# Phase 3K — Bookings Domain Dual-Write Pre-Implementation Design Specification
**Document Version**: 1.0.0  
**Audit Date**: August 11, 2026  
**Status**: Pre-Implementation Design Specification (READ-ONLY Architecture Audit)  
**Target Domain**: Bookings (`bookings`, `booking_history`)  

---

## 1. Verified Current Architecture & System Baseline

The HPMS-Sky5 system operates with **MySQL 8.x as the sole operational single source of truth**. Cloud Firestore operates as a secondary shadow data layer synchronized via an asynchronous Transactional Outbox pattern.

The **Bookings Domain** (`bookings` and `booking_history` tables) is the central core of HPMS-Sky5, linking Guests, Rooms, Payments, Ledger items, Invoices, and Housekeeping logs.

- **Phase 2 Status**: Firestore repositories [`bookingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/bookingsRepository.js) and [`bookingHistoryRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/bookingHistoryRepository.js) are implemented and operational for read fallback queries.
- **Phase 3 Status**: Transactional Outbox dual-write is **not yet implemented** for Bookings mutations. Controller write operations currently update MySQL only.
- **Feature Flag Safety Lock**: `ENABLE_FIRESTORE_DUAL_WRITE` and `ENABLE_FIRESTORE_OUTBOX_WORKER` are strictly set to `false`.

---

## 2. Complete Bookings Write-Path Inventory

Below is the comprehensive inventory of all 11 active MySQL write paths affecting the `bookings` and `booking_history` tables across backend controllers and services:

| # | File / Function | Route / Context | Method | Target Table | SQL Operation | Transactional Boundary |
| :- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `checkInService.js` / `executeCheckIn` | `POST /api/rooms/:number/checkin` | POST | `bookings` | `INSERT INTO bookings (...)` | Explicit `beginTransaction()` + `commit()` |
| **2** | `roomController.js` / `checkIn` | `POST /api/rooms/:number/checkin` | POST | `bookings` | `INSERT INTO bookings (...)` | Explicit `beginTransaction()` + `commit()` |
| **3** | `roomController.js` / `checkOut` | `POST /api/rooms/:number/checkout` | POST | `bookings` | `UPDATE bookings SET booking_status = 'Checked Out' ...` | Explicit `beginTransaction()` + `commit()` |
| **4** | `roomController.js` / `shift` | `POST /api/rooms/shift` | POST | `bookings`, `booking_history` | `UPDATE bookings SET room_id = ? ...`, `INSERT INTO booking_history` | Explicit `beginTransaction()` + `commit()` |
| **5** | `roomController.js` / `processRefundCheckout` | `POST /api/rooms/:number/refund-checkout` | POST | `bookings` | `UPDATE bookings SET booking_status = 'Checked Out', payment_status = 'Refunded' ...` | Explicit `beginTransaction()` + `commit()` |
| **6** | `roomController.js` / `extendStay` | `POST /api/rooms/:number/extend-stay` | POST | `bookings` | `UPDATE bookings SET expected_check_out_date = ? ...` | Explicit `beginTransaction()` + `commit()` |
| **7** | `roomController.js` / `adminNoShow` | `POST /api/rooms/:number/no-show` | POST | `bookings` | `UPDATE bookings SET booking_status = 'No Show' ...` | Explicit `beginTransaction()` + `commit()` |
| **8** | `reservationController.js` / `confirmReservation` | `POST /api/reservations/:id/confirm` | POST | `bookings` | `UPDATE bookings SET booking_status = 'Confirmed' ...` | Explicit `beginTransaction()` + `commit()` |
| **9** | `reservationController.js` / `cancelReservation` | `POST /api/reservations/:id/cancel` | POST | `bookings` | `UPDATE bookings SET booking_status = 'Cancelled' ...` | Explicit `beginTransaction()` + `commit()` |
| **10**| `auditController.js` / `executeNightAudit` | `POST /api/audit/night-audit` | POST | `bookings` | `UPDATE bookings SET expected_check_out_date = ? ...` | Explicit `beginTransaction()` + `commit()` |
| **11**| `FactoryResetService.js` / `factoryReset` | `POST /api/system/factory-reset` | POST | `bookings`, `booking_history` | `DELETE FROM booking_history`, `DELETE FROM bookings` | Explicit `beginTransaction()` + `commit()` |

---

## 3. Complete Booking Lifecycle & Dependency Analysis

