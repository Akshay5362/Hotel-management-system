import pool from '../db.js';
import fs from 'fs';
import path from 'path';
import { extractOCRData, verifyDocumentData } from '../services/ocrService.js';

// Helper to format time (e.g. 09:30 AM)
function formatTime(date) {
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 should be 12
  return `${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
}

export const checkIn = async (req, res) => {
  const { number } = req.params;
  const { guestName, phone, pax, deposit, checkInDate } = req.body;

  // Input Validation
  if (!number || typeof number !== 'string' || number.trim() === '') {
    return res.status(400).json({ error: 'Room number is required' });
  }
  if (!guestName || typeof guestName !== 'string' || guestName.trim() === '') {
    return res.status(400).json({ error: 'Guest name is required' });
  }
  const parsedPax = parseInt(pax, 10);
  if (isNaN(parsedPax) || parsedPax <= 0) {
    return res.status(400).json({ error: 'Pax must be a positive integer' });
  }
  const parsedDeposit = parseInt(deposit, 10);
  if (isNaN(parsedDeposit) || parsedDeposit < 0) {
    return res.status(400).json({ error: 'Deposit must be a non-negative integer' });
  }
  if (phone && phone.length > 50) {
    return res.status(400).json({ error: 'Phone number cannot exceed 50 characters' });
  }

  // Obtain user ID from authenticated request context
  const resolvedUserId = req.user?.id || null;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Check if room exists and is vacant or booked
    const [roomRows] = await connection.query(`
      SELECT r.*, rt.base_rate as rate, rt.code as type
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.number = ?
    `, [number]);
    if (roomRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `Room ${number} not found` });
    }

    const room = roomRows[0];
    if (room.status !== 'vacant' && room.status !== 'booked') {
      await connection.rollback();
      return res.status(400).json({ error: `Room ${number} is not vacant or booked` });
    }

    const guestNameUpper = guestName.trim().toUpperCase();
    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    let guestId;
    let bookingId;

    if (room.status === 'booked') {
      // Find pre-existing Reserved booking
      const [bookingRows] = await connection.query(
        "SELECT * FROM bookings WHERE room_id = ? AND booking_status = 'Reserved'",
        [room.id]
      );
      if (bookingRows.length > 0) {
        const booking = bookingRows[0];
        guestId = booking.guest_id;
        bookingId = booking.id;

        // Update booking details to Checked In
        await connection.query(
          `UPDATE bookings 
           SET booking_status = 'Checked In', check_in_date = ?, advance_amount = ?, adults = ?
           WHERE id = ?`,
          [checkInDate || businessDate, parsedDeposit, parsedPax, bookingId]
        );
      }
    }

    if (!bookingId) {
      // Create or select guest profile
      const [guestRows] = await connection.query('SELECT id FROM guests WHERE full_name = ? AND phone = ?', [guestNameUpper, phone || '']);
      if (guestRows.length > 0) {
        guestId = guestRows[0].id;
      } else {
        const [newGuestRes] = await connection.query(
          'INSERT INTO guests (full_name, phone) VALUES (?, ?)',
          [guestNameUpper, phone || '']
        );
        guestId = newGuestRes.insertId;
      }

      // Create Checked In booking
      const bookingNumber = 'BKG-' + Math.floor(100000 + Math.random() * 900000);
      const [newBookingRes] = await connection.query(
        `INSERT INTO bookings (booking_number, guest_id, room_id, check_in_date, adults, booking_status, payment_status, total_amount, advance_amount, created_by)
         VALUES (?, ?, ?, ?, ?, 'Checked In', 'Partial', ?, ?, ?)`,
        [bookingNumber, guestId, room.id, checkInDate || businessDate, parsedPax, room.rate, parsedDeposit, resolvedUserId]
      );
      bookingId = newBookingRes.insertId;

      // Add initial ledger entries (Room Tariff Charge and Taxes)
      const tariffAmount = room.rate;
      const taxesAmount = Math.round(tariffAmount * 0.12);

      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
        [number, 'Room Tariff Charge', tariffAmount, businessDate, bookingId]
      );
      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
        [number, 'Taxes & GST (12%)', taxesAmount, businessDate, bookingId]
      );
    }

    // Insert cash log transaction if deposit paid
    if (parsedDeposit > 0) {
      const timeStr = formatTime(new Date());
      await connection.query(
        `INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
         VALUES (?, ?, ?, 'Advance Deposit', ?, ?, ?)`,
        [timeStr, number, guestNameUpper, parsedDeposit, businessDate, bookingId]
      );

      // Log Payment transaction
      await connection.query(
        `INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
         VALUES (?, ?, 'Cash', 'Advance Deposit', ?)`,
        [bookingId, parsedDeposit, businessDate]
      );
    }

    // Update Room Status History
    await connection.query(
      `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
       VALUES (?, ?, 'occupied', ?, ?)`,
      [room.id, room.status, resolvedUserId, businessDate]
    );

    // Insert Audit Log entry
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'CHECK_IN', ?, ?)`,
      [resolvedUserId, `Checked in guest ${guestNameUpper} into Room ${number}. Booking ID: ${bookingId}`, businessDate]
    );

    // Update room status to occupied
    await connection.query(
      `UPDATE rooms SET status = 'occupied' WHERE id = ?`,
      [room.id]
    );

    // Increment todayCheckins count
    await connection.query(
      `UPDATE system_settings 
       SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR)
       WHERE key_name = 'today_checkins'`
    );

    await connection.commit();
    res.json({ message: `Successfully checked in to Room ${number}` });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
    }
    console.error('Error during checkin controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

export const checkOut = async (req, res) => {
  const { number } = req.params;
  const { balancePaid } = req.body;

  if (!number || typeof number !== 'string' || number.trim() === '') {
    return res.status(400).json({ error: 'Room number is required' });
  }

  const parsedBalancePaid = parseInt(balancePaid, 10);
  if (isNaN(parsedBalancePaid)) {
    return res.status(400).json({ error: 'Balance paid must be a valid integer' });
  }

  // Obtain user ID from authenticated request context
  const resolvedUserId = req.user?.id || null;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [roomRows] = await connection.query(`
      SELECT r.*, rt.base_rate as rate, rt.code as type
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.number = ?
    `, [number]);
    if (roomRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `Room ${number} not found` });
    }

    const room = roomRows[0];
    if (room.status !== 'occupied') {
      await connection.rollback();
      return res.status(400).json({ error: `Room ${number} is not occupied` });
    }

    // Fetch active Checked In booking
    const [bookingRows] = await connection.query(
      `SELECT b.*, g.full_name as guestName FROM bookings b
       JOIN guests g ON b.guest_id = g.id
       WHERE b.room_id = ? AND b.booking_status = 'Checked In'`,
      [room.id]
    );

    if (bookingRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `No active Checked In booking found for Room ${number}` });
    }

    const activeBooking = bookingRows[0];

    // Fetch system settings for business date
    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    // Insert cash log transaction if there's any transaction amount
    if (parsedBalancePaid !== 0) {
      const timeStr = formatTime(new Date());
      const transactionType = parsedBalancePaid > 0 ? 'Checkout Settlement' : 'Checkout Refund';
      await connection.query(
        `INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [timeStr, number, activeBooking.guestName, transactionType, Math.abs(parsedBalancePaid), businessDate, activeBooking.id]
      );

      // Log Payment transaction
      await connection.query(
        `INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
         VALUES (?, ?, 'Cash', ?, ?)`,
        [activeBooking.id, Math.abs(parsedBalancePaid), transactionType, businessDate]
      );
    }

    // Update booking status to Checked Out
    const finalPaymentStatus = (activeBooking.advance_amount + parsedBalancePaid >= activeBooking.total_amount) ? 'Paid' : 'Partial';
    await connection.query(
      `UPDATE bookings 
       SET booking_status = 'Checked Out', payment_status = ?, check_out_date = ?
       WHERE id = ?`,
      [finalPaymentStatus, businessDate, activeBooking.id]
    );

    // Update Room Status History
    await connection.query(
      `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
       VALUES (?, 'occupied', 'dirty', ?, ?)`,
      [room.id, resolvedUserId, businessDate]
    );

    // Insert Audit Log entry
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'CHECK_OUT', ?, ?)`,
      [resolvedUserId, `Checked out Room ${number}. Booking ID: ${activeBooking.id}. Balance paid: ₹${parsedBalancePaid}`, businessDate]
    );

    // Update room status to dirty
    await connection.query(
      `UPDATE rooms SET status = 'dirty' WHERE id = ?`,
      [room.id]
    );

    // Log CHECKED_OUT event in booking_history
    await connection.query(
      `INSERT INTO booking_history (booking_id, action, old_room_id, new_room_id, changed_by, business_date, notes)
       VALUES (?, 'CHECKED_OUT', ?, ?, ?, ?, ?)`,
      [activeBooking.id, room.id, room.id, resolvedUserId, businessDate,
       `Checkout settled. Balance paid: ₹${parsedBalancePaid}. Payment status: ${finalPaymentStatus}.`]
    );

    // Notify the guest about checkout completion and request feedback
    // Fetch the guest's user_id so we can send them a notification
    const [guestUserRows] = await connection.query(
      `SELECT g.user_id FROM guests g WHERE g.id = ?`,
      [activeBooking.guest_id]
    );
    const guestUserId = guestUserRows[0]?.user_id;
    if (guestUserId) {
      await connection.query(
        `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
        [guestUserId,
         '🏨 Thank You for Staying With Us!',
         `Your checkout from Room ${number} is complete. We hope you had a wonderful stay! Please take a moment to share your experience — your feedback helps us serve you better.`]
      );
    }

    // Increment todayCheckouts count
    await connection.query(
      `UPDATE system_settings 
       SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR)
       WHERE key_name = 'today_checkouts'`
    );

    await connection.commit();
    res.json({ message: `Successfully checked out Room ${number}` });

  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
    }
    console.error('Error during checkout controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

export const clean = async (req, res) => {
  const { number } = req.params;

  if (!number || typeof number !== 'string' || number.trim() === '') {
    return res.status(400).json({ error: 'Room number is required' });
  }

  // Obtain operator user id
  const operatorId = req.user?.id || null;

  try {
    const [roomRows] = await pool.query(`
      SELECT r.id, r.status
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.number = ?
    `, [number]);
    if (roomRows.length === 0) {
      return res.status(404).json({ error: `Room ${number} not found` });
    }

    const room = roomRows[0];
    if (room.status !== 'dirty') {
      return res.status(400).json({ error: `Room ${number} is not dirty` });
    }

    // Get current business date
    const [settings] = await pool.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    // Log Room Status History
    await pool.query(
      `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
       VALUES (?, 'dirty', 'vacant', ?, ?)`,
      [room.id, operatorId, businessDate]
    );

    // Insert Audit Log entry
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'CLEAN_ROOM', ?, ?)`,
      [operatorId, `Marked Room ${number} as Clean and vacant.`, businessDate]
    );

    await pool.query(
      `UPDATE rooms SET status = 'vacant' WHERE id = ?`,
      [room.id]
    );

    res.json({ message: `Room ${number} marked as CLEAN and vacant` });
  } catch (error) {
    console.error('Error during cleaning controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const addLedgerItem = async (req, res) => {
  const { number } = req.params;
  const { desc, amount } = req.body;

  const parsedAmount = parseInt(amount, 10);
  if (!desc || typeof desc !== 'string' || desc.trim() === '' || isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Invalid charge description or amount' });
  }

  try {
    const [rooms] = await pool.query(`
      SELECT r.id, r.status
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.number = ?
    `, [number]);
    if (rooms.length === 0 || rooms[0].status !== 'occupied') {
      return res.status(400).json({ error: 'Charges can only be posted to occupied rooms' });
    }

    const room = rooms[0];

    // Find the active checkin booking ID
    const [bookings] = await pool.query(
      "SELECT id FROM bookings WHERE room_id = ? AND booking_status = 'Checked In'",
      [room.id]
    );
    const bookingId = bookings[0]?.id || null;

    // Get current business date
    const [settings] = await pool.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    await pool.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
      [number, desc.trim(), parsedAmount, businessDate, bookingId]
    );

    res.json({ message: `Posted ${desc} of ₹${parsedAmount} to Room ${number}` });
  } catch (error) {
    console.error('Error posting ledger charge controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const shift = async (req, res) => {
  const { fromRoomNumber, toRoomNumber } = req.body;

  if (!fromRoomNumber || !toRoomNumber) {
    return res.status(400).json({ error: 'Source and target room numbers are required' });
  }

  // Obtain operator user id
  const resolvedUserId = req.user?.id || null;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [fromRooms] = await connection.query(`
      SELECT r.*, rt.base_rate as rate, rt.code as type
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.number = ?
    `, [fromRoomNumber]);
    if (fromRooms.length === 0 || fromRooms[0].status !== 'occupied') {
      await connection.rollback();
      return res.status(400).json({ error: `Source Room ${fromRoomNumber} is not occupied` });
    }
    const sourceRoom = fromRooms[0];

    const [toRooms] = await connection.query(`
      SELECT r.*, rt.base_rate as rate, rt.code as type
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.number = ?
    `, [toRoomNumber]);
    if (toRooms.length === 0 || toRooms[0].status !== 'vacant') {
      await connection.rollback();
      return res.status(400).json({ error: `Target Room ${toRoomNumber} is not vacant` });
    }
    const targetRoom = toRooms[0];

    // Find the active check-in booking
    const [bookings] = await connection.query(
      "SELECT * FROM bookings WHERE room_id = ? AND booking_status = 'Checked In'",
      [sourceRoom.id]
    );
    if (bookings.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: `No active checkin found for Room ${fromRoomNumber}` });
    }
    const booking = bookings[0];

    // Get current business date
    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    // Update booking room_id
    await connection.query(
      "UPDATE bookings SET room_id = ? WHERE id = ?",
      [targetRoom.id, booking.id]
    );

    // Update room statuses
    await connection.query("UPDATE rooms SET status = 'occupied' WHERE id = ?", [targetRoom.id]);
    await connection.query("UPDATE rooms SET status = 'vacant' WHERE id = ?", [sourceRoom.id]);

    // Delete current business date's tariff/tax from source room
    await connection.query(
      `DELETE FROM ledger_items 
       WHERE room_number = ? AND business_date = ? AND (\`desc\` LIKE '%Tariff%' OR \`desc\` LIKE '%Taxes%')`,
      [fromRoomNumber, businessDate]
    );

    // Move all ledger items of this booking to the target room number
    await connection.query(
      'UPDATE ledger_items SET room_number = ? WHERE booking_id = ?',
      [toRoomNumber, booking.id]
    );

    // Insert target room's tariff and taxes for the current business date
    const targetTariff = targetRoom.rate;
    const targetTaxes = Math.round(targetTariff * 0.12);

    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
      [toRoomNumber, `Room Tariff (${targetRoom.type})`, targetTariff, businessDate, booking.id]
    );
    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
      [toRoomNumber, 'Taxes & GST (12%)', targetTaxes, businessDate, booking.id]
    );

    // Log Room Status History for source room
    await connection.query(
      `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
       VALUES (?, 'occupied', 'vacant', ?, ?)`,
      [sourceRoom.id, resolvedUserId, businessDate]
    );

    // Log Room Status History for target room
    await connection.query(
      `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
       VALUES (?, 'vacant', 'occupied', ?, ?)`,
      [targetRoom.id, resolvedUserId, businessDate]
    );

    // Insert Audit Log entry
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'SHIFT_ROOM', ?, ?)`,
      [resolvedUserId, `Shifted guest reservation (Booking ID: ${booking.id}) from Room ${fromRoomNumber} to ${toRoomNumber}`, businessDate]
    );

    await connection.commit();
    res.json({ message: `Successfully shifted guest from Room ${fromRoomNumber} to ${toRoomNumber}` });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
    }
    console.error('Error during room shifting controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

export const bookRoom = async (req, res) => {
  const { number } = req.params;
  const { 
    guestName, 
    phone, 
    email,
    gender,
    age,
    idType,
    governmentId,
    pax, 
    deposit, 
    checkInDate,
    checkOutDate,
    userId, 
    extraGuests, 
    extraServices 
  } = req.body;

  // Input Validation
  if (!number || typeof number !== 'string' || number.trim() === '') {
    return res.status(400).json({ error: 'Room number is required' });
  }
  if (!guestName || typeof guestName !== 'string' || guestName.trim() === '') {
    return res.status(400).json({ error: 'Guest name is required' });
  }
  const parsedPax = parseInt(pax, 10);
  if (isNaN(parsedPax) || parsedPax <= 0) {
    return res.status(400).json({ error: 'Pax must be a positive integer' });
  }
  const parsedDeposit = parseInt(deposit, 10);
  if (isNaN(parsedDeposit) || parsedDeposit < 0) {
    return res.status(400).json({ success: false, message: 'Deposit must be a non-negative integer' });
  }

  // Strict Document Validation
  const val = (governmentId || '').trim();
  let docError = null;
  if (!idType || !val) {
    docError = 'ID Type and Document Number are required';
  } else if (idType === 'Aadhaar Card') {
    if (!/^\d{12}$/.test(val)) docError = 'Aadhaar must be exactly 12 numeric digits.';
  } else if (idType === 'Passport') {
    if (!/^[A-Z]\d{7}$/.test(val)) docError = 'Passport must be 1 uppercase letter followed by 7 digits.';
  } else if (idType === 'Voter ID') {
    if (!/^[A-Z]{3}\d{7}$/.test(val)) docError = 'Voter ID must be 3 uppercase letters followed by 7 digits.';
  } else if (idType === 'Driving Licence') {
    const cleanDL = val.replace(/[- ]/g, '');
    if (!/^[A-Z]{2}\d{2}(19|20)\d{2}\d{7}$/.test(cleanDL)) {
      docError = 'Driving Licence must match standard format (e.g. DL0420101234567).';
    }
  } else {
    docError = 'Invalid Document Type.';
  }

  if (docError) {
    return res.status(400).json({ success: false, message: 'Validation Failed', errors: { governmentId: docError } });
  }

  const { idDocumentPath, idOcrText } = req.body;
  // Document upload is optional — guest may show ID offline at reception.
  // If no document is uploaded, id_verification_status is set to 'Offline' below.


  // Obtain user ID from authenticated request context
  const resolvedUserId = req.user?.id || userId;
  const parsedUserId = parseInt(resolvedUserId, 10);
  if (isNaN(parsedUserId)) {
    return res.status(400).json({ error: 'User ID is required for guest booking' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Verify user exists first to prevent foreign key constraint violations
    const [userRows] = await connection.query('SELECT id FROM users WHERE id = ?', [parsedUserId]);
    if (userRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'User session expired or user not found. Please log in again.' });
    }

    const [roomRows] = await connection.query(`
      SELECT r.*, rt.base_rate as rate, rt.code as type
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.number = ?
    `, [number]);
    if (roomRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `Room ${number} not found` });
    }

    const room = roomRows[0];

    // Determine effective check-in and check-out dates for overlap detection
    // Dates from client are ISO format (YYYY-MM-DD); convert for comparison
    const newCheckIn = checkInDate ? new Date(checkInDate) : new Date();
    const newCheckOut = checkOutDate ? new Date(checkOutDate) : null;

    // Block if room is 'occupied' (guest physically present) or 'dirty' / 'inactive'
    if (room.status === 'occupied' || room.status === 'dirty' || room.status === 'inactive') {
      await connection.rollback();
      return res.status(400).json({ error: `Room ${number} is currently ${room.status} and cannot be booked` });
    }

    // If room is 'booked' or 'vacant': check for date overlap with existing Reserved/Checked-In bookings
    if (newCheckOut) {
      // Query existing active bookings for this room that overlap with new date range
      const [conflictRows] = await connection.query(`
        SELECT id, check_in_date, expected_check_out_date, booking_status
        FROM bookings
        WHERE room_id = ?
          AND booking_status IN ('Reserved', 'Checked In')
      `, [room.id]);

      for (const existing of conflictRows) {
        // Parse existing booking dates
        const existingCheckIn = existing.check_in_date ? new Date(existing.check_in_date) : null;
        const existingCheckOut = existing.expected_check_out_date ? new Date(existing.expected_check_out_date) : null;

        if (!existingCheckIn) continue;

        // Determine end bound for existing booking (use expected_check_out_date if set, else assume 1 night)
        const existingEnd = existingCheckOut || new Date(existingCheckIn.getTime() + 86400000);

        // Overlap check: [newCheckIn, newCheckOut) overlaps [existingCheckIn, existingEnd) iff
        // newCheckIn < existingEnd AND newCheckOut > existingCheckIn
        const hasOverlap = newCheckIn < existingEnd && newCheckOut > existingCheckIn;
        if (hasOverlap) {
          await connection.rollback();
          return res.status(400).json({
            error: `Room ${number} is already reserved from ${existing.check_in_date} to ${existing.expected_check_out_date || 'check-out date'}. Please choose different dates or another room.`
          });
        }
      }
    } else if (room.status === 'booked') {
      // No checkOutDate provided and room is booked – block to be safe
      await connection.rollback();
      return res.status(400).json({ error: `Room ${number} is already booked. Please provide your check-out date for us to verify availability.` });
    }

    const guestNameUpper = guestName.trim().toUpperCase();

    // Get or create guest profile linked to user_id
    const [guestRows] = await connection.query('SELECT id, loyalty_tier, loyalty_points FROM guests WHERE user_id = ?', [parsedUserId]);
    let guestId;
    let loyaltyTier = 'Bronze';
    let loyaltyPoints = 0;

    if (guestRows.length > 0) {
      guestId = guestRows[0].id;
      loyaltyTier = guestRows[0].loyalty_tier || 'Bronze';
      loyaltyPoints = guestRows[0].loyalty_points || 0;
      // Update their profile details.
      // id_verification_status: 'Pending' if document uploaded for OCR, 'Offline' if guest will show ID in person.
      const verificationStatus = idDocumentPath ? 'Pending' : 'Offline';
      await connection.query(
        `UPDATE guests 
         SET full_name = ?, phone = ?, email = ?, gender = ?, age = ?, id_type = ?, government_id = ?,
             id_document_path = ?, id_upload_timestamp = CASE WHEN ? IS NOT NULL AND ? != '' THEN NOW() ELSE id_upload_timestamp END,
             id_verification_status = ?, id_ocr_text = ?
         WHERE id = ?`,
        [guestNameUpper, phone || '', email || '', gender || '', age ? parseInt(age, 10) : null, idType || '', governmentId || '',
         idDocumentPath || null, idDocumentPath || null, idDocumentPath || null,
         verificationStatus, idOcrText || '', guestId]
      );
    } else {
      const newVerificationStatus = idDocumentPath ? 'Pending' : 'Offline';
      const [newGuestRes] = await connection.query(
        `INSERT INTO guests (full_name, phone, email, gender, age, id_type, government_id, id_document_path, id_upload_timestamp, id_verification_status, id_ocr_text, user_id, loyalty_tier, loyalty_points) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN NOW() ELSE NULL END, ?, ?, ?, 'Bronze', 0)`,
        [guestNameUpper, phone || '', email || '', gender || '', age ? parseInt(age, 10) : null, idType || '', governmentId || '',
         idDocumentPath || null, idDocumentPath || null,
         newVerificationStatus, idOcrText || '', parsedUserId]
      );
      guestId = newGuestRes.insertId;
    }

    // Get current business date
    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    // Calculate loyalty discount on room base rate
    let discountPercent = 0;
    if (loyaltyTier === 'Silver') discountPercent = 0.05;
    else if (loyaltyTier === 'Gold') discountPercent = 0.10;
    else if (loyaltyTier === 'Platinum') discountPercent = 0.15;

    const tariffAmount = room.rate;
    const loyaltyDiscountAmount = Math.round(tariffAmount * discountPercent);

    // Calculate extra services totals with loyalty perks
    let servicesTotal = 0;
    const servicesList = [];
    if (extraServices && typeof extraServices === 'object') {
      if (extraServices.breakfast) {
        // Free breakfast for Gold and Platinum tiers
        const isFree = (loyaltyTier === 'Gold' || loyaltyTier === 'Platinum');
        const amt = isFree ? 0 : (250 * parsedPax);
        servicesTotal += amt;
        servicesList.push({ 
          desc: isFree ? 'Extra Service: Buffet Breakfast (Complimentary Loyalty Perk)' : 'Extra Service: Buffet Breakfast', 
          amount: amt 
        });
      }
      if (extraServices.lunch) {
        const amt = 400 * parsedPax;
        servicesTotal += amt;
        servicesList.push({ desc: 'Extra Service: Executive Lunch', amount: amt });
      }
      if (extraServices.dinner) {
        const amt = 500 * parsedPax;
        servicesTotal += amt;
        servicesList.push({ desc: 'Extra Service: Gourmet Dinner', amount: amt });
      }
      if (extraServices.parking) {
        // Free secure parking for Platinum tier
        const isFree = (loyaltyTier === 'Platinum');
        const amt = isFree ? 0 : 150;
        servicesTotal += amt;
        servicesList.push({ 
          desc: isFree ? 'Extra Service: Secure Parking (Complimentary Loyalty Perk)' : 'Extra Service: Secure Parking', 
          amount: amt 
        });
      }
    }

    const netTariffAmount = tariffAmount; 
    const taxesAmount = Math.round((netTariffAmount - loyaltyDiscountAmount + servicesTotal) * 0.12);
    const bookingTotal = (netTariffAmount - loyaltyDiscountAmount) + taxesAmount + servicesTotal;

    // Create Reserved Booking
    const bookingNumber = 'BKG-' + Math.floor(100000 + Math.random() * 900000);
    const expectedCheckOutStr = checkOutDate || '';
    const [bookingRes] = await connection.query(
      `INSERT INTO bookings (booking_number, guest_id, room_id, check_in_date, expected_check_out_date, adults, booking_status, payment_status, total_amount, advance_amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'Reserved', ?, ?, ?, ?)`,
      [bookingNumber, guestId, room.id, checkInDate || businessDate, expectedCheckOutStr, parsedPax, parsedDeposit >= bookingTotal ? 'Paid' : 'Partial', bookingTotal, parsedDeposit, parsedUserId]
    );
    const bookingId = bookingRes.insertId;

    // Add initial ledger entries (Room Tariff Charge, Services, and Taxes)
    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
      [number, 'Room Tariff Charge', tariffAmount, businessDate, bookingId]
    );

    // Add negative loyalty discount ledger item if any
    if (loyaltyDiscountAmount > 0) {
      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
        [number, `Loyalty ${loyaltyTier} Discount (${discountPercent * 100}%)`, 1, -loyaltyDiscountAmount, businessDate, bookingId]
      );
    }

    // Add extra services to ledger
    for (const service of servicesList) {
      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
        [number, service.desc, service.amount, businessDate, bookingId]
      );
    }

    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
      [number, 'Taxes & GST (12%)', taxesAmount, businessDate, bookingId]
    );

    // Add extra guests as zero-charge ledger items to folio
    if (extraGuests && Array.isArray(extraGuests)) {
      for (const extra of extraGuests) {
        if (extra.name && extra.age) {
          const descStr = `Extra Guest: ${extra.name.trim().toUpperCase()} (Age: ${extra.age})`;
          await connection.query(
            'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, 0, ?, ?)',
            [number, descStr, businessDate, bookingId]
          );
        }
      }
    }

    // Insert cash log transaction if deposit paid
    if (parsedDeposit > 0) {
      const timeStr = formatTime(new Date());
      await connection.query(
        `INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
         VALUES (?, ?, ?, 'Advance Deposit', ?, ?, ?)`,
        [timeStr, number, guestNameUpper, parsedDeposit, businessDate, bookingId]
      );

      // Log Payment transaction
      await connection.query(
        `INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
         VALUES (?, ?, 'Cash', 'Advance Deposit', ?)`,
        [bookingId, parsedDeposit, businessDate]
      );
    }

    // Log Room Status History
    await connection.query(
      `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
       VALUES (?, 'vacant', 'booked', ?, ?)`,
      [room.id, parsedUserId, businessDate]
    );

    // Calculate points earned: 1 point for every ₹10 spent
    const pointsEarned = Math.round(bookingTotal / 10);
    const updatedPoints = loyaltyPoints + pointsEarned;

    // Determine new tier based on total points
    let updatedTier = 'Bronze';
    if (updatedPoints >= 3000) updatedTier = 'Platinum';
    else if (updatedPoints >= 1500) updatedTier = 'Gold';
    else if (updatedPoints >= 500) updatedTier = 'Silver';

    await connection.query(
      'UPDATE guests SET loyalty_points = ?, loyalty_tier = ? WHERE id = ?',
      [updatedPoints, updatedTier, guestId]
    );

    // Insert Audit Log entry with updated loyalty points
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'BOOK_ROOM', ?, ?)`,
      [parsedUserId, `Online reservation booked for Room ${number}. Booking ID: ${bookingId}. Earned ${pointsEarned} loyalty points (Total: ${updatedPoints}, Tier: ${updatedTier})`, businessDate]
    );

    // Update room status to 'booked' only if it was previously 'vacant'
    // If room was already 'booked' (for a non-overlapping future date), leave it as 'booked' — the first guest's booking already set that
    if (room.status === 'vacant') {
      await connection.query(
        "UPDATE rooms SET status = 'booked' WHERE id = ?",
        [room.id]
      );
    }

    await connection.commit();
    res.json({ 
      message: `Successfully booked Room ${number}`,
      bookingNumber,
      bookingId,
      loyalty: {
        pointsEarned,
        totalPoints: updatedPoints,
        tier: updatedTier
      }
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
    }
    console.error('Error during bookRoom controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

export const modifyCheckIn = async (req, res) => {
  const { number } = req.params;
  const { 
    guestName, 
    phone, 
    pax, 
    deposit, 
    checkInDate, 
    expectedCheckOutDate,
    address,
    gst_no,
    pincode,
    country,
    arrival_from,
    departure_to
  } = req.body;

  if (!number) {
    return res.status(400).json({ error: 'Room number is required' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [roomRows] = await connection.query(`
      SELECT id, status FROM rooms WHERE number = ?
    `, [number]);
    if (roomRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `Room ${number} not found` });
    }
    const room = roomRows[0];

    const [bookingRows] = await connection.query(`
      SELECT * FROM bookings 
      WHERE room_id = ? AND booking_status IN ('Checked In', 'Reserved')
      ORDER BY id DESC LIMIT 1
    `, [room.id]);

    if (bookingRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `No active booking found for Room ${number}` });
    }
    const booking = bookingRows[0];

    const guestNameUpper = guestName ? guestName.trim().toUpperCase() : '';
    if (guestNameUpper) {
      await connection.query(`
        UPDATE guests 
        SET full_name = ?, phone = ?, address = ?, gst_no = ?, pincode = ?, country = ?, arrival_from = ?, departure_to = ?
        WHERE id = ?
      `, [
        guestNameUpper, 
        phone || '', 
        address || '', 
        gst_no || '', 
        pincode || '', 
        country || '', 
        arrival_from || '', 
        departure_to || '', 
        booking.guest_id
      ]);
    }


    const parsedPax = pax ? parseInt(pax, 10) : booking.adults;
    const parsedDeposit = deposit !== undefined ? parseInt(deposit, 10) : booking.advance_amount;

    await connection.query(`
      UPDATE bookings 
      SET check_in_date = ?, expected_check_out_date = ?, adults = ?, advance_amount = ?
      WHERE id = ?
    `, [
      checkInDate || booking.check_in_date, 
      expectedCheckOutDate || booking.expected_check_out_date || '',
      parsedPax, 
      parsedDeposit,
      booking.id
    ]);

    const resolvedUserId = req.user?.id || null;
    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const systemDate = settings[0]?.value_val || '11-Jul-2026';

    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'MODIFY_CHECKIN', ?, ?)`,
      [resolvedUserId, `Modified check-in details for Room ${number}. Booking ID: ${booking.id}`, systemDate]
    );

    await connection.commit();
    res.json({ message: `Successfully modified check-in details for Room ${number}` });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
    }
    console.error('Error in modifyCheckIn controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// ─────────────────────────────────────────────────────────────
// GUEST PORTAL PHASE 2 — Guest-Facing Controllers
// ─────────────────────────────────────────────────────────────

/** Guest self check-in — auto-approves if today >= booking check_in_date */
export const guestRequestCheckIn = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Find the guest profile for this user
    const [guestRows] = await connection.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
    if (guestRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Guest profile not found' });
    }
    const guestId = guestRows[0].id;

    // Find their Reserved booking
    const [bookingRows] = await connection.query(
      `SELECT b.*, r.number as room_number, r.id as room_id_val
       FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.guest_id = ? AND b.booking_status = 'Reserved'
       ORDER BY b.id DESC LIMIT 1`,
      [guestId]
    );
    if (bookingRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'No upcoming reservation found' });
    }
    const booking = bookingRows[0];

    // ── Payment Guard: block self check-in if cash not yet confirmed ────────
    const [pendingPayment] = await connection.query(
      `SELECT id, amount, payment_method FROM payments
       WHERE booking_id    = ?
         AND payment_method = 'Cash'
         AND payment_status = 'Pending'
       LIMIT 1`,
      [booking.id]
    );
    if (pendingPayment.length > 0) {
      await connection.rollback();
      return res.status(403).json({
        error: 'Cash payment not yet confirmed.',
        message: `Your advance cash payment of ₹${pendingPayment[0].amount} has not been confirmed by the reception yet. Please visit the front desk with your cash, and once the staff confirms receipt your Check In will be enabled.`,
        code: 'CASH_PAYMENT_PENDING'
      });
    }

    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    // Update booking to Checked In
    await connection.query(
      "UPDATE bookings SET booking_status = 'Checked In' WHERE id = ?",
      [booking.id]
    );
    // Update room to occupied
    await connection.query(
      "UPDATE rooms SET status = 'occupied' WHERE id = ?",
      [booking.room_id_val]
    );
    // Log status history
    await connection.query(
      `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
       VALUES (?, 'booked', 'occupied', ?, ?)`,
      [booking.room_id_val, resolvedUserId, businessDate]
    );
    // Create welcome notification for guest
    await connection.query(
      `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
      [resolvedUserId, '🏨 Welcome to Hotel Sky-5!', `You have successfully checked in to Room ${booking.room_number}. Enjoy your stay! If you need anything, use your Guest Dashboard.`]
    );
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'GUEST_CHECKIN', ?, ?)`,
      [resolvedUserId, `Guest self check-in for Room ${booking.room_number}, Booking ID: ${booking.id}`, businessDate]
    );

    await connection.commit();
    res.json({ message: `Successfully checked in to Room ${booking.room_number}`, roomNumber: booking.room_number });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestRequestCheckIn error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

/** Guest adds a service request (room service / housekeeping) — creates ledger item + admin notification */
export const guestAddService = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  const { serviceDesc, amount, qty = 1 } = req.body;
  if (!serviceDesc || !amount) return res.status(400).json({ error: 'serviceDesc and amount are required' });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Get guest's active booking
    const [guestRows] = await connection.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
    if (guestRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
    const guestId = guestRows[0].id;

    const [bookingRows] = await connection.query(
      `SELECT b.*, r.number as room_number FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.guest_id = ? AND b.booking_status = 'Checked In'
       ORDER BY b.id DESC LIMIT 1`,
      [guestId]
    );
    if (bookingRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'No active stay found' }); }
    const booking = bookingRows[0];

    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    const parsedAmt = parseInt(amount, 10);
    const parsedQty = parseInt(qty, 10);

    // Insert ledger item
    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, ?, ?, ?, ?)',
      [booking.room_number, serviceDesc, parsedQty, parsedAmt * parsedQty, businessDate, booking.id]
    );
    // Notify guest
    await connection.query(
      'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [resolvedUserId, '✅ Service Requested', `Your request for "${serviceDesc}" has been received and will be delivered shortly.`]
    );

    await connection.commit();
    res.json({ message: 'Service request submitted successfully' });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestAddService error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

/** Guest reports a maintenance issue */
export const guestReportMaintenance = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  const { issue } = req.body;
  if (!issue || issue.trim() === '') return res.status(400).json({ error: 'Issue description is required' });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [guestRows] = await connection.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
    if (guestRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
    const guestId = guestRows[0].id;

    const [bookingRows] = await connection.query(
      `SELECT b.*, r.id as room_id_val, r.number as room_number FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.guest_id = ? AND b.booking_status = 'Checked In'
       ORDER BY b.id DESC LIMIT 1`,
      [guestId]
    );
    if (bookingRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'No active stay found' }); }
    const booking = bookingRows[0];

    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    await connection.query(
      `INSERT INTO maintenance (room_id, reported_by, issue, status, business_date) VALUES (?, ?, ?, 'Pending', ?)`,
      [booking.room_id_val, resolvedUserId, issue.trim(), businessDate]
    );
    await connection.query(
      'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [resolvedUserId, '🔧 Maintenance Report Received', `Your maintenance report for Room ${booking.room_number} has been logged. Our team will attend to it shortly.`]
    );

    await connection.commit();
    res.json({ message: 'Maintenance request submitted successfully' });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestReportMaintenance error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

/** Guest extends their checkout date */
export const guestExtendStay = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  const { newCheckOutDate } = req.body;
  if (!newCheckOutDate) return res.status(400).json({ error: 'newCheckOutDate is required' });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [guestRows] = await connection.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
    if (guestRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
    const guestId = guestRows[0].id;

    const [bookingRows] = await connection.query(
      `SELECT b.*, r.number as room_number FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.guest_id = ? AND b.booking_status = 'Checked In'
       ORDER BY b.id DESC LIMIT 1`,
      [guestId]
    );
    if (bookingRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'No active stay found' }); }
    const booking = bookingRows[0];

    // Validate new date is after existing check-out
    const existingOut = new Date(booking.expected_check_out_date);
    const newOut = new Date(newCheckOutDate);
    if (newOut <= existingOut) {
      await connection.rollback();
      return res.status(400).json({ error: 'New checkout date must be after the current checkout date' });
    }

    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    await connection.query(
      'UPDATE bookings SET expected_check_out_date = ? WHERE id = ?',
      [newCheckOutDate, booking.id]
    );
    await connection.query(
      'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [resolvedUserId, '📅 Stay Extended!', `Your checkout has been extended to ${new Date(newCheckOutDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}. Enjoy your extended stay at Hotel Sky-5!`]
    );
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'EXTEND_STAY', ?, ?)`,
      [resolvedUserId, `Guest extended stay for Room ${booking.room_number} to ${newCheckOutDate}, Booking ID: ${booking.id}`, businessDate]
    );

    await connection.commit();
    res.json({ message: `Stay extended to ${newCheckOutDate}` });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestExtendStay error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

