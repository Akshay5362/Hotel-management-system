import dotenv from 'dotenv';
dotenv.config();
process.env.ENABLE_FIREBASE_AUTH = 'true';

import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { ensureGuestLazyAuthMigration } from '../backend/controllers/authController.js';
import http from 'http';

function makeRequest(path, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch (e) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testGuestLazyAuth() {
  console.log('\n=================================================');
  console.log('  PHASE 1: GUEST LAZY AUTH MIGRATION TEST SUITE');
  console.log('=================================================\n');

  let failureCount = 0;

  try {
    // 1. Fetch test customer user (users.id = 6, username = 'akshay')
    const [userRows] = await pool.query("SELECT id, username, fullName, phone, role_id FROM users WHERE username = 'akshay' LIMIT 1");
    if (userRows.length === 0) {
      throw new Error('Test customer account user.id = 6 not found in MySQL.');
    }
    const testUser = {
      id: userRows[0].id,
      username: userRows[0].username,
      fullName: userRows[0].fullName,
      phone: userRows[0].phone,
      role: 'guest'
    };

    console.log(`[Test User] ID: ${testUser.id}, Username: '${testUser.username}', FullName: '${testUser.fullName}'`);

    // 2. Execute First Lazy Migration Trigger
    console.log('\n--- 1. Executing First Guest Lazy Auth Migration Trigger ---');
    await ensureGuestLazyAuthMigration(testUser, 'TestPassword123!');

    // 3. Verify MySQL guest row created/linked
    const [guestRows] = await pool.query('SELECT id, full_name, user_id FROM guests WHERE user_id = ?', [testUser.id]);
    console.log(` - MySQL Guests Table Row Count : ${guestRows.length} (Expected: 1)`);
    if (guestRows.length !== 1) failureCount++;

    const mysqlGuestId = guestRows[0].id;
    console.log(` - Created MySQL Guest ID       : ${mysqlGuestId}`);

    // 4. Verify Firebase Auth User
    const expectedUid = `guest_${testUser.id}`;
    const authUser = await auth.getUser(expectedUid);
    const claims = authUser.customClaims || {};

    console.log(` - Firebase Auth UID             : ${authUser.uid} (Expected: '${expectedUid}')`);
    console.log(` - Custom Claims                 : role='${claims.role}', user_type='${claims.user_type}', mysql_id=${claims.mysql_id}`);

    const isClaimsValid = claims.role === 'guest' && claims.user_type === 'guest' && Number(claims.mysql_id) === testUser.id;
    if (!isClaimsValid) failureCount++;

    // 5. Verify Firestore Document /guests/guest_${mysqlGuestId}
    const docSnap = await db.collection('guests').doc(`guest_${mysqlGuestId}`).get();
    console.log(` - Firestore Doc /guests/guest_${mysqlGuestId} Exists : ${docSnap.exists ? 'YES' : 'NO'}`);
    if (!docSnap.exists) failureCount++;

    const docData = docSnap.data() || {};
    console.log(` - Firestore Doc user_uid        : '${docData.user_uid}' (Expected: '${expectedUid}')`);
    if (docData.user_uid !== expectedUid) failureCount++;

    // 6. Idempotency Test (Second Migration Trigger Call)
    console.log('\n--- 2. Executing Second Guest Lazy Auth Trigger (Idempotency Check) ---');
    await ensureGuestLazyAuthMigration(testUser, 'TestPassword123!');

    const [postGuestRows] = await pool.query('SELECT id FROM guests WHERE user_id = ?', [testUser.id]);
    console.log(` - MySQL Guests Table Row Count AFTER : ${postGuestRows.length} (Expected: 1)`);
    if (postGuestRows.length !== 1) failureCount++;

    const postAuthUser = await auth.getUser(expectedUid);
    console.log(` - Firebase Auth User Exists AFTER    : YES (${postAuthUser.uid})`);

    // 7. Security / RBAC Route Protection Test
    console.log('\n--- 3. Testing RBAC Route Security Assertions ---');
    const noTokenRes = await makeRequest('/api/dayend', 'POST');
    console.log(` - Missing Token on POST /api/dayend                    : HTTP ${noTokenRes.status} (Expected: 401)`);
    if (noTokenRes.status !== 401) failureCount++;

    const invalidTokenRes = await makeRequest('/api/dayend', 'POST', { Authorization: 'Bearer fake_invalid_token' });
    console.log(` - Invalid Token on POST /api/dayend                   : HTTP ${invalidTokenRes.status} (Expected: 401)`);
    if (invalidTokenRes.status !== 401) failureCount++;

    // 8. Walk-in Guest & Collection Counts Integrity Verification
    console.log('\n--- 4. Walk-in Guest & Firestore Collection Integrity ---');
    const roomsSnap = await db.collection('rooms').get();
    const roomTypesSnap = await db.collection('room_types').get();
    const staffSnap = await db.collection('staff').get();
    const guestsSnap = await db.collection('guests').get();

    console.log(` - Firestore /rooms      : ${roomsSnap.size} / 17`);
    console.log(` - Firestore /room_types : ${roomTypesSnap.size} / 3`);
    console.log(` - Firestore /staff      : ${staffSnap.size} / 11`);
    console.log(` - Firestore /guests     : ${guestsSnap.size} / 5 (14 walk-in docs + 1 newly migrated guest doc)`);

    let walkinNullUidCount = 0;
    for (let id = 11; id <= 14; id++) {
      const walkinDoc = await db.collection('guests').doc(`guest_${id}`).get();
      if (walkinDoc.exists && walkinDoc.data().user_uid === null) walkinNullUidCount++;
    }
    console.log(` - Walk-in Guests 11–14 user_uid === null Count : ${walkinNullUidCount} / 4`);
    if (walkinNullUidCount !== 4) failureCount++;

    console.log('\n=================================================');
    console.log(`PHASE 1 LAZY AUTH RESULT: ${failureCount === 0 ? 'PHASE 1 GUEST LAZY AUTH VERIFIED' : 'PHASE 1 FAILED'}`);
    console.log('=================================================\n');

    if (failureCount > 0) process.exit(1);

  } catch (err) {
    console.error('Test Suite Error:', err.message);
    process.exit(1);
  }
}

testGuestLazyAuth();
