/**
 * backend/services/foodOrderNumberService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Concurrency-Safe Daily Sequential Order Number Generator for Food POS.
 *
 * Guarantees zero duplicate human-readable order numbers under concurrent load.
 * Format: FO-YYYYMMDD-000001, FO-YYYYMMDD-000002, ...
 *
 * Uses Firestore transaction atomic increment on `food_order_counters/{businessDate}`.
 * The technical food_order document ID (`forder_{ts}_{4hex}`) remains independently unique.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';

const COUNTERS_COLLECTION = 'food_order_counters';

/**
 * Atomically generates the next sequential order number for a given business date.
 *
 * @param {string} businessDate - Date string in 'YYYY-MM-DD' format.
 * @returns {Promise<{ orderNumber: string, sequenceNumber: number }>}
 */
export async function generateFoodOrderNumber(businessDate) {
  if (!db) {
    throw new Error('Firebase Admin DB is not initialized.');
  }

  const dateStr = String(businessDate || '').trim() || new Date().toISOString().split('T')[0];
  const counterRef = db.collection(COUNTERS_COLLECTION).doc(dateStr);

  let sequenceNumber = 1;

  await db.runTransaction(async (txn) => {
    const counterSnap = await txn.get(counterRef);

    if (counterSnap.exists) {
      const currentSeq = Number(counterSnap.data().seq || 0);
      sequenceNumber = currentSeq + 1;
    } else {
      sequenceNumber = 1;
    }

    txn.set(counterRef, {
      seq: sequenceNumber,
      date: dateStr,
      updated_at: new Date().toISOString()
    }, { merge: true });
  });

  const paddedSeq = String(sequenceNumber).padStart(6, '0');
  const cleanDate = dateStr.replace(/-/g, '');
  const orderNumber = `FO-${cleanDate}-${paddedSeq}`;

  return { orderNumber, sequenceNumber };
}