/** Get the live bill/folio for the guest's active booking */
export const getGuestBill = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [guestRows] = await pool.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
    if (guestRows.length === 0) return res.status(404).json({ error: 'Guest profile not found' });
    const guestId = guestRows[0].id;

    const [bookingRows] = await pool.query(
      `SELECT b.*, r.number as room_number, rt.title as room_type_title, rt.base_rate
       FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       JOIN room_types rt ON r.room_type_id = rt.id
       WHERE b.guest_id = ? AND b.booking_status IN ('Checked In', 'Reserved')
       ORDER BY b.id DESC LIMIT 1`,
      [guestId]
    );
    if (bookingRows.length === 0) return res.json({ booking: null, ledger: [] });
    const booking = bookingRows[0];

    const [ledger] = await pool.query(
      'SELECT * FROM ledger_items WHERE booking_id = ? ORDER BY id ASC',
      [booking.id]
    );

    res.json({ booking, ledger });
  } catch (error) {
    console.error('getGuestBill error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** Get notifications for the logged-in guest */
export const getGuestNotifications = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [resolvedUserId]
    );
    res.json({ notifications: rows });
  } catch (error) {
    console.error('getGuestNotifications error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** Mark a notification as read */
export const markNotificationRead = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  try {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, resolvedUserId]);
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error('markNotificationRead error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** Guest requests checkout — sends admin notification */
export const guestRequestCheckout = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [guestRows] = await connection.query('SELECT id, full_name FROM guests WHERE user_id = ?', [resolvedUserId]);
    if (guestRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
    const guest = guestRows[0];

    const [bookingRows] = await connection.query(
      `SELECT b.*, r.number as room_number FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.guest_id = ? AND b.booking_status = 'Checked In'
       ORDER BY b.id DESC LIMIT 1`,
      [guest.id]
    );
    if (bookingRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'No active stay found' }); }
    const booking = bookingRows[0];

    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    // Notify the guest
    await connection.query(
      'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [resolvedUserId, '📋 Checkout Requested', `Your checkout request for Room ${booking.room_number} has been received. Please visit the reception desk to complete bill settlement.`]
    );
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'GUEST_CHECKOUT_REQUEST', ?, ?)`,
      [resolvedUserId, `Guest ${guest.full_name} requested checkout from Room ${booking.room_number}, Booking ID: ${booking.id}`, businessDate]
    );

    await connection.commit();
    res.json({ message: 'Checkout request submitted. Please proceed to the reception desk.', roomNumber: booking.room_number });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestRequestCheckout error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── POST-CHECKOUT: Submit Feedback & Rating ────────────────────────────────
/** Guest submits a post-stay review */
export const guestSubmitFeedback = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, overallRating, roomCleanliness, serviceQuality, valueForMoney, comments, wouldRecommend } = req.body;

  if (!bookingId || !overallRating) {
    return res.status(400).json({ error: 'bookingId and overallRating are required' });
  }
  const rating = parseInt(overallRating, 10);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'overallRating must be between 1 and 5' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Verify this booking belongs to this guest and is checked out
    const [guestRows] = await connection.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
    if (guestRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
    const guestId = guestRows[0].id;

    const [bookingRows] = await connection.query(
      `SELECT b.id, b.booking_status, r.number as room_number 
       FROM bookings b JOIN rooms r ON b.room_id = r.id
       WHERE b.id = ? AND b.guest_id = ?`,
      [bookingId, guestId]
    );
    if (bookingRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Booking not found or does not belong to you' });
    }
    if (bookingRows[0].booking_status !== 'Checked Out') {
      await connection.rollback();
      return res.status(400).json({ error: 'Feedback can only be submitted after checkout' });
    }

    // Check for duplicate feedback
    const [existingFeedback] = await connection.query('SELECT id FROM feedback WHERE booking_id = ?', [bookingId]);
    if (existingFeedback.length > 0) {
      await connection.rollback();
      return res.status(409).json({ error: 'Feedback already submitted for this booking' });
    }

    // Insert feedback
    await connection.query(
      `INSERT INTO feedback (booking_id, guest_id, overall_rating, room_cleanliness, service_quality, value_for_money, comments, would_recommend)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [bookingId, guestId, rating,
       roomCleanliness ? parseInt(roomCleanliness, 10) : null,
       serviceQuality ? parseInt(serviceQuality, 10) : null,
       valueForMoney ? parseInt(valueForMoney, 10) : null,
       comments || null,
       wouldRecommend === false || wouldRecommend === 0 ? 0 : 1]
    );

    // Award 50 loyalty points for leaving a review
    await connection.query(
      `UPDATE guests SET loyalty_points = loyalty_points + 50 WHERE id = ?`,
      [guestId]
    );

    // Notify guest of points earned
    await connection.query(
      `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
      [resolvedUserId, '⭐ Thank You for Your Review!', 'You earned 50 loyalty points for sharing your feedback. We look forward to welcoming you again!']
    );

    // Audit log
    const [settings] = await connection.query("SELECT value_val FROM system_settings WHERE key_name = 'system_date'");
    const businessDate = settings[0]?.value_val || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'GUEST_FEEDBACK', ?, ?)`,
      [resolvedUserId, `Guest submitted ${rating}-star review for Booking ID: ${bookingId}`, businessDate]
    );

    await connection.commit();
    res.json({ message: 'Thank you for your feedback! You earned 50 loyalty points.', pointsEarned: 50 });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestSubmitFeedback error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── GET: Guest's own booking history ──────────────────────────────────────
