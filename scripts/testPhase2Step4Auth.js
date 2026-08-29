import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { verifyFirebaseAuth } from '../backend/middleware/firebaseAuthMiddleware.js';
import http from 'http';

function makeHttpPost(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
    });
    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    req.write(payload);
    req.end();
  });
}

function makeHttpGet(path, token) {
  return new Promise((resolve) => {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path,
      method: 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
    });
    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    req.end();
  });
}

async function runAuthTests() {
  console.log('\n========================================================================================');
  console.log('                 PHASE 2 STEP 4 FIREBASE AUTHENTICATION TEST SUITE');
  console.log('========================================================================================\n');

  if (!isFirebaseConfigured || !db || !auth) {
    console.error('❌ Firebase Admin SDK is not properly initialized.');
    process.exit(1);
  }

  let totalTests = 0;
  let passedTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✔ [PASS] ${message}`);
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
    }
  }

  try {
    // ── SECTION A: Firebase Auth Users & Custom Claims Audit ─────────────────
    console.log('[SECTION A] Firebase Auth Users & Custom Claims Audit...');
    const user1Auth = await auth.getUser('user_1');
    assert(user1Auth && user1Auth.email === 'admin@hpms-sky5.internal', 'user_1 exists in Firebase Auth with expected email');
    assert(user1Auth.customClaims?.role === 'super_admin' && Number(user1Auth.customClaims?.mysql_id) === 1, 'user_1 has custom claims { role: super_admin, mysql_id: 1 }');

    const user2Auth = await auth.getUser('user_2');
    assert(user2Auth && user2Auth.email === 'keval@hpms-sky5.internal', 'user_2 (keval) exists in Firebase Auth with expected email');
    assert(user2Auth.customClaims?.role === 'admin' && Number(user2Auth.customClaims?.mysql_id) === 2, 'user_2 has custom claims { role: admin, mysql_id: 2 }');

    const guest6Auth = await auth.getUser('guest_6');
    assert(guest6Auth && guest6Auth.customClaims?.role === 'guest', 'guest_6 remains intact in Firebase Auth');

    let staffAuthCount = 0;
    for (let i = 1; i <= 11; i++) {
      try {
        const u = await auth.getUser(`staff_${i}`);
        if (u) staffAuthCount++;
      } catch (e) {}
    }
    assert(staffAuthCount === 11, 'All 11 staff accounts (staff_1..staff_11) exist in Firebase Auth');

    // ── SECTION B: Firestore /users Collection Audit ──────────────────────────
    console.log('\n[SECTION B] Firestore /users Collection Audit...');
    const u1Doc = await db.collection('users').doc('user_1').get();
    assert(u1Doc.exists && u1Doc.data().mysql_user_id === 1, '/users/user_1 document exists with mysql_user_id: 1');
    assert(!('password' in (u1Doc.data() || {})) && !('password_hash' in (u1Doc.data() || {})), '/users/user_1 contains NO password or hash fields');

    const u2Doc = await db.collection('users').doc('user_2').get();
    assert(u2Doc.exists && u2Doc.data().mysql_user_id === 2 && u2Doc.data().username === 'keval', '/users/user_2 document exists with mysql_user_id: 2 and username: keval');
    assert(!('password' in (u2Doc.data() || {})) && !('password_hash' in (u2Doc.data() || {})), '/users/user_2 contains NO password or hash fields');

    // ── SECTION C: Firestore /staff Collection Audit ──────────────────────────
    console.log('\n[SECTION C] Firestore /staff Collection Audit...');
    let staffDocCount = 0;
    let staffUidParityCount = 0;
    let staffNoPasswordCount = 0;

    for (let i = 1; i <= 11; i++) {
      const sDoc = await db.collection('staff').doc(`staff_${i}`).get();
      if (sDoc.exists) {
        staffDocCount++;
        const d = sDoc.data();
        if (d.user_uid === `staff_${i}` && d.mysql_staff_id === i) staffUidParityCount++;
        if (!('password' in d) && !('password_hash' in d) && !('passwordHash' in d)) staffNoPasswordCount++;
      }
    }
    assert(staffDocCount === 11, 'Firestore /staff contains all 11 staff documents (staff_1..staff_11)');
    assert(staffUidParityCount === 11, 'All 11 /staff documents have exact user_uid & mysql_staff_id parity');
    assert(staffNoPasswordCount === 11, 'All 11 /staff documents contain NO sensitive password fields');

    // ── SECTION D: Middleware & Dual Auth Resolution ─────────────────────────
    console.log('\n[SECTION D] Middleware & Dual Auth Resolution...');
    const fakeReq = {
      headers: { authorization: 'Bearer invalid.test.token' }
    };
    const fakeRes = {
      status: function(code) { this.statusCode = code; return this; },
      json: function(data) { this.body = data; return this; }
    };

    let nextCalled = false;
    await verifyFirebaseAuth(fakeReq, fakeRes, () => { nextCalled = true; });
    assert(fakeRes.statusCode === 401 && !nextCalled, 'verifyFirebaseAuth middleware correctly rejects invalid tokens with HTTP 401');

    // ── SECTION E: Legacy MySQL Authentication & Live HTTP Endpoint Testing ─────
    console.log('\n[SECTION E] Legacy MySQL Authentication & Live HTTP Endpoint Testing...');
    
    // Admin user signin
    const adminLoginRes = await makeHttpPost('/api/auth/signin', { username: 'admin', password: 'admin123' });
    assert(adminLoginRes.status === 200 && adminLoginRes.body.token, 'Live HTTP POST /api/auth/signin succeeds for admin (user_1)');

    // Keval user signin
    const kevalLoginRes = await makeHttpPost('/api/auth/signin', { username: 'keval', password: 'keval123' });
    assert(kevalLoginRes.status === 200 && kevalLoginRes.body.token, 'Live HTTP POST /api/auth/signin succeeds for keval (user_2)');

    // Access protected route /api/status with token
    const statusRes = await makeHttpGet('/api/status', adminLoginRes.body.token);
    assert(statusRes.status === 200 && statusRes.body && Array.isArray(statusRes.body.rooms), 'Protected HTTP GET /api/status succeeds with token');

    // ── SECTION F: Negative & Security Tests ──────────────────────────────────
    console.log('\n[SECTION F] Negative & Security Tests...');

    // Invalid password
    const badPassRes = await makeHttpPost('/api/auth/signin', { username: 'admin', password: 'wrongpassword' });
    assert(badPassRes.status === 400 || badPassRes.status === 401, 'Invalid password rejected with 400/401');

    // Non-existent user
    const nonExistentRes = await makeHttpPost('/api/auth/signin', { username: 'nonexistentuser999', password: 'password123' });
    assert(nonExistentRes.status === 400 || nonExistentRes.status === 401, 'Non-existent user signin rejected');

    // Missing token GET /api/status
    const noTokenRes = await makeHttpGet('/api/status', null);
    assert(noTokenRes.status === 401, 'Protected route /api/status rejects request with missing Authorization header');

    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Test Execution Error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runAuthTests();
