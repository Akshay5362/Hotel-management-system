# PHASE 4E-B2 — Compound Event Builder Foundation: Implementation Report

**Date:** 2026-08-12  
**Branch:** firebase-migration  
**Status:** COMPLETE — Awaiting Review

---

## 1. Files Created

| File | Type | Description |
| :--- | :--- | :--- |
| `backend/services/compoundEventBuilder.js` | NEW (untracked) | Core builder module |
| `backend/tests/testPhase4EB2CompoundBuilder.mjs` | NEW (untracked) | 68-test B2 test suite |
| `PHASE4E_B2_IMPLEMENTATION_REPORT.md` | NEW (untracked) | This report |

## 2. Files Modified

**None.** No production source files were modified in Phase 4E-B2.

Existing Phase 4E-A and B1 changes are preserved:

| File | Status | Phase |
| :--- | :--- | :--- |
| `backend/server.js` | ` M` unstaged | 4E-A |
| `backend/services/outboxDispatcher.js` | ` M` unstaged | 4E-B1 |
| `backend/services/outboxService.js` | ` M` unstaged | 4E-A |
| `backend/services/outboxWorker.js` | ` M` unstaged | 4E-A |
| `firestore.indexes.json` | ` M` unstaged | 4D |

---

## 3. Final Compound Event Schema

### Payload (produced by `CompoundEventBuilder.build()`)

```json
{
  "schema_version": 1,
  "event_type":     "COMPOUND_CHECKIN",
  "aggregate_type": "BOOKING",
  "aggregate_id":   "BKG-123456",
  "operation_id":   "op_compound_checkin_1723456789_a3f2c1",
  "occurred_at":    "2026-08-12T09:45:00.000Z",
  "business_date":  "2026-08-12",
  "writes": [
    {
      "seq":         1,
      "collection":  "bookings",
      "document_id": "bkg_BKG-123456",
      "operation":   "set_merge",
      "data":        { "booking_status": "Checked In", "total_amount": 2500 }
    },
    {
      "seq":         2,
      "collection":  "bookings",
      "parent_id":   "bkg_BKG-123456",
      "subcollection": "payments",
      "document_id": "payment_42",
      "operation":   "set_merge",
      "data":        { "amount": 1000, "payment_method": "Cash" }
    }
  ]
}
```

### Required header fields

| Field | Type | Source |
| :--- | :--- | :--- |
| `schema_version` | `1` (constant) | `COMPOUND_EVENT_SCHEMA_VERSION` |
| `event_type` | `COMPOUND_*` | Constructor — uppercased automatically |
| `aggregate_type` | string | Constructor |
| `aggregate_id` | string | Constructor |
| `operation_id` | string | Auto-generated or caller-supplied |
| `occurred_at` | ISO string | Defaults to `new Date().toISOString()` |
| `business_date` | YYYY-MM-DD or null | Caller-supplied |
| `writes` | array | Added via `addRootWrite()` / `addSubcollectionWrite()` / `addDualWrite()` |

### Write descriptor fields

| Field | Required | Notes |
| :--- | :--- | :--- |
| `collection` | ✅ | Root Firestore collection |
| `document_id` | ✅ | Deterministic — from formatXxx() or caller MySQL ID |
| `operation` | ✅ | `set`, `set_merge`, `update`, or `delete` |
| `data` | For set/set_merge/update | Must be non-null, non-empty object |
| `subcollection` | When nested | Non-empty string |
| `parent_id` | When nested | Required with `subcollection` |
| `seq` | Optional | Documentation ordering hint |

---

## 4. Builder API

### `CompoundEventBuilder` class

```javascript
import {
  CompoundEventBuilder,
  createCompoundEventBuilder,
  buildWriteDescriptor,
  COMPOUND_EVENT_SCHEMA_VERSION,
  CompoundBuilderError,

  // ID formatters
  formatBookingId, formatReservationId, formatRoomId,
  formatGuestId, formatStaffId, formatInvoiceId,
  formatLedgerItemId, formatPaymentId, formatCashLogId, formatHistoryId
} from '../services/compoundEventBuilder.js';
```

