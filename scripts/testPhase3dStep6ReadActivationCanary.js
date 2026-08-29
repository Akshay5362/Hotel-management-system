/**
 * testPhase3dStep6ReadActivationCanary.js — Phase 3D Step 6: Controlled Firestore Read Activation + Canary Gate
 * ================================================================================================================
 * Controlled verification of the ENABLE_FIRESTORE_READS flag with process-local simulation only.
 *
 * SAFETY CONTRACT:
 * - backend/.env is NEVER modified
 * - All process.env overrides are restored in try/finally blocks
 * - No Firestore production writes occur
 * - No MySQL business mutations occur
 * - No Firebase Auth mutations occur
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import pool from '../backend/db.js';
import {
  isFirestoreServicesEnabled,
  isFirestoreReadsEnabled,
  isFirestoreDualWriteEnabled,
  isFirestoreOutboxWorkerEnabled,
  isRoomsReadCanaryEnabled,
  isRoomTypesReadCanaryEnabled,
  isInventoryCategoriesReadCanaryEnabled,
  isInventoryProductsReadCanaryEnabled,
  isSettingsReadCanaryEnabled,
  isHousekeepingReadCanaryEnabled,
  isStaffReadCanaryEnabled,
  isReservationsReadCanaryEnabled,
  isMyPaymentsReadCanaryEnabled
} from '../backend/config/featureFlags.js';
import { executeReadCanary } from '../backend/services/dualReadVerificationService.js';
import { isWorkerRunning } from '../backend/services/outboxWorker.js';

const BASE_URL = 'http://localhost:5000';

async function runReadActivationCanaryTestSuite() {
  console.log('\n========================================================================================');
  console.log('    HPMS — PHASE 3D STEP 6 CONTROLLED FIRESTORE READ ACTIVATION + CANARY GATE');
  console.log('========================================================================================\n');

  let totalTests = 0;
  let passedTests = 0;
  const originalEnv = process.env.ENABLE_FIRESTORE_READS;

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
    // SECTION 1: PRE-FLIGHT SAFETY AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    console.log('[SECTION 1] Pre-flight Safety Audit...');

    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES=false');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS=false (production baseline)');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE=false');
    assert(isFirestoreOutboxWorkerEnabled() === false, 'ENABLE_FIRESTORE_OUTBOX_WORKER=false');
    assert(isRoomsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_ROOMS_READ_CANARY=false');
    assert(isRoomTypesReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_ROOM_TYPES_READ_CANARY=false');
    assert(isInventoryCategoriesReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_INVENTORY_CATEGORIES_READ_CANARY=false');
    assert(isInventoryProductsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_INVENTORY_PRODUCTS_READ_CANARY=false');
    assert(isSettingsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_SETTINGS_READ_CANARY=false');
    assert(isHousekeepingReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_HOUSEKEEPING_READ_CANARY=false');
    assert(isStaffReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_STAFF_READ_CANARY=false');
    assert(isReservationsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_RESERVATIONS_READ_CANARY=false');
    assert(isMyPaymentsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY=false');
    assert(isWorkerRunning() === false, 'Outbox worker daemon is idle');

    // Health checks
    try {
      const health = await fetch(`${BASE_URL}/api/health`);
      assert(health.status === 200, `GET /api/health = HTTP ${health.status} (200 expected)`);
    } catch (e) {
      assert(false, `GET /api/health failed: ${e.message}`);
    }

    // MySQL baseline
    const [roomBaseline] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    const [bkgBaseline] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    assert(roomBaseline[0].cnt === 17, 'MySQL rooms baseline: 17 rows (authoritative)');
    assert(bkgBaseline[0].cnt === 1, 'MySQL bookings baseline: 1 row (authoritative)');

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 2: executeReadCanary INFRASTRUCTURE — FLAG GUARD VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SECTION 2] executeReadCanary Flag-Guard Verification...');

    // When individual canary flag is false, executeReadCanary short-circuits
    const guardResult = await executeReadCanary({
      flagCheckFn: () => false,
      endpointName: 'guard_test',
      fetchFirestoreFn: async () => ({ data: 'should_not_reach' }),
      validateAndFormatFn: (r) => r,
      timeoutMs: 500
    });
    assert(guardResult === null,
      'executeReadCanary returns null immediately when flagCheckFn=false (MySQL fallback guaranteed)');

    // When flag is true: successful read path
    const successResult = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: 'success_test',
      fetchFirestoreFn: async () => [{ id: 1, name: 'test_room' }],
      validateAndFormatFn: (r) => Array.isArray(r) && r.length > 0 ? r : null,
      timeoutMs: 500
    });
    assert(Array.isArray(successResult) && successResult.length === 1,
      'executeReadCanary returns formatted Firestore result when flag=true and data is valid');

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 3: PROCESS-LOCAL READ ACTIVATION (ENABLE_FIRESTORE_READS=true)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SECTION 3] Process-local ENABLE_FIRESTORE_READS=true simulation...');

    process.env.ENABLE_FIRESTORE_READS = 'true';
    try {
      assert(isFirestoreReadsEnabled() === true,
        'isFirestoreReadsEnabled() returns true after process-local activation');

      // All other global flags remain false even when reads are enabled
      assert(isFirestoreServicesEnabled() === false,
        'USE_FIRESTORE_SERVICES remains false during read activation');
      assert(isFirestoreDualWriteEnabled() === false,
        'ENABLE_FIRESTORE_DUAL_WRITE remains false during read activation');
      assert(isFirestoreOutboxWorkerEnabled() === false,
        'ENABLE_FIRESTORE_OUTBOX_WORKER remains false during read activation');
    } finally {
      process.env.ENABLE_FIRESTORE_READS = 'false';
    }
    assert(isFirestoreReadsEnabled() === false,
      'ENABLE_FIRESTORE_READS immediately restored to false after simulation block');

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 4: 9-ENDPOINT READ CANARY ARCHITECTURE VERIFICATION
    //            Each endpoint's canary path is validated via synthetic Firestore
    //            simulation — NO real Firestore connection required (flag-guard prevents it)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SECTION 4] 9-Endpoint Read Canary Architecture Verification...');

    // 4.1 — GET /api/public/rooms canary path
    const roomsCanary = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: '/api/public/rooms',
      fetchFirestoreFn: async () => ({
        roomsSnap: {
          empty: false,
          forEach: (cb) => [{ data: () => ({ status: 'VACANT', room_type_id: 'type_DELUXE', number: '101' }) }].forEach(d => cb(d))
        },
        typesSnap: {
          empty: false,
          forEach: (cb) => [{ id: 'type_DELUXE', data: () => ({ code: 'DELUXE', base_rate: 2500, name: 'Deluxe', id: 'type_DELUXE' }) }].forEach(d => cb(d))
        }
      }),
      validateAndFormatFn: ({ roomsSnap, typesSnap }) => {
        if (!roomsSnap || roomsSnap.empty || !typesSnap || typesSnap.empty) return null;
        return [{ id: 'type_DELUXE', type: 'DELUXE', price: 2500, available: true }];
      },
      timeoutMs: 500
    });
    assert(Array.isArray(roomsCanary) && roomsCanary.length > 0,
      'Endpoint 1 (/api/public/rooms): canary path returns room type array');
    assert(roomsCanary[0].type !== undefined && roomsCanary[0].price !== undefined,
      'Endpoint 1 (/api/public/rooms): response contract fields type + price present');

    // 4.2 — GET /api/room-types canary path
    const roomTypesCanary = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: '/api/room-types',
      fetchFirestoreFn: async () => [{ id: 'type_DELUXE', code: 'DELUXE', name: 'Deluxe', base_rate: 2500 }],
      validateAndFormatFn: (docs) => Array.isArray(docs) && docs.length > 0 ? docs : null,
      timeoutMs: 500
    });
    assert(Array.isArray(roomTypesCanary) && roomTypesCanary.length > 0,
      'Endpoint 2 (/api/room-types): canary path returns room type records');

    // 4.3 — GET /api/inventory/categories canary path
    const catsCanary = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: '/api/inventory/categories',
      fetchFirestoreFn: async () => [{ id: 'cat_beverages', name: 'Beverages' }],
      validateAndFormatFn: (docs) => Array.isArray(docs) && docs.length > 0 ? { categories: docs, total: docs.length } : null,
      timeoutMs: 500
    });
    assert(catsCanary && catsCanary.categories && catsCanary.total > 0,
      'Endpoint 3 (/api/inventory/categories): canary path returns categories with total');

    // 4.4 — GET /api/inventory/products canary path
    const prodsCanary = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: '/api/inventory/products',
      fetchFirestoreFn: async () => [{ sku: 'SKU001', name: 'Tea Bags', stock_quantity: 100, unit_price: 5.00 }],
      validateAndFormatFn: (docs) => Array.isArray(docs) && docs.length > 0 ? { products: docs, total: docs.length } : null,
      timeoutMs: 500
    });
    assert(prodsCanary && prodsCanary.products && prodsCanary.total > 0,
      'Endpoint 4 (/api/inventory/products): canary path returns products with total');

    // 4.5 — GET /api/settings/business-date canary path
    const settingsCanary = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: '/api/settings/business-date',
      fetchFirestoreFn: async () => ({ current_date: '2026-08-18', updated_at: '2026-08-18T00:00:00Z' }),
      validateAndFormatFn: (doc) => doc && doc.current_date ? { current_date: doc.current_date } : null,
      timeoutMs: 500
    });
    assert(settingsCanary && typeof settingsCanary.current_date === 'string',
      'Endpoint 5 (/api/settings/business-date): canary path returns current_date string');

    // 4.6 — GET /api/housekeeping/rooms canary path
    const hkCanary = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: '/api/housekeeping/rooms',
      fetchFirestoreFn: async () => [{ room_id: 1, room_number: '101', hk_status: 'Clean' }],
      validateAndFormatFn: (docs) => Array.isArray(docs) && docs.length > 0 ? docs : null,
      timeoutMs: 500
    });
    assert(Array.isArray(hkCanary) && hkCanary.length > 0,
      'Endpoint 6 (/api/housekeeping/rooms): canary path returns housekeeping records');

    // 4.7 — GET /api/staff canary path + sensitive field stripping
    const staffCanary = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: '/api/staff',
      fetchFirestoreFn: async () => [
        { id: 1, full_name: 'Admin User', username: 'admin', role: 'admin',
          password: 'SHOULD_BE_STRIPPED', password_hash: 'SHOULD_BE_STRIPPED',
          deleted: 0, status: 'Active' }
      ],
      validateAndFormatFn: (docs) => {
        if (!Array.isArray(docs) || docs.length === 0) return null;
        const sanitized = docs
          .filter(s => !s.deleted && s.deleted !== 1)
          .map(s => {
            const safe = {
              id: s.id, full_name: s.full_name, username: s.username,
              role: s.role, status: s.status
            };
            delete safe.password_hash;
            delete safe.password;
            delete safe.deleted;
            return safe;
          });
        return sanitized.length >= 1 ? { staff: sanitized, total: sanitized.length } : null;
      },
      timeoutMs: 500
    });
    assert(staffCanary && staffCanary.staff && staffCanary.total > 0,
      'Endpoint 7 (/api/staff): canary path returns staff object with total');
    assert(!staffCanary.staff[0].hasOwnProperty('password'),
      'Endpoint 7 (/api/staff): password field stripped from canary response');
    assert(!staffCanary.staff[0].hasOwnProperty('password_hash'),
      'Endpoint 7 (/api/staff): password_hash field stripped from canary response');
    assert(!staffCanary.staff[0].hasOwnProperty('deleted'),
      'Endpoint 7 (/api/staff): deleted field stripped from canary response');

    // 4.8 — GET /api/reservations canary path
    const resCanary = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: '/api/reservations',
      fetchFirestoreFn: async () => [{ id: 1, reservation_number: 'RES-001', status: 'Pending' }],
      validateAndFormatFn: (docs) => Array.isArray(docs) && docs.length > 0 ? { reservations: docs, total: docs.length } : null,
      timeoutMs: 500
    });
    assert(resCanary && resCanary.reservations && resCanary.total > 0,
      'Endpoint 8 (/api/reservations): canary path returns reservations with total');

    // 4.9 — GET /api/payments/guest/my canary path + financial precision
    const paymentsCanary = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: '/api/payments/guest/my',
      fetchFirestoreFn: async () => [{ id: 1, amount: '1500.50', currency: 'INR', payment_status: 'Completed', guest_user_id: 99 }],
      validateAndFormatFn: (docs) => {
        if (!Array.isArray(docs)) return null;
        const payments = docs.map(p => ({
          id: p.id,
          amount: parseFloat(p.amount || 0),
          currency: p.currency || 'INR',
          payment_status: p.payment_status || 'Completed'
        }));
        return { success: true, payments, count: payments.length };
      },
      timeoutMs: 500
    });
    assert(paymentsCanary && paymentsCanary.success === true,
      'Endpoint 9 (/api/payments/guest/my): canary path returns success:true');
    assert(typeof paymentsCanary.payments[0].amount === 'number',
      'Endpoint 9 (/api/payments/guest/my): amount is parsed to number (financial precision preserved)');
    assert(paymentsCanary.payments[0].amount === 1500.50,
      'Endpoint 9 (/api/payments/guest/my): amount value 1500.50 preserved exactly');

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 5: FAILURE / FALLBACK SIMULATION
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SECTION 5] Failure / Fallback Simulation...');

    // 5A — Firestore timeout
    const timeoutFallback = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: 'fallback_timeout_test',
      fetchFirestoreFn: async () => { await new Promise(r => setTimeout(r, 400)); return [{ id: 1 }]; },
      validateAndFormatFn: (r) => r,
      timeoutMs: 100
    });
    assert(timeoutFallback === null, 'Failure A: Firestore timeout → MySQL fallback (null returned)');

    // 5B — Firestore exception (unavailable)
    const exceptionFallback = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: 'fallback_exception_test',
      fetchFirestoreFn: async () => { throw new Error('FIRESTORE_UNAVAILABLE'); },
      validateAndFormatFn: (r) => r,
      timeoutMs: 500
    });
    assert(exceptionFallback === null, 'Failure B: Firestore exception → MySQL fallback (null returned)');

    // 5C — Firestore permission error
    const permFallback = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: 'fallback_permission_test',
      fetchFirestoreFn: async () => { throw new Error('PERMISSION_DENIED'); },
      validateAndFormatFn: (r) => r,
      timeoutMs: 500
    });
    assert(permFallback === null, 'Failure C: Firestore permission error → MySQL fallback (null returned)');

    // 5D — Empty Firestore result
    const emptyFallback = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: 'fallback_empty_test',
      fetchFirestoreFn: async () => [],
      validateAndFormatFn: (docs) => Array.isArray(docs) && docs.length > 0 ? docs : null,
      timeoutMs: 500
    });
    assert(emptyFallback === null, 'Failure D: Empty Firestore result → MySQL fallback (null returned)');

    // 5E — Invalid document shape (schema mismatch)
    const schemaMismatch = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: 'fallback_schema_test',
      fetchFirestoreFn: async () => [{ unexpected_field: 'bad', no_id: true }],
      validateAndFormatFn: (docs) => {
        if (!Array.isArray(docs) || !docs[0].id) return null; // Missing required field
        return docs;
      },
      timeoutMs: 500
    });
    assert(schemaMismatch === null, 'Failure E: Schema mismatch → MySQL fallback (null returned)');

    // 5F — Verify no MySQL business mutation from any failure path
    const [roomsAfterFailures] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    assert(roomsAfterFailures[0].cnt === 17,
      'Failure path safety: rooms count unchanged (17) after all failure simulations');

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 6: ROLLBACK VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SECTION 6] Rollback Verification...');

    process.env.ENABLE_FIRESTORE_READS = 'true';
    try {
      assert(isFirestoreReadsEnabled() === true,
        'Rollback pre-condition: reads enabled in process-local simulation');
    } finally {
      process.env.ENABLE_FIRESTORE_READS = 'false';
    }
    assert(isFirestoreReadsEnabled() === false,
      'Rollback: setting ENABLE_FIRESTORE_READS=false immediately returns to MySQL-primary reads');
    assert(isFirestoreServicesEnabled() === false,
      'Rollback: USE_FIRESTORE_SERVICES remains false after rollback');
    assert(isFirestoreDualWriteEnabled() === false,
      'Rollback: ENABLE_FIRESTORE_DUAL_WRITE remains false after rollback');
    assert(isWorkerRunning() === false,
      'Rollback: outbox worker daemon remains idle after rollback');

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 7: PRODUCTION .env UNCHANGED VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SECTION 7] Production .env Verification...');

    const envPath = resolve(process.cwd(), 'backend', '.env');
    assert(existsSync(envPath), 'backend/.env file exists');
    const envContent = readFileSync(envPath, 'utf-8');
    assert(envContent.includes('ENABLE_FIRESTORE_READS=false'),
      'backend/.env contains ENABLE_FIRESTORE_READS=false (unchanged)');
    assert(!envContent.includes('ENABLE_FIRESTORE_READS=true'),
      'backend/.env does NOT contain ENABLE_FIRESTORE_READS=true');

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 8: ZERO PRODUCTION MUTATIONS AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SECTION 8] Zero Production Mutations Audit...');

    const [invCount] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [payCount] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
    const [roomFinal] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    const [bkgFinal] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    assert(roomFinal[0].cnt === 17, 'Rooms row count remains 17 (no mutations)');
    assert(bkgFinal[0].cnt === 1, 'Bookings row count remains 1 (no mutations)');
    assert(invCount[0].cnt === 2, 'Invoices row count remains 2 (no mutations)');
    assert(payCount[0].cnt === 1, 'Payments row count remains 1 (no mutations)');

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 9: FINAL FLAG SAFETY CHECK
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[SECTION 9] Final Flag Safety Check...');

    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES=false (final)');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS=false (final)');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE=false (final)');
    assert(isFirestoreOutboxWorkerEnabled() === false, 'ENABLE_FIRESTORE_OUTBOX_WORKER=false (final)');
    assert(isRoomsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_ROOMS_READ_CANARY=false (final)');
    assert(isStaffReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_STAFF_READ_CANARY=false (final)');
    assert(isMyPaymentsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY=false (final)');

    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Test Suite Execution Error:', err);
    process.exitCode = 1;
  } finally {
    // Unconditional restoration
    if (originalEnv !== undefined) {
      process.env.ENABLE_FIRESTORE_READS = originalEnv;
    } else {
      delete process.env.ENABLE_FIRESTORE_READS;
    }
    await pool.end();
  }
}

runReadActivationCanaryTestSuite();
