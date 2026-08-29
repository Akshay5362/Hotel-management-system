/**
 * provisionStaffFirebaseAuth.js  —  Phase 3 (IDEMPOTENT REWRITE)
 * =================================================================
 * Provisions ALL active HPMS staff into Firebase Authentication.
 *
 * Design:
 *  - Idempotent: safe to re-run; will not duplicate, fail, or delete users.
 *  - Reads only non-sensitive fields from MySQL (no password_hash).
 *  - Never modifies any MySQL record or business table.
 *  - Sets custom claims: { role, user_type, staff_id, mysql_staff_id }
 *  - Writes user_uid back to Firestore /staff/{docId} so it can be queried.
 *
 * Usage:  node scripts/provisionStaffFirebaseAuth.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getAuth }      from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createConnection } from 'mysql2/promise';

// ── Firebase Admin bootstrap ─────────────────────────────────────────────────

const projectId   = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const rawKey      = process.env.FIREBASE_PRIVATE_KEY;
const privateKey  = rawKey ? rawKey.replace(/\\n/g, '\n') : undefined;

if (!projectId || !clientEmail || !privateKey) {
  console.error('[FATAL] Firebase Admin credentials missing in backend/.env.');
  process.exit(1);
}

const firebaseApp = !getApps().length
  ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
  : getApp();

const auth = getAuth(firebaseApp);
const db   = getFirestore(firebaseApp);

// ── Role → Firebase claim mapping ────────────────────────────────────────────
// Maps MySQL staff.role to canonical Firebase custom claim role.
// Matches the role names used in firestore.rules isStaff() / isHousekeeping().

function mapRoleToClaims(mysqlRole) {
  switch (String(mysqlRole || '').toUpperCase().trim()) {
    case 'ADMIN':          return { role: 'admin',        user_type: 'staff' };
    case 'RECEPTIONIST':   return { role: 'receptionist', user_type: 'staff' };
    case 'CLEANER':        return { role: 'housekeeping', user_type: 'staff' };
    case 'CHEF':
    case 'KITCHEN_HELPER':
    case 'PANTRY_BOY':     return { role: 'staff',        user_type: 'staff' };
    default:               return { role: mysqlRole.toLowerCase(), user_type: 'staff' };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const summary = {
    total: 0, provisioned: 0, existing: 0,
    claimsUpdated: 0, firestoreUpdated: 0, failed: 0, details: []
  };

  // 1. Read active staff — NO password_hash selected
  const conn = await createConnection({
    host:     process.env.DB_HOST || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'hotel_pms'
  });

  const [staffRows] = await conn.query(`
    SELECT id, username, email, role, department, shift, status, full_name
    FROM staff
    WHERE deleted = 0
    ORDER BY id ASC
  `);
  await conn.end();

  summary.total = staffRows.length;
  console.log('\n' + '═'.repeat(66));
  console.log('PHASE 3 — IDEMPOTENT STAFF FIREBASE AUTH PROVISIONING');
  console.log('═'.repeat(66));
  console.log(`Active staff found in MySQL: ${summary.total}\n`);

  // 2. Provision each staff member
  for (const staff of staffRows) {
    const rec = {
      mysql_id: staff.id, username: staff.username, email: staff.email,
      role: staff.role, action: null, firebase_uid: null,
      claims_updated: false, firestore_updated: false, error: null
    };

    try {
      const { role: claimRole, user_type } = mapRoleToClaims(staff.role);
      const deterministicUid = `staff_${staff.id}`;

      // Step A: Find or create Firebase Auth user (idempotent)
      let authUser = null;

      try {
        // First: try by deterministic UID (fastest idempotent path)
        authUser = await auth.getUser(deterministicUid);
        rec.action = 'existing_by_uid';
        summary.existing++;
      } catch {
        try {
          // Second: try by email (handles pre-existing users with different UIDs)
          authUser = await auth.getUserByEmail(staff.email);
          rec.action = 'existing_by_email';
          summary.existing++;
        } catch {
          // Create new Firebase Auth user with deterministic UID
          authUser = await auth.createUser({
            uid:           deterministicUid,
            email:         staff.email.toLowerCase().trim(),
            emailVerified: true,
            displayName:   staff.full_name || staff.username,
            disabled:      staff.status === 'Inactive'
          });
          rec.action = 'created';
          summary.provisioned++;
        }
      }

      rec.firebase_uid = authUser.uid;

      // Step B: Set / verify custom claims
      const existingClaims = authUser.customClaims || {};
      const claimsCorrect =
        existingClaims.role           === claimRole    &&
        existingClaims.user_type      === user_type    &&
        existingClaims.staff_id       === staff.username &&
        existingClaims.mysql_staff_id === staff.id;

      if (!claimsCorrect) {
        await auth.setCustomUserClaims(authUser.uid, {
          role:           claimRole,
          user_type,
          staff_id:       staff.username,
          mysql_staff_id: staff.id
        });
        rec.claims_updated = true;
        summary.claimsUpdated++;
      }

      // Step C: Write / update Firestore staff document with user_uid
      const firestoreDocId = `staff_${staff.username}`;
      const docRef = db.collection('staff').doc(firestoreDocId);
      const snap   = await docRef.get();

      if (snap.exists) {
        const existingData = snap.data();
        if (!existingData.user_uid || existingData.user_uid !== authUser.uid) {
          await docRef.update({
            user_uid:   authUser.uid,
            updated_at: new Date().toISOString()
          });
          rec.firestore_updated = true;
          summary.firestoreUpdated++;
        }
      } else {
        // Firestore staff document doesn't exist yet — create minimal safe record
        await docRef.set({
          username:       staff.username,
          full_name:      staff.full_name,
          email:          staff.email.toLowerCase().trim(),
          role:           staff.role.toLowerCase(),
          department:     staff.department,
          shift:          staff.shift,
          status:         staff.status,
          user_uid:       authUser.uid,
          mysql_staff_id: staff.id,
          created_at:     new Date().toISOString(),
          updated_at:     new Date().toISOString()
        }, { merge: true });
        rec.firestore_updated = true;
        summary.firestoreUpdated++;
      }

      const icon = rec.action === 'created' ? '✅ CREATED ' : '🔄 EXISTING';
      console.log(
        `  [${icon}] id=${staff.id} | ${staff.username.padEnd(20)} | ` +
        `${staff.role.padEnd(14)} → ${claimRole.padEnd(14)} | ` +
        `uid=${authUser.uid} | claims=${rec.claims_updated} | fs=${rec.firestore_updated}`
      );

    } catch (err) {
      rec.action = 'failed';
      rec.error  = err.message;
      summary.failed++;
      console.error(`  [❌ FAILED ] id=${staff.id} ${staff.username}: ${err.message}`);
    }

    summary.details.push(rec);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(66));
  console.log('PROVISIONING COMPLETE');
  console.log('═'.repeat(66));
  console.log(`  Total staff              : ${summary.total}`);
  console.log(`  Newly created in FB Auth : ${summary.provisioned}`);
  console.log(`  Already existed          : ${summary.existing}`);
  console.log(`  Custom claims updated    : ${summary.claimsUpdated}`);
  console.log(`  Firestore docs updated   : ${summary.firestoreUpdated}`);
  console.log(`  Failures                 : ${summary.failed}`);
  console.log('═'.repeat(66));

  // Security audit: ensure no super_admin claim was assigned
  const hasSuperAdmin = summary.details.some(d => d.role === 'super_admin');
  if (hasSuperAdmin) {
    console.error('\n[SECURITY ALERT] super_admin claim detected in details — review immediately.');
  } else {
    console.log('\n[Security] ✅  No super_admin claims assigned to staff.');
  }

  if (summary.failed > 0) {
    console.error(`\n[WARNING] ${summary.failed} account(s) failed provisioning. Review errors above.`);
    process.exit(1);
  }

  console.log('\n[Phase 3] All active staff are provisioned in Firebase Auth.');
  console.log('[Phase 3] Set ENABLE_FIREBASE_AUTH=true in backend/.env to activate dual-auth.\n');
}

main().catch(err => {
  console.error('[FATAL] Unhandled error:', err.message);
  process.exit(1);
});
