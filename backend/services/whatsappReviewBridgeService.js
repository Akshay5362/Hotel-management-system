/**
 * backend/services/whatsappReviewBridgeService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-D — the step between "you have a request waiting" and an actual
 * decision.
 *
 * H8-C sends a template. A template's quick reply carries no developer payload,
 * so the tap comes back as nothing but its own label plus `context.id`, the id
 * of the message it belonged to. This file turns that into a decision prompt:
 * it identifies the authority from the attested sender, identifies the request
 * from the correlation record, re-checks everything, mints a fresh token pair,
 * and sends Approve and Reject buttons carrying the H7 payloads.
 *
 * IT IS A BRIDGE, NOT AN ENGINE
 * Nothing here approves, rejects, or consumes a token. H3 remains the only
 * decision engine and H4 the only rejection flow; this hands them a valid token
 * and steps out of the way. A tap on Approve or Reject afterwards travels the
 * ordinary H7 router, unchanged.
 *
 * IDENTITY IS NEVER TAKEN FROM THE MESSAGE
 * Not from the label, not from `context.id`, not from any text. The authority
 * comes from the Meta-attested sender number through the H6 binding, and the
 * correlation record must independently agree that this dispatch was addressed
 * to that same authority. A tap quoting somebody else's notification resolves
 * to a mismatch and does nothing.
 *
 * MINTING IS BOUNDED AND SELF-CLEANING
 * Every mint first invalidates the outstanding pair for this request and this
 * authority, so there is never more than one live pair per authority per
 * request. The H8-A counter caps how many times one notification may be turned
 * into a prompt, so repeated taps cannot mint without limit.
 *
 * NEVER LOGGED: a raw token, a verification code, a credential, or a full
 * number. Numbers appear masked and only in the audit trail.
 */

import crypto from 'crypto';
import { isWhatsAppDecisionsEnabled, isWhatsAppOutboundEnabled } from '../config/featureFlags.js';
import {
  PR_STATUS,
  PR_APPROVAL_ACTIONS,
  PR_DECISION_TOKEN_TTL_MS,
  WHATSAPP_REVIEW_MAX_MINTS,
  WHATSAPP_REVIEW_BUTTON_LABEL,
  WHATSAPP_DISPATCH_PURPOSE,
  WHATSAPP_SEND_STATE
} from '../utils/inventoryConstants.js';
import { buildApprovePayload, buildRejectPayload } from '../utils/whatsappActionPayload.js';
import { maskWhatsAppNumber } from '../repositories/firestore/inventoryApprovalAuthoritiesRepository.js';
import {
  findDispatchByProviderMessageIdFirestore,
  claimBridgeMintFirestore,
  claimDispatchFirestore,
  recordProviderMessageIdFirestore,
  markDispatchSendStateFirestore
} from '../repositories/firestore/whatsappMessagesRepository.js';
import {
  createApprovalActionFirestore,
  invalidateApprovalActionsForRequestFirestore
} from '../repositories/firestore/inventoryApprovalActionsRepository.js';
import { getPurchaseRequestByIdFirestore } from '../repositories/firestore/purchaseRequestsRepository.js';
import { resolveAuthorityBySender } from './whatsappAuthorityVerificationService.js';
import { assertExternalAuthorityCanApprove } from './purchaseRequestApprovalService.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import * as replyTransport from './whatsappOutboundClient.js';

const LOG = '[WhatsAppReview]';

/** Every way a Review tap can end. Returned, never sent to the authority. */
export const REVIEW_OUTCOME = Object.freeze({
  NOT_A_REVIEW: 'NOT_A_REVIEW',
  DISABLED: 'DISABLED',
  UNKNOWN_SENDER: 'UNKNOWN_SENDER',
  NO_CONTEXT: 'NO_CONTEXT',
  DISPATCH_NOT_FOUND: 'DISPATCH_NOT_FOUND',
  AUTHORITY_MISMATCH: 'AUTHORITY_MISMATCH',
  REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND',
  REQUEST_NOT_PENDING: 'REQUEST_NOT_PENDING',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  MINT_LIMIT_REACHED: 'MINT_LIMIT_REACHED',
  PROMPT_SENT: 'PROMPT_SENT',
  PROMPT_FAILED: 'PROMPT_FAILED'
});

export const WHATSAPP_REVIEW_AUDIT_ACTIONS = Object.freeze({
  PROMPTED: 'INVENTORY_WHATSAPP_REVIEW_PROMPTED',
  REFUSED: 'INVENTORY_WHATSAPP_REVIEW_REFUSED'
});

/** Replies are deliberately generic: they reveal nothing an attacker could use. */
const REPLY = Object.freeze({
  UNAVAILABLE: 'This request is no longer available for a decision.',
  NOT_PENDING: 'That purchase request has already been decided.',
  TOO_MANY: 'Too many attempts on this request. Please contact the hotel.',
  FAILED: 'Something went wrong preparing the approval options. Please try again.'
});

const BUTTON = Object.freeze({ APPROVE: 'Approve', REJECT: 'Reject' });

