/**
 * provisionStaffFirebaseAuth.js  —  Phase 3 (IDEMPOTENT)
 * =================================================================
 * Run from backend/ directory:  node provisionStaffFirebaseAuth.js
 *
 * Provisions ALL active HPMS staff into Firebase Authentication.
 *  - Idempotent: safe to re-run
 *  - Reads only non-sensitive fields (no password_hash)
 *  - Never modifies MySQL records or business tables
 *  - Claims: { role, user_type, staff_id, mysql_staff_id }
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

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
  console.error('[FATAL] Firebase Admin credentials missing in .env');
  process.exit(1);
}

const firebaseApp = !getApps().length
  ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
  : getApp();

const auth = getAuth(firebaseApp);
const db   = getFirestore(firebaseApp);

// ── Role → Firebase claim mapping ────────────────────────────────────────────

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

  // Read active staff — NO password_hash selected
  const conn = await createConnection({
    host:     process.env.DB_HOST || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'hotel_pms'
  });

  const [staffRows] = await conn.query(`
    SELECT id, username, email, role, department, shift, status, full_name
    FROM staff WHERE deleted = 0 ORDER BY id ASC
  `);
  await conn.end();

  summary.total = staffRows.length;
  console.log('\n' + '═'.repeat(70));
  console.log('  PHASE 3 — IDEMPOTENT STAFF FIREBASE AUTH PROVISIONING');
  console.log('═'.repeat(70));
  console.log(`  Active staff found in MySQL: ${summary.total}\n`);

  for (const staff of staffRows) {
    const rec = {
      mysql_id: staff.id, username: staff.username, email: staff.email,
      role: staff.role, action: null, firebase_uid: null,
      claims_updated: false, firestore_updated: false, error: null
    };

    try {
      const { role: claimRole, user_type } = mapRoleToClaims(staff.role);
      const deterministicUid = `staff_${staff.id}`;

      // Find or create Firebase Auth user (idempotent)
      let authUser = null;

      try {
        authUser = await auth.getUser(deterministicUid);
        rec.action = 'existing_uid';
        summary.existing++;
      } catch {
        try {
          authUser = await auth.getUserByEmail(staff.email);
          rec.action = 'existing_email';
          summary.existing++;
        } catch {
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

      // Set / verify custom claims
      const cur = authUser.customClaims || {};
      if (cur.role !== claimRole || cur.user_type !== user_type ||
          cur.staff_id !== staff.username || cur.mysql_staff_id !== staff.id) {
        await auth.setCustomUserClaims(authUser.uid, {
          role: claimRole, user_type,
          staff_id: staff.username, mysql_staff_id: staff.id
        });
        rec.claims_updated = true;
        summary.claimsUpdated++;
      }

      // Write / update Firestore staff document user_uid
      const docRef = db.collection('staff').doc(`staff_${staff.username}`);
      const snap   = await docRef.get();

      if (snap.exists) {
        if (!snap.data().user_uid || snap.data().user_uid !== authUser.uid) {
          await docRef.update({ user_uid: authUser.uid, updated_at: new Date().toISOString() });
          rec.firestore_updated = true;
          summary.firestoreUpdated++;
        }
      } else {
        await docRef.set({
          username: staff.username, full_name: staff.full_name,
          email: staff.email.toLowerCase().trim(), role: staff.role.toLowerCase(),
          department: staff.department, shift: staff.shift, status: staff.status,
          user_uid: authUser.uid, mysql_staff_id: staff.id,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        }, { merge: true });
        rec.firestore_updated = true;
        summary.firestoreUpdated++;
      }

      const icon = rec.action === 'created' ? '✅ CREATED ' : '🔄 EXISTING';
      console.log(
        `  [${icon}] id=${String(staff.id).padEnd(3)} | ${staff.username.padEnd(20)} | ` +
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

  console.log('\n' + '═'.repeat(70));
  console.log('  PROVISIONING SUMMARY');
  console.log('═'.repeat(70));
  console.log(`  Total staff              : ${summary.total}`);
  console.log(`  Newly created in FB Auth : ${summary.provisioned}`);
  console.log(`  Already existed          : ${summary.existing}`);
  console.log(`  Custom claims updated    : ${summary.claimsUpdated}`);
  console.log(`  Firestore docs updated   : ${summary.firestoreUpdated}`);
  console.log(`  Failures                 : ${summary.failed}`);
  console.log('═'.repeat(70));

  if (summary.failed > 0) {
    console.error(`\n[WARNING] ${summary.failed} account(s) failed. Review errors above.`);
    process.exit(1);
  }

  console.log('\n[Phase 3] ✅ All active staff provisioned in Firebase Auth.');
  console.log('[Phase 3] Set ENABLE_FIREBASE_AUTH=true in backend/.env to activate dual-auth.\n');
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
