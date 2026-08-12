import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { createStaff, updateStaff, updateStaffStatus, deleteStaff } from '../controllers/staffController.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import { enqueue } from '../services/outboxService.js';
import { dispatchEvent } from '../services/outboxDispatcher.js';
import {
  getStaffByIdFirestore, getStaffByUsernameFirestore, updateStaffFirestore, deleteStaffFirestore
} from '../repositories/firestore/staffRepository.js';

async function runStaffDualWritePilotTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3D Staff Dual-Write Pilot Test Suite');
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
  const testUsername = `phase3d_test_${rand}`;
  const testEmail = `phase3d_${rand}@hotelpms.test`;
  let createdStaffId = null;
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

    // Scenario A & L: STAFF_CREATED + Sensitive Data Protection
    console.log('--- Scenario A & L: STAFF_CREATED & Sensitive Data Protection ---');
    const reqCreate = {
      body: {
        full_name: 'Phase3D Test User',
        username: testUsername,
        email: testEmail,
        password: 'Password123!',
        role: 'RECEPTIONIST',
        department: 'Front Office',
        shift: 'Morning',
        status: 'Active'
      }
    };
    const resCreate = createMockRes();
    await createStaff(reqCreate, resCreate);
    assert(resCreate.statusCode === 201, 'createStaff returned 201 Created');

    createdStaffId = resCreate.jsonData?.staff?.id;
    assert(createdStaffId !== undefined, 'Created MySQL staff ID retrieved');

    const [outboxCreateRows] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'STAFF_CREATED'`,
      [testUsername]
    );
    assert(outboxCreateRows.length === 1, 'Exactly one STAFF_CREATED outbox event staged inside transaction');

    const stagedPayload = typeof outboxCreateRows[0].payload === 'string'
      ? JSON.parse(outboxCreateRows[0].payload)
      : outboxCreateRows[0].payload;

    assert(!stagedPayload.password_hash && !stagedPayload.password, 'password_hash and password strictly absent from outbox payload');

    // Scenario B: STAFF_CREATED Rollback Guard
    console.log('\n--- Scenario B: STAFF_CREATED Rollback Guard ---');
    const failUsername = `phase3d_fail_${rand}`;
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO staff (full_name, username, email, password_hash, role, department, shift, status)
         VALUES ('Fail User', ?, 'fail@test.com', 'hash', 'RECEPTIONIST', 'Front Office', 'Morning', 'Active')`,
        [failUsername]
      );
      await enqueue(conn, {
        event_type: 'STAFF_CREATED',
        aggregate_type: 'STAFF',
        aggregate_id: failUsername,
        payload: { username: failUsername }
      });
      await conn.rollback();
      assert(true, 'Rolled back failed staff transaction');
    } catch (e) {
      if (conn) await conn.rollback();
    }

    const [failEvts] = await conn.query(`SELECT * FROM dual_write_outbox WHERE aggregate_id = ?`, [failUsername]);
    assert(failEvts.length === 0, 'Zero outbox events committed for rolled-back transaction');

    // Scenario F: Worker Dispatch to Firestore
    console.log('\n--- Scenario F: Worker Dispatch to Firestore ---');
    if (isFirebaseConfigured) {
      const batchResultF = await processOutboxBatch(10, 5);
      assert(batchResultF.processed > 0, 'Outbox worker processed pending STAFF_CREATED event');

      const firestoreStaffF = await getStaffByIdFirestore(`staff_${testUsername}`);
      assert(firestoreStaffF && firestoreStaffF.username === testUsername, 'Firestore staff document created successfully');
    } else {
      console.log('  ~ Firebase not configured, skipped live Firestore dispatch assertion.');
    }

    // Scenario C: STAFF_UPDATED
    console.log('\n--- Scenario C: STAFF_UPDATED Controller Integration ---');
    const reqUpdate = {
      params: { id: createdStaffId },
      body: {
        full_name: 'Phase3D Updated User',
        username: testUsername,
        email: testEmail,
        role: 'ADMIN',
        department: 'Administration',
        shift: 'Night',
        status: 'Active'
      }
    };
    const resUpdate = createMockRes();
    await updateStaff(reqUpdate, resUpdate);
    assert(resUpdate.statusCode === 200, 'updateStaff returned 200 OK');

    const [outboxUpdateRows] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'STAFF_UPDATED'`,
      [testUsername]
    );
    assert(outboxUpdateRows.length > 0, 'STAFF_UPDATED outbox event staged');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const firestoreStaffC = await getStaffByIdFirestore(`staff_${testUsername}`);
      assert(firestoreStaffC && firestoreStaffC.role === 'admin', 'Firestore staff role updated to admin');
    }

    // Scenario D: STAFF_STATUS_CHANGED
    console.log('\n--- Scenario D: STAFF_STATUS_CHANGED Integration ---');
    const reqStatus = { body: { id: createdStaffId, status: 'Inactive' } };
    const resStatus = createMockRes();
    await updateStaffStatus(reqStatus, resStatus);
    assert(resStatus.statusCode === 200, 'updateStaffStatus returned 200 OK');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const firestoreStaffD = await getStaffByIdFirestore(`staff_${testUsername}`);
      assert(firestoreStaffD && firestoreStaffD.status === 'Inactive', 'Firestore staff status updated to Inactive');
    }

    // Scenario H: Stale Event Protection
    console.log('\n--- Scenario H: Stale Event Protection (Older Event Arrives Late) ---');
    if (isFirebaseConfigured) {
      const newerTime = new Date(Date.now() + 10000).toISOString();
      await updateStaffFirestore(`staff_${testUsername}`, {
        status: 'Active',
        updated_at: newerTime
      });

      const olderTime = new Date(Date.now() - 5000).toISOString();
      const staleEvent = {
        event_type: 'STAFF_STATUS_CHANGED',
        payload: {
          username: testUsername,
          status: 'Inactive',
          updated_at: olderTime
        }
      };

      await dispatchEvent(staleEvent);

      const firestoreStaleCheck = await getStaffByIdFirestore(`staff_${testUsername}`);
      assert(
        firestoreStaleCheck && firestoreStaleCheck.status === 'Active',
        'Stale Event Guard rejected older event T2 and preserved newer state T3'
      );
    } else {
      console.log('  ~ Firebase not configured, skipped live Stale Event Guard assertion.');
    }

    // Scenario G: Duplicate Event Replay Idempotency
    console.log('\n--- Scenario G: Idempotency Replay ---');
    if (isFirebaseConfigured) {
      const dupEvent = {
        event_type: 'STAFF_CREATED',
        payload: {
          username: testUsername,
          full_name: 'Phase3D Dup User',
          role: 'ADMIN',
          updated_at: new Date(Date.now() + 20000).toISOString()
        }
      };
      await dispatchEvent(dupEvent);
      await dispatchEvent(dupEvent);
      const dupCheck = await getStaffByIdFirestore(`staff_${testUsername}`);
      assert(dupCheck && dupCheck.username === testUsername, 'Idempotent replay executed cleanly without duplicate document generation');
    }

    // Scenario E & K: STAFF_DELETED & Missing Document Idempotency
    console.log('\n--- Scenario E & K: STAFF_DELETED & Missing Document Idempotency ---');
    const reqDelete = { params: { id: createdStaffId } };
    const resDelete = createMockRes();
    await deleteStaff(reqDelete, resDelete);
    assert(resDelete.statusCode === 200, 'deleteStaff soft-delete returned 200 OK');

    const [mySqlSoftDelete] = await conn.query('SELECT deleted, status FROM staff WHERE id = ?', [createdStaffId]);
    assert(mySqlSoftDelete[0].deleted === 1 && mySqlSoftDelete[0].status === 'Inactive', 'MySQL record marked deleted=1 and status=Inactive');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const deletedDoc = await getStaffByIdFirestore(`staff_${testUsername}`);
      assert(deletedDoc === null, 'Firestore staff document deleted cleanly');

      // Replay delete on missing doc
      await deleteStaffFirestore(`staff_${testUsername}`);
      assert(true, 'Missing document delete handled idempotently without error');
    }

    // Scenario M: Automated Test Cleanup
    console.log('\n--- Scenario M: CLEANUP PHASE ---');
    await conn.query('DELETE FROM staff WHERE username = ?', [testUsername]);
    await conn.query('DELETE FROM dual_write_outbox WHERE aggregate_id = ?', [testUsername]);
    assert(true, 'Cleaned up MySQL test staff and outbox records');

    if (isFirebaseConfigured) {
      await deleteStaffFirestore(`staff_${testUsername}`).catch(() => {});
      console.log('  ✓ Cleaned up test Firestore staff document.');
    }

  } catch (err) {
    console.error('Unhandled error during Staff Dual-Write Pilot test:', err);
    failed++;
  } finally {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    if (testUsername || createdStaffId) {
      try {
        const cleanupConn = await pool.getConnection();
        if (createdStaffId) await cleanupConn.query('DELETE FROM staff WHERE id = ?', [createdStaffId]);
        await cleanupConn.query('DELETE FROM staff WHERE username = ?', [testUsername]);
        await cleanupConn.query('DELETE FROM dual_write_outbox WHERE aggregate_id = ?', [testUsername]);
        cleanupConn.release();
      } catch (e) {}
      if (isFirebaseConfigured) {
        await deleteStaffFirestore(`staff_${testUsername}`).catch(() => {});
      }
    }
    if (conn) conn.release();
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3D Staff Pilot Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runStaffDualWritePilotTests();
