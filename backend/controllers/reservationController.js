/**
 * reservationController.js
 *
 * Phase 2 Step 8: Controlled Firestore Reservations Cutover
 *   - createReservation()   routed through ReservationCutoverService with MySQL fallback
 *   - getReservations()     routed through ReservationCutoverService with MySQL fallback
 *   - getReservationById()  routed through ReservationCutoverService with MySQL fallback
 *   - updateReservation()   routed through ReservationCutoverService with MySQL fallback
 *   - cancelReservation()   routed through ReservationCutoverService with MySQL fallback
 *   - getReservationReport() routed through ReservationCutoverService with MySQL fallback
 *
 * Safety rules:
 *   - MySQL remains emergency fallback.
 *   - All Firestore logic gated by isFirestoreReservationsServingEnabled().
 *   - No destructive database operations.
 */
import pool from '../db.js';
import { db } from '../config/firebaseAdmin.js';
import { BusinessDateService } from '../services/businessDateService.js';
import { processCheckIn } from '../services/checkInService.js';
import { CheckInCutoverService } from '../services/checkInCutoverService.js';
import { RoomStatusService, isDateOverlap, parseToComparableDate } from '../services/roomStatusService.js';
import { FirestoreAvailabilityService } from '../services/firestoreAvailabilityService.js';
import { isReservationsReadCanaryEnabled, isFirestoreReservationsServingEnabled } from '../config/featureFlags.js';
import { ReservationCutoverService } from '../services/reservationCutoverService.js';

/**
 * Auto-generate Reservation Number: RES-YYYYMMDD-XXXX
 */
