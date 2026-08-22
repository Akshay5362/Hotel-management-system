/**
 * backend/services/masterBillCutoverService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HPMS Master Bill Cutover Service
 *
 * Directs Master Bill requests to Firestore primary authority when
 * USE_FIRESTORE_INVOICES=true / USE_FIRESTORE_FINANCIALS=true, with safe fail-closed error handling.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isFirestoreInvoicesEnabled, isFirestoreFinancialsEnabled } from '../config/featureFlags.js';
import { MasterBillService } from './masterBillService.js';

export class MasterBillCutoverService {
  /**
   * Generates or fetches the Master Bill for a booking.
   *
   * @param {string|number} bookingId - Booking identifier
   * @param {Function} [mysqlFallbackFn] - Legacy fallback generator
   * @param {Object} [options] - Extra options
   * @returns {Promise<Object>} Master Bill object
   */
  static async getMasterBill(bookingId, mysqlFallbackFn, options = {}) {
    const useFirestore = isFirestoreInvoicesEnabled() || isFirestoreFinancialsEnabled();

    if (!useFirestore && typeof mysqlFallbackFn === 'function') {
      return await mysqlFallbackFn();
    }

    try {
      return await MasterBillService.getMasterBill(bookingId, options);
    } catch (err) {
      if (err.status === 404 || err.status === 400) {
        throw err; // Fail closed for business validation errors
      }

      console.error('[FAIL_CLOSED:MASTER_BILL] Firestore MasterBill failed:', err.message);
      throw err;
    }
  }
}

export default MasterBillCutoverService;
