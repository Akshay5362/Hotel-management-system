/**
 * backend/services/whatsappInboundDispatcher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H6, extended in H7 — what happens to an inbound WhatsApp message AFTER
 * H5 has proven it came from Meta and claimed it exactly once.
 *
 * TWO KINDS OF MESSAGE, ONE RULE EACH
 *   a tapped control  → the H7 decision router
 *   plain text        → the H6 verification redeemer
 *
 * This file still decides nothing itself. It does not approve, reject, mint or
 * consume a token, or touch a purchase request; it chooses which specialist to
 * call and records the outcome. The approval engine is reached only through
 * whatsappDecisionRouter, never from here.
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
import { routeWhatsAppAction } from './whatsappDecisionRouter.js';
import { looksLikeActionPayload } from '../utils/whatsappActionPayload.js';
import { handleReviewTap, isReviewTap } from './whatsappReviewBridgeService.js';

const LOG = '[WhatsAppInbound]';

/**
 * One event, one specialist. A tapped control carries an action payload and
 * goes to the decision router; plain text goes to verification. Anything else
 * is ignored safely, which is the correct answer for a photo, a sticker or a
 * message we have no business interpreting.
 */
async function handleOne(event, { io }) {
  if (event.event_type !== 'message') return 'IGNORED_NOT_A_MESSAGE';
  if (!event.sender_id) return 'IGNORED_NO_SENDER';

  if (event.action_payload) {
    // H8-D — a tap on the H8-C notification button. A template quick reply
    // carries no developer payload, so it arrives as its own label and is NOT
    // an H7 action. It is recognised here, before the router, and handed to the
    // bridge; H7's grammar and router are untouched by this path.
    if (!looksLikeActionPayload(event.action_payload) && isReviewTap(event.action_payload)) {
      const outcome = await handleReviewTap({
        sender_id: event.sender_id,
        payload: event.action_payload,
        context_id: event.context_id,
        meta_message_id: event.meta_message_id
      });
      return `REVIEW_${outcome}`;
    }

    const outcome = await routeWhatsAppAction({
      sender_id: event.sender_id,
      payload: event.action_payload,
      meta_message_id: event.meta_message_id,
      io
    });
    return `DECISION_${outcome}`;
  }

  if (event.message_type !== 'text') return 'IGNORED_NOT_TEXT';
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
export async function dispatchInboundWhatsAppEvents(claimedEvents = [], { io = null } = {}) {
  for (const event of claimedEvents) {
    let status = WEBHOOK_EVENT_STATUS.PROCESSED;
    let errorCode = null;
    try {
      const outcome = await handleOne(event, { io });
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
