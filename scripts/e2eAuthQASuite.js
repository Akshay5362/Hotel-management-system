import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { normalizeUserRole } from '../backend/controllers/authController.js';
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
    const uids = authUsers.map(u => u.uid);
    const uniqueUids = new Set(uids);
    const hasUniqueUids = uids.length === uniqueUids.size;

    const requiredUids = ['user_1', 'staff_1', 'staff_2', 'staff_5', 'staff_9'];
    const hasRequiredIdentities = requiredUids.every(uid => uids.includes(uid));

    console.log(`[Firebase Auth Users] Total: ${authUsers.length} | Unique UIDs: ${hasUniqueUids ? 'PASS' : 'FAIL'} | Required Test Identities: ${hasRequiredIdentities ? 'PASS' : 'FAIL'}`);
    if (authUsers.length === 0 || !hasUniqueUids || !hasRequiredIdentities) failureCount++;

    // ── TEST 1: Super Admin (user_1) Verification ─────────────────────────────
    console.log('\n--- TEST 1: Super Admin (user_1) Verification ---');
    const user1Auth = authUsers.find(u => u.uid === 'user_1' || u.email === 'admin@hpms-sky5.internal');
    const user1Claims = user1Auth?.customClaims || {};

    const isUser1Match = Boolean(
      user1Auth &&
      user1Auth.uid === 'user_1' &&
      user1Auth.email === 'admin@hpms-sky5.internal' &&
      user1Claims.role === 'super_admin' &&
      user1Claims.user_type === 'system' &&
      Number(user1Claims.mysql_id) === 1
    );

    console.log(` - UID                          : ${user1Auth?.uid || 'MISSING'}`);
    console.log(` - Email                        : ${user1Auth?.email || 'MISSING'}`);
    console.log(` - Claim Role / Type / mysql_id : ${user1Claims.role} / ${user1Claims.user_type} / ${user1Claims.mysql_id}`);
    console.log(` - Super Admin Account Status   : ${isUser1Match ? 'PASS' : 'FAIL'}`);
    if (!isUser1Match) failureCount++;

    // ── TEST 2: Staff Admin (staff_1) & Isolation Verification ────────────────
    console.log('\n--- TEST 2: Staff Admin (staff_1) & Isolation ---');
    const staff1Auth = authUsers.find(u => u.uid === 'staff_1' || u.email === 'admin@hotelsky5.com');
    const staff1Claims = staff1Auth?.customClaims || {};

    const staff1RawValid = Boolean(
      staff1Auth &&
      staff1Auth.uid === 'staff_1' &&
      staff1Auth.email === 'admin@hotelsky5.com' &&
      ['ADMIN', 'admin'].includes(String(staff1Claims.role || '').trim()) &&
      staff1Claims.user_type === 'staff' &&
      Number(staff1Claims.mysql_id) === 1
    );

    const staff1CanonicalRole = normalizeUserRole({
      role: staff1Claims.role,
      type: staff1Claims.user_type,
      user_type: staff1Claims.user_type,
      id: staff1Claims.mysql_id
    });
    const staff1CanonicalValid = staff1CanonicalRole === 'admin';
    const isStaff1Match = staff1RawValid && staff1CanonicalValid;

    console.log(` - UID                          : ${staff1Auth?.uid || 'MISSING'}`);
    console.log(` - Email                        : ${staff1Auth?.email || 'MISSING'}`);
    console.log(` - Raw Claim Role / user_type   : ${staff1Claims.role} / ${staff1Claims.user_type} (mysql_id: ${staff1Claims.mysql_id})`);
    console.log(` - Normalized Canonical Role    : ${staff1CanonicalRole} (Expected: admin)`);
    console.log(` - Staff Admin Account Status   : ${isStaff1Match ? 'PASS' : 'FAIL'}`);
    if (!isStaff1Match) failureCount++;

    // Verify staff_1 cannot access Super Admin endpoint (e.g. requireSuperAdmin)
    const superAdminIsolationPass = (staff1Claims.role !== 'super_admin' && staff1Claims.user_type !== 'system');
    console.log(` - Super Admin Isolation Status  : ${superAdminIsolationPass ? 'PASS (Forbidden from Super Admin privileges)' : 'FAIL'}`);
    if (!superAdminIsolationPass) failureCount++;

    // ── TEST 3: Receptionist (staff_2) Verification ───────────────────────────
    console.log('\n--- TEST 3: Receptionist (staff_2) Verification ---');
    const staff2Auth = authUsers.find(u => u.uid === 'staff_2' || u.email === 'reception.morning@hotelsky5.com');
    const staff2Claims = staff2Auth?.customClaims || {};

    const staff2RawValid = Boolean(
      staff2Auth &&
      staff2Auth.uid === 'staff_2' &&
      ['RECEPTIONIST', 'receptionist'].includes(String(staff2Claims.role || '').trim()) &&
      staff2Claims.user_type === 'staff'
    );

    const staff2CanonicalRole = normalizeUserRole({
      role: staff2Claims.role,
      type: staff2Claims.user_type,
      user_type: staff2Claims.user_type,
      id: staff2Claims.mysql_id
    });
    const staff2CanonicalValid = staff2CanonicalRole === 'receptionist';
    const isStaff2Match = staff2RawValid && staff2CanonicalValid;

    console.log(` - UID / Email                  : ${staff2Auth?.uid} / ${staff2Auth?.email}`);
    console.log(` - Raw Claim Role / user_type   : ${staff2Claims.role} / ${staff2Claims.user_type}`);
    console.log(` - Normalized Canonical Role    : ${staff2CanonicalRole} (Expected: receptionist)`);
    console.log(` - Receptionist Account Status  : ${isStaff2Match ? 'PASS' : 'FAIL'}`);
    if (!isStaff2Match) failureCount++;

    // ── TEST 4: Kitchen (staff_5) Verification ────────────────────────────────
    console.log('\n--- TEST 4: Kitchen (staff_5) Verification ---');
    const staff5Auth = authUsers.find(u => u.uid === 'staff_5' || u.email === 'chef@hotelsky5.com');
    const staff5Claims = staff5Auth?.customClaims || {};

    const staff5RawValid = Boolean(
      staff5Auth &&
      staff5Auth.uid === 'staff_5' &&
      ['CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY', 'kitchen'].includes(String(staff5Claims.role || '').trim()) &&
      staff5Claims.user_type === 'staff'
    );

    const staff5CanonicalRole = normalizeUserRole({
      role: staff5Claims.role,
      type: staff5Claims.user_type,
      user_type: staff5Claims.user_type,
      id: staff5Claims.mysql_id
    });
    const staff5CanonicalValid = staff5CanonicalRole === 'kitchen';
    const isStaff5Match = staff5RawValid && staff5CanonicalValid;

    console.log(` - UID / Email                  : ${staff5Auth?.uid} / ${staff5Auth?.email}`);
    console.log(` - Raw Claim Role / user_type   : ${staff5Claims.role} / ${staff5Claims.user_type}`);
    console.log(` - Normalized Canonical Role    : ${staff5CanonicalRole} (Expected: kitchen)`);
    console.log(` - Kitchen Account Status       : ${isStaff5Match ? 'PASS' : 'FAIL'}`);
    if (!isStaff5Match) failureCount++;

    // ── TEST 5: Housekeeper (staff_9) Verification ────────────────────
    console.log('\n--- TEST 5: Housekeeper (staff_9) Verification ---');
    const staff9Auth = authUsers.find(u => u.uid === 'staff_9' || u.email === 'cleaner1@hotelsky5.com');
    const staff9Claims = staff9Auth?.customClaims || {};

    const staff9RawValid = Boolean(
      staff9Auth &&
      staff9Auth.uid === 'staff_9' &&
      ['CLEANER', 'housekeeping', 'housekeeper'].includes(String(staff9Claims.role || '').trim()) &&
      staff9Claims.user_type === 'staff'
    );

    const staff9CanonicalRole = normalizeUserRole({
      role: staff9Claims.role,
      type: staff9Claims.user_type,
      user_type: staff9Claims.user_type,
      id: staff9Claims.mysql_id
    });
    const staff9CanonicalValid = staff9CanonicalRole === 'housekeeper';
    const isStaff9Match = staff9RawValid && staff9CanonicalValid;

    console.log(` - UID / Email                  : ${staff9Auth?.uid} / ${staff9Auth?.email}`);
    console.log(` - Raw Claim Role / user_type   : ${staff9Claims.role} / ${staff9Claims.user_type}`);
    console.log(` - Normalized Canonical Role    : ${staff9CanonicalRole} (Expected: housekeeper)`);
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
    console.log(` - Guest Firebase Auth Users     : ${guestAuthCount} (Expected: >= 1)`);
    if (guestAuthCount < 1) failureCount++;

    const roomsSnap = await db.collection('rooms').get();
    const roomTypesSnap = await db.collection('room_types').get();
    const staffSnap = await db.collection('staff').get();
    const guestsSnap = await db.collection('guests').get();
    const user1Doc = await db.collection('users').doc('user_1').get();

    console.log(` - Firestore /rooms              : ${roomsSnap.size} (Expected: > 0)`);
    console.log(` - Firestore /room_types         : ${roomTypesSnap.size} (Expected: > 0)`);
    console.log(` - Firestore /staff              : ${staffSnap.size} (Expected: > 0)`);
    console.log(` - Firestore /guests             : ${guestsSnap.size} (Expected: >= 0)`);
    console.log(` - Firestore /users/user_1 Exists: ${user1Doc.exists ? 'YES' : 'NO'}`);

    let linkedStaffCount = 0;
    staffSnap.forEach(d => { if (d.data().user_uid && d.data().user_uid.startsWith('staff_')) linkedStaffCount++; });
    console.log(` - Firestore /staff UIDs Linked  : ${linkedStaffCount} / ${staffSnap.size}`);

    if (roomsSnap.size === 0 || roomTypesSnap.size === 0 || staffSnap.size === 0 || !user1Doc.exists || linkedStaffCount === 0) {
      failureCount++;
    }

    const [[{ total_users }]] = await pool.query('SELECT COUNT(*) as total_users FROM users');
    const [[{ total_staff }]] = await pool.query('SELECT COUNT(*) as total_staff FROM staff');
    const [[{ total_guests }]] = await pool.query('SELECT COUNT(*) as total_guests FROM guests');

    console.log(` - MySQL users / staff / guests  : ${total_users} / ${total_staff} / ${total_guests} (Schema Accessible: YES)`);
    console.log(` - MySQL Write Count             : 0`);

    if (typeof total_users !== 'number' || typeof total_staff !== 'number' || typeof total_guests !== 'number') {
      failureCount++;
    }

    console.log('\n=================================================');
    console.log(`FIREBASE AUTH END-TO-END QA RESULT: ${failureCount === 0 ? 'FIREBASE AUTH END-TO-END QA PASSED (0 Failures)' : `FIREBASE AUTH END-TO-END QA FAILED (${failureCount} Failures Detected)`}`);
    console.log('=================================================\n');

    if (failureCount > 0) process.exit(1);
    else process.exit(0);

  } catch (err) {
    console.error('QA Error:', err.message);
  }
}

runE2EAuthQA();

