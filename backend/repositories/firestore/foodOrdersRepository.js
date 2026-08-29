/**
 * foodOrdersRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore data-access layer for the Food / Restaurant POS — Orders.
 *
 * Collection managed:
 *   food_orders — draft, active, billed, and completed food orders
 *
 * Safety Contract:
 *   - Reads/writes ONLY to food_orders collection.
 *   - Never modifies any existing HPMS repository.
 *   - No MySQL interaction. Food orders are Firestore-native.
 *   - Uses firestoreUtils.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

// ── Collection Constant ────────────────────────────────────────────────────────
const FOOD_ORDERS_COLLECTION = 'food_orders';

// ── Valid Enum Values ──────────────────────────────────────────────────────────
export const VALID_DESTINATION_TYPES = ['ROOM', 'TABLE', 'STAFF', 'OWNER'];
export const VALID_ORDER_STATUSES    = [
  'DRAFT',
  'PLACED',
  'RECEIVED',
  'PREPARING',
  'READY',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED'
];
export const VALID_PAYMENT_STATUSES  = [
  'PENDING',
  'PAID',
  'ROOM_BILL',
  'COMPLIMENTARY',
  'VOIDED',
  'REFUNDED'
];

// ─────────────────────────────────────────────────────────────────────────────
// ID Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a time-based, collision-safe Firestore document ID for a food order.
 * Format: forder_{epoch_ms}_{4hex}
 */
export function generateFoodOrderDocId() {
  const ts   = Date.now();
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `forder_${ts}_${rand}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FOOD ORDERS — CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads a single food order by its Firestore document ID.
 */
export async function getFoodOrderByIdFirestore(orderId, options = {}) {
  if (!orderId) return null;
  const docId = String(orderId).startsWith('forder_') ? String(orderId) : `forder_${orderId}`;
  return await getDoc(FOOD_ORDERS_COLLECTION, docId, options);
}

/**
 * Lists food orders with optional filters and sorting.
 */
export async function listFoodOrdersFirestore(options = {}) {
  const {
    orderStatus,
    paymentStatus,
    businessDate,
    destinationType,
    roomNumber,
    waiterUid,
    limit = 50,
    cursor = null,
    orderBy = [{ field: 'created_at', direction: 'desc' }],
    transaction
  } = options;

  const filters = [];

  if (orderStatus) {
    filters.push({ field: 'order_status', op: '==', value: orderStatus });
  }
  if (paymentStatus) {
    filters.push({ field: 'payment_status', op: '==', value: paymentStatus });
  }
  if (businessDate) {
    filters.push({ field: 'business_date', op: '==', value: businessDate });
  }
  if (destinationType) {
    filters.push({ field: 'destination_type', op: '==', value: destinationType });
  }
  if (roomNumber) {
    filters.push({ field: 'room_number', op: '==', value: String(roomNumber) });
  }
  if (waiterUid) {
    filters.push({ field: 'waiter_uid', op: '==', value: String(waiterUid) });
  }

  return await listDocs(FOOD_ORDERS_COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

/**
 * Creates a new food order document in DRAFT (or PLACED) state.
 */
export async function createFoodOrderFirestore(orderData, options = {}) {
  validateRequiredFields(orderData, [
    'destination_type',
    'items',
    'subtotal',
    'tax_total',
    'grand_total',
    'created_by_uid'
  ], 'FoodOrder');

  if (!VALID_DESTINATION_TYPES.includes(orderData.destination_type)) {
    throw new RepositoryError(
      `Invalid destination_type "${orderData.destination_type}". Must be one of: ${VALID_DESTINATION_TYPES.join(', ')}`,
      'VALIDATION_ERROR',
      400
    );
  }

  if (!Array.isArray(orderData.items) || orderData.items.length === 0) {
    throw new RepositoryError('Food order must contain at least one item', 'VALIDATION_ERROR', 400);
  }

  const docId       = orderData.order_id || generateFoodOrderDocId();
  const orderNumber = orderData.order_number || null;
  const now         = new Date().toISOString();
  const bDate       = orderData.business_date || now.split('T')[0];

  const payload = {
    order_id:          docId,
    order_number:      orderNumber,
    business_date:     bDate,
    order_status:      orderData.order_status || 'DRAFT',
    payment_status:    orderData.payment_status || 'PENDING',

    // Destination
    destination_type:  orderData.destination_type,

    // Room fields (null when not ROOM)
    room_id:           orderData.room_id       || null,
    room_number:       orderData.room_number   || null,
    guest_id:          orderData.guest_id      || null,
    guest_name:        orderData.guest_name    || null,
    booking_id:        orderData.booking_id    || null,

    // Table fields (null when not TABLE)
    table_id:          orderData.table_id      || null,
    table_name:        orderData.table_name    || null,

    // Staff fields (null when not STAFF)
    staff_id:          orderData.staff_id      || null,
    staff_name:        orderData.staff_name    || null,

    // Owner fields (null when not OWNER)
    owner_name:        orderData.owner_name    || null,

    // Waiter
    waiter_uid:        orderData.waiter_uid    || null,
    waiter_name:       orderData.waiter_name   || null,

    // Basket snapshot (prices immutable after creation)
    items: orderData.items.map(item => ({
      item_id:       String(item.item_id),
      item_name:     String(item.item_name),
      category_id:   item.category_id   || null,
      category_name: item.category_name || null,
      quantity:      Number(item.quantity),
      unit_price:    Number(item.unit_price),
      tax_rate:      Number(item.tax_rate),
      tax_type:      String(item.tax_type),
      tax_amount:    Number(item.tax_amount),
      line_subtotal: Number(item.line_subtotal),
      line_total:    Number(item.line_total),
      kot_type:      item.kot_type || 'KITCHEN',
      is_veg:        item.is_veg === true,
      item_remarks:  item.item_remarks || null
    })),

    // Totals
    subtotal:          Number(orderData.subtotal),
    tax_total:         Number(orderData.tax_total),
    grand_total:       Number(orderData.grand_total),

    // Remarks
    remarks:           (orderData.remarks || '').trim() || null,

    // Status History
    status_history:    orderData.status_history || [
      {
        status:  orderData.order_status || 'DRAFT',
        by_uid:  String(orderData.created_by_uid),
        by_name: orderData.created_by_name || 'Staff',
        ts:      now,
        note:    'Initial order creation'
      }
    ],

    // Kitchen fields
    kitchen_received_at:  null,
    kitchen_preparing_at: null,
    kitchen_ready_at:     null,
    kitchen_notes:        null,

    // Billing refs
    food_payment_id:          null,
    ledger_item_id:           null,
    complimentary_request_id: null,
    billed_at:                null,
    billed_by_uid:            null,

    // Cancellation
    cancelled_at:        null,
    cancelled_by_uid:    null,
    cancellation_reason: null,

    // Provenance
    created_by_uid:    String(orderData.created_by_uid),
    created_by_name:   orderData.created_by_name || null,
    created_at:        now,
    updated_at:        now
  };

  await setDoc(FOOD_ORDERS_COLLECTION, docId, payload, { merge: false, ...options });
  return { id: docId, ...payload };
}

/**
 * Updates a food order document.
 */
export async function updateFoodOrderFirestore(orderId, updateData, options = {}) {
  if (!orderId) throw new RepositoryError('Food Order ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(orderId).startsWith('forder_') ? String(orderId) : `forder_${orderId}`;

  const payload = {
    ...updateData,
    updated_at: new Date().toISOString()
  };

  return await updateDoc(FOOD_ORDERS_COLLECTION, docId, payload, options);
}
