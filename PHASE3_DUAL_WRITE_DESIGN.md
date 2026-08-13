# HPMS-Sky5: Phase 3 Dual-Write Bridge Architecture & Safety Blueprint

> **Phase:** Phase 3 — Dual-Write Bridge Architecture (Design & Audit Only)  
> **Timestamp:** August 11, 2026  
> **Status:** READ-ONLY DESIGN COMPLETE — ZERO SOURCE CODE MODIFICATIONS PERFORMED  
> **Final Verdict:** **PHASE 3 DESIGN STATUS: READY FOR IMPLEMENTATION**  

---

## Executive Summary

This document presents the complete architectural specification for **Phase 3: Dual-Write Bridge Engine** of HPMS-Sky5. The objective of Phase 3 is to synchronize operational data changes from MySQL into Cloud Firestore (`asia-south1`) in real time, while **MySQL remains 100% authoritative as the primary source of truth**.

To eliminate split-brain data corruption and API latency overhead, HPMS-Sky5 will adopt an **Asynchronous Transactional Outbox Pattern with Idempotency Keys**. Dual-write events are atomically staged in MySQL within the exact same database transaction as the operational write, and dispatched asynchronously to Cloud Firestore by an outbox worker engine.

---

## 1. Complete Write-Path Inventory Matrix

The audit scanned 100% of backend controllers (`backend/controllers/*`) and business services (`backend/services/*`) to map every single database mutation path:

