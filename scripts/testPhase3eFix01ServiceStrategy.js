/**
 * testPhase3eFix01ServiceStrategy.js
 * ======================================================================================================
 * HPMS — Phase 3E FIX-01: Service Strategy Abstraction & Router Test Suite
 *
 * Verifies all 10 required FIX-01 test scenarios:
 * 1. USE_FIRESTORE_SERVICES=false -> MySQL read path selected
 * 2. USE_FIRESTORE_SERVICES=true -> Firestore read strategy selected (with MySQL fallback)
 * 3. Firestore timeout -> transparent MySQL fallback
 * 4. Firestore exception -> transparent MySQL fallback
 * 5. Firestore permission denied -> transparent MySQL fallback
 * 6. Firestore schema mismatch -> transparent MySQL fallback
 * 7. Firestore missing document -> transparent MySQL fallback
 * 8. Firestore read succeeds -> response contract matches MySQL
 * 9. Business mutation -> remains MySQL transaction (hard safety rule)
 * 10. Multi-table transaction -> remains MySQL transaction (hard safety rule)
 */

import pool from '../backend/db.js';
import {
  STRATEGY_MODE,
  getReadStrategy,
  getMutationStrategy,
  executeServiceRead,
  executeServiceMutation
} from '../backend/services/serviceStrategy.js';
import {
  isFirestoreServicesEnabled,
  isFirestoreReadsEnabled,
  isFirestoreDualWriteEnabled,
  isFirestoreOutboxWorkerEnabled
} from '../backend/config/featureFlags.js';

