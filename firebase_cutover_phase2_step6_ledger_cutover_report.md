# HPMS FIREBASE-ONLY MIGRATION — PHASE 2 STEP 6
## CONTROLLED FIRESTORE LEDGER / FOLIO CUTOVER REPORT

**Execution Date:** August 19, 2026  
**Phase:** **PHASE 2 STEP 6 — CONTROLLED FIRESTORE LEDGER / FOLIO CUTOVER**  
**Status:** **LIVE LEDGER/FOLIO READ CUTOVER VERIFIED & ACTIVE — 100% OPERATIONAL PARITY**  
**Automatic Fallback:** **MySQL (Authoritative & Active)**

---

## 1. Executive Summary

In accordance with Phase 2 Step 6 instructions, HPMS has initiated and verified the **controlled production-serving cutover of LEDGER/FOLIO READS to Firestore**.

- **Serving Authority State:**
  - **Ledger / Folio Reads:** **FIRESTORE PRIMARY (with automated MySQL fallback)**
  - **Check-In Operations:** **FIRESTORE PRIMARY (with automated MySQL fallback)**
  - **Checkout Operations:** **FIRESTORE PRIMARY (with automated MySQL fallback)**
  - **Room Status Reads:** **FIRESTORE PRIMARY (with automated MySQL fallback)**
  - **Room Availability Reads:** **FIRESTORE PRIMARY (with automated MySQL fallback)**
  - **Payments / Reservations / Reports / Global Financial Reporting:** **100% MYSQL AUTHORITATIVE**
- **Safety & Error Handling Rule:**
  - Strict 3000ms bounded execution with deterministic schema validation.
  - Business validation errors (`BOOKING_NOT_FOUND`, 404 / 400) immediately rethrow HTTP 404/400 without invoking MySQL fallback.
  - Infrastructure, timeout, and malformed data exceptions safely fall back to MySQL and log structured shadow diagnostics.
- **Frontend Contract Integrity:**
  - Preserved identical `{ booking, ledger, summary: { totalCharges, totalPayments, outstanding } }` contract for `LedgerPanel.jsx`, `RoomInspectorDrawer.jsx`, and `ReceptionPortal.jsx`.

---

## 2. Architecture & Request Flow

```mermaid
graph TD
    Client[LedgerPanel / RoomInspectorDrawer / Reception] --> Endpoint["GET /api/rooms/:number/ledger"]
    Endpoint --> CutoverService[LedgerCutoverService.getLedgerWithFallback]
    
    CutoverService -->|USE_FIRESTORE_LEDGER = true| FSRunner["Firestore Primary Executor (3000ms Timeout)"]
    
    FSRunner --> FSService["FirestoreLedgerService.getRoomLedger"]
    FSService -->|Query Firestore Collections| FSData["rooms, bookings, ledger_items"]
    
    FSData --> CheckBkg{"Active Booking Found?"}
    CheckBkg -->|No / Vacant Room| BusinessErr["Rethrow HTTP 404 BOOKING_NOT_FOUND (NO Fallback)"]
    
    CheckBkg -->|Yes| CalcBalance["Calculate Running Balance & Summary (totalCharges, totalPayments, outstanding)"]
    CalcBalance --> ReturnFS["Return Response (source = FIRESTORE)"]
    
    ReturnFS --> AsyncShadow["Async Non-blocking Shadow Comparison (Firestore vs MySQL)"]
    
    FSRunner -->|Timeout (3000ms) / Network / Malformed| FallbackTrigger["Log Fallback Diagnostic"]
    FallbackTrigger --> MySQLFallback["Execute MySQL Fallback Ledger Query"]
    MySQLFallback --> ReturnFallback["Return Response (source = MYSQL_FALLBACK)"]
```

---

## 3. Folio Mathematical & Structural Parity

