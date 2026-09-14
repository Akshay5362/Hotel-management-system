/**
 * backend/controllers/whatsappWebhookController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H5 — the public webhook. Transport only.
 *
 * This file authenticates an inbound delivery, deduplicates the events inside
 * it, and stops. It contains NO approval logic: it does not mint tokens, does
 * not resolve an approver, does not decide anything and does not send anything.
 * Those belong to H6, H7 and H8, and the seam they attach to is
 * `dispatchVerifiedWebhookEvents` at the bottom of this file.
 *
 * ORDER OF OPERATIONS — the whole point of the phase
 *   1. feature flag        disabled → 404, nothing else runs
 *   2. rate limit          applied by the router, before the body is buffered
 *   3. signature           HMAC over the RAW bytes, timing-safe
 *   4. parse               ONLY after the signature proved the bytes are Meta's
 *   5. claim               each event exactly once
 *   6. dispatch            H7's seam; a no-op today
 *
 * Nothing at step 4 or later may run if step 3 failed, because a payload that
 * has not been authenticated is attacker-controlled input.
 *
 * WHAT IS NEVER LOGGED
 * The app secret, the verify token, the signature header, and the raw body.
 * Event ids and counts are logged, because they are the operational signal and
 * carry no secret.
 */

import {
  verifyWebhookSignature,
  timingSafeCompare,
  SIGNATURE_HEADER
} from '../utils/whatsappSignature.js';
import { isWhatsAppWebhookEnabled } from '../config/featureFlags.js';
import {
  claimWebhookEventFirestore,
  digestDelivery
} from '../repositories/firestore/whatsappWebhookEventsRepository.js';
import { dispatchInboundWhatsAppEvents } from '../services/whatsappInboundDispatcher.js';

/** A code is 8 digits; anything longer than this is not a message we act on. */
const MAX_TEXT_LENGTH = 512;

const LOG = '[WhatsAppWebhook]';

/**
 * A disabled feature answers as though the route does not exist. Meta's setup
 * screen reports the failure just as clearly as a 403 would, and an unconfigured
 * deployment gives a prober nothing to confirm.
 */
function notFound(res) {
  return res.status(404).json({ error: 'Not found.' });
}

/**
 * GET — Meta's subscription handshake.
 *
 * Meta calls this once when the webhook URL is saved, with a verify token we
 * chose and a challenge it expects echoed back verbatim as plain text.
 */
export const verifyWebhookSubscription = (req, res) => {
  if (!isWhatsAppWebhookEnabled()) return notFound(res);

  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!expected) {
    // Misconfiguration must fail closed, and must not say which secret is absent.
    console.warn(`${LOG} handshake refused: webhook is enabled but not fully configured`);
    return res.status(403).json({ error: 'Forbidden.' });
  }

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe' || typeof token !== 'string' || !timingSafeCompare(token, expected)) {
    console.warn(`${LOG} handshake refused: mode or verify token did not match`);
    return res.status(403).json({ error: 'Forbidden.' });
  }

  console.log(`${LOG} handshake accepted`);
  // Echoed verbatim as text/plain — Meta rejects a JSON-wrapped challenge.
  return res.status(200).type('text/plain').send(String(challenge ?? ''));
};

/**
 * Pulls the dedupe keys out of an authenticated payload.
 *
 * Two namespaces, deliberately separated:
 *   message  one inbound message, keyed by its own id
 *   status   a delivery receipt, which REUSES the original message id across
 *            sent/delivered/read — so the status value is part of the key, or
 *            the 'read' receipt would be dropped as a duplicate of 'delivered'
 *
 * Everything is optional-chained. A payload that passed the signature check is
 * authentic, but authentic is not the same as well-formed.
 */
/**
 * The machine-readable identifier attached to a tapped control, or null.
 * Reads only the documented reply shapes; anything else yields null rather
 * than a guess, so an ordinary message can never be read as an action.
 */
export function extractActionPayload(message, messageType) {
  if (messageType === 'button' && typeof message?.button?.payload === 'string') {
    return message.button.payload.slice(0, MAX_TEXT_LENGTH);
  }
  if (messageType === 'interactive') {
    const interactive = message?.interactive;
    const id = interactive?.type === 'button_reply' ? interactive?.button_reply?.id
      : interactive?.type === 'list_reply' ? interactive?.list_reply?.id
        : null;
    if (typeof id === 'string') return id.slice(0, MAX_TEXT_LENGTH);
  }
  return null;
}

