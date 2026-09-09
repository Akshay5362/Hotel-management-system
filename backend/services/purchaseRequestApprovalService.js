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
 * Records one approval decision atomically.
 *
 * @param {'APPROVED'|'REJECTED'} action
 * @returns {{ duplicate: boolean, request: object }}
 */
async function decide(requestId, action, { comment, actor }) {
  if (!PR_APPROVAL_ACTIONS[action]) throw fail(`Unknown approval action '${action}'.`, 'INVALID_APPROVAL_ACTION');
  const targetStatus = PR_ACTION_TO_STATUS[action];

  const reason = cleanText(comment, 1000);
  if (action === PR_APPROVAL_ACTIONS.REJECTED && (!reason || reason.length < MIN_REJECTION_REASON_LENGTH)) {
    throw fail(
      `A rejection reason of at least ${MIN_REJECTION_REASON_LENGTH} characters is required.`,
      'REJECTION_REASON_REQUIRED'
    );
  }

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
    return { duplicate: false, request: { ...current, ...updates }, approvalRecord };
  });

  if (!result.duplicate) {
    await writeAudit(
      action === PR_APPROVAL_ACTIONS.APPROVED ? 'INVENTORY_PR_APPROVED' : 'INVENTORY_PR_REJECTED',
      result.request,
      actor,
      action === PR_APPROVAL_ACTIONS.REJECTED ? { rejection_reason: reason } : { comment: reason }
    );
  }

  return { duplicate: result.duplicate, request: await withItems(result.request) };
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

  assertCanApprove
};

export default PurchaseRequestApprovalService;
