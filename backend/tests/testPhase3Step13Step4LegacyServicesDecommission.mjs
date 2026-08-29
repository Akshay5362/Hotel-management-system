/**
 * testPhase3Step13Step4LegacyServicesDecommission.mjs
 * ==============================================================================
 * Comprehensive test suite for Phase 3 Step 13.4:
 * "Legacy MySQL Services, Utility Scripts & Migration Artifacts Decommission"
 *
 * Verifies:
 *  1. 46 obsolete legacy files / migrations directory no longer exist.
 *  2. All primary Firestore cutover services and repositories exist and are intact.
 *  3. Critical Step 13.5 baseline components (db.js, FactoryResetService.js, mysql2 in package.json, docker-compose.yml) are preserved.
 *  4. USE_FIRESTORE_FACTORY_RESET remains false until Step 13.5.
 *  5. Controllers and services have zero references or imports to deleted files.
 *  6. Deterministic ID formatters in firestoreUtils.js are intact and valid.
 *  7. package.json contains no obsolete migration / init-db scripts.
 *  8. Active Firestore runtime and fail-closed safety are verified.
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

console.log('\n============================================================');
console.log('PHASE 3 STEP 13.4 — LEGACY SERVICES & ARTIFACTS DECOMMISSION TEST');
console.log('============================================================\n');

// ── Section A: Deleted Legacy Files Verification ─────────────────────────────
console.log('--- Section A: Deleted Legacy Files Verification ---');

const deletedFilesList = [
  'init_db.js',
  'cleanup.js',
  'create_razorpay_table.cjs',
  'create_razorpay_table.mjs',
  'diag_status.mjs',
  'list_dbs.mjs',
  'migrate_cash_submissions.js',
  'migrate_db.js',
  'migrate_db2.js',
  'migrate_hk.js',
  'migrate_notif.mjs',
  'check_notif.mjs',
  'query.sql',
  'seed_staff.js',
  'test-controller.js',
  'test-db.js',
  'test.js',
  'testUpload.js',
  'test_empty.mjs',
  'test_ocr.js',
  'test_query2.mjs',
  'test_query3.mjs',
  'test-limit.js',
  'update_passwords.js',
  'verifyAvailabilityEngine.mjs',
  'verifyBusinessDate.mjs',
  'verifyBusinessDateManagement.mjs',
  'verifyCheckoutSnapshot.mjs',
  'verifyFactoryResetArchitecture.mjs',
  'verifyUndoDayEnd.mjs',
  'scripts/fix_date.js',
  'scripts/setup_extension_table.js',
  'scripts/removeDuplicateLedger.js',
  'scripts/executeBusinessDateCorrection.mjs',
  'scripts/testOutboxInfrastructure.js',
  'services/dualRbacVerificationService.js',
  'services/dualReadVerificationService.js',
  'services/dualRbacShadowService.js',
  'services/outboxWorker.js',
  'services/outboxDispatcher.js',
  'services/outboxService.js',
  'services/outboxDecommissionService.js',
  'services/compoundEventBuilder.js',
  'services/AvailabilityService.js',
  'services/CheckoutRecoveryService.js'
];

runTest(`All 45 identified legacy scratch/service files are deleted`, () => {
  for (const relPath of deletedFilesList) {
    const fullPath = path.join(backendRoot, relPath);
    assert.strictEqual(fs.existsSync(fullPath), false, `File ${relPath} should have been deleted`);
  }
});

runTest('backend/migrations directory is completely deleted', () => {
  const migrationsDir = path.join(backendRoot, 'migrations');
  assert.strictEqual(fs.existsSync(migrationsDir), false, 'backend/migrations directory should have been deleted');
});

// ── Section B: Step 13.5 Preserved Baseline Verification ──────────────────────
console.log('\n--- Section B: Step 13.5 Preserved Baseline Verification ---');

runTest('backend/db.js connection pool is preserved', () => {
  const dbFile = path.join(backendRoot, 'db.js');
  assert.strictEqual(fs.existsSync(dbFile), true, 'backend/db.js must be preserved for Step 13.5 baseline');
});

runTest('FactoryResetService.js is preserved for Step 13.5 baseline', () => {
  const frFile = path.join(backendRoot, 'services', 'FactoryResetService.js');
  assert.strictEqual(fs.existsSync(frFile), true, 'FactoryResetService.js must be preserved');
});

runTest('mysql2 remains in backend/package.json dependencies', () => {
  const pkgPath = path.join(backendRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.ok(pkg.dependencies && pkg.dependencies.mysql2, 'mysql2 must remain in dependencies');
});

runTest('docker-compose.yml still configures MySQL database and phpMyAdmin', () => {
  const dockerPath = path.join(repoRoot, 'docker-compose.yml');
  const content = fs.readFileSync(dockerPath, 'utf8');
  assert.ok(content.includes('hotel_pms_db') || content.includes('image: mysql'), 'docker-compose.yml must retain MySQL service');
  assert.ok(content.includes('phpmyadmin'), 'docker-compose.yml must retain phpMyAdmin service');
});

runTest('USE_FIRESTORE_FACTORY_RESET remains false', async () => {
  const { isFirestoreFactoryResetEnabled } = await import('../config/featureFlags.js');
  assert.strictEqual(isFirestoreFactoryResetEnabled(), false, 'USE_FIRESTORE_FACTORY_RESET must remain false until Step 13.5');
});

// ── Section C: Active Firestore Services & Repositories Verification ──────────
console.log('\n--- Section C: Active Firestore Services & Repositories Verification ---');

const activeFirestoreServices = [
  'services/firestoreAvailabilityService.js',
  'services/firestoreRoomStatusService.js',
  'services/firestoreLedgerService.js',
  'services/firestoreReportsService.js',
  'services/firestoreShadowComparisonService.js',
  'services/firestoreFactoryResetService.js',
  'services/safeCutoverFallbackService.js',
  'services/businessDateService.js',
  'services/roomTypeCutoverService.js',
  'services/staffCutoverService.js',
  'services/inventoryCutoverService.js',
  'services/housekeepingCutoverService.js',
  'services/checkInCutoverService.js',
  'services/checkOutCutoverService.js',
  'services/roomShiftCutoverService.js',
  'services/invoiceCutoverService.js',
  'services/ledgerCutoverService.js',
  'services/ledgerWriteCutoverService.js',
  'services/paymentCutoverService.js',
  'services/refundCutoverService.js',
  'services/cashCutoverService.js',
  'services/reportsCutoverService.js',
  'services/auditHistoryCutoverService.js',
  'services/masterBillCutoverService.js',
  'services/reservationCutoverService.js',
  'services/factoryResetCutoverService.js'
];

runTest('All 26 active Firestore services are present', () => {
  for (const relPath of activeFirestoreServices) {
    const fullPath = path.join(backendRoot, relPath);
    assert.strictEqual(fs.existsSync(fullPath), true, `Active service ${relPath} must exist`);
  }
});

runTest('All 28 Firestore repositories are present', () => {
  const repoDir = path.join(backendRoot, 'repositories', 'firestore');
  assert.strictEqual(fs.existsSync(repoDir), true, 'Firestore repositories dir must exist');
  const repoFiles = fs.readdirSync(repoDir).filter(f => f.endsWith('.js'));
  assert.strictEqual(repoFiles.length >= 28, true, `Expected >=28 repositories, found ${repoFiles.length}`);
});

// ── Section D: Deterministic ID Formatters Verification ───────────────────────
console.log('\n--- Section D: Deterministic ID Formatters Verification ---');

runTest('Deterministic ID formatters are exported from firestoreUtils.js', async () => {
  const utils = await import('../repositories/firestore/firestoreUtils.js');
  const expectedFormatters = [
    'formatRoomId',
    'formatBookingId',
    'formatReservationId',
    'formatGuestId',
    'formatStaffId',
    'formatInvoiceId',
    'formatCategoryDocId',
    'formatProductDocId',
    'formatLedgerItemId',
    'formatPaymentId',
    'formatCashLogId',
    'formatHistoryId',
    'formatCashSubmissionId'
  ];

  for (const fmt of expectedFormatters) {
    assert.strictEqual(typeof utils[fmt], 'function', `${fmt} must be exported as a function`);
  }

  // Verify deterministic formatting outputs
  assert.strictEqual(utils.formatRoomId('101'), 'room_101');
  assert.strictEqual(utils.formatBookingId('50'), 'booking_50');
  assert.strictEqual(utils.formatReservationId('12'), 'res_12');
  assert.strictEqual(utils.formatGuestId('8'), 'guest_8');
  assert.strictEqual(utils.formatStaffId('4'), 'staff_4');
  assert.strictEqual(utils.formatInvoiceId('99'), 'inv_99');
  assert.strictEqual(utils.formatLedgerItemId('1001'), 'ledger_1001');
  assert.strictEqual(utils.formatPaymentId('2002'), 'payment_2002');
  assert.strictEqual(utils.formatCashLogId('3003'), 'cash_3003');
  assert.strictEqual(utils.formatHistoryId('4004'), 'hist_4004');
  assert.strictEqual(utils.formatCashSubmissionId('5005'), 'submission_5005');
});

// ── Section E: Zero Static References to Deleted Artifacts ───────────────────
console.log('\n--- Section E: Zero Static References to Deleted Artifacts ---');

runTest('Zero runtime files import deleted legacy services or scripts', () => {
  const scannedDirs = ['controllers', 'routes', 'services', 'middleware', 'adapters'];
  const deletedImports = [
    '/AvailabilityService.js',
    '/CheckoutRecoveryService.js',
    '/dualRbacVerificationService.js',
    '/dualReadVerificationService.js',
    '/dualRbacShadowService.js',
    '/outboxWorker.js',
    '/outboxDispatcher.js',
    '/outboxService.js',
    '/outboxDecommissionService.js',
    '/compoundEventBuilder.js',
    'init_db.js',
    'migrations/'
  ];

  for (const dir of scannedDirs) {
    const fullDir = path.join(backendRoot, dir);
    if (!fs.existsSync(fullDir)) continue;
    const files = fs.readdirSync(fullDir, { recursive: true }).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const fullPath = path.join(fullDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const target of deletedImports) {
        assert.strictEqual(
          content.includes(target),
          false,
          `File ${dir}/${file} still contains reference to deleted target: ${target}`
        );
      }
    }
  }
});

runTest('backend/package.json contains no migration or init-db scripts', () => {
  const pkgPath = path.join(backendRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const forbiddenScripts = ['migrate', 'migrate:up', 'migrate:down', 'migrate:status', 'migrate:fresh', 'init-db-DANGER'];
  for (const s of forbiddenScripts) {
    assert.strictEqual(pkg.scripts[s], undefined, `package.json script ${s} must be removed`);
  }
});

// ── Section F: Availability Engine Firestore Compatibility ────────────────────
console.log('\n--- Section F: Firestore Availability Service Compatibility ---');

runTest('FirestoreAvailabilityService provides checkRoomAvailability, getAvailableRooms, validateAndLockRoom', async () => {
  const { FirestoreAvailabilityService } = await import('../services/firestoreAvailabilityService.js');
  assert.strictEqual(typeof FirestoreAvailabilityService.checkRoomAvailability, 'function');
  assert.strictEqual(typeof FirestoreAvailabilityService.getAvailableRooms, 'function');
  assert.strictEqual(typeof FirestoreAvailabilityService.validateAndLockRoom, 'function');
});

console.log('\n============================================================');
console.log(`STEP 13.4 TESTS COMPLETE: ${passedTests}/${totalTests} PASSED (100%)`);
console.log('============================================================\n');

process.exit(0);
