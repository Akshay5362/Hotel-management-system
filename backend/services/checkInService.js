import { formatTime } from '../utils/dateUtils.js';
import { BusinessDateService } from './businessDateService.js';

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
  mealPlan = 'EP'
}) => {
  // Validate optional fields (ignore invalid values gracefully — use default)
  const resolvedBilling = ALLOWED_BILLING_INSTRUCTIONS.includes(billingInstruction)
    ? billingInstruction
    : 'Direct to Guest';
  const resolvedMealPlan = ALLOWED_MEAL_PLANS.includes(mealPlan)
    ? mealPlan
    : 'EP';
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
    throw { status: 400, message: `Room ${roomNumber} is not vacant or booked. Current status: ${room.status}` };
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
    const [existingGuests] = await connection.query('SELECT id FROM guests WHERE phone = ? LIMIT 1', [phone || '']);
    if (existingGuests.length > 0) {
      finalGuestId = existingGuests[0].id;
    } else {
      const [newGuestRes] = await connection.query(
        'INSERT INTO guests (full_name, phone, email, address, country) VALUES (?, ?, ?, ?, ?)',
        [guestNameUpper, phone || '', email || '', address || '', country || '']
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

  await connection.query(
    "INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)",
    [roomNumber, 'Room Tariff (Incl. GST)', tariffAmount, businessDate, bookingId]
  );

  // 8. Payments & Cash Logs
  if (deposit > 0) {
    if (paymentMethod === 'Razorpay' && transactionId) {
      await connection.query(
        "UPDATE razorpay_transactions SET booking_id = ? WHERE id = ?",
        [bookingId, transactionId]
      );
    }
    const timeStr = formatTime(new Date());
    if (paymentMethod === 'Cash') {
      await connection.query(
        `INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
        VALUES (?, ?, ?, 'Advance Deposit', ?, ?, ?)`,
        [timeStr, roomNumber, guestNameUpper, deposit, businessDate, bookingId]
      );
    }
    await connection.query(
      `INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
      VALUES (?, ?, ?, 'Advance Deposit', ?)`,
      [bookingId, deposit, paymentMethod, businessDate]
    );
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

  return { bookingId, roomNumber };
};
