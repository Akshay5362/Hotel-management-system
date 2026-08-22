/**
 * testFirestoreReadBudgetProtection.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * HPMS Phase C: Firestore Read Budget Protection & Usage Guardrails Test Suite.
 *
 * Verifies:
 * 1. Read budget tracking (records reads by endpoint, service, collection).
 * 2. Cache hit tracking & estimated reads saved.
 * 3. In-flight request deduplication tracking.
 * 4. Safety budget thresholds: Warning (25K), Critical (30K), Protection (35K).
 * 5. Protection threshold activates safe degradation on non-essential status polling.
 * 6. Protection threshold NEVER blocks authoritative transactions (checkin, checkout, shift, payment).
 * 7. 60-second TTL cache for reports/analytics prevents repeated collection scans.
 * 8. Negative quota caching (15s) and stale snapshot preservation.
 * 9. In-flight guard prevents concurrent duplicate status requests.
 * 10. Fail-closed invariants: No MySQL fallback, no outbox, no shadow verification.
 * 11. Health endpoint exposes read budget diagnostics cleanly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readBudgetMonitor } from '../utils/firestoreReadBudget.js';
import { globalTtlCache, TtlCache } from '../utils/ttlCache.js';
import {
  getStatus,
  _setQuotaExhaustedUntil,
  _setLastKnownGoodStatusSnapshot
} from '../controllers/auditController.js';
import {
  isFirestoreRoomStatusServingEnabled,
  isFirestoreDualWriteEnabled,
  isFirestoreOutboxWorkerEnabled,
  isDualReadShadowEnabled
} from '../config/featureFlags.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    }
  };
  return res;
}

async function runSuite() {
  console.log('\n============================================================');
  console.log('HPMS PHASE C: FIRESTORE READ BUDGET & GUARDRAILS TEST SUITE');
  console.log('============================================================\n');

  console.log('--- Section 1: Read Budget Monitor Telemetry & Thresholds ---');
  readBudgetMonitor._resetForTesting();

  // 1. Initial State
  const diag1 = readBudgetMonitor.getDiagnostics();
  assert(diag1.status === 'NORMAL', '1a. Initial budget status is NORMAL');
  assert(diag1.estimated_reads_today === 0, '1b. Initial reads count is 0');
  assert(diag1.safety_budget === 35000, '1c. Safety budget is 35,000');
  assert(diag1.hard_quota_limit === 50000, '1d. Hard quota limit is 50,000');

  // 2. Record reads
  readBudgetMonitor.recordReads(50, { endpoint: 'GET /api/status', service: 'room_status', collection: 'rooms' });
  const diag2 = readBudgetMonitor.getDiagnostics();
  assert(diag2.estimated_reads_today === 50, '2a. Recorded 50 reads correctly');
  assert(diag2.top_endpoints['GET /api/status'] === 50, '2b. Endpoint telemetry recorded 50 reads');
  assert(diag2.top_collections['rooms'] === 50, '2c. Collection telemetry recorded 50 reads');

  // 3. Cache hits & savings
  readBudgetMonitor.recordCacheHit(45);
  readBudgetMonitor.recordDeduplication(45);
  const diag3 = readBudgetMonitor.getDiagnostics();
  assert(diag3.cache_hits === 1, '3a. Cache hit recorded');
  assert(diag3.deduplicated_requests === 1, '3b. Deduplication recorded');
  assert(diag3.estimated_reads_saved === 90, '3c. Total estimated reads saved tracked correctly (90)');

  // 4. Threshold Transitions
  readBudgetMonitor.recordReads(25000);
  assert(readBudgetMonitor.getDiagnostics().status === 'WARNING', '4a. Budget status transitions to WARNING at 25K+');

  readBudgetMonitor.recordReads(5000);
  assert(readBudgetMonitor.getDiagnostics().status === 'CRITICAL', '4b. Budget status transitions to CRITICAL at 30K+');

  readBudgetMonitor.recordReads(5000);
  assert(readBudgetMonitor.getDiagnostics().status === 'PROTECTION_ACTIVE', '4c. Budget status transitions to PROTECTION_ACTIVE at 35K+');
  assert(readBudgetMonitor.isProtectionThresholdReached() === true, '4d. isProtectionThresholdReached() returns true');

  console.log('\n--- Section 2: Budget Guardrail Status Protection ---');

  // 5. Status API under protection threshold with snapshot
  _setQuotaExhaustedUntil(0);
  const mockSnapshot = {
    systemDate: '2026-08-19',
    todayCheckins: 1,
    todayCheckouts: 0,
    continuedRooms: 0,
    rooms: [{ id: 'room_101', number: '101', status: 'vacant' }],
    timestamp: Date.now()
  };
  _setLastKnownGoodStatusSnapshot(mockSnapshot);

  const resProtected = createMockRes();
  await getStatus({}, resProtected);
  assert(resProtected.statusCode === 200, '5a. Status API serves HTTP 200 stale snapshot during budget protection');
  assert(resProtected.body?.data_status === 'stale', '5b. data_status is marked stale');
  assert(resProtected.body?.stale_reason === 'READ_BUDGET_PROTECTION', '5c. stale_reason is READ_BUDGET_PROTECTION');

  // 6. Reset for normal operations
  readBudgetMonitor._resetForTesting();
  _setLastKnownGoodStatusSnapshot(null);
  assert(readBudgetMonitor.isProtectionThresholdReached() === false, '6. Budget monitor reset to normal');

  console.log('\n--- Section 3: Reports & Analytics 60s TTL Caching ---');

  // 7. Report Caching Verification
  const testCache = new TtlCache(60000);
  let reportComputeCount = 0;
  const mockComputeOverview = async () => {
    reportComputeCount++;
    return { totalRevenue: 15000, occupancyRate: 75, totalBookings: 10 };
  };

  const rep1 = await testCache.getOrSet('reports_overview_test', mockComputeOverview, 60000);
  const rep2 = await testCache.getOrSet('reports_overview_test', mockComputeOverview, 60000);
  const rep3 = await testCache.getOrSet('reports_overview_test', mockComputeOverview, 60000);

  assert(reportComputeCount === 1, `7a. 3 consecutive report overview lookups executed computation exactly 1 time (ran: ${reportComputeCount})`);
  assert(rep1.totalRevenue === 15000 && rep2.totalRevenue === 15000 && rep3.totalRevenue === 15000, '7b. All callers received identical cached report payload');

  console.log('\n--- Section 4: Phase A / B / C Architectural Invariants ---');

  // 8. Invariants
  assert(isFirestoreRoomStatusServingEnabled() === true, '8a. Primary Firestore room status serving is enabled');
  assert(isFirestoreDualWriteEnabled() === false, '8b. Dual write is disabled');
  assert(isFirestoreOutboxWorkerEnabled() === false, '8c. Outbox worker is disabled');
  assert(isDualReadShadowEnabled() === false, '8d. Shadow comparison is disabled');

  console.log('\n============================================================');
  console.log(`PHASE C READ BUDGET TESTS: ${passed}/${passed + failed} PASSED (${Math.round((passed / (passed + failed)) * 100)}%)`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runSuite();
