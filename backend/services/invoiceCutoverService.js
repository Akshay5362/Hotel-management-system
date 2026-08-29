import { isFirestoreInvoicesEnabled, isFirestoreFinancialsEnabled } from '../config/featureFlags.js';
import { InvoiceFirestoreAdapter } from '../adapters/firestore/invoiceFirestoreAdapter.js';
import { db } from '../config/firebaseAdmin.js';

/**
 * InvoiceCutoverService
 * Coordinates primary Firestore invoice operations with safe fail-closed error handling.
 */
export class InvoiceCutoverService {
  /**
   * Reconciles unknown outcome on timeout or mid-flight disconnect.
   */
  static async reconcileUnknownInvoiceOutcome(idempotencyKey, bookingId) {
    if (idempotencyKey) {
      try {
        const idemSnap = await db.collection('idempotency_keys').doc(String(idempotencyKey)).get();
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED') {
          return { committed: true, result: idemSnap.data().result };
        }
      } catch (err) {
        console.warn('[InvoiceCutoverService] Idempotency reconciliation check failed:', err.message);
      }
    }
    return { committed: false, result: null };
  }

  /**
   * Generates or retrieves an invoice number with Firestore primary serving and safe fail-closed error handling.
   */
  static async getOrGenerateInvoiceNumber({ bookingId, businessDate, idempotencyKey = null, timeoutMs = 8000 }, mysqlHandler) {
    const servingEnabled = isFirestoreInvoicesEnabled() || isFirestoreFinancialsEnabled();

    if (!servingEnabled && typeof mysqlHandler === 'function') {
      return await mysqlHandler();
    }

    const startTime = Date.now();
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: Invoice generation exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const fsPromise = InvoiceFirestoreAdapter.getOrGenerateInvoiceFirestore({
        bookingId,
        businessDate,
        idempotencyKey
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([fsPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      console.log(`[CUTOVER_SERVING:INVOICES] Invoice served from Firestore in ${durationMs}ms:`, {
        domain: 'invoices',
        source: 'FIRESTORE',
        bookingId,
        invoiceNumber: fsResult.invoiceNumber
      });

      return {
        ...fsResult,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // Business errors must NOT fallback to MySQL
      if (fsErr.status === 400 || fsErr.status === 404 || fsErr.code === 'BOOKING_NOT_FOUND' || fsErr.code === 'INVALID_BOOKING_ID') {
        throw fsErr;
      }

      console.warn(`[CUTOVER_FALLBACK:INVOICES] Invoice Firestore error (${fsErr.message}) in ${durationMs}ms. Reconciling...`);

      const reconciliation = await this.reconcileUnknownInvoiceOutcome(idempotencyKey, bookingId);
      if (reconciliation.committed && reconciliation.result) {
        console.log('[CUTOVER_RECONCILED:INVOICES] Found previously committed Firestore invoice.');
        return {
          ...reconciliation.result,
          source: 'FIRESTORE_RECONCILED',
          durationMs
        };
      }

      // Step 13.2: Fail closed safely
      console.error(`[FAIL_CLOSED:INVOICES] Invoice generation failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }
}

export default InvoiceCutoverService;
