/**
 * backend/services/whatsappOutboundClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H7 (replies) and H8-B (business-initiated sends) — the ONE outbound
 * transport. There is deliberately no second WhatsApp client anywhere.
 *
 * TWO CLASSES OF MESSAGE, TWO DIFFERENT RULES
 *
 *   sendText / sendReasonList        H7. A reply to somebody who has just
 *                                    tapped something, so it travels inside the
 *                                    service window their tap opened. Free-form,
 *                                    needs no approved template, and is governed
 *                                    by the H7 decisions flag, not by H8's.
 *
 *   sendTemplateMessage              H8-B. Business-initiated: we speak first,
 *   sendInteractiveButtonsMessage    or we follow up inside a window we intend
 *                                    to use for a decision prompt. Both are
 *                                    gated by ENABLE_WHATSAPP_OUTBOUND, which
 *                                    defaults OFF.
 *
 * The split is the reason the new flag does not break H7: a reply is not a
 * business-initiated message, and switching outbound off must never leave an
 * authority who just tapped a button with silence.
 *
 * THIS FILE IS TRANSPORT AND NOTHING ELSE
 * It chooses no recipient, resolves no authority, mints no token, records
 * nothing, reads nothing back, and interprets no button identifier. A caller
 * hands it a number, a body and identifiers; it builds the documented request,
 * sends it, and normalises the answer. Every business decision lives elsewhere.
 *
 * PAYLOADS ARE BUILT, NEVER FORWARDED
 * No caller-supplied object is ever passed through to the provider. Each
 * builder writes the envelope itself, so a caller cannot change the message
 * type, add a component, or reach an endpoint of its choosing.
 *
 * NEVER LOGGED, NEVER RETURNED
 * The access token, the app secret, the verify token and the recipient's full
 * number. Logs carry an operation name, a coarse outcome and at most a masked
 * number. Error results carry no credential and no complete recipient.
 */

import {
  WHATSAPP_SEND_STATE
} from '../utils/inventoryConstants.js';
import { isWhatsAppOutboundEnabled } from '../config/featureFlags.js';

const LOG = '[WhatsAppOutbound]';

/** Meta's documented ceilings for an interactive list. Verified at send time. */
export const LIST_LIMITS = Object.freeze({
  MAX_ROWS: 10,
  ROW_TITLE: 24,
  ROW_DESCRIPTION: 72,
  BODY: 1024,
  BUTTON_LABEL: 20
});

/**
 * Meta's documented ceilings for interactive reply buttons. The identifier
 * limit is the load-bearing one: H7's action payloads live in it, so it is
 * ENFORCED BY REFUSAL and never by truncation. A silently shortened identifier
 * would be a valid-looking payload for a token that does not exist.
 */
export const BUTTON_LIMITS = Object.freeze({
  MAX_BUTTONS: 3,
  ID: 256,
  TITLE: 20,
  BODY: 1024
});

/** Our own ceiling for one template body parameter. Well inside the envelope. */
export const TEMPLATE_LIMITS = Object.freeze({
  NAME: 512,
  PARAMETER: 1024,
  MAX_PARAMETERS: 20
});

/** Default send timeout. A reply must never hold a webhook handler open. */
export const DEFAULT_SEND_TIMEOUT_MS = 8000;

/** Every reason this transport can refuse or fail. No free-form strings. */
export const SEND_REASON = Object.freeze({
  OUTBOUND_DISABLED: 'OUTBOUND_DISABLED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  INVALID_INPUT: 'INVALID_INPUT',
  SEND_TIMEOUT: 'SEND_TIMEOUT',
  SEND_FAILED: 'SEND_FAILED',
  SEND_ERROR: 'SEND_ERROR',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE'
});

/**
 * Hosts this transport will talk to. The base URL is BACKEND CONFIGURATION and
 * nothing else: it is never read from a request body, a query string, a
 * renderer message or a stored document. An unrecognised host leaves the client
 * unconfigured rather than silently falling back to the default, so a
 * misconfigured deployment sends nothing instead of sending somewhere else.
 */
const ALLOWED_GRAPH_HOSTS = Object.freeze(['graph.facebook.com']);
const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';

function clamp(value, max) {
  const s = String(value ?? '').trim();
  return s.length <= max ? s : s.slice(0, max);
}

/** First two and last two digits only. Enough to correlate, useless to a reader. */
export function maskNumber(value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
}

// ── Validation. Pure, exported so it can be tested without any transport. ────

/**
 * A recipient must be E.164: an optional '+', a non-zero leading digit, then 8
 * to 15 digits in total. Returned WITHOUT the '+', which is the form the
 * provider accepts and the form H6 stores.
 */
export function normalizeRecipient(value) {
  const raw = String(value ?? '').trim();
  if (!/^\+?[1-9][0-9]{7,14}$/.test(raw)) return null;
  return raw.replace(/^\+/, '');
}

/** Template names are lower-case, digits and underscores, by provider convention. */
export function isValidTemplateName(value) {
  const s = String(value ?? '').trim();
  return s.length > 0 && s.length <= TEMPLATE_LIMITS.NAME && /^[a-z0-9_]+$/.test(s);
}

/** A language code such as 'en' or 'en_US'. */
export function isValidLanguageCode(value) {
  return /^[a-z]{2,3}(_[A-Z]{2})?$/.test(String(value ?? '').trim());
}

/**
 * One template body parameter. Values are single-line by construction: a
 * newline or tab in a parameter reshapes the rendered message and is refused
 * rather than stripped, so a caller notices instead of sending something odd.
 */
function validateParameterValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value);
  if (!s.trim()) return null;
  if (s.length > TEMPLATE_LIMITS.PARAMETER) return null;
  if (/[\r\n\t]/.test(s)) return null;
  return s;
}

/** A named parameter's key, matching the provider's documented shape. */
function isValidParameterName(name) {
  return /^[a-z][a-z0-9_]{0,63}$/.test(String(name ?? ''));
}

/**
 * Reply buttons. Identifiers are checked against the ceiling and REFUSED when
 * they exceed it; titles must be present, short and unique, which the provider
 * requires when more than one button is sent.
 */
export function validateButtons(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) return { ok: false, reason: 'buttons must be a non-empty array' };
  if (buttons.length > BUTTON_LIMITS.MAX_BUTTONS) return { ok: false, reason: 'too many buttons' };

  const seenIds = new Set();
  const seenTitles = new Set();
  const clean = [];

  for (const button of buttons) {
    if (!button || typeof button !== 'object') return { ok: false, reason: 'each button must be an object' };
    const id = String(button.id ?? '');
    const title = String(button.title ?? '').trim();

    if (!id) return { ok: false, reason: 'a button id is required' };
    // Refused, never truncated. See BUTTON_LIMITS.
    if (id.length > BUTTON_LIMITS.ID) return { ok: false, reason: 'a button id exceeds the identifier limit' };
    if (/[\s\r\n]/.test(id)) return { ok: false, reason: 'a button id contains whitespace' };
    if (!title) return { ok: false, reason: 'a button title is required' };
    if (title.length > BUTTON_LIMITS.TITLE) return { ok: false, reason: 'a button title is too long' };
    if (seenIds.has(id)) return { ok: false, reason: 'button ids must be unique' };
    if (seenTitles.has(title)) return { ok: false, reason: 'button titles must be unique' };

    seenIds.add(id);
    seenTitles.add(title);
    clean.push({ id, title });
  }
  return { ok: true, buttons: clean };
}

/** Validates a configured base URL. Returns null when it may not be used. */
export function safeGraphBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!ALLOWED_GRAPH_HOSTS.includes(url.hostname)) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return `https://${url.hostname}`;
}

// ── Payload builders. Explicit envelopes; nothing is forwarded. ──────────────

/**
 * Builds a template send body. The message type is written here and cannot be
 * supplied by a caller, so no other message type can be injected.
 */
