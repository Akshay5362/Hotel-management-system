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
const LEDGER_COLLECTION = 'ledger_items';
const ROOM_STATUS_HISTORY_COLLECTION = 'room_status_history';
const REPORT_CACHE_TTL_MS = 60000; // 60-second caching for analytics/reports

/**
 * Invalidate all cached report/analytics aggregations immediately upon data mutation.
 * Mirrors the invalidateRoomStatusCache pattern in firestoreRoomStatusService.js.
 * All report cache keys share the 'reports_' prefix (see getOrSet calls below).
 */
export function invalidateReportsCache() {
  globalTtlCache.deleteByPrefix('reports_');
}

/**
 * Operational room statuses that temporarily remove a room from inventory available for sale.
 */
export const UNAVAILABLE_ROOM_STATUSES = Object.freeze(new Set(['maintenance', 'out_of_order', 'blocked']));


export function isUnavailableRoomStatus(status) {
  if (!status) return false;
  const normalized = String(status).trim().toLowerCase().replace(/[\s-]/g, '_');
  return UNAVAILABLE_ROOM_STATUSES.has(normalized);
}

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

/**
 * Calculates net effective payment amount, correctly deducting positive refund records
 * and ignoring failed/void/cancelled payments.
 */
export function getEffectivePaymentAmount(p) {
  if (!p) return 0;
  const rawAmt = Number(p.amount || 0);
  if (isNaN(rawAmt)) return 0;

  const status = String(p.payment_status || p.status || '').trim().toLowerCase();
  if (status === 'failed' || status === 'void' || status === 'cancelled') {
    return 0;
  }

  const type = String(p.payment_type || p.type || '').trim();
  const isRefund = type.toLowerCase().includes('refund') || status === 'refunded';

  if (rawAmt < 0) {
    return rawAmt;
  }

  if (isRefund && rawAmt > 0) {
    return -rawAmt;
  }

  return rawAmt;
}

/**
 * Computes calendar days between two dates inclusively.
 */
export function computeDaysInRange(startDate, endDate) {
  if (!startDate || !endDate) return 1;
  const s = new Date(parseToComparableDate(startDate) || startDate);
  const e = new Date(parseToComparableDate(endDate) || endDate);
  const diffTime = e.getTime() - s.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(1, diffDays);
}

/**
 * Calculates available room nights across a date range [startDate, endDate],
 * deducting nights when active rooms were in maintenance, out_of_order, or blocked based on room_status_history.
 */
export function calculateAvailableRoomNights(rooms = [], statusHistory = [], startDate = null, endDate = null) {
  if (!rooms || !Array.isArray(rooms) || rooms.length === 0) {
    return 0;
  }

  const activeRooms = rooms.filter(r => r && r.status !== 'inactive');
  if (activeRooms.length === 0) {
    return 0;
  }

  const daysInRange = computeDaysInRange(startDate, endDate);
  const baseCapacity = activeRooms.length * daysInRange;

  if (!statusHistory || !Array.isArray(statusHistory) || statusHistory.length === 0 || !startDate || !endDate) {
    return Math.max(0, baseCapacity);
  }

  const startStr = parseToComparableDate(startDate);
  const endStr = parseToComparableDate(endDate);
  if (!startStr || !endStr || endStr < startStr) {
    return Math.max(0, baseCapacity);
  }

  // Pre-index history by room identifier
  const historyByRoom = new Map();
  statusHistory.forEach(h => {
    if (!h) return;
    const rId = h.room_id ? String(h.room_id) : null;
    const rNum = h.room_number ? String(h.room_number) : null;
    if (rId) {
      if (!historyByRoom.has(rId)) historyByRoom.set(rId, []);
      historyByRoom.get(rId).push(h);
      const cleanId = rId.replace(/^room_/, '');
      if (!historyByRoom.has(cleanId)) historyByRoom.set(cleanId, historyByRoom.get(rId));
    }
    if (rNum) {
      if (!historyByRoom.has(rNum)) historyByRoom.set(rNum, []);
      historyByRoom.get(rNum).push(h);
    }
  });

  // Sort each room's history chronologically
  historyByRoom.forEach((list) => {
    list.sort((a, b) => {
      const dateA = parseToComparableDate(a.business_date) || (a.created_at ? parseToComparableDate(a.created_at) : '0000-00-00');
      const dateB = parseToComparableDate(b.business_date) || (b.created_at ? parseToComparableDate(b.created_at) : '0000-00-00');
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return timeA - timeB;
    });
  });

  let totalUnavailableNights = 0;

  activeRooms.forEach(room => {
    const rId = room.id ? String(room.id) : null;
    const rNum = room.number ? String(room.number) : null;
    const roomHist = (rId && historyByRoom.get(rId)) || (rNum && historyByRoom.get(rNum)) || [];

    if (roomHist.length === 0) return;

    const curr = new Date(startStr);
    const endObj = new Date(endStr);

    while (curr <= endObj) {
      const dKey = curr.toISOString().split('T')[0];

      // Find the last transition on or before dKey
      let effectiveStatus = null;
      for (let i = roomHist.length - 1; i >= 0; i--) {
        const hDate = parseToComparableDate(roomHist[i].business_date) || parseToComparableDate(roomHist[i].created_at);
        if (hDate && hDate <= dKey) {
          effectiveStatus = roomHist[i].new_status;
          break;
        }
      }

      if (!effectiveStatus && roomHist.length > 0) {
        // If all transitions occurred after dKey, the status was the old_status of the first transition
        effectiveStatus = roomHist[0].old_status;
      }

      if (isUnavailableRoomStatus(effectiveStatus)) {
        totalUnavailableNights++;
      }

      curr.setDate(curr.getDate() + 1);
    }
  });

  const availableNights = baseCapacity - totalUnavailableNights;
  return Math.max(0, availableNights);
}

