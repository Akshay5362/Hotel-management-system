/**
 * Controlled Pilot Migration Script: Staff Only
 * ===============================================
 * Reads employee records from MySQL (`staff` table) and maps them
 * to the target Firestore schema for collection `/staff/staff_${mysql_id}`.
 *
 * SAFETY RULES:
 *  - Defaults to DRY-RUN mode (`--dry-run`).
 *  - ZERO writes to Firestore unless `--commit` is explicitly passed.
 *  - ZERO writes/updates to MySQL (MySQL is strictly Read-Only).
 *  - ZERO password hashes or credential secrets exported.
 *  - No existing application source files or routes modified.
 *
 * Usage:
 *  node scripts/migrateStaffToFirestore.js           (Runs Dry-Run mode)
 *  node scripts/migrateStaffToFirestore.js --dry-run  (Runs Dry-Run mode)
 *  node scripts/migrateStaffToFirestore.js --commit   (Performs Firestore write)
 */

import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';

const isCommitMode = process.argv.includes('--commit');
const isDryRunMode = !isCommitMode;

// Role normalization mapping
const ROLE_MAP = {
  'ADMIN': 'admin',
  'RECEPTIONIST': 'receptionist',
  'CLEANER': 'housekeeper',
  'CHEF': 'kitchen',
  'KITCHEN_HELPER': 'kitchen',
  'PANTRY_BOY': 'kitchen'
};

async function runStaffMigration() {
  console.log('\n=================================================');
  console.log(`  STAFF PILOT MIGRATION SCRIPT (${isCommitMode ? 'COMMIT MODE' : 'DRY-RUN MODE'})`);
  console.log('=================================================\n');

  let connection;
  try {
    // 1. Read staff from MySQL
    connection = await pool.getConnection();
    const [rows] = await connection.query(`
      SELECT 
        id AS mysql_staff_id,
        username,
        email,
        full_name,
        role,
        department,
        shift,
        status,
        deleted
      FROM staff
      ORDER BY id ASC
    `);

    console.log(`[MySQL] Fetched ${rows.length} staff records from MySQL database.`);

    const mappedDocuments = [];
    const docIdSet = new Set();
    const mysqlIdSet = new Set();
    const usernameSet = new Set();
    const emailSet = new Set();

    let duplicateDocIdCount = 0;
    let missingMysqlIdCount = 0;
    let duplicateMysqlIdCount = 0;
    let duplicateUsernameCount = 0;
    let duplicateEmailCount = 0;
    let missingFieldCount = 0;
    let unknownRoleCount = 0;
    let inactiveCount = 0;
    let deletedCount = 0;
    let passwordHashCheck = false;

    const roleCounts = {};
    const issues = [];

    // 2. Perform deterministic field mapping and validation
    for (const s of rows) {
      if (s.deleted) deletedCount++;
      if (s.status === 'Inactive') inactiveCount++;

      if (!s.mysql_staff_id) {
        missingMysqlIdCount++;
        issues.push(`Staff record missing mysql_staff_id.`);
      } else if (mysqlIdSet.has(s.mysql_staff_id)) {
        duplicateMysqlIdCount++;
        issues.push(`Duplicate mysql_staff_id: ${s.mysql_staff_id}`);
      }
      if (s.mysql_staff_id) mysqlIdSet.add(s.mysql_staff_id);

      if (!s.username || !s.full_name || !s.role) {
        missingFieldCount++;
        issues.push(`Staff ID ${s.mysql_staff_id} missing mandatory fields.`);
      }

      if (s.username) {
        const lowerUser = s.username.toLowerCase();
        if (usernameSet.has(lowerUser)) {
          duplicateUsernameCount++;
          issues.push(`Duplicate username: ${s.username}`);
        }
        usernameSet.add(lowerUser);
      }

      if (s.email && s.email.trim() !== '') {
        const lowerEmail = s.email.toLowerCase().trim();
        if (emailSet.has(lowerEmail)) {
          duplicateEmailCount++;
          issues.push(`Duplicate email: ${s.email}`);
        }
        emailSet.add(lowerEmail);
      }

      // Role Normalization
      const rawRole = (s.role || '').toUpperCase().trim();
      const normalizedRole = ROLE_MAP[rawRole];

      if (!normalizedRole) {
        unknownRoleCount++;
        issues.push(`Unknown staff role '${s.role}' on staff ID ${s.mysql_staff_id}`);
      } else {
        roleCounts[normalizedRole] = (roleCounts[normalizedRole] || 0) + 1;
      }

      const docId = `staff_${s.mysql_staff_id}`;

      if (docIdSet.has(docId)) {
        duplicateDocIdCount++;
        issues.push(`Duplicate Firestore Document ID: ${docId}`);
      }
      docIdSet.add(docId);

      // SECURITY AUDIT: Verify password / hash fields do NOT exist in raw object
      if (s.password || s.password_hash) {
        passwordHashCheck = true;
        issues.push(`SECURITY ALERT: Password/hash field present on staff ID ${s.mysql_staff_id}`);
      }

      const firestoreDoc = {
        mysql_staff_id: Number(s.mysql_staff_id),
        user_uid: null, // Firebase Auth provisioning not started yet
        username: String(s.username || ''),
        email: s.email ? String(s.email).trim() : null,
        full_name: String(s.full_name || ''),
        role: normalizedRole || 'UNKNOWN_ROLE',
        department: String(s.department || 'General'),
        shift: String(s.shift || 'Morning'),
        status: String(s.status || 'Active'),
        deleted: Boolean(s.deleted),
        updated_at: new Date().toISOString()
      };

      mappedDocuments.push({
        docId,
        data: firestoreDoc
      });
    }

    // 3. Dry-Run Report
    console.log('\n--- DRY-RUN VALIDATION REPORT ---');
    console.log(`Target Collection          : /staff`);
    console.log(`MySQL Staff Count          : ${rows.length}`);
    console.log(`Expected Firestore Docs    : ${mappedDocuments.length}`);
    console.log(`Duplicate Document IDs     : ${duplicateDocIdCount}`);
    console.log(`Missing mysql_staff_id     : ${missingMysqlIdCount}`);
    console.log(`Duplicate mysql_staff_id   : ${duplicateMysqlIdCount}`);
    console.log(`Duplicate Usernames        : ${duplicateUsernameCount}`);
    console.log(`Duplicate Emails           : ${duplicateEmailCount}`);
    console.log(`Missing Required Fields    : ${missingFieldCount}`);
    console.log(`Unknown Staff Roles        : ${unknownRoleCount}`);
    console.log(`Inactive Accounts          : ${inactiveCount}`);
    console.log(`Deleted Accounts           : ${deletedCount}`);
    console.log(`Password / Secret Included : ${passwordHashCheck ? 'YES (SECURITY FAILURE)' : 'NO (Pass)'}`);
    console.log(`Validation Status          : ${issues.length === 0 ? 'NONE (Pass)' : issues.join(', ')}`);

    console.log('\n--- ROLE NORMALIZATION BREAKDOWN ---');
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
      console.log('  ZERO FIREBASE AUTH USERS CREATED.');
      console.log('=================================================\n');
      return;
    }

    // 4. Actual Commit Guard
    if (unknownRoleCount > 0) {
      throw new Error(`Cannot commit staff migration: ${unknownRoleCount} unknown roles detected.`);
    }

    if (!isFirebaseConfigured || !db) {
      throw new Error('Firebase Admin SDK is not configured. Cannot perform Firestore write.');
    }

    console.log(`\n[Firestore Write] Committing ${mappedDocuments.length} staff documents to Firestore...`);
    const batch = db.batch();

    for (const item of mappedDocuments) {
      const docRef = db.collection('staff').doc(item.docId);
      batch.set(docRef, item.data, { merge: true });
    }

    await batch.commit();
    console.log(`✔ [Firestore Write SUCCESS] Successfully wrote ${mappedDocuments.length} staff documents to /staff collection.\n`);

  } catch (error) {
    console.error('\n❌ [Migration Error]:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
  }
}

runStaffMigration();