export function buildTemplatePayload({ to, templateName, languageCode, parameters }) {
  const recipient = normalizeRecipient(to);
  if (!recipient) return { ok: false, reason: 'recipient is not a valid E.164 number' };
  if (!isValidTemplateName(templateName)) return { ok: false, reason: 'template name is not valid' };
  if (!isValidLanguageCode(languageCode)) return { ok: false, reason: 'language code is not valid' };

  const components = [];
  if (parameters !== undefined && parameters !== null) {
    const built = [];
    if (Array.isArray(parameters)) {
      if (parameters.length > TEMPLATE_LIMITS.MAX_PARAMETERS) return { ok: false, reason: 'too many parameters' };
      for (const value of parameters) {
        const text = validateParameterValue(value);
        if (text === null) return { ok: false, reason: 'a template parameter is not valid' };
        built.push({ type: 'text', text });
      }
    } else if (typeof parameters === 'object') {
      const names = Object.keys(parameters);
      if (names.length > TEMPLATE_LIMITS.MAX_PARAMETERS) return { ok: false, reason: 'too many parameters' };
      for (const name of names) {
        if (!isValidParameterName(name)) return { ok: false, reason: 'a parameter name is not valid' };
        const text = validateParameterValue(parameters[name]);
        if (text === null) return { ok: false, reason: 'a template parameter is not valid' };
        built.push({ type: 'text', parameter_name: name, text });
      }
    } else {
      return { ok: false, reason: 'parameters must be an array or an object' };
    }
    if (built.length) components.push({ type: 'body', parameters: built });
  }

  return {
    ok: true,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'template',
      template: {
        name: String(templateName).trim(),
        language: { code: String(languageCode).trim() },
        ...(components.length ? { components } : {})
      }
    }
  };
}

/**
 * Builds an interactive reply-buttons body. Identifiers are placed verbatim:
 * this transport does not read them, shorten them or attach meaning to them.
 */
export function buildInteractiveButtonsPayload({ to, bodyText, buttons, header, footer }) {
  const recipient = normalizeRecipient(to);
  if (!recipient) return { ok: false, reason: 'recipient is not a valid E.164 number' };

  const body = String(bodyText ?? '').trim();
  if (!body) return { ok: false, reason: 'body text is required' };
  if (body.length > BUTTON_LIMITS.BODY) return { ok: false, reason: 'body text is too long' };

  const checked = validateButtons(buttons);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const headerText = header === undefined || header === null ? null : String(header).trim();
  if (headerText && headerText.length > 60) return { ok: false, reason: 'header text is too long' };
  const footerText = footer === undefined || footer === null ? null : String(footer).trim();
  if (footerText && footerText.length > 60) return { ok: false, reason: 'footer text is too long' };

  return {
    ok: true,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(headerText ? { header: { type: 'text', text: headerText } } : {}),
        body: { text: body },
        ...(footerText ? { footer: { text: footerText } } : {}),
        action: {
          buttons: checked.buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } }))
        }
      }
    }
  };
}

// ── The real transport ───────────────────────────────────────────────────────

/**
 * Reached only when the client is configured, which never happens in a DEV test
 * because no credential is present there. The URL is assembled from validated
 * configuration; no part of it comes from a caller.
 */
