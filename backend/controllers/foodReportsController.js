/**
 * backend/controllers/foodReportsController.js
 * -----------------------------------------------------------------
 * Phase 2D-B -- Food POS Back-Office: Order History API.
 *
 * Current scope (2D-B): GET /api/food/orders/history only.
 *
 * SAFETY CONTRACT:
 *   - READ ONLY. No Firestore writes, no MySQL reads/writes, no Firebase Auth writes.
 *   - Reads ONLY from: food_orders collection.
 *   - Never reads current menu prices -- historical snapshot data returned as-is.
 *   - Never calls BusinessDateService.getBusinessDate() -- that requires MySQL.
 *     Date filtering uses the `business_date` field already stored on food_orders
 *     (set at placement via getSystemDateFirestore(), not the OS clock).
 *   - Does not modify any existing HPMS workflow or Food POS workflow.
 *
 * BUSINESS DATE RULE (CRITICAL):
 *   food_orders.business_date is the canonical date field for food history.
 *   If `business_date` is supplied, it takes exact-match precedence over from_date/to_date.
 *   If only from_date/to_date are supplied, filter on the business_date field range.
 *   NEVER derive the date from created_at, updated_at, or the OS clock.
 *
 * QUERY STRATEGY:
 *   To minimise required composite indexes, at most ONE Firestore equality/range
 *   filter is applied as the primary filter. All secondary filters are applied
 *   in-memory after the Firestore fetch.
 *
 *   Existing confirmed indexes (firestore.indexes.json):
 *     food_orders: business_date ASC + created_at DESC  <- used for date filters
 *     food_orders: order_status ASC + created_at DESC   <- used for status-only filter
 *     food_orders: payment_status ASC + created_at DESC <- used for payment-only filter
 *
 *   Fetch cap: 500 documents. More than sufficient for hotel restaurant volumes.
 *
 *   Cursor types:
 *     newest/oldest -> Firestore startAfter(docSnapshot) cursor, encoded as:
 *                      base64url { type: "doc", value: "forder_..." }
 *     highest/lowest-> In-memory offset cursor, encoded as:
 *                      base64url { type: "offset", value: <integer> }
 *
 * ORDER NUMBER SEARCH LIMITATION:
 *   Firestore does not support arbitrary substring search. The `order_number` filter
 *   performs in-memory substring matching on the fetched document set.
 *   For date-filtered queries this is accurate. For open-ended queries without a
 *   date filter, results are bounded by the 500-document fetch cap.
 *   A `warnings` field is included in the response when this applies.
 */

import { db } from '../config/firebaseAdmin.js';

const FOOD_ORDERS_COLLECTION = 'food_orders';

// Valid enum values -- must mirror foodOrdersRepository.js
const VALID_ORDER_STATUSES = [
  'DRAFT', 'PLACED', 'RECEIVED', 'PREPARING', 'READY',
  'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED',
];
const VALID_PAYMENT_STATUSES  = ['PENDING', 'PAID', 'ROOM_BILL', 'COMPLIMENTARY', 'VOIDED', 'REFUNDED'];
const VALID_DESTINATION_TYPES = ['ROOM', 'TABLE', 'STAFF', 'OWNER'];
const VALID_SORTS             = ['newest', 'oldest', 'highest', 'lowest'];
const ALLOWED_PAGE_SIZES      = [25, 50, 100];
const FETCH_CAP               = 500;

// ---------------------------------------------------------------------------
// Field Whitelist
// Only these fields are returned to the frontend.
// Raw Firestore internals, tokens, credentials are never exposed.
// ---------------------------------------------------------------------------
function sanitizeOrder(raw) {
  return {
    order_id:                 raw.order_id                 ?? null,
    order_number:             raw.order_number             ?? null,
    business_date:            raw.business_date            ?? null,
    order_status:             raw.order_status             ?? null,
    payment_status:           raw.payment_status           ?? null,
    destination_type:         raw.destination_type         ?? null,

    // Room destination
    room_number:              raw.room_number              ?? null,
    room_id:                  raw.room_id                  ?? null,
    guest_id:                 raw.guest_id                 ?? null,
    guest_name:               raw.guest_name               ?? null,
    booking_id:               raw.booking_id               ?? null,

    // Table destination
    table_id:                 raw.table_id                 ?? null,
    table_name:               raw.table_name               ?? null,

    // Staff / Owner destination
    staff_id:                 raw.staff_id                 ?? null,
    staff_name:               raw.staff_name               ?? null,
    owner_name:               raw.owner_name               ?? null,

    // Waiter
    waiter_uid:               raw.waiter_uid               ?? null,
    waiter_name:              raw.waiter_name              ?? null,

    // Immutable basket snapshot.
    // unit_price here is the HISTORICAL snapshot price -- never replaced with
    // the current menu price.
    items:                    Array.isArray(raw.items) ? raw.items : [],

    subtotal:                 raw.subtotal                 ?? 0,
    tax_total:                raw.tax_total                ?? 0,
    grand_total:              raw.grand_total              ?? 0,

    // Full status timeline (each entry: { status, by_uid, by_name, ts, note })
    status_history:           Array.isArray(raw.status_history) ? raw.status_history : [],

    // Billing references
    food_payment_id:          raw.food_payment_id          ?? null,
    ledger_item_id:           raw.ledger_item_id           ?? null,
    complimentary_request_id: raw.complimentary_request_id ?? null,
    billed_at:                raw.billed_at                ?? null,
    billed_by_uid:            raw.billed_by_uid            ?? null,

    // Cancellation
    cancelled_at:             raw.cancelled_at             ?? null,
    cancelled_by_uid:         raw.cancelled_by_uid         ?? null,
    cancellation_reason:      raw.cancellation_reason      ?? null,

    // Provenance
    created_by_uid:           raw.created_by_uid           ?? null,
    created_by_name:          raw.created_by_name          ?? null,
    created_at:               raw.created_at               ?? null,
    updated_at:               raw.updated_at               ?? null,

    remarks:                  raw.remarks                  ?? null,
  };
}

