/**
 * backend/services/whatsappNotificationService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-C — what happens AFTER a purchase request has been submitted.
 *
 * One job: tell every eligible approval authority, over WhatsApp, that a
 * request is waiting. Nothing else.
 *
 * WHAT THIS FILE MUST NEVER DO
 * It mints no approval or rejection token, makes no decision, changes no
 * purchase request, routes nothing inbound, and creates no collection of its
 * own. A token belongs to the moment an authority actually taps Review, which
 * is H8-D; minting at submit time would put a live bearer token in a message
 * nobody may have asked for and leave it valid for its whole lifetime.
 *
 * POST-COMMIT, ALWAYS
 * The purchase-request transaction has already committed before this runs. No
 * network call of any kind happens inside a Firestore transaction, and a
 * WhatsApp failure can never roll back or fail a submission that succeeded. The
 * caller treats this as fire-and-forget; every error is caught here.
 *
 * ELIGIBILITY IS BORROWED, NOT RESTATED
 * "Who may approve this request" already has exactly one definition and this
 * file does not add a second. It composes three existing checks:
 *   isAuthorityDecisionEligible      external, verified, unexpired, active
 *   resolveAuthorityBySender         the same binding path H7 trusts inbound
 *   assertExternalAuthorityCanApprove the engine's own per-request rule,
 *                                    including self-approval
 * Using the sender resolver in the forward direction is deliberate: an
 * authority is notified on a number only if that number would be accepted
 * coming back the other way.
 *
 * AT MOST ONE SEND PER DISPATCH
 * The H8-A dispatch id is deterministic in (request, authority, purpose), and
 * claiming it is a create. A replayed submit, a duplicated handler or two
 * concurrent callers all collide on the same id and only one wins. A send is
 * attempted only by the winner. Exactly-once delivery is not achievable against
 * a provider with no idempotency key, so what is guaranteed here is at most one
 * ATTEMPT per dispatch — an unknown outcome is recorded, never retried, and
 * never reclaimed.
 *
 * NEVER SENT, LOGGED, AUDITED OR EMITTED: a token, a verification code, a
 * credential, or a full phone number. Numbers appear only masked, and only in
 * the audit trail.
 */

import crypto from 'crypto';
import { isWhatsAppOutboundEnabled } from '../config/featureFlags.js';
import {
  WHATSAPP_DISPATCH_PURPOSE,
  WHATSAPP_SEND_STATE,
  PR_WHATSAPP_EVENTS
} from '../utils/inventoryConstants.js';
import {
  listApprovalAuthoritiesFirestore,
  isAuthorityDecisionEligible,
  maskWhatsAppNumber
} from '../repositories/firestore/inventoryApprovalAuthoritiesRepository.js';
import {
  claimDispatchFirestore,
  recordProviderMessageIdFirestore,
  markDispatchSendStateFirestore
} from '../repositories/firestore/whatsappMessagesRepository.js';
import { resolveAuthorityBySender } from './whatsappAuthorityVerificationService.js';
import { assertExternalAuthorityCanApprove } from './purchaseRequestApprovalService.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import * as replyTransport from './whatsappOutboundClient.js';

const LOG = '[WhatsAppNotify]';

/** Audit actions, following the naming the other WhatsApp phases established. */
export const WHATSAPP_NOTIFICATION_AUDIT_ACTIONS = Object.freeze({
  QUEUED: 'INVENTORY_WHATSAPP_REQUEST_QUEUED',
  SENT: 'INVENTORY_WHATSAPP_REQUEST_SENT',
  FAILED: 'INVENTORY_WHATSAPP_REQUEST_FAILED'
});

/** Why one authority was passed over. Recorded, never sent anywhere. */
export const SKIP_REASON = Object.freeze({
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  BINDING_UNUSABLE: 'BINDING_UNUSABLE',
  CANNOT_APPROVE: 'CANNOT_APPROVE',
  ALREADY_DISPATCHED: 'ALREADY_DISPATCHED'
});

/** The outcome of one fan-out. */
export const FANOUT_OUTCOME = Object.freeze({
  DISABLED: 'DISABLED',
  NO_ELIGIBLE_AUTHORITIES: 'NO_ELIGIBLE_AUTHORITIES',
  COMPLETED: 'COMPLETED'
});

/** Our own ceiling for the free-text reason inside the approved template. */
export const REASON_MAX_LENGTH = 300;
export const REASON_PLACEHOLDER = 'No reason given';

/**
 * The one free-text field that reaches a template. A newline or tab would
 * reshape the rendered message and the transport refuses them outright, so they
 * are collapsed here rather than allowed to fail the send.
 */
export function sanitizeReason(value) {
  const collapsed = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!collapsed) return REASON_PLACEHOLDER;
  return collapsed.length <= REASON_MAX_LENGTH ? collapsed : collapsed.slice(0, REASON_MAX_LENGTH - 1).trimEnd() + '…';
}

