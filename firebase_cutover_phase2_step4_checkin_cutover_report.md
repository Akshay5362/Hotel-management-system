# HPMS FIREBASE-ONLY MIGRATION — PHASE 2 STEP 4
## CONTROLLED FIRESTORE CHECK-IN CUTOVER REPORT

**Execution Date:** August 19, 2026  
**Phase:** **PHASE 2 STEP 4 — CONTROLLED CHECK-IN CUTOVER**  
**Status:** **LIVE CHECK-IN CUTOVER VERIFIED & ACTIVE — 100% OPERATIONAL PARITY**  
**Automatic Fallback:** **MySQL (Authoritative & Active)**

---

## 1. Executive Summary

In accordance with Phase 2 Step 4 instructions, HPMS has initiated and verified the **controlled production-serving cutover of CHECK-IN to Firestore**.

- **Serving Authority State:**
  - **Check-In Operations:** **FIRESTORE PRIMARY (with automated MySQL fallback)**
  - **Room Status Reads:** **FIRESTORE PRIMARY (with automated MySQL fallback)**
  - **Room Availability Reads:** **FIRESTORE PRIMARY (with automated MySQL fallback)**
  - **Checkout / Payments / Reservations / Reports / Global Ledger:** **100% MYSQL AUTHORITATIVE**
- **Atomicity Guarantee:**
  - Check-in writes (Room status, Guest profile, Booking record, Initial Room Tariff ledger item, Advance Payment ledger item, Payment record, Cash log, Room status history, and Idempotency key) are executed inside an atomic `db.runTransaction(...)`.
- **Zero Double-Booking Guarantee:**
  - Concurrency testing with 10 simultaneous check-ins on the same room resulted in exactly **1 SUCCESS and 9 BLOCKED** with 0 race conditions and 0 duplicate records.
