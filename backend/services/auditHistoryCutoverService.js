/**
 * backend/services/auditHistoryCutoverService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3 Step 10: Audit Logs, Reports & History Cutover Service.
 *
 * Orchestrates serving Audit Logs, Guest History, Booking History, Room Status
 * History, and Folio History from Firestore PRIMARY while maintaining automatic,
 * zero-downtime fallback to MySQL with strict timeout bounds and fallback logging.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';
import { isFirestoreAuditHistoryEnabled } from '../config/featureFlags.js';
import { listDocs, getDoc, formatGuestId, formatBookingId, formatRoomId } from '../repositories/firestore/firestoreUtils.js';
import { getAllAuditLogsFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { getBookingHistoryByBookingFirestore } from '../repositories/firestore/bookingHistoryRepository.js';
import { getRoomStatusHistoryByRoomFirestore } from '../repositories/firestore/roomStatusHistoryRepository.js';
import { getAllCashLogsFirestore } from '../repositories/firestore/cashLogsRepository.js';
import { getGuestByIdFirestore, getGuestByUidFirestore, getGuestByPhoneFirestore, getAllGuestsFirestore } from '../repositories/firestore/guestsRepository.js';
import { getAllBookingsFirestore, getBookingByIdFirestore, getBookingsByGuestFirestore } from '../repositories/firestore/bookingsRepository.js';
import { getPaymentsByBookingFirestore, getAllPaymentsFirestore } from '../repositories/firestore/paymentsRepository.js';
import { getFeedbackByBookingFirestore } from '../repositories/firestore/feedbackRepository.js';
import { FirestoreRoomStatusService } from './firestoreRoomStatusService.js';
import { BusinessDateService } from './businessDateService.js';

const CUTOVER_TIMEOUT_MS = 3000;

export class AuditHistoryCutoverService {
  /**
   * Bounded timeout wrapper.
   */
  static async withTimeout(promise, timeoutMs = CUTOVER_TIMEOUT_MS, operationName = 'AuditHistoryOperation') {
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
   * Generic executor for history reads with fail-closed error handling.
   */
  static async executeRead({
    domain,
    firestoreFn,
    mysqlFallbackFn,
    timeoutMs = CUTOVER_TIMEOUT_MS
  }) {
    const isPrimary = isFirestoreAuditHistoryEnabled();

    if (!isPrimary && typeof mysqlFallbackFn === 'function') {
      return await mysqlFallbackFn();
    }

    try {
      return await this.withTimeout(firestoreFn(), timeoutMs, domain);
    } catch (fsErr) {
      // Re-throw business validation errors (do not fallback for bad request / 404 / 400)
      if (fsErr.status && fsErr.status < 500 && fsErr.code !== 'FIRESTORE_TIMEOUT') {
        throw fsErr;
      }

      console.error(`[FAIL_CLOSED:AUDIT_HISTORY] ${domain} Firestore error (${fsErr.message}). Failing closed.`);
      throw fsErr;
    }
  }

  /**
   * Fetch last Day End audit record.
   */
  static async getLastDayEnd(mysqlFallbackFn) {
    return this.executeRead({
      domain: 'getLastDayEnd',
      mysqlFallbackFn,
      firestoreFn: async () => {
        const logs = await getAllAuditLogsFirestore({
          filters: [{ field: 'action', op: '==', value: 'DAY_END' }],
          orderBy: [{ field: 'created_at', direction: 'desc' }],
          limit: 1
        });

        if (logs.length > 0) {
          const l = logs[0];
          return {
            id: l.mysql_audit_id || l.log_id || l.id,
            business_date: l.business_date,
            previous_business_date: l.previous_business_date || null,
            details: l.details || '',
            created_at: l.created_at
          };
        }

        return null;
      }
    });
  }

  /**
   * Fetch business date settings info (including lastDayEnd and stats).
   */
  static async getBusinessDateInfo(mysqlFallbackFn) {
    return this.executeRead({
      domain: 'getBusinessDateInfo',
      mysqlFallbackFn,
      firestoreFn: async () => {
        const businessDate = await BusinessDateService.getBusinessDate();

        // 1. Last day end
        let lastDayEnd = null;
        try {
          const logs = await getAllAuditLogsFirestore({
            filters: [{ field: 'action', op: '==', value: 'DAY_END' }],
            orderBy: [{ field: 'created_at', direction: 'desc' }],
            limit: 1
          });
          if (logs.length > 0) {
            lastDayEnd = logs[0].created_at;
          }
        } catch (e) {
          console.warn('[AuditHistoryCutoverService] Failed to read last Day End from Firestore:', e.message);
        }

        // 2. Room status stats
        const processedRooms = await FirestoreRoomStatusService.getRoomStatuses(businessDate);
        let occupiedRooms = 0;
        let bookedRooms = 0;
        let dirtyRooms = 0;
        let pendingCheckouts = 0;

        const bDateObj = new Date(businessDate);
        bDateObj.setHours(0, 0, 0, 0);

        for (const room of processedRooms) {
          if (room.status === 'occupied') {
            occupiedRooms++;
            if (room.expectedCheckOutDate) {
              const expDateObj = new Date(room.expectedCheckOutDate);
              expDateObj.setHours(0, 0, 0, 0);
              if (expDateObj <= bDateObj) pendingCheckouts++;
            }
          } else if (room.status === 'booked') {
            bookedRooms++;
          }
          if (room.status === 'dirty' || room.housekeeping_status === 'Dirty') {
            dirtyRooms++;
          }
        }

        const isDev = process.env.NODE_ENV === 'development';

        return {
          businessDate,
          systemDate: new Date().toISOString(),
          lastDayEnd,
          mode: isDev ? 'development' : 'production',
          stats: {
            occupiedRooms,
            bookedRooms,
            dirtyRooms,
            pendingCheckouts
          }
        };
      }
    });
  }

  /**
   * Fetch guest personal history (post-checkout overview).
   */
  static async getGuestHistory({ claimedGuestId, resolvedUserId }, mysqlFallbackFn) {
    return this.executeRead({
      domain: 'getGuestHistory',
      mysqlFallbackFn,
      firestoreFn: async () => {
        // 1. Resolve guest profile directly without full collection scan
        let guest = null;
        if (claimedGuestId !== null && claimedGuestId !== undefined) {
          guest = await getGuestByIdFirestore(claimedGuestId);
        } else if (resolvedUserId) {
          guest = await getGuestByUidFirestore(resolvedUserId);
          if (!guest) {
            guest = await getGuestByIdFirestore(resolvedUserId);
          }
        }

        if (!guest) {
          const err = new Error('Guest profile not found');
          err.status = 404;
          throw err;
        }

        const guestDocId = guest.guest_id || guest.id || formatGuestId(guest.phone || guest.id);
        const guestMysqlId = guest.mysql_guest_id || (guest.id && !isNaN(Number(guest.id)) ? Number(guest.id) : null);

        // 2. Fetch bookings targeted by guest ID
        const guestBookings = await getBookingsByGuestFirestore(guestDocId);
        if (guestMysqlId && String(guestMysqlId) !== String(guestDocId)) {
          const mysqlBookings = await getBookingsByGuestFirestore(guestMysqlId);
          mysqlBookings.forEach(b => {
            if (!guestBookings.some(x => x.id === b.id)) guestBookings.push(b);
          });
        }

        // 3. For each booking, enrich with payment sums and feedback
        const enrichedBookings = [];
        for (const b of guestBookings) {
          const bkgDocId = b.booking_id || b.id || formatBookingId(b.booking_number);
          const bkgMysqlId = b.mysql_booking_id || (b.id && !isNaN(Number(b.id)) ? Number(b.id) : null);

          // Payments
          let totalPaid = 0;
          try {
            const payments = await getPaymentsByBookingFirestore(bkgDocId);
            totalPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
          } catch (_) {}

          // Feedback
          let feedback = null;
          try {
            feedback = await getFeedbackByBookingFirestore(bkgDocId);
          } catch (_) {}

          enrichedBookings.push({
            id: bkgMysqlId || bkgDocId,
            booking_number: b.booking_number || '',
            check_in_date: b.check_in_date || '',
            check_out_date: b.check_out_date || null,
            expected_check_out_date: b.expected_check_out_date || b.check_out_date || '',
            adults: Number(b.adults || b.pax || 1),
            booking_status: b.booking_status || 'Reserved',
            payment_status: b.payment_status || 'Pending',
            total_amount: Number(b.total_amount || 0),
            advance_amount: Number(b.advance_amount || 0),
            created_at: b.created_at || new Date().toISOString(),
            room_number: b.room_number || '',
            room_type: b.room_type || b.room_type_code || '',
            room_title: b.room_title || b.room_type_title || b.room_type || '',
            feedback_id: feedback?.mysql_feedback_id || feedback?.id || null,
            overall_rating: feedback?.overall_rating || null,
            feedback_comments: feedback?.comments || null,
            feedback_date: feedback?.created_at || null,
            total_paid: totalPaid
          });
        }

        // Sort bookings created_at desc
        enrichedBookings.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

        return {
          guest: {
            id: guestMysqlId || guestDocId,
            full_name: guest.full_name || '',
            phone: guest.phone || '',
            email: guest.email || '',
            loyalty_tier: guest.loyalty_tier || 'Bronze',
            loyalty_points: Number(guest.loyalty_points || 0)
          },
          bookings: enrichedBookings,
          totalStays: enrichedBookings.length
        };
      }
    });
  }

  /**
   * Fetch admin/staff view of a specific guest's full history.
   */
  static async getGuestHistoryAdmin(guestId, mysqlFallbackFn) {
    return this.executeRead({
      domain: 'getGuestHistoryAdmin',
      mysqlFallbackFn,
      firestoreFn: async () => {
        const guest = await getGuestByIdFirestore(guestId);
        if (!guest) {
          const err = new Error('Guest not found');
          err.status = 404;
          throw err;
        }

        const guestDocId = guest.guest_id || guest.id || formatGuestId(guest.phone || guest.id);
        const guestMysqlId = guest.mysql_guest_id || (guest.id && !isNaN(Number(guest.id)) ? Number(guest.id) : null);

        // Fetch bookings targeted by guest ID
        const guestBookings = await getBookingsByGuestFirestore(guestDocId);
        if (guestMysqlId && String(guestMysqlId) !== String(guestDocId)) {
          const mysqlBookings = await getBookingsByGuestFirestore(guestMysqlId);
          mysqlBookings.forEach(b => {
            if (!guestBookings.some(x => x.id === b.id)) guestBookings.push(b);
          });
        }

        const enrichedBookings = [];
        const allPaymentsForGuest = [];

        for (const b of guestBookings) {
          const bkgDocId = b.booking_id || b.id || formatBookingId(b.booking_number);
          const bkgMysqlId = b.mysql_booking_id || (b.id && !isNaN(Number(b.id)) ? Number(b.id) : null);

          let totalPaid = 0;
          try {
            const payments = await getPaymentsByBookingFirestore(bkgDocId);
            totalPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
            payments.forEach(p => {
              allPaymentsForGuest.push({
                id: p.mysql_payment_id || p.id,
                booking_id: bkgMysqlId || p.booking_id,
                amount: Number(p.amount || 0),
                currency: p.currency || 'INR',
                payment_method: p.payment_method || 'Cash',
                payment_type: p.payment_type || 'Advance Deposit',
                payment_source: p.payment_source || 'front_desk',
                payment_status: p.payment_status || 'Paid',
                payment_gateway: p.payment_gateway || 'Internal',
                transaction_id: p.transaction_id || null,
                payment_date: p.payment_date || p.created_at,
                remarks: p.remarks || null,
                business_date: p.business_date || null,
                created_at: p.created_at || new Date().toISOString(),
                booking_number: b.booking_number || ''
              });
            });
          } catch (_) {}

          let feedback = null;
          try {
            feedback = await getFeedbackByBookingFirestore(bkgDocId);
          } catch (_) {}

          enrichedBookings.push({
            id: bkgMysqlId || bkgDocId,
            booking_number: b.booking_number || '',
            check_in_date: b.check_in_date || '',
            check_out_date: b.check_out_date || null,
            booking_status: b.booking_status || 'Reserved',
            payment_status: b.payment_status || 'Pending',
            total_amount: Number(b.total_amount || 0),
            advance_amount: Number(b.advance_amount || 0),
            room_number: b.room_number || '',
            room_type: b.room_type || b.room_type_code || '',
            overall_rating: feedback?.overall_rating || null,
            feedback_comments: feedback?.comments || null,
            total_paid: totalPaid,
            created_at: b.created_at || new Date().toISOString()
          });
        }
        enrichedBookings.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        allPaymentsForGuest.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

        return {
          guest: {
            id: guestMysqlId || guestDocId,
            full_name: guest.full_name || '',
            phone: guest.phone || '',
            email: guest.email || '',
            loyalty_tier: guest.loyalty_tier || 'Bronze',
            loyalty_points: Number(guest.loyalty_points || 0),
            created_at: guest.created_at || new Date().toISOString()
          },
          bookings: enrichedBookings,
          payments: allPaymentsForGuest
        };
      }
    });
  }

  /**
   * Fetch guest live bill/folio.
   */
  static async getGuestBill({ claimedGuestId, resolvedUserId }, mysqlFallbackFn) {
    return this.executeRead({
      domain: 'getGuestBill',
      mysqlFallbackFn,
      firestoreFn: async () => {
        let guest = null;
        if (claimedGuestId !== null && claimedGuestId !== undefined) {
          guest = await getGuestByIdFirestore(claimedGuestId);
        } else if (resolvedUserId) {
          guest = await getGuestByUidFirestore(resolvedUserId);
          if (!guest) {
            guest = await getGuestByIdFirestore(resolvedUserId);
          }
        }

        if (!guest) {
          const err = new Error('Guest profile not found');
          err.status = 404;
          throw err;
        }

        const guestDocId = guest.guest_id || guest.id || formatGuestId(guest.phone || guest.id);
        const guestMysqlId = guest.mysql_guest_id || (guest.id && !isNaN(Number(guest.id)) ? Number(guest.id) : null);

        // Targeted query: Find active bookings for this specific guest
        const guestBookings = await getBookingsByGuestFirestore(guestDocId);
        if (guestMysqlId && String(guestMysqlId) !== String(guestDocId)) {
          const mysqlBookings = await getBookingsByGuestFirestore(guestMysqlId);
          mysqlBookings.forEach(b => {
            if (!guestBookings.some(x => x.id === b.id)) guestBookings.push(b);
          });
        }

        const activeBooking = guestBookings
          .filter(b => b && ['Checked In', 'Reserved'].includes(b.booking_status))
          .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];

        if (!activeBooking) {
          return { booking: null, ledger: [] };
        }

        const bkgDocId = activeBooking.booking_id || activeBooking.id || formatBookingId(activeBooking.booking_number);
        const bkgMysqlId = activeBooking.mysql_booking_id || (activeBooking.id && !isNaN(Number(activeBooking.id)) ? Number(activeBooking.id) : null);

        // Fetch ledger items for the active booking
        const ledgerSnap = await listDocs('ledger_items', {
          filters: [{ field: 'booking_id', op: '==', value: bkgDocId }]
        });

        const ledger = ledgerSnap.map(item => ({
          id: item.mysql_ledger_id || item.id,
          booking_id: bkgMysqlId || bkgDocId,
          desc: item.desc || item.description || '',
          qty: Number(item.qty || 1),
          amount: Number(item.amount || item.debit_amount || 0),
          created_at: item.created_at || new Date().toISOString()
        }));

        return {
          booking: {
            id: bkgMysqlId || bkgDocId,
            booking_number: activeBooking.booking_number,
            room_number: activeBooking.room_number || '',
            room_type_title: activeBooking.room_title || activeBooking.room_type || '',
            base_rate: Number(activeBooking.base_rate || activeBooking.room_tariff || 0),
            booking_status: activeBooking.booking_status,
            total_amount: Number(activeBooking.total_amount || 0),
            advance_amount: Number(activeBooking.advance_amount || 0),
            check_in_date: activeBooking.check_in_date,
            check_out_date: activeBooking.check_out_date
          },
          ledger
        };
      }
    });
  }

  /**
   * Fetch booking history.
   */
  static async getBookingHistory(bookingId, mysqlFallbackFn) {
    return this.executeRead({
      domain: 'getBookingHistory',
      mysqlFallbackFn,
      firestoreFn: async () => {
        return await getBookingHistoryByBookingFirestore(bookingId);
      }
    });
  }

  /**
   * Fetch room status history.
   */
  static async getRoomStatusHistory(roomId, mysqlFallbackFn) {
    return this.executeRead({
      domain: 'getRoomStatusHistory',
      mysqlFallbackFn,
      firestoreFn: async () => {
        return await getRoomStatusHistoryByRoomFirestore(roomId);
      }
    });
  }

  /**
   * Fetch cash logs history.
   */
  static async getCashLogs(options = {}, mysqlFallbackFn) {
    return this.executeRead({
      domain: 'getCashLogs',
      mysqlFallbackFn,
      firestoreFn: async () => {
        return await getAllCashLogsFirestore(options);
      }
    });
  }
}

export default AuditHistoryCutoverService;
