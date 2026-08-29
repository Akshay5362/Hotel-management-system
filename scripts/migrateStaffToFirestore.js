/**
 * Refactored Staff Migration Script
 * ====================================
 * Reads staff roster profiles from MySQL `staff` table (enriched with `users`
 * authentication metadata where available) and exports them to Cloud Firestore
 * collection `/staff/staff_${mysql_id}`.
 *
 * SAFETY RULES:
 *  - Defaults to DRY-RUN mode (`--dry-run`).
 *  - ZERO writes to Firestore unless `--commit` is explicitly passed.
 *  - ZERO writes/updates to MySQL (MySQL is strictly Read-Only).
 *  - ZERO password hashes, credentials, or secrets exported to Firestore.
 *  - Uses SafeFirestoreBatchWriter for safe chunked batching (max 250 ops/batch).
 *
 * Usage:
 *  node scripts/migrateStaffToFirestore.js           (Runs Dry-Run mode)
 *  node scripts/migrateStaffToFirestore.js --dry-run  (Runs Dry-Run mode)
 *  node scripts/migrateStaffToFirestore.js --commit   (Performs Firestore write)
 */

import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { SafeFirestoreBatchWriter } from './utils/firestoreBatch.js';

const isCommitMode = process.argv.includes('--commit');
const isDryRunMode = !isCommitMode;

// Role normalization mapping
const ROLE_MAP = {
  'ADMIN': 'admin',
  'RECEPTIONIST': 'receptionist',
  'RECEPTION': 'receptionist',
  'HOUSEKEEPING': 'housekeeping',
  'CLEANER': 'housekeeping',
  'MANAGER': 'manager',
  'CHEF': 'kitchen',
  'KITCHEN': 'kitchen',
  'KITCHEN_HELPER': 'kitchen',
  'PANTRY_BOY': 'kitchen'
};

