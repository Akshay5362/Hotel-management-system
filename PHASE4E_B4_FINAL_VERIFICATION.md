# Phase 4E-B4: Final Verification Report

## 1. Git Baseline
**Verified via `git status` and `git diff`**:
- The changes strictly align with the scope of B4 (i.e. `backend/controllers/roomController.js`, `backend/services/checkOutService.js`, `backend/services/compoundEventBuilder.js`, and `backend/tests/testPhase4EB4CheckOutCompoundEvent.mjs`).
- Previous work (Phase 4E-A/B1/B2/B3) remains intact and un-reverted.

## 2. Controller/Service Extraction
**Verified**:
- The entirety of the transactional logic and data mutations have been relocated from `roomController.checkOut` to `checkOutService.processCheckOut`.
- `roomController.js` correctly forwards `req.params` and `req.body` and manages the HTTP response payload structure (`res.status().json()`).
- The same error propagation model is observed. `processCheckOut` explicitly sets `error.status = 404/400` which the controller applies if present, defaulting to `500`.

## 3. Transaction Boundary
**Verified**:
The exact flow is:
1. `roomController`: `connection = await pool.getConnection();` -> `await connection.beginTransaction();`
2. `checkOutService.processCheckOut`:
   - MySQL Check-Out operations (UPDATE rooms, bookings, INSERTS etc).
   - INSERT IDs are captured (`cashLogMysqlId`, `paymentMysqlId`, `historyMysqlId`).
   - `today_checkouts` is updated and immediately re-selected.
   - `createCompoundEventBuilder(...)` is called.
   - `enqueue(connection, ...)` is called.
3. `CheckoutRecoveryService.createSnapshot(connection, ...)` runs.
4. `roomController`: `await connection.commit();`

**Critical Safety**:
- `enqueue()` uses the SAME `connection` as the business logic.
- Outbox `INSERT` happens before `COMMIT`.
- If `enqueue()` fails, the thrown error propagates back up to the `catch (error)` block in `roomController.js`, executing `await connection.rollback();`.

## 4. Snapshot Ordering
**Verified**:
- `createCompoundEventBuilder` and `enqueue` occur immediately before `CheckoutRecoveryService.createSnapshot()`.
- `createSnapshot()` uses the same connection.
- `createSnapshot()` explicitly swallows errors internally (`MUST NOT throw`) so the transaction commits even if snapshot capture fails.
- Because Firestore uses deterministic ID `snap_${bkgDocId}` rather than a MySQL `insertId` for snapshots, it doesn't need to wait for `createSnapshot()` to produce an ID. Thus, placing the enqueue before snapshot capture poses no consistency issue.

## 5. MySQL Insert IDs
**Verified**:
- **payments**: INSERT performed -> `paymentMysqlId = paymentResult.insertId` captured -> formatted with `formatPaymentId()`.
- **ledger_items**: Not inserted during Check-Out (they are pre-existing).
- **booking_history**: INSERT performed -> `historyMysqlId = historyResult.insertId` captured -> formatted with `formatHistoryId()`.
- **invoices**: INSERT... ON DUPLICATE KEY UPDATE. The canonical business ID `invoiceNumber` is formatted with `formatInvoiceId()`. `insertId` is intentionally ignored due to `ON DUPLICATE KEY`.
- **cash_logs**: INSERT performed -> `cashLogMysqlId = cashLogResult.insertId` captured -> formatted with `formatCashLogId()`.
- **checkout_snapshots**: Inserted later by `createSnapshot`. `insertId` is NOT captured; the Firestore document ID uses `snap_${bkgDocId}`.

## 6. Counter
**Verified**:
- `today_checkouts` is updated via standard SQL (`+ 1`).
- The final absolute value is immediately fetched in the same transaction: `SELECT value_val FROM system_settings WHERE key_name = 'today_checkouts'`.
- This absolute number is passed directly to the builder. No `FieldValue.increment()` is used.

## 7. Exact Firestore Write Set
**Verified**:

| # | PATH | OPERATION | CONDITION | MYSQL SOURCE | DOCUMENT ID | MERGE MODE |
|---|---|---|---|---|---|---|
| 1 | `bookings` | `set_merge` | Always | `bookings` | `bkg_{booking_number}` | true |
| 2 | `rooms` | `set_merge` | Always | `rooms` | `room_{number}` | true |
| 3 | `invoices` | `set_merge` | Always | `invoices` | `inv_{invoiceNumber}` | true |
| 4 | `booking_history` (root) | `set_merge` | Always | `booking_history` | `history_{historyMysqlId}` | true |
| 5 | `bookings/{bkgId}/history` (sub) | `set_merge` | Always | `booking_history` | `history_{historyMysqlId}` | true |
| 6 | `payments` (root) | `set_merge` | `parsedBalancePaid !== 0` | `payments` | `payment_{paymentMysqlId}` | true |
| 7 | `bookings/{bkgId}/payments` (sub) | `set_merge` | `parsedBalancePaid !== 0` | `payments` | `payment_{paymentMysqlId}` | true |
| 8 | `cash_logs` | `set_merge` | `parsedBalancePaid !== 0` | `cash_logs` | `cash_log_{cashLogMysqlId}` | true |
| 9 | `settings/system_date` | `set_merge` | Always | `system_settings` | `system_date` | true |
| 10 | `checkout_snapshots` | `set_merge` | Always | memory | `snap_{bkgId}` | true |

