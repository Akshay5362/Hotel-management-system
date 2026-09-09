/**
 * goodsReceiptsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore access for `goods_receipts` and `goods_receipt_items` (Phase F).
 *
 * A GOODS RECEIPT records one physical delivery against a purchase order. It
 * is the only document in the purchasing chain that accompanies a real stock
 * increase, and both are written in the SAME transaction (see
 * goodsReceiptService.js) — a receipt without stock, or stock without a
 * receipt, is impossible by construction.
 *
 * ── Idempotency by document id ──────────────────────────────────────────────
 * The receipt document id is derived from the caller's `idempotency_key`
 * (gr_<key>). A retried delivery therefore targets the SAME document: the
 * transaction sees it already exists and returns it untouched, so stock can
 * never be posted twice and no second receipt number is allocated.
 *
 * goods_receipts/{gr_<idempotency-key>}
 * goods_receipt_items/{gr_<idempotency-key>_<line_no>}
 *
 * Receipts and their lines are IMMUTABLE once committed. This module exposes
 * no update path; the cascade delete exists only for DEV test cleanup.
 */

import { db } from '../../config/firebaseAdmin.js';
import { getDoc, formatDocSnapshot, RepositoryError } from './firestoreUtils.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../utils/inventoryConstants.js';

export const RECEIPTS_COLLECTION = 'goods_receipts';
export const RECEIPT_ITEMS_COLLECTION = 'goods_receipt_items';

/** Deterministic receipt id for an idempotency key. */
export function receiptIdForKey(idempotencyKey) {
  const raw = String(idempotencyKey || '').trim().toLowerCase();
  if (!raw) throw new RepositoryError('An idempotency key is required for a goods receipt', 'IDEMPOTENCY_KEY_REQUIRED', 400);
  const key = raw.replace(/^gr_/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) throw new RepositoryError('Invalid idempotency key', 'IDEMPOTENCY_KEY_REQUIRED', 400);
  return `gr_${key}`.slice(0, 200);
}

export function formatReceiptDocId(key) {
  const s = String(key || '').trim().toLowerCase();
  if (!s) throw new RepositoryError('A goods receipt id is required', 'VALIDATION_ERROR', 400);
  if (s.startsWith('gr_')) return s.slice(0, 200);
  return receiptIdForKey(s);
}

export function formatReceiptItemDocId(receiptDocId, lineNo) {
  return `${formatReceiptDocId(receiptDocId)}_${String(lineNo).padStart(3, '0')}`.slice(0, 220);
}

export function receiptRef(receiptId) {
  return db.collection(RECEIPTS_COLLECTION).doc(formatReceiptDocId(receiptId));
}

export function receiptItemRef(receiptDocId, lineNo) {
  return db.collection(RECEIPT_ITEMS_COLLECTION).doc(formatReceiptItemDocId(receiptDocId, lineNo));
}

export async function getGoodsReceiptByIdFirestore(receiptId, options = {}) {
  if (!receiptId) return null;
  return await getDoc(RECEIPTS_COLLECTION, formatReceiptDocId(receiptId), options);
}

/** Line items of one receipt, ordered by line number. */
export async function getGoodsReceiptItemsFirestore(receiptDocId, options = {}) {
  const { transaction = null } = options;
  const q = db.collection(RECEIPT_ITEMS_COLLECTION)
    .where('receipt_id', '==', formatReceiptDocId(receiptDocId))
    .orderBy('line_no', 'asc');
  const snap = transaction ? await transaction.get(q) : await q.get();
  return snap.docs.map(formatDocSnapshot);
}

/**
 * Every receipt raised against one purchase order, oldest first — the
 * delivery history shown on the PO detail. Each receipt is a separate,
 * immutable record; a later delivery never overwrites an earlier one.
 */
export async function getGoodsReceiptsForOrderFirestore(poId, options = {}) {
  const { transaction = null } = options;
  const q = db.collection(RECEIPTS_COLLECTION)
    .where('po_id', '==', String(poId))
    .orderBy('created_at', 'asc');
  const snap = transaction ? await transaction.get(q) : await q.get();
  return snap.docs.map(formatDocSnapshot);
}

/**
 * Paginated receipt listing, newest first.
 * @returns {{ items: object[], next_cursor: string|null, limit: number }}
 */
export async function listGoodsReceiptsFirestore({
  po_id = null, supplier_id = null, location_id = null,
  from = null, to = null, limit = DEFAULT_PAGE_SIZE, cursor = null
} = {}) {
  let q = db.collection(RECEIPTS_COLLECTION);
  if (po_id) q = q.where('po_id', '==', String(po_id));
  if (supplier_id) q = q.where('supplier_id', '==', String(supplier_id));
  if (location_id) q = q.where('location_id', '==', String(location_id));
  if (from) q = q.where('business_date', '>=', String(from));
  if (to) q = q.where('business_date', '<=', String(to));

  q = (from || to)
    ? q.orderBy('business_date', 'desc').orderBy('created_at', 'desc')
    : q.orderBy('created_at', 'desc');

  if (cursor) {
    const cursorSnap = await receiptRef(cursor).get();
    if (cursorSnap.exists) q = q.startAfter(cursorSnap);
  }

  const pageSize = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const snap = await q.limit(pageSize + 1).get();
  const docs = snap.docs.map(formatDocSnapshot);
  const hasMore = docs.length > pageSize;
  const items = hasMore ? docs.slice(0, pageSize) : docs;
  return { items, next_cursor: hasMore ? items[items.length - 1].id : null, limit: pageSize };
}

/** Deletes a receipt and its lines — DEV tooling / tests only, never routed. */
export async function deleteGoodsReceiptCascadeFirestore(receiptDocId) {
  const docId = formatReceiptDocId(receiptDocId);
  const items = await getGoodsReceiptItemsFirestore(docId);
  const batch = db.batch();
  for (const item of items) batch.delete(db.collection(RECEIPT_ITEMS_COLLECTION).doc(item.id));
  batch.delete(receiptRef(docId));
  await batch.commit();
  return { deleted_items: items.length };
}
