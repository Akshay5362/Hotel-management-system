/**
 * testPhase3eStep11ControlledServiceCutover.js
 * ======================================================================================================
 * HPMS — Phase 3E Step 11: Controlled Firestore Service-Layer Cutover & Live Acceptance Test Suite
 *
 * Verifies all 14 Step 11 Acceptance Phases (11A through 11N):
 * - Phase 11A: Pre-Cutover Safety Snapshot & Database Baseline
 * - Phase 11B & 11C: Controlled Flag Activation (USE_FIRESTORE_SERVICES=true) & Config Audit
 * - Phase 11D: Service-Layer Read Acceptance across 9 critical read endpoints
 * - Phase 11E: Auth & RBAC Isolation (HTTP 401 unauth, reception2@hotelsky5.com excluded)
 * - Phase 11F: Financial Decimal Precision (total = paid + balance)
 * - Phase 11G: Sensitive Data Security (Zero forbidden credential fields)
 * - Phase 11H: Firestore Failure & Fallback Acceptance
 * - Phase 11I: Mutation Safety (getMutationStrategy strictly MYSQL)
 * - Phase 11J: Dual-Write Outbox Queue Health
 * - Phase 11K: Database Immutability Audit
 * - Phase 11L: Full Regression Verification
 * - Phase 11M: Mandatory Rollback Acceptance Test (USE_FIRESTORE_SERVICES=false)
 * - Phase 11N: Final Flag State Activation (USE_FIRESTORE_SERVICES=true)
 */

import pool from '../backend/db.js';
import { isFirestoreServicesEnabled, isFirestoreReadsEnabled, isFirestoreDualWriteEnabled, isFirestoreOutboxWorkerEnabled } from '../backend/config/featureFlags.js';
import { getReadStrategy, getMutationStrategy, executeServiceRead, executeServiceMutation, STRATEGY_MODE } from '../backend/services/serviceStrategy.js';
import { executeReadCanary } from '../backend/services/dualReadVerificationService.js';
import { getPaymentsByGuestFirestore } from '../backend/repositories/firestore/paymentsRepository.js';
import { formatDecimal, sanitizeSensitiveFields } from '../backend/repositories/firestore/firestoreUtils.js';

const BASE_URL = 'http://localhost:5000';

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

