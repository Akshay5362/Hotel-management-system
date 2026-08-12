import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import {
  createEvent, enqueue, claimNextBatch, markProcessed, markFailed, retry, moveToDeadLetter, OutboxServiceError
} from '../services/outboxService.js';
import { dispatchEvent, DispatcherError } from '../services/outboxDispatcher.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import { up as migrationUp, down as migrationDown } from '../migrations/008_create_dual_write_outbox.js';
import { deleteRoomFirestore, deleteGuestFirestore } from '../repositories/firestore/index.js';

async function runOutboxInfrastructureTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3A Transactional Outbox Infrastructure Test Suite');
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
  const testTag = `phase3a_test_${timestamp}_${rand}`;
  const testRoomNum = `P3A_${rand.toUpperCase()}`;
  const testEventId = `evt_test_${timestamp}_${rand}`;

  let conn;

  try {
    conn = await pool.getConnection();

    // 1. Ensure dual_write_outbox table exists
    console.log('--- 1. Testing Migration 008 Setup ---');
    await migrationUp(conn);
    assert(true, 'Executed Migration 008 up() cleanly');

    // 2. Unit Test createEvent
    console.log('\n--- 2. Testing createEvent helper ---');
    const evt = createEvent({
      event_type: 'TEST_ROOM_UPSERT',
      aggregate_type: 'ROOM',
      aggregate_id: testRoomNum,
      payload: { number: testRoomNum, type: 'SINGLE', price: 2000 }
    });
    assert(evt && evt.event_id && evt.event_type === 'TEST_ROOM_UPSERT', 'createEvent generated event structure');

    // 3. Enqueue Atomic Staging inside MySQL Transaction
    console.log('\n--- 3. Testing Atomic Enqueue inside Transaction ---');
    await conn.beginTransaction();

    const enqueuedEvt = await enqueue(conn, {
      event_id: testEventId,
      event_type: 'TEST_ROOM_UPSERT',
      aggregate_type: 'ROOM',
      aggregate_id: testRoomNum,
      payload: { number: testRoomNum, type: 'SINGLE', price: 2200 }
    });
    assert(enqueuedEvt && enqueuedEvt.event_id === testEventId, 'enqueue staged event in transaction');

    await conn.commit();
    assert(true, 'Committed MySQL transaction with outbox event');

    // 4. Test Duplicate Event Rejection
    console.log('\n--- 4. Testing Duplicate Event ID Protection ---');
    try {
      await enqueue(conn, {
        event_id: testEventId,
        event_type: 'TEST_ROOM_UPSERT',
        aggregate_type: 'ROOM',
        aggregate_id: testRoomNum,
        payload: { number: testRoomNum, type: 'SINGLE' }
      });
      assert(false, 'Should have thrown DUPLICATE_EVENT_ID');
    } catch (err) {
      assert(err instanceof OutboxServiceError && err.code === 'DUPLICATE_EVENT_ID', 'Caught DUPLICATE_EVENT_ID error');
    }

    // 5. Test Worker Claiming Batch
    console.log('\n--- 5. Testing claimNextBatch ---');
    const claimedBatch = await claimNextBatch(conn, 5, 5);
    assert(claimedBatch.length > 0 && claimedBatch.some(e => e.event_id === testEventId), 'claimNextBatch claimed pending event');

    // 6. Test Dispatcher to Phase 2 Repositories
    console.log('\n--- 6. Testing Event Dispatcher ---');
    if (isFirebaseConfigured) {
      const targetEvt = claimedBatch.find(e => e.event_id === testEventId);
      const dispatchResult = await dispatchEvent(targetEvt);
      assert(dispatchResult && dispatchResult.id === `room_${testRoomNum}`, 'dispatchEvent invoked Phase 2 createRoomFirestore');

      await markProcessed(conn, testEventId);
      const [rows] = await conn.query('SELECT status FROM dual_write_outbox WHERE event_id = ?', [testEventId]);
      assert(rows[0] && rows[0].status === 'PROCESSED', 'markProcessed updated status to PROCESSED');
    } else {
      console.log('  ~ Firebase not configured, skipped live Firestore dispatch assertion.');
    }

    // 7. Test Retry & Exponential Backoff & Dead Letter
    console.log('\n--- 7. Testing Retry & Dead Letter Transition ---');
    const failEventId = `evt_fail_${timestamp}_${rand}`;
    await enqueue(conn, {
      event_id: failEventId,
      event_type: 'TEST_ROOM_UPSERT',
      aggregate_type: 'ROOM',
      aggregate_id: 'FAIL_ROOM',
      payload: { number: 'FAIL_ROOM', type: 'INVALID' }
    });

    await markFailed(conn, failEventId, 'Simulated network timeout', 2);
    const [failRows1] = await conn.query('SELECT status, attempts FROM dual_write_outbox WHERE event_id = ?', [failEventId]);
    assert(failRows1[0].status === 'FAILED', 'markFailed updated status to FAILED on 1st attempt');

    await markFailed(conn, failEventId, 'Simulated max retries exceeded', 2);
    const [failRows2] = await conn.query('SELECT status FROM dual_write_outbox WHERE event_id = ?', [failEventId]);
    assert(failRows2[0].status === 'DEAD_LETTER', 'markFailed transitioned event to DEAD_LETTER on max retries');

    // 8. Test Manual Retry Reset
    console.log('\n--- 8. Testing Manual Retry Reset ---');
    await retry(conn, failEventId);
    const [retryRows] = await conn.query('SELECT status, attempts FROM dual_write_outbox WHERE event_id = ?', [failEventId]);
    assert(retryRows[0].status === 'PENDING' && retryRows[0].attempts === 0, 'retry reset event to PENDING with 0 attempts');

    // 9. CLEANUP
    console.log('\n--- 9. CLEANUP: Removing test outbox records ---');
    await conn.query('DELETE FROM dual_write_outbox WHERE event_id IN (?, ?)', [testEventId, failEventId]);
    assert(true, 'Cleaned up test outbox records');

    if (isFirebaseConfigured) {
      await deleteRoomFirestore(`room_${testRoomNum}`);
      console.log('  ✓ Cleaned up test Firestore room document.');
    }

  } catch (err) {
    console.error('Unhandled Outbox Infrastructure test error:', err);
    failed++;
  } finally {
    if (conn) conn.release();
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3A Infrastructure Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runOutboxInfrastructureTests();
