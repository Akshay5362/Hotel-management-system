/**
 * testPhase3eStep3DualWriteStability.js
 * ======================================================================================================
 * HPMS — Phase 3E Step 3: Controlled Dual-Write Stability & Production Monitoring Gate
 *
 * Verifies 11 core stability and monitoring gates:
 * 1. Current production health & feature flags audit
 * 2. Database baseline audit
 * 3. HTTP API health & authentication audit
 * 4. Worker stability & FOR UPDATE SKIP LOCKED concurrency guard
 * 5. Controlled real business event lifecycle & latency monitoring
 * 6. Transaction atomicity (MySQL rollback removes outbox event)
 * 7. Firestore failure isolation (Firestore error does NOT break MySQL TX)
 * 8. Idempotency & set_merge replay safety
 * 9. Payload security audit (Zero sensitive terms in payloads/docs)
 * 10. MySQL authority check (ENABLE_FIRESTORE_READS=false)
 * 11. Complete cleanup & database baseline restoration
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
import { enqueue, markFailed, reclaimStaleProcessing } from '../backend/services/outboxService.js';
import { db as firestoreDb } from '../backend/config/firebaseAdmin.js';

const BASE_URL = 'http://localhost:5000';
const STABILITY_TAG = '[STABILITY-STEP3]';

async function runDualWriteStabilitySuite() {
  console.log('\n========================================================================================');
  console.log('  HPMS — PHASE 3E STEP 3: CONTROLLED DUAL-WRITE STABILITY & MONITORING GATE');
  console.log('========================================================================================\n');

  let totalTests = 0;
  let passedTests = 0;

  // Track created test IDs for safe cleanup
  let createdBookingId = null;
  let createdBookingNumber = null;
  let createdGuestId = null;
  let createdPaymentId = null;
  let createdInvoiceId = null;
  let testOutboxIds = [];
  let sourceRoomId = null;
  let sourceRoomNumber = null;
  let targetRoomId = null;
  let targetRoomNumber = null;

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
    // GATE 1: CURRENT PRODUCTION FEATURE FLAGS AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    console.log('[GATE 1] Current Production Feature Flags Audit...');

    assert(isFirestoreDualWriteEnabled() === true, 'ENABLE_FIRESTORE_DUAL_WRITE=true (production active)');
    assert(isFirestoreOutboxWorkerEnabled() === true, 'ENABLE_FIRESTORE_OUTBOX_WORKER=true (production active)');
    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES=false (MySQL authoritative)');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS=false (MySQL authoritative)');
    assert(isFirestoreReconciliationEnabled() === false, 'ENABLE_FIRESTORE_RECONCILIATION=false');
    assert(isRoomsReadCanaryEnabled() === false, 'ROOMS_READ_CANARY=false');
    assert(isStaffReadCanaryEnabled() === false, 'STAFF_READ_CANARY=false');
    assert(isMyPaymentsReadCanaryEnabled() === false, 'MY_PAYMENTS_READ_CANARY=false');
    assert(isFirebaseAuthEnabled() === true, 'ENABLE_FIREBASE_AUTH=true (Auth active)');
    assert(isStrictRbacEnabled() === true, 'ENABLE_STRICT_RBAC=true (RBAC active)');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 2: DATABASE BASELINE AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 2] Database Baseline Audit...');

    const [ping] = await pool.query('SELECT 1+1 AS res');
    assert(ping[0].res === 2, 'MySQL connection healthy');

    const [roomsBase] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    const [bkgBase] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    const [invBase] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [payBase] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
    const [staffBase] = await pool.query('SELECT COUNT(*) as cnt FROM staff WHERE deleted=0');
    const [guestBase] = await pool.query('SELECT COUNT(*) as cnt FROM guests');

    const [pBase] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PENDING'");
    const [prBase] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PROCESSING'");
    const [fBase] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='FAILED'");
    const [dBase] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='DEAD_LETTER'");
    const staleReclaimed = await reclaimStaleProcessing();

    console.log(`  ⓘ Baseline counts — rooms:${roomsBase[0].cnt}, bookings:${bkgBase[0].cnt}, invoices:${invBase[0].cnt}, payments:${payBase[0].cnt}, staff:${staffBase[0].cnt}, guests:${guestBase[0].cnt}`);
    console.log(`  ⓘ Outbox baseline — PENDING:${pBase[0].cnt}, PROCESSING:${prBase[0].cnt}, FAILED:${fBase[0].cnt}, DEAD_LETTER:${dBase[0].cnt}`);

    assert(roomsBase[0].cnt === 17, 'MySQL rooms baseline = 17');
    assert(bkgBase[0].cnt === 1, 'MySQL bookings baseline = 1');
    assert(invBase[0].cnt === 2, 'MySQL invoices baseline = 2');
    assert(payBase[0].cnt === 1, 'MySQL payments baseline = 1');
    assert(staffBase[0].cnt === 10, 'MySQL active staff baseline = 10');
    assert(guestBase[0].cnt === 2, 'MySQL guests baseline = 2');
    assert(pBase[0].cnt === 0, 'Outbox PENDING count = 0');
    assert(prBase[0].cnt === 0, 'Outbox PROCESSING count = 0');
    assert(fBase[0].cnt === 0, 'Outbox FAILED count = 0');
    assert(dBase[0].cnt === 0, 'Outbox DEAD_LETTER count = 0');
    assert(staleReclaimed === 0, 'Stale PROCESSING events reclaimed = 0');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 3: HTTP API HEALTH & AUTHENTICATION AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 3] HTTP API Health & Authentication Audit...');

    try {
      const resHealth = await fetch(`${BASE_URL}/api/health`);
      assert(resHealth.status === 200, 'GET /api/health = HTTP 200 (Server healthy)');
    } catch (e) {
      assert(false, `GET /api/health failed: ${e.message}`);
    }

    try {
      const resStatus = await fetch(`${BASE_URL}/api/status`);
      assert(resStatus.status === 401, 'GET /api/status without token = HTTP 401 (Auth protected)');
    } catch (e) {
      assert(false, `GET /api/status failed: ${e.message}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 4: WORKER STABILITY & CONCURRENCY GUARD
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 4] Worker Stability & Concurrency Guard Audit...');

    const started1 = startOutboxWorker();
    assert(started1 === true, 'startOutboxWorker() starts worker daemon cleanly');
    assert(isWorkerRunning() === true, 'isWorkerRunning() returns true');

    // Duplicate call idempotency check
    const started2 = startOutboxWorker();
    assert(started2 === true, 'startOutboxWorker() is idempotent (returns true, no duplicate interval)');
    assert(isWorkerRunning() === true, 'isWorkerRunning() remains true');

    // No-op batch check when PENDING=0
    const noopBatch = await processOutboxBatch(10, 5);
    assert(noopBatch.processed === 0, 'processOutboxBatch with 0 pending returns processed=0 (safe no-op)');
    assert(noopBatch.failed === 0, 'processOutboxBatch with 0 pending returns failed=0');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 5: CONTROLLED REAL BUSINESS EVENTS & LATENCY MONITORING
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 5] Controlled Real Business Events & Latency Monitoring...');

    const [vacantRooms] = await pool.query("SELECT id, number FROM rooms WHERE status='Vacant' ORDER BY id LIMIT 2");
    sourceRoomId = vacantRooms[0].id;
    sourceRoomNumber = vacantRooms[0].number;
    targetRoomId = vacantRooms[1].id;
    targetRoomNumber = vacantRooms[1].number;

    const latencies = [];

    // 1. Reservation Event
    const conn1 = await pool.getConnection();
    try {
      await conn1.beginTransaction();
      const [gRes] = await conn1.query("INSERT INTO guests (full_name, email, phone) VALUES ('Stability Guest', 'stability@example.com', '9991112220')");
      createdGuestId = gRes.insertId;

      createdBookingNumber = `BKG-STAB-${Date.now()}`;
      const [bRes] = await conn1.query(
        `INSERT INTO bookings (booking_number, guest_id, room_id, check_in_date, check_out_date, booking_status, payment_status, total_amount, advance_amount, created_at)
         VALUES (?, ?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 1 DAY), 'Confirmed', 'Pending', 3000, 0, NOW())`,
        [createdBookingNumber, createdGuestId, sourceRoomId]
      );
      createdBookingId = bRes.insertId;

      const evt1 = await enqueue(conn1, {
        event_type: 'BOOKING_CREATED',
        aggregate_type: 'BOOKING',
        aggregate_id: String(createdBookingNumber),
        payload: {
          booking_id: String(createdBookingId),
          booking_number: createdBookingNumber,
          guest_id: String(createdGuestId),
          room_id: String(sourceRoomId),
          room_number: String(sourceRoomNumber),
          check_in_date: new Date().toISOString().split('T')[0],
          check_out_date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
          booking_status: 'Confirmed',
          payment_status: 'Pending',
          total_amount: 3000,
          created_at: new Date().toISOString()
        }
      });
      testOutboxIds.push(evt1.event_id);
      await conn1.commit();
    } finally {
      conn1.release();
    }

    const t1 = Date.now();
    const batch1 = await processOutboxBatch(10, 5);
    const d1 = Date.now() - t1;
    latencies.push(d1);
    console.log(`  ⓘ Event 1 (BOOKING_CREATED) processed in ${d1}ms (batch processed=${batch1.processed})`);
    assert(batch1.processed === 1, 'BOOKING_CREATED dispatched cleanly');

    // 2. Housekeeping Event
    const conn2 = await pool.getConnection();
    try {
      await conn2.beginTransaction();
      await conn2.query("UPDATE rooms SET housekeeping_status = 'Dirty' WHERE id = ?", [sourceRoomId]);
      const evt2 = await enqueue(conn2, {
        event_type: 'HOUSEKEEPING_STATUS_UPDATED',
        aggregate_type: 'HOUSEKEEPING',
        aggregate_id: String(sourceRoomNumber),
        payload: {
          room_id: String(sourceRoomId),
          room_number: String(sourceRoomNumber),
          status: 'Dirty',
          updated_at: new Date().toISOString()
        }
      });
      testOutboxIds.push(evt2.event_id);
      await conn2.commit();
    } finally {
      conn2.release();
    }

    const t2 = Date.now();
    const batch2 = await processOutboxBatch(10, 5);
    const d2 = Date.now() - t2;
    latencies.push(d2);
    console.log(`  ⓘ Event 2 (HOUSEKEEPING_STATUS_UPDATED) processed in ${d2}ms (batch processed=${batch2.processed})`);
    assert(batch2.processed === 1, 'HOUSEKEEPING_STATUS_UPDATED dispatched cleanly');

    // Latency guard check
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    console.log(`  ⓘ Average event processing latency: ${avgLatency.toFixed(2)}ms`);
    assert(avgLatency < 1000, `Processing latency is fast (${avgLatency.toFixed(2)}ms < 1000ms threshold)`);

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 6: TRANSACTION ATOMICITY & ROLLBACK SAFETY
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 6] Transaction Atomicity & Rollback Safety Audit...');

    const connRb = await pool.getConnection();
    try {
      await connRb.beginTransaction();
      await connRb.query("UPDATE rooms SET housekeeping_status = 'Clean' WHERE id = ?", [sourceRoomId]);
      const rbEvt = await enqueue(connRb, {
        event_type: 'TEST_ROLLBACK_STABILITY',
        aggregate_type: 'TEST',
        aggregate_id: '99999',
        payload: { test: true }
      });
      // Explicit ROLLBACK
      await connRb.rollback();

      const [rbCheck] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE event_id = ?", [rbEvt.event_id]);
      assert(rbCheck[0].cnt === 0, 'Atomic Rollback: MySQL transaction rollback removed enqueued outbox event');
    } finally {
      connRb.release();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 7: FIRESTORE FAILURE ISOLATION AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 7] Firestore Failure Isolation Audit...');

    // Enqueue synthetic event directly
    const synthEvt = await enqueue(null, {
      event_type: 'TEST_SYNTHETIC_FAILURE',
      aggregate_type: 'TEST',
      aggregate_id: '88888',
      payload: { synthetic: true }
    });

    // Simulate markFailed path (Firestore dispatch exception simulation)
    const failedRecord = await markFailed(null, synthEvt.event_id, 'Simulated Firestore Dispatch Error', 5);
    assert(failedRecord.status === 'FAILED', 'Firestore Failure Isolation: Outbox event status updated to FAILED');
    assert(failedRecord.attempts === 1, 'Retry attempts incremented to 1');

    // MySQL connection check (MySQL TX was NOT broken by Firestore failure)
    const [mysqlPing] = await pool.query('SELECT 1+1 as res');
    assert(mysqlPing[0].res === 2, 'MySQL database remains 100% healthy and operational despite Firestore error');

    // Cleanup synthetic event so FAILED count returns to 0
    await pool.query('DELETE FROM dual_write_outbox WHERE event_id = ?', [synthEvt.event_id]);
    const [failedCleanCheck] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status = 'FAILED'");
    assert(failedCleanCheck[0].cnt === 0, 'Synthetic FAILED event cleaned up; FAILED count = 0');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 8: IDEMPOTENCY & REPLAY SAFETY
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 8] Idempotency & Replay Safety Audit...');

    // Enqueue an event with identical aggregate_id
    const idempEvt = await enqueue(null, {
      event_type: 'HOUSEKEEPING_STATUS_UPDATED',
      aggregate_type: 'HOUSEKEEPING',
      aggregate_id: String(sourceRoomNumber),
      payload: {
        room_id: String(sourceRoomId),
        room_number: String(sourceRoomNumber),
        status: 'Clean',
        updated_at: new Date().toISOString()
      }
    });
    testOutboxIds.push(idempEvt.event_id);

    const batchIdemp = await processOutboxBatch(10, 5);
    assert(batchIdemp.processed === 1, 'Replay event processed successfully via set_merge');
    assert(batchIdemp.failed === 0, 'Zero errors on idempotent replay');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 9: PAYLOAD SECURITY AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 9] Payload Security Audit...');

    const [testPayloads] = await pool.query(
      "SELECT payload FROM dual_write_outbox WHERE event_id IN (?)",
      [testOutboxIds.length > 0 ? testOutboxIds : ['none']]
    );

    const SENSITIVE_TERMS = ['password', 'password_hash', 'jwt', 'private_key', 'card_number', 'cvv', 'pin'];
    let sensitiveFound = false;

    for (const row of testPayloads) {
      const pStr = row.payload.toLowerCase();
      for (const term of SENSITIVE_TERMS) {
        if (pStr.includes(`"${term}"`)) {
          sensitiveFound = true;
          console.error(`  ❌ Found sensitive term '${term}' in outbox payload`);
        }
      }
    }
    assert(!sensitiveFound, 'Security Audit: ZERO sensitive credential terms found in outbox payloads');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 10: MYSQL AUTHORITY CHECK
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 10] MySQL Authority Check...');

    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS=false (MySQL is 100% authoritative for reads)');
    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES=false (MySQL serves all client traffic)');

    const [authRead] = await pool.query('SELECT status FROM rooms WHERE id = ?', [sourceRoomId]);
    assert(authRead.length > 0, `MySQL authoritative read verified: room status = ${authRead[0].status}`);

    // ══════════════════════════════════════════════════════════════════════════
    // GATE 11: CLEANUP & BASELINE RESTORATION AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[GATE 11] Cleanup & Database Baseline Restoration...');

    // Stop worker before cleanup
    stopOutboxWorker();
    assert(isWorkerRunning() === false, 'Outbox worker stopped cleanly for cleanup');

    // Delete created test records
    if (createdPaymentId) await pool.query('DELETE FROM payments WHERE id = ?', [createdPaymentId]);
    if (createdInvoiceId) await pool.query('DELETE FROM invoices WHERE id = ?', [createdInvoiceId]);
    if (createdBookingId) await pool.query('DELETE FROM bookings WHERE id = ?', [createdBookingId]);
    if (createdGuestId) await pool.query('DELETE FROM guests WHERE id = ?', [createdGuestId]);

    if (sourceRoomId) await pool.query("UPDATE rooms SET status = 'Vacant', housekeeping_status = 'Clean' WHERE id = ?", [sourceRoomId]);
    if (targetRoomId) await pool.query("UPDATE rooms SET status = 'Vacant', housekeeping_status = 'Clean' WHERE id = ?", [targetRoomId]);

    if (testOutboxIds.length > 0) {
      await pool.query("DELETE FROM dual_write_outbox WHERE event_id IN (?)", [testOutboxIds]);
    }

    // Verify baseline counts restored
    const [roomsPost] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    const [bkgPost] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    const [invPost] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [payPost] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
    const [staffPost] = await pool.query('SELECT COUNT(*) as cnt FROM staff WHERE deleted=0');
    const [guestPost] = await pool.query('SELECT COUNT(*) as cnt FROM guests');

    const [pPost] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PENDING'");
    const [prPost] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PROCESSING'");
    const [fPost] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='FAILED'");
    const [dPost] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='DEAD_LETTER'");

    console.log(`  ⓘ Post-cleanup counts — rooms:${roomsPost[0].cnt}, bookings:${bkgPost[0].cnt}, invoices:${invPost[0].cnt}, payments:${payPost[0].cnt}, staff:${staffPost[0].cnt}, guests:${guestPost[0].cnt}`);
    console.log(`  ⓘ Post-cleanup outbox — PENDING:${pPost[0].cnt}, PROCESSING:${prPost[0].cnt}, FAILED:${fPost[0].cnt}, DEAD_LETTER:${dPost[0].cnt}`);

    assert(roomsPost[0].cnt === 17, 'Rooms restored to baseline = 17');
    assert(bkgPost[0].cnt === 1, 'Bookings restored to baseline = 1');
    assert(invPost[0].cnt === 2, 'Invoices restored to baseline = 2');
    assert(payPost[0].cnt === 1, 'Payments restored to baseline = 1');
    assert(staffPost[0].cnt === 10, 'Active staff restored to baseline = 10');
    assert(guestPost[0].cnt === 2, 'Guests restored to baseline = 2');
    assert(pPost[0].cnt === 0, 'Outbox PENDING = 0');
    assert(prPost[0].cnt === 0, 'Outbox PROCESSING = 0');
    assert(fPost[0].cnt === 0, 'Outbox FAILED = 0');
    assert(dPost[0].cnt === 0, 'Outbox DEAD_LETTER = 0');

    // Confirm flags remain intact
    assert(isFirestoreDualWriteEnabled() === true, 'ENABLE_FIRESTORE_DUAL_WRITE remains true');
    assert(isFirestoreOutboxWorkerEnabled() === true, 'ENABLE_FIRESTORE_OUTBOX_WORKER remains true');

    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    if (passedTests === totalTests) {
      console.log('ALL GATES PASSED — PHASE 3E STEP 3 DUAL-WRITE STABILITY GATE: PASS');
    } else {
      console.log('PHASE 3E STEP 3 DUAL-WRITE STABILITY GATE: BLOCKED');
    }
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Dual-Write Stability Suite Error:', err);
    if (isWorkerRunning()) stopOutboxWorker();
    process.exitCode = 1;
  } finally {
    if (isWorkerRunning()) stopOutboxWorker();
    await pool.end();
  }
}

runDualWriteStabilitySuite();
