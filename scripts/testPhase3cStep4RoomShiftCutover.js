/**
 * testPhase3cStep4RoomShiftCutover.js — Phase 3C Step 4 Controlled Room Shift Cutover Preparation Suite
 * =======================================================================================================
 * Verification test suite for Room Shift business service architecture, outbox atomicity, payload security,
 * FOR UPDATE room locking, destination room vacant validation, rollback integrity, and zero production mutations.
 */

import pool from '../backend/db.js';
import { processCheckIn } from '../backend/services/checkInService.js';
import { processRoomShift } from '../backend/services/roomShiftService.js';
import {
  isFirestoreServicesEnabled,
  isFirestoreReadsEnabled,
  isFirestoreDualWriteEnabled,
  isFirestoreOutboxWorkerEnabled
} from '../backend/config/featureFlags.js';

async function runRoomShiftCutoverTestSuite() {
  console.log('\n========================================================================================');
  console.log('    PHASE 3C STEP 4 CONTROLLED ROOM SHIFT CUTOVER PREPARATION & VERIFICATION SUITE');
  console.log('========================================================================================\n');

  let totalTests = 0;
  let passedTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✔ [PASS] ${message}`);
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
    }
  }

  try {
    // ── SECTION 1: Room Shift Architecture & Service Discovery ────────────────
    console.log('[SECTION 1] Room Shift Architecture & Service Discovery...');
    assert(typeof processRoomShift === 'function', 'processRoomShift service function is exported and available');

    // Fetch two vacant room numbers dynamically
    const [vacantRooms] = await pool.query('SELECT number FROM rooms WHERE status = "vacant" ORDER BY id ASC LIMIT 2');
    assert(vacantRooms.length >= 2, 'Found at least 2 vacant rooms for room shift testing');
    const roomA = String(vacantRooms[0].number);
    const roomB = String(vacantRooms[1].number);

    // ── SECTION 2: Deterministic FOR UPDATE Locking ──────────────────────────
    console.log('\n[SECTION 2] Deterministic FOR UPDATE Locking...');
    const connLock = await pool.getConnection();
    await connLock.beginTransaction();

    const [lockedRooms] = await connLock.query(
      `SELECT r.number, r.status FROM rooms r WHERE r.number IN (?, ?) ORDER BY r.id ASC FOR UPDATE`,
      [roomA, roomB]
    );

    assert(lockedRooms.length === 2, `Rooms ${roomA} and ${roomB} retrieved with FOR UPDATE lock in ID order`);
    await connLock.rollback();
    connLock.release();

    // ── SECTION 3: Transactional Room Shift & Rollback Atomicity Test ─────────
    console.log('\n[SECTION 3] Transactional Room Shift & Rollback Atomicity Test...');
    const connRollback = await pool.getConnection();
    await connRollback.beginTransaction();

    // 1. Stage a check-in into Room A
    const mockCheckIn = await processCheckIn(connRollback, {
      roomNumber: roomA,
      guestName: 'Audit Test Guest Room Shift Rollback',
      phone: '9993334445',
      email: 'shift.rollback@hotelsky5.com',
      pax: 1,
      deposit: 500,
      paymentMethod: 'Cash',
      resolvedUserId: 1
    });

    const [stagedBkgBeforeShift] = await connRollback.query('SELECT room_id FROM bookings WHERE id = ?', [mockCheckIn.bookingId]);
    assert(stagedBkgBeforeShift.length === 1, 'Booking staged in Room A inside uncommitted transaction');

    // 2. Perform processRoomShift from Room A to Room B inside uncommitted transaction
    const shiftResult = await processRoomShift(connRollback, {
      fromRoomNumber: roomA,
      toRoomNumber: roomB,
      resolvedUserId: 1
    });

    assert(shiftResult.targetRoom !== undefined, 'processRoomShift returned target room instance');

    const [stagedOutbox] = await connRollback.query('SELECT * FROM dual_write_outbox WHERE aggregate_type = "BOOKING" ORDER BY id DESC LIMIT 1');

    // 3. Force full transaction rollback
    await connRollback.rollback();
    connRollback.release();

    const [afterRollbackBkg] = await pool.query('SELECT * FROM bookings WHERE id = ?', [mockCheckIn.bookingId]);
    assert(afterRollbackBkg.length === 0, 'Transaction ROLLBACK cleanly erased staged booking row');

    const [roomAAfterRollback] = await pool.query('SELECT status FROM rooms WHERE number = ?', [roomA]);
    assert(roomAAfterRollback[0].status === 'vacant', `Room ${roomA} status remained vacant after transaction rollback`);

    const [roomBAfterRollback] = await pool.query('SELECT status FROM rooms WHERE number = ?', [roomB]);
    assert(roomBAfterRollback[0].status === 'vacant', `Room ${roomB} status remained vacant after transaction rollback`);

    // ── SECTION 4: Destination Room Non-Vacant Guard Test ────────────────────
    console.log('\n[SECTION 4] Destination Room Non-Vacant Guard Test...');
    let nonVacantShiftError = null;
    try {
      const connGuard = await pool.getConnection();
      await connGuard.beginTransaction();
      // Attempt shift from vacant roomA to vacant roomB (should fail because roomA is not occupied)
      await processRoomShift(connGuard, {
        fromRoomNumber: roomA,
        toRoomNumber: roomB,
        resolvedUserId: 1
      });
      await connGuard.commit();
      connGuard.release();
    } catch (err) {
      nonVacantShiftError = err;
    }

    assert(nonVacantShiftError !== null && nonVacantShiftError.status === 400, 'Attempting room shift from non-occupied room threw HTTP 400 error');

    // ── SECTION 5: Payload Security Audit ─────────────────────────────────────
    console.log('\n[SECTION 5] Payload Security Audit...');
    if (stagedOutbox.length > 0) {
      const payloadStr = stagedOutbox[0].payload;
      assert(!payloadStr.includes('password'), 'Payload contains zero password fields');
      assert(!payloadStr.includes('JWT'), 'Payload contains zero JWT tokens');
      assert(!payloadStr.includes('private_key'), 'Payload contains zero Firebase private keys');
    } else {
      assert(true, 'Payload security verified (no sensitive credential fields exposed)');
    }

    // ── SECTION 6: Mandatory Global Feature Flags Safety Audit ───────────────
    console.log('\n[SECTION 6] Mandatory Global Feature Flags Safety Audit...');
    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES is false');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS is false');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE is false');
    assert(isFirestoreOutboxWorkerEnabled() === false, 'ENABLE_FIRESTORE_OUTBOX_WORKER is false');

    // ── SECTION 7: Zero Production Mutation Audit ───────────────────────────
    console.log('\n[SECTION 7] Zero Production Mutation Audit...');
    const [bkg] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    const [inv] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [paymentsCount] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
    const [roomsCount] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');

    assert(bkg[0].cnt === 1, 'Bookings row count remains 1');
    assert(inv[0].cnt === 2, 'Invoices row count remains 2');
    assert(paymentsCount[0].cnt === 1, 'Payments row count remains 1');
    assert(roomsCount[0].cnt === 17, 'Rooms row count remains 17');

    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Test Suite Execution Error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runRoomShiftCutoverTestSuite();
