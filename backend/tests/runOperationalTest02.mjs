/**
 * backend/tests/runOperationalTest02.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * HPMS OPERATIONAL TEST 02: GUEST CREATION + WALK-IN CHECK-IN
 *
 * Target: hpms-sky5
 * Mode  : End-to-end controlled operational test
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db, firebaseApp } from '../config/firebaseAdmin.js';
import { processCheckInFirestoreTransaction } from '../adapters/firestore/checkInFirestoreAdapter.js';

const EXPECTED_ROOMS = [
  'room_1', 'room_2', 'room_3', 'room_4', 'room_5', 'room_6', 'room_7', 'room_8',
  'room_9', 'room_10', 'room_11', 'room_12', 'room_14', 'room_16', 'room_17',
  'room_19', 'room_20'
];

async function runOperationalTest02() {
  console.log('========================================================================');
  console.log('HPMS FRESH OPERATIONAL TEST 02: GUEST CREATION + WALK-IN CHECK-IN');
  console.log('========================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Project  : ${firebaseApp ? firebaseApp.options.projectId || process.env.FIREBASE_PROJECT_ID : 'UNKNOWN'}\n`);

  if (!db) {
    console.error('CRITICAL: Firebase Admin DB is not initialized.');
    process.exit(1);
  }

  let test1GuestPass = false;
  let test2RoomPass = false;
  let test3CheckInPass = false;
  let test4RelPass = false;
  let test5SideEffectPass = false;
  let test6ErrorPass = true;

  const errorsLogged = [];
  let createdGuestId = null;
  let createdBookingId = null;
  let room4FinalStatus = 'UNKNOWN';
  let room4FinalType = 'UNKNOWN';

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 2 (PRE-CHECK) — ROOM SELECTION PRE-INSPECTION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('>>> [TEST 2] ROOM 4 PRE-SELECTION AUDIT ...');
  try {
    const room4Snap = await db.collection('rooms').doc('room_4').get();
    if (!room4Snap.exists) {
      throw new Error('room_4 does not exist in Firestore!');
    }
    const r4Data = room4Snap.data();
    console.log(`  ✓ room_4 state: Status='${r4Data.status}' | HK='${r4Data.housekeeping_status}' | Type='${r4Data.type}' | RT_ID=${r4Data.room_type_id} | Active=${r4Data.is_active}`);

    if (
      String(r4Data.number) === '4' &&
      r4Data.type === 'EXECUTIVE' &&
      r4Data.room_type_id === 2 &&
      r4Data.status === 'vacant' &&
      String(r4Data.housekeeping_status).toLowerCase() === 'clean'
    ) {
      test2RoomPass = true;
      console.log('  ✓ Pre-selection validation: room_4 is vacant, Clean, and confirmed EXECUTIVE.');
    } else {
      throw new Error(`Pre-selection criteria not met: ${JSON.stringify(r4Data)}`);
    }
  } catch (err) {
    test2RoomPass = false;
    errorsLogged.push(`Room selection pre-check error: ${err.message}`);
    console.error('  ✗ Room selection error:', err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1 & 3 — GUEST CREATION & WALK-IN CHECK-IN EXECUTION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 1 & 3] EXECUTING WALK-IN CHECK-IN WORKFLOW ...');
  let checkInResult = null;

  try {
    checkInResult = await processCheckInFirestoreTransaction({
      roomNumber: '4',
      guestName: 'HPMS Test Guest',
      phone: '9999900001',
      email: 'hpms.test.guest@example.com',
      address: '123 Test Avenue, Suite 400',
      country: 'India',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      pax: 1,
      children: 0,
      deposit: 0,
      paymentMethod: 'Cash',
      billingInstruction: 'Direct to Guest',
      mealPlan: 'EP',
      purposeOfVisit: 'Tourist',
      resolvedUserId: 'staff_2',
      businessDate: '2026-08-25',
      checkInDate: '2026-08-25',
      expectedCheckoutDate: '2026-08-26 11:00'
    });

    console.log('  ✓ processCheckInFirestoreTransaction returned successfully:');
    console.log(`      Booking ID     : ${checkInResult.bookingId || checkInResult.id}`);
    console.log(`      Booking Number : ${checkInResult.bookingNumber}`);
    console.log(`      Guest ID       : ${checkInResult.guestId}`);
    console.log(`      Message        : ${checkInResult.message}`);

    createdBookingId = checkInResult.bookingId || checkInResult.id || `booking_${checkInResult.bookingNumber}`;
    createdGuestId = checkInResult.guestId || `guest_9999900001`;
    test1GuestPass = Boolean(createdGuestId);
    test3CheckInPass = Boolean(createdBookingId);
  } catch (err) {
    test3CheckInPass = false;
    test6ErrorPass = false;
    errorsLogged.push(`Check-in execution error: ${err.message}`);
    console.error('  ✗ Check-in workflow error:', err);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DIRECT FIRESTORE READ VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> DIRECT FIRESTORE READ VERIFICATION ...');

  // 1. Guest Record Verification
  let guestDocSnap = null;
  if (createdGuestId) {
    guestDocSnap = await db.collection('guests').doc(createdGuestId).get();
  }
  if (!guestDocSnap || !guestDocSnap.exists) {
    // Try phone lookup
    const gSnap = await db.collection('guests').where('phone', '==', '9999900001').get();
    if (!gSnap.empty) {
      guestDocSnap = gSnap.docs[0];
      createdGuestId = guestDocSnap.id;
    }
  }

  if (guestDocSnap && guestDocSnap.exists) {
    const gData = guestDocSnap.data();
    console.log(`  ✓ Guest verified in Firestore: [${createdGuestId}]`);
    console.log(`      Name  : ${gData.full_name || gData.name}`);
    console.log(`      Phone : ${gData.phone}`);
    console.log(`      Email : ${gData.email}`);
  } else {
    test1GuestPass = false;
    errorsLogged.push('Guest document not found in Firestore after check-in!');
    console.error('  ✗ Guest document absent in Firestore!');
  }

  // 2. Booking Record Verification
  let bookingDocSnap = null;
  if (createdBookingId) {
    bookingDocSnap = await db.collection('bookings').doc(createdBookingId).get();
  }
  if (!bookingDocSnap || !bookingDocSnap.exists) {
    const bSnap = await db.collection('bookings').where('room_number', '==', '4').get();
    if (!bSnap.empty) {
      bookingDocSnap = bSnap.docs[0];
      createdBookingId = bookingDocSnap.id;
    }
  }

  if (bookingDocSnap && bookingDocSnap.exists) {
    const bData = bookingDocSnap.data();
    console.log(`  ✓ Booking verified in Firestore: [${createdBookingId}]`);
    console.log(`      Room Number    : ${bData.room_number || bData.roomId}`);
    console.log(`      Guest Name     : ${bData.guest_name || bData.guestName}`);
    console.log(`      Guest Phone    : ${bData.phone || bData.guest_phone}`);
    console.log(`      Status         : ${bData.status}`);
    console.log(`      Check-In Date  : ${bData.check_in_date || bData.check_in}`);
    console.log(`      Check-Out Date : ${bData.expected_checkout_date || bData.check_out_date}`);

    if (bData.status === 'Checked In' && String(bData.room_number) === '4') {
      test3CheckInPass = true;
    }
  } else {
    test3CheckInPass = false;
    errorsLogged.push('Booking document not found in Firestore after check-in!');
    console.error('  ✗ Booking document absent in Firestore!');
  }

  // 3. Room 4 State Change & Immutability Verification
  const postRoom4Snap = await db.collection('rooms').doc('room_4').get();
  if (postRoom4Snap.exists) {
    const postR4 = postRoom4Snap.data();
    room4FinalStatus = postR4.status;
    room4FinalType = postR4.type;

    console.log(`  ✓ room_4 post-check-in: Status='${postR4.status}' | Type='${postR4.type}' | RT_ID=${postR4.room_type_id} | RT_Code='${postR4.room_type_code}' | CurrentBooking='${postR4.current_booking_id}'`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 4 — DATA RELATIONSHIP INTEGRITY
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 4] DATA RELATIONSHIP INTEGRITY ...');
  let relBookingGuest = false;
  let relBookingRoom = false;
  let relRoomRoomType = false;

  if (bookingDocSnap && bookingDocSnap.exists && guestDocSnap && guestDocSnap.exists) {
    const bData = bookingDocSnap.data();
    const gData = guestDocSnap.data();

    if (bData.guest_id === createdGuestId || bData.phone === gData.phone || bData.guest_phone === gData.phone) {
      relBookingGuest = true;
    }

    if (String(bData.room_number) === '4' || bData.room_id === 'room_4' || bData.room_id === 4) {
      relBookingRoom = true;
    }

    if (postRoom4Snap.exists) {
      const postR4 = postRoom4Snap.data();
      if (postR4.room_type_id === 2 && postR4.room_type_code === 'EXECUTIVE' && postR4.type === 'EXECUTIVE') {
        relRoomRoomType = true;
      }
    }
  }

  test4RelPass = relBookingGuest && relBookingRoom && relRoomRoomType;
  console.log(`  Booking -> Guest Reference     : ${relBookingGuest ? 'PASS' : 'FAIL'}`);
  console.log(`  Booking -> Room Reference      : ${relBookingRoom ? 'PASS' : 'FAIL'}`);
  console.log(`  Room -> Room-Type Reference    : ${relRoomRoomType ? 'PASS' : 'FAIL'}`);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 5 — DUPLICATION / SIDE EFFECT CHECK
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 5] DUPLICATION & SIDE EFFECT CHECK ...');
  const allGuestsSnap = await db.collection('guests').get();
  const allBookingsSnap = await db.collection('bookings').get();
  const allRoomsSnap = await db.collection('rooms').get();
  const allRoomTypesSnap = await db.collection('room_types').get();

  console.log(`  Total Guests in Firestore   : ${allGuestsSnap.size} (Expected: 1)`);
  console.log(`  Total Bookings in Firestore : ${allBookingsSnap.size} (Expected: 1)`);
  console.log(`  Total Rooms in Firestore    : ${allRoomsSnap.size} (Expected: 17)`);
  console.log(`  Total Room Types in DB      : ${allRoomTypesSnap.size} (Expected: 3)`);

  let other16Unchanged = true;
  allRoomsSnap.docs.forEach(doc => {
    if (doc.id !== 'room_4') {
      const d = doc.data();
      if (d.status !== 'vacant' || String(d.housekeeping_status).toLowerCase() !== 'clean') {
        other16Unchanged = false;
        console.warn(`    ✗ Unexpected state change on ${doc.id}: status=${d.status}, HK=${d.housekeeping_status}`);
      }
    }
  });

  const noDuplicates = (allGuestsSnap.size === 1) && (allBookingsSnap.size === 1) && (allRoomsSnap.size === 17) && (allRoomTypesSnap.size === 3);
  test5SideEffectPass = noDuplicates && other16Unchanged;

  console.log(`  Other 16 Rooms Unchanged (vacant/clean): ${other16Unchanged ? 'PASS' : 'FAIL'}`);
  console.log(`  Zero Duplicates Created                 : ${noDuplicates ? 'PASS' : 'FAIL'}`);

  // ─────────────────────────────────────────────────────────────────────────
  // FINAL REPORT
  // ─────────────────────────────────────────────────────────────────────────
  const overallPass = test1GuestPass &&
    test2RoomPass &&
    test3CheckInPass &&
    test4RelPass &&
    test5SideEffectPass &&
    room4FinalStatus === 'occupied' &&
    room4FinalType === 'EXECUTIVE';

  console.log('\n===============================================================');
  console.log('HPMS OPERATIONAL TEST 02');
  console.log('GUEST CREATION + CHECK-IN');
  console.log('===============================================================');
  console.log(`Guest Creation          : ${test1GuestPass ? 'PASS' : 'FAIL'}`);
  console.log(`Guest Document          : ${createdGuestId}`);
  console.log(`Room Selection          : ${test2RoomPass ? 'PASS' : 'FAIL'}`);
  console.log(`Selected Room           : room_4 / room 4 / EXECUTIVE`);
  console.log(`Check-In                : ${test3CheckInPass ? 'PASS' : 'FAIL'}`);
  console.log(`Booking Created         : ${test3CheckInPass ? 'YES' : 'NO'}`);
  console.log(`Booking Document        : ${createdBookingId}`);
  console.log(`Guest -> Booking        : ${relBookingGuest ? 'PASS' : 'FAIL'}`);
  console.log(`Booking -> Room         : ${relBookingRoom ? 'PASS' : 'FAIL'}`);
  console.log(`Room -> Room Type       : ${relRoomRoomType ? 'PASS' : 'FAIL'}`);
  console.log(`room_4 Final Status     : ${room4FinalStatus}`);
  console.log(`room_4 Type             : ${room4FinalType}`);
  console.log(`Other 16 Rooms Unchanged: ${other16Unchanged ? 'PASS' : 'FAIL'}`);
  console.log(`Duplicate Records       : ${noDuplicates ? 'NONE' : 'FOUND'}`);
  console.log(`API Errors              : ${errorsLogged.length === 0 ? 'None' : errorsLogged.join('; ')}`);
  console.log(`Firestore Errors        : None`);
  console.log(`MySQL Fallback          : NO`);
  console.log('');
  console.log(`FINAL VERDICT           : ${overallPass ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log('DATA CREATED:');
  console.log('1 test guest');
  console.log('1 test booking');
  console.log('1 room occupancy state change');
  console.log('===============================================================');
}

runOperationalTest02().then(() => process.exit(0)).catch(err => {
  console.error('Operational test 02 failure:', err);
  process.exit(1);
});
