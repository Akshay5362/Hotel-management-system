# PHASE 4E-B1 — Generic Compound Outbox Dispatcher: Implementation Report

**Date:** 2026-08-12  
**Branch:** firebase-migration  
**Status:** COMPLETE — Awaiting Review

---

## 1. Files Modified

| File | Change Type | Description |
| :--- | :--- | :--- |
| `backend/services/outboxDispatcher.js` | MODIFIED (unstaged) | Added `dispatchCompoundEvent()`, `SUPPORTED_WRITE_OPERATIONS`, `FIRESTORE_MAX_BATCH_OPS` constants, and routing case for `COMPOUND_*` event types |

**New untracked files:**

| File | Description |
| :--- | :--- |
| `backend/tests/testPhase4EB1CompoundDispatcher.mjs` | 48-test B1 test suite (mock db — no production Firestore) |
| `PHASE4E_B1_IMPLEMENTATION_REPORT.md` | This report |

**Preserved unchanged (Phase 4E-A):**
- `backend/server.js` ` M` — Phase 4E-A worker startup
- `backend/services/outboxService.js` ` M` — Phase 4E-A reliability hardening
- `backend/services/outboxWorker.js` ` M` — Phase 4E-A worker loop

---

## 2. Compound Event Contract

### Payload Schema (v1)

```json
{
  "schema_version": 1,
  "operation_id":   "op_checkin_1723456789_a3f2c1",
  "aggregate_type": "BOOKING",
  "aggregate_id":   "BKG-123456",
  "occurred_at":    "2026-08-12T09:45:00.000Z",
  "business_date":  "2026-08-12",
  "writes": [
    {
      "seq":           1,
      "collection":    "bookings",
      "document_id":   "bkg_BKG-123456",
      "operation":     "set_merge",
      "data":          { "booking_status": "Checked In", "total_amount": 2500 },
      "subcollection": null,
      "parent_id":     null
    },
    {
      "seq":           2,
      "collection":    "bookings",
      "parent_id":     "bkg_BKG-123456",
      "subcollection": "payments",
      "document_id":   "payment_42",
      "operation":     "set_merge",
      "data":          { "amount": 1000, "payment_method": "Cash" }
    }
  ]
}
```

### Routing

Events with `event_type` starting with `COMPOUND_` (e.g., `COMPOUND_CHECKIN`, `COMPOUND_CHECKOUT`, `COMPOUND_SHIFT`, `COMPOUND_NIGHT_AUDIT`) are routed through `dispatchCompoundEvent()` in the `default:` branch of `dispatchEvent()`. All other event types continue to use the existing individual handlers unchanged.

### Exports added

| Export | Type | Description |
| :--- | :--- | :--- |
| `dispatchCompoundEvent(payload)` | `async function` | Main compound event dispatcher |
| `SUPPORTED_WRITE_OPERATIONS` | frozen object | Enum of valid operation strings |
| `FIRESTORE_MAX_BATCH_OPS` | number | Configured batch limit (default 490) |

---

## 3. Supported Write Operations

| `operation` value | Firestore call | Notes |
| :--- | :--- | :--- |
| `set` | `batch.set(ref, data)` | Full document overwrite |
| `set_merge` | `batch.set(ref, data, { merge: true })` | Partial upsert — **preferred for idempotency** |
| `update` | `batch.update(ref, data)` | Update specific fields only |
| `delete` | `batch.delete(ref)` | Delete document; `data` field not required |

Any other string (e.g., `increment`, `upsert`, `BOOKING_CREATED`) is rejected with `DispatcherError(COMPOUND_UNSUPPORTED_OPERATION)` before the batch is created.

---

## 4. Batch Validation (Pre-Commit Checks)

All validation runs **before** `db.batch()` is called. A single validation failure means ZERO Firestore writes occur.

| Check | Error Code |
| :--- | :--- |
| Payload is non-null object | `COMPOUND_INVALID_PAYLOAD` |
| `writes` field exists | `COMPOUND_MISSING_WRITES` |
| `writes` is an Array | `COMPOUND_WRITES_NOT_ARRAY` |
| `writes` is non-empty | `COMPOUND_EMPTY_WRITES` |
| `writes.length <= FIRESTORE_MAX_BATCH_OPS` | `COMPOUND_BATCH_LIMIT_EXCEEDED` |
| Firestore `db` is initialized | `COMPOUND_DB_NOT_READY` |
| Each write is a non-null object | `COMPOUND_INVALID_WRITE_DESCRIPTOR` |
| `operation` is in `SUPPORTED_WRITE_OPERATIONS` | `COMPOUND_UNSUPPORTED_OPERATION` |
| `collection` is non-empty string | `COMPOUND_INVALID_COLLECTION` |
| `document_id` is non-empty string | `COMPOUND_INVALID_DOCUMENT_ID` |
| If `subcollection` set: it is non-empty string | `COMPOUND_INVALID_SUBCOLLECTION` |
| If `subcollection` set: `parent_id` is also set | `COMPOUND_MISSING_PARENT_ID` |
| For set/set_merge/update: `data` is non-null object (not array) | `COMPOUND_MISSING_DATA` |
| For set/set_merge/update: `data` has at least 1 key | `COMPOUND_EMPTY_DATA` |
| Firestore DocumentReference builds without error | `COMPOUND_INVALID_REF` |

---

## 5. Batch Limit

| Setting | Value |
| :--- | :--- |
| Firebase Admin SDK hard limit | 500 operations per batch |
| HPMS configured default | **490** operations |
| Override via env var | `FIRESTORE_MAX_BATCH_OPS=N` (clamped to max 500) |
| Behaviour when exceeded | Rejected before any Firestore interaction; `COMPOUND_BATCH_LIMIT_EXCEEDED` error propagates through `markFailed()` |
| Split behaviour | NOT supported — a compound event must remain atomic. Domain builders must split large operations into multiple compound events (e.g., Night Audit with >249 rooms). |

---

## 6. Idempotency Behaviour

| Property | Guarantee |
| :--- | :--- |
| Document IDs | Passed through verbatim from `document_id` field — no random ID generation in dispatcher |
| `set_merge` operations | Safe to replay: fields are merged onto existing documents; second execution produces same Firestore state |
| Absolute values | Numeric values pass through unchanged — no `FieldValue.increment()` added by dispatcher |
| `updated_at` field | Automatically set to current ISO timestamp IF not already present in `data` — idempotent because any re-execution replaces with a fresh timestamp, which is acceptable for auditing |
| Batch atomicity | Either all writes in the batch commit, or none do. Partial Firestore state cannot result from a single compound event execution. |

---

## 7. Legacy Event Compatibility

The `COMPOUND_*` routing lives inside the `default:` case of the existing `switch(eventType)` statement:

```javascript
default:
  if (eventType.startsWith('COMPOUND_')) {
    return await dispatchCompoundEvent(payload);
  }
  throw new DispatcherError(`Unsupported event_type for dispatch: '${eventType}'`, 'UNSUPPORTED_EVENT_TYPE');
```

All existing event types (`BOOKING_CREATED`, `ROOM_STATUS_CHANGED`, `SYSTEM_DATE_UPDATED`, etc.) continue to fall through to their existing `case` handlers exactly as before. The `default:` branch is only reached for event types not matched by any `case` — which was already the behaviour for unknown events (thrown as `UNSUPPORTED_EVENT_TYPE`).

**Zero changes to any existing event handler.**

---

## 8. Error Handling

| Scenario | Result |
| :--- | :--- |
| Validation failure | `DispatcherError` thrown before any `db.batch()` call. Outbox worker's `processOutboxBatch()` `try/catch` catches it, calls `markFailed()`. Event becomes eligible for retry. |
| `batch.commit()` throws | Error propagates out of `dispatchCompoundEvent()`. Outbox worker catches, calls `markFailed()`. Event retried with exponential backoff. |
| `batch.commit()` succeeds | Returns `{ committed: N, operation_id: '...' }`. Outbox worker calls `markProcessed()`. Event is done. |
| No new retry logic | Phase 4E-A retry/backoff/DEAD_LETTER machinery handles all cases unchanged. |

---

## 9. Tests Added

**File:** `backend/tests/testPhase4EB1CompoundDispatcher.mjs`

**Test infrastructure:** Mock `db` object with `MockBatch`, `MockRef`, `MockCollection`. No production Firestore SDK calls. No feature flag changes.

| Group | Tests | Focus |
| :--- | :--- | :--- |
| 1 — Module Constants | 4 | `SUPPORTED_WRITE_OPERATIONS`, `FIRESTORE_MAX_BATCH_OPS` |
| 2 — Payload Validation | 7 | null payload, missing writes, non-array, empty, batch limit, null db |
| 3 — Write Descriptor Validation | 10 | invalid operation, missing collection/document_id, subcollection consistency, data presence |
| 4 — Successful Dispatch | 12 | single write, multiple writes, root path, subcollection path, dual-representation, set/set_merge/update/delete, one commit, operation_id |
| 5 — Idempotency | 4 | deterministic IDs, no random IDs, absolute values, retry replay |
| 6 — Error Handling | 2 | commit failure propagation, not silently marked processed |
| 7 — Legacy Compatibility | 2 | DispatcherError still exported, operations don't include legacy event names |
| 8 — Subcollection Edge Cases | 4 | ledger path, history path, mixed root+sub, null subcollection |
| 9 — Batch Size Edge Cases | 3 | exactly at limit, one over limit, no Firestore interaction when over limit |

**Total: 48 tests**

---

## 10. Test Results

```
══════════════════════════════════════════════════════════════
  PHASE 4E-B1 — Compound Outbox Dispatcher Tests
══════════════════════════════════════════════════════════════

  Results: 48 passed, 0 failed
══════════════════════════════════════════════════════════════
```

**Phase 4E-A reliability tests (regression):**
```
  Phase 4E-A Reliability Tests: 34 PASSED, 0 FAILED
```