// ---------------------------------------------------------------------------
// Date Validation
// ---------------------------------------------------------------------------
function validateDateParam(value, paramName) {
  if (!value) return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const err = new Error(
      `Invalid date format for "${paramName}". Expected YYYY-MM-DD, received: "${s}"`
    );
    err.statusCode = 400;
    err.code = 'INVALID_DATE';
    throw err;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Cursor Encoding / Decoding
//
// Cursor is a base64url-encoded JSON object:
//   { "type": "doc",    "value": "forder_..." }  -> Firestore startAfter cursor
//   { "type": "offset", "value": 50 }             -> In-memory offset cursor
//
// base64url avoids + and / characters that need URL-encoding in query strings.
// ---------------------------------------------------------------------------
function encodeCursor(type, value) {
  return Buffer.from(JSON.stringify({ type, value }), 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.type !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ===========================================================================
// GET /api/food/orders/history
// ===========================================================================

/**
 * Returns a paginated, filterable, sortable list of food orders for back-office.
 *
 * Permitted roles: admin, receptionist, manager.
 * Kitchen, chef, staff, and guest roles are blocked at route middleware.
 *
 * READ-ONLY. No writes of any kind.
 */
export async function getOrderHistory(req, res) {
  try {

    // ------------------------------------------------------------------
    // 1. Extract query parameters
    // ------------------------------------------------------------------
    const {
      business_date:    rawBD,
      from_date:        rawFrom,
      to_date:          rawTo,
      order_number:     rawOrderNum,
      order_status:     rawOrderStatus,
      payment_status:   rawPaymentStatus,
      destination_type: rawDestType,
      room_number:      rawRoomNum,
      waiter_uid:       rawWaiterUid,
      table_id:         rawTableId,
      cursor:           rawCursor,
      sort:             rawSort     = 'newest',
      page_size:        rawPageSize = '25',
    } = req.query;

    // ------------------------------------------------------------------
    // 2. Validate sort
    // ------------------------------------------------------------------
    const sort = String(rawSort).toLowerCase().trim();
    if (!VALID_SORTS.includes(sort)) {
      return res.status(400).json({
        error: `Invalid sort value "${rawSort}". Must be one of: ${VALID_SORTS.join(', ')}`,
        code:  'VALIDATION_ERROR',
      });
    }

    // ------------------------------------------------------------------
    // 3. Validate page_size
    // ------------------------------------------------------------------
    const pageSizeNum = Number(rawPageSize);
    if (!Number.isFinite(pageSizeNum) || !ALLOWED_PAGE_SIZES.includes(pageSizeNum)) {
      return res.status(400).json({
        error: `Invalid page_size "${rawPageSize}". Allowed values: ${ALLOWED_PAGE_SIZES.join(', ')}`,
        code:  'VALIDATION_ERROR',
      });
    }
    const pageSize = pageSizeNum;

    // ------------------------------------------------------------------
    // 4. Validate enum filters
    // ------------------------------------------------------------------
    if (rawOrderStatus && !VALID_ORDER_STATUSES.includes(rawOrderStatus)) {
      return res.status(400).json({
        error: `Invalid order_status "${rawOrderStatus}". Valid: ${VALID_ORDER_STATUSES.join(', ')}`,
        code:  'VALIDATION_ERROR',
      });
    }
    if (rawPaymentStatus && !VALID_PAYMENT_STATUSES.includes(rawPaymentStatus)) {
      return res.status(400).json({
        error: `Invalid payment_status "${rawPaymentStatus}". Valid: ${VALID_PAYMENT_STATUSES.join(', ')}`,
        code:  'VALIDATION_ERROR',
      });
    }
    if (rawDestType && !VALID_DESTINATION_TYPES.includes(rawDestType)) {
      return res.status(400).json({
        error: `Invalid destination_type "${rawDestType}". Valid: ${VALID_DESTINATION_TYPES.join(', ')}`,
        code:  'VALIDATION_ERROR',
      });
    }

    // ------------------------------------------------------------------
    // 5. Validate and parse dates
    // ------------------------------------------------------------------
    let businessDate, fromDate, toDate;
    try {
      businessDate = validateDateParam(rawBD,   'business_date');
      fromDate     = validateDateParam(rawFrom, 'from_date');
      toDate       = validateDateParam(rawTo,   'to_date');
    } catch (err) {
      return res.status(err.statusCode || 400).json({
        error: err.message,
        code:  err.code || 'VALIDATION_ERROR',
      });
    }

    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).json({
        error: 'from_date cannot be after to_date',
        code:  'VALIDATION_ERROR',
      });
    }

    // ------------------------------------------------------------------
    // 6. Decode cursor
    // ------------------------------------------------------------------
    const cursor = decodeCursor(rawCursor);

    // ------------------------------------------------------------------
    // 7. Determine mode flags
    //
    // BUSINESS DATE RULE:
    //   business_date exact match takes precedence over from_date/to_date.
    //   Both modes use food_orders.business_date -- never OS clock or MySQL.
    // ------------------------------------------------------------------
    const useSingleDate = Boolean(businessDate);
    const useDateRange  = !useSingleDate && Boolean(fromDate || toDate);
    const isValueSort   = sort === 'highest' || sort === 'lowest';
    const sortDir       = sort === 'oldest' ? 'asc' : 'desc';

    // ------------------------------------------------------------------
    // 8. Build Firestore query
    //
    // Apply ONE primary Firestore filter using a confirmed existing index.
    // All secondary filters are applied in-memory after fetch.
    //
    // Primary filter priority:
    //   1. business_date exact match  -> index: business_date ASC + created_at DESC
    //   2. from_date/to_date range    -> index: business_date ASC + created_at DESC
    //   3. order_status only          -> index: order_status ASC + created_at DESC
    //   4. payment_status only        -> index: payment_status ASC + created_at DESC
    //   5. No primary filter          -> orderBy created_at only (no composite needed)
    // ------------------------------------------------------------------
    let fsQuery = db.collection(FOOD_ORDERS_COLLECTION);
    let primaryFilter = 'none';

    if (useSingleDate) {
      fsQuery = fsQuery.where('business_date', '==', businessDate);
      primaryFilter = 'business_date_exact';

    } else if (useDateRange) {
      // Range filter on business_date.
      // Firestore requires the first orderBy to match the range-filtered field.
      // The existing index (business_date ASC + created_at DESC) satisfies:
      //   where('>= fromDate').where('<= toDate').orderBy('business_date').orderBy('created_at', 'desc')
      if (fromDate) fsQuery = fsQuery.where('business_date', '>=', fromDate);
      if (toDate)   fsQuery = fsQuery.where('business_date', '<=', toDate);
      // orderBy must start with business_date (Firestore range filter requirement).
      // Always use DESC created_at (existing index direction).
      // Re-sort in-memory if sort === 'oldest' or value sort.
      fsQuery = fsQuery.orderBy('business_date', 'asc').orderBy('created_at', 'desc');
      primaryFilter = 'date_range';

    } else if (
      rawOrderStatus &&
      !rawPaymentStatus && !rawDestType && !rawRoomNum && !rawWaiterUid && !rawTableId
    ) {
      // Single order_status: uses existing index order_status ASC + created_at DESC
      fsQuery = fsQuery.where('order_status', '==', rawOrderStatus);
      primaryFilter = 'order_status';

    } else if (
      rawPaymentStatus &&
      !rawOrderStatus && !rawDestType && !rawRoomNum && !rawWaiterUid && !rawTableId
    ) {
      // Single payment_status: uses existing index payment_status ASC + created_at DESC
      fsQuery = fsQuery.where('payment_status', '==', rawPaymentStatus);
      primaryFilter = 'payment_status';
    }
    // All other combinations: no Firestore filter, query entire collection ordered by created_at.

    // ------------------------------------------------------------------
    // 9. Apply ordering (skip if date_range already set it)
    // ------------------------------------------------------------------
    if (primaryFilter !== 'date_range') {
      // For value sorts: fetch desc by created_at (stable); re-sort in memory by grand_total.
      fsQuery = fsQuery.orderBy('created_at', isValueSort ? 'desc' : sortDir);
    }

    // ------------------------------------------------------------------
    // 10. Apply Firestore cursor (time-based sorts only)
    //
    // Uses Firestore startAfter(documentSnapshot) as required.
    // The cursor encodes the last document ID from the previous page.
    // Silently ignored if the cursor document has been deleted.
    // ------------------------------------------------------------------
    if (!isValueSort && cursor?.type === 'doc' && cursor.value) {
      const cursorDocRef  = db.collection(FOOD_ORDERS_COLLECTION).doc(String(cursor.value));
      const cursorDocSnap = await cursorDocRef.get();
      if (cursorDocSnap.exists) {
        fsQuery = fsQuery.startAfter(cursorDocSnap);
      }
    }

    // ------------------------------------------------------------------
    // 11. Determine fetch limit
    //
    // Value sorts: must fetch all matching docs to sort correctly -> FETCH_CAP.
    // Date range: always overfetch since we sort in-memory -> FETCH_CAP.
    // Time sorts + secondary in-memory filters: overfetch as buffer -> min(5x, FETCH_CAP).
    // Time sorts + no secondary filters: tight limit (pageSize+1 for has_more probe).
    // ------------------------------------------------------------------
    const hasSecondaryInMemoryFilters = Boolean(
      rawOrderNum || rawDestType || rawRoomNum || rawWaiterUid || rawTableId ||
      (rawOrderStatus   && primaryFilter !== 'order_status')  ||
      (rawPaymentStatus && primaryFilter !== 'payment_status')
    );

    let fetchLimit;
    if (isValueSort || primaryFilter === 'date_range') {
      fetchLimit = FETCH_CAP;
    } else if (hasSecondaryInMemoryFilters) {
      fetchLimit = Math.min(pageSize * 5, FETCH_CAP);
    } else {
      fetchLimit = pageSize + 1;
    }

    fsQuery = fsQuery.limit(fetchLimit);

    // ------------------------------------------------------------------
    // 12. Execute Firestore query
    // ------------------------------------------------------------------
    const snapshot = await fsQuery.get();

    // Attach Firestore doc ID as _fsDocId for cursor construction.
    // Stripped from output in sanitizeOrder().
    let docs = snapshot.docs.map(docSnap => ({
      _fsDocId: docSnap.id,
      ...docSnap.data(),
    }));

    // ------------------------------------------------------------------
    // 13. In-memory secondary filters
    // ------------------------------------------------------------------
    if (rawOrderStatus && primaryFilter !== 'order_status') {
      docs = docs.filter(d => d.order_status === rawOrderStatus);
    }
    if (rawPaymentStatus && primaryFilter !== 'payment_status') {
      docs = docs.filter(d => d.payment_status === rawPaymentStatus);
    }
    if (rawDestType) {
      docs = docs.filter(d => d.destination_type === rawDestType);
    }
    if (rawRoomNum) {
      const rn = String(rawRoomNum).trim();
      docs = docs.filter(d => String(d.room_number || '').trim() === rn);
    }
    if (rawWaiterUid) {
      docs = docs.filter(d => d.waiter_uid === rawWaiterUid);
    }
    if (rawTableId) {
      docs = docs.filter(d => d.table_id === rawTableId);
    }
    if (rawOrderNum) {
      // LIMITATION: In-memory substring match on the fetched document set.
      // For date-filtered queries this is accurate. For open-ended queries,
      // bounded by the FETCH_CAP limit. A warning is included in the response.
      const searchStr = String(rawOrderNum).toUpperCase().trim();
      docs = docs.filter(d =>
        d.order_number && String(d.order_number).toUpperCase().includes(searchStr)
      );
    }

    // ------------------------------------------------------------------
    // 14. In-memory sort (value sorts, and oldest+dateRange)
    // ------------------------------------------------------------------
    if (sort === 'highest') {
      docs.sort((a, b) => (Number(b.grand_total) || 0) - (Number(a.grand_total) || 0));
    } else if (sort === 'lowest') {
      docs.sort((a, b) => (Number(a.grand_total) || 0) - (Number(b.grand_total) || 0));
    } else if (sort === 'oldest' && primaryFilter === 'date_range') {
      // Date range Firestore query uses business_date ASC + created_at DESC.
      // Re-sort for oldest (created_at ASC).
      docs.sort((a, b) => {
        const ta = a.created_at || '';
        const tb = b.created_at || '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
    }

    // ------------------------------------------------------------------
    // 15. Paginate and build next_cursor
    // ------------------------------------------------------------------
    let resultDocs;
    let hasMore;
    let nextCursorStr = null;

    if (isValueSort) {
      // Offset cursor for value-based sorts.
      const offset = (
        cursor?.type === 'offset' &&
        Number.isInteger(cursor.value) &&
        cursor.value >= 0
      ) ? cursor.value : 0;

      resultDocs = docs.slice(offset, offset + pageSize);
      hasMore    = docs.length > offset + pageSize;
      if (hasMore) {
        nextCursorStr = encodeCursor('offset', offset + pageSize);
      }

    } else {
      // Time-based sort: Firestore startAfter was already applied.
      // docs starts from after the cursor position.
      hasMore    = docs.length > pageSize;
      resultDocs = docs.slice(0, pageSize);

      if (resultDocs.length > 0 && hasMore) {
        const lastDoc = resultDocs[resultDocs.length - 1];
        nextCursorStr = encodeCursor('doc', lastDoc._fsDocId || lastDoc.order_id);
      }
    }

    // ------------------------------------------------------------------
    // 16. Sanitize: strip _fsDocId, apply field whitelist, return.
    //     Historical snapshot data (items, unit_price) returned exactly as stored.
    //     Current menu prices are NOT consulted.
    // ------------------------------------------------------------------
    const orders = resultDocs.map(doc => sanitizeOrder(doc));

    const warnings = [];
    if (rawOrderNum && !useSingleDate && !useDateRange) {
      warnings.push(
        'order_number search is performed in-memory and is bounded by the ' +
        '500-document fetch cap. Add a business_date or date range filter for complete results.'
      );
    }

    const body = {
      count:       orders.length,
      orders,
      has_more:    hasMore,
      next_cursor: nextCursorStr,
    };
    if (warnings.length > 0) body.warnings = warnings;

    return res.json(body);

  } catch (err) {
    // Never expose Firestore internals or stack traces to the frontend.
    console.error('[FoodReportsController] getOrderHistory unexpected error:', err);

    // Surface missing-index errors clearly in logs (actionable for devs).
    if (err.code === 9 || (err.message && err.message.includes('FAILED_PRECONDITION'))) {
      console.error(
        '[FoodReportsController] Firestore FAILED_PRECONDITION detected.\n' +
        'A composite index may be missing. Identify the query above and add the required\n' +
        'index to firestore.indexes.json before redeploying.'
      );
      return res.status(500).json({
        error: 'A required Firestore index is missing. Contact the system administrator.',
        code:  'INDEX_MISSING',
      });
    }

    return res.status(500).json({
      error: 'Failed to retrieve order history. Please try again.',
      code:  'INTERNAL_ERROR',
    });
  }
}
