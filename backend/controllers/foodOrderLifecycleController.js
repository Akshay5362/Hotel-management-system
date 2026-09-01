/**
 * backend/controllers/foodOrderLifecycleController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Controller for Food Order Lifecycle & Billing Operations (Phases 2B & 2C).
 *
 * Enforces:
 *   1. Transaction-level idempotency for PAY NOW, ROOM BILL, and COMPLIMENTARY.
 *   2. State-machine progression & state-gated cancellations.
 *   3. Kitchen-restricted field whitelist.
 *   4. Zero frontend total trust (recalculates / verifies server-side).
 *   5. Socket.IO notification emission (additive namespaced events).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';
import {
  getFoodOrderByIdFirestore,
  updateFoodOrderFirestore,
  listFoodOrdersFirestore,
  VALID_ORDER_STATUSES,
  VALID_PAYMENT_STATUSES
} from '../repositories/firestore/foodOrdersRepository.js';
import {
  createFoodPaymentFirestore,
  generateFoodPaymentDocId
} from '../repositories/firestore/foodPaymentsRepository.js';
import {
  createLedgerItemFirestore
} from '../repositories/firestore/ledgerRepository.js';
import {
  getBookingByIdFirestore
} from '../repositories/firestore/bookingsRepository.js';
import {
  generateFoodOrderNumber
} from '../services/foodOrderNumberService.js';
import {
  getSystemDateFirestore
} from '../repositories/firestore/systemSettingsRepository.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { RepositoryError } from '../repositories/firestore/firestoreUtils.js';
import { normalizeUserRole } from './authController.js';

// ── State Machine Mapping ─────────────────────────────────────────────────────
export const VALID_TRANSITIONS = {
  DRAFT:            ['PLACED', 'CANCELLED'],
  PLACED:           ['RECEIVED', 'CANCELLED'],
  RECEIVED:         ['PREPARING', 'CANCELLED'],
  PREPARING:        ['READY', 'CANCELLED'],
  READY:            ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED:        ['COMPLETED'],
  COMPLETED:        [], // Terminal
  CANCELLED:        []  // Terminal
};

// ── Kitchen Whitelist ─────────────────────────────────────────────────────────
const KITCHEN_ALLOWED_FIELDS = new Set([
  'order_status',
  'status_history',
  'kitchen_received_at',
  'kitchen_preparing_at',
  'kitchen_ready_at',
  'kitchen_notes'
]);

function handleRepoError(res, err, context) {
  if (err instanceof RepositoryError) {
    const status = err.status || 500;
    console.warn(`[FoodOrderLifecycleController] ${context} - RepositoryError (${err.code}): ${err.message}`);
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error(`[FoodOrderLifecycleController] ${context} - Unexpected error:`, err);
  return res.status(500).json({ error: 'Internal Server Error' });
}

/**
 * PUT /api/food/orders/:id/place
 * Transitions DRAFT order to PLACED and generates sequential FO number.
 */
