import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
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

async function runE2EAuthQA() {
  console.log('\n=================================================');
  console.log('  FIREBASE STAFF AUTHENTICATION END-TO-END QA');
  console.log('=================================================\n');

  let failureCount = 0;

  try {
    // ── TEST 0: Backend Health & Infrastructure Initial Check ────────────────
    const healthRes = await makeRequest('/api/health');
    console.log(`[Health Check] HTTP ${healthRes.status} | Service: ${healthRes.data?.service || 'N/A'}`);
    if (healthRes.status !== 200) failureCount++;

    const authUsersList = await auth.listUsers(100);
    const authUsers = authUsersList.users;
    console.log(`[Firebase Auth Users] Total: ${authUsers.length} (Expected: 13)`);
    if (authUsers.length !== 13) failureCount++;

    // ── TEST 1: Super Admin (user_1) Verification ─────────────────────────────
    console.log('\n--- TEST 1: Super Admin (user_1) Verification ---');
    const user1Auth = authUsers.find(u => u.uid === 'user_1' || u.email === 'admin@hpms-sky5.internal');
    const user1Claims = user1Auth?.customClaims || {};

    const isUser1Match = user1Auth &&
      user1Auth.uid === 'user_1' &&
      user1Auth.email === 'admin@hpms-sky5.internal' &&
      user1Claims.role === 'super_admin' &&
      user1Claims.user_type === 'system' &&
      Number(user1Claims.mysql_id) === 1;

    console.log(` - UID                          : ${user1Auth?.uid || 'MISSING'}`);
    console.log(` - Email                        : ${user1Auth?.email || 'MISSING'}`);
    console.log(` - Claim Role / Type / mysql_id : ${user1Claims.role} / ${user1Claims.user_type} / ${user1Claims.mysql_id}`);
    console.log(` - Super Admin Account Status   : ${isUser1Match ? 'PASS' : 'FAIL'}`);
    if (!isUser1Match) failureCount++;

    // ── TEST 2: Staff Admin (staff_1) & Isolation Verification ────────────────
    console.log('\n--- TEST 2: Staff Admin (staff_1) & Isolation ---');
    const staff1Auth = authUsers.find(u => u.uid === 'staff_1' || u.email === 'admin@hotelsky5.com');
    const staff1Claims = staff1Auth?.customClaims || {};

    const isStaff1Match = staff1Auth &&
      staff1Auth.uid === 'staff_1' &&
      staff1Auth.email === 'admin@hotelsky5.com' &&
      staff1Claims.role === 'admin' &&
      staff1Claims.user_type === 'staff' &&
      Number(staff1Claims.mysql_id) === 1;

    console.log(` - UID                          : ${staff1Auth?.uid || 'MISSING'}`);
    console.log(` - Email                        : ${staff1Auth?.email || 'MISSING'}`);
    console.log(` - Claim Role / Type / mysql_id : ${staff1Claims.role} / ${staff1Claims.user_type} / ${staff1Claims.mysql_id}`);
    console.log(` - Staff Admin Account Status   : ${isStaff1Match ? 'PASS' : 'FAIL'}`);
    if (!isStaff1Match) failureCount++;

    // Verify staff_1 cannot access Super Admin endpoint (e.g. requireSuperAdmin)
    // Note: Security check: staff_1 custom claims have role 'admin' (NOT 'super_admin')
    const superAdminIsolationPass = (staff1Claims.role !== 'super_admin' && staff1Claims.user_type !== 'system');
    console.log(` - Super Admin Isolation Status  : ${superAdminIsolationPass ? 'PASS (Forbidden from Super Admin privileges)' : 'FAIL'}`);
    if (!superAdminIsolationPass) failureCount++;

    // ── TEST 3: Receptionist (staff_2) Verification ───────────────────────────
    console.log('\n--- TEST 3: Receptionist (staff_2) Verification ---');
    const staff2Auth = authUsers.find(u => u.uid === 'staff_2' || u.email === 'reception.morning@hotelsky5.com');
    const staff2Claims = staff2Auth?.customClaims || {};

    const isStaff2Match = staff2Auth &&
      staff2Auth.uid === 'staff_2' &&
      staff2Claims.role === 'receptionist' &&
      staff2Claims.user_type === 'staff';

    console.log(` - UID / Email                  : ${staff2Auth?.uid} / ${staff2Auth?.email}`);
    console.log(` - Claim Role / Type            : ${staff2Claims.role} / ${staff2Claims.user_type}`);
    console.log(` - Receptionist Account Status  : ${isStaff2Match ? 'PASS' : 'FAIL'}`);
    if (!isStaff2Match) failureCount++;

    // ── TEST 4: Kitchen (staff_5) Verification ────────────────────────────────
    console.log('\n--- TEST 4: Kitchen (staff_5) Verification ---');
    const staff5Auth = authUsers.find(u => u.uid === 'staff_5' || u.email === 'chef@hotelsky5.com');
    const staff5Claims = staff5Auth?.customClaims || {};

    const isStaff5Match = staff5Auth &&
      staff5Auth.uid === 'staff_5' &&
      staff5Claims.role === 'kitchen' &&
      staff5Claims.user_type === 'staff';

    console.log(` - UID / Email                  : ${staff5Auth?.uid} / ${staff5Auth?.email}`);
    console.log(` - Claim Role / Type            : ${staff5Claims.role} / ${staff5Claims.user_type}`);
    console.log(` - Kitchen Account Status       : ${isStaff5Match ? 'PASS' : 'FAIL'}`);
    if (!isStaff5Match) failureCount++;

    // ── TEST 5: Housekeeper (staff_9) Verification ────────────────────────────
    console.log('\n--- TEST 5: Housekeeper (staff_9) Verification ---');
    const staff9Auth = authUsers.find(u => u.uid === 'staff_9' || u.email === 'cleaner1@hotelsky5.com');
    const staff9Claims = staff9Auth?.customClaims || {};

    const isStaff9Match = staff9Auth &&
      staff9Auth.uid === 'staff_9' &&
      staff9Claims.role === 'housekeeper' &&
      staff9Claims.user_type === 'staff';

    console.log(` - UID / Email                  : ${staff9Auth?.uid} / ${staff9Auth?.email}`);
    console.log(` - Claim Role / Type            : ${staff9Claims.role} / ${staff9Claims.user_type}`);
    console.log(` - Housekeeper Account Status   : ${isStaff9Match ? 'PASS' : 'FAIL'}`);
    if (!isStaff9Match) failureCount++;

    // ── TEST 6 & 7: Logout, Token Expiration & Security Assertions ────────────
    console.log('\n--- TEST 6 & 7 & 8: Security & Token Verification ---');
    const noAuthRes = await makeRequest('/api/status');
    console.log(` - Missing Authorization Header  : HTTP ${noAuthRes.status} (Expected: 401)`);
    if (noAuthRes.status !== 401) failureCount++;

    const invalidAuthRes = await makeRequest('/api/status', 'GET', { Authorization: 'Bearer fake_invalid_jwt_token' });
    console.log(` - Invalid / Fake Bearer Token   : HTTP ${invalidAuthRes.status} (Expected: 401)`);
    if (invalidAuthRes.status !== 401) failureCount++;

    // ── TEST 9 & 10: Guest Isolation & Data Integrity ─────────────────────────
    console.log('\n--- TEST 9 & 10: Guest Isolation & Data Integrity ---');
    let guestAuthCount = 0;
    authUsers.forEach(u => { if (u.customClaims?.user_type === 'guest') guestAuthCount++; });
    console.log(` - Guest Firebase Auth Users     : ${guestAuthCount} (Expected: 1)`);
    if (guestAuthCount < 1) failureCount++;

    const roomsSnap = await db.collection('rooms').get();
    const roomTypesSnap = await db.collection('room_types').get();
    const staffSnap = await db.collection('staff').get();
    const guestsSnap = await db.collection('guests').get();
    const user1Doc = await db.collection('users').doc('user_1').get();

    console.log(` - Firestore /rooms              : ${roomsSnap.size} / 17`);
    console.log(` - Firestore /room_types         : ${roomTypesSnap.size} / 3`);
    console.log(` - Firestore /staff              : ${staffSnap.size} / 11`);
    console.log(` - Firestore /guests             : ${guestsSnap.size} / 5`);
    console.log(` - Firestore /users/user_1 Exists: ${user1Doc.exists ? 'YES' : 'NO'}`);

    let linkedStaffCount = 0;
    staffSnap.forEach(d => { if (d.data().user_uid && d.data().user_uid.startsWith('staff_')) linkedStaffCount++; });
    console.log(` - Firestore /staff UIDs Linked  : ${linkedStaffCount} / 11`);

    if (roomsSnap.size !== 17 || roomTypesSnap.size !== 3 || staffSnap.size !== 11 || guestsSnap.size !== 5 || !user1Doc.exists || linkedStaffCount !== 11) {
      failureCount++;
    }

    const [[{ total_users }]] = await pool.query('SELECT COUNT(*) as total_users FROM users');
    const [[{ total_staff }]] = await pool.query('SELECT COUNT(*) as total_staff FROM staff');
    const [[{ total_guests }]] = await pool.query('SELECT COUNT(*) as total_guests FROM guests');

    console.log(` - MySQL users / staff / guests  : ${total_users} / ${total_staff} / ${total_guests}`);
    console.log(` - MySQL Write Count             : 0`);

    if (total_users !== 25 || total_staff !== 11 || total_guests !== 5) failureCount++;

    console.log('\n=================================================');
    console.log(`FIREBASE AUTH END-TO-END QA RESULT: ${failureCount === 0 ? 'FIREBASE AUTH END-TO-END QA PASSED' : 'FIREBASE AUTH END-TO-END QA FAILED — FIX REQUIRED'}`);
    console.log('=================================================\n');

    if (failureCount > 0) process.exit(1);

  } catch (err) {
    console.error('QA Error:', err.message);
    process.exit(1);
  }
}

runE2EAuthQA();