/**
 * Calculates available room count for a single business date D.
 */
export function calculateAvailableRoomsForDate(rooms = [], statusHistory = [], dateStr) {
  return calculateAvailableRoomNights(rooms, statusHistory, dateStr, dateStr);
}

/**
 * Calculates occupied room nights for a booking clipped to the requested reporting period.
 * Booking nights are [check_in_date, check_out_date).
 */
export function calculateStayOverlapNights(booking, startDate, endDate) {
  if (!booking) return 0;
  const status = booking.booking_status;
  if (status === 'Cancelled' || status === 'No Show') {
    return 0;
  }

  const checkIn = parseToComparableDate(booking.check_in_date || booking.created_at);
  if (!checkIn) return 0;

  let checkOut = parseToComparableDate(booking.check_out_date || booking.expected_check_out_date);
  if (!checkOut || checkOut <= checkIn) {
    const d = new Date(checkIn);
    d.setDate(d.getDate() + 1);
    checkOut = d.toISOString().split('T')[0];
  }

  const startStr = startDate ? parseToComparableDate(startDate) : '0000-00-00';
  const endStr = endDate ? parseToComparableDate(endDate) : '9999-12-31';

  const endNext = new Date(endStr);
  endNext.setDate(endNext.getDate() + 1);
  const endNextStr = endNext.toISOString().split('T')[0];

  const overlapStart = checkIn > startStr ? checkIn : startStr;
  const overlapEnd = checkOut < endNextStr ? checkOut : endNextStr;

  if (overlapEnd <= overlapStart) return 0;

  const s = new Date(overlapStart);
  const e = new Date(overlapEnd);
  const nights = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0, nights);
}

/**
 * Resolves the nightly room tariff for a booking, excluding taxes/non-room charges.
 */
export function getBookingRoomTariff(booking) {
  if (!booking) return 0;
  if (booking.room_tariff !== undefined && booking.room_tariff !== null && !isNaN(Number(booking.room_tariff))) {
    return Number(booking.room_tariff);
  }
  const checkIn = parseToComparableDate(booking.check_in_date || booking.created_at);
  let checkOut = parseToComparableDate(booking.check_out_date || booking.expected_check_out_date);
  let stayNights = 1;
  if (checkIn && checkOut && checkOut > checkIn) {
    const s = new Date(checkIn);
    const e = new Date(checkOut);
    stayNights = Math.max(1, Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)));
  }
  const total = Number(booking.total_amount || 0);
  return stayNights > 0 ? (total / stayNights) : total;
}

/**
 * Determines whether a ledger entry is an eligible room revenue charge/credit.
 */
