# PHASE 4F — PRODUCTION READINESS AUDIT
## Transactional Outbox: MySQL to Firestore

**Date:** 2026-08-12
**Auditor:** Automated deep read-only inspection
**Scope:** HPMS-Sky5 backend — `backend/` directory
**Codebase state:** 325/325 tests passing. All feature flags OFF.

---

## 1. TRANSACTIONAL WRITE-PATH COVERAGE

### 1.1 Covered Domains (Outbox Event Emitted)

| Domain | Mutation | MySQL Tx? | enqueue conn? | Compound? | Root Write? | Subcollection? | Gated? | Status |
|---|---|---|---|---|---|---|---|---|
| Check-In | INSERT booking/guest/payment/ledger/cash_log/audit_log | YES | YES | COMPOUND_CHECK_IN | YES | YES (bookings/ledger_items, bookings/payments) | YES | COVERED |
| Check-Out | UPDATE booking/room; INSERT payment/ledger/cash_log/invoice/history | YES | YES | COMPOUND_CHECK_OUT | YES | YES (bookings/ledger_items) | YES | COVERED |
| Room Shift | UPDATE bookings/ledger_items/rooms/audit_log | YES | YES | COMPOUND_ROOM_SHIFT | YES | YES (bookings/ledger_items) | YES | COVERED |
| Night Audit | INSERT ledger_items(N); UPDATE system_settings(3); INSERT audit_log | YES | YES | COMPOUND_NIGHT_AUDIT | YES (settings/system_date) | YES (bookings/ledger_items) | YES | COVERED |
| Guest Registration | INSERT users/guests/audit_log | YES | YES | NO (legacy GUEST_CREATED) | YES | NO | YES | COVERED |
| Room Status Update | UPDATE rooms; INSERT room_status_history/audit_log | YES | YES | NO (legacy ROOM_STATUS_CHANGED) | YES | NO | YES | COVERED |
| Online Booking (reserve) | INSERT bookings; UPDATE guest loyalty/audit_log | YES | YES | NO (legacy BOOKING_CREATED) | YES | NO | YES | COVERED |
| Modify Check-In | UPDATE bookings/guests; INSERT audit_log | YES | YES | NO (legacy BOOKING_UPDATED) | YES | NO | YES | COVERED |
| Staff CRUD | INSERT/UPDATE/DELETE users/staff | YES | YES | NO (legacy STAFF_*) | YES | NO | YES | COVERED |
| Room Type CRUD | INSERT/UPDATE/DELETE room_types | YES | YES | NO (legacy ROOM_TYPE_*) | YES | NO | YES | COVERED |
| Inventory Category CRUD | INSERT/UPDATE/DELETE inventory_categories | YES | YES | NO (legacy INV_CAT_*) | YES | NO | YES | COVERED |
| Inventory Product CRUD | INSERT/UPDATE/DELETE inventory_products | YES | YES | NO (legacy INV_PROD_*) | YES | NO | YES | COVERED |
| Housekeeping Log/Status | INSERT housekeeping_logs; UPDATE rooms.housekeeping_status | YES | YES | NO (legacy HK_*) | YES | NO | YES | COVERED |

### 1.2 NOT COVERED Domains (No Outbox Event)

| Domain | Mutation | MySQL Tx? | enqueue? | Gap Severity |
|---|---|---|---|---|
| Reservation Create | INSERT reservations; INSERT cash_logs (advance) | YES | NO | CRITICAL |
| Reservation Update | UPDATE reservations | YES | NO | CRITICAL |
| Reservation Cancel | UPDATE reservations.status | YES | NO | CRITICAL |
| Payment (finalizePayment) | UPDATE payments; UPDATE invoices | NO (pool.query) | NO | CRITICAL |
| Confirm Cash Payment | UPDATE payments; UPDATE invoices | NO (pool.query) | NO | CRITICAL |
| Invoice Generate/Update | INSERT/UPDATE invoices | NO (pool.query) | NO | HIGH |
| Cash Submission | INSERT cash_submissions; INSERT audit_log | YES | NO | HIGH |
| Undo Day End | DELETE ledger_items; UPDATE system_settings | YES | NO | HIGH |
| Booking status mutations (guest portal) | UPDATE bookings.booking_status | YES | NO | HIGH |
| Guest profile update (standalone) | UPDATE guests | YES | PARTIAL (BOOKING_UPDATED only) | MEDIUM |
| Audit Log creation (all controllers) | INSERT audit_logs | YES | NO | LOW |
| Notifications | INSERT notifications | Varies | NO | LOW |
| Feedback submission | INSERT feedback | YES | NO | LOW |
| Stay Extension Create/Resolve | INSERT/UPDATE stay_extensions | YES | NO | LOW |