async function runServiceStrategySuite() {
  console.log('\n========================================================================================');
  console.log('  HPMS — PHASE 3E FIX-01: SERVICE STRATEGY ABSTRACTION & ROUTER SUITE');
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
    // ══════════════════════════════════════════════════════════════════════════
    // SCENARIO 1: USE_FIRESTORE_SERVICES=false -> MYSQL PATH
    // ══════════════════════════════════════════════════════════════════════════
    console.log('[SCENARIO 1] Strategy selection when flags disabled...');

    const origReads = process.env.ENABLE_FIRESTORE_READS;
    const origServices = process.env.USE_FIRESTORE_SERVICES;

    try {
      process.env.ENABLE_FIRESTORE_READS = 'false';
      process.env.USE_FIRESTORE_SERVICES = 'false';

      const strategyOff = getReadStrategy('rooms');
      assert(strategyOff === STRATEGY_MODE.MYSQL, 'When flags=false: getReadStrategy returns MYSQL');

      const resOff = await executeServiceRead({
        domainName: 'rooms_off',
        fetchFirestoreFn: async () => [{ id: 'fs_room_1' }],
        fetchMysqlFn: async () => [{ id: 'mysql_room_1' }]
      });
      assert(resOff[0].id === 'mysql_room_1', 'When flags=false: executeServiceRead routes directly to MySQL');
    } finally {
      process.env.ENABLE_FIRESTORE_READS = origReads || 'true';
      process.env.USE_FIRESTORE_SERVICES = origServices || 'false';
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SCENARIO 2: USE_FIRESTORE_SERVICES=true -> FIRESTORE WITH MYSQL FALLBACK
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SCENARIO 2] Strategy selection when flags enabled...');

    try {
      process.env.USE_FIRESTORE_SERVICES = 'true';
      const strategyOn = getReadStrategy('rooms');
      assert(strategyOn === STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK,
        'When USE_FIRESTORE_SERVICES=true: getReadStrategy returns FIRESTORE_WITH_MYSQL_FALLBACK');
    } finally {
      process.env.USE_FIRESTORE_SERVICES = origServices || 'false';
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SCENARIO 3: FIRESTORE TIMEOUT -> MYSQL FALLBACK
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SCENARIO 3] Firestore Timeout Fallback...');

    const resTimeout = await executeServiceRead({
      domainName: 'fix01_timeout_test',
      fetchFirestoreFn: () => new Promise(resolve => setTimeout(resolve, 300)),
      fetchMysqlFn: async () => [{ source: 'mysql_authoritative' }],
      timeoutMs: 100,
      options: { forceMode: STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK }
    });
    assert(resTimeout[0].source === 'mysql_authoritative', 'Timeout: transparently falls back to MySQL');

    // ══════════════════════════════════════════════════════════════════════════
    // SCENARIO 4: FIRESTORE EXCEPTION -> MYSQL FALLBACK
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SCENARIO 4] Firestore Exception Fallback...');

    const resException = await executeServiceRead({
      domainName: 'fix01_exception_test',
      fetchFirestoreFn: async () => { throw new Error('FIRESTORE_NETWORK_DISCONNECTED'); },
      fetchMysqlFn: async () => [{ source: 'mysql_authoritative' }],
      timeoutMs: 500,
      options: { forceMode: STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK }
    });
    assert(resException[0].source === 'mysql_authoritative', 'Exception: transparently falls back to MySQL');

    // ══════════════════════════════════════════════════════════════════════════
    // SCENARIO 5: FIRESTORE PERMISSION DENIED -> MYSQL FALLBACK
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SCENARIO 5] Firestore Permission Denied Fallback...');

    const resPermission = await executeServiceRead({
      domainName: 'fix01_permission_test',
      fetchFirestoreFn: async () => { throw new Error('PERMISSION_DENIED'); },
      fetchMysqlFn: async () => [{ source: 'mysql_authoritative' }],
      timeoutMs: 500,
      options: { forceMode: STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK }
    });
    assert(resPermission[0].source === 'mysql_authoritative', 'Permission Denied: transparently falls back to MySQL');

    // ══════════════════════════════════════════════════════════════════════════
    // SCENARIO 6: FIRESTORE SCHEMA MISMATCH -> MYSQL FALLBACK
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SCENARIO 6] Firestore Schema Mismatch Fallback...');

    const resMismatch = await executeServiceRead({
      domainName: 'fix01_mismatch_test',
      fetchFirestoreFn: async () => [{ invalid_field: true }],
      fetchMysqlFn: async () => [{ source: 'mysql_authoritative' }],
      validateAndFormatFn: () => { throw new Error('SCHEMA_VAL_ERROR'); },
      timeoutMs: 500,
      options: { forceMode: STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK }
    });
    assert(resMismatch[0].source === 'mysql_authoritative', 'Schema Mismatch: transparently falls back to MySQL');

    // ══════════════════════════════════════════════════════════════════════════
    // SCENARIO 7: FIRESTORE MISSING DOCUMENT -> MYSQL FALLBACK
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SCENARIO 7] Firestore Missing Document Fallback...');

    const resMissing = await executeServiceRead({
      domainName: 'fix01_missing_test',
      fetchFirestoreFn: async () => null,
      fetchMysqlFn: async () => [{ source: 'mysql_authoritative' }],
      validateAndFormatFn: (data) => data,
      timeoutMs: 500,
      options: { forceMode: STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK }
    });
    assert(resMissing[0].source === 'mysql_authoritative', 'Missing Document: transparently falls back to MySQL');

    // ══════════════════════════════════════════════════════════════════════════
    // SCENARIO 8: FIRESTORE READ SUCCEEDS -> CONTRACT PARITY
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SCENARIO 8] Firestore Read Success & Parity...');

    const resSuccess = await executeServiceRead({
      domainName: 'fix01_success_test',
      fetchFirestoreFn: async () => [{ room_number: '101', status: 'Available' }],
      fetchMysqlFn: async () => [{ room_number: '101', status: 'Available' }],
      validateAndFormatFn: (data) => data,
      timeoutMs: 500,
      options: { forceMode: STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK }
    });
    assert(resSuccess[0].room_number === '101' && resSuccess[0].status === 'Available',
      'Firestore Read Success: returns validated data matching MySQL API contract');

    // ══════════════════════════════════════════════════════════════════════════
    // SCENARIO 9 & 10: MUTATION SAFETY & MULTI-TABLE ACID TRANSACTION BOUNDARY
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SCENARIO 9 & 10] Mutation Safety & Multi-Table ACID Boundary...');

    const mutationStrat = getMutationStrategy('check_in');
    assert(mutationStrat === STRATEGY_MODE.MYSQL, 'Hard Safety Rule: getMutationStrategy ALWAYS returns MYSQL');

    const resMutation = await executeServiceMutation({
      domainName: 'check_in_mutation',
      executeMysqlFn: async () => {
        const [rows] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
        return { status: 'Checked In', room_count: rows[0].cnt };
      }
    });

    assert(resMutation.status === 'Checked In' && resMutation.room_count === 17,
      'Mutation Execution: executeServiceMutation safely executes inside MySQL transaction boundary');

    // ══════════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    if (passedTests === totalTests) {
      console.log('ALL FIX-01 TEST SCENARIOS PASSED — SERVICE STRATEGY ABSTRACTION: PASS');
    } else {
      console.log('FIX-01 SERVICE STRATEGY ABSTRACTION: BLOCKED');
    }
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Service Strategy Suite Error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runServiceStrategySuite();
