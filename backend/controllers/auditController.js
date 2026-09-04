import pool from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RoomStatusService } from '../services/roomStatusService.js';
import { BusinessDateService, BD_ERRORS } from '../services/businessDateService.js';
import { FirestoreAvailabilityService } from '../services/firestoreAvailabilityService.js';
import { isFirestoreRoomStatusShadowEnabled, isFirestoreRoomStatusServingEnabled, isFirebaseOnlyBusinessDateEnabled, isMysqlCutoverFallbacksDisabled } from '../config/featureFlags.js';
import { getSystemDateDetailsFirestore } from '../repositories/firestore/systemSettingsRepository.js';
import { getAllCashLogsFirestore } from '../repositories/firestore/cashLogsRepository.js';
import { getAllReservationsFirestore } from '../repositories/firestore/reservationsRepository.js';
import { getAllBookingsFirestore } from '../repositories/firestore/bookingsRepository.js';
import { FirestoreShadowComparisonService } from '../services/firestoreShadowComparisonService.js';
import { FirestoreRoomStatusService } from '../services/firestoreRoomStatusService.js';
import { SafeCutoverFallbackService } from '../services/safeCutoverFallbackService.js';
import { GuestAdminService } from '../services/guestAdminService.js';
import { GuestRequestsService, invalidateGuestRequestsCache } from '../services/guestRequestsService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GUEST_DOCS_DIR = path.resolve(__dirname, '..', 'guest-documents');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Convert a stored date like "14-Jul-2026" → JS Date (midnight UTC) */
function parsePmsDate(dateStr) {
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const parts = (dateStr || '').split('-'); // ['14','Jul','2026']
  if (parts.length !== 3) return null;
  return new Date(Date.UTC(parseInt(parts[2]), months[parts[1]], parseInt(parts[0])));
}

