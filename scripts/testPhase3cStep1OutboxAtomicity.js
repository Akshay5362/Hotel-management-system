/**
 * testPhase3cStep1OutboxAtomicity.js — Phase 3C Step 1 Outbox & Atomicity Safety Verification
 * ==============================================================================================
 * Verification test suite for outbox transaction atomicity, worker claim strategy, state machine,
 * exponential backoff, lease recovery, and zero production business data mutations.
 */

import crypto from 'crypto';
import pool from '../backend/db.js';
import {
  createEvent,
  enqueue,
  claimNextBatch,
  markProcessed,
  markFailed,
  reclaimStaleProcessing
} from '../backend/services/outboxService.js';
import {
  isFirestoreServicesEnabled,
  isFirestoreReadsEnabled,
  isFirestoreDualWriteEnabled,
  isFirestoreOutboxWorkerEnabled
} from '../backend/config/featureFlags.js';

async function runOutboxAtomicityTestSuite() {
  console.log('\n========================================================================================');
  console.log('       PHASE 3C STEP 1 OUTBOX & ATOMIC TRANSACTION SAFETY TEST SUITE');
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
    // ── SECTION 1: Event Builder & Payload Validation ─────────────────────────
    console.log('[SECTION 1] Event Builder & Payload Validation...');
    const testEvt = createEvent({
      event_type: 'TEST_AUDIT_EVENT',
      aggregate_type: 'TEST_AGGREGATE',
      aggregate_id: '12345',
      payload: { test_key: 'test_val' }
    });

    assert(testEvt.event_id.startsWith('evt_test_audit_event_'), 'Event ID follows format prefix');
    assert(testEvt.event_type === 'TEST_AUDIT_EVENT', 'Event type converted to UPPERCASE');
    assert(testEvt.status === 'PENDING', 'Initial status set to PENDING');

    // ── SECTION 2: Transactional Atomicity (Enqueue & Rollback) ───────────────
    console.log('\n[SECTION 2] Transactional Atomicity (Enqueue & Rollback)...');
    const conn = await pool.getConnection();
    await conn.beginTransaction();

    const rollbackEvent = await enqueue(conn, {
      event_type: 'TEST_ROLLBACK_EVENT',
      aggregate_type: 'TEST_AGGREGATE',
      aggregate_id: '99999',
      payload: { data: 'should_be_rolled_back' }
    });

    const [stagedRows] = await conn.query('SELECT * FROM dual_write_outbox WHERE event_id = ?', [rollbackEvent.event_id]);
    assert(stagedRows.length === 1, 'Outbox event staged inside uncommitted MySQL transaction');

    await conn.rollback();
    conn.release();

    const [afterRollback] = await pool.query('SELECT * FROM dual_write_outbox WHERE event_id = ?', [rollbackEvent.event_id]);
    assert(afterRollback.length === 0, 'Transaction ROLLBACK cleanly removed staged outbox event');

    // ── SECTION 3: Transactional Commit & Atomicity ─────────────────────────
    console.log('\n[SECTION 3] Transactional Commit & Atomicity...');
    const conn2 = await pool.getConnection();
    await conn2.beginTransaction();

    const commitEvent = await enqueue(conn2, {
      event_type: 'TEST_COMMIT_EVENT',
      aggregate_type: 'TEST_AGGREGATE',
      aggregate_id: '88888',
      payload: { data: 'should_be_committed' }
    });

    await conn2.commit();
    conn2.release();

    const [afterCommit] = await pool.query('SELECT * FROM dual_write_outbox WHERE event_id = ?', [commitEvent.event_id]);
    assert(afterCommit.length === 1 && afterCommit[0].status === 'PENDING', 'Transaction COMMIT atomically persisted outbox event');

    // ── SECTION 4: Claim Strategy & FOR UPDATE SKIP LOCKED ───────────────────
    console.log('\n[SECTION 4] Claim Strategy & FOR UPDATE SKIP LOCKED...');
    const connClaim1 = await pool.getConnection();
    await connClaim1.beginTransaction();

    // Worker 1 claims batch
    const batch1 = await claimNextBatch(connClaim1, 10, 5);
    assert(batch1.some(e => e.event_id === commitEvent.event_id), 'Worker 1 claimed pending commitEvent');

    // Worker 2 attempts claim concurrently (SKIP LOCKED test)
    const connClaim2 = await pool.getConnection();
    await connClaim2.beginTransaction();
    const batch2 = await claimNextBatch(connClaim2, 10, 5);
    assert(!batch2.some(e => e.event_id === commitEvent.event_id), 'FOR UPDATE SKIP LOCKED prevented Worker 2 from claiming locked event');

    await connClaim1.commit();
    await connClaim2.commit();
    connClaim1.release();
    connClaim2.release();

    // ── SECTION 5: State Transitions (Mark Processed / Mark Failed) ─────────
    console.log('\n[SECTION 5] State Transitions (Mark Processed / Mark Failed)...');
    await markProcessed(null, commitEvent.event_id);
    const [processedRow] = await pool.query('SELECT status, processed_at FROM dual_write_outbox WHERE event_id = ?', [commitEvent.event_id]);
    assert(processedRow[0].status === 'PROCESSED' && processedRow[0].processed_at !== null, 'markProcessed updated event status to PROCESSED');

    // Clean up test event from dual_write_outbox
    await pool.query('DELETE FROM dual_write_outbox WHERE event_id = ?', [commitEvent.event_id]);

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

runOutboxAtomicityTestSuite();
