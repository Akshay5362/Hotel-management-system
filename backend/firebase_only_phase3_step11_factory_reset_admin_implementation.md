# HPMS Phase 3 Step 11 — Factory Reset & Administrative Routines
## Firebase/Firestore Dual-Path Migration Implementation Report

**Date:** 2026-08-20  
**Phase:** Phase 3 Step 11 (Implementation Only)  
**Status:** **STEP 11 IMPLEMENTATION COMPLETE — CONTROLLED CUTOVER NOT PERFORMED**  
**Safety Invariants:** 0 MySQL Schema Mutations, 0 MySQL Data Deletions, 0 Destructive Resets on Production Data, Feature Flag Defaults to `false`  

---

## 1. Executive Summary

Phase 3 Step 11 establishes the dual-path migration architecture for **Factory Reset & Administrative Routines** in Google Cloud Firestore. The new implementation enables HPMS to execute a complete, atomic, and safe factory reset against Firestore collections with chunked batch limits, distributed concurrency locking, guest identity document cleanup, idempotent housekeeping reseeding, and daily counter resets — while strictly preserving master hotel data, staff accounts, RBAC configuration, and room entities.

In accordance with Phase 3 safety requirements:
- The implementation is **dual-path and rollback-safe**.
- The new feature flag `USE_FIRESTORE_FACTORY_RESET` defaults to `false`.
- The MySQL connection pool, outbox, and fallback mechanisms remain 100% active.
- Real destructive Factory Reset was **NOT** executed against live hotel data.

---

## 2. Files Changed & Created