export function isRoomRevenueLedgerItem(l) {
  if (!l) return false;
  const status = String(l.status || '').toLowerCase();
  if (status === 'void' || status === 'cancelled') return false;

  const type = String(l.transaction_type || l.type || '').toUpperCase();
  if (type === 'PAYMENT' || type === 'REFUND') return false;

  const cat = String(l.category || '').toLowerCase();
  const desc = String(l.desc || l.description || '').toLowerCase();

  // Exclude explicit non-room categories
  if (cat.includes('food') || cat.includes('beverage') || cat.includes('laundry') || 
      cat.includes('extra bed') || cat.includes('service') || cat.includes('restaurant') || 
      cat.includes('settlement') || cat.includes('maintenance')) {
    return false;
  }

  // Include room tariff, room charges, and room shift adjustments
  if (cat.includes('room tariff') || cat.includes('room charge') || cat.includes('room shift')) {
    return true;
  }
  if (desc.includes('room tariff') || desc.includes('room shift') || desc.includes('room upgrade') || desc.includes('room downgrade')) {
    return true;
  }

  return false;
}

/**
 * Calculates historical room revenue for a booking within a date range using authoritative ledger records if available,
 * falling back safely to room_tariff * stay overlap nights if no ledger records exist.
 */
export function getHistoricalRoomRevenueForBooking(booking, allLedgerItems = [], startDate = null, endDate = null) {
  if (!booking) return 0;
  if (booking.booking_status === 'Cancelled' || booking.booking_status === 'No Show') {
    return 0;
  }

  const bookingDocId = booking.id || booking.booking_id;
  const bookingNum = booking.booking_number;
  const mysqlId = booking.mysql_booking_id !== undefined && booking.mysql_booking_id !== null ? String(booking.mysql_booking_id) : null;

  // Filter ledger items for this booking
  const bookingLedgerItems = allLedgerItems.filter(l => {
    if (!l) return false;
    const lBkgId = l.booking_id ? String(l.booking_id) : null;
    const lBkgNum = l.booking_number ? String(l.booking_number) : null;
    const lMysqlId = l.mysql_booking_id !== undefined && l.mysql_booking_id !== null ? String(l.mysql_booking_id) : null;

    if (bookingDocId && lBkgId && (lBkgId === String(bookingDocId) || lBkgId.replace(/^booking_/, '') === String(bookingDocId).replace(/^booking_/, ''))) {
      return true;
    }
    if (bookingNum && (lBkgNum === String(bookingNum) || lBkgId === String(bookingNum))) {
      return true;
    }
    if (mysqlId && lMysqlId && lMysqlId === mysqlId) {
      return true;
    }
    return false;
  });

  const roomChargeItems = bookingLedgerItems.filter(isRoomRevenueLedgerItem);

  if (roomChargeItems.length > 0) {
    const startStr = startDate ? parseToComparableDate(startDate) : '0000-00-00';
    const endStr = endDate ? parseToComparableDate(endDate) : '9999-12-31';

    let totalRevenue = 0;
    roomChargeItems.forEach(l => {
      const rawDate = l.business_date || l.created_at;
      const itemDate = parseToComparableDate(rawDate);
      if (itemDate && itemDate >= startStr && itemDate <= endStr) {
        const type = String(l.transaction_type || l.type || '').toUpperCase();
        if (type === 'CREDIT' || (l.credit_amount && Number(l.credit_amount) > 0 && (!l.debit_amount || Number(l.debit_amount) === 0))) {
          totalRevenue -= Number(l.credit_amount || l.amount || 0);
        } else {
          const amt = Number(l.debit_amount !== undefined && l.debit_amount !== null ? l.debit_amount : (l.amount || 0));
          totalRevenue += amt;
        }
      }
    });

    return Math.max(0, totalRevenue);
  }

  // Safe fallback for legacy/mock bookings without ledger items
  const overlap = calculateStayOverlapNights(booking, startDate, endDate);
  if (overlap <= 0) return 0;
  const tariff = getBookingRoomTariff(booking);
  return overlap * tariff;
}

export class FirestoreReportsService {

  /**
   * Computes the high-level Dashboard Overview from Firestore.
   */
  static async getDashboardOverview({ startDate, endDate, businessDate = '2026-08-19' }, options = {}) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');

