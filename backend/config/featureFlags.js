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

// ── Phase 3 Step 3B — Firebase-Only Staff Resolution (Default: FALSE) ───────────
/**
 * When true: Firebase-authenticated staff requests resolve role/identity/status
 * exclusively from Firebase Custom Claims + Firestore, never hitting MySQL.
 * When false (default): existing MySQL lookup in resolveCanonicalFirebaseUser is used.
 */
export const isFirebaseOnlyStaffResolutionEnabled = () => {
  return process.env.ENABLE_FIREBASE_ONLY_STAFF_RESOLUTION === 'true';
};

// ── Phase 3 Step 3C — Firebase-Only Staff Login (Default: FALSE) ─────────────────
/**
 * When true: Staff login MUST use Firebase Authentication.
 * - POST /api/staff/auth/login (staffLogin) rejects MySQL password verification attempts.
 * - POST /api/auth/signin MySQL fallback for staff is disabled.
 * - Frontend must use Firebase signInWithEmailAndPassword → ID token → /api/auth/me.
 * When false (default): existing MySQL password login remains fully operational.
 */
export const isFirebaseStaffLoginEnabled = () => {
  return process.env.ENABLE_FIREBASE_STAFF_LOGIN === 'true';
};

// ── Phase 3 Step 3D — Firebase Guest Auth (Default: FALSE) ───────────────────
/**
 * When true: Guest login MUST use Firebase Authentication.
 * - POST /api/auth/signin MySQL password check for guests is disabled.
 * - POST /api/auth/signup provisions Firebase Auth at registration time.
 * - Frontend must use Firebase signInWithEmailAndPassword → ID token → /api/auth/me.
 * When false (default): existing MySQL password login remains fully operational.
 */
export const isFirebaseGuestLoginEnabled = () => {
  return process.env.ENABLE_FIREBASE_GUEST_LOGIN === 'true';
};

/**
 * When true: Firebase-authenticated guest requests resolve identity/booking ownership
 * exclusively from Firebase Custom Claims, never querying MySQL for guest profile.
 * Requires mysql_guest_id and guest_id claims to be present (set by Step 3D-1 provisioning).
 * When false (default): existing MySQL guest lookup (SELECT FROM guests WHERE user_id=?) is used.
 */
export const isFirebaseOnlyGuestResolutionEnabled = () => {
  return process.env.ENABLE_FIREBASE_ONLY_GUEST_RESOLUTION === 'true';
};

// ── Phase 3 Step 4 — Firebase-Only RBAC (Default: FALSE) ─────────────────────
/**
 * When true: Permission checks (hasPermission) and Root Admin token resolution
 * are routed exclusively to Firestore RBAC and Firebase Custom Claims, bypassing MySQL.
 * When false (default): MySQL RBAC tables (roles, permissions, role_permissions, users) remain authoritative.
 */
export const isFirebaseOnlyRbacEnabled = () => {
  return process.env.ENABLE_FIREBASE_ONLY_RBAC === 'true';
};

// ── Phase 3 Step 5 — Firebase-Only Business Date & Day-End (Default: FALSE) ─
/**
 * When true: Business Date reading, setting, Day End advancement, and rollback
 * are routed exclusively to Firestore /settings/system_date, bypassing MySQL.
 * When false (default): MySQL system_settings table remains authoritative.
 */
export const isFirebaseOnlyBusinessDateEnabled = () => {
  return process.env.ENABLE_FIREBASE_ONLY_BUSINESS_DATE === 'true';
};

// ── Phase 3 Step 7 — Master Data Controllers Firestore Migration (Default: FALSE) ──
export const isFirestoreRoomTypesEnabled = () => {
  return process.env.USE_FIRESTORE_ROOM_TYPES === 'true';
};

export const isFirestoreStaffEnabled = () => {
  return process.env.USE_FIRESTORE_STAFF === 'true';
};

export const isFirestoreInventoryEnabled = () => {
  return process.env.USE_FIRESTORE_INVENTORY === 'true';
};

