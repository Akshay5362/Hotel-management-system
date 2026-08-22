/**
 * backend/services/firestoreReportsService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Native Firestore Reports & Analytics Aggregation Service for HPMS.
 *
 * Provides 100% mathematical and structural parity with backend/controllers/reportsController.js
 * without executing multi-table SQL queries or joins:
 *   - Dashboard Overview (Revenue, Occupancy Rate, Total Bookings, ADR, RevPAR)
 *   - Revenue Report (Revenue by date, Revenue by payment type)
 *   - Occupancy Report (Room Type Stats, Booking Status Counts)
 *   - ADR Report (Average Daily Rate trend)
 *   - RevPAR Report (Revenue Per Available Room trend)
 *   - Payments & Cash Breakdown
 *   - Cancellation & Lost Revenue Analysis
 *   - Guest Analytics (Loyalty, Gender)
 *
 * NOTE: During Phase 1, MySQL remains the live production authority.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';
import { listDocs } from '../repositories/firestore/firestoreUtils.js';
import { parseToComparableDate } from './firestoreAvailabilityService.js';
import { FirestoreRoomStatusService } from './firestoreRoomStatusService.js';
import { globalTtlCache } from '../utils/ttlCache.js';

const PAYMENTS_COLLECTION = 'payments';
const BOOKINGS_COLLECTION = 'bookings';
const ROOMS_COLLECTION = 'rooms';
const GUESTS_COLLECTION = 'guests';
const ROOM_TYPES_COLLECTION = 'room_types';
const REPORT_CACHE_TTL_MS = 60000; // 60-second caching for analytics/reports

/**
 * Filter records by date range on a specified date field.
 * Handles ISO timestamps, YYYY-MM-DD, and DD-Mon-YYYY strings.
 */
export function filterRecordsByDateRange(records, startDate, endDate, dateField = 'business_date') {
  if (!records || !Array.isArray(records)) return [];

  const startStr = startDate ? parseToComparableDate(startDate) : '0000-00-00';
  const endStr = endDate ? parseToComparableDate(endDate) : '9999-12-31';

  return records.filter(record => {
    if (!record) return false;
    const rawVal = record[dateField];
    if (!rawVal) return false;

    let compDate = null;
    if (rawVal instanceof Date) {
      compDate = rawVal.toISOString().split('T')[0];
    } else {
      compDate = parseToComparableDate(rawVal);
    }

    if (!compDate) return false;
    return compDate >= startStr && compDate <= endStr;
  });
}

export class FirestoreReportsService {

  /**
   * Computes the high-level Dashboard Overview from Firestore.
   */
  static async getDashboardOverview({ startDate, endDate, businessDate = '2026-08-19' }, options = {}) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');

    const cacheKey = `reports_overview_${startDate || 'all'}_${endDate || 'all'}_${businessDate}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      // 1. Fetch payments, bookings, and computed room statuses (skip ledger items for overview)
      const allPayments = await listDocs(PAYMENTS_COLLECTION, options);
      const allBookings = await listDocs(BOOKINGS_COLLECTION, options);
      const rooms = await FirestoreRoomStatusService.getRoomStatuses(businessDate, { ...options, includeLedger: false });

      // 2. Filter payments by date range
      const filteredPayments = filterRecordsByDateRange(allPayments, startDate, endDate, 'business_date');
      const totalRevenue = filteredPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

      // 3. Filter bookings by date range
      const filteredBookings = filterRecordsByDateRange(allBookings, startDate, endDate, 'created_at');
      const totalBookings = filteredBookings.length;

      // 4. Occupancy Rate: Math.round((occupiedRooms / totalRooms) * 100)
      const totalRooms = rooms.length;
      const occupiedRooms = rooms.filter(r => r.status === 'occupied').length;
      const occupancyRate = totalRooms === 0 ? 0 : Math.round((occupiedRooms / totalRooms) * 100);

      // 5. ADR: Total Room Revenue / Total Rooms Booked (Reserved, Checked In, Checked Out)
      const roomRevenue = filteredBookings.reduce((sum, b) => sum + Number(b.total_amount || 0), 0);
      const validBookings = filteredBookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));
      const totalRoomsBooked = validBookings.length;
      const adr = totalRoomsBooked === 0 ? 0 : Math.round(roomRevenue / totalRoomsBooked);

      // 6. RevPAR: Total Room Revenue / Total Available Rooms
      const revPAR = totalRooms === 0 ? 0 : Math.round(roomRevenue / totalRooms);

      return {
        totalRevenue,
        occupancyRate,
        totalBookings,
        adr,
        revPAR
      };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes the Revenue Report with chronological chart data and payment method breakdown.
   */
  static async getRevenueReport({ startDate, endDate }, options = {}) {
    const cacheKey = `reports_revenue_${startDate || 'all'}_${endDate || 'all'}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allPayments = await listDocs(PAYMENTS_COLLECTION, options);
      const filteredPayments = filterRecordsByDateRange(allPayments, startDate, endDate, 'business_date');

      const revenueByDate = {};
      const revenueByType = {};

