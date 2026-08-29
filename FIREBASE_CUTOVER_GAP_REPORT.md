# HPMS-Sky5: Full Firebase / Firestore Operational Cutover Gap Report
> **Phase 1: Read-Only Codebase Audit & Migration Strategy**  
> **Timestamp:** August 11, 2026  
> **Status:** AUDIT COMPLETE — NOT READY FOR IMMEDIATE MYSQL REMOVAL  
> **Cutover Readiness Score:** **28 / 100**

---

## Executive Summary

A comprehensive, read-only architectural audit of the **HPMS-Sky5** codebase was conducted to evaluate readiness for completely replacing MySQL with Cloud Firestore (`asia-south1`) and Firebase Authentication.

### Key Finding:
**The system is NOT currently ready for MySQL removal.** While baseline Firestore collections exist with 165 migrated documents and 13 Firebase Auth users, **100% of HTTP API controllers and business services directly rely on MySQL connection pool queries (`pool.query()`) and MySQL transactions (`FOR UPDATE` / `connection.beginTransaction()`)**. The 15 existing Firestore repositories in `backend/repositories/firestore/` are read-only stubs containing hard dependencies on legacy MySQL IDs. 

Removing MySQL today would cause total system failure across all 15 PMS operational workflows.

---

## Section A: Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT APPLICATIONS                               │
│  ┌─────────────────────────┐  ┌─────────────────────┐  ┌─────────────────┐  │
│  │ Primary Admin React App │  │ Guest Portal App    │  │ Electron Wrapper│  │
│  │ (src/)                  │  │ (guest-web/)        │  │ (electron/)     │  │
│  └────────────┬────────────┘  └──────────┬──────────┘  └────────┬────────┘  │
└───────────────┼──────────────────────────┼──────────────────────┼───────────┘
                │ HTTP / REST              │ HTTP / REST          │ Spawns Node
                ▼                          ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      EXPRESS 4.x BACKEND (backend/)                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Controllers (14 modules) & Services (8 modules)                      │  │
│  │  Auth: Legacy HMAC-SHA256 JWT (with optional Firebase ID Token check) │  │
│  └───────────────────────────────────┬───────────────────────────────────┘  │
│                                      │ pool.query() / connection.query()    │
│                                      ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  MySQL Database (30 Tables) — SINGLE OPERATIONAL SOURCE OF TRUTH      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Section B: Final Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT APPLICATIONS                               │
│  ┌─────────────────────────┐  ┌─────────────────────┐  ┌─────────────────┐  │
│  │ Primary Admin React App │  │ Guest Portal App    │  │ Electron Wrapper│  │
│  │ (Firebase SDK + Auth)   │  │ (Firebase SDK + Auth)│  │ (Local Node Api)│  │
│  └────────────┬────────────┘  └──────────┬──────────┘  └────────┬────────┘  │
└───────────────┼──────────────────────────┼──────────────────────┼───────────┘
                │ Firebase ID Token        │ Firebase ID Token    │ Token / IPC
                ▼                          ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   EXPRESS API SERVER / CLOUD FUNCTIONS                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Controllers & Business Logic                                         │  │
│  │  Middleware: Firebase Admin SDK ID Token Verification & Custom Claims │  │
│  └───────────────────────────────────┬───────────────────────────────────┘  │
│                                      │ Repository Pattern / Transactions    │
│                                      ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Cloud Firestore (asia-south1) — SOLE OPERATIONAL DATABASE            │  │
│  │  Collections: /rooms, /bookings, /guests, /reservations, /payments,   │  │
│  │  /ledger_items, /cash_logs, /invoices, /staff, /system_settings...    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Section C: MySQL Dependency Inventory

The audit scanned 100% of codebase files and identified the following direct MySQL dependencies:

1. **Connection Pool Imports (`backend/db.js`)**:
   - Imported in **all 14 controllers** (`roomController.js`, `reservationController.js`, `paymentController.js`, `invoiceController.js`, `cashController.js`, `housekeepingController.js`, `inventoryController.js`, `staffController.js`, `authController.js`, `settingsController.js`, `reportsController.js`, `auditController.js`, `razorpayController.js`, `factoryResetController.js`).
   - Imported in **5 core services** (`businessDateService.js`, `AvailabilityService.js`, `checkInService.js`, `CheckoutRecoveryService.js`, `roomStatusService.js`).

2. **SQL Query Statements**:
   - Over **350 raw SQL query executions** across the backend using `pool.query()`, `connection.query()`, `db.query()`.