#### Constructor

```javascript
new CompoundEventBuilder({
  event_type:     'COMPOUND_CHECKIN',   // required; uppercased; must start with COMPOUND_
  aggregate_type: 'BOOKING',            // required
  aggregate_id:   'BKG-123456',         // required
  operation_id:   'op_optional_custom', // optional; auto-generated if absent
  occurred_at:    '2026-08-12T...',     // optional; defaults to now
  business_date:  '2026-08-12',         // optional
  allowDuplicates: false                // optional; default false
})
```

#### Methods

| Method | Description |
| :--- | :--- |
| `.addRootWrite({ collection, document_id, operation, data })` | Adds root-path write; returns `this` |
| `.addSubcollectionWrite({ collection, parent_id, subcollection, document_id, operation, data })` | Adds subcollection write; returns `this` |
| `.addDualWrite({ rootCollection, document_id, parentCollection, parent_id, subcollection, operation, data })` | Adds root + subcollection writes in one call; returns `this` |
| `.build()` | Validates and returns payload object; throws on any error |
| `.writeCount` | (getter) Current number of staged writes |

#### Standalone helpers

| Export | Description |
| :--- | :--- |
| `buildWriteDescriptor(opts)` | Low-level single write descriptor builder |
| `createCompoundEventBuilder(opts)` | Factory function equivalent to `new CompoundEventBuilder(opts)` |

---

## 5. Path Handling

### Root path

```javascript
builder.addRootWrite({
  collection: 'payments',
  document_id: formatPaymentId(42),   // → 'payment_42'
  operation: 'set_merge',
  data: { amount: 1000 }
});
// Produces Firestore path: /payments/payment_42
```

### Subcollection path

```javascript
builder.addSubcollectionWrite({
  collection: 'bookings',
  parent_id: formatBookingId('BKG-001'),   // → 'bkg_BKG-001'
  subcollection: 'payments',
  document_id: formatPaymentId(42),
  operation: 'set_merge',
  data: { amount: 1000 }
});
// Produces Firestore path: /bookings/bkg_BKG-001/payments/payment_42
```

### Dual representation (root + subcollection)

```javascript
builder.addDualWrite({
  rootCollection:   'payments',
  document_id:       formatPaymentId(42),
  parentCollection:  'bookings',
  parent_id:         formatBookingId('BKG-001'),
  subcollection:     'payments',
  operation:         'set_merge',
  data:              { amount: 1000 }
});
// Produces TWO writes:
//   /payments/payment_42
//   /bookings/bkg_BKG-001/payments/payment_42
```

Path validation:
- `collection` and `document_id` are required non-empty strings — empty/null rejected
- When `subcollection` is set, `parent_id` is also required — validated at descriptor build time
- All path components are trimmed

---

## 6. Deterministic ID Handling

### ID formatters (all exported from `compoundEventBuilder.js`)

| Function | Pattern | Example |
| :--- | :--- | :--- |
| `formatBookingId(ref)` | `bkg_{ref}` | `bkg_BKG-123456` |
| `formatReservationId(ref)` | `res_{ref}` | `res_RES-789` |
| `formatRoomId(number)` | `room_{number}` | `room_101` |
| `formatGuestId(id)` | `guest_{id}` | `guest_9876543210` |
| `formatStaffId(id)` | `staff_{id}` | `staff_uid_abc` |
| `formatInvoiceId(num)` | `inv_{num}` | `inv_INV-20260812-0042` |
| `formatLedgerItemId(mysqlId)` | `ledger_{id}` | `ledger_1001` |
| `formatPaymentId(mysqlId)` | `payment_{id}` | `payment_42` |
| `formatCashLogId(mysqlId)` | `cash_log_{id}` | `cash_log_7` |
| `formatHistoryId(mysqlId)` | `history_{id}` | `history_88` |

All formatters validate that the supplied ID is non-null, non-undefined, and non-empty — throwing `CompoundBuilderError` on failure so problems surface at build time.

**The builder never generates business entity IDs.** All document IDs come from the caller.