/** Returns all bookings for the authenticated guest with payment and feedback status */
export const getGuestHistory = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [guestRows] = await pool.query('SELECT id, full_name, phone, email, loyalty_tier, loyalty_points FROM guests WHERE user_id = ?', [resolvedUserId]);
    if (guestRows.length === 0) return res.status(404).json({ error: 'Guest profile not found' });
    const guest = guestRows[0];

    const [bookings] = await pool.query(`
      SELECT 
        b.id,
        b.booking_number,
        b.check_in_date,
        b.check_out_date,
        b.expected_check_out_date,
        b.adults,
        b.booking_status,
        b.payment_status,
        b.total_amount,
        b.advance_amount,
        b.created_at,
        r.number as room_number,
        rt.code as room_type,
        rt.title as room_title,
        f.id as feedback_id,
        f.overall_rating,
        f.comments as feedback_comments,
        f.created_at as feedback_date,
        COALESCE(
          (SELECT SUM(p.amount) FROM payments p WHERE p.booking_id = b.id), 0
        ) as total_paid
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      JOIN room_types rt ON r.room_type_id = rt.id
      LEFT JOIN feedback f ON f.booking_id = b.id
      WHERE b.guest_id = ?
      ORDER BY b.created_at DESC
    `, [guest.id]);

    res.json({ guest, bookings, totalStays: bookings.length });
  } catch (error) {
    console.error('getGuestHistory error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ─── GET (Admin): View a specific guest's full history ──────────────────────
export const getGuestHistoryAdmin = async (req, res) => {
  const { guestId } = req.params;
  try {
    const [guestRows] = await pool.query(
      'SELECT id, full_name, phone, email, loyalty_tier, loyalty_points, created_at FROM guests WHERE id = ?',
      [guestId]
    );
    if (guestRows.length === 0) return res.status(404).json({ error: 'Guest not found' });
    const guest = guestRows[0];

    const [bookings] = await pool.query(`
      SELECT 
        b.id, b.booking_number, b.check_in_date, b.check_out_date,
        b.booking_status, b.payment_status, b.total_amount, b.advance_amount,
        r.number as room_number, rt.code as room_type,
        f.overall_rating, f.comments as feedback_comments,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.booking_id = b.id), 0) as total_paid
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      JOIN room_types rt ON r.room_type_id = rt.id
      LEFT JOIN feedback f ON f.booking_id = b.id
      WHERE b.guest_id = ?
      ORDER BY b.created_at DESC
    `, [guest.id]);

    const [payments] = await pool.query(`
      SELECT p.*, b.booking_number
      FROM payments p
      JOIN bookings b ON p.booking_id = b.id
      WHERE b.guest_id = ?
      ORDER BY p.created_at DESC
    `, [guest.id]);

    res.json({ guest, bookings, payments });
  } catch (error) {
    console.error('getGuestHistoryAdmin error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const uploadIdentity = async (req, res) => {
  console.log('--- UPLOAD IDENTITY START ---');
  console.log('Request body:', req.body);
  console.log('Request file:', req.file);

  if (!req.file) {
    console.log('FAILED: No req.file');
    return res.status(400).json({ success: false, message: 'Upload Failed', errors: { document: 'No file uploaded or invalid file format.' } });
  }

  const { idType, documentNumber } = req.body;
  if (!idType) {
    console.log('FAILED: No idType provided');
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    return res.status(400).json({ success: false, message: 'Upload Failed', errors: { document: 'ID Type is required for verification.' } });
  }

  try {
    // 1. Extract Text
    console.log('Starting OCR extraction for file:', req.file.path);
    const ocrData = await extractOCRData(req.file.path, req.file.mimetype);
    console.log('OCR Extraction Result (first 100 chars):', ocrData.preprocessedText ? ocrData.preprocessedText.substring(0, 100).replace(/\n/g, ' ') : 'NULL');

    // 2. Verify Document Type Match
    console.log(`Starting Document Verification. ID Type: ${idType}, Document Number: ${documentNumber}`);
    const verificationResult = verifyDocumentData(ocrData, idType, documentNumber);
    console.log('Document Match Result:', verificationResult);
    
    if (!verificationResult.success) {
      console.log('FAILED: Document verification failed. isMatch=false');
      try { fs.unlinkSync(req.file.path); } catch(e) {} // Clean up mismatched file
    } else {
      console.log('SUCCESS: Document verified successfully');
    }

    const report = {
      success: verificationResult.success,
      message: verificationResult.message,
      data: verificationResult.success ? {
        filePath: req.file.filename,
        ocrText: ocrData.preprocessedText.substring(0, 1000) // Keep reasonable length
      } : undefined,
      errors: !verificationResult.success ? { document: verificationResult.message } : undefined,
      verificationReport: {
        reasonFailed: verificationResult.success ? null : verificationResult.reason,
        ocrRawText: ocrData.rawText.substring(0, 500),
        ocrPreprocessedText: ocrData.preprocessedText.substring(0, 500),
        confidenceScore: ocrData.confidence,
        matchingScore: verificationResult.score,
        decision: verificationResult.success ? 'ACCEPTED' : 'REJECTED'
      }
    };

    if (verificationResult.success) {
      res.json(report);
    } else {
      res.status(400).json(report);
    }
  } catch (error) {
    console.error('OCR Process Error:', error);
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ success: false, message: 'Internal Server Error during document verification.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REFUND POLICY — Admin-configurable cancellation refund settings
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/refund-policy  — return the 4 refund policy keys */
export const getRefundPolicy = async (req, res) => {
  try {
    const keys = ['refund_no_stay_pct', 'refund_partial_stay_pct', 'refund_full_stay_pct', 'refund_partial_hours'];
    const [rows] = await pool.query(
      'SELECT key_name, value_val FROM system_settings WHERE key_name IN (?)',
      [keys]
    );
    const policy = {};
    rows.forEach(r => { policy[r.key_name] = parseFloat(r.value_val); });
    // Provide safe defaults if keys are missing
    res.json({
      noStayPct:      policy['refund_no_stay_pct']      ?? 100,
      partialStayPct: policy['refund_partial_stay_pct'] ?? 50,
      fullStayPct:    policy['refund_full_stay_pct']    ?? 0,
      partialHours:   policy['refund_partial_hours']    ?? 12
    });
  } catch (error) {
    console.error('Error in getRefundPolicy:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** PUT /api/refund-policy  — update the 4 refund policy keys (admin only) */
export const updateRefundPolicy = async (req, res) => {
  const { noStayPct, partialStayPct, fullStayPct, partialHours } = req.body;

  // Validation
  const vals = [noStayPct, partialStayPct, fullStayPct, partialHours];
  if (vals.some(v => v === undefined || v === null || isNaN(parseFloat(v)))) {
    return res.status(400).json({ error: 'All four refund policy values are required and must be numeric' });
  }
  if ([noStayPct, partialStayPct, fullStayPct].some(v => parseFloat(v) < 0 || parseFloat(v) > 100)) {
    return res.status(400).json({ error: 'Refund percentages must be between 0 and 100' });
  }

  try {
    const updates = [
      ['refund_no_stay_pct',      String(parseFloat(noStayPct))],
      ['refund_partial_stay_pct', String(parseFloat(partialStayPct))],
      ['refund_full_stay_pct',    String(parseFloat(fullStayPct))],
      ['refund_partial_hours',    String(parseFloat(partialHours))]
    ];
    for (const [key, val] of updates) {
      await pool.query(
        'INSERT INTO system_settings (key_name, value_val) VALUES (?, ?) ON DUPLICATE KEY UPDATE value_val = ?',
        [key, val, val]
      );
    }

    const resolvedUserId = req.user?.id || null;
    const [settings] = await pool.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '18-Jul-2026';
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'UPDATE_REFUND_POLICY', ?, ?)`,
      [resolvedUserId, `Refund policy updated: NoStay=${noStayPct}%, Partial=${partialStayPct}%, Full=${fullStayPct}%, PartialHrs=${partialHours}`, businessDate]
    );

    res.json({ message: 'Refund policy updated successfully' });
  } catch (error) {
    console.error('Error in updateRefundPolicy:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * POST /api/rooms/:number/refund-checkout
 * Processes a cancellation refund checkout.
 * Body: { refundAmount, reason }
 * - Adds a "Cancellation Refund" negative ledger entry
 * - Logs refund in cash_logs (negative payout)
 * - Marks booking Checked Out with payment_status = 'Refunded'
 * - Sets room to dirty
 * - Audit log: REFUND_CHECKOUT
 */
export const processRefundCheckout = async (req, res) => {
  const { number } = req.params;
  const { refundAmount, reason } = req.body;

  if (!number) {
    return res.status(400).json({ error: 'Room number is required' });
  }
  const parsedRefund = parseFloat(refundAmount);
  if (isNaN(parsedRefund) || parsedRefund < 0) {
    return res.status(400).json({ error: 'Refund amount must be a non-negative number' });
  }

  const resolvedUserId = req.user?.id || null;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Fetch room
    const [roomRows] = await connection.query(`
      SELECT r.*, rt.base_rate as rate, rt.code as type
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.number = ?
    `, [number]);
    if (roomRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `Room ${number} not found` });
    }
    const room = roomRows[0];
    if (room.status !== 'occupied') {
      await connection.rollback();
      return res.status(400).json({ error: `Room ${number} is not currently occupied` });
    }

    // Fetch active booking
    const [bookingRows] = await connection.query(
      `SELECT b.*, g.full_name as guestName, g.user_id as guestUserId
       FROM bookings b
       JOIN guests g ON b.guest_id = g.id
       WHERE b.room_id = ? AND b.booking_status = 'Checked In'`,
      [room.id]
    );
    if (bookingRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `No active booking found for Room ${number}` });
    }
    const booking = bookingRows[0];

    // Fetch system date
    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '18-Jul-2026';

    const timeStr = formatTime(new Date());
    const refundReason = (reason || 'Guest Cancellation').trim();

    // Post Cancellation Refund ledger entry (negative amount = credit to guest)
    if (parsedRefund > 0) {
      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
        [number, `Cancellation Refund (${refundReason})`, -parsedRefund, businessDate, booking.id]
      );

      // Log refund payout in cash_logs (amount stored as positive, type indicates direction)
      await connection.query(
        `INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
         VALUES (?, ?, ?, 'Cancellation Refund', ?, ?, ?)`,
        [timeStr, number, booking.guestName, parsedRefund, businessDate, booking.id]
      );

      // Log in payments table as refund
      await connection.query(
        `INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
         VALUES (?, ?, 'Cash', 'Cancellation Refund', ?)`,
        [booking.id, -parsedRefund, businessDate]
      );
    }

    // Mark booking as Checked Out with Refunded status
    await connection.query(
      `UPDATE bookings SET booking_status = 'Checked Out', payment_status = 'Refunded', check_out_date = ? WHERE id = ?`,
      [businessDate, booking.id]
    );

    // Room status → dirty
    await connection.query(`UPDATE rooms SET status = 'dirty' WHERE id = ?`, [room.id]);

    // Room status history
    await connection.query(
      `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
       VALUES (?, 'occupied', 'dirty', ?, ?)`,
      [room.id, resolvedUserId, businessDate]
    );

    // Audit log
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'REFUND_CHECKOUT', ?, ?)`,
      [resolvedUserId,
       `Refund checkout for Room ${number}. Guest: ${booking.guestName}. Refund: ₹${parsedRefund}. Reason: ${refundReason}. Booking ID: ${booking.id}`,
       businessDate]
    );

    // Increment today_checkouts
    await connection.query(
      `UPDATE system_settings SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR) WHERE key_name = 'today_checkouts'`
    );

    // Notify guest if they have a portal account
    if (booking.guestUserId) {
      await connection.query(
        `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
        [booking.guestUserId,
         '💰 Cancellation Processed',
         `Your cancellation for Room ${number} has been processed. A refund of ₹${parsedRefund} will be returned to you. Reason: ${refundReason}.`]
      );
    }

    await connection.commit();
    res.json({ message: `Refund checkout processed for Room ${number}. Refund: ₹${parsedRefund}` });

  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) { console.error('Rollback error:', e); }
    }
    console.error('Error in processRefundCheckout:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};