---

## 2. OUTBOX EVENT COVERAGE

### 2.1 Active Event Types

| Event Type | Producer | Dispatcher Handler | Status |
|---|---|---|---|
| GUEST_CREATED | authController.js:96 | Phase 3H | ACTIVE |
| GUEST_UPDATED | None | Phase 3H | NO PRODUCER |
| BOOKING_CREATED | roomController.js:626 | Phase 3K | ACTIVE |
| BOOKING_UPDATED | roomController.js:788 | Phase 3K | ACTIVE |
| BOOKING_STATUS_CHANGED | None | Phase 3K | NO PRODUCER |
| BOOKING_HISTORY_CREATED | None | Phase 3K | NO PRODUCER |
| ROOM_STATUS_CHANGED | roomController.js:2043 | Phase 3C | ACTIVE |
| ROOM_TYPE_CREATED/UPDATED/DELETED | roomTypeController.js | Phase 3B | ACTIVE |
| STAFF_CREATED/UPDATED/STATUS/DELETED | staffController.js | Phase 3D | ACTIVE |
| INVENTORY_CATEGORY_* | inventoryController.js | Phase 3E | ACTIVE |
| INVENTORY_PRODUCT_* | inventoryController.js | Phase 3G | ACTIVE |
| SYSTEM_DATE_UPDATED | businessDateService.js:232 | Phase 3F | ACTIVE |
| HOUSEKEEPING_STATUS_UPDATED | housekeepingController.js:60 | Phase 3I | ACTIVE |
| HOUSEKEEPING_LOG_CREATED | housekeepingController.js:161,174 | Phase 3I | ACTIVE |
| COMPOUND_CHECK_IN | checkInService.js:438 | Phase 4E-B3 | ACTIVE |
| COMPOUND_CHECK_OUT | checkOutService.js:379 | Phase 4E-B4 | ACTIVE |
| COMPOUND_ROOM_SHIFT | roomShiftService.js:221 | Phase 4E-B5 | ACTIVE |
| COMPOUND_NIGHT_AUDIT | businessDateService.js:455 | Phase 4E-B7 | ACTIVE |
| PAYMENT_CREATED | None in controllers | Phase 2A | NO PRODUCER |
| LEDGER_ITEM_CREATED | None standalone | Phase 2B | NO PRODUCER |
| INVOICE_CREATED | None | Phase 2C | NO PRODUCER |
| RESERVATION_CREATED/UPDATED | None | Phase 2D | NO PRODUCER |
| CASH_LOG_CREATED | None | Phase 2E | NO PRODUCER |
| CASH_SUBMISSION_CREATED | None | Phase 2F | NO PRODUCER |
| AUDIT_LOG_CREATED | None | Phase 3J | NO PRODUCER |
| STAY_EXTENSION_CREATED/RESOLVED | None | Phase 2I | NO PRODUCER |

### 2.2 Delivery Guarantee Classification

- Compound events (B3-B7): EFFECTIVELY-ONCE (set_merge + deterministic IDs)
- Legacy events: AT-LEAST-ONCE (upsert patterns in dispatcher reduce duplicates)
- Overall system: AT-LEAST-ONCE

---

## 3. TRANSACTIONAL OUTBOX CORRECTNESS

