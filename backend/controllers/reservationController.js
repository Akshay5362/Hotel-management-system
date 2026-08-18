/**
 * reservationController.js
 *
 * Phase 4G-B additions:
 *   - createReservation()   wrapped with COMPOUND_RESERVATION_CREATED outbox event
 *   - updateReservation()   wrapped with COMPOUND_RESERVATION_UPDATED outbox event
 *   - cancelReservation()   wrapped with COMPOUND_RESERVATION_CANCELLED (3-path write set)
 *
 * Safety rules:
 *   - MySQL remains the permanent transactional authority.
 *   - All enqueue() calls use the same acquired connection, run BEFORE commit().
 *   - All Firestore logic is completely gated by isFirestoreDualWriteEnabled().
 *   - Firestore canonical field names: check_in_date / check_out_date
 *     (translated from MySQL arrival_date / departure_date).
 *   - No FieldValue.increment(), no random IDs, all operations are set_merge.
 */
import pool from '../db.js';
import { db } from '../config/firebaseAdmin.js';
import { BusinessDateService } from '../services/businessDateService.js';
import { processCheckIn } from '../services/checkInService.js';
import { RoomStatusService, isDateOverlap, parseToComparableDate } from '../services/roomStatusService.js';
import { AvailabilityService } from '../services/AvailabilityService.js';
import { enqueue } from '../services/outboxService.js';
import { isFirestoreDualWriteEnabled, isReservationsReadCanaryEnabled } from '../config/featureFlags.js';
import { executeReadCanary } from '../services/dualReadVerificationService.js';
import {
  CompoundEventBuilder,
  formatReservationId,
  formatBookingId,
  formatRoomId
} from '../services/compoundEventBuilder.js';

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

    // AvailabilityService enforces all 4 blocking rules in one call
    const availableRooms = await AvailabilityService.getAvailableRooms(
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
      const [rRows] = await connection.query('SELECT id, is_active FROM rooms WHERE number = ?', [selectedRoomNumber]);
      if (rRows.length > 0) {
        selectedRoomId = rRows[0].id;
        if (rRows[0].is_active === 0 || rRows[0].is_active === false || rRows[0].is_active === '0') {
          await connection.rollback();
          return res.status(400).json({ error: `Room ${selectedRoomNumber} is inactive and unavailable for reservation.` });
        }
      } else {
        selectedRoomId = null;
        selectedRoomNumber = ''; // Invalid room number provided
      }
    } else if (selectedRoomId) {
      const [rRows] = await connection.query('SELECT number, is_active FROM rooms WHERE id = ?', [selectedRoomId]);
      if (rRows.length > 0) {
        selectedRoomNumber = rRows[0].number;
        if (rRows[0].is_active === 0 || rRows[0].is_active === false || rRows[0].is_active === '0') {
          await connection.rollback();
          return res.status(400).json({ error: `Room ${selectedRoomNumber} is inactive and unavailable for reservation.` });
        }
      } else {
        selectedRoomId = null;
      }
    }

    if (!selectedRoomNumber) {
      await connection.rollback();
      return res.status(400).json({ error: 'Please select a room for reservation' });
    }

    // ── Availability Validation with row lock (concurrency-safe) ─────────────
    try {
      await AvailabilityService.validateAndLockRoom(connection, {
        roomId:         selectedRoomId,
        roomNumber:     selectedRoomNumber,
        arrivalDate,
        departureDate,
      });
    } catch (availErr) {
      await connection.rollback();
      return res.status(availErr.status || 409).json({
        error: availErr.message,
        code:  availErr.code || 'ROOM_ALREADY_BOOKED'
      });
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

    // Log Advance Payment if present
    if (parsedAdvance > 0) {
      const businessDate = await BusinessDateService.getBusinessDate(connection);
      await connection.query(`
        INSERT INTO cash_logs (time, room, guest, type, amount, business_date)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        arrivalTime, selectedRoomNumber, guestName.trim(), `Reservation Advance (${reservationNumber})`, parsedAdvance, businessDate
      ]);
    }

    // ── Phase 4G-B: Outbox — COMPOUND_RESERVATION_CREATED ────────────────────
    // enqueue() MUST use the same connection and run BEFORE commit().
    // Firestore canonical field names: check_in_date / check_out_date
    // (translated from MySQL arrival_date / departure_date).
    if (isFirestoreDualWriteEnabled()) {
      // Freeze timestamp once — used for both created_at and updated_at.
      const eventOccurredAt = new Date().toISOString();

      const reservationEvent = new CompoundEventBuilder({
        event_type:     'COMPOUND_RESERVATION_CREATED',
        aggregate_type: 'RESERVATION',
        aggregate_id:   reservationId
      })
        .addRootWrite({
          collection:  'reservations',
          document_id: formatReservationId(reservationNumber),
          operation:   'set_merge',
          data: {
            reservation_number:   reservationNumber,
            guest_name:           guestName.trim(),
            phone:                phone.trim(),
            email:                email || null,
            address:              address || null,
            nationality:          nationality || 'Indian',
            company:              company || null,
            purpose:              purpose || null,
            room_id:              formatRoomId(selectedRoomNumber),
            mysql_room_id:        selectedRoomId,
            room_number:          selectedRoomNumber,
            room_type:            roomType || 'STANDARD',
            // ⚠ Firestore uses check_in_date / check_out_date — NOT arrival_date / departure_date
            check_in_date:        String(arrivalDate),
            check_out_date:       String(departureDate),
            arrival_time:         arrivalTime || '12:00 PM',
            adults:               parseInt(adults, 10) || 1,
            children:             parseInt(children, 10) || 0,
            booking_source:       bookingSource || 'Direct',
            booking_mode:         bookingMode || 'Offline',
            booked_by:            bookedBy || null,
            booked_by_contact:    bookedByContact || null,
            advance_payment:      parsedAdvance,
            payment_mode:         paymentMode || 'Cash',
            transport_mode:       transportMode || 'Self',
            billing_instructions: billingInstructions || null,
            remarks:              remarks || null,
            status:               'Reserved',
            booking_id:           null,
            mysql_booking_id:     null,
            mysql_reservation_id: reservationId,
            created_by:           req.user?.id || null,
            created_at:           eventOccurredAt,
            updated_at:           eventOccurredAt
          }
        })
        .build();

      await enqueue(connection, {
        event_type:     reservationEvent.event_type,
        aggregate_type: reservationEvent.aggregate_type,
        aggregate_id:   reservationEvent.aggregate_id,
        payload:        reservationEvent
      });
      console.log(`[reservationController] Compound outbox event enqueued: ${reservationEvent.operation_id} (${reservationEvent.writes.length} write)`);
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
  const canaryResult = await executeReadCanary({
    flagCheckFn: isReservationsReadCanaryEnabled,
    endpointName: '/api/reservations',
    timeoutMs: 1000,
    fetchFirestoreFn: async () => {
      const snap = await db.collection('reservations').get();
      return snap.docs.map(doc => ({ ...doc.data(), firestore_id: doc.id }));
    },
    validateAndFormatFn: (docs) => {
      if (!Array.isArray(docs)) return null;
      const formatted = docs.map(r => ({
        id: r.id || r.mysql_reservation_id || r.firestore_id,
        reservation_number: r.reservation_number || '',
        guest_name: r.guest_name || '',
        phone: r.phone || '',
        email: r.email || null,
        address: r.address || null,
        nationality: r.nationality || 'Indian',
        company: r.company || null,
        purpose: r.purpose || null,
        room_id: r.mysql_room_id || null,
        room_number: r.room_number || '',
        room_type: r.room_type || 'STANDARD',
        arrival_date: r.arrival_date || r.check_in_date || null,
        departure_date: r.departure_date || r.check_out_date || null,
        arrival_time: r.arrival_time || null,
        adults: Number(r.adults || 1),
        children: Number(r.children || 0),
        booking_source: r.booking_source || 'Direct',
        booking_mode: r.booking_mode || 'Offline',
        booked_by: r.booked_by || null,
        booked_by_contact: r.booked_by_contact || null,
        advance_payment: parseFloat(r.advance_payment || 0),
        payment_mode: r.payment_mode || 'Cash',
        billing_instructions: r.billing_instructions || null,
        transport_mode: r.transport_mode || 'Self',
        remarks: r.remarks || null,
        status: r.status || 'Reserved',
        created_at: r.created_at || null,
        updated_at: r.updated_at || null
      }));
      formatted.sort((a, b) => Number(b.id) - Number(a.id));
      return { success: true, count: formatted.length, reservations: formatted };
    }
  });

  if (canaryResult) {
    return res.json(canaryResult);
  }

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

    // Freeze timestamp once — used for updated_at in the outbox payload.
    // Frozen here (before any SQL) so all retries of this handler produce
    // the same timestamp-shaped document.
    const eventOccurredAt = new Date().toISOString();

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

    // ── Availability Validation for modification (same validator, excluding self) ─
    if (roomNumber !== currentRes.room_number || arrivalDate !== currentRes.arrival_date || departureDate !== currentRes.departure_date) {
      try {
        await AvailabilityService.validateAndLockRoom(connection, {
          roomId:                 selectedRoomId,
          roomNumber:             roomNumber,
          arrivalDate,
          departureDate,
          excludeReservationId:   parseInt(id, 10),
        });
      } catch (availErr) {
        await connection.rollback();
        return res.status(availErr.status || 409).json({
          error: availErr.message,
          code:  availErr.code || 'ROOM_ALREADY_BOOKED'
        });
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

    // ── Phase 4G-B: Outbox — COMPOUND_RESERVATION_UPDATED ────────────────────
    // enqueue() MUST use the same connection and run BEFORE commit().
    // aggregate_id = MySQL reservation integer id (from URL param).
    // reservation_number is taken from the existing row — it NEVER changes on update.
    // created_at is intentionally omitted — set_merge preserves the existing value.
    if (isFirestoreDualWriteEnabled()) {
      const updateEvent = new CompoundEventBuilder({
        event_type:     'COMPOUND_RESERVATION_UPDATED',
        aggregate_type: 'RESERVATION',
        aggregate_id:   parseInt(id, 10)
      })
        .addRootWrite({
          collection:  'reservations',
          document_id: formatReservationId(currentRes.reservation_number),
          operation:   'set_merge',
          data: {
            reservation_number:   currentRes.reservation_number,
            guest_name:           guestName.trim(),
            phone:                phone.trim(),
            email:                email || null,
            address:              address || null,
            nationality:          nationality || null,
            company:              company || null,
            purpose:              purpose || null,
            room_id:              formatRoomId(roomNumber),
            mysql_room_id:        selectedRoomId,
            room_number:          roomNumber,
            room_type:            roomType || null,
            // ⚠ Firestore uses check_in_date / check_out_date — NOT arrival_date / departure_date
            check_in_date:        String(arrivalDate),
            check_out_date:       String(departureDate),
            arrival_time:         arrivalTime || null,
            adults:               parseInt(adults, 10) || 1,
            children:             parseInt(children, 10) || 0,
            booking_source:       bookingSource || null,
            booking_mode:         bookingMode || null,
            booked_by:            bookedBy || null,
            booked_by_contact:    bookedByContact || null,
            advance_payment:      parseInt(advancePayment, 10) || 0,
            payment_mode:         paymentMode || null,
            billing_instructions: billingInstructions || null,
            transport_mode:       transportMode || null,
            remarks:              remarks || null,
            status:               status,
            mysql_reservation_id: parseInt(id, 10),
            // created_at intentionally excluded — set_merge preserves the existing value
            updated_at:           eventOccurredAt
          }
        })
        .build();

      // enqueue() MUST run BEFORE commit()
      await enqueue(connection, {
        event_type:     updateEvent.event_type,
        aggregate_type: updateEvent.aggregate_type,
        aggregate_id:   updateEvent.aggregate_id,
        payload:        updateEvent
      });
      console.log(`[reservationController] Compound outbox event enqueued: ${updateEvent.operation_id} (${updateEvent.writes.length} write)`);
    }

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

    // Variables populated per path — used for compound event construction below.
    let cancelBooking   = null; // populated in Path B and C
    let cancelBizDate   = null; // populated in Path B

    // If reservation is associated with a booking (Checked-In or Checked-Out)
    if (current.booking_id) {
      const [bookingRows] = await connection.query(
        'SELECT b.*, g.full_name as guestName FROM bookings b JOIN guests g ON b.guest_id = g.id WHERE b.id = ?',
        [current.booking_id]
      );

      if (bookingRows.length > 0) {
        const booking = bookingRows[0];
        cancelBooking = booking; // capture for compound event
        
        // Fetch current system business date
        const businessDate = await BusinessDateService.getBusinessDate(connection);
        cancelBizDate = businessDate; // capture for compound event (Path B)

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
              `UPDATE rooms SET status = 'dirty' WHERE id = ?`,
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

    // ── Phase 4G-B: Outbox — COMPOUND_RESERVATION_CANCELLED ──────────────────
    // Placed AFTER all MySQL mutations and BEFORE commit().
    // Three paths determined by booking state:
    //   Path A: no booking_id              → 1 write (reservation only)
    //   Path B: booking is Checked In      → 3 writes (reservation + booking + room)
    //   Path C: booking is not Checked In  → 2 writes (reservation + booking)
    if (isFirestoreDualWriteEnabled()) {
      const eventOccurredAt = new Date().toISOString();

      const cancelBuilder = new CompoundEventBuilder({
        event_type:     'COMPOUND_RESERVATION_CANCELLED',
        aggregate_type: 'RESERVATION',
        aggregate_id:   parseInt(id, 10)
      });

      // Write 1 (all paths): reservation → Cancelled
      cancelBuilder.addRootWrite({
        collection:  'reservations',
        document_id: formatReservationId(current.reservation_number),
        operation:   'set_merge',
        data: {
          status:               'Cancelled',
          remarks:              updatedRemarks,
          mysql_reservation_id: parseInt(id, 10),
          updated_at:           eventOccurredAt
        }
      });

      if (cancelBooking) {
        if (cancelBooking.booking_status === 'Checked In') {
          // ── Path B: 3 writes ─────────────────────────────────────────────
          // Write 2: booking → Checked Out / Refunded
          cancelBuilder.addRootWrite({
            collection:  'bookings',
            document_id: formatBookingId(cancelBooking.booking_number),
            operation:   'set_merge',
            data: {
              booking_status: 'Checked Out',
              payment_status: 'Refunded',
              check_out_date: cancelBizDate,
              updated_at:     eventOccurredAt
            }
          });

          // Write 3: room → dirty
          cancelBuilder.addRootWrite({
            collection:  'rooms',
            document_id: formatRoomId(current.room_number),
            operation:   'set_merge',
            data: {
              status:     'dirty',
              updated_at: eventOccurredAt
            }
          });
        } else {
          // ── Path C: 2 writes ─────────────────────────────────────────────
          // Write 2: booking → payment_status Refunded only
          cancelBuilder.addRootWrite({
            collection:  'bookings',
            document_id: formatBookingId(cancelBooking.booking_number),
            operation:   'set_merge',
            data: {
              payment_status: 'Refunded',
              updated_at:     eventOccurredAt
            }
          });
        }
      }
      // Path A: no cancelBooking → only the reservation write above (1 write total).

      const cancelEvent = cancelBuilder.build();
      // enqueue() MUST use the same connection and run BEFORE commit()
      await enqueue(connection, {
        event_type:     cancelEvent.event_type,
        aggregate_type: cancelEvent.aggregate_type,
        aggregate_id:   cancelEvent.aggregate_id,
        payload:        cancelEvent
      });
      console.log(`[reservationController] Compound outbox event enqueued: ${cancelEvent.operation_id} (${cancelEvent.writes.length} write(s))`);
    }

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
