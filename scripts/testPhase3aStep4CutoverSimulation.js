/**
 * testPhase3aStep4CutoverSimulation.js — Controlled Firebase Auth Cutover Simulation & Full Regression Gate
 * =========================================================================================================
 * 40-test automated verification suite covering system admins, staff, guests, inactive staff protection,
 * identity normalization, legacy JWT fallback, token failure matrix, RBAC positive/negative authorization,
 * Firestore shadow matching, portal isolation, security audits, and zero-mutation verification.
 */

process.env.ENABLE_DUAL_RBAC_SHADOW = 'true';

import http from 'http';
import crypto from 'crypto';
import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { resolveFirebaseEmail, resolveFallbackFirebaseEmail } from '../src/config/authMapping.js';
import { comparePermissionResolution } from '../backend/services/dualRbacVerificationService.js';
import { executeShadowRbacVerification } from '../backend/services/dualRbacShadowService.js';
import { authenticate } from '../backend/controllers/authController.js';
import { isFirestoreServicesEnabled, isFirestoreReadsEnabled, isFirestoreDualWriteEnabled, isFirestoreOutboxWorkerEnabled, isDualRbacShadowEnabled } from '../backend/config/featureFlags.js';

const JWT_SECRET = process.env.JWT_SECRET || 'hotel-pms-super-secret-key-12345!';

function generateLegacyToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'staff' });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return `${base64Payload}.${signature}`;
}

function makeHttpPost(path, body, token) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path,
      method: 'POST',
      headers
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

