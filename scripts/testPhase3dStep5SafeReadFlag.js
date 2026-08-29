/**
 * testPhase3dStep5SafeReadFlag.js — Phase 3D Step 5: P1 Safe-by-Default Read Flag Verification Suite
 * =====================================================================================================
 * Verifies the P1 fix: isFirestoreReadsEnabled() now uses === 'true' (safe-by-default)
 * instead of !== 'false' (unsafe-by-default).
 *
 * Environment variable simulations are performed via process-local overrides ONLY.
 * The production backend/.env file is NEVER modified.
 * All overrides are restored in a finally block.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import pool from '../backend/db.js';
import {
  isFirestoreReadsEnabled,
  isFirestoreServicesEnabled,
  isFirestoreDualWriteEnabled,
  isFirestoreOutboxWorkerEnabled,
  isFirestoreReconciliationEnabled,
  isDualRbacShadowEnabled,
  isDualReadShadowEnabled,
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

async function runSafeReadFlagTestSuite() {
  console.log('\n========================================================================================');
  console.log('    HPMS — PHASE 3D STEP 5: P1 SAFE-BY-DEFAULT READ FLAG VERIFICATION SUITE');
  console.log('========================================================================================\n');

  let totalTests = 0;
  let passedTests = 0;
  const originalEnvValue = process.env.ENABLE_FIRESTORE_READS;

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
    // ── TEST 1: ENABLE_FIRESTORE_READS missing/undefined → false ─────────────
    console.log('[TEST 1] ENABLE_FIRESTORE_READS missing/undefined => false...');
    const savedVal = process.env.ENABLE_FIRESTORE_READS;
    delete process.env.ENABLE_FIRESTORE_READS;
    assert(process.env.ENABLE_FIRESTORE_READS === undefined,
      'Pre-condition: ENABLE_FIRESTORE_READS env var is undefined for this test');
    assert(isFirestoreReadsEnabled() === false,
      'isFirestoreReadsEnabled() returns FALSE when ENABLE_FIRESTORE_READS is undefined (safe-by-default ✓)');
    process.env.ENABLE_FIRESTORE_READS = savedVal;

    // ── TEST 2: ENABLE_FIRESTORE_READS="false" → false ────────────────────────
    console.log('\n[TEST 2] ENABLE_FIRESTORE_READS="false" => false...');
    process.env.ENABLE_FIRESTORE_READS = 'false';
    assert(isFirestoreReadsEnabled() === false,
      'isFirestoreReadsEnabled() returns FALSE when ENABLE_FIRESTORE_READS="false"');

    // ── TEST 3: ENABLE_FIRESTORE_READS="true" → true (simulated, restored immediately) ──
    console.log('\n[TEST 3] ENABLE_FIRESTORE_READS="true" => true (process-local simulation only)...');
    process.env.ENABLE_FIRESTORE_READS = 'true';
    assert(isFirestoreReadsEnabled() === true,
      'isFirestoreReadsEnabled() returns TRUE when ENABLE_FIRESTORE_READS="true" (process-local only)');
    process.env.ENABLE_FIRESTORE_READS = 'false'; // Restore to safe immediately

    // ── TEST 4: Verify all global Firestore flags remain safe-by-default ──────
    console.log('\n[TEST 4] Global Firestore flags safe-by-default audit...');
    assert(isFirestoreReadsEnabled() === false,
      'ENABLE_FIRESTORE_READS is false (after restore)');
    assert(isFirestoreServicesEnabled() === false,
      'USE_FIRESTORE_SERVICES is false (=== "true" default safe)');
    assert(isFirestoreDualWriteEnabled() === false,
      'ENABLE_FIRESTORE_DUAL_WRITE is false (=== "true" default safe)');
    assert(isFirestoreOutboxWorkerEnabled() === false,
      'ENABLE_FIRESTORE_OUTBOX_WORKER is false (=== "true" default safe)');
    assert(isFirestoreReconciliationEnabled() === false,
      'ENABLE_FIRESTORE_RECONCILIATION is false (=== "true" default safe)');
    assert(isDualRbacShadowEnabled() === false,
      'ENABLE_DUAL_RBAC_SHADOW is false (=== "true" default safe)');
    assert(isDualReadShadowEnabled() === false,
      'ENABLE_DUAL_READ_SHADOW is false (=== "true" default safe)');

    // ── TEST 5: All 9 individual read-canary flags remain false by default ────
    console.log('\n[TEST 5] 9 individual read-canary flags safe-by-default audit...');
    assert(isRoomsReadCanaryEnabled() === false,
      'ENABLE_FIRESTORE_ROOMS_READ_CANARY is false');
    assert(isRoomTypesReadCanaryEnabled() === false,
      'ENABLE_FIRESTORE_ROOM_TYPES_READ_CANARY is false');
    assert(isInventoryCategoriesReadCanaryEnabled() === false,
      'ENABLE_FIRESTORE_INVENTORY_CATEGORIES_READ_CANARY is false');
    assert(isInventoryProductsReadCanaryEnabled() === false,
      'ENABLE_FIRESTORE_INVENTORY_PRODUCTS_READ_CANARY is false');
    assert(isSettingsReadCanaryEnabled() === false,
      'ENABLE_FIRESTORE_SETTINGS_READ_CANARY is false');
    assert(isHousekeepingReadCanaryEnabled() === false,
      'ENABLE_FIRESTORE_HOUSEKEEPING_READ_CANARY is false');
    assert(isStaffReadCanaryEnabled() === false,
      'ENABLE_FIRESTORE_STAFF_READ_CANARY is false');
    assert(isReservationsReadCanaryEnabled() === false,
      'ENABLE_FIRESTORE_RESERVATIONS_READ_CANARY is false');
    assert(isMyPaymentsReadCanaryEnabled() === false,
      'ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY is false');

    // ── TEST 6: Production .env still contains ENABLE_FIRESTORE_READS=false ───
    console.log('\n[TEST 6] Production backend/.env contains ENABLE_FIRESTORE_READS=false...');
    const envPath = resolve(process.cwd(), 'backend', '.env');
    assert(existsSync(envPath), 'backend/.env file exists');
    const envContent = readFileSync(envPath, 'utf-8');
    assert(envContent.includes('ENABLE_FIRESTORE_READS=false'),
      'backend/.env contains explicit ENABLE_FIRESTORE_READS=false (unchanged)');
    assert(!envContent.includes('ENABLE_FIRESTORE_READS=true'),
      'backend/.env does NOT contain ENABLE_FIRESTORE_READS=true');

    // ── TEST 7: Verify featureFlags.js source code uses safe === 'true' logic ─
    console.log('\n[TEST 7] featureFlags.js source code audit...');
    const flagsPath = resolve(process.cwd(), 'backend', 'config', 'featureFlags.js');
    assert(existsSync(flagsPath), 'backend/config/featureFlags.js exists');
    const flagsContent = readFileSync(flagsPath, 'utf-8');
    assert(flagsContent.includes("process.env.ENABLE_FIRESTORE_READS === 'true'"),
      'featureFlags.js uses safe === "true" logic for ENABLE_FIRESTORE_READS');
    assert(!flagsContent.includes("process.env.ENABLE_FIRESTORE_READS !== 'false'"),
      'featureFlags.js no longer uses unsafe !== "false" logic');

    // ── TEST 8: GET /api/health returns HTTP 200 ──────────────────────────────
    console.log('\n[TEST 8] GET /api/health → HTTP 200...');
    try {
      const response = await fetch('http://localhost:5000/api/health');
      assert(response.status === 200, `GET /api/health returned HTTP ${response.status} (200 expected)`);
    } catch (err) {
      assert(false, `GET /api/health request failed: ${err.message}`);
    }

    // ── TEST 9: MySQL remains authoritative ───────────────────────────────────
    console.log('\n[TEST 9] MySQL authoritative read path...');
    const [rooms] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    assert(rooms[0].cnt === 17, 'MySQL rooms table returns 17 rows (authoritative baseline intact)');
    const [bkgs] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    assert(bkgs[0].cnt === 1, 'MySQL bookings table returns 1 row (authoritative baseline intact)');

    // ── TEST 10: No production business mutations ──────────────────────────────
    console.log('\n[TEST 10] Zero production business data mutations audit...');
    const [invCount] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [payCount] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
    assert(invCount[0].cnt === 2, 'Invoices row count remains 2');
    assert(payCount[0].cnt === 1, 'Payments row count remains 1');

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
    // Always restore original env value
    if (originalEnvValue !== undefined) {
      process.env.ENABLE_FIRESTORE_READS = originalEnvValue;
    } else {
      delete process.env.ENABLE_FIRESTORE_READS;
    }
    await pool.end();
  }
}

runSafeReadFlagTestSuite();
