/**
 * backend/config/productionSafetyGuard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * isProductionProject() — a pure, dependency-free predicate used by
 * backend/config/firebaseAdmin.js (a production runtime file) to detect an
 * accidental HPMS_ENV=development connection to the production Firebase
 * project. It must live somewhere the packaged Electron production build
 * actually ships, unlike backend/tests/ (excluded from packaging via
 * package.json's extraResources filter — see build.extraResources).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function isProductionProject() {
  return process.env.FIREBASE_PROJECT_ID === 'hpms-sky5' && !process.env.FIRESTORE_EMULATOR_HOST;
}
