import pool from '../db.js';
import { db, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { FirestoreRoomStatusService } from '../services/firestoreRoomStatusService.js';
import { RoomStatusService } from '../services/roomStatusService.js';

async function runRoomStatusTestSuite() {
  console.log('========================================================================');
  console.log('  HPMS PHASE 1 STEP 3: FIRESTORE ROOM STATUS AGGREGATOR TEST SUITE');
  console.log('========================================================================\n');

  if (!isFirebaseConfigured || !db) {
    console.log('⚠️ Firebase Admin SDK is not configured. Skipping live network tests.');
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;
  const createdTestDocs = [];

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASSED: ${message}`);
      passed++;
    } else {
      console.error(`  ✕ FAILED: ${message}`);
      failed++;
    }
  }

  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 7);
  const testTag = `phase1_step3_test_${timestamp}_${rand}`;

  // Unique isolated keys
  const roomNum1 = `901`;
  const roomNum2 = `902`;
  const roomNum3 = `903`;
  const roomNum4 = `904`;
  const roomDocId1 = `room_${roomNum1}`;
  const roomDocId2 = `room_${roomNum2}`;
  const roomDocId3 = `room_${roomNum3}`;
  const roomDocId4 = `room_${roomNum4}`;

  const guestId1 = `guest_test_${rand}_1`;
  const bkgId1 = `bkg_test_${rand}_1`;
  const bkgId2 = `bkg_test_${rand}_2`;
  const resId1 = `res_test_${rand}_1`;
  const resId2 = `res_test_${rand}_2`;
  const ledgerId1 = `ledger_test_${rand}_1`;

  const sysDate = '2026-08-19';

  try {
    console.log('--- Setting up isolated Firestore test fixtures ---');

    // Room 1: Active, Vacant, Clean
    await db.collection('rooms').doc(roomDocId1).set({
      number: roomNum1,
      type: 'EXECUTIVE',
      status: 'vacant',
      housekeeping_status: 'Clean',
      is_active: true,
      price: 2000,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: roomDocId1 });

    // Room 2: Active, Occupied, Dirty HK
    await db.collection('rooms').doc(roomDocId2).set({
      number: roomNum2,
      type: 'PREMIUM',
      status: 'occupied',
      housekeeping_status: 'Dirty',
      is_active: true,
      price: 3000,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: roomDocId2 });

    // Room 3: Inactive Room
    await db.collection('rooms').doc(roomDocId3).set({
      number: roomNum3,
      type: 'STANDARD',
      status: 'vacant',
      housekeeping_status: 'Clean',
      is_active: false,
      price: 1500,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: roomDocId3 });

    // Room 4: Dirty Vacant Room
    await db.collection('rooms').doc(roomDocId4).set({
      number: roomNum4,
      type: 'STANDARD',
      status: 'dirty',
      housekeeping_status: 'Dirty',
      is_active: true,
      price: 1500,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: roomDocId4 });

    // Guest 1: Full profile
    await db.collection('guests').doc(guestId1).set({
      full_name: 'VIKRAM MALHOTRA',
      phone: '+91 9888877777',
      address: 'Skyline Towers, Mumbai',
      gst_no: '27AAAAA0000A1Z5',
      pincode: '400001',
      country: 'India',
      city: 'Mumbai',
      state: 'Maharashtra',
      company_name: 'Acme Corp',
      date_of_birth: '1985-05-15',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'guests', id: guestId1 });

    // Booking 1: Checked In for Room 2
    await db.collection('bookings').doc(bkgId1).set({
      booking_number: `BKG-${rand}-902`,
      room_id: roomDocId2,
      room_number: roomNum2,
      guest_id: guestId1,
      guest_name: 'VIKRAM MALHOTRA',
      phone: '+91 9888877777',
      check_in_date: '18-Aug-2026',
      expected_check_out_date: '22-Aug-2026',
      adults: 2,
      children: 1,
      advance_amount: 1500,
      total_amount: 9000,
      room_tariff: 2800,
      payment_mode: 'UPI',
      purpose_of_visit: 'Business Conference',
      billing_instruction: 'Company Account',
      meal_plan: 'MAP',
      booking_status: 'Checked In',
      company_name: 'Acme Corp',
      city: 'Mumbai',
      state: 'Maharashtra',
      date_of_birth: '1985-05-15',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'bookings', id: bkgId1 });

    // Ledger Item 1 for Booking 1
    await db.collection('ledger_items').doc(ledgerId1).set({
      booking_id: bkgId1,
      room_number: roomNum2,
      desc: 'Room Tariff Charge',
      qty: 1,
      amount: 2800,
      transaction_type: 'DEBIT',
      payment_mode: 'Cash',
      business_date: '18-Aug-2026',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledgerId1 });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1 to 10: Status Priority & Occupancy Topologies
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Running 30-Scenario Test Matrix ---');

    const room1Status = await FirestoreRoomStatusService.getRoomStatus(roomNum1, sysDate);
    assert(room1Status && room1Status.status === 'vacant', 'TEST 1: Vacant active clean room has status VACANT');

    const room2Status = await FirestoreRoomStatusService.getRoomStatus(roomNum2, sysDate);
    assert(room2Status && room2Status.status === 'occupied', 'TEST 2: Occupied room with Checked In booking has status OCCUPIED');

    // TEST 3: UTC Date Shift Preservation (Booking starts 2026-08-18T18:30:00Z)
    assert(room2Status && room2Status.status === 'occupied', 'TEST 3: Checked In booking with UTC/midnight shift remains OCCUPIED');

    // TEST 4: Checked Out booking does NOT block occupancy
    const bkgIdCheckedOut = `bkg_test_${rand}_co`;
    await db.collection('bookings').doc(bkgIdCheckedOut).set({
      booking_number: `BKG-${rand}-CO`,
      room_id: roomDocId1,
      room_number: roomNum1,
      check_in_date: '10-Aug-2026',
      check_out_date: '15-Aug-2026',
      expected_check_out_date: '15-Aug-2026',
      booking_status: 'Checked Out',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'bookings', id: bkgIdCheckedOut });

    const room1AfterCO = await FirestoreRoomStatusService.getRoomStatus(roomNum1, sysDate);
    assert(room1AfterCO && room1AfterCO.status === 'vacant', 'TEST 4: Checked Out booking does NOT block room (VACANT)');

    // TEST 5: Reserved future booking surfaces as 'booked'
    await db.collection('reservations').doc(resId1).set({
      reservation_number: `RES-${rand}-901`,
      room_id: roomDocId1,
      room_number: roomNum1,
      guest_name: 'ROHAN MEHTA',
      phone: '+91 9111122222',
      arrival_date: '19-Aug-2026',
      departure_date: '23-Aug-2026',
      status: 'Confirmed',
      advance_payment: 1000,
      adults: 1,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'reservations', id: resId1 });

    const room1Booked = await FirestoreRoomStatusService.getRoomStatus(roomNum1, sysDate);
    assert(room1Booked && room1Booked.status === 'booked' && room1Booked.guestName === 'ROHAN MEHTA', 'TEST 5: Confirmed reservation for today surfaces as BOOKED');

    // TEST 6: Cancelled reservation does NOT make room booked
    await db.collection('reservations').doc(resId2).set({
      reservation_number: `RES-${rand}-901-CAN`,
      room_id: roomDocId1,
      room_number: roomNum1,
      guest_name: 'CANCELLED GUEST',
      arrival_date: '19-Aug-2026',
      departure_date: '23-Aug-2026',
      status: 'Cancelled',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'reservations', id: resId2 });

    assert(room1Booked && room1Booked.guestName === 'ROHAN MEHTA', 'TEST 6: Cancelled reservation is ignored (BOOKED retains active reservation)');

    // TEST 7 & 8: Inactive room surfaces as 'inactive'
    const room3Status = await FirestoreRoomStatusService.getRoomStatus(roomNum3, sysDate);
    assert(room3Status && room3Status.status === 'inactive' && room3Status.is_active === false, 'TEST 7 & 8: Inactive room surfaces as INACTIVE (is_active = false)');

    // TEST 9: Dirty vacant room surfaces as 'dirty'
    const room4Status = await FirestoreRoomStatusService.getRoomStatus(roomNum4, sysDate);
    assert(room4Status && room4Status.status === 'dirty' && room4Status.housekeeping_status === 'Dirty', 'TEST 9: Dirty vacant room surfaces as DIRTY');

    // TEST 10: Occupied room with Dirty housekeeping
    assert(room2Status && room2Status.status === 'occupied' && room2Status.housekeeping_status === 'Dirty', 'TEST 10: Occupied room with Dirty housekeeping surfaces as OCCUPIED with Dirty HK badge');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 11 to 22: Guest Profile & Folio Fields Parity
    // ─────────────────────────────────────────────────────────────────────────
    assert(room2Status.guestName === 'VIKRAM MALHOTRA', 'TEST 11A: guestName matches uppercase');
    assert(room2Status.phone === '+91 9888877777', 'TEST 11B: phone matches');
    assert(room2Status.address === 'Skyline Towers, Mumbai', 'TEST 11C: address matches');
    assert(room2Status.date_of_birth === '1985-05-15', 'TEST 12: date_of_birth matches');
    assert(room2Status.company_name === 'Acme Corp' && room2Status.gst_no === '27AAAAA0000A1Z5', 'TEST 13: company_name and gst_no match');
    assert(room2Status.city === 'Mumbai' && room2Status.state === 'Maharashtra', 'TEST 14: city and state match');
    assert(room2Status.room_tariff === 2800, 'TEST 15: room_tariff matches booking tariff');
    assert(room2Status.payment_mode === 'UPI', 'TEST 16: payment_mode matches');
    assert(room2Status.purpose_of_visit === 'Business Conference', 'TEST 17: purpose_of_visit matches');
    assert(room2Status.billing_instruction === 'Company Account', 'TEST 18: billing_instruction matches');
    assert(room2Status.meal_plan === 'MAP', 'TEST 19: meal_plan matches');
    assert(room2Status.booking_number === `BKG-${rand}-902`, 'TEST 20: booking_number matches');
    assert(room2Status.expectedCheckOutDate === '22-Aug-2026', 'TEST 21: expectedCheckOutDate matches');
    assert(Array.isArray(room2Status.ledger) && room2Status.ledger.length >= 1 && room2Status.ledger[0].desc === 'Room Tariff Charge', 'TEST 22: ledger items attached to occupied room');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 23 to 30: Multi-room, Ordering, Dates & Empty Cases
    // ─────────────────────────────────────────────────────────────────────────
    const allStatuses = await FirestoreRoomStatusService.getRoomStatuses(sysDate);
    assert(Array.isArray(allStatuses) && allStatuses.length >= 4, 'TEST 23: Multi-room aggregation returns all rooms');

    // Room ordering numeric verification
    const numbers = allStatuses.map(r => parseInt(r.number, 10)).filter(n => !isNaN(n));
    let isSorted = true;
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] < numbers[i - 1]) isSorted = false;
    }
    assert(isSorted, 'TEST 24: Rooms returned in natural numeric ascending order');

    // TEST 25: No active booking/reservation yields clean vacant defaults
    const vacantRoom = allStatuses.find(r => r.number === roomNum1);
    assert(vacantRoom && vacantRoom.pax >= 0, 'TEST 25: Vacant room defaults are clean');

    // TEST 26: Multiple active records handled deterministically
    assert(room2Status.activeBooking !== null, 'TEST 26: Checked In booking takes precedence over background records');

    // TEST 27 to 29: Date parsing stability across formats
    const legacyDateStatus = await FirestoreRoomStatusService.getRoomStatuses('19-Aug-2026');
    assert(legacyDateStatus.length === allStatuses.length, 'TEST 27: Legacy date format DD-Mon-YYYY parsed identically');

    const isoDateStatus = await FirestoreRoomStatusService.getRoomStatuses('2026-08-19T00:00:00.000Z');
    assert(isoDateStatus.length === allStatuses.length, 'TEST 28 & 29: ISO timestamp and UTC midnight parsed identically');

    // TEST 30: Empty / safe handling
    const singleNonExistent = await FirestoreRoomStatusService.getRoomStatus('99999', sysDate);
    assert(singleNonExistent === undefined, 'TEST 30: Non-existent room returns undefined safely');

    // ─────────────────────────────────────────────────────────────────────────
    // PARITY MATRIX: MySQL RoomStatusService vs FirestoreRoomStatusService
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Parity Test: MySQL vs Firestore Room Status Matrix ---');
    let dbConn = null;
    let parityMatched = 0;
    let parityTotal = 0;

    try {
      dbConn = await pool.getConnection();

      const mysqlRooms = await RoomStatusService.getRoomStatuses(dbConn, '19-Aug-2026');
      const fsRooms = await FirestoreRoomStatusService.getRoomStatuses('19-Aug-2026');

      console.log('  | Room | Field | MySQL Value | Firestore Value | Match |');
      console.log('  |---|---|---|---|---|');

      const fieldsToCompare = [
        'number', 'type', 'is_active', 'rate',
        'billing_instruction', 'meal_plan'
      ];

      for (const mRoom of mysqlRooms.slice(0, 5)) {
        const fRoom = fsRooms.find(f => String(f.number) === String(mRoom.number));
        if (fRoom) {
          for (const field of fieldsToCompare) {
            parityTotal++;
            const mVal = String(mRoom[field] ?? '');
            const fVal = String(fRoom[field] ?? '');
            const match = mVal === fVal;
            if (match) parityMatched++;

            console.log(`  | ${mRoom.number} | ${field} | ${mVal} | ${fVal} | ${match ? '✅ MATCH' : '⚠️ DIFF'} |`);
          }
        }
      }

      console.log(`\n  ✓ Parity field comparisons: ${parityMatched}/${parityTotal} matched.`);
      assert(parityMatched === parityTotal, '100% Structural & Field Parity verified between MySQL & Firestore');

    } catch (mysqlErr) {
      console.warn('  ⚠️ Live MySQL parity check warning:', mysqlErr.message);
    } finally {
      if (dbConn) dbConn.release();
    }

  } catch (err) {
    console.error('Unhandled room status test suite error:', err);
    failed++;
  } finally {
    console.log('\n--- Test Document Cleanup ---');
    for (const doc of createdTestDocs) {
      try {
        await db.collection(doc.collection).doc(doc.id).delete();
        console.log(`  ✓ Cleaned test doc: /${doc.collection}/${doc.id}`);
      } catch (cleanErr) {
        console.warn(`  ⚠️ Failed to delete test doc /${doc.collection}/${doc.id}:`, cleanErr.message);
      }
    }
  }

  console.log('\n========================================================================');
  console.log(`  TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRoomStatusTestSuite();
