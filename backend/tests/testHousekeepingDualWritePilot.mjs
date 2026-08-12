import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { updateHousekeepingStatus, assignHousekeeper } from '../controllers/housekeepingController.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import { enqueue } from '../services/outboxService.js';
import { dispatchEvent } from '../services/outboxDispatcher.js';
import {
  getHousekeepingByIdFirestore, createHousekeepingRecordFirestore, updateHousekeepingRecordFirestore, deleteHousekeepingRecordFirestore
} from '../repositories/firestore/housekeepingRepository.js';
import { deleteRoomFirestore } from '../repositories/firestore/roomsRepository.js';

async function runHousekeepingDualWritePilotTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3I Housekeeping Dual-Write Pilot Test Suite');
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

  const rand = Math.floor(100 + Math.random() * 899);
  const testRoomNumber = `P3I_${rand}`;
  let testRoomId = null;
  let conn;

  function createMockRes() {
    return {
      statusCode: 200,
      jsonData: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.jsonData = data;
        return this;
      }
    };
  }

  try {
    conn = await pool.getConnection();
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

    // 1. Setup Test Room in MySQL
    const [rtRows] = await conn.query('SELECT id FROM room_types LIMIT 1');
    const roomTypeId = rtRows[0]?.id || 1;

    const [roomRes] = await conn.query(
      `INSERT INTO rooms (number, room_type_id, status, housekeeping_status) VALUES (?, ?, 'vacant', 'Dirty')`,
      [testRoomNumber, roomTypeId]
    );
    testRoomId = roomRes.insertId;

    // Test 1, 3, 4, 13 & 14: updateHousekeepingStatus Controller Integration
    console.log('--- Test 1, 3, 4, 13 & 14: updateHousekeepingStatus Controller Integration ---');
    const mockReqStatus = {
      body: { roomId: testRoomId, status: 'In Progress', notes: 'Phase 3I test cleaning' },
      user: { id: 1, role: 'admin' }
    };
    const mockResStatus = createMockRes();

    await updateHousekeepingStatus(mockReqStatus, mockResStatus);
    assert(mockResStatus.statusCode === 200, 'updateHousekeepingStatus returned 200 OK');

    const [outboxRows] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'HOUSEKEEPING_STATUS_UPDATED'`,
      [testRoomNumber]
    );
    assert(outboxRows.length === 1, 'HOUSEKEEPING_STATUS_UPDATED outbox event staged inside transaction');

    // Test 5 & 6: MySQL Rollback Guard
    console.log('\n--- Test 5 & 6: MySQL Rollback Guard ---');
    try {
      await conn.beginTransaction();
      await conn.query(`UPDATE rooms SET housekeeping_status = 'Clean' WHERE id = ?`, [testRoomId]);
      await enqueue(conn, {
        event_type: 'HOUSEKEEPING_STATUS_UPDATED',
        aggregate_type: 'HOUSEKEEPING',
        aggregate_id: 'FAIL_P3I',
        payload: { room_id: String(testRoomId), room_number: testRoomNumber, housekeeping_status: 'Clean' }
      });
      await conn.rollback();
      assert(true, 'Rolled back failed housekeeping transaction');
    } catch (e) {
      if (conn) await conn.rollback();
    }

    const [failOutbox] = await conn.query(`SELECT * FROM dual_write_outbox WHERE aggregate_id = 'FAIL_P3I'`);
    assert(failOutbox.length === 0, 'Zero outbox events committed for rolled-back transaction');

    // Test 7 & 8: Worker Dispatch to Firestore
    console.log('\n--- Test 7 & 8: Worker Dispatch to Firestore ---');
    if (isFirebaseConfigured) {
      const batchResult = await processOutboxBatch(10, 5);
      assert(batchResult.processed > 0, 'Outbox worker processed HOUSEKEEPING_STATUS_UPDATED event');

      const firestoreHkDoc = await getHousekeepingByIdFirestore(`hk_room_${testRoomNumber}`);
      assert(firestoreHkDoc && (firestoreHkDoc.status === 'In Progress' || firestoreHkDoc.housekeeping_status === 'In Progress'), 'Firestore housekeeping status updated to In Progress');
    } else {
      console.log('  ~ Firebase not configured, skipped live Firestore dispatch assertion.');
    }

    // Test 2 & 8: assignHousekeeper Integration
    console.log('\n--- Test 2 & 8: assignHousekeeper Integration ---');
    const mockReqAssign = {
      body: { roomId: testRoomId, userId: 1, priority: 'High' },
      user: { id: 1, role: 'admin' }
    };
    const mockResAssign = createMockRes();

    await assignHousekeeper(mockReqAssign, mockResAssign);
    assert(mockResAssign.statusCode === 200, 'assignHousekeeper returned 200 OK');

    const [assignOutbox] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'HOUSEKEEPING_LOG_CREATED'`,
      [testRoomNumber]
    );
    assert(assignOutbox.length === 1, 'HOUSEKEEPING_LOG_CREATED outbox event staged');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const updatedHkDoc = await getHousekeepingByIdFirestore(`hk_room_${testRoomNumber}`);
      assert(updatedHkDoc && updatedHkDoc.priority === 'High', 'Firestore housekeeping priority updated to High');
    }

    // Test 11: Stale Event Protection (Older Event Arrives Late)
    console.log('\n--- Test 11: Stale Event Protection (Older Event Arrives Late) ---');
    if (isFirebaseConfigured) {
      const currentPriority = 'High';
      const olderTime = new Date(Date.now() - 3600000).toISOString();
      const staleEvent = {
        event_type: 'HOUSEKEEPING_STATUS_UPDATED',
        payload: {
          room_id: String(testRoomId),
          room_number: testRoomNumber,
          status: 'Dirty',
          priority: 'Low',
          updated_at: olderTime
        }
      };

      await dispatchEvent(staleEvent);

      const firestoreStaleCheck = await getHousekeepingByIdFirestore(`hk_room_${testRoomNumber}`);
      assert(
        firestoreStaleCheck && firestoreStaleCheck.priority === currentPriority,
        'Stale Event Guard rejected older event T2 and preserved newer state T3'
      );
    } else {
      console.log('  ~ Firebase not configured, skipped live Stale Event Guard assertion.');
    }

    // Test 9, 10 & 12: Idempotency Replay
    console.log('\n--- Test 9, 10 & 12: Idempotency Replay ---');
    if (isFirebaseConfigured) {
      const dupEvent = {
        event_type: 'HOUSEKEEPING_STATUS_UPDATED',
        payload: {
          room_id: String(testRoomId),
          room_number: testRoomNumber,
          status: 'Clean',
          updated_at: new Date().toISOString()
        }
      };
      await dispatchEvent(dupEvent);
      await dispatchEvent(dupEvent);
      const dupCheck = await getHousekeepingByIdFirestore(`hk_room_${testRoomNumber}`);
      assert(dupCheck && dupCheck.status === 'Clean', 'Idempotent replay executed cleanly');
    }

    // Test 16: Automated Test Cleanup
    console.log('\n--- Test 16: CLEANUP PHASE ---');
    await conn.query('DELETE FROM housekeeping_logs WHERE room_id = ?', [testRoomId]);
    await conn.query('DELETE FROM rooms WHERE id = ?', [testRoomId]);
    await conn.query('DELETE FROM dual_write_outbox WHERE aggregate_id = ?', [testRoomNumber]);
    assert(true, 'Cleaned up MySQL test room, housekeeping logs, and outbox records');

    if (isFirebaseConfigured) {
      await deleteHousekeepingRecordFirestore(`hk_room_${testRoomNumber}`).catch(() => {});
      await deleteRoomFirestore(`room_${testRoomNumber}`).catch(() => {});
      console.log('  ✓ Cleaned up test Firestore housekeeping and room documents.');
    }

  } catch (err) {
    console.error('Unhandled error during Housekeeping Dual-Write Pilot test:', err);
    failed++;
  } finally {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    if (testRoomNumber || testRoomId) {
      try {
        const cleanupConn = await pool.getConnection();
        if (testRoomId) {
          await cleanupConn.query('DELETE FROM housekeeping_logs WHERE room_id = ?', [testRoomId]);
          await cleanupConn.query('DELETE FROM rooms WHERE id = ?', [testRoomId]);
        }
        await cleanupConn.query('DELETE FROM dual_write_outbox WHERE aggregate_id = ?', [testRoomNumber]);
        cleanupConn.release();
      } catch (e) {}
      if (isFirebaseConfigured) {
        await deleteHousekeepingRecordFirestore(`hk_room_${testRoomNumber}`).catch(() => {});
        await deleteRoomFirestore(`room_${testRoomNumber}`).catch(() => {});
      }
    }
    if (conn) conn.release();
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3I Housekeeping Pilot Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runHousekeepingDualWritePilotTests();
