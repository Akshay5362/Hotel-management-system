/**
 * purchaseRequestsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore access for `purchase_requests` and `purchase_request_items`
 * (Phase B).
 *
 * A purchase request is a REQUEST TO BUY — never a purchase order, a receipt,
 * a stock addition or a payment. Nothing in this file reads or writes a stock
 * balance or the movement ledger.
 *
 * purchase_requests/{pr_<key>}
 *   request_id, request_number (null until submitted), status,
 *   requested_by_uid, requested_by_name, requested_by_role,
 *   department, location_id, location_name_snapshot, priority,
 *   reason, remarks, total_estimated_value, item_count,
 *   business_date, created_at, updated_at, submitted_at, cancelled_at,
 *   cancelled_by_uid, cancel_reason, idempotency_key, status_history[]
 *
 * purchase_request_items/{pri_<request_doc_id>_<line_no>}
 *   request_item_id, request_id, line_no, product_id, sku,
 *   product_name_snapshot, category_id, category_name_snapshot, unit,
 *   current_stock_snapshot, minimum_stock_snapshot, requested_quantity,
 *   estimated_unit_cost, estimated_total, remarks, created_at
 *
 * Line ids are deterministic (line_no based), so re-saving a draft's lines
 * overwrites in place rather than accumulating duplicates.
 */

import { db } from '../../config/firebaseAdmin.js';
import { getDoc, formatDocSnapshot, RepositoryError } from './firestoreUtils.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../utils/inventoryConstants.js';

export const REQUESTS_COLLECTION = 'purchase_requests';
export const REQUEST_ITEMS_COLLECTION = 'purchase_request_items';

export function formatRequestDocId(key) {
  const s = String(key || '').trim().toLowerCase();
  if (!s) throw new RepositoryError('Purchase request key is required', 'VALIDATION_ERROR', 400);
  if (s.startsWith('pr_')) return s.slice(0, 200);
  return `pr_${s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`.slice(0, 200);
}

export function formatRequestItemDocId(requestDocId, lineNo) {
  return `pri_${String(requestDocId).replace(/^pr_/, '')}_${String(lineNo).padStart(3, '0')}`.slice(0, 220);
}

export function requestRef(requestId) {
  return db.collection(REQUESTS_COLLECTION).doc(formatRequestDocId(requestId));
}

export async function getPurchaseRequestByIdFirestore(requestId, options = {}) {
  if (!requestId) return null;
  return await getDoc(REQUESTS_COLLECTION, formatRequestDocId(requestId), options);
}

/** Looks a request up by its human-facing number (PR-YYYYMMDD-NNNNNN). */
export async function getPurchaseRequestByNumberFirestore(requestNumber) {
  if (!requestNumber) return null;
  const snap = await db.collection(REQUESTS_COLLECTION)
    .where('request_number', '==', String(requestNumber).trim().toUpperCase())
    .limit(1).get();
  return snap.empty ? null : formatDocSnapshot(snap.docs[0]);
}

/** All line items of one request, ordered by line number. */
export async function getPurchaseRequestItemsFirestore(requestDocId, options = {}) {
  const { transaction = null } = options;
  const q = db.collection(REQUEST_ITEMS_COLLECTION)
    .where('request_id', '==', String(requestDocId))
    .orderBy('line_no', 'asc');
  const snap = transaction ? await transaction.get(q) : await q.get();
  return snap.docs.map(formatDocSnapshot);
}

/**
 * Lists requests newest-first with optional equality filters and a
 * business_date range, using cursor pagination (`cursor` = the last request
 * doc id of the previous page).
 *
 * @returns {{ items: object[], next_cursor: string|null, limit: number }}
 */
export async function listPurchaseRequestsFirestore({
  status = null,
  requested_by_uid = null,
  department = null,
  location_id = null,
  request_number = null,
  from = null,          // business_date lower bound (YYYY-MM-DD, inclusive)
  to = null,            // business_date upper bound (YYYY-MM-DD, inclusive)
  limit = DEFAULT_PAGE_SIZE,
  cursor = null
} = {}) {
  // An exact request-number lookup short-circuits the whole listing.
  if (request_number) {
    const hit = await getPurchaseRequestByNumberFirestore(request_number);
    return { items: hit ? [hit] : [], next_cursor: null, limit: 1 };
  }

  let q = db.collection(REQUESTS_COLLECTION);
  if (status) q = q.where('status', '==', String(status).toUpperCase());
  if (requested_by_uid) q = q.where('requested_by_uid', '==', String(requested_by_uid));
  if (department) q = q.where('department', '==', String(department));
  if (location_id) q = q.where('location_id', '==', String(location_id));
  if (from) q = q.where('business_date', '>=', String(from));
  if (to) q = q.where('business_date', '<=', String(to));

  // A range filter must be ordered by its own field first (Firestore rule).
  q = (from || to)
    ? q.orderBy('business_date', 'desc').orderBy('created_at', 'desc')
    : q.orderBy('created_at', 'desc');

  if (cursor) {
    const cursorSnap = await requestRef(cursor).get();
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

/**
 * Replaces a draft's line items: deletes whatever is stored and writes the
 * supplied lines, in one batch. Deterministic ids mean a re-save of the same
 * lines is an overwrite, never a duplicate.
 */
export async function replacePurchaseRequestItemsFirestore(requestDocId, lines) {
  const existing = await getPurchaseRequestItemsFirestore(requestDocId);
  const batch = db.batch();
  for (const old of existing) {
    batch.delete(db.collection(REQUEST_ITEMS_COLLECTION).doc(old.id));
  }
  const written = [];
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const docId = formatRequestItemDocId(requestDocId, lineNo);
    const payload = { ...line, request_item_id: docId, request_id: String(requestDocId), line_no: lineNo };
    batch.set(db.collection(REQUEST_ITEMS_COLLECTION).doc(docId), payload);
    written.push({ id: docId, ...payload });
  });
  await batch.commit();
  return written;
}

/** Deletes a request and all of its line items (used by DEV tooling/tests only). */
export async function deletePurchaseRequestCascadeFirestore(requestDocId) {
  const items = await getPurchaseRequestItemsFirestore(requestDocId);
  const batch = db.batch();
  for (const item of items) batch.delete(db.collection(REQUEST_ITEMS_COLLECTION).doc(item.id));
  batch.delete(requestRef(requestDocId));
  await batch.commit();
  return { deleted_items: items.length };
}
