/**
 * purchaseRequestApprovalService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase C — PURCHASE REQUEST APPROVAL ENGINE.
 *
 *   PENDING_APPROVAL ──approve──▶ APPROVED   (terminal)
 *   PENDING_APPROVAL ──reject───▶ REJECTED   (terminal)
 *
 * APPROVAL MODEL: ANY ONE authorized approver closes the request. The first
 * valid decision wins; no quorum. The approvals[] array is nevertheless kept
 * as an append-only list so a future multi-approver rule can build on it
 * without a data migration.
 *
 * STOCK SAFETY: an approval is a DECISION, not a purchase. This module does
 * not import inventoryStockService, inventoryNumberService, or any product
 * repository — approving or rejecting cannot change a balance, create a
 * movement, or allocate a new request number, by construction.
 *
 * CONCURRENCY: the status check and the write happen inside ONE Firestore
 * transaction. If two approvers act at once, Firestore serializes them: the
 * second transaction re-reads the already-terminal request and refuses, so
 * there can never be an APPROVED request carrying a later REJECTED transition
 * (or vice versa), and approvals[] only ever records committed decisions.
 */

import crypto from 'crypto';
import { db } from '../config/firebaseAdmin.js';
import { formatDocSnapshot, RepositoryError } from '../repositories/firestore/firestoreUtils.js';
// H3 -- a service importing from a controller already has precedent here
// (housekeepingCutoverService does the same). authController imports no
// service that imports this one, so there is no cycle.
import { normalizeUserRole } from '../controllers/authController.js';
import { getStaffByUidFirestore } from '../repositories/firestore/staffRepository.js';
import {
  getApprovalAuthorityByUidFirestore,
  APPROVAL_AUTHORITIES_COLLECTION
} from '../repositories/firestore/inventoryApprovalAuthoritiesRepository.js';
import {
  findApprovalActionByTokenFirestore,
  readApprovalActionInTxn,
  markApprovalActionConsumedInTxn,
  invalidateApprovalActionsForRequestFirestore,
  normalizeAction as normalizeApprovalActionToken,
  ACTION_INVALID
} from '../repositories/firestore/inventoryApprovalActionsRepository.js';
import {
  formatRequestDocId,
  requestRef,
  getPurchaseRequestByIdFirestore,
  getPurchaseRequestItemsFirestore
} from '../repositories/firestore/purchaseRequestsRepository.js';
import {
  getInventoryApprovalConfigFirestore,
  roleCanApprove
} from '../repositories/firestore/inventoryApprovalConfigRepository.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import {
  PR_STATUS, PR_TRANSITIONS, PR_APPROVAL_ACTIONS, PR_ACTION_TO_STATUS,
  MIN_REJECTION_REASON_LENGTH
} from '../utils/inventoryConstants.js';

function fail(message, code, status = 400) {
  return new RepositoryError(message, code, status);
}

