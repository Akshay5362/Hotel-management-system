import { isFirestoreLedgerWritesEnabled, isFirestoreFinancialsEnabled } from '../config/featureFlags.js';
import { LedgerFirestoreAdapter } from '../adapters/firestore/ledgerFirestoreAdapter.js';
import { db } from '../config/firebaseAdmin.js';
import { invalidateRoomStatusCache } from './firestoreRoomStatusService.js';

/**
 * LedgerWriteCutoverService
 * Coordinates primary Firestore folio ledger writes with safe fail-closed error handling.
 */
export class LedgerWriteCutoverService {
  /**
   * Reconciles unknown outcome on timeout or mid-flight disconnect.
   */
  static async reconcileUnknownLedgerOutcome(idempotencyKey, roomNumber, desc, amount) {
    if (idempotencyKey) {
      try {
        const idemSnap = await db.collection('idempotency_keys').doc(String(idempotencyKey)).get();
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED') {
          return { committed: true, result: idemSnap.data().result };
        }
      } catch (err) {
        console.warn('[LedgerWriteCutoverService] Idempotency reconciliation check failed:', err.message);
      }
    }
    return { committed: false, result: null };
  }

  /**
   * Adds a ledger item with Firestore primary serving and safe fail-closed error handling.
   */
  static async addLedgerItem(params, mysqlHandler) {
    const servingEnabled = isFirestoreLedgerWritesEnabled() || isFirestoreFinancialsEnabled();
    const { roomNumber, desc, amount, transactionType = 'CHARGE', businessDate, idempotencyKey = null, resolvedUserId, timeoutMs = 5000 } = params;

    if (!servingEnabled && typeof mysqlHandler === 'function') {
      return await mysqlHandler();
    }

    const startTime = Date.now();
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: addLedgerItem exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const fsPromise = LedgerFirestoreAdapter.addLedgerItemFirestore({
        roomNumber,
        desc,
        amount,
        transactionType,
        businessDate,
        idempotencyKey,
        resolvedUserId
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([fsPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      console.log(`[CUTOVER_SERVING:LEDGER_WRITES] Ledger item posted in Firestore in ${durationMs}ms:`, {
        domain: 'ledger_writes',
        source: 'FIRESTORE',
        roomNumber,
        amount,
        desc
      });

      // Invalidate room status cache so attached ledger items update immediately
      invalidateRoomStatusCache();

      return {
        ...fsResult,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // Business errors must NOT fallback to MySQL
      if (
        fsErr.status === 400 ||
        fsErr.status === 404 ||
        fsErr.code === 'ROOM_NOT_FOUND' ||
        fsErr.code === 'ROOM_NOT_OCCUPIED' ||
        fsErr.code === 'BOOKING_NOT_FOUND'
      ) {
        throw fsErr;
      }

      console.warn(`[CUTOVER_FALLBACK:LEDGER_WRITES] Ledger Firestore error (${fsErr.message}) in ${durationMs}ms. Reconciling...`);

      const reconciliation = await this.reconcileUnknownLedgerOutcome(idempotencyKey, roomNumber, desc, amount);
      if (reconciliation.committed && reconciliation.result) {
        console.log('[CUTOVER_RECONCILED:LEDGER_WRITES] Found previously committed Firestore ledger item.');
        invalidateRoomStatusCache();
        return {
          ...reconciliation.result,
          source: 'FIRESTORE_RECONCILED',
          durationMs
        };
      }

      // Step 13.2: Fail closed safely
      console.error(`[FAIL_CLOSED:LEDGER_WRITES] addLedgerItem failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }

  /**
   * Records a partial or full payment with Firestore primary serving and fail-closed safety.
   */
  static async recordPayment(params) {
    const { roomNumber, amount, paymentMethod = 'Cash', reference = '', remarks = '', businessDate, idempotencyKey = null, resolvedUserId, timeoutMs = 5000 } = params;

    const startTime = Date.now();
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: recordPayment exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const fsPromise = LedgerFirestoreAdapter.recordPaymentFirestore({
        roomNumber,
        amount,
        paymentMethod,
        reference,
        remarks,
        businessDate,
        idempotencyKey,
        resolvedUserId
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([fsPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      console.log(`[CUTOVER_SERVING:LEDGER_PAYMENTS] Payment recorded in Firestore in ${durationMs}ms:`, {
        domain: 'ledger_payments',
        source: 'FIRESTORE',
        roomNumber,
        amount,
        paymentMethod
      });

      // Invalidate room status cache
      invalidateRoomStatusCache();

      return {
        ...fsResult,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // Business validation errors fail closed immediately
      if (
        fsErr.status === 400 ||
        fsErr.status === 404 ||
        fsErr.code === 'ROOM_NOT_FOUND' ||
        fsErr.code === 'ROOM_NOT_OCCUPIED' ||
        fsErr.code === 'BOOKING_NOT_FOUND' ||
        fsErr.code === 'PAYMENT_EXCEEDS_BALANCE' ||
        fsErr.code === 'INVALID_PAYMENT_AMOUNT'
      ) {
        throw fsErr;
      }

      console.error(`[FAIL_CLOSED:LEDGER_PAYMENTS] recordPayment failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }
  /**
   * Applies a manual room rent adjustment with Firestore primary serving and fail-closed safety.
   */
  static async adjustRoomRent(params) {
    const { roomNumber, amount, adjustmentType = 'INCREASE', reason = '', businessDate, idempotencyKey = null, resolvedUserId, timeoutMs = 5000 } = params;

    const startTime = Date.now();
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: adjustRoomRent exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const fsPromise = LedgerFirestoreAdapter.adjustRoomRentFirestore({
        roomNumber,
        amount,
        adjustmentType,
        reason,
        businessDate,
        idempotencyKey,
        resolvedUserId
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([fsPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      console.log(`[CUTOVER_SERVING:LEDGER_RENT_ADJUST] Room rent adjustment applied in Firestore in ${durationMs}ms:`, {
        domain: 'ledger_rent_adjust',
        source: 'FIRESTORE',
        roomNumber,
        amount,
        adjustmentType
      });

      // Invalidate room status cache
      invalidateRoomStatusCache();

      return {
        ...fsResult,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // Business validation errors fail closed immediately
      if (
        fsErr.status === 400 ||
        fsErr.status === 404 ||
        fsErr.code === 'ROOM_NOT_FOUND' ||
        fsErr.code === 'ROOM_NOT_OCCUPIED' ||
        fsErr.code === 'BOOKING_NOT_FOUND' ||
        fsErr.code === 'INVALID_ADJUSTMENT_AMOUNT' ||
        fsErr.code === 'ADJUSTMENT_REASON_REQUIRED' ||
        fsErr.code === 'INVALID_ADJUSTMENT_TYPE'
      ) {
        throw fsErr;
      }

      console.error(`[FAIL_CLOSED:LEDGER_RENT_ADJUST] adjustRoomRent failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }
}

export default LedgerWriteCutoverService;
