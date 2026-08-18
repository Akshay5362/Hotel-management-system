/**
 * Controlled Firebase Auth Provisioning: User Keval
 * =================================================
 * Idempotently provisions MySQL user 'keval' (id: 2) into Firebase Auth
 * and Firestore collection /users/user_2.
 *
 * Safety Rules:
 *  - ZERO MySQL writes.
 *  - ZERO password/hash fields written to Firestore.
 *  - Idempotent execution (safe to re-run).
 */

import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';

async function provisionKeval() {
  console.log('\n=================================================');
  console.log('  PROVISIONING FIREBASE AUTH USER: KEVAL (id: 2)');
  console.log('=================================================\n');

  if (!isFirebaseConfigured || !auth || !db) {
    throw new Error('Firebase Admin SDK is not initialized.');
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // 1. Fetch user record from MySQL
    const [userRows] = await connection.query(
      'SELECT id, username, fullName, phone FROM users WHERE id = 2 OR username = "keval"'
    );

    if (userRows.length === 0) {
      throw new Error('MySQL user "keval" (id: 2) not found in users table.');
    }

    const mysqlUser = userRows[0];
    console.log(`[MySQL Found] ID: ${mysqlUser.id}, Username: '${mysqlUser.username}', Name: '${mysqlUser.fullName}'`);

    const deterministicUid = 'user_2';
    const emailToUse = 'keval@hpms-sky5.internal';

    // 2. Firebase Auth Provisioning (Idempotent)
    let authUser = null;
    try {
      authUser = await auth.getUser(deterministicUid);
      console.log(`[Firebase Auth] Existing account found by UID '${deterministicUid}'`);
    } catch {
      try {
        authUser = await auth.getUserByEmail(emailToUse);
        console.log(`[Firebase Auth] Existing account found by Email '${emailToUse}'`);
      } catch {
        const tempPassword = process.env.KEVAL_TEMP_PASSWORD || 'KevalTempPass2026!';
        authUser = await auth.createUser({
          uid: deterministicUid,
          email: emailToUse,
          emailVerified: true,
          password: tempPassword,
          displayName: mysqlUser.fullName || 'KEVAL PATEL',
          disabled: false
        });
        console.log(`[Firebase Auth] Created new user UID '${authUser.uid}' (${emailToUse})`);
      }
    }

    // 3. Custom Claims Verification & Update
    const expectedClaims = {
      role: 'admin',
      user_type: 'system',
      mysql_id: mysqlUser.id
    };

    const currentClaims = authUser.customClaims || {};
    const claimsCorrect =
      currentClaims.role === expectedClaims.role &&
      currentClaims.user_type === expectedClaims.user_type &&
      Number(currentClaims.mysql_id) === expectedClaims.mysql_id;

    if (!claimsCorrect) {
      await auth.setCustomUserClaims(authUser.uid, expectedClaims);
      console.log('[Firebase Auth] Updated custom claims:', expectedClaims);
    } else {
      console.log('[Firebase Auth] Custom claims already match parity.');
    }

    // 4. Firestore /users/user_2 Document Sync (Idempotent, Zero Passwords)
    const userDocRef = db.collection('users').doc(deterministicUid);
    const docSnap = await userDocRef.get();

    const nowIso = new Date().toISOString();
    const userProfilePayload = {
      mysql_user_id: mysqlUser.id,
      user_uid: authUser.uid,
      email: emailToUse,
      username: String(mysqlUser.username).toLowerCase().trim(),
      full_name: String(mysqlUser.fullName).trim(),
      phone: mysqlUser.phone || null,
      role: 'admin',
      user_type: 'system',
      updated_at: nowIso
    };

    if (!docSnap.exists) {
      userProfilePayload.created_at = nowIso;
      await userDocRef.set(userProfilePayload);
      console.log(`[Firestore] Created document /users/${deterministicUid}`);
    } else {
      await userDocRef.update({
        ...userProfilePayload,
        updated_at: nowIso
      });
      console.log(`[Firestore] Updated document /users/${deterministicUid}`);
    }

    console.log('\n✔ Successfully provisioned/verified user "keval" in Firebase Auth and Firestore /users.\n');

  } catch (err) {
    console.error('❌ Provisioning Failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

provisionKeval();
