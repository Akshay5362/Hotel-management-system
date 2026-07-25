import pool from '../db.js';
import { processCheckIn } from '../services/checkInService.js';
import { RoomStatusService, isDateOverlap, parseToComparableDate } from '../services/roomStatusService.js';

/**
 * Auto-generate Reservation Number: RES-YYYYMMDD-XXXX
 */
async function generateReservationNumber(connection) {
  const [settings] = await connection.query("SELECT value_val FROM system_settings WHERE key_name = 'system_date'");
  const businessDate = settings[0]?.value_val || '25-Jul-2026';
  const compDate = parseToComparableDate(businessDate) || '2026-07-25';
  const dateStr = compDate.replace(/-/g, '');
  const prefix = `RES-${dateStr}-`;
  
  const [rows] = await connection.query(
    'SELECT reservation_number FROM reservations WHERE reservation_number LIKE ? ORDER BY id DESC LIMIT 1',
    [`${prefix}%`]
  );

  let nextSeq = 1001;
  if (rows.length > 0) {
    const lastNum = rows[0].reservation_number;
    const parts = lastNum.split('-');
    if (parts.length === 3) {
      const parsedSeq = parseInt(parts[2], 10);
      if (!isNaN(parsedSeq)) {
        nextSeq = parsedSeq + 1;
      }
    }
  }

  return `${prefix}${nextSeq}`;
}

/**
 * Check Available Rooms for given dates & room type
 * GET /api/reservations/available-rooms?arrivalDate=...&departureDate=...&roomType=...
 */
