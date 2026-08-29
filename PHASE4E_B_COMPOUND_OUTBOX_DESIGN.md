# PHASE 4E-B — Compound Outbox Implementation Design

> **Status:** DESIGN / AUDIT ONLY — No implementation.  
> **Branch:** firebase-migration  
> **Date:** 2026-08-12

---

## Executive Summary

This document is the complete design audit for Phase 4E-B: Compound Outbox Events. It is based on direct inspection of:

- `checkInService.js` — full check-in MySQL transaction
- `roomController.js::checkOut` — full check-out MySQL transaction
- `roomController.js::shift` — full room shift MySQL transaction
- `businessDateService.js::advanceBusinessDate` — night audit / day-end
- `outboxService.js`, `outboxWorker.js`, `outboxDispatcher.js` — outbox infrastructure
- All 21 Firestore repositories in `repositories/firestore/`
- `firestoreUtils.js` — `db`, `setDoc`, `updateDoc`, `batch` support
- `firebaseAdmin.js` — `db` object (Firestore instance)

---

## 1. Current Outbox Infrastructure — Integration Points

### What exists (Phase 4E-A confirmed)

| Component | Role |
| :--- | :--- |
| `outboxService.enqueue(conn, eventData)` | Atomically inserts one event row inside the active MySQL transaction |
| `outboxService.claimNextBatch()` | Claims PENDING + retry-eligible FAILED events |
| `outboxService.reclaimStaleProcessing()` | NEW: recovers orphaned PROCESSING events |
| `outboxService.markProcessed(conn, event_id)` | Sets status = PROCESSED after successful dispatch |
| `outboxService.markFailed(conn, event_id, err)` | Sets status = FAILED or DEAD_LETTER with backoff |
| `outboxWorker.processOutboxBatch()` | Reclaim → Claim → Dispatch → Mark cycle |
| `outboxDispatcher.dispatchEvent(event)` | Routes event_type → individual Firestore repository calls |

### Compound event integration point

A compound event is one call to `enqueue()`. The outbox schema stores it as a single row with one `event_type = 'COMPOUND'` and a `payload` containing the array of writes. The dispatcher receives the entire payload and executes a `db.batch().commit()` for all writes atomically.

**No schema change is required.** The `payload` column is a JSON TEXT field of effectively unlimited size (MySQL LONGTEXT in practice; audit confirms it is a `TEXT` column in migration 008). This is sufficient for compound payloads up to ~65KB, which is well above the maximum realistic compound event size calculated in §12.

---

## 2. Compound Event Schema — Final Design

```jsonc
{
  // ── Standard outbox envelope (unchanged) ──────────────────────────────
  "event_id":       "evt_compound_checkin_1723456789_a3f2c1",
  "event_type":     "COMPOUND_CHECKIN",           // UPPER_SNAKE discriminator
  "aggregate_type": "BOOKING",
  "aggregate_id":   "BKG-123456",                 // booking_number
  "schema_version": 1,

  // ── Compound-specific header ───────────────────────────────────────────
  "operation_id":   "op_checkin_1723456789_a3f2c1", // globally unique, used for idempotency logs
  "occurred_at":    "2026-08-12T09:45:00.000Z",     // MySQL COMMIT wall-clock ISO
  "business_date":  "2026-08-12",

  // ── Write set (ordered — dispatcher applies in sequence) ─────────────
  "writes": [
    {
      "seq":         1,               // order enforced; no write depends on a previous result
      "collection":  "bookings",      // root collection
      "subcollection": null,          // null = root write
      "parent_id":   null,            // null = root write
      "document_id": "bkg_BKG-123456",
      "operation":   "set_merge",     // "set_merge" | "update" | "delete"
      "data": {
        "booking_number": "BKG-123456",
        "booking_status": "Checked In",
        "guest_id": "guest_9876543210",
        "room_id":  "room_101",
        "check_in_date": "2026-08-12",
        "total_amount": 2500,
        "advance_amount": 1000,
        "payment_status": "Partial"
      }
    },
    {
      "seq":         2,
      "collection":  "rooms",
      "subcollection": null,
      "parent_id":   null,
      "document_id": "room_101",
      "operation":   "set_merge",
      "data": {
        "status": "occupied",
        "current_booking_id": "bkg_BKG-123456",
        "updated_at": "2026-08-12T09:45:00.000Z"
      }
    },
    {
      "seq":         3,
      "collection":  "ledger_items",
      "subcollection": null,
      "parent_id":   null,
      "document_id": "ledger_1001",          // deterministic: ledger_{mysql_id}
      "operation":   "set_merge",
      "data": {
        "item_id": "ledger_1001",
        "booking_id": "bkg_BKG-123456",
        "description": "Room Tariff (Incl. GST)",
        "amount": 2500,
        "business_date": "2026-08-12"
      }
    },
    {
      "seq":         4,
      "collection":  "bookings",            // subcollection write
      "subcollection": "ledger_items",
      "parent_id":   "bkg_BKG-123456",
      "document_id": "ledger_1001",
      "operation":   "set_merge",
      "data": { /* same as seq 3 */ }
    },
    {
      "seq":         5,
      "collection":  "settings",
      "subcollection": null,
      "parent_id":   null,
      "document_id": "system_date",
      "operation":   "set_merge",
      "data": {
        "today_checkins": 3            // ABSOLUTE VALUE — read from MySQL after increment
      }
    }
    // ... more writes
  ]
}
```

### Required Fields

| Field | Type | Notes |
| :--- | :--- | :--- |
| `event_type` | string | `COMPOUND_*` discriminator |
| `aggregate_type` | string | Primary domain: `BOOKING`, `ROOM`, `NIGHT_AUDIT` |
| `aggregate_id` | string | Primary entity: booking_number, room_number |
| `schema_version` | int | `1` — future-proofs schema evolution |
| `operation_id` | string | Same format as `event_id`; logged separately for idempotency auditing |
| `occurred_at` | ISO string | Wall-clock at MySQL COMMIT |
| `business_date` | YYYY-MM-DD | Hotel business date at time of operation |
| `writes` | array | Ordered array of write descriptors |

### Write Descriptor Fields

| Field | Type | Notes |
| :--- | :--- | :--- |
| `seq` | int | Enforces write ordering in batch; no write depends on a prior result |
| `collection` | string | Firestore root collection |
| `subcollection` | string or null | If non-null, writes to `collection/parent_id/subcollection/document_id` |
| `parent_id` | string or null | Required when `subcollection != null` |
| `document_id` | string | Deterministic ID — must be computed from MySQL primary keys |
| `operation` | `set_merge` / `update` / `delete` | `set_merge` is preferred for idempotency |
| `data` | object | Absolute values only — NO `FieldValue.increment()` |

---

## 3. Firestore WriteBatch — Verified Capability

### How `db` is obtained

`firebaseAdmin.js` exports `db = getFirestore(firebaseApp)`. This is the standard Firebase Admin SDK `Firestore` instance.

```javascript
const batch = db.batch();
```

`db.batch()` returns a `WriteBatch` object. Firebase Admin SDK documentation confirms:

- `batch.set(ref, data, { merge: true })` — idempotent upsert
- `batch.update(ref, data)` — update existing fields
- `batch.delete(ref)` — delete document
- `batch.commit()` — atomic commit of all staged writes

### Limits

| Limit | Value | Notes |
| :--- | :--- | :--- |
| Operations per batch | **500** | Hard Firebase limit |
| Maximum request size | **9.8 MB** | Rarely approached in HPMS context |
| Document size | **1 MB** | Not a concern for current document shapes |

### Idempotency of batch

`batch.commit()` is atomic: either all writes succeed or none do. If `commit()` throws, no document is changed. This means a retry of the same batch is safe as long as the write operations themselves are idempotent (covered in §4).

### `FieldValue.increment()` in `WriteBatch`

Confirmed: `FieldValue.increment()` is a valid server-side transform for `batch.set()` and `batch.update()`. However, it is **NOT retry-safe** (see §5). The design uses absolute values instead.

---

## 4. Idempotency — Critical Analysis

### The crash scenario

```
batch.commit()          → succeeds (Firestore is written)
  ↓ worker crash
markProcessed()         → never executes
  ↓ outbox worker restarts
reclaimStaleProcessing() → event moves PROCESSING → FAILED
  ↓
same event is re-dispatched
batch.commit()          → runs AGAIN on already-written documents
```

The second execution must produce the same final Firestore state.

### Analysis by operation type

| Operation | Retry-safe? | Why |
| :--- | :--- | :--- |
| `batch.set(ref, data, { merge: true })` | ✅ YES | Overwrites with same values. If `data` is deterministic (absolute values), second call = same result. |
| `batch.update(ref, data)` | ✅ YES (if deterministic) | Same fields, same values. Only fails if document doesn't exist — which shouldn't happen in normal flow. |
| `batch.delete(ref)` | ✅ YES | Deleting an already-deleted document is a no-op. |
| `FieldValue.increment(1)` | ❌ NO | Each re-execution increments again. `today_checkins` becomes 2 on retry. |
| `FieldValue.serverTimestamp()` | ❌ NO | Different timestamps on each execution. Use `occurred_at` from payload instead. |

**Rule: All write data in compound events must use absolute, pre-computed values read from MySQL immediately before COMMIT.**

### Document ID determinism

All Firestore document IDs are deterministic:

| Entity | ID Format |
| :--- | :--- |
| Booking | `bkg_{booking_number}` |
| Room | `room_{room_number}` |
| Guest | `guest_{phone}` |
| Ledger Item | `ledger_{mysql_id}` — requires MySQL AUTO_INCREMENT `id` at enqueue time |
| Payment | `payment_{mysql_id}` — requires MySQL AUTO_INCREMENT `id` |
| Invoice | `inv_{invoice_number}` |
| Reservation | `res_{reservation_number}` |
| Booking History | `history_{mysql_id}` |
| Settings | `system_date` (fixed) |

> [!IMPORTANT]
> **Ledger and payment document IDs require the MySQL `lastInsertId` to be captured BEFORE enqueue.** The current dispatcher generates random IDs for payments and ledger items. For compound events, the MySQL `id` must be captured immediately after each INSERT and embedded in the payload.

### Subcollection write idempotency

Both payments and ledger items write to:
1. Root collection: `payments/{payment_id}` and `ledger_items/{ledger_id}`
2. Subcollection: `bookings/{bkg_id}/payments/{payment_id}` and `bookings/{bkg_id}/ledger_items/{ledger_id}`

Both are separate `batch.set(ref, data, { merge: true })` calls. Both are idempotent as long as document IDs are deterministic (see above).

---

## 5. Critical Counters — Absolute Values Only

### `today_checkins` and `today_checkouts`

**Current MySQL implementation:**
```sql
UPDATE system_settings
SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR)
WHERE key_name = 'today_checkins'
```

This is a read-modify-write in MySQL, protected by the MySQL transaction lock. MySQL is the authority.

**Current Firestore implementation (existing dispatcher):**  
`SYSTEM_SETTING_UPDATED` events call `updateSystemSettingFirestore()`, which calls `setDoc(..., { merge: true })` with whatever value is in the payload. The current outbox enqueue for settings does not enqueue these counter changes.

**Why `FieldValue.increment()` must NOT be used:**

1. **Not idempotent.** A worker crash after Firestore write but before `markProcessed()` causes the event to be re-dispatched. If the batch contains `FieldValue.increment(1)`, `today_checkins` becomes N+2 instead of N+1.
2. **MySQL is the authority.** The Firestore counter must mirror MySQL, not compute its own value.

**Required approach:**

After the MySQL `UPDATE system_settings ... + 1`, immediately SELECT the new absolute value:
```sql
SELECT value_val FROM system_settings WHERE key_name = 'today_checkins'
```
Embed this absolute value in the compound event payload:
```json
{
  "document_id": "system_date",
  "operation":   "set_merge",
  "data": {
    "today_checkins": 3   // absolute value from MySQL
  }
}
```

On retry, the batch writes `today_checkins = 3` again — idempotent.

### `continued_rooms`

Same analysis. Night Audit sets `continued_rooms = occupiedRooms.length` (already an absolute value assignment in MySQL). Use the same pattern.

---

## 6. Check-In — Exact Firestore Batch Design

### MySQL writes in `processCheckIn()` (confirmed by code inspection)

| Step | MySQL Table | Operation | Notes |
| :--- | :--- | :--- | :--- |
| 2 | `rooms` | `SELECT ... FOR UPDATE` | Lock room |
| 3 | `reservations` | `SELECT ... FOR UPDATE` | Optional |
| 4 | `guests` | `SELECT` / `INSERT` | Guest upsert |
| 5 | `bookings` | `INSERT` | Core booking row |
| 6 | `reservations` | `UPDATE status='Checked-In'` | If reservation exists |
| 7 | `ledger_items` | `INSERT` | Room Tariff (Incl. GST) |
| 8 | `cash_logs` | `INSERT` | If Cash deposit > 0 |
| 8 | `payments` | `INSERT` | If deposit > 0 |
| 9 | `rooms` | `UPDATE status='occupied'` | Room status change |
| 9 | `room_status_history` | `INSERT` | Audit trail |
| 9 | `system_settings` | `UPDATE today_checkins += 1` | Counter |
| 10 | `audit_logs` | `INSERT` | CHECK_IN entry |
| 10 | `notifications` | `INSERT` | If guest self check-in |

### Required Firestore batch (compound event: `COMPOUND_CHECKIN`)

All writes are `set_merge` for idempotency. All IDs are deterministic from MySQL IDs captured at enqueue time.

| seq | collection | subcollection | document_id | data fields |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `bookings` | — | `bkg_{booking_number}` | booking_number, guest_id, room_id, room_number, check_in_date, expected_check_out_date, adults, children, booking_status, payment_status, total_amount, advance_amount, billing_instruction, meal_plan, mysql_booking_id, occurred_at |
| 2 | `guests` | — | `guest_{phone}` | full_name, phone, email, address, country, mysql_guest_id, updated_at |
| 3 | `rooms` | — | `room_{room_number}` | status='occupied', current_booking_id, updated_at |
| 4 | `ledger_items` | — | `ledger_{mysql_id}` | item_id, booking_id, room_number, description, amount, business_date, mysql_booking_id |
| 5 | `bookings` | `ledger_items` | `ledger_{mysql_id}` | (same as seq 4) |
| 6 | `settings` | — | `system_date` | today_checkins={absolute value} |
| 7 (conditional) | `payments` | — | `payment_{mysql_id}` | If deposit > 0 |
| 8 (conditional) | `bookings` | `payments` | `payment_{mysql_id}` | If deposit > 0 |
| 9 (conditional) | `reservations` | — | `res_{reservation_number}` | status='Checked-In', booking_id |

**Maximum writes (with deposit + reservation): 9**  
**Minimum writes (no deposit, no reservation): 6**  
Well within the 500-write Firestore limit.

> [!IMPORTANT]
> **booking_history is NOT included in the Check-In compound event.** Check-In does not currently create a booking_history record. Only Check-Out and Room Shift create `booking_history` entries. Do not add booking_history to Check-In compound event unnecessarily.

---

## 7. Check-Out — Exact Firestore Batch Design

### MySQL writes in `checkOut()` (confirmed by code inspection)

| Step | MySQL Table | Operation | Notes |
| :--- | :--- | :--- | :--- |
| — | `rooms` | `SELECT ... FOR UPDATE` | Lock room |
| — | `bookings` | `SELECT ... FOR UPDATE` | Get active booking |
| — | `cash_logs` | `INSERT` | If balancePaid != 0 |
| — | `payments` | `INSERT` | If balancePaid != 0 |
| — | `bookings` | `UPDATE` | status='Checked Out', payment_status='Paid', total_amount, check_out_date |
| — | `invoices` | `INSERT ... ON DUPLICATE KEY UPDATE` | Invoice creation |
| — | `room_status_history` | `INSERT` | Audit trail: occupied → dirty |
| — | `audit_logs` | `INSERT` | CHECK_OUT entry |
| — | `rooms` | `UPDATE` | status='dirty', housekeeping_status='Dirty', housekeeping_priority='High Priority' |
| — | `booking_history` | `INSERT` | CHECKED_OUT event |
| — | `notifications` | `INSERT` | If guestUserId exists |
| — | `system_settings` | `UPDATE today_checkouts += 1` | Counter |
| — | checkout_snapshots | `INSERT` (via CheckoutRecoveryService) | Internal snapshot — MySQL only |

### Required Firestore batch (compound event: `COMPOUND_CHECKOUT`)

| seq | collection | subcollection | document_id | data fields |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `bookings` | — | `bkg_{booking_number}` | booking_status='Checked Out', payment_status='Paid', total_amount, check_out_date, updated_at |
| 2 | `rooms` | — | `room_{room_number}` | status='dirty', housekeeping_status='Dirty', housekeeping_priority='High Priority', current_booking_id=null, updated_at |
| 3 | `invoices` | — | `inv_{invoice_number}` | invoice_number, booking_id, total_amount, paid_amount, balance_due=0, status='Paid', business_date |
| 4 (conditional) | `payments` | — | `payment_{mysql_id}` | If balancePaid != 0 |
| 5 (conditional) | `bookings` | `payments` | `payment_{mysql_id}` | If balancePaid != 0 |
| 6 (conditional) | `cash_logs` | — | `cash_log_{mysql_id}` | If balancePaid != 0 |
| 7 | `booking_history` | — | `history_{mysql_id}` | action='CHECKED_OUT', booking_id, details, business_date |
| 8 | `bookings` | `history` | `history_{mysql_id}` | (same as seq 7) |
| 9 | `settings` | — | `system_date` | today_checkouts={absolute value} |

**Maximum writes (with payment + cash log): 9**  
**Minimum writes (no balance): 6**  
Well within the 500-write limit.

> [!NOTE]
> `checkout_snapshots` is a MySQL-only recovery mechanism. It does NOT need to be replicated to Firestore. The dispatcher already handles `CHECKOUT_SNAPSHOT_CREATED` as a separate event for Firestore when dual-write is enabled, but it is intentionally NOT part of the compound transaction write set.

---

## 8. Room Shift — Exact Firestore Batch Design

### MySQL writes in `shift()` (confirmed by code inspection)

| MySQL Table | Operation | Notes |
| :--- | :--- | :--- |
| `rooms` (both) | `SELECT ... FOR UPDATE` | Lock both rooms in ID order |
| `bookings` | `SELECT ... FOR UPDATE` | Get active booking |
| `bookings` | `UPDATE room_id` | Move booking to new room |
| `rooms` (target) | `UPDATE status='occupied'` | Target room is now occupied |
| `rooms` (source) | `UPDATE status='vacant'` | Source room is now vacant |
| `ledger_items` | `DELETE tariff for source room on business_date` | Remove current day's tariff |
| `ledger_items` | `UPDATE room_number` | Move all ledger items to target room |
| `ledger_items` | `INSERT` target room tariff | New tariff for target room |
| `room_status_history` | `INSERT` source: occupied → vacant | Audit trail |
| `room_status_history` | `INSERT` target: vacant → occupied | Audit trail |
| `audit_logs` | `INSERT` | SHIFT_ROOM entry |

### Required Firestore batch (compound event: `COMPOUND_SHIFT`)

> [!WARNING]
> Room shift modifies **all existing ledger items** for the booking (UPDATE room_number). These cannot be modelled as deletes + re-inserts because the existing documents' MySQL IDs are needed. The compound event must carry the full list of ledger item IDs and their new `room_number`.

| seq | collection | subcollection | document_id | data fields |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `bookings` | — | `bkg_{booking_number}` | room_id='room_{to}', room_number=to_room, updated_at |
| 2 | `rooms` | — | `room_{from_room}` | status='vacant', current_booking_id=null, updated_at |
| 3 | `rooms` | — | `room_{to_room}` | status='occupied', current_booking_id='bkg_{booking_number}', updated_at |
| 4..N | `ledger_items` | — | `ledger_{id}` for each existing item | room_number=to_room_number |
| 4..N | `bookings` | `ledger_items` | `ledger_{id}` | room_number=to_room_number (subcollection mirror) |
| N+1 | `ledger_items` | — | `ledger_{new_tariff_mysql_id}` | New tariff for target room |
| N+2 | `bookings` | `ledger_items` | `ledger_{new_tariff_mysql_id}` | New tariff (subcollection) |

**Maximum writes per shift:** Depends on number of existing ledger items (one per day of stay). For a 10-day stay: 3 room/booking writes + 10×2 ledger updates + 2 new tariff writes = **25 writes**. Still well within 500. For a 60-day stay: 3 + 60×2 + 2 = **125 writes**. Safe.

**Open question:** The existing MySQL query deletes the current day's tariff from the source room but does NOT delete it from Firestore. The compound event should either:
- a) `delete` the old tariff document from Firestore (requires knowing its `mysql_id`)
- b) Use `update` to modify its `room_number` to the target room (consistent with the other ledger item updates)

**Recommendation: option (b).** Delete operations can fail for soft-delete scenarios and the ledger item is still valid data — it just needs to move to the new room number. The MySQL query also does UPDATE for existing items (not delete them all). The only deletion is of the current business date tariff for the source room — this tariff will be re-created with the target room's rate. The simplest approach is to `update` its room_number field rather than delete + recreate. This maintains the ledger history.

> [!IMPORTANT]
> The compound event enqueue for Room Shift must SELECT all existing ledger item IDs for the booking after the UPDATE and before COMMIT. This is the only way to build the deterministic write set.

---

## 9. Booking / Reservation — Single vs Compound Events

### Booking creation (Walk-in advance booking via `bookRoom()`)

**Analysis:** `bookRoom()` creates a booking row (status='booked'), optionally a guest, and optionally a payment. No room status changes (room remains 'booked' status in MySQL).

**Recommendation: SINGLE EVENT (`BOOKING_CREATED`)**

The current `BOOKING_CREATED` event already exists in the dispatcher. The write count is:
- 1 booking document
- 1 guest document (conditional)
- 1 payment document (conditional)
- 1 booking/payments subcollection (conditional)

**Max: 4 writes. No compound event needed.** The current single-event pattern is sufficient.

### Reservation creation

**Analysis:** Reservation creation writes one `reservations` row, optionally a guest row. Small, non-transactional across multiple booking-critical tables.

**Recommendation: SINGLE EVENT (`RESERVATION_CREATED`)**. No compound event needed.

### Booking update

**Recommendation: SINGLE EVENT (`BOOKING_UPDATED`)**. Updates are typically single-field changes.

### Check-In (reservation-based path)

When a guest checks in from a reservation, the MySQL transaction touches: booking, reservation, guest, room, ledger, payment (optional). This justifies a compound event.

**Recommendation: `COMPOUND_CHECKIN` covers this path completely.** The `reservations` write is already listed as conditional seq 9 in §6.

---

## 10. Payments / Ledger / Invoice — Dual Representation

### Current architecture (verified)

Both `paymentsRepository.js` and `ledgerRepository.js` write to:
1. **Root collection:** `payments/{payment_id}` / `ledger_items/{ledger_id}`
2. **Subcollection:** `bookings/{bkg_id}/payments/{payment_id}` / `bookings/{bkg_id}/ledger_items/{ledger_id}`

The `bookingHistoryRepository.js` similarly writes to:
1. Root: `booking_history/{history_id}`
2. Subcollection: `bookings/{bkg_id}/history/{history_id}`

### Consistency strategy

One compound event `payload.writes[]` contains both the root write and the subcollection write as separate, sequential write descriptors (same `document_id`, different `collection`/`subcollection`/`parent_id` values).

Since `db.batch()` is atomic, both the root write and subcollection write will either both succeed or both fail — guaranteeing dual-representation consistency.

```json
[
  { "seq": 4, "collection": "payments",  "subcollection": null,       "document_id": "payment_42", "data": {...} },
  { "seq": 5, "collection": "bookings",  "subcollection": "payments", "parent_id": "bkg_BKG-123", "document_id": "payment_42", "data": {...} }
]
```

**Risk eliminated:** Under the current per-event dispatcher model, a root write succeeds and then the subcollection write fails, leaving them inconsistent. With a compound WriteBatch, both succeed or neither does.

---

## 11. Night Audit — Safe Strategy

### What `advanceBusinessDate()` does (confirmed by code inspection)

| Step | MySQL Table | Operation | Notes |
| :--- | :--- | :--- | :--- |
| Lock | `system_settings` | `SELECT ... FOR UPDATE` | Concurrent Day End prevention |
| Per occupied room | `ledger_items` | `INSERT` rollover tariff | **One INSERT PER occupied room** |
| — | `system_settings` | `UPDATE system_date` | Date advance |
| — | `system_settings` | `UPDATE continued_rooms` | Absolute value |
| — | `system_settings` | `UPDATE today_checkins='0'` | Reset |
| — | `system_settings` | `UPDATE today_checkouts='0'` | Reset |
| — | `audit_logs` | `INSERT` | DAY_END entry |

### Batch size calculation

For Night Audit, the Firestore write count scales with **number of occupied rooms**:

| Domain | Writes per audit |
| :--- | :--- |
| 1 ledger item per occupied room (root) | N |
| 1 subcollection ledger item per occupied room | N |
| settings/system_date (date, checkins=0, checkouts=0, continued_rooms) | 1 |

**Total: 2N + 1 writes** where N = occupied rooms.

For a 150-room hotel at 90% occupancy (135 rooms):  
`2 × 135 + 1 = 271 writes` — safe within 500.

For the upper bound at 100% occupancy (all 150 rooms):  
`2 × 150 + 1 = 301 writes` — still safe.

**Verdict: A single `db.batch()` is safe for Night Audit for this hotel's room count.**

> [!IMPORTANT]
> However, Night Audit has a fundamentally different risk profile than Check-In/Check-Out:
> - **Night Audit is a cross-booking, cross-room operation.** A single compound event touches N rooms and N ledger items.
> - **Night Audit already has idempotency protection in MySQL** (`SELECT id FROM ledger_items WHERE ... LIKE 'Room Tariff%Rollover%'`). A re-dispatched Night Audit event would write the same ledger documents again — idempotent via `set_merge`.
> - **Recommended Phase:** Night Audit compound event should be implemented LAST (Phase 4E-B7) after Check-In and Check-Out are validated. The complexity of carrying potentially 135 ledger item IDs in a single JSON payload warrants a separate validation cycle.

### Alternative: Phase 4E-B-NA — Night Audit Snapshot Strategy

Instead of embedding all ledger item IDs in the compound event, Night Audit could use a snapshot strategy:

1. Enqueue a `NIGHT_AUDIT_RAN` event with the summary: `{ business_date, next_date, occupied_rooms: [{room_number, booking_id, tariff_amount, ledger_mysql_id}] }`
2. The dispatcher builds the WriteBatch from this snapshot.

This is identical to a compound event in structure but distinguishes Night Audit semantically from the real-time operational compound events. **Recommended: use the same compound schema.** The snapshot is the payload.

---

## 12. Event Size / Batch Limits — Realistic Calculations

| Operation | Write Count | Estimated Payload Size | Status |
| :--- | :--- | :--- | :--- |
| Check-In (no deposit, no reservation) | 6 | ~3 KB | ✅ Safe |
| Check-In (with deposit + reservation) | 9 | ~5 KB | ✅ Safe |
| Check-Out (no balance) | 6 | ~3 KB | ✅ Safe |
| Check-Out (with balance payment) | 9 | ~5 KB | ✅ Safe |
| Room Shift (3-day stay, 3 ledger items) | 11 | ~6 KB | ✅ Safe |
| Room Shift (30-day stay, 30 ledger items) | 65 | ~35 KB | ✅ Safe |
| Room Shift (60-day stay, 60 ledger items) | 125 | ~68 KB | ✅ Safe (well under 9.8 MB) |
| Night Audit (100 rooms) | 201 | ~80 KB | ✅ Safe |
| Night Audit (150 rooms) | 301 | ~120 KB | ✅ Safe |
| Night Audit (500 rooms — theoretical max) | 1001 | ~400 KB | ❌ EXCEEDS 500-write limit |

**Conclusion for current hotel:** All operations are well within Firestore's 500-write batch limit. The only scenario that could exceed the limit is a hotel with >249 simultaneously occupied rooms running Night Audit. At Sky5's current scale this is not a concern, but a guard should be added that splits into two batches if N > 249.

---

## 13. Failure Matrix

