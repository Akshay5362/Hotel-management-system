# PHASE 3K-2 BOOKINGS DOMAIN COMPLETE WRITE-PATH AUDIT REPORT

**Date**: August 11, 2026  
**Auditor**: Antigravity AI Engine  
**Domain**: Bookings (`bookings` & `booking_history` MySQL tables / `bookings` & `booking_history` Firestore collections)  
**Task Type**: Read-Only Write-Path Audit  

---

## 1. Inventory of Real Bookings Write Paths

Following a complete scan of `backend/controllers/`, `backend/services/`, and `backend/routes/`, **11 actual write paths** mutating `bookings` and/or `booking_history` were identified in the codebase.

### Identified Write Paths:
1. `roomController.bookRoom` — Online/Walk-in room reservation creation (`bookings` INSERT)
2. `roomController.modifyCheckIn` — Update check-in and reservation details (`bookings` UPDATE)
3. `checkInService.processCheckIn` (called via `roomController.checkIn`, `reservationController.checkInReservation`, `roomController.guestRequestCheckIn`) — Direct or reservation check-in execution (`bookings` INSERT)
4. `roomController.checkOut` — Guest checkout and balance settlement (`bookings` UPDATE, `booking_history` INSERT)
5. `roomController.shift` — Room shift for active checked-in guest (`bookings` UPDATE)
6. `roomController.processRefundCheckout` — Reception refund processing and checkout (`bookings` UPDATE)
7. `roomController.adminExtendStay` — Admin direct stay extension (`bookings` UPDATE)
8. `roomController.adminNoShow` — Admin marking reservation as No Show (`bookings` UPDATE)
9. `reservationController.cancelReservation` — Cancel reservation with active booking (`bookings` UPDATE, `booking_history` INSERT)
10. `auditController.resolveExtensionRequest` — Approve stay extension request (`bookings` UPDATE)
11. `FactoryResetService.factoryReset` (called via `factoryResetController.js`) — System factory reset (`bookings` DELETE, `booking_history` DELETE)

---

## 2. Complete Write-Path Matrix

| # | File | Function | Table Mutated | Op | Tx Boundary | FOR UPDATE Required/Present | Uses `enqueue()` | Staged Outbox Event | Enqueue Before Commit | Rollback Clears Event | Payload Complete | Stale Protection | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `backend/controllers/roomController.js` | `bookRoom` | `bookings` | INSERT | YES (`pool.getConnection`) | YES (on `rooms` & `AvailabilityService`) | YES | `BOOKING_CREATED` | YES | YES | YES | YES (`updated_at`) | **COMPLETE** |
| 2 | `backend/controllers/roomController.js` | `modifyCheckIn` | `bookings` | UPDATE | YES (`pool.getConnection`) | **NO (MISSING)** | YES | `BOOKING_UPDATED` | YES | YES | **PARTIAL** (Missing `guest_id`, `room_id`, `total_amount`, `booking_status`) | YES (`updated_at`) | **PARTIAL** |
| 3 | `backend/services/checkInService.js` | `processCheckIn` | `bookings` | INSERT | YES (Passed from controller) | YES (on `rooms` & `reservations`) | **NO** | NONE | N/A | N/A | N/A | N/A | **MISSING** |
| 4 | `backend/controllers/roomController.js` | `checkOut` | `bookings`, `booking_history` | UPDATE, INSERT | YES (`pool.getConnection`) | YES (on `rooms`, missing on `bookings`) | **NO** | NONE | N/A | N/A | N/A | N/A | **MISSING** |
| 5 | `backend/controllers/roomController.js` | `shift` | `bookings` | UPDATE | YES (`pool.getConnection`) | YES (on `rooms`) | **NO** | NONE | N/A | N/A | N/A | N/A | **MISSING** |
| 6 | `backend/controllers/roomController.js` | `processRefundCheckout` | `bookings` | UPDATE | YES (`pool.getConnection`) | YES (on `rooms`) | **NO** | NONE | N/A | N/A | N/A | N/A | **MISSING** |
| 7 | `backend/controllers/roomController.js` | `adminExtendStay` | `bookings` | UPDATE | YES (`pool.getConnection`) | YES (on `rooms`) | **NO** | NONE | N/A | N/A | N/A | N/A | **MISSING** |
| 8 | `backend/controllers/roomController.js` | `adminNoShow` | `bookings` | UPDATE | YES (`pool.getConnection`) | YES (on `rooms`) | **NO** | NONE | N/A | N/A | N/A | N/A | **MISSING** |
| 9 | `backend/controllers/reservationController.js` | `cancelReservation` | `bookings`, `booking_history` | UPDATE, INSERT | YES (`pool.getConnection`) | YES (on `reservations` & `bookings`) | **NO** | NONE | N/A | N/A | N/A | N/A | **MISSING** |
| 10 | `backend/controllers/auditController.js` | `resolveExtensionRequest` | `bookings` | UPDATE | YES (`pool.getConnection`) | YES (on `requests` & `bookings`) | **NO** | NONE | N/A | N/A | N/A | N/A | **MISSING** |
| 11 | `backend/services/FactoryResetService.js` | `factoryReset` | `bookings`, `booking_history` | DELETE, DELETE | YES (`pool.getConnection`) | N/A (Full table clear) | **NO** | NONE | N/A | N/A | N/A | N/A | **MISSING** |

