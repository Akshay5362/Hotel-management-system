/**
 * backend/services/whatsappDecisionRouter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H7 — turning a verified tap into a call to an engine that already
 * exists. A THIN ROUTER, and nothing else.
 *
 * WHAT THIS FILE DOES NOT DO
 * It does not decide. It never writes to purchase_requests, never consumes a
 * token, never mints one, never opens a Firestore transaction and never
 * reimplements a rule. Approval is H3's `decideWithApprovalActionToken`;
 * rejection is H4's `beginTokenRejection` and `completeTokenRejection`. Every
 * guarantee — first-valid-decision-wins, single-use tokens, in-transaction
 * re-reads, sibling retirement, self-approval — belongs to those, untouched.
 *
 * THE TRUST CHAIN, IN ORDER
 *   1. H5 proved the body came from Meta, over the raw bytes, and claimed the
 *      message id exactly once.
 *   2. The sender is `messages[].from`, attested by Meta inside that signed
 *      body. It is the ONLY identity this system accepts.
 *   3. H6 resolves that sender to one authority: external, verified, inside
 *      its 180-day validity, and active.
 *   4. Only then does an authority id become `decided_by_uid`, server-side.
 *
 * Nothing in the action payload contributes identity. A payload says which
 * action on which token, and both are re-verified by the engine against the
 * authority resolved above.
 *
 * WHAT AN UNKNOWN SENDER GETS
 * Silence. Any reply at all would confirm whether a number is registered.
 *
 * NEVER LOGGED, NEVER AUDITED: a raw token, a token hash, a verification code,
 * a secret, or a full phone number. Numbers are masked; outcomes are codes.
 */

import crypto from 'crypto';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { maskWhatsAppNumber } from '../repositories/firestore/inventoryApprovalAuthoritiesRepository.js';
import { PurchaseRequestApprovalService } from './purchaseRequestApprovalService.js';
import { resolveAuthorityBySender } from './whatsappAuthorityVerificationService.js';
import * as replyTransport from './whatsappOutboundClient.js';
import { isWhatsAppDecisionsEnabled } from '../config/featureFlags.js';
import {
  parseActionPayload,
  buildReasonPayload,
  WHATSAPP_ACTION
} from '../utils/whatsappActionPayload.js';
import {
  PR_EVENTS,
  PR_APPROVAL_ACTIONS,
  PR_REJECTION_REASON_CODES
} from '../utils/inventoryConstants.js';

const LOG = '[WhatsAppDecision]';

/** What the router did. Returned to the dispatcher for its event row and log. */
export const ROUTER_OUTCOME = Object.freeze({
  NOT_AN_ACTION: 'NOT_AN_ACTION',
  MALFORMED_ACTION: 'MALFORMED_ACTION',
  UNKNOWN_SENDER: 'UNKNOWN_SENDER',
  SENDER_NOT_ELIGIBLE: 'SENDER_NOT_ELIGIBLE',
  DISABLED: 'DISABLED',
  APPROVED: 'APPROVED',
  APPROVE_DUPLICATE: 'APPROVE_DUPLICATE',
  REJECTION_STARTED: 'REJECTION_STARTED',
  REJECTED: 'REJECTED',
  REJECT_DUPLICATE: 'REJECT_DUPLICATE',
  REFUSED: 'REFUSED'
});

export const WHATSAPP_DECISION_AUDIT_ACTIONS = Object.freeze({
  APPROVAL_TAPPED: 'INVENTORY_WHATSAPP_APPROVAL_TAPPED',
  REJECTION_STARTED: 'INVENTORY_WHATSAPP_REJECTION_STARTED',
  REJECTION_COMPLETED: 'INVENTORY_WHATSAPP_REJECTION_COMPLETED',
  ACTION_REFUSED: 'INVENTORY_WHATSAPP_ACTION_REFUSED'
});

/**
 * Every reply the authority can receive. Deliberately generic wherever a
 * specific answer would help someone probing: one message covers an unknown
 * token, a token belonging to another authority, another request, and a
 * purpose mismatch, so none of them is distinguishable from outside.
 */