    const cacheKey = `reports_overview_${startDate || 'all'}_${endDate || 'all'}_${businessDate}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      // 1. Fetch payments, bookings, ledger items, status history, and computed room statuses
      const allPayments = await listDocs(PAYMENTS_COLLECTION, options);
      const allBookings = await listDocs(BOOKINGS_COLLECTION, options);
      const allLedgerItems = await listDocs(LEDGER_COLLECTION, options);
      const allStatusHistory = await listDocs(ROOM_STATUS_HISTORY_COLLECTION, options);
      const rooms = await FirestoreRoomStatusService.getRoomStatuses(businessDate, { ...options, includeLedger: false });

      // 2. Filter payments by date range with refund deductions
      const filteredPayments = filterRecordsByDateRange(allPayments, startDate, endDate, 'business_date');
      const totalRevenue = filteredPayments.reduce((sum, p) => sum + getEffectivePaymentAmount(p), 0);

      // 3. Filter bookings by date range for total new bookings count
      const filteredBookings = filterRecordsByDateRange(allBookings, startDate, endDate, 'created_at');
      const totalBookings = filteredBookings.length;

      // 4. Calculate available room nights in requested date range deducting maintenance/OOO/blocked nights
      const totalAvailableRoomNights = calculateAvailableRoomNights(rooms, allStatusHistory, startDate, endDate);

      // 5. Calculate occupied room nights and room revenue for valid stays overlapping the period
      const validBookings = allBookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));
      let totalOccupiedRoomNights = 0;
      let totalRoomRevenue = 0;

      validBookings.forEach(b => {
        const overlap = calculateStayOverlapNights(b, startDate, endDate);
        if (overlap > 0) {
          totalOccupiedRoomNights += overlap;
          const bookingRoomRev = getHistoricalRoomRevenueForBooking(b, allLedgerItems, startDate, endDate);
          totalRoomRevenue += bookingRoomRev;
        }
      });

      // 6. Occupancy Rate % = (Occupied Room Nights / Available Room Nights) * 100
      const occupancyRate = totalAvailableRoomNights === 0 ? 0 : Math.min(100, Math.round((totalOccupiedRoomNights / totalAvailableRoomNights) * 100));

      // 7. ADR = Total Room Revenue / Total Occupied Room Nights Sold
      const adr = totalOccupiedRoomNights === 0 ? 0 : Math.round(totalRoomRevenue / totalOccupiedRoomNights);

      // 8. RevPAR = Total Room Revenue / Total Available Room Nights
      const revPAR = totalAvailableRoomNights === 0 ? 0 : Math.round(totalRoomRevenue / totalAvailableRoomNights);

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
      let totalNetRevenue = 0;

      filteredPayments.forEach(p => {
        const date = parseToComparableDate(p.business_date) || p.business_date;
        const amt = getEffectivePaymentAmount(p);

        totalNetRevenue += amt;

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
        total: totalNetRevenue,
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
      const roomTypes = await listDocs(ROOM_TYPES_COLLECTION, options);
      const allStatusHistory = await listDocs(ROOM_STATUS_HISTORY_COLLECTION, options);

      // Map room types and their physical capacities
      const roomTypeMap = new Map();
      roomTypes.forEach(rt => {
        const typeRooms = rooms.filter(r => (r.room_type_id === rt.id || r.type === rt.title) && r.status !== 'inactive');
        roomTypeMap.set(rt.id, {
          id: rt.id,
          name: rt.title || rt.name,
          totalRooms: typeRooms.length,
          typeRooms,
          occupiedNights: 0
        });
      });

      // Calculate occupied nights per room type across date range
      const validBookings = allBookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));
      validBookings.forEach(b => {
        const overlap = calculateStayOverlapNights(b, startDate, endDate);
        if (overlap > 0) {
          const room = rooms.find(r => r.id === b.room_id || r.number === b.room_number);
          if (room && roomTypeMap.has(room.room_type_id)) {
            roomTypeMap.get(room.room_type_id).occupiedNights += overlap;
          }
        }
      });

      const roomTypeStats = Array.from(roomTypeMap.values()).map(stat => {
        const availableNights = calculateAvailableRoomNights(stat.typeRooms, allStatusHistory, startDate, endDate);
        return {
          name: stat.name,
          total: stat.totalRooms,
          occupied: stat.occupiedNights,
          occupancyRate: availableNights === 0 ? 0 : Math.min(100, Math.round((stat.occupiedNights / availableNights) * 100))
        };
      });

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
   * Computes ADR (Average Daily Rate) trend over time across calendar dates in range.
   */
  static async getADRReport({ startDate, endDate }, options = {}) {
    const cacheKey = `reports_adr_${startDate || 'all'}_${endDate || 'all'}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allBookings = await listDocs(BOOKINGS_COLLECTION, options);
      const allLedgerItems = await listDocs(LEDGER_COLLECTION, options);
      const validBookings = allBookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));

      const byDate = {};
      const startStr = startDate ? parseToComparableDate(startDate) : null;
      const endStr = endDate ? parseToComparableDate(endDate) : null;

      if (startStr && endStr) {
        const curr = new Date(startStr);
        const endObj = new Date(endStr);
        while (curr <= endObj) {
          const dKey = curr.toISOString().split('T')[0];
          byDate[dKey] = { revenue: 0, rooms: 0 };
          curr.setDate(curr.getDate() + 1);
        }
      }

      validBookings.forEach(b => {
        const checkIn = parseToComparableDate(b.check_in_date || b.created_at);
        let checkOut = parseToComparableDate(b.check_out_date || b.expected_check_out_date);
        if (!checkIn) return;
        if (!checkOut || checkOut <= checkIn) {
          const d = new Date(checkIn);
          d.setDate(d.getDate() + 1);
          checkOut = d.toISOString().split('T')[0];
        }

        const stayDate = new Date(checkIn);
        const outDate = new Date(checkOut);
        while (stayDate < outDate) {
          const dKey = stayDate.toISOString().split('T')[0];
          if (!startStr || (dKey >= startStr && dKey <= endStr)) {
            if (!byDate[dKey]) byDate[dKey] = { revenue: 0, rooms: 0 };
            const dayRev = getHistoricalRoomRevenueForBooking(b, allLedgerItems, dKey, dKey);
            byDate[dKey].revenue += dayRev;
            byDate[dKey].rooms += 1;
          }
          stayDate.setDate(stayDate.getDate() + 1);
        }
      });

      const chartData = Object.keys(byDate).map(date => ({
        date,
        adr: byDate[date].rooms === 0 ? 0 : Math.round(byDate[date].revenue / byDate[date].rooms)
      })).sort((a, b) => (a.date > b.date ? 1 : -1));

      return { chartData };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes RevPAR (Revenue Per Available Room) trend over time across calendar dates in range,
   * evaluating daily available inventory accurately.
   */
  static async getRevPARReport({ startDate, endDate, businessDate = '2026-08-19' }, options = {}) {
    const cacheKey = `reports_revpar_${startDate || 'all'}_${endDate || 'all'}_${businessDate}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allBookings = await listDocs(BOOKINGS_COLLECTION, options);
      const allLedgerItems = await listDocs(LEDGER_COLLECTION, options);
      const allStatusHistory = await listDocs(ROOM_STATUS_HISTORY_COLLECTION, options);
      const rooms = await FirestoreRoomStatusService.getRoomStatuses(businessDate, options);

      const validBookings = allBookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));

      const byDate = {};
      const startStr = startDate ? parseToComparableDate(startDate) : null;
      const endStr = endDate ? parseToComparableDate(endDate) : null;

      if (startStr && endStr) {
        const curr = new Date(startStr);
        const endObj = new Date(endStr);
        while (curr <= endObj) {
          const dKey = curr.toISOString().split('T')[0];
          byDate[dKey] = { revenue: 0 };
          curr.setDate(curr.getDate() + 1);
        }
      }

      validBookings.forEach(b => {
        const checkIn = parseToComparableDate(b.check_in_date || b.created_at);
        let checkOut = parseToComparableDate(b.check_out_date || b.expected_check_out_date);
        if (!checkIn) return;
        if (!checkOut || checkOut <= checkIn) {
          const d = new Date(checkIn);
          d.setDate(d.getDate() + 1);
          checkOut = d.toISOString().split('T')[0];
        }

        const stayDate = new Date(checkIn);
        const outDate = new Date(checkOut);
        while (stayDate < outDate) {
          const dKey = stayDate.toISOString().split('T')[0];
          if (!startStr || (dKey >= startStr && dKey <= endStr)) {
            if (!byDate[dKey]) byDate[dKey] = { revenue: 0 };
            const dayRev = getHistoricalRoomRevenueForBooking(b, allLedgerItems, dKey, dKey);
            byDate[dKey].revenue += dayRev;
          }
          stayDate.setDate(stayDate.getDate() + 1);
        }
      });

      const chartData = Object.keys(byDate).map(date => {
        const dailyAvailable = calculateAvailableRoomsForDate(rooms, allStatusHistory, date);
        return {
          date,
          revPAR: dailyAvailable === 0 ? 0 : Math.round(byDate[date].revenue / dailyAvailable)
        };
      }).sort((a, b) => (a.date > b.date ? 1 : -1));

      return { chartData };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes Payments breakdown by payment method with refund deduction.
   */
  static async getPaymentsReport({ startDate, endDate }, options = {}) {
    const cacheKey = `reports_payments_${startDate || 'all'}_${endDate || 'all'}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const allPayments = await listDocs(PAYMENTS_COLLECTION, options);
      const filteredPayments = filterRecordsByDateRange(allPayments, startDate, endDate, 'business_date');

      const paymentMethods = {};
      filteredPayments.forEach(p => {
        const method = p.payment_method || p.payment_type || 'Unknown';
        const amt = getEffectivePaymentAmount(p);
        if (!paymentMethods[method]) paymentMethods[method] = 0;
        paymentMethods[method] += amt;
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

      const totalRevenue = filteredPayments.reduce((sum, p) => sum + getEffectivePaymentAmount(p), 0);
      const estimatedCosts = Math.round(totalRevenue * 0.3);
      const estimatedProfit = totalRevenue - estimatedCosts;

      return {
        totalRevenue,
        estimatedCosts,
        estimatedProfit
      };
    }, REPORT_CACHE_TTL_MS, options);
  }

  /**
   * Computes Room Type Performance report.
   */
  static async getRoomTypePerformance({ startDate, endDate, businessDate = '2026-08-19' }, options = {}) {
    const cacheKey = `reports_room_type_performance_${startDate || 'all'}_${endDate || 'all'}_${businessDate}`;
    return await globalTtlCache.getOrSet(cacheKey, async () => {
      const rooms = await FirestoreRoomStatusService.getRoomStatuses(businessDate, options);
      const allBookings = await listDocs(BOOKINGS_COLLECTION, options);
      const roomTypes = await listDocs(ROOM_TYPES_COLLECTION, options);
      const allStatusHistory = await listDocs(ROOM_STATUS_HISTORY_COLLECTION, options);

      const roomTypeMap = new Map();
      roomTypes.forEach(rt => {
        const typeRooms = rooms.filter(r => (r.room_type_id === rt.id || r.type === rt.title) && r.status !== 'inactive');
        roomTypeMap.set(rt.id, {
          id: rt.id,
          name: rt.title || rt.name,
          totalRooms: typeRooms.length,
          typeRooms,
          occupiedNights: 0
        });
      });

      const validBookings = allBookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));
      validBookings.forEach(b => {
        const overlap = calculateStayOverlapNights(b, startDate, endDate);
        if (overlap > 0) {
          const room = rooms.find(r => r.id === b.room_id || r.number === b.room_number);
          if (room && roomTypeMap.has(room.room_type_id)) {
            roomTypeMap.get(room.room_type_id).occupiedNights += overlap;
          }
        }
      });

      const roomTypeStats = Array.from(roomTypeMap.values()).map(stat => {
        const availableNights = calculateAvailableRoomNights(stat.typeRooms, allStatusHistory, startDate, endDate);
        return {
          name: stat.name,
          total: stat.totalRooms,
          occupied: stat.occupiedNights,
          occupancyRate: availableNights === 0 ? 0 : Math.min(100, Math.round((stat.occupiedNights / availableNights) * 100))
        };
      });

      return { roomTypeStats };
    }, REPORT_CACHE_TTL_MS, options);
  }
}