async function generateReservationNumber(connection) {
  const businessDate = await BusinessDateService.getBusinessDate(connection);
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

    // FirestoreAvailabilityService enforces all 4 blocking rules in one call
    const availableRooms = await FirestoreAvailabilityService.getAvailableRooms(
      pool, arrivalDate, departureDate, roomType || 'ALL'
    );
    res.json({ success: true, count: availableRooms.length, rooms: availableRooms });
  } catch (error) {
    if (error.message && error.message.includes('Arrival date must be strictly before departure date')) {
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
  const mysqlFallbackFn = async () => {
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
        remarks = '',
        dateOfBirth = null,
        dob = null
      } = req.body;

      const resolvedDob = dateOfBirth || dob || null;

      // Field Validations
      if (!guestName || typeof guestName !== 'string' || guestName.trim() === '') {
        const err = new Error('Guest name is required');
        err.status = 400;
        throw err;
      }
      if (!phone || typeof phone !== 'string' || phone.trim() === '') {
        const err = new Error('Contact phone number is required');
        err.status = 400;
        throw err;
      }
      if (!arrivalDate || !departureDate) {
        const err = new Error('Arrival and Departure dates are required');
        err.status = 400;
        throw err;
      }

      const sArr = parseToComparableDate(arrivalDate);
      const sDep = parseToComparableDate(departureDate);
      if (sArr >= sDep) {
        const err = new Error('Arrival date must be strictly before departure date');
        err.status = 400;
        throw err;
      }

      const parsedAdvance = parseInt(advancePayment, 10) || 0;
      if (parsedAdvance < 0) {
        const err = new Error('Advance payment must be a non-negative number');
        err.status = 400;
        throw err;
      }

      let selectedRoomId = parseInt(roomId, 10);
      if (isNaN(selectedRoomId)) selectedRoomId = null;
      let selectedRoomNumber = roomNumber ? String(roomNumber).trim() : '';

      if (selectedRoomNumber) {
        const [rRows] = await connection.query('SELECT id, is_active FROM rooms WHERE number = ?', [selectedRoomNumber]);
        if (rRows.length > 0) {
          selectedRoomId = rRows[0].id;
          if (rRows[0].is_active === 0 || rRows[0].is_active === false || rRows[0].is_active === '0') {
            const err = new Error(`Room ${selectedRoomNumber} is inactive and unavailable for reservation.`);
            err.status = 400;
            throw err;
          }
        } else {
          selectedRoomId = null;
          selectedRoomNumber = '';
        }
      } else if (selectedRoomId) {
        const [rRows] = await connection.query('SELECT number, is_active FROM rooms WHERE id = ?', [selectedRoomId]);
        if (rRows.length > 0) {
          selectedRoomNumber = rRows[0].number;
          if (rRows[0].is_active === 0 || rRows[0].is_active === false || rRows[0].is_active === '0') {
            const err = new Error(`Room ${selectedRoomNumber} is inactive and unavailable for reservation.`);
            err.status = 400;
            throw err;
          }
        } else {
          selectedRoomId = null;
        }
      }

      if (!selectedRoomNumber) {
        const err = new Error('Please select a room for reservation');
        err.status = 400;
        throw err;
      }

      await FirestoreAvailabilityService.validateAndLockRoom(connection, {
        roomId:         selectedRoomId,
        roomNumber:     selectedRoomNumber,
        arrivalDate,
        departureDate,
        forUpdate: true
      });

      const reservationNumber = await generateReservationNumber(connection);

      const [result] = await connection.query(`
        INSERT INTO reservations (
          reservation_number, guest_name, address, phone, email,
          nationality, state, company, purpose,
          arrival_date, arrival_time, departure_date, adults, children,
          room_type, room_id, room_number,
          booking_source, booking_mode, booked_by, booked_by_contact,
          advance_payment, payment_mode, billing_instructions, transport_mode,
          remarks, status, created_by, date_of_birth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        reservationNumber, guestName.trim(), address || '', phone.trim(), email || '',
        nationality, state, company, purpose,
        arrivalDate, arrivalTime, departureDate, parseInt(adults, 10) || 1, parseInt(children, 10) || 0,
        roomType || 'STANDARD', selectedRoomId, selectedRoomNumber,
        bookingSource, bookingMode, bookedBy, bookedByContact,
        parsedAdvance, paymentMode, billingInstructions, transportMode,
        remarks, 'Reserved', req.user?.id || null, resolvedDob
      ]);

      const reservationId = result.insertId;

      if (parsedAdvance > 0) {
        const businessDate = await BusinessDateService.getBusinessDate(connection);
        await connection.query(`
          INSERT INTO cash_logs (time, room, guest, type, amount, business_date)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          arrivalTime, selectedRoomNumber, guestName.trim(), `Reservation Advance (${reservationNumber})`, parsedAdvance, businessDate
        ]);
      }

      await connection.commit();

      const [savedRes] = await pool.query('SELECT * FROM reservations WHERE id = ?', [reservationId]);
      return {
        success: true,
        message: 'Reservation created successfully',
        reservation: savedRes[0]
      };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  };

  try {
    const params = {
      ...req.body,
      user: req.user || {},
      idempotencyKey: req.headers['x-idempotency-key'] || req.body?.idempotencyKey || null
    };

    const result = await ReservationCutoverService.createReservation(params, mysqlFallbackFn);

    const io = req.app.get('io');
    if (io && result.reservation) {
      io.emit('new_reservation', result.reservation);
    }

    return res.status(201).json(result);
  } catch (error) {
    if (error.status === 400 || error.status === 404 || error.status === 409) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code || (error.status === 409 ? 'ROOM_ALREADY_BOOKED' : 'VALIDATION_ERROR')
      });
    }
    console.error('Error creating reservation:', error);
    return res.status(500).json({ error: 'Failed to create reservation: ' + error.message });
  }
};

/**
 * Get List of Reservations with Filters
 * GET /api/reservations
 */
export const getReservations = async (req, res) => {
  const mysqlFallbackFn = async () => {
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
    return { success: true, count: reservations.length, reservations };
  };

  try {
    const result = await ReservationCutoverService.getReservations(req.query, mysqlFallbackFn);
    return res.json(result);
  } catch (error) {
    console.error('Error fetching reservations:', error);
    return res.status(500).json({ error: 'Failed to fetch reservations' });
  }
};

