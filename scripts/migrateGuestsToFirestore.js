/**
 * Controlled Pilot Migration Script: Guests Only
 * ===============================================
 * Reads guest records from MySQL (`guests` table LEFT JOIN `users`) and maps
 * them to target Firestore collection `/guests/guest_${mysql_guest_id}`.
 *
 * SAFETY RULES:
 *  - Defaults strictly to DRY-RUN mode (`--dry-run`).
 *  - ZERO writes to Firestore unless `--commit` is explicitly passed.
 *  - ZERO writes/updates to MySQL (MySQL is strictly Read-Only).
 *  - ZERO password hashes or credential secrets exported.
 *  - Uses SafeFirestoreBatchWriter for safe chunked batching (max 250 ops/batch).
 *  - Sensitive personal data (phone, email, government_id) REDACTED in dry-run output logs.
 *
 * Usage:
 *  node scripts/migrateGuestsToFirestore.js           (Runs Dry-Run mode)
 *  node scripts/migrateGuestsToFirestore.js --dry-run  (Runs Dry-Run mode)
 *  node scripts/migrateGuestsToFirestore.js --commit   (Performs Firestore write)
 */

import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { SafeFirestoreBatchWriter } from './utils/firestoreBatch.js';

const isCommitMode = process.argv.includes('--commit');
const isDryRunMode = !isCommitMode;

