/**
 * Central Feature Flags Configuration for HPMS-Sky5 Architecture
 */

export const isFirestoreReadsEnabled = () => {
  return process.env.ENABLE_FIRESTORE_READS !== 'false';
};

export const isFirebaseAuthEnabled = () => {
  return process.env.ENABLE_FIREBASE_AUTH !== 'false';
};

export const isStrictRbacEnabled = () => {
  return process.env.ENABLE_STRICT_RBAC !== 'false';
};

// ── Phase 3 Dual-Write & Outbox Feature Flags (Default: FALSE) ────────────────
export const isFirestoreDualWriteEnabled = () => {
  return process.env.ENABLE_FIRESTORE_DUAL_WRITE === 'true';
};

export const isFirestoreOutboxWorkerEnabled = () => {
  return process.env.ENABLE_FIRESTORE_OUTBOX_WORKER === 'true';
};

export const isFirestoreReconciliationEnabled = () => {
  return process.env.ENABLE_FIRESTORE_RECONCILIATION === 'true';
};

export const FEATURE_FLAGS = {
  ENABLE_FIRESTORE_DUAL_WRITE: isFirestoreDualWriteEnabled(),
  ENABLE_FIRESTORE_OUTBOX_WORKER: isFirestoreOutboxWorkerEnabled(),
  ENABLE_FIRESTORE_RECONCILIATION: isFirestoreReconciliationEnabled()
};