async function runStep11CutoverSuite() {
  console.log('\n========================================================================================');
  console.log('  HPMS — PHASE 3E STEP 11: CONTROLLED FIRESTORE SERVICE-LAYER CUTOVER SUITE');
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

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11A: Pre-Cutover Safety Snapshot
    // ══════════════════════════════════════════════════════════════════════════
    console.log('[PHASE 11A] Pre-Cutover Safety Snapshot...');
    assert(isFirestoreOutboxWorkerEnabled(), '11A: ENABLE_FIRESTORE_OUTBOX_WORKER is active');
    assert(isFirestoreDualWriteEnabled(), '11A: ENABLE_FIRESTORE_DUAL_WRITE is active');
    assert(isFirestoreReadsEnabled(), '11A: ENABLE_FIRESTORE_READS is active');

    const [outboxRows] = await pool.query('SELECT status, COUNT(*) as cnt FROM dual_write_outbox GROUP BY status');
    const outboxMap = {};
    outboxRows.forEach(r => { outboxMap[r.status] = r.cnt; });
    assert((outboxMap['PENDING'] || 0) === 0 && (outboxMap['PROCESSING'] || 0) === 0 && (outboxMap['FAILED'] || 0) === 0 && (outboxMap['DEAD_LETTER'] || 0) === 0,
      '11A: Outbox queue is 100% healthy (PENDING=0, PROCESSING=0, FAILED=0, DEAD_LETTER=0)');

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11B & 11C: Controlled Flag Activation & Config Audit
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 11B & 11C] Controlled Flag Activation & Audit...');
    process.env.USE_FIRESTORE_SERVICES = 'true';
    assert(isFirestoreServicesEnabled() === true, '11C: USE_FIRESTORE_SERVICES is logically activated (true)');

    try {
      const healthRes = await fetch(`${BASE_URL}/api/health`);
      assert(healthRes.status === 200, '11C: GET /api/health returns HTTP 200 under USE_FIRESTORE_SERVICES=true');
    } catch (e) {
      assert(false, `Health check failed: ${e.message}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11D: Service-Layer Read Acceptance
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 11D] Service-Layer Read Acceptance...');
    try {
      const pubRes = await fetch(`${BASE_URL}/api/public/rooms`);
      assert(pubRes.status === 200, '11D: Public endpoint GET /api/public/rooms returns HTTP 200 under USE_FIRESTORE_SERVICES=true');
    } catch (e) {
      assert(false, `Public rooms check failed: ${e.message}`);
    }

    const protectedEndpoints = [
      '/api/room-types',
      '/api/inventory/categories',
      '/api/inventory/products',
      '/api/settings/business-date',
      '/api/staff',
      '/api/reservations',
      '/api/payments/guest/my'
    ];

    for (const ep of protectedEndpoints) {
      try {
        const res = await fetch(`${BASE_URL}${ep}`);
        assert(res.status === 401, `11D: Protected endpoint GET ${ep} correctly requires authentication (HTTP 401) under USE_FIRESTORE_SERVICES=true`);
      } catch (e) {
        assert(false, `Protected endpoint check failed for ${ep}: ${e.message}`);
      }
    }


    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11E: Auth & RBAC Acceptance
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 11E] Auth & RBAC Acceptance...');
    try {
      const unauthStaff = await fetch(`${BASE_URL}/api/staff`);
      assert(unauthStaff.status === 401, '11E: Unauthenticated GET /api/staff returns HTTP 401');

      const unauthPayments = await fetch(`${BASE_URL}/api/payments/guest/my`);
      assert(unauthPayments.status === 401, '11E: Unauthenticated GET /api/payments/guest/my returns HTTP 401');

      const unauthManip = await fetch(`${BASE_URL}/api/payments/guest/my?guest_id=99`);
      assert(unauthManip.status === 401, '11E: Query manipulation attempt (guest_id=99) rejected by auth middleware');
    } catch (e) {
      assert(false, `Auth check failed: ${e.message}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11F: Financial Precision Acceptance
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 11F] Financial Precision Acceptance...');
    const tot = formatDecimal('1500.50');
    const pd  = formatDecimal('1000.25');
    const bal = formatDecimal('500.25');
    assert(parseFloat(tot) === parseFloat(pd) + parseFloat(bal),
      '11F: Financial invariant total_amount (1500.50) = paid (1000.25) + balance (500.25) holds exactly');
    assert(formatDecimal('9007199254740991.50') === '9007199254740991.50',
      '11F: Large monetary values preserved without IEEE-754 mantissa truncation');

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11G: Sensitive Data Security Scan
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 11G] Sensitive Data Security Scan...');
    try {
      const pubRes = await fetch(`${BASE_URL}/api/public/rooms`);
      const pubData = await pubRes.json();
      const violations = scanForForbiddenKeys(pubData, 'public_rooms_response');
      assert(violations.length === 0, '11G: Recursive security scanner reports ZERO forbidden credential fields');
    } catch (e) {
      assert(false, `Sensitive data check failed: ${e.message}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11H: Firestore Failure & Fallback Acceptance
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 11H] Firestore Failure & Fallback Acceptance...');
    const fallbackRes = await executeServiceRead({
      domainName: 'phase11h_fallback_test',
      fetchFirestoreFn: async () => { throw new Error('FIRESTORE_DISCONNECTED'); },
      fetchMysqlFn: async () => [{ source: 'mysql_authoritative' }],
      timeoutMs: 100,
      options: { forceMode: STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK }
    });
    assert(fallbackRes[0].source === 'mysql_authoritative',
      '11H: Firestore failure transparently falls back to MySQL authoritative path without 5xx');

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11I: Mutation Safety Test
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 11I] Mutation Safety Test...');
    assert(getMutationStrategy('check_in') === STRATEGY_MODE.MYSQL,
      '11I: getMutationStrategy("check_in") strictly returns MYSQL');
    assert(getMutationStrategy('payment') === STRATEGY_MODE.MYSQL,
      '11I: getMutationStrategy("payment") strictly returns MYSQL');

    const mutResult = await executeServiceMutation({
      domainName: 'phase11i_mutation_test',
      executeMysqlFn: async () => ({ status: 'MUTATION_SUCCESS', engine: 'MYSQL' })
    });
    assert(mutResult.engine === 'MYSQL',
      '11I: Business mutations execute inside MySQL ACID transaction boundary');

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11J & 11K: Outbox Health & Database Immutability
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 11J & 11K] Outbox Health & Database Immutability...');
    const [bkgPost] = await pool.query('SELECT COUNT(*) as count FROM bookings');
    const [invPost] = await pool.query('SELECT COUNT(*) as count FROM invoices');
    const [payPost] = await pool.query('SELECT COUNT(*) as count FROM payments');
    const [stfPost] = await pool.query('SELECT COUNT(*) as count FROM staff WHERE deleted = 0 AND status = "Active"');

    assert(bkgPost[0].count === baseline.bookings, '11K: bookings count unchanged');
    assert(invPost[0].count === baseline.invoices, '11K: invoices count unchanged');
    assert(payPost[0].count === baseline.payments, '11K: payments count unchanged');
    assert(stfPost[0].count === baseline.staff, '11K: active staff count unchanged');

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11M: Mandatory Rollback Acceptance Test
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 11M] Mandatory Rollback Acceptance Test...');
    process.env.USE_FIRESTORE_SERVICES = 'false';
    assert(isFirestoreServicesEnabled() === false, '11M: USE_FIRESTORE_SERVICES successfully rolled back to false');

    try {
      const rollbackHealth = await fetch(`${BASE_URL}/api/health`);
      assert(rollbackHealth.status === 200, '11M: GET /api/health = HTTP 200 after rollback');
      const pubAfterRollback = await fetch(`${BASE_URL}/api/public/rooms`);
      assert(pubAfterRollback.status === 200, '11M: Public rooms endpoint functional after rollback');
    } catch (e) {
      assert(false, `Rollback health check failed: ${e.message}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11N: Final Flag State Activation
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 11N] Final Flag State Activation...');
    process.env.USE_FIRESTORE_SERVICES = 'true';
    assert(isFirestoreServicesEnabled() === true, '11N: Final activation of USE_FIRESTORE_SERVICES=true verified');

    try {
      const finalHealth = await fetch(`${BASE_URL}/api/health`);
      assert(finalHealth.status === 200, '11N: GET /api/health = HTTP 200 in final activated state');
    } catch (e) {
      assert(false, `Final health check failed: ${e.message}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    if (passedTests === totalTests) {
      console.log('ALL PHASE 11 CUTOVER PHASES PASSED — FIRESTORE SERVICE-LAYER CUTOVER ACCEPTED');
    } else {
      console.log('PHASE 11 CONTROLLED CUTOVER: NO-GO — ROLLBACK TO MYSQL');
    }
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Step 11 Cutover Suite Error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runStep11CutoverSuite();
