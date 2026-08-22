import { isFirestorePaymentsServingEnabled, isFirestoreFinancialsEnabled } from '../config/featureFlags.js';
import { PaymentFirestoreAdapter } from '../adapters/firestore/paymentFirestoreAdapter.js';
import { db } from '../config/firebaseAdmin.js';

export class PaymentCutoverService {
  /**
   * Reconciles unknown outcome on timeout or mid-flight disconnect.
   */
  static async reconcileUnknownPaymentOutcome(idempotencyKey, bookingId) {
    if (idempotencyKey) {
      try {
        const idemSnap = await db.collection('idempotency_keys').doc(String(idempotencyKey)).get();
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED') {
          return { committed: true, result: idemSnap.data().result };
        }
      } catch (err) {
        console.warn('[PaymentCutoverService] Idempotency check during reconciliation failed:', err.message);
      }
    }
    return { committed: false, result: null };
  }

  /**
   * Finalizes payment with primary Firestore execution and safe fail-closed error handling.
   */
  static async finalizePayment(params, mysqlHandler) {
    const servingEnabled = isFirestorePaymentsServingEnabled() || isFirestoreFinancialsEnabled();
    const { bookingId, idempotencyKey = null, timeoutMs = 3000 } = params;

    if (!servingEnabled && typeof mysqlHandler === 'function') {
      return await mysqlHandler();
    }

    const startTime = Date.now();
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: finalizePayment exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const fsPromise = PaymentFirestoreAdapter.processFinalizePaymentFirestore(params).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([fsPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      console.log(`[CUTOVER_SERVING:PAYMENTS] finalizePayment served from Firestore in ${durationMs}ms:`, {
        domain: 'payments_finalize',
        source: 'FIRESTORE',
        bookingId
      });

      return {
        ...fsResult,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // Business errors must NOT fallback
      if (fsErr.status === 400 || fsErr.status === 404 || fsErr.code === 'BOOKING_PAYMENT_NOT_FOUND') {
        throw fsErr;
      }

      console.warn(`[CUTOVER_FALLBACK:PAYMENTS] finalizePayment Firestore error (${fsErr.message}) in ${durationMs}ms. Reconciling...`);

      const reconciliation = await this.reconcileUnknownPaymentOutcome(idempotencyKey, bookingId);
      if (reconciliation.committed && reconciliation.result) {
        console.log('[CUTOVER_RECONCILED:PAYMENTS] Found previously committed Firestore transaction.');
        return {
          ...reconciliation.result,
          source: 'FIRESTORE_RECONCILED',
          durationMs
        };
      }

      // Step 13.2: Fail closed safely
      console.error(`[FAIL_CLOSED:PAYMENTS] finalizePayment failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }

  /**
   * Confirms Cash payment with primary Firestore execution and safe fail-closed error handling.
   */
  static async confirmCashPayment(params, mysqlHandler) {
    const servingEnabled = isFirestorePaymentsServingEnabled() || isFirestoreFinancialsEnabled();
    const { bookingId, idempotencyKey = null, timeoutMs = 3000 } = params;

    if (!servingEnabled && typeof mysqlHandler === 'function') {
      return await mysqlHandler();
    }

    const startTime = Date.now();
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: confirmCashPayment exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const fsPromise = PaymentFirestoreAdapter.processConfirmCashPaymentFirestore(params).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([fsPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      console.log(`[CUTOVER_SERVING:PAYMENTS] confirmCashPayment served from Firestore in ${durationMs}ms:`, {
        domain: 'payments_confirm_cash',
        source: 'FIRESTORE',
        bookingId
      });

      return {
        ...fsResult,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // Business errors must NOT fallback
      if (fsErr.status === 400 || fsErr.status === 404 || fsErr.code === 'BOOKING_PAYMENT_NOT_FOUND') {
        throw fsErr;
      }

      console.warn(`[CUTOVER_FALLBACK:PAYMENTS] confirmCashPayment Firestore error (${fsErr.message}) in ${durationMs}ms. Reconciling...`);

      const reconciliation = await this.reconcileUnknownPaymentOutcome(idempotencyKey, bookingId);
      if (reconciliation.committed && reconciliation.result) {
        console.log('[CUTOVER_RECONCILED:PAYMENTS] Found previously committed Firestore transaction.');
        return {
          ...reconciliation.result,
          source: 'FIRESTORE_RECONCILED',
          durationMs
        };
      }

      // Step 13.2: Fail closed safely
      console.error(`[FAIL_CLOSED:PAYMENTS] confirmCashPayment failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }

  /**
   * Retrieves payments by booking with fail-closed error handling.
   */
  static async getPaymentsByBooking(bookingId, user, mysqlHandler) {
    if (!isFirestorePaymentsServingEnabled() && !isFirestoreFinancialsEnabled() && typeof mysqlHandler === 'function') {
      return await mysqlHandler();
    }

    try {
      const fsRes = await PaymentFirestoreAdapter.getPaymentsByBookingFirestore(bookingId, user);
      return { ...fsRes, source: 'FIRESTORE' };
    } catch (err) {
      console.error('[FAIL_CLOSED:PAYMENTS] getPaymentsByBooking failed:', err.message);
      throw err;
    }
  }

  /**
   * Retrieves current guest's payments with fail-closed error handling.
   */
  static async getMyPayments(userId, mysqlHandler) {
    if (!isFirestorePaymentsServingEnabled() && !isFirestoreFinancialsEnabled() && typeof mysqlHandler === 'function') {
      return await mysqlHandler();
    }

    try {
      const fsRes = await PaymentFirestoreAdapter.getMyPaymentsFirestore(userId);
      return { ...fsRes, source: 'FIRESTORE' };
    } catch (err) {
      console.error('[FAIL_CLOSED:PAYMENTS] getMyPayments failed:', err.message);
      throw err;
    }
  }

  /**
   * Retrieves guest payment status with fail-closed error handling.
   */
  static async getGuestPaymentStatus(userId, mysqlHandler) {
    if (!isFirestorePaymentsServingEnabled() && !isFirestoreFinancialsEnabled() && typeof mysqlHandler === 'function') {
      return await mysqlHandler();
    }

    try {
      const fsRes = await PaymentFirestoreAdapter.getGuestPaymentStatusFirestore(userId);
      return { ...fsRes, source: 'FIRESTORE' };
    } catch (err) {
      console.error('[FAIL_CLOSED:PAYMENTS] getGuestPaymentStatus failed:', err.message);
      throw err;
    }
  }
}

export default PaymentCutoverService;