/**
 * Get Single Reservation by ID
 * GET /api/reservations/:id
 */
export const getReservationById = async (req, res) => {
  const { id } = req.params;
  const mysqlFallbackFn = async () => {
    const [rows] = await pool.query('SELECT * FROM reservations WHERE id = ? OR reservation_number = ?', [id, id]);
    if (rows.length === 0) {
      const err = new Error('Reservation not found');
      err.status = 404;
      throw err;
    }
    return { success: true, reservation: rows[0] };
  };

  try {
    const result = await ReservationCutoverService.getReservationById(id, mysqlFallbackFn);
    return res.json(result);
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    console.error('Error fetching reservation by ID:', error);
    return res.status(500).json({ error: 'Failed to fetch reservation details' });
  }
};

/**
 * Update Reservation
 * PUT /api/reservations/:id
 */
export const updateReservation = async (req, res) => {
  const { id } = req.params;
  const mysqlFallbackFn = async () => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const eventOccurredAt = new Date().toISOString();

      const [existing] = await connection.query('SELECT * FROM reservations WHERE id = ?', [id]);
      if (existing.length === 0) {
        const err = new Error('Reservation not found');
        err.status = 404;
        throw err;
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

      const sArr = parseToComparableDate(arrivalDate);
      const sDep = parseToComparableDate(departureDate);
      if (sArr >= sDep) {
        const err = new Error('Arrival date must be strictly before departure date');
        err.status = 400;
        throw err;
      }

      let selectedRoomId = currentRes.room_id;
      if (roomNumber !== currentRes.room_number || !selectedRoomId) {
        const [rRows] = await connection.query('SELECT id FROM rooms WHERE number = ?', [roomNumber]);
        if (rRows.length > 0) {
          selectedRoomId = rRows[0].id;
        }
      }

      if (roomNumber !== currentRes.room_number || arrivalDate !== currentRes.arrival_date || departureDate !== currentRes.departure_date) {
        await FirestoreAvailabilityService.validateAndLockRoom(connection, {
          roomId:                 selectedRoomId,
          roomNumber:             roomNumber,
          arrivalDate,
          departureDate,
          excludeReservationId:   parseInt(id, 10),
          forUpdate: true
        });
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
      return { success: true, message: 'Reservation updated successfully', reservation: updated[0] };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  };

  try {
    const updateData = {
      ...req.body,
      idempotencyKey: req.headers['x-idempotency-key'] || req.body?.idempotencyKey || null
    };

    const result = await ReservationCutoverService.updateReservation(id, updateData, req.user || {}, mysqlFallbackFn);
    return res.json(result);
  } catch (error) {
    if (error.status === 400 || error.status === 404 || error.status === 409) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code || (error.status === 409 ? 'ROOM_ALREADY_BOOKED' : 'VALIDATION_ERROR')
      });
    }
    console.error('Error updating reservation:', error);
    return res.status(500).json({ error: 'Failed to update reservation: ' + error.message });
  }
};

/**
 * Cancel Reservation
 * POST /api/reservations/:id/cancel
 */
