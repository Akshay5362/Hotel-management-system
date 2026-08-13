# PHASE 4E-A — Outbox Reliability Hardening — Implementation Report

> **Date:** 2026-08-12  
> **Branch:** firebase-migration  
> **Status:** COMPLETE — All tests passing, build passing.

---

## 1. Files Modified

| File | Change Type | Summary |
| :--- | :--- | :--- |
| [`backend/services/outboxService.js`](file:///d:/projects/hotel/backend/services/outboxService.js) | Modified | Added `reclaimStaleProcessing()`. Updated `markFailed()` to return `{status, attempts}`. |
| [`backend/services/outboxWorker.js`](file:///d:/projects/hotel/backend/services/outboxWorker.js) | Modified | Wired `reclaimStaleProcessing()` as step 1 of every batch cycle. Added DEAD_LETTER ERROR log. Hardened `setInterval` with top-level try/catch. Switched to `isFirestoreOutboxWorkerEnabled()` helper. |
| [`backend/server.js`](file:///d:/projects/hotel/backend/server.js) | Modified | Added `startOutboxWorker()` call inside `server.listen()` callback via deferred dynamic import. Flag-gated, error-isolated. |

**New file (untracked):**

| File | Summary |
| :--- | :--- |
| [`backend/tests/testPhase4EAOutboxReliability.mjs`](file:///d:/projects/hotel/backend/tests/testPhase4EAOutboxReliability.mjs) | Phase 4E-A reliability test suite (10 scenarios, 34 assertions) |

---

## 2. Exact Reliability Changes

### 2.1 `reclaimStaleProcessing()` — `outboxService.js`

```javascript
export async function reclaimStaleProcessing(conn) {
  const db = conn || pool;
  const leaseMinutes = Number(process.env.OUTBOX_PROCESSING_LEASE_MINUTES) || 10;

  const [result] = await db.query(
    `UPDATE dual_write_outbox
     SET
       status       = 'FAILED',
       available_at = NOW(),
       last_error   = CONCAT('Lease expired: event was stuck in PROCESSING for > ', ?, ' minutes ...', NOW())
     WHERE status = 'PROCESSING'
       AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [leaseMinutes, leaseMinutes]
  );

  return result.affectedRows;
}
```

**Key guarantees:**
- **Guarded UPDATE**: `WHERE status = 'PROCESSING' AND updated_at < threshold` — never touches fresh events.
- **Payload preserved**: Only `status`, `available_at`, and `last_error` are changed.
- **attempts NOT reset**: Events near maxRetries correctly proceed to DEAD_LETTER.
- **Returns to FAILED** (not PENDING): respects the existing retry mechanism.
- **available_at = NOW()**: Immediately retry-eligible, no extra backoff for crash recovery.
- **No schema change**: Uses existing `updated_at` (`ON UPDATE CURRENT_TIMESTAMP`) as lease signal.

### 2.2 `markFailed()` return value — `outboxService.js`

```javascript
return { status: 'DEAD_LETTER', attempts: currentAttempts };  // or 'FAILED'
```

Enables the worker to log a `console.error` alert when an event permanently dies — without an extra DB query.

### 2.3 `processOutboxBatch()` — `outboxWorker.js`

Each batch cycle now executes:
```
1. reclaimStaleProcessing()   ← NEW: recover orphaned events
2. claimNextBatch()           ← unchanged
3. dispatchEvent()            ← unchanged
4. markProcessed() / markFailed()  ← unchanged
```

Added lease recovery `WARN` log and DEAD_LETTER `ERROR` log for operator visibility.

### 2.4 `startOutboxWorker()` hardening — `outboxWorker.js`

- Switched from `FEATURE_FLAGS.ENABLE_FIRESTORE_OUTBOX_WORKER` (evaluated at module load time) to `isFirestoreOutboxWorkerEnabled()` (evaluated at call time) — safer for hot-reload scenarios.
- `setInterval` callback now has a top-level `try/catch` so any unhandled error in a poll cycle is logged but **does not kill the interval or the Express process**.
- Startup log now includes `Lease timeout:` to make configuration visible on startup.

### 2.5 `server.js` worker startup

```javascript
server.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);

  import('./services/outboxWorker.js')
    .then(({ startOutboxWorker }) => {
      try {
        startOutboxWorker();
      } catch (err) {
        console.error('[Server] Outbox worker failed to start:', err.message);
      }
    })
    .catch(err => {
      console.error('[Server] Failed to import outboxWorker module:', err.message);
    });
});
```

- Dynamic import **deferred** inside `listen()` callback — module loaded only after the server is up, preventing circular imports.
- `try/catch` at both import level and startup level — worker failure **cannot crash hotel operations**.
- `startOutboxWorker()` already guards the flag internally — no duplication.

---

## 3. Lease Configuration

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `OUTBOX_PROCESSING_LEASE_MINUTES` | `10` | Minutes before a stuck PROCESSING event is reclaimed to FAILED |

**To change:** Add `OUTBOX_PROCESSING_LEASE_MINUTES=15` to `backend/.env`.  
**If absent:** 10-minute default applies. Documented in function JSDoc.

---

## 4. Worker Startup Behavior

| Condition | Behavior |
| :--- | :--- |
| `ENABLE_FIRESTORE_OUTBOX_WORKER=false` (current) | `startOutboxWorker()` logs "remains idle (safe state)." Returns false. No interval. |
| `ENABLE_FIRESTORE_OUTBOX_WORKER=true` | Worker starts. Poll every 3s. Lease recovery runs on every cycle. |
| Worker already running | Second `startOutboxWorker()` call returns true without creating duplicate interval. |
| Worker startup throws | Error is caught + logged. Server continues serving HTTP. |
| Module import fails | Error is caught + logged. Server continues serving HTTP. |

---

## 5. Retry / Recovery Behavior

```
Worker crash during PROCESSING
         ↓  (10 min passes)
