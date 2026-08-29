# HPMS Phase 3 Step 12 — MySQL Outbox & Fallback Decommission Implementation Report
**Document Version:** 1.0.0  
**Generated:** 2026-08-20  
**Target Environment:** HPMS-Sky5 Hybrid / Cloud Production  
**Status:** IMPLEMENTATION COMPLETE — ALL DECOMMISSION FLAGS DEFAULT OFF (SAFE & REVERSIBLE)

---

## 1. Executive Summary

This document certifies the successful dual-path implementation of **HPMS Phase 3 Step 12 — MySQL Outbox & Fallback Decommission**.

In accordance with strict zero-downtime and reversibility constraints:
- **No infrastructure was deleted or removed**: MySQL database container, connection pools (`backend/db.js`), `mysql2` dependencies, and table schemas remain 100% active and healthy.
- **Controlled Decommission Layer**: A central decommission management layer (`outboxDecommissionService.js`) and 6 dedicated feature flags were created to allow runtime toggling of MySQL Outbox writes, MySQL emergency cutover fallbacks, and background shadow verifications without code redeployment.
- **Universal Outbox Write Gating**: All 37 MySQL Outbox `enqueue()` locations across controllers and services are dynamically gated through a single centralized check.
- **Universal Cutover Fallback Gating**: All 18 cutover services across all functional domains (Check-In, Check-Out, Room Shift, Invoices, Ledger Writes, Payments, Refunds, Cash, Reservations, Reports, Audit History, Master Bill, Factory Reset, Ledger Folio, Room Types, Staff, Inventory, Housekeeping) are gated with `shouldAllowMySQLCutoverFallback(domain)`.
- **Fail-Closed Boundary Preservation**: Business validation errors (400, 401, 403, 404, 409) continue to fail closed immediately without invoking fallback.
- **Existing Cutover Preservation**: Prior cutovers (Step 4 RBAC, Step 5 Business Date, Step 7 Master Data, Step 8 Check-In/Out/Shift, Step 9 Financials, Step 10 Audit/Reports/History) remain active and undisturbed.
- **Instant 100% Rollback Path**: All Step 12 feature flags default to `false`. Setting any flag back to `false` instantly restores original MySQL dual-write or fallback behavior.

---

## 2. Feature Flags Specification