---

## 3. Verification of the Two Pilot Paths

### Path A: `roomController.bookRoom`
- **MySQL Transaction**: Correctly opens dedicated connection `await pool.getConnection()` and begins transaction `await connection.beginTransaction()`.
- **Booking Mutation**: Inserts new record into `bookings` table with `booking_status = 'Reserved'`.
- **Outbox Enqueue**: Calls `await enqueue(connection, { event_type: 'BOOKING_CREATED', aggregate_type: 'BOOKING', aggregate_id: bookingNumber, payload: { ... } })` on line 863.
- **Commit Sequence**: Enqueue occurs **before** `connection.commit()` (line 888).
- **Rollback Safety**: If any query or outbox enqueue fails, `connection.rollback()` is invoked in `catch` block, rolling back both the booking insert and the outbox log.
- **Connection Object**: Correctly passes the transactional `connection` object to `enqueue(connection, ...)`.
- **Payload Verification**: Includes `booking_number`, `guest_id`, `guest_name`, `room_id`, `room_number`, `check_in_date`, `expected_check_out_date`, `adults`, `children`, `booking_status`, `payment_status`, `total_amount`, `advance_amount`, `mysql_booking_id`, `updated_at`.
- **Aggregate ID**: Correctly set to `bookingNumber` (e.g., `BKG-784920`).
- **Feature Flag Check**: Gated behind `if (isFirestoreDualWriteEnabled())`.

### Path B: `roomController.modifyCheckIn`
- **MySQL Transaction**: Correctly uses `connection = await pool.getConnection()` and `connection.beginTransaction()`.
- **Booking Mutation**: Updates `check_in_date`, `expected_check_out_date`, `adults`, `advance_amount`, `billing_instruction`, `meal_plan` on `bookings` table.
- **Outbox Enqueue**: Calls `await enqueue(connection, { event_type: 'BOOKING_UPDATED', aggregate_type: 'BOOKING', aggregate_id: booking.booking_number, payload: { ... } })` on line 1025.
- **Commit Sequence**: Enqueue occurs **before** `connection.commit()` (line 1043).
- **Rollback Safety**: Rollback properly cleans up outbox event.
- **Issues Identified**:
  1. **Locking Issue**: `SELECT id, status FROM rooms WHERE number = ?` (line 944) and `SELECT * FROM bookings WHERE room_id = ? ...` (line 953) **DO NOT use `FOR UPDATE`**. Parallel requests could cause race conditions.
  2. **Incomplete Payload**: Event payload is missing `guest_id`, `room_id`, `total_amount`, and `booking_status`. When `outboxDispatcher` receives `BOOKING_UPDATED`, it updates Firestore; missing fields leave Firestore out-of-sync if defaults are assumed.

---

## 4. Operation-by-Operation Audit Summary