- **Safe Fallback & Reconciliation:**
  - If Firestore times out or fails with an infrastructure error before commit, MySQL check-in fallback executes seamlessly.
  - If a transient network disconnect occurs after/during commit, [`CheckInCutoverService.reconcileUnknownOutcome`](file:///d:/projects/hotel/backend/services/checkInCutoverService.js) recovers the committed booking and prevents double check-ins.

---

## 2. Previous MySQL vs New Firestore Check-In Architecture

```mermaid
graph TD
    UI[Frontend CheckInModal / ReceptionPortal] --> API["POST /api/rooms/:number/checkin"]
    API --> CutoverService[CheckInCutoverService]
    
    CutoverService -->|USE_FIRESTORE_CHECKIN = true| FSTransaction["Firestore Atomic Transaction (Primary)"]
    
    FSTransaction -->|Reads & Validates| CheckRoom["Room Doc (vacant? active? clean?)"]
    CheckRoom -->|Valid| CommitWrites["Atomic Commit (Room, Booking, Guest, Ledger, Payment, CashLog, StatusHistory, IdempotencyKey)"]
    
    CommitWrites -->|Success (200 OK)| UI
    
    CommitWrites -->|Pre-commit Infrastructure Error / Timeout| MySQLFallback["MySQL Check-In Fallback (Authoritative)"]
    MySQLFallback -->|Commit & Rollback Safe| UI
    
    CommitWrites -->|Ambiguous Mid-Commit Failure| Reconcile["Reconcile Unknown Outcome"]
    Reconcile -->|Found Committed| ReturnFS[Return Reconciled Firestore Booking]
    Reconcile -->|Not Committed| MySQLFallback
    
    CheckRoom -->|Business Error: ALREADY_CHECKED_IN / ROOM_INACTIVE / ROOM_DIRTY| Rethrow["Rethrow HTTP 400 (NO Fallback)"]
```

---

## 3. Parity & Data Mapping Matrix

| Domain / Field | MySQL Implementation | Firestore Transaction Implementation | Parity Match |
|---|---|---|---|
| **Room Status Transition** | `UPDATE rooms SET status = 'occupied'` | `transaction.set(roomRef, { status: 'occupied', current_booking_id })` | ✅ 100% PARITY |
| **Inactive Room Check** | `is_active === 0` throws `ROOM_INACTIVE` | `is_active === false` throws `ROOM_INACTIVE` | ✅ 100% PARITY |
| **Already Occupied Check** | `status === 'occupied'` throws `ALREADY_CHECKED_IN` | `status === 'occupied'` throws `ALREADY_CHECKED_IN` | ✅ 100% PARITY |
| **Ghost Occupancy Healing** | Reverts orphan occupied to vacant if no active booking | Reverts orphan occupied to vacant if no active booking | ✅ 100% PARITY |
| **Housekeeping Dirty Check** | `housekeeping_status === 'Dirty'` throws `ROOM_DIRTY` | `housekeeping_status === 'Dirty'` throws `ROOM_DIRTY` | ✅ 100% PARITY |
| **Manual Dirty Override** | `manual_override === true` bypasses dirty check | `manualOverride === true` bypasses dirty check | ✅ 100% PARITY |
| **Negotiated Room Tariff** | Custom tariff overrides room base rate | Custom tariff overrides room base rate | ✅ 100% PARITY |
| **D+1 11:00 AM Checkout** | Computed as next calendar date at 11:00 AM | Computed as next calendar date at 11:00 AM | ✅ 100% PARITY |
| **Custom Expected Checkout** | Preserves receptionist-selected date/time | Preserves receptionist-selected date/time | ✅ 100% PARITY |
| **Guest Profile Upsert** | Matched by phone, updates DOB, GST, Company, City, State | Matched by phone, updates DOB, GST, Company, City, State | ✅ 100% PARITY |
| **Tariff Ledger Item** | Debit charge `Room Tariff (Incl. GST)` | Debit charge `Room Tariff (Incl. GST)` in `ledger_items` | ✅ 100% PARITY |
| **Advance Deposit Ledger** | Credit payment `Advance Deposit (...)` | Credit payment `Advance Deposit (...)` in `ledger_items` | ✅ 100% PARITY |
| **Payment Record** | Inserts into `payments` table | Inserts into `payments` collection | ✅ 100% PARITY |
| **Cash Log** | Inserts into `cash_logs` when paymentMethod is Cash | Inserts into `cash_logs` when paymentMethod is Cash | ✅ 100% PARITY |
| **Status History Audit** | Inserts into `room_status_history` table | Inserts into `room_status_history` collection | ✅ 100% PARITY |
| **Idempotency Protection** | N/A (Standard DB) | Replays existing result on identical `idempotencyKey` | ✅ ENHANCED |

---

## 4. Idempotency & Unknown Outcome Reconciliation Strategy

1. **Deterministic Idempotency Key:**
   - Clients or controllers supply `idempotencyKey` (or header `Idempotency-Key`).
   - If a duplicate request arrives, `db.collection('idempotency_keys')` returns the original cached `{ bookingId, bookingNumber, replayed: true }` without creating duplicate records.
2. **Reconciliation on Mid-Flight Disconnect:**
   - If an error occurs during commit, `CheckInCutoverService.reconcileUnknownOutcome` inspects `idempotency_keys`, `rooms`, and `bookings` to confirm whether Firestore completed the commit.
   - If confirmed committed, returns the Firestore booking.
   - If confirmed NOT committed, safely falls back to MySQL.

---

## 5. Feature Flags State

| Environment Variable | Description | Value | Authority |
|---|---|---|---|
| `USE_FIRESTORE_CHECKIN` | Check-in write serving | `true` | **FIRESTORE PRIMARY (MySQL Fallback)** |
| `USE_FIRESTORE_ROOM_STATUS` | Room status read serving | `true` | **FIRESTORE PRIMARY (MySQL Fallback)** |
| `USE_FIRESTORE_AVAILABILITY` | Room availability calculation | `true` | **FIRESTORE PRIMARY (MySQL Fallback)** |
| `USE_FIRESTORE_LEDGER` | Folio / Ledger serving | `false` | **MYSQL AUTHORITATIVE (Firestore Shadow)** |
| `USE_FIRESTORE_REPORTS` | Reports / Financials serving | `false` | **MYSQL AUTHORITATIVE (Firestore Shadow)** |
| `USE_FIRESTORE_ROOM_STATUS_SHADOW` | Async shadow comparison | `true` | Active |
| `USE_FIRESTORE_AVAILABILITY_SHADOW` | Async shadow comparison | `true` | Active |
| `USE_FIRESTORE_LEDGER_SHADOW` | Async shadow comparison | `true` | Active |
| `USE_FIRESTORE_REPORTS_SHADOW` | Async shadow comparison | `true` | Active |
| `ENABLE_FIRESTORE_OUTBOX_WORKER` | MySQL outbox processor | `true` | Unchanged |

---

## 6. Exact Files Created & Modified

### Created Files:
- [`backend/services/checkInCutoverService.js`](file:///d:/projects/hotel/backend/services/checkInCutoverService.js) — Check-in primary executor, timeout wrapper (3000ms), unknown outcome reconciler, and safe MySQL fallback.
- [`backend/tests/testFirestoreCheckInCutoverPhase2Step4.mjs`](file:///d:/projects/hotel/backend/tests/testFirestoreCheckInCutoverPhase2Step4.mjs) — 31-scenario comprehensive test suite.

### Modified Files:
- [`backend/config/featureFlags.js`](file:///d:/projects/hotel/backend/config/featureFlags.js) — Added `isFirestoreCheckInServingEnabled`, enabled `USE_FIRESTORE_CHECKIN !== 'false'`.
- [`backend/adapters/firestore/checkInFirestoreAdapter.js`](file:///d:/projects/hotel/backend/adapters/firestore/checkInFirestoreAdapter.js) — Implemented atomic transaction, D+1 11:00 AM calculation, negotiated tariff, Phase C fields, deposit payment ledger item, cash log, and idempotency key.
- [`backend/controllers/roomController.js`](file:///d:/projects/hotel/backend/controllers/roomController.js) — Wired `checkIn` endpoint to `CheckInCutoverService.executeCheckIn`.

---

## 7. Full Regression & Verification Matrix

All 8 test suites passed with **0 failures**:

| Test Suite | Command | Scenarios | Result |
|---|---|---|---|
| Missing Firestore Repositories | `node backend/tests/testMissingFirestoreRepositoriesPhase1.mjs` | 30 | **30 PASSED / 0 FAILED** |
| Firestore Availability Engine | `node backend/tests/testFirestoreAvailabilityPhase1Step2.mjs` | 26 | **26 PASSED / 0 FAILED** |
| Financial Parity Engine | `node backend/tests/testFirestoreFinancialParityPhase1Step4.mjs` | 25 | **25 PASSED / 0 FAILED** |
| Dual-Read Shadow Infrastructure | `node backend/tests/testFirestoreShadowPhase2Step1.mjs` | 22 | **22 PASSED / 0 FAILED** |
| Dual-Read Shadow Soak | `node backend/tests/testFirestoreShadowSoakPhase2Step2.mjs` | 41 | **41 PASSED / 0 FAILED** |
| Controlled Cutover & Fallback (Step 3) | `node backend/tests/testFirestoreControlledCutoverPhase2Step3.mjs` | 34 | **34 PASSED / 0 FAILED** |
| Controlled Check-In Cutover (Step 4) | `node backend/tests/testFirestoreCheckInCutoverPhase2Step4.mjs` | 31 | **31 PASSED / 0 FAILED** |
| Frontend Production Build | `npm run build` | 2852 modules | **SUCCESS (11.74s)** |

---

## 8. Mandatory Invariant & Authority Assertions

- **FIRESTORE CHECK-IN = PRIMARY**
- **MYSQL CHECK-IN = AUTOMATIC EMERGENCY FALLBACK**
- **CHECKOUT = UNCHANGED (100% MySQL Authoritative)**
- **PAYMENTS = UNCHANGED (100% MySQL Authoritative)**
- **RESERVATIONS = UNCHANGED (100% MySQL Authoritative)**
- **REPORTS = UNCHANGED (100% MySQL Authoritative)**
- **OUTBOX = CONFIGURED AND RUNNING**
- **MySQL DECOMMISSIONED = NO**