reclaimStaleProcessing()
         ↓
status = FAILED, available_at = NOW(), last_error = "Lease expired: ..."
attempts = preserved (NOT reset)
         ↓
claimNextBatch() picks up FAILED event on next cycle
         ↓
dispatchEvent() → Firestore repository
  ↓ success            ↓ failure
markProcessed()     markFailed() → exponential backoff or DEAD_LETTER
```

**Idempotency:** All Firestore dispatches use `set(merge:true)` + deterministic IDs. A re-dispatched event after crash recovery is idempotent.

**DEAD_LETTER alert:** When `markFailed()` reaches maxRetries, the worker now logs:
```
[OutboxWorker] DEAD_LETTER: Event 'evt_...' (BOOKING_CREATED) has permanently failed after 5 attempts. Last error: ... Manual intervention required.
```

---

## 6. Tests Added

**File:** [`backend/tests/testPhase4EAOutboxReliability.mjs`](file:///d:/projects/hotel/backend/tests/testPhase4EAOutboxReliability.mjs)

| Test | Description | Assertions |
| :--- | :--- | :--- |
| A | Worker disabled — must not start | 3 |
| B | Worker enabled — starts exactly once, no duplicate | 6 |
| C | Fresh PROCESSING — NOT reclaimed | 2 |
| D | Stale PROCESSING — moved to FAILED, payload intact, attempts preserved | 5 |
| E | Reclaimed event — immediately retry-eligible and claimable | 2 |
| F | Guarded reclaim — PENDING/PROCESSED untouched | 2 |
| G | Retry limit — DEAD_LETTER at maxRetries, not affected by reclaim | 5 |
| H | Worker restart simulation — stale events recoverable | 3 |
| I | Normal happy path — unchanged | 4 |
| J | MySQL business operation with worker disabled | 2 |

---

## 7. Test Results

```
Phase 4E-A Reliability Tests: 34 PASSED, 0 FAILED

Phase 3A Infrastructure Tests: 12 PASSED, 0 FAILED  (regression: PASS)
```

All test rows cleaned up from `dual_write_outbox`. No Firestore writes (dispatcher not invoked in 4E-A tests). Worker stopped after test B.

---

## 8. Build Result

```
npm run build

vite v5.4.21 building for production...
✓ 2849 modules transformed.
✓ built in 17.41s
```

Build: ✅ PASS (chunk size warning is pre-existing, unrelated to this change).

---

## 9. MySQL Impact

- **Schema:** UNCHANGED. No `ALTER TABLE`. No `CREATE TABLE`. No migrations.
- **Data:** 8 test rows inserted and deleted during test run. Net = 0 rows added.
- **Business data:** UNCHANGED.
- **Transaction boundaries:** UNCHANGED in all controllers and services.

---

## 10. Firestore Impact

- **ZERO Firestore writes** during implementation or tests.
- `dispatchEvent()` was not called in any Phase 4E-A test.
- Firestore repositories: UNCHANGED.

---

## 11. Feature Flag State

All flags remain at their safe default values:

```
ENABLE_FIRESTORE_READS=false
ENABLE_FIRESTORE_DUAL_WRITE=false
ENABLE_FIRESTORE_OUTBOX_WORKER=false    ← worker NOT started in production
ENABLE_FIRESTORE_RECONCILIATION=false
```

No `.env` file was modified.

---

## 12. Git Status

```
 M backend/server.js
 M backend/services/outboxService.js
 M backend/services/outboxWorker.js
 M firestore.indexes.json                ← pre-existing, Phase 4D-3, not modified this session
?? backend/tests/testPhase4EAOutboxReliability.mjs  ← new, untracked
... (audit/report documents — untracked, unchanged)
```

**Staged files:** 0  
**Commits:** 0  
**Pushes:** 0

---

## 13. Remaining Risks

| Risk | Severity | Notes |
| :--- | :--- | :--- |
| Lease timeout tuning | LOW | 10-minute default is very conservative (actual processing <30s). Adjust via `OUTBOX_PROCESSING_LEASE_MINUTES` if needed. |
| `markFailed()` two-query pattern | LOW | Not atomic (SELECT + UPDATE). Safe for single-worker. Not changed in this phase per scope restrictions. |
| Compound events not yet wired | MEDIUM | Check-In, Check-Out, Night Audit will generate compound outbox events in Phase 4E-B. The reliability infrastructure (lease recovery, retry, DEAD_LETTER) is now in place to support them. |
| DEAD_LETTER alert only in `console.error` | LOW | No structured monitoring. Recommended future: forward to an operations alerting channel. |

---

## 14. Recommended Next Step

**Phase 4E-B: Compound Outbox Events**

The lease recovery mechanism is now in place. The next phase may safely implement compound outbox events for:
1. Check-In (`checkInService.js`)
2. Check-Out (`roomController.js::checkOut`)
3. Room Shift (`roomController.js::shift`)
4. Night Audit (`businessDateService.js::advanceBusinessDate`)
5. Payment posting

Each compound event must:
- Call `enqueue(conn, ...)` **before** `conn.commit()` (inside the MySQL transaction).
- Include absolute counter values (not `FieldValue.increment()`) for idempotency.
- Use `db.batch()` in the dispatcher for atomic Firestore writes.

---

## Safety Confirmation

```
CODE CHANGES:   3 source files (outboxService.js, outboxWorker.js, server.js)
                1 new test file (testPhase4EAOutboxReliability.mjs)
MYSQL WRITES:   8 test rows inserted and deleted. Net = 0.
FIRESTORE WRITES: 0
AUTH MUTATIONS: 0
DEPLOYMENTS:    0
COMMITS:        0
PUSHES:         0
```

**STOP. Phase 4E-A implementation is complete. Awaiting your approval for Phase 4E-B.**