---

## 7. MySQL lastInsertId Contract

Domain builders (B3+) must capture MySQL AUTO_INCREMENT IDs before calling builder functions:

```javascript
// Inside the active MySQL transaction (B3+ responsibility):
const [ledgerResult] = await conn.query('INSERT INTO ledger_items ...');
const ledgerMysqlId = ledgerResult.insertId;    // ← capture BEFORE enqueue

const [paymentResult] = await conn.query('INSERT INTO payments ...');
const paymentMysqlId = paymentResult.insertId;  // ← capture BEFORE enqueue

// Then build the compound event:
builder
  .addDualWrite({ rootCollection: 'ledger_items', document_id: formatLedgerItemId(ledgerMysqlId), ... })
  .addDualWrite({ rootCollection: 'payments',     document_id: formatPaymentId(paymentMysqlId),  ... });
```

**B2 NEVER invents MySQL IDs.** This is enforced by the fact that formatters require the ID as a parameter.

---

## 8. Absolute Counter Contract

### Rule

Counter values **MUST be absolute integers** read from MySQL after the UPDATE:

```javascript
// Inside MySQL transaction (B3+ responsibility):
await conn.query("UPDATE system_settings SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR) WHERE key_name = 'today_checkins'");
const [[row]] = await conn.query("SELECT value_val FROM system_settings WHERE key_name = 'today_checkins'");
const todayCheckinsAbsolute = Number(row.value_val);  // e.g. 7

// In compound event:
builder.addRootWrite({
  collection: 'settings', document_id: 'system_date',
  operation: 'set_merge',
  data: { today_checkins: todayCheckinsAbsolute }  // absolute: 7
});
```

### What is forbidden

```javascript
// FORBIDDEN — never do this in a compound event:
import { FieldValue } from 'firebase-admin/firestore';
builder.addRootWrite({
  collection: 'settings', document_id: 'system_date',
  operation: 'set_merge',
  data: { today_checkins: FieldValue.increment(1) }   // ← REJECTED
});
// → CompoundBuilderError('FIELDVALUE_FORBIDDEN')
```

The FieldValue sentinel guard in `buildWriteDescriptor` detects Firebase FieldValue objects by checking the constructor name (`FieldTransform`, `FieldValue`) and the presence of `_methodName` / `_operand` properties.

---

## 9. Idempotency Guarantees

| Property | Guarantee |
| :--- | :--- |
| Document IDs | Caller-supplied deterministic IDs — same MySQL ID → same Firestore path |
| Data values | Plain JavaScript primitives — same MySQL data → same Firestore data |
| Counters | Absolute values from MySQL — retry writes same value (idempotent) |
| FieldValue | Rejected at `buildWriteDescriptor()` call — never reaches Firestore |
| `operation_id` | Auto-generated with `Date.now()` + `crypto.randomBytes` — unique per event invocation, not per retry (caller should supply a fixed `operation_id` if strict replay identity is needed) |
| `build()` copies | Returns a defensive copy of `writes[]` — mutations after `build()` don't affect the payload |

---

## 10. Validation Rules

### Constructor-level

| Check | Error Code |
| :--- | :--- |
| `event_type` is non-empty | `INVALID_EVENT_TYPE` |
| `event_type` starts with `COMPOUND_` | `INVALID_EVENT_TYPE_PREFIX` |
| `aggregate_type` is non-empty | `INVALID_AGGREGATE_TYPE` |
| `aggregate_id` is non-null | `INVALID_AGGREGATE_ID` |

### `buildWriteDescriptor()` / `addXxx()` level

| Check | Error Code |
| :--- | :--- |
| `operation` is one of set/set_merge/update/delete | `INVALID_OPERATION` |
| `collection` is non-empty string | `INVALID_COLLECTION` |
| `document_id` is non-empty string | `INVALID_DOCUMENT_ID` |
| If `subcollection` set: non-empty string | `INVALID_SUBCOLLECTION` |
| If `subcollection` set: `parent_id` also set | `MISSING_PARENT_ID` |
| For non-delete: `data` is non-null, non-array object | `INVALID_DATA` |
| For non-delete: `data` is non-empty | `EMPTY_DATA` |
| No FieldValue sentinels in `data` | `FIELDVALUE_FORBIDDEN` |

### `build()` level

| Check | Error Code |
| :--- | :--- |
| At least 1 write | `EMPTY_WRITE_SET` |
| `writes.length <= FIRESTORE_MAX_BATCH_OPS` | `WRITE_SET_TOO_LARGE` |
| No duplicate write targets (unless `allowDuplicates=true`) | `DUPLICATE_WRITE_TARGET` |

### ID formatter level

| Function | Error Code |
| :--- | :--- |
| `formatLedgerItemId(null/undefined/'')` | `INVALID_LEDGER_ID` |
| `formatPaymentId(null/undefined/'')` | `INVALID_PAYMENT_ID` |
| `formatCashLogId(null/undefined/'')` | `INVALID_CASH_LOG_ID` |
| `formatHistoryId(null/undefined/'')` | `INVALID_HISTORY_ID` |

---

## 11. Tests Added

**File:** `backend/tests/testPhase4EB2CompoundBuilder.mjs`

| Group | Tests | Focus |
| :--- | :--- | :--- |
| 1 — Module Constants | 2 | `COMPOUND_EVENT_SCHEMA_VERSION`, `CompoundBuilderError` |
| 2 — ID Formatters | 13 | All 10 formatters + null/empty rejection for new formatters |
| 3 — `buildWriteDescriptor` | 19 | All 4 operations, all validation paths, FieldValue guard, seq |
| 4 — Constructor Validation | 9 | Required fields, type prefix, auto operation_id, business_date |
| 5 — Build Validation | 6 | Empty writes, duplicates, oversized, defensive copy |
| 6 — Successful Builds | 8 | Single write, multiple, root, subcollection, dual, chaining, factory |
| 7 — Idempotency | 5 | Same IDs, deterministic payload, absolute counters, FieldValue reject |
| 8 — Dispatcher Compatibility | 5 | Full payload through mock db dispatch, dual-path, 6-write checkin, delete, invalid field |
| 9 — Counter Contract | 2 | `today_checkins` and `today_checkouts` absolute value pass-through |

**Total: 68 tests**

---

## 12. Test Results

```
══════════════════════════════════════════════════════════════
  PHASE 4E-B2 — Compound Event Builder Tests
══════════════════════════════════════════════════════════════

  Results: 68 passed, 0 failed
══════════════════════════════════════════════════════════════
```

---

## 13. Regression Results

| Suite | Result |
| :--- | :--- |
| B1 compound dispatcher (48 tests) | **48/48** ✅ |
| Phase 4E-A reliability (34 tests) | **34/34** ✅ |
| Phase 3A infrastructure (12 tests) | **12/12** ✅ |

---

## 14. Build Result

```
vite v5.4.21 building for production...
✓ 2849 modules transformed.
✓ built in 14.00s
```

`compoundEventBuilder.js` is a backend-only module — it is not bundled into the Vite frontend build, so the module count and bundle size are unchanged. The chunk-size warning is pre-existing and unrelated to B2.

---

## 15. MySQL Production Writes

```
MYSQL PRODUCTION WRITES:   0
```

No MySQL schema changes. No business data modifications. Test suites do write temporary rows to `dual_write_outbox` for Phase 4E-A and 3A tests — these are cleaned up by those test suites at the end of each run (confirmed: `[Cleanup] Removed 8 test rows from dual_write_outbox`).

---

## 16. Firestore Production Writes

```
FIRESTORE PRODUCTION WRITES:   0
```

All B2 tests use mocked `db` objects. No real Firestore SDK calls. Feature flags remain `false`.

---

## 17. Feature Flags

All flags remain **unchanged and disabled**:

| Flag | Value |
| :--- | :--- |
| `ENABLE_FIRESTORE_READS` | `false` |
| `ENABLE_FIRESTORE_DUAL_WRITE` | `false` |
| `ENABLE_FIRESTORE_OUTBOX_WORKER` | `false` |
| `ENABLE_FIRESTORE_RECONCILIATION` | `false` |