## 8. Root + Subcollection
**Verified**:
- **payments**: Conditional dual-write using `addDualWrite`. Root: `payments/{paymentDocId}`, Sub: `bookings/{bkgDocId}/payments/{paymentDocId}`. Same data, same event.
- **booking_history**: Dual-write using `addDualWrite`. Root: `booking_history/{historyDocId}`, Sub: `bookings/{bkgDocId}/history/{historyDocId}`. Same data, same event.
- **ledger_items**: Not applicable (ledger items are written on check-in or manual posting, not on check-out natively).

## 9. Deterministic IDs
**Verified**:
| ENTITY | CANONICAL FORMAT | ACTUAL FORMAT | MATCH |
|---|---|---|---|
| booking | `bkg_...` | `formatBookingId()` | YES |
| room | `room_...` | `formatRoomId()` | YES |
| invoice | `inv_...` | `formatInvoiceId()` | YES |
| payment | `payment_...` | `formatPaymentId()` | YES |
| history | `history_...` | `formatHistoryId()` | YES |
| cash_log | `cash_log_...` | `formatCashLogId()` | YES |

- No `Math.random()`, `randomUUID()`, or non-deterministic ID generation is present in the `checkOutService.js` builder path.

## 10. Idempotency
**Verified**:
- Event captures its own `occurred_at` timestamp before generation. This `eventOccurredAt` timestamp is used universally for all `updated_at`/`created_at` fields within the payload.
- All writes use `set_merge` (via `addRootWrite` and `addDualWrite`).
- The counter relies on an absolute value captured at transaction time.
- A worker retry simply re-applies the exact same JSON with the exact same `eventOccurredAt` and counter values.

## 11. Failure / Rollback Matrix
| SCENARIO | MYSQL STATE | OUTBOX STATE | FIRESTORE STATE | EXPECTED RESULT |
|---|---|---|---|---|
| MySQL business mutation fails | Rolled back | None | None | 500 error; system consistent |
| Payment/Cash/History INSERT fails | Rolled back | None | None | 500 error; system consistent |
| Compound event builder fails | Rolled back | None | None | 500 error; system consistent |
| Outbox enqueue fails | Rolled back | None | None | 500 error; system consistent |
| Checkout snapshot fails | Committed | Enqueued | None (yet) | 200 Success; snapshot lost in MySQL but Firestore is updated |
| COMMIT fails | Rolled back | None | None | 500 error; system consistent |
| Firestore batch fails | Committed | PENDING / FAILED | None | Worker retries based on backoff |
| Firestore batch succeeds / worker crashes | Committed | PROCESSING | Updated | Worker reclaims stale event, retries, idempotent re-apply |
| Event retries | Committed | PROCESSED | Updated | State is unchanged in DB/Firestore |

## 12. Feature Flag
**Verified**:
- The compound event construction and `enqueue()` are fully gated inside `if (isFirestoreDualWriteEnabled())`.
- When disabled, no compound event is built, and `enqueue` is skipped entirely. Check-Out completes successfully via MySQL only.

## 13. Batch Size
**Verified**:
- Maximum possible writes per Check-Out transaction: 10 (as outlined in section 7).
- `FIRESTORE_MAX_BATCH_OPS` is typically 500.
- `10 < 500`. No possible normal Check-Out exceeds the configured limit.

## 14. Test Quality
**Verified**:
- The `testPhase4EB4CheckOutCompoundEvent.mjs` comprehensively covers:
  - Mock connection assertions (proving transaction sequence)
  - InsertId captures (payment: 88, cash_log: 77, etc)
  - Exact dual write validations on payments and history.
  - Verification of no `_methodName` sentinels or `FieldValue.increment` (Group 6).
  - Validation of the feature-flag toggling (Group 2).
  - Rejection propagation testing (Group 7).
- The subcollection test bug (`w.parentCollection` vs `w.collection`) was successfully addressed.

## 15. Regression
**Verified**:
- **B4 Check-Out tests**: 23/23 PASS
- **B3 Check-In tests**: PASS
- **B2 Builder tests**: PASS
- **B1 Dispatcher tests**: PASS
- **Phase 4E-A reliability tests**: 34/34 PASS
- **Phase 3A infra tests**: PASS

## 16. Business Behavior Regression
**Verified**:
- Absolutely no change to the logic. `checkOutService.js` contains a 1:1 copy of the pre-existing checkout code block, replacing `res.status` with `throw new Error()` formatted correctly for the controller.
- All HTTP responses (`res.json()`), audit log insertions, room status updates, guest notifications, etc., remain exactly as they were.

## 17. File Scope
**Verified**:
- `backend/controllers/roomController.js` (refactored)
- `backend/services/checkOutService.js` (created/implemented)
- `backend/services/compoundEventBuilder.js` (re-export added)
- `backend/tests/testPhase4EB4CheckOutCompoundEvent.mjs` (test suite created)
- No other unexpected domain logic files were altered.

## 18. Final Verdict
**PASS — SAFE TO PROCEED TO B5 AUDIT**

CODE CHANGES: 0
MYSQL WRITES: 0
FIRESTORE WRITES: 0
AUTH MUTATIONS: 0
DEPLOYMENTS: 0
COMMITS: 0
PUSHES: 0