async function runGuestMigration() {
  console.log('\n=================================================');
  console.log(`  GUEST MIGRATION SCRIPT (${isCommitMode ? 'COMMIT MODE' : 'DRY-RUN MODE'})`);
  console.log('=================================================\n');

  let connection;
  try {
    connection = await pool.getConnection();

    // Query MySQL guests LEFT JOIN users
    const [rows] = await connection.query(`
      SELECT 
        g.id AS mysql_guest_id,
        g.user_id AS mysql_user_id,
        g.full_name,
        g.email,
        g.phone,
        g.address,
        g.gst_no,
        g.pincode,
        g.country,
        g.arrival_from,
        g.departure_to,
        g.government_id,
        g.id_type,
        g.gender,
        g.age,
        g.loyalty_tier,
        g.loyalty_points,
        g.created_at,
        g.updated_at,
        g.id_document_path,
        g.id_upload_timestamp,
        g.id_verification_status,
        g.id_rejection_reason,
        g.id_verified_by,
        g.id_verified_at,
        u.username AS linked_username,
        u.role_id AS user_role_id
      FROM guests g
      LEFT JOIN users u ON g.user_id = u.id
      ORDER BY g.id ASC
    `);

    console.log(`[MySQL] Fetched ${rows.length} guest records from MySQL database.`);

    const mappedDocuments = [];
    const docIdSet = new Set();
    const mysqlIdSet = new Set();
    const phoneSet = new Set();
    const emailSet = new Set();

    let registeredGuestCount = 0;
    let walkinGuestCount = 0;
    let duplicateDocIdCount = 0;
    let missingMysqlIdCount = 0;
    let duplicateMysqlIdCount = 0;
    let duplicatePhoneCount = 0;
    let duplicateEmailCount = 0;
    let missingFieldCount = 0;
    let userRelationshipErrorCount = 0;
    let credentialCheckFailed = false;
    let hasIdDocCount = 0;
    let noIdDocCount = 0;

    const issues = [];

    for (const g of rows) {
      if (g.mysql_user_id) {
        registeredGuestCount++;
        if (!g.linked_username) {
          userRelationshipErrorCount++;
          issues.push(`Guest ID ${g.mysql_guest_id} references user_id ${g.mysql_user_id} which does not exist in users table.`);
        }
      } else {
        walkinGuestCount++;
      }

      if (!g.mysql_guest_id) {
        missingMysqlIdCount++;
        issues.push(`Guest record missing mysql_guest_id.`);
      } else if (mysqlIdSet.has(g.mysql_guest_id)) {
        duplicateMysqlIdCount++;
        issues.push(`Duplicate mysql_guest_id: ${g.mysql_guest_id}`);
      }
      if (g.mysql_guest_id) mysqlIdSet.add(g.mysql_guest_id);

      if (!g.full_name || g.full_name.trim() === '') {
        missingFieldCount++;
        issues.push(`Guest ID ${g.mysql_guest_id} missing mandatory full_name.`);
      }

      if (g.phone && g.phone.trim() !== '') {
        const cleanPhone = g.phone.trim();
        if (phoneSet.has(cleanPhone)) {
          duplicatePhoneCount++;
        }
        phoneSet.add(cleanPhone);
      }

      if (g.email && g.email.trim() !== '') {
        const cleanEmail = g.email.trim().toLowerCase();
        if (emailSet.has(cleanEmail)) {
          duplicateEmailCount++;
        }
        emailSet.add(cleanEmail);
      }

      if (g.id_document_path && g.id_document_path.trim() !== '') {
        hasIdDocCount++;
      } else {
        noIdDocCount++;
      }

      const docId = `guest_${g.mysql_guest_id}`;
      if (docIdSet.has(docId)) {
        duplicateDocIdCount++;
        issues.push(`Duplicate Firestore Document ID: ${docId}`);
      }
      docIdSet.add(docId);

      // Security Audit: Check for passwords or secrets
      if (g.password || g.password_hash || g.secret) {
        credentialCheckFailed = true;
        issues.push(`SECURITY FAILURE: Password field detected on guest ID ${g.mysql_guest_id}`);
      }

      const firestoreDoc = {
        mysql_guest_id: Number(g.mysql_guest_id),
        mysql_user_id: g.mysql_user_id ? Number(g.mysql_user_id) : null,
        user_uid: null, // Firebase Auth not provisioned yet
        full_name: String(g.full_name || '').trim(),
        email: g.email ? String(g.email).trim() : null,
        phone: g.phone ? String(g.phone).trim() : null,
        address: g.address ? String(g.address).trim() : null,
        gst_no: g.gst_no ? String(g.gst_no).trim() : null,
        pincode: g.pincode ? String(g.pincode).trim() : null,
        country: g.country ? String(g.country).trim() : null,
        arrival_from: g.arrival_from ? String(g.arrival_from).trim() : null,
        departure_to: g.departure_to ? String(g.departure_to).trim() : null,
        government_id: g.government_id ? String(g.government_id).trim() : null,
        id_type: g.id_type ? String(g.id_type).trim() : null,
        gender: g.gender ? String(g.gender).trim() : null,
        age: g.age ? Number(g.age) : null,
        loyalty_tier: String(g.loyalty_tier || 'Bronze'),
        loyalty_points: Number(g.loyalty_points || 0),
        id_document_path: g.id_document_path ? String(g.id_document_path) : null,
        id_upload_timestamp: g.id_upload_timestamp ? new Date(g.id_upload_timestamp).toISOString() : null,
        id_verification_status: String(g.id_verification_status || 'Pending'),
        id_rejection_reason: g.id_rejection_reason ? String(g.id_rejection_reason) : null,
        id_verified_by: g.id_verified_by ? Number(g.id_verified_by) : null,
        id_verified_at: g.id_verified_at ? new Date(g.id_verified_at).toISOString() : null,
        created_at: g.created_at ? new Date(g.created_at).toISOString() : new Date().toISOString(),
        updated_at: g.updated_at ? new Date(g.updated_at).toISOString() : new Date().toISOString()
      };

      mappedDocuments.push({
        docId,
        data: firestoreDoc
      });
    }

    // Print Dry-Run Validation Report
    console.log('\n--- GUEST MIGRATION DRY-RUN REPORT ---');
    console.log(`Target Collection          : /guests`);
    console.log(`MySQL Guest Count          : ${rows.length}`);
    console.log(`Expected Firestore Docs    : ${mappedDocuments.length}`);
    console.log(`Registered Guests          : ${registeredGuestCount}`);
    console.log(`Walk-in Guests             : ${walkinGuestCount}`);
    console.log(`Duplicate Document IDs     : ${duplicateDocIdCount}`);
    console.log(`Duplicate mysql_guest_id   : ${duplicateMysqlIdCount}`);
    console.log(`Missing Required Fields    : ${missingFieldCount}`);
    console.log(`Duplicate Phones           : ${duplicatePhoneCount}`);
    console.log(`Duplicate Emails           : ${duplicateEmailCount}`);
    console.log(`User/Guest Rel Errors      : ${userRelationshipErrorCount}`);
    console.log(`With ID Document Path      : ${hasIdDocCount}`);
    console.log(`Without ID Document Path   : ${noIdDocCount}`);
    console.log(`Credential Fields Included : ${credentialCheckFailed ? 'YES (FAIL)' : 'NO (Pass)'}`);
    console.log(`Firebase Auth Users        : 0`);
    console.log(`Firestore Writes           : 0`);
    console.log(`MySQL Writes               : 0`);

    if (mappedDocuments.length > 0) {
      const sample = JSON.parse(JSON.stringify(mappedDocuments[0].data));
      // Redact sensitive personal data in sample output
      if (sample.phone) sample.phone = '[REDACTED]';
      if (sample.email) sample.email = '[REDACTED]';
      if (sample.government_id) sample.government_id = '[REDACTED]';
      if (sample.address) sample.address = '[REDACTED]';

      console.log('\n--- SAMPLE MAPPED FIRESTORE DOCUMENT (REDACTED FOR PRIVACY) ---');
      console.log(`Document Path: /guests/${mappedDocuments[0].docId}`);
      console.log(JSON.stringify(sample, null, 2));
    }

    if (isDryRunMode) {
      console.log('\n=================================================');
      console.log('  DRY-RUN COMPLETE: ZERO FIRESTORE WRITES PERFORMED.');
      console.log('  ZERO MYSQL WRITES PERFORMED.');
      console.log('  ZERO FIREBASE AUTH USERS CREATED.');
      console.log('=================================================\n');
      return;
    }

    // Commit guard
    if (issues.length > 0) {
      throw new Error(`Cannot commit guest migration due to issues: ${issues.join('; ')}`);
    }

    if (!isFirebaseConfigured || !db) {
      throw new Error('Firebase Admin SDK is not configured.');
    }

    console.log(`\n[Firestore Write] Committing ${mappedDocuments.length} guest documents to Firestore via SafeBatchWriter...`);
    const batchWriter = new SafeFirestoreBatchWriter(db, {
      collectionName: 'guests',
      maxBatchSize: 250,
      isDryRun: false
    });

    for (const item of mappedDocuments) {
      const docRef = db.collection('guests').doc(item.docId);
      await batchWriter.set(docRef, item.data, { merge: true });
    }

    await batchWriter.finalize();
    console.log(`✔ [Firestore Write SUCCESS] Wrote ${mappedDocuments.length} documents to /guests.\n`);

  } catch (error) {
    console.error('\n❌ [Migration Error]:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
  }
}

runGuestMigration();
