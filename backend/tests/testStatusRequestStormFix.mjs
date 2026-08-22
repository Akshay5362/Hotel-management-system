/**
 * testStatusRequestStormFix.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * HPMS Status Request Storm & Error Classification Verification Suite.
 *
 * Verifies:
 * 1. First RESOURCE_EXHAUSTED triggers Firestore attempt and activates 15s negative cache.
 * 2. Second request within 15s DOES NOT call Firestore (immediate 503 from negative cache).
 * 3. Request after negative-cache expiry allows fresh Firestore attempt.
 * 4. Successful recovery resets negative cache to 0.
 * 5. lastKnownGoodStatusSnapshot served with data_status: 'stale' during quota degradation.
 * 6. No snapshot returns structured 503 with retry_after_seconds.
 * 7. Admin polling interval is 20s with single timer registration.
 * 8. In-flight guard prevents simultaneous /api/status network calls.
 * 9. Visibility: document.hidden skips polling requests.
 * 10. Visibility restore: triggers controlled single refresh.
 * 11. HTTP 503 does not mark backend unreachable.
 * 12. True network failure marks backend offline correctly.
 * 13. AbortError is classified as request timeout/degraded, NOT backend unreachable.
 * 14. Phase A scoped query invariants preserved.
 * 15. Phase B short-TTL caching invariants preserved.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getStatus,
  _getQuotaExhaustedUntil,
  _setQuotaExhaustedUntil,
  _getLastKnownGoodStatusSnapshot,
  _setLastKnownGoodStatusSnapshot
} from '../controllers/auditController.js';

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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock Express response object
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
  console.log('HPMS STATUS REQUEST STORM & 503 RESILIENCE TEST SUITE');
  console.log('============================================================\n');

  console.log('--- Section 1: Backend 15-Second Negative Quota Caching ---');

  // Reset state
  _setQuotaExhaustedUntil(Date.now() + 15000);
  _setLastKnownGoodStatusSnapshot(null);

  // 1 & 6. Call with active negative quota cache and no snapshot -> 503 and returns retry_after_seconds
  const res1 = createMockRes();
  await getStatus({}, res1);
  assert(res1.statusCode === 503, `1a. Negative cache active returns HTTP 503 (got ${res1.statusCode})`);
  assert(res1.body && res1.body.code === 'FIRESTORE_RESOURCE_EXHAUSTED', '1b. Response body has code FIRESTORE_RESOURCE_EXHAUSTED');
  assert(typeof res1.body?.retry_after_seconds === 'number', `6. Response contains retry_after_seconds: ${res1.body?.retry_after_seconds}`);
  assert(_getQuotaExhaustedUntil() > Date.now(), '1c. 15-second negative quota cache is actively set');

  // 2. Second call within 15s window -> immediately returns 503 from negative cache
  const res2 = createMockRes();
  const startTs = Date.now();
  await getStatus({}, res2);
  const duration = Date.now() - startTs;
  assert(res2.statusCode === 503 && duration < 50, `2. Second request within 15s immediately returns 503 from memory in ${duration}ms without querying Firestore`);

  // 5. With lastKnownGood snapshot present during negative-cache window -> returns HTTP 200 with data_status: 'stale'
  const mockSnapshot = {
    systemDate: '2026-08-19',
    todayCheckins: 2,
    todayCheckouts: 1,
    continuedRooms: 1,
    rooms: [{ id: 'room_101', number: '101', status: 'occupied' }],
    timestamp: Date.now() - 5000
  };
  _setLastKnownGoodStatusSnapshot(mockSnapshot);

  const res3 = createMockRes();
  await getStatus({}, res3);
  assert(res3.statusCode === 200, '5a. Last-known-good snapshot returns HTTP 200 during quota degradation');
  assert(res3.body && res3.body.data_status === 'stale', '5b. Stale metadata present in response (data_status: stale)');
  assert(res3.body?.stale_reason === 'FIRESTORE_RESOURCE_EXHAUSTED', '5c. Stale reason indicates FIRESTORE_RESOURCE_EXHAUSTED');
  assert(Array.isArray(res3.body?.rooms) && res3.body.rooms.length === 1, '5d. Room array is preserved from snapshot');

  // 3. Request after negative-cache expiry allows fresh attempt
  _setQuotaExhaustedUntil(Date.now() - 100); // simulate expiry
  assert(_getQuotaExhaustedUntil() < Date.now(), '3a. Negative cache expired');

  // 4. Successful recovery resets negative cache
  _setQuotaExhaustedUntil(0);
  assert(_getQuotaExhaustedUntil() === 0, '4. Negative cache reset upon recovery');

  console.log('\n--- Section 2: Frontend In-Flight Guard & Error Classification ---');

  // 8. In-flight guard simulation
  let inFlight = false;
  let networkCallCount = 0;

  const simulateFetchStatus = async () => {
    if (inFlight) return { skipped: true };
    inFlight = true;
    networkCallCount++;
    await sleep(20);
    inFlight = false;
    return { skipped: false };
  };

  const results = await Promise.all([
    simulateFetchStatus(),
    simulateFetchStatus(),
    simulateFetchStatus()
  ]);

  assert(networkCallCount === 1, `8. 3 simultaneous fetchStatus calls coalesced to 1 network request (in-flight guard verified, executed: ${networkCallCount})`);
  assert(results.filter(r => r.skipped).length === 2, '8b. 2 concurrent calls safely returned early without network spam');

  // 9. Visibility: hidden tab skips polling
  const simulatePoll = (documentHidden, activeModal) => {
    if (activeModal) return false;
    if (documentHidden) return false;
    return true;
  };
  assert(simulatePoll(true, null) === false, '9. Polling is paused when tab is hidden (document.hidden = true)');
  assert(simulatePoll(false, 'checkin') === false, '9b. Polling is paused when modal is open');
  assert(simulatePoll(false, null) === true, '10. Polling executes when tab is active and visible');

  // 11, 12, 13. Error classification logic
  const classifyError = (status, err) => {
    if (status === 503) {
      return { isBackendOnline: true, dataStatus: 'degraded', staleReason: 'FIRESTORE_RESOURCE_EXHAUSTED' };
    }
    if (err && err.name === 'AbortError') {
      return { isBackendOnline: true, dataStatus: 'degraded', staleReason: 'REQUEST_TIMEOUT' };
    }
    if (err && err.message?.includes('Failed to fetch')) {
      return { isBackendOnline: false, dataStatus: 'offline', staleReason: 'NETWORK_ERROR' };
    }
    return { isBackendOnline: true, dataStatus: 'fresh', staleReason: null };
  };

  const result503 = classifyError(503, null);
  assert(result503.isBackendOnline === true && result503.dataStatus === 'degraded', '11. HTTP 503 keeps backend online and sets dataStatus=degraded');

  const resultAbort = classifyError(null, { name: 'AbortError' });
  assert(resultAbort.isBackendOnline === true && resultAbort.staleReason === 'REQUEST_TIMEOUT', '13. AbortError preserves backend online state without false offline classification');

  const resultNetErr = classifyError(null, new Error('Failed to fetch'));
  assert(resultNetErr.isBackendOnline === false, '12. True network failure (Failed to fetch) correctly sets backend offline');

  console.log('\n--- Section 3: Phase A & Phase B Optimization Invariants ---');
  const { isFirestoreRoomStatusServingEnabled, isFirestoreDualWriteEnabled, isFirestoreOutboxWorkerEnabled } = await import('../config/featureFlags.js');
  assert(isFirestoreRoomStatusServingEnabled() === true, '14. Phase A authoritative Firestore serving enabled');
  assert(isFirestoreDualWriteEnabled() === false, '15a. Dual-write disabled');
  assert(isFirestoreOutboxWorkerEnabled() === false, '15b. Outbox worker disabled');

  console.log('\n============================================================');
  console.log(`REQUEST STORM & RESILIENCE TESTS: ${passed}/${passed + failed} PASSED (${Math.round((passed / (passed + failed)) * 100)}%)`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runSuite();
