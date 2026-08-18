/**
 * testPhase2Step8DualRbacShadow.js — Dual-RBAC Shadow Verification Test Suite
 * =========================================================================
 * Comprehensive test suite covering positive/negative shadow matches, real identity
 * resolution, failure safety fallbacks, mismatch simulation, and live HTTP endpoints.
 *
 * SAFETY RULES:
 *  - 100% Shadow-Only & Non-Destructive.
 *  - ZERO writes to MySQL or Firestore.
 *  - ZERO changes to feature flags or Auth custom claims.
 *
 * Usage:
 *  node scripts/testPhase2Step8DualRbacShadow.js
 */

process.env.ENABLE_DUAL_RBAC_SHADOW = 'true';

import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { executeShadowRbacVerification } from '../backend/services/dualRbacShadowService.js';
import { hasFirestorePermission } from '../backend/repositories/firestore/rbacRepository.js';
import { hasMysqlPermission, comparePermissionResolution } from '../backend/services/dualRbacVerificationService.js';
import { isFirestoreServicesEnabled, isFirestoreReadsEnabled, isFirestoreDualWriteEnabled, isFirestoreOutboxWorkerEnabled, isDualRbacShadowEnabled } from '../backend/config/featureFlags.js';
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

async function runShadowTests() {
  console.log('\n========================================================================================');
  console.log('            PHASE 2 STEP 8 LIVE DUAL-RBAC SHADOW VERIFICATION TEST SUITE');
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
    // ── SECTION A: Positive Authorization Shadow Matches ─────────────────────
    console.log('[SECTION A] Positive Authorization Shadow Matches...');
    const positiveCases = [
      { roleId: 1, roleName: 'admin', perm: 'view_dashboard' },
      { roleId: 1, roleName: 'admin', perm: 'manage_rooms' },
      { roleId: 1, roleName: 'admin', perm: 'manage_bookings' },
      { roleId: 1, roleName: 'admin', perm: 'run_audit' },
      { roleId: 1, roleName: 'admin', perm: 'make_payment' },
      { roleId: 1, roleName: 'admin', perm: 'modify_business_date' },
      { roleId: 1, roleName: 'admin', perm: 'override_business_date' },
      { roleId: 2, roleName: 'guest', perm: 'view_dashboard' },
      { roleId: 2, roleName: 'guest', perm: 'make_payment' }
    ];

    for (const c of positiveCases) {
      const res = await comparePermissionResolution(c.roleId, c.perm);
      assert(res.match && res.mysqlAllowed && res.firestoreAllowed, `[SHADOW_MATCH] ${c.roleName} + ${c.perm} => ALLOW (Match: true)`);
    }

    // ── SECTION B: Negative Authorization Shadow Matches ─────────────────────
    console.log('\n[SECTION B] Negative Authorization Shadow Matches...');
    const negativeCases = [
      { roleId: 2, roleName: 'guest', perm: 'manage_rooms' },
      { roleId: 2, roleName: 'guest', perm: 'manage_bookings' },
      { roleId: 2, roleName: 'guest', perm: 'run_audit' },
      { roleId: 2, roleName: 'guest', perm: 'modify_business_date' },
      { roleId: 2, roleName: 'guest', perm: 'override_business_date' }
    ];

    for (const c of negativeCases) {
      const res = await comparePermissionResolution(c.roleId, c.perm);
      assert(res.match && !res.mysqlAllowed && !res.firestoreAllowed, `[SHADOW_MATCH] ${c.roleName} + ${c.perm} => DENY (Match: true)`);
    }

    // ── SECTION C: Real Existing Auth Identity Resolution ─────────────────────
    console.log('\n[SECTION C] Real Existing Auth Identity Resolution...');
    
    // User 1 (Admin)
    const u1Auth = await auth.getUser('user_1');
    assert(u1Auth && u1Auth.customClaims?.role === 'super_admin', 'user_1 resolved with claim super_admin');

    // User 2 (Keval)
    const u2Auth = await auth.getUser('user_2');
    assert(u2Auth && u2Auth.customClaims?.role === 'admin', 'user_2 resolved with claim admin');

    // Guest 6 (Akshay)
    const g6Auth = await auth.getUser('guest_6');
    assert(g6Auth && g6Auth.customClaims?.role === 'guest', 'guest_6 resolved with claim guest');

    // Staff Identities (staff_1, staff_2, staff_11)
    const s1Auth = await auth.getUser('staff_1');
    assert(s1Auth && s1Auth.customClaims?.role === 'admin', 'staff_1 resolved with claim admin');

    const s2Auth = await auth.getUser('staff_2');
    assert(s2Auth && s2Auth.customClaims?.role === 'receptionist', 'staff_2 resolved with claim receptionist');

    const s11Auth = await auth.getUser('staff_11');
    assert(s11Auth && s11Auth.customClaims?.role === 'receptionist', 'staff_11 resolved with claim receptionist');

    // ── SECTION D: Failure Safety & Robustness Tests ─────────────────────────
    console.log('\n[SECTION D] Failure Safety & Robustness Tests...');

    // 1. Non-blocking shadow execution test
    let shadowMatchLogged = false;
    const originalLog = console.log;
    console.log = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('[SHADOW_RBAC_MATCH]')) {
        shadowMatchLogged = true;
      }
      originalLog(...args);
    };

    const mockReq = { user: { id: 2, role: 'admin' } };
    executeShadowRbacVerification(mockReq, 'manage_rooms', true);
    await new Promise(r => setTimeout(r, 200)); // allow setImmediate to complete
    console.log = originalLog;
    assert(shadowMatchLogged === true, 'executeShadowRbacVerification executed non-blocking shadow logging');

    // 2. Missing user role in request context (safely caught)
    let shadowErrorLogged = false;
    console.log = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('[SHADOW_RBAC_ERROR]')) {
        shadowErrorLogged = true;
      }
      originalLog(...args);
    };

    const mockBadReq = { user: { id: 999 } };
    executeShadowRbacVerification(mockBadReq, 'manage_rooms', true);
    await new Promise(r => setTimeout(r, 200));
    console.log = originalLog;
    assert(shadowErrorLogged === true, 'Shadow verifier safely logs SHADOW_RBAC_ERROR when user role is missing');

    // 3. Invalid permission query handling
    const invalidPermRes = await hasMysqlPermission(1, 'non_existent_permission_xyz');
    assert(invalidPermRes === false, 'Invalid permission resolves to false without crashing');

    // ── SECTION E: Mismatch Simulation Test ──────────────────────────────────
    console.log('\n[SECTION E] Mismatch Simulation Test...');
    let mismatchLogged = false;
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('[SHADOW_RBAC_MISMATCH]')) {
        mismatchLogged = true;
      }
      originalWarn(...args);
    };

    // Simulate MySQL ALLOW (true) vs Firestore DENY (false) for guest
    const mockReqMismatch = { user: { id: 6, role: 'guest' } };
    executeShadowRbacVerification(mockReqMismatch, 'manage_rooms', true);
    await new Promise(r => setTimeout(r, 200));
    console.warn = originalWarn;

    assert(mismatchLogged === true, 'Simulated mismatch successfully logged SHADOW_RBAC_MISMATCH');

    // ── SECTION F: Live HTTP & Feature Flag Verification ─────────────────────
    console.log('\n[SECTION F] Live HTTP & Feature Flag Verification...');

    // Signin request
    const loginRes = await makeHttpPost('/api/auth/signin', { username: 'admin', password: 'admin123' });
    assert(loginRes.status === 200 && loginRes.body.token, 'Live HTTP POST /api/auth/signin succeeds with token');

    // Status request with token
    const statusRes = await makeHttpGet('/api/status', loginRes.body.token);
    assert(statusRes.status === 200 && statusRes.body.systemDate, 'Protected HTTP GET /api/status succeeds with token (HTTP 200)');

    // Missing auth header
    const noTokenRes = await makeHttpGet('/api/status', null);
    assert(noTokenRes.status === 401, 'Protected route /api/status returns HTTP 401 when Authorization header is missing');

    // Feature Flags Safety Audit
    assert(isDualRbacShadowEnabled() === true, 'ENABLE_DUAL_RBAC_SHADOW is true');
    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES is false');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS is false');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE is false');
    assert(isFirestoreOutboxWorkerEnabled() === false, 'ENABLE_FIRESTORE_OUTBOX_WORKER is false');

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

runShadowTests();