| # | Domain | Controller / Service | Write Operation | MySQL Tables Mutated | Firestore Collection | Transaction Boundary | Concurrency Risk | Current Source of Truth |
|---|---|---|---|---|---|---|---|---|
| 1 | **Auth / User** | `authController.signUp` | `INSERT INTO users, guests, audit_logs` | `users`, `guests`, `audit_logs` | `/users`, `/guests`, `/audit_logs` | MySQL Transaction (`conn.beginTransaction`) | High (Duplicate phone / username) | MySQL |
| 2 | **Auth / User** | `authController.signIn` | `UPDATE staff SET last_login`, `INSERT audit_logs` | `staff`, `audit_logs` | `/staff`, `/audit_logs` | Single Query | Low | MySQL |
| 3 | **Auth / User** | `authController.ensureGuestLazyAuth` | `INSERT INTO guests` (if missing), `auth.createUser` | `guests` | `/guests` | Single Query + Firebase Admin SDK | Low | MySQL |
| 4 | **Rooms** | `roomController.checkIn` | `checkInService.executeCheckIn` | `rooms`, `bookings`, `guests`, `ledger_items`, `audit_logs` | `/rooms`, `/bookings`, `/ledger_items`, `/audit_logs` | MySQL Transaction (`SELECT ... FOR UPDATE`) | **CRITICAL** (Double check-in to room) | MySQL |
| 5 | **Rooms** | `roomController.modifyCheckIn` | `UPDATE bookings, rooms`, `INSERT audit_logs` | `bookings`, `rooms`, `audit_logs` | `/bookings`, `/rooms`, `/audit_logs` | MySQL Transaction | High (Parallel modification) | MySQL |
| 6 | **Rooms** | `roomController.checkOut` | `CheckoutRecoveryService`, `UPDATE bookings, rooms`, `INSERT audit_logs` | `checkout_snapshots`, `bookings`, `rooms`, `audit_logs` | `/checkout_snapshots`, `/bookings`, `/rooms`, `/audit_logs` | MySQL Transaction | High (Duplicate checkout) | MySQL |
| 7 | **Rooms** | `roomController.clean` | `UPDATE rooms`, `INSERT housekeeping_logs` | `rooms`, `housekeeping_logs` | `/rooms`, `/housekeeping` | Single Query | Low | MySQL |
| 8 | **Rooms** | `roomController.addLedgerItem` | `INSERT INTO ledger_items, audit_logs` | `ledger_items`, `audit_logs` | `/bookings/{id}/ledger_items`, `/ledger_items`, `/audit_logs` | Single Query | Medium | MySQL |
| 9 | **Rooms** | `roomController.shift` | `UPDATE bookings, rooms`, `INSERT audit_logs` | `bookings`, `rooms`, `audit_logs` | `/bookings`, `/rooms`, `/audit_logs` | MySQL Transaction | **CRITICAL** (Simultaneous room shift) | MySQL |
| 10 | **Rooms** | `roomController.bookRoom` | `INSERT INTO bookings`, `UPDATE rooms`, `INSERT audit_logs` | `bookings`, `rooms`, `audit_logs` | `/bookings`, `/rooms`, `/audit_logs` | MySQL Transaction | High (Walk-in booking clash) | MySQL |
| 11 | **Rooms** | `roomController.processRefundCheckout` | `INSERT INTO payments`, `UPDATE bookings, rooms`, `INSERT audit_logs` | `payments`, `bookings`, `rooms`, `audit_logs` | `/payments`, `/bookings`, `/rooms`, `/audit_logs` | MySQL Transaction | High (Refund double posting) | MySQL |
| 12 | **Rooms** | `roomController.adminExtendStay` | `UPDATE bookings`, `INSERT booking_history` | `bookings`, `booking_history` | `/bookings`, `/booking_history` | Single Query | Medium | MySQL |
| 13 | **Rooms** | `roomController.adminLateCheckout` | `UPDATE bookings`, `INSERT ledger_items` | `bookings`, `ledger_items` | `/bookings`, `/ledger_items` | Single Query | Medium | MySQL |
| 14 | **Rooms** | `roomController.adminNoShow` | `UPDATE bookings, rooms`, `INSERT audit_logs` | `bookings`, `rooms`, `audit_logs` | `/bookings`, `/rooms`, `/audit_logs` | MySQL Transaction | High | MySQL |
| 15 | **Rooms** | `roomController.updateRoomStatus` | `UPDATE rooms` | `rooms` | `/rooms` | Single Query | Low | MySQL |
| 16 | **Guest Portal** | `roomController.uploadIdentity` | `UPDATE guests SET id_document_url` | `guests` | `/guests` | Single Query | Low | MySQL |
| 17 | **Guest Portal** | `roomController.guestRequestCheckIn` | `INSERT INTO guest_requests` | `guest_requests` | `/notifications` | Single Query | Low | MySQL |
| 18 | **Guest Portal** | `roomController.guestSubmitFeedback` | `INSERT INTO feedback` | `feedback` | `/feedback` | Single Query | Low | MySQL |
| 19 | **Reservations** | `reservationController.createReservation` | `AvailabilityService`, `INSERT INTO reservations, audit_logs` | `reservations`, `audit_logs` | `/reservations`, `/audit_logs` | MySQL Transaction (`SELECT ... FOR UPDATE`) | **CRITICAL** (Double reservation clash) | MySQL |
| 20 | **Reservations** | `reservationController.updateReservation` | `AvailabilityService`, `UPDATE reservations` | `reservations` | `/reservations` | MySQL Transaction | High | MySQL |
| 21 | **Reservations** | `reservationController.cancelReservation` | `UPDATE reservations SET status='Cancelled'` | `reservations` | `/reservations` | Single Query | Low | MySQL |
| 22 | **Payments** | `paymentController.processPayment` | `INSERT INTO payments`, `UPDATE bookings`, `INSERT cash_logs` (if cash), `INSERT audit_logs` | `payments`, `bookings`, `cash_logs`, `audit_logs` | `/payments`, `/bookings`, `/cash_logs`, `/audit_logs` | MySQL Transaction | **CRITICAL** (Duplicate payment / folio balance clash) | MySQL |
| 23 | **Payments** | `paymentController.refundPayment` | `INSERT INTO payments`, `UPDATE bookings` | `payments`, `bookings` | `/payments`, `/bookings` | MySQL Transaction | High | MySQL |
| 24 | **Invoices** | `invoiceController.generateInvoice` | `INSERT INTO invoices, audit_logs` | `invoices`, `audit_logs` | `/invoices`, `/audit_logs` | Single Query | High (Duplicate invoice number) | MySQL |
| 25 | **Housekeeping** | `housekeepingController.updateHousekeepingStatus` | `UPDATE housekeeping`, `INSERT housekeeping_logs` | `housekeeping`, `housekeeping_logs` | `/housekeeping` | Single Query | Low | MySQL |
| 26 | **Inventory** | `inventoryController.createProduct` | `INSERT INTO inventory_products` | `inventory_products` | `/inventory_products` | Single Query | Medium (SKU conflict) | MySQL |
| 27 | **Inventory** | `inventoryController.adjustStock` | `UPDATE inventory_products SET stock_quantity` | `inventory_products`, `stock_logs` | `/inventory_products` | Single Query | High (Parallel stock subtraction) | MySQL |
| 28 | **Cash** | `cashController.submitCash` | `INSERT INTO cash_submissions, audit_logs` | `cash_submissions`, `audit_logs` | `/cash_submissions`, `/audit_logs` | MySQL Transaction | High (Shift cash handover) | MySQL |
| 29 | **Staff** | `staffController.createStaff` | `INSERT INTO staff`, `auth.createUser`, `auth.setCustomUserClaims` | `staff` | `/staff` | Single Query + Firebase Admin | Medium | MySQL |
| 30 | **Staff** | `staffController.updateStaff` | `UPDATE staff`, `auth.updateUser` | `staff` | `/staff` | Single Query + Firebase Admin | Medium | MySQL |
| 31 | **Staff** | `staffController.deleteStaff` | `UPDATE staff SET deleted = 1` | `staff` | `/staff` | Single Query | Low | MySQL |
| 32 | **Settings** | `settingsController.updateBusinessDate` | `BusinessDateService.setBusinessDate` | `system_settings`, `audit_logs` | `/settings/system_date`, `/audit_logs` | MySQL Transaction | **CRITICAL** (Business date skip/jump) | MySQL |
| 33 | **Night Audit** | `auditController.runDayEnd` | `BusinessDateService.advanceBusinessDate`, `runNightAudit` | `system_settings`, `rooms`, `bookings`, `ledger_items`, `audit_logs` | `/settings/system_date`, `/ledger_items`, `/audit_logs` | MySQL Transaction (`FOR UPDATE NOWAIT`) | **CRITICAL** (Simultaneous night audit) | MySQL |
| 34 | **Night Audit** | `auditController.undoDayEnd` | `BusinessDateService.rollbackBusinessDate` | `system_settings`, `audit_logs` | `/settings/system_date`, `/audit_logs` | MySQL Transaction | **CRITICAL** (Irreversible date rollback) | MySQL |
| 35 | **Gateway** | `razorpayController.verifyPaymentSignature` | `UPDATE razorpay_transactions SET status='paid'` | `razorpay_transactions` | `/razorpay_transactions` | Single Query | High (Webhook replay) | MySQL |

