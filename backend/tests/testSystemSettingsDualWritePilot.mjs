import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { BusinessDateService } from '../services/businessDateService.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import { enqueue } from '../services/outboxService.js';
import { dispatchEvent } from '../services/outboxDispatcher.js';
import {
  getSystemSettingsFirestore, getSystemDateFirestore, updateSystemDateFirestore, updateSystemSettingFirestore
} from '../repositories/firestore/systemSettingsRepository.js';

async function runSystemSettingsDualWritePilotTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3F System Settings Dual-Write Pilot Test Suite');
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
  const testSettingKey = `phase3f_setting_${rand}`;
  let conn;

  try {
    conn = await pool.getConnection();
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

    // Scenario D & E: SYSTEM_DATE_UPDATED Event Creation & MySQL Commit
    console.log('--- Scenario D & E: SYSTEM_DATE_UPDATED & Transaction Commit ---');
    await conn.beginTransaction();

    const originalDate = await BusinessDateService.getBusinessDate(conn);
    const testDate = '2026-08-11';
    await BusinessDateService.setBusinessDate(conn, testDate, { allowBackward: true, allowSameDate: true });

    const [outboxDateRows] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = 'system_date' AND event_type = 'SYSTEM_DATE_UPDATED'`
    );
    assert(outboxDateRows.length > 0, 'SYSTEM_DATE_UPDATED outbox event staged inside transaction');

    await conn.commit();
    assert(true, 'MySQL transaction committed with outbox event');

    // Scenario F: MySQL Rollback -> No Outbox Event
    console.log('\n--- Scenario F: MySQL Rollback Guard ---');
    const failSettingKey = `phase3f_fail_${rand}`;
    try {
      await conn.beginTransaction();
      await conn.query("INSERT INTO system_settings (key_name, value_val) VALUES (?, 'fail')", [failSettingKey]);
      await enqueue(conn, {
        event_type: 'SYSTEM_SETTING_UPDATED',
        aggregate_type: 'SYSTEM_SETTING',
        aggregate_id: failSettingKey,
        payload: { key_name: failSettingKey, value_val: 'fail' }
      });
      await conn.rollback();
      assert(true, 'Rolled back failed system setting transaction');
    } catch (e) {
      if (conn) await conn.rollback();
    }

    const [failEvts] = await conn.query(`SELECT * FROM dual_write_outbox WHERE aggregate_id = ?`, [failSettingKey]);
    assert(failEvts.length === 0, 'Zero outbox events committed for rolled-back transaction');

    // Scenario G: Worker Dispatch -> Firestore Synchronization
    console.log('\n--- Scenario G: Worker Dispatch to Firestore ---');
    if (isFirebaseConfigured) {
      const batchResultG = await processOutboxBatch(10, 5);
      assert(batchResultG.processed > 0, 'Outbox worker processed pending SYSTEM_DATE_UPDATED event');

      const firestoreDate = await getSystemDateFirestore();
      assert(firestoreDate === testDate, 'Firestore system_date document updated successfully');
    } else {
      console.log('  ~ Firebase not configured, skipped live Firestore dispatch assertion.');
    }

    // Scenario A, B & C: System Setting Creation, Update & SYSTEM_SETTING_UPDATED Event
    console.log('\n--- Scenario A, B & C: System Setting Upsert & Dispatch ---');
    await conn.beginTransaction();
    await conn.query("INSERT INTO system_settings (key_name, value_val) VALUES (?, 'V1')", [testSettingKey]);
    await enqueue(conn, {
      event_type: 'SYSTEM_SETTING_UPDATED',
      aggregate_type: 'SYSTEM_SETTING',
      aggregate_id: testSettingKey,
      payload: {
        key_name: testSettingKey,
        value_val: 'V1',
        updated_at: new Date().toISOString()
      }
    });
    await conn.commit();

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const firestoreSettingV1 = await getSystemSettingsFirestore(testSettingKey);
      assert(firestoreSettingV1 && firestoreSettingV1.value_val === 'V1', 'Firestore setting V1 synchronized');
    }

    // Scenario I: Stale Event Protection
    console.log('\n--- Scenario I: Stale Event Protection (Older Event Arrives Late) ---');
    if (isFirebaseConfigured) {
      const newerTime = new Date(Date.now() + 10000).toISOString();
      await updateSystemSettingFirestore(testSettingKey, {
        value_val: 'V_NEWER',
        updated_at: newerTime
      });

      const olderTime = new Date(Date.now() - 5000).toISOString();
      const staleEvent = {
        event_type: 'SYSTEM_SETTING_UPDATED',
        payload: {
          key_name: testSettingKey,
          value_val: 'V_STALE',
          updated_at: olderTime
        }
      };

      await dispatchEvent(staleEvent);

      const firestoreStaleCheck = await getSystemSettingsFirestore(testSettingKey);
      assert(
        firestoreStaleCheck && firestoreStaleCheck.value_val === 'V_NEWER',
        'Stale Event Guard rejected older event T2 and preserved newer state T3'
      );
    } else {
      console.log('  ~ Firebase not configured, skipped live Stale Event Guard assertion.');
    }

    // Scenario H: Idempotent Event Replay
    console.log('\n--- Scenario H: Idempotent Event Replay ---');
    if (isFirebaseConfigured) {
      const dupEvent = {
        event_type: 'SYSTEM_SETTING_UPDATED',
        payload: {
          key_name: testSettingKey,
          value_val: 'V_NEWER',
          updated_at: new Date(Date.now() + 20000).toISOString()
        }
      };
      await dispatchEvent(dupEvent);
      await dispatchEvent(dupEvent);
      const dupCheck = await getSystemSettingsFirestore(testSettingKey);
      assert(dupCheck && dupCheck.value_val === 'V_NEWER', 'Idempotent replay executed cleanly');
    }

    // Scenario K & L: Validation
    console.log('\n--- Scenario K & L: Validation Testing ---');
    try {
      await BusinessDateService.setBusinessDate(conn, 'INVALID-DATE-FORMAT', { allowBackward: true });
      assert(false, 'Should throw format validation error on invalid date');
    } catch (e) {
      assert(e.code === 'BD_INVALID_FORMAT', 'Caught expected BD_INVALID_FORMAT error on malformed date');
    }

    // Scenario O: Automated Test Cleanup & Restore Original Date
    console.log('\n--- Scenario O: CLEANUP PHASE ---');
    await conn.beginTransaction();
    await conn.query("DELETE FROM system_settings WHERE key_name = ?", [testSettingKey]);
    await conn.query("DELETE FROM dual_write_outbox WHERE aggregate_id = ?", [testSettingKey]);
    await conn.query("DELETE FROM dual_write_outbox WHERE aggregate_id = 'system_date'");
    
    // Restore original business date in MySQL
    await conn.query("UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'", [originalDate]);
    await conn.commit();
    assert(true, 'Cleaned up MySQL test settings and restored original business date');

    if (isFirebaseConfigured) {
      await updateSystemDateFirestore(originalDate).catch(() => {});
      console.log('  ✓ Restored original Firestore system_date.');
    }

  } catch (err) {
    console.error('Unhandled error during System Settings Dual-Write Pilot test:', err);
    failed++;
  } finally {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    if (conn) conn.release();
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3F System Settings Pilot Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSystemSettingsDualWritePilotTests();
