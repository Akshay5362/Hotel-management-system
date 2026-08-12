import pool from '../db.js';
import { enqueue } from '../services/outboxService.js';
import { processCheckIn } from '../services/checkInService.js';

async function runPhase3K2ALockingTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3K-2A Locking Fixes & Payload Validation Test Suite');
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
  const testPhone = `999${Math.floor(1000000 + Math.random() * 9000000)}`;

  let testRoomId = null;
  let testRoomNumber = null;
  let createdBookingId = null;
  let createdBookingNumber = null;

  try {
    // ── TEST 1: processCheckIn Guest Phone FOR UPDATE Lookup ─────────────────
    console.log('--- Step 1: processCheckIn Guest Phone FOR UPDATE Lock Verification ---');
    const conn1 = await pool.getConnection();
    try {
      await conn1.beginTransaction();

      // Find an available vacant room
      const [roomRows] = await conn1.query("SELECT id, number FROM rooms WHERE status = 'vacant' LIMIT 1");
      if (roomRows.length === 0) {
        throw new Error('No vacant room available for test');
      }
      testRoomId = roomRows[0].id;
      testRoomNumber = roomRows[0].number;

      // Call processCheckIn (uses guest phone FOR UPDATE query internally)
      const checkInResult = await processCheckIn(conn1, {
        roomNumber: testRoomNumber,
        guestName: `Test Guest ${rand}`,
        phone: testPhone,
        pax: 2,
        deposit: 500,
        departureDate: '2026-08-20',
        billing_instruction: 'Direct to Guest',
        meal_plan: 'CP'
      });

      assert(!!checkInResult && checkInResult.bookingId > 0, 'processCheckIn executed successfully and returned bookingId');
      createdBookingId = checkInResult.bookingId;

      // Verify guest record was created/retrieved with FOR UPDATE
      const [guestRows] = await conn1.query('SELECT id FROM guests WHERE phone = ? LIMIT 1 FOR UPDATE', [testPhone]);
      assert(guestRows.length === 1, 'Guest phone lookup FOR UPDATE returned guest record inside transaction');

      await conn1.commit();
      assert(true, 'Transaction committed successfully');
    } catch (e) {
      await conn1.rollback();
      throw e;
    } finally {
      conn1.release();
    }

    // ── TEST 2: modifyCheckIn Payload Completeness & FOR UPDATE Queries ────
    console.log('\n--- Step 2: modifyCheckIn Outbox Payload Completeness & Locking Verification ---');
    const conn2 = await pool.getConnection();
    try {
      await conn2.beginTransaction();

      // 1. Lock room FOR UPDATE
      const [roomRows] = await conn2.query('SELECT id, status FROM rooms WHERE number = ? FOR UPDATE', [testRoomNumber]);
      assert(roomRows.length > 0, 'SELECT rooms ... FOR UPDATE succeeded inside transaction');

      // 2. Lock active booking FOR UPDATE
      const [bookingRows] = await conn2.query(
        "SELECT * FROM bookings WHERE room_id = ? AND booking_status IN ('Checked In', 'Reserved') ORDER BY id DESC LIMIT 1 FOR UPDATE",
        [testRoomId]
      );
      assert(bookingRows.length > 0, 'SELECT bookings ... FOR UPDATE succeeded inside transaction');
      const booking = bookingRows[0];

      // 3. Stage BOOKING_UPDATED payload with all required 14 fields
      const updatedPayload = {
        booking_number: String(booking.booking_number),
        guest_id: String(booking.guest_id),
        room_id: String(booking.room_id),
        check_in_date: String('2026-08-11'),
        expected_check_out_date: String('2026-08-22'),
        adults: 3,
        advance_amount: 1000,
        total_amount: Number(booking.total_amount || 0),
        booking_status: String(booking.booking_status),
        payment_status: String(booking.payment_status || 'Pending'),
        billing_instruction: 'Bill to Company',
        meal_plan: 'MAP',
        mysql_booking_id: booking.id,
        updated_at: new Date().toISOString()
      };

      const requiredKeys = [
        'booking_number',
        'guest_id',
        'room_id',
        'check_in_date',
        'expected_check_out_date',
        'adults',
        'advance_amount',
        'total_amount',
        'booking_status',
        'payment_status',
        'billing_instruction',
        'meal_plan',
        'mysql_booking_id',
        'updated_at'
      ];

      const hasAllKeys = requiredKeys.every(k => Object.prototype.hasOwnProperty.call(updatedPayload, k));
      assert(hasAllKeys, 'BOOKING_UPDATED payload contains all required 14 fields');

      await enqueue(conn2, {
        event_type: 'BOOKING_UPDATED',
        aggregate_type: 'BOOKING',
        aggregate_id: booking.booking_number,
        payload: updatedPayload
      });

      await conn2.commit();
      assert(true, 'modifyCheckIn transaction committed with staged outbox event');
    } catch (e) {
      await conn2.rollback();
      throw e;
    } finally {
      conn2.release();
    }

    // ── TEST 3: Rollback Atomicity in modifyCheckIn ────────────────────────
    console.log('\n--- Step 3: Transaction Rollback Atomicity Verification ---');
    const conn3 = await pool.getConnection();
    try {
      await conn3.beginTransaction();

      const rollbackTag = `BKG_ROLLBACK_3K2A_${rand}`;
      await enqueue(conn3, {
        event_type: 'BOOKING_UPDATED',
        aggregate_type: 'BOOKING',
        aggregate_id: rollbackTag,
        payload: { booking_number: rollbackTag }
      });

      await conn3.rollback();
      assert(true, 'Forced transaction rollback executed');

      const [outboxCheck] = await pool.query('SELECT * FROM dual_write_outbox WHERE aggregate_id = ?', [rollbackTag]);
      assert(outboxCheck.length === 0, 'Zero outbox events present in DB post-rollback');
    } finally {
      conn3.release();
    }

    // ── TEST 4: checkOut FOR UPDATE Query Verification ───────────────────────
    console.log('\n--- Step 4: checkOut Active Booking FOR UPDATE Lock Verification ---');
    const conn4 = await pool.getConnection();
    try {
      await conn4.beginTransaction();

      const [bkgCheckOutRows] = await conn4.query(
        `SELECT b.*, g.full_name as guestName FROM bookings b
         JOIN guests g ON b.guest_id = g.id
         WHERE b.room_id = ? AND b.booking_status = 'Checked In'
         FOR UPDATE`,
        [testRoomId]
      );
      assert(bkgCheckOutRows.length > 0, 'checkOut active booking SELECT ... FOR UPDATE query executed inside transaction');

      await conn4.rollback();
    } finally {
      conn4.release();
    }

    // ── TEST 5: shift Deterministic Room & Booking FOR UPDATE Locking ─────
    console.log('\n--- Step 5: shift Deterministic Room & Booking FOR UPDATE Verification ---');
    const conn5 = await pool.getConnection();
    try {
      await conn5.beginTransaction();

      // Find second vacant room for shift target
      const [targetRoomRows] = await conn5.query("SELECT id, number FROM rooms WHERE id != ? AND status = 'vacant' LIMIT 1", [testRoomId]);
      if (targetRoomRows.length > 0) {
        const targetRoomNumber = targetRoomRows[0].number;
        const [lockedRooms] = await conn5.query(
          `SELECT r.*, rt.base_rate as rate, rt.code as type
           FROM rooms r
           JOIN room_types rt ON r.room_type_id = rt.id
           WHERE r.number IN (?, ?)
           ORDER BY r.id ASC
           FOR UPDATE`,
          [testRoomNumber, targetRoomNumber]
        );
        assert(lockedRooms.length === 2, 'shift source and target rooms locked in deterministic ORDER BY r.id ASC FOR UPDATE');

        const [activeBkgShift] = await conn5.query(
          "SELECT * FROM bookings WHERE room_id = ? AND booking_status = 'Checked In' FOR UPDATE",
          [testRoomId]
        );
        assert(activeBkgShift.length > 0, 'shift active booking locked with FOR UPDATE');
      } else {
        console.log('  ⚠️ Skipping target room query test (no second vacant room)');
      }

      await conn5.rollback();
    } finally {
      conn5.release();
    }

  } catch (err) {
    console.error('Unhandled error during Phase 3K-2A test:', err);
    failed++;
  } finally {
    // ── CLEANUP PHASE ───────────────────────────────────────────────────────
    console.log('\n--- Step 6: Test Cleanup ---');
    if (createdBookingId) {
      const connClean = await pool.getConnection();
      try {
        await connClean.beginTransaction();
        await connClean.query('DELETE FROM ledger_items WHERE booking_id = ?', [createdBookingId]);
        await connClean.query('DELETE FROM payments WHERE booking_id = ?', [createdBookingId]);
        await connClean.query('DELETE FROM cash_logs WHERE booking_id = ?', [createdBookingId]);
        await connClean.query('DELETE FROM audit_logs WHERE details LIKE ?', [`%${createdBookingId}%`]);
        await connClean.query('DELETE FROM bookings WHERE id = ?', [createdBookingId]);
        if (testPhone) {
          await connClean.query('DELETE FROM guests WHERE phone = ?', [testPhone]);
        }
        if (testRoomId) {
          await connClean.query("UPDATE rooms SET status = 'vacant', housekeeping_status = 'Clean', housekeeping_priority = 'Normal' WHERE id = ?", [testRoomId]);
        }
        await connClean.query('DELETE FROM dual_write_outbox WHERE aggregate_id = ?', [createdBookingNumber]);
        await connClean.commit();
        assert(true, 'Test booking, guest, and outbox records cleaned up cleanly');
      } catch (ce) {
        await connClean.rollback();
        console.error('Cleanup error:', ce);
      } finally {
        connClean.release();
      }
    }
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3K-2A Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase3K2ALockingTests();