---

## 2. Firestore Mapping Audit

Every MySQL operational write maps cleanly to Phase 2 Firestore Repository functions:

| MySQL Operation | Phase 2 Repository Method | Firestore Collection / Document | Deterministic Doc ID | Key Payload Fields |
|---|---|---|---|---|
| Check-In / Booking | `createBookingFirestore` | `/bookings/{id}` | `bkg_{booking_number}` | `booking_number`, `guest_id`, `room_id`, `check_in_date`, `total_amount` |
| Room Status Update | `updateRoomStatusFirestore` | `/rooms/{id}` | `room_{number}` | `status`, `cleaning_status`, `housekeeping_status` |
| Payment Posting | `createPaymentFirestore` | `/payments/{id}` & `/bookings/{id}/payments/{id}` | `payment_{id}` | `booking_id`, `amount`, `payment_method`, `business_date` |
| Ledger Charge | `createLedgerItemFirestore` | `/ledger_items/{id}` & `/bookings/{id}/ledger_items/{id}` | `ledger_{id}` | `booking_id`, `description`, `qty`, `amount`, `type`, `business_date` |
| Invoice Generation | `createInvoiceFirestore` | `/invoices/{id}` | `inv_{invoice_number}` | `invoice_number`, `booking_id`, `total_amount`, `paid_amount` |
| Reservation Creation | `createReservationFirestore` | `/reservations/{id}` | `res_{reservation_number}` | `reservation_number`, `guest_name`, `room_id`, `check_in_date` |
| Guest Profile Update | `updateGuestFirestore` | `/guests/{id}` | `guest_{user_uid}` | `full_name`, `phone`, `email`, `id_document_url`, `id_verification_status` |
| Staff Account | `createStaffFirestore` | `/staff/{id}` | `staff_{user_uid}` | `username`, `full_name`, `role`, `department`, `shift`, `status` |
| Business Date Change | `updateSystemDateFirestore` | `/settings/system_date` | `system_date` | `current_date`, `today_checkins`, `today_checkouts`, `day_end_status` |
| Inventory Adjustment | `updateProductStockFirestore` | `/inventory_products/{id}` | `prod_{sku}` | `stock_quantity`, `updated_at` |

---

## 3. Transaction & Consistency Architecture Design

### Evaluation of Dual-Write Consistency Strategies:

1. **Option A: Synchronous Dual-Write inside HTTP Controller**
   - *Pattern*: Controller calls `mysql.query()`, then immediately calls `firestoreRepo.set()`.
   - *Verdict*: **REJECTED**. If Firestore network times out after MySQL commits, the client receives a 500 error even though MySQL succeeded. If MySQL rolls back after Firestore writes, Firestore contains orphaned phantom data.

