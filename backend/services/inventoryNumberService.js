/**
 * inventoryNumberService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Transactional, collision-safe document numbers for the Inventory module.
 *
 * Mirrors the proven pattern in services/foodOrderNumberService.js: a
 * per-business-date counter document incremented inside a Firestore
 * transaction, so two concurrent callers can never receive the same sequence.
 * Numbers are NEVER derived from a client clock.
 *
 * Counter documents live in `inventory_counters`, one per (prefix, date):
 *   inventory_counters/PR_2026-09-08  →  { prefix, date, seq, updated_at }
 *
 * Format: <PREFIX>-YYYYMMDD-NNNNNN     e.g. PR-20260908-000001
 *
 * The business date comes from BusinessDateService (the same source the rest
 * of the system uses for day-end), not from `new Date()` — a request created
 * after midnight but before day-end belongs to the open business day.
 */

import { db } from '../config/firebaseAdmin.js';
import BusinessDateService from './businessDateService.js';

export const COUNTERS_COLLECTION = 'inventory_counters';

/** Resolves the current business date (YYYY-MM-DD), falling back to today. */
export async function resolveBusinessDate(explicit = null) {
  if (explicit && /^\d{4}-\d{2}-\d{2}$/.test(String(explicit))) return String(explicit);
  try {
    const bd = await BusinessDateService.getBusinessDate();
    if (bd && /^\d{4}-\d{2}-\d{2}$/.test(String(bd))) return String(bd);
  } catch { /* fall through to the calendar date */ }
  return new Date().toISOString().split('T')[0];
}

export function counterDocId(prefix, businessDate) {
  return `${String(prefix).toUpperCase()}_${businessDate}`;
}

export function formatDocumentNumber(prefix, businessDate, sequenceNumber) {
  return `${String(prefix).toUpperCase()}-${String(businessDate).replace(/-/g, '')}-${String(sequenceNumber).padStart(6, '0')}`;
}

/**
 * Reserves the next sequence number INSIDE an existing Firestore transaction.
 *
 * Call this from the caller's own transaction so the number and the document
 * that uses it commit together — a rolled-back submission never burns a
 * number, and a retried submission never takes a second one.
 *
 * Firestore requires all reads before all writes: this performs its read
 * first, then registers its write, so call it before any other write in the
 * transaction.
 *
 * @returns {Promise<{ number: string, sequence: number, businessDate: string }>}
 */
export async function reserveNumberInTransaction(txn, prefix, businessDate) {
  if (!txn) throw new Error('reserveNumberInTransaction requires a Firestore transaction');
  const docId = counterDocId(prefix, businessDate);
  const ref = db.collection(COUNTERS_COLLECTION).doc(docId);

  const snap = await txn.get(ref);
  const sequence = snap.exists ? Number(snap.data().seq || 0) + 1 : 1;

  txn.set(ref, {
    prefix: String(prefix).toUpperCase(),
    date: businessDate,
    seq: sequence,
    updated_at: new Date().toISOString()
  }, { merge: true });

  return { number: formatDocumentNumber(prefix, businessDate, sequence), sequence, businessDate };
}

/**
 * Standalone variant (own transaction) for callers that do not already have
 * one. Phase B's submit path uses reserveNumberInTransaction instead so the
 * number and the status change are atomic.
 */
export async function generateDocumentNumber(prefix, businessDate = null) {
  const date = await resolveBusinessDate(businessDate);
  return await db.runTransaction(async (txn) => reserveNumberInTransaction(txn, prefix, date));
}

export default { reserveNumberInTransaction, generateDocumentNumber, resolveBusinessDate, formatDocumentNumber, counterDocId };
