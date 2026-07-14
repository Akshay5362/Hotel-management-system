import pool from '../db.js';

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
    return res.status(400).json({ error: 'Deposit must be a non-negative integer' });
  }

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
      // Update their profile details
      await connection.query(
        `UPDATE guests 
         SET full_name = ?, phone = ?, email = ?, gender = ?, age = ?, id_type = ?, government_id = ?
         WHERE id = ?`,
        [guestNameUpper, phone || '', email || '', gender || '', age ? parseInt(age, 10) : null, idType || '', governmentId || '', guestId]
      );
    } else {
      const [newGuestRes] = await connection.query(
        `INSERT INTO guests (full_name, phone, email, gender, age, id_type, government_id, user_id, loyalty_tier, loyalty_points) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Bronze', 0)`,
        [guestNameUpper, phone || '', email || '', gender || '', age ? parseInt(age, 10) : null, idType || '', governmentId || '', parsedUserId]
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

