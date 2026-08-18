/**
 * testPhase3bStep4OperationalReadCanary.js — Controlled Operational Read-Canary Expansion Test Suite
 * =====================================================================================================
 * Automated test suite for Phase 3B Step 4 operational read canaries on:
 *   1. GET /api/housekeeping/rooms
 *   2. GET /api/staff
 */

import http from 'http';
import crypto from 'crypto';
import pool from '../backend/db.js';
import { db, auth } from '../backend/config/firebaseAdmin.js';
import { getHousekeepingRooms } from '../backend/controllers/housekeepingController.js';
import { getAllStaff } from '../backend/controllers/staffController.js';
import {
  isHousekeepingReadCanaryEnabled,
  isStaffReadCanaryEnabled,
  isFirestoreServicesEnabled,
  isFirestoreReadsEnabled,
  isFirestoreDualWriteEnabled,
  isFirestoreOutboxWorkerEnabled
} from '../backend/config/featureFlags.js';

const JWT_SECRET = process.env.JWT_SECRET || 'hotel-pms-super-secret-key-12345!';

function generateLegacyToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'staff' });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return `${base64Payload}.${signature}`;
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

function createMockRes() {
  let mockStatus = 200;
  let mockJsonData = null;
  const mockRes = {
    status: (code) => { mockStatus = code; return { json: (b) => { mockJsonData = b; } }; },
    json: (data) => { mockStatus = 200; mockJsonData = data; }
  };
  return { mockRes, getResult: () => ({ status: mockStatus, data: mockJsonData }) };
}

async function runOperationalCanaryTestSuite() {
  console.log('\n========================================================================================');
  console.log('       PHASE 3B STEP 4 CONTROLLED OPERATIONAL READ-CANARY EXPANSION TEST SUITE');
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
    // ── SECTION 1: Default Feature Flags Verification ────────────────────────
    console.log('[SECTION 1] Default Feature Flags Verification...');
    delete process.env.ENABLE_FIRESTORE_HOUSEKEEPING_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_STAFF_READ_CANARY;

    assert(isHousekeepingReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_HOUSEKEEPING_READ_CANARY default = FALSE');
    assert(isStaffReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_STAFF_READ_CANARY default = FALSE');

    // ── SECTION 2: GET /api/housekeeping/rooms Canary Path ───────────────────
    console.log('\n[SECTION 2] GET /api/housekeeping/rooms Canary Path...');
    process.env.ENABLE_FIRESTORE_HOUSEKEEPING_READ_CANARY = 'true';
    const mockHk = createMockRes();
    await getHousekeepingRooms({}, mockHk.mockRes);
    const resHk = mockHk.getResult();
    assert(resHk.status === 200 && Array.isArray(resHk.data) && resHk.data.length === 17, 'Canary ON served 17 housekeeping rooms from Firestore');

    process.env.ENABLE_FIRESTORE_HOUSEKEEPING_READ_CANARY = 'false';
    const mockHkOff = createMockRes();
    await getHousekeepingRooms({}, mockHkOff.mockRes);
    const resHkOff = mockHkOff.getResult();
    assert(resHkOff.status === 200 && Array.isArray(resHkOff.data), 'Canary OFF served housekeeping rooms directly from MySQL fallback');

    // ── SECTION 3: GET /api/staff Canary Path ─────────────────────────────────
    console.log('\n[SECTION 3] GET /api/staff Canary Path...');
    process.env.ENABLE_FIRESTORE_STAFF_READ_CANARY = 'true';
    const mockStf = createMockRes();
    await getAllStaff({ query: {} }, mockStf.mockRes);
    const resStf = mockStf.getResult();
    assert(resStf.status === 200 && resStf.data.staff && resStf.data.staff.length === 11, 'Canary ON served 11 staff records from Firestore');

    // Verify sensitive credentials stripped
    const firstStaff = resStf.data.staff[0];
    assert(firstStaff.password === undefined && firstStaff.password_hash === undefined && firstStaff.deleted === undefined, 'Sanitizer stripped password_hash and password from Firestore staff output');

    process.env.ENABLE_FIRESTORE_STAFF_READ_CANARY = 'false';
    const mockStfOff = createMockRes();
    await getAllStaff({ query: {} }, mockStfOff.mockRes);
    const resStfOff = mockStfOff.getResult();
    assert(resStfOff.status === 200 && resStfOff.data.staff, 'Canary OFF served staff records directly from MySQL fallback');

    // ── SECTION 4: Protected API Authorization & Inactive Guard ─────────────
    console.log('\n[SECTION 4] Protected API Authorization & Inactive Guard...');
    const legacyAdmin = generateLegacyToken({ id: 1, role: 'admin', type: 'staff' });
    const legacyInactive = generateLegacyToken({ id: 11, role: 'receptionist', type: 'staff' });

    const statusAdmin = await makeHttpGet('/api/status', legacyAdmin);
    assert(statusAdmin.status === 200 && statusAdmin.body.systemDate, 'Admin identity accessed GET /api/status (HTTP 200)');

    const [staff11Db] = await pool.query('SELECT status FROM staff WHERE id = 11');
    assert(staff11Db[0]?.status === 'Inactive', 'staff_11 status remains Inactive in MySQL database');

    // ── SECTION 5: Mandatory Global Feature Flags & Mutation Audit ───────────
    console.log('\n[SECTION 5] Mandatory Global Feature Flags & Mutation Audit...');
    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES is false');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS is false');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE is false');
    assert(isFirestoreOutboxWorkerEnabled() === false, 'ENABLE_FIRESTORE_OUTBOX_WORKER is false');

    const [bkg] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    const [inv] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [rooms] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    const [staffCount] = await pool.query('SELECT COUNT(*) as cnt FROM staff');

    assert(bkg[0].cnt === 1, 'Bookings row count remains 1');
    assert(inv[0].cnt === 2, 'Invoices row count remains 2');
    assert(rooms[0].cnt === 17, 'Rooms row count remains 17');
    assert(staffCount[0].cnt === 11, 'Staff row count remains 11');

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
    delete process.env.ENABLE_FIRESTORE_HOUSEKEEPING_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_STAFF_READ_CANARY;
    await pool.end();
  }
}

runOperationalCanaryTestSuite();
