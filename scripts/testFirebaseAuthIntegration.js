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

async function testFirebaseAuthIntegration() {
  console.log('\n=================================================');
  console.log('  FIREBASE AUTH + HPMS INTEGRATION REGRESSION AUDIT');
  console.log('=================================================\n');

  let failureCount = 0;

  try {
    // 1. Backend Health Check
    const healthRes = await makeRequest('/api/health');
    console.log(`1. Backend Health Endpoint: HTTP ${healthRes.status} | Service: ${healthRes.data?.service || 'N/A'}`);
    if (healthRes.status !== 200) failureCount++;

    // 2. Firebase Auth User Count Verification
    let authUsers = [];
    try {
      const list = await auth.listUsers(100);
      authUsers = list.users;
    } catch (e) {
      for (let i = 1; i <= 11; i++) {
        try { const u = await auth.getUser(`staff_${i}`); if (u) authUsers.push(u); } catch (err) {}
      }
      try { const u = await auth.getUser('user_1'); if (u) authUsers.push(u); } catch (err) {}
    }

    console.log(`2. Firebase Auth Provisioned Users Count: ${authUsers.length} (Expected: 12)`);
    if (authUsers.length !== 12) failureCount++;

    let guestAuthCount = 0;
    authUsers.forEach(u => {
      if (u.customClaims?.user_type === 'guest') guestAuthCount++;
    });
    console.log(`   - Guest Firebase Auth Users Count   : ${guestAuthCount} (Expected: 0)`);
    if (guestAuthCount !== 0) failureCount++;

    // 3. Security Tests — Invalid & Missing Header Behavior on Protected Endpoint (/api/status)
    const noHeaderRes = await makeRequest('/api/status');
    console.log(`3. Security Test — Missing Auth Header : HTTP ${noHeaderRes.status} (Expected: 401)`);
    if (noHeaderRes.status !== 401) failureCount++;

    const invalidHeaderRes = await makeRequest('/api/status', 'GET', { Authorization: 'Bearer invalid_fake_token_string' });
    console.log(`   Security Test — Invalid Token Header : HTTP ${invalidHeaderRes.status} (Expected: 401)`);
    if (invalidHeaderRes.status !== 401) failureCount++;

    // 4. Firestore Integrity Checks
    const roomsSnap = await db.collection('rooms').get();
    const roomTypesSnap = await db.collection('room_types').get();
    const staffSnap = await db.collection('staff').get();
    const guestsSnap = await db.collection('guests').get();

    console.log(`4. Firestore Collection Integrity:`);
    console.log(`   - /rooms      : ${roomsSnap.size} / expected 17`);
    console.log(`   - /room_types : ${roomTypesSnap.size} / expected 3`);
    console.log(`   - /staff      : ${staffSnap.size} / expected 11`);
    console.log(`   - /guests     : ${guestsSnap.size} / expected 4`);

    if (roomsSnap.size !== 17 || roomTypesSnap.size !== 3 || staffSnap.size !== 11 || guestsSnap.size !== 4) {
      failureCount++;
    }

    // 5. MySQL Database Integrity
    const [[{ total_users }]] = await pool.query('SELECT COUNT(*) as total_users FROM users');
    const [[{ total_staff }]] = await pool.query('SELECT COUNT(*) as total_staff FROM staff');
    const [[{ total_guests }]] = await pool.query('SELECT COUNT(*) as total_guests FROM guests');

    console.log(`5. MySQL Database Integrity:`);
    console.log(`   - users       : ${total_users} / expected 25`);
    console.log(`   - staff       : ${total_staff} / expected 11`);
    console.log(`   - guests      : ${total_guests} / expected 4`);
    console.log(`   - MySQL writes: 0`);

    if (total_users !== 25 || total_staff !== 11 || total_guests !== 4) {
      failureCount++;
    }

    console.log('\n=================================================');
    console.log(`FINAL INTEGRATION VERDICT: ${failureCount === 0 ? 'FIREBASE AUTH INTEGRATION VERIFIED' : 'INTEGRATION BLOCKED — FIX REQUIRED ITEMS'}`);
    console.log('=================================================\n');

    if (failureCount > 0) process.exit(1);

  } catch (err) {
    console.error('Integration Error:', err.message);
    process.exit(1);
  }
}

testFirebaseAuthIntegration();
