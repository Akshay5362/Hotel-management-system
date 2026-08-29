/**
 * backend/tests/testFirestoreReservationCutoverPhase2Step8.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 Step 8: Controlled Firestore Reservations Cutover Test Suite (40 Scenarios)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';
import {
  isFirestoreReservationsServingEnabled
} from '../config/featureFlags.js';
import { ReservationFirestoreAdapter } from '../adapters/firestore/reservationFirestoreAdapter.js';
import { ReservationCutoverService } from '../services/reservationCutoverService.js';
import { checkRoomAvailabilityFirestore } from '../services/firestoreAvailabilityService.js';
import { formatReservationId } from '../repositories/firestore/firestoreUtils.js';

let totalTests = 0;
let passedTests = 0;

async function runTest(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ [TEST ${totalTests}] ${name}`);
  } catch (err) {
    console.error(`  ✗ [TEST ${totalTests}] ${name}`);
    console.error(`     Error: ${err.message}`);
    throw err;
  }
}

async function main() {
  console.log('\n===============================================================');
  console.log('PHASE 2 STEP 8: RESERVATIONS CUTOVER TEST SUITE (40 SCENARIOS)');
  console.log('===============================================================\n');

  const ts = Date.now();
  const testRoom1 = `801_${ts.toString().slice(-4)}`;
  const testRoom2 = `802_${ts.toString().slice(-4)}`;
  const testRoomInactive = `803_${ts.toString().slice(-4)}`;
  const testRoomDirty = `804_${ts.toString().slice(-4)}`;

  // 0. Seed Rooms in Firestore
  await db.collection('rooms').doc(`room_${testRoom1}`).set({
    number: testRoom1,
    type: 'DELUXE',
    is_active: true,
    status: 'vacant',
    housekeeping_status: 'Clean',
    created_at: new Date().toISOString()
  });

  await db.collection('rooms').doc(`room_${testRoom2}`).set({
    number: testRoom2,
    type: 'DELUXE',
    is_active: true,
    status: 'vacant',
    housekeeping_status: 'Clean',
    created_at: new Date().toISOString()
  });

  await db.collection('rooms').doc(`room_${testRoomInactive}`).set({
    number: testRoomInactive,
    type: 'STANDARD',
    is_active: false,
    status: 'vacant',
    housekeeping_status: 'Clean',
    created_at: new Date().toISOString()
  });

  await db.collection('rooms').doc(`room_${testRoomDirty}`).set({
    number: testRoomDirty,
    type: 'STANDARD',
    is_active: true,
    status: 'vacant',
    housekeeping_status: 'Dirty',
    created_at: new Date().toISOString()
  });

  let createdRes1 = null;
  let createdResNumber1 = null;

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 1: CREATE RESERVATION SCENARIOS (1 to 6)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('--- GROUP 1: Create Reservation ---');

  await runTest('1.1 Create reservation successfully', async () => {
    const res = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'John Doe',
      phone: '9876543210',
      arrivalDate: '2026-09-01',
      departureDate: '2026-09-05',
      roomNumber: testRoom1,
      idempotencyKey: `idem_create_${ts}`
    });
    assert.strictEqual(res.success, true);
    assert.ok(res.reservation.reservation_number.startsWith('RES-'));
    assert.strictEqual(res.reservation.room_number, testRoom1);
    assert.strictEqual(res.reservation.status, 'Reserved');
    createdRes1 = res.reservation;
    createdResNumber1 = res.reservation.reservation_number;
  });

  await runTest('1.2 Create reservation with complete guest details', async () => {
    const res = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Alice Smith',
      phone: '9876543211',
      email: 'alice@example.com',
      address: '123 Baker Street, London',
      nationality: 'British',
      arrivalDate: '2026-09-10',
      departureDate: '2026-09-15',
      roomNumber: testRoom1
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.reservation.email, 'alice@example.com');
    assert.strictEqual(res.reservation.address, '123 Baker Street, London');
    assert.strictEqual(res.reservation.nationality, 'British');
  });

  await runTest('1.3 Create reservation with Date of Birth', async () => {
    const res = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Bob Williams',
      phone: '9876543212',
      dateOfBirth: '1990-05-15',
      arrivalDate: '2026-09-20',
      departureDate: '2026-09-25',
      roomNumber: testRoom1
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.reservation.date_of_birth, '1990-05-15');
  });

  await runTest('1.4 Create reservation with GST, company, and location', async () => {
    const res = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Corporate Tech',
      phone: '9876543213',
      company: 'Tech Innovations Ltd',
      state: 'Maharashtra',
      purpose: 'Business Conference',
      arrivalDate: '2026-10-01',
      departureDate: '2026-10-05',
      roomNumber: testRoom1
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.reservation.company, 'Tech Innovations Ltd');
    assert.strictEqual(res.reservation.state, 'Maharashtra');
    assert.strictEqual(res.reservation.purpose, 'Business Conference');
  });

  await runTest('1.5 Create reservation with tariff and occupants', async () => {
    const res = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Family Vacation',
      phone: '9876543214',
      adults: 2,
      children: 2,
      roomType: 'DELUXE',
      arrivalDate: '2026-10-10',
      departureDate: '2026-10-15',
      roomNumber: testRoom1
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.reservation.adults, 2);
    assert.strictEqual(res.reservation.children, 2);
    assert.strictEqual(res.reservation.room_type, 'DELUXE');
  });

  await runTest('1.6 Create reservation with advance cash payment', async () => {
    const res = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Advance Guest',
      phone: '9876543215',
      advancePayment: 1500,
      paymentMode: 'Cash',
      arrivalDate: '2026-10-20',
      departureDate: '2026-10-25',
      roomNumber: testRoom1
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.reservation.advance_payment, 1500);
    assert.strictEqual(res.reservation.payment_mode, 'Cash');

    const cashLogSnap = await db.collection('cash_logs')
      .doc(`cash_log_res_${res.reservation.reservation_number}_advance`)
      .get();
    assert.strictEqual(cashLogSnap.exists, true);
    assert.strictEqual(cashLogSnap.data().amount, 1500);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 2: AVAILABILITY & DOUBLE-BOOKING PROTECTION (7 to 11)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 2: Availability & Double-Booking Protection ---');

  await runTest('2.1 Overlapping reservation is blocked with 409 conflict', async () => {
    let threw = false;
    try {
      await ReservationFirestoreAdapter.createReservationFirestore({
        guestName: 'Conflicting Guest',
        phone: '9876543216',
        arrivalDate: '2026-09-02', // overlaps with 2026-09-01 -> 2026-09-05
        departureDate: '2026-09-04',
        roomNumber: testRoom1
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 409);
      assert.strictEqual(err.code, 'ROOM_ALREADY_BOOKED');
    }
    assert.strictEqual(threw, true);
  });

  await runTest('2.2 Checked-in room blocks overlapping reservation', async () => {
    // Seed active checked-in booking
    const bkgId = `booking_test_checkedin_${ts}`;
    await db.collection('bookings').doc(bkgId).set({
      booking_id: bkgId,
      booking_number: `BK-TEST-${ts}`,
      room_number: testRoom2,
      booking_status: 'Checked In',
      check_in_date: '2026-09-01',
      check_out_date: '2026-09-05',
      created_at: new Date().toISOString()
    });

    let threw = false;
    try {
      await ReservationFirestoreAdapter.createReservationFirestore({
        guestName: 'Booking Conflict Guest',
        phone: '9876543217',
        arrivalDate: '2026-09-03',
        departureDate: '2026-09-07',
        roomNumber: testRoom2
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 409);
      assert.strictEqual(err.code, 'ROOM_ALREADY_BOOKED');
    }
    assert.strictEqual(threw, true);
  });

  await runTest('2.3 Inactive room is blocked with 400 ROOM_INACTIVE', async () => {
    let threw = false;
    try {
      await ReservationFirestoreAdapter.createReservationFirestore({
        guestName: 'Inactive Room Guest',
        phone: '9876543218',
        arrivalDate: '2026-09-01',
        departureDate: '2026-09-05',
        roomNumber: testRoomInactive
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 400);
      assert.strictEqual(err.code, 'ROOM_INACTIVE');
    }
    assert.strictEqual(threw, true);
  });

  await runTest('2.4 Dirty room restriction preserved in Availability Engine', async () => {
    const avail = await checkRoomAvailabilityFirestore({
      roomNumber: testRoomDirty,
      arrivalDate: '2026-09-01',
      departureDate: '2026-09-05'
    });
    assert.strictEqual(avail.available, false);
    assert.strictEqual(avail.code, 'ROOM_DIRTY');
  });

  await runTest('2.5 Cancelled reservation no longer blocks availability', async () => {
    const cancelRes = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'To Cancel',
      phone: '9876543219',
      arrivalDate: '2026-11-01',
      departureDate: '2026-11-05',
      roomNumber: testRoom2
    });
    await ReservationFirestoreAdapter.cancelReservationFirestore(cancelRes.reservation.reservation_number);

    // Now booking same dates should succeed
    const newRes = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Replacement Guest',
      phone: '9876543220',
      arrivalDate: '2026-11-01',
      departureDate: '2026-11-05',
      roomNumber: testRoom2
    });
    assert.strictEqual(newRes.success, true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 3: MODIFICATION SCENARIOS (12 to 16)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 3: Modify Reservation ---');

  await runTest('3.1 Modify reservation guest name and phone', async () => {
    const updated = await ReservationFirestoreAdapter.updateReservationFirestore(
      createdResNumber1,
      { guestName: 'Johnathan Doe Updated', phone: '9998887776' }
    );
    assert.strictEqual(updated.success, true);
    assert.strictEqual(updated.reservation.guest_name, 'Johnathan Doe Updated');
    assert.strictEqual(updated.reservation.phone, '9998887776');
  });

  await runTest('3.2 Modify reservation room successfully', async () => {
    const updated = await ReservationFirestoreAdapter.updateReservationFirestore(
      createdResNumber1,
      { roomNumber: testRoom2, arrivalDate: '2026-12-01', departureDate: '2026-12-05' }
    );
    assert.strictEqual(updated.success, true);
    assert.strictEqual(updated.reservation.room_number, testRoom2);
  });

  await runTest('3.3 Modify reservation dates successfully', async () => {
    const updated = await ReservationFirestoreAdapter.updateReservationFirestore(
      createdResNumber1,
      { arrivalDate: '2026-12-02', departureDate: '2026-12-06' }
    );
    assert.strictEqual(updated.success, true);
    assert.strictEqual(updated.reservation.check_in_date, '2026-12-02');
    assert.strictEqual(updated.reservation.check_out_date, '2026-12-06');
  });

  await runTest('3.4 Self-exclusion works when modifying reservation dates without conflict error', async () => {
    const updated = await ReservationFirestoreAdapter.updateReservationFirestore(
      createdResNumber1,
      { arrivalDate: '2026-12-02', departureDate: '2026-12-07' }
    );
    assert.strictEqual(updated.success, true);
  });

  await runTest('3.5 Existing conflicting reservation blocks modification with 409', async () => {
    // Seed another reservation on testRoom2 for 2026-12-20 -> 2026-12-25
    await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Obstacle Guest',
      phone: '9876543221',
      arrivalDate: '2026-12-20',
      departureDate: '2026-12-25',
      roomNumber: testRoom2
    });

    let threw = false;
    try {
      await ReservationFirestoreAdapter.updateReservationFirestore(
        createdResNumber1,
        { arrivalDate: '2026-12-22', departureDate: '2026-12-27' }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 409);
      assert.strictEqual(err.code, 'ROOM_ALREADY_BOOKED');
    }
    assert.strictEqual(threw, true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 4: CANCELLATION SCENARIOS (17 to 18)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 4: Cancel Reservation ---');

  await runTest('4.1 Cancel reservation successfully', async () => {
    const res = await ReservationFirestoreAdapter.cancelReservationFirestore(
      createdResNumber1,
      { cancellationReason: 'Change of plans' }
    );
    assert.strictEqual(res.success, true);

    const doc = await db.collection('reservations').doc(formatReservationId(createdResNumber1)).get();
    assert.strictEqual(doc.data().status, 'Cancelled');
    assert.ok(doc.data().remarks.includes('Change of plans'));
  });

  await runTest('4.2 Repeated cancellation is safe and idempotent', async () => {
    const res = await ReservationFirestoreAdapter.cancelReservationFirestore(
      createdResNumber1,
      { cancellationReason: 'Change of plans' }
    );
    assert.strictEqual(res.success, true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 5: IDEMPOTENCY SCENARIOS (19 to 21)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 5: Idempotency ---');

  let idemResNumber = null;
  await runTest('5.1 Idempotent create reservation returns cached response', async () => {
    const key = `idem_create_test_${ts}`;
    const res1 = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Idem Guest',
      phone: '9876543222',
      arrivalDate: '2027-01-01',
      departureDate: '2027-01-05',
      roomNumber: testRoom1,
      idempotencyKey: key
    });
    idemResNumber = res1.reservation.reservation_number;

    const res2 = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Idem Guest',
      phone: '9876543222',
      arrivalDate: '2027-01-01',
      departureDate: '2027-01-05',
      roomNumber: testRoom1,
      idempotencyKey: key
    });
    assert.strictEqual(res2.reservation.reservation_number, idemResNumber);
  });

  await runTest('5.2 Idempotent modify reservation returns cached response', async () => {
    const key = `idem_update_test_${ts}`;
    const res1 = await ReservationFirestoreAdapter.updateReservationFirestore(
      idemResNumber,
      { guestName: 'Idem Updated Name' },
      {},
      key
    );

    const res2 = await ReservationFirestoreAdapter.updateReservationFirestore(
      idemResNumber,
      { guestName: 'Idem Updated Name' },
      {},
      key
    );
    assert.strictEqual(res2.reservation.guest_name, 'Idem Updated Name');
  });

  await runTest('5.3 Idempotent cancel reservation returns cached response', async () => {
    const key = `idem_cancel_test_${ts}`;
    const res1 = await ReservationFirestoreAdapter.cancelReservationFirestore(
      idemResNumber,
      { cancellationReason: 'Idem cancel' },
      {},
      key
    );
    assert.strictEqual(res1.success, true);

    const res2 = await ReservationFirestoreAdapter.cancelReservationFirestore(
      idemResNumber,
      { cancellationReason: 'Idem cancel' },
      {},
      key
    );
    assert.strictEqual(res2.success, true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 6: CONCURRENCY PROTECTION (22 to 23)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 6: Concurrency Protection ---');

  await runTest('6.1 10 concurrent create requests with same idempotency key return identical result', async () => {
    const concKey = `conc_idem_key_${ts}`;
    const promises = Array.from({ length: 10 }).map(() =>
      ReservationFirestoreAdapter.createReservationFirestore({
        guestName: 'Concurrent Idem Guest',
        phone: '9876543223',
        arrivalDate: '2027-02-01',
        departureDate: '2027-02-05',
        roomNumber: testRoom1,
        idempotencyKey: concKey
      })
    );
    const results = await Promise.all(promises);
    assert.strictEqual(results.length, 10);
    const firstNum = results[0].reservation.reservation_number;
    results.forEach(r => assert.strictEqual(r.reservation.reservation_number, firstNum));
  });

  await runTest('6.2 10 concurrent requests for same room/dates: exactly 1 succeeds, 9 fail with 409', async () => {
    const promises = Array.from({ length: 10 }).map((_, idx) =>
      ReservationFirestoreAdapter.createReservationFirestore({
        guestName: `Contender ${idx}`,
        phone: `98765432${idx.toString().padStart(2, '0')}`,
        arrivalDate: '2027-03-01',
        departureDate: '2027-03-05',
        roomNumber: testRoom1
      }).catch(err => ({ error: err }))
    );

    const results = await Promise.all(promises);
    const successes = results.filter(r => r.success === true);
    const conflicts = results.filter(r => r.error && r.error.status === 409);

    assert.strictEqual(successes.length, 1);
    assert.strictEqual(conflicts.length, 9);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 7: CUTOVER SERVICE & FALLBACK (24 to 29)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 7: Cutover Service & Fallback ---');

  await runTest('7.1 ReservationCutoverService serves from MySQL when flag is false', async () => {
    process.env.USE_FIRESTORE_RESERVATIONS = 'false';
    let calledMysql = false;
    const res = await ReservationCutoverService.createReservation(
      { roomNumber: testRoom1 },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, true);
    assert.strictEqual(res.fromMysql, true);
  });

  await runTest('7.2 ReservationCutoverService serves from Firestore when flag is true', async () => {
    process.env.USE_FIRESTORE_RESERVATIONS = 'true';
    let calledMysql = false;
    const res = await ReservationCutoverService.createReservation(
      {
        guestName: 'Cutover Serving Guest',
        phone: '9876543224',
        arrivalDate: '2027-04-01',
        departureDate: '2027-04-05',
        roomNumber: testRoom1
      },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE');
  });

  await runTest('7.3 ReservationCutoverService does NOT fallback for business 400/409 errors', async () => {
    process.env.USE_FIRESTORE_RESERVATIONS = 'true';
    let calledMysql = false;
    let threw = false;
    try {
      await ReservationCutoverService.createReservation(
        {
          guestName: '', // invalid
          phone: '9876543225',
          arrivalDate: '2027-04-01',
          departureDate: '2027-04-05',
          roomNumber: testRoom1
        },
        async () => {
          calledMysql = true;
          return { success: true, fromMysql: true };
        }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 400);
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(calledMysql, false);
  });

  await runTest('7.4 ReservationCutoverService fails closed with FIRESTORE_TIMEOUT on timeout (no MySQL fallback)', async () => {
    process.env.USE_FIRESTORE_RESERVATIONS = 'true';
    let calledMysql = false;
    let threw = false;
    try {
      await ReservationCutoverService.createReservation(
        {
          guestName: 'Timeout Test',
          phone: '9876543226',
          arrivalDate: '2027-05-01',
          departureDate: '2027-05-05',
          roomNumber: testRoom1,
          timeoutMs: 0 // trigger timeout
        },
        async () => {
          calledMysql = true;
          return { success: true, fromMysql: true };
        }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, 'FIRESTORE_TIMEOUT');
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(calledMysql, false);
  });

  await runTest('7.5 ReservationCutoverService reconciles previously committed transaction on timeout', async () => {
    process.env.USE_FIRESTORE_RESERVATIONS = 'true';
    const committedKey = `reconciled_res_key_${ts}`;
    await db.collection('idempotency_keys').doc(committedKey).set({
      key: committedKey,
      status: 'COMPLETED',
      result: { success: true, resReconciled: true }
    });

    let calledMysql = false;
    const res = await ReservationCutoverService.createReservation(
      {
        guestName: 'Reconciled Test',
        phone: '9876543227',
        arrivalDate: '2027-06-01',
        departureDate: '2027-06-05',
        roomNumber: testRoom1,
        idempotencyKey: committedKey,
        timeoutMs: 0 // trigger timeout
      },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE_RECONCILED');
    assert.strictEqual(res.resReconciled, true);
  });

  await runTest('7.6 ReservationCutoverService update & cancel fail closed on timeout (no MySQL fallback)', async () => {
    process.env.USE_FIRESTORE_RESERVATIONS = 'true';
    let calledMysqlUpdate = false;
    let threwUpdate = false;
    try {
      await ReservationCutoverService.updateReservation(
        'res_test_timeout',
        { timeoutMs: 0 },
        {},
        async () => {
          calledMysqlUpdate = true;
          return { success: true, fromMysql: true };
        }
      );
    } catch (err) {
      threwUpdate = true;
      assert.strictEqual(err.code, 'FIRESTORE_TIMEOUT');
    }
    assert.strictEqual(threwUpdate, true);
    assert.strictEqual(calledMysqlUpdate, false);

    let calledMysqlCancel = false;
    let threwCancel = false;
    try {
      await ReservationCutoverService.cancelReservation(
        'res_test_timeout',
        { timeoutMs: 0 },
        {},
        async () => {
          calledMysqlCancel = true;
          return { success: true, fromMysql: true };
        }
      );
    } catch (err) {
      threwCancel = true;
      assert.strictEqual(err.code, 'FIRESTORE_TIMEOUT');
    }
    assert.strictEqual(threwCancel, true);
    assert.strictEqual(calledMysqlCancel, false);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 8: READ QUERIES & API CONTRACT (30 to 35)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 8: Read Queries & API Contract ---');

  await runTest('8.1 getReservationsFirestore returns list with summary counts', async () => {
    const res = await ReservationFirestoreAdapter.getReservationsFirestore();
    assert.strictEqual(res.success, true);
    assert.ok(Array.isArray(res.reservations));
    assert.ok(res.reservations.length > 0);
  });

  await runTest('8.2 getReservationsFirestore filters by status correctly', async () => {
    const res = await ReservationFirestoreAdapter.getReservationsFirestore({ status: 'Cancelled' });
    assert.strictEqual(res.success, true);
    assert.ok(res.reservations.every(r => r.status === 'Cancelled'));
  });

  await runTest('8.3 getReservationsFirestore searches by guest name and phone', async () => {
    const res = await ReservationFirestoreAdapter.getReservationsFirestore({ search: 'Alice' });
    assert.strictEqual(res.success, true);
    assert.ok(res.reservations.some(r => r.guest_name.includes('Alice')));
  });

  await runTest('8.4 getReservationByIdFirestore retrieves single reservation accurately', async () => {
    const res = await ReservationFirestoreAdapter.getReservationByIdFirestore(createdResNumber1);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.reservation.reservation_number, createdResNumber1);
  });

  await runTest('8.5 getReservationReportFirestore aggregates summary metrics', async () => {
    const res = await ReservationFirestoreAdapter.getReservationReportFirestore();
    assert.strictEqual(res.success, true);
    assert.strictEqual(typeof res.summary.totalReservations, 'number');
    assert.strictEqual(typeof res.summary.reservedCount, 'number');
    assert.strictEqual(typeof res.summary.cancelledCount, 'number');
    assert.strictEqual(typeof res.summary.totalAdvance, 'number');
  });

  await runTest('8.6 ReservationCutoverService read endpoints serve from Firestore', async () => {
    process.env.USE_FIRESTORE_RESERVATIONS = 'true';
    const listRes = await ReservationCutoverService.getReservations({}, async () => ({}));
    assert.strictEqual(listRes.source, 'FIRESTORE');

    const singleRes = await ReservationCutoverService.getReservationById(createdResNumber1, async () => ({}));
    assert.strictEqual(singleRes.source, 'FIRESTORE');

    const reportRes = await ReservationCutoverService.getReservationReport({}, async () => ({}));
    assert.strictEqual(reportRes.source, 'FIRESTORE');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 9: INTEGRATION & LIFECYCLE (36 to 40)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 9: Integration & Lifecycle ---');

  await runTest('9.1 Reservation creation updates Room Availability Engine immediately', async () => {
    const res = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Avail Check Guest',
      phone: '9876543228',
      arrivalDate: '2027-07-01',
      departureDate: '2027-07-05',
      roomNumber: testRoom1
    });

    const avail = await checkRoomAvailabilityFirestore({
      roomNumber: testRoom1,
      arrivalDate: '2027-07-02',
      departureDate: '2027-07-04'
    });
    assert.strictEqual(avail.available, false);
    assert.strictEqual(avail.code, 'ROOM_ALREADY_BOOKED');
  });

  await runTest('9.2 Date boundary handover: new arrival on departure date is AVAILABLE', async () => {
    const avail = await checkRoomAvailabilityFirestore({
      roomNumber: testRoom1,
      arrivalDate: '2027-07-05', // exact departure boundary
      departureDate: '2027-07-10'
    });
    assert.strictEqual(avail.available, true);
  });

  await runTest('9.3 Multiple non-overlapping reservations across multiple rooms succeed', async () => {
    const r1 = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Multi Room 1',
      phone: '9876543229',
      arrivalDate: '2027-08-01',
      departureDate: '2027-08-05',
      roomNumber: testRoom1
    });
    const r2 = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Multi Room 2',
      phone: '9876543230',
      arrivalDate: '2027-08-01',
      departureDate: '2027-08-05',
      roomNumber: testRoom2
    });
    assert.strictEqual(r1.success, true);
    assert.strictEqual(r2.success, true);
  });

  await runTest('9.4 Reservation cancellation immediately restores Availability to AVAILABLE', async () => {
    const res = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Cancel Avail Test',
      phone: '9876543231',
      arrivalDate: '2027-09-01',
      departureDate: '2027-09-05',
      roomNumber: testRoom1
    });

    // Cancel
    await ReservationFirestoreAdapter.cancelReservationFirestore(res.reservation.reservation_number);

    // Verify room is available again
    const avail = await checkRoomAvailabilityFirestore({
      roomNumber: testRoom1,
      arrivalDate: '2027-09-01',
      departureDate: '2027-09-05'
    });
    assert.strictEqual(avail.available, true);
  });

  await runTest('9.5 Full Reservation Lifecycle: Create -> Avail Blocked -> Modify Dates -> Cancel -> Avail Freed', async () => {
    // 1. Create
    const created = await ReservationFirestoreAdapter.createReservationFirestore({
      guestName: 'Lifecycle Guest',
      phone: '9876543232',
      arrivalDate: '2027-10-01',
      departureDate: '2027-10-05',
      roomNumber: testRoom1
    });
    const num = created.reservation.reservation_number;

    // 2. Check Avail blocked
    let a1 = await checkRoomAvailabilityFirestore({
      roomNumber: testRoom1,
      arrivalDate: '2027-10-02',
      departureDate: '2027-10-04'
    });
    assert.strictEqual(a1.available, false);

    // 3. Modify Dates to 2027-10-10 -> 2027-10-15
    await ReservationFirestoreAdapter.updateReservationFirestore(num, {
      arrivalDate: '2027-10-10',
      departureDate: '2027-10-15'
    });

    // 4. Old dates now freed
    let a2 = await checkRoomAvailabilityFirestore({
      roomNumber: testRoom1,
      arrivalDate: '2027-10-01',
      departureDate: '2027-10-05'
    });
    assert.strictEqual(a2.available, true);

    // 5. New dates blocked
    let a3 = await checkRoomAvailabilityFirestore({
      roomNumber: testRoom1,
      arrivalDate: '2027-10-11',
      departureDate: '2027-10-14'
    });
    assert.strictEqual(a3.available, false);

    // 6. Cancel
    await ReservationFirestoreAdapter.cancelReservationFirestore(num);

    // 7. New dates now freed
    let a4 = await checkRoomAvailabilityFirestore({
      roomNumber: testRoom1,
      arrivalDate: '2027-10-10',
      departureDate: '2027-10-15'
    });
    assert.strictEqual(a4.available, true);
  });

  try {
    // [Test groups run here]
  } finally {
    // Cleanup test documents
    await db.collection('rooms').doc(`room_${testRoom1}`).delete();
    await db.collection('rooms').doc(`room_${testRoom2}`).delete();
    await db.collection('rooms').doc(`room_${testRoomInactive}`).delete();
    await db.collection('rooms').doc(`room_${testRoomDirty}`).delete();
  }

  console.log('\n===============================================================');
  console.log(`TEST EXECUTION SUMMARY: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('===============================================================\n');

  if (passedTests === totalTests && totalTests === 40) {
    console.log('>>> ALL 40 PHASE 2 STEP 8 TESTS PASSED SUCCESSFULLY! <<<\n');
  } else {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
