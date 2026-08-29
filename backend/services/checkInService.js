import { formatTime } from '../utils/dateUtils.js';
import { BusinessDateService } from './businessDateService.js';

// Allowed values for optional enumerated fields
const ALLOWED_BILLING_INSTRUCTIONS = ['Direct to Guest', 'Bill to Company', 'Room Tariff Only'];
const ALLOWED_MEAL_PLANS           = ['EP', 'CP', 'MAP', 'AP'];
const ALLOWED_PURPOSES             = ['Official', 'Function', 'Tourist', 'Personal', 'Business'];
const ALLOWED_PAYMENT_MODES        = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];

// Build an entry time string "HH:MM AM/PM" from a Date object
function buildTimeOfEntry(date) {
  const h   = date.getHours();
  const m   = date.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Compute the expected checkout date = next calendar day at 11:00 AM
// Result format: "YYYY-MM-DD 11:00"  (safe for existing parseToComparableDate consumers)
function computeExpectedCheckout(checkInDateStr) {
  if (!checkInDateStr) return '';
  const str = String(checkInDateStr).trim();
  let yyyy = null, mm = null, dd = null;

  // Pattern 1: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const clean = str.split(' ')[0].split('T')[0];
    const [y, m, d] = clean.split('-').map(Number);
    yyyy = y; mm = m; dd = d;
  }
  // Pattern 2: DD-Mon-YYYY (e.g. 19-Aug-2026)
  else if (/^\d{1,2}-[A-Za-z]{3}-\d{4}/.test(str)) {
    const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
    const parts = str.split(' ')[0].split('T')[0].split('-');
    dd = parseInt(parts[0], 10);
    mm = MONTHS[parts[1].toLowerCase()] || null;
    yyyy = parseInt(parts[2], 10);
  }
  // Pattern 3: DD-MM-YYYY
  else if (/^\d{1,2}-\d{1,2}-\d{4}/.test(str)) {
    const parts = str.split(' ')[0].split('T')[0].split('-');
    dd = parseInt(parts[0], 10);
    mm = parseInt(parts[1], 10);
    yyyy = parseInt(parts[2], 10);
  }

  if (yyyy && mm && dd && !isNaN(yyyy) && !isNaN(mm) && !isNaN(dd)) {
    const dt = new Date(Date.UTC(yyyy, mm - 1, dd + 1));
    const nextY = dt.getUTCFullYear();
    const nextM = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const nextD = String(dt.getUTCDate()).padStart(2, '0');
    return `${nextY}-${nextM}-${nextD} 11:00`;
  }

  return '';
}

// Normalize user-supplied or default expected checkout string
function normalizeExpectedCheckout(val, checkInDateStr) {
  if (!val || typeof val !== 'string' || val.trim() === '' || val.includes('NaN')) {
    return computeExpectedCheckout(checkInDateStr);
  }
  const trimmed = val.trim();
  // "YYYY-MM-DDTHH:mm" -> "YYYY-MM-DD HH:mm"
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    const [d, t] = trimmed.split('T');
    return `${d} ${t.substring(0, 5)}`;
  }
  // "YYYY-MM-DD" -> "YYYY-MM-DD 11:00"
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed} 11:00`;
  }
  // "YYYY-MM-DD HH:mm"
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(trimmed)) {
    return trimmed.substring(0, 16);
  }
  return trimmed;
}

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
  expectedCheckoutDate = null,
  departureDate = null,
  billingInstruction = 'Direct to Guest',
  mealPlan = 'EP',
  dateOfBirth = null,
  dob = null,
  // ── New fields (Phase C) ──────────────────────────────────────────────────
  roomTariff      = null,   // booking-specific negotiated tariff (overrides room.rate)
  paymentMode     = null,   // Cash|UPI|Card|Bank Transfer|Other|null
  purposeOfVisit  = null,   // Official|Function|Tourist|Personal|Business
  companyName     = '',     // optional company name
  gstNo           = '',     // optional GST number (stored on guest)
  city            = '',     // optional guest city
  state           = ''      // optional guest state
}) => {
  // Validate optional fields (ignore invalid values gracefully — use default)
  const resolvedBilling = ALLOWED_BILLING_INSTRUCTIONS.includes(billingInstruction)
    ? billingInstruction
    : 'Direct to Guest';
  const resolvedMealPlan = ALLOWED_MEAL_PLANS.includes(mealPlan)
    ? mealPlan
    : 'EP';
  const resolvedDob     = dateOfBirth || dob || null;
  const resolvedPurpose = ALLOWED_PURPOSES.includes(purposeOfVisit) ? purposeOfVisit : null;
  const resolvedPayMode = ALLOWED_PAYMENT_MODES.includes(paymentMode) ? paymentMode : null;

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
  const roomStatusNorm = (room.status || '').toLowerCase();
  if (roomStatusNorm !== 'vacant' && roomStatusNorm !== 'booked') {
    if (roomStatusNorm === 'dirty' && manualOverride) {
      // Allowed via manual override
    } else {
      throw { status: 400, message: `Room ${roomNumber} is not vacant or booked. Current status: ${room.status}` };
    }
  }

  // Dirty check
  if (roomStatusNorm === 'dirty' || String(room.housekeeping_status).toLowerCase() === 'dirty') {
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
    guestName  = guestName  || reservation.guest_name;
    phone      = phone      || reservation.phone;
    email      = email      || reservation.email;
    address    = address    || reservation.address;
    country    = country    || reservation.nationality;
    state      = state      || reservation.state      || '';
    companyName = companyName || reservation.company  || '';
    purposeOfVisit = purposeOfVisit || (ALLOWED_PURPOSES.includes(reservation.purpose) ? reservation.purpose : null);
    pax      = Math.max(pax, reservation.adults || 1);
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
    const [existingGuests] = await connection.query(
      'SELECT id, date_of_birth, gst_no, company_name, city, state FROM guests WHERE phone = ? LIMIT 1 FOR UPDATE',
      [phone || '']
    );
    if (existingGuests.length > 0) {
      finalGuestId = existingGuests[0].id;
      // Update any new information on the existing guest record
      const updateFields = [];
      const updateVals   = [];
      if (resolvedDob && !existingGuests[0].date_of_birth) { updateFields.push('date_of_birth = ?'); updateVals.push(resolvedDob); }
      if (gstNo && !existingGuests[0].gst_no)              { updateFields.push('gst_no = ?');        updateVals.push(gstNo); }
      if (companyName)                                     { updateFields.push('company_name = ?');  updateVals.push(companyName); }
      if (city)                                            { updateFields.push('city = ?');          updateVals.push(city); }
      if (state)                                           { updateFields.push('state = ?');         updateVals.push(state); }
      if (updateFields.length > 0) {
        updateVals.push(finalGuestId);
        await connection.query(`UPDATE guests SET ${updateFields.join(', ')} WHERE id = ?`, updateVals);
      }
    } else {
      const [newGuestRes] = await connection.query(
        'INSERT INTO guests (full_name, phone, email, address, country, date_of_birth, gst_no, company_name, city, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [guestNameUpper, phone || '', email || '', address || '', country || '', resolvedDob, gstNo || '', companyName || '', city || '', state || '']
      );
      finalGuestId = newGuestRes.insertId;
    }
  }

  // 5. Create Booking
  // resolvedTariff: use negotiated tariff if valid and positive; otherwise room base rate
  const resolvedTariff = (roomTariff !== null && roomTariff !== undefined && Number.isFinite(Number(roomTariff)) && Number(roomTariff) >= 0)
    ? Math.round(Number(roomTariff))
    : (room.rate || 0);

  // Expected checkout date at 11:00 AM (customizable by client, fallback to D+1 at 11:00)
  const resolvedExpectedCheckout = normalizeExpectedCheckout(expectedCheckoutDate || departureDate, actualCheckInDate);

  const resolvedUserIdNum = (resolvedUserId && Number.isInteger(Number(resolvedUserId)) && Number(resolvedUserId) > 0)
    ? Number(resolvedUserId)
    : null;

  const bookingNumber = 'BKG-' + Math.floor(100000 + Math.random() * 900000);
  const [bResult] = await connection.query(
    `INSERT INTO bookings (
      booking_number, guest_id, room_id, check_in_date, expected_check_out_date,
      adults, children, booking_status, payment_status, total_amount, advance_amount, created_by,
      billing_instruction, meal_plan, room_tariff, payment_mode, purpose_of_visit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Checked In', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      bookingNumber, finalGuestId, room.id, actualCheckInDate, resolvedExpectedCheckout,
      pax, children, deposit > 0 ? 'Partial' : 'Pending',
      resolvedTariff, deposit, resolvedUserIdNum,
      resolvedBilling, resolvedMealPlan, resolvedTariff, resolvedPayMode, resolvedPurpose
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
  const tariffAmount = resolvedTariff;
  const entryNow     = new Date();
  const timeOfEntry  = buildTimeOfEntry(entryNow);

  const [ledgerResult] = await connection.query(
    `INSERT INTO ledger_items (room_number, \`desc\`, qty, amount, business_date, booking_id,
      transaction_type, credit_amount, time_of_entry, created_by)
     VALUES (?, ?, 1, ?, ?, ?, 'CHARGE', 0, ?, ?)`,
    [roomNumber, 'Room Tariff (Incl. GST)', tariffAmount, businessDate, bookingId, timeOfEntry, resolvedUserIdNum]
  );
  const ledgerMysqlId = ledgerResult.insertId;

  // 7b. PAYMENT ledger entry if advance deposit was provided
  let paymentLedgerMysqlId = null;
  if (deposit > 0) {
    const [payLedgerResult] = await connection.query(
      `INSERT INTO ledger_items (room_number, \`desc\`, qty, amount, credit_amount, business_date, booking_id,
        transaction_type, payment_mode, time_of_entry, created_by)
       VALUES (?, ?, 1, 0, ?, ?, ?, 'PAYMENT', ?, ?, ?)`,
      [roomNumber, `Advance Deposit (${resolvedPayMode || paymentMethod || 'Cash'})`, deposit, businessDate, bookingId,
       resolvedPayMode || paymentMethod || null, timeOfEntry, resolvedUserIdNum]
    );
    paymentLedgerMysqlId = payLedgerResult.insertId;
  }

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
    [room.id, room.status, resolvedUserIdNum, businessDate]
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
      [resolvedUserIdNum, '🎉 Welcome to Hotel Sky-5!', `You have successfully checked in to Room ${roomNumber}. Enjoy your stay!`]
    );
    await connection.query(
      "INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'GUEST_CHECKIN', ?, ?)",
      [resolvedUserIdNum, `Guest self check-in for Room ${roomNumber}. Booking ID: ${bookingId}`, businessDate]
    );
  } else {
    await connection.query(
      "INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'CHECK_IN', ?, ?)",
      [resolvedUserIdNum, `Checked in guest ${guestNameUpper} into Room ${roomNumber}. Booking ID: ${bookingId}`, businessDate]
    );
  }

  return { bookingId, roomNumber };
};
