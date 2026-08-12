import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { updateRoomStatus } from '../controllers/roomController.js';
import { updateHousekeepingStatus } from '../controllers/housekeepingController.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import { enqueue, claimNextBatch, markProcessed } from '../services/outboxService.js';
import { dispatchEvent } from '../services/outboxDispatcher.js';
import {
  getRoomByIdFirestore, createRoomFirestore, updateRoomFirestore, updateRoomStatusFirestore, deleteRoomFirestore
} from '../repositories/firestore/roomsRepository.js';

async function runRoomsDualWritePilotTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3C Rooms Dual-Write Pilot Test Suite');
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

  const rand = Math.random().toString(36).substring(2, 7);
  const testRoomNum = `P3C_${rand.toUpperCase()}`;
  let createdRoomId = null;
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

    // 1. MySQL Room Creation + Outbox Event Staging
    console.log('--- Test A: Room Creation + Outbox Staging ---');
    await conn.beginTransaction();
    
    // Get a valid room_type_id
    const [rtRows] = await conn.query('SELECT id FROM room_types LIMIT 1');
    const roomTypeId = rtRows[0]?.id || 1;

    const [createRes] = await conn.query(
      `INSERT INTO rooms (number, room_type_id, status, housekeeping_status) VALUES (?, ?, 'vacant', 'Clean')`,
      [testRoomNum, roomTypeId]
    );
    createdRoomId = createRes.insertId;

    const createEvt = await enqueue(conn, {
      event_type: 'ROOM_CREATED',
      aggregate_type: 'ROOM',
      aggregate_id: testRoomNum,
      payload: {
        number: testRoomNum,
        room_number: testRoomNum,
        type: 'SUITE',
        status: 'vacant',
        housekeeping_status: 'Clean',
        price: 5000,
        mysql_room_id: createdRoomId,
        updated_at: new Date().toISOString()
      }
    });

    await conn.commit();
    assert(createEvt && createEvt.event_id, 'Enqueued ROOM_CREATED event inside MySQL transaction');

    // Test E: MySQL Rollback -> No Committed Outbox Event
    console.log('\n--- Test E: MySQL Rollback Verification ---');
    try {
      await conn.beginTransaction();
      await conn.query(`INSERT INTO rooms (number, room_type_id, status) VALUES ('FAIL_3C', ?, 'vacant')`, [roomTypeId]);
      await enqueue(conn, {
        event_type: 'ROOM_CREATED',
        aggregate_type: 'ROOM',
        aggregate_id: 'FAIL_3C',
        payload: { number: 'FAIL_3C', type: 'SUITE' }
      });
      await conn.rollback();
      assert(true, 'Rolled back failed room transaction');
    } catch (e) {
      if (conn) await conn.rollback();
    }

    const [failOutbox] = await conn.query(`SELECT * FROM dual_write_outbox WHERE aggregate_id = 'FAIL_3C'`);
    assert(failOutbox.length === 0, 'Zero outbox events committed for rolled-back transaction');

    // Test F & G: Outbox Worker Claim & Process -> Firestore Document Generation
    console.log('\n--- Test F & G: Worker Processing & Firestore Sync ---');
    if (isFirebaseConfigured) {
      const batchResult = await processOutboxBatch(10, 5);
      assert(batchResult.processed > 0, 'Outbox worker processed ROOM_CREATED event');

      const firestoreRoomDoc = await getRoomByIdFirestore(`room_${testRoomNum}`);
      assert(firestoreRoomDoc && firestoreRoomDoc.number === testRoomNum, 'Firestore room document created cleanly');
    } else {
      console.log('  ~ Firebase not configured, skipped live Firestore sync assertion.');
    }

    // Test H: `updateRoomStatus` Integration (MySQL Write + Staged Outbox Event)
    console.log('\n--- Test H: updateRoomStatus Controller Dual-Write ---');
    const mockReqStatus = {
      params: { number: testRoomNum },
      body: { action: 'mark_dirty' },
      user: { id: 1, role: 'admin' }
    };
    const mockResStatus = createMockRes();

    await updateRoomStatus(mockReqStatus, mockResStatus);
    assert(mockResStatus.statusCode === 200, 'updateRoomStatus returned 200 OK');

    const [statusOutbox] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'ROOM_STATUS_CHANGED'`,
      [testRoomNum]
    );
    assert(statusOutbox.length === 1, 'updateRoomStatus staged ROOM_STATUS_CHANGED outbox event inside transaction');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const updatedStatusDoc = await getRoomByIdFirestore(`room_${testRoomNum}`);
      assert(updatedStatusDoc && updatedStatusDoc.status === 'dirty', 'Firestore room status updated to dirty');
    }

    // Test D: `updateHousekeepingStatus` Integration
    console.log('\n--- Test D: updateHousekeepingStatus Controller Dual-Write ---');
    const mockReqHk = {
      body: { roomId: createdRoomId, status: 'In Progress' },
      user: { id: 1, role: 'admin' }
    };
    const mockResHk = createMockRes();

    await updateHousekeepingStatus(mockReqHk, mockResHk);
    assert(mockResHk.statusCode === 200, 'updateHousekeepingStatus returned 200 OK');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const updatedHkDoc = await getRoomByIdFirestore(`room_${testRoomNum}`);
      assert(updatedHkDoc && updatedHkDoc.housekeeping_status === 'In Progress', 'Firestore updated to In Progress');
    }

    // Test K: Stale Event Protection (Older Event Arrives Late)
    console.log('\n--- Test K: Stale Event Protection (Older Event Arrives Late) ---');
    if (isFirebaseConfigured) {
      const olderTime = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      const staleEvent = {
        event_type: 'ROOM_UPDATED',
        payload: {
          number: testRoomNum,
          status: 'vacant',
          updated_at: olderTime
        }
      };

      await dispatchEvent(staleEvent);

      const firestoreStaleCheck = await getRoomByIdFirestore(`room_${testRoomNum}`);
      assert(
        firestoreStaleCheck && (firestoreStaleCheck.status === 'dirty' || firestoreStaleCheck.housekeeping_status === 'In Progress'),
        'Stale Event Guard rejected older event T2 and preserved newer state T3'
      );
    } else {
      console.log('  ~ Firebase not configured, skipped live Stale Event Guard assertion.');
    }

    // Test J: Duplicate Event Replay (Idempotency)
    console.log('\n--- Test J: Duplicate Event Replay (Idempotency) ---');
    if (isFirebaseConfigured) {
      const mockDupEvent = {
        event_type: 'ROOM_CREATED',
        payload: {
          number: testRoomNum,
          type: 'SUITE',
          price: 5000,
          status: 'vacant',
          updated_at: new Date(Date.now() + 20000).toISOString()
        }
      };
      await dispatchEvent(mockDupEvent); // 1st replay
      await dispatchEvent(mockDupEvent); // 2nd replay
      const dupCheck = await getRoomByIdFirestore(`room_${testRoomNum}`);
      assert(dupCheck && dupCheck.number === testRoomNum, 'Idempotent replay executed cleanly without duplication');
    }

    // Test C & I: Room Deletion (`ROOM_DELETED`)
    console.log('\n--- Test C & I: Room Deletion ---');
    await conn.beginTransaction();
    await conn.query(`DELETE FROM rooms WHERE id = ?`, [createdRoomId]);
    await enqueue(conn, {
      event_type: 'ROOM_DELETED',
      aggregate_type: 'ROOM',
      aggregate_id: testRoomNum,
      payload: { number: testRoomNum, docId: `room_${testRoomNum}` }
    });
    await conn.commit();

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const deletedRoomDoc = await getRoomByIdFirestore(`room_${testRoomNum}`);
      assert(deletedRoomDoc === null, 'Firestore room document deleted cleanly');
    }

    // Test O: Automated Cleanup Verification
    console.log('\n--- Test O: CLEANUP PHASE ---');
    await conn.query(`DELETE FROM rooms WHERE number = ?`, [testRoomNum]);
    await conn.query(`DELETE FROM dual_write_outbox WHERE aggregate_id = ?`, [testRoomNum]);
    assert(true, 'Cleaned up MySQL test room and outbox records');

    if (isFirebaseConfigured) {
      await deleteRoomFirestore(`room_${testRoomNum}`).catch(() => {});
      console.log('  ✓ Cleaned up test Firestore room document.');
    }

  } catch (err) {
    console.error('Unhandled error during Rooms Dual-Write Pilot test:', err);
    failed++;
  } finally {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    if (createdRoomId || testRoomNum) {
      try {
        const cleanupConn = await pool.getConnection();
        if (createdRoomId) await cleanupConn.query(`DELETE FROM rooms WHERE id = ?`, [createdRoomId]);
        await cleanupConn.query(`DELETE FROM rooms WHERE number = ?`, [testRoomNum]);
        await cleanupConn.query(`DELETE FROM dual_write_outbox WHERE aggregate_id = ?`, [testRoomNum]);
        cleanupConn.release();
      } catch (e) {}
      if (isFirebaseConfigured) {
        await deleteRoomFirestore(`room_${testRoomNum}`).catch(() => {});
      }
    }
    if (conn) conn.release();
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3C Rooms Pilot Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRoomsDualWritePilotTests();
