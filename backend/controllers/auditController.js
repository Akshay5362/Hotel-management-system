import pool from '../db.js';
import fs from 'fs';
import path from 'path';
import { RoomStatusService } from '../services/roomStatusService.js';
import { BusinessDateService, BD_ERRORS } from '../services/businessDateService.js';
import { AvailabilityService } from '../services/AvailabilityService.js';

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


export const getStatus = async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.commit();
    connection.release();
    connection = null;

    const systemDate = await BusinessDateService.getBusinessDate(pool);
    const [counterRows] = await pool.query(
      "SELECT key_name, value_val FROM system_settings WHERE key_name IN ('today_checkins','today_checkouts','continued_rooms')"
    );
    const counterMap = {};
    counterRows.forEach(r => { counterMap[r.key_name] = r.value_val; });
    const todayCheckins  = parseInt(counterMap['today_checkins']  || '0', 10);
    const todayCheckouts = parseInt(counterMap['today_checkouts'] || '0', 10);
    const continuedRooms = parseInt(counterMap['continued_rooms'] || '0', 10);


    // Compute all dynamic room statuses via RoomStatusService
    const computedRooms = await RoomStatusService.getRoomStatuses(pool, systemDate);

    // Group ledgers by active booking_id to prevent old checked-out charges from polluting current folio
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

    const processedRooms = computedRooms.map(r => ({
      id: r.id,
      number: r.number,
      type: r.type,
      status: r.status,
      housekeeping_status: r.housekeeping_status,
      rate: r.rate,
      guestName: r.guestName,
      phone: r.phone,
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
    }));

    const [cashLog] = await pool.query('SELECT * FROM cash_logs WHERE business_date = ?', [systemDate]);

    // Query upcoming future reservations for the side panel component
    const [futureBookings] = await pool.query(`
      SELECT 
        b.id as booking_id,
        b.booking_number,
        b.room_id,
        b.check_in_date as checkInDate,
        b.expected_check_out_date as expectedCheckOutDate,
        b.adults,
        b.total_amount as totalAmount,
        b.advance_amount as deposit,
        b.booking_status as status,
        g.full_name as guestName,
        g.phone,
        r.number as roomNumber,
        rt.code as roomType
      FROM bookings b
      JOIN guests g ON b.guest_id = g.id
      JOIN rooms r ON b.room_id = r.id
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE b.booking_status = 'Reserved'
      ORDER BY b.check_in_date ASC
    `);

    const [futureResTable] = await pool.query(`
      SELECT 
        res.id as reservation_id,
        res.reservation_number as ref_code,
        res.reservation_number as booking_number,
        res.room_id,
        res.room_number,
        res.room_type as roomType,
        res.guest_name as guest_name,
        res.guest_name as guestName,
        res.phone,
        res.arrival_date as check_in_date,
        res.arrival_date as checkInDate,
        res.departure_date as check_out_date,
        res.departure_date as expectedCheckOutDate,
        res.adults as pax,
        res.adults,
        res.advance_payment as total_amount,
        res.advance_payment as deposit,
        res.status
      FROM reservations res
      WHERE res.status IN ('Reserved', 'Confirmed')
      ORDER BY res.arrival_date ASC
    `);

    const upcomingReservations = [...futureBookings, ...futureResTable];

    res.json({
      systemDate,
      todayCheckins,
      todayCheckouts,
      continuedRooms,
      rooms: processedRooms,
      cashLog,
      upcomingReservations: upcomingReservations || []
    });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) { }
      connection.release();
    }
    console.error('Error in getStatus controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const runDayEnd = async (req, res) => {
  const { nextDate } = req.body;
  if (!nextDate) {
    return res.status(400).json({ error: 'Next business date is required' });
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
    // 1. Ledger-based service requests (food orders, room service, laundry etc.)
    //    These appear in ledger_items with desc starting with 'Food Order:' or service names
    //    We join bookings → guests → rooms to get context
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
    // Joined with bookings/rooms to get metadata and only show active stay requests
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
    } else {
      await connection.rollback();
      return res.status(400).json({ error: 'Invalid request ID format' });
    }
    await connection.commit();
    res.json({ message: 'Request resolved successfully' });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) { }
    }
    console.error('resolveGuestRequest error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
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

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [reqRows] = await connection.query(
      "SELECT * FROM stay_extension_requests WHERE id = ? AND status = 'Pending' FOR UPDATE",
      [realId]
    );
    if (reqRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Pending extension request not found' });
    }
    const extReq = reqRows[0];

    // Get the booking
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
      console.log(`[ExtensionResolve] Admin ${adminId} called approve API for Request ID ${realId}`);

      // Verify availability for extension period using AvailabilityService
      const availResult = await AvailabilityService.checkRoomAvailability(connection, {
        roomId: extReq.room_id,
        arrivalDate: extReq.current_checkout_date || booking.expected_check_out_date,
        departureDate: extReq.requested_checkout_date,
        forUpdate: true
      });
      if (!availResult.available) {
        await connection.rollback();
        return res.status(400).json({ error: `Cannot approve extension: ${availResult.reason}` });
      }

      // Update Booking
      await connection.query(
        "UPDATE bookings SET expected_check_out_date = ? WHERE id = ?",
        [extReq.requested_checkout_date, booking.id]
      );
      console.log(`[ExtensionResolve] Booking ${booking.id} updated checkout date to ${extReq.requested_checkout_date}`);

      // Post Ledger Entries immediately for the new extension period
      const [roomRows] = await connection.query(`
        SELECT r.number, rt.base_rate FROM rooms r
        JOIN room_types rt ON r.room_type_id = rt.id
        WHERE r.id = ?
      `, [extReq.room_id]);
      const room = roomRows[0];
      const tariff = room.base_rate;
      // GST included in room rate — no separate tax line

      let currentDate = new Date(extReq.current_checkout_date);
      let endDate = new Date(extReq.requested_checkout_date);
      currentDate.setHours(0, 0, 0, 0);
      endDate.setHours(0, 0, 0, 0);
      let additionalCharges = 0;

      console.log(`[ExtensionResolve] Ledger posting started. Dates: ${currentDate.toISOString()} to ${endDate.toISOString()}`);

      while (currentDate < endDate) {
        const bizDateStr = currentDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

        // Post Room Tariff
        const [existingTariff] = await connection.query(
          "SELECT id FROM ledger_items WHERE room_number = ? AND business_date = ? AND booking_id = ? AND `desc` LIKE 'Room Tariff%Rollover%'",
          [room.number, bizDateStr, booking.id]
        );
        if (existingTariff.length === 0) {
          await connection.query(
            'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
            [room.number, 'Room Tariff (Rollover, Incl. GST)', tariff, bizDateStr, booking.id]
          );
          additionalCharges += tariff;
          console.log(`[ExtensionResolve] Room tariff ₹${tariff} inserted for ${bizDateStr}`);
        } else {
          console.log(`[ExtensionResolve] Room tariff skipped (already exists) for ${bizDateStr}`);
        }

        currentDate.setDate(currentDate.getDate() + 1);
      }

      console.log(`[ExtensionResolve] Balance recalculated successfully. Total added: ₹${additionalCharges}`);

      // Update Request status
      await connection.query(
        "UPDATE stay_extension_requests SET status = 'Approved', admin_id = ? WHERE id = ?",
        [adminId, realId]
      );

      // Notify Guest
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

      await connection.commit();
      console.log(`[ExtensionResolve] Transaction committed successfully for Request ${realId}`);
      req.app.get('io')?.emit('guest_dashboard_refresh', { guestUserId });
      return res.json({ message: `Stay extension approved. Additional charges of ₹${additionalCharges.toLocaleString('en-IN')} have been added to the guest folio.` });

    } else if (action === 'reject') {
      // Update Request status
      await connection.query(
        "UPDATE stay_extension_requests SET status = 'Rejected', admin_id = ? WHERE id = ?",
        [adminId, realId]
      );

      // Notify Guest
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
    // Notify clients to refresh dashboards
    req.app.get('io')?.emit('guest_dashboard_refresh', { guestUserId });
    res.json({ message: `Extension request ${action}d successfully` });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) { }
    }
    console.error('resolveExtensionRequest error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── ADMIN: GET ALL GUEST DOCUMENTS ──────────────────────────────────────────
export const getGuestDocuments = async (req, res) => {
  try {
    const [guests] = await pool.query(`
      SELECT 
        g.id, g.full_name, g.government_id, g.id_type, g.id_document_path, 
        g.id_upload_timestamp, g.id_verification_status, g.id_rejection_reason, 
        g.id_verified_by, g.id_verified_at, g.id_ocr_text,
        r.number AS room_number,
        b.booking_status,
        b.check_in_date,
        b.expected_check_out_date
      FROM guests g
      LEFT JOIN bookings b ON b.guest_id = g.id 
        AND b.booking_status IN ('Reserved', 'Checked In')
      LEFT JOIN rooms r ON r.id = b.room_id
      WHERE g.id_document_path IS NOT NULL
      ORDER BY g.id_upload_timestamp DESC
    `);
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

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [result] = await connection.query(`
      UPDATE guests 
      SET id_verification_status = ?, 
          id_rejection_reason = ?, 
          id_verified_by = ?, 
          id_verified_at = NOW()
      WHERE id = ?
    `, [status, status === 'Rejected' ? rejectionReason : null, adminId, guestId]);

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Guest document not found' });
    }

    // ── Send notification to the guest ───────────────────────────────────────
    // Fetch the guest's user_id so we can target their notification inbox
    const [guestRows] = await connection.query(
      'SELECT user_id, full_name, id_type FROM guests WHERE id = ?',
      [guestId]
    );
    const guest = guestRows[0];

    if (guest?.user_id) {
      if (status === 'Rejected') {
        await connection.query(
          `INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
          [
            guest.user_id,
            '❌ Document Verification Failed',
            `Your ${guest.id_type || 'ID document'} was reviewed by the front desk and could not be accepted.\n\nReason: ${rejectionReason}\n\nPlease re-upload a clear, legible copy of your document to complete verification.`,
            'id_rejected'
          ]
        );
      } else if (status === 'Verified') {
        await connection.query(
          `INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
          [
            guest.user_id,
            '✅ Identity Verified',
            `Great news, ${guest.full_name?.split(' ')[0] || 'Guest'}! Your ${guest.id_type || 'ID document'} has been verified successfully by our front desk team.`,
            'id_verified'
          ]
        );
      }
    }

    await connection.commit();
    res.json({ success: true, message: `Document successfully marked as ${status}` });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) { } }
    console.error('Error verifying guest document:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── ADMIN: DELETE GUEST DOCUMENT ──────────────────────────────────────────────────
export const deleteGuestDocument = async (req, res) => {
  const { guestId } = req.params;

  let connection;
  try {
    connection = await pool.getConnection();

    const [guestRows] = await connection.query(
      'SELECT id_document_path FROM guests WHERE id = ?',
      [guestId]
    );

    if (guestRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Guest not found' });
    }

    const docPath = guestRows[0].id_document_path;

    // Start transaction to clean up DB
    await connection.beginTransaction();

    await connection.query(`
      UPDATE guests 
      SET id_document_path = NULL,
          id_upload_timestamp = NULL,
          id_verification_status = 'Pending',
          id_rejection_reason = NULL,
          id_verified_by = NULL,
          id_verified_at = NULL,
          id_ocr_text = NULL
      WHERE id = ?
    `, [guestId]);

    await connection.commit();

    // Delete the file from disk if it exists
    if (docPath) {
      let filePath;
      if (path.isAbsolute(docPath)) {
        filePath = docPath;
      } else {
        const backendRoot = process.cwd();
        const relativePath = docPath.startsWith('/') ? docPath.slice(1) : docPath;
        filePath = path.join(backendRoot, relativePath);
      }

      try {
        await fs.promises.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`Failed to delete document file ${filePath}:`, err);
        }
      }
    }

    res.json({ success: true, message: 'Identity document deleted successfully' });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) { }
    }
    console.error('deleteGuestDocument error:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── ADMIN: LIST ALL GUESTS (paginated, filterable) ──────────────────────────
export const listGuests = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '25', 10)));
  const offset = (page - 1) * limit;
  const q = (req.query.q || '').trim();
  const filter = req.query.filter || 'all'; // all | inhouse | checkedout | reserved | vip | blacklisted

  // Build WHERE clauses
  const whereClauses = [];
  const params = [];

  if (q.length >= 2) {
    const term = `%${q.toUpperCase()}%`;
    whereClauses.push(`(UPPER(g.full_name) LIKE ? OR g.phone LIKE ? OR UPPER(g.email) LIKE ? OR g.government_id LIKE ?)`);
    params.push(term, term, term, term);
  }

  if (filter === 'inhouse') {
    whereClauses.push(`EXISTS (SELECT 1 FROM bookings ab WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved'))`);
  } else if (filter === 'checkedout') {
    whereClauses.push(`EXISTS (SELECT 1 FROM bookings ab WHERE ab.guest_id = g.id AND ab.booking_status = 'Checked Out')`);
    whereClauses.push(`NOT EXISTS (SELECT 1 FROM bookings ab2 WHERE ab2.guest_id = g.id AND ab2.booking_status IN ('Checked In','Reserved'))`);
  } else if (filter === 'reserved') {
    whereClauses.push(`EXISTS (SELECT 1 FROM bookings ab WHERE ab.guest_id = g.id AND ab.booking_status = 'Reserved')`);
  } else if (filter === 'vip') {
    whereClauses.push(`g.loyalty_tier IN ('Gold','Platinum')`);
  } else if (filter === 'blacklisted') {
    whereClauses.push(`g.loyalty_tier = 'Blacklisted'`);
  }

  const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const [statsResult] = await pool.query(`
      SELECT 
        COUNT(g.id) as total,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM bookings ab WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved')) THEN 1 ELSE 0 END) as inhouse,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM bookings ab WHERE ab.guest_id = g.id AND ab.booking_status = 'Checked Out') AND NOT EXISTS (SELECT 1 FROM bookings ab2 WHERE ab2.guest_id = g.id AND ab2.booking_status IN ('Checked In','Reserved')) THEN 1 ELSE 0 END) as checkedout,
        SUM(CASE WHEN g.loyalty_tier IN ('Gold','Platinum') THEN 1 ELSE 0 END) as vip,
        SUM(CASE WHEN g.loyalty_tier = 'Blacklisted' THEN 1 ELSE 0 END) as blacklisted,
        SUM(CASE WHEN DATE(g.created_at) = CURDATE() THEN 1 ELSE 0 END) as new_today
      FROM guests g
    `);
    const stats = statsResult[0];

    // Total count
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(DISTINCT g.id) AS total FROM guests g ${whereSQL}`,
      params
    );

    // Page of results
    const [guests] = await pool.query(
      `SELECT
         g.id, g.full_name, g.phone, g.email, g.address, g.gst_no, g.pincode, g.country,
         g.arrival_from, g.departure_to,
         g.government_id, g.id_type, g.gender, g.age,
         g.id_verification_status,
         g.loyalty_tier, g.loyalty_points,
         g.created_at, g.updated_at,
         COUNT(b.id)                                                 AS total_bookings,
         COALESCE(SUM(b.total_amount), 0)                           AS lifetime_spend,
         MAX(b.created_at)                                          AS last_booking_at,
         (SELECT r.number FROM bookings ab JOIN rooms r ON ab.room_id = r.id
          WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved') LIMIT 1) AS current_room,
         (SELECT ab.booking_status FROM bookings ab
          WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved') LIMIT 1) AS current_status,
         (SELECT ab.booking_number FROM bookings ab
          WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved') LIMIT 1) AS current_booking_number
       FROM guests g
       LEFT JOIN bookings b ON b.guest_id = g.id
       ${whereSQL}
       GROUP BY g.id
       ORDER BY last_booking_at DESC, g.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      guests,
      stats,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
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
  const term = `%${q.trim().toUpperCase()}%`;
  try {
    const [guests] = await pool.query(`
      SELECT 
        g.id, g.full_name, g.phone, g.email, g.loyalty_tier, g.loyalty_points,
        g.id_verification_status,
        COUNT(b.id) as total_bookings,
        MAX(b.created_at) as last_booking_at,
        (SELECT r.number FROM bookings ab JOIN rooms r ON ab.room_id = r.id 
         WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved') LIMIT 1) as current_room,
        (SELECT ab.booking_status FROM bookings ab 
         WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved') LIMIT 1) as current_status
      FROM guests g
      LEFT JOIN bookings b ON b.guest_id = g.id
      WHERE UPPER(g.full_name) LIKE ? OR g.phone LIKE ?
      GROUP BY g.id
      ORDER BY MAX(b.created_at) DESC
      LIMIT 20
    `, [term, term]);
    res.json({ guests });
  } catch (error) {
    console.error('searchGuests error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ─── RECEPTION STAFF: GUEST SEARCH (name / phone / email / booking number) ───
// Available to any authenticated staff — no requireAdmin.
// Returns all guests (in-house, checked-out, reserved) across all history.
export const searchGuestsStaff = async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }
  const term = `%${q.trim().toUpperCase()}%`;
  const termRaw = `%${q.trim()}%`;          // for booking_number (case-sensitive in some engines)
  try {
    // First try: match by booking number — find the guest via their booking
    const [byBooking] = await pool.query(`
      SELECT DISTINCT g.id
      FROM guests g
      JOIN bookings b ON b.guest_id = g.id
      WHERE UPPER(b.booking_number) LIKE ?
    `, [term]);
    const bookingGuestIds = byBooking.map(r => r.id);

    // Main search: by name, phone, email — plus any guest_ids from booking match
    const idPlaceholders = bookingGuestIds.length > 0
      ? `OR g.id IN (${bookingGuestIds.map(() => '?').join(',')})`
      : '';

    const queryParams = [term, termRaw, termRaw, ...bookingGuestIds];

    const [guests] = await pool.query(`
      SELECT 
        g.id,
        g.full_name,
        g.phone,
        g.email,
        g.loyalty_tier,
        g.loyalty_points,
        g.id_verification_status,
        COUNT(DISTINCT b.id)  AS total_bookings,
        MAX(b.created_at)     AS last_booking_at,
        -- current room / status if currently in-house
        (SELECT r.number FROM bookings ab
          JOIN rooms r ON ab.room_id = r.id
          WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved')
          ORDER BY ab.check_in_date DESC LIMIT 1) AS current_room,
        (SELECT ab.booking_status FROM bookings ab
          WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved')
          ORDER BY ab.check_in_date DESC LIMIT 1) AS current_status,
        -- most recent booking summary
        (SELECT ab.booking_number FROM bookings ab
          WHERE ab.guest_id = g.id
          ORDER BY ab.created_at DESC LIMIT 1) AS last_booking_number,
        (SELECT ab.booking_status FROM bookings ab
          WHERE ab.guest_id = g.id
          ORDER BY ab.created_at DESC LIMIT 1) AS last_booking_status,
        (SELECT ab.check_in_date FROM bookings ab
          WHERE ab.guest_id = g.id
          ORDER BY ab.created_at DESC LIMIT 1) AS last_check_in,
        (SELECT ab.check_out_date FROM bookings ab
          WHERE ab.guest_id = g.id
          ORDER BY ab.created_at DESC LIMIT 1) AS last_check_out
      FROM guests g
      LEFT JOIN bookings b ON b.guest_id = g.id
      WHERE UPPER(g.full_name) LIKE ?
         OR g.phone             LIKE ?
         OR UPPER(g.email)      LIKE ?
         ${idPlaceholders}
      GROUP BY g.id
      ORDER BY
        CASE WHEN g.id IN (
          SELECT ab.guest_id FROM bookings ab WHERE ab.booking_status IN ('Checked In','Reserved')
        ) THEN 0 ELSE 1 END,
        MAX(b.created_at) DESC
      LIMIT 30
    `, queryParams);

    res.json({ guests });
  } catch (error) {
    console.error('searchGuestsStaff error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


