/**
 * foodOrderController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express controller handlers for Food / Restaurant POS — Phase 2A: Orders.
 *
 * Phase 2A Scope:
 *   - GET /api/food/context/rooms  — read-only room+guest context for order destination
 *   - GET /api/food/context/staff  — read-only active staff list for order destination
 *   - POST /api/food/orders        — create a draft food order (DRAFT status)
 *   - GET /api/food/orders/:id     — read a single food order
 *
 * Phase 2B will add:
 *   - Order status updates (CONFIRMED, BILLED, CANCELLED)
 *   - Order history listing
 *   - Room ledger posting (separate phase — NOT here)
 *
 * Safety Contract:
 *   - context/rooms: reads `rooms` + `bookings` collections read-only via existing repos
 *   - context/staff: reads `staff` collection read-only via existing repo
 *   - food_orders: writes ONLY to food_orders collection via foodOrdersRepository.js
 *   - Never modifies any existing HPMS business logic, schema, or collection
 *   - No MySQL interaction
 *   - No Firebase Auth mutations
 */

import {
  getAllRoomsFirestore,
  getRoomByNumberFirestore
} from '../repositories/firestore/roomsRepository.js';

import {
  getBookingByIdFirestore
} from '../repositories/firestore/bookingsRepository.js';

import {
  getAllStaffFirestore
} from '../repositories/firestore/staffRepository.js';

import {
  createFoodOrderFirestore,
  getFoodOrderByIdFirestore,
  VALID_DESTINATION_TYPES
} from '../repositories/firestore/foodOrdersRepository.js';

import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { RepositoryError } from '../repositories/firestore/firestoreUtils.js';

// ── Shared error handler ──────────────────────────────────────────────────────

