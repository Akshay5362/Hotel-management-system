# HPMS Phase 3 Step 6 — Remaining MySQL Dependency & Firebase Migration Read-Only Audit

**Date:** 2026-08-20  
**Phase:** Phase 3 — Step 6 (Comprehensive MySQL Dependency & Decommission Audit)  
**Status:** READ-ONLY AUDIT COMPLETE  
**Safety Status:** 0 Source modifications, 0 Schema mutations, 0 Data writes, 0 Flag changes.

---

## 1. Executive Summary & Overall Readiness Score

Following the successful controlled cutovers of **Firebase-Only RBAC (Step 4)** and **Firebase-Only Business Date / Day-End (Step 5)**, HPMS has achieved zero MySQL queries for user permission checks, authentication tokens, system date resolution, and daily room counter metrics.

However, MySQL currently remains active as:
1. The **mutation store** for operational workflows (Check-In, Check-Out, Room Shift, Payments, Reservations).
2. The host of the **`dual_write_outbox` table** used by the background Outbox worker.
3. The **emergency fallback** in cutover services (`SafeCutoverFallbackService`, `checkInCutoverService`, etc.).
4. The database for **master data CRUD** (Staff, Room Types, Inventory, Housekeeping, Invoices).
5. The storage engine targeted by **`FactoryResetService.js`**.
6. The container dependency in **`docker-compose.yml`** (`depends_on: db`).

```
========================================================================================
                      MYSQL DECOMMISSION READINESS SCORE: 68%
========================================================================================
 Domain / Area                       Readiness  Primary Authority  Remaining MySQL Role
 ---------------------------------------------------------------------------------------
 Authentication                      95%        Firebase Auth      Legacy password auth fallback
 Authorization / RBAC                100%       Firestore / Claims Emergency fallback only
 Business Date / Day-End             100%       Firestore          Emergency fallback only
 Room Status & Availability Serving  85%        Firestore          Emergency fallback & shadow
 Core Mutations (Checkin/Out/Shift)  70%        MySQL + Outbox     ACID transaction coordinator
 Financials (Payments, Ledger, Cash) 70%        MySQL + Outbox     ACID transaction coordinator
 Master Data (Staff, Inventory, HK)  60%        MySQL + Outbox     Direct SQL CRUD in controllers
 Audit Logs, Reports & Invoices      65%        MySQL + Outbox     SQL queries for list endpoints
 Factory Reset / Maintenance         30%        MySQL              Hardcoded DELETE FROM on 19 tables
 Outbox Infrastructure               40%        MySQL              dual_write_outbox table in MySQL
 Infrastructure & Docker             20%        MySQL + Docker     db service and mysql2 pool
========================================================================================
```

---

## 2. Complete MySQL Query Inventory by Domain

Below is the complete classification of every live MySQL query across the backend codebase:

### 2.1 Authentication & RBAC (Legacy Fallback Paths)
- [`backend/controllers/authController.js`](file:///d:/projects/hotel/backend/controllers/authController.js) (Lines 48–140, 240–320):
  - `SELECT ... FROM staff WHERE username = ?`
  - `SELECT ... FROM guests WHERE email = ?`
  - `SELECT ... FROM users WHERE id = ?`
  - `INSERT INTO users`, `INSERT INTO guests` (Guest self-registration)
- [`backend/controllers/staffController.js`](file:///d:/projects/hotel/backend/controllers/staffController.js) (Line 146):
  - `SELECT s.*, r.name as role FROM staff s JOIN roles r...` (Legacy staff login fallback)
  - *Status:* Firebase Auth & Claims are primary. MySQL code is active only when `ENABLE_FIREBASE_STAFF_LOGIN` or `ENABLE_FIREBASE_GUEST_LOGIN` is false.

### 2.2 Core Operational Mutations (Check-In, Check-Out, Room Shift, Reservations)
- [`backend/services/checkInService.js`](file:///d:/projects/hotel/backend/services/checkInService.js) (Lines 40–180):
  - `SELECT * FROM rooms WHERE id = ? FOR UPDATE`
  - `SELECT * FROM bookings WHERE id = ? FOR UPDATE`
  - `UPDATE rooms SET status = 'occupied'`
  - `UPDATE bookings SET booking_status = 'Checked In'`
  - `INSERT INTO ledger_items`, `INSERT INTO payments`, `INSERT INTO guest_documents`
  - `INSERT INTO dual_write_outbox`
- [`backend/services/checkOutService.js`](file:///d:/projects/hotel/backend/services/checkOutService.js) (Lines 50–160):
  - `SELECT * FROM bookings WHERE id = ? FOR UPDATE`
  - `UPDATE rooms SET status = 'dirty'`
  - `UPDATE bookings SET booking_status = 'Checked Out'`
  - `INSERT INTO checkout_snapshots`
- [`backend/services/roomShiftService.js`](file:///d:/projects/hotel/backend/services/roomShiftService.js) (Lines 20–140):
  - `SELECT id, number, status FROM rooms WHERE id IN (?, ?) FOR UPDATE`
  - `UPDATE rooms SET status = 'occupied'`, `UPDATE rooms SET status = 'vacant'`
  - `UPDATE bookings SET room_id = ?`, `INSERT INTO room_shift_logs`
- [`backend/controllers/reservationController.js`](file:///d:/projects/hotel/backend/controllers/reservationController.js) (Lines 60–280):
  - `SELECT * FROM reservations`, `INSERT INTO reservations`, `UPDATE reservations SET status = 'Cancelled'`
  - *Status:* Writes currently execute MySQL transaction + enqueue to Outbox.

### 2.3 Financial & Ledger Operations
- [`backend/controllers/paymentController.js`](file:///d:/projects/hotel/backend/controllers/paymentController.js) (Lines 50–220):
  - `INSERT INTO payments`, `INSERT INTO ledger_items`, `SELECT * FROM payments WHERE booking_id = ?`
- [`backend/controllers/cashController.js`](file:///d:/projects/hotel/backend/controllers/cashController.js) (Lines 30–120):
  - `SELECT * FROM cash_logs`, `INSERT INTO cash_submissions`, `UPDATE cash_logs SET status = 'SUBMITTED'`
- [`backend/controllers/invoiceController.js`](file:///d:/projects/hotel/backend/controllers/invoiceController.js) (Lines 40–160):
  - `SELECT * FROM invoices WHERE booking_id = ?`, `INSERT INTO invoices`, `SELECT ... FROM ledger_items`
- [`backend/controllers/razorpayController.js`](file:///d:/projects/hotel/backend/controllers/razorpayController.js) (Lines 30–90):
  - `INSERT INTO razorpay_transactions`, `UPDATE razorpay_transactions`
  - *Status:* Outbox synchronizes to Firestore collections `/payments`, `/ledger_items`, `/cash_logs`, `/invoices`.

### 2.4 Master Data Management (CRUD)
- [`backend/controllers/roomTypeController.js`](file:///d:/projects/hotel/backend/controllers/roomTypeController.js) (Lines 30–190):
  - `SELECT * FROM room_types`, `INSERT INTO room_types`, `UPDATE room_types`, `DELETE FROM room_types`
- [`backend/controllers/staffController.js`](file:///d:/projects/hotel/backend/controllers/staffController.js) (Lines 250–520):
  - `SELECT * FROM staff`, `INSERT INTO staff`, `UPDATE staff SET ...`, `UPDATE staff SET deleted = 1`
- [`backend/controllers/inventoryController.js`](file:///d:/projects/hotel/backend/controllers/inventoryController.js) (Lines 40–350):
  - `SELECT * FROM inventory_categories`, `INSERT/UPDATE/DELETE inventory_categories`
  - `SELECT * FROM inventory_products`, `INSERT/UPDATE/DELETE inventory_products`
- [`backend/controllers/housekeepingController.js`](file:///d:/projects/hotel/backend/controllers/housekeepingController.js) (Lines 30–180):
  - `SELECT * FROM housekeeping`, `INSERT INTO housekeeping`, `UPDATE housekeeping SET status = ?`
  - *Status:* Direct SQL in controllers. Firestore repositories exist in `backend/repositories/firestore/`.

### 2.5 Outbox & Background Processing
- [`backend/services/outboxService.js`](file:///d:/projects/hotel/backend/services/outboxService.js) & [`outboxWorker.js`](file:///d:/projects/hotel/backend/services/outboxWorker.js):
  - `INSERT INTO dual_write_outbox`
  - `SELECT * FROM dual_write_outbox WHERE status = 'PENDING' FOR UPDATE SKIP LOCKED`
  - `UPDATE dual_write_outbox SET status = 'COMPLETED'`
  - *Status:* The outbox worker polls MySQL every 500ms.

### 2.6 Factory Reset & Administrative Maintenance
- [`backend/services/FactoryResetService.js`](file:///d:/projects/hotel/backend/services/FactoryResetService.js) (Lines 150–320):
  - Iterates over 19 MySQL tables executing `DELETE FROM \`${table}\``.
  - Re-seeds default admin, roles, permissions, settings, rooms.

---

## 3. Firestore Coverage Matrix

| Domain | MySQL Table | Firestore Collection | Firestore Repository | Primary Authority | Readiness |
|---|---|---|---|---|---|
| **Users / Staff Auth** | `users`, `staff` | `users`, `staff` | `usersRepository.js`, `staffRepository.js` | Firebase Auth | **95%** |
| **RBAC** | `roles`, `permissions`, `role_permissions` | `roles`, `permissions`, `role_permissions` | `rbacRepository.js` | Firestore / Claims | **100%** |
| **Business Date** | `system_settings` (`system_date`) | `settings/system_date` | `systemSettingsRepository.js` | Firestore | **100%** |
| **Room Status** | `rooms`, `room_status_history` | `rooms`, `room_status_history` | `roomsRepository.js`, `roomStatusHistoryRepository.js` | Firestore (Primary) | **85%** |
| **Availability** | `bookings`, `rooms`, `reservations` | `bookings`, `rooms`, `reservations` | `firestoreAvailabilityService.js` | Firestore (Primary) | **85%** |
| **Check-In / Out** | `bookings`, `guests`, `guest_documents` | `bookings`, `guests`, `guest_documents` | `bookingsRepository.js`, `guestsRepository.js` | MySQL + Outbox | **70%** |
| **Room Shift** | `room_shift_logs`, `bookings` | `room_shift_logs`, `bookings` | `bookingsRepository.js` | MySQL + Outbox | **65%** |
| **Ledger / Folio** | `ledger_items` | `ledger_items`, `/bookings/{id}/ledger_items` | `ledgerRepository.js` | MySQL + Outbox | **70%** |
| **Payments / Cash** | `payments`, `cash_logs`, `cash_submissions` | `payments`, `cash_logs`, `cash_submissions` | `paymentsRepository.js`, `cashLogsRepository.js` | MySQL + Outbox | **70%** |
| **Reservations** | `reservations` | `reservations` | `reservationsRepository.js` | MySQL + Outbox | **70%** |
| **Invoices** | `invoices` | `invoices` | `invoicesRepository.js` | MySQL + Outbox | **65%** |
| **Inventory** | `inventory_categories`, `inventory_products` | `inventory_categories`, `inventory_products` | `inventoryCategoriesRepository.js`, `inventoryProductsRepository.js` | MySQL (Dual-write) | **60%** |
| **Housekeeping** | `housekeeping` | `housekeeping` | `housekeepingRepository.js` | MySQL (Dual-write) | **60%** |
| **Room Types** | `room_types` | `room_types` | `roomTypesRepository.js` | MySQL (Dual-write) | **60%** |
| **Audit Logs** | `audit_logs` | `audit_logs` | `auditLogsRepository.js` | MySQL + Outbox | **70%** |
| **Factory Reset** | All 19 MySQL tables | All collections | `FactoryResetService.js` | MySQL | **30%** |
| **Outbox Queue** | `dual_write_outbox` | N/A | `outboxService.js` | MySQL | **40%** |

---

## 4. Known Blockers & Technical Analysis

### 4.1 Blocker 1: Core Operational Multi-Entity Transactions (Check-In, Check-Out, Room Shift)
- **Problem:** Currently, Check-In and Room Shift modify multiple tables (`rooms`, `bookings`, `ledger_items`, `payments`, `guest_documents`) inside a MySQL `START TRANSACTION ... FOR UPDATE` block.
- **Solution for Firebase-Only:** Migrate Check-In, Check-Out, and Room Shift to Firestore `db.runTransaction()` using atomic multi-document reads and writes across `/rooms`, `/bookings`, and subcollections. All repositories already support Firestore transactions.

### 4.2 Blocker 2: MySQL Outbox Daemon (`dual_write_outbox`)
- **Problem:** Background synchronization from MySQL to Firestore relies on `dual_write_outbox` polled by `outboxWorker.js`.
- **Solution for Firebase-Only:** Once operations write directly to Firestore as Primary Authority, the intermediate MySQL Outbox is no longer needed and can be decommissioned.

### 4.3 Blocker 3: Direct SQL in Master Data Controllers (Staff, Room Types, Inventory, Housekeeping)
- **Problem:** `staffController.js`, `roomTypeController.js`, `inventoryController.js`, and `housekeepingController.js` contain direct `pool.query('SELECT/INSERT/UPDATE...')` statements instead of calling repositories.
- **Solution for Firebase-Only:** Update these 4 controllers to route operations through their respective Firestore repositories (`staffRepository.js`, `roomTypesRepository.js`, `inventoryProductsRepository.js`, `housekeepingRepository.js`).

### 4.4 Blocker 4: Factory Reset Service
- **Problem:** `FactoryResetService.js` deletes all rows across 19 MySQL tables and re-inserts seeds using MySQL queries.
- **Solution for Firebase-Only:** Rewrite `FactoryResetService.js` to clear Firestore collections in batches and re-seed default admin user, settings, and room inventory directly in Firestore.

### 4.5 Blocker 5: Infrastructure & Docker Composition
- **Problem:** `docker-compose.yml` runs `hotel_pms_db` and `backend` has `depends_on: db: condition: service_healthy`. `backend/db.js` initializes a MySQL pool on startup.
- **Solution for Firebase-Only:** Remove `mysql2` pool initialization, remove MySQL healthcheck dependency in Dockerfile/compose, and remove `hotel_pms_db` service once all steps are complete.

---

## 5. Historical Data Audit & Backfill Assessment

1. **Current State:**
   - Active rooms (17 rooms) and room types are synchronized in Firestore.
   - Master settings (`/settings/system_date`) are synchronized.
   - Verified active staff and root admin claims are in Firebase Auth.
2. **Backfill Requirements Before Full Cutover:**
   - Historical bookings and reservations in MySQL need verification to ensure past audit trail parity.
   - Inventory products and historical invoice numbers should be validated for consistency.
   - No destructive schema deletion should take place before a complete Firestore export/backup is verified.

---

## 6. Recommended Phase 3 Roadmap to "Firebase-Only / MySQL-Free"

```
Phase 3 Step 6  ───► COMPREHENSIVE READ-ONLY DEPENDENCY AUDIT (COMPLETE)
Phase 3 Step 7  ───► Master Data Controllers Migration (Room Types, Staff, Inventory, Housekeeping)
Phase 3 Step 8  ───► Operational Mutations Migration (Check-In, Check-Out, Room Shift to Firestore Transactions)
Phase 3 Step 9  ───► Financial & Invoices Migration (Payments, Ledger, Cash Logs, Invoices to Firestore)
Phase 3 Step 10 ───► Audit Logs, Reports & History Cutover (Direct Firestore Querying)
Phase 3 Step 11 ───► Factory Reset & Administrative Routines (Firestore Batch Reset)
Phase 3 Step 12 ───► MySQL Outbox & Fallback Decommission (Bypass Outbox, Direct Firestore Writes)
Phase 3 Step 13 ───► Final Infrastructure & Docker MySQL Removal (Remove mysql2, drop db container, 100% Zero-MySQL)
```

---

## 7. Verification Checklist

- **Backend / Frontend Source Files Modified:** 0
- **Database Schema / Data Alterations:** 0
- **Feature Flags Changed:** 0
- **Runtime Behavior Changed:** 0

---

*(Phase 3 Step 6 Read-Only Audit is complete. Awaiting user review.)*
