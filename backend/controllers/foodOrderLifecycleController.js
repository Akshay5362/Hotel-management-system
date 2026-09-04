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

// ── Status-Transition Field Whitelist ──────────────────────────────────────────
// Applies to every caller of updateFoodOrderStatus (Kitchen AND, since the
// READY -> OUT_FOR_DELIVERY handoff, Reception too) — neither may ever touch
// any field beyond this set via this endpoint, regardless of which specific
// transition they're authorized for.
const STATUS_TRANSITION_ALLOWED_FIELDS = new Set([
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
 * POST /api/food/orders/:id/cancel-draft
 * ─────────────────────────────────────────────────────────────────────────
 * Narrow, best-effort cleanup for the two-step FoodNewOrder.jsx create+place
 * flow: if POST /orders succeeded (a DRAFT exists) but the follow-up
 * PUT /orders/:id/place call then failed, the frontend calls this endpoint
 * with the known order_id to avoid leaving an orphan DRAFT behind.
 *
 * Deliberately narrower than cancelFoodOrder (which allows cancelling any
 * non-terminal status, intended for staff-initiated cancellations of a real,
 * visible order): this only ever touches a still-DRAFT order.
 *   - Not found or already CANCELLED  → idempotent success, safe to call
 *     more than once (e.g. a retried cleanup attempt after a flaky network).
 *   - Anything other than DRAFT (i.e. the placement actually succeeded
 *     server-side despite the client seeing a failure) → 409, no write.
 *     This is the critical guard against ever cancelling an order that
 *     raced into PLACED or beyond.
 * No Socket.IO event is emitted — a DRAFT was never returned by
 * getFoodKDSQueue (PLACED/RECEIVED/PREPARING/READY only), so no Kitchen/
 * Reception screen ever displayed it; emitting food:status_changed here
 * would just be noise for an order nobody ever saw. No payment/ledger
 * fields are touched — a DRAFT's payment_status is never meaningfully
 * engaged before PLACED.
 */
export async function cancelDraftOrder(req, res) {
  try {
    const { id } = req.params;

    const orderDoc = await getFoodOrderByIdFirestore(id);
    if (!orderDoc || orderDoc.order_status === 'CANCELLED') {
      return res.json({ success: true, message: 'Nothing to clean up.' });
    }

    if (orderDoc.order_status !== 'DRAFT') {
      return res.status(409).json({
        error: `Refusing to auto-cancel: order is "${orderDoc.order_status}", not DRAFT.`,
        code: 'NOT_DRAFT'
      });
    }

    const now = new Date().toISOString();
    const newHistoryEntry = {
      status:  'CANCELLED',
      by_uid:  String(req.user.uid || req.user.id),
      by_name: req.user.fullName || req.user.username || 'Staff',
      ts:      now,
      note:    'Auto-cancelled: order placement failed'
    };

    await updateFoodOrderFirestore(id, {
      order_status:        'CANCELLED',
      cancelled_at:         now,
      cancelled_by_uid:     String(req.user.uid || req.user.id),
      cancellation_reason:  'Order placement failed — automatically cancelled draft.',
      status_history:       [...(orderDoc.status_history || []), newHistoryEntry],
      updated_at:            now
    });

    return res.json({ success: true, message: 'Draft order cancelled.' });
  } catch (err) {
    return handleRepoError(res, err, 'cancelDraftOrder');
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

    // ── Food-specific authorization: order-status transitions are a
    // KITCHEN or RECEPTION operational action — Admin, Housekeeper, and
    // every other role are always forbidden here, full stop. Admin may
    // view the KDS (see GET /orders/kds) but must never be able to drive
    // it. The exact PER-TRANSITION rule (which of Kitchen/Reception may
    // perform which specific transition) is enforced further below, once
    // the order's current status is known inside the transaction — this
    // first check is only the coarse "is this role ever eligible at all"
    // gate.
    //
    // This check is deliberately independent of the global ENABLE_STRICT_RBAC
    // flag and of the route-level requireRole(...) list — it re-derives the
    // caller's normalized role itself and enforces the restriction here,
    // so this endpoint's authorization stays correct regardless of how that
    // flag or the route's allowed-role list are configured elsewhere in HPMS.
    const normalizedRole = normalizeUserRole(req.user);
    const isKitchenUser = normalizedRole === 'kitchen';
    const isReceptionUser = normalizedRole === 'receptionist';

    if (!isKitchenUser && !isReceptionUser) {
      return res.status(403).json({
        error: 'Forbidden: Only Kitchen staff may change kitchen preparation status, and only Reception may hand an order off for delivery. Admin has monitoring-only access to the Kitchen Display.',
        code: 'STATUS_TRANSITION_FORBIDDEN'
      });
    }

    // Both eligible roles are further restricted to only the fields this
    // workflow legitimately needs to touch (unchanged from before, now
    // shared by both Kitchen and Reception callers).
    const incomingKeys = Object.keys(req.body);
    const invalidKeys = incomingKeys.filter(k => !STATUS_TRANSITION_ALLOWED_FIELDS.has(k) && k !== 'next_status');
    if (invalidKeys.length > 0) {
      return res.status(403).json({
        error: `Strictly forbidden from modifying fields: ${invalidKeys.join(', ')}`,
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

      // ── Per-transition role authorization ────────────────────────────
      // Reception is authorized for exactly one handoff: READY -> OUT_FOR_DELIVERY.
      // Kitchen is authorized for every other transition (RECEIVED -> PREPARING,
      // PREPARING -> READY, etc.) but explicitly NOT this handoff — Chef must
      // not be able to mark an order out for delivery. This check only runs
      // once currentStatus is known (read above), which is why it lives inside
      // the transaction rather than in the coarse pre-check earlier.
      const isReadyToDispatchTransition = currentStatus === 'READY' && next_status === 'OUT_FOR_DELIVERY';

      if (isReadyToDispatchTransition) {
        if (!isReceptionUser) {
          throw new RepositoryError(
            'Forbidden: Only Reception may hand an order off for delivery (READY -> OUT_FOR_DELIVERY).',
            'RECEPTION_ONLY_ACTION',
            403
          );
        }
      } else if (!isKitchenUser) {
        throw new RepositoryError(
          'Forbidden: Only Kitchen staff may perform this status transition.',
          'KITCHEN_ONLY_ACTION',
          403
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
 * PUT /api/food/orders/:id/modify
 * ─────────────────────────────────────────────────────────────────────────────
 * KOT Modification (F2). Changes the item lines on an already-placed order —
 * this NEVER creates a new order; order_id and order_number are preserved.
 *
 * Client sends the complete new item list as {item_id, quantity, item_remarks?}.
 * Prices/tax are NEVER trusted from the client — every line is recalculated
 * here from the authoritative food_menu_items record, mirroring the same
 * "never trust frontend totals" rule the rest of this controller already
 * enforces for Pay Now / Room Bill.
 *
 * Writes, atomically, in one transaction on the same food_orders document:
 *   - items / subtotal / tax_total / grand_total (recalculated)
 *   - modification_history[] — new, structured, append-only audit entry
 *   - status_history[] — one human-readable note, so the existing Order
 *     History timeline (FoodOrderHistory.jsx) surfaces the modification
 *     with zero frontend changes to that screen.
 * order_status itself is untouched — a modification is not a status change.
 */
export async function modifyFoodOrder(req, res) {
  try {
    const { id } = req.params;
    const items = req.body.items;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required', code: 'VALIDATION_ERROR' });
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.item_id) {
        return res.status(400).json({ error: `Item #${i + 1}: item_id is required`, code: 'VALIDATION_ERROR' });
      }
      if (!Number.isFinite(Number(it.quantity)) || Number(it.quantity) < 1) {
        return res.status(400).json({ error: `Item #${i + 1}: quantity must be >= 1`, code: 'VALIDATION_ERROR' });
      }
    }

    const orderRef = db.collection('food_orders').doc(String(id).startsWith('forder_') ? String(id) : `forder_${id}`);
    const uniqueItemIds = Array.from(new Set(items.map(it => String(it.item_id))));
    const menuItemRefs = uniqueItemIds.map(itemId => db.collection('food_menu_items').doc(itemId));

    const now = new Date().toISOString();
    let resultPayload = null;

    await db.runTransaction(async (txn) => {
      // ── All reads before any write (Firestore transaction rule) ──────────
      const orderSnap = await txn.get(orderRef);
      if (!orderSnap.exists) {
        throw new RepositoryError(`Order "${id}" not found`, 'ORDER_NOT_FOUND', 404);
      }
      const orderData = orderSnap.data();

      const menuSnaps = menuItemRefs.length > 0 ? await txn.getAll(...menuItemRefs) : [];
      const menuById = new Map();
      menuSnaps.forEach(snap => {
        if (snap.exists) menuById.set(snap.id, snap.data());
      });

      // ── Business-rule gates ────────────────────────────────────────────
      // Same terminal-state gate already used by cancelFoodOrder — reusing
      // the one rule this codebase has already vetted, not inventing a new one.
      if (['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(orderData.order_status)) {
        throw new RepositoryError(
          `Cannot modify order in status "${orderData.order_status}"`,
          'INVALID_ORDER_STATE',
          409
        );
      }
      // No refund/reconciliation mechanism exists yet for food payments —
      // modifying totals on an already-billed order would leave the charged
      // amount and the order total silently out of sync. Block it instead
      // of inventing reconciliation logic here.
      if (orderData.payment_status !== 'PENDING') {
        throw new RepositoryError(
          `Cannot modify an order that is already billed (payment_status: "${orderData.payment_status}"). Settle/void it through the existing payment workflow first.`,
          'ALREADY_BILLED',
          409
        );
      }

      const oldItemsById = new Map((orderData.items || []).map(it => [it.item_id, it]));

      // ── Validate every item exists/active, build the new snapshot ────────
      const newItems = [];
      for (const it of items) {
        const itemId = String(it.item_id);
        const menuItem = menuById.get(itemId);
        if (!menuItem) {
          throw new RepositoryError(`Menu item "${itemId}" does not exist`, 'ITEM_NOT_FOUND', 400);
        }
        if (menuItem.is_active === false) {
          throw new RepositoryError(`Menu item "${menuItem.name}" is no longer active`, 'ITEM_INACTIVE', 400);
        }

        const priorSnapshot = oldItemsById.get(itemId) || null;
        const quantity      = Number(it.quantity);
        const unitPrice     = Number(menuItem.base_price || 0);
        const taxRate       = Number(menuItem.tax_rate || 0);
        const taxType       = String(menuItem.tax_type || 'EXEMPT');
        const lineSubtotal  = Math.round(unitPrice * quantity * 100) / 100;
        const taxAmount     = Math.round(lineSubtotal * (taxRate / 100) * 100) / 100;
        const lineTotal     = Math.round((lineSubtotal + taxAmount) * 100) / 100;

        newItems.push({
          item_id:       itemId,
          item_name:     menuItem.name,
          category_id:   menuItem.category_id || priorSnapshot?.category_id || null,
          category_name: priorSnapshot?.category_name || null,
          quantity,
          unit_price:    unitPrice,
          tax_rate:      taxRate,
          tax_type:      taxType,
          tax_amount:    taxAmount,
          line_subtotal: lineSubtotal,
          line_total:    lineTotal,
          kot_type:      menuItem.kot_type || 'KITCHEN',
          is_veg:        menuItem.is_veg === true,
          item_remarks:  it.item_remarks !== undefined
            ? (String(it.item_remarks).trim() || null)
            : (priorSnapshot?.item_remarks || null)
        });
      }

      const newSubtotal   = Math.round(newItems.reduce((s, it) => s + it.line_subtotal, 0) * 100) / 100;
      const newTaxTotal   = Math.round(newItems.reduce((s, it) => s + it.tax_amount, 0) * 100) / 100;
      const newGrandTotal = Math.round((newSubtotal + newTaxTotal) * 100) / 100;

      // ── Server-computed diff — never trust a client-submitted summary ────
      const newItemsById = new Map(newItems.map(it => [it.item_id, it]));
      const changes = [];

      for (const [itemId, oldItem] of oldItemsById) {
        const newItem = newItemsById.get(itemId);
        if (!newItem) {
          changes.push({ type: 'REMOVED', item_id: itemId, item_name: oldItem.item_name, prev_qty: oldItem.quantity, new_qty: 0 });
        } else if (newItem.quantity !== oldItem.quantity) {
          changes.push({ type: 'QTY_CHANGED', item_id: itemId, item_name: oldItem.item_name, prev_qty: oldItem.quantity, new_qty: newItem.quantity });
        }
      }
      for (const [itemId, newItem] of newItemsById) {
        if (!oldItemsById.has(itemId)) {
          changes.push({ type: 'ADDED', item_id: itemId, item_name: newItem.item_name, prev_qty: 0, new_qty: newItem.quantity });
        }
      }

      if (changes.length === 0) {
        throw new RepositoryError('No changes detected — nothing to modify', 'NO_CHANGES', 400);
      }

      const modificationId = `fmod_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
      const byUid  = String(req.user.uid || req.user.id);
      const byName = req.user.fullName || req.user.username || 'Staff';

      const summaryParts = changes.map(c => {
        if (c.type === 'ADDED')   return `+ ${c.item_name} × ${c.new_qty}`;
        if (c.type === 'REMOVED') return `− ${c.item_name} × ${c.prev_qty}`;
        return `${c.item_name} ${c.prev_qty} → ${c.new_qty}`;
      });

      const modificationEntry = {
        modification_id: modificationId,
        ts:               now,
        by_uid:           byUid,
        by_name:          byName,
        changes,
        old_grand_total:  Number(orderData.grand_total),
        new_grand_total:  newGrandTotal
      };

      const statusHistoryEntry = {
        status:  orderData.order_status, // unchanged — a modification is not a status transition
        by_uid:  byUid,
        by_name: byName,
        ts:      now,
        note:    `KOT Modified: ${summaryParts.join(', ')}`
      };

      txn.update(orderRef, {
        items:                 newItems,
        subtotal:              newSubtotal,
        tax_total:             newTaxTotal,
        grand_total:           newGrandTotal,
        modification_history:  [...(orderData.modification_history || []), modificationEntry],
        status_history:        [...(orderData.status_history || []), statusHistoryEntry],
        updated_at:            now
      });

      resultPayload = {
        order_id:        orderData.order_id,
        order_number:     orderData.order_number,
        changes,
        old_grand_total:  Number(orderData.grand_total),
        new_grand_total:  newGrandTotal,
        modification_id:  modificationId
      };
    });

    req.app.get('io')?.emit('food:order_modified', {
      order_id:     resultPayload.order_id,
      order_number: resultPayload.order_number,
      changes:      resultPayload.changes,
      modified_by:  req.user.fullName || req.user.username || 'Staff',
      ts:           now
    });

    return res.json({
      success: true,
      message: 'KOT modified successfully',
      ...resultPayload
    });
  } catch (err) {
    return handleRepoError(res, err, 'modifyFoodOrder');
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
