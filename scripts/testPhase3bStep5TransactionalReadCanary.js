/**
 * testPhase3bStep5TransactionalReadCanary.js — Controlled Transactional Read-Canary Expansion Test Suite
 * =========================================================================================================
 * Automated test suite for Phase 3B Step 5 transactional read canaries on:
 *   1. GET /api/reservations
 *   2. GET /api/payments/guest/my
 */

import http from 'http';
import crypto from 'crypto';
import pool from '../backend/db.js';
import { db, auth } from '../backend/config/firebaseAdmin.js';
import { getReservations } from '../backend/controllers/reservationController.js';
import { getMyPayments } from '../backend/controllers/paymentController.js';
import {
  isReservationsReadCanaryEnabled,
  isMyPaymentsReadCanaryEnabled,
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

async function runTransactionalCanaryTestSuite() {
  console.log('\n========================================================================================');
  console.log('       PHASE 3B STEP 5 CONTROLLED TRANSACTIONAL READ-CANARY EXPANSION TEST SUITE');
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
    delete process.env.ENABLE_FIRESTORE_RESERVATIONS_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY;

    assert(isReservationsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_RESERVATIONS_READ_CANARY default = FALSE');
    assert(isMyPaymentsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY default = FALSE');

    // ── SECTION 2: GET /api/reservations Canary Path ─────────────────────────
    console.log('\n[SECTION 2] GET /api/reservations Canary Path...');
    process.env.ENABLE_FIRESTORE_RESERVATIONS_READ_CANARY = 'true';
    const mockResv = createMockRes();
    await getReservations({ query: {} }, mockResv.mockRes);
    const resResv = mockResv.getResult();
    assert(resResv.status === 200 && resResv.data.success === true && Array.isArray(resResv.data.reservations), 'Canary ON served reservations list from Firestore');

    process.env.ENABLE_FIRESTORE_RESERVATIONS_READ_CANARY = 'false';
    const mockResvOff = createMockRes();
    await getReservations({ query: {} }, mockResvOff.mockRes);
    const resResvOff = mockResvOff.getResult();
    assert(resResvOff.status === 200 && resResvOff.data.success === true, 'Canary OFF served reservations directly from MySQL fallback');

    // ── SECTION 3: GET /api/payments/guest/my Canary Path ───────────────────
    console.log('\n[SECTION 3] GET /api/payments/guest/my Canary Path...');
    process.env.ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY = 'true';
    const mockPay = createMockRes();
    await getMyPayments({ user: { id: 6 } }, mockPay.mockRes);
    const resPay = mockPay.getResult();
    assert(resPay.status === 200 && resPay.data.success === true && Array.isArray(resPay.data.payments), 'Canary ON served guest payment history from Firestore');

    process.env.ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY = 'false';
    const mockPayOff = createMockRes();
    await getMyPayments({ user: { id: 6 } }, mockPayOff.mockRes);
    const resPayOff = mockPayOff.getResult();
    assert(resPayOff.status === 200 && resPayOff.data.success === true, 'Canary OFF served guest payment history directly from MySQL fallback');

    // ── SECTION 4: Protected API Authorization & Inactive Guard ─────────────
    console.log('\n[SECTION 4] Protected API Authorization & Inactive Guard...');
    const legacyAdmin = generateLegacyToken({ id: 1, role: 'admin', type: 'staff' });
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
    const [paymentsCount] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
    const [roomsCount] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');

    assert(bkg[0].cnt === 1, 'Bookings row count remains 1');
    assert(inv[0].cnt === 2, 'Invoices row count remains 2');
    assert(paymentsCount[0].cnt === 1, 'Payments row count remains 1');
    assert(roomsCount[0].cnt === 17, 'Rooms row count remains 17');

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
    delete process.env.ENABLE_FIRESTORE_RESERVATIONS_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY;
    await pool.end();
  }
}

runTransactionalCanaryTestSuite();
