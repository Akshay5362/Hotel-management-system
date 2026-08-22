import { isFirestoreRefundsEnabled, isFirestoreFinancialsEnabled } from '../config/featureFlags.js';
import { RefundCheckoutFirestoreAdapter } from '../adapters/firestore/refundCheckoutFirestoreAdapter.js';
import { db } from '../config/firebaseAdmin.js';

/**
 * RefundCutoverService
 * Coordinates primary Firestore refund checkouts with safe fail-closed error handling.
 */
export class RefundCutoverService {
  /**
   * Reconciles unknown outcome on timeout or mid-flight disconnect.
   */
  static async reconcileUnknownRefundOutcome(idempotencyKey, number) {
    if (idempotencyKey) {
      try {
        const idemSnap = await db.collection('idempotency_keys').doc(String(idempotencyKey)).get();
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED') {
          return { committed: true, result: idemSnap.data().result };
        }
      } catch (err) {
        console.warn('[RefundCutoverService] Idempotency reconciliation check failed:', err.message);
      }
    }
    return { committed: false, result: null };
  }

  /**
   * Processes a refund checkout with Firestore primary serving and safe fail-closed error handling.
   */
  static async processRefundCheckout(params, mysqlHandler) {
    const servingEnabled = isFirestoreRefundsEnabled() || isFirestoreFinancialsEnabled();
    const { number, refundAmount, reason, resolvedUserId, businessDate, idempotencyKey = null, timeoutMs = 5000 } = params;

    if (!servingEnabled && typeof mysqlHandler === 'function') {
      return await mysqlHandler();
    }

    const startTime = Date.now();
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: processRefundCheckout exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const fsPromise = RefundCheckoutFirestoreAdapter.processRefundCheckoutFirestore({
        number,
        refundAmount,
        reason,
        resolvedUserId,
        businessDate,
        idempotencyKey
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([fsPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      console.log(`[CUTOVER_SERVING:REFUNDS] Refund checkout processed in Firestore in ${durationMs}ms:`, {
        domain: 'refunds',
        source: 'FIRESTORE',
        roomNumber: number,
        refundAmount
      });

      return {
        ...fsResult,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // Business validation errors must NOT fallback to MySQL
      if (
        fsErr.status === 400 ||
        fsErr.status === 404 ||
        fsErr.code === 'ROOM_NOT_FOUND' ||
        fsErr.code === 'ROOM_NOT_OCCUPIED' ||
        fsErr.code === 'BOOKING_NOT_FOUND' ||
        fsErr.code === 'ALREADY_CHECKED_OUT'
      ) {
        throw fsErr;
      }

      console.warn(`[CUTOVER_FALLBACK:REFUNDS] Refund Firestore error (${fsErr.message}) in ${durationMs}ms. Reconciling...`);

      const reconciliation = await this.reconcileUnknownRefundOutcome(idempotencyKey, number);
      if (reconciliation.committed && reconciliation.result) {
        console.log('[CUTOVER_RECONCILED:REFUNDS] Found previously committed Firestore refund.');
        return {
          ...reconciliation.result,
          source: 'FIRESTORE_RECONCILED',
          durationMs
        };
      }

      // Step 13.2: Fail closed safely
      console.error(`[FAIL_CLOSED:REFUNDS] Refund checkout failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }
}

export default RefundCutoverService;
