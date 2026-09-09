/**
 * goodsReceiptReversalsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore access for `goods_receipt_reversals` (Phase G).
 *
 * A REVERSAL is an immutable correction record proving WHO reversed WHICH
 * receipt, WHY, WHEN, and WHICH compensating stock movements cancelled it.
 * The original goods receipt is never edited or deleted — it keeps its
 * quantities and stays visible in the delivery history, annotated as reversed.
 *
 * ── Idempotency by document id ──────────────────────────────────────────────
 * The reversal id is derived from the caller's idempotency key (grv_<key>), so
 * a retried request targets the SAME document: the transaction sees it exists
 * and returns it without posting a second compensating movement.
 *
 * goods_receipt_reversals/{grv_<idempotency-key>}
 */

import { db } from '../../config/firebaseAdmin.js';
import { getDoc, formatDocSnapshot, RepositoryError } from './firestoreUtils.js';

export const REVERSALS_COLLECTION = 'goods_receipt_reversals';

/** Deterministic reversal id for an idempotency key. */
export function reversalIdForKey(idempotencyKey) {
  const raw = String(idempotencyKey || '').trim().toLowerCase();
  if (!raw) throw new RepositoryError('An idempotency key is required to reverse a goods receipt', 'IDEMPOTENCY_KEY_REQUIRED', 400);
  const key = raw.replace(/^grv_/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) throw new RepositoryError('Invalid idempotency key', 'IDEMPOTENCY_KEY_REQUIRED', 400);
  return `grv_${key}`.slice(0, 200);
}

export function formatReversalDocId(key) {
  const s = String(key || '').trim().toLowerCase();
  if (!s) throw new RepositoryError('A reversal id is required', 'VALIDATION_ERROR', 400);
  if (s.startsWith('grv_')) return s.slice(0, 200);
  return reversalIdForKey(s);
}

export function reversalRef(reversalId) {
  return db.collection(REVERSALS_COLLECTION).doc(formatReversalDocId(reversalId));
}

export async function getGoodsReceiptReversalByIdFirestore(reversalId, options = {}) {
  if (!reversalId) return null;
  return await getDoc(REVERSALS_COLLECTION, formatReversalDocId(reversalId), options);
}

/** The reversal of one receipt, if it has been reversed. */
export async function getReversalForReceiptFirestore(receiptId, options = {}) {
  const { transaction = null } = options;
  const q = db.collection(REVERSALS_COLLECTION).where('receipt_id', '==', String(receiptId)).limit(1);
  const snap = transaction ? await transaction.get(q) : await q.get();
  return snap.empty ? null : formatDocSnapshot(snap.docs[0]);
}

/** Every reversal recorded against one purchase order. */
export async function getReversalsForOrderFirestore(poId, options = {}) {
  const { transaction = null } = options;
  const q = db.collection(REVERSALS_COLLECTION).where('purchase_order_id', '==', String(poId));
  const snap = transaction ? await transaction.get(q) : await q.get();
  return snap.docs.map(formatDocSnapshot);
}

/** DEV tooling / tests only — reversals are never deleted in the product. */
export async function deleteGoodsReceiptReversalFirestore(reversalId) {
  await reversalRef(reversalId).delete();
  return { deleted: true };
}
