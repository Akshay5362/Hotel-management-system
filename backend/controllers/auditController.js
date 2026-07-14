import pool from '../db.js';

export const getStatus = async (req, res) => {
  try {
    const [settings] = await pool.query('SELECT * FROM system_settings');
    const settingsMap = {};
    settings.forEach(s => {
      settingsMap[s.key_name] = s.value_val;
    });

    const systemDate = settingsMap['system_date'] || '11-Jul-2026';
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