| Operation Name | Mutates Bookings / History? | Exact Mutation | Event Representation | Currently Staged? | Same Tx? |
|---|---|---|---|---|---|
| `executeCheckIn` / `processCheckIn` | YES | `INSERT INTO bookings` (`booking_status = 'Checked In'`) | `BOOKING_CREATED` | **NO** | YES |
| `bookRoom` | YES | `INSERT INTO bookings` (`booking_status = 'Reserved'`) | `BOOKING_CREATED` | YES | YES |
| `modifyCheckIn` | YES | `UPDATE bookings SET check_in_date = ?, expected_check_out_date = ?, adults = ?, advance_amount = ?, ...` | `BOOKING_UPDATED` | YES | YES |
| `checkOut` | YES | `UPDATE bookings SET booking_status = 'Checked Out', payment_status = 'Paid', ...`<br>`INSERT INTO booking_history (action = 'CHECKED_OUT')` | `BOOKING_STATUS_CHANGED`, `BOOKING_HISTORY_CREATED` | **NO** | YES |
| `processRefundCheckout` | YES | `UPDATE bookings SET booking_status = 'Checked Out', payment_status = 'Refunded', check_out_date = ?` | `BOOKING_STATUS_CHANGED` | **NO** | YES |
| `shift` | YES | `UPDATE bookings SET room_id = ?` | `BOOKING_UPDATED` | **NO** | YES |
| `extendStay` / `adminExtendStay` | YES | `UPDATE bookings SET expected_check_out_date = ?` | `BOOKING_UPDATED` | **NO** | YES |
| `adminNoShow` | YES | `UPDATE bookings SET booking_status = 'No Show', check_out_date = ?` | `BOOKING_STATUS_CHANGED` | **NO** | YES |
| `confirmReservation` / `checkInReservation` | YES | Via `processCheckIn`: `INSERT INTO bookings` | `BOOKING_CREATED` | **NO** | YES |
| `cancelReservation` | YES | `UPDATE bookings SET booking_status = 'Checked Out', payment_status = 'Refunded'`<br>`INSERT INTO booking_history (action = 'CANCELLED')` | `BOOKING_STATUS_CHANGED`, `BOOKING_HISTORY_CREATED` | **NO** | YES |
| `executeNightAudit` / `runDayEnd` | **NO** | **NO BOOKING MUTATION FOUND** (Reads bookings for rollover ledger generation only) | N/A | N/A | N/A |
| `factoryReset` | YES | `DELETE FROM booking_history`<br>`DELETE FROM bookings` | `BOOKING_DELETED` | **NO** | YES |

---

## 5. Check-In / Check-Out Concurrency Audit

### Concurrency Risk Analysis:

1. **`modifyCheckIn` Locking Omission (P1 Risk)**:
   - File: `backend/controllers/roomController.js` (lines 944, 953)
   - Issue: Queries `rooms` and `bookings` without `FOR UPDATE`.
   - Concurrency Consequence: Parallel check-in modification and room checkout or extension can read stale booking state, resulting in lost updates or state mismatch.

2. **`checkOut` Active Booking Selection Race (P1 Risk)**:
   - File: `backend/controllers/roomController.js` (line 106)
   - Issue: `rooms` table is locked with `FOR UPDATE` (line 92), but `bookings` query (`SELECT b.* ... WHERE b.room_id = ? AND b.booking_status = 'Checked In'`) does NOT use `FOR UPDATE`.
   - Concurrency Consequence: Parallel checkout requests for the same room can both select the active booking simultaneously before the first query updates the status to `'Checked Out'`.

3. **`shift` Active Booking Selection Race (P1 Risk)**:
   - File: `backend/controllers/roomController.js` (line 434)
   - Issue: `fromRooms` and `toRooms` are locked with `FOR UPDATE`, but the `bookings` query does NOT use `FOR UPDATE`.
   - Concurrency Consequence: Simultaneous shift and checkout operations can compete for the same booking.

4. **`processCheckIn` Guest Creation Race Condition (P2 Risk)**:
   - File: `backend/services/checkInService.js` (line 134)
   - Issue: Rooms and reservations are locked with `FOR UPDATE`, but guest lookup (`SELECT id FROM guests WHERE phone = ?`) does not lock the guest record.
   - Concurrency Consequence: Simultaneous check-ins with the same phone number can cause duplicate guest records to be created in MySQL.

