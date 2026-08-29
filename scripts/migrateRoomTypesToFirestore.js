/**
 * Controlled Pilot Migration Script: Room Types Only
 * ====================================================
 * Reads `room_types` records from MySQL and maps them to the target
 * Firestore collection `/room_types/room_type_${mysql_id}`.
 *
 * SAFETY RULES:
 *  - Defaults to DRY-RUN mode (`--dry-run`).
 *  - ZERO writes to Firestore unless `--commit` is explicitly passed.
 *  - ZERO writes/updates to MySQL (MySQL is strictly Read-Only).
 *  - Uses SafeFirestoreBatchWriter for safe chunked batching (max 250 ops/batch).
 *
 * Usage:
 *  node scripts/migrateRoomTypesToFirestore.js           (Runs Dry-Run mode)
 *  node scripts/migrateRoomTypesToFirestore.js --dry-run  (Runs Dry-Run mode)
 *  node scripts/migrateRoomTypesToFirestore.js --commit   (Performs Firestore write)
 */

import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { SafeFirestoreBatchWriter } from './utils/firestoreBatch.js';

const isCommitMode = process.argv.includes('--commit');
const isDryRunMode = !isCommitMode;

async function runRoomTypesMigration() {
  console.log('\n=================================================');
  console.log(`  ROOM TYPES MIGRATION SCRIPT (${isCommitMode ? 'COMMIT MODE' : 'DRY-RUN MODE'})`);
  console.log('=================================================\n');

  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query(`
      SELECT id, code, title, description, base_rate, image
      FROM room_types
      ORDER BY id ASC
    `);

    console.log(`[MySQL] Fetched ${rows.length} room_type records from MySQL database.`);

    const mappedDocuments = [];
    const docIdSet = new Set();
    const mysqlIdSet = new Set();
    const codeSet = new Set();

    let duplicateDocIdCount = 0;
    let missingMysqlIdCount = 0;
    let duplicateMysqlIdCount = 0;
    let duplicateCodeCount = 0;
    let missingFieldCount = 0;
    let invalidTypeCount = 0;
    const issues = [];

    for (const rt of rows) {
      if (!rt.id) {
        missingMysqlIdCount++;
        issues.push(`Room type record missing id.`);
      } else if (mysqlIdSet.has(rt.id)) {
        duplicateMysqlIdCount++;
        issues.push(`Duplicate mysql_id: ${rt.id}`);
      }
      if (rt.id) mysqlIdSet.add(rt.id);

      if (!rt.code) {
        missingFieldCount++;
        issues.push(`Room type ID ${rt.id} missing mandatory code.`);
      } else if (codeSet.has(rt.code.toUpperCase())) {
        duplicateCodeCount++;
        issues.push(`Duplicate room_type code encountered: ${rt.code}`);
      }
      if (rt.code) codeSet.add(rt.code.toUpperCase());

      if (rt.base_rate === undefined || rt.base_rate === null || isNaN(Number(rt.base_rate))) {
        invalidTypeCount++;
        issues.push(`Room type ID ${rt.id} has invalid base_rate: ${rt.base_rate}`);
      }

      const docId = `room_type_${rt.id}`;

      if (docIdSet.has(docId)) {
        duplicateDocIdCount++;
        issues.push(`Duplicate Firestore Document ID encountered: ${docId}`);
      }
      docIdSet.add(docId);

      const firestoreDoc = {
        mysql_id: Number(rt.id),
        code: String(rt.code),
        title: String(rt.title || ''),
        description: String(rt.description || ''),
        default_base_rate: Number(rt.base_rate || 0),
        image: String(rt.image || ''),
        updated_at: new Date().toISOString()
      };

      mappedDocuments.push({
        docId,
        data: firestoreDoc
      });
    }

    // Dry-Run Report
    console.log('\n--- DRY-RUN VALIDATION REPORT ---');
    console.log(`Target Collection          : /room_types`);
    console.log(`MySQL Room Types Count     : ${rows.length}`);
    console.log(`Expected Firestore Docs    : ${mappedDocuments.length}`);
    console.log(`Duplicate Document IDs     : ${duplicateDocIdCount}`);
    console.log(`Missing mysql_id           : ${missingMysqlIdCount}`);
    console.log(`Duplicate mysql_id         : ${duplicateMysqlIdCount}`);
    console.log(`Duplicate Room Type Codes  : ${duplicateCodeCount}`);
    console.log(`Missing Required Fields    : ${missingFieldCount}`);
    console.log(`Invalid Field Types        : ${invalidTypeCount}`);
    console.log(`Validation Status          : ${issues.length === 0 ? 'NONE (Pass)' : issues.join(', ')}`);

    if (mappedDocuments.length > 0) {
      console.log('\n--- SAMPLE MAPPED FIRESTORE DOCUMENT ---');
      console.log(`Document Path: /room_types/${mappedDocuments[0].docId}`);
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
      collectionName: 'room_types',
      maxBatchSize: 250,
      isDryRun: false
    });

    console.log(`\n[Firestore Write] Committing ${mappedDocuments.length} room_type documents using SafeBatchWriter...`);
    for (const item of mappedDocuments) {
      const docRef = db.collection('room_types').doc(item.docId);
      await batchWriter.set(docRef, item.data, { merge: true });
    }

    await batchWriter.finalize();
    console.log(`✔ [Firestore Write SUCCESS] Successfully wrote ${mappedDocuments.length} room_type documents.\n`);

  } catch (error) {
    console.error('\n❌ [Migration Error]:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
  }
}

runRoomTypesMigration();
