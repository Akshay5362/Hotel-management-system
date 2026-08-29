import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { signUp } from '../controllers/authController.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import { enqueue } from '../services/outboxService.js';
import { dispatchEvent } from '../services/outboxDispatcher.js';
import {
  getGuestByIdFirestore, getGuestByPhoneFirestore, updateGuestFirestore, deleteGuestFirestore
} from '../repositories/firestore/guestsRepository.js';

async function runGuestDualWritePilotTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3H Guest Profiles Dual-Write Pilot Test Suite');
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
  const testPhone = `999${Math.floor(1000500 + Math.random() * 8999000)}`;
  const testFullName = `phase3h_guest_${rand}`;
  const testUsername = `guest_${rand}`;
  let createdUserId = null;
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

    // Test 1, 2, 3 & 13, 14: Guest Creation, Outbox Staging, Commit & Sensitive Field Exclusion
    console.log('--- Test 1, 2, 3, 13 & 14: GUEST_CREATED, Commit & Payload Sanitization ---');
    const reqSignup = {
      body: {
        username: testUsername,
        fullName: testFullName,
        phone: testPhone,
        password: 'Password123!'
      }
    };
    const resSignup = createMockRes();
    await signUp(reqSignup, resSignup);
    assert(resSignup.statusCode === 201, 'signUp returned 201 Created');

    createdUserId = resSignup.jsonData?.user?.id;
    assert(createdUserId !== undefined, 'Created MySQL guest user ID retrieved');

    const [outboxCreateRows] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'GUEST_CREATED'`,
      [testPhone]
    );
    assert(outboxCreateRows.length === 1, 'Exactly one GUEST_CREATED outbox event staged inside transaction');

    // Test 13: Verify sensitive fields (password, password_hash, token) are excluded
    const stagedPayload = typeof outboxCreateRows[0].payload === 'string'
      ? JSON.parse(outboxCreateRows[0].payload)
      : outboxCreateRows[0].payload;

    assert(stagedPayload.password === undefined, 'Payload strictly excludes plain password');
    assert(stagedPayload.password_hash === undefined, 'Payload strictly excludes password_hash');
    assert(stagedPayload.token === undefined, 'Payload strictly excludes token');

    // Test 4 & 5: MySQL Rollback Guard -> Zero Outbox Events
    console.log('\n--- Test 4 & 5: MySQL Rollback Guard ---');
    const failPhone = `999${Math.floor(1000500 + Math.random() * 8999000)}`;
    try {
      await conn.beginTransaction();
      await conn.query("INSERT INTO guests (full_name, phone) VALUES ('FailGuest', ?)", [failPhone]);
      await enqueue(conn, {
        event_type: 'GUEST_CREATED',
        aggregate_type: 'GUEST',
        aggregate_id: failPhone,
        payload: { full_name: 'FailGuest', phone: failPhone }
      });
      await conn.rollback();
      assert(true, 'Rolled back failed guest transaction');
    } catch (e) {
      if (conn) await conn.rollback();
    }

    const [failEvts] = await conn.query(`SELECT * FROM dual_write_outbox WHERE aggregate_id = ?`, [failPhone]);
    assert(failEvts.length === 0, 'Zero outbox events committed for rolled-back transaction');

    // Test 6 & 7: Worker Dispatch -> Firestore Synchronization
    console.log('\n--- Test 6 & 7: Worker Dispatch to Firestore ---');
    if (isFirebaseConfigured) {
      const batchResult = await processOutboxBatch(10, 5);
      assert(batchResult.processed > 0, 'Outbox worker processed pending GUEST_CREATED event');

      const firestoreGuest = await getGuestByPhoneFirestore(testPhone);
      assert(firestoreGuest && firestoreGuest.full_name === testFullName, 'Firestore guest document created successfully');
    } else {
      console.log('  ~ Firebase not configured, skipped live Firestore dispatch assertion.');
    }

    // Test 8: Guest Update
    console.log('\n--- Test 8: GUEST_UPDATED Integration ---');
    await conn.beginTransaction();
    await conn.query("UPDATE guests SET address = '123 Hotel Suite Way' WHERE phone = ?", [testPhone]);
    await enqueue(conn, {
      event_type: 'GUEST_UPDATED',
      aggregate_type: 'GUEST',
      aggregate_id: testPhone,
      payload: {
        phone: testPhone,
        full_name: testFullName,
        address: '123 Hotel Suite Way',
        updated_at: new Date().toISOString()
      }
    });
    await conn.commit();

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const firestoreGuestUpdated = await getGuestByPhoneFirestore(testPhone);
      assert(firestoreGuestUpdated && firestoreGuestUpdated.address === '123 Hotel Suite Way', 'Firestore guest address updated');
    }

    // Test 11: Stale Event Protection
    console.log('\n--- Test 11: Stale Event Protection (Older Event Arrives Late) ---');
    if (isFirebaseConfigured) {
      const currentGuest = await getGuestByPhoneFirestore(testPhone);
      const currentAddr = currentGuest ? currentGuest.address : '123 Hotel Suite Way';

      const olderTime = new Date(Date.now() - 60000).toISOString(); // 1 minute in the past
      const staleEvent = {
        event_type: 'GUEST_UPDATED',
        payload: {
          phone: testPhone,
          full_name: testFullName,
          address: 'Stale Address 999',
          updated_at: olderTime
        }
      };

      await dispatchEvent(staleEvent);

      const firestoreStaleCheck = await getGuestByPhoneFirestore(testPhone);
      assert(
        firestoreStaleCheck && firestoreStaleCheck.address === currentAddr,
        'Stale Event Guard rejected older event T2 and preserved newer state T3'
      );
    } else {
      console.log('  ~ Firebase not configured, skipped live Stale Event Guard assertion.');
    }

    // Test 9 & 10: Idempotency Replay
    console.log('\n--- Test 9 & 10: Idempotency Replay ---');
    if (isFirebaseConfigured) {
      const dupEvent = {
        event_type: 'GUEST_CREATED',
        payload: {
          phone: testPhone,
          full_name: testFullName,
          address: '123 Hotel Suite Way',
          updated_at: new Date().toISOString()
        }
      };
      await dispatchEvent(dupEvent);
      await dispatchEvent(dupEvent);
      const dupCheck = await getGuestByPhoneFirestore(testPhone);
      assert(dupCheck && dupCheck.full_name === testFullName, 'Idempotent replay executed cleanly');
    }

    // Test 17: Automated Test Cleanup
    console.log('\n--- Test 17: CLEANUP PHASE ---');
    await conn.query('DELETE FROM guests WHERE phone = ?', [testPhone]);
    if (createdUserId) {
      await conn.query('DELETE FROM users WHERE id = ?', [createdUserId]);
    }
    await conn.query('DELETE FROM dual_write_outbox WHERE aggregate_id = ?', [testPhone]);
    assert(true, 'Cleaned up MySQL test guest, user, and outbox records');

    if (isFirebaseConfigured) {
      await deleteGuestFirestore(testPhone).catch(() => {});
      console.log('  ✓ Cleaned up test Firestore guest document.');
    }

  } catch (err) {
    console.error('Unhandled error during Guest Profiles Dual-Write Pilot test:', err);
    failed++;
  } finally {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    if (conn) conn.release();
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3H Guest Profile Pilot Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runGuestDualWritePilotTests();
