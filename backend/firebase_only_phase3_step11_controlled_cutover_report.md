# HPMS Phase 3 Step 11: Controlled Firestore-Only Factory Reset Cutover Report
## Pre-Cutover Verification Only — Zero Destructive Operations Executed

**Author:** Google Antigravity Advanced Agentic AI  
**Date:** 2026-08-20  
**Status:** VERIFIED & READY FOR CONTROLLED RUNTIME CUTOVER (FLAG REMAINS OFF)  
**Target Feature Flag:** `USE_FIRESTORE_FACTORY_RESET=false`  

---

## 1. Executive Summary

This report documents the rigorous pre-cutover verification for **HPMS Phase 3 Step 11 — Factory Reset & Administrative Routines**. In strict accordance with safety protocols:
- **No Factory Reset was executed.**
- **Zero Firestore documents were deleted or modified.**
- **Zero MySQL records were deleted or modified.**
- **Zero Firebase Auth user accounts were modified.**
- **The feature flag `USE_FIRESTORE_FACTORY_RESET` remains `false`.**

All routing paths, authorization guards, distributed concurrency locking, collection purge/preservation schemas, room reset workflows, housekeeping reseed mechanics, system counters, and fail-closed error boundaries were verified using deterministic mock testing and non-destructive analysis.

---

## 2. Feature Flag & Runtime State

| Configuration Item | Status | Verified Value | Target |
|---|---|---|---|
| `USE_FIRESTORE_FACTORY_RESET` | **OFF** | `false` | `false` (Unchanged) |
| `isFirestoreFactoryResetEnabled()` | **ACTIVE** | `false` | `false` |
| `FEATURE_FLAGS.USE_FIRESTORE_FACTORY_RESET` | **EXPOSED** | `false` | `false` |
| Step 4 RBAC Cutover | **ACTIVE** | `true` | `true` |
| Step 5 Business Date Cutover | **ACTIVE** | `true` | `true` |
| Step 7 Master Data Cutover | **ACTIVE** | `true` | `true` |
| Step 8 Check-In/Out/Shift Cutover | **ACTIVE** | `true` | `true` |
| Step 9 Financials Cutover | **ACTIVE** | `true` | `true` |
| Step 10 Audit Logs & Reports Cutover | **ACTIVE** | `true` | `true` |

---

## 3. Architecture & Safety Verification Summary

