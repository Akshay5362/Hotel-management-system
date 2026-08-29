import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';
import { GuestRequestsService, invalidateGuestRequestsCache, GUEST_REQUESTS_CACHE_KEY } from '../services/guestRequestsService.js';
import { globalTtlCache } from '../utils/ttlCache.js';
import { readBudgetMonitor } from '../utils/firestoreReadBudget.js';

console.log('═════════════════════════════════════════════════════════════════════════════');
console.log('HPMS — PHASE 2 FIRESTORE GUEST REQUESTS READ OPTIMIZATION TEST SUITE');
console.log('═════════════════════════════════════════════════════════════════════════════\n');

async function runTests() {
  console.log('1. Verifying Guest Requests Baseline & Single Request Behavior...');
  invalidateGuestRequestsCache();

  // Reset metrics
  const initialBudgetReads = readBudgetMonitor.estimatedReadsToday;

  // Request 1: Fresh read (Cache Miss)
  console.log('Executing Request 1 (Initial fetch on cold cache)...');
  const res1 = await GuestRequestsService.getGuestRequests({ skipCache: false });
  assert(res1 && Array.isArray(res1.requests), 'res1 must contain a requests array');
  assert(typeof res1.total === 'number', 'res1 must contain numeric total');
  const readsAfterReq1 = readBudgetMonitor.estimatedReadsToday;
  const req1DocsRead = readsAfterReq1 - initialBudgetReads;
  console.log(`✓ Request 1 completed. Returned ${res1.total} requests. Firestore reads consumed: ${req1DocsRead}`);

  // Verify response schema parity
  if (res1.requests.length > 0) {
    const sample = res1.requests[0];
    const expectedKeys = ['id', 'desc', 'request_type', 'status'];
    for (const k of expectedKeys) {
      assert(sample[k] !== undefined, `Sample request missing key '${k}'`);
    }
  }
  console.log('✓ Response schema verified (requests array, total count, canonical fields).');

  // Request 2: Immediate follow-up within 15s cache TTL (Cache Hit)
  console.log('\n2. Verifying Immediate Cache Hit & Zero Duplicate Reads...');
  const readsBeforeReq2 = readBudgetMonitor.estimatedReadsToday;
  const res2 = await GuestRequestsService.getGuestRequests({ skipCache: false });
  const readsAfterReq2 = readBudgetMonitor.estimatedReadsToday;
  const req2DocsRead = readsAfterReq2 - readsBeforeReq2;

  assert.strictEqual(req2DocsRead, 0, 'Request 2 within TTL MUST NOT consume ANY Firestore reads (0 reads)');
  assert.strictEqual(res2.total, res1.total, 'res2 total must match res1 total');
  console.log(`✓ Request 2 (Cache Hit) completed with ZERO (${req2DocsRead}) Firestore document reads.`);

  // 3. Verifying In-Flight Request Deduplication (Single-Flight / Stampede Protection)
  console.log('\n3. Verifying Single-Flight Request Deduplication...');
  invalidateGuestRequestsCache();

  const readsBeforeStampede = readBudgetMonitor.estimatedReadsToday;
  console.log('Dispatching 5 concurrent requests simultaneously on cold cache...');
  const concurrentResults = await Promise.all([
    GuestRequestsService.getGuestRequests({ skipCache: false }),
    GuestRequestsService.getGuestRequests({ skipCache: false }),
    GuestRequestsService.getGuestRequests({ skipCache: false }),
    GuestRequestsService.getGuestRequests({ skipCache: false }),
    GuestRequestsService.getGuestRequests({ skipCache: false })
  ]);
  const readsAfterStampede = readBudgetMonitor.estimatedReadsToday;
  const stampedeDocsRead = readsAfterStampede - readsBeforeStampede;

  assert.strictEqual(concurrentResults.length, 5, 'All 5 concurrent requests must resolve');
  for (const cRes of concurrentResults) {
    assert.strictEqual(cRes.total, res1.total, 'All concurrent responses must match total count');
  }
  console.log(`✓ 5 concurrent requests coalesced into 1 in-flight operation. Total reads consumed: ${stampedeDocsRead}`);
  assert(stampedeDocsRead <= req1DocsRead + 5, 'Stampede protection prevented 5x duplicate reads');

  // 4. Verifying Cache Expiry & Refresh
  console.log('\n4. Verifying Short-TTL Expiry & Refresh...');
  const shortTtl = 150; // 150ms test TTL
  const testKey = 'test_guest_requests_expiry';
  let loaderCount = 0;
  const testLoader = async () => {
    loaderCount++;
    return { requests: [], total: loaderCount };
  };

  const t1 = await globalTtlCache.getOrSet(testKey, testLoader, shortTtl);
  assert.strictEqual(t1.total, 1);
  assert.strictEqual(loaderCount, 1);

  // Immediate read -> Cache Hit
  const t2 = await globalTtlCache.getOrSet(testKey, testLoader, shortTtl);
  assert.strictEqual(t2.total, 1);
  assert.strictEqual(loaderCount, 1);

  // Wait for TTL expiry
  console.log('Waiting for short TTL to expire...');
  await new Promise(r => setTimeout(r, 200));

  const t3 = await globalTtlCache.getOrSet(testKey, testLoader, shortTtl);
  assert.strictEqual(t3.total, 2);
  assert.strictEqual(loaderCount, 2);
  console.log('✓ Cache expiration refreshed data accurately.');

  // 5. Verifying In-Flight Error Cleanup
  console.log('\n5. Verifying In-Flight Error Cleanup...');
  const failKey = 'test_guest_requests_fail';
  const failLoader = async () => {
    throw new Error('Simulated transient request failure');
  };

  try {
    await globalTtlCache.getOrSet(failKey, failLoader, 5000);
    assert.fail('Should have failed');
  } catch (err) {
    assert.strictEqual(err.message, 'Simulated transient request failure');
  }

  assert.strictEqual(globalTtlCache.inFlight.has(failKey), false, 'inFlight map must be cleared on failure');
  console.log('✓ In-flight error cleanup verified (no permanent lock).');

  // 6. Verifying Mutation Cache Invalidation
  console.log('\n6. Verifying Mutation Invalidation Points...');
  // Populate cache
  await GuestRequestsService.getGuestRequests({ skipCache: false });
  assert(globalTtlCache.hasValid(GUEST_REQUESTS_CACHE_KEY) === true, 'Cache must be populated');

  // Trigger invalidation
  invalidateGuestRequestsCache();
  assert(globalTtlCache.hasValid(GUEST_REQUESTS_CACHE_KEY) === false, 'Cache must be purged immediately after invalidateGuestRequestsCache()');
  console.log('✓ invalidateGuestRequestsCache() successfully purged cached guest requests.');

  console.log('\n═════════════════════════════════════════════════════════════════════════════');
  console.log('ALL PHASE 2 GUEST REQUESTS READ OPTIMIZATION TESTS PASSED SUCCESSFULLY!');
  console.log('═════════════════════════════════════════════════════════════════════════════\n');
}

runTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
