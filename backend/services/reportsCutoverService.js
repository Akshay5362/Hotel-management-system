/**
 * backend/services/reportsCutoverService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cutover Service for Reports & Analytics domain (Phase 2 Step 9).
 *
 * Orchestrates serving from Firestore PRIMARY with fail-closed error handling
 * and strict response schema validation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isFirestoreReportsServingEnabled, isFirestoreAuditHistoryEnabled } from '../config/featureFlags.js';
import { FirestoreReportsService } from './firestoreReportsService.js';

const CUTOVER_TIMEOUT_MS = 3000;

export class ReportsCutoverService {
  /**
   * Bounded timeout wrapper.
   */
  static async withTimeout(promise, timeoutMs = CUTOVER_TIMEOUT_MS, operationName = 'ReportsOperation') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`FIRESTORE_TIMEOUT: ${operationName} exceeded ${timeoutMs}ms limit`);
        err.code = 'FIRESTORE_TIMEOUT';
        err.name = 'TimeoutError';
        reject(err);
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Generic executor for report cutover with validation & fail-closed error handling.
   */
  static async executeReport({
    domain,
    params,
    firestoreFn,
    mysqlFallbackFn,
    validateFn
  }) {
    const isPrimary = isFirestoreAuditHistoryEnabled() || isFirestoreReportsServingEnabled();

    if (!isPrimary && typeof mysqlFallbackFn === 'function') {
      return await mysqlFallbackFn();
    }

    const startTime = Date.now();
    const timeout = params?.timeoutMs !== undefined ? params.timeoutMs : CUTOVER_TIMEOUT_MS;

    try {
      const result = await this.withTimeout(
        firestoreFn(),
        timeout,
        domain
      );

      // Schema validation check
      if (validateFn && !validateFn(result)) {
        throw new Error(`MALFORMED_FIRESTORE_RESPONSE: Schema validation failed for ${domain}`);
      }

      const durationMs = Date.now() - startTime;
      return {
        ...result,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;
      console.error(`[FAIL_CLOSED:REPORTS] ${domain} Firestore error (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }

  // 1. Dashboard Overview
  static async getDashboardOverview(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'dashboard_overview',
      params,
      firestoreFn: () => FirestoreReportsService.getDashboardOverview(params),
      mysqlFallbackFn,
      validateFn: res => res && typeof res.totalRevenue === 'number' && typeof res.occupancyRate === 'number'
    });
  }

  // 2. Revenue Report
  static async getRevenueReport(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'revenue',
      params,
      firestoreFn: () => FirestoreReportsService.getRevenueReport(params),
      mysqlFallbackFn,
      validateFn: res => res && typeof res.total === 'number' && Array.isArray(res.chartData)
    });
  }

  // 3. Occupancy Report
  static async getOccupancyReport(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'occupancy',
      params,
      firestoreFn: () => FirestoreReportsService.getOccupancyReport(params),
      mysqlFallbackFn,
      validateFn: res => res && Array.isArray(res.roomTypeStats) && res.bookingStatus
    });
  }

  // 4. Guest Analytics
  static async getGuestAnalytics(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'guests',
      params,
      firestoreFn: () => FirestoreReportsService.getGuestAnalytics(params),
      mysqlFallbackFn,
      validateFn: res => res && typeof res.totalGuests === 'number' && Array.isArray(res.loyaltyStats)
    });
  }

  // 5. Booking Analytics
  static async getBookingAnalytics(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'bookings',
      params,
      firestoreFn: () => FirestoreReportsService.getBookingAnalytics(params),
      mysqlFallbackFn,
      validateFn: res => res && typeof res.totalBookings === 'number' && Array.isArray(res.chartData)
    });
  }

  // 6. Cancellation Report
  static async getCancellationReport(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'cancellations',
      params,
      firestoreFn: () => FirestoreReportsService.getCancellationReport(params),
      mysqlFallbackFn,
      validateFn: res => res && typeof res.totalCancelled === 'number' && typeof res.lostRevenue === 'number'
    });
  }

  // 7. Profit Report
  static async getProfitReport(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'profit',
      params,
      firestoreFn: () => FirestoreReportsService.getProfitReport(params),
      mysqlFallbackFn,
      validateFn: res => res && typeof res.totalRevenue === 'number' && typeof res.estimatedCosts === 'number'
    });
  }

  // 8. ADR Report
  static async getADRReport(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'adr',
      params,
      firestoreFn: () => FirestoreReportsService.getADRReport(params),
      mysqlFallbackFn,
      validateFn: res => res && Array.isArray(res.chartData)
    });
  }

  // 9. RevPAR Report
  static async getRevPARReport(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'revpar',
      params,
      firestoreFn: () => FirestoreReportsService.getRevPARReport(params),
      mysqlFallbackFn,
      validateFn: res => res && Array.isArray(res.chartData)
    });
  }

  // 10. Room Type Performance
  static async getRoomTypePerformance(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'room_types',
      params,
      firestoreFn: () => FirestoreReportsService.getRoomTypePerformance(params),
      mysqlFallbackFn,
      validateFn: res => res && Array.isArray(res.roomTypeStats)
    });
  }

  // 11. Payments Report
  static async getPaymentsReport(params, mysqlFallbackFn) {
    return this.executeReport({
      domain: 'payments',
      params,
      firestoreFn: () => FirestoreReportsService.getPaymentsReport(params),
      mysqlFallbackFn,
      validateFn: res => res && Array.isArray(res.breakdown) && Array.isArray(res.payments)
    });
  }
}

export default ReportsCutoverService;
