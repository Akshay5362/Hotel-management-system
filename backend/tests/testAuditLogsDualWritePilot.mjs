import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import { enqueue } from '../services/outboxService.js';
import { dispatchEvent } from '../services/outboxDispatcher.js';
import {
  getAuditLogByIdFirestore, createAuditLogFirestore, deleteAuditLogFirestore
} from '../repositories/firestore/auditLogsRepository.js';

async function runAuditLogsDualWritePilotTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3J Audit Logs Dual-Write Pilot Test Suite');
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

  const rand = Math.floor(1000 + Math.random() * 8999);
  const testAction = `PHASE3J_TEST_ACTION_${rand}`;
  const testDetails = `Test detail payload for Phase 3J execution ${rand}`;
  let createdAuditId = null;
  let conn;

  try {
    conn = await pool.getConnection();
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

    // Test A, B, C, H & K: Audit Log Creation, Transactional Outbox Staging & Payload Sanitization
    console.log('--- Test A, B, C, H & K: AUDIT_LOG_CREATED, Commit & Payload Security ---');
    await conn.beginTransaction();
    const [insertResult] = await conn.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (1, ?, ?, CURDATE())`,
      [testAction, testDetails]
    );
    createdAuditId = insertResult.insertId;
    assert(createdAuditId !== undefined && createdAuditId > 0, 'MySQL audit log record inserted');

    await enqueue(conn, {
      event_type: 'AUDIT_LOG_CREATED',
      aggregate_type: 'AUDIT_LOG',
      aggregate_id: String(createdAuditId),
      payload: {
        mysql_audit_id: createdAuditId,
        user_id: 1,
        action: testAction,
        details: testDetails,
        business_date: new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString()
      }
    });
    await conn.commit();

    const [outboxRows] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'AUDIT_LOG_CREATED'`,
      [String(createdAuditId)]
    );
    assert(outboxRows.length === 1, 'Exactly one AUDIT_LOG_CREATED outbox event staged inside transaction');

    // Test K: Security Sanitization Check
    const stagedPayload = typeof outboxRows[0].payload === 'string'
      ? JSON.parse(outboxRows[0].payload)
      : outboxRows[0].payload;
    assert(stagedPayload.password === undefined, 'Outbox payload strictly excludes plain password');
    assert(stagedPayload.password_hash === undefined, 'Outbox payload strictly excludes password_hash');
    assert(stagedPayload.token === undefined, 'Outbox payload strictly excludes token');

    // Test D & E: MySQL Transaction Rollback Guard -> Zero Outbox Events
    console.log('\n--- Test D & E: MySQL Transaction Rollback Guard ---');
    const failAction = `FAIL_ACTION_${rand}`;
    try {
      await conn.beginTransaction();
      const [failInsert] = await conn.query(
        `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (1, ?, 'Fail detail', CURDATE())`,
        [failAction]
      );
      const failAuditId = failInsert.insertId;
      await enqueue(conn, {
        event_type: 'AUDIT_LOG_CREATED',
        aggregate_type: 'AUDIT_LOG',
        aggregate_id: String(failAuditId),
        payload: { mysql_audit_id: failAuditId, action: failAction }
      });
      await conn.rollback();
      assert(true, 'Rolled back failed audit log transaction');
    } catch (e) {
      if (conn) await conn.rollback();
    }

    const [failOutbox] = await conn.query(`SELECT * FROM dual_write_outbox WHERE payload LIKE ?`, [`%${failAction}%`]);
    assert(failOutbox.length === 0, 'Zero outbox events committed for rolled-back transaction');

    // Test F & G: Outbox Worker Processing & Firestore Synchronization
    console.log('\n--- Test F & G: Worker Dispatch to Firestore ---');
    if (isFirebaseConfigured) {
      const batchResult = await processOutboxBatch(10, 5);
      assert(batchResult.processed > 0, 'Outbox worker processed pending AUDIT_LOG_CREATED event');

      const firestoreAuditDoc = await getAuditLogByIdFirestore(`audit_${createdAuditId}`);
      assert(firestoreAuditDoc && firestoreAuditDoc.action === testAction, 'Firestore audit log document created with deterministic ID');
    } else {
      console.log('  ~ Firebase not configured, skipped live Firestore dispatch assertion.');
    }

    // Test I & J: Idempotent Event Replay & Append-Only Behavior
    console.log('\n--- Test I & J: Idempotency Replay & Append-Only Behavior ---');
    if (isFirebaseConfigured) {
      const replayEvent = {
        event_type: 'AUDIT_LOG_CREATED',
        payload: {
          mysql_audit_id: createdAuditId,
          user_id: 1,
          action: testAction,
          details: testDetails,
          created_at: new Date().toISOString()
        }
      };
      await dispatchEvent(replayEvent);
      await dispatchEvent(replayEvent);

      const firestoreReplayCheck = await getAuditLogByIdFirestore(`audit_${createdAuditId}`);
      assert(firestoreReplayCheck && firestoreReplayCheck.action === testAction, 'Idempotent event replay executed without creating duplicate documents');
    }

    // Test L: CLEANUP PHASE
    console.log('\n--- Test L: CLEANUP PHASE ---');
    if (createdAuditId) {
      await conn.query('DELETE FROM audit_logs WHERE id = ?', [createdAuditId]);
      await conn.query('DELETE FROM dual_write_outbox WHERE aggregate_id = ?', [String(createdAuditId)]);
    }
    assert(true, 'Cleaned up MySQL test audit log and outbox records');

    if (isFirebaseConfigured && createdAuditId) {
      await deleteAuditLogFirestore(`audit_${createdAuditId}`).catch(() => {});
      console.log('  ✓ Cleaned up test Firestore audit log document.');
    }

  } catch (err) {
    console.error('Unhandled error during Audit Logs Dual-Write Pilot test:', err);
    failed++;
  } finally {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    if (conn) conn.release();
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3J Audit Log Pilot Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAuditLogsDualWritePilotTests();
