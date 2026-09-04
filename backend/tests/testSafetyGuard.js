/**
 * backend/tests/testSafetyGuard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Automated Test Runner Protection Guard for HPMS-Sky5.
 *
 * Prevents automated test scripts from executing destructive write operations
 * directly against the live Google Cloud Firestore project (hpms-sky5).
 *
 * isProductionProject() now lives in ../config/productionSafetyGuard.js and is
 * re-exported here for backward compatibility — it moved because a production
 * runtime file (config/firebaseAdmin.js) needs it, and backend/tests/ is
 * excluded from the packaged Electron production build (package.json's
 * extraResources filter), which made that a static import into a file the
 * packaged app never ships.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isProductionProject } from '../config/productionSafetyGuard.js';

export { isProductionProject };

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

export default {
  assertSafeTestEnvironment,
  isProductionProject
};
