import { db } from '../../config/firebaseAdmin.js';
import { formatTime } from '../../utils/dateUtils.js';

const ALLOWED_BILLING_INSTRUCTIONS = ['Direct to Guest', 'Bill to Company', 'Room Tariff Only'];
const ALLOWED_MEAL_PLANS           = ['EP', 'CP', 'MAP', 'AP'];
const ALLOWED_PURPOSES             = ['Official', 'Function', 'Tourist', 'Personal', 'Business'];
const ALLOWED_PAYMENT_MODES        = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];

// Build entry time string "HH:MM AM/PM"
function buildTimeOfEntry(date) {
  const h   = date.getHours();
  const m   = date.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Compute the expected checkout date = next calendar day at 11:00 AM
export function computeExpectedCheckout(checkInDateStr) {
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
export function normalizeExpectedCheckout(val, checkInDateStr) {
  if (!val || typeof val !== 'string' || val.trim() === '' || val.includes('NaN')) {
    return computeExpectedCheckout(checkInDateStr);
  }
  const trimmed = val.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    const [d, t] = trimmed.split('T');
    return `${d} ${t.substring(0, 5)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed} 11:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(trimmed)) {
    return trimmed.substring(0, 16);
  }
  return trimmed;
}

/**
 * Atomic Firestore Transaction Adapter for Check-In.
 * Guarantees absolute race-condition safety, idempotency, and full business rule parity.
 */
export const processCheckInFirestoreTransaction = async ({
  roomNumber,
  guestName,
  age = null,
  phone,
  email = '',
  address = '',
  country = '',
  pax = 1,
  children = 0,
  deposit = 0,
  paymentMethod = 'Cash',
  transactionId = null,
  manualOverride = false,
  checkInDate,
  resolvedUserId = 'admin',
  reservationId = null,
  isGuestSelfCheckIn = false,
  guestId = null,
  expectedCheckoutDate = null,
  departureDate = null,
  billingInstruction = 'Direct to Guest',
  mealPlan = 'EP',
  dateOfBirth = null,
  dob = null,
  roomTariff = null,
  paymentMode = null,
  purposeOfVisit = null,
  companyName = '',
  gstNo = '',
  city = '',
  state = '',
  pincode = '',
  gender = null,
  businessDate = null,
  idempotencyKey = null
}) => {
  if (!db) {
    throw new Error('Firebase Admin DB is not initialized.');
  }

  const resolvedBilling = ALLOWED_BILLING_INSTRUCTIONS.includes(billingInstruction)
    ? billingInstruction
    : 'Direct to Guest';
  const resolvedMealPlan = ALLOWED_MEAL_PLANS.includes(mealPlan)
    ? mealPlan
    : 'EP';
  const resolvedDob     = dateOfBirth || dob || null;
  const resolvedPurpose = ALLOWED_PURPOSES.includes(purposeOfVisit) ? purposeOfVisit : null;
  const resolvedPayMode = ALLOWED_PAYMENT_MODES.includes(paymentMode) ? paymentMode : null;

  // Determine system business date if not explicitly passed
  let actualBusinessDate = businessDate;
  if (!actualBusinessDate) {
    const today = new Date();
    actualBusinessDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }
  const actualCheckInDate = checkInDate || actualBusinessDate;
  let guestNameUpper = guestName ? String(guestName).trim().toUpperCase() : 'UNKNOWN';

  // Execute inside Firestore Atomic Transaction with maxAttempts: 2 to avoid excessive backoff
  return await db.runTransaction(async (transaction) => {
    // 0. IDEMPOTENCY CHECK (Inside Transaction)
    if (idempotencyKey) {
      const idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
      const idemSnap = await transaction.get(idemRef);
      if (idemSnap.exists) {
        const idemData = idemSnap.data();
        if (idemData.status === 'COMPLETED' && idemData.result) {
          console.log(`[CheckInFirestore] Idempotent request replayed for key: ${idempotencyKey}`);
          return { ...idemData.result, replayed: true };
        }
      }
    }

    // 1. READ ROOM DOCUMENT (Inside Transaction)
    const roomRef = db.collection('rooms').doc(`room_${roomNumber}`);
    const roomSnap = await transaction.get(roomRef);

    if (!roomSnap.exists) {
      throw { status: 404, message: `Room ${roomNumber} not found`, code: 'ROOM_NOT_FOUND' };
    }

    const roomData = roomSnap.data();

    // Inactive Room Validation
    if (roomData.is_active === false || roomData.is_active === 0 || roomData.is_active === '0') {
      throw { status: 400, message: `Room ${roomNumber} is inactive and unavailable for check-in.`, code: 'ROOM_INACTIVE' };
    }

    // Occupied Room Validation & Ghost Auto-Healing
    if (roomData.status === 'occupied') {
      // In Firestore, if status is occupied, check if current_booking_id is active
      if (roomData.current_booking_id) {
        const bkgRef = db.collection('bookings').doc(roomData.current_booking_id);
        const bkgSnap = await transaction.get(bkgRef);
        if (bkgSnap.exists && bkgSnap.data().booking_status === 'Checked In') {
          throw { status: 400, message: `Room ${roomNumber} is already occupied (Already Checked-In).`, code: 'ALREADY_CHECKED_IN' };
        }
      } else {
        throw { status: 400, message: `Room ${roomNumber} is already occupied (Already Checked-In).`, code: 'ALREADY_CHECKED_IN' };
      }
    }

    // Housekeeping Dirty Check
    const isDirty = roomData.housekeeping_status === 'Dirty' || roomData.status === 'dirty';
    if (isDirty && !manualOverride) {
      throw { status: 400, message: `Room ${roomNumber} has pending housekeeping (Dirty).`, code: 'ROOM_DIRTY' };
    }

    // 2. RESOLVE RESERVATION (if applicable)
    let resRef = null;
    let resData = null;
    if (reservationId) {
      resRef = db.collection('reservations').doc(String(reservationId).startsWith('res_') ? String(reservationId) : `res_${reservationId}`);
      const resSnap = await transaction.get(resRef);
      if (resSnap.exists) {
        resData = resSnap.data();
        if (resData.status === 'Checked-In') {
          throw { status: 400, message: 'Reservation is already checked in.', code: 'ALREADY_CHECKED_IN' };
        }
        if (resData.status === 'Cancelled') {
          throw { status: 400, message: 'Cannot check in a cancelled reservation.' };
        }
        // Fall back to the linked reservation's guest identity when the
        // caller did not explicitly supply one, so reservation-linked
        // check-ins reuse the existing guest document instead of creating
        // a new timestamp-keyed one.
        if (!guestName && resData.guest_name) {
          guestNameUpper = String(resData.guest_name).trim().toUpperCase();
        }
      }
    }

    // 3. RESOLVE GUEST DOCUMENT
    const resolvedPhone = phone || (resData && resData.phone) || null;
    const phoneKey = resolvedPhone ? String(resolvedPhone).trim() : (guestId || `guest_${Date.now()}`);
    const guestRef = db.collection('guests').doc(String(phoneKey).startsWith('guest_') ? String(phoneKey) : `guest_${phoneKey}`);
    const guestSnap = await transaction.get(guestRef);

    const nowIso = new Date().toISOString();
    const guestData = {
      full_name: guestNameUpper,
      phone: resolvedPhone || '',
      email: email || (guestSnap.exists ? guestSnap.data().email : (resData ? resData.email : '')) || '',
      age: (age !== undefined && age !== null) ? Number(age) : (guestSnap.exists ? (guestSnap.data().age || null) : null),
      address: address || (guestSnap.exists ? guestSnap.data().address : (resData ? resData.address : '')) || '',
      country: country || (guestSnap.exists ? guestSnap.data().country : (resData ? resData.nationality : '')) || '',
      date_of_birth: resolvedDob || (guestSnap.exists ? (guestSnap.data().date_of_birth || null) : null),
      gst_no: gstNo || (guestSnap.exists ? guestSnap.data().gst_no : '') || '',
      company_name: companyName || (guestSnap.exists ? guestSnap.data().company_name : '') || '',
      city: city || (guestSnap.exists ? guestSnap.data().city : '') || '',
      state: state || (guestSnap.exists ? guestSnap.data().state : '') || '',
      pincode: pincode || (guestSnap.exists ? (guestSnap.data().pincode || '') : '') || '',
      gender: gender || (guestSnap.exists ? (guestSnap.data().gender || null) : null),
      updated_at: nowIso
    };

    if (!guestSnap.exists) {
      guestData.created_at = nowIso;
      transaction.set(guestRef, guestData, { merge: true });
    } else {
      transaction.set(guestRef, guestData, { merge: true });
    }

    // 4. CREATE BOOKING DOCUMENT
    const resolvedTariff = (roomTariff !== null && roomTariff !== undefined && Number.isFinite(Number(roomTariff)) && Number(roomTariff) >= 0)
      ? Math.round(Number(roomTariff))
      : Number(roomData.price || roomData.rate || roomData.base_rate || 0);

    const resolvedExpectedCheckout = normalizeExpectedCheckout(expectedCheckoutDate || departureDate, actualCheckInDate);

    const bookingNumber = 'BKG-' + Math.floor(100000 + Math.random() * 900000);
    const bookingRef = db.collection('bookings').doc(`booking_${bookingNumber}`);

    const bookingPayload = {
      booking_number: bookingNumber,
      guest_id: guestRef.id,
      guest_name: guestNameUpper,
      age: (age !== undefined && age !== null) ? Number(age) : null,
      phone: resolvedPhone || '',
      email: email || '',
      country: country || '',
      state: state || '',
      address: address || '',
      pincode: pincode || '',
      gender: gender || null,
      room_id: roomRef.id,
      room_number: String(roomNumber),
      check_in_date: actualCheckInDate,
      expected_check_out_date: resolvedExpectedCheckout,
      check_out_date: null,
      adults: Number(pax || 1),
      pax: Number(pax || 1),
      children: Number(children || 0),
      booking_status: 'Checked In',
      payment_status: deposit > 0 ? 'Partial' : 'Pending',
      total_amount: resolvedTariff,
      advance_amount: Number(deposit || 0),
      billing_instruction: resolvedBilling,
      meal_plan: resolvedMealPlan,
      room_tariff: resolvedTariff,
      payment_mode: resolvedPayMode,
      purpose_of_visit: resolvedPurpose,
      company_name: companyName || '',
      gst_no: gstNo || '',
      date_of_birth: resolvedDob || null,
      dob: resolvedDob || null,
      city: city || '',
      created_by: String(resolvedUserId),
      created_at: nowIso,
      updated_at: nowIso
    };

    transaction.set(bookingRef, bookingPayload);

    // 5. UPDATE RESERVATION IF PRESENT
    if (resRef && resData) {
      transaction.set(resRef, {
        status: 'Checked-In',
        booking_id: bookingRef.id,
        booking_number: bookingNumber,
        updated_at: nowIso
      }, { merge: true });
    }

    // 6. CREATE INITIAL CHARGE LEDGER ITEM
    const timeOfEntry = buildTimeOfEntry(new Date());
    const ledgerTariffRef = db.collection('ledger_items').doc(`ledger_${bookingNumber}_1`);
    transaction.set(ledgerTariffRef, {
      booking_id: bookingRef.id,
      booking_number: bookingNumber,
      room_number: String(roomNumber),
      desc: 'Room Tariff (Incl. GST)',
      description: 'Room Tariff (Incl. GST)',
      qty: 1,
      amount: resolvedTariff,
      credit_amount: 0,
      transaction_type: 'CHARGE',
      business_date: actualBusinessDate,
      time_of_entry: timeOfEntry,
      created_by: String(resolvedUserId),
      created_at: nowIso
    });

    // 7. CREATE DEPOSIT PAYMENT & LEDGER ITEM IF APPLICABLE
    if (deposit > 0) {
      const ledgerPaymentRef = db.collection('ledger_items').doc(`ledger_${bookingNumber}_2`);
      transaction.set(ledgerPaymentRef, {
        booking_id: bookingRef.id,
        booking_number: bookingNumber,
        room_number: String(roomNumber),
        desc: `Advance Deposit (${resolvedPayMode || paymentMethod || 'Cash'})`,
        description: `Advance Deposit (${resolvedPayMode || paymentMethod || 'Cash'})`,
        qty: 1,
        amount: 0,
        credit_amount: Number(deposit),
        transaction_type: 'PAYMENT',
        payment_mode: resolvedPayMode || paymentMethod || 'Cash',
        business_date: actualBusinessDate,
        time_of_entry: timeOfEntry,
        created_by: String(resolvedUserId),
        created_at: nowIso
      });

      const paymentRef = db.collection('payments').doc(`payment_${bookingNumber}_1`);
      transaction.set(paymentRef, {
        booking_id: bookingRef.id,
        booking_number: bookingNumber,
        room_number: String(roomNumber),
        amount: Number(deposit),
        payment_method: resolvedPayMode || paymentMethod || 'Cash',
        payment_status: 'Completed',
        payment_type: 'Advance Deposit',
        business_date: actualBusinessDate,
        created_at: nowIso
      });

      if ((resolvedPayMode || paymentMethod) === 'Cash') {
        const cashLogRef = db.collection('cash_logs').doc(`cash_${bookingNumber}_1`);
        transaction.set(cashLogRef, {
          time: formatTime(new Date()),
          room: String(roomNumber),
          guest: guestNameUpper,
          type: 'Advance Deposit',
          amount: Number(deposit),
          business_date: actualBusinessDate,
          booking_id: bookingRef.id,
          created_at: nowIso
        });
      }
    }

    // 8. UPDATE ROOM STATUS TO OCCUPIED (Inside Transaction)
    transaction.set(roomRef, {
      status: 'occupied',
      current_booking_id: bookingRef.id,
      updated_at: nowIso
    }, { merge: true });

    // 9. RECORD AUDIT LOG & STATUS HISTORY
    const statusHistRef = db.collection('room_status_history').doc(`rsh_${bookingNumber}`);
    transaction.set(statusHistRef, {
      room_id: roomRef.id,
      room_number: String(roomNumber),
      old_status: roomData.status || 'vacant',
      new_status: 'occupied',
      changed_by: String(resolvedUserId),
      business_date: actualBusinessDate,
      created_at: nowIso
    });

    const resultPayload = {
      success: true,
      bookingId: bookingRef.id,
      bookingNumber,
      roomNumber: String(roomNumber),
      guestName: guestNameUpper,
      checkInDate: actualCheckInDate,
      expectedCheckoutDate: resolvedExpectedCheckout,
      roomTariff: resolvedTariff,
      deposit: Number(deposit || 0)
    };

    // 10. SAVE IDEMPOTENCY KEY RECORD
    if (idempotencyKey) {
      const idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
      transaction.set(idemRef, {
        idempotency_key: String(idempotencyKey),
        booking_id: bookingRef.id,
        booking_number: bookingNumber,
        status: 'COMPLETED',
        result: resultPayload,
        created_at: nowIso
      });
    }

    return resultPayload;
  }, { maxAttempts: 1 });
};

export default {
  processCheckInFirestoreTransaction,
  computeExpectedCheckout,
  normalizeExpectedCheckout
};