No new feature flags introduced.

---

## 18. Git Status

```
 M backend/server.js                              ← 4E-A (preserved)
 M backend/services/outboxDispatcher.js           ← 4E-B1 (preserved)
 M backend/services/outboxService.js              ← 4E-A (preserved)
 M backend/services/outboxWorker.js               ← 4E-A (preserved)
 M firestore.indexes.json                         ← 4D (preserved)
?? backend/services/compoundEventBuilder.js       ← B2 NEW
?? backend/tests/testPhase4EB2CompoundBuilder.mjs ← B2 NEW
?? PHASE4E_B2_IMPLEMENTATION_REPORT.md            ← THIS FILE
... [other untracked report files from earlier phases]
```

```
AUTH MUTATIONS:   0
DEPLOYMENTS:      0
COMMITS:          0
PUSHES:           0
STAGED:           0
```

---

## 19. Remaining Risks

| Risk | Severity | Notes |
| :--- | :--- | :--- |
| FieldValue detection is heuristic | LOW | Checks `constructor.name` and `_methodName`/`_operand` presence. If Firebase changes its internal class names, detection may miss new FieldValue types. The JSON round-trip guard (undefined stripping) is a secondary mitigation. |
| `operation_id` randomness | LOW | The `operation_id` uses `Date.now()` + `crypto.randomBytes`. This is safe for tracing but means two separate invocations of the same domain operation have different `operation_id`s. Domain builders should supply a fixed `operation_id` (e.g., derived from booking_number + business_date) if strict replay identity is required. |
| `allowDuplicates: true` in production | LOW | This bypass exists for test scaffolding. Domain builders must never use it. Document as internal-only. |
| `formatCategoryDocId` / `formatProductDocId` not re-exported | MINIMAL | These formatters exist in `firestoreUtils.js` but are category/product-specific and not needed for compound events. They can be added to B2 exports if a future domain builder needs them. |

---

## 20. Recommended Next Phase

**Phase 4E-B3 — Check-In Compound Event (Pilot)**

**Files to modify:** `backend/services/checkInService.js` only.

**Task:** After all MySQL writes in `processCheckIn()`, before `connection.commit()`:

```javascript
if (FEATURE_FLAGS.ENABLE_FIRESTORE_DUAL_WRITE) {
  const payload = buildCheckInCompoundEvent({
    bookingNumber, bookingMysqlId, guestId,
    roomNumber, ledgerMysqlId, paymentMysqlId,   // ← MySQL lastInsertId
    todayCheckinsAbsolute,                         // ← absolute MySQL counter
    reservationId, business_date
  });
  await enqueue(connection, {
    event_type:     payload.event_type,
    aggregate_type: payload.aggregate_type,
    aggregate_id:   payload.aggregate_id,
    payload
  });
}
```

**Builder function:** `buildCheckInCompoundEvent()` — pure function in a new `compoundEventBuilders/checkIn.js` or inline in `compoundEventBuilder.js`.

**Required MySQL IDs to capture** (currently not captured):
- `ledger_items.insertId` after the room tariff INSERT
- `payments.insertId` after the deposit payment INSERT (if deposit > 0)

**Test:** Integration test against local MySQL with `ENABLE_FIRESTORE_DUAL_WRITE=false`, verifying the outbox event is correctly built and the MySQL transaction remains unaffected.

---

## Summary

```
CODE CHANGES:             1 new file created (compoundEventBuilder.js)
MYSQL PRODUCTION WRITES:  0
FIRESTORE PRODUCTION WRITES: 0
AUTH MUTATIONS:           0
DEPLOYMENTS:              0
COMMITS:                  0
PUSHES:                   0

TESTS ADDED:              68 (B2 new)
TESTS PASSING:            68/68 (B2) + 48/48 (B1) + 34/34 (4E-A) + 12/12 (3A)
BUILD:                    PASS (14.00s)
SYNTAX CHECK:             PASS (builder module)
```