### 3.1 All 25 Active enqueue() Sites Verified

VERDICT: ALL 25 enqueue sites:
- Use the active MySQL connection (not pool)
- Are inside BEGIN/COMMIT transaction boundary
- Are placed BEFORE connection.commit()
- Will cause transaction ROLLBACK if enqueue() throws

### 3.2 Dangerous pool.query Mutations (Outside Transactions)

| File | Line | Pattern | Risk |
|---|---|---|---|
| paymentController.js | 96 | pool.query(UPDATE payments) | CRITICAL — no tx, no enqueue |
| paymentController.js | 113 | pool.query(UPDATE invoices) | CRITICAL — no tx, no enqueue |
| paymentController.js | 282 | pool.query(UPDATE payments — confirmCash) | CRITICAL — no tx, no enqueue |
| paymentController.js | 294 | pool.query(UPDATE invoices — confirmCash) | CRITICAL — no tx, no enqueue |
| invoiceController.js | 51,101 | pool.query(UPDATE/INSERT invoices) | HIGH — no tx, no enqueue |
| paymentController.js | 324 | pool.query(INSERT notifications) | LOW |

CRITICAL FINDING: paymentController and invoiceController mutate MySQL using pool.query outside any transaction. Safe dual-write is impossible for these domains without first wrapping mutations in a transaction and adding enqueue().

---

## 4. OUTBOX WORKER RELIABILITY

### 4.1 State Machine

PENDING -> [claimNextBatch] -> PROCESSING
  -> [dispatchEvent OK] -> [markProcessed] -> PROCESSED
  -> [dispatchEvent FAIL] -> [markFailed]:
      attempts < maxRetries -> FAILED (backoff) -> retry
      attempts >= maxRetries -> DEAD_LETTER (manual intervention)
  -> [worker crash, lease expired] -> [reclaimStaleProcessing] -> FAILED -> retry

### 4.2 Concurrent Worker Analysis

The claimNextBatch() function uses SELECT then UPDATE (not SELECT FOR UPDATE).
Race window: Two workers can SELECT the same candidates.
Protection: UPDATE WHERE status='PENDING' OR status='FAILED' — only one UPDATE wins.
Second worker: affectedRows=0, returns empty.

VERDICT: Concurrent workers CANNOT process the same event. Double processing is not possible.
Risk: LOW (theoretical TOCTOU but UPDATE guard makes it safe).

### 4.3 Other Worker Properties

- Lease recovery: reclaimStaleProcessing() runs at the START of every batch cycle. CONFIRMED.
- PROCESSING -> FAILED (not PENDING) -> backoff retry -> DEAD_LETTER. CONFIRMED.
- Server restart: fresh isRunning=false, startOutboxWorker() restarts cleanly. CONFIRMED.
- No SIGTERM/SIGINT handler: worker interval not cleared on kill signal. COSMETIC RISK.
- Worker started in server.listen() callback via dynamic import(). CONFIRMED.
- Backoff: min(300, 2^n * 5) seconds. Max 300s. CONFIRMED.
- Default maxRetries=5. DEAD_LETTER logged at ERROR level. CONFIRMED.

---

## 5. COMPOUND EVENT SAFETY

### 5.1 Dispatcher Protection Matrix

| Check | Status |
|---|---|
| Batch limit >490 rejected BEFORE batch creation | ENFORCED (line 670 outboxDispatcher.js) |
| Deterministic document_id (builder responsibility) | CONTRACT enforced at CompoundEventBuilder |
| set_merge operation | IMPLEMENTED — batch.set(ref, data, {merge:true}) |
| Duplicate target detection | ENFORCED at builder.build() |
| FieldValue rejection | ENFORCED at builder descriptor validation |
| Root/subcollection consistency (parent_id required) | ENFORCED at dispatcher validation |
| Frozen timestamps | BUILDER RESPONSIBILITY — eventOccurredAt frozen before build() |
| Absolute counters | ENFORCED — FieldValue-like sentinels rejected |
| Retry idempotency | set_merge + deterministic IDs = safe to replay |
| All-or-nothing batch | ENFORCED — all descriptors validated before batch creation |
| Unsupported operations | COMPOUND_UNSUPPORTED_OPERATION |
| Empty writes | COMPOUND_EMPTY_WRITES |
| Duplicate writes | DUPLICATE_WRITE_TARGET |