function createGraphTransport({ graphBaseUrl, apiVersion, phoneNumberId, accessToken, timeoutMs }) {
  return async (body) => {
    const url = `${graphBaseUrl}/${apiVersion}/${phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a non-JSON body is reported as unparseable */ }
    return { ok: res.ok, status: res.status, json };
  };
}

/** A timeout and a dead connection are different facts and are reported as such. */
function isTimeout(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|timed out/i.test(String(err.message || '')));
}

/**
 * Builds a client.
 *
 * @param {object} [o]
 * @param {Function} [o.transport]  injected for tests; receives the message body
 */
export function createWhatsAppReplyClient({
  transport = null,
  graphBaseUrl = process.env.WHATSAPP_GRAPH_BASE_URL || DEFAULT_GRAPH_BASE_URL,
  apiVersion = process.env.WHATSAPP_GRAPH_API_VERSION || '',
  phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '',
  timeoutMs = Number.parseInt(process.env.WHATSAPP_SEND_TIMEOUT_MS || '', 10) || DEFAULT_SEND_TIMEOUT_MS,
  templateName = process.env.WHATSAPP_TEMPLATE_PR_REVIEW || '',
  templateLanguage = process.env.WHATSAPP_TEMPLATE_LANGUAGE || ''
} = {}) {
  // An unrecognised host is refused outright rather than replaced by the
  // default, so a bad value cannot be papered over into a working client.
  const safeBaseUrl = safeGraphBaseUrl(graphBaseUrl);

  // An injected transport is itself the configuration: a test needs no token.
  const credentialed = Boolean(apiVersion && phoneNumberId && accessToken && safeBaseUrl);
  const configured = Boolean(transport) || credentialed;
  const send = transport || (credentialed
    ? createGraphTransport({ graphBaseUrl: safeBaseUrl, apiVersion, phoneNumberId, accessToken, timeoutMs })
    : null);

  /** One place where every send is attempted, and where nothing secret is logged. */
  async function dispatch(kind, body) {
    if (!configured || !send) {
      console.warn(`${LOG} ${kind} not sent: transport not configured`);
      return { sent: false, reason: SEND_REASON.NOT_CONFIGURED, outcome: WHATSAPP_SEND_STATE.FAILED };
    }
    try {
      const result = await send(body);
      if (!result?.ok) {
        // A provider error code is safe to surface; the body may echo input, so
        // only the documented code and message fields are read.
        const providerCode = result?.json?.error?.code ?? null;
        console.warn(`${LOG} ${kind} refused: HTTP ${result?.status ?? 'unknown'}`);
        return {
          sent: false,
          reason: SEND_REASON.SEND_FAILED,
          outcome: WHATSAPP_SEND_STATE.FAILED,
          http_status: result?.status ?? null,
          provider_code: providerCode
        };
      }
      const messageId = result.json?.messages?.[0]?.id ?? null;
      if (!messageId) {
        // Accepted, but we cannot name what was accepted. That is UNKNOWN, not
        // a failure: the message may well have gone out.
        console.warn(`${LOG} ${kind} accepted without a usable message id`);
        return {
          sent: false,
          reason: SEND_REASON.MALFORMED_RESPONSE,
          outcome: WHATSAPP_SEND_STATE.UNKNOWN,
          http_status: result?.status ?? null
        };
      }
      console.log(`${LOG} ${kind} sent`);
      return { sent: true, message_id: messageId, outcome: WHATSAPP_SEND_STATE.SENT };
    } catch (err) {
      // A reply failure must never undo or obscure a committed decision, and a
      // timeout must never be reported as a definite failure.
      if (isTimeout(err)) {
        console.warn(`${LOG} ${kind} timed out`);
        return { sent: false, reason: SEND_REASON.SEND_TIMEOUT, outcome: WHATSAPP_SEND_STATE.UNKNOWN };
      }
      console.warn(`${LOG} ${kind} failed: ${err?.name || 'Error'}`);
      return { sent: false, reason: SEND_REASON.SEND_ERROR, outcome: WHATSAPP_SEND_STATE.FAILED };
    }
  }

  /** Business-initiated sends are gated; replies are not. */
  function outboundGate(kind) {
    if (!isWhatsAppOutboundEnabled()) {
      console.warn(`${LOG} ${kind} refused: outbound is disabled`);
      return { sent: false, reason: SEND_REASON.OUTBOUND_DISABLED, outcome: WHATSAPP_SEND_STATE.FAILED };
    }
    return null;
  }

  function invalid(kind, reason) {
    console.warn(`${LOG} ${kind} refused: ${reason}`);
    return { sent: false, reason: SEND_REASON.INVALID_INPUT, detail: reason, outcome: WHATSAPP_SEND_STATE.FAILED };
  }

  return {
    configured,
    credentialed,

    // ── H7: replies inside a window the recipient opened ─────────────────────

    /** A plain free-form reply, valid inside the window the tap opened. */
    async sendText(to, body) {
      return await dispatch('text', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(to || ''),
        type: 'text',
        text: { preview_url: false, body: clamp(body, LIST_LIMITS.BODY) }
      });
    },

    /**
     * An interactive list. Titles are written by the caller and never carry a
     * token; the token lives only in each row's machine-readable id.
     */
    async sendReasonList(to, { body, buttonLabel, rows = [] } = {}) {
      const safeRows = rows.slice(0, LIST_LIMITS.MAX_ROWS).map(r => ({
        id: String(r.id || ''),
        title: clamp(r.title, LIST_LIMITS.ROW_TITLE),
        ...(r.description ? { description: clamp(r.description, LIST_LIMITS.ROW_DESCRIPTION) } : {})
      }));
      return await dispatch('list', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(to || ''),
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: clamp(body, LIST_LIMITS.BODY) },
          action: {
            button: clamp(buttonLabel || 'Choose a reason', LIST_LIMITS.BUTTON_LABEL),
            sections: [{ title: 'Reasons', rows: safeRows }]
          }
        }
      });
    },

    // ── H8-B: business-initiated sends, gated and validated ──────────────────

    /**
     * An approved template. This is the only way to reach somebody outside an
     * open window, and it carries no approval token: a quick-reply button on a
     * template returns its own label, never a value we chose.
     */
    async sendTemplateMessage({ to, templateName: name, languageCode, parameters } = {}) {
      const blocked = outboundGate('template');
      if (blocked) return blocked;

      const useName = name || templateName;
      const useLanguage = languageCode || templateLanguage;
      if (!useName || !useLanguage) return invalid('template', 'template name and language must be configured');
      if (!configured) {
        console.warn(`${LOG} template not sent: transport not configured`);
        return { sent: false, reason: SEND_REASON.NOT_CONFIGURED, outcome: WHATSAPP_SEND_STATE.FAILED };
      }

      const built = buildTemplatePayload({ to, templateName: useName, languageCode: useLanguage, parameters });
      if (!built.ok) return invalid('template', built.reason);
      return await dispatch('template', built.body);
    },

    /**
     * Interactive reply buttons, for a decision prompt inside an open window.
     * The identifiers are placed exactly as given; this transport never reads
     * them and never decides anything about them.
     */
    async sendInteractiveButtonsMessage({ to, bodyText, buttons, header, footer } = {}) {
      const blocked = outboundGate('buttons');
      if (blocked) return blocked;
      if (!configured) {
        console.warn(`${LOG} buttons not sent: transport not configured`);
        return { sent: false, reason: SEND_REASON.NOT_CONFIGURED, outcome: WHATSAPP_SEND_STATE.FAILED };
      }

      const built = buildInteractiveButtonsPayload({ to, bodyText, buttons, header, footer });
      if (!built.ok) return invalid('buttons', built.reason);
      return await dispatch('buttons', built.body);
    }
  };
}

/**
 * The process-wide client, built from the environment. Unconfigured by default,
 * so nothing is ever sent until credentials exist.
 *
 * A `let` with a setter, deliberately: the router resolves this binding on every
 * call, so a DEV test can install a recording client and exercise the REAL
 * webhook path end to end without a Meta credential and without a network call.
 * Production never calls the setter, and no environment variable can reach it.
 */
export let whatsappReplyClient = createWhatsAppReplyClient();

/** TEST SEAM ONLY. Installs a replacement reply client; returns the previous one. */
export function setWhatsAppReplyClient(client) {
  const previous = whatsappReplyClient;
  whatsappReplyClient = client || createWhatsAppReplyClient();
  return previous;
}
