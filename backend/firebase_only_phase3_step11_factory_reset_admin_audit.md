# HPMS Phase 3 Step 11 — Factory Reset & Administrative Routines
## Firebase/Firestore 100% Read-Only Dependency Audit

**Date:** 2026-08-20  
**Phase:** Phase 3 Step 11 (Audit Only)  
**Status:** **100% READ-ONLY AUDIT COMPLETE — IMPLEMENTATION NOT STARTED**  
**Safety Status:** 0 Database Mutations, 0 Source Code Modifications, 0 .env Changes, 0 Destructive Actions  

---

## 1. Executive Summary

This document establishes the comprehensive 100% read-only architectural audit for **Phase 3 Step 11: Factory Reset & Administrative Routines**.

In HPMS, Factory Reset and administrative maintenance routines represent destructive operations designed to reset the hotel management system to an initial clean operational state. Currently, Factory Reset is implemented in MySQL via [`backend/services/FactoryResetService.js`](file:///d:/projects/hotel/backend/services/FactoryResetService.js), [`backend/controllers/factoryResetController.js`](file:///d:/projects/hotel/backend/controllers/factoryResetController.js), and [`backend/routes/factoryResetRoutes.js`](file:///d:/projects/hotel/backend/routes/factoryResetRoutes.js).

With Phases 3 Step 4 through Step 10 already cut over to Firestore primary authority, all operational data (Guests, Bookings, Reservations, Payments, Invoices, Ledger items, Cash logs, Housekeeping, Room Status History, Audit Logs, and Reports) resides in Google Cloud Firestore. Step 11 defines the dual-path migration architecture to execute Factory Reset and maintenance routines directly against Firestore collections while strictly preserving master data, staff accounts, RBAC configurations, and room configurations.

---

## 2. Current Factory Reset Architecture

### 2.1 File Components
1. **Service:** [`backend/services/FactoryResetService.js`](file:///d:/projects/hotel/backend/services/FactoryResetService.js)
   - Executes transactional deletes in FK child→parent order.
   - Resets room status to `'vacant'` and housekeeping status to `'Clean'`.
   - Reseeds 1 initial `'Clean'` housekeeping log per room.
   - Resets operational counters in `system_settings` (`today_checkins`, `today_checkouts`, `continued_rooms`, `system_date`).
   - Resets `AUTO_INCREMENT = 1` for all 15 deleted tables.
   - Removes uploaded identity document files from `backend/guest-documents/`.
   - Exposes read-only preflight method `verifyReset()`.
2. **Controller:** [`backend/controllers/factoryResetController.js`](file:///d:/projects/hotel/backend/controllers/factoryResetController.js)
   - `getFactoryResetStatus`: Returns current entity counts (read-only preflight).
   - `factoryReset`: Requires exact confirmation phrase: `"RESET HOTEL DATA"`.
3. **Route Definition:** [`backend/routes/factoryResetRoutes.js`](file:///d:/projects/hotel/backend/routes/factoryResetRoutes.js)
   - `GET /api/system/factory-reset/status` (Protected: `authenticate`, `requireSuperAdmin`)
   - `POST /api/system/factory-reset` (Protected: `authenticate`, `requireSuperAdmin`)

### 2.2 Exact MySQL SQL Statements Executed During Reset

```sql
-- 1. Transactional Deletions (FK child -> parent order)
DELETE FROM `room_status_history`;
DELETE FROM `booking_history`;
DELETE FROM `stay_extension_requests`;
DELETE FROM `feedback`;
DELETE FROM `maintenance`;
DELETE FROM `housekeeping_logs`;
DELETE FROM `ledger_items`;
DELETE FROM `payments`;
DELETE FROM `invoices`;
DELETE FROM `cash_logs`;
DELETE FROM `audit_logs`;
DELETE FROM `notifications`;
DELETE FROM `reservations`;
DELETE FROM `bookings`;
DELETE FROM `guests`;

-- 2. Guest User Deletion
SELECT id FROM roles WHERE name = 'guest' LIMIT 1;
DELETE FROM users WHERE role_id = ?;

-- 3. Room Operational State Reset
UPDATE rooms 
SET status = 'vacant', 
    housekeeping_status = 'Clean', 
    housekeeping_assigned_to = NULL, 
    housekeeping_priority = 'Normal', 
    last_cleaned_at = CURRENT_TIMESTAMP;

-- 4. Housekeeping Log Reseeding (1 per room)
SELECT id FROM rooms;
INSERT INTO housekeeping_logs (room_id, action, notes) 
VALUES (?, 'Clean', 'Post factory reset — room ready for check-in.');

-- 5. System Settings Counters Reset
UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date';
UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkins';
UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkouts';
UPDATE system_settings SET value_val = '0' WHERE key_name = 'continued_rooms';

-- 6. Post-Commit AUTO_INCREMENT Resets
ALTER TABLE `room_status_history` AUTO_INCREMENT = 1;
ALTER TABLE `booking_history` AUTO_INCREMENT = 1;
ALTER TABLE `stay_extension_requests` AUTO_INCREMENT = 1;
ALTER TABLE `feedback` AUTO_INCREMENT = 1;
ALTER TABLE `maintenance` AUTO_INCREMENT = 1;
ALTER TABLE `housekeeping_logs` AUTO_INCREMENT = 1;
ALTER TABLE `ledger_items` AUTO_INCREMENT = 1;
ALTER TABLE `payments` AUTO_INCREMENT = 1;
ALTER TABLE `invoices` AUTO_INCREMENT = 1;
ALTER TABLE `cash_logs` AUTO_INCREMENT = 1;
ALTER TABLE `audit_logs` AUTO_INCREMENT = 1;
ALTER TABLE `notifications` AUTO_INCREMENT = 1;
ALTER TABLE `reservations` AUTO_INCREMENT = 1;
ALTER TABLE `bookings` AUTO_INCREMENT = 1;
ALTER TABLE `guests` AUTO_INCREMENT = 1;
```

---

## 3. Other Administrative Routines in the Codebase

Beyond Factory Reset, the codebase contains specific administrative maintenance and state-transition routines:

| Routine | File | HTTP Endpoint / Invocation | Description | Impact |
|---|---|---|---|---|
| **Day End Close** | [`auditController.js`](file:///d:/projects/hotel/backend/controllers/auditController.js) | `POST /api/dayend` | Advances business date, posts rollover tariffs, resets daily counters | Mutates business date & daily counters |
| **Undo Day End** | [`auditController.js`](file:///d:/projects/hotel/backend/controllers/auditController.js) | `POST /api/dayend/undo` | Reverses last Day End, deletes rollover tariffs, restores previous counters | Deletes rollover ledger items, updates settings |
| **Manual Business Date Override** | [`settingsController.js`](file:///d:/projects/hotel/backend/controllers/settingsController.js) | `POST /api/settings/business-date` | Sets system date manually with permission check | Mutates `/settings/system_date` |
| **Document Cleanup** | [`auditController.js`](file:///d:/projects/hotel/backend/controllers/auditController.js) | `DELETE /api/admin/guest-documents/:guestId` | Deletes uploaded guest ID file and resets verification status | Disk unlink + DB update |
| **Staff Soft Deactivation** | [`staffController.js`](file:///d:/projects/hotel/backend/controllers/staffController.js) | `DELETE /api/staff/:id` | Soft-deactivates staff member (`status = 'Inactive'`) | Profile status update |
| **Room Housekeeping Status** | [`housekeepingController.js`](file:///d:/projects/hotel/backend/controllers/housekeepingController.js) | `PUT /api/housekeeping/rooms/:id/status` | Updates cleaning status and logs housekeeping audit | Room metadata update |

---

## 4. Firestore Collection Mapping & Deletion Classification

Every MySQL table and operational artifact has been classified into its corresponding Firestore collection and reset policy:

```
                                    HPMS DATA STORE
                                          │
            ┌─────────────────────────────┼─────────────────────────────┐
            ▼                             ▼                             ▼
       [CATEGORY A]                  [CATEGORY B]                  [CATEGORY C & D]
  PURGE DURING RESET              PRESERVE 100%                 RESET & RESEED
  ──────────────────              ─────────────                 ───────────────
  • /bookings                     • /roles                      • /rooms (Reset vacant/clean)
  • /reservations                 • /permissions                • /housekeeping_logs (Reseed 1/room)
  • /guests                       • /role_permissions           • /settings/system_date (Reset counters)
  • /payments                     • /staff                      • /counters/invoice_sequence (Reset 0)
  • /invoices                     • /room_types                 
  • /ledger_items                 • /inventory_categories       
  • /cash_logs                    • /inventory_products         
  • /cash_submissions             • /users (Staff/Admin)        
  • /audit_logs                                                 
  • /notifications                                              
  • /feedback                                                   
  • /maintenance                                                
  • /stay_extension_requests                                    
  • /checkout_snapshots                                         
  • /razorpay_transactions                                      
  • /users (role='guest')                                       
```

### Detailed Deletion & Preservation Matrix

| Database Entity / Domain | Firestore Collection | Document ID Strategy | Reset Classification | Reset Action / Rationale |
|---|---|---|:---:|---|
| **Bookings** | `/bookings` + subcollections | `booking_{id}` or `bkg_{id}` | **A (DELETE)** | Purge all booking records and history subcollections |
| **Reservations** | `/reservations` | `res_{id}` | **A (DELETE)** | Purge all upcoming/past reservations |
| **Guests** | `/guests` | `guest_{id}` | **A (DELETE)** | Purge all guest profiles and identity metadata |
| **Payments** | `/payments` | `pay_{id}` | **A (DELETE)** | Purge all financial transactions and payment receipts |
| **Invoices** | `/invoices` | `inv_{id}` | **A (DELETE)** | Purge all generated invoices |
| **Invoice Counters** | `/counters/invoice_sequence` | `invoice_sequence` | **C (RESET)** | Reset sequence counter back to 0 |
| **Ledger Items / Folios** | `/ledger_items` | `ledger_{id}` | **A (DELETE)** | Purge all room tariffs, taxes, and service charges |
| **Cash Logs** | `/cash_logs` | `cash_log_{id}` | **A (DELETE)** | Purge all cash register in/out records |
| **Cash Submissions** | `/cash_submissions` | `cash_sub_{id}` | **A (DELETE)** | Purge all shift cash handover submissions |
| **Audit Logs** | `/audit_logs` | `audit_{id}` | **A (DELETE)** | Purge old audit logs; create 1 single `FACTORY_RESET` audit log |
| **Notifications** | `/notifications` | `notif_{id}` | **A (DELETE)** | Purge all guest and admin notification items |
| **Feedback / Reviews** | `/feedback` | `fb_{id}` | **A (DELETE)** | Purge all guest review submissions |
| **Maintenance Requests** | `/maintenance` | `maint_{id}` | **A (DELETE)** | Purge all maintenance tickets |
| **Stay Extensions** | `/stay_extension_requests`| `ext_{id}` | **A (DELETE)** | Purge all extension requests |
| **Checkout Snapshots** | `/checkout_snapshots` | `snap_{bookingId}` | **A (DELETE)** | Purge historical recovery snapshots |
| **Online Transactions** | `/razorpay_transactions` | `rzp_{id}` | **A (DELETE)** | Purge payment gateway logs |
| **Booking History** | `/booking_history` | `bh_{id}` | **A (DELETE)** | Purge audit history timelines |
| **Room Status History** | `/room_status_history` | `rsh_{id}` | **A (DELETE)** | Purge room transition history timelines |
| **Guest Users** | `/users` (where role='guest') | `uid` or `user_{id}` | **A (DELETE)** | Purge guest user records from `/users` |
| **Rooms** | `/rooms` | `room_{number}` | **C (RESET)** | **PRESERVE ALL ROOMS**. Update fields: `status='vacant'`, `housekeeping_status='Clean'`, `current_booking_id=null`, `current_guest_name=null`, `guest_id=null`, `last_cleaned_at=ISO` |
| **Housekeeping Logs** | `/housekeeping_logs` | `hk_{id}` | **D (RESEED)** | Purge all past logs; reseed 1 initial `'Clean'` log per room |
| **System Settings** | `/settings/system_date` | `system_date` | **C (RESET)** | Set `system_date` to today's date (`YYYY-MM-DD`), `today_checkins=0`, `today_checkouts=0`, `continued_rooms=0` |
| **Hotel Configuration** | `/settings/hotel_config` | `hotel_config` | **B (PRESERVE)** | Preserve hotel name, tax rates, GST rules, policies |
| **Room Types** | `/room_types` | `rt_{code}` or `rt_{id}` | **B (PRESERVE)** | Preserve all room types, base rates, descriptions |
| **Staff Members** | `/staff` | `staff_{id}` or `staff_{uid}`| **B (PRESERVE)** | Preserve all staff profiles, departments, shift assignments |
| **Staff/Admin Users** | `/users` (role != 'guest') | `uid` or `user_{id}` | **B (PRESERVE)** | Preserve all staff and Super Admin login records |
| **RBAC Roles & Permissions**| `/roles`, `/permissions` | `role_{id}`, `perm_{id}` | **B (PRESERVE)** | Preserve complete permission and authorization matrix |
| **Inventory Products** | `/inventory_products` | `prod_{id}` or SKU | **B (PRESERVE)** | Preserve master inventory catalog |
| **Inventory Categories** | `/inventory_categories` | `cat_{id}` | **B (PRESERVE)** | Preserve inventory categorization |
| **Guest Uploaded Files** | `backend/guest-documents/` | `id_doc_*` | **A (DELETE)** | Delete uploaded identity files from physical disk |

---

## 5. Active Hotel & Firebase Auth Safety Analysis

### 5.1 What Must NEVER Be Deleted from Firebase Authentication
1. **Root Admin Account (`user_id = 1` / `role = 'admin'`):**
   - Must retain credentials, Firebase UID, and custom claims intact.
2. **Staff Accounts (`/staff/*`):**
   - Front desk, housekeeping, kitchen, and managerial staff MUST retain their Firebase Auth UIDs and passwords.
3. **RBAC Claims:**
   - Custom claims (`role`, `permissions`, `isRootAdmin`, `mysql_id`) for staff must remain completely untouched.

### 5.2 Guest Firebase Authentication Strategy
- In Firebase Auth, guest users who signed up self-service have Firebase Auth UIDs.
- In Factory Reset:
  - Deleting `/guests/*` and `/users/{uid}` (where `role === 'guest'`) isolates the guest in Firestore.
  - Optional batch deletion via Firebase Admin SDK (`getAuth().deleteUsers(uids)`) can purge guest auth records in chunks of 1000 without affecting staff.
  - Staff UIDs must be explicitly filtered out before invoking any Firebase Auth deletion.

---

## 6. Firestore Transaction & Batch Limits Strategy

Firestore enforces a **500 write operations limit per atomic batch / transaction**. A hotel with 5,000 bookings and 20,000 ledger items cannot delete all records in a single Firestore transaction.

### Safe Chunked Batch Deletion Pattern

```javascript
/**
 * Deletes a Firestore collection in safe chunks of 400 documents.
 * Ensures execution respects the 500-operation limit with exponential backoff on retry.
 */
async function deleteCollectionChunked(db, collectionName, batchSize = 400) {
  let deletedCount = 0;
  while (true) {
    const snapshot = await db.collection(collectionName).limit(batchSize).get();
    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    deletedCount += snapshot.size;
    if (snapshot.size < batchSize) break;
  }
  return deletedCount;
}
```

### Reset Concurrency & Idempotency Locking
- **Distributed Mutex:** To prevent concurrent executions of Factory Reset, an atomic lock document `/settings/factory_reset_lock` with a 2-minute lease timestamp will be acquired before execution.
- **Fail-Safe Release:** Lock is automatically cleared upon completion or failure.

---

## 7. Feature Flag Design

### Recommended Flag
```env
USE_FIRESTORE_FACTORY_RESET=false
```

### Helpers in `backend/config/featureFlags.js`
- `isFirestoreFactoryResetEnabled()`: Returns `true` if `process.env.USE_FIRESTORE_FACTORY_RESET === 'true'`.

### Behavior Matrix
- **Flag OFF (`false`):** Routes `factoryReset` requests to MySQL `FactoryResetService.factoryReset()`.
- **Flag ON (`true`):** Routes `factoryReset` requests to `FirestoreFactoryResetService.factoryReset()`.
- **Rollback Mechanism:** Setting `USE_FIRESTORE_FACTORY_RESET=false` in `.env` immediately restores MySQL reset execution without code changes.

---

## 8. MySQL Fallback Policy

1. **Business Validation Errors:**
   - Invalid confirmation phrase (`!= "RESET HOTEL DATA"`) ➔ Returns **HTTP 400 Bad Request** immediately. **Zero fallback to MySQL**.
   - Non-SuperAdmin caller ➔ Returns **HTTP 403 Forbidden** immediately. **Zero fallback to MySQL**.
   - Unauthenticated caller ➔ Returns **HTTP 401 Unauthorized** immediately. **Zero fallback to MySQL**.
2. **Infrastructure Failures:**
   - If Firestore is unreachable (network timeout or quota error) **prior to any deletion**, safe fallback to MySQL `FactoryResetService` can be executed if configured.
   - If deletion has partially started, fail closed with detailed logging and rollback recovery rather than performing partial MySQL execution to prevent split-brain state.

---

## 9. Security & Authorization Analysis

- **Route Protection:** `router.post('/', authenticate, requireSuperAdmin, factoryReset)` in [`factoryResetRoutes.js`](file:///d:/projects/hotel/backend/routes/factoryResetRoutes.js).
- **Middleware Validation:** `requireSuperAdmin` checks:
  - `req.user.isRootAdmin === true` OR `req.user.role === 'super_admin'` OR `req.user.role === 'admin'`.
- **RBAC Authority:** Firebase-only RBAC (Phase 3 Step 4) resolves user permissions and claims purely from token claims and Firestore `/roles`.
- **Bypass Prevention:** No public endpoint exists. Confirmation phrase is strictly required on every execution.

---

## 10. Future Implementation Test Plan

A dedicated test suite [`backend/tests/testPhase3Step11FactoryResetFirestoreMigration.mjs`](file:///d:/projects/hotel/backend/tests/testPhase3Step11FactoryResetFirestoreMigration.mjs) will be created during Step 11 implementation:

1. **Group A: Feature Flag Defaulting**
   - `USE_FIRESTORE_FACTORY_RESET` defaults to `false`.
2. **Group B: Authorization & Guard Rejection**
   - Rejects missing phrase, wrong phrase, unauthenticated, and non-admin requests.
3. **Group C: Preflight Record Verification**
   - `verifyReset()` returns counts without modifying any data.
4. **Group D: Controlled Chunked Deletion**
   - Purges test bookings, guests, payments, invoices, ledger items, audit logs, and feedback.
5. **Group E: Preservation of Master & Staff Data**
   - Verifies staff accounts, room types, inventory products, roles, and admin users remain untouched.
6. **Group F: Room State & Counter Reset**
   - Rooms reset to vacant/clean, housekeeping reseeded, `system_date` counters reset to 0.
7. **Group G: Concurrency Lock & Rollback Safety**
   - Prevents simultaneous reset requests; toggling flag off restores MySQL path.

---

## 11. Regression Baseline Verification

All active cutovers have been verified passing:
- **Step 10 Audit Logs & Reports Cutover:** 29 / 29 PASS
- **Step 10 Dual-Path Migration:** 27 / 27 PASS
- **Step 9 Financials & Invoices Cutover:** 24 / 24 PASS
- **Step 8 Check-In/Out/Shift Cutover:** 23 / 23 PASS
- **Step 7 Master Data Cutover:** 33 / 33 PASS
- **Step 5 Business Date Cutover:** 37 / 37 PASS
- **Step 4 RBAC Cutover:** 73 / 73 PASS
- **Step 3B / 3C / 3D-4 Auth & Ownership:** 252 / 252 PASS
- **Status Endpoint & System Date:** 16 / 16 PASS
- **Total Regression Assertions:** **534 / 534 PASS (100%)**

---

## 12. Audit Invariant Summary

- **MySQL Mutations:** 0 (Read-only audit — no tables touched)
- **Firestore Mutations:** 0 (Read-only audit — no documents touched)
- **Source Modifications:** 0 (No application code modified)
- **.env Modifications:** 0 (No feature flags altered)
- **Destructive Operations Executed:** **ZERO (Factory Reset was NOT executed)**
- **Phase Status:**
  - **Phase 3 Step 11 Read-Only Audit is COMPLETE.**
  - **Phase 3 Step 11 Implementation has NOT started.**
  - **Phase 3 Step 12 and Step 13 have NOT started.**
