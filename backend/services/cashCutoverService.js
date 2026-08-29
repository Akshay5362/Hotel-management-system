import { isFirestoreCashServingEnabled, isFirestoreFinancialsEnabled } from '../config/featureFlags.js';
import { CashFirestoreAdapter } from '../adapters/firestore/cashFirestoreAdapter.js';
import { db } from '../config/firebaseAdmin.js';

export class CashCutoverService {
  /**
   * Reconciles unknown outcome on timeout or mid-flight disconnect.
   */
  static async reconcileUnknownCashOutcome(idempotencyKey) {
    if (idempotencyKey) {
      try {
        const idemSnap = await db.collection('idempotency_keys').doc(String(idempotencyKey)).get();
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED') {
          return { committed: true, result: idemSnap.data().result };
        }
      } catch (err) {
        console.warn('[CashCutoverService] Idempotency check during reconciliation failed:', err.message);
      }
    }
    return { committed: false, result: null };
  }

  /**
   * Submits cash with primary Firestore execution and safe fail-closed error handling.
   */
  static async submitCash(params, mysqlHandler) {
    const servingEnabled = isFirestoreCashServingEnabled() || isFirestoreFinancialsEnabled();
    const { idempotencyKey = null, timeoutMs = 3000 } = params;

    if (!servingEnabled && typeof mysqlHandler === 'function') {
      return await mysqlHandler();
    }

    const startTime = Date.now();
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: submitCash exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const fsPromise = CashFirestoreAdapter.submitCashFirestore(params).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([fsPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      console.log(`[CUTOVER_SERVING:CASH] submitCash served from Firestore in ${durationMs}ms:`, {
        domain: 'cash_submit',
        source: 'FIRESTORE',
        receiptId: fsResult.submission?.receipt_id
      });

      return {
        ...fsResult,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // Business errors (invalid amount, insufficient cash in hand) must NOT fallback
      if (fsErr.status === 400 || fsErr.code === 'INSUFFICIENT_CASH_IN_HAND') {
        throw fsErr;
      }

      console.warn(`[CUTOVER_FALLBACK:CASH] submitCash Firestore error (${fsErr.message}) in ${durationMs}ms. Reconciling...`);

      const reconciliation = await this.reconcileUnknownCashOutcome(idempotencyKey);
      if (reconciliation.committed && reconciliation.result) {
        console.log('[CUTOVER_RECONCILED:CASH] Found previously committed Firestore transaction.');
        return {
          ...reconciliation.result,
          source: 'FIRESTORE_RECONCILED',
          durationMs
        };
      }

      // Step 13.2: Fail closed safely
      console.error(`[FAIL_CLOSED:CASH] submitCash failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }

  /**
   * Retrieves cash submissions with fail-closed error handling.
   */
  static async getCashSubmissions(businessDate, mysqlHandler) {
    if (!isFirestoreCashServingEnabled() && !isFirestoreFinancialsEnabled() && typeof mysqlHandler === 'function') {
      return await mysqlHandler();
    }

    try {
      const fsRes = await CashFirestoreAdapter.getCashSubmissionsFirestore(businessDate);
      return { ...fsRes, source: 'FIRESTORE' };
    } catch (err) {
      console.error('[FAIL_CLOSED:CASH] getCashSubmissions failed:', err.message);
      throw err;
    }
  }
}

export default CashCutoverService;