function cleanText(v, max = 1000) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** Deterministic-ish id for one approval record (unique per approver+action+request). */
function newApprovalId(requestDocId, actorUid, action) {
  const base = `${requestDocId}_${actorUid || 'unknown'}_${action}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `apr_${base}_${crypto.randomUUID().slice(0, 6)}`.slice(0, 180);
}

async function writeAudit(action, request, actor, extra = {}) {
  try {
    await createAuditLogFirestore({
      // Deterministic per request + outcome, matching the Phase B convention.
      log_id: `inv_pr_${action.toLowerCase()}_${request.id || request.request_id}`,
      action,
      details: {
        request_id: request.id || request.request_id,
        request_number: request.request_number || null,
        status: request.status,
        department: request.department,
        location_id: request.location_id,
        item_count: request.item_count,
        total_estimated_value: request.total_estimated_value,
        approver_uid: actor.uid || null,
        approver_name: actor.name || null,
        approver_role: actor.role || null,
        ...extra
      },
      user_id: actor.uid || 'unknown',
      business_date: request.business_date
    });
  } catch (err) {
    // Audit is a secondary trail; the approval transaction has already
    // committed and must not be undone because logging failed.
    console.warn(`[PurchaseRequestApproval] audit log failed (${action}): ${err.message}`);
  }
}

async function withItems(requestDoc) {
  if (!requestDoc) return null;
  const items = await getPurchaseRequestItemsFirestore(requestDoc.id);
  return { ...requestDoc, items };
}

/**
 * Authorization for an approval decision, evaluated server-side only.
 * Returns the resolved config so callers can report why access was refused.
 */
export async function assertCanApprove(request, actor) {
  const config = await getInventoryApprovalConfigFirestore();

  if (config.enabled === false) {
    throw fail('Purchase request approvals are currently disabled.', 'PURCHASE_REQUEST_APPROVALS_DISABLED', 403);
  }
  if (!actor || !actor.uid) {
    throw fail('An authenticated approver is required.', 'APPROVER_REQUIRED', 401);
  }
  if (!roleCanApprove(config, actor.role)) {
    throw fail(
      `Role '${actor.role || 'unknown'}' is not authorized to approve purchase requests.`,
      'PURCHASE_REQUEST_APPROVAL_FORBIDDEN',
      403
    );
  }
  // A requester may never approve their own request, whatever their role.
  if (request.requested_by_uid && String(request.requested_by_uid) === String(actor.uid)) {
    throw fail(
      'You cannot approve or reject a purchase request that you raised yourself.',
      'PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN',
      403
    );
  }
  return config;
}

/**
 * The one rejection-reason rule, shared by both entry points so the token path
 * can never drift from the in-app path. Pure: reads nothing.
 */
function assertRejectionReason(action, comment) {
  const reason = cleanText(comment, 1000);
  if (action === PR_APPROVAL_ACTIONS.REJECTED && (!reason || reason.length < MIN_REJECTION_REASON_LENGTH)) {
    throw fail(
      `A rejection reason of at least ${MIN_REJECTION_REASON_LENGTH} characters is required.`,
      'REJECTION_REASON_REQUIRED'
    );
  }
  return reason;
}

/**
 * Retires every approval-action token still outstanding for a request that
 * has just become terminal. Post-commit and best-effort, like the audit
 * write: a leftover token is inert anyway (any use meets the terminal-status
 * guard inside the transaction), so a failure here must never undo a
 * committed decision. One bounded query scoped by pr_id; no scan.
 */
async function retireOutstandingActions(requestDocId, status) {
  try {
    await invalidateApprovalActionsForRequestFirestore(requestDocId, { reason: `PR_${status}` });
  } catch (err) {
    console.warn(`[PurchaseRequestApproval] token retirement failed (${requestDocId}): ${err.message}`);
  }
}

/**
 * Records one approval decision atomically.
 *
 * @param {'APPROVED'|'REJECTED'} action
 * @param {object}  opts
 * @param {object} [opts.hooks]  H3 -- extra factors verified INSIDE the transaction.
 *   afterRead(txn, current)    read phase: runs right after the request is read
 *                              and before any rule can throw, so every txn read
 *                              it performs precedes every write.
 *   beforeCommit(txn, current) write phase, synchronous: runs after the request
 *                              update, so its writes commit with the decision.
 *   The in-app path passes no hooks and behaves exactly as before.
 * @param {object} [opts.audit_extra]  merged into the audit details (no secrets).
 * @returns {{ duplicate: boolean, request: object }}
 */
async function decide(requestId, action, { comment, actor, hooks = null, audit_extra = {} }) {
  if (!PR_APPROVAL_ACTIONS[action]) throw fail(`Unknown approval action '${action}'.`, 'INVALID_APPROVAL_ACTION');
  const targetStatus = PR_ACTION_TO_STATUS[action];

  const reason = assertRejectionReason(action, comment);

  const docId = formatRequestDocId(requestId);
  const ref = requestRef(docId);

  // Existence + authorization are resolved before the transaction so a
  // forbidden caller never contends for the document. The authoritative
  // status check still happens INSIDE the transaction below.
  const preflight = await getPurchaseRequestByIdFirestore(docId);
  if (!preflight) throw fail('Purchase request not found.', 'REQUEST_NOT_FOUND', 404);
  await assertCanApprove(preflight, actor);

  const now = new Date().toISOString();

  const result = await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) throw fail('Purchase request not found.', 'REQUEST_NOT_FOUND', 404);
    const current = formatDocSnapshot(snap);

    // H3 -- the action token and the approver's live staff and authority
    // records are re-read and verified HERE, before the status check, so a
    // spent token is reported as spent instead of falling into the replay
    // branch below, and so every read still precedes the write.
    if (hooks?.afterRead) await hooks.afterRead(txn, current);

    const approvals = Array.isArray(current.approvals) ? [...current.approvals] : [];

    if (current.status !== PR_STATUS.PENDING_APPROVAL) {
      // Idempotent replay: this same approver already recorded this same
      // decision and it is the decision that closed the request.
      const alreadyMine = approvals.some(a =>
        String(a.approver_uid) === String(actor.uid) && a.action === action);
      if (current.status === targetStatus && alreadyMine) {
        return { duplicate: true, request: current };
      }
      // Anything else is a contradictory or late action — the losing side of
      // a concurrent decision lands here and must not write.
      throw fail(
        `This purchase request is already ${current.status} and can no longer be ${action.toLowerCase()}.`,
        'INVALID_STATUS_TRANSITION',
        409
      );
    }

    // Defensive: the transition table is the single source of truth.
    if (!(PR_TRANSITIONS[current.status] || []).includes(targetStatus)) {
      throw fail(`A ${current.status} purchase request cannot become ${targetStatus}.`, 'INVALID_STATUS_TRANSITION', 409);
    }
    // Re-checked inside the transaction against the freshly read document.
    if (current.requested_by_uid && String(current.requested_by_uid) === String(actor.uid)) {
      throw fail(
        'You cannot approve or reject a purchase request that you raised yourself.',
        'PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN',
        403
      );
    }
    if (approvals.some(a => String(a.approver_uid) === String(actor.uid))) {
      throw fail('You have already recorded a decision on this purchase request.', 'APPROVER_ALREADY_ACTED', 409);
    }

    const approvalRecord = {
      approval_id: newApprovalId(docId, actor.uid, action),
      approver_uid: actor.uid || null,
      approver_name: actor.name || null,
      approver_email: actor.email || null,
      approver_role: actor.role || null,
      action,
      comment: reason,
      status_at_action: current.status,
      created_at: now
    };
    approvals.push(approvalRecord);

    const history = Array.isArray(current.status_history) ? [...current.status_history] : [];
    history.push({ status: targetStatus, at: now, by_uid: actor.uid || null, by_name: actor.name || null });

    const updates = {
      status: targetStatus,
      approvals,
      status_history: history,
      updated_at: now
    };
    if (action === PR_APPROVAL_ACTIONS.APPROVED) {
      updates.approved_at = now;
      updates.approved_by_uid = actor.uid || null;
      updates.approved_by_name = actor.name || null;
    } else {
      updates.rejected_at = now;
      updates.rejected_by_uid = actor.uid || null;
      updates.rejected_by_name = actor.name || null;
      updates.rejection_reason = reason;
    }

    txn.update(ref, updates);
    // H3 -- the token is marked consumed in the SAME transaction as the
    // decision, so neither can commit without the other.
    if (hooks?.beforeCommit) hooks.beforeCommit(txn, current);
    return { duplicate: false, request: { ...current, ...updates }, approvalRecord };
  });

  if (!result.duplicate) {
    await writeAudit(
      action === PR_APPROVAL_ACTIONS.APPROVED ? 'INVENTORY_PR_APPROVED' : 'INVENTORY_PR_REJECTED',
      result.request,
      actor,
      { ...(action === PR_APPROVAL_ACTIONS.REJECTED ? { rejection_reason: reason } : { comment: reason }), ...audit_extra }
    );
    // A terminal request retires every token still outstanding for it, on
    // BOTH entry points: an in-app decision must also retire the tokens H5
    // will have issued for the same request.
    await retireOutstandingActions(docId, result.request.status);
  }

  return { duplicate: result.duplicate, request: await withItems(result.request) };
}

// =============================================================================
// H3 -- TOKEN-AWARE DECISION
//
// A token is one factor, never the authorization. Before the ONE existing
// engine records anything, this path establishes -- inside the same
// transaction that records the decision --
//
//   a valid, unspent, unexpired token
//     AND bound to THIS request, THIS approver and THIS action
//     AND the approver's staff record is still active
//     AND an active H1 authority record exists for them
//     AND their CURRENT role passes the live approval configuration
//     AND every rule decide() already enforces: status, transition,
//         self-approval, already-acted, rejection reason
//
// Nothing is reimplemented: this function resolves an actor and hands it to
// decide() with hooks. decide() does what it always did.
//
// `decided_by_uid` is a TRUSTED, server-side argument. This service refuses a
// token whose approver_uid differs from it, which is what stops "token X
// presented by identity Y". The future webhook (H4) must derive the identity
// it passes here from its own verified channel binding -- the registered
// WhatsApp number resolved through the H1 authority record -- never from a
// field an external party controls. H3 exposes no HTTP surface of its own.
// =============================================================================

/** Mirrors the H1 controller's predicate; consolidating them is a follow-up. */
function isStaffActive(staff) {
  if (!staff) return false;
  if (staff.deleted === true || staff.deleted === 1 || staff.is_deleted === true || staff.is_deleted === 1 || staff.deleted_at) return false;
  if (staff.is_active === false || staff.is_active === 0 || staff.active === false || staff.active === 0) return false;
  if (staff.status === 'Inactive' || staff.status === 'Disabled' || staff.status === 'Deleted') return false;
  return true;
}

/**
 * Maps a repository verdict to a decision error. Malformed and unknown tokens
 * collapse to one code so this path is not an oracle for which hashes exist.
 * Consumed and expired are distinguished: the bearer already holds the token
 * and learns nothing they could not learn by presenting it.
 */
function throwForTokenVerdict(verdict) {
  if (verdict.valid) return;
  switch (verdict.reason) {
    case ACTION_INVALID.CONSUMED: throw fail('This approval link has already been used.', 'TOKEN_CONSUMED', 409);
    case ACTION_INVALID.EXPIRED:  throw fail('This approval link has expired.', 'TOKEN_EXPIRED', 403);
    default:                      throw fail('This approval link is not valid.', 'TOKEN_INVALID', 403);
  }
}

/** The three bindings. Pure; never echoes the token. */
function assertTokenBinding(tokenDoc, { approverUid, action, requestDocId }) {
  if (String(tokenDoc.approver_uid) !== String(approverUid)) {
    throw fail('This approval link was issued to a different approver.', 'TOKEN_APPROVER_MISMATCH', 403);
  }
  if (tokenDoc.action !== action) {
    throw fail(`This approval link permits ${tokenDoc.action}, not ${action}.`, 'TOKEN_ACTION_MISMATCH', 403);
  }
  if (requestDocId && formatRequestDocId(tokenDoc.pr_id) !== formatRequestDocId(requestDocId)) {
    throw fail('This approval link belongs to a different purchase request.', 'TOKEN_PR_MISMATCH', 403);
  }
}

function assertAuthorityActive(authority) {
  if (!authority) throw fail('The approver is not configured as an approval authority.', 'AUTHORITY_NOT_FOUND', 403);
  if (authority.is_active === false) throw fail('The approval authority for this approver has been deactivated.', 'AUTHORITY_INACTIVE', 403);
}

/** Returns the approver's normalized CURRENT role, or throws with a specific code. */
function assertStaffEligible(staff, approverUid) {
  if (!staff) throw fail('The approver is not a recognised staff member.', 'STAFF_NOT_FOUND', 403);
  if (!isStaffActive(staff)) throw fail('The approver is no longer an active staff member.', 'STAFF_INACTIVE', 403);
  if (String(staff.user_uid || '') !== String(approverUid)) {
    throw fail('The approver identity does not match a staff account.', 'STAFF_UID_MISMATCH', 403);
  }
  return normalizeUserRole({ ...staff, type: 'staff' });
}

/**
 * Records a decision authorised by an approval-action token.
 *
 * @param {object} p
 * @param {string} p.raw_token        the secret presented by the bearer
 * @param {string} p.decided_by_uid   TRUSTED identity of the deciding approver (see above)
 * @param {'APPROVED'|'REJECTED'|'APPROVE'|'REJECT'} p.action
 * @param {string} [p.reason]         mandatory for a rejection, exactly as in-app
 * @param {string} [p.request_id]     optional; when supplied it must match the token's request
 * @param {string} [p.consumed_via]   recorded on the token; defaults to the channel name
 * @returns {{ duplicate: boolean, request: object }}  the same shape approve()/reject() return
 */
async function decideWithApprovalActionToken({
  raw_token, decided_by_uid, action, reason = null, request_id = null, consumed_via = 'APPROVAL_ACTION_TOKEN'
} = {}) {
  const approverUid = String(decided_by_uid || '').trim();
  if (!approverUid) throw fail('An approver identity is required.', 'APPROVER_REQUIRED', 401);
  const wanted = normalizeApprovalActionToken(action);   // APPROVE/REJECT aliases -> canonical
  assertRejectionReason(wanted, reason);                  // fails before any read, as in-app does

  // Fail-fast preflight. Nothing here is authoritative: the same token and
  // the same two identity records are re-read inside the transaction below.
  // Order is cheapest-refusal-first: one read decides most bad requests.
  const pre = await findApprovalActionByTokenFirestore(raw_token);
  throwForTokenVerdict(pre);
  assertTokenBinding(pre.action, { approverUid, action: wanted, requestDocId: request_id });
  const requestDocId = formatRequestDocId(pre.action.pr_id);

  const authority = await getApprovalAuthorityByUidFirestore(approverUid);
  assertAuthorityActive(authority);
  const staff = await getStaffByUidFirestore(approverUid);
  const actor = {
    uid: approverUid,
    name: staff?.full_name || staff?.username || null,
    email: staff?.email || null,
    role: assertStaffEligible(staff, approverUid)
  };
  const staffRef = db.collection('staff').doc(staff.id);
  const authorityRef = db.collection(APPROVAL_AUTHORITIES_COLLECTION).doc(approverUid);

  return await decide(requestDocId, wanted, {
    comment: reason,
    actor,
    audit_extra: { decision_channel: consumed_via },
    hooks: {
      // READ PHASE. Token first, so a spent token costs one read and refuses
      // before anything else is fetched; then the two identity records.
      async afterRead(txn, current) {
        const verdict = await readApprovalActionInTxn(txn, pre.token_hash);
        throwForTokenVerdict(verdict);
        assertTokenBinding(verdict.action, { approverUid, action: wanted, requestDocId: current.id });

        const [staffSnap, authoritySnap] = await txn.getAll(staffRef, authorityRef);
        assertAuthorityActive(authoritySnap.exists ? formatDocSnapshot(authoritySnap) : null);
        // The role at DECISION time is what the record carries and what the
        // existing authorization is evaluated against -- never a send-time copy.
        actor.role = assertStaffEligible(staffSnap.exists ? formatDocSnapshot(staffSnap) : null, approverUid);
        await assertCanApprove(current, actor);
      },
      // WRITE PHASE, after decide() has queued the request update.
      beforeCommit(txn) {
        markApprovalActionConsumedInTxn(txn, pre.token_hash, { via: consumed_via });
      }
    }
  });
}

export const PurchaseRequestApprovalService = {
  /** PENDING_APPROVAL → APPROVED. Comment optional. */
  async approve(requestId, comment, actor) {
    return await decide(requestId, PR_APPROVAL_ACTIONS.APPROVED, { comment, actor });
  },

  /** PENDING_APPROVAL → REJECTED. A reason is mandatory and is stored immutably. */
  async reject(requestId, reason, actor) {
    return await decide(requestId, PR_APPROVAL_ACTIONS.REJECTED, { comment: reason, actor });
  },

  /**
   * Effective approval configuration plus whether THIS caller may approve.
   * Used by the UI to decide button visibility — never as the security
   * boundary, which is always the server-side check in assertCanApprove.
   */
  async getApprovalContext(actor) {
    const config = await getInventoryApprovalConfigFirestore();
    return {
      enabled: config.enabled !== false,
      allowed_roles: config.allowed_roles || [],
      source: config.source || 'settings',
      caller_role: actor?.role || null,
      caller_can_approve: roleCanApprove(config, actor?.role)
    };
  },

  assertCanApprove,

  /**
   * H3 -- decision authorised by an approval-action token. Same engine, same
   * transaction, same post-commit audit. The caller emits PR_EVENTS.DECIDED
   * after this resolves, exactly as the in-app controller does.
   */
  decideWithApprovalActionToken
};

export default PurchaseRequestApprovalService;
