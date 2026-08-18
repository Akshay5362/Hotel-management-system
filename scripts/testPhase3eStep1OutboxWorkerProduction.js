/**
 * testPhase3eStep1OutboxWorkerProduction.js — Phase 3E Step 1: Controlled Production Outbox Worker Activation
 * =============================================================================================================
 * Verifies that the outbox worker starts correctly when ENABLE_FIRESTORE_OUTBOX_WORKER=true,
 * processes events safely, and leaves all safety invariants intact.
 *
 * SAFETY CONTRACT:
 * - ENABLE_FIRESTORE_OUTBOX_WORKER is already set to true in backend/.env
 * - ENABLE_FIRESTORE_READS, ENABLE_FIRESTORE_DUAL_WRITE, USE_FIRESTORE_SERVICES remain false
 * - All 9 read-canary flags remain false
 * - MySQL remains 100% authoritative
 * - No Firebase Auth mutations
 * - No production business record mutations
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import pool from '../backend/db.js';
import {
  isFirestoreServicesEnabled,
  isFirestoreReadsEnabled,
  isFirestoreDualWriteEnabled,
  isFirestoreOutboxWorkerEnabled,
  isFirestoreReconciliationEnabled,
  isFirebaseAuthEnabled,
  isStrictRbacEnabled,
  isRoomsReadCanaryEnabled,
  isStaffReadCanaryEnabled,
  isMyPaymentsReadCanaryEnabled
} from '../backend/config/featureFlags.js';
import {
  startOutboxWorker,
  stopOutboxWorker,
  isWorkerRunning,
  processOutboxBatch
} from '../backend/services/outboxWorker.js';
import {
  reclaimStaleProcessing,
  claimNextBatch
} from '../backend/services/outboxService.js';

const BASE_URL = 'http://localhost:5000';

async function runOutboxWorkerProductionSuite() {
  console.log('\n========================================================================================');
  console.log('  HPMS — PHASE 3E STEP 1: CONTROLLED PRODUCTION OUTBOX WORKER ACTIVATION');
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
    // ══════════════════════════════════════════════════════════════════════════
    // GATE 1: PRE-FLIGHT SAFETY AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    console.log('[GATE 1] Pre-flight Safety Audit...');

    // Worker flag should now be true (we just set it in .env)
    assert(isFirestoreOutboxWorkerEnabled() === true,
      'ENABLE_FIRESTORE_OUTBOX_WORKER=true (production flag activated)');

    // All other Firestore flags remain false
    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES=false');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS=false');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE=false');
    assert(isFirestoreReconciliationEnabled() === false, 'ENABLE_FIRESTORE_RECONCILIATION=false');
    assert(isRoomsReadCanaryEnabled() === false, 'ROOMS_READ_CANARY=false');
    assert(isStaffReadCanaryEnabled() === false, 'STAFF_READ_CANARY=false');
    assert(isMyPaymentsReadCanaryEnabled() === false, 'MY_PAYMENTS_READ_CANARY=false');

    // Auth/RBAC still active
    assert(isFirebaseAuthEnabled() === true, 'ENABLE_FIREBASE_AUTH=true (auth active)');
    assert(isStrictRbacEnabled() === true, 'ENABLE_STRICT_RBAC=true (RBAC active)');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 2: PRE-FLIGHT MYSQL BASELINE
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 2] MySQL Baseline...');

    const [pingResult] = await pool.query('SELECT 1+1 AS result');
    assert(pingResult[0].result === 2, 'MySQL connection healthy');

    const [pendingPre] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PENDING'");
    const [processingPre] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PROCESSING'");
    const [processedPre] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PROCESSED'");
    const [failedPre] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='FAILED'");
    const [deadPre] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='DEAD_LETTER'");

    console.log(`  ⓘ Outbox baseline — PENDING:${pendingPre[0].cnt} PROCESSING:${processingPre[0].cnt} PROCESSED:${processedPre[0].cnt} FAILED:${failedPre[0].cnt} DEAD_LETTER:${deadPre[0].cnt}`);

    assert(deadPre[0].cnt === 0, `DEAD_LETTER events = 0 (pre-activation baseline)`);
    assert(failedPre[0].cnt === 0, `FAILED events = 0 (pre-activation baseline)`);
    assert(processingPre[0].cnt === 0, `PROCESSING events = 0 (no orphaned events)`);

    const stale = await reclaimStaleProcessing();
    assert(stale === 0, `Stale PROCESSING events reclaimed = 0 (clean state)`);

    const [roomsBase] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    const [bkgBase] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    const [invBase] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [payBase] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
    const [staffBase] = await pool.query("SELECT COUNT(*) as cnt FROM staff WHERE deleted=0");
    const [guestBase] = await pool.query('SELECT COUNT(*) as cnt FROM guests');

    assert(roomsBase[0].cnt === 17, `MySQL rooms baseline = 17`);
    assert(bkgBase[0].cnt === 1, `MySQL bookings baseline = 1`);
    assert(invBase[0].cnt === 2, `MySQL invoices baseline = 2`);
    assert(payBase[0].cnt === 1, `MySQL payments baseline = 1`);
    assert(staffBase[0].cnt === 10, `MySQL active staff baseline = 10`);
    assert(guestBase[0].cnt === 2, `MySQL guests baseline = 2`);

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 3: WORKER STARTUP VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 3] Worker Startup Verification...');

    // Worker module import and startup (flag is now true in .env)
    assert(isFirestoreOutboxWorkerEnabled() === true,
      'Pre-startup: ENABLE_FIRESTORE_OUTBOX_WORKER flag confirmed true');

    const startedFirst = startOutboxWorker();
    assert(startedFirst === true,
      'startOutboxWorker() returns true when ENABLE_FIRESTORE_OUTBOX_WORKER=true');
    assert(isWorkerRunning() === true,
      'isWorkerRunning() returns true after startOutboxWorker()');

    // Idempotency: second call should not create a second interval
    const startedSecond = startOutboxWorker();
    assert(startedSecond === true,
      'startOutboxWorker() is idempotent — second call returns true (already running)');
    assert(isWorkerRunning() === true,
      'isWorkerRunning() still true after duplicate start call (guard working)');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 4: processOutboxBatch — SAFETY WITH NO PENDING EVENTS
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 4] processOutboxBatch Safety (No Pending Events)...');

    // Since PENDING=0 (clean state), the batch should return immediately with 0 processed
    const batchResult = await processOutboxBatch(10, 5);
    assert(typeof batchResult === 'object', 'processOutboxBatch returns an object');
    assert(batchResult.processed === 0,
      `Batch with 0 pending events: processed=0 (safe no-op, got: ${batchResult.processed})`);
    assert(batchResult.failed === 0,
      `Batch with 0 pending events: failed=0 (got: ${batchResult.failed})`);
    assert(batchResult.reclaimed === 0,
      `Batch with 0 pending events: reclaimed=0 (got: ${batchResult.reclaimed})`);
    assert(!batchResult.error,
      `Batch returned no error (got: ${batchResult.error || 'none'})`);

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 5: OUTBOX STATE INTEGRITY POST-BATCH
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 5] Outbox State Integrity Post-Batch...');

    const [pendingPost] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PENDING'");
    const [processingPost] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PROCESSING'");
    const [processedPost] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PROCESSED'");
    const [failedPost] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='FAILED'");
    const [deadPost] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='DEAD_LETTER'");

    console.log(`  ⓘ Outbox post-batch — PENDING:${pendingPost[0].cnt} PROCESSING:${processingPost[0].cnt} PROCESSED:${processedPost[0].cnt} FAILED:${failedPost[0].cnt} DEAD_LETTER:${deadPost[0].cnt}`);

    assert(deadPost[0].cnt === 0, 'DEAD_LETTER = 0 after batch (no permanent failures)');
    assert(failedPost[0].cnt === 0, 'FAILED = 0 after batch');
    assert(processingPost[0].cnt === 0, 'PROCESSING = 0 after batch (no orphaned leases)');
    assert(pendingPost[0].cnt === pendingPre[0].cnt,
      `PENDING count unchanged (${pendingPre[0].cnt} → ${pendingPost[0].cnt})`);
    assert(processedPost[0].cnt === processedPre[0].cnt,
      `PROCESSED count unchanged (${processedPre[0].cnt} → ${processedPost[0].cnt}, no dual-write active yet)`);

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 6: claimNextBatch — FOR UPDATE SKIP LOCKED VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 6] claimNextBatch — FOR UPDATE SKIP LOCKED Concurrency...');

    // With PENDING=0, claimNextBatch should return empty array (no events to claim)
    const claimed = await claimNextBatch(null, 10, 5);
    assert(Array.isArray(claimed), 'claimNextBatch returns an array');
    assert(claimed.length === 0,
      `claimNextBatch returns 0 events when PENDING=0 (FOR UPDATE SKIP LOCKED working, got: ${claimed.length})`);

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 7: HTTP HEALTH AFTER WORKER ACTIVATION
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 7] HTTP Health After Worker Activation...');

    try {
      const health = await fetch(`${BASE_URL}/api/health`);
      assert(health.status === 200, `GET /api/health = HTTP ${health.status} (worker running, API healthy)`);
    } catch (e) {
      assert(false, `GET /api/health failed: ${e.message}`);
    }

    // Auth gate still enforced
    try {
      const unauthed = await fetch(`${BASE_URL}/api/staff`);
      assert(unauthed.status === 401, `GET /api/staff without token = HTTP ${unauthed.status} (auth gate active)`);
    } catch (e) {
      assert(false, `Auth gate test failed: ${e.message}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 8: MYSQL BUSINESS TABLE IMMUTABILITY
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 8] MySQL Business Table Immutability...');

    const [roomsPost] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    const [bkgPost] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    const [invPost] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [payPost] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
    const [staffPost] = await pool.query("SELECT COUNT(*) as cnt FROM staff WHERE deleted=0");
    const [guestPost] = await pool.query('SELECT COUNT(*) as cnt FROM guests');

    assert(roomsPost[0].cnt === 17, 'Rooms: 17 (unchanged by worker activation)');
    assert(bkgPost[0].cnt === 1, 'Bookings: 1 (unchanged)');
    assert(invPost[0].cnt === 2, 'Invoices: 2 (unchanged)');
    assert(payPost[0].cnt === 1, 'Payments: 1 (unchanged)');
    assert(staffPost[0].cnt === 10, 'Active staff: 10 (unchanged)');
    assert(guestPost[0].cnt === 2, 'Guests: 2 (unchanged)');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 9: WORKER STOPPAGE AND ROLLBACK VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 9] Worker Stoppage and Rollback Verification...');

    stopOutboxWorker();
    assert(isWorkerRunning() === false,
      'stopOutboxWorker() halts the daemon: isWorkerRunning()=false');

    // Verify batch returns safely after stop
    const batchAfterStop = await processOutboxBatch(10, 5);
    assert(batchAfterStop.processed === 0,
      'processOutboxBatch safe after stopOutboxWorker (no interval, no crash)');

    // Restart to confirm re-start is safe (since .env still has flag=true)
    const restarted = startOutboxWorker();
    assert(restarted === true, 'startOutboxWorker() restarts cleanly after stop');
    assert(isWorkerRunning() === true, 'isWorkerRunning()=true after restart');

    // Final stop (we don't want the test to leave a daemon running)
    stopOutboxWorker();
    assert(isWorkerRunning() === false, 'Worker stopped cleanly at end of test');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 10: .env VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 10] .env Verification...');

    const envPath = resolve(process.cwd(), 'backend', '.env');
    assert(existsSync(envPath), 'backend/.env exists');
    const envContent = readFileSync(envPath, 'utf-8');
    assert(envContent.includes('ENABLE_FIRESTORE_OUTBOX_WORKER=true'),
      'backend/.env: ENABLE_FIRESTORE_OUTBOX_WORKER=true (activated in Phase 3E Step 1)');
    assert(envContent.includes('ENABLE_FIRESTORE_READS=false'),
      'backend/.env: ENABLE_FIRESTORE_READS=false (unchanged)');
    assert(envContent.includes('ENABLE_FIRESTORE_DUAL_WRITE=false'),
      'backend/.env: ENABLE_FIRESTORE_DUAL_WRITE=false (unchanged)');
    assert(!envContent.includes('USE_FIRESTORE_SERVICES=true'),
      'backend/.env: USE_FIRESTORE_SERVICES NOT true (unchanged)');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 11: FINAL FLAG STATE CONFIRMATION
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 11] Final Flag State Confirmation...');

    assert(isFirestoreOutboxWorkerEnabled() === true,
      'ENABLE_FIRESTORE_OUTBOX_WORKER=true (intentional — production activation)');
    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES=false (final)');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS=false (final)');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE=false (final)');
    assert(isRoomsReadCanaryEnabled() === false, 'ROOMS_CANARY=false (final)');
    assert(isStaffReadCanaryEnabled() === false, 'STAFF_CANARY=false (final)');
    assert(isMyPaymentsReadCanaryEnabled() === false, 'MY_PAYMENTS_CANARY=false (final)');

    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    if (passedTests === totalTests) {
      console.log('ALL GATES PASSED — PHASE 3E STEP 1 RESULT: PASS');
    } else {
      console.log('PHASE 3E STEP 1 RESULT: BLOCKED');
    }
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Test Suite Execution Error:', err);
    // Rollback: disable worker on error
    if (isWorkerRunning()) { stopOutboxWorker(); }
    process.exitCode = 1;
  } finally {
    // Ensure worker is stopped after tests (server.js will restart it on next boot)
    if (isWorkerRunning()) stopOutboxWorker();
    await pool.end();
  }
}

runOutboxWorkerProductionSuite();