**Phase 3A infrastructure tests (regression):**
```
  Phase 3A Infrastructure Test Results: 12 PASSED, 0 FAILED
```

---

## 11. Build Result

```
vite v5.4.21 building for production...
✓ 2849 modules transformed.
✓ built in 13.20s
```

Pre-existing chunk size warning (`dist/assets/index-StaS4N85.js 1,997.57 kB`) is unrelated to B1 and was present before this phase.

---

## 12. MySQL Impact

```
MYSQL WRITES:         0
```

No MySQL schema changes. No business data modifications. No temporary test data written to production tables.

---

## 13. Firestore Impact

```
FIRESTORE WRITES:     0
```

No production Firestore writes. The compound dispatcher is inactive until:
1. `ENABLE_FIRESTORE_DUAL_WRITE=true` (currently `false`)  
2. `ENABLE_FIRESTORE_OUTBOX_WORKER=true` (currently `false`)  
3. A domain builder (Phase 4E-B2+) enqueues a `COMPOUND_*` event into the outbox

All tests used mocked db objects with no real Firestore SDK calls.

---

## 14. Firebase Auth Impact

```
AUTH MUTATIONS:       0
```

No Firebase Auth changes.

---

## 15. Feature Flag State

All flags remain **unchanged and disabled**:

| Flag | Value |
| :--- | :--- |
| `ENABLE_FIRESTORE_READS` | `false` |
| `ENABLE_FIRESTORE_DUAL_WRITE` | `false` |
| `ENABLE_FIRESTORE_OUTBOX_WORKER` | `false` |
| `ENABLE_FIRESTORE_RECONCILIATION` | `false` |

No new feature flags were introduced in B1.

---

## 16. Git Status

```
 M backend/server.js                           ← Phase 4E-A (preserved)
 M backend/services/outboxDispatcher.js        ← Phase 4E-B1 (new)
 M backend/services/outboxService.js           ← Phase 4E-A (preserved)
 M backend/services/outboxWorker.js            ← Phase 4E-A (preserved)
 M firestore.indexes.json                      ← Phase 4D (preserved)
?? backend/tests/testPhase4EB1CompoundDispatcher.mjs   ← NEW (untracked)
?? PHASE4E_B1_IMPLEMENTATION_REPORT.md        ← THIS FILE (untracked)
... [other untracked report files from earlier phases]
```

```
COMMITS:  0
PUSHES:   0
STAGED:   0
```

---

## 17. Remaining Risks

| Risk | Severity | Notes |
| :--- | :--- | :--- |
| `updated_at` is auto-injected by dispatcher for set/update ops | LOW | All writes get `updated_at = now` if not present in `data`. On retry, `updated_at` changes but the document field values remain correct. This is acceptable for all planned write scenarios. |
| `set` (no merge) wipes unlisted fields | MEDIUM | Domain builders should use `set_merge` unless full overwrite is intentional. The dispatcher allows plain `set` but does not force `merge`. |
| Legacy `createBookingFirestore` DUPLICATE_KEY check | LOW | Compound dispatcher bypasses repository-level duplicate checks by using `db.batch().set()` directly. This is correct — idempotency is provided by `set_merge` semantics at the batch level, not the repo layer. |
| Night Audit with >249 rooms | LOW | Batch guard at 490 operations will reject a compound event exceeding this. Domain builder (B7) must split. The guard is in place now. |
| Real Firestore integration test absent in B1 | LOW | B1 uses mocks only. Real end-to-end path will be validated in B3 (Check-In pilot) using Firestore emulator or controlled test Firestore project. |

---

## 18. Recommended Next Phase

**Phase 4E-B2 — `compoundEventBuilder.js`**

Create a dedicated builder module with pure functions:
- `buildCheckInCompoundEvent(mysqlResults, mysqlIds)` → payload
- `buildCheckOutCompoundEvent(mysqlResults, mysqlIds)` → payload
- `buildShiftCompoundEvent(mysqlResults, mysqlIds, existingLedgerItems)` → payload
- `buildNightAuditCompoundEvent(occupiedRooms, newLedgerIds, newDate)` → payload

Requirements:
- Pure functions — no database calls, no Firestore calls
- All document IDs deterministic from MySQL primary keys
- All counter values as absolute integers (no FieldValue)
- Unit-testable without any infrastructure

Pilot domain: **Check-In** (`buildCheckInCompoundEvent`) because:
- Smallest compound event (6–9 writes)
- Most frequent operation
- Already thoroughly modelled in Phase 4E-B design document

---

## Summary

```
CODE CHANGES:         1 file modified (outboxDispatcher.js)
MYSQL WRITES:         0
FIRESTORE WRITES:     0
AUTH MUTATIONS:       0
DEPLOYMENTS:          0
COMMITS:              0
PUSHES:               0

TESTS ADDED:          48 (B1 new)
TESTS PASSING:        48/48 (B1) + 34/34 (4E-A regression) + 12/12 (3A regression)
BUILD:                PASS (13.20s)
SYNTAX CHECK:         PASS
```