### A. Dual-Path Routing & API Contract
- **Flag OFF (`false`):** [`FactoryResetCutoverService.js`](file:///d:/projects/hotel/backend/services/factoryResetCutoverService.js) routes all preflight status and execution requests to the legacy MySQL `FactoryResetService`.
- **Flag ON (`true`):** Routes cleanly to [`FirestoreFactoryResetService.js`](file:///d:/projects/hotel/backend/services/firestoreFactoryResetService.js).
- **API Parity:** Both paths return identical HTTP status codes and response schemas:
  - `GET /api/system/factory-reset/status` $\rightarrow$ `{ success: true, status: "Ready", validation: { ... } }`
  - `POST /api/system/factory-reset` $\rightarrow$ `{ success: true, summary: { guestsDeleted, bookingsDeleted, roomsReset, ... } }`

### B. Strict Authorization & Confirmation Phrase Protection
- **Middleware Chain:** `authenticate` + `requireSuperAdmin` on all `/api/system/factory-reset/*` endpoints.
- **Canonical Confirmation Phrase:** Strict verification of `"RESET HOTEL DATA"` (`req.body.confirmationPhrase.trim() === 'RESET HOTEL DATA'`).
  - Empty string $\rightarrow$ HTTP 400 Bad Request
  - Incomplete / lowercase phrase $\rightarrow$ HTTP 400 Bad Request
  - Non-superadmin / receptionist $\rightarrow$ HTTP 403 Forbidden
  - Unauthenticated request $\rightarrow$ HTTP 401 Unauthorized

### C. Collection Purge vs. Preservation Matrix

#### Purged Collections (18 Transactional Domains):
1. `/room_status_history`
2. `/booking_history`
3. `/stay_extension_requests`
4. `/feedback`
5. `/maintenance`
6. `/housekeeping_logs`
7. `/ledger_items`
8. `/payments`
9. `/invoices`
10. `/cash_logs`
11. `/cash_submissions`
12. `/checkout_snapshots`
13. `/razorpay_transactions`
14. `/audit_logs`
15. `/notifications`
16. `/reservations`
17. `/bookings`
18. `/guests`

#### Purged Users (Role-Isolated):
- `/users` where `role === 'guest'` only.

#### 100% Preserved Collections (Master Data & System Config):
- `/roles`
- `/permissions`
- `/role_permissions`
- `/staff`
- `/room_types`
- `/inventory_categories`
- `/inventory_products`
- `/users` (where `role` is `admin`, `super_admin`, `receptionist`, `housekeeper`, `kitchen`)
- `/settings/hotel_config`

### D. Firebase Auth Protection & User Safety
- **Strict Isolation:** Staff, Admin, and SuperAdmin Firebase Auth accounts are **never targeted**.
- Verified exclusion logic ensures only guest users with `role === 'guest'` are eligible for guest record deletion.

### E. Chunked Batch Deletion & Concurrency Mutex
- **Firestore Batch Limit Compliance:** `deleteCollectionChunked(collectionName, batchSize = 400)` operates with batch sizes $\le 400$ (well within Firestore's 500-operation transaction limit).
- **Distributed Mutex Lock:** `/settings/factory_reset_lock` with a 2-minute lease window (`LOCK_LEASE_MS = 120000`).
- **Concurrent Request Protection:** Any second reset attempt during an active lease immediately throws HTTP 409 Conflict (`RESET_IN_PROGRESS`) without executing or triggering fallbacks.

### F. Room State, Reseed & System Date Mechanics
- **Room State Reset:** All rooms transition to `status: 'vacant'`, `housekeeping_status: 'Clean'`, with `current_booking_id: null` and `guest_id: null`.
- **Deterministic Reseeding:** Exactly 1 initial housekeeping record created per room with deterministic document ID `hk_init_{roomNumber}`.
- **Daily Counters & Date:** Resets `/settings/system_date` daily counters (`today_checkins = 0`, `today_checkouts = 0`, `continued_rooms = 0`) and resets `/counters/invoice_sequence` to `0`.

### G. Guest Document Disk Cleanup Safety
- Targets only files in `backend/guest-documents/` matching prefix `id_doc_*`.
- Excludes administrative and staff assets; prevents path traversal (`..` forbidden); safely ignores missing files (`ENOENT`).

---

## 4. Verification & Test Results

### 1. Dedicated Step 11 Cutover Test Suite
**Command:** `node backend/tests/testPhase3Step11ControlledCutoverVerification.mjs`
- **Result:** **33 / 33 Passed (100%)**
- **Tested Areas:**
  - Group A: Feature flag state & active cutovers (3/3)
  - Group B: Routing verification with Flag OFF and Flag ON (2/2)
  - Group C: Authorization & confirmation phrase guards (5/5)
  - Group D: 18 transactional collection purge list and FK ordering (2/2)
  - Group E: Master data & hotel config preservation mapping (1/1)
  - Group F: User isolation & Firebase Auth safety (2/2)
  - Group G: Room reset state specification (3/3)
  - Group H: Housekeeping reseed idempotency (`hk_init_{roomNumber}`) (1/1)
  - Group I: Daily counters and invoice sequence reset (2/2)
  - Group J: Chunked batch size $\le 400$ safety (1/1)
  - Group K: Distributed lock lease & expiration (2/2)
  - Group L: Fail-closed 409/400 error boundary without fallback (1/1)
  - Group M: File cleanup target filter and path safety (4/4)
  - Group N: Zero production mutation confirmation (4/4)

### 2. Full Regression Test Suites
| Suite | Scope | Result |
|---|---|---|
| `testPhase3Step11ControlledCutoverVerification.mjs` | Step 11 Factory Reset Cutover | **33 / 33 PASSED** |
| `testPhase3Step10ControlledCutoverVerification.mjs` | Step 10 Audit Logs & Reports | **29 / 29 PASSED** |
| `testPhase3Step9ControlledCutoverVerification.mjs` | Step 9 Financials & Invoices | **24 / 24 PASSED** |
| `testPhase3Step8ControlledCutoverVerification.mjs` | Step 8 Check-In/Out/Shift | **23 / 23 PASSED** |
| `testPhase3Step7ControlledCutoverVerification.mjs` | Step 7 Master Data | **33 / 33 PASSED** |
| `testPhase3Step5FirebaseOnlyBusinessDate.mjs` | Step 5 Business Date | **37 / 37 PASSED** |
| `testPhase3Step4FirebaseOnlyRbac.mjs` | Step 4 Strict RBAC | **73 / 73 PASSED** |
| `testPhase3Step3BStaffFirebaseOnlyResolution.mjs` | Step 3B Staff Resolution | **73 / 73 PASSED** |
| `testPhase3Step3CStaffFirebaseLogin.mjs` | Step 3C Staff Login | **114 / 114 PASSED** |
| `testPhase3Step3D4GuestBookingOwnership.mjs` | Step 3D-4 Guest Ownership | **65 / 65 PASSED** |
| `testStatusEndpointResGuestFix.mjs` | Status & Reservations Schema | **16 / 16 PASSED** |
| **Total Test Assertions** | **All Active HPMS Domains** | **520 / 520 PASSED (100%)** |

### 3. Production Build & Live Health
- **Vite Production Build (`npm run build`):** Built successfully in 10.87s without errors.
- **`GET /api/health`:** HTTP 200 OK
- **`GET /api/status`:** HTTP 200 OK (Authenticated) / HTTP 401 (Unauthenticated)
- **`GET /api/settings/business-date`:** HTTP 200 OK (Authenticated) / HTTP 401 (Unauthenticated)

---

## 5. Audit Statement on Database Mutations

- **MySQL Records Deleted / Mutated:** **0**
- **Firestore Documents Deleted / Mutated:** **0**
- **Firebase Auth Users Deleted / Mutated:** **0**
- **Guest Document Files Deleted / Mutated:** **0**
- **Production Hotel Data Affected:** **0% (100% untouched)**
- **Runtime Flag State:** `USE_FIRESTORE_FACTORY_RESET=false` (Remains OFF)