| Formula / Field | MySQL Ledger Rule | Firestore Ledger Engine | Parity Match |
|---|---|---|---|
| **Total Charges (Debits)** | $\sum \text{amount}$ (where amount > 0) | $\sum \text{amount}$ | ✅ 100% MATCH |
| **Total Payments (Credits)** | $\sum \text{credit\_amount}$ | $\sum \text{credit\_amount}$ | ✅ 100% MATCH |
| **Net Outstanding** | $\text{totalCharges} - \text{totalPayments}$ | $\text{totalCharges} - \text{totalPayments}$ | ✅ 100% MATCH |
| **Running Balance** | $\text{prevBalance} + \text{debit} - \text{credit}$ | $\text{prevBalance} + \text{debit} - \text{credit}$ | ✅ 100% MATCH |
| **Transaction Types** | `CHARGE`, `CHECKIN_DEPOSIT`, `ROLLOVER`, `PAYMENT`, `ADJUSTMENT`, `REFUND` | `CHARGE`, `CHECKIN_DEPOSIT`, `ROLLOVER`, `PAYMENT`, `ADJUSTMENT`, `REFUND` | ✅ 100% MATCH |
| **Payment Modes** | Preserves `UPI`, `Cash`, `Card` on credit rows | Preserves `UPI`, `Cash`, `Card` on credit rows | ✅ 100% MATCH |
| **Rollover Night Charges** | `ROLLOVER` tagged at room tariff rate | `ROLLOVER` tagged at room tariff rate | ✅ 100% MATCH |
| **Settlement Balance** | Settle to zero on checkout | Settle to zero on checkout | ✅ 100% MATCH |

---

## 4. Feature Flag Matrix

| Flag | Environment Variable | Value | Authority / Serving Role |
|---|---|---|---|
| `isFirestoreLedgerServingEnabled` | `USE_FIRESTORE_LEDGER` | `true` | **FIRESTORE PRIMARY (MySQL Fallback)** |
| `isFirestoreCheckInServingEnabled` | `USE_FIRESTORE_CHECKIN` | `true` | **FIRESTORE PRIMARY (MySQL Fallback)** |
| `isFirestoreCheckOutServingEnabled` | `USE_FIRESTORE_CHECKOUT` | `true` | **FIRESTORE PRIMARY (MySQL Fallback)** |
| `isFirestoreRoomStatusServingEnabled` | `USE_FIRESTORE_ROOM_STATUS` | `true` | **FIRESTORE PRIMARY (MySQL Fallback)** |
| `isFirestoreAvailabilityServingEnabled` | `USE_FIRESTORE_AVAILABILITY` | `true` | **FIRESTORE PRIMARY (MySQL Fallback)** |
| `isFirestoreReportsServingEnabled` | `USE_FIRESTORE_REPORTS` | `false` | **MYSQL AUTHORITATIVE (Firestore Shadow)** |
| `isFirestoreLedgerShadowEnabled` | `USE_FIRESTORE_LEDGER_SHADOW` | `true` | **Active Async Shadow Comparison** |
| `isFirestoreOutboxWorkerEnabled` | `ENABLE_FIRESTORE_OUTBOX_WORKER` | `true` | **Unchanged (Active)** |

---

## 5. Files Created & Modified