export const getAvailableRoomsForReservation = async (req, res) => {
  try {
    const { arrivalDate, departureDate, roomType } = req.query;

    if (!arrivalDate || !departureDate) {
      return res.status(400).json({ error: 'Arrival date and departure date are required' });
    }

    const availableRooms = await RoomStatusService.getAvailableRoomsForDateRange(pool, arrivalDate, departureDate, roomType);
    res.json({ success: true, count: availableRooms.length, rooms: availableRooms });
  } catch (error) {
    if (error.message.includes('Arrival date must be strictly before departure date')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error fetching available rooms for reservation:', error);
    res.status(500).json({ error: 'Failed to fetch available rooms' });
  }
};

/**
 * Create New Reservation
 * POST /api/reservations
 */
export const createReservation = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      guestName,
      phone,
      email,
      address,
      nationality = 'Indian',
      state = '',
      company = '',
      purpose = '',
      arrivalDate,
      arrivalTime = '12:00 PM',
      departureDate,
      adults = 1,
      children = 0,
      roomType,
      roomNumber,
      roomId,
      bookingSource = 'Direct',
      bookingMode = 'Offline',
      bookedBy = '',
      bookedByContact = '',
      advancePayment = 0,
      paymentMode = 'Cash',
      billingInstructions = '',
      transportMode = 'Self',
      remarks = ''
    } = req.body;

    // Field Validations
    if (!guestName || typeof guestName !== 'string' || guestName.trim() === '') {
      await connection.rollback();
      return res.status(400).json({ error: 'Guest name is required' });
    }
    if (!phone || typeof phone !== 'string' || phone.trim() === '') {
      await connection.rollback();
      return res.status(400).json({ error: 'Contact phone number is required' });
    }
    if (!arrivalDate || !departureDate) {
      await connection.rollback();
      return res.status(400).json({ error: 'Arrival and Departure dates are required' });
    }

    const sArr = parseToComparableDate(arrivalDate);
    const sDep = parseToComparableDate(departureDate);
    if (sArr >= sDep) {
      await connection.rollback();
      return res.status(400).json({ error: 'Arrival date must be strictly before departure date' });
    }

    const parsedAdvance = parseInt(advancePayment, 10) || 0;
    if (parsedAdvance < 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Advance payment must be a non-negative number' });
    }

    // Resolve room_id and room_number
    let selectedRoomId = parseInt(roomId, 10);
    if (isNaN(selectedRoomId)) selectedRoomId = null;
    let selectedRoomNumber = roomNumber ? String(roomNumber).trim() : '';

    // ALWAYS enforce consistency between room_number and room_id
    if (selectedRoomNumber) {
      const [rRows] = await connection.query('SELECT id FROM rooms WHERE number = ?', [selectedRoomNumber]);
      if (rRows.length > 0) {
        selectedRoomId = rRows[0].id;
      } else {
        selectedRoomId = null;
        selectedRoomNumber = ''; // Invalid room number provided
      }
    } else if (selectedRoomId) {
      const [rRows] = await connection.query('SELECT number FROM rooms WHERE id = ?', [selectedRoomId]);
      if (rRows.length > 0) {
        selectedRoomNumber = rRows[0].number;
      } else {
        selectedRoomId = null;
      }
    }

    if (!selectedRoomNumber) {
      await connection.rollback();
      return res.status(400).json({ error: 'Please select a room for reservation' });
    }

    // Double Booking Prevention Check
    const [overlappingBookings] = await connection.query(`
      SELECT b.id, b.check_in_date, b.expected_check_out_date, b.check_out_date
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      WHERE r.number = ? AND b.booking_status = 'Checked In'
    `, [selectedRoomNumber]);

    const hasBookingConflict = overlappingBookings.some(b => {
      const bEnd = b.expected_check_out_date || b.check_out_date || b.check_in_date;
      return isDateOverlap(arrivalDate, departureDate, b.check_in_date, bEnd);
    });

    if (hasBookingConflict) {
      await connection.rollback();
      return res.status(400).json({ error: `Room ${selectedRoomNumber} is already occupied during the selected date range.` });
    }

    const [overlappingRes] = await connection.query(`
      SELECT id, arrival_date, departure_date
      FROM reservations
      WHERE room_number = ? AND status IN ('Reserved', 'Confirmed')
    `, [selectedRoomNumber]);

    const hasResConflict = overlappingRes.some(r => {
      return isDateOverlap(arrivalDate, departureDate, r.arrival_date, r.departure_date);
    });

    if (hasResConflict) {
      await connection.rollback();
      return res.status(400).json({ error: `Room ${selectedRoomNumber} has an existing reservation during the selected date range.` });
    }

    // Generate Reservation Number
    const reservationNumber = await generateReservationNumber(connection);

    // Insert Reservation
    const [result] = await connection.query(`
      INSERT INTO reservations (
        reservation_number, guest_name, address, phone, email,
        nationality, state, company, purpose,
        arrival_date, arrival_time, departure_date, adults, children,
        room_type, room_id, room_number,
        booking_source, booking_mode, booked_by, booked_by_contact,
        advance_payment, payment_mode, billing_instructions, transport_mode,
        remarks, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      reservationNumber, guestName.trim(), address || '', phone.trim(), email || '',
      nationality, state, company, purpose,
      arrivalDate, arrivalTime, departureDate, parseInt(adults, 10) || 1, parseInt(children, 10) || 0,
      roomType || 'STANDARD', selectedRoomId, selectedRoomNumber,
      bookingSource, bookingMode, bookedBy, bookedByContact,
      parsedAdvance, paymentMode, billingInstructions, transportMode,
      remarks, 'Reserved', req.user?.id || null
    ]);

    const reservationId = result.insertId;

    // Log Advance Payment if present
    if (parsedAdvance > 0) {
      const [settings] = await connection.query("SELECT value_val FROM system_settings WHERE key_name = 'system_date'");
      const businessDate = settings[0]?.value_val || arrivalDate || '25-Jul-2026';
      await connection.query(`
        INSERT INTO cash_logs (time, room, guest, type, amount, business_date)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        arrivalTime, selectedRoomNumber, guestName.trim(), `Reservation Advance (${reservationNumber})`, parsedAdvance, businessDate
      ]);
    }

    await connection.commit();

    const [savedRes] = await pool.query('SELECT * FROM reservations WHERE id = ?', [reservationId]);

    // Socket IO broadcast if available
    const io = req.app.get('io');
    if (io) {
      io.emit('new_reservation', savedRes[0]);
    }

    res.status(201).json({
      success: true,
      message: 'Reservation created successfully',
      reservation: savedRes[0]
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating reservation:', error);
    res.status(500).json({ error: 'Failed to create reservation: ' + error.message });
  } finally {
    connection.release();
  }
};

