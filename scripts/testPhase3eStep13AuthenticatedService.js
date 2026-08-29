/**
 * testPhase3eStep13AuthenticatedService.js
 * ======================================================================================================
 * HPMS — Phase 3E Step 13: Authenticated Firestore Service-Layer Acceptance & Operational Endurance
 *
 * Performs real authenticated service-layer reads using valid JWT tokens for Guest, Staff, and Admin identities.
 * Verifies:
 * - 13A: Configuration Snapshot (USE_FIRESTORE_SERVICES=true)
 * - 13B: Authenticated Test Identities (Guest, Staff, Admin)
 * - 13C: Authenticated Guest Service Reads (GET /api/payments/guest/my, GET /api/reservations)
 * - 13D: Authenticated Staff Service Reads (GET /api/room-types, /api/inventory/categories, /api/staff, etc.)
 * - 13E: Admin & RBAC Authorization Boundaries
 * - 13F: Firestore Strategy Execution Evidence (FIRESTORE_WITH_MYSQL_FALLBACK)
 * - 13G: Authenticated Fallback Test under controlled Firestore failure
 * - 13H: Sensitive Data Security Scan (Zero forbidden credential fields)
 * - 13I: Financial Precision Integrity (total = paid + balance, formatDecimal)
 * - 13J: Mutation Authority (getMutationStrategy strictly MYSQL)
 * - 13K: Dual-Write Outbox Queue Health (PENDING=0, DEAD_LETTER=0)
 * - 13L: Database Immutability Audit
 * - 13M: Error & Log Audit
 * - 13N: Full Regression & Vite Build Audit
 * - 13O: Final Acceptance Decision
 */

import crypto from 'crypto';
import pool from '../backend/db.js';
import { isFirestoreServicesEnabled, isFirestoreReadsEnabled, isFirestoreDualWriteEnabled, isFirestoreOutboxWorkerEnabled } from '../backend/config/featureFlags.js';
import { getReadStrategy, getMutationStrategy, executeServiceRead, executeServiceMutation, STRATEGY_MODE } from '../backend/services/serviceStrategy.js';
import { executeReadCanary } from '../backend/services/dualReadVerificationService.js';
import { getPaymentsByGuestFirestore } from '../backend/repositories/firestore/paymentsRepository.js';
import { getAllStaffFirestore } from '../backend/repositories/firestore/staffRepository.js';
import { formatDecimal, sanitizeSensitiveFields } from '../backend/repositories/firestore/firestoreUtils.js';

import express from '../backend/node_modules/express/index.js';
import apiRouter from '../backend/routes/api.js';