const REPLY = Object.freeze({
  DISABLED: 'WhatsApp approvals are not available right now. Please use the HPMS Staff Portal.',
  UNAVAILABLE: 'This action is no longer available. Please ask for a new approval request.',
  EXPIRED: 'This approval request has expired. Please ask for a new one.',
  ALREADY_DECIDED: 'This purchase request has already been decided.',
  NOT_PERMITTED: 'You are not able to act on this request.',
  PICK_LISTED_REASON: 'Please choose one of the listed reasons.',
  HELP: 'Use the Approve or Reject buttons on an approval request to act on it.'
});

/**
 * Engine error code to outcome and reply. Anything unmapped falls through to
 * the generic UNAVAILABLE, so a new error code can never leak its meaning by
 * default.
 */
const ERROR_REPLY = Object.freeze({
  TOKEN_CONSUMED: REPLY.ALREADY_DECIDED,
  TOKEN_EXPIRED: REPLY.EXPIRED,
  INVALID_STATUS_TRANSITION: REPLY.ALREADY_DECIDED,
  APPROVER_ALREADY_ACTED: REPLY.ALREADY_DECIDED,
  REJECTION_REASON_CODE_INVALID: REPLY.PICK_LISTED_REASON,
  REJECTION_REASON_CODE_REQUIRED: REPLY.PICK_LISTED_REASON,
  PURCHASE_REQUEST_APPROVALS_DISABLED: REPLY.DISABLED,
  PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN: REPLY.NOT_PERMITTED,
  AUTHORITY_INACTIVE: REPLY.NOT_PERMITTED,
  AUTHORITY_NOT_VERIFIED: REPLY.NOT_PERMITTED,
  AUTHORITY_VERIFICATION_EXPIRED: REPLY.NOT_PERMITTED,
  AUTHORITY_REVOKED: REPLY.NOT_PERMITTED
});