/**
 * Get List of Reservations with Filters
 * GET /api/reservations
 */
export const getReservations = async (req, res) => {
  try {
    const { status, search, fromDate, toDate } = req.query;

    let query = 'SELECT * FROM reservations WHERE 1=1';
    const params = [];

    if (status && status !== 'ALL') {
      query += ' AND status = ?';
      params.push(status);
    }

    if (search && search.trim() !== '') {
      query += ' AND (guest_name LIKE ? OR phone LIKE ? OR reservation_number LIKE ? OR room_number LIKE ?)';
      const s = `%${search.trim()}%`;
      params.push(s, s, s, s);
    }

    if (fromDate) {
      query += ' AND arrival_date >= ?';
      params.push(fromDate);
    }

    if (toDate) {
      query += ' AND departure_date <= ?';
      params.push(toDate);
    }

    query += ' ORDER BY id DESC';

    const [reservations] = await pool.query(query, params);
    res.json({ success: true, count: reservations.length, reservations });
  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
};

/**
 * Get Single Reservation by ID
 * GET /api/reservations/:id
 */
export const getReservationById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM reservations WHERE id = ? OR reservation_number = ?', [id, id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    res.json({ success: true, reservation: rows[0] });
  } catch (error) {
    console.error('Error fetching reservation by ID:', error);
    res.status(500).json({ error: 'Failed to fetch reservation details' });
  }
};

/**
 * Update Reservation
 * PUT /api/reservations/:id
 */
export const updateReservation = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const [existing] = await connection.query('SELECT * FROM reservations WHERE id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const currentRes = existing[0];
    const {
      guestName = currentRes.guest_name,
      phone = currentRes.phone,
      email = currentRes.email,
      address = currentRes.address,
      nationality = currentRes.nationality,
      state = currentRes.state,
      company = currentRes.company,
      purpose = currentRes.purpose,
      arrivalDate = currentRes.arrival_date,
      arrivalTime = currentRes.arrival_time,
      departureDate = currentRes.departure_date,
      adults = currentRes.adults,
      children = currentRes.children,
      roomType = currentRes.room_type,
      roomNumber = currentRes.room_number,
      bookingSource = currentRes.booking_source,
      bookingMode = currentRes.booking_mode,
      bookedBy = currentRes.booked_by,
      bookedByContact = currentRes.booked_by_contact,
      advancePayment = currentRes.advance_payment,
      paymentMode = currentRes.payment_mode,
      billingInstructions = currentRes.billing_instructions,
      transportMode = currentRes.transport_mode,
      remarks = currentRes.remarks,
      status = currentRes.status
    } = req.body;

    // Check date logic
    const sArr = parseToComparableDate(arrivalDate);
    const sDep = parseToComparableDate(departureDate);
    if (sArr >= sDep) {
      await connection.rollback();
      return res.status(400).json({ error: 'Arrival date must be strictly before departure date' });
    }

    // Resolve room_id (Heal NULL values if present)
    let selectedRoomId = currentRes.room_id;
    if (roomNumber !== currentRes.room_number || !selectedRoomId) {
      const [rRows] = await connection.query('SELECT id FROM rooms WHERE number = ?', [roomNumber]);
      if (rRows.length > 0) {
        selectedRoomId = rRows[0].id;
      }
    }

    // Double Booking Check (excluding current reservation ID)
    if (roomNumber !== currentRes.room_number || arrivalDate !== currentRes.arrival_date || departureDate !== currentRes.departure_date) {
      const [overlappingRes] = await connection.query(`
        SELECT id FROM reservations
        WHERE room_number = ? AND status IN ('Reserved', 'Confirmed') AND id != ?
      `, [roomNumber, id]);

      const hasConflict = overlappingRes.some(r => {
        return isDateOverlap(arrivalDate, departureDate, r.arrival_date, r.departure_date);
      });

      if (hasConflict) {
        await connection.rollback();
        return res.status(400).json({ error: `Room ${roomNumber} has an overlapping reservation during specified dates.` });
      }
    }

    await connection.query(`
      UPDATE reservations SET
        guest_name = ?, phone = ?, email = ?, address = ?, nationality = ?, state = ?, company = ?, purpose = ?,
        arrival_date = ?, arrival_time = ?, departure_date = ?, adults = ?, children = ?,
        room_type = ?, room_id = ?, room_number = ?,
        booking_source = ?, booking_mode = ?, booked_by = ?, booked_by_contact = ?,
        advance_payment = ?, payment_mode = ?, billing_instructions = ?, transport_mode = ?,
        remarks = ?, status = ?
      WHERE id = ?
    `, [
      guestName.trim(), phone.trim(), email, address, nationality, state, company, purpose,
      arrivalDate, arrivalTime, departureDate, parseInt(adults, 10) || 1, parseInt(children, 10) || 0,
      roomType, selectedRoomId, roomNumber,
      bookingSource, bookingMode, bookedBy, bookedByContact,
      parseInt(advancePayment, 10) || 0, paymentMode, billingInstructions, transportMode,
      remarks, status, id
    ]);

    await connection.commit();

    const [updated] = await pool.query('SELECT * FROM reservations WHERE id = ?', [id]);
    res.json({ success: true, message: 'Reservation updated successfully', reservation: updated[0] });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating reservation:', error);
    res.status(500).json({ error: 'Failed to update reservation: ' + error.message });
  } finally {
    connection.release();
  }
};