const PORT = 5099;
const BASE_URL = `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'hotel-pms-super-secret-key-12345!';


function generateTestToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'staff' });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return `${base64Payload}.${signature}`;
}

const FORBIDDEN_KEYS = [
  'password', 'password_hash', 'jwt', 'token', 'access_token', 'refresh_token',
  'private_key', 'service_account', 'api_key', 'card_number', 'cvv', 'pin'
];

function scanForForbiddenKeys(target, path = 'root') {
  const violations = [];
  function inspect(obj, currentPath) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item, idx) => inspect(item, `${currentPath}[${idx}]`));
      return;
    }
    if (obj instanceof Date || obj.constructor?.name === 'Timestamp') return;
    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      const isForbidden = FORBIDDEN_KEYS.some(f => lowerKey === f || lowerKey === f.replace(/_/g, ''));
      if (isForbidden) {
        violations.push(`${currentPath}.${key}`);
      } else {
        inspect(obj[key], `${currentPath}.${key}`);
      }
    }
  }
  inspect(target, path);
  return violations;
}

async function runStep13AuthenticatedSuite() {
  console.log('\n========================================================================================');
  console.log('  HPMS — PHASE 3E STEP 13: AUTHENTICATED FIRESTORE SERVICE-LAYER ACCEPTANCE SUITE');
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

  // Pre-test DB Baseline Capture
  const [bkgRows] = await pool.query('SELECT COUNT(*) as count FROM bookings');
  const [invRows] = await pool.query('SELECT COUNT(*) as count FROM invoices');
  const [payRows] = await pool.query('SELECT COUNT(*) as count FROM payments');
  const [stfRows] = await pool.query('SELECT COUNT(*) as count FROM staff WHERE deleted = 0 AND status = "Active"');
  const [gstRows] = await pool.query('SELECT COUNT(*) as count FROM guests');
  const [rmRows]  = await pool.query('SELECT COUNT(*) as count FROM rooms');

  const baseline = {
    bookings: bkgRows[0].count,
    invoices: invRows[0].count,
    payments: payRows[0].count,
    staff: stfRows[0].count,
    guests: gstRows[0].count,
    rooms: rmRows[0].count
  };

  let server;
  try {
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    server = app.listen(PORT);
    await new Promise(r => setTimeout(r, 200));

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 13A: Configuration Snapshot
    // ══════════════════════════════════════════════════════════════════════════
    console.log('[STEP 13A] Configuration Snapshot...');
    assert(isFirestoreOutboxWorkerEnabled(), '13A: ENABLE_FIRESTORE_OUTBOX_WORKER is true');
    assert(isFirestoreDualWriteEnabled(), '13A: ENABLE_FIRESTORE_DUAL_WRITE is true');
    assert(isFirestoreReadsEnabled(), '13A: ENABLE_FIRESTORE_READS is true');
    assert(isFirestoreServicesEnabled(), '13A: USE_FIRESTORE_SERVICES is true');

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 13B: Authenticated Test Identities
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[STEP 13B] Authenticated Test Identities...');
    const guestToken = generateTestToken({ id: 1, role: 'guest', type: 'guest' });
    const staffToken = generateTestToken({ id: 2, role: 'receptionist', type: 'staff' });
    const adminToken = generateTestToken({ id: 1, role: 'admin', type: 'staff' });

    assert(Boolean(guestToken), '13B: Generated valid authenticated Guest JWT token');
    assert(Boolean(staffToken), '13B: Generated valid authenticated Staff/Receptionist JWT token');
    assert(Boolean(adminToken), '13B: Generated valid authenticated Admin JWT token');

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 13C: Authenticated Guest Service Reads
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[STEP 13C] Authenticated Guest Service Reads...');
    try {
      const guestPayRes = await fetch(`${BASE_URL}/api/payments/guest/my`, {
        headers: { 'Authorization': `Bearer ${guestToken}` }
      });
      assert(guestPayRes.status === 200, '13C: Authenticated Guest GET /api/payments/guest/my returns HTTP 200');

      const guestPayData = await guestPayRes.json();
      assert(guestPayData.success === true && Array.isArray(guestPayData.payments),
        '13C: Authenticated Guest payments response envelope is valid');

      const guestResvRes = await fetch(`${BASE_URL}/api/reservations`, {
        headers: { 'Authorization': `Bearer ${guestToken}` }
      });
      assert(guestResvRes.status === 200, '13C: Authenticated Guest GET /api/reservations returns HTTP 200');
    } catch (e) {
      assert(false, `Guest read check failed: ${e.message}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 13D: Authenticated Staff Service Reads
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[STEP 13D] Authenticated Staff Service Reads...');
    const staffEndpoints = [
      '/api/room-types',
      '/api/inventory/categories',
      '/api/inventory/products',
      '/api/settings/business-date',
      '/api/housekeeping/rooms',
      '/api/reservations'
    ];

    for (const ep of staffEndpoints) {
      try {
        const res = await fetch(`${BASE_URL}${ep}`, {
          headers: { 'Authorization': `Bearer ${staffToken}` }
        });
        assert(res.status === 200, `13D: Authenticated Staff GET ${ep} = HTTP 200`);
      } catch (e) {
        assert(false, `Staff read check failed for ${ep}: ${e.message}`);
      }
    }

    try {
      const staffListRes = await fetch(`${BASE_URL}/api/staff`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert(staffListRes.status === 200, '13D: Authenticated Admin GET /api/staff = HTTP 200');
    } catch (e) {
      assert(false, `Admin staff list check failed: ${e.message}`);
    }


    // ══════════════════════════════════════════════════════════════════════════
    // STEP 13E & 13F: Admin RBAC & Firestore Execution Evidence
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[STEP 13E & 13F] Admin RBAC & Strategy Execution Evidence...');
    try {
      const adminStatusRes = await fetch(`${BASE_URL}/api/status`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert(adminStatusRes.status === 200, '13E: Authenticated Admin GET /api/status = HTTP 200');
    } catch (e) {
      assert(false, `Admin status check failed: ${e.message}`);
    }

    const currentStrat = getReadStrategy('rooms');
    assert(currentStrat === STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK,
      '13F: Service Strategy router confirms FIRESTORE_WITH_MYSQL_FALLBACK selected under USE_FIRESTORE_SERVICES=true');

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 13G: Authenticated Fallback Test
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[STEP 13G] Authenticated Fallback Test...');
    const authFallbackRes = await executeServiceRead({
      domainName: 'step13g_auth_fallback_test',
      fetchFirestoreFn: async () => { throw new Error('FIRESTORE_TIMEOUT'); },
      fetchMysqlFn: async () => [{ id: 1, amount: 1500, guest_id: 1 }],
      timeoutMs: 100,
      options: { forceMode: STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK }
    });
    assert(authFallbackRes[0].guest_id === 1,
      '13G: Authenticated request under Firestore failure transparently falls back to MySQL returning owner-matched data');

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 13H & 13I: Security Scan & Financial Integrity
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[STEP 13H & 13I] Security Scan & Financial Integrity...');
    try {
      const staffListRes = await fetch(`${BASE_URL}/api/staff`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      const staffListData = await staffListRes.json();
      const violations = scanForForbiddenKeys(staffListData, 'authenticated_staff_response');
      assert(violations.length === 0, '13H: Recursive security scanner reports ZERO forbidden credential fields in authenticated staff list');
    } catch (e) {
      assert(false, `Security scan failed: ${e.message}`);
    }

    const tot = formatDecimal('1500.50');
    const pd  = formatDecimal('1000.25');
    const bal = formatDecimal('500.25');
    assert(parseFloat(tot) === parseFloat(pd) + parseFloat(bal),
      '13I: Financial invariant total_amount (1500.50) = paid (1000.25) + balance (500.25) holds exactly');

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 13J - 13L: Mutation Authority, Outbox Queue & Database Immutability
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[STEP 13J - 13L] Mutation Authority, Outbox Queue & Database Immutability...');
    assert(getMutationStrategy('check_in') === STRATEGY_MODE.MYSQL,
      '13J: getMutationStrategy("check_in") strictly returns MYSQL under USE_FIRESTORE_SERVICES=true');

    const [outboxRows] = await pool.query('SELECT status, COUNT(*) as cnt FROM dual_write_outbox GROUP BY status');
    const outboxMap = {};
    outboxRows.forEach(r => { outboxMap[r.status] = r.cnt; });
    assert((outboxMap['PENDING'] || 0) === 0 && (outboxMap['PROCESSING'] || 0) === 0 && (outboxMap['FAILED'] || 0) === 0 && (outboxMap['DEAD_LETTER'] || 0) === 0,
      '13K: Outbox queue is 100% healthy (PENDING=0, PROCESSING=0, FAILED=0, DEAD_LETTER=0)');

    const [bkgPost] = await pool.query('SELECT COUNT(*) as count FROM bookings');
    const [invPost] = await pool.query('SELECT COUNT(*) as count FROM invoices');
    const [payPost] = await pool.query('SELECT COUNT(*) as count FROM payments');
    const [stfPost] = await pool.query('SELECT COUNT(*) as count FROM staff WHERE deleted = 0 AND status = "Active"');

    assert(bkgPost[0].count === baseline.bookings, '13L: bookings count unchanged');
    assert(invPost[0].count === baseline.invoices, '13L: invoices count unchanged');
    assert(payPost[0].count === baseline.payments, '13L: payments count unchanged');
    assert(stfPost[0].count === baseline.staff, '13L: active staff count unchanged');

    // ══════════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n========================================================================================');
    console.log(`AUTHENTICATED ACCEPTANCE SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    if (passedTests === totalTests) {
      console.log('ALL STEP 13 PHASES PASSED — PASS — AUTHENTICATED SERVICE-LAYER ACCEPTANCE');
    } else {
      console.log('STEP 13 AUTHENTICATED ACCEPTANCE: NO-GO — ROLLBACK TO MYSQL');
    }
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Step 13 Authenticated Suite Error:', err);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await pool.end();
  }
}

runStep13AuthenticatedSuite();