3. **MySQL Transaction & Locking Statements**:
   - `connection.beginTransaction()`, `connection.commit()`, `connection.rollback()` used in check-in, checkout, reservation creation, day end, room shifting, refund processing, and cash submission.
   - `SELECT ... FOR UPDATE` row locks used in `AvailabilityService.js`, `checkInService.js`, and `businessDateService.js` to serialize concurrent requests.

4. **MySQL Specific Date Functions**:
   - Heavy usage of `CURDATE()`, `NOW()`, `DATE_ADD()`, `DATE_SUB()`, `DATE_FORMAT()`, `DATEDIFF()` inside SQL strings.

5. **MySQL Relational Joins & Foreign Keys**:
   - Complex `JOIN` queries connecting `bookings` + `rooms` + `guests` + `users` + `payments` + `ledger_items` + `invoices`.
   - Foreign key cascading behaviors (`ON DELETE CASCADE`, `ON DELETE SET NULL`, `ON DELETE RESTRICT`).

6. **MySQL Auto-Increment Assumptions**:
   - Reliance on `result.insertId` for newly inserted records and numerical IDs (e.g. `room_id = 14`, `booking_id = 502`).

---

## Section D: Controller & Service Dependency Map

| Module | Current Read Source | Current Write Source | MySQL Files Used | Firestore Repo Available? | Repo Methods Available | Missing Firestore Methods | Transaction Requirement | Query / Index Requirements | Document Relationships | Migration Complexity | Cutover Risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **authController.js** | MySQL (`users`, `roles`, `guests`, `staff`) | MySQL + Firestore Sync (Lazy) | `backend/db.js` | Yes (`guestsRepository.js`, `staffRepository.js`) | `getAllGuestsFirestore`, `getAllStaffFirestore` | `createGuest`, `updateGuest`, `findUserByUsername`, `verifyPassword`, `setCustomClaims` | High (User + Guest creation) | Equality on `username`, `email`, `phone` | `/users/{uid}`, `/guests/{guest_id}` | High | High |
| **roomController.js** | MySQL (`rooms`, `bookings`, `ledger`, `guests`) | MySQL | `backend/db.js` | Yes (`roomsRepository.js`, `bookingsRepository.js`, `ledgerRepository.js`) | `getAllRoomsFirestore`, `getRoomByIdFirestore`, `getAllBookings` | `updateRoomStatus`, `assignHousekeeping`, `createCheckIn`, `processCheckout`, `addLedgerItem` | High (Multi-doc atomic check-in/out) | Compound query: `status` + `housekeeping_status` | `/rooms/{room_id}`, `/bookings/{booking_id}/ledger_items` | Critical | High |
| **reservationController.js** | MySQL (`reservations`, `rooms`) | MySQL | `backend/db.js` | Yes (`reservationsRepository.js`) | `getAllReservationsFirestore` | `createReservation`, `updateReservation`, `cancelReservation`, `checkOverlap` | High (Availability validation) | Compound query: `room_id` + `check_in_date` + `status` | `/reservations/{res_id}` | High | High |
| **paymentController.js** | MySQL (`payments`, `bookings`) | MySQL | `backend/db.js` | Yes (`paymentsRepository.js`) | `getAllPaymentsFirestore` | `createPayment`, `getPaymentsByBooking`, `refundPayment` | High (Payment + Folio balance sync) | Index by `booking_id` + `payment_date` | `/bookings/{booking_id}/payments` | High | High |
| **invoiceController.js** | MySQL (`invoices`, `bookings`, `ledger`) | MySQL | `backend/db.js` | Yes (`invoicesRepository.js`) | `getAllInvoicesFirestore` | `generateInvoice`, `getInvoiceByNumber`, `updateInvoiceStatus` | High (Deterministic invoice number) | Index by `invoice_number`, `booking_id` | `/invoices/{invoice_id}` | Medium | High |
| **housekeepingController.js** | MySQL (`housekeeping`, `rooms`, `staff`) | MySQL | `backend/db.js` | Partial | None | `updateCleaningStatus`, `assignStaff`, `logHousekeepingHistory` | Medium | Index by `room_id`, `assigned_to` | `/rooms/{room_id}`, `/housekeeping_logs` | Medium | Medium |
| **inventoryController.js** | MySQL (`inventory_products`, `categories`) | MySQL | `backend/db.js` | Yes (`inventoryProductsRepository.js`, `inventoryCategoriesRepository.js`) | `getAllInventoryProducts`, `getAllCategories` | `updateStock`, `createProduct`, `adjustQuantity` | High (Stock subtraction transaction) | Index by `category_id`, `sku` | `/inventory_products/{prod_id}` | Medium | Medium |
| **cashController.js** | MySQL (`cash_logs`, `cash_submissions`) | MySQL | `backend/db.js` | Yes (`cashLogsRepository.js`) | `getAllCashLogsFirestore` | `logCashEntry`, `submitShiftCash`, `getCashSummary` | High (Shift opening/closing balance) | Index by `business_date` + `user_id` | `/cash_logs/{log_id}`, `/cash_submissions/{sub_id}` | High | High |
| **staffController.js** | MySQL (`staff`) | MySQL | `backend/db.js` | Yes (`staffRepository.js`) | `getAllStaffFirestore` | `createStaffProfile`, `updateStaffStatus`, `deleteStaff` | Medium | Index by `department`, `status` | `/staff/{staff_id}` | Medium | Medium |
| **settingsController.js** | MySQL (`system_settings`) | MySQL | `backend/db.js` | Yes (`systemSettingsRepository.js`) | `getSystemDateFirestore` | `updateBusinessDate`, `acquireDateLock` | High (System-wide business date) | Key lookups | `/settings/system_date` | High | Critical |
| **reportsController.js** | MySQL (Aggregations across 10 tables) | MySQL | `backend/db.js` | No | None | All report aggregation functions | Low (Read-only, precomputed summary docs) | Aggregation indexes | `/analytics/daily_{date}` | Critical | Critical |
| **auditController.js** | MySQL (`audit_logs`, `booking_history`) | MySQL | `backend/db.js` | Yes (`auditLogsRepository.js`, `bookingHistoryRepository.js`) | `getAllAuditLogs`, `getAllBookingHistory` | `logAuditEvent`, `getAuditLogsByDate` | Low (Append-only) | Index by `business_date` + `action` | `/audit_logs/{log_id}` | Low | Low |
| **razorpayController.js** | MySQL (`razorpay_transactions`) | MySQL | `backend/db.js` | No | None | `createOrder`, `verifyPaymentSignature` | High (Idempotent webhook processing) | Index by `order_id` | `/razorpay_transactions/{order_id}` | Medium | High |
| **AvailabilityService.js** | MySQL (`rooms`, `reservations`, `bookings`) | MySQL | `backend/db.js` | No | None | `checkRoomAvailability`, `lockRoom` | High (Transaction lock replacement) | Compound range query on `check_in`/`check_out` | `/rooms/{room_id}` | Critical | Critical |
| **checkInService.js** | MySQL (`rooms`, `bookings`, `guests`) | MySQL | `backend/db.js` | No | None | `executeCheckIn` | High (Atomic multi-document check-in) | Compound queries | `/bookings`, `/rooms`, `/guests` | Critical | Critical |
| **CheckoutRecoveryService.js** | MySQL (`checkout_snapshots`, `bookings`) | MySQL | `backend/db.js` | No | None | `createSnapshot`, `recoverCheckout` | High | Document lookup by `booking_id` | `/checkout_snapshots/{booking_id}` | High | High |
| **businessDateService.js** | MySQL (`system_settings`, `bookings`, `rooms`, `ledger`) | MySQL | `backend/db.js` | No | None | `getBusinessDate`, `advanceBusinessDate`, `runNightAudit` | High (System Night Audit Transaction) | Batch processing | `/settings/system_date`, `/ledger_items` | Critical | Critical |

