/**
 * Controlled Firebase Auth Provisioning: Super Admin
 * ==================================================
 * Target Project: hpms-sky5 (asia-south1)
 *
 * Provisions ONLY the root Super Admin (MySQL users.id = 1) into Firebase Auth.
 * Reads temporary password strictly from process.env.SUPER_ADMIN_TEMP_PASSWORD.
 *
 * ABSOLUTE SAFETY RULES:
 *  - ZERO MySQL writes.
 *  - NEVER prints passwords or password hashes.
 *  - Requires process.env.SUPER_ADMIN_TEMP_PASSWORD before any write.
 *  - Preserves staff admin role='admin' / user_type='staff' isolation.
 *
 * Usage:
 *  $env:SUPER_ADMIN_TEMP_PASSWORD="YourSecureTempPassword123!"
 *  node scripts/provisionSuperAdminFirebaseAuth.js
 */

import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import http from 'http';

function makeHealthRequest() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/health',
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    req.end();
  });
}

async function provisionSuperAdmin() {
  console.log('\n=================================================');
  console.log('  CONTROLLED FIREBASE AUTH PROVISIONING: SUPER ADMIN');
  console.log('=================================================\n');

  if (!isFirebaseConfigured || !auth || !db) {
    throw new Error('Firebase Admin SDK is not properly initialized.');
  }

  const tempPassword = process.env.SUPER_ADMIN_TEMP_PASSWORD;

  if (!tempPassword || tempPassword.trim() === '') {
    console.error('❌ SAFETY ABORT: Environment variable SUPER_ADMIN_TEMP_PASSWORD is missing or empty.');
    console.error('   Please set $env:SUPER_ADMIN_TEMP_PASSWORD before running this script.\n');
    process.exit(1);
  }

  let connection;
  let authUserCreated = false;

  try {
    connection = await pool.getConnection();

    // ── Phase 0: Pre-Commit Assertion Checks ───────────────────────────────────
    console.log('[Phase 0] Pre-commit Assertion Checks...');

    let authUsers = [];
    try {
      const list = await auth.listUsers(100);
      authUsers = list.users;
    } catch (e) {
      for (let i = 1; i <= 11; i++) {
        try {
          const u = await auth.getUser(`staff_${i}`);
          if (u) authUsers.push(u);
        } catch (err) {}
      }
    }

    const authBeforeCount = authUsers.length;
    console.log(` - Firebase Auth Users BEFORE : ${authBeforeCount} (Expected: 11)`);
    if (authBeforeCount !== 11) {
      throw new Error(`Safety Abort: Firebase Auth user count is ${authBeforeCount}, expected 11.`);
    }

    let existingUser1 = null;
    let existingAdminEmail = null;

    try { existingUser1 = await auth.getUser('user_1'); } catch (e) {}
    try { existingAdminEmail = await auth.getUserByEmail('admin@hpms-sky5.internal'); } catch (e) {}

    if (existingUser1 || existingAdminEmail) {
      throw new Error(`Safety Abort: user_1 or admin@hpms-sky5.internal already exists in Firebase Auth.`);
    }

    const staff1User = authUsers.find(u => u.uid === 'staff_1' || u.email.toLowerCase() === 'admin@hotelsky5.com');
    const staff1Claims = staff1User?.customClaims || {};

    if (!staff1User || staff1Claims.role !== 'admin' || staff1Claims.user_type !== 'staff') {
      throw new Error(`Safety Abort: staff_1 account validation failed or incorrect claims.`);
    }

    let staffSuperAdminCount = 0;
    authUsers.forEach(u => {
      const c = u.customClaims || {};
      if (c.role === 'super_admin' || c.user_type === 'system') staffSuperAdminCount++;
    });

    if (staffSuperAdminCount > 0) {
      throw new Error(`Safety Abort: Staff account has super_admin claim.`);
    }

    const user1Doc = await db.collection('users').doc('user_1').get();
    if (user1Doc.exists) {
      throw new Error(`Safety Abort: Firestore /users/user_1 document already exists.`);
    }

    const [rootRows] = await connection.query('SELECT id, username, fullName FROM users WHERE id = 1');
    if (rootRows.length === 0) {
      throw new Error(`Safety Abort: MySQL users.id = 1 record not found.`);
    }
    const rootUser = rootRows[0];

    const [[{ total_users }]] = await connection.query('SELECT COUNT(*) as total_users FROM users');
    const [[{ total_staff }]] = await connection.query('SELECT COUNT(*) as total_staff FROM staff');
    const [[{ total_guests }]] = await connection.query('SELECT COUNT(*) as total_guests FROM guests');

    if (total_users !== 25 || total_staff !== 11 || total_guests !== 4) {
      throw new Error(`Safety Abort: MySQL count assertion failed (${total_users}/${total_staff}/${total_guests}).`);
    }

    const roomsSnap = await db.collection('rooms').get();
    const roomTypesSnap = await db.collection('room_types').get();
    const staffSnap = await db.collection('staff').get();
    const guestsSnap = await db.collection('guests').get();

    if (roomsSnap.size !== 17 || roomTypesSnap.size !== 3 || staffSnap.size !== 11 || guestsSnap.size !== 4) {
      throw new Error(`Safety Abort: Firestore collection count assertion failed.`);
    }

    console.log(' ✔ [Validation PASS] All pre-commit assertions verified cleanly.\n');

    // ── Phase 1: Create Firebase Auth User ──────────────────────────────────────
    console.log('[Phase 1] Creating Firebase Auth user (uid: user_1)...');
    
    const createdUser = await auth.createUser({
      uid: 'user_1',
      email: 'admin@hpms-sky5.internal',
      emailVerified: true,
      password: tempPassword,
      displayName: rootUser.fullName || 'Root Super Admin'
    });

    authUserCreated = true;
    console.log(` ✔ [Auth User Created] UID: '${createdUser.uid}', Email: '${createdUser.email}'`);

    // ── Phase 2: Set Custom Claims ──────────────────────────────────────────────
    console.log('\n[Phase 2] Setting Custom Claims for Root Super Admin...');
    const claimPayload = {
      role: 'super_admin',
      user_type: 'system',
      mysql_id: 1
    };

    await auth.setCustomUserClaims('user_1', claimPayload);
    console.log(` ✔ [Custom Claims Set] role='super_admin', user_type='system', mysql_id=1`);

    // ── Phase 3: Create Firestore Document /users/user_1 ────────────────────────
    console.log('\n[Phase 3] Creating Firestore /users/user_1 Profile Document...');
    const userDocRef = db.collection('users').doc('user_1');

    const firestoreProfile = {
      mysql_user_id: 1,
      user_uid: 'user_1',
      email: 'admin@hpms-sky5.internal',
      username: String(rootUser.username || 'admin'),
      full_name: String(rootUser.fullName || 'System Administrator'),
      role: 'super_admin',
      user_type: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await userDocRef.set(firestoreProfile);
    console.log(` ✔ [Firestore Doc Created] Path: /users/user_1`);

    // ── Phase 4: Post-Provisioning READ-ONLY Verification ───────────────────────
    console.log('\n=================================================');
    console.log('  READ-ONLY POST-PROVISIONING VERIFICATION');
    console.log('=================================================\n');

    let postAuthUsers = [];
    try {
      const list = await auth.listUsers(100);
      postAuthUsers = list.users;
    } catch (e) {
      for (let i = 1; i <= 11; i++) {
        try { const u = await auth.getUser(`staff_${i}`); if (u) postAuthUsers.push(u); } catch (err) {}
      }
      try { const u = await auth.getUser('user_1'); if (u) postAuthUsers.push(u); } catch (err) {}
    }

    const authAfterCount = postAuthUsers.length;
    const user1Auth = await auth.getUser('user_1');
    const user1Claims = user1Auth.customClaims || {};

    const claimsPass = (user1Claims.role === 'super_admin' && user1Claims.user_type === 'system' && Number(user1Claims.mysql_id) === 1);
    
    const user1FirestoreDoc = await db.collection('users').doc('user_1').get();
    const firestoreUser1Pass = user1FirestoreDoc.exists && user1FirestoreDoc.data().user_uid === 'user_1';

    let postStaffSuperAdminCount = 0;
    for (let i = 1; i <= 11; i++) {
      const u = postAuthUsers.find(x => x.uid === `staff_${i}`);
      if (u?.customClaims?.role === 'super_admin') postStaffSuperAdminCount++;
    }
    const staffIsolationPass = (postStaffSuperAdminCount === 0);

    const postRoomsSnap = await db.collection('rooms').get();
    const postRoomTypesSnap = await db.collection('room_types').get();
    const postStaffSnap = await db.collection('staff').get();
    const postGuestsSnap = await db.collection('guests').get();

    const firestoreIntegrityPass = (postRoomsSnap.size === 17 && postRoomTypesSnap.size === 3 && postStaffSnap.size === 11 && postGuestsSnap.size === 4);

    const [[{ post_users }]] = await connection.query('SELECT COUNT(*) as post_users FROM users');
    const [[{ post_staff }]] = await connection.query('SELECT COUNT(*) as post_staff FROM staff');
    const [[{ post_guests }]] = await connection.query('SELECT COUNT(*) as post_guests FROM guests');

    const mysqlIntegrityPass = (post_users === 25 && post_staff === 11 && post_guests === 4);

    const healthRes = await makeHealthRequest();
    const healthPass = (healthRes.status === 200);

    const finalPass = (authAfterCount === 12) && claimsPass && firestoreUser1Pass && staffIsolationPass && firestoreIntegrityPass && mysqlIntegrityPass && healthPass;

    console.log('=================================================');
    console.log('SUPER ADMIN PROVISIONING RESULT');
    console.log('=================================================');
    console.log(`Firebase Auth Before        : ${authBeforeCount}`);
    console.log(`Firebase Auth After         : ${authAfterCount}`);
    console.log(`UID                         : user_1`);
    console.log(`Email                       : admin@hpms-sky5.internal`);
    console.log(`Claims                      : ${claimsPass ? 'PASS' : 'FAIL'}`);
    console.log(`Firestore /users/user_1     : ${firestoreUser1Pass ? 'PASS' : 'FAIL'}`);
    console.log(`Staff Super Admin Isolation : ${staffIsolationPass ? 'PASS' : 'FAIL'}`);
    console.log(`Firestore Integrity         : ${firestoreIntegrityPass ? 'PASS' : 'FAIL'}`);
    console.log(`MySQL Integrity             : ${mysqlIntegrityPass ? 'PASS' : 'FAIL'}`);
    console.log(`Credential Exposure         : NONE`);
    console.log(`FINAL STATUS                : ${finalPass ? 'PASS' : 'FAIL'}`);
    console.log('=================================================\n');

    if (!finalPass) process.exit(1);

  } catch (err) {
    console.error('\n❌ [Provisioning Error]:', err.message);
    if (authUserCreated) {
      console.error(' ⚠️ Note: Firebase Auth user_1 was created prior to error. Inspect state safely before retrying.');
    }
    process.exit(1);
  } finally {
    if (connection) connection.release();
  }
}

provisionSuperAdmin();
