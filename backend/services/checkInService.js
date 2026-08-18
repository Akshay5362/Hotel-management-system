import { formatTime } from '../utils/dateUtils.js';
import { BusinessDateService } from './businessDateService.js';
import { isFirestoreDualWriteEnabled } from '../config/featureFlags.js';
import { enqueue } from './outboxService.js';
import {
  createCompoundEventBuilder,
  formatBookingId,
  formatRoomId,
  formatGuestId,
  formatReservationId,
  formatLedgerItemId,
  formatPaymentId,
  formatCashLogId
} from './compoundEventBuilder.js';

// Allowed values for the two new optional fields
const ALLOWED_BILLING_INSTRUCTIONS = ['Direct to Guest', 'Bill to Company', 'Room Tariff Only'];
const ALLOWED_MEAL_PLANS           = ['EP', 'CP', 'MAP', 'AP'];

export const processCheckIn = async (connection, {
  roomNumber,
  guestName,
  phone,
  email,
  address,
  country,
  pax = 1,
  children = 0,
  deposit = 0,
  paymentMethod = 'Cash',
  transactionId = null,
  manualOverride = false,
  checkInDate,
  resolvedUserId,
  reservationId = null,
  isGuestSelfCheckIn = false,
  guestId = null,
  departureDate = null,
  billingInstruction = 'Direct to Guest',
  mealPlan = 'EP',
  dateOfBirth = null,
  dob = null
}) => {
  // Validate optional fields (ignore invalid values gracefully — use default)
  const resolvedBilling = ALLOWED_BILLING_INSTRUCTIONS.includes(billingInstruction)
    ? billingInstruction
    : 'Direct to Guest';
  const resolvedMealPlan = ALLOWED_MEAL_PLANS.includes(mealPlan)
    ? mealPlan
    : 'EP';
  const resolvedDob = dateOfBirth || dob || null;

  // 1. Get Business Date
  const businessDate = await BusinessDateService.getBusinessDate(connection);
  if (!businessDate) throw new Error('System configuration error: Business Date is missing.');

  const actualCheckInDate = checkInDate || businessDate;

  // 2. Lock Room
  const [roomRows] = await connection.query(
    `SELECT r.*, rt.base_rate as rate, rt.code as type
    FROM rooms r
    JOIN room_types rt ON r.room_type_id = rt.id
    WHERE r.number = ? FOR UPDATE`,
    [roomNumber]
  );

  if (roomRows.length === 0) {
    throw { status: 404, message: `Room ${roomNumber} not found` };
  }
  const room = roomRows[0];

  // Inactive Room Check
  if (room.is_active === 0 || room.is_active === false || room.is_active === '0') {
    throw { status: 400, message: `Room ${roomNumber} is inactive and unavailable for check-in.`, code: 'ROOM_INACTIVE' };
  }

  if (room.status === 'occupied') {
    // Verify a real active 'Checked In' booking backs this status.
    // If none exists (ghost/orphaned status from a failed or missed checkout),
    // auto-correct the room to vacant and allow the new check-in to proceed.
    const [activeCheckedIn] = await connection.query(
      `SELECT id FROM bookings
       WHERE room_id = ? AND booking_status = 'Checked In' LIMIT 1`,
      [room.id]
    );
    if (activeCheckedIn.length > 0) {
      // Real occupied — block as expected
      throw { status: 400, message: `Room ${roomNumber} is already occupied (Already Checked-In).`, code: 'ALREADY_CHECKED_IN' };
    }
    // Ghost status — auto-heal and continue
    await connection.query(
      `UPDATE rooms SET status = 'vacant' WHERE id = ?`,
      [room.id]
    );
    room.status = 'vacant';
    console.warn(`[checkInService] Auto-corrected ghost occupied status for Room ${roomNumber} (no active Checked In booking found).`);
  }
  if (room.status !== 'vacant' && room.status !== 'booked') {
    if (room.status === 'dirty' && manualOverride) {
      // Allowed via manual override
    } else {
      throw { status: 400, message: `Room ${roomNumber} is not vacant or booked. Current status: ${room.status}` };
    }
  }

  // Dirty check
  if (room.status === 'dirty' || room.housekeeping_status === 'Dirty') {
    if (!manualOverride) {
      throw { status: 400, message: `Room ${roomNumber} has pending housekeeping (Dirty).`, code: 'ROOM_DIRTY' };
    }
  }

  // 3. Resolve Reservation
  let reservation = null;
  if (reservationId) {
    const [resRows] = await connection.query('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [reservationId]);
    if (resRows.length > 0) reservation = resRows[0];
  } else {
    const [resRows] = await connection.query(
      `SELECT * FROM reservations 
      WHERE room_number = ? 
        AND arrival_date <= ? 
        AND departure_date >= ?
        AND status IN ('Reserved', 'Confirmed')
      ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      [roomNumber, actualCheckInDate, actualCheckInDate]
    );
    if (resRows.length > 0) reservation = resRows[0];
  }

  if (reservation) {
    if (reservation.status === 'Checked-In') {
      throw { status: 400, message: 'Reservation is already checked in.', code: 'ALREADY_CHECKED_IN' };
    }
    if (reservation.status === 'Cancelled') {
      throw { status: 400, message: 'Cannot check in a cancelled reservation.' };
    }
    // Pull defaults from reservation if not provided
    guestName = guestName || reservation.guest_name;
    phone = phone || reservation.phone;
    email = email || reservation.email;
    address = address || reservation.address;
    country = country || reservation.nationality;
    pax = Math.max(pax, reservation.adults || 1);
    children = Math.max(children, reservation.children || 0);
    departureDate = departureDate || reservation.departure_date;
    if (deposit === 0 && reservation.advance_payment > 0) {
      deposit = reservation.advance_payment;
      paymentMethod = reservation.payment_mode || 'Cash';
    }
  }

  // 4. Resolve Guest
  let finalGuestId = guestId;
  const guestNameUpper = guestName ? guestName.trim().toUpperCase() : 'UNKNOWN';
  
  if (!finalGuestId) {
    const [existingGuests] = await connection.query('SELECT id, date_of_birth FROM guests WHERE phone = ? LIMIT 1 FOR UPDATE', [phone || '']);
    if (existingGuests.length > 0) {
      finalGuestId = existingGuests[0].id;
      if (resolvedDob && !existingGuests[0].date_of_birth) {
        await connection.query('UPDATE guests SET date_of_birth = ? WHERE id = ?', [resolvedDob, finalGuestId]);
      }
    } else {
      const [newGuestRes] = await connection.query(
        'INSERT INTO guests (full_name, phone, email, address, country, date_of_birth) VALUES (?, ?, ?, ?, ?, ?)',
        [guestNameUpper, phone || '', email || '', address || '', country || '', resolvedDob]
      );
      finalGuestId = newGuestRes.insertId;
    }
  }

  // 5. Create Booking
  const bookingNumber = 'BKG-' + Math.floor(100000 + Math.random() * 900000);
  const [bResult] = await connection.query(
    `INSERT INTO bookings (
      booking_number, guest_id, room_id, check_in_date, expected_check_out_date,
      adults, children, booking_status, payment_status, total_amount, advance_amount, created_by,
      billing_instruction, meal_plan
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Checked In', ?, ?, ?, ?, ?, ?)`,
    [
      bookingNumber, finalGuestId, room.id, actualCheckInDate, departureDate || actualCheckInDate,
      pax, children, deposit > 0 ? 'Partial' : 'Pending',
      room.rate, deposit, resolvedUserId,
      resolvedBilling, resolvedMealPlan
    ]
  );
  const bookingId = bResult.insertId;

  // 6. Link & Update Reservation
  if (reservation) {
    await connection.query(
      "UPDATE reservations SET status = 'Checked-In', booking_id = ? WHERE id = ?",
      [bookingId, reservation.id]
    );
  }

  // 7. Ledger Items — GST is INCLUDED in the room rate (no separate tax line)
  const tariffAmount = room.rate || 0;

  const [ledgerResult] = await connection.query(
    "INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)",
    [roomNumber, 'Room Tariff (Incl. GST)', tariffAmount, businessDate, bookingId]
  );
  const ledgerMysqlId = ledgerResult.insertId;

  // 8. Payments & Cash Logs
  // Declared in outer scope so compound event builder can access them below.
  let paymentMysqlId  = null;
  let cashLogMysqlId  = null;
  if (deposit > 0) {
    if (paymentMethod === 'Razorpay' && transactionId) {
      await connection.query(
        "UPDATE razorpay_transactions SET booking_id = ? WHERE id = ?",
        [bookingId, transactionId]
      );
    }
    const timeStr = formatTime(new Date());
    if (paymentMethod === 'Cash') {
      const [cashLogResult] = await connection.query(
        `INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
        VALUES (?, ?, ?, 'Advance Deposit', ?, ?, ?)`,
        [timeStr, roomNumber, guestNameUpper, deposit, businessDate, bookingId]
      );
      cashLogMysqlId = cashLogResult.insertId;
    }
    const [paymentResult] = await connection.query(
      `INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
      VALUES (?, ?, ?, 'Advance Deposit', ?)`,
      [bookingId, deposit, paymentMethod, businessDate]
    );
    paymentMysqlId = paymentResult.insertId;
  }

  // 9. Update Room & Counters
  await connection.query("UPDATE rooms SET status = 'occupied' WHERE id = ?", [room.id]);
  await connection.query(
    `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
    VALUES (?, ?, 'occupied', ?, ?)`,
    [room.id, room.status, resolvedUserId, businessDate]
  );

  await connection.query(
    "UPDATE system_settings SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR) WHERE key_name = 'today_checkins'"
  );
  // Read the absolute post-increment value inside this transaction.
  // The compound event must contain the final MySQL value — never FieldValue.increment().
  const [[checkinCounterRow]] = await connection.query(
    "SELECT value_val FROM system_settings WHERE key_name = 'today_checkins'"
  );
  const todayCheckinsAbsolute = Number(checkinCounterRow.value_val);

  // 10. Audit Log & Notifications
  if (isGuestSelfCheckIn) {
    await connection.query(
      "INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)",
      [resolvedUserId, '🎉 Welcome to Hotel Sky-5!', `You have successfully checked in to Room ${roomNumber}. Enjoy your stay!`]
    );
    await connection.query(
      "INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'GUEST_CHECKIN', ?, ?)",
      [resolvedUserId, `Guest self check-in for Room ${roomNumber}. Booking ID: ${bookingId}`, businessDate]
    );
  } else {
    await connection.query(
      "INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'CHECK_IN', ?, ?)",
      [resolvedUserId, `Checked in guest ${guestNameUpper} into Room ${roomNumber}. Booking ID: ${bookingId}`, businessDate]
    );
  }

  // ── Phase 4E-B3: Compound Outbox Event ──────────────────────────────────────
  // The compound event is enqueued on the SAME connection as the business
  // mutations. If enqueue throws, the entire transaction rolls back — no partial
  // Firestore state is possible.
  //
  // The event is only processed by the Outbox worker when
  // ENABLE_FIRESTORE_OUTBOX_WORKER=true (currently false in production).
  if (isFirestoreDualWriteEnabled()) {
    const eventOccurredAt = new Date().toISOString();
    const bkgDocId  = formatBookingId(bookingNumber);
    // Canonical guest document ID: the guest repository uses phone as the key
    // for phone-based guests, or the MySQL guest PK as fallback (walk-ins without phone).
    const guestDocId = formatGuestId(phone || finalGuestId);

    const builder = createCompoundEventBuilder({
      event_type:     'COMPOUND_CHECKIN',
      aggregate_type: 'BOOKING',
      aggregate_id:   bookingNumber,
      operation_id:   `op_checkin_${bookingNumber}_${bookingId}`,
      occurred_at:    eventOccurredAt,
      business_date:  businessDate
    });

    // 1. Booking document (root)
    builder.addRootWrite({
      collection:  'bookings',
      document_id: bkgDocId,
      operation:   'set_merge',
      data: {
        booking_number:           bookingNumber,
        guest_id:                 guestDocId,
        mysql_guest_id:           finalGuestId,
        guest_name:               guestNameUpper,
        room_id:                  formatRoomId(roomNumber),
        mysql_room_id:            room.id,
        room_number:              roomNumber,
        check_in_date:            actualCheckInDate,
        expected_check_out_date:  departureDate || actualCheckInDate,
        check_out_date:           null,
        adults:                   pax,
        children,
        booking_status:           'Checked In',
        payment_status:           deposit > 0 ? 'Partial' : 'Pending',
        total_amount:             tariffAmount,
        advance_amount:           deposit,
        billing_instruction:      resolvedBilling,
        meal_plan:                resolvedMealPlan,
        mysql_booking_id:         bookingId,
        created_at:               eventOccurredAt,
        updated_at:               eventOccurredAt
      }
    });

    // 2. Room document (root)
    builder.addRootWrite({
      collection:  'rooms',
      document_id: formatRoomId(roomNumber),
      operation:   'set_merge',
      data: {
        status:             'occupied',
        current_booking_id: bkgDocId,
        updated_at:         eventOccurredAt
      }
    });

    // 3. Guest document (root)
    builder.addRootWrite({
      collection:  'guests',
      document_id: guestDocId,
      operation:   'set_merge',
      data: {
        full_name:      guestNameUpper,
        phone:          phone || '',
        email:          email || '',
        address:        address || '',
        country:        country || '',
        mysql_guest_id: finalGuestId,
        updated_at:     eventOccurredAt
      }
    });

    // 4. Reservation document (root, conditional)
    if (reservation) {
      builder.addRootWrite({
        collection:  'reservations',
        document_id: formatReservationId(reservation.id),
        operation:   'set_merge',
        data: {
          status:           'Checked-In',
          booking_id:       bkgDocId,
          mysql_booking_id: bookingId,
          updated_at:       eventOccurredAt
        }
      });
    }

    // 5+6. Ledger item (root + booking subcollection — dual write)
    const ledgerDocId  = formatLedgerItemId(ledgerMysqlId);
    const ledgerData   = {
      item_id:          ledgerDocId,
      booking_id:       bkgDocId,
      mysql_booking_id: bookingId,
      room_number:      roomNumber,
      description:      'Room Tariff (Incl. GST)',
      desc:             'Room Tariff (Incl. GST)',
      qty:              1,
      quantity:         1,
      amount:           tariffAmount,
      type:             'CHARGE',
      status:           'Pending',
      business_date:    businessDate,
      mysql_ledger_id:  ledgerMysqlId,
      created_at:       eventOccurredAt
    };
    builder.addDualWrite({
      rootCollection:   'ledger_items',
      document_id:       ledgerDocId,
      parentCollection:  'bookings',
      parent_id:         bkgDocId,
      subcollection:     'ledger_items',
      operation:         'set_merge',
      data:              ledgerData
    });

    // 7+8. Payment (root + booking subcollection — dual write, conditional)
    if (deposit > 0) {
      const paymentDocId = formatPaymentId(paymentMysqlId);
      const paymentData  = {
        payment_id:       paymentDocId,
        booking_id:       bkgDocId,
        mysql_booking_id: bookingId,
        amount:           deposit,
        payment_method:   paymentMethod,
        payment_status:   'Completed',
        payment_type:     'Advance Deposit',
        business_date:    businessDate,
        mysql_payment_id: paymentMysqlId,
        created_at:       eventOccurredAt
      };
      builder.addDualWrite({
        rootCollection:   'payments',
        document_id:       paymentDocId,
        parentCollection:  'bookings',
        parent_id:         bkgDocId,
        subcollection:     'payments',
        operation:         'set_merge',
        data:              paymentData
      });

      // 9. Cash log (root only, conditional — cash_logs collection has no subcollection)
      if (paymentMethod === 'Cash' && cashLogMysqlId !== null) {
        builder.addRootWrite({
          collection:  'cash_logs',
          document_id: formatCashLogId(cashLogMysqlId),
          operation:   'set_merge',
          data: {
            log_id:           formatCashLogId(cashLogMysqlId),
            amount:           deposit,
            type:             'Advance Deposit',
            category:         'Room Payment',
            description:      `Advance Deposit for ${roomNumber} — ${guestNameUpper}`,
            booking_id:       bkgDocId,
            mysql_booking_id: bookingId,
            business_date:    businessDate,
            mysql_cash_log_id: cashLogMysqlId,
            created_at:       eventOccurredAt
          }
        });
      }
    }

    // 10. Settings/counter document — absolute today_checkins
    builder.addRootWrite({
      collection:  'settings',
      document_id: 'system_date',
      operation:   'set_merge',
      data: {
        today_checkins: todayCheckinsAbsolute
      }
    });

    const compoundPayload = builder.build();

    await enqueue(connection, {
      event_type:     compoundPayload.event_type,
      aggregate_type: compoundPayload.aggregate_type,
      aggregate_id:   compoundPayload.aggregate_id,
      payload:        compoundPayload
    });

    console.log(`[checkInService] Compound outbox event enqueued: ${compoundPayload.operation_id} (${compoundPayload.writes.length} writes)`);
  }

  return { bookingId, roomNumber };
};