/** Format a JS Date → "16-Jul-2026" style */
function formatPmsDate(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = months[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mon}-${yyyy}`;
}

/** Convert any date format ("25-Jul-2026", "2026-07-25", ISO string) → "YYYY-MM-DD" */
function parseToComparableDate(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const parts = str.split('-');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const mon = months[parts[1].toLowerCase()];
    const yr = parts[2];
    if (mon && yr) {
      return `${yr}-${mon}-${day}`;
    }
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }
  return str;
}

/** Add one calendar day to a date */
function addDay(d) {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * Auto-advance the PMS business date to today if it has fallen behind.
 * For each missed day, posts Rollover Tariff + Tax charges for occupied rooms
 * and resets today_checkins / today_checkouts counters — mirroring runDayEnd.
 */


import { readBudgetMonitor } from '../utils/firestoreReadBudget.js';

let lastKnownGoodStatusSnapshot = null;
let quotaExhaustedUntil = 0;
const NEGATIVE_QUOTA_CACHE_TTL_MS = 15000; // 15 seconds negative cache for quota exhaustion

// Test/Diagnostic inspection helpers
export const _getQuotaExhaustedUntil = () => quotaExhaustedUntil;
export const _setQuotaExhaustedUntil = (ts) => { quotaExhaustedUntil = ts; };
export const _getLastKnownGoodStatusSnapshot = () => lastKnownGoodStatusSnapshot;
export const _setLastKnownGoodStatusSnapshot = (snap) => { lastKnownGoodStatusSnapshot = snap; };

export const getStatus = async (req, res) => {
  // ── Short-Lived Negative Cache for Firestore Quota Exhaustion ──────────────
  // If Firestore quota was recently exhausted within the 15s window, avoid repeating live gRPC calls
  if (Date.now() < quotaExhaustedUntil) {
    if (lastKnownGoodStatusSnapshot && Array.isArray(lastKnownGoodStatusSnapshot.rooms) && lastKnownGoodStatusSnapshot.rooms.length > 0) {
      return res.json({
        ...lastKnownGoodStatusSnapshot,
        data_status: 'stale',
        stale_reason: 'FIRESTORE_RESOURCE_EXHAUSTED',
        stale_since: new Date(lastKnownGoodStatusSnapshot.timestamp).toISOString(),
        error_message: 'Firestore temporarily quota-degraded (cached 15s window)'
      });
    }
    return res.status(503).json({
      error: 'Firestore database is temporarily unavailable due to daily project quota limit (Google Cloud Free Tier).',
      code: 'FIRESTORE_RESOURCE_EXHAUSTED',
      firestore_degraded: true,
      backend_online: true,
      retry_after_seconds: Math.max(1, Math.ceil((quotaExhaustedUntil - Date.now()) / 1000))
    });
  }

  // ── Application Read Budget Safety Guardrail (35K reads) ───────────────────
  if (readBudgetMonitor.isProtectionThresholdReached()) {
    if (lastKnownGoodStatusSnapshot && Array.isArray(lastKnownGoodStatusSnapshot.rooms) && lastKnownGoodStatusSnapshot.rooms.length > 0) {
      return res.json({
        ...lastKnownGoodStatusSnapshot,
        data_status: 'stale',
        stale_reason: 'READ_BUDGET_PROTECTION',
        stale_since: new Date(lastKnownGoodStatusSnapshot.timestamp).toISOString(),
        error_message: 'Application safety budget reached (35K reads). Serving cached status to protect remaining daily quota.'
      });
    }
    return res.status(503).json({
      error: 'Application Firestore daily read budget safety threshold reached (35,000 reads). Non-essential status polling paused.',
      code: 'READ_BUDGET_PROTECTION',
      firestore_degraded: true,
      backend_online: true,
      budget_diagnostics: readBudgetMonitor.getDiagnostics()
    });
  }

  try {
    const systemDate = await BusinessDateService.getBusinessDate();

    // ── Independent reads below — none depends on any other's result, only
    //    on systemDate above — run concurrently instead of serially. Each
    //    preserves its exact original branch logic and error handling.

    const fetchCounters = async () => {
      let todayCheckins = 0;
      let todayCheckouts = 0;
      let continuedRooms = 0;

      if (isFirebaseOnlyBusinessDateEnabled() || isMysqlCutoverFallbacksDisabled()) {
        try {
          const details = await getSystemDateDetailsFirestore();
          if (details) {
            todayCheckins = details.today_checkins || 0;
            todayCheckouts = details.today_checkouts || 0;
            continuedRooms = details.continued_rooms || 0;
          }
        } catch (e) {
          console.warn('[getStatus] Failed to read daily counters from Firestore, falling back to 0:', e.message);
        }
      } else {
        const [counterRows] = await pool.query(
          "SELECT key_name, value_val FROM system_settings WHERE key_name IN ('today_checkins','today_checkouts','continued_rooms')"
        );
        const counterMap = {};
        counterRows.forEach(r => { counterMap[r.key_name] = r.value_val; });
        todayCheckins  = parseInt(counterMap['today_checkins']  || '0', 10);
        todayCheckouts = parseInt(counterMap['today_checkouts'] || '0', 10);
        continuedRooms = parseInt(counterMap['continued_rooms'] || '0', 10);
      }

      return { todayCheckins, todayCheckouts, continuedRooms };
    };

    // Helper function to fetch authoritative MySQL room status data
    const fetchMysqlProcessedRooms = async () => {
      const computedRooms = await RoomStatusService.getRoomStatuses(pool, systemDate);
      const activeBookingIds = computedRooms
        .map(r => r.booking_id)
        .filter(Boolean);

      let ledgerByBookingId = {};
      if (activeBookingIds.length > 0) {
        const placeholders = activeBookingIds.map(() => '?').join(',');
        const [ledgerItems] = await pool.query(
          `SELECT * FROM ledger_items WHERE booking_id IN (${placeholders})`,
          activeBookingIds
        );
        ledgerItems.forEach(item => {
          const bookingId = item.booking_id;
          if (!ledgerByBookingId[bookingId]) {
            ledgerByBookingId[bookingId] = [];
          }
          ledgerByBookingId[bookingId].push({
            id: item.id,
            desc: item.desc,
            qty: item.qty,
            amount: item.amount
          });
        });
      }

      return computedRooms.map(r => ({
        id: r.id,
        number: r.number,
        type: r.type,
        status: r.status,
        is_active: r.is_active,
        housekeeping_status: r.housekeeping_status,
        rate: r.rate,
        guestName: r.guestName,
        phone: r.phone,
        date_of_birth: r.date_of_birth,
        pax: r.pax,
        deposit: r.deposit,
        checkInDate: r.checkInDate,
        expectedCheckOutDate: r.expectedCheckOutDate,
        address: r.address,
        gst_no: r.gst_no,
        pincode: r.pincode,
        country: r.country,
        arrival_from: r.arrival_from,
        departure_to: r.departure_to,
        user_id: r.user_id,
        booking_id: r.booking_id,
        reservation_id: r.reservation_id,
        booking_number: r.booking_number,
        billing_instruction: r.billing_instruction || 'Direct to Guest',
        meal_plan: r.meal_plan || 'EP',
        ledger: (r.booking_id && ledgerByBookingId[r.booking_id]) ? ledgerByBookingId[r.booking_id] : []
      })).sort((a, b) => {
        const numA = parseInt(a.number, 10);
        const numB = parseInt(b.number, 10);
        if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
          return numA - numB;
        }
        return String(a.number || '').localeCompare(String(b.number || ''), undefined, { numeric: true, sensitivity: 'base' });
      });
    };

    // Controlled Cutover: Primary Firestore Serving with Emergency MySQL Fallback
    const fetchProcessedRooms = () => SafeCutoverFallbackService.executeWithFallback({
      domain: 'room_status',
      servingEnabled: isFirestoreRoomStatusServingEnabled(),
      firestoreOp: () => FirestoreRoomStatusService.getRoomStatuses(systemDate),
      mysqlOp: isMysqlCutoverFallbacksDisabled() ? null : fetchMysqlProcessedRooms,
      validate: SafeCutoverFallbackService.validateRoomStatuses,
      shadowCompareFn: (fsRooms, mysqlRooms) => {
        if (isFirestoreRoomStatusShadowEnabled()) {
          FirestoreShadowComparisonService.compareRoomStatus(mysqlRooms, fsRooms, { businessDate: systemDate, endpoint: 'GET /api/status' });
        }
      },
      context: { endpoint: 'GET /api/status', systemDate }
    });

    const fetchCashLog = async () => {
      if (isMysqlCutoverFallbacksDisabled()) {
        try {
          return await getAllCashLogsFirestore({ filters: [{ field: 'business_date', op: '==', value: systemDate }], orderBy: [] }) || [];
        } catch (e) {
          console.warn('[getStatus] Failed to read cash logs from Firestore:', e.message);
          return [];
        }
      }
      const [dbCashLog] = await pool.query('SELECT * FROM cash_logs WHERE business_date = ?', [systemDate]);
      return dbCashLog;
    };

    const fetchUpcomingReservations = async () => {
      if (isMysqlCutoverFallbacksDisabled()) {
        try {
          const fsReservations = await getAllReservationsFirestore({ filters: [{ field: 'check_in_date', op: '>=', value: systemDate }] }) || [];
          return (fsReservations || [])
            .filter(r => r.status === 'Confirmed' || r.status === 'Reserved')
            .map(r => ({
              reservation_id: r.id || r.reservation_number,
              booking_id: r.booking_id || r.id,
              booking_number: r.reservation_number || r.booking_number,
              reservation_number: r.reservation_number,
              room_id: r.room_id,
              checkInDate: r.check_in_date || r.arrival_date,
              expectedCheckOutDate: r.check_out_date || r.departure_date,
              status: r.status,
              guestName: r.guest_name,
              phone: r.phone,
              adults: r.adults || 1,
              totalAmount: r.advance_payment || r.total_amount || 0,
              roomNumber: r.room_number || '',
              roomType: r.room_type || ''
            }));
        } catch (e) {
          console.warn('[getStatus] Failed to read upcoming reservations from Firestore:', e.message);
          return [];
        }
      }

      // Query upcoming future reservations for the side panel component
      const [futureBookings] = await pool.query(`
        SELECT
          b.id as booking_id,
          b.booking_number,
          b.room_id,
          b.check_in_date as checkInDate,
          b.expected_check_out_date as expectedCheckOutDate,
          b.booking_status as status,
          g.full_name as guestName,
          r.number as roomNumber,
          rt.title as roomType
        FROM bookings b
        LEFT JOIN guests g ON b.guest_id = g.id
        LEFT JOIN rooms r ON b.room_id = r.id
        LEFT JOIN room_types rt ON r.room_type_id = rt.id
        WHERE b.booking_status = 'Reserved'
          AND b.check_in_date >= ?
        ORDER BY b.check_in_date ASC
      `, [systemDate]);

      const [futureResTable] = await pool.query(`
        SELECT
          res.id as reservation_id,
          res.id as booking_id,
          res.reservation_number as booking_number,
          res.reservation_number,
          res.room_id,
          res.arrival_date as checkInDate,
          res.departure_date as expectedCheckOutDate,
          res.status as status,
          res.guest_name as guestName,
          res.phone as phone,
          res.adults as adults,
          res.advance_payment as totalAmount,
          COALESCE(r.number, res.room_number, '') as roomNumber,
          COALESCE(rt.title, res.room_type, '') as roomType
        FROM reservations res
        LEFT JOIN rooms r ON res.room_id = r.id
        LEFT JOIN room_types rt ON r.room_type_id = rt.id
        WHERE res.status IN ('Confirmed', 'Reserved')
          AND res.arrival_date >= ?
        ORDER BY res.arrival_date ASC
      `, [systemDate]);

      return [...futureBookings, ...futureResTable];
    };

    const [
      { todayCheckins, todayCheckouts, continuedRooms },
      processedRooms,
      cashLog,
      upcomingReservations
    ] = await Promise.all([
      fetchCounters(),
      fetchProcessedRooms(),
      fetchCashLog(),
      fetchUpcomingReservations()
    ]);

    const responsePayload = {
      systemDate,
      todayCheckins,
      todayCheckouts,
      continuedRooms,
      rooms: processedRooms,
      cashLog,
      upcomingReservations: upcomingReservations || [],
      data_status: 'fresh'
    };

    // Successful query: clear negative quota cache
    quotaExhaustedUntil = 0;

    // Save as last-known-good snapshot if rooms array is populated
    if (Array.isArray(processedRooms) && processedRooms.length > 0) {
      lastKnownGoodStatusSnapshot = {
        ...responsePayload,
        timestamp: Date.now()
      };
    }

    return res.json(responsePayload);
  } catch (error) {
    console.error('Error in getStatus controller:', error);

    const isQuotaError = error.code === 8 ||
      (error.message && (error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('Quota exceeded'))) ||
      (error.details && error.details.includes('Quota exceeded'));

    if (isQuotaError) {
      // Activate 15-second negative cache window to suppress repeated live Firestore attempts
      quotaExhaustedUntil = Date.now() + NEGATIVE_QUOTA_CACHE_TTL_MS;
    }

    // Safe Degradation: If a valid previous snapshot exists, return it with explicit stale metadata
    if (lastKnownGoodStatusSnapshot && Array.isArray(lastKnownGoodStatusSnapshot.rooms) && lastKnownGoodStatusSnapshot.rooms.length > 0) {
      console.warn('[getStatus] Returning last-known-good status snapshot due to Firestore degraded state');
      return res.json({
        ...lastKnownGoodStatusSnapshot,
        data_status: 'stale',
        stale_reason: isQuotaError ? 'FIRESTORE_RESOURCE_EXHAUSTED' : (error.code || 'FIRESTORE_DEGRADED'),
        stale_since: new Date(lastKnownGoodStatusSnapshot.timestamp).toISOString(),
        error_message: error.message || 'Firestore temporarily degraded'
      });
    }

    if (isQuotaError) {
      return res.status(503).json({
        error: 'Firestore database is temporarily unavailable due to daily project quota limit (Google Cloud Free Tier).',
        code: 'FIRESTORE_RESOURCE_EXHAUSTED',
        firestore_degraded: true,
        backend_online: true,
        retry_after_seconds: Math.max(1, Math.ceil((quotaExhaustedUntil - Date.now()) / 1000))
      });
    }

    return res.status(500).json({
      error: error.message || 'Internal Server Error',
      code: error.code || 'STATUS_ERROR',
      backend_online: true
    });
  }
};

export const runDayEnd = async (req, res) => {
  const { nextDate } = req.body;
  if (!nextDate) {
    return res.status(400).json({ error: 'Next business date is required' });
  }

  if (isFirebaseOnlyBusinessDateEnabled()) {
    try {
      await BusinessDateService.advanceBusinessDate(null, nextDate, {
        auditorId: req.user?.id || null,
        isFirebaseOnly: true
      });

      const confirmedDate = await BusinessDateService.getBusinessDate();
      return res.json({ message: `Night audit complete. Business date rolled to ${confirmedDate}` });
    } catch (error) {
      if (error.name === 'BusinessDateError') {
        console.warn(`[DayEnd] Rejected: [${error.code}] ${error.message}`);
        return res.status(error.httpStatus).json({ error: error.message, code: error.code });
      }
      console.error('Error in runDayEnd controller (Firestore), falling back if permitted:', error);
    }
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    await BusinessDateService.advanceBusinessDate(connection, nextDate, {
      auditorId: req.user?.id || null,
    });

    await connection.commit();
    const confirmedDate = await BusinessDateService.getBusinessDate(pool);
    res.json({ message: `Night audit complete. Business date rolled to ${confirmedDate}` });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) { }
    }
    if (error.name === 'BusinessDateError') {
      console.warn(`[DayEnd] Rejected: [${error.code}] ${error.message}`);
      return res.status(error.httpStatus).json({ error: error.message, code: error.code });
    }
    console.error('Error in runDayEnd controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── UNDO DAY END ─────────────────────────────────────────────────────────────
/**
 * POST /api/dayend/undo
 * Super Admin only. Reverses the most recent committed Day End iff no
 * operational data was created after that Day End.
 *
 * Checks (all must be zero to allow undo):
 *   • New bookings  (bookings.created_at  > dayend.created_at)
 *   • Check-outs    (bookings.updated_at  > dayend.created_at AND status=Checked Out)
 *   • Payments      (payments.created_at  > dayend.created_at)
 *   • Invoices      (invoices.created_at  > dayend.created_at)
 *   • Ledger items  (ledger_items.created_at > dayend.created_at, excl. rollover lines)
 *   • Reservations  (reservations.created_at > dayend.created_at)
 *   • Cash logs     (cash_logs.created_at > dayend.created_at)   [if created_at exists]
 *   • Housekeeping  (room_status_history.created_at > dayend.created_at)
 *
 * On success:
 *   1. Restores system_settings.system_date to previous date.
 *   2. Deletes rollover ledger_items created by that Day End.
 *   3. Marks the DAY_END audit log row as DAY_END_UNDONE.
 *   4. Inserts UNDO_DAY_END audit log entry.
 *   5. Commits.
 */
export const undoDayEnd = async (req, res) => {
  const adminId  = req.user?.id  || null;
  const username = req.user?.username || null;

  // ── Firestore Primary Path for Undo Day End ────────────────────────────────
  if (isFirebaseOnlyBusinessDateEnabled()) {
    try {
      const { listDocs, updateDoc, deleteDoc } = await import('../repositories/firestore/firestoreUtils.js');
      const { createAuditLogFirestore } = await import('../repositories/firestore/auditLogsRepository.js');

      const currentBusinessDate = await BusinessDateService.getBusinessDate();

      const dayEndLogs = await listDocs('audit_logs', {
        filters: [{ field: 'action', op: '==', value: 'DAY_END' }],
        orderBy: [{ field: 'created_at', direction: 'desc' }],
        limit: 1
      });

      if (!dayEndLogs || dayEndLogs.length === 0) {
        return res.status(404).json({
          error: 'No Day End has been executed yet. Nothing to undo.',
          code: 'NO_DAY_END_FOUND',
        });
      }

      const lastDayEnd = dayEndLogs[0];
      const dayEndId = lastDayEnd.id;
      const dayEndAt = new Date(lastDayEnd.created_at);
      const rolledToDate = BusinessDateService.parseDate(lastDayEnd.business_date || lastDayEnd.new_business_date);

      if (rolledToDate !== currentBusinessDate) {
        return res.status(409).json({
          error: `Cannot undo: current Business Date (${currentBusinessDate}) does not match the last Day End target (${rolledToDate}). Another Day End or manual date change may have occurred.`,
          code: 'BUSINESS_DATE_MISMATCH',
        });
      }

      let previousDate = lastDayEnd.previous_business_date;
      if (!previousDate && lastDayEnd.details) {
        const detailMatch = lastDayEnd.details.match(/rolled from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
        if (detailMatch) previousDate = detailMatch[1];
      }

      if (!previousDate) {
        return res.status(500).json({
          error: 'Cannot undo: audit log details do not contain the previous Business Date. The log may be corrupted.',
          code: 'CORRUPT_AUDIT_LOG',
        });
      }

      // Operational data checks in Firestore
      const blockers = [];
      const [newBookings, newPayments, newInvoices, newReservations, postLedger] = await Promise.all([
        listDocs('bookings', { filters: [{ field: 'created_at', op: '>', value: dayEndAt.toISOString() }] }),
        listDocs('payments', { filters: [{ field: 'created_at', op: '>', value: dayEndAt.toISOString() }] }),
        listDocs('invoices', { filters: [{ field: 'created_at', op: '>', value: dayEndAt.toISOString() }] }),
        listDocs('reservations', { filters: [{ field: 'created_at', op: '>', value: dayEndAt.toISOString() }] }),
        listDocs('ledger_items', { filters: [{ field: 'created_at', op: '>', value: dayEndAt.toISOString() }] })
      ]);

      const activeNewBookings = (newBookings || []).filter(b => String(b.booking_status || '').toLowerCase() !== 'cancelled');
      if (activeNewBookings.length > 0) blockers.push(`${activeNewBookings.length} new check-ins`);
      if ((newPayments || []).length > 0) blockers.push(`${newPayments.length} new payments`);
      if ((newInvoices || []).length > 0) blockers.push(`${newInvoices.length} new invoices`);
      if ((newReservations || []).length > 0) blockers.push(`${newReservations.length} new reservations`);

      const nonRolloverLedger = (postLedger || []).filter(item => {
        const desc = String(item.desc || '');
        return !desc.includes('Rollover') && !desc.includes('Room Tariff') && !desc.includes('Taxes & GST');
      });
      if (nonRolloverLedger.length > 0) blockers.push(`${nonRolloverLedger.length} new ledger entries (non-rollover)`);

      if (blockers.length > 0) {
        return res.status(409).json({
          error: `Undo rejected: operational data exists after the last Day End. Remove or reverse these records first.`,
          code: 'POST_DAY_END_DATA_EXISTS',
          blockers,
        });
      }

      // Delete rollover ledger items in Firestore for rolledToDate
      const rolloverItems = await listDocs('ledger_items', {
        filters: [{ field: 'business_date', op: '==', value: rolledToDate }]
      });
      for (const item of (rolloverItems || [])) {
        const desc = String(item.desc || '');
        if (desc.includes('Rollover') || desc.includes('Room Tariff') || desc.includes('Taxes & GST')) {
          await deleteDoc('ledger_items', item.id);
        }
      }

      // Restore business date in Firestore
      await BusinessDateService.setBusinessDate(null, previousDate, { allowBackward: true });

      // Mark Day End audit log as undone
      await updateDoc('audit_logs', dayEndId, { action: 'DAY_END_UNDONE' });

      // Insert UNDO_DAY_END log
      const undoDetail = `Day End #${dayEndId} reversed by ${username || 'admin'}. Business Date restored from ${rolledToDate} to ${previousDate}.`;
      await createAuditLogFirestore({
        user_id: adminId,
        action: 'UNDO_DAY_END',
        details: undoDetail,
        business_date: previousDate,
        previous_business_date: rolledToDate,
        new_business_date: previousDate
      });

      return res.json({
        message: `Day End undone. Business Date restored from ${rolledToDate} to ${previousDate}.`,
        previousDate,
        restoredDate: previousDate
      });

    } catch (fsErr) {
      console.warn('[undoDayEnd] Firestore primary undo failed, attempting MySQL fallback:', fsErr.message);
    }
  }

  // ── Legacy MySQL Fallback Path ──────────────────────────────────────────
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── Lock system_settings to block concurrent Day End calls ──────────────
    await connection.query('SELECT * FROM system_settings FOR UPDATE');

    const currentBusinessDate = await BusinessDateService.getBusinessDate(connection);

    // ── Find the most recent committed Day End ───────────────────────────────
    const [dayEndRows] = await connection.query(
      "SELECT id, business_date, previous_business_date, details, created_at FROM audit_logs WHERE action = 'DAY_END' ORDER BY created_at DESC LIMIT 1"
    );

    if (dayEndRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        error: 'No Day End has been executed yet. Nothing to undo.',
        code: 'NO_DAY_END_FOUND',
      });
    }

    const lastDayEnd = dayEndRows[0];
    const dayEndId        = lastDayEnd.id;
    const dayEndAt        = new Date(lastDayEnd.created_at); // JS Date for comparisons
    const rolledToDate    = BusinessDateService.parseDate(lastDayEnd.business_date);

    // Verify the current Business Date matches the rolled-to date.
    // If not, either the date moved forward again (another Day End ran) or
    // a manual override happened — undo is unsafe.
    if (rolledToDate !== currentBusinessDate) {
      await connection.rollback();
      return res.status(409).json({
        error: `Cannot undo: current Business Date (${currentBusinessDate}) does not match the last Day End target (${rolledToDate}). Another Day End or manual date change may have occurred.`,
        code: 'BUSINESS_DATE_MISMATCH',
      });
    }

    // ── Extract previous business date from audit log details ────────────────
    // Details format: "Night audit run. Business date rolled from YYYY-MM-DD to YYYY-MM-DD. ..."
    const detailMatch = lastDayEnd.details.match(/rolled from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
    if (!detailMatch) {
      await connection.rollback();
      return res.status(500).json({
        error: 'Cannot undo: audit log details do not contain the previous Business Date. The log may be corrupted.',
        code: 'CORRUPT_AUDIT_LOG',
      });
    }
    const previousDate = detailMatch[1];

    // ── Operational data guard ───────────────────────────────────────────────
    // All checks return { count, description } pairs. Any non-zero count blocks undo.
    const dataChecks = [
      {
        label: 'new check-ins',
        query: 'SELECT COUNT(*) as cnt FROM bookings WHERE created_at > ? AND booking_status != ?',
        params: [dayEndAt, 'Cancelled'],
      },
      {
        label: 'new check-outs',
        query: "SELECT COUNT(*) as cnt FROM bookings WHERE updated_at > ? AND booking_status = 'Checked Out'",
        params: [dayEndAt],
      },
      {
        label: 'new payments',
        query: 'SELECT COUNT(*) as cnt FROM payments WHERE created_at > ?',
        params: [dayEndAt],
      },
      {
        label: 'new invoices',
        query: 'SELECT COUNT(*) as cnt FROM invoices WHERE created_at > ?',
        params: [dayEndAt],
      },
      {
        label: 'new ledger entries (non-rollover)',
        query: "SELECT COUNT(*) as cnt FROM ledger_items WHERE created_at > ? AND `desc` NOT LIKE 'Room Tariff%Rollover%' AND `desc` NOT LIKE 'Taxes & GST%'",
        params: [dayEndAt],
      },
      {
        label: 'new reservations',
        query: 'SELECT COUNT(*) as cnt FROM reservations WHERE created_at > ?',
        params: [dayEndAt],
      },
      {
        label: 'housekeeping updates',
        query: 'SELECT COUNT(*) as cnt FROM room_status_history WHERE created_at > ?',
        params: [dayEndAt],
      },
    ];

    // Conditionally check cash_logs only if it has a created_at column
    const [cashCols] = await connection.query("SHOW COLUMNS FROM cash_logs LIKE 'created_at'");
    if (cashCols.length > 0) {
      dataChecks.push({
        label: 'new cash transactions',
        query: 'SELECT COUNT(*) as cnt FROM cash_logs WHERE created_at > ?',
        params: [dayEndAt],
      });
    }

    const blockers = [];
    for (const check of dataChecks) {
      const [[{ cnt }]] = await connection.query(check.query, check.params);
      if (cnt > 0) blockers.push(`${cnt} ${check.label}`);
    }

    if (blockers.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        error: `Undo rejected: operational data exists after the last Day End. Remove or reverse these records first.`,
        code: 'POST_DAY_END_DATA_EXISTS',
        blockers,
      });
    }

    // ── Reverse rollover ledger entries created by this Day End ──────────────
    // These are ledger_items with business_date = rolledToDate AND a rollover desc.
    const [delResult] = await connection.query(
      "DELETE FROM ledger_items WHERE business_date = ? AND (`desc` LIKE 'Room Tariff%Rollover%' OR `desc` LIKE 'Taxes & GST%')",
      [rolledToDate]
    );
    console.log(`[UndoDayEnd] Deleted ${delResult.affectedRows} rollover ledger items for ${rolledToDate}.`);

    // ── Restore Business Date to previous via BusinessDateService ────────────
    console.log(`[UndoDayEnd] Restoring Business Date: ${rolledToDate} → ${previousDate}`);
    await BusinessDateService.setBusinessDate(connection, previousDate, { allowBackward: true });

    // ── Mark the DAY_END audit log as undone ─────────────────────────────────
    await connection.query(
      "UPDATE audit_logs SET action = 'DAY_END_UNDONE' WHERE id = ?",
      [dayEndId]
    );

    // ── Insert UNDO_DAY_END audit log ────────────────────────────────────────
    const undoDetail = `Day End #${dayEndId} reversed by ${username || 'admin'}. Business Date restored from ${rolledToDate} to ${previousDate}.`;
    await connection.query(
      "INSERT INTO audit_logs (user_id, action, details, business_date, previous_business_date, new_business_date) VALUES (?, 'UNDO_DAY_END', ?, ?, ?, ?)",
      [adminId, undoDetail, previousDate, rolledToDate, previousDate]
    );

    // ── Phase 4G-C: Restore daily counters ───────────────────────────────────
    // Day End reset today_checkins and today_checkouts to 0, and set
    // continued_rooms = occupied count. Undo must restore these counters
    // to the values they held immediately before the Day End ran.
    //
    // The data guard above ensures ZERO operations occurred after the Day End,
    // so we can safely count from the DB:
    //   today_checkins  = bookings created on previousDate (checked-in)
    //   today_checkouts = bookings whose check_out_date falls on previousDate
    //   continued_rooms = rooms currently occupied (unchanged since Day End)
    const [[checkinCountRow]] = await connection.query(
      `SELECT COUNT(*) as cnt FROM bookings
       WHERE DATE(created_at) = ? AND booking_status NOT IN ('Cancelled', 'Reserved')`,
      [previousDate]
    );
    const restoredCheckins = Number(checkinCountRow.cnt);

    const [[checkoutCountRow]] = await connection.query(
      `SELECT COUNT(*) as cnt FROM bookings
       WHERE DATE(check_out_date) = ? AND booking_status = 'Checked Out'`,
      [previousDate]
    );
    const restoredCheckouts = Number(checkoutCountRow.cnt);

    const [[occupiedCountRow]] = await connection.query(
      `SELECT COUNT(*) as cnt FROM rooms WHERE status = 'occupied'`
    );
    const restoredContinuedRooms = Number(occupiedCountRow.cnt);

    await connection.query(
      `UPDATE system_settings SET value_val = ? WHERE key_name = 'today_checkins'`,
      [String(restoredCheckins)]
    );
    await connection.query(
      `UPDATE system_settings SET value_val = ? WHERE key_name = 'today_checkouts'`,
      [String(restoredCheckouts)]
    );
    await connection.query(
      `UPDATE system_settings SET value_val = ? WHERE key_name = 'continued_rooms'`,
      [String(restoredContinuedRooms)]
    );
    console.log(`[UndoDayEnd] Counters restored: checkins=${restoredCheckins}, checkouts=${restoredCheckouts}, continued_rooms=${restoredContinuedRooms}`);

    await connection.commit();

    const restoredDate = await BusinessDateService.getBusinessDate(pool);
    console.log(`[UndoDayEnd] Complete. Business Date is now ${restoredDate}.`);

    res.json({
      message: `Day End successfully reversed. Business Date restored to ${restoredDate}.`,
      previousDate: rolledToDate,
      restoredDate,
      rolledBackLedgerItems: delResult.affectedRows,
    });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) { } }
    console.error('[UndoDayEnd] Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

/** Admin endpoint — get all pending guest requests with room & guest details */
export const getGuestRequests = async (req, res) => {
  try {
    // Primary: Authoritative Firestore serving with 15s caching and in-flight deduplication
    try {
      const fsData = await GuestRequestsService.getGuestRequests({ skipCache: false });
      if (fsData && Array.isArray(fsData.requests)) {
        return res.json(fsData);
      }
    } catch (fsErr) {
      console.warn('[getGuestRequests] Firestore serving error, attempting MySQL fallback:', fsErr.message);
    }

    // ── Fallback: Legacy MySQL Path ──────────────────────────────────────────
    // 1. Ledger-based service requests (food orders, room service, laundry etc.)
    const [serviceItems] = await pool.query(`
      SELECT 
        li.id,
        li.desc as \`desc\`,
        li.qty,
        li.amount,
        li.business_date,
        COALESCE(li.created_at, NOW()) as created_at,
        r.number as room_number,
        rt.code as room_type,
        g.full_name as guest_name,
        g.phone as guest_phone,
        b.booking_number,
        b.id as booking_id,
        'service' as request_type,
        li.status as \`status\`
      FROM ledger_items li
      JOIN bookings b ON li.booking_id = b.id
      JOIN rooms r ON b.room_id = r.id
      JOIN room_types rt ON r.room_type_id = rt.id
      JOIN guests g ON b.guest_id = g.id
      WHERE 
        b.booking_status = 'Checked In'
        AND li.status = 'Pending'
        AND li.desc NOT LIKE '%Room Tariff%'
        AND li.desc NOT LIKE '%Taxes%'
        AND li.desc NOT LIKE '%GST%'
        AND li.desc NOT LIKE '%Deposit%'
      ORDER BY li.id DESC
      LIMIT 100
    `);

    // 2. Maintenance requests — from maintenance table
    const [maintenanceItems] = await pool.query(`
      SELECT 
        m.id,
        m.issue as \`desc\`,
        m.status as \`status\`,
        m.business_date,
        m.created_at,
        r.number as room_number,
        rt.code as room_type,
        g.full_name as guest_name,
        g.phone as guest_phone,
        b.booking_number,
        b.id as booking_id,
        'maintenance' as request_type
      FROM maintenance m
      JOIN rooms r ON m.room_id = r.id
      JOIN room_types rt ON r.room_type_id = rt.id
      JOIN bookings b ON (b.room_id = r.id AND b.booking_status = 'Checked In')
      JOIN guests g ON b.guest_id = g.id
      WHERE m.status IN ('Pending', 'In Progress')
        AND m.reported_by = g.user_id
      ORDER BY m.created_at DESC
      LIMIT 100
    `);


    // 3. Checkout requests — from audit_logs with action GUEST_CHECKOUT_REQUEST
    const [checkoutRequests] = await pool.query(`
      SELECT 
        al.id,
        al.details as \`desc\`,
        al.business_date,
        al.created_at,
        'checkout_request' as request_type,
        'Pending' as \`status\`,
        u.fullName as guest_name,
        r.number as room_number,
        rt.code as room_type
      FROM audit_logs al
      JOIN users u ON al.user_id = u.id
      JOIN guests g ON g.user_id = u.id
      JOIN bookings b ON b.guest_id = g.id
      JOIN rooms r ON b.room_id = r.id
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE al.action = 'GUEST_CHECKOUT_REQUEST'
        AND b.booking_status = 'Checked In'
        AND al.created_at >= NOW() - INTERVAL 48 HOUR
      ORDER BY al.created_at DESC
      LIMIT 50
    `);

    // 4. Extension requests
    const [extensionRequests] = await pool.query(`
      SELECT 
        er.id,
        CONCAT('Requested Extension to: ', er.requested_checkout_date) as \`desc\`,
        '11-Jul-2026' as business_date,
        er.created_at,
        'extension_request' as request_type,
        er.status as \`status\`,
        g.full_name as guest_name,
        g.phone as guest_phone,
        b.booking_number,
        b.id as booking_id,
        r.number as room_number,
        rt.code as room_type,
        er.requested_checkout_date
      FROM stay_extension_requests er
      JOIN bookings b ON er.booking_id = b.id
      JOIN rooms r ON b.room_id = r.id
      JOIN room_types rt ON r.room_type_id = rt.id
      JOIN guests g ON b.guest_id = g.id
      WHERE er.status = 'Pending'
      ORDER BY er.created_at DESC
      LIMIT 100
    `);

    // Combine all request types
    const allRequests = [
      ...serviceItems.map(r => ({ ...r, id: `svc_${r.id}` })),
      ...maintenanceItems.map(r => ({ ...r, id: `mnt_${r.id}` })),
      ...checkoutRequests.map(r => ({ ...r, id: `co_${r.id}` })),
      ...extensionRequests.map(r => ({ ...r, id: `ext_${r.id}` }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ requests: allRequests, total: allRequests.length });
  } catch (error) {
    console.error('getGuestRequests error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** Acknowledge and resolve a guest request */
export const resolveGuestRequest = async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Request ID is required' });

  try {
    // 1. Primary Firestore resolution
    try {
      await GuestRequestsService.resolveRequest(id, req.user?.id || 'admin');
    } catch (fsErr) {
      if (fsErr.status === 400 || fsErr.status === 404) {
        return res.status(fsErr.status).json({ error: fsErr.message });
      }
      console.warn('[resolveGuestRequest] Firestore resolution warning:', fsErr.message);
    }

    // 2. MySQL dual-write update if available
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      if (id.startsWith('svc_')) {
        const realId = id.replace('svc_', '');
        await connection.query(
          "UPDATE ledger_items SET status = 'Completed' WHERE id = ?",
          [realId]
        );
      } else if (id.startsWith('mnt_')) {
        const realId = id.replace('mnt_', '');
        await connection.query(
          "UPDATE maintenance SET status = 'Resolved' WHERE id = ?",
          [realId]
        );
      } else if (id.startsWith('co_')) {
        const realId = id.replace('co_', '');
        await connection.query(
          "UPDATE audit_logs SET action = 'GUEST_CHECKOUT_REQUEST_PROCESSED' WHERE id = ?",
          [realId]
        );
      }
      await connection.commit();
    } catch (mysqlErr) {
      if (connection) {
        try { await connection.rollback(); } catch (e) { }
      }
      console.warn('[resolveGuestRequest] MySQL dual-write non-fatal error:', mysqlErr.message);
    } finally {
      if (connection) connection.release();
    }

    // Invalidate caches
    invalidateGuestRequestsCache();
    return res.json({ message: 'Request resolved successfully' });
  } catch (error) {
    console.error('resolveGuestRequest error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const resolveExtensionRequest = async (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // 'approve' or 'reject'

  if (!id) return res.status(400).json({ error: 'Request ID is required' });
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action. Must be approve or reject' });
  }

  const realId = id.replace('ext_', '');
  const adminId = req.user?.id;

  try {
    // 1. Primary Firestore resolution
    let fsResult = null;
    try {
      fsResult = await GuestRequestsService.resolveExtensionRequest(id, action, adminId);
    } catch (fsErr) {
      if (fsErr.status === 400 || fsErr.status === 404) {
        return res.status(fsErr.status).json({ error: fsErr.message });
      }
      console.warn('[resolveExtensionRequest] Firestore resolution warning:', fsErr.message);
    }

    // 2. MySQL dual-write update if available
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [reqRows] = await connection.query(
        "SELECT * FROM stay_extension_requests WHERE id = ? AND status = 'Pending' FOR UPDATE",
        [realId]
      );
      if (reqRows.length > 0) {
        const extReq = reqRows[0];

        const [bookingRows] = await connection.query(
          "SELECT * FROM bookings WHERE id = ? FOR UPDATE",
          [extReq.booking_id]
        );
        const booking = bookingRows[0];

        const [guestRows] = await connection.query(
          "SELECT user_id FROM guests WHERE id = ?",
          [extReq.guest_id]
        );
        const guestUserId = guestRows[0]?.user_id;

        if (action === 'approve') {
          await connection.query(
            "UPDATE bookings SET expected_check_out_date = ? WHERE id = ?",
            [extReq.requested_checkout_date, booking.id]
          );

          // Update Request status
          await connection.query(
            "UPDATE stay_extension_requests SET status = 'Approved', admin_id = ? WHERE id = ?",
            [adminId, realId]
          );

          if (guestUserId) {
            await connection.query(
              "INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)",
              [guestUserId, '✅ Extension Approved', `Your request to extend your stay until ${extReq.requested_checkout_date} has been approved.`]
            );
          }

          await connection.query(
            `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'EXTENSION_APPROVED', ?, CURDATE())`,
            [adminId, `Admin approved stay extension for Booking ${booking.id} to ${extReq.requested_checkout_date}`]
          );
        } else if (action === 'reject') {
          await connection.query(
            "UPDATE stay_extension_requests SET status = 'Rejected', admin_id = ? WHERE id = ?",
            [adminId, realId]
          );

          if (guestUserId) {
            await connection.query(
              "INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)",
              [guestUserId, '❌ Extension Rejected', `Your request to extend your stay until ${extReq.requested_checkout_date} could not be approved due to unavailability.`]
            );
          }

          await connection.query(
            `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'EXTENSION_REJECTED', ?, CURDATE())`,
            [adminId, `Admin rejected stay extension for Booking ${booking.id}`]
          );
        }

        await connection.commit();
        req.app.get('io')?.emit('guest_dashboard_refresh', { guestUserId });
      }
    } catch (mysqlErr) {
      if (connection) {
        try { await connection.rollback(); } catch (e) { }
      }
      console.warn('[resolveExtensionRequest] MySQL dual-write non-fatal error:', mysqlErr.message);
    } finally {
      if (connection) connection.release();
    }

    // Invalidate caches
    invalidateGuestRequestsCache();

    if (fsResult && fsResult.message) {
      return res.json({ message: fsResult.message });
    }
    return res.json({ message: `Extension request ${action}d successfully` });
  } catch (error) {
    console.error('resolveExtensionRequest error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ─── ADMIN: GET ALL GUEST DOCUMENTS ──────────────────────────────────────────
export const getGuestDocuments = async (req, res) => {
  try {
    const guests = await GuestAdminService.getGuestDocuments();
    res.json({ success: true, guests });
  } catch (error) {
    console.error('Error fetching guest documents:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

// ─── ADMIN: VERIFY/REJECT GUEST DOCUMENT ─────────────────────────────────────
export const verifyGuestDocument = async (req, res) => {
  const { guestId } = req.params;
  const { status, rejectionReason } = req.body; // status: 'Verified' | 'Rejected' | 'Pending'
  const adminId = req.user?.id || null;

  if (!['Verified', 'Rejected', 'Pending'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }
  if (status === 'Rejected' && (!rejectionReason || rejectionReason.trim() === '')) {
    return res.status(400).json({ success: false, message: 'Rejection reason is required' });
  }

  try {
    const result = await GuestAdminService.verifyGuestDocument(guestId, {
      status,
      rejectionReason,
      adminId
    });
    res.json(result);
  } catch (error) {
    console.error('Error verifying guest document:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Internal Server Error' });
  }
};

// ─── ADMIN: DELETE GUEST DOCUMENT ──────────────────────────────────────────────────
export const deleteGuestDocument = async (req, res) => {
  const { guestId } = req.params;
  try {
    const result = await GuestAdminService.deleteGuestDocument(guestId);
    res.json(result);
  } catch (error) {
    console.error('deleteGuestDocument error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Internal Server Error' });
  }
};

// ─── ADMIN: STREAM GUEST DOCUMENT (AUTHENTICATED) ──────────────────────────
export const streamGuestDocument = async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'Filename is required' });
    }

    // Strictly validate filename to prevent path traversal and invalid characters
    const baseFilename = path.basename(filename);
    if (baseFilename !== filename || filename.includes('..') || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
      return res.status(400).json({ error: 'Invalid filename format' });
    }

    // Strict extension validation
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.pdf': 'application/pdf'
    };

    const contentType = mimeMap[ext];
    if (!contentType) {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    const filePath = path.resolve(GUEST_DOCS_DIR, filename);

    // Verify resolved path stays strictly inside GUEST_DOCS_DIR
    if (!filePath.startsWith(GUEST_DOCS_DIR + path.sep) && filePath !== GUEST_DOCS_DIR) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Document not found' });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (err) {
    console.error('streamGuestDocument error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ─── ADMIN: LIST ALL GUESTS (paginated, filterable) ──────────────────────────
export const listGuests = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
  const q = (req.query.q || '').trim();
  const filter = req.query.filter || 'all'; // all | inhouse | checkedout | reserved | vip | blacklisted

  try {
    const result = await GuestAdminService.listGuests({ page, limit, q, filter });
    res.json(result);
  } catch (error) {
    console.error('listGuests error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ─── ADMIN: SEARCH GUESTS BY NAME OR PHONE ───────────────────────────────────
export const searchGuests = async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }
  try {
    const guests = await GuestAdminService.searchGuests(q);
    res.json({ guests });
  } catch (error) {
    console.error('searchGuests error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ─── RECEPTION STAFF: GUEST SEARCH (name / phone / email / booking number) ───
export const searchGuestsStaff = async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }
  try {
    const guests = await GuestAdminService.searchGuestsStaff(q);
    res.json({ guests });
  } catch (error) {
    console.error('searchGuestsStaff error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


