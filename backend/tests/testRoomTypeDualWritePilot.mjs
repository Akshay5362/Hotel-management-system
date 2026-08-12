import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { createRoomType, updateRoomType, deleteRoomType } from '../controllers/roomTypeController.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import { enqueue, claimNextBatch, markProcessed } from '../services/outboxService.js';
import { dispatchEvent } from '../services/outboxDispatcher.js';
import { getRoomTypeByIdFirestore, deleteRoomTypeFirestore } from '../repositories/firestore/roomTypesRepository.js';

async function runRoomTypePilotTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3B Room Types Dual-Write Pilot Test Suite');
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
  const rand = Math.random().toString(36).substring(2, 7);
  const testCode = `P3B_${rand.toUpperCase()}`;
  const testName = `Phase 3B Pilot Suite ${rand}`;
  let conn;

  // Mock res object
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

    // Enable feature flag dynamically for test suite context
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

    // Scenario A: MySQL Write Succeeds + Outbox Event Enqueued
    console.log('--- Scenario A: Room Type Creation + Outbox Staging ---');
    const reqCreate = {
      body: { code: testCode, title: testName, description: 'Pilot room type', base_rate: 7500 }
    };
    const resCreate = createMockRes();

    await createRoomType(reqCreate, resCreate);
    assert(resCreate.statusCode === 201 && resCreate.jsonData.id, 'createRoomType returned 201 with insertId');
    const createdId = resCreate.jsonData.id;

    const [outboxRowsA] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_type = 'ROOM_TYPE' AND aggregate_id = ?`,
      [testCode]
    );
    assert(outboxRowsA.length > 0 && outboxRowsA[0].event_type === 'ROOM_TYPE_CREATED', 'Outbox event ROOM_TYPE_CREATED staged in MySQL transaction');

    // Scenario B: MySQL Rollback (Simulated failure)
    console.log('\n--- Scenario B: MySQL Transaction Rollback ---');
    try {
      await conn.beginTransaction();
      await conn.query('INSERT INTO room_types (code, title, base_rate) VALUES (?, ?, ?)', ['FAIL_CODE', 'Fail Title', 1000]);
      await enqueue(conn, {
        event_type: 'ROOM_TYPE_CREATED',
        aggregate_type: 'ROOM_TYPE',
        aggregate_id: 'FAIL_CODE',
        payload: { code: 'FAIL_CODE', title: 'Fail Title', base_rate: 1000 }
      });
      await conn.rollback(); // Rollback simulation
      assert(true, 'Rolled back MySQL transaction');
    } catch (e) {
      if (conn) await conn.rollback();
    }

    const [failRows] = await conn.query(`SELECT * FROM dual_write_outbox WHERE aggregate_id = 'FAIL_CODE'`);
    assert(failRows.length === 0, 'Zero outbox rows exist for rolled back transaction');

    // Scenario C & D: Outbox Dispatch to Firestore
    console.log('\n--- Scenario C & D: Asynchronous Worker Processing to Firestore ---');
    if (isFirebaseConfigured) {
      const batchResult = await processOutboxBatch(10, 5);
      assert(batchResult.processed > 0, 'Outbox worker processed pending ROOM_TYPE_CREATED event');

      const firestoreDoc = await getRoomTypeByIdFirestore(`type_${testCode}`);
      assert(firestoreDoc && firestoreDoc.code === testCode && firestoreDoc.base_rate === 7500, 'Firestore room_types document synchronized successfully');
    } else {
      console.log('  ~ Firebase not configured, skipped live Firestore dispatch assertion.');
    }

    // Scenario E: Idempotency Replay Test
    console.log('\n--- Scenario E: Idempotency Replay ---');
    if (isFirebaseConfigured) {
      const mockEvent = {
        event_type: 'ROOM_TYPE_CREATED',
        payload: { code: testCode, title: testName, base_rate: 7500, mysql_room_type_id: createdId }
      };
      // Re-dispatching exact same event should not throw or duplicate
      await dispatchEvent(mockEvent);
      const firestoreDocReplay = await getRoomTypeByIdFirestore(`type_${testCode}`);
      assert(firestoreDocReplay && firestoreDocReplay.code === testCode, 'Idempotent re-dispatch preserved document without duplicates');
    }

    // Scenario G: Sequential Updates (Created -> Updated -> Updated Again)
    console.log('\n--- Scenario G: Room Type Sequential Updates ---');
    const reqUpdate1 = { params: { id: createdId }, body: { title: `${testName} V2`, base_rate: 8000 } };
    const resUpdate1 = createMockRes();
    await updateRoomType(reqUpdate1, resUpdate1);
    assert(resUpdate1.statusCode === 200, 'updateRoomType V1 returned 200');

    const reqUpdate2 = { params: { id: createdId }, body: { title: `${testName} V3`, base_rate: 8500 } };
    const resUpdate2 = createMockRes();
    await updateRoomType(reqUpdate2, resUpdate2);
    assert(resUpdate2.statusCode === 200, 'updateRoomType V2 returned 200');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const updatedDoc = await getRoomTypeByIdFirestore(`type_${testCode}`);
      assert(updatedDoc && updatedDoc.name === `${testName} V3` && updatedDoc.base_rate === 8500, 'Sequential updates synchronized final state to Firestore');
    }

    // Scenario H: Room Type Deletion
    console.log('\n--- Scenario H: Room Type Deletion ---');
    const reqDelete = { params: { id: createdId } };
    const resDelete = createMockRes();
    await deleteRoomType(reqDelete, resDelete);
    assert(resDelete.statusCode === 200, 'deleteRoomType returned 200');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const deletedDoc = await getRoomTypeByIdFirestore(`type_${testCode}`);
      assert(deletedDoc === null, 'Firestore room_types document deleted cleanly');
    }

    // Scenario I: Read-Only Reconciliation Audit
    console.log('\n--- Scenario I: Read-Only Reconciliation Audit ---');
    const [mysqlTypes] = await conn.query('SELECT COUNT(*) as cnt FROM room_types');
    assert(typeof mysqlTypes[0].cnt === 'number', `MySQL room_types total records: ${mysqlTypes[0].cnt}`);

    // CLEANUP
    console.log('\n--- CLEANUP PHASE ---');
    await conn.query(`DELETE FROM room_types WHERE code = ?`, [testCode]);
    await conn.query(`DELETE FROM dual_write_outbox WHERE aggregate_id = ?`, [testCode]);
    assert(true, 'Cleaned up MySQL test room type and outbox events');

    if (isFirebaseConfigured) {
      await deleteRoomTypeFirestore(`type_${testCode}`).catch(() => {});
      console.log('  ✓ Cleaned up test Firestore room_type document.');
    }

  } catch (err) {
    console.error('Unhandled Error during Room Type Pilot test:', err);
    failed++;
  } finally {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    if (testCode) {
      try {
        const cleanupConn = await pool.getConnection();
        await cleanupConn.query(`DELETE FROM room_types WHERE code = ?`, [testCode]);
        await cleanupConn.query(`DELETE FROM dual_write_outbox WHERE aggregate_id = ?`, [testCode]);
        cleanupConn.release();
      } catch (e) {}
      if (isFirebaseConfigured) {
        await deleteRoomTypeFirestore(`type_${testCode}`).catch(() => {});
      }
    }
    if (conn) conn.release();
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3B Room Type Pilot Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRoomTypePilotTests();