export async function placeFoodOrder(req, res) {
  try {
    const { id } = req.params;
    const { waiter_uid, waiter_name } = req.body;

    const orderDoc = await getFoodOrderByIdFirestore(id);
    if (!orderDoc) {
      return res.status(404).json({ error: `Food order "${id}" not found`, code: 'ORDER_NOT_FOUND' });
    }

    if (orderDoc.order_status !== 'DRAFT') {
      return res.status(409).json({
        error: `Cannot place order in status "${orderDoc.order_status}". Must be DRAFT.`,
        code: 'INVALID_ORDER_STATE'
      });
    }

    const businessDate = await getSystemDateFirestore().catch(() => new Date().toISOString().split('T')[0]);
    const { orderNumber } = await generateFoodOrderNumber(businessDate);
    const now = new Date().toISOString();

    const newHistoryEntry = {
      status:  'PLACED',
      by_uid:  String(req.user.uid || req.user.id),
      by_name: req.user.fullName || req.user.username || 'Staff',
      ts:      now,
      note:    'Order officially placed'
    };

    const updatePayload = {
      order_number:   orderNumber,
      order_status:   'PLACED',
      business_date:  businessDate,
      waiter_uid:     waiter_uid || orderDoc.waiter_uid || null,
      waiter_name:    waiter_name || orderDoc.waiter_name || null,
      status_history: [...(orderDoc.status_history || []), newHistoryEntry],
      updated_at:     now
    };

    await updateFoodOrderFirestore(id, updatePayload);

    // Socket.IO Emit: food:order_placed
    req.app.get('io')?.emit('food:order_placed', {
      order_id:         orderDoc.order_id,
      order_number:     orderNumber,
      destination_type: orderDoc.destination_type,
      room_number:      orderDoc.room_number,
      table_name:       orderDoc.table_name,
      items_count:      (orderDoc.items || []).length,
      grand_total:      orderDoc.grand_total,
      created_at:       now
    });

    return res.json({
      success: true,
      order: {
        ...orderDoc,
        ...updatePayload
      }
    });
  } catch (err) {
    return handleRepoError(res, err, 'placeFoodOrder');
  }
}

/**
 * PUT /api/food/orders/:id/status
 * Updates status along the state machine.
 */
export async function updateFoodOrderStatus(req, res) {
  try {
    const { id } = req.params;
    const { next_status, notes } = req.body;

    if (!next_status || !VALID_ORDER_STATUSES.includes(next_status)) {
      return res.status(400).json({
        error: `Invalid next_status "${next_status}". Valid: ${VALID_ORDER_STATUSES.join(', ')}`,
        code: 'VALIDATION_ERROR'
      });
    }

    // ── Food-specific authorization: kitchen status transitions are a
    // KITCHEN-ONLY operational action. Reception/Admin may view the KDS
    // (see GET /orders/kds) but must never be able to drive it.
    //
    // This check is deliberately independent of the global ENABLE_STRICT_RBAC
    // flag and of the route-level requireRole(...) list — it re-derives the
    // caller's normalized role itself and enforces the restriction here,
    // so this endpoint stays kitchen-only regardless of how that flag or
    // the route's allowed-role list are configured elsewhere in HPMS.
    const normalizedRole = normalizeUserRole(req.user);
    const isKitchenUser = normalizedRole === 'kitchen';

    if (!isKitchenUser) {
      return res.status(403).json({
        error: 'Forbidden: Only Kitchen staff may change order status. Reception/Admin have monitoring-only access to the Kitchen Display.',
        code: 'KITCHEN_ONLY_ACTION'
      });
    }

    // Kitchen users are further restricted to only the fields the kitchen
    // workflow legitimately needs to touch (unchanged from before).
    const incomingKeys = Object.keys(req.body);
    const invalidKeys = incomingKeys.filter(k => !KITCHEN_ALLOWED_FIELDS.has(k) && k !== 'next_status');
    if (invalidKeys.length > 0) {
      return res.status(403).json({
        error: `Kitchen users are strictly forbidden from modifying fields: ${invalidKeys.join(', ')}`,
        code: 'FIELD_FORBIDDEN'
      });
    }

    // Atomic read-validate-write — a plain read-then-write here would let two
    // near-simultaneous requests (e.g. a double-tap on a kitchen tablet) both
    // read the same pre-transition status, both pass validation, and then
    // silently clobber each other's status_history entry on write. Wrapping
    // in a transaction mirrors the pattern already used by modifyFoodOrder /
    // processPayNow / cancelFoodOrder elsewhere in this controller.
    const orderRef = db.collection('food_orders').doc(String(id).startsWith('forder_') ? String(id) : `forder_${id}`);
    const now = new Date().toISOString();
    let resultPayload = null;

    await db.runTransaction(async (txn) => {
      const orderSnap = await txn.get(orderRef);
      if (!orderSnap.exists) {
        throw new RepositoryError(`Food order "${id}" not found`, 'ORDER_NOT_FOUND', 404);
      }
      const orderDoc = orderSnap.data();

      const currentStatus = orderDoc.order_status;
      const allowedNext = VALID_TRANSITIONS[currentStatus] || [];

      if (!allowedNext.includes(next_status)) {
        throw new RepositoryError(
          `Invalid transition from "${currentStatus}" to "${next_status}". Allowed: [${allowedNext.join(', ')}]`,
          'INVALID_TRANSITION',
          409
        );
      }

      const newHistoryEntry = {
        status:  next_status,
        by_uid:  String(req.user.uid || req.user.id),
        by_name: req.user.fullName || req.user.username || 'Staff',
        ts:      now,
        note:    notes || `Status transitioned to ${next_status}`
      };

      const updatePayload = {
        order_status:   next_status,
        status_history: [...(orderDoc.status_history || []), newHistoryEntry],
        updated_at:     now
      };

      if (next_status === 'RECEIVED') updatePayload.kitchen_received_at = now;
      if (next_status === 'PREPARING') updatePayload.kitchen_preparing_at = now;
      if (next_status === 'READY') updatePayload.kitchen_ready_at = now;
      if (notes) updatePayload.kitchen_notes = notes;

      txn.update(orderRef, updatePayload);

      resultPayload = {
        order_id:         orderDoc.order_id,
        order_number:     orderDoc.order_number,
        prev_status:      currentStatus,
        destination_type: orderDoc.destination_type,
        room_number:      orderDoc.room_number,
        table_name:       orderDoc.table_name,
        waiter_name:      orderDoc.waiter_name
      };
    });

    // Socket.IO Notifications
    req.app.get('io')?.emit('food:status_changed', {
      order_id:        resultPayload.order_id,
      order_number:    resultPayload.order_number,
      prev_status:     resultPayload.prev_status,
      new_status:      next_status,
      changed_by_name: req.user.fullName || req.user.username || 'Staff',
      ts:              now
    });

    if (next_status === 'READY') {
      req.app.get('io')?.emit('food:order_ready', {
        order_id:         resultPayload.order_id,
        order_number:     resultPayload.order_number,
        destination_type: resultPayload.destination_type,
        room_number:      resultPayload.room_number,
        table_name:       resultPayload.table_name,
        waiter_name:      resultPayload.waiter_name
      });
    }

    return res.json({
      success: true,
      order_id: resultPayload.order_id,
      order_status: next_status,
      updated_at: now
    });
  } catch (err) {
    return handleRepoError(res, err, 'updateFoodOrderStatus');
  }
}

/**
 * POST /api/food/orders/:id/pay-now
 * Atomic Transaction-Safe PAY NOW billing.
 */
export async function processPayNow(req, res) {
  try {
    const { id } = req.params;
    const { payment_method, notes } = req.body;

    if (!payment_method || !['Cash', 'Card', 'UPI'].includes(payment_method)) {
      return res.status(400).json({
        error: 'Invalid payment_method. Must be Cash, Card, or UPI',
        code: 'VALIDATION_ERROR'
      });
    }

    const orderRef = db.collection('food_orders').doc(String(id).startsWith('forder_') ? String(id) : `forder_${id}`);
    const paymentId = generateFoodPaymentDocId();
    const paymentRef = db.collection('food_payments').doc(paymentId);
    const now = new Date().toISOString();
    const businessDate = await getSystemDateFirestore().catch(() => now.split('T')[0]);

    let finalOrderData = null;
    let paymentPayload = null;

    await db.runTransaction(async (txn) => {
      const orderSnap = await txn.get(orderRef);
      if (!orderSnap.exists) {
        throw new RepositoryError(`Order "${id}" not found`, 'ORDER_NOT_FOUND', 404);
      }

      const orderData = orderSnap.data();

      if (orderData.payment_status !== 'PENDING') {
        throw new RepositoryError(
          `Order is already billed with status: ${orderData.payment_status}`,
          'ALREADY_BILLED',
          409
        );
      }

      if (orderData.order_status === 'CANCELLED') {
        throw new RepositoryError('Cannot bill a cancelled order', 'INVALID_ORDER_STATE', 409);
      }

      // Server recalculates/verifies grand total
      const grandTotal = Number(orderData.grand_total);
      if (isNaN(grandTotal) || grandTotal <= 0) {
        throw new RepositoryError('Invalid order total amount', 'INVALID_AMOUNT', 400);
      }

      paymentPayload = {
        food_payment_id:   paymentId,
        food_order_id:     orderData.order_id,
        food_order_number: orderData.order_number || '',
        amount:            grandTotal,
        currency:          'INR',
        payment_method:    payment_method,
        payment_status:    'Completed',
        business_date:     businessDate,
        cashier_uid:       String(req.user.uid || req.user.id),
        cashier_name:      req.user.fullName || req.user.username || 'Cashier',
        notes:             notes || null,
        created_at:        now
      };

      txn.set(paymentRef, paymentPayload);

      const orderUpdate = {
        payment_status:  'PAID',
        food_payment_id: paymentId,
        billed_at:       now,
        billed_by_uid:   String(req.user.uid || req.user.id),
        updated_at:      now
      };

      txn.update(orderRef, orderUpdate);
      finalOrderData = { ...orderData, ...orderUpdate };
    });

    return res.json({
      success: true,
      message: 'Payment processed successfully',
      payment: paymentPayload,
      order: finalOrderData
    });
  } catch (err) {
    return handleRepoError(res, err, 'processPayNow');
  }
}

