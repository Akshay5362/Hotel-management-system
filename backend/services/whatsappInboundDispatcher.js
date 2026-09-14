/**
 * backend/services/whatsappInboundDispatcher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H6 — what happens to an inbound WhatsApp message AFTER H5 has proven
 * it came from Meta and claimed it exactly once.
 *
 * IN H6 THIS ROUTES ONE THING: a verification code, sent by an authority from
 * their own number. Nothing here approves, rejects, mints a token, consumes a
 * token, or touches a purchase request. Approve and Reject taps are H7, and
 * this file deliberately does not import the approval service, the token
 * repository, or anything that could decide.
 *
 * TRUST
 * Every field on an event was extracted by the webhook controller from a body
 * whose signature verified. The sender is the one Meta attested; there is no
 * caller-supplied sender anywhere on this path. Unknown senders and messages
 * that are not codes do nothing and answer nothing.
 *
 * The dispatcher marks each claimed event PROCESSED or FAILED, so a row left
 * at CLAIMED is exactly what H5 intended it to mean: the process died mid-way.
 */

import { isWhatsAppVerificationEnabled } from '../config/featureFlags.js';
import {
  markWebhookEventFirestore,
  WEBHOOK_EVENT_STATUS
} from '../repositories/firestore/whatsappWebhookEventsRepository.js';
import { redeemVerificationFromSender } from './whatsappAuthorityVerificationService.js';

const LOG = '[WhatsAppInbound]';

/** Only a plain text message from a known sender can carry a verification code. */
async function handleOne(event) {
  if (event.event_type !== 'message') return 'IGNORED_NOT_A_MESSAGE';
  if (event.message_type !== 'text') return 'IGNORED_NOT_TEXT';
  if (!event.sender_id) return 'IGNORED_NO_SENDER';
  if (!isWhatsAppVerificationEnabled()) return 'IGNORED_VERIFICATION_DISABLED';

  const result = await redeemVerificationFromSender({
    sender_id: event.sender_id,
    text: event.text,
    message_id: event.meta_message_id
  });
  return `VERIFICATION_${result.outcome}`;
}

/**
 * Handles every event THIS process claimed. Never throws: the claim has
 * already committed and Meta has already been told 200, so an error here is
 * recorded on the event row and logged, not propagated.
 */
export async function dispatchInboundWhatsAppEvents(claimedEvents = []) {
  for (const event of claimedEvents) {
    let status = WEBHOOK_EVENT_STATUS.PROCESSED;
    let errorCode = null;
    try {
      const outcome = await handleOne(event);
      // Outcome and event id only. Never the sender, never the text.
      console.log(`${LOG} ${event.event_id}: ${outcome}`);
    } catch (err) {
      status = WEBHOOK_EVENT_STATUS.FAILED;
      errorCode = err?.code || 'DISPATCH_ERROR';
      console.error(`${LOG} ${event.event_id} failed: ${err?.message || err}`);
    }
    try {
      await markWebhookEventFirestore(event.event_id, { status, errorCode });
    } catch (err) {
      console.warn(`${LOG} could not mark ${event.event_id}: ${err?.message || err}`);
    }
  }
}
