/**
 * backend/controllers/foodComplimentaryController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Controller for Food Complimentary Billing & Approvals (Phase 2B).
 *
 * Flow:
 *   1. Staff creates request -> PENDING_APPROVAL
 *   2. Admin/Manager reviews -> APPROVE or REJECT
 *   3. Approval atomically updates food_order to COMPLIMENTARY.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';
import {
  createComplimentaryRequestFirestore,
  getComplimentaryRequestByIdFirestore,
  updateComplimentaryRequestFirestore,
  listComplimentaryRequestsFirestore
} from '../repositories/firestore/foodComplimentaryRepository.js';
import {
  getFoodOrderByIdFirestore,
  updateFoodOrderFirestore
} from '../repositories/firestore/foodOrdersRepository.js';
import { RepositoryError } from '../repositories/firestore/firestoreUtils.js';

function handleRepoError(res, err, context) {
  if (err instanceof RepositoryError) {
    const status = err.status || 500;
    console.warn(`[FoodComplimentaryController] ${context} - RepositoryError (${err.code}): ${err.message}`);
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error(`[FoodComplimentaryController] ${context} - Unexpected error:`, err);
  return res.status(500).json({ error: 'Internal Server Error' });
}

/**
 * POST /api/food/orders/:id/complimentary/request
 * Staff creates a complimentary billing authorization request.
 */
export async function requestComplimentary(req, res) {
  try {
    const { id } = req.params;
    const { recipient, recipient_type, reason } = req.body;

    if (!recipient || !reason) {
      return res.status(400).json({
        error: 'Recipient name and justification reason are mandatory for complimentary billing',
        code: 'VALIDATION_ERROR'
      });
    }

    const order = await getFoodOrderByIdFirestore(id);
    if (!order) {
      return res.status(404).json({ error: `Order "${id}" not found`, code: 'ORDER_NOT_FOUND' });
    }

    if (order.payment_status !== 'PENDING') {
      return res.status(409).json({
        error: `Cannot request complimentary on order with payment_status: "${order.payment_status}"`,
        code: 'ALREADY_BILLED'
      });
    }

    const userRole = String(req.user.role || req.user.type || '').toLowerCase();
    const isAdminUser = userRole === 'admin' || userRole === 'super_admin';

    // If admin initiates, automatically approve atomically
    if (isAdminUser) {
      const now = new Date().toISOString();
      const reqDoc = await createComplimentaryRequestFirestore({
        food_order_id:     order.order_id,
        food_order_number: order.order_number || '',
        amount:            order.grand_total,
        recipient,
        recipient_type:    recipient_type || 'GUEST',
        room_number:       order.room_number,
        reason,
        status:            'APPROVED',
        requested_by_uid:  String(req.user.uid || req.user.id),
        requested_by_name: req.user.fullName || req.user.username || 'Admin',
        approved_by_uid:   String(req.user.uid || req.user.id),
        approved_by_name:  req.user.fullName || req.user.username || 'Admin',
        approved_at:       now
      });

      await updateFoodOrderFirestore(order.order_id, {
        payment_status:           'COMPLIMENTARY',
        complimentary_request_id: reqDoc.id,
        billed_at:                now,
        billed_by_uid:            String(req.user.uid || req.user.id)
      });

      return res.json({
        success: true,
        auto_approved: true,
        complimentary_request: reqDoc
      });
    }

    // Standard Staff flow -> PENDING_APPROVAL
    const reqDoc = await createComplimentaryRequestFirestore({
      food_order_id:     order.order_id,
      food_order_number: order.order_number || '',
      amount:            order.grand_total,
      recipient,
      recipient_type:    recipient_type || 'GUEST',
      room_number:       order.room_number,
      reason,
      status:            'PENDING_APPROVAL',
      requested_by_uid:  String(req.user.uid || req.user.id),
      requested_by_name: req.user.fullName || req.user.username || 'Staff'
    });

    // Notify Admin Dashboard
    req.app.get('io')?.emit('food:complimentary_pending', {
      request_id:   reqDoc.id,
      order_id:     order.order_id,
      order_number: order.order_number,
      amount:       order.grand_total,
      recipient,
      reason,
      requested_by: req.user.fullName || 'Staff'
    });

    return res.json({
      success: true,
      message: 'Complimentary authorization request submitted for Admin/Manager approval',
      complimentary_request: reqDoc
    });
  } catch (err) {
    return handleRepoError(res, err, 'requestComplimentary');
  }
}