---

## Section E: Audit of Existing Firestore Repositories

All 15 repositories located under `backend/repositories/firestore/` were individually view-audited:

```
backend/repositories/firestore/
├── auditLogsRepository.js
├── bookingHistoryRepository.js
├── bookingsRepository.js
├── cashLogsRepository.js
├── guestsRepository.js
├── inventoryCategoriesRepository.js
├── inventoryProductsRepository.js
├── invoicesRepository.js
├── ledgerRepository.js
├── paymentsRepository.js
├── reservationsRepository.js
├── roomTypesRepository.js
├── roomsRepository.js
├── staffRepository.js
└── systemSettingsRepository.js
```

### Audit Findings:

1. **CRUD Incompleteness**:
   - Every repository file contains **only 1 or 2 read functions** (e.g., `getAllRoomsFirestore()`, `getRoomByIdFirestore()`).
   - **Zero write functions** (`create`, `update`, `delete`, `upsert`) exist in any of the 15 repository files.

2. **Hard Dependency on Legacy MySQL IDs**:
   - All repositories attempt to format output IDs by checking `d.mysql_*_id` or parsing `Number(doc.id.replace('...', ''))`.
   - *Example from `roomsRepository.js`*:
     ```javascript
     id: d.mysql_room_id || Number(doc.id.replace('room_', ''))
     ```
   - When MySQL is removed and new documents are created with non-numeric deterministic IDs (e.g., UUIDs or strings), this code will fail or output `NaN`.

