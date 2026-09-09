/**
 * purchaseRequestController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP layer for Phase B purchase requests, mounted under
 * /api/inventory/purchase-requests (see routes/inventoryRoutes.js).
 *
 * Authorization is enforced twice: requireRole on the route (who may reach the
 * endpoint at all) and an ownership check inside PurchaseRequestService (who
 * may mutate this particular request). The frontend is never the boundary.
 */

import { PurchaseRequestService } from '../services/purchaseRequestService.js';
import { PurchaseRequestApprovalService } from '../services/purchaseRequestApprovalService.js';
import { getActor, sendError } from './inventoryController.js';
import { normalizeUserRole } from './authController.js';
import { ALL_PR_STATUSES, PR_PRIORITIES, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PR_EVENTS, VALID_APPROVER_ROLES } from '../utils/inventoryConstants.js';
import {
  getInventoryApprovalConfigFirestore,
  updateInventoryApprovalConfigFirestore
} from '../repositories/firestore/inventoryApprovalConfigRepository.js';
import { auditInventory } from './inventoryController.js';

/**
 * Phase D — emits the "a request needs approval" event AFTER the Firestore
 * transaction has committed, so a failed submit can never produce a false
 * notification. The payload carries the approver role list so each connected
 * client can decide whether the signed-in user is a recipient.
 *
 * KNOWN ARCHITECTURAL LIMITATION (pre-existing, shared with every food event):
 * this Socket.IO server broadcasts globally — there are no rooms and no socket
 * authentication — so the event reaches every connected client and the
 * recipient filter runs client-side. It carries no financial or personal
 * detail beyond what an inventory user may already read, and it grants no
 * privilege: approving is still authorized server-side on every call.
 * Redesigning Socket.IO auth/rooms is deliberately out of scope here.
 */
async function emitPurchaseRequestSubmitted(req, request) {
  try {
    const config = await getInventoryApprovalConfigFirestore();
    // Approvals switched off → nobody is a recipient, so emit nothing.
    if (config.enabled === false) return;
    req.app.get('io')?.emit(PR_EVENTS.SUBMITTED, {
      request_id:        request.id || request.request_id,
      request_number:    request.request_number,
      department:        request.department,
      location_id:       request.location_id,
      location_name:     request.location_name_snapshot || null,
      priority:          request.priority,
      requested_by_uid:  request.requested_by_uid,
      requested_by_name: request.requested_by_name,
      item_count:        request.item_count,
      estimated_total:   request.total_estimated_value,
      business_date:     request.business_date,
      // Targeting data — the single source of truth is the same settings
      // document Phase C authorizes against.
      approver_roles:    config.allowed_roles || []
    });
  } catch (err) {
    // A notification must never break the request workflow.
    console.warn(`[PurchaseRequest] submit notification emit failed: ${err.message}`);
  }
}

/** Phase D — decision event, used by clients to retire the pending notification. */
function emitPurchaseRequestDecided(req, request, actor) {
  try {
    req.app.get('io')?.emit(PR_EVENTS.DECIDED, {
      request_id:      request.id || request.request_id,
      request_number:  request.request_number,
      status:          request.status,
      decided_by_uid:  actor?.uid || null,
      decided_by_name: actor?.name || null
    });
  } catch (err) {
    console.warn(`[PurchaseRequest] decision notification emit failed: ${err.message}`);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Actor identity plus the normalized role the ownership rules rely on. */
function requestActor(req) {
  const actor = getActor(req);
  return { ...actor, role: normalizeUserRole(req.user) };
}

function validateItemsPayload(items, errors) {
  if (items === undefined) return;
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('items must be a non-empty array.');
    return;
  }
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object') { errors.push(`items[${i}] must be an object.`); return; }
    if (!it.product_id) errors.push(`items[${i}].product_id is required.`);
    const q = Number(it.requested_quantity);
    if (it.requested_quantity === undefined || it.requested_quantity === null || it.requested_quantity === '' || !Number.isFinite(q)) {
      errors.push(`items[${i}].requested_quantity must be a number.`);
    } else if (q <= 0) {
      errors.push(`items[${i}].requested_quantity must be greater than zero.`);
    }
  });
}