function handleRepoError(res, err, context) {
  if (err instanceof RepositoryError) {
    const status = err.status || 500;
    console.warn(`[FoodOrderController] ${context} — RepositoryError (${err.code}): ${err.message}`);
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error(`[FoodOrderController] ${context} — Unexpected error:`, err);
  return res.status(500).json({ error: 'Internal Server Error' });
}

// ── Audit helper ──────────────────────────────────────────────────────────────

async function writeAuditLog(req, action, details) {
  try {
    await createAuditLogFirestore({
      action,
      details,
      user_id:       req.user?.uid || req.user?.id || 'unknown',
      business_date: new Date().toISOString().split('T')[0]
    });
  } catch (e) {
    // Non-fatal — never let audit log failure break the primary operation
    console.warn('[FoodOrderController] Audit log write failed (non-fatal):', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT ENDPOINTS — Read-only lookups to populate destination selectors
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/food/context/rooms
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns all rooms with their current occupancy status and guest name.
 * Used by the New Order form to let receptionist select a room destination.
 *
 * READ-ONLY — calls existing roomsRepository + bookingsRepository functions.
 * Zero writes. Zero MySQL. Zero side effects.
 */
export const getFoodOrderRoomContext = async (req, res) => {
  try {
    const allRooms = await getAllRoomsFirestore({
      orderBy: [{ field: 'number', direction: 'asc' }],
      limit: 200
    });

    // Enrich occupied rooms with guest name from their active booking
    const enriched = await Promise.all(
      allRooms.map(async room => {
        let guestName = null;
        let guestId   = null;
        let bookingId = null;

        if (room.status === 'occupied' && room.current_booking_id) {
          try {
            const booking = await getBookingByIdFirestore(room.current_booking_id);
            if (booking) {
              guestName = booking.guest_name || booking.primary_guest_name || null;
              guestId   = booking.guest_id   || null;
              bookingId = booking.booking_id || booking.id || booking.doc_id || null;
            }
          } catch (e) {
            // Non-fatal — room still returned, just without guest name
            console.warn(`[FoodOrderController] Could not fetch booking for room ${room.number}:`, e.message);
          }
        }

        return {
          room_id:     room.doc_id || room.id,
          room_number: String(room.number || ''),
          type:        room.type || room.room_type || null,
          status:      room.status || 'unknown',
          guest_name:  guestName,
          guest_id:    guestId,
          booking_id:  bookingId,
          floor:       room.floor || null
        };
      })
    );

    return res.json({
      rooms: enriched,
      total: enriched.length
    });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodOrderRoomContext');
  }
};

/**
 * GET /api/food/context/staff
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns all active staff members.
 * Used by the New Order form for STAFF destination type.
 *
 * READ-ONLY — calls existing staffRepository function.
 * Zero writes. Zero MySQL. Zero side effects.
 */
export const getFoodOrderStaffContext = async (req, res) => {
  try {
    const staffList = await getAllStaffFirestore({
      orderBy:        [{ field: 'full_name', direction: 'asc' }],
      limit:          200,
      includeInactive: false
    });

    const mapped = staffList.map(s => ({
      staff_id:   s.doc_id || s.id,
      staff_name: s.full_name || s.name || s.username || 'Unknown',
      role:       s.role || null,
      department: s.department || null
    }));

    return res.json({
      staff: mapped,
      total: mapped.length
    });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodOrderStaffContext');
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOOD ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/food/orders
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates a new food order in DRAFT status.
 * Called after the receptionist completes the basket and clicks "Place Draft Order".
 *
 * Full validation is performed before writing.
 * Basket item prices are snapshotted — menu changes after order creation
 * do NOT affect the order totals.
 *
 * Writes to: food_orders (new Firestore collection, zero overlap with HPMS)
 */
export const createFoodOrder = async (req, res) => {
  try {
    const body = req.body;

    // ── Destination validation ─────────────────────────────────────────────
    if (!body.destination_type || !VALID_DESTINATION_TYPES.includes(body.destination_type)) {
      return res.status(400).json({
        error: `destination_type is required and must be one of: ${VALID_DESTINATION_TYPES.join(', ')}`
      });
    }

    if (body.destination_type === 'ROOM' && !body.room_number) {
      return res.status(400).json({ error: 'room_number is required for ROOM orders' });
    }
    if (body.destination_type === 'TABLE' && !body.table_name) {
      return res.status(400).json({ error: 'table_name is required for TABLE orders' });
    }
    if (body.destination_type === 'STAFF' && !body.staff_name) {
      return res.status(400).json({ error: 'staff_name is required for STAFF orders' });
    }
    if (body.destination_type === 'OWNER' && !body.owner_name) {
      return res.status(400).json({ error: 'owner_name is required for OWNER orders' });
    }

    // ── Items validation ───────────────────────────────────────────────────
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      if (!item.item_id)             return res.status(400).json({ error: `Item #${i+1}: item_id is required` });
      if (!item.item_name)           return res.status(400).json({ error: `Item #${i+1}: item_name is required` });
      if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) < 1) {
        return res.status(400).json({ error: `Item #${i+1}: quantity must be >= 1` });
      }
      if (!Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0) {
        return res.status(400).json({ error: `Item #${i+1}: unit_price must be a non-negative number` });
      }
      if (!Number.isFinite(Number(item.line_total)) || Number(item.line_total) < 0) {
        return res.status(400).json({ error: `Item #${i+1}: line_total is invalid` });
      }
    }

    // ── Totals validation ──────────────────────────────────────────────────
    const subtotal    = Number(body.subtotal);
    const taxTotal    = Number(body.tax_total);
    const grandTotal  = Number(body.grand_total);

    if (!Number.isFinite(subtotal)   || subtotal   < 0) return res.status(400).json({ error: 'subtotal is invalid' });
    if (!Number.isFinite(taxTotal)   || taxTotal   < 0) return res.status(400).json({ error: 'tax_total is invalid' });
    if (!Number.isFinite(grandTotal) || grandTotal < 0) return res.status(400).json({ error: 'grand_total is invalid' });

    // Server-side cross-check: grand_total must equal subtotal + tax_total (within ₹0.02 tolerance for float rounding)
    const computedGrand = Math.round((subtotal + taxTotal) * 100) / 100;
    if (Math.abs(computedGrand - grandTotal) > 0.02) {
      return res.status(400).json({
        error: `grand_total mismatch: expected ${computedGrand}, received ${grandTotal}`
      });
    }

    // ── Build order payload ────────────────────────────────────────────────
    const orderData = {
      destination_type: body.destination_type,

      // Room
      room_id:     body.room_id     || null,
      room_number: body.room_number || null,
      guest_id:    body.guest_id    || null,
      guest_name:  body.guest_name  || null,
      booking_id:  body.booking_id  || null,

      // Table
      table_id:   body.table_id   || null,
      table_name: body.table_name || null,

      // Staff
      staff_id:   body.staff_id   || null,
      staff_name: body.staff_name || null,

      // Owner
      owner_name: body.owner_name || null,

      // Items snapshot
      items: body.items.map(item => ({
        item_id:       String(item.item_id),
        item_name:     String(item.item_name),
        category_id:   item.category_id   || null,
        category_name: item.category_name || null,
        quantity:      Number(item.quantity),
        unit_price:    Math.round(Number(item.unit_price)    * 100) / 100,
        tax_rate:      Number(item.tax_rate)    || 0,
        tax_type:      String(item.tax_type     || 'EXEMPT'),
        tax_amount:    Math.round(Number(item.tax_amount)    * 100) / 100,
        line_subtotal: Math.round(Number(item.line_subtotal) * 100) / 100,
        line_total:    Math.round(Number(item.line_total)    * 100) / 100,
        kot_type:      item.kot_type || 'KITCHEN',
        is_veg:        item.is_veg === true
      })),

      // Totals
      subtotal:    Math.round(subtotal   * 100) / 100,
      tax_total:   Math.round(taxTotal   * 100) / 100,
      grand_total: Math.round(grandTotal * 100) / 100,

      // Remarks
      remarks: (body.remarks || '').trim() || null,

      // Provenance from authenticated user
      created_by_uid:  req.user?.uid || req.user?.id || 'unknown',
      created_by_name: req.user?.name || req.user?.full_name || req.user?.username || null
    };

    const savedOrder = await createFoodOrderFirestore(orderData);

    // Audit log (non-fatal)
    await writeAuditLog(req, 'food_order_created', {
      order_id:         savedOrder.order_id,
      order_number:     savedOrder.order_number,
      destination_type: savedOrder.destination_type,
      grand_total:      savedOrder.grand_total,
      item_count:       savedOrder.items.length
    });

    return res.status(201).json({
      message:      'Food order created successfully',
      order_id:     savedOrder.order_id,
      order_number: savedOrder.order_number,
      order_status: savedOrder.order_status,
      order:        savedOrder
    });
  } catch (err) {
    return handleRepoError(res, err, 'createFoodOrder');
  }
};

/**
 * GET /api/food/orders/:id
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns a single food order by its document ID.
 * Used to confirm the order was persisted correctly after creation.
 */
export const getFoodOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Order ID is required' });

    const order = await getFoodOrderByIdFirestore(id);
    if (!order) return res.status(404).json({ error: 'Food order not found' });

    return res.json({ order });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodOrderById');
  }
};