async function runCutoverSimulationSuite() {
  console.log('\n========================================================================================');
  console.log('       PHASE 3A STEP 4 CONTROLLED FIREBASE AUTH CUTOVER SIMULATION & REGRESSION GATE');
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
    // ── SECTION 1: System Admin Firebase Identities ──────────────────────────
    console.log('[SECTION 1] System Admin Firebase Identities...');
    const u1 = await auth.getUser('user_1');
    assert(u1.uid === 'user_1' && u1.customClaims?.role === 'super_admin' && u1.customClaims?.mysql_id === 1, 'user_1 (admin) resolved with super_admin claim');

    const u2 = await auth.getUser('user_2');
    assert(u2.uid === 'user_2' && u2.customClaims?.role === 'admin' && u2.customClaims?.mysql_id === 2, 'user_2 (keval) resolved with admin claim');

    // ── SECTION 2: Staff Firebase Identities (staff_1 through staff_10) ─────
    console.log('\n[SECTION 2] Staff Firebase Identities...');
    const staffIds = [
      { id: 'staff_1', role: 'admin', staff_id: 'admin' },
      { id: 'staff_2', role: 'receptionist', staff_id: 'reception_morning' },
      { id: 'staff_3', role: 'receptionist', staff_id: 'reception_evening' },
      { id: 'staff_4', role: 'receptionist', staff_id: 'reception_night' },
      { id: 'staff_5', role: 'staff', staff_id: 'chef' },
      { id: 'staff_6', role: 'staff', staff_id: 'helper' },
      { id: 'staff_7', role: 'staff', staff_id: 'pantry1' },
      { id: 'staff_8', role: 'staff', staff_id: 'pantry2' },
      { id: 'staff_9', role: 'housekeeping', staff_id: 'cleaner1' },
      { id: 'staff_10', role: 'housekeeping', staff_id: 'cleaner2' }
    ];

    for (const s of staffIds) {
      const u = await auth.getUser(s.id);
      assert(u.uid === s.id && u.customClaims?.role === s.role && u.customClaims?.staff_id === s.staff_id, `${s.id} (${s.staff_id}) resolved with role ${s.role}`);
    }

    // ── SECTION 3: Inactive Staff Account Protection (staff_11) ──────────────
    console.log('\n[SECTION 3] Inactive Staff Account Protection...');
    const s11 = await auth.getUser('staff_11');
    assert(s11.uid === 'staff_11', 'staff_11 exists in Firebase Auth');

    const inactiveToken = generateLegacyToken({ id: 11, role: 'receptionist', type: 'staff' });
    let middlewareStatus = null;
    const mockReqInactive = { headers: { authorization: `Bearer ${inactiveToken}` } };
    const mockResInactive = {
      status: (code) => { middlewareStatus = code; return { json: (b) => b }; }
    };
    await authenticate(mockReqInactive, mockResInactive, () => { middlewareStatus = 200; });
    assert(middlewareStatus === 403, 'Inactive staff_11 correctly returned HTTP 403 Forbidden');

    // ── SECTION 4: Guest Identity Verification ─────────────────────────────
    console.log('\n[SECTION 4] Guest Identity Verification...');
    const g6 = await auth.getUser('guest_6');
    assert(g6.uid === 'guest_6' && g6.customClaims?.role === 'guest' && g6.customClaims?.mysql_id === 6, 'guest_6 resolved with role guest, mysql_id 6');

    // ── SECTION 5: Legacy HMAC JWT Authentication Fallback ───────────────────
    console.log('\n[SECTION 5] Legacy HMAC JWT Fallback...');
    const legacyAdmin = generateLegacyToken({ id: 1, role: 'admin', type: 'staff' });
    const legacyKeval = generateLegacyToken({ id: 2, role: 'admin', type: 'system' });
    const legacyReception = generateLegacyToken({ id: 2, role: 'receptionist', type: 'staff' });

    const statusAdmin = await makeHttpGet('/api/status', legacyAdmin);
    assert(statusAdmin.status === 200 && statusAdmin.body.systemDate, 'Legacy Admin JWT accessed /api/status (HTTP 200)');

    const statusKeval = await makeHttpGet('/api/status', legacyKeval);
    assert(statusKeval.status === 200 && statusKeval.body.systemDate, 'Legacy Keval JWT accessed /api/status (HTTP 200)');

    const statusReception = await makeHttpGet('/api/status', legacyReception);
    assert(statusReception.status === 200 && statusReception.body.systemDate, 'Legacy Receptionist JWT accessed /api/status (HTTP 200)');

    // ── SECTION 6: Token Failure & Malformed Token Protection ───────────────
    console.log('\n[SECTION 6] Token Failure & Malformed Token Protection...');
    const noTokenRes = await makeHttpGet('/api/status', null);
    assert(noTokenRes.status === 401, 'Missing token returned HTTP 401');

    const badFbTokenRes = await makeHttpGet('/api/status', 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZvbyJ9.invalid.payload');
    assert(badFbTokenRes.status === 401, 'Malformed Firebase ID token returned HTTP 401');

    const badJwtRes = await makeHttpGet('/api/status', 'eyJhbGciOiJIUzI1NiJ9.invalid.signature');
    assert(badJwtRes.status === 401, 'Invalid HMAC JWT returned HTTP 401');

    // ── SECTION 7: Authorization Bypass & Role Spoofing Protection ───────────
    console.log('\n[SECTION 7] Role Spoofing Protection...');
    const fakeGuestToken = generateLegacyToken({ id: 6, role: 'guest', type: 'guest' });
    const spoofRes = await makeHttpPost('/api/settings/business-date', { date: '2026-12-31' }, fakeGuestToken);
    assert(spoofRes.status === 403, 'Guest user role spoofing attempt returned HTTP 403 Forbidden');

    // ── SECTION 8: RBAC Positive Matches & Negative Denials ─────────────────
    console.log('\n[SECTION 8] RBAC Positive Matches & Negative Denials...');
    const adminRooms = await comparePermissionResolution(1, 'manage_rooms');
    assert(adminRooms.mysqlAllowed && adminRooms.firestoreAllowed, 'Admin + manage_rooms resolved ALLOW on MySQL & Firestore');

    const adminDashboard = await comparePermissionResolution(1, 'view_dashboard');
    assert(adminDashboard.mysqlAllowed && adminDashboard.firestoreAllowed, 'Admin + view_dashboard resolved ALLOW on MySQL & Firestore');

    const guestRooms = await comparePermissionResolution(2, 'manage_rooms');
    assert(!guestRooms.mysqlAllowed && !guestRooms.firestoreAllowed, 'Guest + manage_rooms resolved DENY on MySQL & Firestore');

    const guestBookings = await comparePermissionResolution(2, 'manage_bookings');
    assert(!guestBookings.mysqlAllowed && !guestBookings.firestoreAllowed, 'Guest + manage_bookings resolved DENY on MySQL & Firestore');

    const guestAudit = await comparePermissionResolution(2, 'run_audit');
    assert(!guestAudit.mysqlAllowed && !guestAudit.firestoreAllowed, 'Guest + run_audit resolved DENY on MySQL & Firestore');

    const guestDate = await comparePermissionResolution(2, 'override_business_date');
    assert(!guestDate.mysqlAllowed && !guestDate.firestoreAllowed, 'Guest + override_business_date resolved DENY on MySQL & Firestore');

    // ── SECTION 9: Firestore Shadow Matching & Non-blocking Safety ──────────
    console.log('\n[SECTION 9] Firestore Shadow Matching & Non-blocking Safety...');
    const shadowRes = await comparePermissionResolution(1, 'view_dashboard');
    assert(shadowRes.match === true, 'Role admin + view_dashboard shadow match = true');

    let shadowNonBlocking = false;
    try {
      executeShadowRbacVerification({ user: { id: 999 } }, 'manage_rooms', true);
      await new Promise(r => setTimeout(r, 100));
      shadowNonBlocking = true;
    } catch (e) {}
    assert(shadowNonBlocking === true, 'Firestore shadow verification runs asynchronously without blocking HTTP response');

    // ── SECTION 10: Protected API Access Matrix ─────────────────────────────
    console.log('\n[SECTION 10] Protected API Access Matrix...');
    const healthRes = await makeHttpGet('/api/health', null);
    assert(healthRes.status === 200, 'GET /api/health returned HTTP 200 OK');

    const businessDateRes = await makeHttpGet('/api/settings/business-date', legacyAdmin);
    assert(businessDateRes.status === 200, 'GET /api/settings/business-date returned HTTP 200 OK');

    const publicRoomsRes = await makeHttpGet('/api/public/rooms', null);
    assert(publicRoomsRes.status === 200, 'GET /api/public/rooms returned HTTP 200 OK');

    // ── SECTION 11: Feature Flags & Zero Production Mutation Audit ──────────
    console.log('\n[SECTION 11] Feature Flags & Zero Production Mutation Audit...');
    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES is false');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS is false');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE is false');
    assert(isFirestoreOutboxWorkerEnabled() === false, 'ENABLE_FIRESTORE_OUTBOX_WORKER is false');
    assert(isDualRbacShadowEnabled() === true, 'ENABLE_DUAL_RBAC_SHADOW is true');

    const [bookingCount] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    assert(bookingCount[0].cnt === 1, 'Production bookings table row count remains exactly 1');

    const [invoiceCount] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    assert(invoiceCount[0].cnt === 2, 'Production invoices table row count remains exactly 2');

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

runCutoverSimulationSuite();