/**
 * Cancel Reservation
 * POST /api/reservations/:id/cancel
 */
export const cancelReservation = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const { cancellationReason = 'Guest Cancellation', refundAmount } = req.body;

    const [existing] = await connection.query('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const current = existing[0];

    // If reservation is associated with a booking (Checked-In or Checked-Out)
    if (current.booking_id) {
      const [bookingRows] = await connection.query(
        'SELECT b.*, g.full_name as guestName FROM bookings b JOIN guests g ON b.guest_id = g.id WHERE b.id = ?',
        [current.booking_id]
      );

      if (bookingRows.length > 0) {
        const booking = bookingRows[0];
        
        // Fetch current system business date
        const [settings] = await connection.query("SELECT value_val FROM system_settings WHERE key_name = 'system_date'");
        const businessDate = settings[0]?.value_val;
    if (!businessDate) {
      console.error('[CRITICAL] system_settings.system_date is missing from database.');
      return res.status(500).json({ error: 'System configuration error: Business Date is missing. Please contact administrator.' });
    }

        const refundVal = refundAmount !== undefined ? parseFloat(refundAmount) : (current.advance_payment || 0);

        if (booking.booking_status === 'Checked In') {
          // 1. Log Cancellation Refund in cash_logs & payments if refund > 0
          if (refundVal > 0) {
            const now = new Date();
            let hours = now.getHours();
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12 || 12;
            const timeStr = `${hours}:${minutes} ${ampm}`;

            await connection.query(
              `INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
               VALUES (?, ?, ?, 'Cancellation Refund', ?, ?, ?)`,
              [timeStr, current.room_number, booking.guestName, refundVal, businessDate, booking.id]
            );

            await connection.query(
              `INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
               VALUES (?, ?, 'Cash', 'Cancellation Refund', ?)`,
              [booking.id, -refundVal, businessDate]
            );
          }

          // 2. Mark booking as Checked Out with payment_status = 'Refunded'
          await connection.query(
            `UPDATE bookings SET booking_status = 'Checked Out', payment_status = 'Refunded', check_out_date = ? WHERE id = ?`,
            [businessDate, booking.id]
          );

          // 3. Mark room as dirty
          if (current.room_id) {
            await connection.query(
              `UPDATE rooms SET status = 'dirty', housekeeping_status = 'Dirty' WHERE id = ?`,
              [current.room_id]
            );
          }

          // 4. Log in booking_history & audit_logs
          await connection.query(
            `INSERT INTO booking_history (booking_id, action, old_room_id, new_room_id, changed_by, business_date, notes)
             VALUES (?, 'CANCELLED', ?, ?, ?, ?, ?)`,
            [booking.id, current.room_id, current.room_id, req.user?.id || null, businessDate, `Reservation cancelled after check-in. Reason: ${cancellationReason}`]
          );

          await connection.query(
            `INSERT INTO audit_logs (user_id, action, details, business_date)
             VALUES (?, 'CANCEL_RESERVATION', ?, ?)`,
            [req.user?.id || null, `Cancelled Reservation #${current.reservation_number} (Booking ID ${booking.id}). Reason: ${cancellationReason}`, businessDate]
          );
        } else {
          // If booking is already checked out, update payment_status to Refunded if refund processed
          if (refundVal > 0) {
            await connection.query(`UPDATE bookings SET payment_status = 'Refunded' WHERE id = ?`, [booking.id]);
          }
        }
      }
    }

    const updatedRemarks = current.remarks 
      ? `${current.remarks} | Cancelled: ${cancellationReason}` 
      : `Cancelled: ${cancellationReason}`;

    await connection.query(
      'UPDATE reservations SET status = ?, remarks = ? WHERE id = ?',
      ['Cancelled', updatedRemarks, id]
    );

    await connection.commit();

    res.json({ success: true, message: `Reservation #${current.reservation_number} cancelled successfully` });
  } catch (error) {
    await connection.rollback();
    console.error('Error cancelling reservation:', error);
    res.status(500).json({ error: 'Failed to cancel reservation: ' + error.message });
  } finally {
    connection.release();
  }
};

