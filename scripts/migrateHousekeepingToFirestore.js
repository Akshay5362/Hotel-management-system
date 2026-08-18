/**
 * Housekeeping Migration Script
 * =====================================
 * Reads housekeeping records from MySQL (`rooms` table housekeeping fields)
 * and maps them to the target Firestore schema for collection `/housekeeping/hk_room_${room_id}`.
 *
 * SAFETY RULES:
 *  - Defaults to DRY-RUN mode (`--dry-run`).
 *  - ZERO writes to Firestore unless `--commit` is explicitly passed.
 *  - ZERO writes/updates to MySQL (MySQL is strictly Read-Only).
 *  - Uses SafeFirestoreBatchWriter for safe chunked batching (max 250 ops/batch).
 *
 * Usage:
 *  node scripts/migrateHousekeepingToFirestore.js           (Runs Dry-Run mode)
 *  node scripts/migrateHousekeepingToFirestore.js --dry-run  (Runs Dry-Run mode)
 *  node scripts/migrateHousekeepingToFirestore.js --commit   (Performs Firestore write)
 */

import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { SafeFirestoreBatchWriter } from './utils/firestoreBatch.js';

const isCommitMode = process.argv.includes('--commit');
const isDryRunMode = !isCommitMode;

async function runHousekeepingMigration() {
  console.log('\n=================================================');
  console.log(`  HOUSEKEEPING MIGRATION SCRIPT (${isCommitMode ? 'COMMIT MODE' : 'DRY-RUN MODE'})`);
  console.log('=================================================\n');

  let connection;
  try {
    connection = await pool.getConnection();

    let rows = [];
    const [rRows] = await connection.query(`
      SELECT 
        id AS mysql_room_id,
        number AS room_number,
        COALESCE(housekeeping_status, 'Clean') AS status,
        COALESCE(housekeeping_priority, 'Normal') AS priority,
        housekeeping_assigned_to AS assigned_to,
        last_cleaned_at
      FROM rooms
      ORDER BY id ASC
    `);
    rows = rRows;
    console.log(`[MySQL] Fetched ${rows.length} room housekeeping records from 'rooms' table.`);

    const mappedDocuments = [];
    const docIdSet = new Set();
    let duplicateDocIdCount = 0;
    const statusCounts = {};

    for (const h of rows) {
      const roomDocId = `room_${h.mysql_room_id}`;
      // Document ID strategy matches housekeepingRepository.js: hk_room_${room_id}
      const docId = `hk_${roomDocId}`;

      if (docIdSet.has(docId)) {
        duplicateDocIdCount++;
      }
      docIdSet.add(docId);

      const normalizedStatus = String(h.status || 'Clean');
      statusCounts[normalizedStatus] = (statusCounts[normalizedStatus] || 0) + 1;

      const firestoreDoc = {
        mysql_housekeeping_id: Number(h.mysql_room_id),
        room_id: roomDocId,
        room_number: String(h.room_number || ''),
        status: normalizedStatus,
        priority: String(h.priority || 'Normal'),
        assigned_to: h.assigned_to ? String(h.assigned_to) : null,
        cleaned_by: null,
        notes: '',
        created_at: h.last_cleaned_at ? new Date(h.last_cleaned_at).toISOString() : new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      mappedDocuments.push({
        docId,
        data: firestoreDoc
      });
    }

    // Dry-Run Report
    console.log('\n--- DRY-RUN VALIDATION REPORT ---');
    console.log(`Target Collection          : /housekeeping`);
    console.log(`MySQL Housekeeping Records : ${rows.length}`);
    console.log(`Expected Firestore Docs    : ${mappedDocuments.length}`);
    console.log(`Duplicate Document IDs     : ${duplicateDocIdCount}`);

    console.log('\n--- STATUS BREAKDOWN ---');
    console.table(statusCounts);

    if (mappedDocuments.length > 0) {
      console.log('\n--- SAMPLE MAPPED FIRESTORE DOCUMENT ---');
      console.log(`Document Path: /housekeeping/${mappedDocuments[0].docId}`);
      console.log(JSON.stringify(mappedDocuments[0].data, null, 2));
    }

    if (isDryRunMode) {
      console.log('\n=================================================');
      console.log('  DRY-RUN COMPLETE: ZERO FIRESTORE WRITES PERFORMED.');
      console.log('  ZERO MYSQL WRITES PERFORMED.');
      console.log('=================================================\n');
      return;
    }

    // Commit Mode
    if (!isFirebaseConfigured || !db) {
      throw new Error('Firebase Admin SDK is not configured. Cannot perform Firestore write.');
    }

    const batchWriter = new SafeFirestoreBatchWriter(db, {
      collectionName: 'housekeeping',
      maxBatchSize: 250,
      isDryRun: false
    });

    console.log(`\n[Firestore Write] Committing ${mappedDocuments.length} housekeeping documents...`);
    for (const item of mappedDocuments) {
      const docRef = db.collection('housekeeping').doc(item.docId);
      await batchWriter.set(docRef, item.data, { merge: true });
    }

    await batchWriter.finalize();
    console.log(`✔ [Firestore Write SUCCESS] Successfully wrote ${mappedDocuments.length} housekeeping documents.\n`);

  } catch (error) {
    console.error('\n❌ [Migration Error]:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
  }
}

runHousekeepingMigration();
