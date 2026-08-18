import { db } from '../../config/firebaseAdmin.js';
import { formatTime } from '../../utils/dateUtils.js';

const ALLOWED_BILLING_INSTRUCTIONS = ['Direct to Guest', 'Bill to Company', 'Room Tariff Only'];
const ALLOWED_MEAL_PLANS           = ['EP', 'CP', 'MAP', 'AP'];

/**
 * Atomic Firestore Transaction Adapter for Check-In.
 * Guarantees race-condition safety: two concurrent check-ins on the same room
 * will result in exactly ONE success and ONE failure.
 */
export const processCheckInFirestoreTransaction = async ({
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
  resolvedUserId = 'admin',
  reservationId = null,
  isGuestSelfCheckIn = false,
  guestId = null,
  departureDate = null,
  billingInstruction = 'Direct to Guest',
  mealPlan = 'EP',
  dateOfBirth = null,
  dob = null,
  businessDate = '2026-08-17'
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
  const resolvedDob = dateOfBirth || dob || null;
  const actualCheckInDate = checkInDate || businessDate;
  const guestNameUpper = guestName ? String(guestName).trim().toUpperCase() : 'UNKNOWN';

  // Execute inside Firestore Atomic Transaction
  return await db.runTransaction(async (transaction) => {
    // 1. READ ROOM DOCUMENT (Inside Transaction)
    // Document ID lookup: room_${roomNumber}
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

    // Occupied Room Validation
    if (roomData.status === 'occupied') {
      throw { status: 400, message: `Room ${roomNumber} is already occupied (Already Checked-In).`, code: 'ALREADY_CHECKED_IN' };
    }

    // Housekeeping Dirty Check
    const isDirty = roomData.housekeeping_status === 'Dirty' || roomData.status === 'dirty';
    if (isDirty && !manualOverride) {
      throw { status: 400, message: `Room ${roomNumber} has pending housekeeping (Dirty).`, code: 'ROOM_DIRTY' };
    }

    // 2. RESOLVE GUEST DOCUMENT
    const phoneKey = phone ? String(phone).trim() : (guestId || `guest_${Date.now()}`);
    const guestRef = db.collection('guests').doc(`guest_${phoneKey}`);
    const guestSnap = await transaction.get(guestRef);

    const nowIso = new Date().toISOString();
    const guestData = {
      full_name: guestNameUpper,
      phone: phone || '',
      email: email || '',
      address: address || '',
      country: country || '',
      date_of_birth: resolvedDob,
      updated_at: nowIso
    };

    if (!guestSnap.exists) {
      guestData.created_at = nowIso;
      transaction.set(guestRef, guestData, { merge: true });
    } else {
      transaction.set(guestRef, {
        full_name: guestNameUpper,
        date_of_birth: resolvedDob || guestSnap.data().date_of_birth || null,
        updated_at: nowIso
      }, { merge: true });
    }

    // 3. CREATE BOOKING DOCUMENT
    const bookingNumber = 'BKG-' + Math.floor(100000 + Math.random() * 900000);
    const bookingRef = db.collection('bookings').doc(`booking_${bookingNumber}`);
    const tariffAmount = Number(roomData.price || roomData.rate || roomData.base_rate || 0);

    const bookingPayload = {
      booking_number: bookingNumber,
      guest_id: guestRef.id,
      guest_name: guestNameUpper,
      room_id: roomRef.id,
      room_number: String(roomNumber),
      check_in_date: actualCheckInDate,
      expected_check_out_date: departureDate || actualCheckInDate,
      check_out_date: null,
      adults: Number(pax || 1),
      children: Number(children || 0),
      booking_status: 'Checked In',
      payment_status: deposit > 0 ? 'Partial' : 'Pending',
      total_amount: tariffAmount,
      advance_amount: Number(deposit || 0),
      billing_instruction: resolvedBilling,
      meal_plan: resolvedMealPlan,
      created_by: String(resolvedUserId),
      created_at: nowIso,
      updated_at: nowIso
    };

    transaction.set(bookingRef, bookingPayload);

    // 4. CREATE LEDGER ITEM
    const ledgerRef = db.collection('ledger_items').doc(`ledger_${bookingNumber}_1`);
    transaction.set(ledgerRef, {
      booking_id: bookingRef.id,
      room_number: String(roomNumber),
      desc: 'Room Tariff (Incl. GST)',
      description: 'Room Tariff (Incl. GST)',
      qty: 1,
      amount: tariffAmount,
      business_date: businessDate,
      created_at: nowIso
    });

    // 5. DEPOSIT & PAYMENT LOGS
    if (deposit > 0) {
      const paymentRef = db.collection('payments').doc(`payment_${bookingNumber}_1`);
      transaction.set(paymentRef, {
        booking_id: bookingRef.id,
        amount: Number(deposit),
        payment_method: paymentMethod,
        payment_status: 'Completed',
        payment_type: 'Advance Deposit',
        business_date: businessDate,
        created_at: nowIso
      });

      if (paymentMethod === 'Cash') {
        const cashLogRef = db.collection('cash_logs').doc(`cash_${bookingNumber}_1`);
        transaction.set(cashLogRef, {
          time: formatTime(new Date()),
          room: String(roomNumber),
          guest: guestNameUpper,
          type: 'Advance Deposit',
          amount: Number(deposit),
          business_date: businessDate,
          booking_id: bookingRef.id,
          created_at: nowIso
        });
      }
    }

    // 6. UPDATE ROOM STATUS TO OCCUPIED (Inside Transaction)
    transaction.set(roomRef, {
      status: 'occupied',
      current_booking_id: bookingRef.id,
      updated_at: nowIso
    }, { merge: true });

    return {
      success: true,
      bookingId: bookingRef.id,
      bookingNumber,
      roomNumber
    };
  });
};
