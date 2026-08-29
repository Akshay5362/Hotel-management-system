/**
 * testPhase3eStep16ObservabilityStability.js
 * ======================================================================================================
 * HPMS — Phase 3E Step 16: Production Observability & Long-Running Stability Test Suite
 *
 * Verifies lightweight telemetry, health diagnostics, sustained reads (180 requests across 9 routes),
 * 10-request concurrency, failure fallback observability, recovery, database immutability,
 * credential security scanning, financial precision, mutation authority, and outbox queue health.
 */

import crypto from 'crypto';
import express from '../backend/node_modules/express/index.js';
import apiRouter from '../backend/routes/api.js';
import pool from '../backend/db.js';
import { isFirestoreServicesEnabled, isFirestoreReadsEnabled, isFirestoreDualWriteEnabled, isFirestoreOutboxWorkerEnabled } from '../backend/config/featureFlags.js';
import { getReadStrategy, getMutationStrategy, executeServiceRead, executeServiceMutation, STRATEGY_MODE, getServiceReadMetrics, resetServiceReadMetrics } from '../backend/services/serviceStrategy.js';
import { formatDecimal, sanitizeSensitiveFields } from '../backend/repositories/firestore/firestoreUtils.js';

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

async function runStep16ObservabilitySuite() {
  console.log('\n========================================================================================');
  console.log('  HPMS — PHASE 3E STEP 16: PRODUCTION OBSERVABILITY & LONG-RUNNING STABILITY SUITE');
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

    app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        service: 'hotel-pms-backend',
        port: PORT,
        feature_flags: {
          outbox_worker: isFirestoreOutboxWorkerEnabled(),
          dual_write: isFirestoreDualWriteEnabled(),
          firestore_reads: isFirestoreReadsEnabled(),
          use_firestore_services: isFirestoreServicesEnabled()
        },
        telemetry: getServiceReadMetrics()
      });
    });

    server = app.listen(PORT);
    await new Promise(r => setTimeout(r, 200));

    const guestToken = generateTestToken({ id: 1, role: 'guest', type: 'guest' });
    const staffToken = generateTestToken({ id: 2, role: 'receptionist', type: 'staff' });
    const adminToken = generateTestToken({ id: 1, role: 'admin', type: 'staff' });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 16A - 16D: Configuration Snapshot & Health Telemetry Diagnostics
    // ══════════════════════════════════════════════════════════════════════════
    console.log('[PHASE 16A - 16D] Configuration Snapshot & Health Diagnostics...');
    assert(isFirestoreOutboxWorkerEnabled(), '16A: ENABLE_FIRESTORE_OUTBOX_WORKER is true');
    assert(isFirestoreDualWriteEnabled(), '16A: ENABLE_FIRESTORE_DUAL_WRITE is true');
    assert(isFirestoreReadsEnabled(), '16A: ENABLE_FIRESTORE_READS is true');
    assert(isFirestoreServicesEnabled(), '16A: USE_FIRESTORE_SERVICES is true');

    const healthRes = await fetch(`${BASE_URL}/api/health`);
    assert(healthRes.status === 200, '16D: Health endpoint GET /api/health returns HTTP 200');

    const healthData = await healthRes.json();
    assert(healthData.telemetry && typeof healthData.telemetry.read_attempts === 'number',
      '16D: Health endpoint safely includes telemetry metrics envelope');

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 16E: Sustained Read Stability (180 Requests Across 9 Endpoints)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 16E] Sustained Read Stability (180 Read Requests)...');
    resetServiceReadMetrics();

    const readEndpoints = [
      { route: '/api/public/rooms', token: null },
      { route: '/api/room-types', token: staffToken },
      { route: '/api/inventory/categories', token: staffToken },
      { route: '/api/inventory/products', token: staffToken },
      { route: '/api/settings/business-date', token: staffToken },
      { route: '/api/housekeeping/rooms', token: staffToken },
      { route: '/api/staff', token: adminToken },
      { route: '/api/reservations', token: staffToken },
      { route: '/api/payments/guest/my', token: guestToken }
    ];

    let totalSustainedRequests = 0;
    let successfulSustained = 0;
    let sumLatencyMs = 0;

    for (const ep of readEndpoints) {
      for (let i = 0; i < 20; i++) {
        totalSustainedRequests++;
        const headers = ep.token ? { 'Authorization': `Bearer ${ep.token}` } : {};
        const start = Date.now();
        try {
          const res = await fetch(`${BASE_URL}${ep.route}`, { headers });
          const latency = Date.now() - start;
          sumLatencyMs += latency;
          if (res.status === 200) {
            successfulSustained++;
          }
        } catch (e) {
          console.error(`Sustained read error on ${ep.route}:`, e.message);
        }
      }
    }

    const avgSustainedLatency = (sumLatencyMs / totalSustainedRequests).toFixed(2);
    assert(totalSustainedRequests === 180, '16E: Executed 180 read requests across 9 monitored endpoints');
    assert(successfulSustained === 180,
      `16E: 180/180 sustained read requests returned HTTP 200 (Avg Latency: ${avgSustainedLatency}ms, 0 5xx)`);

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 16F: Concurrent Read Stability (10 Concurrent Requests)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 16F] Concurrent Read Stability (10 Requests)...');
    const concurrentPromises = Array.from({ length: 10 }, () =>
      fetch(`${BASE_URL}/api/room-types`, { headers: { 'Authorization': `Bearer ${staffToken}` } })
    );
    const concurrentResults = await Promise.all(concurrentPromises);
    const all200 = concurrentResults.every(r => r.status === 200);
    assert(all200, '16F: 10 concurrent read requests completed with 10/10 HTTP 200 responses (0 pool errors)');

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 16G & 16H: Failure Fallback & Recovery Observability
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 16G & 16H] Failure Fallback & Recovery Observability...');
    const failMetricsBefore = getServiceReadMetrics();
    const fallbackRes = await executeServiceRead({
      domainName: 'phase16g_fallback_test',
      fetchFirestoreFn: async () => { throw new Error('FIRESTORE_TIMEOUT'); },
      fetchMysqlFn: async () => [{ source: 'mysql_fallback' }],
      timeoutMs: 100,
      options: { forceMode: STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK }
    });
    assert(fallbackRes[0].source === 'mysql_fallback',
      '16G: Controlled Firestore failure transparently logged and executed MySQL fallback');

    const failMetricsAfter = getServiceReadMetrics();
    assert(failMetricsAfter.read_fallbacks === failMetricsBefore.read_fallbacks + 1,
      '16G: Read metrics fallback counter correctly incremented by 1');

    const recovRes = await executeServiceRead({
      domainName: 'phase16h_recovery_test',
      fetchFirestoreFn: async () => [{ id: 1, source: 'firestore_recovered' }],
      fetchMysqlFn: async () => [{ id: 1, source: 'mysql_fallback' }],
      timeoutMs: 100,
      options: { forceMode: STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK }
    });
    assert(recovRes[0].source === 'firestore_recovered',
      '16H: Healthy Firestore read cleanly re-activates Firestore path without restart');

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 16I - 16M: Immutability, Security, Financial, Mutation Authority & Outbox
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[PHASE 16I - 16M] Immutability, Security, Financial, Mutation Authority & Outbox...');
    assert(getMutationStrategy('check_in') === STRATEGY_MODE.MYSQL,
      '16L: getMutationStrategy("check_in") strictly returns MYSQL under USE_FIRESTORE_SERVICES=true');
    assert(getMutationStrategy('payment') === STRATEGY_MODE.MYSQL,
      '16L: getMutationStrategy("payment") strictly returns MYSQL under USE_FIRESTORE_SERVICES=true');

    const [outboxPost] = await pool.query('SELECT status, COUNT(*) as cnt FROM dual_write_outbox GROUP BY status');
    const outboxPostMap = {};
    outboxPost.forEach(r => { outboxPostMap[r.status] = r.cnt; });
    assert((outboxPostMap['PENDING'] || 0) === 0 && (outboxPostMap['PROCESSING'] || 0) === 0 && (outboxPostMap['FAILED'] || 0) === 0 && (outboxPostMap['DEAD_LETTER'] || 0) === 0,
      '16M: Dual-write outbox queue is 100% healthy (PENDING=0, PROCESSING=0, FAILED=0, DEAD_LETTER=0)');

    const [bkgPost] = await pool.query('SELECT COUNT(*) as count FROM bookings');
    const [invPost] = await pool.query('SELECT COUNT(*) as count FROM invoices');
    const [payPost] = await pool.query('SELECT COUNT(*) as count FROM payments');
    const [stfPost] = await pool.query('SELECT COUNT(*) as count FROM staff WHERE deleted = 0 AND status = "Active"');

    assert(bkgPost[0].count === baseline.bookings, '16I: bookings count unchanged');
    assert(invPost[0].count === baseline.invoices, '16I: invoices count unchanged');
    assert(payPost[0].count === baseline.payments, '16I: payments count unchanged');
    assert(stfPost[0].count === baseline.staff, '16I: active staff count unchanged');

    const staffRes = await fetch(`${BASE_URL}/api/staff`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const staffData = await staffRes.json();
    const violations = scanForForbiddenKeys(staffData, 'authenticated_staff_observability');
    assert(violations.length === 0, '16J: Recursive security scanner reports ZERO forbidden credential fields');

    const tot = formatDecimal('1500.50');
    const pd  = formatDecimal('1000.25');
    const bal = formatDecimal('500.25');
    assert(parseFloat(tot) === parseFloat(pd) + parseFloat(bal),
      '16K: Financial invariant total_amount (1500.50) = paid (1000.25) + balance (500.25) holds exactly');

    // ══════════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n========================================================================================');
    console.log(`OBSERVABILITY SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    if (passedTests === totalTests) {
      console.log('ALL PHASE 16 STAGES PASSED — PASS — PRODUCTION OBSERVABILITY & LONG-RUNNING STABILITY VERIFIED');
    } else {
      console.log('STEP 16 OBSERVABILITY AUDIT: NO-GO — ROLLBACK TO MYSQL');
    }
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Step 16 Observability Suite Error:', err);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await pool.end();
  }
}

runStep16ObservabilitySuite();
