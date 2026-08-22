/**
 * backend/tests/testSafetyGuard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Automated Test Runner Protection Guard for HPMS-Sky5.
 *
 * Prevents automated test scripts from executing destructive write operations
 * directly against the live Google Cloud Firestore project (hpms-sky5).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function assertSafeTestEnvironment(suiteName = 'Test Suite') {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'hpms-sky5';
  const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const allowProdWrites = process.env.ALLOW_PROD_TEST_WRITES === 'true';

  if (projectId === 'hpms-sky5' && !isEmulator && !allowProdWrites) {
    // Read-only inspection / verification suites are allowed
    if (process.env.ALLOW_READONLY_TESTS === 'true' || process.env.NODE_ENV === 'test_readonly') {
      return;
    }
    const err = new Error(`[SAFETY_GUARD_BLOCKED] Automated test "${suiteName}" is blocked from mutating live production Firestore project "${projectId}". Use Firestore Emulator or set ALLOW_PROD_TEST_WRITES=true.`);
    err.code = 'PROD_TEST_MUTATION_BLOCKED';
    throw err;
  }
}

export function isProductionProject() {
  return process.env.FIREBASE_PROJECT_ID === 'hpms-sky5' && !process.env.FIRESTORE_EMULATOR_HOST;
}

export default {
  assertSafeTestEnvironment,
  isProductionProject
};
