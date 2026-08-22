import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';
import { GuestAdminService, invalidateGuestDirectoryCache, GUEST_DIRECTORY_CACHE_KEY } from '../services/guestAdminService.js';
import { globalTtlCache } from '../utils/ttlCache.js';
import { readBudgetMonitor } from '../utils/firestoreReadBudget.js';

console.log('═════════════════════════════════════════════════════════════════════════════');
console.log('HPMS — PHASE 3A GUEST DIRECTORY FIRESTORE READ OPTIMIZATION TEST SUITE');
console.log('═════════════════════════════════════════════════════════════════════════════\n');

async function runTests() {
  console.log('1. Verifying Guest Directory Baseline & Single Request Behavior...');
  invalidateGuestDirectoryCache();

  // Reset metrics
  const initialBudgetReads = readBudgetMonitor.estimatedReadsToday;

  // Request 1: Fresh read (Cache Miss)
  console.log('Executing Request 1 (Initial fetch on cold cache)...');
  const res1 = await GuestAdminService.listGuests({ page: 1, limit: 25, q: '', filter: 'all' });
  assert(res1 && Array.isArray(res1.guests), 'res1 must contain a guests array');
  assert(res1.stats && typeof res1.stats.total === 'number', 'res1 must contain stats');
  assert(res1.pagination && typeof res1.pagination.total === 'number', 'res1 must contain pagination metadata');

  const readsAfterReq1 = readBudgetMonitor.estimatedReadsToday;
  const req1DocsRead = readsAfterReq1 - initialBudgetReads;
  console.log(`✓ Request 1 completed. Returned ${res1.guests.length} guests (Total: ${res1.stats.total}). Firestore reads consumed: ${req1DocsRead}`);
  assert(req1DocsRead > 0, 'Request 1 must perform initial Firestore reads');

  // Verify response schema parity
  if (res1.guests.length > 0) {
    const sample = res1.guests[0];
    const expectedKeys = ['id', 'full_name', 'phone', 'loyalty_tier', 'total_bookings', 'lifetime_spend'];
    for (const k of expectedKeys) {
      assert(sample[k] !== undefined, `Sample guest missing key '${k}'`);
    }
  }
  const statKeys = ['total', 'inhouse', 'checkedout', 'vip', 'blacklisted', 'new_today'];
  for (const sk of statKeys) {
    assert(res1.stats[sk] !== undefined, `Stats missing key '${sk}'`);
  }
  console.log('✓ Response schema verified (guests array, KPI stats, pagination metadata).');

  // Request 2: Immediate follow-up within 15s cache TTL (Cache Hit)
  console.log('\n2. Verifying Immediate Cache Hit & Zero Duplicate Reads...');
  const readsBeforeReq2 = readBudgetMonitor.estimatedReadsToday;
  const res2 = await GuestAdminService.listGuests({ page: 1, limit: 25, q: '', filter: 'all' });
  const readsAfterReq2 = readBudgetMonitor.estimatedReadsToday;
  const req2DocsRead = readsAfterReq2 - readsBeforeReq2;

  assert.strictEqual(req2DocsRead, 0, 'Request 2 within TTL MUST NOT consume ANY Firestore reads (0 reads)');
  assert.strictEqual(res2.stats.total, res1.stats.total, 'res2 stats must match res1 stats');
  assert.strictEqual(res2.guests.length, res1.guests.length, 'res2 guests length must match res1');
  console.log(`✓ Request 2 (Cache Hit) completed with ZERO (${req2DocsRead}) Firestore document reads.`);

  // 3. Verifying Filter Switching on Warm Cache
  console.log('\n3. Verifying Filter & Tab Switching with ZERO Firestore Reads...');
  const readsBeforeFilters = readBudgetMonitor.estimatedReadsToday;

  const inHouseRes = await GuestAdminService.listGuests({ page: 1, limit: 25, filter: 'inhouse' });
  const vipRes = await GuestAdminService.listGuests({ page: 1, limit: 25, filter: 'vip' });
  const checkedOutRes = await GuestAdminService.listGuests({ page: 1, limit: 25, filter: 'checkedout' });
  const reservedRes = await GuestAdminService.listGuests({ page: 1, limit: 25, filter: 'reserved' });

  const readsAfterFilters = readBudgetMonitor.estimatedReadsToday;
  const filterDocsRead = readsAfterFilters - readsBeforeFilters;

  assert.strictEqual(filterDocsRead, 0, 'Switching filters on warm cache MUST consume 0 Firestore reads');
  console.log(`✓ 4 Filter switches (inhouse, vip, checkedout, reserved) executed with ZERO (${filterDocsRead}) Firestore reads.`);

  // 4. Verifying Search Queries with ZERO Firestore Reads
  console.log('\n4. Verifying Search Queries on Warm Cache...');
  const readsBeforeSearch = readBudgetMonitor.estimatedReadsToday;

  const searchName = await GuestAdminService.searchGuests('Aksh', { limit: 10 });
  const searchPhone = await GuestAdminService.searchGuests('98', { limit: 10 });
  const searchStaff = await GuestAdminService.searchGuestsStaff('A', { limit: 10 });

  const readsAfterSearch = readBudgetMonitor.estimatedReadsToday;
  const searchDocsRead = readsAfterSearch - readsBeforeSearch;

  assert.strictEqual(searchDocsRead, 0, 'Searching on warm cache MUST consume 0 Firestore reads');
  console.log(`✓ 3 Search operations executed with ZERO (${searchDocsRead}) Firestore reads.`);

  // 5. Verifying In-Flight Request Deduplication (Single-Flight / Stampede Protection)
  console.log('\n5. Verifying Single-Flight Request Deduplication...');
  invalidateGuestDirectoryCache();

  const readsBeforeStampede = readBudgetMonitor.estimatedReadsToday;
  console.log('Dispatching 5 concurrent Guest Directory requests simultaneously on cold cache...');
  const concurrentResults = await Promise.all([
    GuestAdminService.listGuests({ page: 1, limit: 25, filter: 'all' }),
    GuestAdminService.listGuests({ page: 1, limit: 25, filter: 'inhouse' }),
    GuestAdminService.listGuests({ page: 1, limit: 25, filter: 'vip' }),
    GuestAdminService.searchGuests('Test', { limit: 10 }),
    GuestAdminService.searchGuestsStaff('Test', { limit: 10 })
  ]);
  const readsAfterStampede = readBudgetMonitor.estimatedReadsToday;
  const stampedeDocsRead = readsAfterStampede - readsBeforeStampede;

  assert.strictEqual(concurrentResults.length, 5, 'All 5 concurrent requests must resolve');
  console.log(`✓ 5 concurrent requests coalesced into 1 in-flight fetch. Total reads consumed: ${stampedeDocsRead} (approx 1 fetch).`);
  assert(stampedeDocsRead <= req1DocsRead + 5, 'Stampede protection prevented 5x duplicate reads');

  // 6. Verifying Cache Expiry & Refresh
  console.log('\n6. Verifying Short-TTL Expiry & Refresh...');
  const shortTtl = 150; // 150ms test TTL
  const testKey = 'test_guest_dir_expiry';
  let loaderCount = 0;
  const testLoader = async () => {
    loaderCount++;
    return [{ id: 'test_1', version: loaderCount }];
  };

  const t1 = await globalTtlCache.getOrSet(testKey, testLoader, shortTtl);
  assert.strictEqual(t1[0].version, 1);
  assert.strictEqual(loaderCount, 1);

  // Immediate read -> Cache Hit
  const t2 = await globalTtlCache.getOrSet(testKey, testLoader, shortTtl);
  assert.strictEqual(t2[0].version, 1);
  assert.strictEqual(loaderCount, 1);

  // Wait for TTL expiry
  console.log('Waiting for short TTL to expire...');
  await new Promise(r => setTimeout(r, 200));

  const t3 = await globalTtlCache.getOrSet(testKey, testLoader, shortTtl);
  assert.strictEqual(t3[0].version, 2);
  assert.strictEqual(loaderCount, 2);
  console.log('✓ Cache expiration refreshed data accurately.');

  // 7. Verifying Mutation Invalidation
  console.log('\n7. Verifying Proactive Mutation Invalidation Points...');
  // Populate cache
  await GuestAdminService.listGuests({ page: 1, limit: 25 });
  assert(globalTtlCache.hasValid(GUEST_DIRECTORY_CACHE_KEY) === true, 'Cache must be populated');

  // Invalidate
  invalidateGuestDirectoryCache();
  assert(globalTtlCache.hasValid(GUEST_DIRECTORY_CACHE_KEY) === false, 'Cache must be purged immediately after invalidateGuestDirectoryCache()');
  console.log('✓ invalidateGuestDirectoryCache() successfully purged cached guest directory.');

  console.log('\n═════════════════════════════════════════════════════════════════════════════');
  console.log('ALL PHASE 3A GUEST DIRECTORY READ OPTIMIZATION TESTS PASSED SUCCESSFULLY!');
  console.log('═════════════════════════════════════════════════════════════════════════════\n');
}

runTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