### Booking Domain Dependency Graph
```
                          ┌─────────────────────────┐
                          │     ROOM TYPES (3B)     │
                          └────────────┬────────────┘
                                       │ 1:N
                                       ▼
┌─────────────────────────┐       ┌─────────────────────────┐
│       GUESTS (3H)       │ 1:N   │       ROOMS (3C)        │
└────────────┬────────────┘       └────────────┬────────────┘
             │                                 │
             └─────────────────┬───────────────┘
                               │ 1:N
                               ▼
                   ┌───────────────────────┐
                   │    BOOKINGS (3K)      │
                   └───────────┬───────────┘
                               │ 1:N
     ┌─────────────────────────┼─────────────────────────┐
     │                         │                         │
     ▼                         ▼                         ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ BOOKING HISTORY  │  │     PAYMENTS     │  │   LEDGER ITEMS   │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

### Lifecycle State Machine & Transitions

1. **`Reserved` / `Confirmed`**: Created via walk-in reservation or web booking.
2. **`Checked In`**: Guest checks in, room status transitions to `occupied`.
3. **`Shifted`**: Guest moves room; `bookings.room_id` is updated, and an entry is added to `booking_history`.
4. **`Extended`**: Stay extended; `expected_check_out_date` is updated.
5. **`Checked Out`**: Guest departs; `booking_status` becomes `'Checked Out'`, room status transitions to `'dirty'`.
6. **`Cancelled` / `No Show`**: Booking cancelled or guest fails to show up.

---

## 4. Firestore Repository & Schema Compatibility Audit

### Document Path & Idempotency Strategy
- **Root Collection**: `/bookings/{bookingId}`
- **Deterministic Document ID**: `formatBookingId(booking_number)` -> `bkg_${booking_number}` (e.g. `bkg_BKG-407600`).
- **Subcollection**: `/bookings/{bookingId}/history/{historyId}`
- **Deterministic History Document ID**: `history_${history_id}` (e.g. `history_1786424572`).

### Repository Compatibility
- [`backend/repositories/firestore/bookingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/bookingsRepository.js) provides complete CRUD methods:
  - `createBookingFirestore(bookingData, options)`
  - `updateBookingFirestore(bookingId, bookingData, options)`
  - `updateBookingStatusFirestore(bookingId, bookingStatus, paymentStatus, options)`
  - `deleteBookingFirestore(bookingId, options)`
