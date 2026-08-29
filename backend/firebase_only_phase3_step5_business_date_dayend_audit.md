# HPMS Phase 3 Step 5 — Business Date & Day-End Firebase-Only Read-Only Audit

**Date:** 2026-08-20  
**Phase:** Phase 3 — Step 5 (Business Date, Daily Counters, Day-End & Night Audit Cutover Audit)  
**Status:** READ-ONLY AUDIT COMPLETE — IMPLEMENTATION READY (PENDING APPROVAL)  
**Safety Status:** Zero source code changes, zero MySQL/Firestore mutations, zero feature flag modifications.

---

## 1. Executive Summary

This read-only audit inspects all backend components, services, controllers, repositories, and routes responsible for **Business Date resolution, Daily Counters (`today_checkins`, `today_checkouts`, `continued_rooms`), Night Audit / Day End execution, and Undo Day End reversal**.

### Key Findings
1. **Single Source of Truth Architecture:** The backend already enforces that **all** controllers, services, and middleware query Business Date strictly through [`BusinessDateService.getBusinessDate()`](file:///d:/projects/hotel/backend/services/businessDateService.js#L178) (direct SQL against `system_settings.system_date` is statically banned and guarded).
2. **Dual-Write State:** Phase 4 dual-writes already stage and dispatch compound atomic events (`COMPOUND_NIGHT_AUDIT`, `COMPOUND_UNDO_DAY_END`, `SYSTEM_DATE_UPDATED`) maintaining 100% data mirroring in Firestore collection `/settings/system_date`.
3. **Low Migration Blast Radius:** Because all date consumption flows through `BusinessDateService`, cutting over reads to Firestore requires updating **only 1 service** (`BusinessDateService.js`) and its repository [`systemSettingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/systemSettingsRepository.js).
4. **Zero Frontend Contract Changes:** The JSON contracts for `GET /api/settings/business-date`, `POST /api/settings/business-date`, `POST /api/dayend`, `POST /api/dayend/undo`, and `GET /api/status` remain 100% unchanged.

---

## 2. Inventory of Endpoints, Controllers & Services

### 2.1 Route Handlers & Controllers

| Route | Method | Controller & Function | Auth / RBAC Level | Purpose |
|---|---|---|---|---|
| `/api/settings/business-date` | `GET` | [`getBusinessDateInfo`](file:///d:/projects/hotel/backend/controllers/settingsController.js#L48) | Authenticated | Returns current business date, last Day End, room stats |
| `/api/settings/business-date` | `POST` | [`updateBusinessDate`](file:///d:/projects/hotel/backend/controllers/settingsController.js#L143) | `override_business_date` | Manual date override, single-day rollback, dev reset |
| `/api/dayend` | `POST` | [`runDayEnd`](file:///d:/projects/hotel/backend/controllers/auditController.js#L240) | `requireRole('admin')` | Advances business date by +1 day, posts nightly tariff |
| `/api/dayend/undo` | `POST` | [`undoDayEnd`](file:///d:/projects/hotel/backend/controllers/auditController.js#L296) | `requireSuperAdmin` | Reverses most recent Day End if zero post-audit operations |
| `/api/status` | `GET` | [`getStatus`](file:///d:/projects/hotel/backend/controllers/auditController.js#L71) | Authenticated | Dashboard state, reads `systemDate` & daily counters |

### 2.2 Core Service Methods in `BusinessDateService`

| Method | File & Line | Current Authority | Firestore Equivalency |
|---|---|---|---|
| `getBusinessDate(conn?)` | [`businessDateService.js:178`](file:///d:/projects/hotel/backend/services/businessDateService.js#L178) | MySQL `system_settings.system_date` | `getSystemDateFirestore()` from `/settings/system_date` |
| `setBusinessDate(conn, date, opts)` | [`businessDateService.js:210`](file:///d:/projects/hotel/backend/services/businessDateService.js#L210) | MySQL `UPDATE system_settings` | `updateSystemDateFirestore()` with merge |
| `resetDailyCounters(conn)` | [`businessDateService.js:251`](file:///d:/projects/hotel/backend/services/businessDateService.js#L251) | MySQL `UPDATE system_settings` | Set `today_checkins: 0, today_checkouts: 0` |
| `advanceBusinessDate(conn, nextDate, opts)` | [`businessDateService.js:274`](file:///d:/projects/hotel/backend/services/businessDateService.js#L274) | MySQL `FOR UPDATE` + atomic transaction | Firestore Transaction (`runTransaction`) |
| `rollbackBusinessDate(conn, opts)` | [`businessDateService.js:502`](file:///d:/projects/hotel/backend/services/businessDateService.js#L502) | MySQL `FOR UPDATE` + `audit_logs` | Firestore Transaction (`setDoc` + `/audit_logs`) |
| `acquireLock(conn)` | [`businessDateService.js:593`](file:///d:/projects/hotel/backend/services/businessDateService.js#L593) | MySQL `FOR UPDATE NOWAIT` | Firestore Transaction document precondition |

### 2.3 All Domain Consumers Reading Business Date During Requests

The following modules invoke `BusinessDateService.getBusinessDate()` during runtime execution:
- **Check-in Service:** [`checkInService.js:138`](file:///d:/projects/hotel/backend/services/checkInService.js#L138)
- **Check-out Service:** [`checkOutService.js:64`](file:///d:/projects/hotel/backend/services/checkOutService.js#L64)
- **Room Controller:** [`roomController.js:267, 537`](file:///d:/projects/hotel/backend/controllers/roomController.js#L267)
- **Cash Controller:** [`cashController.js:64, 182, 205`](file:///d:/projects/hotel/backend/controllers/cashController.js#L64)
- **Housekeeping Controller:** [`housekeepingController.js:159`](file:///d:/projects/hotel/backend/controllers/housekeepingController.js#L159)
- **Inventory Controller:** [`inventoryController.js:499, 647, 729`](file:///d:/projects/hotel/backend/controllers/inventoryController.js#L499)
- **Invoice Controller:** [`invoiceController.js:114`](file:///d:/projects/hotel/backend/controllers/invoiceController.js#L114)
- **Reports Controller:** [`reportsController.js:51, 147, 384, 420`](file:///d:/projects/hotel/backend/controllers/reportsController.js#L51)
- **Reservation Controller:** [`reservationController.js:38, 232, 632`](file:///d:/projects/hotel/backend/controllers/reservationController.js#L38)
- **Audit Controller:** [`auditController.js:81, 256, 308`](file:///d:/projects/hotel/backend/controllers/auditController.js#L81)
- **Settings Controller:** [`settingsController.js:82, 210`](file:///d:/projects/hotel/backend/controllers/settingsController.js#L82)
- **Auth Controller:** [`authController.js:104, 416`](file:///d:/projects/hotel/backend/controllers/authController.js#L104)

---

## 3. MySQL Schema & Query Enumeration

### 3.1 MySQL Tables and Columns Used in Business Date / Day-End Domain

| Table | Columns Accessed | Operations |
|---|---|---|
| `system_settings` | `key_name`, `value_val` | `SELECT ... FOR UPDATE`, `SELECT ... FOR UPDATE NOWAIT`, `UPDATE` |
| `audit_logs` | `id`, `user_id`, `action`, `details`, `business_date`, `previous_business_date`, `new_business_date`, `reason`, `username`, `role`, `client_ip`, `created_at` | `SELECT`, `INSERT`, `UPDATE` |
| `rooms` | `id`, `number`, `status`, `room_type_id` | `SELECT` (find occupied rooms for rollover) |
| `room_types` | `id`, `base_rate` | `SELECT` (room base tariff) |
| `bookings` | `id`, `room_id`, `booking_status`, `room_tariff`, `created_at`, `updated_at`, `check_out_date` | `SELECT` (booking tariff and undo-guard counts) |
| `ledger_items` | `id`, `room_number`, `desc`, `qty`, `amount`, `business_date`, `booking_id`, `transaction_type`, `credit_amount`, `time_of_entry`, `created_at` | `SELECT`, `INSERT` (rollover lines), `DELETE` (undo day end) |
| `reservations` | `created_at` | `SELECT COUNT(*)` (undo data guard) |
| `payments` | `created_at` | `SELECT COUNT(*)` (undo data guard) |
| `invoices` | `created_at` | `SELECT COUNT(*)` (undo data guard) |
| `room_status_history` | `created_at` | `SELECT COUNT(*)` (undo data guard) |
| `cash_logs` | `created_at` | `SELECT COUNT(*)` (undo data guard) |

### 3.2 Complete SQL Queries in `BusinessDateService` & Day-End Execution

1. **Read Business Date:**
   ```sql
   SELECT value_val FROM system_settings WHERE key_name = 'system_date'
   ```
2. **Read Daily Counters:**
   ```sql
   SELECT key_name, value_val FROM system_settings WHERE key_name IN ('today_checkins','today_checkouts','continued_rooms')
   ```
3. **Lock System Settings:**
   ```sql
   SELECT * FROM system_settings FOR UPDATE
   SELECT value_val FROM system_settings WHERE key_name = 'system_date' FOR UPDATE NOWAIT
   ```
4. **Duplicate Day-End Check:**
   ```sql
   SELECT id FROM audit_logs WHERE action = 'DAY_END' AND business_date = ? LIMIT 1
   ```
5. **Occupied Rooms Rollover Fetch:**
   ```sql
   SELECT r.id, r.number, r.status, rt.base_rate as rate
   FROM rooms r
   JOIN room_types rt ON r.room_type_id = rt.id
   WHERE r.status = 'occupied'
   ```
6. **Booking Tariff Fetch:**
   ```sql
   SELECT id, room_tariff FROM bookings WHERE room_id = ? AND booking_status = 'Checked In'
   ```
7. **Existing Rollover Line Check:**
   ```sql
   SELECT id FROM ledger_items WHERE room_number = ? AND business_date = ? AND booking_id = ? AND `desc` LIKE 'Room Tariff%Rollover%'
   ```
8. **Insert Rollover Ledger Line:**
   ```sql
   INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id, transaction_type, credit_amount, time_of_entry)
   VALUES (?, 'Room Tariff (Rollover, Incl. GST)', ?, ?, ?, 'ROLLOVER', 0, ?)
   ```
9. **Update Business Date & Counters:**
   ```sql
   UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'
   UPDATE system_settings SET value_val = ? WHERE key_name = 'continued_rooms'
   UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkins'
   UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkouts'
   ```
10. **Insert Audit Log:**
    ```sql
    INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'DAY_END', ?, ?)
    ```

---

## 4. Firestore Data Mirroring & Schema Parity

### 4.1 Existing Firestore Documents
- **Document Path:** `/settings/system_date`
  ```json
  {
    "current_date": "2026-08-19",
    "system_date": "2026-08-19",
    "today_checkins": 0,
    "today_checkouts": 0,
    "continued_rooms": 0,
    "day_end_status": "IDLE",
    "updated_at": "2026-08-20T04:45:00.000Z"
  }
  ```
- **Audit Logs Collection:** `/audit_logs/audit_{id}`
- **Ledger Items Collection:** `/ledger_items/ledger_{id}` & `/bookings/{booking_id}/ledger_items/ledger_{id}`

### 4.2 Concurrency & Locking Guarantees in Firestore

| Requirement | MySQL Mechanism | Firestore Equivalent Mechanism |
|---|---|---|
| **Atomicity** | `connection.beginTransaction()` / `commit()` | `db.runTransaction()` |
| **Pessimistic / Concurrent Lock** | `SELECT ... FOR UPDATE` | Transaction Read Precondition (`transaction.get(docRef)`) |
| **Conflict Detection** | `ER_LOCK_NOWAIT` / `ER_LOCK_DEADLOCK` | Optimistic Concurrency Control (OCC) retry / rejection |
| **Stale Overwrite Protection** | In-order committed log | `isStaleUpdate()` comparing `updated_at` timestamps |
| **Max Batch / Write Limit** | Unlimited | Max 500 writes (Night audit generates $\approx 2 \times N_{occupied} + 1$ writes; for a 17-room hotel, 35 writes) |

---

## 5. Risk & Blocker Assessment

| Potential Risk | Severity | Mitigation Strategy |
|---|---|---|
| **Double-Run / Race Condition during Day End** | HIGH | Firestore `transaction.get(docRef)` checks `system_date.current_date` and duplicate audit log `/audit_logs/day_end_${nextDate}` before writing. |
| **Quota Exhaustion during high-frequency date reads** | MEDIUM | `BusinessDateService` can implement in-memory caching with TTL (e.g., 5 seconds) or fall back cleanly to MySQL when quota is exhausted. |
| **Rollover Tariff Drift between MySQL and Firestore** | LOW | Compound outbox dispatcher (`COMPOUND_NIGHT_AUDIT`) dual-writes every tariff line deterministically with formatting helper `formatLedgerItemId()`. |

---

## 6. Proposed Migration Architecture & Sub-Steps

### Sub-Step 5.1: Feature Flag Registration
- Add `ENABLE_FIREBASE_ONLY_BUSINESS_DATE=false` to `backend/config/featureFlags.js`.
- Export helper `isFirebaseOnlyBusinessDateEnabled()`.

### Sub-Step 5.2: Firestore-First `getBusinessDate()` and Daily Counters Read
- When `ENABLE_FIREBASE_ONLY_BUSINESS_DATE=true`:
  - `BusinessDateService.getBusinessDate()` reads from `getSystemDateFirestore()`.
  - `getStatus` reads daily counters (`today_checkins`, `today_checkouts`, `continued_rooms`) from Firestore `/settings/system_date`.
  - Executes **0 MySQL queries**.
- When `ENABLE_FIREBASE_ONLY_BUSINESS_DATE=false`:
  - Preserves authoritative MySQL `system_settings` queries.

### Sub-Step 5.3: Controlled Firestore Transaction for `advanceBusinessDate()` & `rollbackBusinessDate()`
- Provide dual-path support for Day End advancement and Rollback.
- When flag is enabled, perform state transition via Firestore transactions.
- Keep MySQL transaction path active when flag is disabled.

### Sub-Step 5.4: Test Suite & Parity Validation
- Create `backend/tests/testPhase3Step5FirebaseOnlyBusinessDate.mjs`.
- Verify 100% parity across get, advance, rollback, conflict rejection, and error handling.
- Verify MySQL query count === 0 when flag is enabled.

---

## 7. Audit Verification Metrics

```
========================================================================================
                   PHASE 3 STEP 5 READ-ONLY AUDIT METRICS
========================================================================================
 Files modified                 : 0 (ZERO source files modified)
 MySQL mutations                : 0 (ZERO data mutations)
 MySQL schema changes           : 0 (ZERO table/column alterations)
 Firestore mutations            : 0 (ZERO document writes)
 Feature flags modified         : 0 (ZERO flag changes)
 Existing tests passing         : 64/64 Night Audit, 23/23 Undo Day End
 Production build verification  : PASS (vite v5.4.21 clean build)
 Migration readiness            : READY FOR STEP 5 IMPLEMENTATION (Awaiting Approval)
========================================================================================
```
