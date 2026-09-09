/**
 * inventoryStockMovementsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore access for `inventory_stock_movements` (Phase A).
 *
 * This collection is the APPEND-ONLY LEDGER of every stock change. Documents
 * are only ever written inside inventoryStockService.applyMovement /
 * transfer transactions; there is no update or delete API on purpose.
 *
 * Document id: mov_<idempotency-key-slug>   (deterministic → idempotent)
 * Fields:
 *   movement_id, product_id, sku, product_name, movement_type, quantity (signed
 *   for ADJUSTMENT, absolute otherwise), unit, qty_before, qty_after,
 *   location_id, location_name, counterpart_location_id (transfers),
 *   reference_type, reference_id, reason, remarks, business_date,
 *   actor_uid, actor_name, idempotency_key, created_at
 */

import { db } from '../../config/firebaseAdmin.js';
import { getDoc, formatDocSnapshot, RepositoryError } from './firestoreUtils.js';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../../utils/inventoryConstants.js';

export const MOVEMENTS_COLLECTION = 'inventory_stock_movements';

export function formatMovementDocId(key) {
  const s = String(key || '').trim().toLowerCase();
  if (!s) throw new RepositoryError('Movement key is required', 'VALIDATION_ERROR', 400);
  if (s.startsWith('mov_')) return s;
  return `mov_${s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`.slice(0, 200);
}

export function movementRef(movementId) {
  return db.collection(MOVEMENTS_COLLECTION).doc(formatMovementDocId(movementId));
}

export async function getInventoryMovementByIdFirestore(movementId, options = {}) {
  if (!movementId) return null;
  return await getDoc(MOVEMENTS_COLLECTION, formatMovementDocId(movementId), options);
}

/**
 * Lists movements newest-first with optional equality filters and a created_at
 * range, using cursor pagination (`cursor` = last movement id of the previous
 * page). Every combination of equality filters + created_at ordering is backed
 * by a composite index in firestore.indexes.json.
 *
 * @returns {{ items: object[], next_cursor: string|null, limit: number }}
 */
export async function listInventoryMovementsFirestore({
  product_id = null,
  location_id = null,
  movement_type = null,
  from = null,        // ISO date or datetime (inclusive)
  to = null,          // ISO date or datetime (inclusive; a bare date covers the whole day)
  limit = DEFAULT_PAGE_SIZE,
  cursor = null
} = {}) {
  let q = db.collection(MOVEMENTS_COLLECTION);
  if (product_id) q = q.where('product_id', '==', String(product_id));
  if (location_id) q = q.where('location_id', '==', String(location_id));
  if (movement_type) q = q.where('movement_type', '==', String(movement_type).toUpperCase());
  if (from) q = q.where('created_at', '>=', normalizeFrom(from));
  if (to) q = q.where('created_at', '<=', normalizeTo(to));
  q = q.orderBy('created_at', 'desc');

  if (cursor) {
    const cursorSnap = await movementRef(cursor).get();
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

function normalizeFrom(v) {
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s;
}
function normalizeTo(v) {
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999Z` : s;
}
