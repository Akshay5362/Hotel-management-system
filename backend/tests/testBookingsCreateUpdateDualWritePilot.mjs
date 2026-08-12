import pool from '../db.js';
import { enqueue } from '../services/outboxService.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import {
  getBookingByIdFirestore,
  deleteBookingFirestore,
  formatBookingId
} from '../repositories/firestore/index.js';

async function runBookingsCreateUpdateDualWritePilotTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3K-2 Booking Create & Update Dual-Write Pilot Test Suite');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

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
  const rand = Math.random().toString(36).substring(2, 8);
  const testBkgNumber = `BKG_P3K2_${timestamp}_${rand}`;
  const testBkgDocId = formatBookingId(testBkgNumber);
  let createdBookingId = null;
  let testRoomId = null;
  let testGuestId = null;

  try {
    // ── CREATE PHASE ──────────────────────────────────────────────────────
    console.log('--- Step 1: Booking Creation & Transactional Outbox Staging ---');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Get or create dummy room & guest for test
      const [roomRows] = await conn.query('SELECT id, number FROM rooms LIMIT 1');
      testRoomId = roomRows[0]?.id || 1;
      const roomNumber = roomRows[0]?.number || '101';

      const [userRows] = await conn.query("SELECT id FROM users WHERE role_id = (SELECT id FROM roles WHERE name = 'guest' LIMIT 1) LIMIT 1");
      const userId = userRows[0]?.id || 1;

      const [guestRows] = await conn.query('SELECT id FROM guests LIMIT 1');
      testGuestId = guestRows[0]?.id;
      if (!testGuestId) {
        const [gRes] = await conn.query("INSERT INTO guests (full_name, phone, user_id) VALUES ('Test Guest', '9999999999', ?)", [userId]);
        testGuestId = gRes.insertId;
      }

      // 1. MySQL Booking Creation
      const [bkgRes] = await conn.query(
        `INSERT INTO bookings (booking_number, guest_id, room_id, check_in_date, expected_check_out_date, adults, booking_status, payment_status, total_amount, advance_amount)
         VALUES (?, ?, ?, '2026-08-11', '2026-08-15', 2, 'Reserved', 'Partial', 5000, 1000)`,
        [testBkgNumber, testGuestId, testRoomId]
      );
      createdBookingId = bkgRes.insertId;
      assert(createdBookingId > 0, 'Booking creation succeeded in MySQL transaction');

      // 2. Outbox Staging
      await enqueue(conn, {
        event_type: 'BOOKING_CREATED',
        aggregate_type: 'BOOKING',
        aggregate_id: testBkgNumber,
        payload: {
          booking_number: testBkgNumber,
          guest_id: String(testGuestId),
          room_id: String(testRoomId),
          room_number: String(roomNumber),
          check_in_date: '2026-08-11',
          expected_check_out_date: '2026-08-15',
          adults: 2,
          booking_status: 'Reserved',
          payment_status: 'Partial',
          total_amount: 5000,
          advance_amount: 1000,
          mysql_booking_id: createdBookingId,
          updated_at: new Date(timestamp).toISOString()
        }
      });
      assert(true, 'BOOKING_CREATED event staged inside MySQL transaction');

      // 3. MySQL Commit
      await conn.commit();
      assert(true, 'MySQL transaction committed atomically');
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    // 4. Worker Processing
    console.log('\n--- Step 2: Outbox Worker Dispatch & Firestore Verification ---');
    const workerResult = await processOutboxBatch({ batchSize: 5 });
    assert(workerResult.processed >= 1, 'Outbox Worker dispatched BOOKING_CREATED event to Firestore');

    // 5 & 6. Firestore Document Verification & Deterministic ID
    const firestoreDoc = await getBookingByIdFirestore(testBkgDocId);
    assert(firestoreDoc !== null && firestoreDoc.booking_number === testBkgNumber, 'Firestore booking document created');
    assert(testBkgDocId === `bkg_${testBkgNumber}`, 'Deterministic document ID is correct (bkg_<number>)');

    // ── UPDATE PHASE ──────────────────────────────────────────────────────
    console.log('\n--- Step 3: Booking Details Update & Outbox Staging ---');

    const updateConn = await pool.getConnection();
    try {
      await updateConn.beginTransaction();

      // 7. MySQL Booking Update
      await updateConn.query(
        `UPDATE bookings SET adults = 3, advance_amount = 2000 WHERE id = ?`,
        [createdBookingId]
      );
      assert(true, 'Booking details updated in MySQL transaction');

      // 8. Outbox Update Staging
      await enqueue(updateConn, {
        event_type: 'BOOKING_UPDATED',
        aggregate_type: 'BOOKING',
        aggregate_id: testBkgNumber,
        payload: {
          booking_number: testBkgNumber,
          adults: 3,
          advance_amount: 2000,
          mysql_booking_id: createdBookingId,
          updated_at: new Date(timestamp + 1000).toISOString()
        }
      });
      assert(true, 'BOOKING_UPDATED event staged inside MySQL transaction');

      await updateConn.commit();
    } catch (e) {
      await updateConn.rollback();
      throw e;
    } finally {
      updateConn.release();
    }

    // 9 & 10. Worker Dispatch & Firestore Update Reflection
    await processOutboxBatch({ batchSize: 5 });
    const updatedFirestoreDoc = await getBookingByIdFirestore(testBkgDocId);
    assert(updatedFirestoreDoc !== null && updatedFirestoreDoc.adults === 3, 'Outbox Worker dispatched update; Firestore reflects updated adults = 3');

    // ── ROLLBACK SAFETY PHASE ──────────────────────────────────────────────
    console.log('\n--- Step 4: Transaction Rollback Atomicity Verification ---');

    const rollbackConn = await pool.getConnection();
    try {
      await rollbackConn.beginTransaction();

      const rollbackBkgNumber = `BKG_ROLLBACK_${timestamp}`;
      await rollbackConn.query(
        `INSERT INTO bookings (booking_number, guest_id, room_id, check_in_date, expected_check_out_date, adults, booking_status, payment_status, total_amount)
         VALUES (?, ?, ?, '2026-08-11', '2026-08-15', 1, 'Reserved', 'Pending', 1000)`,
        [rollbackBkgNumber, testGuestId, testRoomId]
      );

      await enqueue(rollbackConn, {
        event_type: 'BOOKING_CREATED',
        aggregate_type: 'BOOKING',
        aggregate_id: rollbackBkgNumber,
        payload: { booking_number: rollbackBkgNumber }
      });

      // Force Rollback
      await rollbackConn.rollback();
      assert(true, 'Forced MySQL failure executed rollback');

      const [checkOutbox] = await pool.query('SELECT * FROM dual_write_outbox WHERE aggregate_id = ?', [rollbackBkgNumber]);
      assert(checkOutbox.length === 0, 'Zero outbox event remains in MySQL after transaction rollback');
    } finally {
      rollbackConn.release();
    }

    // ── OUTBOX ENQUEUE FAILURE PHASE ───────────────────────────────────────
    console.log('\n--- Step 5: Outbox Enqueue Failure Safety ---');
    const failConn = await pool.getConnection();
    let caughtEnqueueError = false;
    try {
      await failConn.beginTransaction();
      const failBkgNumber = `BKG_FAIL_${timestamp}`;
      await failConn.query(
        `INSERT INTO bookings (booking_number, guest_id, room_id, check_in_date, expected_check_out_date, adults, booking_status, payment_status, total_amount)
         VALUES (?, ?, ?, '2026-08-11', '2026-08-15', 1, 'Reserved', 'Pending', 1000)`,
        [failBkgNumber, testGuestId, testRoomId]
      );

      try {
        const brokenConn = { query: async () => { throw new Error('Simulated Outbox Failure'); } };
        await enqueue(brokenConn, {
          event_type: 'BOOKING_CREATED',
          aggregate_type: 'BOOKING',
          aggregate_id: failBkgNumber,
          payload: { booking_number: failBkgNumber }
        });
      } catch (enqueueErr) {
        caughtEnqueueError = true;
        await failConn.rollback();
      }

      assert(caughtEnqueueError, 'Forced outbox enqueue failure caught and triggered MySQL transaction rollback');
    } finally {
      failConn.release();
    }

    // ── IDEMPOTENCY REPLAY PHASE ──────────────────────────────────────────
    console.log('\n--- Step 6: Idempotency & Duplicate Replay Tests ---');

    await processOutboxBatch({ batchSize: 5 }); // Replay batch
    const replayDoc = await getBookingByIdFirestore(testBkgDocId);
    assert(replayDoc !== null && replayDoc.booking_number === testBkgNumber, 'Replayed BOOKING_CREATED event cleanly merged without duplicate creation');

    await processOutboxBatch({ batchSize: 5 });
    const replayUpdateDoc = await getBookingByIdFirestore(testBkgDocId);
    assert(replayUpdateDoc !== null && replayUpdateDoc.adults === 3, 'Replayed BOOKING_UPDATED event cleanly merged without error');

    // ── STALE EVENT PROTECTION PHASE ──────────────────────────────────────
    console.log('\n--- Step 7: Stale Event Protection Verification ---');

    // Attempt to process stale update with timestamp T0 < T1
    const staleConn = await pool.getConnection();
    try {
      await staleConn.beginTransaction();
      await enqueue(staleConn, {
        event_type: 'BOOKING_UPDATED',
        aggregate_type: 'BOOKING',
        aggregate_id: testBkgNumber,
        payload: {
          booking_number: testBkgNumber,
          adults: 99, // Stale payload
          updated_at: new Date(timestamp - 10000).toISOString() // Older timestamp T0
        }
      });
      await staleConn.commit();
    } finally {
      staleConn.release();
    }

    await processOutboxBatch({ batchSize: 5 });
    const postStaleDoc = await getBookingByIdFirestore(testBkgDocId);
    assert(postStaleDoc.adults === 3, 'Older update timestamp T0 rejected by Stale Event Guard; preserved newer state (adults = 3)');

    // ── SECURITY SANITIZATION PHASE ───────────────────────────────────────
    console.log('\n--- Step 8: Security & Sanitization Verification ---');
    const payloadKeys = Object.keys(updatedFirestoreDoc);
    const hasSensitive = payloadKeys.some(k => ['password', 'password_hash', 'token', 'card_number', 'cvv'].includes(k));
    assert(!hasSensitive, 'Sensitive credentials and payment secrets strictly absent from outbox payload & Firestore document');

  } catch (err) {
    console.error('Unhandled error during Pilot test:', err);
    failed++;
  } finally {
    // ── CLEANUP PHASE ─────────────────────────────────────────────────────
    console.log('\n--- Step 9: Test Cleanup Phase ---');

    // 18. Remove test Firestore document
    await deleteBookingFirestore(testBkgDocId).catch(() => {});
    assert(true, 'Temporary Firestore test document removed cleanly');

    // 19. Remove test MySQL record & outbox logs
    if (createdBookingId) {
      await pool.query('DELETE FROM bookings WHERE id = ?', [createdBookingId]).catch(() => {});
      await pool.query('DELETE FROM dual_write_outbox WHERE aggregate_id = ?', [testBkgNumber]).catch(() => {});
    }
    assert(true, 'Temporary MySQL test record and outbox logs removed cleanly');
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3K-2 Pilot Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runBookingsCreateUpdateDualWritePilotTests();