3. **Absence of Query Filtering, Pagination & Sorting**:
   - All read functions execute `.get()` on the entire collection without `where()`, `limit()`, `orderBy()`, or cursor pagination.
   - Calling `getAllBookingsFirestore()` on a production dataset will fetch every historical booking document into memory at once.

4. **Missing Transaction & Concurrency Support**:
   - None of the repositories accept a Firestore `Transaction` (`Transaction` object from `db.runTransaction()`) or `WriteBatch` parameter.

5. **Data Type & Date Normalization Gaps**:
   - Timestamps are stored inconsistently (ISO strings vs Firestore `Timestamp` objects vs legacy epoch numbers).

---

## Section F: Firestore Schema vs. MySQL Schema Gaps

### 1. Relational Joins vs. Firestore Document References & Subcollections

| MySQL Table | Relational Design in MySQL | Recommended Firestore Architecture |
|---|---|---|
| `ledger_items` | Relational table with `booking_id` foreign key | Subcollection: `/bookings/{booking_id}/ledger_items/{item_id}` |
| `payments` | Relational table with `booking_id` foreign key | Subcollection: `/bookings/{booking_id}/payments/{payment_id}` |
| `booking_history` | Relational audit table with `booking_id` foreign key | Subcollection: `/bookings/{booking_id}/history/{history_id}` |
| `checkout_snapshots` | Separate table linked by `booking_id` | Dedicated root collection `/checkout_snapshots/{booking_id}` (Server-only) |
| `roles` & `permissions` | Relational M:N join via `role_permissions` | Stored directly as Firebase Auth Custom Claims + `/roles/{role_name}` master document |

### 2. ID Strategy & Unique Constraints

- **Auto-Increment Removal**: Firestore does NOT support native auto-incrementing integer IDs.
- **Deterministic ID Conventions**:
  - `/rooms`: `room_101`, `room_102` (based on room number)
  - `/bookings`: `bkg_BKG-20260811-001` (based on unique booking reference)
  - `/reservations`: `res_RES-20260811-001`
  - `/guests`: `guest_{firebase_uid}`
  - `/staff`: `staff_{firebase_uid}`
  - `/invoices`: `inv_INV-20260811-001`
- **Application-Level Unique Constraints**:
  - Unique fields like `room.number`, `users.username`, `invoices.invoice_number`, `inventory_products.sku` must be validated transactionally inside Firestore transactions using deterministic doc IDs or unique index documents (e.g. `/unique_indexes/username_{name}`).

---

## Section G: Required Firestore Indexes

Firestore requires explicit composite indexes for compound queries (`where` + `where` or `where` + `orderBy`).

Required composite indexes to be added to `firestore.indexes.json`:

```json
{
  "indexes": [
    {
      "collectionGroup": "bookings",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "booking_status", "order": "ASCENDING" },
        { "fieldPath": "check_in_date", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "bookings",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "room_id", "order": "ASCENDING" },
        { "fieldPath": "booking_status", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "reservations",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "room_id", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "check_in_date", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "ledger_items",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "business_date", "order": "ASCENDING" },
        { "fieldPath": "created_at", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "cash_logs",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "user_id", "order": "ASCENDING" },
        { "fieldPath": "business_date", "order": "ASCENDING" }
      ]
    }
  ]
}
```

---

## Section H: Transaction & Concurrency Risk Analysis

In a PMS, data corruption or race conditions can result in financial loss or double-booked rooms.

### Critical Concurrency Scenarios & Firestore Transaction Designs:

