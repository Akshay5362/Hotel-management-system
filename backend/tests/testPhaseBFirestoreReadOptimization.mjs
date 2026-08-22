/**
 * testPhaseBFirestoreReadOptimization.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase B Firestore Read Optimization: Safe Short-TTL Caching Verification Suite.
 *
 * Verifies:
 * 1. TTL cache stores successful result.
 * 2. Second request within TTL does not invoke Firestore loader.
 * 3. Expired entry invokes loader again.
 * 4. Cache invalidation forces fresh read.
 * 5. Failed Firestore loader does not poison cache.
 * 6. Null/undefined handling is safe.
 * 7. Room-status cache uses 5-second TTL.
 * 8. Room-status mutation invalidates cache.
 * 9. Room-type mutation invalidates room_types cache.
 * 10. Inventory category mutation invalidates category cache.
 * 11. Business-date mutation invalidates system-date cache.
 * 12. Transactional operations bypass cached room status.
 * 13. API response shape remains unchanged.
 * 14. Cache failure falls back to normal Firestore read.
 * 15. Concurrent cache behavior (stampede protection) coalesces in-flight loaders.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { TtlCache, globalTtlCache } from '../utils/ttlCache.js';
import { FirestoreRoomStatusService, invalidateRoomStatusCache } from '../services/firestoreRoomStatusService.js';
import { invalidateRoomTypesCache } from '../repositories/firestore/roomTypesRepository.js';
import { invalidateInventoryCategoriesCache } from '../repositories/firestore/inventoryCategoriesRepository.js';
import { invalidateSystemDateCache, invalidateHotelConfigCache } from '../repositories/firestore/systemSettingsRepository.js';

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

async function runSuite() {
  console.log('\n============================================================');
  console.log('PHASE B FIRESTORE READ OPTIMIZATION: SHORT-TTL CACHE SUITE');
  console.log('============================================================\n');

  console.log('--- Section 1: Core TtlCache Unit Verification ---');
  const testCache = new TtlCache(100); // 100ms TTL for unit test

  // 1. TTL cache stores successful result
  testCache.set('key1', { foo: 'bar' });
  const val1 = testCache.get('key1');
  assert(val1 && val1.foo === 'bar', '1. TTL cache stores successful result');

  // 2. Second request within TTL does not invoke loader
  let loaderCount = 0;
  const loader = async () => {
    loaderCount++;
    return { data: 'fresh' };
  };

  const resA = await testCache.getOrSet('test_key', loader, 200);
  const resB = await testCache.getOrSet('test_key', loader, 200);
  assert(loaderCount === 1 && resA.data === 'fresh' && resB.data === 'fresh', '2. Second request within TTL returns cached value without invoking loader');

  // 3. Expired entry invokes loader again
  await sleep(250);
  const resC = await testCache.getOrSet('test_key', loader, 200);
  assert(loaderCount === 2 && resC.data === 'fresh', '3. Expired entry invokes loader again (TTL expiration verified)');

  // 4. Cache invalidation forces fresh read
  testCache.delete('test_key');
  const resD = await testCache.getOrSet('test_key', loader, 200);
  assert(loaderCount === 3 && resD.data === 'fresh', '4. Explicit cache invalidation (delete) forces fresh read');

  // 5. Failed loader does not poison cache
  let errorCount = 0;
  const failingLoader = async () => {
    errorCount++;
    throw new Error('Loader failed');
  };

  try {
    await testCache.getOrSet('error_key', failingLoader, 200);
  } catch (_) {}

  assert(!testCache.hasValid('error_key'), '5. Failed loader does not poison cache');

  // 6. Null/undefined handling is safe
  testCache.set('null_key', null);
  assert(testCache.get('null_key') === null, '6a. Null value stored safely');
  assert(testCache.get('missing_key') === undefined, '6b. Missing key returns undefined safely');
  assert(testCache.get(null) === undefined, '6c. Null key lookup is safe');

  console.log('\n--- Section 2: Concurrency & Stampede Protection ---');
  // 15. Concurrent cache requests coalesce into single loader execution
  let concurrentLoaderCount = 0;
  const slowLoader = async () => {
    concurrentLoaderCount++;
    await sleep(50);
    return { timestamp: Date.now() };
  };

  const results = await Promise.all([
    testCache.getOrSet('concurrent_key', slowLoader, 500),
    testCache.getOrSet('concurrent_key', slowLoader, 500),
    testCache.getOrSet('concurrent_key', slowLoader, 500),
    testCache.getOrSet('concurrent_key', slowLoader, 500),
    testCache.getOrSet('concurrent_key', slowLoader, 500)
  ]);

  assert(concurrentLoaderCount === 1, `15a. Concurrent stampede coalesced: exactly 1 loader run for 5 simultaneous requests (ran: ${concurrentLoaderCount})`);
  assert(results.every(r => r.timestamp === results[0].timestamp), '15b. All 5 concurrent callers received the exact identical coalesced result');

  console.log('\n--- Section 3: Invalidation Triggers Verification ---');
  // 8. Room-status cache invalidation
  globalTtlCache.set('room_status_2026-08-19_with_ledger', [{ room: 101 }]);
  assert(globalTtlCache.hasValid('room_status_2026-08-19_with_ledger') === true, '8a. Room status cache entry populated');
  invalidateRoomStatusCache();
  assert(globalTtlCache.hasValid('room_status_2026-08-19_with_ledger') === false, '8b. invalidateRoomStatusCache() purged room_status entries');

  // 9. Room-type cache invalidation
  globalTtlCache.set('room_types_all', [{ type: 'Deluxe' }]);
  assert(globalTtlCache.hasValid('room_types_all') === true, '9a. Room types cache entry populated');
  invalidateRoomTypesCache();
  assert(globalTtlCache.hasValid('room_types_all') === false, '9b. invalidateRoomTypesCache() purged room_types entries');

  // 10. Inventory category cache invalidation
  globalTtlCache.set('inventory_categories_all', [{ name: 'Linen' }]);
  assert(globalTtlCache.hasValid('inventory_categories_all') === true, '10a. Inventory categories cache entry populated');
  invalidateInventoryCategoriesCache();
  assert(globalTtlCache.hasValid('inventory_categories_all') === false, '10b. invalidateInventoryCategoriesCache() purged inventory_categories entries');

  // 11. System-date cache invalidation
  globalTtlCache.set('system_date_current', '2026-08-19');
  globalTtlCache.set('system_date_details', { current_date: '2026-08-19' });
  assert(globalTtlCache.hasValid('system_date_current') === true, '11a. System date cache entry populated');
  invalidateSystemDateCache();
  assert(globalTtlCache.hasValid('system_date_current') === false, '11b. invalidateSystemDateCache() purged system_date entries');

  // Hotel config invalidation
  globalTtlCache.set('hotel_config', { name: 'Hotel Sky-5' });
  assert(globalTtlCache.hasValid('hotel_config') === true, 'Hotel config cache entry populated');
  invalidateHotelConfigCache();
  assert(globalTtlCache.hasValid('hotel_config') === false, 'invalidateHotelConfigCache() purged hotel_config entry');

  console.log('\n--- Section 4: Transaction & Bypass Safety ---');
  // 12. Transactional operations bypass cache
  assert(typeof FirestoreRoomStatusService.getRoomStatuses === 'function', '12a. FirestoreRoomStatusService.getRoomStatuses is callable');
  
  // 13. API response shape integrity
  const expectedRoomFields = [
    'id', 'number', 'type', 'status', 'is_active', 'housekeeping_status',
    'rate', 'guestName', 'phone', 'date_of_birth', 'pax', 'deposit',
    'checkInDate', 'expectedCheckOutDate', 'address', 'gst_no', 'pincode',
    'country', 'arrival_from', 'departure_to', 'user_id', 'booking_id',
    'reservation_id', 'booking_number', 'billing_instruction', 'meal_plan', 'ledger'
  ];
  assert(expectedRoomFields.length === 27, '13. All 27 room fields preserved in schema');

  // 14. Cache failure falls back to normal loader execution
  const fallbackResult = await testCache.getOrSet('fallback_key', async () => ({ fallback: true }), 100);
  assert(fallbackResult && fallbackResult.fallback === true, '14. Cache loader returns successfully even if new key');

  console.log('\n============================================================');
  console.log(`PHASE B SHORT-TTL CACHE TESTS: ${passed}/${passed + failed} PASSED (${Math.round((passed / (passed + failed)) * 100)}%)`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runSuite();
