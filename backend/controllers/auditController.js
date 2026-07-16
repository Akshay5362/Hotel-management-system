import pool from '../db.js';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Convert a stored date like "14-Jul-2026" → JS Date (midnight UTC) */
function parsePmsDate(dateStr) {
  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const parts = (dateStr || '').split('-'); // ['14','Jul','2026']
  if (parts.length !== 3) return null;
  return new Date(Date.UTC(parseInt(parts[2]), months[parts[1]], parseInt(parts[0])));
}

/** Format a JS Date → "16-Jul-2026" style */
function formatPmsDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const mon  = months[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mon}-${yyyy}`;
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
async function autoAdvanceToToday(connection) {
  const [settings] = await connection.query('SELECT * FROM system_settings');
  const settingsMap = {};
  settings.forEach(s => { settingsMap[s.key_name] = s.value_val; });

  const storedDate = parsePmsDate(settingsMap['system_date']);
  if (!storedDate) return;

  // Today at midnight UTC (Indian time is UTC+5:30 — use getUTC methods after offset)
  const nowIST     = new Date(Date.now() + 5.5 * 60 * 60 * 1000); // shift to IST
  const todayUTC   = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()));

  if (storedDate >= todayUTC) return; // already current — nothing to do

  let current = storedDate;

  while (current < todayUTC) {
    const next     = addDay(current);
    const nextStr  = formatPmsDate(next);

    // Get all currently occupied rooms
    const [occupiedRooms] = await connection.query(`
      SELECT r.number, r.id, rt.base_rate as rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.status = 'occupied'
    `);

    for (const room of occupiedRooms) {
      const tariff = room.rate;
      const taxes  = Math.round(tariff * 0.12);

      const [bookings] = await connection.query(
        "SELECT id FROM bookings WHERE room_id = ? AND booking_status = 'Checked In'",
        [room.id]
      );
      const bookingId = bookings[0]?.id || null;

      // Only post if we haven't already posted for this date (avoid duplicates on repeated calls)
      const [existing] = await connection.query(
        "SELECT id FROM ledger_items WHERE room_number = ? AND business_date = ? AND `desc` LIKE 'Room Tariff%Rollover%'",
        [room.number, nextStr]
      );
      if (existing.length === 0) {
        await connection.query(
          'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
          [room.number, 'Room Tariff Charge (Rollover)', tariff, nextStr, bookingId]
        );
        await connection.query(
          'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
          [room.number, 'Taxes & GST (12%)', taxes, nextStr, bookingId]
        );
      }
    }

    await connection.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'",
      [nextStr]
    );
    await connection.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'continued_rooms'",
      [String(occupiedRooms.length)]
    );
    // Reset daily counters for the new date
    await connection.query("UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkins'");
    await connection.query("UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkouts'");

    // Audit log entry for auto rollover
    await connection.query(
      "INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (NULL, 'AUTO_DAY_ROLLOVER', ?, ?)",
      [`System auto-advanced business date to ${nextStr}`, nextStr]
    );

    current = next;
    console.log(`[AutoRollover] Business date advanced to ${nextStr}`);
  }
}

export const getStatus = async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── Auto-advance date to today if behind ──────────────────────────────────
    await autoAdvanceToToday(connection);
    await connection.commit();
    connection.release();
    connection = null;

    const [settings] = await pool.query('SELECT * FROM system_settings');
    const settingsMap = {};
    settings.forEach(s => {
      settingsMap[s.key_name] = s.value_val;
    });

    const systemDate = settingsMap['system_date'] || formatPmsDate(new Date());
    const todayCheckins = parseInt(settingsMap['today_checkins'] || '0', 10);
    const todayCheckouts = parseInt(settingsMap['today_checkouts'] || '0', 10);
    const continuedRooms = parseInt(settingsMap['continued_rooms'] || '0', 10);

    const [rooms] = await pool.query(`
      SELECT r.id, r.number, r.status, rt.code as type, rt.base_rate as rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
    `);

    // Query active bookings (Checked In or Reserved)
    const [activeBookings] = await pool.query(`
      SELECT 
        b.id as booking_id,
        b.booking_number,
        b.room_id,
        b.check_in_date as checkInDate,
        b.expected_check_out_date as expectedCheckOutDate,
        b.adults,
        b.children,
        b.advance_amount as deposit,
        b.booking_status,
        g.full_name as guestName,
        g.phone,
        g.address,
        g.gst_no,
        g.pincode,
        g.country,
        g.arrival_from,
        g.departure_to,
        g.user_id
      FROM bookings b
      JOIN guests g ON b.guest_id = g.id
      WHERE b.booking_status IN ('Checked In', 'Reserved')
    `);

    // Query upcoming future reservations (Reserved only, check_in_date is in future relative to system date)
    // We do a simple string comparison since dates are stored in YYYY-MM-DD ISO format from the guest portal
    const [futureReservations] = await pool.query(`
      SELECT 
        b.id as booking_id,
        b.booking_number,
        b.room_id,
        b.check_in_date as checkInDate,
        b.expected_check_out_date as expectedCheckOutDate,
        b.adults,
        b.total_amount as totalAmount,
        b.advance_amount as deposit,
        b.booking_status,
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

    const [ledgerItems] = await pool.query('SELECT * FROM ledger_items');
    const ledgerMap = {};
    ledgerItems.forEach(item => {
      if (!ledgerMap[item.room_number]) {
        ledgerMap[item.room_number] = [];
      }
      ledgerMap[item.room_number].push({
        id: item.id,
        desc: item.desc,
        qty: item.qty,
        amount: item.amount
      });
    });

    const processedRooms = rooms.map(r => {
      const activeBooking = activeBookings.find(b => b.room_id === r.id);
      return {
        id: r.id,
        number: r.number,
        type: r.type,
        status: r.status,
        rate: r.rate,
        guestName: activeBooking ? activeBooking.guestName.toUpperCase() : '',
        phone: activeBooking ? activeBooking.phone : '',
        pax: activeBooking ? (activeBooking.adults + activeBooking.children) : 0,
        deposit: activeBooking ? activeBooking.deposit : 0,
        checkInDate: activeBooking ? activeBooking.checkInDate : '',
        expectedCheckOutDate: activeBooking ? (activeBooking.expectedCheckOutDate || '') : '',
        address: activeBooking ? (activeBooking.address || '') : '',
        gst_no: activeBooking ? (activeBooking.gst_no || '') : '',
        pincode: activeBooking ? (activeBooking.pincode || '') : '',
        country: activeBooking ? (activeBooking.country || '') : '',
        arrival_from: activeBooking ? (activeBooking.arrival_from || '') : '',
        departure_to: activeBooking ? (activeBooking.departure_to || '') : '',
        user_id: activeBooking ? activeBooking.user_id : null,
        booking_id: activeBooking ? activeBooking.booking_id : null,
        booking_number: activeBooking ? activeBooking.booking_number : null,
        ledger: ledgerMap[r.number] || []
      };
    });

    const [cashLog] = await pool.query('SELECT * FROM cash_logs WHERE business_date = ?', [systemDate]);

    res.json({
      systemDate,
      todayCheckins,
      todayCheckouts,
      continuedRooms,
      rooms: processedRooms,
      cashLog,
      upcomingReservations: futureReservations
    });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) {}
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

    const [occupiedRooms] = await connection.query(`
      SELECT r.*, rt.base_rate as rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.status = 'occupied'
    `);

    for (const room of occupiedRooms) {
      const tariff = room.rate;
      const taxes = Math.round(tariff * 0.12);

      // Find active booking for the room
      const [bookings] = await connection.query(
        "SELECT id FROM bookings WHERE room_id = ? AND booking_status = 'Checked In'",
        [room.id]
      );
      const bookingId = bookings[0]?.id || null;

      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
        [room.number, 'Room Tariff Charge (Rollover)', tariff, nextDate, bookingId]
      );
      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
        [room.number, 'Taxes & GST (12%)', taxes, nextDate, bookingId]
      );
    }

    await connection.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'",
      [nextDate]
    );

    await connection.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'continued_rooms'",
      [String(occupiedRooms.length)]
    );

    await connection.query(
      "UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkins'"
    );
    await connection.query(
      "UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkouts'"
    );
    // Insert Audit Log entry
    const auditorId = req.user?.id || null;
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'DAY_END', ?, ?)`,
      [auditorId, `Night audit run. Business date rolled to ${nextDate}.`, nextDate]
    );

    await connection.commit();
    res.json({ message: `Night audit complete. Business date rolled to ${nextDate}` });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
    }
    console.error('Error in runDayEnd controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) {
      connection.release();
    }
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

    // Combine all request types
    const allRequests = [
      ...serviceItems.map(r => ({ ...r, id: `svc_${r.id}` })),
      ...maintenanceItems.map(r => ({ ...r, id: `mnt_${r.id}` })),
      ...checkoutRequests.map(r => ({ ...r, id: `co_${r.id}` }))
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
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('resolveGuestRequest error:', error);
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
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('Error verifying guest document:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