| Scenario | Expected Result | Risk | Protection |
| :--- | :--- | :--- | :--- |
| 1. MySQL transaction rollback | No outbox event enqueued. No Firestore write. | None — consistent. | MySQL ROLLBACK before `enqueue()`. |
| 2. MySQL COMMIT succeeds, enqueue succeeds | Event is PENDING. Worker will dispatch. | None — safe state. | Normal outbox lifecycle. |
| 3. Worker crashes before Firestore write | Event stays PROCESSING. `reclaimStaleProcessing()` → FAILED. Normal retry. | Temporary delay only. | Phase 4E-A lease recovery. |
| 4. Firestore batch failure (`batch.commit()` throws) | `markFailed()` called. Event → FAILED. Retry with backoff. | None — MySQL not affected. | `try/catch` in `processOutboxBatch`. |
| 5. `batch.commit()` succeeds, worker crashes before `markProcessed()` | Event stays PROCESSING. Lease recovery → FAILED. Event re-dispatched. All `set_merge` writes are idempotent. | Counter increment risk if `FieldValue.increment()` used — **mitigated by absolute values**. | Absolute counter values in payload. |
| 6. Duplicate event (same `event_id` enqueued twice) | `ER_DUP_ENTRY` on second `enqueue()`. First enqueue is processed. | None — caught by `enqueue()`. | MySQL `UNIQUE(event_id)` constraint. |
| 7. Out-of-order events for same booking | Each event is a self-contained state snapshot with `updated_at`. Stale-update guards in `bookingsRepository.js` and `roomsRepository.js` reject older writes. | Minor: brief inconsistency window. | `isStaleUpdate()` guards in repos. |
| 8. Concurrent events for same booking (two receptionists) | MySQL `SELECT ... FOR UPDATE` prevents concurrent check-in/check-out on same booking. At Firestore level, second write arrives after first — `set_merge` overwrites. | None for operations guarded by MySQL locks. | MySQL row-level locking. |
| 9. Concurrent events for same room | MySQL `SELECT ... FOR UPDATE` on rooms table with deterministic lock ordering prevents deadlock. Loser gets rollback. | None — MySQL handles concurrency. | `FOR UPDATE` on rooms in ID order. |
| 10. Retry after partial application | `set_merge` means partial state is overwritten to correct state. Absolute values restore counters correctly. | None if all writes are `set_merge` + deterministic IDs. | Protocol guarantees in compound event schema. |

---

## 14. Concurrency — Explicit Analysis

### Firestore WriteBatch vs MySQL SELECT FOR UPDATE

**Firestore WriteBatch provides atomicity within Firestore.**  
It does NOT provide:
- Read isolation
- Locking of documents between the query that builds the payload and the batch.commit()
- Prevention of interleaved Firestore writes from other sources

**MySQL continues to provide all concurrency control:**

| Scenario | MySQL Protection | Firestore Impact |
| :--- | :--- | :--- |
| Two receptionists check in same room | Second transaction sees room.status='occupied', throws `ALREADY_CHECKED_IN` before `enqueue()` | No Firestore write from loser |
| Two payments for same booking | Each gets a separate MySQL payment row with unique `id`. Both outbox events are independent. | Two separate payment documents created — correct |
| Room shift + simultaneous check-in to target room | MySQL `FOR UPDATE` on target room; check-in sees 'occupied' (from shift transaction holding lock) or 'vacant' (shift not yet committed). Correct in both cases. | No conflict |
| Night Audit + reception check-in | MySQL lock on `system_settings` during Night Audit. Check-in reads business date from the same connection — consistent. | Both compound events queued; processed sequentially by worker |
| Two Night Audits simultaneously | Duplicate prevention: `SELECT ... WHERE action='DAY_END' AND business_date=?`. Second throws `BD_ALREADY_RAN`. | No second compound event enqueued |

**Conclusion:** MySQL handles all concurrency. Firestore batches are downstream replication — they do not need to implement locking.

---

## 15. Exact File Impact

### Files that WILL need modification