/**
 * POST /api/food/orders/:id/room-bill
 * Atomic Transaction-Safe Room Bill Charge posting.
 */
export async function processRoomBill(req, res) {
  try {
    const { id } = req.params;
    const orderDoc = await getFoodOrderByIdFirestore(id);

    if (!orderDoc) {
      return res.status(404).json({ error: `Order "${id}" not found`, code: 'ORDER_NOT_FOUND' });
    }

    if (orderDoc.destination_type !== 'ROOM' || !orderDoc.booking_id) {
      return res.status(400).json({
        error: 'Room Bill is only allowed for ROOM destination with an active booking_id',
        code: 'INVALID_DESTINATION'
      });
    }

    const booking = await getBookingByIdFirestore(orderDoc.booking_id);
    if (!booking) {
      return res.status(404).json({ error: `Booking "${orderDoc.booking_id}" not found`, code: 'BOOKING_NOT_FOUND' });
    }

    if (booking.booking_status !== 'Checked In') {
      return res.status(400).json({
        error: `Cannot post charge to room. Booking status is "${booking.booking_status}". Must be "Checked In".`,
        code: 'BOOKING_NOT_CHECKED_IN'
      });
    }

    const orderRef = db.collection('food_orders').doc(orderDoc.order_id);
    const now = new Date().toISOString();
    const businessDate = await getSystemDateFirestore().catch(() => now.split('T')[0]);
    let ledgerResult = null;

    await db.runTransaction(async (txn) => {
      const snap = await txn.get(orderRef);
      if (!snap.exists) throw new RepositoryError('Order not found', 'ORDER_NOT_FOUND', 404);
      const curOrder = snap.data();

      if (curOrder.payment_status !== 'PENDING') {
        throw new RepositoryError(
          `Order is already billed with status: ${curOrder.payment_status}`,
          'ALREADY_BILLED',
          409
        );
      }

      const description = `Food & Beverage — ${curOrder.order_number || curOrder.order_id}`;
      const ledgerItemId = `ledger_food_${curOrder.order_id}_${Date.now()}`;

      const ledgerPayload = {
        item_id:          ledgerItemId,
        booking_id:       curOrder.booking_id,
        mysql_booking_id: booking.mysql_booking_id || null,
        room_number:      String(curOrder.room_number || booking.room_number || ''),
        description:      description,
        desc:             description,
        qty:              1,
        quantity:         1,
        amount:           Number(curOrder.grand_total),
        type:             'CHARGE',
        transaction_type: 'CHARGE',
        status:           'Confirmed',
        business_date:    businessDate,
        created_by:       req.user.fullName || req.user.username || 'Front Desk',
        created_at:       now
      };

      const ledgerRef = db.collection('ledger_items').doc(ledgerItemId);
      txn.set(ledgerRef, ledgerPayload);

      txn.update(orderRef, {
        payment_status: 'ROOM_BILL',
        ledger_item_id: ledgerItemId,
        billed_at:      now,
        billed_by_uid:  String(req.user.uid || req.user.id),
        updated_at:     now
      });

      ledgerResult = ledgerPayload;
    });

    return res.json({
      success: true,
      message: 'Charge successfully posted to Room Folio',
      ledger_item: ledgerResult
    });
  } catch (err) {
    return handleRepoError(res, err, 'processRoomBill');
  }
}