- [`backend/repositories/firestore/bookingHistoryRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/bookingHistoryRepository.js) provides dual-write methods for both root `booking_history` collection and `/bookings/{bkgId}/history/{histId}` subcollection.

---

## 5. Proposed Phase 3K Dual-Write Outbox Event Architecture

To maintain minimal scope and complete stability, Phase 3K will introduce **5 core outbox event types**:

| Event Type | Trigger Path | Payload Structure | Firestore Repository Method |
| :--- | :--- | :--- | :--- |
| **`BOOKING_CREATED`** | Walk-in check-in / Booking creation | `{ booking_number, guest_id, room_id, room_number, check_in_date, expected_check_out_date, adults, children, total_amount, advance_amount, booking_status, payment_status, mysql_booking_id, updated_at }` | `createBookingFirestore` |
| **`BOOKING_UPDATED`** | Extension, tariff adjustment, room shift | `{ booking_number, room_id, room_number, expected_check_out_date, total_amount, updated_at }` | `updateBookingFirestore` |
| **`BOOKING_STATUS_CHANGED`**| Check-out, cancellation, no-show | `{ booking_number, booking_status, payment_status, check_out_date, updated_at }` | `updateBookingStatusFirestore` |
| **`BOOKING_HISTORY_CREATED`**| Room shift log, status log insertion | `{ booking_number, action, details, changed_by, business_date, mysql_history_id, updated_at }` | `createBookingHistoryFirestore` |
| **`BOOKING_DELETED`** | Factory reset / administrative removal | `{ booking_number, docId, updated_at }` | `deleteBookingFirestore` |

---

## 6. Outbox Staging & Transactional Pattern

Every booking write path in MySQL MUST enclose the outbox staging within the **exact same database transaction**:

```javascript
const connection = await pool.getConnection();
try {
  await connection.beginTransaction();

  // 1. Operational MySQL write
  const [res] = await connection.query(`INSERT INTO bookings (...) VALUES (...)`);
  const bookingId = res.insertId;

  // 2. Outbox event enqueue (Same Transaction!)
  if (isFirestoreDualWriteEnabled()) {
    await enqueue(connection, {
      event_type: 'BOOKING_CREATED',
      aggregate_type: 'BOOKING',
      aggregate_id: String(bookingNumber),
      payload: {
        booking_number: String(bookingNumber),
        guest_id: String(guestId),
        room_id: String(roomId),
        mysql_booking_id: bookingId,
        updated_at: new Date().toISOString()
      }
    });
  }

  // 3. Commit both operational write and outbox event atomically
  await connection.commit();
} catch (error) {
  await connection.rollback(); // Both operational write AND outbox event rolled back!
  throw error;
} finally {
  connection.release();
}
```

---

## 7. Failure & Recovery Matrix (15 Scenarios)

| Failure Scenario | Expected MySQL State | Expected Firestore State | Recovery Mechanism |
| :--- | :--- | :--- | :--- |
| **MySQL Transaction Rollback** | Cleanly rolled back | Unchanged | Outbox event rolled back with MySQL transaction |
| **Firestore Outage / Timeout** | Committed in MySQL | Temporarily stale | Outbox Worker retries up to 5 attempts (`attempts++`) |
| **Outbox Worker Process Crash** | Committed in MySQL | Temporarily stale | Supervisor (PM2/systemd) restarts worker; uncommitted events claimed |
| **Duplicate Event Replay** | Unchanged | Idempotent set/update | `setDoc(merge: true)` handles duplicate events safely |
| **Out-of-Order Event Processing**| Unchanged | Preserves newest state | Stale Event Guard (`isStaleUpdate`) rejects older events |
| **Missing Guest in Firestore** | Committed in MySQL | Partial booking doc | Historical catch-up tool seeds guest profile |
| **Retry Exhaustion (5 Attempts)** | Committed in MySQL | Out of sync | Stays in outbox as `last_error`; admin manual retry tool |

---

## 8. Security & Data Privacy Audit

- **Excluded Sensitive Data**: Passwords, `password_hash`, credit card numbers, payment CVVs, and raw identity document binary data are **strictly excluded** from outbox event payloads.
- **Included Booking PII**: Guest full name, phone number, booking dates, and room details are included in the payload to allow receptionist dashboard lookups.

---

## 9. Historical Catch-Up / Migration Tool Design

Prior to enabling `ENABLE_FIRESTORE_DUAL_WRITE=true` for Bookings:
1. Develop `scripts/migrateBookingsToFirestore.js`.
2. Process existing MySQL `bookings` in batches of 100 records.
3. Transform each record and invoke `createBookingFirestore(data, { merge: true })`.
4. Support `--dry-run` flag to audit catch-up output without modifying Firestore.

---

## 10. Pre-Implementation Test Strategy & Assertions

Create [`backend/tests/testBookingsDualWritePilot.mjs`](file:///d:/projects/hotel/backend/tests/testBookingsDualWritePilot.mjs) verifying:
1. **Creation Staging**: `BOOKING_CREATED` outbox event staged inside transaction.
2. **Rollback Guard**: Zero outbox events committed if transaction rolls back.
3. **Worker Dispatch**: Outbox worker processes `BOOKING_CREATED` and creates `bkg_${booking_number}` in Firestore.
4. **Status Update Integration**: `BOOKING_STATUS_CHANGED` updates Firestore status to `'Checked Out'`.
5. **Room Shift Integration**: Room shift updates `room_id` and creates `/bookings/{bkgId}/history` subcollection document.
6. **Stale Event Protection**: Older timestamp T1 rejected if Firestore already holds T2.
7. **Idempotency Replay**: Re-dispatching exact event causes 0 errors or duplicates.
8. **Clean Deletion**: `BOOKING_DELETED` removes booking document cleanly from Firestore.
9. **Guaranteed Cleanup**: Test rooms, guests, bookings, and outbox rows deleted inside `finally` block.

---

## 11. Objective GO / NO-GO Criteria

### GO Criteria:
- [x] All 11 write paths mapped and transactional boundaries documented.
- [x] Firestore repositories [`bookingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/bookingsRepository.js) and [`bookingHistoryRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/bookingHistoryRepository.js) audited.
- [x] Deterministic document ID strategy (`bkg_${booking_number}`) confirmed.
- [x] Outbox event schema & payload rules defined.
- [x] Stale event protection and idempotency strategy defined.
- [x] Feature flags confirmed to remain `false` by default.

### NO-GO Criteria:
- [ ] Attempting implementation without user plan approval.
- [ ] Enabling `ENABLE_FIRESTORE_DUAL_WRITE` before historical catch-up script execution.

---

## 12. Staged Implementation Roadmap (Design Only)

- **Phase 3K-1**: Outbox Event Dispatcher Integration (`outboxDispatcher.js` switch statement handlers for `BOOKING_*`).
- **Phase 3K-2**: Check-In Write-Path Integration (`checkInService.js` outbox staging).
- **Phase 3K-3**: Check-Out & Status Transition Integration (`roomController.js` outbox staging).
- **Phase 3K-4**: Room Shift & Extension Integration (`roomController.js` outbox staging).
- **Phase 3K-5**: Automated Pilot Test Suite (`testBookingsDualWritePilot.mjs`).
- **Phase 3K-6**: Historical Catch-Up Script (`scripts/migrateBookingsToFirestore.js`).
- **Phase 3K-7**: Verification & Documentation Report.
