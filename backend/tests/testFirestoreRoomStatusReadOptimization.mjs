import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';
import { FirestoreRoomStatusService, invalidateRoomStatusCache, ROOM_STATUS_CACHE_TTL_MS } from '../services/firestoreRoomStatusService.js';
import { globalTtlCache, TtlCache } from '../utils/ttlCache.js';
import { readBudgetMonitor } from '../utils/firestoreReadBudget.js';

console.log('═════════════════════════════════════════════════════════════════════════════');
console.log('HPMS — PHASE 1 FIRESTORE ROOM STATUS READ OPTIMIZATION TEST SUITE');
console.log('═════════════════════════════════════════════════════════════════════════════\n');

async function runTests() {
  const businessDate = '2026-08-19';

  console.log('1. Verifying Cache Baseline & Single Request Behavior...');
  invalidateRoomStatusCache();

  // Reset metrics for clean measurement
  const initialBudgetReads = readBudgetMonitor.estimatedReadsToday;

  // Request 1: Fresh read (Cache Miss)
  console.log('Executing Request 1 (Initial status fetch)...');
  const status1 = await FirestoreRoomStatusService.getRoomStatuses(businessDate, { skipCache: false });
  assert(Array.isArray(status1), 'Status 1 must return an array of rooms');
  assert(status1.length > 0, 'Status 1 must contain rooms');
  const readsAfterReq1 = readBudgetMonitor.estimatedReadsToday;
  const req1DocsRead = readsAfterReq1 - initialBudgetReads;
  console.log(`✓ Request 1 completed. Returned ${status1.length} rooms. Firestore reads consumed: ${req1DocsRead}`);
  assert(req1DocsRead > 0, 'Request 1 must perform initial Firestore reads');

  // Verify response shape integrity (check essential fields)
  const sampleRoom = status1[0];
  const expectedFields = ['id', 'number', 'type', 'status', 'is_active', 'housekeeping_status', 'rate'];
  for (const field of expectedFields) {
    assert(sampleRoom[field] !== undefined, `Room object must contain '${field}'`);
  }
  console.log('✓ Response shape integrity verified (all canonical room fields present).');

  // Request 2: Immediate follow-up within 30s cache TTL (Cache Hit)
  console.log('\n2. Verifying Immediate Cache Hit & Zero Duplicate Reads...');
  const readsBeforeReq2 = readBudgetMonitor.estimatedReadsToday;
  const status2 = await FirestoreRoomStatusService.getRoomStatuses(businessDate, { skipCache: false });
  const readsAfterReq2 = readBudgetMonitor.estimatedReadsToday;
  const req2DocsRead = readsAfterReq2 - readsBeforeReq2;

  assert.strictEqual(req2DocsRead, 0, 'Request 2 within TTL MUST NOT consume ANY Firestore reads (0 reads)');
  assert.strictEqual(status2.length, status1.length, 'Status 2 must return identical room count');
  assert.strictEqual(status2[0].number, status1[0].number, 'Status 2 must match Status 1 content');
  console.log(`✓ Request 2 (Cache Hit) completed with ZERO (${req2DocsRead}) Firestore document reads.`);

  // 3. Verifying In-Flight Request Deduplication (Single-Flight / Stampede Protection)
  console.log('\n3. Verifying Stampede Protection / Single-Flight Deduplication...');
  invalidateRoomStatusCache();

  // Fire 5 simultaneous requests concurrently
  const readsBeforeStampede = readBudgetMonitor.estimatedReadsToday;
  console.log('Dispatching 5 concurrent status requests simultaneously on cold cache...');
  const concurrentResults = await Promise.all([
    FirestoreRoomStatusService.getRoomStatuses(businessDate, { skipCache: false }),
    FirestoreRoomStatusService.getRoomStatuses(businessDate, { skipCache: false }),
    FirestoreRoomStatusService.getRoomStatuses(businessDate, { skipCache: false }),
    FirestoreRoomStatusService.getRoomStatuses(businessDate, { skipCache: false }),
    FirestoreRoomStatusService.getRoomStatuses(businessDate, { skipCache: false })
  ]);
  const readsAfterStampede = readBudgetMonitor.estimatedReadsToday;
  const stampedeDocsRead = readsAfterStampede - readsBeforeStampede;

  assert.strictEqual(concurrentResults.length, 5, 'All 5 concurrent requests must resolve');
  for (const res of concurrentResults) {
    assert.strictEqual(res.length, status1.length, 'All concurrent responses must match canonical room length');
  }
  console.log(`✓ 5 concurrent requests coalesced into 1 in-flight operation. Total reads consumed: ${stampedeDocsRead} (approx 1 fetch).`);
  assert(stampedeDocsRead <= req1DocsRead + 5, 'Stampede protection prevented 5x duplicate reads');

  // 4. Verifying Cache Expiry & Refresh
  console.log('\n4. Verifying Cache Expiration & Refresh...');
  const shortTtl = 150; // 150ms test TTL
  const testCacheKey = 'room_status_test_expiry';
  let loaderCalls = 0;
  const mockLoader = async () => {
    loaderCalls++;
    return [{ test: true, version: loaderCalls }];
  };

  const exp1 = await globalTtlCache.getOrSet(testCacheKey, mockLoader, shortTtl);
  assert.strictEqual(loaderCalls, 1);
  assert.strictEqual(exp1[0].version, 1);

  // Immediate call -> cache hit
  const exp2 = await globalTtlCache.getOrSet(testCacheKey, mockLoader, shortTtl);
  assert.strictEqual(loaderCalls, 1, 'Should still be 1 call during TTL');

  // Wait for TTL to expire
  console.log('Waiting for short TTL to expire...');
  await new Promise(r => setTimeout(r, 200));

  const exp3 = await globalTtlCache.getOrSet(testCacheKey, mockLoader, shortTtl);
  assert.strictEqual(loaderCalls, 2, 'Should refresh exactly once after expiration');
  assert.strictEqual(exp3[0].version, 2);
  console.log('✓ Cache expiration successfully refreshed data after TTL.');

  // 5. Verifying In-Flight Error Handling & Cleanup
  console.log('\n5. Verifying In-Flight Error Cleanup...');
  const errorKey = 'room_status_test_error';
  let errorCalls = 0;
  const failingLoader = async () => {
    errorCalls++;
    throw new Error('Simulated transient loader failure');
  };

  try {
    await globalTtlCache.getOrSet(errorKey, failingLoader, 5000);
    assert.fail('Should have thrown error');
  } catch (err) {
    assert.strictEqual(err.message, 'Simulated transient loader failure');
  }

  assert.strictEqual(globalTtlCache.inFlight.has(errorKey), false, 'inFlight map must be cleared on failure');

  // Verify next attempt is not blocked
  let recoveryCalls = 0;
  const recoveringLoader = async () => {
    recoveryCalls++;
    return [{ recovered: true }];
  };
  const recRes = await globalTtlCache.getOrSet(errorKey, recoveringLoader, 5000);
  assert.strictEqual(recRes[0].recovered, true);
  assert.strictEqual(recoveryCalls, 1);
  console.log('✓ In-flight state cleanly cleared on error; subsequent requests succeed without blockage.');

  // 6. Verifying Cache Invalidation on Mutations
  console.log('\n6. Verifying Proactive Cache Invalidation Points...');
  // Populate status cache
  await FirestoreRoomStatusService.getRoomStatuses(businessDate);
  const cacheKeySys = `room_status_2026-08-19_with_ledger`;
  assert(globalTtlCache.hasValid(cacheKeySys) === true, 'Cache must be valid before invalidation');

  // Trigger invalidation
  invalidateRoomStatusCache();
  assert(globalTtlCache.hasValid(cacheKeySys) === false, 'Cache must be purged immediately after invalidateRoomStatusCache()');
  console.log('✓ invalidateRoomStatusCache() purged all room_status_ entries.');

  console.log('\n═════════════════════════════════════════════════════════════════════════════');
  console.log('ALL PHASE 1 ROOM STATUS READ OPTIMIZATION TESTS PASSED SUCCESSFULLY!');
  console.log('═════════════════════════════════════════════════════════════════════════════\n');
}

runTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