5. **`bookRoom` Guest Loyalty Points Race Condition (P2 Risk)**:
   - File: `backend/controllers/roomController.js` (line 672, 840)
   - Issue: Guest profile lookup and loyalty updates do not lock the guest row with `FOR UPDATE`.
   - Concurrency Consequence: Rapid consecutive bookings for the same guest can cause lost updates on loyalty points and tier calculations.

---

## 6. Event Contract Audit

| Event Type | Dispatcher Mapping | Repository Method | Aggregate Type | Aggregate ID | Firestore Document ID Format | Payload Validation / Stale Protection | Security & Sanitization Status |
|---|---|---|---|---|---|---|---|
| `BOOKING_CREATED` | `outboxDispatcher.js` line 263 | `createBookingFirestore` | `BOOKING` | `booking_number` | `bkg_<booking_number>` | Requires `booking_number`, `guest_id`, `room_id`, `check_in_date`. Checks duplicate key. | PASS (No secrets/passwords) |
| `BOOKING_UPDATED` | `outboxDispatcher.js` line 274 | `updateBookingFirestore` | `BOOKING` | `booking_number` | `bkg_<booking_number>` | Has `isStaleUpdate` timestamp protection (`updated_at`). | PASS (No secrets/passwords) |
| `BOOKING_STATUS_CHANGED` | `outboxDispatcher.js` line 280 | `updateBookingStatusFirestore` | `BOOKING` | `booking_number` | `bkg_<booking_number>` | Updates `booking_status` and `payment_status` with `updated_at`. | PASS (No secrets/passwords) |
| `BOOKING_HISTORY_CREATED` | `outboxDispatcher.js` line 286 | `createBookingHistoryFirestore` | `BOOKING_HISTORY` | `history_id` / `booking_id` | `history_<id>` (Root & Subcollection) | Requires `action`, `details`. Deterministic subcollection write under `bookings/{bkg_id}/history`. | PASS (No secrets/passwords) |
| `BOOKING_DELETED` | `outboxDispatcher.js` line 290 | `deleteBookingFirestore` | `BOOKING` | `booking_number` | `bkg_<booking_number>` | Idempotent deletion (ignores `NOT_FOUND`). | PASS |

---

## 7. Booking History Audit

1. **Actual History Write Paths**:
   - `roomController.checkOut`: Inserts history row with action `'CHECKED_OUT'`.
   - `reservationController.cancelReservation`: Inserts history row with action `'CANCELLED'`.
   - `FactoryResetService.factoryReset`: Deletes all history rows.
2. **Outbox Staging Status**: Currently **NOT STAGED** in any write path.
3. **Deterministic History IDs**: `createBookingHistoryFirestore` uses `history_id` or generates `history_<timestamp>_<rand>`. Writes both to root collection `booking_history` and subcollection `bookings/{bkgId}/history/{historyId}`.
4. **Duplicate Replay Safety**: Dual write uses `setDoc(..., merge: true)`, making replay idempotent and safe.
5. **Append-Only Property**: MySQL `booking_history` is strictly append-only (except during factory reset).

---

## 8. Test Coverage Audit

### TESTED (Covered by Phase 3K-1 Foundation & Pilot Tests):
- `createBookingFirestore`, `getBookingByIdFirestore`, `getBookingByNumberFirestore`, `updateBookingFirestore`, `updateBookingStatusFirestore`, `deleteBookingFirestore` repository methods.
- `createBookingHistoryFirestore`, `getBookingHistoryByBookingFirestore`, `getBookingHistoryByIdFirestore` repository methods.
- `outboxDispatcher` dispatching for `BOOKING_CREATED`, `BOOKING_UPDATED`, `BOOKING_STATUS_CHANGED`, `BOOKING_HISTORY_CREATED`, `BOOKING_DELETED`.
- Timestamp-based stale update protection (`updated_at`).
- Outbox staging & worker dispatch for `bookRoom` (`BOOKING_CREATED`) and `modifyCheckIn` (`BOOKING_UPDATED`).
- Rollback safety (outbox log deletion on transaction abort).
- Replay idempotency.