/** Audit, in the existing convention. There is no request object on this path. */
async function writeAudit(action, details, authorityId) {
  try {
    await createAuditLogFirestore({
      log_id: `inv_wa_decision_${action.toLowerCase()}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      action,
      details: { authority_id: authorityId || null, ...details },
      user_id: authorityId || 'system:whatsapp'
    });
  } catch (err) {
    console.warn(`${LOG} audit log failed (${action}): ${err.message}`);
  }
}

/**
 * Post-commit only, and only for a decision that actually changed the request.
 * Socket.IO is a notification that something moved; the Staff Portal still
 * reads through the authenticated API, so this never grants anything.
 */
function emitDecided(io, request, authority) {
  try {
    io?.emit(PR_EVENTS.DECIDED, {
      request_id: request.id || request.request_id,
      request_number: request.request_number,
      status: request.status,
      decided_by_uid: authority.authority_id || null,
      decided_by_name: authority.display_name || null
    });
  } catch (err) {
    console.warn(`${LOG} decision notification emit failed: ${err.message}`);
  }
}

/** The six server-owned reasons, as list rows carrying the intent token. */
function reasonRows(intentToken) {
  return Object.entries(PR_REJECTION_REASON_CODES)
    .map(([code, text]) => ({ id: buildReasonPayload(intentToken, code), title: titleFor(code), description: text }))
    .filter(row => row.id);
}

/** A short human label per code. The payload, not the label, carries meaning. */
function titleFor(code) {
  return code.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

/**
 * Routes ONE verified inbound action.
 *
 * @param {object} p
 * @param {string} p.sender_id  the Meta-attested sender, from the signed body
 * @param {string} p.payload    the identifier Meta echoed back
 * @param {object} [p.io]       Socket.IO server, for the post-commit notification
 * @param {object} [p.client]   reply transport; injectable for tests
 * @returns {Promise<string>} one of ROUTER_OUTCOME
 */
export async function routeWhatsAppAction({
  sender_id, payload, meta_message_id = null, io = null, client = null
} = {}) {
  // Resolved per call, so an installed test client is honoured on the real path.
  client = client || replyTransport.whatsappReplyClient;
  const parsed = parseActionPayload(payload);

  // ── 1. Identity FIRST. An unknown sender gets no reply of any kind, so the
  //       webhook cannot be used to test whether a number is registered.
  const resolved = await resolveAuthorityBySender(sender_id);
  if (!resolved.ok) {
    if (resolved.code === 'UNKNOWN_SENDER') {
      console.log(`${LOG} ignored: sender not registered`);
      return ROUTER_OUTCOME.UNKNOWN_SENDER;
    }
    // A registered but ineligible authority is told only that it cannot act.
    await writeAudit(WHATSAPP_DECISION_AUDIT_ACTIONS.ACTION_REFUSED,
      { reason: resolved.code, sender_masked: maskWhatsAppNumber(resolved.sender_e164), meta_message_id },
      resolved.authority_id);
    await client.sendText(sender_id, REPLY.NOT_PERMITTED);
    console.log(`${LOG} refused: ${resolved.code}`);
    return ROUTER_OUTCOME.SENDER_NOT_ELIGIBLE;
  }
  const authority = resolved.authority;
  const authorityId = authority.authority_id;
  const senderMasked = maskWhatsAppNumber(authority.whatsapp_e164);

  // ── 2. A verified authority who sent something that is not an action gets a
  //       harmless hint, never an error and never any request detail.
  if (!parsed.ok) {
    console.log(`${LOG} ${authorityId}: not an action (${parsed.reason})`);
    await client.sendText(sender_id, REPLY.HELP);
    return parsed.reason === 'NOT_AN_ACTION' ? ROUTER_OUTCOME.NOT_AN_ACTION : ROUTER_OUTCOME.MALFORMED_ACTION;
  }

  // ── 3. The kill switch, evaluated server-side at execution time, BEFORE any
  //       token is read. While off nothing is consumed and no intent is minted.
  if (!isWhatsAppDecisionsEnabled()) {
    await writeAudit(WHATSAPP_DECISION_AUDIT_ACTIONS.ACTION_REFUSED,
      { reason: 'WHATSAPP_DECISIONS_DISABLED', action: parsed.action, sender_masked: senderMasked, meta_message_id },
      authorityId);
    await client.sendText(sender_id, REPLY.DISABLED);
    console.log(`${LOG} ${authorityId}: refused, decisions disabled`);
    return ROUTER_OUTCOME.DISABLED;
  }

  const ctx = { sender_id, authority, authorityId, senderMasked, meta_message_id, io, client };
  if (parsed.action === WHATSAPP_ACTION.APPROVE) return await handleApprove(parsed, ctx);
  if (parsed.action === WHATSAPP_ACTION.REJECT) return await handleRejectStart(parsed, ctx);
  return await handleRejectComplete(parsed, ctx);
}

/** Shared refusal path: audit the code, reply generically, never explain. */
async function refuse(err, ctx, action) {
  const code = err?.code || 'UNKNOWN_ERROR';
  await writeAudit(WHATSAPP_DECISION_AUDIT_ACTIONS.ACTION_REFUSED,
    { reason: code, action, sender_masked: ctx.senderMasked, meta_message_id: ctx.meta_message_id },
    ctx.authorityId);
  await ctx.client.sendText(ctx.sender_id, ERROR_REPLY[code] || REPLY.UNAVAILABLE);
  console.log(`${LOG} ${ctx.authorityId}: ${action} refused (${code})`);
  return code === 'TOKEN_CONSUMED' || code === 'INVALID_STATUS_TRANSITION'
    ? ROUTER_OUTCOME.REFUSED
    : ROUTER_OUTCOME.REFUSED;
}

/** APPROVE — one call into the existing engine. */
async function handleApprove(parsed, ctx) {
  await writeAudit(WHATSAPP_DECISION_AUDIT_ACTIONS.APPROVAL_TAPPED,
    { sender_masked: ctx.senderMasked, meta_message_id: ctx.meta_message_id }, ctx.authorityId);
  try {
    const result = await PurchaseRequestApprovalService.decideWithApprovalActionToken({
      raw_token: parsed.token,
      decided_by_uid: ctx.authorityId,
      action: PR_APPROVAL_ACTIONS.APPROVED,
      consumed_via: 'WHATSAPP_BUTTON'
    });
    const number = result.request?.request_number || '';
    if (result.duplicate) {
      await ctx.client.sendText(ctx.sender_id, REPLY.ALREADY_DECIDED);
      return ROUTER_OUTCOME.APPROVE_DUPLICATE;
    }
    emitDecided(ctx.io, result.request, ctx.authority);
    await ctx.client.sendText(ctx.sender_id, `Purchase request ${number} has been approved. Thank you.`.trim());
    console.log(`${LOG} ${ctx.authorityId}: approved ${result.request?.id}`);
    return ROUTER_OUTCOME.APPROVED;
  } catch (err) {
    return await refuse(err, ctx, 'APPROVE');
  }
}

/**
 * REJECT, step one. `beginTokenRejection` validates everything except the
 * reason and mints a short-lived intent; it consumes NOTHING, so an abandoned
 * rejection leaves the original decision token usable.
 */
async function handleRejectStart(parsed, ctx) {
  try {
    const intent = await PurchaseRequestApprovalService.beginTokenRejection({
      raw_token: parsed.token,
      decided_by_uid: ctx.authorityId
    });
    await writeAudit(WHATSAPP_DECISION_AUDIT_ACTIONS.REJECTION_STARTED,
      { request_id: intent.request_id, request_number: intent.request_number,
        sender_masked: ctx.senderMasked, meta_message_id: ctx.meta_message_id }, ctx.authorityId);
    const sent = await ctx.client.sendReasonList(ctx.sender_id, {
      body: `Why are you rejecting purchase request ${intent.request_number}?`,
      buttonLabel: 'Choose a reason',
      rows: reasonRows(intent.raw_token)
    });
    if (!sent.sent) {
      // The intent simply expires and the original token is still live, so the
      // authority can tap Reject again. Nothing is stranded.
      console.warn(`${LOG} ${ctx.authorityId}: reason list not delivered (${sent.reason})`);
    }
    return ROUTER_OUTCOME.REJECTION_STARTED;
  } catch (err) {
    return await refuse(err, ctx, 'REJECT_START');
  }
}

/**
 * REJECT, step two. The identity is passed explicitly so H4 cross-checks it
 * against the intent: a list reply arriving from a DIFFERENT verified
 * authority is refused rather than accepted on possession of the intent alone.
 */
async function handleRejectComplete(parsed, ctx) {
  try {
    const result = await PurchaseRequestApprovalService.completeTokenRejection({
      raw_token: parsed.token,
      reason_code: parsed.reason_code,
      decided_by_uid: ctx.authorityId,
      consumed_via: 'WHATSAPP_REASON_LIST'
    });
    const number = result.request?.request_number || '';
    if (result.duplicate) {
      await ctx.client.sendText(ctx.sender_id, REPLY.ALREADY_DECIDED);
      return ROUTER_OUTCOME.REJECT_DUPLICATE;
    }
    await writeAudit(WHATSAPP_DECISION_AUDIT_ACTIONS.REJECTION_COMPLETED,
      { request_id: result.request?.id, request_number: number, reason_code: parsed.reason_code,
        sender_masked: ctx.senderMasked, meta_message_id: ctx.meta_message_id }, ctx.authorityId);
    emitDecided(ctx.io, result.request, ctx.authority);
    await ctx.client.sendText(ctx.sender_id,
      `Purchase request ${number} has been rejected. Reason recorded: ${result.request?.rejection_reason || ''}`.trim());
    console.log(`${LOG} ${ctx.authorityId}: rejected ${result.request?.id}`);
    return ROUTER_OUTCOME.REJECTED;
  } catch (err) {
    return await refuse(err, ctx, 'REJECT_COMPLETE');
  }
}