/**
 * Check-In Reservation (Converts reservation to actual Check-In)
 * POST /api/reservations/:id/checkin
 */
export const checkInReservation = async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const { id } = req.params;
    const [resRows] = await connection.query('SELECT * FROM reservations WHERE id = ?', [id]);
    if (resRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const reservation = resRows[0];
    
    // Delegate to shared service
    const { bookingId } = await processCheckIn(connection, {
      roomNumber: reservation.room_number,
      reservationId: id,
      resolvedUserId: req.user?.id || null
    });

    await connection.commit();

    res.json({
      success: true,
      message: `Reservation ${reservation.reservation_number} checked in successfully to Room ${reservation.room_number}`,
      booking_id: bookingId,
      room_number: reservation.room_number
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error during reservation check-in:', error);
    res.status(500).json({ error: 'Failed to check in reservation: ' + error.message });
  } finally {
    connection.release();
  }
};

/**
 * Reservation Summary & Reports
 * GET /api/reservations/report
 */
export const getReservationReport = async (req, res) => {
  try {
    const { fromDate, toDate, roomType, source, status } = req.query;

    let query = 'SELECT * FROM reservations WHERE 1=1';
    const params = [];

    if (fromDate) {
      query += ' AND arrival_date >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      query += ' AND departure_date <= ?';
      params.push(toDate);
    }
    if (roomType && roomType !== 'ALL') {
      query += ' AND room_type = ?';
      params.push(roomType);
    }
    if (source && source !== 'ALL') {
      query += ' AND booking_source = ?';
      params.push(source);
    }
    if (status && status !== 'ALL') {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY arrival_date ASC';

    const [rows] = await pool.query(query, params);

    // Compute Metrics
    const totalReservations = rows.length;
    const reservedCount = rows.filter(r => r.status === 'Reserved').length;
    const confirmedCount = rows.filter(r => r.status === 'Confirmed').length;
    const checkedInCount = rows.filter(r => r.status === 'Checked-In').length;
    const cancelledCount = rows.filter(r => r.status === 'Cancelled').length;
    const totalAdvance = rows.reduce((sum, r) => sum + (r.advance_payment || 0), 0);

    res.json({
      success: true,
      summary: {
        totalReservations,
        reservedCount,
        confirmedCount,
        checkedInCount,
        cancelledCount,
        totalAdvance
      },
      reservations: rows
    });
  } catch (error) {
    console.error('Error generating reservation report:', error);
    res.status(500).json({ error: 'Failed to generate reservation report' });
  }
};