      filteredPayments.forEach(p => {
        const date = parseToComparableDate(p.business_date) || p.business_date;
        const amt = Number(p.amount || 0);

        if (!revenueByDate[date]) revenueByDate[date] = 0;
        revenueByDate[date] += amt;

        const type = p.payment_type || p.payment_method || 'Other';
        if (!revenueByType[type]) revenueByType[type] = 0;
        revenueByType[type] += amt;
      });

      const chartData = Object.keys(revenueByDate).map(date => ({
        date,
        revenue: revenueByDate[date]
      })).sort((a, b) => (parseToComparableDate(a.date) > parseToComparableDate(b.date) ? 1 : -1));

      return {
        total: filteredPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0),
        chartData,
        breakdown: revenueByType
      };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes Occupancy Performance by Room Type and Booking Status counts.
   */
  static async getOccupancyReport({ startDate, endDate, businessDate = '2026-08-19' }, options = {}) {
    const cacheKey = `reports_occupancy_${startDate || 'all'}_${endDate || 'all'}_${businessDate}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const rooms = await FirestoreRoomStatusService.getRoomStatuses(businessDate, options);
      const allBookings = await listDocs(BOOKINGS_COLLECTION, options);

      // Group rooms by room type
      const roomTypeMap = new Map();
      rooms.forEach(r => {
        const typeKey = r.type || 'STANDARD';
        if (!roomTypeMap.has(typeKey)) {
          roomTypeMap.set(typeKey, { total: 0, occupied: 0 });
        }
        const entry = roomTypeMap.get(typeKey);
        entry.total++;
        if (r.status === 'occupied') entry.occupied++;
      });

      const roomTypeStats = Array.from(roomTypeMap.entries()).map(([name, stat]) => ({
        name,
        total: stat.total,
        occupied: stat.occupied,
        occupancyRate: stat.total === 0 ? 0 : Math.round((stat.occupied / stat.total) * 100)
      }));

      const statusCounts = {
        'Reserved': 0,
        'Checked In': 0,
        'Checked Out': 0,
        'Cancelled': 0
      };

      const filteredBookings = filterRecordsByDateRange(allBookings, startDate, endDate, 'created_at');
      filteredBookings.forEach(b => {
        const st = b.booking_status || 'Reserved';
        if (statusCounts[st] !== undefined) {
          statusCounts[st]++;
        }
      });

      return {
        roomTypeStats,
        bookingStatus: statusCounts
      };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes ADR (Average Daily Rate) trend over time.
   */
  static async getADRReport({ startDate, endDate }, options = {}) {
    const cacheKey = `reports_adr_${startDate || 'all'}_${endDate || 'all'}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allBookings = await listDocs(BOOKINGS_COLLECTION, options);
      const filteredBookings = filterRecordsByDateRange(allBookings, startDate, endDate, 'created_at');

      const byDate = {};
      filteredBookings.forEach(b => {
        if (!['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status)) return;
        const date = b.created_at ? b.created_at.split('T')[0] : '2026-08-19';
        if (!byDate[date]) byDate[date] = { revenue: 0, rooms: 0 };
        byDate[date].revenue += Number(b.total_amount || 0);
        byDate[date].rooms += 1;
      });

      const chartData = Object.keys(byDate).map(date => ({
        date,
        adr: byDate[date].rooms === 0 ? 0 : Math.round(byDate[date].revenue / byDate[date].rooms)
      })).sort((a, b) => (a.date > b.date ? 1 : -1));

      return { chartData };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes RevPAR (Revenue Per Available Room) trend over time.
   */
  static async getRevPARReport({ startDate, endDate, businessDate = '2026-08-19' }, options = {}) {
    const cacheKey = `reports_revpar_${startDate || 'all'}_${endDate || 'all'}_${businessDate}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allBookings = await listDocs(BOOKINGS_COLLECTION, options);
      const rooms = await FirestoreRoomStatusService.getRoomStatuses(businessDate, options);
      const totalRooms = rooms.length;

      const filteredBookings = filterRecordsByDateRange(allBookings, startDate, endDate, 'created_at');

      const byDate = {};
      filteredBookings.forEach(b => {
        const date = b.created_at ? b.created_at.split('T')[0] : '2026-08-19';
        if (!byDate[date]) byDate[date] = { revenue: 0 };
        byDate[date].revenue += Number(b.total_amount || 0);
      });

      const chartData = Object.keys(byDate).map(date => ({
        date,
        revPAR: totalRooms === 0 ? 0 : Math.round(byDate[date].revenue / totalRooms)
      })).sort((a, b) => (a.date > b.date ? 1 : -1));

      return { chartData };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes Payments breakdown by payment method.
   */
  static async getPaymentsReport({ startDate, endDate }, options = {}) {
    const cacheKey = `reports_payments_${startDate || 'all'}_${endDate || 'all'}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allPayments = await listDocs(PAYMENTS_COLLECTION, options);
      const filteredPayments = filterRecordsByDateRange(allPayments, startDate, endDate, 'business_date');

      const paymentMethods = {};
      filteredPayments.forEach(p => {
        const method = p.payment_method || p.payment_type || 'Unknown';
        if (!paymentMethods[method]) paymentMethods[method] = 0;
        paymentMethods[method] += Number(p.amount || 0);
      });

      const breakdown = Object.keys(paymentMethods).map(name => ({
        name,
        value: paymentMethods[name]
      }));

      return {
        breakdown,
        payments: filteredPayments
      };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes Cancellation and Lost Revenue report.
   */
  static async getCancellationReport({ startDate, endDate }, options = {}) {
    const cacheKey = `reports_cancellation_${startDate || 'all'}_${endDate || 'all'}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allBookings = await listDocs(BOOKINGS_COLLECTION, options);
      const filteredBookings = filterRecordsByDateRange(allBookings, startDate, endDate, 'created_at');

      const cancelled = filteredBookings.filter(b => b.booking_status === 'Cancelled');
      const totalCancelled = cancelled.length;
      const lostRevenue = cancelled.reduce((sum, b) => sum + Number(b.total_amount || 0), 0);

      return {
        totalCancelled,
        lostRevenue,
        cancellations: cancelled
      };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes Guest Analytics (Loyalty Tier and Gender distribution).
   */
  static async getGuestAnalytics({ startDate, endDate }, options = {}) {
    const cacheKey = `reports_guest_analytics_${startDate || 'all'}_${endDate || 'all'}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allGuests = await listDocs(GUESTS_COLLECTION, options);
      const filteredGuests = filterRecordsByDateRange(allGuests, startDate, endDate, 'created_at');

      const loyaltyStats = {};
      const genderStats = {};

      filteredGuests.forEach(g => {
        const tier = g.loyalty_tier || 'None';
        if (!loyaltyStats[tier]) loyaltyStats[tier] = 0;
        loyaltyStats[tier]++;

        const gender = g.gender || 'Unknown';
        if (!genderStats[gender]) genderStats[gender] = 0;
        genderStats[gender]++;
      });

      return {
        totalGuests: filteredGuests.length,
        loyaltyStats: Object.keys(loyaltyStats).map(name => ({ name, value: loyaltyStats[name] })),
        genderStats: Object.keys(genderStats).map(name => ({ name, value: genderStats[name] }))
      };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes Booking Analytics over time.
   */
  static async getBookingAnalytics({ startDate, endDate }, options = {}) {
    const cacheKey = `reports_booking_analytics_${startDate || 'all'}_${endDate || 'all'}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allBookings = await listDocs(BOOKINGS_COLLECTION, options);
      const filteredBookings = filterRecordsByDateRange(allBookings, startDate, endDate, 'created_at');

      const bookingByDate = {};
      filteredBookings.forEach(b => {
        let d = '2026-08-19';
        if (b.created_at) {
          if (b.created_at instanceof Date) {
            d = b.created_at.toISOString().split('T')[0];
          } else if (typeof b.created_at === 'string') {
            d = b.created_at.split('T')[0];
          }
        }
        if (!bookingByDate[d]) bookingByDate[d] = 0;
        bookingByDate[d]++;
      });

      const chartData = Object.keys(bookingByDate).map(date => ({
        date,
        bookings: bookingByDate[date]
      })).sort((a, b) => (a.date > b.date ? 1 : -1));

      return {
        totalBookings: filteredBookings.length,
        chartData
      };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes Profit Report with estimated operating expenses.
   */
  static async getProfitReport({ startDate, endDate }, options = {}) {
    const cacheKey = `reports_profit_${startDate || 'all'}_${endDate || 'all'}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allPayments = await listDocs(PAYMENTS_COLLECTION, options);
      const filteredPayments = filterRecordsByDateRange(allPayments, startDate, endDate, 'business_date');

      const totalRevenue = filteredPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const estimatedCosts = totalRevenue * 0.3;
      const estimatedProfit = totalRevenue - estimatedCosts;

      return {
        totalRevenue,
        estimatedCosts,
        estimatedProfit
      };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes Room Type Performance summary.
   */
  static async getRoomTypePerformance({ startDate, endDate, businessDate = '2026-08-19' }, options = {}) {
    const cacheKey = `reports_room_type_perf_${startDate || 'all'}_${endDate || 'all'}_${businessDate}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const rooms = await FirestoreRoomStatusService.getRoomStatuses(businessDate, options);

      const roomTypeMap = new Map();
      rooms.forEach(r => {
        const typeKey = r.type || 'STANDARD';
        if (!roomTypeMap.has(typeKey)) {
          roomTypeMap.set(typeKey, { total: 0, occupied: 0 });
        }
        const entry = roomTypeMap.get(typeKey);
        entry.total++;
        if (r.status === 'occupied') entry.occupied++;
      });

      const roomTypeStats = Array.from(roomTypeMap.entries()).map(([name, stat]) => ({
        name,
        total: stat.total,
        occupied: stat.occupied,
        occupancyRate: stat.total === 0 ? 0 : Math.round((stat.occupied / stat.total) * 100)
      }));

      return { roomTypeStats };
    }, REPORT_CACHE_TTL_MS, options);
  }
}

export function invalidateReportsCache() {
  globalTtlCache.clear();
}

export default FirestoreReportsService;