The following flags were added to [`backend/config/featureFlags.js`](file:///d:/projects/hotel/backend/config/featureFlags.js):

| Feature Flag | Environment Variable | Default | Purpose |
| :--- | :--- | :---: | :--- |
| `DISABLE_MYSQL_OUTBOX_WRITES` | `process.env.DISABLE_MYSQL_OUTBOX_WRITES` | `false` | When `true`, stops inserting new rows into MySQL `dual_write_outbox`. Returns `{ skipped: true, reason: 'OUTBOX_WRITES_DISABLED' }`. Existing rows are untouched. |
| `DISABLE_MYSQL_CUTOVER_FALLBACKS` | `process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS` | `false` | When `true`, disables emergency MySQL fallback across all 18 cutover services upon Firestore infrastructure errors, failing closed cleanly. |
| `DISABLE_RBAC_SHADOW_VERIFICATION` | `process.env.DISABLE_RBAC_SHADOW_VERIFICATION` | `false` | When `true`, deactivates background shadow comparison of MySQL vs Firestore RBAC decisions. |
| `DISABLE_BUSINESS_DATE_SHADOW_VERIFICATION` | `process.env.DISABLE_BUSINESS_DATE_SHADOW_VERIFICATION` | `false` | When `true`, deactivates background shadow comparison of MySQL vs Firestore business date values. |
| `DISABLE_MASTER_DATA_SHADOW_VERIFICATION` | `process.env.DISABLE_MASTER_DATA_SHADOW_VERIFICATION` | `false` | When `true`, deactivates background shadow comparisons for room types, staff, inventory, and housekeeping. |
| `DISABLE_OPERATIONAL_SHADOW_VERIFICATION` | `process.env.DISABLE_OPERATIONAL_SHADOW_VERIFICATION` | `false` | When `true`, deactivates background shadow comparisons for room status, availability, and folio/ledger reads. |

All flags are exposed in the runtime `FEATURE_FLAGS` export object.

---

## 3. Architecture & Centralized Decommission Service

### 3.1 Central Decommission Gate Service ([`backend/services/outboxDecommissionService.js`](file:///d:/projects/hotel/backend/services/outboxDecommissionService.js))

The service provides four key functions:

1. **`shouldEnqueueOutbox()`**:
   Evaluates `!isMysqlOutboxWritesDisabled()`. Returns `true` when Outbox writes are enabled (default), and `false` when decommissioned.
2. **`shouldAllowMySQLCutoverFallback(domain)`**:
   Evaluates `!isMysqlCutoverFallbacksDisabled()`. Returns `true` when fallback is enabled (default), and `false` when decommissioned. Logs decommission events for auditability.
3. **`shouldRunShadowVerification(domain)`**:
   Evaluates domain-specific flags (`DISABLE_RBAC_SHADOW_VERIFICATION`, `DISABLE_BUSINESS_DATE_SHADOW_VERIFICATION`, `DISABLE_MASTER_DATA_SHADOW_VERIFICATION`, `DISABLE_OPERATIONAL_SHADOW_VERIFICATION`).
4. **`OutboxDecommissionService.getOutboxDiagnostics(pool)`**:
   Non-destructive status inspection method providing queue depth, pending/processed counts, oldest unprocessed timestamp, and active flag states.

---

## 4. Universal Outbox Gating (37/37 Locations Covered)

All Outbox writes across the HPMS backend route through `enqueue()` in [`backend/services/outboxService.js`](file:///d:/projects/hotel/backend/services/outboxService.js). By inserting the write gate at the function's entry:

```javascript
export async function enqueue(connection, eventData) {
  if (!shouldEnqueueOutbox()) {
    return {
      ...eventData,
      skipped: true,
      reason: 'OUTBOX_WRITES_DISABLED'
    };
  }
  // Standard MySQL INSERT INTO dual_write_outbox ...
}
```

All 37 write locations identified during the Phase 3 Step 12 audit are automatically and atomically gated:

1. `checkInService.js:631` — `COMPOUND_CHECKIN`
2. `checkOutService.js:383` — `COMPOUND_CHECKOUT`
3. `roomShiftService.js:225` — `COMPOUND_ROOM_SHIFT`
4. `businessDateService.js:279` — `SYSTEM_DATE_UPDATED` (Day End)
5. `businessDateService.js:604` — `SYSTEM_DATE_UPDATED` (Rollback)
6. `roomTypeCutoverService.js:140` — `ROOM_TYPE_CREATED`
7. `roomTypeCutoverService.js:230` — `ROOM_TYPE_UPDATED`
8. `roomTypeCutoverService.js:292` — `ROOM_TYPE_DELETED`
9. `staffCutoverService.js:216` — `STAFF_CREATED`
10. `staffCutoverService.js:302` — `STAFF_UPDATED`
11. `staffCutoverService.js:374` — `STAFF_STATUS_UPDATED`
12. `staffCutoverService.js:446` — `STAFF_DELETED`
13. `inventoryCutoverService.js:101` — `INVENTORY_CATEGORY_CREATED`
14. `inventoryCutoverService.js:170` — `INVENTORY_CATEGORY_DELETED`
15. `inventoryCutoverService.js:246` — `INVENTORY_PRODUCT_CREATED`
16. `inventoryCutoverService.js:522` — `INVENTORY_PRODUCT_UPDATED`
17. `inventoryCutoverService.js:603` — `INVENTORY_STOCK_ADJUSTED`
18. `inventoryCutoverService.js:712` — `INVENTORY_PRODUCT_DELETED`
19. `housekeepingCutoverService.js:162` — `HOUSEKEEPING_LOG_CREATED`
20. `housekeepingCutoverService.js:297` — `HOUSEKEEPING_STATUS_UPDATED`
21. `housekeepingCutoverService.js:310` — `HOUSEKEEPING_LOG_CREATED`
22. `roomController.js:786` — `PAYMENT_RECORDED`
23. `roomController.js:817` — `FOLIO_CHARGE_POSTED`
24. `roomController.js:848` — `CHECKOUT_COMPLETED`
25. `roomController.js:1000` — `BOOKING_CANCELLED`
26. `roomController.js:2024` — `RESERVATION_CANCELLED`
27. `roomController.js:2524` — `REFUND_PROCESSED`
28. `paymentController.js:231` — `PAYMENT_CREATED`
29. `paymentController.js:567` — `REFUND_CREATED`
30. `reservationController.js:294` — `RESERVATION_CREATED`
31. `reservationController.js:559` — `RESERVATION_UPDATED`
32. `reservationController.js:758` — `RESERVATION_CANCELLED`
33. `invoiceController.js:79` — `INVOICE_GENERATED`
34. `invoiceController.js:165` — `INVOICE_STATUS_UPDATED`
35. `cashController.js:148` — `CASH_TRANSACTION_RECORDED`
36. `authController.js:111` — `STAFF_REGISTERED`
37. `auditController.js:529` — `AUDIT_LOG_RECORDED`

---

## 5. Universal Fallback & Shadow Gating (18 Cutover Services)

The fallback gate was integrated across all 18 cutover services and shadow verification handlers:

1. [`safeCutoverFallbackService.js`](file:///d:/projects/hotel/backend/services/safeCutoverFallbackService.js)
2. [`invoiceCutoverService.js`](file:///d:/projects/hotel/backend/services/invoiceCutoverService.js)
3. [`ledgerWriteCutoverService.js`](file:///d:/projects/hotel/backend/services/ledgerWriteCutoverService.js)
4. [`paymentCutoverService.js`](file:///d:/projects/hotel/backend/services/paymentCutoverService.js)
5. [`refundCutoverService.js`](file:///d:/projects/hotel/backend/services/refundCutoverService.js)
6. [`cashCutoverService.js`](file:///d:/projects/hotel/backend/services/cashCutoverService.js)
7. [`reservationCutoverService.js`](file:///d:/projects/hotel/backend/services/reservationCutoverService.js)
8. [`reportsCutoverService.js`](file:///d:/projects/hotel/backend/services/reportsCutoverService.js)
9. [`auditHistoryCutoverService.js`](file:///d:/projects/hotel/backend/services/auditHistoryCutoverService.js)
10. [`masterBillCutoverService.js`](file:///d:/projects/hotel/backend/services/masterBillCutoverService.js)
11. [`factoryResetCutoverService.js`](file:///d:/projects/hotel/backend/services/factoryResetCutoverService.js)
12. [`checkInCutoverService.js`](file:///d:/projects/hotel/backend/services/checkInCutoverService.js)
13. [`checkOutCutoverService.js`](file:///d:/projects/hotel/backend/services/checkOutCutoverService.js)
14. [`roomShiftCutoverService.js`](file:///d:/projects/hotel/backend/services/roomShiftCutoverService.js)
15. [`ledgerCutoverService.js`](file:///d:/projects/hotel/backend/services/ledgerCutoverService.js)
16. [`roomTypeCutoverService.js`](file:///d:/projects/hotel/backend/services/roomTypeCutoverService.js)
17. [`staffCutoverService.js`](file:///d:/projects/hotel/backend/services/staffCutoverService.js)
18. [`inventoryCutoverService.js`](file:///d:/projects/hotel/backend/services/inventoryCutoverService.js)
19. [`housekeepingCutoverService.js`](file:///d:/projects/hotel/backend/services/housekeepingCutoverService.js)
20. [`dualRbacShadowService.js`](file:///d:/projects/hotel/backend/services/dualRbacShadowService.js)
21. [`dualReadVerificationService.js`](file:///d:/projects/hotel/backend/services/dualReadVerificationService.js)

---

## 6. Verification & Test Suite Execution Results

All unit, integration, and end-to-end regression suites were executed and verified:

| Test Suite | Result | Details |
| :--- | :---: | :--- |
| **`testPhase3Step12OutboxFallbackDecommission.mjs`** | **28/28 PASSED (100%)** | All 24 sections (A-X) passed: flag defaults, write skip, fallback blocking, error boundaries, shadow bypass, non-mutation, rollback. |
| **`testPhase3Step11ControlledCutoverVerification.mjs`** | **33/33 PASSED (100%)** | Factory reset dry-run, phrase check, collection target map, safety assertions. |
| **`testPhase3Step10ControlledCutoverVerification.mjs`** | **29/29 PASSED (100%)** | Audit logs, 11 reports, guest/booking history Firestore primary authority. |
| **`testPhase3Step9ControlledCutoverVerification.mjs`** | **24/24 PASSED (100%)** | Invoices, ledger writes, refund checkouts, idempotency. |
| **`testPhase3Step8ControlledCutoverVerification.mjs`** | **23/23 PASSED (100%)** | Check-in, check-out, room shift compound operations. |
| **`testPhase3Step7ControlledCutoverVerification.mjs`** | **33/33 PASSED (100%)** | Master data (room types, staff, inventory, housekeeping) operations & fallbacks. |
| **`testPhase3Step5FirebaseOnlyBusinessDate.mjs`** | **37/37 PASSED (100%)** | Business date advancement, daily counters, rollback mechanics. |
| **`testPhase3Step4FirebaseOnlyRbac.mjs`** | **73/73 PASSED (100%)** | 7 master permissions parity, roles normalization, root admin resolution. |
| **`testPhase3Step3BStaffFirebaseOnlyResolution.mjs`** | **73/73 PASSED (100%)** | Canonical staff resolution from Firebase claims. |
| **`testPhase3Step3CStaffFirebaseLogin.mjs`** | **114/114 PASSED (100%)** | Staff Firebase Auth login endpoint handling. |
| **`testPhase3Step3D4GuestBookingOwnership.mjs`** | **65/65 PASSED (100%)** | Guest booking ownership resolution from claims. |
| **`testStatusEndpointResGuestFix.mjs`** | **16/16 PASSED (100%)** | System status endpoint contract verification. |
| **Frontend Production Build (`npm run build`)** | **PASSED (0 errors)** | Production bundle compiled cleanly in 12.05s. |
| **Live Server Health Verification** | **HTTP 200 / 401** | `/api/health` returned HTTP 200. Authenticated endpoints enforce auth correctly. |

---

## 7. Current State & Safety Invariants

```
========================================================================
FEATURE FLAG STATUS AT STEP 12 IMPLEMENTATION CONCLUSION:
========================================================================
DISABLE_MYSQL_OUTBOX_WRITES                  = false  (DEFAULT - OFF)
DISABLE_MYSQL_CUTOVER_FALLBACKS              = false  (DEFAULT - OFF)
DISABLE_RBAC_SHADOW_VERIFICATION             = false  (DEFAULT - OFF)
DISABLE_BUSINESS_DATE_SHADOW_VERIFICATION    = false  (DEFAULT - OFF)
DISABLE_MASTER_DATA_SHADOW_VERIFICATION      = false  (DEFAULT - OFF)
DISABLE_OPERATIONAL_SHADOW_VERIFICATION      = false  (DEFAULT - OFF)
USE_FIRESTORE_FACTORY_RESET                  = false  (UNCHANGED - OFF)
========================================================================
ACTIVE PRIOR CUTOVERS (PRESERVED):
========================================================================
ENABLE_FIREBASE_ONLY_RBAC                    = true   (ACTIVE)
ENABLE_FIREBASE_ONLY_BUSINESS_DATE           = true   (ACTIVE)
USE_FIRESTORE_ROOM_TYPES                     = true   (ACTIVE)
USE_FIRESTORE_STAFF                          = true   (ACTIVE)
USE_FIRESTORE_INVENTORY                      = true   (ACTIVE)
USE_FIRESTORE_HOUSEKEEPING                   = true   (ACTIVE)
USE_FIRESTORE_CHECKIN                        = true   (ACTIVE)
USE_FIRESTORE_CHECKOUT                       = true   (ACTIVE)
USE_FIRESTORE_ROOM_SHIFT                     = true   (ACTIVE)
USE_FIRESTORE_FINANCIALS                     = true   (ACTIVE)
USE_FIRESTORE_INVOICES                       = true   (ACTIVE)
USE_FIRESTORE_LEDGER_WRITES                  = true   (ACTIVE)
USE_FIRESTORE_REFUNDS                        = true   (ACTIVE)
USE_FIRESTORE_AUDIT_HISTORY                  = true   (ACTIVE)
========================================================================
```
