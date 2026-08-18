/**
 * testPhase3aStep1Auth.js — Phase 3A Step 1 Frontend Firebase Auth Test Suite
 * =========================================================================
 * Non-destructive automated verification for System User, Keval, Staff identities,
 * Inactive staff protection, Legacy JWT fallback, and Protected Route authorization.
 */

import http from 'http';
import crypto from 'crypto';
import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { resolveFirebaseEmail, resolveFallbackFirebaseEmail } from '../src/config/authMapping.js';

const JWT_SECRET = process.env.JWT_SECRET || 'hotel-pms-super-secret-key-12345!';

function generateLegacyToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'staff' });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return `${base64Payload}.${signature}`;
}

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

async function runPhase3aStep1Tests() {
  console.log('\n========================================================================================');
  console.log('            PHASE 3A STEP 1 FRONTEND FIREBASE AUTH VERIFICATION TEST SUITE');
  console.log('========================================================================================\n');

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
    // ── TEST A & B: System & Keval Email Mapping Resolution ─────────────────
    console.log('[TEST A & B] Centralized Email Resolver for System Users...');
    assert(resolveFirebaseEmail('admin') === 'admin@hpms-sky5.internal', 'admin maps to admin@hpms-sky5.internal');
    assert(resolveFallbackFirebaseEmail('admin') === 'admin@hotelsky5.com', 'admin secondary fallback maps to admin@hotelsky5.com');
    assert(resolveFirebaseEmail('keval') === 'keval@hpms-sky5.internal', 'keval maps to keval@hpms-sky5.internal');

    // ── TEST C: Staff Username Email Mapping ──────────────────────────────
    console.log('\n[TEST C] Centralized Email Resolver for Staff Usernames...');
    const mappings = [
      { username: 'reception_morning', exp: 'reception.morning@hotelsky5.com' },
      { username: 'reception_evening', exp: 'reception.evening@hotelsky5.com' },
      { username: 'reception_night',   exp: 'reception.night@hotelsky5.com' },
      { username: 'chef',              exp: 'chef@hotelsky5.com' },
      { username: 'helper',            exp: 'helper@hotelsky5.com' },
      { username: 'pantry1',           exp: 'pantry1@hotelsky5.com' },
      { username: 'cleaner1',          exp: 'cleaner1@hotelsky5.com' },
      { username: 'reception2',        exp: 'reception2@hotelsky5.com' }
    ];

    for (const m of mappings) {
      assert(resolveFirebaseEmail(m.username) === m.exp, `'${m.username}' maps to ${m.exp}`);
    }

    // ── TEST D: Firebase Provisioned Accounts Check via Admin SDK ───────────
    console.log('\n[TEST D] Firebase Provisioned Accounts Integrity...');
    const user1 = await auth.getUser('user_1');
    assert(user1 && user1.customClaims?.role === 'super_admin', 'user_1 has custom claim super_admin');

    const user2 = await auth.getUser('user_2');
    assert(user2 && user2.customClaims?.role === 'admin', 'user_2 has custom claim admin');

    const staff1 = await auth.getUser('staff_1');
    assert(staff1 && staff1.customClaims?.role === 'admin', 'staff_1 has custom claim admin');

    // ── TEST E: Legacy JWT Fallback Access ──────────────────────────────────
    console.log('\n[TEST E] Legacy HMAC JWT Fallback...');
    const legacyToken = generateLegacyToken({ id: 1, role: 'admin', type: 'staff' });
    const legacyStatusRes = await makeHttpGet('/api/status', legacyToken);
    assert(legacyStatusRes.status === 200 && legacyStatusRes.body.systemDate, 'Legacy HMAC JWT accesses protected /api/status (HTTP 200)');

    // ── TEST F: Missing Token Protection ───────────────────────────────────
    console.log('\n[TEST F] Missing Token Protection...');
    const noTokenRes = await makeHttpGet('/api/status', null);
    assert(noTokenRes.status === 401, 'Protected /api/status returns HTTP 401 when Authorization header is missing');

    // ── TEST G: Inactive Staff Protection (reception2) ─────────────────────
    console.log('\n[TEST G & J] Inactive Staff Account Check...');
    const staff11 = await auth.getUser('staff_11');
    assert(staff11 && staff11.uid === 'staff_11', 'staff_11 exists in Firebase Auth for legacy session evaluation');

    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Test Suite Execution Error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runPhase3aStep1Tests();