| Component | File Path | Action | Description |
|---|---|:---:|---|
| **Feature Flags** | [`backend/config/featureFlags.js`](file:///d:/projects/hotel/backend/config/featureFlags.js) | MODIFIED | Added `isFirestoreFactoryResetEnabled()` and exposed `USE_FIRESTORE_FACTORY_RESET` in `FEATURE_FLAGS` |
| **Firestore Service** | [`backend/services/firestoreFactoryResetService.js`](file:///d:/projects/hotel/backend/services/firestoreFactoryResetService.js) | NEW | Pure Firestore factory reset service with chunked batch deletion, concurrency locking, and status preflight |
| **Cutover Service** | [`backend/services/factoryResetCutoverService.js`](file:///d:/projects/hotel/backend/services/factoryResetCutoverService.js) | NEW | Dual-path router between MySQL and Firestore factory reset paths with fail-closed error handling |
| **Controller** | [`backend/controllers/factoryResetController.js`](file:///d:/projects/hotel/backend/controllers/factoryResetController.js) | MODIFIED | Integrated `FactoryResetCutoverService` with fallback and user operator ID extraction |
| **Test Suite** | [`backend/tests/testPhase3Step11FactoryResetFirestoreMigration.mjs`](file:///d:/projects/hotel/backend/tests/testPhase3Step11FactoryResetFirestoreMigration.mjs) | NEW | Complete 24-assertion test suite verifying flag defaults, routing, chunking, concurrency locks, and safety |
| **Implementation Report** | [`backend/firebase_only_phase3_step11_factory_reset_admin_implementation.md`](file:///d:/projects/hotel/backend/firebase_only_phase3_step11_factory_reset_admin_implementation.md) | NEW | Comprehensive technical implementation documentation |

---

## 3. Architecture Comparison

### 3.1 Legacy MySQL Architecture (`USE_FIRESTORE_FACTORY_RESET=false`)
- Requests to `POST /api/system/factory-reset` and `GET /api/system/factory-reset/status` route directly to `FactoryResetService.js`.
- Deletes 15 MySQL tables in child→parent foreign key order.
- Resets `rooms` table columns to `status = 'vacant'` and `housekeeping_status = 'Clean'`.
- Reseeds `housekeeping_logs` with 1 clean entry per room.
- Resets `system_settings` keys (`system_date`, `today_checkins`, `today_checkouts`, `continued_rooms`).
- Resets `AUTO_INCREMENT = 1` for all 15 deleted tables.

### 3.2 New Firestore Architecture (`USE_FIRESTORE_FACTORY_RESET=true`)
- Requests route through [`FactoryResetCutoverService`](file:///d:/projects/hotel/backend/services/factoryResetCutoverService.js) to [`FirestoreFactoryResetService`](file:///d:/projects/hotel/backend/services/firestoreFactoryResetService.js).
- Acquires distributed concurrency lock via Firestore document `/settings/factory_reset_lock` with a 2-minute lease.
- Purges 18 transactional Firestore collections in safe chunked batches (400 items per batch) to respect Firestore's 500-operation batch limits.
- Purges only `/users` documents where `role === 'guest'`.
- Resets `/rooms` documents to vacant/clean without deleting room definitions.
- Deterministically reseeds exactly 1 initial `Clean` log per room in `/housekeeping_logs` (`hk_init_{roomNumber}`).
- Resets `/settings/system_date` (`system_date`, `current_date`, `today_checkins = 0`, `today_checkouts = 0`, `continued_rooms = 0`).
- Resets `/counters/invoice_sequence` (`sequence = 0`, `current_value = 0`).
- Creates 1 post-reset audit log entry in `/audit_logs`.
- Unlinks uploaded guest document files (`id_doc_*`) safely from `backend/guest-documents/`.
- Releases distributed concurrency lock in the `finally` block.

---

## 4. Exact Purge vs. Preserve Policy

### 4.1 Purged Collections (Transactional Data)
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
14. `/audit_logs` (prior logs purged; 1 post-reset entry recorded)
15. `/notifications`
16. `/reservations`
17. `/bookings`
18. `/guests`
19. `/users` (WHERE `role === 'guest'`)

### 4.2 Protected Collections (100% Preserved)
1. `/roles` (Step 4 RBAC)
2. `/permissions` (Step 4 RBAC)
3. `/role_permissions` (Step 4 RBAC)
4. `/staff` (Step 7 Master Data)
5. `/room_types` (Step 7 Master Data)
6. `/inventory_categories` (Step 7 Master Data)
7. `/inventory_products` (Step 7 Master Data)
8. `/users` (WHERE `role != 'guest'` — e.g. `admin`, `super_admin`, `staff`, `receptionist`, `housekeeper`, `kitchen`)
9. `/settings/hotel_config` (Tax rules, hotel name, policies)

### 4.3 Firebase Auth Safety
- Staff Firebase Auth accounts are **NEVER deleted**.
- Super Admin and Root Admin Firebase Auth accounts are **NEVER deleted**.
- All staff UIDs are explicitly shielded from any authentication deletion.

---

## 5. Chunked Deletion & Distributed Concurrency Lock

### 5.1 Chunked Batch Deletion
```javascript
static async deleteCollectionChunked(collectionName, batchSize = 400) {
  let totalDeleted = 0;
  while (true) {
    const snapshot = await db.collection(collectionName).limit(batchSize).get();
    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    totalDeleted += snapshot.size;
    if (snapshot.size < batchSize) break;
  }
  return totalDeleted;
}
```

### 5.2 Concurrency Lock & Lease Recovery
- Lock Document: `/settings/factory_reset_lock`
- Lease Timeout: 120,000 ms (2 minutes)
- Rejection: Concurrent requests receive **HTTP 409 Conflict** (`RESET_IN_PROGRESS`).
- Stale Recovery: If a previous reset process crashed, leases older than 2 minutes are automatically reclaimed.

---

## 6. Verification & Test Results

### 6.1 Step 11 Migration Test Suite
```bash
node backend/tests/testPhase3Step11FactoryResetFirestoreMigration.mjs
```
- **Result:** **24 / 24 PASSED (100%)**
- Verified feature flag defaulting to `false`
- Verified MySQL fallback execution when flag is `false`
- Verified Firestore path execution when flag is `true`
- Verified distributed lock acquisition and rejection of concurrent resets (409)
- Verified chunked deletion bounds (400 operations)
- Verified purge invariants (18 transactional collections)
- Verified preservation invariants (7 protected config collections)
- Verified guest user purge isolation vs staff/admin user preservation
- Verified room reset contract (`vacant`, `Clean`, active references cleared)
- Verified housekeeping deterministic reseeding (`hk_init_{roomNumber}`)
- Verified business date and counters reset (`today_checkins = 0`, etc.)
- Verified rollback safety upon flag toggle

### 6.2 Full Regression Test Suite Execution
| Test Suite | Assertions | Status |
|---|:---:|:---:|
| **Step 11 Factory Reset Migration** | 24 / 24 | **PASS** |
| **Step 10 Audit Logs & Reports Cutover** | 29 / 29 | **PASS** |
| **Step 9 Financials & Invoices Cutover** | 24 / 24 | **PASS** |
| **Step 8 Check-In/Out/Shift Cutover** | 23 / 23 | **PASS** |
| **Step 7 Master Data Cutover** | 33 / 33 | **PASS** |
| **Step 5 Business Date & Day End** | 37 / 37 | **PASS** |
| **Step 4 RBAC & Claims Resolution** | 73 / 73 | **PASS** |
| **Step 3B Staff Resolution** | 73 / 73 | **PASS** |
| **Step 3C Staff Login** | 114 / 114 | **PASS** |
| **Step 3D-4 Guest Ownership** | 65 / 65 | **PASS** |
| **Status Endpoint & Business Date** | 16 / 16 | **PASS** |
| **Total Regression Assertions** | **511 / 511** | **100% PASS** |

### 6.3 Production Bundle Build
```bash
npm run build
```
- **Result:** **PASS** (Built in 10.97s, 2853 modules transformed)

---

## 7. Safety Declaration & Status Confirmation

- **MySQL Schema Changes:** **0**
- **MySQL Data Deletions:** **0**
- **Destructive Operations on Production Data:** **0**
- **Feature Flag State:** `USE_FIRESTORE_FACTORY_RESET=false` (Default)

> [!IMPORTANT]
> **Step 11 implementation complete.**  
> **Step 11 controlled cutover NOT performed.**  
> **Step 12 and Step 13 NOT started.**
