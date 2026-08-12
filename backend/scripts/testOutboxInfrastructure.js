import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { isWorkerRunning } from '../services/outboxWorker.js';

async function diagnoseOutboxInfrastructure() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3A Outbox Infrastructure Diagnostic Report');
  console.log('========================================================================\n');

  try {
    // 1. Table Availability Check
    console.log('1. Checking dual_write_outbox MySQL Table Availability...');
    const [tables] = await pool.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dual_write_outbox'`
    );

    const isTablePresent = tables.length > 0;
    console.log(`   - dual_write_outbox Table Exists: ${isTablePresent ? 'YES' : 'NO (Pending Migration 008)'}`);

    if (isTablePresent) {
      // 2. Outbox Counts by Status
      const [counts] = await pool.query(
        `SELECT status, COUNT(*) as cnt FROM dual_write_outbox GROUP BY status`
      );

      const statusMap = {
        PENDING: 0,
        PROCESSING: 0,
        PROCESSED: 0,
        FAILED: 0,
        DEAD_LETTER: 0
      };

      counts.forEach(row => {
        statusMap[row.status] = Number(row.cnt);
      });

      console.log('\n2. Outbox Event Counts by Status:');
      console.log(`   - PENDING:     ${statusMap.PENDING}`);
      console.log(`   - PROCESSING:  ${statusMap.PROCESSING}`);
      console.log(`   - PROCESSED:   ${statusMap.PROCESSED}`);
      console.log(`   - FAILED:      ${statusMap.FAILED}`);
      console.log(`   - DEAD_LETTER: ${statusMap.DEAD_LETTER}`);
    }

    // 3. Worker Configuration Status
    console.log('\n3. Outbox Worker Configuration Status:');
    console.log(`   - ENABLE_FIRESTORE_DUAL_WRITE:   ${process.env.ENABLE_FIRESTORE_DUAL_WRITE || 'false'} (Default: false)`);
    console.log(`   - ENABLE_FIRESTORE_OUTBOX_WORKER: ${process.env.ENABLE_FIRESTORE_OUTBOX_WORKER || 'false'} (Default: false)`);
    console.log(`   - Batch Size:                     ${process.env.FIRESTORE_OUTBOX_BATCH_SIZE || 10}`);
    console.log(`   - Max Retries:                    ${process.env.FIRESTORE_OUTBOX_MAX_RETRIES || 5}`);
    console.log(`   - Poll Interval:                  ${process.env.FIRESTORE_OUTBOX_POLL_INTERVAL_MS || 3000} ms`);
    console.log(`   - Worker Running State:           ${isWorkerRunning() ? 'RUNNING' : 'IDLE'}`);

    // 4. Firebase Admin SDK Configuration Status
    console.log('\n4. Firebase Admin SDK Configuration Status:');
    console.log(`   - Firebase Configured:            ${isFirebaseConfigured ? 'YES' : 'NO (Missing Service Account credentials)'}`);

    console.log('\n========================================================================');
    console.log('  DIAGNOSTIC REPORT COMPLETE — Zero production data modified.');
    console.log('========================================================================\n');

    process.exit(0);
  } catch (err) {
    console.error('Error during outbox diagnostic check:', err.message);
    process.exit(1);
  }
}

diagnoseOutboxInfrastructure();