| File | Current Responsibility | Proposed Modification | Risk |
| :--- | :--- | :--- | :--- |
| [`outboxDispatcher.js`](file:///d:/projects/hotel/backend/services/outboxDispatcher.js) | Routes individual event types | Add `case 'COMPOUND_*':` handlers; build `db.batch()` from `payload.writes[]`; commit atomically | Medium — central routing hub |
| [`checkInService.js`](file:///d:/projects/hotel/backend/services/checkInService.js) | MySQL check-in transaction | Add `enqueue(conn, COMPOUND_CHECKIN_payload)` before COMMIT; capture MySQL IDs | Low — only adds one `enqueue()` call |
| [`roomController.js::checkOut`](file:///d:/projects/hotel/backend/controllers/roomController.js) | MySQL check-out transaction | Add `enqueue(conn, COMPOUND_CHECKOUT_payload)` before `connection.commit()` | Low — one `enqueue()` call |
| [`roomController.js::shift`](file:///d:/projects/hotel/backend/controllers/roomController.js) | MySQL room shift transaction | Add `enqueue(conn, COMPOUND_SHIFT_payload)` before `connection.commit()`; must SELECT existing ledger item IDs after UPDATE | Medium — needs extra SELECT in transaction |
| [`businessDateService.js::advanceBusinessDate`](file:///d:/projects/hotel/backend/services/businessDateService.js) | Night audit MySQL transaction | Add `enqueue(conn, COMPOUND_NIGHT_AUDIT_payload)` before caller's commit; carry ledger MySQL IDs | Medium — larger payload |

### New files required

| File | Purpose | Risk |
| :--- | :--- | :--- |
| `backend/services/compoundEventBuilder.js` | Pure functions that build compound event payloads from MySQL result objects. Keeps business logic out of dispatcher. | Low — pure functions, no side effects |
| `backend/tests/testPhase4EBCompoundEvents.mjs` | Compound event tests (see §17) | Low |

### Files that MUST NOT change

| File | Reason |
| :--- | :--- |
| MySQL schema migrations | No schema changes permitted |
| Firestore rules | Not in scope |
| Firestore indexes | No new compound queries |
| `roomController.js::bookRoom` | Single events sufficient; already handled |
| `roomController.js::clean` | Read-only for Firestore |
| Frontend | Not affected |
| Electron | Not affected |
| `featureFlags.js` | No new flags needed |
| `outboxService.js` (Phase 4E-A) | Do not modify; compound events use existing `enqueue()` |
| `outboxWorker.js` (Phase 4E-A) | Do not modify; compound events dispatched by existing worker cycle |

---

## 16. Implementation Phases — Recommended Sequence

The sequence minimises risk by building shared infrastructure first, then validating with the simplest transactional domain before moving to more complex ones.

### 4E-B1: Generic WriteBatch Dispatcher

**File:** `outboxDispatcher.js`  
**Task:** Add a generic `COMPOUND_*` dispatch handler that:
1. Parses `payload.writes[]`
2. Builds a `db.batch()`
3. Resolves each write to the correct `batch.set()` / `batch.update()` / `batch.delete()`
4. Calls `batch.commit()`

No business logic in the dispatcher — it only translates the declarative write set.

**Test:** Unit test with a mock `db.batch()` object.

### 4E-B2: `compoundEventBuilder.js` — Shared Infrastructure

**File:** `backend/services/compoundEventBuilder.js`  
**Task:** Implement pure builder functions:
- `buildCheckInCompoundEvent(mysqlResults, mysqlIds)` → payload
- `buildCheckOutCompoundEvent(mysqlResults, mysqlIds)` → payload
- `buildShiftCompoundEvent(mysqlResults, mysqlIds, existingLedgerItems)` → payload
- `buildNightAuditCompoundEvent(occupiedRooms, newLedgerIds, newDate)` → payload

**Test:** Pure function unit tests — no DB, no Firestore.

### 4E-B3: Check-In Compound Event (pilot)

**Files:** `checkInService.js`  
**Task:** After all MySQL writes in `processCheckIn()`, before returning, call:
```javascript
if (isFirestoreDualWriteEnabled()) {
  await enqueue(connection, buildCheckInCompoundEvent(results, ids));
}
```
MySQL IDs needed: `bookingId`, `ledgerItemId` (from `INSERT INTO ledger_items`), `paymentId` (if deposit).

**Tests:** Integration test against local MySQL with `ENABLE_FIRESTORE_DUAL_WRITE=false`.

### 4E-B4: Check-Out Compound Event

**Files:** `roomController.js::checkOut`  
**Task:** Same pattern as 4E-B3. MySQL IDs needed: `paymentId`, `cash_log id`, `invoiceNumber`, `booking_history id`.

### 4E-B5: Room Shift Compound Event

**Files:** `roomController.js::shift`  
**Task:** After all MySQL writes, SELECT existing ledger items, build compound event.  
Additional complexity: carry all `ledger_{mysql_id}` for room_number updates.

### 4E-B6: Booking Creation (refinement if needed)

**Assessment:** Current single events may be sufficient. Decide after 4E-B3 validates the compound pattern.

### 4E-B7: Night Audit Compound Event

**Files:** `businessDateService.js::advanceBusinessDate`  
**Task:** After all occupied room ledger inserts, build compound event with all ledger item MySQL IDs.  
Add guard: if `occupiedRooms.length > 249`, split into two batches (two compound events enqueued sequentially in same transaction).

### 4E-B8: Reconciliation / Verification

Run reconciliation queries (MySQL counts vs Firestore document counts) for each compound event domain.

---

## 17. Test Strategy

### 4E-B1: Generic dispatcher tests

| Test | Expectation |
| :--- | :--- |
| Valid `writes[]` with `set_merge` ops | `batch.commit()` called with correct refs and data |
| `update` op on non-existent document | `batch.update()` registered; error propagates on commit |
| `delete` op | `batch.delete()` registered |
| Empty `writes[]` | No batch created; no error |
| `writes[]` > 500 items | Error thrown before batch creation |
| Retry of successful event | `set_merge` writes idempotently — same state |

### 4E-B2: Builder function tests

| Test | Expectation |
| :--- | :--- |
| `buildCheckInCompoundEvent` with deposit | 9-write payload, no FieldValue references |
| `buildCheckInCompoundEvent` without deposit | 6-write payload |
| `buildCheckInCompoundEvent` with reservation | includes reservation write |
| All counter writes use absolute values | No `FieldValue.increment()` in any write |
| All document IDs are deterministic | Same inputs → same IDs |

### 4E-B3: Check-In compound event integration tests

| Test | Expectation |
| :--- | :--- |
| Check-In with flag OFF | No outbox event enqueued |
| Check-In with flag ON (flag=true, emulator) | 1 compound event in outbox, PENDING |
| Dispatch compound event | All Firestore documents created/updated |
| Retry dispatch | Same Firestore state (idempotent) |
| Worker crash simulation (mark as stale PROCESSING) | reclaimStaleProcessing → retry → same Firestore state |
| today_checkins absolute value | Counter reflects MySQL value, not +1 on each retry |

### 4E-B4–7: Domain-specific tests

Same pattern for Check-Out, Room Shift, Night Audit with domain-specific assertions.

### Concurrency tests

| Test | Expectation |
| :--- | :--- |
| Two concurrent Check-Ins for same room | Second throws `ALREADY_CHECKED_IN`, only 1 outbox event created |
| Root + subcollection consistency | Both written or neither — verify via Firestore read after commit |
| Night Audit + concurrent Check-In | Both compound events queued, processed sequentially, no counter corruption |

---

## 18. Final Verdict

### APPROVE WITH CHANGES

The compound outbox architecture is fundamentally sound. The following changes are required before implementation begins:

#### Required before implementation

1. **Absolute counter values** — The compound event payload MUST carry pre-read MySQL counter values (SELECT after UPDATE). `FieldValue.increment()` MUST NOT appear in compound event write descriptors.

2. **Deterministic ledger/payment IDs** — MySQL `lastInsertId` for every `ledger_items` and `payments` INSERT must be captured at enqueue time and embedded in the payload as `ledger_{id}` and `payment_{id}`. This is a change from the current dispatcher behavior which generates random IDs.

3. **Room Shift pre-SELECT** — After the `UPDATE ledger_items SET room_number = ?` in `shift()`, the transaction must SELECT all existing ledger item IDs for the booking so the compound event can enumerate them for Firestore updates.

4. **Batch guard for Night Audit** — If `occupiedRooms.length > 249`, split into two compound events in the same MySQL transaction.

5. **`compoundEventBuilder.js`** — Create a dedicated builder module. Do not embed compound payload construction inline in service/controller code.

6. **Generic dispatcher handler** — One `COMPOUND_*` case in the dispatcher that handles all compound event types via the declarative `writes[]` structure, rather than one case per operation.

---

## Summary: Approval Required

### ### APPROVAL REQUIRED

#### 1. Final Architecture

```
MySQL Transaction (BEGIN)
    ↓ business writes (rooms, bookings, ledger, payments...)
    ↓ SELECT mysql_ids after each INSERT
    ↓ SELECT absolute counter values from system_settings
    ↓ enqueue(conn, compoundEventPayload)  ← inside transaction
MySQL COMMIT
    ↓
Outbox Worker (every 3s)
    ↓ reclaimStaleProcessing()
    ↓ claimNextBatch()
    ↓ dispatchEvent(event)
        ↓ parse writes[]
        ↓ db.batch()
        ↓ batch.set/update/delete for each write descriptor
        ↓ batch.commit()  ← atomic
    ↓ markProcessed()
```

#### 2. Compound Event Schema

- Single outbox row per operation
- `event_type = COMPOUND_{CHECKIN|CHECKOUT|SHIFT|NIGHT_AUDIT}`
- `writes[]` array: ordered, declarative, absolute values, deterministic IDs
- `schema_version = 1`

#### 3. Firestore Batch Strategy

- `db.batch()` from existing `db` export
- All `set_merge` for idempotency
- Atomic commit — all writes or none
- Root + subcollection writes in same batch for dual-representation consistency

#### 4. Idempotency Strategy

- Deterministic document IDs from MySQL primary keys
- Absolute counter values (no `FieldValue.increment()`)
- `set_merge` semantics for all writes
- `isStaleUpdate()` guards already in repos (unchanged)

#### 5. Counter Strategy

- SELECT counter value from MySQL AFTER UPDATE
- Embed absolute value in compound event payload
- Firestore writes `today_checkins = N` (idempotent)

#### 6. Check-In Strategy

- 6–9 writes per compound event (within limits)
- MySQL IDs: bookingId, ledgerItemId, paymentId (if deposit), reservationId (if present)

#### 7. Check-Out Strategy

- 6–9 writes per compound event
- MySQL IDs: paymentId (if balance), cashLogId (if balance), invoiceNumber, historyId

#### 8. Night Audit Strategy

- 2N+1 writes (N = occupied rooms)
- Safe for current scale (N < 150 → max 301 writes)
- Batch guard if N > 249 (split into two compound events)
- Implement LAST (4E-B7)

#### 9. Concurrency Strategy

- MySQL row locking (`SELECT ... FOR UPDATE`) remains the sole concurrency mechanism
- Firestore WriteBatch is downstream-only, no locking
- No changes to MySQL transaction boundaries

#### 10. Exact Files to Modify

- `outboxDispatcher.js` — add compound dispatch handler
- `checkInService.js` — add compound event enqueue
- `roomController.js` — add compound event enqueue for checkOut and shift
- `businessDateService.js` — add compound event enqueue for night audit
- NEW: `backend/services/compoundEventBuilder.js`
- NEW: `backend/tests/testPhase4EBCompoundEvents.mjs`

#### 11. Implementation Order

4E-B1 → Generic WriteBatch Dispatcher  
4E-B2 → `compoundEventBuilder.js`  
4E-B3 → Check-In (pilot domain)  
4E-B4 → Check-Out  
4E-B5 → Room Shift  
4E-B6 → Booking (assess after 4E-B3)  
4E-B7 → Night Audit  
4E-B8 → Reconciliation

#### 12. Required Tests

All tests in §17. No production Firestore writes. Use Firestore emulator or mock `db.batch()` for unit tests.

#### 13. Rollback Plan

- All feature flags remain OFF during implementation and testing
- `ENABLE_FIRESTORE_DUAL_WRITE=false` means no `enqueue()` calls are reached in new code paths
- If a bug is found: set `ENABLE_FIRESTORE_OUTBOX_WORKER=false` — worker stops. MySQL operations unaffected.
- Compound events can be individually DEAD_LETTERED via existing `moveToDeadLetter()` if needed
- No MySQL or Firestore destructive operations required to roll back

#### 14. Remaining Risks

| Risk | Severity | Mitigation |
| :--- | :--- | :--- |
| Room shift ledger SELECT adds latency to shift transaction | LOW | One additional indexed query inside existing transaction |
| Night Audit payload size for large hotels (>249 rooms) | LOW | Batch guard splits compound events |
| Existing `createBookingFirestore` throws `DUPLICATE_KEY` on retry | MEDIUM | Switch to `set_merge` in compound dispatcher — bypass repo-level check |
| Stale-update guard in `bookingsRepository.updateBookingFirestore` may reject retry | LOW | Compound dispatcher uses `db` directly with batch, bypassing repo stale guard |
| `compoundEventBuilder.js` correctness is hard to test without MySQL | LOW | Pure function design enables unit tests with mock data |

---

## Safety Confirmation

```
CODE CHANGES:   0
MYSQL WRITES:   0
FIRESTORE WRITES: 0
AUTH MUTATIONS: 0
DEPLOYMENTS:    0
COMMITS:        0
PUSHES:         0
```

**STOP. This is a design document only. No implementation has been performed.**

**Awaiting explicit approval to proceed with Phase 4E-B1.**
