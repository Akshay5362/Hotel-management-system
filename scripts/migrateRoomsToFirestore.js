/**
 * Controlled Pilot Migration Script: Rooms Only
 * ===============================================
 * Reads room records from MySQL (`rooms` JOIN `room_types`) and maps them
 * to the target Firestore schema for collection `/rooms/{room_id}`.
 *
 * SAFETY RULES:
 *  - Defaults to DRY-RUN mode (`--dry-run`).
 *  - ZERO writes to Firestore unless `--commit` is explicitly passed.
 *  - ZERO writes/updates to MySQL (MySQL is strictly Read-Only).
 *  - No existing application source files or routes modified.
 *
 * Usage:
 *  node scripts/migrateRoomsToFirestore.js           (Runs Dry-Run mode)
 *  node scripts/migrateRoomsToFirestore.js --dry-run  (Runs Dry-Run mode)
 *  node scripts/migrateRoomsToFirestore.js --commit   (Performs Firestore write)
 */

import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';

const isCommitMode = process.argv.includes('--commit');
const isDryRunMode = !isCommitMode;

async function runRoomsMigration() {
  console.log('\n=================================================');
  console.log(`  ROOMS PILOT MIGRATION SCRIPT (${isCommitMode ? 'COMMIT MODE' : 'DRY-RUN MODE'})`);
  console.log('=================================================\n');

  let connection;
  try {
    // 1. Read rooms from MySQL
    connection = await pool.getConnection();
    const [rows] = await connection.query(`
      SELECT 
        r.id AS mysql_room_id,
        r.number,
        r.status,
        COALESCE(r.housekeeping_status, 'Clean') AS housekeeping_status,
        r.housekeeping_assigned_to,
        COALESCE(r.housekeeping_priority, 'Normal') AS housekeeping_priority,
        r.last_cleaned_at,
        rt.id AS mysql_room_type_id,
        rt.code AS room_type_code,
        rt.title AS room_type_title,
        rt.base_rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      ORDER BY r.id ASC
    `);

    console.log(`[MySQL] Fetched ${rows.length} room records from MySQL database.`);

    const mappedDocuments = [];
    const docIdSet = new Set();
    const mysqlIdSet = new Set();
    let duplicateDocIdCount = 0;
    let missingMysqlIdCount = 0;
    let duplicateMysqlIdCount = 0;
    let missingFieldCount = 0;
    const issues = [];

    // 2. Perform deterministic field mapping and validation
    for (const r of rows) {
      if (!r.mysql_room_id) {
        missingMysqlIdCount++;
        issues.push(`Room record missing mysql_room_id.`);
      } else if (mysqlIdSet.has(r.mysql_room_id)) {
        duplicateMysqlIdCount++;
        issues.push(`Duplicate mysql_room_id: ${r.mysql_room_id}`);
      }
      if (r.mysql_room_id) mysqlIdSet.add(r.mysql_room_id);

      const docId = `room_${r.mysql_room_id}`;

      if (docIdSet.has(docId)) {
        duplicateDocIdCount++;
        issues.push(`Duplicate Firestore Document ID encountered: ${docId}`);
      }
      docIdSet.add(docId);

      if (!r.number || !r.room_type_code || r.base_rate === undefined) {
        missingFieldCount++;
        issues.push(`Room MySQL ID ${r.mysql_room_id} missing mandatory fields.`);
      }

      const firestoreDoc = {
        mysql_id: r.mysql_room_id,
        number: String(r.number),
        room_type_id: r.mysql_room_type_id,
        room_type_code: String(r.room_type_code),
        room_type_title: String(r.room_type_title),
        status: String(r.status || 'vacant'),
        housekeeping_status: String(r.housekeeping_status || 'Clean'),
        housekeeping_priority: String(r.housekeeping_priority || 'Normal'),
        base_rate: Number(r.base_rate || 0),
        last_cleaned_at: r.last_cleaned_at ? new Date(r.last_cleaned_at).toISOString() : null,
        updated_at: new Date().toISOString()
      };

      mappedDocuments.push({
        docId,
        data: firestoreDoc
      });
    }

    // 3. Dry-Run Report
    console.log('\n--- DRY-RUN VALIDATION REPORT ---');
    console.log(`Target Collection          : /rooms`);
    console.log(`MySQL Rooms Count          : ${rows.length}`);
    console.log(`Expected Firestore Docs    : ${mappedDocuments.length}`);
    console.log(`Duplicate Document IDs     : ${duplicateDocIdCount}`);
    console.log(`Missing mysql_id           : ${missingMysqlIdCount}`);
    console.log(`Duplicate mysql_id         : ${duplicateMysqlIdCount}`);
    console.log(`Missing Field Count        : ${missingFieldCount}`);
    console.log(`Validation Status          : ${issues.length === 0 ? 'NONE (Pass)' : issues.join(', ')}`);

    if (mappedDocuments.length > 0) {
      console.log('\n--- SAMPLE MAPPED FIRESTORE DOCUMENT ---');
      console.log(`Document Path: /rooms/${mappedDocuments[0].docId}`);
      console.log(JSON.stringify(mappedDocuments[0].data, null, 2));
    }

    if (isDryRunMode) {
      console.log('\n=================================================');
      console.log('  DRY-RUN COMPLETE: ZERO FIRESTORE WRITES PERFORMED.');
      console.log('  ZERO MYSQL WRITES PERFORMED.');
      console.log('=================================================\n');
      return;
    }

    // 4. Actual Commit (Only if --commit explicitly passed)
    if (!isFirebaseConfigured || !db) {
      throw new Error('Firebase Admin SDK is not configured. Cannot perform Firestore write.');
    }

    console.log(`\n[Firestore Write] Committing ${mappedDocuments.length} room documents to Firestore...`);
    const batch = db.batch();

    for (const item of mappedDocuments) {
      const docRef = db.collection('rooms').doc(item.docId);
      batch.set(docRef, item.data, { merge: true });
    }

    await batch.commit();
    console.log(`✔ [Firestore Write SUCCESS] Successfully wrote ${mappedDocuments.length} room documents to /rooms collection.\n`);

  } catch (error) {
    console.error('\n❌ [Migration Error]:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
  }
}

runRoomsMigration();
