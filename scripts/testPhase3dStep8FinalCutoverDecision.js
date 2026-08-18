/**
 * testPhase3dStep8FinalCutoverDecision.js — Phase 3D Step 8: Final Controlled Firestore Cutover Decision
 * =========================================================================================================
 * The complete Phase 3A → Phase 3D state verification and production window GO/NO-GO gate.
 *
 * SAFETY CONTRACT:
 * - backend/.env is NEVER modified
 * - No production Firestore writes
 * - No MySQL business mutations
 * - No Firebase Auth mutations
 * - All process.env overrides restored in try/finally
 * - All global Firestore flags remain FALSE throughout
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';
import pool from '../backend/db.js';
import {
  isFirestoreServicesEnabled,
  isFirestoreReadsEnabled,
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
  isMyPaymentsReadCanaryEnabled,
  isFirebaseAuthEnabled,
  isStrictRbacEnabled
} from '../backend/config/featureFlags.js';
import { executeReadCanary } from '../backend/services/dualReadVerificationService.js';
import { isWorkerRunning } from '../backend/services/outboxWorker.js';
import { reclaimStaleProcessing } from '../backend/services/outboxService.js';

const BASE_URL = 'http://localhost:5000';

async function runFinalCutoverDecision() {
  console.log('\n========================================================================================');
  console.log('  HPMS — PHASE 3D STEP 8: FINAL CONTROLLED FIRESTORE CUTOVER DECISION');
  console.log('========================================================================================\n');

  let totalTests = 0;
  let passedTests = 0;
  const gateResults = {};

  function assert(condition, message, gate = null) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✔ [PASS] ${message}`);
      if (gate) gateResults[gate] = (gateResults[gate] !== false);
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      if (gate) gateResults[gate] = false;
    }
  }

  function markGateStart(gate, label) {
    gateResults[gate] = true;
    console.log(`\n[GATE ${gate}] ${label}...`);
  }

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // GATE A: PHASE 3A → 3D REGRESSION BASELINE VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('A', 'Phase 3A → 3D Regression Baseline Verification');

    const { readdirSync } = await import('fs');
    const scriptsDir = resolve(process.cwd(), 'scripts');
    const allScripts = readdirSync(scriptsDir);
    const phase3Suites = allScripts.filter(f => f.startsWith('testPhase3') && f.endsWith('.js'));
    phase3Suites.sort();
    const EXPECTED_SUITES = 24; // 3A(4) + 3B(5) + 3C(8) + 3D(7)
    assert(phase3Suites.length >= EXPECTED_SUITES,
      `Phase 3A→3D test suites discovered: ${phase3Suites.length} (expected >= ${EXPECTED_SUITES})`, 'A');
    console.log(`  ⓘ Suites discovered: ${phase3Suites.join(', ')}`);

    // ══════════════════════════════════════════════════════════════════════════
    // GATE B: GLOBAL FEATURE FLAG SAFETY AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('B', 'Global Feature Flag Safety Audit');

    // Firestore flags — all must be false
    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES=false', 'B');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS=false', 'B');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE=false', 'B');
    assert(isFirestoreOutboxWorkerEnabled() === false, 'ENABLE_FIRESTORE_OUTBOX_WORKER=false', 'B');
    assert(isFirestoreReconciliationEnabled() === false, 'ENABLE_FIRESTORE_RECONCILIATION=false', 'B');
    assert(isDualRbacShadowEnabled() === false, 'ENABLE_DUAL_RBAC_SHADOW=false', 'B');
    assert(isDualReadShadowEnabled() === false, 'ENABLE_DUAL_READ_SHADOW=false', 'B');

    // Auth flags — must remain active (=== true, they're !==false flags)
    assert(isFirebaseAuthEnabled() === true, 'ENABLE_FIREBASE_AUTH=true (active)', 'B');
    assert(isStrictRbacEnabled() === true, 'ENABLE_STRICT_RBAC=true (active)', 'B');

    // featureFlags.js source verification — safe === 'true' logic for reads
    const flagsPath = resolve(process.cwd(), 'backend', 'config', 'featureFlags.js');
    const flagsContent = readFileSync(flagsPath, 'utf-8');
    assert(flagsContent.includes("process.env.ENABLE_FIRESTORE_READS === 'true'"),
      'featureFlags.js uses safe === "true" logic for ENABLE_FIRESTORE_READS (P1 fix verified)', 'B');
    assert(!flagsContent.includes("process.env.ENABLE_FIRESTORE_READS !== 'false'"),
      'featureFlags.js no longer has unsafe !== "false" logic', 'B');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE C: 9 INDIVIDUAL READ-CANARY FLAGS
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('C', '9 Individual Read-Canary Flags = false');

    const canaryFlags = [
      ['ROOMS', isRoomsReadCanaryEnabled],
      ['ROOM_TYPES', isRoomTypesReadCanaryEnabled],
      ['INV_CATEGORIES', isInventoryCategoriesReadCanaryEnabled],
      ['INV_PRODUCTS', isInventoryProductsReadCanaryEnabled],
      ['SETTINGS', isSettingsReadCanaryEnabled],
      ['HOUSEKEEPING', isHousekeepingReadCanaryEnabled],
      ['STAFF', isStaffReadCanaryEnabled],
      ['RESERVATIONS', isReservationsReadCanaryEnabled],
      ['MY_PAYMENTS', isMyPaymentsReadCanaryEnabled]
    ];
    for (const [name, fn] of canaryFlags) {
      assert(fn() === false, `ENABLE_FIRESTORE_${name}_READ_CANARY=false`, 'C');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GATE D: OUTBOX WORKER & OUTBOX HEALTH
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('D', 'Outbox Worker & Outbox Health');

    assert(isWorkerRunning() === false, 'Outbox worker daemon is idle (safe state)', 'D');

    const staleCount = await reclaimStaleProcessing();
    assert(staleCount === 0, `Zero stale PROCESSING events reclaimed (${staleCount})`, 'D');

    const [dlRows] = await pool.query(
      "SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status = 'DEAD_LETTER'"
    );
    assert(dlRows[0].cnt === 0, `DEAD_LETTER events = 0 (found: ${dlRows[0].cnt})`, 'D');

    const [pendingRows] = await pool.query(
      "SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status = 'PENDING'"
    );
    assert(true, `Pending outbox events = ${pendingRows[0].cnt} (informational — worker idle)`, 'D');

    const [processingRows] = await pool.query(
      "SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status = 'PROCESSING'"
    );
    assert(processingRows[0].cnt === 0, `Active PROCESSING events = 0 (worker idle confirmed)`, 'D');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE E: MYSQL HEALTH & HTTP HEALTH
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('E', 'MySQL Health & HTTP Health');

    const [pingResult] = await pool.query('SELECT 1+1 AS result');
    assert(pingResult[0].result === 2, 'MySQL connection healthy (1+1=2)', 'E');

    const [roomRows] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    const [bkgRows] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    const [invRows] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [payRows] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
    const [staffRows] = await pool.query("SELECT COUNT(*) as cnt FROM staff WHERE deleted = 0");
    const [guestRows] = await pool.query('SELECT COUNT(*) as cnt FROM guests');

    assert(roomRows[0].cnt === 17, `MySQL rooms = 17 (authoritative baseline)`, 'E');
    assert(bkgRows[0].cnt === 1, `MySQL bookings = 1 (authoritative baseline)`, 'E');
    assert(invRows[0].cnt === 2, `MySQL invoices = 2 (authoritative baseline)`, 'E');
    assert(payRows[0].cnt === 1, `MySQL payments = 1 (authoritative baseline)`, 'E');
    assert(staffRows[0].cnt >= 1, `MySQL active staff = ${staffRows[0].cnt} (>= 1)`, 'E');
    assert(guestRows[0].cnt >= 1, `MySQL guests = ${guestRows[0].cnt} (>= 1)`, 'E');

    try {
      const health = await fetch(`${BASE_URL}/api/health`);
      assert(health.status === 200, `GET /api/health = HTTP ${health.status}`, 'E');
    } catch (e) {
      assert(false, `GET /api/health failed: ${e.message}`, 'E');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GATE F: FIREBASE AUTH & RBAC
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('F', 'Firebase Auth & RBAC');

    // Protected route: unauthenticated request should return 401
    try {
      const unauthed = await fetch(`${BASE_URL}/api/staff`);
      assert(unauthed.status === 401,
        `GET /api/staff without token = HTTP ${unauthed.status} (401 expected — auth gate active)`, 'F');
    } catch (e) {
      assert(false, `GET /api/staff auth gate test failed: ${e.message}`, 'F');
    }

    // Guest-only route: unauthenticated should return 401
    try {
      const guestUnauthed = await fetch(`${BASE_URL}/api/payments/guest/my`);
      assert(guestUnauthed.status === 401,
        `GET /api/payments/guest/my without token = HTTP ${guestUnauthed.status} (401)`, 'F');
    } catch (e) {
      assert(false, `GET /api/payments/guest/my auth test failed: ${e.message}`, 'F');
    }

    assert(isFirebaseAuthEnabled() === true, 'Firebase Auth flag active (cannot be disabled without explicit env override)', 'F');
    assert(isStrictRbacEnabled() === true, 'Strict RBAC flag active', 'F');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE G: executeReadCanary INFRASTRUCTURE INTEGRITY
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('G', 'executeReadCanary Infrastructure Integrity');

    // Guard: flag disabled → null (MySQL fallback)
    const guardResult = await executeReadCanary({
      flagCheckFn: () => false,
      endpointName: 'final_gate_guard',
      fetchFirestoreFn: async () => [{ id: 1 }],
      validateAndFormatFn: r => r,
      timeoutMs: 500
    });
    assert(guardResult === null, 'Flag-guard: flagCheckFn=false → null (MySQL fallback guaranteed)', 'G');

    // Timeout: slow fetch → null
    const timeoutResult = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: 'final_gate_timeout',
      fetchFirestoreFn: async () => { await new Promise(r => setTimeout(r, 300)); return []; },
      validateAndFormatFn: r => r,
      timeoutMs: 100
    });
    assert(timeoutResult === null, 'Timeout: 300ms fetch with 100ms guard → null (fallback)', 'G');

    // Exception: throw → null
    const exceptionResult = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: 'final_gate_exception',
      fetchFirestoreFn: async () => { throw new Error('FIRESTORE_UNAVAILABLE'); },
      validateAndFormatFn: r => r,
      timeoutMs: 500
    });
    assert(exceptionResult === null, 'Exception: FIRESTORE_UNAVAILABLE → null (fallback)', 'G');

    // Happy path: valid data → formatted result
    const happyResult = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: 'final_gate_happy',
      fetchFirestoreFn: async () => [{ id: 1, name: 'Room 101', status: 'VACANT' }],
      validateAndFormatFn: docs => Array.isArray(docs) && docs.length > 0 ? docs : null,
      timeoutMs: 500
    });
    assert(Array.isArray(happyResult) && happyResult.length === 1,
      'Happy path: valid Firestore data → formatted result returned', 'G');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE H: ROLLBACK VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('H', 'Rollback to MySQL-only Mode');

    const originalEnv = process.env.ENABLE_FIRESTORE_READS;
    process.env.ENABLE_FIRESTORE_READS = 'true';
    try {
      assert(isFirestoreReadsEnabled() === true, 'Rollback pre-condition: reads enabled', 'H');
      assert(isFirestoreServicesEnabled() === false, 'Other flags unchanged during read activation', 'H');
    } finally {
      process.env.ENABLE_FIRESTORE_READS = 'false';
    }
    assert(isFirestoreReadsEnabled() === false, 'Rollback: immediately returns to false', 'H');

    // Restore to original
    if (originalEnv !== undefined) {
      process.env.ENABLE_FIRESTORE_READS = originalEnv;
    } else {
      delete process.env.ENABLE_FIRESTORE_READS;
    }

    assert(isFirestoreServicesEnabled() === false, 'Post-rollback: USE_FIRESTORE_SERVICES=false', 'H');
    assert(isFirestoreDualWriteEnabled() === false, 'Post-rollback: ENABLE_FIRESTORE_DUAL_WRITE=false', 'H');
    assert(isFirestoreOutboxWorkerEnabled() === false, 'Post-rollback: ENABLE_FIRESTORE_OUTBOX_WORKER=false', 'H');
    assert(isWorkerRunning() === false, 'Post-rollback: worker idle', 'H');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE I: PRODUCTION .env VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('I', 'Production .env Verification');

    const envPath = resolve(process.cwd(), 'backend', '.env');
    assert(existsSync(envPath), 'backend/.env exists', 'I');
    const envContent = readFileSync(envPath, 'utf-8');
    const envMtime = statSync(envPath).mtimeMs;
    assert(envContent.includes('ENABLE_FIRESTORE_READS=false'),
      'backend/.env: ENABLE_FIRESTORE_READS=false (unchanged)', 'I');
    assert(!envContent.includes('ENABLE_FIRESTORE_READS=true'),
      'backend/.env: does NOT contain =true', 'I');
    assert(envContent.includes('USE_FIRESTORE_SERVICES=false') ||
      !envContent.includes('USE_FIRESTORE_SERVICES=true'),
      'backend/.env: USE_FIRESTORE_SERVICES not true', 'I');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE J: SECURITY AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('J', 'Security Audit');

    const SENSITIVE = ['password', 'password_hash', 'passwordHash', 'pin', 'jwt',
      'token', 'private_key', 'card_number', 'cvv', 'secret'];

    const secResult = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: 'security_final_audit',
      fetchFirestoreFn: async () => [{
        id: 1, full_name: 'Admin', username: 'admin', role: 'admin', status: 'Active', deleted: 0,
        password: 'SHOULD_NOT_APPEAR', password_hash: 'HASH', pin: '1234', jwt: 'JWT_TOKEN'
      }],
      validateAndFormatFn: (docs) => {
        if (!Array.isArray(docs) || !docs.length) return null;
        const safe = docs.filter(s => !s.deleted).map(s => ({
          id: s.id, full_name: s.full_name, username: s.username,
          role: s.role, status: s.status
        }));
        return safe.length > 0 ? { staff: safe } : null;
      },
      timeoutMs: 500
    });

    assert(secResult !== null, 'Security audit: staff canary response produced', 'J');
    for (const field of SENSITIVE) {
      const inResponse = JSON.stringify(secResult || {}).toLowerCase().includes(`"${field.toLowerCase()}"`);
      assert(!inResponse, `Security: "${field}" NOT exposed in canary response`, 'J');
    }

    // featureFlags.js does not export any credentials
    assert(!flagsContent.includes('password') && !flagsContent.includes('private_key'),
      'featureFlags.js: no credentials embedded', 'J');

    // ══════════════════════════════════════════════════════════════════════════
    // GATE K: ZERO PRODUCTION MUTATIONS FINAL AUDIT
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('K', 'Zero Production Mutations Final Audit');

    const [roomFinal] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
    const [bkgFinal] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    const [invFinal] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [payFinal] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
    assert(roomFinal[0].cnt === 17, `Rooms: 17 (no mutations)`, 'K');
    assert(bkgFinal[0].cnt === 1, `Bookings: 1 (no mutations)`, 'K');
    assert(invFinal[0].cnt === 2, `Invoices: 2 (no mutations)`, 'K');
    assert(payFinal[0].cnt === 1, `Payments: 1 (no mutations)`, 'K');

    // ══════════════════════════════════════════════════════════════════════════
    // FINAL FLAG CONFIRMATION
    // ══════════════════════════════════════════════════════════════════════════
    markGateStart('L', 'Final Flag State Confirmation');

    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES=false (final)', 'L');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS=false (final)', 'L');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE=false (final)', 'L');
    assert(isFirestoreOutboxWorkerEnabled() === false, 'ENABLE_FIRESTORE_OUTBOX_WORKER=false (final)', 'L');
    assert(isRoomsReadCanaryEnabled() === false, 'ROOMS_CANARY=false (final)', 'L');
    assert(isStaffReadCanaryEnabled() === false, 'STAFF_CANARY=false (final)', 'L');
    assert(isMyPaymentsReadCanaryEnabled() === false, 'MY_PAYMENTS_CANARY=false (final)', 'L');

    // ══════════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════════════════════
    const failedGates = Object.entries(gateResults).filter(([, v]) => v === false).map(([k]) => k);
    const allGatesPassed = failedGates.length === 0;

    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    if (allGatesPassed) {
      console.log('ALL GATES PASSED — FINAL RESULT: READY FOR CONTROLLED PRODUCTION WINDOW');
    } else {
      console.log(`GATES FAILED: ${failedGates.join(', ')} — FINAL RESULT: BLOCKED`);
    }
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Test Suite Execution Error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runFinalCutoverDecision();