1. **Simultaneous Walk-in Check-in for Same Room**:
   - **Risk**: Two receptionists check in two different guests to Room 101 at the same second.
   - **MySQL Current Logic**: `SELECT ... FOR UPDATE` on room row.
   - **Firestore Solution**: `db.runTransaction(async (t) => { ... })`. Read `/rooms/room_101`. Verify `status === 'vacant'` and `housekeeping_status === 'Clean'`. If valid, update room status to `occupied` and create `/bookings/bkg_...` in the same transaction. If room state changes during execution, Firestore automatically rejects/retries.

2. **Simultaneous Room Shift**:
   - **Risk**: Moving Guest A from Room 101 to Room 102 while Guest B is being assigned to Room 102.
   - **Firestore Solution**: Single transaction reading both target room document `/rooms/room_102`, source room document `/rooms/room_101`, and booking document `/bookings/bkg_...`. Update all three atomically.

3. **Night Audit / Day End Execution**:
   - **Risk**: Two admins click "Run Day End" simultaneously, resulting in double-posting daily room tariffs to folios and double-advancing the business date.
   - **Firestore Solution**: Read `/settings/system_date` inside transaction. Check `day_end_status !== 'IN_PROGRESS'`. Set `day_end_status = 'IN_PROGRESS'`. Process room tariffs via batched writes. Advance `current_date` by 1 day and set `day_end_status = 'IDLE'`.

4. **Inventory Stock Adjustment**:
   - **Risk**: Parallel orders deducting stock from product SKU `PROD-01` leading to negative inventory.
   - **Firestore Solution**: Transaction reading `/inventory_products/prod_...`, asserting `stock_quantity >= requested_qty`, and updating `stock_quantity` using `FieldValue.increment(-requested_qty)`.

---

## Section I: Audit of Firestore Security Rules (`firestore.rules`)

Inspection of `firestore.rules` revealed severe access control gaps:

### Missing Collections in Rules:
The following **14 collections have NO rules defined** and fall back to `allow read, write: if false;`, blocking all client SDK access:
1. `/cash_logs`
2. `/cash_submissions`
3. `/invoices`
4. `/booking_history`
5. `/audit_logs`
6. `/system_settings`
7. `/inventory_categories`
8. `/inventory_products`
9. `/room_types`
10. `/staff`
11. `/razorpay_transactions`
12. `/housekeeping`
13. `/maintenance`
14. `/feedback`

### Role Hierarchy Gaps:
- `firestore.rules` currently checks `getUserRole()` against `'admin'`, `'staff'`, `'receptionist'`.
- Missing checks for canonical system roles: **`super_admin`**, **`kitchen`**, **`housekeeping`**.
- Housekeeping staff currently have write access to `/bookings` under the generic `isStaff()` rule, violating principle of least privilege.

---

## Section J: Firebase Authentication & Custom Claims Audit

### Current State:
- `backend/middleware/firebaseAuthMiddleware.js` verifies Firebase ID tokens if provided in `Authorization: Bearer <token>`.
- `authController.js` includes an idempotent helper `ensureGuestLazyAuthMigration()` that provisions Firebase Auth accounts for guests and attaches custom claims:
  ```json
  {
    "role": "guest",
    "user_type": "guest",
    "mysql_id": 14
  }
  ```

### Cutover Requirements:
1. **Remove `mysql_id` dependency**: Custom claims must reference `user_uid`, `staff_id`, or `guest_id` instead of numeric MySQL IDs.
2. **Staff Provisioning**: Provision Firebase Auth accounts for all staff members (Super Admin, Admin, Receptionist, Chef, Cleaner) with claims matching their canonical roles (`super_admin`, `admin`, `receptionist`, `kitchen`, `housekeeper`).
3. **Full Deprecation of HMAC-SHA256 JWTs**: Deprecate custom token generation in `authController.js` (`generateToken()`).

---

## Section K: Client Application Audit (Frontend, Guest-Web, Electron)

### 1. Primary Admin React UI (`src/`):
- `AdminAuthContext.jsx` currently stores legacy backend JWTs (`adminToken`) in `localStorage`.
- API request headers attach `Authorization: Bearer <adminToken>`.
- **Cutover Task**: Update `AdminAuthContext.jsx` to log in using Firebase Auth SDK (`signInWithEmailAndPassword`), retrieve Firebase ID Token via `user.getIdToken()`, and attach Firebase ID Token to all HTTP requests.

### 2. Guest Web Application (`guest-web/`):
- `guest-web/src/config/firebaseClient.js` exists but is **not imported anywhere in the React app**.
- `guest-web/src/services/api.js` relies on `localStorage.getItem('guestToken')`.
- **Cutover Task**: Initialize Firebase Client SDK in `guest-web/src/main.jsx`, wire Firebase Auth login/signup, and attach Firebase ID Token to `apiFetch()`.