IMPORTANT: Dispatcher adds updated_at = new Date().toISOString() at dispatch time if not in payload.
For compound events with frozen updated_at in payload: correctly preserved.
For legacy events without updated_at: staleness of up to OUTBOX_PROCESSING_LEASE_MINUTES introduced.

### 5.2 Current Compound Events Write Set

| Event | Total Writes | settings | ledger(root) | ledger(sub) | booking | room | payment | cash |
|---|---|---|---|---|---|---|---|---|
| COMPOUND_CHECK_IN | 6 | NO | YES | YES | YES | YES | YES | YES |
| COMPOUND_CHECK_OUT | 7-10 | NO | YES | YES | YES | YES | Cond | Cond |
| COMPOUND_ROOM_SHIFT | Variable | NO | YES (per ledger) | YES | YES | YES(x2) | NO | NO |
| COMPOUND_NIGHT_AUDIT | 2N+1 | YES | YES (per tariff) | YES (per tariff) | NO | NO | NO | NO |

---

## 6. FIRESTORE REPOSITORY COMPATIBILITY

All four compound events verified against Firestore repository expectations:

COMPOUND_CHECK_IN: booking_number, mysql_booking_id, room_number, guest_id, today_checkins — ALL MATCH.
COMPOUND_NIGHT_AUDIT: settings/system_date, current_date, system_date, today_checkins/checkouts/continued_rooms — ALL MATCH.

Subcollection path: /bookings/{bkg_id}/ledger_items/{ledger_id} — matches Firestore rules definition. CONFIRMED.

FINDING: booking_history (root collection) vs bookings/*/history (subcollection) are TWO different storage paths.
Compound events write to booking_history root via createBookingHistoryFirestore. Legacy dispatcher uses BOOKING_HISTORY_CREATED.
If both are written, dual storage creates inconsistency risk.

---

## 7. SECURITY RULES AUDIT

Admin SDK bypasses all client rules. Compound event WriteBatches use Admin SDK exclusively.

### 7.1 Rules Coverage

| Collection | Client Read | Client Write | Admin SDK Writes | Issue? |
|---|---|---|---|---|
| settings | Any authenticated user | Admin only | Via compound | WARNING: guests can read system_date/room counts |
| bookings | Staff or owner | Staff only | Via compound | CORRECT |
| bookings/*/ledger_items | Staff or owner | Staff only | Via compound | CORRECT |
| bookings/*/payments | Staff or owner | Staff only | Via compound | CORRECT |
| bookings/*/history | Staff or owner | Staff create only | Via compound | CORRECT — immutable |
| ledger_items (root) | Staff only | Staff create/admin update | Via compound | CORRECT |
| payments (root) | Staff only | Staff create/admin update | Via compound | CORRECT |
| rooms | Any authenticated user | Staff only | Via compound | WARNING: guests can read room status |
| guests | Staff or self | Staff or self | Via compound | CORRECT |
| reservations | Staff only | Staff only | Via compound | CORRECT |
| checkout_snapshots | BLOCKED | BLOCKED | Admin SDK only | INTENDED |
| razorpay_transactions | Admin only | BLOCKED | Admin SDK only | CORRECT |
| daily_analytics | Staff only | BLOCKED | Not written by outbox | PLACEHOLDER |
| stay_extensions | Staff or self | Self/staff | Not written by outbox | MISSING outbox coverage |

### 7.2 Key Findings

