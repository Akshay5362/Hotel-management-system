/**
 * purchaseOrdersRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore access for `purchase_orders` and `purchase_order_items` (Phase E).
 *
 * A PURCHASE ORDER is the formal document issued to ONE supplier, created from
 * exactly ONE approved purchase request. It is not a receipt, not a stock
 * addition and not a payment — nothing in this file reads or writes a stock
 * balance or the movement ledger.
 *
 * ── One PO per PR, by construction ──────────────────────────────────────────
 * The PO document id is DERIVED from its source request id
 * (pr_abc → po_abc). That single fact gives three properties for free:
 *   1. a request can never have two purchase orders,
 *   2. "does a PO already exist for this request?" is one O(1) document get —
 *      no query, no composite index,
 *   3. nothing is ever written back to the APPROVED request, so Phase C's
 *      immutability guarantee is preserved untouched.
 *
 * purchase_orders/{po_<request-key>}
 * purchase_order_items/{po_<request-key>_<line_no>}
 */

import { db } from '../../config/firebaseAdmin.js';
import { getDoc, formatDocSnapshot, RepositoryError, buildStatusFilter } from './firestoreUtils.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../utils/inventoryConstants.js';

export const ORDERS_COLLECTION = 'purchase_orders';
export const ORDER_ITEMS_COLLECTION = 'purchase_order_items';

/**
 * The PO id for a given source purchase-request id. Deterministic and total:
 * the same request always maps to the same PO document.
 */
export function purchaseOrderIdForRequest(requestId) {
  const raw = String(requestId || '').trim().toLowerCase();
  if (!raw) throw new RepositoryError('A source purchase request id is required', 'VALIDATION_ERROR', 400);
  const key = raw.replace(/^pr_/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) throw new RepositoryError('Invalid source purchase request id', 'VALIDATION_ERROR', 400);
  return `po_${key}`.slice(0, 200);
}

export function formatOrderDocId(key) {
  const s = String(key || '').trim().toLowerCase();
  if (!s) throw new RepositoryError('A purchase order id is required', 'VALIDATION_ERROR', 400);
  if (s.startsWith('po_')) return s.slice(0, 200);
  return `po_${s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`.slice(0, 200);
}

export function formatOrderItemDocId(orderDocId, lineNo) {
  return `${formatOrderDocId(orderDocId)}_${String(lineNo).padStart(3, '0')}`.slice(0, 220);
}

export function orderRef(orderId) {
  return db.collection(ORDERS_COLLECTION).doc(formatOrderDocId(orderId));
}

export function orderItemRef(orderDocId, lineNo) {
  return db.collection(ORDER_ITEMS_COLLECTION).doc(formatOrderItemDocId(orderDocId, lineNo));
}

export async function getPurchaseOrderByIdFirestore(orderId, options = {}) {
  if (!orderId) return null;
  return await getDoc(ORDERS_COLLECTION, formatOrderDocId(orderId), options);
}

/** O(1) lookup of the PO belonging to a purchase request (no query needed). */
export async function getPurchaseOrderForRequestFirestore(requestId, options = {}) {
  if (!requestId) return null;
  return await getDoc(ORDERS_COLLECTION, purchaseOrderIdForRequest(requestId), options);
}

/** All line items of one PO, ordered by line number. */
export async function getPurchaseOrderItemsFirestore(orderDocId, options = {}) {
  const { transaction = null } = options;
  const q = db.collection(ORDER_ITEMS_COLLECTION)
    .where('po_id', '==', formatOrderDocId(orderDocId))
    .orderBy('line_no', 'asc');
  const snap = transaction ? await transaction.get(q) : await q.get();
  return snap.docs.map(formatDocSnapshot);
}

/**
 * Lists purchase orders newest-first with optional equality filters and a
 * business_date range, using cursor pagination (`cursor` = the last PO doc id
 * of the previous page). Mirrors the Phase B request listing exactly.
 *
 * @returns {{ items: object[], next_cursor: string|null, limit: number }}
 */
export async function listPurchaseOrdersFirestore({
  status = null,
  supplier_id = null,
  source_request_id = null,
  location_id = null,
  department = null,
  po_number = null,
  from = null,
  to = null,
  limit = DEFAULT_PAGE_SIZE,
  cursor = null
} = {}) {
  // A source-request lookup resolves to exactly one document by construction.
  if (source_request_id) {
    const hit = await getPurchaseOrderForRequestFirestore(source_request_id);
    return { items: hit ? [hit] : [], next_cursor: null, limit: 1 };
  }
  if (po_number) {
    const snap = await db.collection(ORDERS_COLLECTION)
      .where('po_number', '==', String(po_number).trim().toUpperCase()).limit(1).get();
    return { items: snap.empty ? [] : [formatDocSnapshot(snap.docs[0])], next_cursor: null, limit: 1 };
  }

  let q = db.collection(ORDERS_COLLECTION);
  // One status or several: `buildStatusFilter` collapses a single value back to
  // `==`, so every existing caller keeps the query it has always issued.
  const statusFilter = buildStatusFilter(
    (Array.isArray(status) ? status : [status]).map(s => (s ? String(s).toUpperCase() : s))
  );
  if (statusFilter) q = q.where(statusFilter.field, statusFilter.op, statusFilter.value);
  if (supplier_id) q = q.where('supplier_id', '==', String(supplier_id));
  if (location_id) q = q.where('location_id', '==', String(location_id));
  if (department) q = q.where('department', '==', String(department));
  if (from) q = q.where('business_date', '>=', String(from));
  if (to) q = q.where('business_date', '<=', String(to));

  // A range filter must be ordered by its own field first (Firestore rule).
  q = (from || to)
    ? q.orderBy('business_date', 'desc').orderBy('created_at', 'desc')
    : q.orderBy('created_at', 'desc');

  if (cursor) {
    const cursorSnap = await orderRef(cursor).get();
    if (cursorSnap.exists) q = q.startAfter(cursorSnap);
  }

  const pageSize = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const snap = await q.limit(pageSize + 1).get();
  const docs = snap.docs.map(formatDocSnapshot);
  const hasMore = docs.length > pageSize;
  const items = hasMore ? docs.slice(0, pageSize) : docs;
  return {
    items,
    next_cursor: hasMore ? items[items.length - 1].id : null,
    limit: pageSize
  };
}

/** Deletes a PO and all of its line items (DEV tooling / tests only). */
export async function deletePurchaseOrderCascadeFirestore(orderDocId) {
  const docId = formatOrderDocId(orderDocId);
  const items = await getPurchaseOrderItemsFirestore(docId);
  const batch = db.batch();
  for (const item of items) batch.delete(db.collection(ORDER_ITEMS_COLLECTION).doc(item.id));
  batch.delete(orderRef(docId));
  await batch.commit();
  return { deleted_items: items.length };
}