async function runStaffMigration() {
  console.log('\n=================================================');
  console.log(`  STAFF MIGRATION SCRIPT (${isCommitMode ? 'COMMIT MODE' : 'DRY-RUN MODE'})`);
  console.log('=================================================\n');

  let connection;
  try {
    connection = await pool.getConnection();

    // 1. Fetch staff roster profiles from MySQL `staff` table
    const [staffRows] = await connection.query(`
      SELECT 
        s.id AS mysql_staff_id,
        s.username,
        s.full_name,
        s.email,
        s.phone,
        s.role,
        s.department,
        s.shift,
        s.status,
        u.id AS mysql_user_id
      FROM staff s
      LEFT JOIN users u ON LOWER(s.username) = LOWER(u.username)
      ORDER BY s.id ASC
    `);

    console.log(`[MySQL] Fetched ${staffRows.length} staff roster records from 'staff' table.`);

    if (staffRows.length === 0) {
      console.warn('[MySQL Warning] Zero staff records found in MySQL database.');
    }

    const mappedDocuments = [];
    const docIdSet = new Set();
    const mysqlIdSet = new Set();
    const usernameSet = new Set();

    let duplicateDocIdCount = 0;
    let missingMysqlIdCount = 0;
    let duplicateMysqlIdCount = 0;
    let duplicateUsernameCount = 0;
    let missingFieldCount = 0;
    let passwordHashCheck = false;

    const roleCounts = {};
    const issues = [];

    // 2. Map records deterministically
    for (const u of staffRows) {
      const mysqlId = u.mysql_staff_id || u.id;
      const username = u.username || `staff_${mysqlId}`;
      const fullName = u.full_name || username;
      const rawRole = String(u.role || 'receptionist').toUpperCase().trim();
      const normalizedRole = ROLE_MAP[rawRole] || rawRole.toLowerCase();

      if (!mysqlId) {
        missingMysqlIdCount++;
        issues.push(`Record missing mysql_id.`);
      } else if (mysqlIdSet.has(mysqlId)) {
        duplicateMysqlIdCount++;
        issues.push(`Duplicate mysql_id: ${mysqlId}`);
      }
      if (mysqlId) mysqlIdSet.add(mysqlId);

      const lowerUser = String(username).toLowerCase();
      if (usernameSet.has(lowerUser)) {
        duplicateUsernameCount++;
        issues.push(`Duplicate username: ${username}`);
      }
      usernameSet.add(lowerUser);

      if (!username || !fullName) {
        missingFieldCount++;
        issues.push(`Staff ID ${mysqlId} missing mandatory username or full_name.`);
      }

      roleCounts[normalizedRole] = (roleCounts[normalizedRole] || 0) + 1;

      const docId = `staff_${mysqlId}`;
      if (docIdSet.has(docId)) {
        duplicateDocIdCount++;
        issues.push(`Duplicate Firestore Document ID: ${docId}`);
      }
      docIdSet.add(docId);

      // SECURITY GUARD: Ensure password secrets are NEVER included
      if (u.password || u.password_hash || u.secret) {
        passwordHashCheck = true;
      }

      const firestoreDoc = {
        mysql_staff_id: Number(mysqlId),
        mysql_user_id: u.mysql_user_id ? Number(u.mysql_user_id) : null,
        user_uid: null, // Linked dynamically when Auth provisioning runs
        username: String(username).toLowerCase().trim(),
        full_name: String(fullName).trim(),
        email: u.email ? String(u.email).toLowerCase().trim() : null,
        phone: u.phone ? String(u.phone).trim() : null,
        role: normalizedRole,
        department: String(u.department || 'Front Office'),
        shift: String(u.shift || 'Morning'),
        status: String(u.status || 'Active'),
        deleted: false,
        updated_at: new Date().toISOString()
      };

      mappedDocuments.push({
        docId,
        data: firestoreDoc
      });
    }

    // 3. Dry-Run Validation Report
    console.log('\n--- DRY-RUN VALIDATION REPORT ---');
    console.log(`Target Collection          : /staff`);
    console.log(`MySQL Source Records       : ${staffRows.length}`);
    console.log(`Expected Firestore Docs    : ${mappedDocuments.length}`);
    console.log(`Duplicate Document IDs     : ${duplicateDocIdCount}`);
    console.log(`Missing mysql_id           : ${missingMysqlIdCount}`);
    console.log(`Duplicate mysql_id         : ${duplicateMysqlIdCount}`);
    console.log(`Duplicate Usernames        : ${duplicateUsernameCount}`);
    console.log(`Missing Required Fields    : ${missingFieldCount}`);
    console.log(`Password Secrets Excluded  : ${!passwordHashCheck ? 'YES (Pass - Zero Secrets Exported)' : 'FAIL (Secrets Found)'}`);
    console.log(`Validation Status          : ${issues.length === 0 ? 'NONE (Pass)' : issues.join(', ')}`);

    console.log('\n--- ROLE BREAKDOWN ---');
    console.table(roleCounts);

    if (mappedDocuments.length > 0) {
      console.log('\n--- SAMPLE MAPPED FIRESTORE DOCUMENT ---');
      console.log(`Document Path: /staff/${mappedDocuments[0].docId}`);
      console.log(JSON.stringify(mappedDocuments[0].data, null, 2));
    }

    if (isDryRunMode) {
      console.log('\n=================================================');
      console.log('  DRY-RUN COMPLETE: ZERO FIRESTORE WRITES PERFORMED.');
      console.log('  ZERO MYSQL WRITES PERFORMED.');
      console.log('=================================================\n');
      return;
    }

    // 4. Commit Mode Execution
    if (!isFirebaseConfigured || !db) {
      throw new Error('Firebase Admin SDK is not configured. Cannot perform Firestore write.');
    }

    const batchWriter = new SafeFirestoreBatchWriter(db, {
      collectionName: 'staff',
      maxBatchSize: 250,
      isDryRun: false
    });

    console.log(`\n[Firestore Write] Committing ${mappedDocuments.length} staff documents using SafeBatchWriter...`);
    for (const item of mappedDocuments) {
      const docRef = db.collection('staff').doc(item.docId);
      await batchWriter.set(docRef, item.data, { merge: true });
    }

    await batchWriter.finalize();
    console.log(`✔ [Firestore Write SUCCESS] Successfully wrote ${mappedDocuments.length} staff documents to /staff collection.\n`);

  } catch (error) {
    console.error('\n❌ [Migration Error]:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
  }
}

runStaffMigration();