FINDING 1: settings collection readable by ANY authenticated user (including guests).
FINDING 2: booking_history (root) and bookings/*/history (subcollection) are separate — both have rules.
FINDING 3: daily_analytics has rules but no writer. Placeholder only.
FINDING 4: room_status_history, feedback — pure MySQL, no Firestore. Intentional.

---

## 8. FIRESTORE INDEXES AUDIT

### 8.1 Defined (9 indexes)

bookings: (booking_status + created_at), (guest_id + booking_status), (check_in_date + check_out_date), (booking_status + room_number)
reservations: (status + check_in_date)
notifications: (user_uid + is_read)
cash_logs: (business_date + booking_id)
audit_logs: (action + business_date)
inventory_products: (status + category_id)

### 8.2 MISSING Indexes (will cause query failures when reads enabled)

| Query Pattern | Collection | Missing Index |
|---|---|---|
| WHERE booking_id ORDER BY created_at | ledger_items (root) | booking_id + created_at |
| WHERE business_date | ledger_items | business_date |
| WHERE booking_id | payments (root) | booking_id |
| WHERE status | staff | status |
| WHERE arrival_date >= ? | reservations | arrival_date |

WARNING: Any Firestore query without a required composite index will FAIL with "requires an index" error.
Missing indexes must be deployed BEFORE ENABLE_FIRESTORE_READS is activated.

---

## 9. FIRESTORE DATA STATE

ENABLE_FIRESTORE_READS=false — no live Firestore data currently read. MySQL remains authoritative.

| Collection | Populated Via | Current State |
|---|---|---|
| room_types | Phase 3B seed | Likely exists (4 types confirmed in dry-run) |
| rooms | Phase 3C seed | Likely exists |
| staff | Phase 3D migration | Unknown |
| inventory_categories | Phase 3E | Unknown |
| inventory_products | Phase 3G | Unknown |
| guests | Phase 3H (new registrations only) | INCOMPLETE — historical guests not migrated |
| bookings | Phase 3K-2 (new bookings only) | INCOMPLETE — historical bookings not migrated |
| reservations | No migration, no outbox producer | EMPTY |
| payments | No migration, no outbox producer | EMPTY |
| invoices | No migration, no outbox producer | EMPTY |
| ledger_items | Via compound events (flag OFF) | EMPTY |
| cash_logs | No outbox producer | EMPTY |
| settings/system_date | No compound event fired yet | STALE or MISSING |

CRITICAL: No complete data migration exists for transactional collections. Enabling Firestore reads
now will show an INCOMPLETE picture of hotel operations.

---

## 10. FEATURE FLAG ACTIVATION SAFETY

### ENABLE_FIRESTORE_DUAL_WRITE

Effect: All isFirestoreDualWriteEnabled() blocks activate.
Risk: RESERVATION, PAYMENT, INVOICE, CASH_SUBMISSION mutations NOT covered — immediate divergence.
Rollback: Set false -> all new enqueue() calls stop instantly.
Prerequisite: Missing outbox producers implemented + historical migration complete.
CURRENT STATUS: NOT READY — payment and reservation domains uncovered.

### ENABLE_FIRESTORE_OUTBOX_WORKER

Effect: Worker setInterval starts at server boot.
Risk: If Firestore misconfigured, worker enters retry loop consuming MySQL throughput.
Rollback: Set false + restart server -> worker does not restart.
Concurrent: Multiple processes safe (UPDATE guard prevents double processing).
CURRENT STATUS: NOT READY — dual-write not yet enabled.

### ENABLE_FIRESTORE_READS

Effect: Firestore used as READ source for supported repositories.
Risk: CRITICAL — incomplete data shows wrong information to users.
Rollback: Set false -> MySQL reads resume instantly.
Prerequisite: Full data sync + indexes deployed + reconciliation passed.
CURRENT STATUS: NOT READY.

### ENABLE_FIRESTORE_RECONCILIATION

Effect: Reconciliation process runs.
Current State: No reconciliation service exists in codebase.
CURRENT STATUS: NOT READY — no service implemented.

### Recommended Activation Order

STEP 0: Implement missing outbox producers (reservation/payment/invoice/cash) + historical migration
STEP 1: ENABLE_FIRESTORE_DUAL_WRITE=true (test 1 Check-In, verify outbox row)
STEP 2: ENABLE_FIRESTORE_OUTBOX_WORKER=true (verify Firestore updated)
STEP 3: Monitor 7 days — check DEAD_LETTER count + Firestore document correctness
STEP 4: Deploy Firestore indexes (existing + missing)
STEP 5: Run full reconciliation comparison
STEP 6: ENABLE_FIRESTORE_READS=true for 1 non-critical collection (room_types)
STEP 7: ENABLE_FIRESTORE_READS for transactional collections after sustained correctness

---

## 11. FAILURE MATRIX

| # | Failure | MySQL | Outbox | Firestore | Expected Result | Safe? |
|---|---|---|---|---|---|---|
| 1 | MySQL mutation fails | ROLLBACK | Nothing written | Unchanged | Error to client | YES |
| 2 | enqueue() fails | ROLLBACK propagates | Nothing written | Unchanged | Error, tx rolled back | YES |
| 3 | MySQL ROLLBACK after enqueue | Rolled back including outbox row | Rolled back atomically | Unchanged | Clean state | YES |
| 4 | MySQL COMMIT succeeds | Committed | PENDING row committed | Not yet written | Event awaits worker | YES |
| 5 | Worker crashes before dispatch | Committed | Stuck in PROCESSING | Unchanged | reclaimStaleProcessing after lease timeout | YES (with delay) |
| 6 | Worker crashes AFTER Firestore commit before markProcessed | Committed | Stuck in PROCESSING | WRITTEN | reclaimStaleProcessing -> retry -> idempotent re-write | YES (idempotent) |
| 7 | Firestore unavailable | Committed | FAILED -> retry | Unchanged | Backoff retry; eventually DEAD_LETTER | YES (at-least-once) |
| 8 | Malformed event payload | Committed | FAILED -> DEAD_LETTER | Unchanged | DispatcherError; ERROR logged | YES (manual fix) |
| 9 | Duplicate event_id | Would fail UNIQUE KEY | DUPLICATE_EVENT_ID error | Unchanged | Prevented at enqueue | YES |
| 10 | Stale event replayed | Committed | Re-processed | May write stale values | set_merge prevents full overwrite | LOW RISK |
| 11 | Server restart | In-flight tx may rollback | PROCESSING recovered after lease | Unchanged until retry | Same as #5 | YES |
| 12 | Worker restart | N/A | PROCESSING recovered | Unchanged until retry | reclaimStaleProcessing on startup | YES |
| 13 | Two workers simultaneously | N/A | Each claims different events | Each writes different events | No duplicate processing | YES |
| 14 | Firestore rules reject Admin SDK | Committed | FAILED -> retry | Unchanged | Indicates misconfiguration | MEDIUM |
| 15 | Batch >490 ops | ROLLBACK (builder throws before enqueue) | Nothing written | Unchanged | Compound: prevented at builder | YES |

---

## 12. PRODUCTION CUTOVER GATES

### A. DUAL-WRITE ACTIVATION GATE

PASS: All domains have outbox producers; historical migration complete; pool.query mutations wrapped in tx.
FAIL: Any payment/reservation/invoice mutation uses pool.query without enqueue.
Rollback: ENABLE_FIRESTORE_DUAL_WRITE=false.
CURRENT STATUS: NOT READY — PAYMENT and RESERVATION have ZERO outbox coverage.

### B. WORKER ACTIVATION GATE

PASS: Dual-write running >=24h; 1 event dispatched successfully; DEAD_LETTER=0.
FAIL: No events in outbox table; Firestore SDK failure.
Rollback: ENABLE_FIRESTORE_OUTBOX_WORKER=false + restart.
CURRENT STATUS: NOT READY.

### C. FIRESTORE READS ACTIVATION GATE

PASS: Dual-write running >=7 days; MySQL/Firestore count discrepancy <0.1%; all indexes deployed; DEAD_LETTER=0 for 72h.
FAIL: Any historical record missing; any index missing; DEAD_LETTER events present.
Rollback: ENABLE_FIRESTORE_READS=false (MySQL reads resume instantly).
CURRENT STATUS: NOT READY.

### D. RECONCILIATION ACTIVATION GATE

PASS: Reconciliation service implemented and tested.
CURRENT STATUS: NOT READY — no service exists.

---

## 13. DELIVERY GUARANTEE ANALYSIS

### System Guarantee: AT-LEAST-ONCE

Trace:
  1. MySQL BEGIN
  2. MySQL business mutations
  3. enqueue(conn, event) — INSERT to dual_write_outbox inside transaction
  4. MySQL COMMIT — outbox row atomically visible to worker
  5. Worker: claimNextBatch -> status=PROCESSING
  6. Worker: dispatchEvent -> batch.commit() — Firestore write committed
  7. Worker: markProcessed -> status=PROCESSED

What happens when batch.commit() succeeds but markProcessed() fails?

  batch.commit()   -> SUCCESS — Firestore write committed permanently
  markProcessed()  -> FAILS (MySQL connectivity issue)

Result:
  Event stays PROCESSING in MySQL.
  After OUTBOX_PROCESSING_LEASE_MINUTES (default 10min): reclaimStaleProcessing() -> FAILED.
  Worker retries: dispatchEvent() called AGAIN with SAME descriptors.
  Firestore receives duplicate write.

For compound events (set_merge + deterministic IDs):
  Retry is idempotent. Outcome correct. EFFECTIVELY-ONCE.

For legacy events (createPaymentFirestore on retry):
  May produce duplicate document or succeed silently per repository implementation.
  AT-LEAST-ONCE.

CONCLUSION:
  Compound events (B3-B7): EFFECTIVELY-ONCE
  Legacy events: AT-LEAST-ONCE
  Overall: AT-LEAST-ONCE

---

## 14. CAPACITY / SCALE LIMITS

| Limit | Value | Enforcement |
|---|---|---|
| Firestore batch hard limit | 500 operations | Firebase SDK |
| HPMS configured batch limit | 490 (FIRESTORE_MAX_BATCH_OPS) | builder.build() + dispatchCompoundEvent() |
| Night Audit max rooms | 244 (2*244+1=489 < 490) | builder.build() WRITE_SET_TOO_LARGE |
| Night Audit >244 rooms | ROLLBACK before enqueue | builder.build() throws |
| Outbox worker batch size | 10 events/cycle | FIRESTORE_OUTBOX_BATCH_SIZE (default 10) |
| Worker poll interval | 3000ms | FIRESTORE_OUTBOX_POLL_INTERVAL_MS (default 3000) |
| Max retry attempts | 5 | FIRESTORE_OUTBOX_MAX_RETRIES (default 5) |
| PROCESSING lease timeout | 10 minutes | OUTBOX_PROCESSING_LEASE_MINUTES (default 10) |
| Max backoff | 300 seconds | Hard-coded cap in markFailed() |
| Outbox event payload | ~65KB (MySQL TEXT) | MySQL TEXT column |
| event_id collision risk | Extremely low | crypto.randomBytes(4) + timestamp |

---

## 15. FINAL VERDICT

### OVERALL VERDICT: READY WITH CONDITIONS

The core outbox architecture (4E-A through 4E-B7) is sound and safe for the four primary
transactional domains. However, critical gaps block production activation.

---

### CRITICAL BLOCKERS

1. Payment domain has ZERO Outbox coverage.
   paymentController.finalizePayment() and confirmCashPayment() use pool.query OUTSIDE any transaction.
   Safe coverage requires: wrap in transaction + add enqueue(). Cannot add enqueue without tx.
   Enabling dual-write while uncovered will produce permanently diverged Firestore payment data.

2. Reservation domain has ZERO Outbox coverage.
   createReservation, updateReservation, cancelReservation have no enqueue() calls.
   All reservations after dual-write activation will NOT appear in Firestore.

3. Invoice domain has ZERO Outbox coverage.
   invoiceController uses pool.query for INSERT/UPDATE — outside any transaction.

4. No historical data migration.
   Firestore collections for bookings, payments, invoices, reservations, ledger_items are EMPTY.
   Enabling Firestore reads shows incomplete/empty operational data to users.

---

### HIGH-RISK ITEMS

5. Missing composite indexes.
   ledger_items, payments, staff Firestore queries will FAIL with "requires an index" error.
   Must deploy indexes BEFORE enabling reads.

6. claimNextBatch is not fully atomic.
   SELECT then UPDATE without SELECT FOR UPDATE. Safe due to UPDATE guard but a TOCTOU gap exists.

7. Cash submission has no Outbox coverage.
   submitCash() inserts cash_submissions inside a transaction but does not enqueue.

8. No reconciliation service.
   No automated mechanism to detect MySQL/Firestore divergence after activation.

---

### MEDIUM-RISK ITEMS

9. undoDayEnd has no Outbox event.
   Firestore settings/system_date shows advanced date while MySQL shows rolled-back date after undo.

10. Guest profile updates not fully covered.
    modifyCheckIn enqueues BOOKING_UPDATED but not GUEST_UPDATED. Guest documents not updated.

11. Dispatcher adds updated_at at dispatch time for legacy events without updated_at in payload.
    Introduces staleness of up to OUTBOX_PROCESSING_LEASE_MINUTES.

12. Night Audit Undo creates Firestore/MySQL desync.
    Compound event already dispatched; Firestore shows tariff records and new date; MySQL rolled back.

13. No SIGTERM/SIGINT graceful shutdown handler.
    Cosmetic for single-process; matters for Docker/Kubernetes orchestration.

---

### LOW-RISK ITEMS

14. settings collection readable by any authenticated user (including guests).
    Business date and room counts visible to guest portal users.

15. daily_analytics collection has rules but no writer (placeholder only).

16. Audit log mutations not replicated to Firestore.

17. Notification mutations not replicated.

18. BOOKING_STATUS_CHANGED dispatcher handler has no producer (dead code).

19. Stay extension mutations not replicated.

---

### SAFE ITEMS

20. All four compound events correctly bounded within MySQL transactions.
21. All 25 active enqueue() sites use the active connection and are BEFORE commit().
22. Concurrent worker safety — UPDATE guard prevents double processing.
23. Exponential backoff with DEAD_LETTER transition at maxRetries. Confirmed working.
24. PROCESSING lease recovery (reclaimStaleProcessing) confirmed (34/34 Phase 4E-A tests).
25. All compound events use set_merge + deterministic IDs. EFFECTIVELY-ONCE.
26. No FieldValue.increment() in any compound event payload.
27. Admin SDK bypasses client security rules — server writes always succeed unless misconfiguration.
28. FIRESTORE_MAX_BATCH_OPS=490 guard prevents Firebase 500-op breach.
29. Feature flags default to false — zero production Firestore writes possible in current state.
30. Build: PASS (2849 modules).
31. Tests: 325/325 PASS.
32. Zero production MySQL/Firestore writes during this audit.

---

## SUMMARY TABLE

| Category | Count | Items |
|---|---|---|
| CRITICAL BLOCKERS | 4 | Payment/Reservation/Invoice no outbox; no historical migration |
| HIGH RISK | 4 | Missing indexes; non-atomic claim; cash no outbox; no reconciliation |
| MEDIUM RISK | 5 | UndoDayEnd desync; guest update gap; staleness; desync on undo; no SIGTERM handler |
| LOW RISK | 6 | Settings readability; analytics placeholder; unreplicated audit/notifications/extensions/dead code |
| SAFE | 13 | Core compound outbox architecture verified correct |

---

```
CODE CHANGES: 0
MYSQL WRITES: 0
FIRESTORE WRITES: 0
AUTH MUTATIONS: 0
DEPLOYMENTS: 0
COMMITS: 0
PUSHES: 0
```

STOP. WAITING FOR REVIEW.