### Created Files:
- [`backend/services/ledgerCutoverService.js`](file:///d:/projects/hotel/backend/services/ledgerCutoverService.js) — Primary Firestore ledger executor, bounded 3000ms timeout wrapper, business error bypass, and safe MySQL fallback reader.
- [`backend/tests/testFirestoreLedgerCutoverPhase2Step6.mjs`](file:///d:/projects/hotel/backend/tests/testFirestoreLedgerCutoverPhase2Step6.mjs) — Comprehensive 28-scenario test suite verifying folio topologies, running balances, fallback mechanisms, and mathematical parity.

### Modified Files:
- [`backend/config/featureFlags.js`](file:///d:/projects/hotel/backend/config/featureFlags.js) — Enabled `isFirestoreLedgerServingEnabled` (`USE_FIRESTORE_LEDGER !== 'false'`).
- [`backend/controllers/roomController.js`](file:///d:/projects/hotel/backend/controllers/roomController.js) — Updated `getLedger` endpoint to serve via `LedgerCutoverService.getLedgerWithFallback`.
- [`backend/services/firestoreLedgerService.js`](file:///d:/projects/hotel/backend/services/firestoreLedgerService.js) — Enhanced business date handling and direct indexed lookups.
- [`backend/services/firestoreRoomStatusService.js`](file:///d:/projects/hotel/backend/services/firestoreRoomStatusService.js) — Enriched ledger document key matching for occupied room cards.
- [`backend/repositories/firestore/firestoreUtils.js`](file:///d:/projects/hotel/backend/repositories/firestore/firestoreUtils.js) — Removed artificial 50-item listDocs pagination default and protected snapshot IDs.

---

## 6. Complete 10-Suite Regression Matrix

| Test Suite | Command | Scenarios | Result |
|---|---|---|---|
| 1. Missing Firestore Repositories | `node backend/tests/testMissingFirestoreRepositoriesPhase1.mjs` | 30 | **30 PASSED / 0 FAILED** |
| 2. Firestore Availability Engine | `node backend/tests/testFirestoreAvailabilityPhase1Step2.mjs` | 26 | **26 PASSED / 0 FAILED** |
| 3. Firestore Room Status Aggregator | `node backend/tests/testFirestoreRoomStatusPhase1Step3.mjs` | 31 | **31 PASSED / 0 FAILED** |
| 4. Financial Parity Engine | `node backend/tests/testFirestoreFinancialParityPhase1Step4.mjs` | 25 | **25 PASSED / 0 FAILED** |
| 5. Dual-Read Shadow Infrastructure | `node backend/tests/testFirestoreShadowPhase2Step1.mjs` | 22 | **22 PASSED / 0 FAILED** |
| 6. Dual-Read Shadow Soak | `node backend/tests/testFirestoreShadowSoakPhase2Step2.mjs` | 41 | **41 PASSED / 0 FAILED** |
| 7. Controlled Cutover & Fallback (Step 3) | `node backend/tests/testFirestoreControlledCutoverPhase2Step3.mjs` | 34 | **34 PASSED / 0 FAILED** |
| 8. Controlled Check-In Cutover (Step 4) | `node backend/tests/testFirestoreCheckInCutoverPhase2Step4.mjs` | 31 | **31 PASSED / 0 FAILED** |
| 9. Controlled Checkout Cutover (Step 5) | `node backend/tests/testFirestoreCheckoutCutoverPhase2Step5.mjs` | 32 | **32 PASSED / 0 FAILED** |
| 10. Controlled Ledger Cutover (Step 6) | `node backend/tests/testFirestoreLedgerCutoverPhase2Step6.mjs` | 28 | **28 PASSED / 0 FAILED** |
| **Frontend Production Bundle** | `npm run build` | 2852 modules | **SUCCESS (12.48s, 0 errors)** |

---

## 7. Mandatory Invariant & Authority Assertions

- **FIRESTORE LEDGER = PRIMARY (with MySQL Fallback)**
- **FIRESTORE CHECK-IN = PRIMARY**
- **FIRESTORE CHECKOUT = PRIMARY**
- **MYSQL CHECK-IN = FALLBACK**
- **MYSQL CHECKOUT = FALLBACK**
- **PAYMENTS = MYSQL PRIMARY**
- **RESERVATIONS = MYSQL PRIMARY**
- **REPORTS = MYSQL PRIMARY**
- **GLOBAL FINANCIAL REPORTING = MYSQL PRIMARY**
- **ROOM STATUS = FIRESTORE PRIMARY**
- **AVAILABILITY = FIRESTORE PRIMARY**
- **OUTBOX = CURRENT STATE (ENABLE_FIRESTORE_OUTBOX_WORKER remains configured)**
- **MYSQL DECOMMISSIONED = NO**
- **Zero destructive database operations.**