/** True when this inbound event is a tap on the H8-C notification button. */
export function isReviewTap(payload) {
  return String(payload ?? '').trim().toLowerCase() === WHATSAPP_REVIEW_BUTTON_LABEL.toLowerCase();
}

async function writeAudit(action, details, authorityId) {
  try {
    await createAuditLogFirestore({
      log_id: `inv_wa_review_${action.toLowerCase()}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      action,
      details: { authority_id: authorityId || null, ...details },
      user_id: authorityId || 'system:whatsapp'
    });
  } catch (err) {
    console.warn(`${LOG} audit log failed (${action}): ${err.message}`);
  }
}

async function reply(client, to, text) {
  try { await client.sendText(to, text); }
  catch (err) { console.warn(`${LOG} reply failed: ${err?.name || 'Error'}`); }
}

/**
 * Handles one tap on the Review button.
 *
 * Never throws: an inbound webhook has already been answered 200 and a failure
 * here must not propagate. Returns one of REVIEW_OUTCOME.
 *
 * @param {object}  o
 * @param {string}  o.sender_id   the number Meta attested; the ONLY identity input
 * @param {string}  o.payload     the tapped label
 * @param {string}  o.context_id  the id of the message the button belonged to
 */
export async function handleReviewTap({ sender_id, payload, context_id, meta_message_id = null, client = null } = {}) {
  if (!isReviewTap(payload)) return REVIEW_OUTCOME.NOT_A_REVIEW;

  const transport = client || replyTransport.whatsappReplyClient;

  // Identity first, and before any flag: an unknown sender learns nothing about
  // what is or is not switched on.
  const resolved = await resolveAuthorityBySender(sender_id);
  if (!resolved.ok) {
    console.warn(`${LOG} refused: ${resolved.code}`);
    return REVIEW_OUTCOME.UNKNOWN_SENDER;
  }
  const authority = resolved.authority;
  const authorityId = resolved.authority_id;
  const to = resolved.sender_e164;

  // Both switches must be on. Decisions gates the token mint; outbound gates the
  // prompt. Minting without being able to deliver would leave live tokens that
  // nobody was ever shown.
  if (!isWhatsAppDecisionsEnabled() || !isWhatsAppOutboundEnabled()) {
    await reply(transport, to, REPLY.UNAVAILABLE);
    await writeAudit(WHATSAPP_REVIEW_AUDIT_ACTIONS.REFUSED,
      { reason: 'DISABLED', sender_masked: maskWhatsAppNumber(to), meta_message_id }, authorityId);
    return REVIEW_OUTCOME.DISABLED;
  }

  if (!context_id) {
    await reply(transport, to, REPLY.UNAVAILABLE);
    return REVIEW_OUTCOME.NO_CONTEXT;
  }

  // Which notification was tapped. The tap itself names no request.
  const dispatch = await findDispatchByProviderMessageIdFirestore(context_id);
  if (!dispatch) {
    await reply(transport, to, REPLY.UNAVAILABLE);
    return REVIEW_OUTCOME.DISPATCH_NOT_FOUND;
  }

  // The correlation record must agree that this notification was addressed to
  // the authority who tapped it. Quoting somebody else's message gets nothing.
  if (dispatch.authority_id !== authorityId) {
    console.warn(`${LOG} refused: the tapped notification belongs to another authority`);
    await writeAudit(WHATSAPP_REVIEW_AUDIT_ACTIONS.REFUSED,
      { reason: 'AUTHORITY_MISMATCH', dispatch_id: dispatch.dispatch_id, meta_message_id }, authorityId);
    return REVIEW_OUTCOME.AUTHORITY_MISMATCH;
  }

  const request = await getPurchaseRequestByIdFirestore(dispatch.request_id);
  if (!request) {
    await reply(transport, to, REPLY.UNAVAILABLE);
    return REVIEW_OUTCOME.REQUEST_NOT_FOUND;
  }

  // Re-checked HERE, at Review time, not merely when the notification was sent.
  if (request.status !== PR_STATUS.PENDING_APPROVAL) {
    await reply(transport, to, REPLY.NOT_PENDING);
    await writeAudit(WHATSAPP_REVIEW_AUDIT_ACTIONS.REFUSED,
      { reason: 'REQUEST_NOT_PENDING', request_id: request.id, status: request.status, meta_message_id }, authorityId);
    return REVIEW_OUTCOME.REQUEST_NOT_PENDING;
  }

  // The engine's own rule, freshly, including self-approval. Not restated here.
  const actor = { uid: authorityId, name: authority.display_name || null, email: null, role: null };
  try {
    await assertExternalAuthorityCanApprove(request, actor, authority);
  } catch (err) {
    await reply(transport, to, REPLY.UNAVAILABLE);
    await writeAudit(WHATSAPP_REVIEW_AUDIT_ACTIONS.REFUSED,
      { reason: err?.code || 'NOT_ELIGIBLE', request_id: request.id, meta_message_id }, authorityId);
    return REVIEW_OUTCOME.NOT_ELIGIBLE;
  }

  // Bounded: compare-and-increment in one transaction, so two concurrent taps
  // cannot both read the same count and both mint.
  const granted = await claimBridgeMintFirestore(dispatch.dispatch_id, { maxMints: WHATSAPP_REVIEW_MAX_MINTS });
  if (!granted.granted) {
    await reply(transport, to, REPLY.TOO_MANY);
    await writeAudit(WHATSAPP_REVIEW_AUDIT_ACTIONS.REFUSED,
      { reason: granted.reason, request_id: request.id, dispatch_id: dispatch.dispatch_id }, authorityId);
    return REVIEW_OUTCOME.MINT_LIMIT_REACHED;
  }

  // Exactly one live pair per authority per request: the previous pair is
  // retired before a new one exists, so an older message stops working the
  // moment a newer one is sent.
  try {
    await invalidateApprovalActionsForRequestFirestore(request.id, {
      reason: 'REVIEW_REMINTED', approverUid: authorityId
    });
  } catch (err) {
    console.warn(`${LOG} could not invalidate the previous pair: ${err.message}`);
  }

  const expiresAt = new Date(Date.now() + PR_DECISION_TOKEN_TTL_MS).toISOString();
  let approve, reject;
  try {
    approve = await createApprovalActionFirestore({
      pr_id: request.id, pr_number: request.request_number,
      approver_uid: authorityId, action: PR_APPROVAL_ACTIONS.APPROVED,
      expires_at: expiresAt, created_by: `whatsapp_review:${authorityId}`
    });
    reject = await createApprovalActionFirestore({
      pr_id: request.id, pr_number: request.request_number,
      approver_uid: authorityId, action: PR_APPROVAL_ACTIONS.REJECTED,
      expires_at: expiresAt, created_by: `whatsapp_review:${authorityId}`
    });
  } catch (err) {
    console.warn(`${LOG} mint failed: ${err.message}`);
    await reply(transport, to, REPLY.FAILED);
    return REVIEW_OUTCOME.PROMPT_FAILED;
  }

  // The raw tokens exist only in these two payloads and only until the send.
  const approvePayload = buildApprovePayload(approve.raw_token);
  const rejectPayload = buildRejectPayload(reject.raw_token);
  if (!approvePayload || !rejectPayload) {
    console.warn(`${LOG} refused: a payload could not be built`);
    await reply(transport, to, REPLY.FAILED);
    return REVIEW_OUTCOME.PROMPT_FAILED;
  }

  // Its own dispatch row, with the prompt purpose, so the prompt is correlated
  // exactly as the notification was. A duplicate claim is not an error here:
  // the counter above is what bounds repetition.
  let promptDispatchId = null;
  try {
    const claim = await claimDispatchFirestore({
      request_id: request.id, authority_id: authorityId,
      purpose: WHATSAPP_DISPATCH_PURPOSE.PR_DECISION_PROMPT,
      request_number: request.request_number || null
    });
    promptDispatchId = claim.dispatch_id;
  } catch (err) {
    console.warn(`${LOG} could not claim the prompt dispatch: ${err.message}`);
  }

  const result = await transport.sendInteractiveButtonsMessage({
    to,
    bodyText: `Purchase request ${request.request_number} — ${request.department || 'General'}. Choose Approve or Reject.`,
    buttons: [
      { id: approvePayload, title: BUTTON.APPROVE },
      { id: rejectPayload, title: BUTTON.REJECT }
    ]
  });

  if (result?.sent && result.message_id) {
    if (promptDispatchId) {
      try { await recordProviderMessageIdFirestore(promptDispatchId, result.message_id); }
      catch (err) { console.warn(`${LOG} could not record the prompt id: ${err.message}`); }
    }
    await writeAudit(WHATSAPP_REVIEW_AUDIT_ACTIONS.PROMPTED, {
      request_id: request.id, request_number: request.request_number,
      dispatch_id: promptDispatchId, mint_count: granted.count,
      sender_masked: maskWhatsAppNumber(to)
    }, authorityId);
    console.log(`${LOG} prompted ${request.request_number} (mint ${granted.count})`);
    return REVIEW_OUTCOME.PROMPT_SENT;
  }

  // The prompt did not go out. The tokens exist but nobody has them, and they
  // expire on their own; nothing is retried and the request is untouched.
  const state = result?.outcome === WHATSAPP_SEND_STATE.UNKNOWN
    ? WHATSAPP_SEND_STATE.UNKNOWN
    : WHATSAPP_SEND_STATE.FAILED;
  if (promptDispatchId) {
    try { await markDispatchSendStateFirestore(promptDispatchId, state); }
    catch (err) { console.warn(`${LOG} could not record the prompt state: ${err.message}`); }
  }
  await writeAudit(WHATSAPP_REVIEW_AUDIT_ACTIONS.REFUSED, {
    reason: result?.reason || 'SEND_ERROR', send_state: state,
    request_id: request.id, dispatch_id: promptDispatchId
  }, authorityId);
  console.warn(`${LOG} prompt not delivered: ${result?.reason || 'SEND_ERROR'}`);
  return REVIEW_OUTCOME.PROMPT_FAILED;
}

export default { handleReviewTap, isReviewTap, REVIEW_OUTCOME };
