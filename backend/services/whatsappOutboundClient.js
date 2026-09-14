/**
 * backend/services/whatsappOutboundClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H7 — a thin REPLY transport, and nothing more.
 *
 * SCOPE, DELIBERATELY NARROW
 * H7 answers an authority who has just tapped a button. That tap opens Meta's
 * customer-service window, so a reply is a free-form message and needs no
 * approved template. This file therefore knows how to send a text and an
 * interactive list, and nothing else.
 *
 * It is NOT the outbound layer for approval requests. A business-initiated
 * purchase-request notification is template-based, needs delivery tracking and
 * belongs to H8 along with the whatsapp_messages collection. Nothing here
 * mints a token, reads a purchase request, or decides anything.
 *
 * MOCKABLE BY CONSTRUCTION
 * The HTTP call is injected. A test builds a client with a recording transport
 * and never reaches the network; no access token is required for DEV tests.
 *
 * UNCONFIGURED IS A NO-OP, NOT AN ERROR
 * With no credentials the client reports `configured:false` and every send
 * returns `{ sent:false, reason:'NOT_CONFIGURED' }`. A decision has already
 * committed by the time a reply is attempted, so a missing reply must never
 * surface as a failure.
 *
 * NEVER LOGGED: the access token, the recipient number, the message body. This
 * file logs only what kind of message was attempted and whether it left. It
 * imports nothing from Firestore, so it is a transport and testable as one.
 */

const LOG = '[WhatsAppReply]';

/** Meta's documented ceilings for an interactive list. Verified at send time. */
export const LIST_LIMITS = Object.freeze({
  MAX_ROWS: 10,
  ROW_TITLE: 24,
  ROW_DESCRIPTION: 72,
  BODY: 1024,
  BUTTON_LABEL: 20
});

/** Default send timeout. A reply must never hold a webhook handler open. */
export const DEFAULT_SEND_TIMEOUT_MS = 8000;

function clamp(value, max) {
  const s = String(value ?? '').trim();
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * The real transport. Reached only when the client is configured, which never
 * happens in a DEV test because no credentials are present there.
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

/**
 * Builds a reply client.
 *
 * @param {object} [o]
 * @param {Function} [o.transport]  injected for tests; receives the message body
 * @returns {{ configured: boolean, sendText: Function, sendReasonList: Function }}
 */
export function createWhatsAppReplyClient({
  transport = null,
  graphBaseUrl = process.env.WHATSAPP_GRAPH_BASE_URL || 'https://graph.facebook.com',
  apiVersion = process.env.WHATSAPP_GRAPH_API_VERSION || '',
  phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '',
  timeoutMs = Number.parseInt(process.env.WHATSAPP_SEND_TIMEOUT_MS || '', 10) || DEFAULT_SEND_TIMEOUT_MS
} = {}) {
  // An injected transport is itself the configuration: a test needs no token.
  const configured = Boolean(transport) || Boolean(apiVersion && phoneNumberId && accessToken);
  const send = transport || (configured
    ? createGraphTransport({ graphBaseUrl, apiVersion, phoneNumberId, accessToken, timeoutMs })
    : null);

  /** One place where every send is attempted, and where nothing secret is logged. */
  async function dispatch(kind, body) {
    if (!configured || !send) {
      console.warn(`${LOG} ${kind} not sent: transport not configured`);
      return { sent: false, reason: 'NOT_CONFIGURED' };
    }
    try {
      const result = await send(body);
      if (!result?.ok) {
        console.warn(`${LOG} ${kind} refused: HTTP ${result?.status ?? 'unknown'}`);
        return { sent: false, reason: 'SEND_FAILED', status: result?.status ?? null };
      }
      const messageId = result.json?.messages?.[0]?.id ?? null;
      console.log(`${LOG} ${kind} sent`);
      return { sent: true, message_id: messageId };
    } catch (err) {
      // A reply failure must never undo or obscure a committed decision.
      console.warn(`${LOG} ${kind} failed: ${err?.message || err}`);
      return { sent: false, reason: 'SEND_ERROR' };
    }
  }

  return {
    configured,

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
 * Production never calls the setter.
 */
export let whatsappReplyClient = createWhatsAppReplyClient();

/** TEST SEAM ONLY. Installs a replacement reply client; returns the previous one. */
export function setWhatsAppReplyClient(client) {
  const previous = whatsappReplyClient;
  whatsappReplyClient = client || createWhatsAppReplyClient();
  return previous;
}