/** A readable amount. No currency symbol: the template supplies its own wording. */
function formatAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/**
 * The approved notification fields, and only those. Supplier is absent because
 * a purchase request has no supplier: that belongs to a purchase order.
 */
export function buildNotificationParameters(request) {
  return {
    request_number: String(request?.request_number ?? '').trim() || 'UNKNOWN',
    department: String(request?.department ?? '').trim() || 'General',
    item_count: String(Number(request?.item_count) || 0),
    estimated_total: formatAmount(request?.total_estimated_value),
    reason: sanitizeReason(request?.reason)
  };
}

/** Audit without a request object, matching the H7 router's pattern. */
async function writeAudit(action, details, authorityId) {
  try {
    await createAuditLogFirestore({
      log_id: `inv_wa_notify_${action.toLowerCase()}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      action,
      details: { authority_id: authorityId || null, ...details },
      user_id: authorityId || 'system:whatsapp'
    });
  } catch (err) {
    console.warn(`${LOG} audit log failed (${action}): ${err.message}`);
  }
}

/**
 * Socket.IO carries a display hint and nothing more. Every field here is
 * already readable by any inventory user through the authenticated API, and
 * none of it grants anything: the Staff Portal still authorises server-side on
 * every call. No number, masked or otherwise, goes into a payload.
 */
function emit(io, event, payload) {
  try {
    io?.emit(event, payload);
  } catch (err) {
    console.warn(`${LOG} emit failed (${event}): ${err.message}`);
  }
}

/**
 * Decides, for ONE authority, whether this request may be announced to them.
 *
 * Composes the existing checks in order of cost: the cheap local predicate,
 * then the binding lookup, then the engine's own per-request rule.
 */
async function screenAuthority(authority, request) {
  if (!isAuthorityDecisionEligible(authority)) {
    return { ok: false, reason: SKIP_REASON.NOT_ELIGIBLE };
  }

  // The forward use of the inbound resolver: notify on this number only if a
  // message arriving FROM it would be accepted as this same authority.
  const resolved = await resolveAuthorityBySender(authority.whatsapp_e164);
  if (!resolved.ok || resolved.authority_id !== authority.authority_id) {
    return { ok: false, reason: SKIP_REASON.BINDING_UNUSABLE, code: resolved.code || 'BINDING_MISMATCH' };
  }

  // The engine's own rule, including the self-approval refusal. Calling it
  // rather than restating it is what keeps a single definition of the policy.
  const actor = { uid: authority.authority_id, name: authority.display_name || null, email: null, role: null };
  try {
    await assertExternalAuthorityCanApprove(request, actor, authority);
  } catch (err) {
    return { ok: false, reason: SKIP_REASON.CANNOT_APPROVE, code: err?.code || 'REFUSED' };
  }

  return { ok: true, sendTo: resolved.sender_e164 };
}

/**
 * Announces one purchase request to every authority who may decide it.
 *
 * Never throws. The submission has already committed and the caller must not be
 * able to fail because of a notification.
 *
 * @param {object}  o
 * @param {object}  o.request  the committed purchase request
 * @param {object} [o.io]      Socket.IO server, for display hints only
 * @param {object} [o.client]  transport override; tests inject a recorder
 */
export async function notifyAuthoritiesOfPurchaseRequest({ request, io = null, client = null } = {}) {
  const summary = {
    outcome: FANOUT_OUTCOME.COMPLETED,
    considered: 0, claimed: 0, sent: 0, failed: 0, unknown: 0,
    skipped: []
  };

  // The kill switch, before anything at all. Nothing is read, nothing is
  // claimed, no transport is touched and no record is created while it is off.
  if (!isWhatsAppOutboundEnabled()) {
    summary.outcome = FANOUT_OUTCOME.DISABLED;
    return summary;
  }

  const requestId = request?.id || request?.request_id;
  if (!requestId) {
    console.warn(`${LOG} refused: the request carries no id`);
    summary.outcome = FANOUT_OUTCOME.NO_ELIGIBLE_AUTHORITIES;
    return summary;
  }

  const transport = client || replyTransport.whatsappReplyClient;

  let authorities = [];
  try {
    authorities = await listApprovalAuthoritiesFirestore();
  } catch (err) {
    console.warn(`${LOG} could not list authorities: ${err.message}`);
    summary.outcome = FANOUT_OUTCOME.NO_ELIGIBLE_AUTHORITIES;
    return summary;
  }

  // Two entries naming the same authority would otherwise race against their
  // own dispatch claim. The claim would still hold, but de-duplicating first
  // keeps the outcome legible.
  const unique = [];
  const seen = new Set();
  for (const a of authorities) {
    const id = a?.authority_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(a);
  }
  summary.considered = unique.length;

  for (const authority of unique) {
    const authorityId = authority.authority_id;
    let screened;
    try {
      screened = await screenAuthority(authority, request);
    } catch (err) {
      console.warn(`${LOG} screening failed for one authority: ${err.message}`);
      summary.skipped.push({ authority_id: authorityId, reason: SKIP_REASON.NOT_ELIGIBLE });
      continue;
    }
    if (!screened.ok) {
      summary.skipped.push({ authority_id: authorityId, reason: screened.reason, code: screened.code || null });
      continue;
    }

    // The claim is the de-duplicator. A replay, a duplicated handler and a
    // concurrent caller all land on the same deterministic id, and only the
    // winner proceeds to send.
    let claim;
    try {
      claim = await claimDispatchFirestore({
        request_id: requestId,
        authority_id: authorityId,
        purpose: WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION,
        request_number: request.request_number || null,
        template_name: process.env.WHATSAPP_TEMPLATE_PR_REVIEW || null
      });
    } catch (err) {
      console.warn(`${LOG} claim failed for ${authorityId}: ${err.message}`);
      summary.failed += 1;
      continue;
    }

    if (!claim.claimed) {
      // Already dispatched. Not an error, and emphatically not a second send.
      summary.skipped.push({ authority_id: authorityId, reason: SKIP_REASON.ALREADY_DISPATCHED });
      continue;
    }
    summary.claimed += 1;

    const dispatchId = claim.dispatch_id;
    emit(io, PR_WHATSAPP_EVENTS.QUEUED, {
      request_id: requestId,
      request_number: request.request_number || null,
      authority_id: authorityId,
      authority_name: authority.display_name || null,
      dispatch_id: dispatchId,
      purpose: WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION
    });
    await writeAudit(WHATSAPP_NOTIFICATION_AUDIT_ACTIONS.QUEUED, {
      request_id: requestId,
      request_number: request.request_number || null,
      dispatch_id: dispatchId,
      recipient_masked: maskWhatsAppNumber(screened.sendTo)
    }, authorityId);

    // One dispatch, one attempt. There is no retry here by design.
    let result;
    try {
      result = await transport.sendTemplateMessage({
        to: screened.sendTo,
        parameters: buildNotificationParameters(request)
      });
    } catch (err) {
      // The transport reports rather than throws, so this is belt and braces.
      console.warn(`${LOG} transport threw for ${authorityId}: ${err?.name || 'Error'}`);
      result = { sent: false, reason: 'SEND_ERROR', outcome: WHATSAPP_SEND_STATE.FAILED };
    }

    if (result?.sent && result.message_id) {
      try { await recordProviderMessageIdFirestore(dispatchId, result.message_id); }
      catch (err) { console.warn(`${LOG} could not record provider id: ${err.message}`); }
      summary.sent += 1;
      emit(io, PR_WHATSAPP_EVENTS.STATUS, {
        request_id: requestId, request_number: request.request_number || null,
        authority_id: authorityId, authority_name: authority.display_name || null,
        dispatch_id: dispatchId, send_state: WHATSAPP_SEND_STATE.SENT
      });
      await writeAudit(WHATSAPP_NOTIFICATION_AUDIT_ACTIONS.SENT, {
        request_id: requestId, request_number: request.request_number || null,
        dispatch_id: dispatchId, provider_message_id: result.message_id
      }, authorityId);
      continue;
    }

    // Anything else is not a send. An unknown outcome stays unknown: the
    // message may well have gone out, so it is recorded and left alone rather
    // than retried into a possible duplicate.
    const state = result?.outcome === WHATSAPP_SEND_STATE.UNKNOWN
      ? WHATSAPP_SEND_STATE.UNKNOWN
      : WHATSAPP_SEND_STATE.FAILED;
    if (state === WHATSAPP_SEND_STATE.UNKNOWN) summary.unknown += 1; else summary.failed += 1;

    try { await markDispatchSendStateFirestore(dispatchId, state); }
    catch (err) { console.warn(`${LOG} could not record send state: ${err.message}`); }

    emit(io, PR_WHATSAPP_EVENTS.FAILED, {
      request_id: requestId, request_number: request.request_number || null,
      authority_id: authorityId, authority_name: authority.display_name || null,
      dispatch_id: dispatchId, send_state: state, reason: result?.reason || 'SEND_ERROR'
    });
    await writeAudit(WHATSAPP_NOTIFICATION_AUDIT_ACTIONS.FAILED, {
      request_id: requestId, request_number: request.request_number || null,
      dispatch_id: dispatchId, send_state: state, reason: result?.reason || 'SEND_ERROR',
      http_status: result?.http_status ?? null, provider_code: result?.provider_code ?? null
    }, authorityId);
  }

  if (summary.claimed === 0 && summary.sent === 0) {
    summary.outcome = FANOUT_OUTCOME.NO_ELIGIBLE_AUTHORITIES;
  }
  console.log(`${LOG} request ${request.request_number || requestId}: considered=${summary.considered} claimed=${summary.claimed} sent=${summary.sent} failed=${summary.failed} unknown=${summary.unknown}`);
  return summary;
}

export default { notifyAuthoritiesOfPurchaseRequest };