/**
 * POST /api/food/complimentary/:requestId/approve
 * Admin/Manager approves complimentary request with atomic transaction.
 */
export async function approveComplimentary(req, res) {
  try {
    const { requestId } = req.params;
    const reqRef = db.collection('food_complimentary_requests').doc(
      String(requestId).startsWith('fcreq_') ? String(requestId) : `fcreq_${requestId}`
    );

    const now = new Date().toISOString();
    let updatedOrder = null;

    await db.runTransaction(async (txn) => {
      const snap = await txn.get(reqRef);
      if (!snap.exists) {
        throw new RepositoryError(`Complimentary request "${requestId}" not found`, 'NOT_FOUND', 404);
      }

      const reqData = snap.data();
      if (reqData.status !== 'PENDING_APPROVAL') {
        throw new RepositoryError(`Request is already in status: "${reqData.status}"`, 'ALREADY_PROCESSED', 409);
      }

      const orderRef = db.collection('food_orders').doc(reqData.food_order_id);
      const orderSnap = await txn.get(orderRef);
      if (!orderSnap.exists) {
        throw new RepositoryError(`Order "${reqData.food_order_id}" not found`, 'ORDER_NOT_FOUND', 404);
      }

      const orderData = orderSnap.data();
      if (orderData.payment_status !== 'PENDING') {
        throw new RepositoryError(`Order is already billed as "${orderData.payment_status}"`, 'ALREADY_BILLED', 409);
      }

      txn.update(reqRef, {
        status:           'APPROVED',
        approved_by_uid:  String(req.user.uid || req.user.id),
        approved_by_name: req.user.fullName || req.user.username || 'Manager',
        approved_at:      now,
        updated_at:       now
      });

      txn.update(orderRef, {
        payment_status:           'COMPLIMENTARY',
        complimentary_request_id: reqData.request_id,
        billed_at:                now,
        billed_by_uid:            String(req.user.uid || req.user.id),
        updated_at:               now
      });

      updatedOrder = { ...orderData, payment_status: 'COMPLIMENTARY' };
    });

    return res.json({
      success: true,
      message: 'Complimentary billing approved successfully',
      order: updatedOrder
    });
  } catch (err) {
    return handleRepoError(res, err, 'approveComplimentary');
  }
}

/**
 * POST /api/food/complimentary/:requestId/reject
 * Admin/Manager rejects complimentary request.
 */
export async function rejectComplimentary(req, res) {
  try {
    const { requestId } = req.params;
    const { rejection_reason } = req.body;

    const reqDoc = await getComplimentaryRequestByIdFirestore(requestId);
    if (!reqDoc) {
      return res.status(404).json({ error: 'Complimentary request not found', code: 'NOT_FOUND' });
    }

    if (reqDoc.status !== 'PENDING_APPROVAL') {
      return res.status(409).json({ error: `Request already "${reqDoc.status}"`, code: 'ALREADY_PROCESSED' });
    }

    const now = new Date().toISOString();
    await updateComplimentaryRequestFirestore(requestId, {
      status:           'REJECTED',
      rejected_by_uid:  String(req.user.uid || req.user.id),
      rejected_by_name: req.user.fullName || req.user.username || 'Manager',
      rejection_reason: rejection_reason || 'Declined by management',
      rejected_at:      now
    });

    return res.json({
      success: true,
      message: 'Complimentary request rejected'
    });
  } catch (err) {
    return handleRepoError(res, err, 'rejectComplimentary');
  }
}

/**
 * GET /api/food/complimentary/pending
 * Lists pending complimentary requests for admin/manager approval.
 */
export async function listPendingComplimentary(req, res) {
  try {
    const requests = await listComplimentaryRequestsFirestore({ status: 'PENDING_APPROVAL' });
    return res.json({
      count: requests.length,
      requests
    });
  } catch (err) {
    return handleRepoError(res, err, 'listPendingComplimentary');
  }
}
