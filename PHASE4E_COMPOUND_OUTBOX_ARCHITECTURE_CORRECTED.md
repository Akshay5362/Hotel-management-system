# PHASE 4E — COMPOUND OUTBOX ARCHITECTURE (CORRECTED)

> **Status:** DESIGN / AUDIT ONLY — No code changes made.  
> **Branch:** firebase-migration  
> **Feature Flags:** ENABLE_FIRESTORE_READS=false, ENABLE_FIRESTORE_DUAL_WRITE=false,  
>                    ENABLE_FIRESTORE_OUTBOX_WORKER=false, ENABLE_FIRESTORE_RECONCILIATION=false  
> **Correction:** Previous report incorrectly stated `FieldValue.increment()` is incompatible with `WriteBatch`. This has been verified and corrected.

---

## CORRECTION NOTICE

The previous architecture document [PHASE4E_COMPOUND_OUTBOX_ARCHITECTURE.md](file:///d:/projects/hotel/PHASE4E_COMPOUND_OUTBOX_ARCHITECTURE.md) stated:

> *"Firestore's WriteBatch does not support server-side counter increments (FieldValue.increment()). These counters must either be excluded from Firestore replication or handled via a separate db.runTransaction()."*

**This statement was incorrect.**

### Verification (Read-Only, No Commit)

A verification script (`backend/audit_fieldvalue_batch.mjs`) was run against the live Firebase Admin SDK. Results:

```
✅ TEST 1 PASS: batch.set(ref, { counter: FieldValue.increment(1) }, { merge: true }) — VALID API
✅ TEST 2 PASS: batch.update(ref, { counter: FieldValue.increment(1) }) — VALID API
✅ TEST 3 PASS: Mixed FieldValue.increment() + regular fields across multiple docs in same batch — VALID API
[FieldValueAudit] batch.commit() was NOT called. Zero Firestore writes made.
```

`FieldValue.increment()` **IS** a valid server-side transform accepted by `WriteBatch.set()` and `WriteBatch.update()`. The batch atomicity guarantee still applies. The increment op is counted as one of the 500 allowed writes per batch.

**However**, the critical idempotency problem remains and is analyzed fully in Section 6.

---

## 1. PROCESSING Lease Analysis

### 1.1 How an Event Enters PROCESSING

The `claimNextBatch` function in [outboxService.js](file:///d:/projects/hotel/backend/services/outboxService.js#L67-L106) performs a two-phase claim:

```sql
-- Phase 1: SELECT candidates
SELECT id, event_id, ... 
FROM dual_write_outbox
WHERE (status = 'PENDING' OR (status = 'FAILED' AND attempts < maxRetries))
  AND available_at <= NOW()
ORDER BY id ASC LIMIT ?

-- Phase 2: CAS-style atomic claim
UPDATE dual_write_outbox
SET status = 'PROCESSING', updated_at = NOW()
WHERE id IN (...) AND (status = 'PENDING' OR status = 'FAILED')
```

**Key behaviors:**
- `status = 'PROCESSING'` is set by the UPDATE, not the SELECT.
- The `AND (status = 'PENDING' OR status = 'FAILED')` condition in the UPDATE is a Compare-And-Swap guard — prevents two workers claiming the same event concurrently.
- `updated_at = NOW()` is updated, but there is **no dedicated `claimed_at` or `lease_expires_at` column**.

### 1.2 Can a Worker Crash Leave Events Stuck?

**YES.** This is a confirmed gap.

If the outbox worker:
1. Claims an event (`status = 'PROCESSING'`)
2. Calls `dispatchEvent()` (Firestore batch)
3. `batch.commit()` succeeds
4. Process crashes BEFORE `markProcessed()` is called

Result: `dual_write_outbox` still shows `status = 'PROCESSING'`.

The `claimNextBatch` query only selects `PENDING` and `FAILED`. A stuck `PROCESSING` event is **never re-queued automatically**.

### 1.3 Current Retry and Dead-Letter Behavior
| Mechanism | Exists? | Details |
| :--- | :--- | :--- |
| Max retries | YES | `maxRetries = 5` (env configurable) |
| Exponential backoff | YES | `2^attempt × 5s`, capped at 300s |
| Dead-letter | YES | After `maxRetries` exceeded → `DEAD_LETTER` |
| Manual retry | YES | `retry(conn, eventId)` resets to PENDING |
| PROCESSING timeout | **NO** | **Missing — the gap** |
| Two-worker protection | YES | CAS UPDATE guard prevents double-claim |
| Event retention | YES | Dead-letter rows are kept, never auto-deleted |

### 1.4 Can Two Workers Process the Same Event?

**No, the CAS guard prevents it.** The `UPDATE ... WHERE status = 'PENDING' OR status = 'FAILED'` means only the first writer succeeds. A second concurrent claim attempt on the same event will find `status = 'PROCESSING'` and `affectedRows = 0`.

However: if HPMS ever runs two workers simultaneously (e.g., two server instances), both could SELECT the same candidate before either UPDATEs. The CAS UPDATE still protects — only one will modify the row. The other gets `affectedRows = 0` and skips. **This is safe.**

### 1.5 Minimum Safe Lease/Recovery Design

**Required addition: `PROCESSING` event cleanup job.**

Design (not implementation):

```sql
-- A periodic maintenance query (run every 5–10 minutes):
UPDATE dual_write_outbox
SET status = 'FAILED',
    last_error = 'Lease expired: worker crashed during PROCESSING',
    available_at = NOW()
WHERE status = 'PROCESSING'
  AND updated_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE);
```

This converts stuck `PROCESSING` events back to `FAILED` (eligible for retry), using `updated_at` as an implicit lease expiry timestamp.

**Why 10 minutes?** A Night Audit compound event with 17 rooms might take a few seconds. 10 minutes is conservative and avoids false-positive reclaims on slow but valid dispatches.

**No schema change required.** `updated_at` already exists in `dual_write_outbox`.

---

## 2. FieldValue.increment() — Corrected Analysis

### 2.1 Where Are Counters Currently Written in MySQL?

| Counter | MySQL Location | Operation |
| :--- | :--- | :--- |
| `today_checkins` | `system_settings.value_val` WHERE `key_name = 'today_checkins'` | `CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR)` |
| `today_checkouts` | `system_settings.value_val` WHERE `key_name = 'today_checkouts'` | `CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR)` |
| `continued_rooms` | `system_settings.value_val` WHERE `key_name = 'continued_rooms'` | Set to occupied room count (absolute) |

### 2.2 Where Are Counters Written in Firestore?

Currently: **nowhere**. All counters are MySQL-only. The `systemSettingsRepository.js` Firestore document (`settings/system_date`) contains `today_checkins` and `today_checkouts` fields as initial defaults (0), but no code path currently **increments** them in Firestore.

### 2.3 Can FieldValue.increment() Be Included in a WriteBatch?

**YES** — verified above. `batch.update(ref, { today_checkins: FieldValue.increment(1) })` is a valid API call accepted by Firebase Admin SDK without error.

The Firebase documentation confirms:
> `FieldValue.increment()` is a sentinel that instructs the server to atomically increment or decrement the field by the given value. Supported in `update()`, `set(merge:true)`, and **batched writes**.

### 2.4 The Idempotency Problem with FieldValue.increment()

**This is the real issue, distinct from API compatibility.**

**Scenario: Worker Retry Double-Increment**

```
MySQL COMMIT: today_checkins = 5 → 6
Outbox event enqueued

Worker runs batch.commit() (includes FieldValue.increment(1))
  → Firestore today_checkins: 0 → 1   ✅

Worker crashes BEFORE markProcessed()

Worker restarts, event still PROCESSING → reset to PENDING (after lease expires)

Worker runs batch.commit() again (includes FieldValue.increment(1))
  → Firestore today_checkins: 1 → 2   ❌ WRONG (should be 1)
```

**Result:** After a retry, the Firestore counter is `2` but the MySQL source of truth has value `1`. Counters are now permanently diverged by 1.

This is **not correctable by merge semantics** — `FieldValue.increment()` is additive, not declarative.

### 2.5 Three Candidate Strategies for Counters

**Strategy A: Absolute Value Write (Recommended)**

Instead of `FieldValue.increment(1)`, the compound event payload includes the **absolute target value** read from MySQL during the transaction.

```json
{
  "collection": "settings",
  "document_id": "system_date",
  "operation": "update",
  "data": {
    "today_checkins": 6,
    "updated_at": "2026-08-12T09:00:00.000Z"
  }
}
```

- The absolute value `6` is captured at MySQL commit time and embedded in the payload.
- A retry writes `6` again — idempotent.
- Downside: If TWO check-ins happen in rapid succession, both capture their respective absolute values (`6` and `7`). If the second event processes before the first, the counter temporarily shows `7` before the first event writes `6`. Firestore ends at `6`, not `7`.
- **However:** Since `ENABLE_FIRESTORE_READS=false`, Firestore counters are display-only. Stale reads are acceptable. And since MySQL is authoritative, the true count is always MySQL.
- **This strategy is safe and idempotent.**

**Strategy B: FieldValue.increment() + Post-Process Reconciliation**

Use `FieldValue.increment(1)` in the batch. Accept that retries cause temporary over-counts. Run a nightly reconciliation job that reads the MySQL `today_checkins` value and overwrites the Firestore absolute value.

- Pros: Simpler batch payload.
- Cons: Firestore could be wrong for hours. Acceptable while reads are off, **not acceptable** before reads are enabled.

**Strategy C: Exclude Counters from Compound Events**

Don't write `today_checkins`/`today_checkouts` to Firestore at all in compound events. Let them stay at `0` until a manual reconciliation or day-end event sets absolute values.

- Pros: Zero idempotency risk.
- Cons: Firestore dashboard shows wrong counters.
- Verdict: Acceptable for now, but less complete than Strategy A.

### 2.6 Recommendation

**Use Strategy A (Absolute Values).** Read the post-increment MySQL value from within the transaction, embed it in the compound event payload, and write it as an absolute set — not an increment. This is idempotent, retry-safe, and requires no reconciliation.

Example for Check-In compound event payload:

```json
{
  "collection": "settings",
  "document_id": "today_checkins",
  "operation": "set",
  "merge": true,
  "data": {
    "value_val": "6",
    "key_name": "today_checkins",
    "updated_at": "2026-08-12T09:00:00.000Z"
  }
}
```

This writes the absolute counter value `6` (read from MySQL after the `UNSIGNED + 1` update), making retries idempotent.

---

## 3. Compound Event Idempotency Analysis

| Operation | Retry-safe? | Why | Required Protection |
| :--- | :--- | :--- | :--- |
| `batch.set(ref, data, { merge: true })` | **YES** | Overwrites only specified fields. Same data writes the same result. | Deterministic doc ID required |
| `batch.set(ref, data, { merge: false })` | **YES** | Full overwrite — same data same result. | Deterministic doc ID required |
| `batch.update(ref, data)` | **YES** | Same fields overwritten with same values. | Doc must already exist; use set+merge instead for create-or-update |
| `FieldValue.increment(n)` via batch | **NO** | Each execution adds `n` again. Two executions add `2n`. | **Must use absolute values instead** |
| `FieldValue.arrayUnion(val)` via batch | **YES** | Adds element only if not already present (set semantics) | None |
| `FieldValue.arrayRemove(val)` via batch | **YES** | Removes element only if present (idempotent) | None |
| `batch.delete(ref)` | **YES** | Deleting an already-deleted doc is a no-op | None — Firestore does not error on deleting non-existent doc |
| Creating a new document (`set`, new ID) | **YES** (with deterministic ID) | If ID is deterministic, retry finds the document already exists and set+merge updates it | Non-deterministic IDs (e.g., random) would create duplicate documents |
| `FieldValue.serverTimestamp()` via batch | **CAUTION** | Each retry generates a new server timestamp | Use explicit ISO string timestamps embedded in payload instead |

**Key rule for HPMS compound events:**
- All document IDs must be **deterministic** (derived from MySQL IDs).
- All counter fields must use **absolute values**, not `FieldValue.increment()`.
- All timestamps must be **explicit ISO strings** from the MySQL transaction, not `FieldValue.serverTimestamp()`.

---

## 4. WriteBatch Limits — Per Operation from Codebase

### Firestore WriteBatch Limits
| Limit | Value |
| :--- | :--- |
| Max write operations per batch | **500** |
| Max request size | ~9.8 MiB |
| Max doc size | 1 MiB |
| Atomicity | YES — all or nothing |

### 4.1 Check-In (from `checkInService.js` + `roomController.js`)

MySQL tables touched: `guests` (upsert), `bookings` (insert), `reservations` (conditional update), `ledger_items` (insert), `payments` (conditional insert), `cash_logs` (conditional insert), `room_status_history` (insert), `audit_logs` (insert), `notifications` (conditional insert), `system_settings` (counter update), `rooms` (status update)

Firestore batch operations:

| Document | Op | Root | Sub | Count |
| :--- | :--- | :--- | :--- | :--- |
| `/guests/guest_{phone}` | set+merge | ✅ | — | 1 |
| `/bookings/bkg_{num}` | set+merge | ✅ | — | 1 |
| `/rooms/room_{num}` | update | ✅ | — | 1 |
| `/reservations/res_{num}` | update (conditional) | ✅ | — | 1 |
| `/ledger_items/ledger_{id}` | set+merge | ✅ | — | 1 |
| `/bookings/{bkg}/ledger_items/ledger_{id}` | set+merge | — | ✅ | 1 |
| `/payments/payment_{id}` | set+merge | ✅ | — | 1 |
| `/bookings/{bkg}/payments/payment_{id}` | set+merge | — | ✅ | 1 |
| `/settings/today_checkins` | set+merge (abs value) | ✅ | — | 1 |
| `/booking_history/history_{ts}` | set+merge | ✅ | — | 1 |
| `/bookings/{bkg}/history/history_{ts}` | set+merge | — | ✅ | 1 |

**Max total: ~11 ops** (if reservation exists + deposit paid). Well within 500.

### 4.2 Check-Out (from `roomController.js::checkOut`)

MySQL tables: `cash_logs`, `payments`, `bookings`, `invoices`, `room_status_history`, `audit_logs`, `rooms`, `checkout_snapshots`, `system_settings`, `notifications`, `guests`

Firestore batch operations:

| Document | Op | Root | Sub | Count |
| :--- | :--- | :--- | :--- | :--- |
| `/bookings/bkg_{num}` | update (status, amount) | ✅ | — | 1 |
| `/payments/payment_{id}` | set+merge | ✅ | — | 1 |
| `/bookings/{bkg}/payments/payment_{id}` | set+merge | — | ✅ | 1 |
| `/invoices/inv_{num}` | set+merge | ✅ | — | 1 |
| `/rooms/room_{num}` | update (status=dirty) | ✅ | — | 1 |
| `/booking_history/history_{ts}` | set+merge | ✅ | — | 1 |
| `/bookings/{bkg}/history/history_{ts}` | set+merge | — | ✅ | 1 |
| `/settings/today_checkouts` | set+merge (abs value) | ✅ | — | 1 |

**checkout_snapshots** — excluded (MySQL-only, Undo not implemented).

**Max total: ~8 ops.** Well within 500.

### 4.3 Room Shift (from `roomController.js::shift`)

MySQL tables: `bookings` (room_id update), `rooms` (×2), `ledger_items` (delete old + insert new), `room_status_history` (×2), `audit_logs`

Firestore batch operations:

| Document | Op | Root | Sub | Count |
| :--- | :--- | :--- | :--- | :--- |
| `/bookings/bkg_{num}` | update (room_id) | ✅ | — | 1 |
| `/rooms/room_{source}` | update (status=vacant) | ✅ | — | 1 |
| `/rooms/room_{target}` | update (status=occupied) | ✅ | — | 1 |
| Old ledger items (delete by booking+date) | delete | ✅ | ✅ | Variable |
| `/ledger_items/ledger_{new}` | set+merge | ✅ | — | 1 |
| `/bookings/{bkg}/ledger_items/ledger_{new}` | set+merge | — | ✅ | 1 |
| `/booking_history/history_{ts}` | set+merge | ✅ | — | 1 |

**Ledger deletes:** Room Shift deletes current business date tariff items for the source room. In a normal HPMS scenario (1 tariff item per room per day), this is 1 delete (root) + 1 delete (subcollection) = 2 ops.

**Max total: ~9–10 ops.** Well within 500.

**Important note on ledger idempotency for Shift:** The MySQL operation is:
```sql
DELETE FROM ledger_items WHERE room_number = ? AND business_date = ? AND desc LIKE '%Tariff%'
```
The compound event must include the specific `ledger_id`(s) of the deleted rows to form deterministic `delete` ops. The event payload must capture the deleted IDs at time of MySQL commit.

### 4.4 Night Audit / Day End (from `businessDateService.js::advanceBusinessDate`)

MySQL tables: `system_settings` (date + counters), `ledger_items` (1 INSERT per occupied room), `audit_logs`

At HPMS-Sky5 (17 rooms max):

| Document | Op | Count (17 rooms) |
| :--- | :--- | :--- |
| `/ledger_items/ledger_{id}` (per room) | set+merge | 17 |
| `/bookings/{bkg}/ledger_items/ledger_{id}` (per room) | set+merge | 17 |
| `/settings/system_date` | set+merge | 1 |
| `/settings/continued_rooms` | set+merge (abs value) | 1 |
| `/settings/today_checkins` | set+merge (abs value = 0) | 1 |
| `/settings/today_checkouts` | set+merge (abs value = 0) | 1 |

**Total for 17 rooms: 38 ops.** Safe.

**For a 500-room hotel:** 500 × 2 = 1000 ops — would exceed the 500-op limit. **HPMS-Sky5 is safe, but the architecture must document the multi-batch strategy:**

**Multi-batch strategy for Night Audit (for future hotel growth):**
- Split compound event into a **single compound event with chunked batch execution in the worker**.
- The single outbox row with one `event_id` still guarantees idempotent re-processing.
- The dispatcher splits the `documents` array into chunks of 450 ops (leaving headroom) and runs multiple sequential `batch.commit()` calls.
- If any chunk fails, the entire operation is retried from the start (idempotent).

For HPMS-Sky5's 17 rooms, this complexity is not currently needed.

### 4.5 Booking Creation (via `roomController.js::bookRoom`)
Existing compound event already partially wired (`BOOKING_CREATED` outbox event). Extends to:
- `/bookings/bkg_{num}` + `/guests/guest_{id}` + `/rooms/room_{num}` + conditional payment/ledger docs.
- **Max: ~8 ops.** Safe.

### 4.6 Payment Posting
- `/payments/payment_{id}` + `/bookings/{bkg}/payments/payment_{id}` + `/bookings/bkg_{num}` (update amount)
- **Max: 3 ops.** Trivial.

### 4.7 Invoice Creation
- `/invoices/inv_{num}`
- **Max: 1 op.** Trivial.

---

## 5. Transactional Authority Confirmation

**CONFIRMED: Option B.**

```
MYSQL
  ↓ (BEGIN ... FOR UPDATE ... COMMIT)
TRANSACTIONAL AUTHORITY
  ↓ (enqueue inside same transaction)
OUTBOX EVENT IN dual_write_outbox
  ↓ (worker: batch.commit())
FIRESTORE
  ↓
REPLICATED READ MODEL (eventually consistent)
```

**Technical reasons — non-negotiable:**

1. **`SELECT ... FOR UPDATE` is the hotel's concurrency control.** Night Audit locks `system_settings`. Check-In locks rooms and guests. Room Shift locks two rooms in deterministic order. None of these can be replicated in Firestore without a complete behavioral redesign.

2. **The `advanceBusinessDate` duplicate-prevention guard** (`SELECT id FROM audit_logs WHERE action='DAY_END'`) is a MySQL read inside a locked transaction. Firestore cannot reproduce this in-transaction check.

3. **The `undoDayEnd` operation** reads business date, checks data integrity, deletes ledger rows, rolls back date — all inside a single MySQL transaction with `system_settings FOR UPDATE`. This is impossible to port to Firestore.

4. **The `CheckoutRecoveryService.createSnapshot`** inserts an immutable snapshot into `checkout_snapshots` inside the checkout transaction. No equivalent Firestore design exists.

---

## 6. Corrected Compound Event Design

### 6.1 Schema

The `dual_write_outbox.payload` (`longtext`) stores a JSON object of this structure for compound events:

```json
{
  "compound": true,
  "operation_id": "op_checkin_1723456789_a1b2c3d4",
  "operation_type": "CHECK_IN_COMMITTED",
  "occurred_at": "2026-08-12T09:00:00.000Z",
  "business_date": "2026-08-12",
  "mysql_committed_at": "2026-08-12T09:00:00.123Z",
  "documents": [
    {
      "collection": "guests",
      "document_id": "guest_9876543210",
      "operation": "set",
      "merge": true,
      "data": { ... }
    },
    {
      "collection": "settings",
      "document_id": "today_checkins",
      "operation": "set",
      "merge": true,
      "data": {
        "key_name": "today_checkins",
        "value_val": "6",
        "updated_at": "2026-08-12T09:00:00.000Z"
      }
    }
  ]
}
```

**Compound event detection:** The dispatcher checks `payload.compound === true`. If true, it extracts `payload.documents` and builds a `db.batch()` instead of routing to individual repository functions.

**Non-compound events** (existing single-entity events) remain unchanged. The dispatcher handles them via the existing `switch(eventType)` block.

### 6.2 Dispatcher Logic (Conceptual, Not Implementation)

```
dispatchEvent(event):
  payload = JSON.parse(event.payload)
  
  IF payload.compound === true:
    batch = db.batch()
    FOR each doc IN payload.documents:
      ref = getRef(doc.collection, doc.document_id, doc.subcollection, doc.subdocument_id)
      IF doc.operation === 'set':
        batch.set(ref, doc.data, { merge: doc.merge !== false })
      ELIF doc.operation === 'update':
        batch.update(ref, doc.data)
      ELIF doc.operation === 'delete':
        batch.delete(ref)
    AWAIT batch.commit()
  ELSE:
    // Existing single-entity dispatch (unchanged)
    switch(event.event_type) { ... }
```

### 6.3 New Event Types Required

| Event Type | Replaces | Trigger Location |
| :--- | :--- | :--- |
| `CHECK_IN_COMMITTED` | `BOOKING_CREATED` + others | `checkInService.js` (end of function) |
| `CHECK_OUT_COMMITTED` | None (not yet wired) | `roomController.js::checkOut` |
| `RESERVATION_COMMITTED` | None | `reservationController.js` |
| `ROOM_SHIFT_COMMITTED` | None | `roomController.js::shift` |
| `DAY_END_COMMITTED` | `SYSTEM_DATE_UPDATED` | `businessDateService.js::advanceBusinessDate` |
| `UNDO_DAY_END_COMMITTED` | None | `auditController.js::undoDayEnd` |
| `PAYMENT_COMMITTED` | `PAYMENT_CREATED` | `paymentController.js` |

---

## 7. Retry Strategy

```
Event lifecycle:
  PENDING → PROCESSING → PROCESSED      (happy path)
  PENDING → PROCESSING → FAILED         (Firestore error, will retry)
  FAILED → PROCESSING → PROCESSED       (retry success)
  FAILED → DEAD_LETTER                  (maxRetries exceeded)
  PROCESSING → FAILED (via lease timeout, then normal retry)

Compound event retry:
  All document writes in the batch are re-attempted in full.
  Safe because:
  - set+merge: idempotent
  - update: idempotent (same fields, same values)
  - delete: idempotent (no-op if already deleted)
  - Counters: absolute values, not increments — idempotent
  - Timestamps: explicit ISO strings from payload — not re-generated
```

---

## 8. Concurrency Strategy

MySQL locks remain the concurrency authority:

| Concurrency scenario | MySQL protection | Firestore impact |
| :--- | :--- | :--- |
| Two check-ins to same room | `rooms FOR UPDATE` blocks second | Second never gets MySQL COMMIT; no outbox event generated |
| Night Audit + Check-In | `system_settings FOR UPDATE NOWAIT` fails Check-In | Check-In gets DB error; rolls back; no outbox event |
| Two Night Audits | `audit_logs DAY_END` duplicate guard | Second audit aborts at MySQL level |
| Room Shift + Check-In to same target | `rooms FOR UPDATE` on target in deterministic order | Only one wins at MySQL level |

**Firestore compound events do not need to handle concurrency.** They arrive sequentially via the outbox (FIFO `ORDER BY id ASC`), and the idempotent `set+merge` semantics mean last-writer-wins is acceptable for a read model.

---

## 9. Check-In Strategy

**Compound Event: `CHECK_IN_COMMITTED`**

Trigger point: End of `processCheckIn()` in `checkInService.js`, BEFORE the caller calls `connection.commit()`.

The caller (`roomController.js::checkIn`) already has the pattern:
```js
await processCheckIn(connection, { ... });
// ← compound enqueue would be called here by processCheckIn
await connection.commit();
```

The compound event must capture:
- The new `bookingId` (from `bResult.insertId`)
- The new `bookingNumber`
- The `guestId` (existing or newly inserted)
- The current `businessDate`
- The post-increment MySQL value of `today_checkins` (read after the UPDATE)
- The `reservationId` if linked
- Whether a payment/deposit was made

All of this is already available within `processCheckIn()` as local variables.

---

## 10. Check-Out Strategy

**Compound Event: `CHECK_OUT_COMMITTED`**

Trigger point: `roomController.js::checkOut`, after the snapshot is created, BEFORE `connection.commit()`.

Current checkout flow ends with:
```js
await CheckoutRecoveryService.createSnapshot(connection, { ... });
await connection.commit();    // ← compound enqueue goes here
```

The compound event captures:
- `activeBooking.id` and `activeBooking.booking_number`
- `room.id` and `room.number`
- `totalCollected` and `parsedBalancePaid`
- `invoiceNumber`
- `businessDate`
- The post-increment MySQL value of `today_checkouts`

`checkout_snapshots` table → excluded from Firestore batch (MySQL-only until Undo is implemented).

---

## 11. Night Audit Strategy

**Compound Event: `DAY_END_COMMITTED`**

Trigger point: `businessDateService.js::advanceBusinessDate`, after all MySQL writes, BEFORE the caller calls `conn.commit()`.

The compound event captures per-room ledger items (using `occupiedRooms` array already available) plus:
- `nextIso` (new business date)
- `occupiedRooms.length` (for `continued_rooms`)
- `0` for reset `today_checkins` and `today_checkouts` (absolute values)

**Batch size for 17 rooms:** 38 ops — safe.

**Multi-batch fallback (not needed now, document for future):**
```
IF documents.length > 450:
  SPLIT into chunks of 450
  FOR each chunk: await db.batch().commit()
  These are sequential, not concurrent
```

---

## 12. Batch Limit Strategy

| Operation | Estimated max ops | Within 500? | Multi-batch needed? |
| :--- | :--- | :--- | :--- |
| Check-In | 11 | ✅ | No |
| Check-Out | 8 | ✅ | No |
| Room Shift | 10 | ✅ | No |
| Booking Creation | 8 | ✅ | No |
| Night Audit (17 rooms) | 38 | ✅ | No |
| Night Audit (250 rooms) | 503 | ❌ | **Yes — split into 2** |
| Payment | 3 | ✅ | No |
| Invoice | 1 | ✅ | No |
| Reservation | 4 | ✅ | No |

**HPMS-Sky5 does not need multi-batch.** Document the strategy for future scalability.

---

## 13. Feature-Flag Rollout Strategy

| Phase | Flag Change | Action |
| :--- | :--- | :--- |
| 4E-1 through 4E-6 | None | Develop and test compound events. Flags remain off. |
| 4E-7 Staging | `ENABLE_FIRESTORE_DUAL_WRITE=true` | Enable compound event generation to outbox. Worker still off. |
| 4E-7 Worker Test | `ENABLE_FIRESTORE_OUTBOX_WORKER=true` | Enable worker to process outbox events into Firestore. Reads still off. |
| 4E-8 Reconciliation | `ENABLE_FIRESTORE_RECONCILIATION=true` | Run reconciliation job to validate MySQL vs Firestore. |
| Cutover (future) | `ENABLE_FIRESTORE_READS=true` | Only if reconciliation passes. |

---

## 14. Test Requirements

### Tests That MUST Exist BEFORE Any Flag Is Enabled

| Test | File | Blocks |
| :--- | :--- | :--- |
| PROCESSING lease timeout cleanup | `testOutboxProcessingLeak.mjs` | 4E-7 |
| Compound batch: success path | `testCompoundBatchSuccess.mjs` | 4E-7 |
| Compound batch: Firestore failure → retry | `testCompoundBatchRetry.mjs` | 4E-7 |
| Absolute counter idempotency | `testCounterAbsoluteIdempotency.mjs` | 4E-7 |
| Check-In compound event | `testCheckInCompoundEvent.mjs` | 4E-7 |
| Check-Out compound event | `testCheckOutCompoundEvent.mjs` | 4E-7 |
| Root + subcollection atomic consistency | `testRootSubcollectionConsistency.mjs` | 4E-7 |
| Night Audit compound event | `testDayEndCompoundEvent.mjs` | 4E-7 |
| Duplicate event (same event_id twice) | `testDuplicateCompoundEvent.mjs` | 4E-7 |
| Reservation compound event | `testReservationCompoundEvent.mjs` | 4E-3 |

### Existing Tests That Already Cover Critical Paths
| Test | What It Covers |
| :--- | :--- |
| `testOutboxInfrastructure.mjs` | PENDING/FAILED/DEAD_LETTER lifecycle |
| `testPhase3K2ALocking.mjs` | MySQL FOR UPDATE concurrency |
| `testBookingsCreateUpdateDualWritePilot.mjs` | Outbox enqueue within tx + rollback |

---

## 15. Rollback Strategy

**Zero-risk rollback at any phase:**

| Rollback Scenario | Action | MySQL Impact | Firestore Impact |
| :--- | :--- | :--- | :--- |
| During 4E-1 to 4E-6 | No flags changed — nothing to roll back | None | None |
| After 4E-7 (dual-write enabled) | Set `ENABLE_FIRESTORE_DUAL_WRITE=false` + restart | None | Firestore stops receiving new events; existing data remains valid |
| After 4E-7 (worker enabled) | Set `ENABLE_FIRESTORE_OUTBOX_WORKER=false` + restart | None | PENDING events accumulate but don't process |
| Emergency full reset | Both flags to `false` + restart | None | Firestore read model is stale; MySQL is authoritative |

**No MySQL data is ever at risk.** No Firestore data is ever deleted by a rollback. The flags are the only control surface.

---

## 16. Exact Files Expected to Change Later

| File | Current Role | Phase | Change Required |
| :--- | :--- | :--- | :--- |
| `backend/services/outboxService.js` | Outbox CRUD | 4E-1 | Add `PROCESSING` lease recovery query (periodic cleanup) |
| `backend/services/outboxDispatcher.js` | Event dispatch | 4E-1 | Add `compound` event handling with `db.batch()` execution |
| `backend/services/checkInService.js` | Check-in logic | 4E-3 | Add `enqueue()` of `CHECK_IN_COMMITTED` compound event |
| `backend/controllers/roomController.js` | Check-out, shift | 4E-4 | Add `enqueue()` for `CHECK_OUT_COMMITTED`, `ROOM_SHIFT_COMMITTED` |
| `backend/controllers/reservationController.js` | Reservation CRUD | 4E-2 | Add `enqueue()` for `RESERVATION_COMMITTED` |
| `backend/controllers/paymentController.js` | Payment posting | 4E-6 | Add `enqueue()` for `PAYMENT_COMMITTED` |
| `backend/services/businessDateService.js` | Date management | 4E-5 | Add `enqueue()` for `DAY_END_COMMITTED`, `UNDO_DAY_END_COMMITTED` |

### Files That MUST NOT Be Modified

- `backend/repositories/firestore/*.js` — already support `{ batch }` option
- `backend/repositories/firestore/firestoreUtils.js` — batch support already complete
- `firestore.rules` — no new write paths require new rules
- `firestore.indexes.json` — already deployed; compound events are writes, not reads
- `backend/.env` / feature flags — no changes until Phase 4E-7
- Frontend code
- Electron code
- Docker configuration
- MySQL schema

---

## AUDIT VALIDATION

```
CODE CHANGES: 0
MYSQL WRITES: 0
FIRESTORE WRITES: 0
AUTH MUTATIONS: 0
DEPLOYMENTS: 0
COMMITS: 0
PUSHES: 0
```

Git status confirms `PHASE4E_COMPOUND_OUTBOX_ARCHITECTURE_CORRECTED.md` is **untracked** (`??`). No staged files.

---

### APPROVAL REQUIRED

**1. Final Architecture Verdict:**

**APPROVE WITH CHANGES** (same verdict, corrections applied).

The Compound Outbox + Firestore `WriteBatch` architecture is technically sound and safe for HPMS-Sky5.

**The FieldValue.increment() incompatibility claim in the previous document was incorrect and is retracted.** `FieldValue.increment()` IS valid in `WriteBatch`. However, it is still NOT safe for compound events due to **idempotency failure on retry**.

The correct design requires **absolute counter values** (not increments) in compound event payloads.

**2. Exact Changes Required Before Implementation:**

| Priority | Change | Reason |
| :--- | :--- | :--- |
| **CRITICAL** | Implement `PROCESSING` lease timeout recovery (periodic cleanup query) | Prevents compound events from being permanently orphaned after a crash |
| **CRITICAL** | Add compound event `{ compound: true, documents: [...] }` handler in `outboxDispatcher.js` | Core infrastructure for all compound events |
| **REQUIRED** | Use absolute counter values in compound event payloads (not `FieldValue.increment()`) | Prevents double-counting on retry |
| **REQUIRED** | Use explicit ISO timestamp strings in payloads (not `FieldValue.serverTimestamp()`) | Ensures idempotency on retry |
| **REQUIRED** | All document IDs must be deterministic (derived from MySQL IDs) | Ensures set+merge writes are idempotent |

**3. Exact Implementation Order:**

1. **4E-1:** PROCESSING lease recovery + compound dispatcher infrastructure + `testOutboxProcessingLeak.mjs` + `testCompoundBatchSuccess.mjs`
2. **4E-2:** Reservation compound event (`RESERVATION_COMMITTED`) + `testReservationCompoundEvent.mjs`
3. **4E-3:** Check-In compound event (`CHECK_IN_COMMITTED`) + `testCheckInCompoundEvent.mjs` + `testCounterAbsoluteIdempotency.mjs`
4. **4E-4:** Check-Out compound event (`CHECK_OUT_COMMITTED`) + `testCheckOutCompoundEvent.mjs`
5. **4E-5:** Night Audit compound event (`DAY_END_COMMITTED`) + `testDayEndCompoundEvent.mjs`
6. **4E-6:** Payment + Invoice + Undo Day End compound events
7. **4E-7:** Enable flags (`ENABLE_FIRESTORE_DUAL_WRITE=true`, `ENABLE_FIRESTORE_OUTBOX_WORKER=true`) + reconciliation

**4. Exact Files Expected to Change:**
- `backend/services/outboxService.js`
- `backend/services/outboxDispatcher.js`
- `backend/services/checkInService.js`
- `backend/controllers/roomController.js`
- `backend/controllers/reservationController.js`
- `backend/controllers/paymentController.js`
- `backend/services/businessDateService.js`

**5. Exact Tests Required (before flag enablement):**
- `testOutboxProcessingLeak.mjs`
- `testCompoundBatchSuccess.mjs`
- `testCompoundBatchRetry.mjs`
- `testCounterAbsoluteIdempotency.mjs`
- `testCheckInCompoundEvent.mjs`
- `testCheckOutCompoundEvent.mjs`
- `testRootSubcollectionConsistency.mjs`
- `testDayEndCompoundEvent.mjs`
- `testDuplicateCompoundEvent.mjs`
- `testReservationCompoundEvent.mjs`

**6. Remaining Risks:**

| Risk | Severity | Mitigation |
| :--- | :--- | :--- |
| PROCESSING lease orphan | HIGH | Implement lease recovery in Phase 4E-1 (pre-condition) |
| Counter over-counting on retry | MEDIUM | Use absolute values (addressed in this document) |
| Room Shift ledger delete capture | MEDIUM | Compound event must capture deleted ledger IDs at MySQL commit time |
| Night Audit batch size at scale | LOW | HPMS-Sky5 has 17 rooms; document multi-batch for future |
| Out-of-order Firestore writes | LOW | Outbox FIFO + last-write-wins acceptable for read model |

---
**STOP. AWAITING YOUR EXPLICIT APPROVAL.**