export const cancelReservation = async (req, res) => {
  const { id } = req.params;
  const mysqlFallbackFn = async () => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const { cancellationReason = 'Guest Cancellation', refundAmount } = req.body;

      const [existing] = await connection.query('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [id]);
      if (existing.length === 0) {
        const err = new Error('Reservation not found');
        err.status = 404;
        throw err;
      }

      const current = existing[0];
      let cancelBooking   = null;
      let cancelBizDate   = null;

      if (current.booking_id) {
        const [bookingRows] = await connection.query(
          'SELECT b.*, g.full_name as guestName FROM bookings b JOIN guests g ON b.guest_id = g.id WHERE b.id = ?',
          [current.booking_id]
        );

        if (bookingRows.length > 0) {
          const booking = bookingRows[0];
          cancelBooking = booking;
          
          const businessDate = await BusinessDateService.getBusinessDate(connection);
          cancelBizDate = businessDate;

          const refundVal = refundAmount !== undefined ? parseFloat(refundAmount) : (current.advance_payment || 0);

          if (booking.booking_status === 'Checked In') {
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

            await connection.query(
              `UPDATE bookings SET booking_status = 'Checked Out', payment_status = 'Refunded', check_out_date = ? WHERE id = ?`,
              [businessDate, booking.id]
            );

            if (current.room_id) {
              await connection.query(
                `UPDATE rooms SET status = 'dirty' WHERE id = ?`,
                [current.room_id]
              );
            }

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
      return { success: true, message: `Reservation #${current.reservation_number} cancelled successfully` };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  };

  try {
    const params = {
      ...req.body,
      idempotencyKey: req.headers['x-idempotency-key'] || req.body?.idempotencyKey || null
    };

    const result = await ReservationCutoverService.cancelReservation(id, params, req.user || {}, mysqlFallbackFn);
    return res.json(result);
  } catch (error) {
    if (error.status === 400 || error.status === 404) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error cancelling reservation:', error);
    return res.status(500).json({ error: 'Failed to cancel reservation: ' + error.message });
  }
};

/**
 * Check-In Reservation (Converts reservation to actual Check-In)
 * POST /api/reservations/:id/checkin
 */
export const checkInReservation = async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    let roomNumber = null;
    let reservationNumber = null;

    if (isFirestoreReservationsServingEnabled()) {
      // Firestore-primary: resolve the reservation via the same Firestore-first
      // path already used by getReservationById/updateReservation, instead of
      // an unconditional MySQL connection (which throws ER_MYSQL_DECOMMISSIONED
      // when DISABLE_MYSQL_CUTOVER_FALLBACKS=true).
      const resResult = await ReservationCutoverService.getReservationById(id);
      roomNumber = resResult?.reservation?.room_number || null;
      reservationNumber = resResult?.reservation?.reservation_number || null;
    } else {
      // Legacy MySQL path — only reached when Firestore reservations serving
      // is explicitly disabled (not the case in this production configuration).
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [resRows] = await connection.query('SELECT * FROM reservations WHERE id = ?', [id]);
      if (resRows.length > 0) {
        roomNumber = resRows[0].room_number;
        reservationNumber = resRows[0].reservation_number;
      }
    }

    // Delegate to CheckInCutoverService (already Firestore-primary internally;
    // `connection` is undefined here in the Firestore path and is simply unused).
    const result = await CheckInCutoverService.executeCheckIn({
      connection,
      params: {
        roomNumber,
        reservationId: id,
        resolvedUserId: req.user?.id || null
      }
    });

    if (connection) await connection.commit();

    res.json({
      success: true,
      message: `Reservation ${reservationNumber || id} checked in successfully to Room ${result.roomNumber || roomNumber}`,
      booking_id: result.bookingId,
      room_number: result.roomNumber || roomNumber
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error during reservation check-in:', error);
    res.status(error.status || 500).json({ error: error.message || 'Failed to check in reservation' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Reservation Summary & Reports
 * GET /api/reservations/report
 */
export const getReservationReport = async (req, res) => {
  const mysqlFallbackFn = async () => {
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

    const totalReservations = rows.length;
    const reservedCount = rows.filter(r => r.status === 'Reserved').length;
    const confirmedCount = rows.filter(r => r.status === 'Confirmed').length;
    const checkedInCount = rows.filter(r => r.status === 'Checked-In').length;
    const cancelledCount = rows.filter(r => r.status === 'Cancelled').length;
    const totalAdvance = rows.reduce((sum, r) => sum + (r.advance_payment || 0), 0);

    return {
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
    };
  };

  try {
    const result = await ReservationCutoverService.getReservationReport(req.query, mysqlFallbackFn);
    return res.json(result);
  } catch (error) {
    console.error('Error generating reservation report:', error);
    return res.status(500).json({ error: 'Failed to generate reservation report' });
  }
};