export function extractWebhookEvents(payload) {
  const events = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;

      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        if (!message?.id) continue;
        // H6 — the sender is the one Meta attested INSIDE the signed body. It is
        // the only sender this system ever trusts; no caller-supplied field can
        // stand in for it. Text is carried only for plain text messages, capped,
        // and never logged by this controller.
        const messageType = message.type ? String(message.type) : null;
        const text = messageType === 'text' && typeof message.text?.body === 'string'
          ? message.text.body.slice(0, MAX_TEXT_LENGTH)
          : null;
        events.push({
          event_id: `msg:${message.id}`,
          event_type: 'message',
          meta_message_id: String(message.id),
          sender_id: message.from ? String(message.from) : null,
          message_type: messageType,
          text,
          // H7 — the identifier behind a tapped control. Meta reports a template
          // quick reply as `button` and an in-window control as `interactive`,
          // whose reply is either a button_reply or a list_reply. All three are
          // read here and nowhere else, capped like the text, and never logged.
          action_payload: extractActionPayload(message, messageType),
          // H8-D — the id of the message whose button was tapped. A template
          // quick reply returns only its own label, so this is the ONLY thing
          // that says which notification the tap belongs to. It is an opaque
          // provider id: it names no authority and grants nothing on its own,
          // and the sender is still the one Meta attested.
          context_id: typeof message?.context?.id === 'string'
            ? message.context.id.slice(0, MAX_TEXT_LENGTH)
            : null
        });
      }

      for (const status of Array.isArray(value?.statuses) ? value.statuses : []) {
        if (!status?.id || !status?.status) continue;
        events.push({
          event_id: `status:${status.id}:${status.status}`,
          event_type: 'status',
          meta_message_id: String(status.id)
        });
      }
    }
  }
  return events;
}

/**
 * POST — an inbound delivery from Meta.
 *
 * Always answers 200 once the signature has been accepted and the payload
 * parsed, because a non-2xx makes Meta retry and a retry cannot fix anything
 * that is already claimed. The two exceptions are deliberate: an unverifiable
 * signature is 403 because it is not Meta, and an unparseable body is 400
 * because a 2xx would be claiming responsibility for something we could not
 * read.
 */
export const receiveWebhook = async (req, res) => {
  if (!isWhatsAppWebhookEnabled()) return notFound(res);

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    console.warn(`${LOG} delivery refused: webhook is enabled but not fully configured`);
    return res.status(403).json({ error: 'Forbidden.' });
  }

  // express.raw() leaves a Buffer here. Anything else means the router was
  // mounted after a body parser, which would make verification impossible —
  // so it is refused rather than worked around.
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    console.error(`${LOG} delivery refused: raw body unavailable (parser order is wrong)`);
    return res.status(403).json({ error: 'Forbidden.' });
  }

  if (!verifyWebhookSignature(rawBody, req.get(SIGNATURE_HEADER), appSecret)) {
    console.warn(`${LOG} delivery refused: signature did not verify`);
    return res.status(403).json({ error: 'Forbidden.' });
  }

  // ── Everything below this line is authenticated as having come from Meta. ──
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.warn(`${LOG} delivery refused: body is not valid JSON`);
    return res.status(400).json({ error: 'Malformed payload.' });
  }

  const events = extractWebhookEvents(payload);
  const deliveryDigest = digestDelivery(rawBody);
  const claimed = [];
  let duplicates = 0;

  for (const event of events) {
    try {
      // Claimed BEFORE any downstream work — see the repository header for why
      // this direction is the safe one.
      const result = await claimWebhookEventFirestore(event.event_id, {
        ...event,
        delivery_digest: deliveryDigest
      });
      if (result.duplicate) duplicates += 1;
      else claimed.push(event);
    } catch (err) {
      // One bad event must not discard the rest of the delivery.
      console.error(`${LOG} claim failed for ${event.event_id}: ${err.message}`);
    }
  }

  if (events.length) {
    console.log(`${LOG} delivery accepted: ${events.length} event(s), ${claimed.length} claimed, ${duplicates} duplicate(s)`);
  }

  // H7 — the Socket.IO server travels as a plain handle, so the dispatcher
  // never depends on Express and no caller-supplied field can reach it.
  await dispatchVerifiedWebhookEvents(claimed, req?.app?.get('io') ?? null);

  return res.status(200).json({
    received: events.length,
    claimed: claimed.length,
    duplicates
  });
};

/**
 * ── DISPATCH SEAM ────────────────────────────────────────────────────────────
 * H5 left this empty. H6 routed verification codes through it, and H7 adds
 * Approve and Reject taps. This controller still decides nothing: it hands the
 * claimed events to the dispatcher and stops.
 *
 * It receives only events THIS process claimed, so downstream work runs at
 * most once per event no matter how often Meta re-delivers. It must stay
 * non-throwing: the claim has already committed, and an exception here would
 * turn a handled delivery into a 500 and a pointless retry.
 */
async function dispatchVerifiedWebhookEvents(claimedEvents, io) {
  if (!claimedEvents.length) return;
  try {
    await dispatchInboundWhatsAppEvents(claimedEvents, { io });
  } catch (err) {
    console.error(`${LOG} dispatch failed: ${err?.message || err}`);
  }
}