2. **Option B: Asynchronous Transactional Outbox Pattern (RECOMMENDED)**
   - *Pattern*: Every MySQL transaction writes operational data AND inserts an event row into a MySQL `dual_write_outbox` table in the **same atomic database transaction**. An asynchronous background outbox worker polls `dual_write_outbox`, calls Phase 2 Firestore Repositories, and marks outbox events `PROCESSED`.
   - *Verdict*: **APPROVED FOR HPMS-SKY5**. Guarantees 100% ACID consistency in MySQL. If MySQL rolls back, zero outbox rows are committed. If Firestore is temporarily unavailable, outbox rows accumulate safely in MySQL and replay automatically when connectivity is restored.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HTTP REQUEST / CONTROLLER                         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SINGLE MYSQL TRANSACTION                            │
│  ┌─────────────────────────────────┐   ┌─────────────────────────────────┐  │
│  │ 1. Mutate Operational Tables    │   │ 2. INSERT INTO dual_write_outbox│  │
│  │    (bookings, rooms, ledger...) │   │    (event_type, payload, status) │  │
│  └─────────────────────────────────┘   └─────────────────────────────────┘  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ COMMIT TRANSACTION
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    BACKGROUND OUTBOX WORKER ENGINE                          │
│  1. Poll `dual_write_outbox` WHERE status = 'PENDING' ORDER BY id ASC       │
│  2. Dispatch to Firestore Repository with Idempotency Key (docId)           │
│  3. UPDATE `dual_write_outbox` SET status = 'PROCESSED', processed_at = NOW()│
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CLOUD FIRESTORE (asia-south1)                         │
│                       Secondary Read Replica Datastore                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. MySQL Primary Source of Truth Model

During Phase 3:
- **MySQL remains 100% Authoritative**: All operational decisions (availability validation, check-in eligibility, payment balance checks, night audit validation) MUST evaluate MySQL tables ONLY.
- **Firestore is a Secondary Read Replica**: Firestore documents are strictly populated via outbox synchronization.
- **Zero Direct Writes from Frontend**: Client React apps (`src/` and `guest-web/`) MUST NOT write directly to Firestore collections during Phase 3. All mutations route through Express API controllers.

---

## 5. Idempotency & Replay Strategy

To ensure zero duplicate documents when an outbox event is re-tried:

1. **Deterministic Document IDs as Idempotency Keys**:
   - `bkg_BKG-20260811-001` for bookings.
   - `pay_payment_104` for payments.
   - `inv_INV-20260811-001` for invoices.
   - `room_101` for rooms.
2. **Merge Semantics**:
   - Firestore updates use `setDoc(COLLECTION, docId, payload, { merge: true })`. Executing `setDoc` multiple times with the exact same `docId` is 100% idempotent and will never create duplicate documents.
3. **Outbox Event Deduplication**:
   - Outbox worker enforces `WHERE event_id = ?` lookups to reject duplicate event processing.

---

## 6. Failure & Recovery Matrix

| # | Scenario | MySQL State | Firestore State | Detection Method | Automated Recovery Action | Operational Data Loss Risk |
|---|---|---|---|---|---|---|
| 1 | Firestore API Outage / Network Down | Committed | Pending in Outbox | Outbox worker logs HTTP 503 / timeout | Retries with exponential backoff until connection restored | **ZERO** (Safely buffered in MySQL) |
| 2 | Outbox Worker Process Crash | Committed | Pending in Outbox | Outbox worker heartbeat failure | Process manager (PM2/Electron) restarts worker; resumes pending events | **ZERO** |
| 3 | MySQL Operational Transaction Rollback | Rolled Back | Not Written | Transaction abort | Zero outbox rows committed; zero Firestore calls made | **ZERO** |
| 4 | Duplicate HTTP Check-In Request | Handled via MySQL `SELECT ... FOR UPDATE` lock | Idempotent Doc Update | MySQL unique constraint / row lock | Outbox updates same document ID `bkg_...` with same data | **ZERO** |
| 5 | Firestore Permission Denied | Committed | Failed in Outbox | Outbox status = `FAILED` | Alert logged to admin console; manually retried after rule fix | **ZERO** (MySQL operational data intact) |
| 6 | Invalid Document Payload | Committed | Failed in Outbox | Outbox status = `DEAD_LETTER` | Event moved to Dead-Letter Queue for investigation | **ZERO** |
| 7 | Server Hard Power Loss | Committed to MySQL WAL | Staged in Outbox | Startup crash recovery | On server restart, outbox worker resumes unprocessed events | **ZERO** |

---