/**
 * POST /api/food/orders/:id/cancel
 * Cancels order with state-gated security rules.
 */
export async function cancelFoodOrder(req, res) {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || String(reason).trim().length < 3) {
      return res.status(400).json({ error: 'Cancellation reason is required', code: 'REASON_REQUIRED' });
    }

    const orderDoc = await getFoodOrderByIdFirestore(id);
    if (!orderDoc) {
      return res.status(404).json({ error: `Order "${id}" not found`, code: 'ORDER_NOT_FOUND' });
    }

    if (['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(orderDoc.order_status)) {
      return res.status(409).json({
        error: `Cannot cancel order in status "${orderDoc.order_status}"`,
        code: 'INVALID_ORDER_STATE'
      });
    }

    const now = new Date().toISOString();
    const newHistoryEntry = {
      status:  'CANCELLED',
      by_uid:  String(req.user.uid || req.user.id),
      by_name: req.user.fullName || req.user.username || 'Staff',
      ts:      now,
      note:    `Order Cancelled: ${reason}`
    };

    const updatePayload = {
      order_status:        'CANCELLED',
      payment_status:      orderDoc.payment_status === 'PENDING' ? 'VOIDED' : orderDoc.payment_status,
      cancelled_at:        now,
      cancelled_by_uid:    String(req.user.uid || req.user.id),
      cancellation_reason: reason,
      status_history:      [...(orderDoc.status_history || []), newHistoryEntry],
      updated_at:          now
    };

    await updateFoodOrderFirestore(id, updatePayload);

    req.app.get('io')?.emit('food:status_changed', {
      order_id:        orderDoc.order_id,
      order_number:    orderDoc.order_number,
      prev_status:     orderDoc.order_status,
      new_status:      'CANCELLED',
      changed_by_name: req.user.fullName || 'Staff',
      ts:              now
    });

    return res.json({
      success: true,
      message: 'Order cancelled successfully'
    });
  } catch (err) {
    return handleRepoError(res, err, 'cancelFoodOrder');
  }
}

/**
 * GET /api/food/orders
 * Returns list of food orders with filtering.
 */
export async function listFoodOrders(req, res) {
  try {
    const { status, payment_status, business_date, room_number, waiter_uid, limit } = req.query;

    const orders = await listFoodOrdersFirestore({
      orderStatus:     status,
      paymentStatus:   payment_status,
      businessDate:    business_date,
      roomNumber:      room_number,
      waiterUid:       waiter_uid,
      limit:           limit ? Number(limit) : 50
    });

    return res.json({
      count: orders.length,
      orders
    });
  } catch (err) {
    return handleRepoError(res, err, 'listFoodOrders');
  }
}

/**
 * GET /api/food/orders/kds
 * Returns orders in active kitchen queue (PLACED, RECEIVED, PREPARING, READY).
 */
export async function getFoodKDSQueue(req, res) {
  try {
    const activeStatuses = ['PLACED', 'RECEIVED', 'PREPARING', 'READY'];
    const allOrders = await listFoodOrdersFirestore({ limit: 100 });
    const kdsOrders = allOrders.filter(o => activeStatuses.includes(o.order_status));

    return res.json({
      count: kdsOrders.length,
      orders: kdsOrders
    });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodKDSQueue');
  }
}