### NOT TESTED (Missing Test Coverage):
- `processCheckIn` direct check-in outbox staging & dual-write.
- `checkOut` outbox staging for status change to `Checked Out` & history creation.
- `shift` outbox staging for room reassignment.
- `processRefundCheckout` outbox staging for refund checkout status update.
- `adminExtendStay` & `resolveExtensionRequest` outbox staging for checkout date extension.
- `adminNoShow` outbox staging for status change to `No Show`.
- `cancelReservation` outbox staging for status change and history creation.
- `factoryReset` outbox deletion / clear dispatching.
- Concurrent transaction race condition tests under high parallel load.

### NEEDS NEW TEST:
- `testBookingsFullWritePathSuite.mjs` covering all 11 real booking write paths.
- Concurrency stress test verifying `SELECT ... FOR UPDATE` isolation under parallel execution.

---

## 9. Production Safety Check

- `ENABLE_FIRESTORE_DUAL_WRITE`: Confirmed `false` in `.env.example` / system defaults.
- `ENABLE_FIRESTORE_OUTBOX_WORKER`: Confirmed `false` in `.env.example` / system defaults.
- No production Firestore writes performed.
- No MySQL schema changes executed.
- No production data modified.
- Audit was performed 100% read-only.

---

## 10. Summary & Implementation Order

### A. Total Write Paths Found: 11
### B. Complete Paths: 1 (`roomController.bookRoom`)
### C. Partial Paths: 1 (`roomController.modifyCheckIn`)
### D. Missing Outbox Paths: 9 (`processCheckIn`, `checkOut`, `shift`, `processRefundCheckout`, `adminExtendStay`, `adminNoShow`, `cancelReservation`, `resolveExtensionRequest`, `factoryReset`)
### E. Concurrency Risks: 3 P1 risks (Missing `FOR UPDATE` in `modifyCheckIn`, `checkOut`, `shift`), 2 P2 risks (Guest profile lookup in `processCheckIn` and `bookRoom`)
### F. Booking History Risks: History events (`BOOKING_HISTORY_CREATED`) are not currently staged in `checkOut` or `cancelReservation`.
### G. Event Contract Issues: `BOOKING_UPDATED` in `modifyCheckIn` payload lacks `guest_id`, `room_id`, `total_amount`, and `booking_status`.
### H. Test Coverage Gaps: 9 out of 11 write paths lack E2E dual-write test verification.

### Recommended Implementation Order for Phase 3K-2:
1. **Fix Missing Locks (P1)**: Add `FOR UPDATE` to `modifyCheckIn`, `checkOut`, and `shift` booking/room queries.
2. **Complete Event Payloads**: Update `modifyCheckIn` outbox payload to include complete booking state (`guest_id`, `room_id`, `total_amount`, `booking_status`).
3. **Integrate Outbox in Remaining 9 Paths**:
   - `checkInService.processCheckIn`: Enqueue `BOOKING_CREATED` or `BOOKING_STATUS_CHANGED`.
   - `roomController.checkOut`: Enqueue `BOOKING_STATUS_CHANGED` and `BOOKING_HISTORY_CREATED`.
   - `roomController.shift`: Enqueue `BOOKING_UPDATED`.
   - `roomController.processRefundCheckout`: Enqueue `BOOKING_STATUS_CHANGED`.
   - `roomController.adminExtendStay`: Enqueue `BOOKING_UPDATED`.
   - `roomController.adminNoShow`: Enqueue `BOOKING_STATUS_CHANGED`.
   - `reservationController.cancelReservation`: Enqueue `BOOKING_STATUS_CHANGED` and `BOOKING_HISTORY_CREATED`.
   - `auditController.resolveExtensionRequest`: Enqueue `BOOKING_UPDATED`.
   - `FactoryResetService.factoryReset`: Enqueue `BOOKING_DELETED` / handle outbox cleanup.
4. **Build Comprehensive Test Suite (`testBookingsFullWritePathSuite.mjs`)**: Validate all 11 write paths with outbox staging, worker dispatching, and Firestore verification.

---

PHASE 3K-2 AUDIT STATUS:  
**NOT READY — FIX THESE ITEMS FIRST**  
*(Requires completing outbox staging across the 9 missing write paths, adding missing `FOR UPDATE` locks, and fixing the `BOOKING_UPDATED` payload before proceeding to Phase 3K-2 implementation completion).*