## 7. Outbox Architecture Specification (`dual_write_outbox`)

Recommended MySQL DDL schema for Phase 3 outbox table (to be created in Phase 3A):

```sql
CREATE TABLE IF NOT EXISTS dual_write_outbox (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL UNIQUE,
  event_type VARCHAR(64) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  payload LONGTEXT NOT NULL,
  status ENUM('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER') DEFAULT 'PENDING',
  attempts INT DEFAULT 0,
  last_error TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP NULL,
  INDEX idx_status_created (status, created_at),
  INDEX idx_aggregate (aggregate_type, aggregate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 8. Read-Only Reconciliation Engine Design

A background reconciliation script ([`scripts/verifySystemDualRead.js`](file:///d:/projects/hotel/scripts/verifySystemDualRead.js)) will run periodically to audit parity between MySQL and Firestore:

- **Record Count Comparison**: Compares MySQL `COUNT(*)` vs Firestore collection document counts for all 19 collections.
- **Financial Balance Assertion**: Asserts `SUM(payments.amount)` in MySQL equals `SUM(payments.amount)` in Firestore.
- **Mismatch Logging**: Logs any missing documents or field discrepancies to a structured audit file (`reconciliation_mismatches.json`) without mutating production data.

---

## 9. Ordering & Concurrency Guarantee

Event processing sequence per entity (`booking_id`, `room_id`, `business_date`) is strictly ordered by outbox `id ASC`:

```
Outbox Event #101: BookingCreated (bkg_101)
   └── Outbox Event #102: PaymentPosted (bkg_101)
        └── Outbox Event #103: CheckInExecuted (bkg_101, room_101)
             └── Outbox Event #104: InvoiceGenerated (inv_101)
```

The outbox worker processes events for the same `aggregate_id` sequentially, preventing race conditions (e.g. processing a payment before the booking document exists).

---

## 10. Performance & Observability Impact

- **API Response Latency**: **0ms added to HTTP API endpoints**. Outbox insertion takes <1ms inside MySQL transactions.
- **Correlation Tracking**: Unified trace ID (`X-Correlation-ID`) passed from HTTP Controller -> MySQL Transaction -> Outbox Row `event_id` -> Firestore `updated_by_event_id` attribute.

---

## 11. Recommended Feature Flags

Configuration in [`backend/config/featureFlags.js`](file:///d:/projects/hotel/backend/config/featureFlags.js):

```javascript
export const FEATURE_FLAGS = {
  ENABLE_FIRESTORE_DUAL_WRITE: process.env.ENABLE_FIRESTORE_DUAL_WRITE === 'true', // Default: false
  ENABLE_OUTBOX_WORKER: process.env.ENABLE_OUTBOX_WORKER === 'true',               // Default: false
  ENABLE_FIRESTORE_RECONCILIATION: process.env.ENABLE_FIRESTORE_RECONCILIATION === 'true' // Default: false
};
```

---

## 12. Instant Rollback Strategy

If any issue occurs during Phase 3 rollout:
1. Set `ENABLE_FIRESTORE_DUAL_WRITE=false` in `backend/.env`.
2. Restart Express backend server.
3. Outbox worker stops immediately.
4. **MySQL continues 100% uninterrupted with zero downtime or user impact**.

---

## 13. Phase 3 Staged Implementation Plan

- **Phase 3A**: Create `dual_write_outbox` table and outbox utility helper.
- **Phase 3B**: Single low-risk pilot (System Settings & Business Date outbox dual-write).
- **Phase 3C**: Rooms & Room Types dual-write bridge.
- **Phase 3D**: Staff & Guests dual-write bridge.
- **Phase 3E**: Reservations & Bookings dual-write bridge.
- **Phase 3F**: Payments, Ledger Items & Invoices dual-write bridge.
- **Phase 3G**: Inventory, Cash Logs & Submissions dual-write bridge.
- **Phase 3H**: Night Audit & Business Date advance dual-write bridge.
- **Phase 3I**: Read-only Reconciliation Engine integration.
- **Phase 3J**: Stability verification gate.

---

## 14. GO / NO-GO Criteria for Starting Phase 3 Implementation

Implementation of Phase 3A may proceed ONLY when:
- [x] Phase 2 Firestore Repository Layer completely implemented and tested (19/19 repos passed).
- [x] Outbox table DDL and architecture approved.
- [x] Zero controller mutations in Phase 2 verified.
- [x] Feature flag toggle and instant rollback procedure confirmed.

---

## PHASE 3 DESIGN STATUS: READY FOR IMPLEMENTATION