export const isFirestoreHousekeepingEnabled = () => {
  return process.env.USE_FIRESTORE_HOUSEKEEPING === 'true';
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

// ── Phase 2 Dual-Read Shadow & Serving Feature Flags ────────────────────────
export const isFirestoreAvailabilityShadowEnabled = () => {
  return process.env.USE_FIRESTORE_AVAILABILITY_SHADOW !== 'false';
};

export const isFirestoreRoomStatusShadowEnabled = () => {
  return process.env.USE_FIRESTORE_ROOM_STATUS_SHADOW !== 'false';
};

export const isFirestoreLedgerShadowEnabled = () => {
  return process.env.USE_FIRESTORE_LEDGER_SHADOW !== 'false';
};

export const isFirestoreReportsShadowEnabled = () => {
  return process.env.USE_FIRESTORE_REPORTS_SHADOW !== 'false';
};

// Production Serving / Cutover Flags (Phase 2 Step 4: Room Status, Availability, Check-In ENABLED)
export const isFirestoreAvailabilityServingEnabled = () => {
  return process.env.USE_FIRESTORE_AVAILABILITY !== 'false';
};

export const isFirestoreRoomStatusServingEnabled = () => {
  return process.env.USE_FIRESTORE_ROOM_STATUS !== 'false';
};

export const isFirestoreCheckInServingEnabled = () => {
  return process.env.USE_FIRESTORE_CHECKIN === 'true';
};

export const isFirestoreCheckOutServingEnabled = () => {
  return process.env.USE_FIRESTORE_CHECKOUT === 'true';
};

// ── Phase 3 Step 8 — Check-In, Check-Out & Room Shift (Default: FALSE) ──────
export const isFirestoreCheckInEnabled = () => {
  return process.env.USE_FIRESTORE_CHECKIN === 'true';
};

export const isFirestoreCheckOutEnabled = () => {
  return process.env.USE_FIRESTORE_CHECKOUT === 'true';
};

export const isFirestoreRoomShiftEnabled = () => {
  return process.env.USE_FIRESTORE_ROOM_SHIFT === 'true';
};

// ── Phase 3 Step 9 — Financials, Invoices, Folio & Refunds (Default: FALSE) ─
export const isFirestoreFinancialsEnabled = () => {
  return process.env.USE_FIRESTORE_FINANCIALS === 'true';
};

export const isFirestoreInvoicesEnabled = () => {
  return process.env.USE_FIRESTORE_INVOICES === 'true';
};

export const isFirestoreLedgerWritesEnabled = () => {
  return process.env.USE_FIRESTORE_LEDGER_WRITES === 'true';
};

export const isFirestoreRefundsEnabled = () => {
  return process.env.USE_FIRESTORE_REFUNDS === 'true';
};

export const isFirestoreLedgerServingEnabled = () => {
  return process.env.USE_FIRESTORE_LEDGER !== 'false';
};

export const isFirestorePaymentsServingEnabled = () => {
  return process.env.USE_FIRESTORE_PAYMENTS !== 'false';
};

export const isFirestoreCashServingEnabled = () => {
  return process.env.USE_FIRESTORE_CASH !== 'false';
};

export const isFirestoreReservationsServingEnabled = () => {
  return process.env.USE_FIRESTORE_RESERVATIONS !== 'false';
};

export const isFirestoreReportsServingEnabled = () => {
  return process.env.USE_FIRESTORE_REPORTS !== 'false';
};

// ── Phase 3 Step 10 — Audit Logs, Reports & History (Default: FALSE) ──────
export const isFirestoreAuditHistoryEnabled = () => {
  return process.env.USE_FIRESTORE_AUDIT_HISTORY === 'true';
};

// ── Phase 3 Step 11 — Factory Reset & Admin Routines (Default: FALSE) ─────
export const isFirestoreFactoryResetEnabled = () => {
  return process.env.USE_FIRESTORE_FACTORY_RESET === 'true';
};

// ── Phase 3 Step 12 — MySQL Outbox & Fallback Decommission (Default: FALSE) ─
export const isMysqlOutboxWritesDisabled = () => {
  return process.env.DISABLE_MYSQL_OUTBOX_WRITES === 'true';
};

export const isMysqlCutoverFallbacksDisabled = () => {
  return process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS === 'true';
};

export const isRbacShadowVerificationDisabled = () => {
  return process.env.DISABLE_RBAC_SHADOW_VERIFICATION === 'true';
};

export const isBusinessDateShadowVerificationDisabled = () => {
  return process.env.DISABLE_BUSINESS_DATE_SHADOW_VERIFICATION === 'true';
};

export const isMasterDataShadowVerificationDisabled = () => {
  return process.env.DISABLE_MASTER_DATA_SHADOW_VERIFICATION === 'true';
};

export const isOperationalShadowVerificationDisabled = () => {
  return process.env.DISABLE_OPERATIONAL_SHADOW_VERIFICATION === 'true';
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
  ENABLE_FIRESTORE_MY_PAYMENTS_READ_CANARY: isMyPaymentsReadCanaryEnabled(),
  USE_FIRESTORE_AVAILABILITY_SHADOW: isFirestoreAvailabilityShadowEnabled(),
  USE_FIRESTORE_ROOM_STATUS_SHADOW: isFirestoreRoomStatusShadowEnabled(),
  USE_FIRESTORE_LEDGER_SHADOW: isFirestoreLedgerShadowEnabled(),
  USE_FIRESTORE_REPORTS_SHADOW: isFirestoreReportsShadowEnabled(),
  USE_FIRESTORE_AVAILABILITY: isFirestoreAvailabilityServingEnabled(),
  USE_FIRESTORE_ROOM_STATUS: isFirestoreRoomStatusServingEnabled(),
  USE_FIRESTORE_CHECKIN: isFirestoreCheckInEnabled(),
  USE_FIRESTORE_CHECKOUT: isFirestoreCheckOutEnabled(),
  USE_FIRESTORE_ROOM_SHIFT: isFirestoreRoomShiftEnabled(),
  USE_FIRESTORE_LEDGER: isFirestoreLedgerServingEnabled(),
  USE_FIRESTORE_REPORTS: isFirestoreReportsServingEnabled(),
  ENABLE_FIREBASE_ONLY_STAFF_RESOLUTION: isFirebaseOnlyStaffResolutionEnabled(),
  ENABLE_FIREBASE_STAFF_LOGIN: isFirebaseStaffLoginEnabled(),
  ENABLE_FIREBASE_GUEST_LOGIN: isFirebaseGuestLoginEnabled(),
  ENABLE_FIREBASE_ONLY_GUEST_RESOLUTION: isFirebaseOnlyGuestResolutionEnabled(),
  ENABLE_FIREBASE_ONLY_RBAC: isFirebaseOnlyRbacEnabled(),
  ENABLE_FIREBASE_ONLY_BUSINESS_DATE: isFirebaseOnlyBusinessDateEnabled(),
  USE_FIRESTORE_ROOM_TYPES: isFirestoreRoomTypesEnabled(),
  USE_FIRESTORE_STAFF: isFirestoreStaffEnabled(),
  USE_FIRESTORE_INVENTORY: isFirestoreInventoryEnabled(),
  USE_FIRESTORE_HOUSEKEEPING: isFirestoreHousekeepingEnabled(),
  USE_FIRESTORE_FINANCIALS: isFirestoreFinancialsEnabled(),
  USE_FIRESTORE_INVOICES: isFirestoreInvoicesEnabled(),
  USE_FIRESTORE_LEDGER_WRITES: isFirestoreLedgerWritesEnabled(),
  USE_FIRESTORE_REFUNDS: isFirestoreRefundsEnabled(),
  USE_FIRESTORE_AUDIT_HISTORY: isFirestoreAuditHistoryEnabled(),
  USE_FIRESTORE_FACTORY_RESET: isFirestoreFactoryResetEnabled(),
  DISABLE_MYSQL_OUTBOX_WRITES: isMysqlOutboxWritesDisabled(),
  DISABLE_MYSQL_CUTOVER_FALLBACKS: isMysqlCutoverFallbacksDisabled(),
  DISABLE_RBAC_SHADOW_VERIFICATION: isRbacShadowVerificationDisabled(),
  DISABLE_BUSINESS_DATE_SHADOW_VERIFICATION: isBusinessDateShadowVerificationDisabled(),
  DISABLE_MASTER_DATA_SHADOW_VERIFICATION: isMasterDataShadowVerificationDisabled(),
  DISABLE_OPERATIONAL_SHADOW_VERIFICATION: isOperationalShadowVerificationDisabled()
};
