/**
 * Central Feature Flags Configuration for HPMS-Sky5 Architecture
 */

export const isFirestoreReadsEnabled = () => {
  return process.env.ENABLE_FIRESTORE_READS === 'true';
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

export const isFirestoreServicesEnabled = () => {
  return process.env.USE_FIRESTORE_SERVICES === 'true';
};

export const isDualRbacShadowEnabled = () => {
  return process.env.ENABLE_DUAL_RBAC_SHADOW === 'true';
};

export const isDualReadShadowEnabled = () => {
  return process.env.ENABLE_DUAL_READ_SHADOW === 'true';
};

export const isRoomsReadCanaryEnabled = () => {
  return process.env.ENABLE_FIRESTORE_ROOMS_READ_CANARY === 'true';
};

export const isRoomTypesReadCanaryEnabled = () => {
  return process.env.ENABLE_FIRESTORE_ROOM_TYPES_READ_CANARY === 'true';
};

export const isInventoryCategoriesReadCanaryEnabled = () => {
  return process.env.ENABLE_FIRESTORE_INVENTORY_CATEGORIES_READ_CANARY === 'true';
};

export const isInventoryProductsReadCanaryEnabled = () => {
  return process.env.ENABLE_FIRESTORE_INVENTORY_PRODUCTS_READ_CANARY === 'true';
};

export const isSettingsReadCanaryEnabled = () => {
  return process.env.ENABLE_FIRESTORE_SETTINGS_READ_CANARY === 'true';
};

export const isHousekeepingReadCanaryEnabled = () => {
  return process.env.ENABLE_FIRESTORE_HOUSEKEEPING_READ_CANARY === 'true';
};

export const isStaffReadCanaryEnabled = () => {
  return process.env.ENABLE_FIRESTORE_STAFF_READ_CANARY === 'true';
};

export const isReservationsReadCanaryEnabled = () => {
  return process.env.ENABLE_FIRESTORE_RESERVATIONS_READ_CANARY === 'true';
};

export const isMyPaymentsReadCanaryEnabled = () => {
  return process.env.ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY === 'true';
};

export const FEATURE_FLAGS = {
  ENABLE_FIRESTORE_DUAL_WRITE: isFirestoreDualWriteEnabled(),
  ENABLE_FIRESTORE_OUTBOX_WORKER: isFirestoreOutboxWorkerEnabled(),
  ENABLE_FIRESTORE_RECONCILIATION: isFirestoreReconciliationEnabled(),
  USE_FIRESTORE_SERVICES: isFirestoreServicesEnabled(),
  ENABLE_DUAL_RBAC_SHADOW: isDualRbacShadowEnabled(),
  ENABLE_DUAL_READ_SHADOW: isDualReadShadowEnabled(),
  ENABLE_FIRESTORE_ROOMS_READ_CANARY: isRoomsReadCanaryEnabled(),
  ENABLE_FIRESTORE_ROOM_TYPES_READ_CANARY: isRoomTypesReadCanaryEnabled(),
  ENABLE_FIRESTORE_INVENTORY_CATEGORIES_READ_CANARY: isInventoryCategoriesReadCanaryEnabled(),
  ENABLE_FIRESTORE_INVENTORY_PRODUCTS_READ_CANARY: isInventoryProductsReadCanaryEnabled(),
  ENABLE_FIRESTORE_SETTINGS_READ_CANARY: isSettingsReadCanaryEnabled(),
  ENABLE_FIRESTORE_HOUSEKEEPING_READ_CANARY: isHousekeepingReadCanaryEnabled(),
  ENABLE_FIRESTORE_STAFF_READ_CANARY: isStaffReadCanaryEnabled(),
  ENABLE_FIRESTORE_RESERVATIONS_READ_CANARY: isReservationsReadCanaryEnabled(),
  ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY: isMyPaymentsReadCanaryEnabled()
};