### 3. Electron Wrapper (`electron/`):
- `electron/backend-launcher.js` spawns `backend/server.js` on `http://localhost:5000`.
- **Cutover Task**: Ensure Node child process receives required environment variables (`FIREBASE_SERVICE_ACCOUNT_KEY` or process env vars) to initialize Firebase Admin SDK without requiring local MySQL configuration.

---

## Section L: Reports & Analytics Migration Strategy

### Problem:
`reportsController.js` executes complex SQL aggregation queries (`SUM`, `COUNT`, `AVG`, `GROUP BY` over date ranges) to generate:
- Manager Flash Reports
- ADR (Average Daily Rate) & RevPAR
- Occupancy Rate Percentages
- Daily Revenue & Ledger Totals

Executing raw `.get()` queries over all `/bookings` or `/ledger_items` documents in Firestore on every report load will cause excessive read costs and high latency.

### Recommended Firestore Analytics Architecture:
1. **Precomputed Daily Summary Documents**:
   - Maintain a root collection `/analytics/daily_{YYYY-MM-DD}`.
   - During Day End / Night Audit execution, write precomputed daily metrics:
     ```json
     {
       "date": "2026-08-11",
       "total_rooms": 50,
       "occupied_rooms": 35,
       "occupancy_rate": 70.0,
       "total_revenue": 87500.00,
       "adr": 2500.00,
       "revpar": 1750.00,
       "checkins_count": 12,
       "checkouts_count": 8
     }
     ```
2. **Instant Report Generation**:
   - `reportsController.js` reads precomputed daily documents for date ranges (e.g. 30 documents for a monthly report) instead of scanning thousands of individual transaction documents.

---

## Section M: Recommended Phased Migration Strategy

```
Phase 1: Architecture Audit & Strategy (COMPLETED)
Phase 2: Complete Firestore Repositories (Full CRUD + Transactions)
Phase 3: Real-Time Dual-Write Sync Bridge Engine
Phase 4: Read-Path Cutover (Controllers read from Firestore)
Phase 5: Auth & Security Rules Hardening (Pure Firebase Auth)
Phase 6: Write-Path Cutover (Controllers write to Firestore)
Phase 7: Independent Validation & Final MySQL Removal
```

---

## Section N: MySQL Removal Prerequisites Checklist

Before MySQL can safely be removed from production, ALL of the following criteria must be satisfied and verified:

- [ ] All 14 controllers refactored to use Firestore repositories instead of `pool.query()`.
- [ ] All 8 services refactored to use Firestore transactions (`db.runTransaction()`).
- [ ] All 15 Firestore repositories implemented with full CRUD, filtering, pagination, and error handling.
- [ ] All 30 MySQL table schemas mapped and populated in Firestore.
- [ ] Security rules in `firestore.rules` updated for all collections and validated.
- [ ] Real-time client listeners (`onSnapshot`) wired in `src/` and `guest-web/`.
- [ ] Firebase Auth custom claims configured for 100% of staff and guest accounts.
- [ ] Precomputed analytics documents operational for Manager & Revenue reports.
- [ ] 100% of unit & end-to-end integration tests passing against Firestore.

---

## Section O: Rollback Strategy

Until Phase 7 is reached and verified:
1. **MySQL remains running in dual-stack mode**.
2. **Dual-write sync engine** ensures all Firestore writes are mirrored back to MySQL (or vice-versa).
3. If any critical issue is detected in Firestore, a single feature flag toggle (`ENABLE_FIRESTORE_OPERATIONAL=false`) immediately routes all HTTP controller traffic back to MySQL without downtime or data loss.

---

## FIREBASE CUTOVER READINESS: NOT READY

### Numerical Score: **28 / 100**

- **Architecture Audit & Documentation**: 100/100
- **Firestore Schema Baseline Data**: 60/100
- **Firestore Repositories Operational Code**: 15/100
- **HTTP Controller & Service Decoupling**: 0/100
- **Firestore Transactions & Concurrency Lock Replacement**: 0/100
- **Security Rules & Client Integration**: 20/100

*Conclusion: Complete Phase 2 (Firestore Repository Layer Rewrite) and Phase 3 (Dual-Write Bridge) before attempting write-path cutover.*