/** POST /api/inventory/purchase-requests */
export const createPurchaseRequest = async (req, res) => {
  const b = req.body || {};
  const errors = [];
  if (!b.location_id) errors.push('location_id is required.');
  if (b.priority !== undefined && b.priority !== null && b.priority !== '' && !PR_PRIORITIES.includes(String(b.priority).toUpperCase())) {
    errors.push(`priority must be one of: ${PR_PRIORITIES.join(', ')}.`);
  }
  if (b.items === undefined) errors.push('items is required.');
  validateItemsPayload(b.items, errors);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const result = await PurchaseRequestService.createDraft(b, requestActor(req));
    return res.status(result.duplicate ? 200 : 201).json({
      message: result.duplicate ? 'Purchase request already exists (idempotent replay).' : 'Draft purchase request created.',
      duplicate: result.duplicate,
      request: result.request
    });
  } catch (error) {
    return sendError(res, error, 'Failed to create purchase request');
  }
};

/** GET /api/inventory/purchase-requests */
export const getPurchaseRequests = async (req, res) => {
  const q = req.query || {};
  const errors = [];
  if (q.status && !ALL_PR_STATUSES.includes(String(q.status).toUpperCase())) {
    errors.push(`status must be one of: ${ALL_PR_STATUSES.join(', ')}.`);
  }
  if (q.from && !ISO_DATE.test(String(q.from))) errors.push('from must be YYYY-MM-DD.');
  if (q.to && !ISO_DATE.test(String(q.to))) errors.push('to must be YYYY-MM-DD.');
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const limit = Math.min(Math.max(parseInt(q.limit || q.page_size, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const result = await PurchaseRequestService.list({
      status: q.status ? String(q.status).toUpperCase() : null,
      requested_by_uid: q.requested_by_uid || null,
      department: q.department || null,
      location_id: q.location_id || null,
      request_number: q.request_number || null,
      from: q.from || null,
      to: q.to || null,
      limit,
      cursor: q.cursor || null
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Failed to load purchase requests');
  }
};

/** GET /api/inventory/purchase-requests/:id */
export const getPurchaseRequestById = async (req, res) => {
  try {
    const request = await PurchaseRequestService.getById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Purchase request not found.' });
    return res.json({ request });
  } catch (error) {
    return sendError(res, error, 'Failed to load purchase request');
  }
};

/** PUT /api/inventory/purchase-requests/:id — DRAFT only. */
export const updatePurchaseRequest = async (req, res) => {
  const b = req.body || {};
  const errors = [];
  if (b.priority !== undefined && b.priority !== null && b.priority !== '' && !PR_PRIORITIES.includes(String(b.priority).toUpperCase())) {
    errors.push(`priority must be one of: ${PR_PRIORITIES.join(', ')}.`);
  }
  validateItemsPayload(b.items, errors);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const result = await PurchaseRequestService.updateDraft(req.params.id, b, requestActor(req));
    return res.json({ message: 'Purchase request updated.', ...result });
  } catch (error) {
    return sendError(res, error, 'Failed to update purchase request');
  }
};

/** POST /api/inventory/purchase-requests/:id/submit — DRAFT → PENDING_APPROVAL. */
export const submitPurchaseRequest = async (req, res) => {
  try {
    const result = await PurchaseRequestService.submit(req.params.id, requestActor(req));
    // Emitted only after the transaction committed, and never for an
    // idempotent replay (which would re-notify for an already-pending request).
    if (!result.duplicate) await emitPurchaseRequestSubmitted(req, result.request);
    return res.status(result.duplicate ? 200 : 201).json({
      message: result.duplicate
        ? 'Purchase request was already submitted (idempotent replay).'
        : `Purchase request submitted as ${result.request.request_number}.`,
      duplicate: result.duplicate,
      request: result.request
    });
  } catch (error) {
    return sendError(res, error, 'Failed to submit purchase request');
  }
};

/** POST /api/inventory/purchase-requests/:id/cancel — DRAFT only. */
export const cancelPurchaseRequest = async (req, res) => {
  try {
    const result = await PurchaseRequestService.cancel(req.params.id, (req.body || {}).reason, requestActor(req));
    return res.json({
      message: result.duplicate ? 'Purchase request was already cancelled.' : 'Purchase request cancelled.',
      duplicate: result.duplicate,
      request: result.request
    });
  } catch (error) {
    return sendError(res, error, 'Failed to cancel purchase request');
  }
};

/* ── Phase C — approval engine ─────────────────────────────────────────────
 * Approving or rejecting is a DECISION, never a purchase: these handlers
 * touch no stock, create no movement and allocate no new request number.
 * Authorization is enforced in PurchaseRequestApprovalService (role from the
 * settings-driven config + a hard self-approval block), not here and never in
 * the frontend.
 */

/** POST /api/inventory/purchase-requests/:id/approve  { comment? } */
export const approvePurchaseRequest = async (req, res) => {
  try {
    const actor = requestActor(req);
    const result = await PurchaseRequestApprovalService.approve(
      req.params.id, (req.body || {}).comment, actor
    );
    if (!result.duplicate) emitPurchaseRequestDecided(req, result.request, actor);
    return res.json({
      message: result.duplicate
        ? 'Purchase request was already approved by you (idempotent replay).'
        : `Purchase request ${result.request.request_number || ''} approved.`.trim(),
      duplicate: result.duplicate,
      request: result.request
    });
  } catch (error) {
    return sendError(res, error, 'Failed to approve purchase request');
  }
};

/** POST /api/inventory/purchase-requests/:id/reject  { reason } — reason required. */
export const rejectPurchaseRequest = async (req, res) => {
  const reason = (req.body || {}).reason ?? (req.body || {}).comment;
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A rejection reason is required.', code: 'REJECTION_REASON_REQUIRED' });
  }
  try {
    const actor = requestActor(req);
    const result = await PurchaseRequestApprovalService.reject(req.params.id, reason, actor);
    if (!result.duplicate) emitPurchaseRequestDecided(req, result.request, actor);
    return res.json({
      message: result.duplicate
        ? 'Purchase request was already rejected by you (idempotent replay).'
        : `Purchase request ${result.request.request_number || ''} rejected.`.trim(),
      duplicate: result.duplicate,
      request: result.request
    });
  } catch (error) {
    return sendError(res, error, 'Failed to reject purchase request');
  }
};

/**
 * GET /api/inventory/purchase-requests/approval-config
 * Effective approval configuration and whether the caller may approve.
 * UX only — every decision is re-authorized server-side.
 */
export const getPurchaseRequestApprovalConfig = async (req, res) => {
  try {
    const actor = requestActor(req);
    const context = await PurchaseRequestApprovalService.getApprovalContext(actor);
    return res.json({
      ...context,
      valid_roles: [...VALID_APPROVER_ROLES],
      // Only an administrator may change this configuration (UX hint; the PUT
      // re-checks server-side regardless).
      caller_can_configure: actor.role === 'admin' || actor.role === 'super_admin'
    });
  } catch (error) {
    return sendError(res, error, 'Failed to load approval configuration');
  }
};

/**
 * PUT /api/inventory/purchase-requests/approval-config
 * ADMIN ONLY — route-guarded with the MANAGE role set and re-checked here.
 * Configures which roles may approve purchase requests, and therefore who
 * receives the pending-approval notification (one source of truth for both).
 */
export const updatePurchaseRequestApprovalConfig = async (req, res) => {
  const actor = requestActor(req);
  // Defence in depth: the route already restricts this to MANAGE roles, but a
  // configuration that controls an authorization boundary re-checks here too.
  if (actor.role !== 'admin' && actor.role !== 'super_admin') {
    return res.status(403).json({
      error: 'Only an administrator can change the purchase-request approval configuration.',
      code: 'APPROVAL_CONFIG_FORBIDDEN'
    });
  }

  try {
    const before = await getInventoryApprovalConfigFirestore({ skipCache: true });
    const saved = await updateInventoryApprovalConfigFirestore({
      enabled: (req.body || {}).enabled,
      allowed_roles: (req.body || {}).allowed_roles,
      updated_by: actor.uid,
      updated_by_role: actor.role
    });

    await auditInventory(req, 'INVENTORY_PR_APPROVAL_CONFIG_UPDATED', {
      previous_enabled: before.enabled,
      new_enabled: saved.enabled,
      previous_allowed_roles: before.allowed_roles,
      new_allowed_roles: saved.allowed_roles,
      actor_role: actor.role
    }, 'pr_approval_config');

    return res.json({
      message: 'Approval configuration updated.',
      config: {
        enabled: saved.enabled,
        allowed_roles: saved.allowed_roles,
        valid_roles: [...VALID_APPROVER_ROLES],
        updated_at: saved.updated_at
      }
    });
  } catch (error) {
    return sendError(res, error, 'Failed to update approval configuration');
  }
};
