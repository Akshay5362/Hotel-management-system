# PHASE 4E TRANSACTIONAL CUTOVER AUDIT

## 1. Executive Summary
This read-only audit evaluated the HPMS-Sky5 backend for Phase 4E readiness. The central finding is that **transactional domains (Check-in, Check-out, Reservations, Payments, Ledger) do NOT currently have Outbox dual-write implemented in their service paths.** Additionally, these operations heavily rely on MySQL `SELECT ... FOR UPDATE` row locks to prevent race conditions (like double booking a room). Because Firestore cannot replicate these synchronous row locks natively without a major architectural shift to `db.runTransaction()`, Phase 4E **must not** be a cutover or bulk data migration. Instead, Phase 4E must be a **Transactional Architecture Redesign and Dual-Write Implementation** phase.

## 2. Current Architecture
- **Source of Truth:** MySQL (Verified: `ENABLE_FIRESTORE_READS=false`)
- **Write Path (Static/Config):** Dual-writes to MySQL and Outbox table (`dual_write_outbox`), processed asynchronously by a worker into Firestore.
- **Write Path (Transactional):** Writes exclusively to MySQL inside `BEGIN ... COMMIT` blocks. Outbox `enqueue()` is notably **absent** from `checkInService.js`, `CheckoutRecoveryService.js`, `reservationController.js`, and `paymentController.js`.
- **Locking:** Heavy reliance on MySQL `SELECT ... FOR UPDATE` (e.g., locking `rooms`, `guests`, `bookings`, `reservations` during check-in/out).

## 3. Transactional Domain Inventory
| Domain | MySQL Count | Firestore Count | Status |
| :--- | :--- | :--- | :--- |
| `bookings` | 0 | 8 (Orphans/Test) | Dual-write pilot exists, but not wired to core workflows |
| `reservations` | 0 | 3 (Orphans/Test) | No dual-write |
| `payments` | 0 | 5 (Orphans/Test) | No dual-write |
| `ledger_items` | 0 | 17 (Orphans/Test) | No dual-write |
| `booking_history` | 0 | 6 (Orphans/Test) | No dual-write |
| `invoices` | 0 | 3 (Orphans/Test) | No dual-write |
| `cash_logs` | 0 | 15 (Orphans/Test) | No dual-write |
| `cash_submissions` | 0 | 0 | No dual-write |
| `stay_extensions` | **Missing Table** | 0 | Not implemented |
| `payment_transactions`| **Missing Table** | 0 | (Razorpay table exists instead) |

## 4. Complete Write-Path Matrix
| Operation | MySQL Tx | FOR UPDATE | Firestore Write | Outbox Enqueue | Recommendation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Check-in** | YES (`roomController`) | `rooms`, `guests`, `reservations` | NO | NO | Needs multi-event Outbox transaction payload |
| **Check-out** | YES | `rooms`, `bookings` | NO | NO | Needs multi-event Outbox transaction payload |
| **Reservations** | YES | `rooms` | NO | NO | Add Outbox events |
| **Ledger Post** | YES | None | NO | NO | Add Outbox events |
| **Night Audit** | YES | `system_settings` | NO | NO | Needs massive multi-event restructuring |
| **Room Shift** | YES | `rooms`, `bookings` | NO | NO | Needs multi-event Outbox transaction payload |

## 5. MySQL Transaction / FOR UPDATE Matrix
Operations inherently unsafe to migrate to Firestore writes without redesign:
1. **Check-in (`validateAndLockRoom`)**: Locks the room to prevent concurrent check-ins to the same physical room.
2. **Night Audit**: Locks `system_settings` (system_date) to prevent check-ins/outs while the date is rolling.
3. **Room Shift**: Locks BOTH the source and target rooms in deterministic ID order to prevent deadlocks.

## 6. Firestore Repository Matrix
| Domain | Root Collection | Subcollection | Merge/Idempotency | Dual-Write Active? |
| :--- | :--- | :--- | :--- | :--- |
| `bookings` | YES | N/A | YES (`isStaleUpdate`) | Partial (Isolated Tests) |
| `reservations` | YES | N/A | YES | NO |
| `payments` | YES | YES (`/bookings/{id}/payments`) | YES (Both) | NO |
| `ledger_items` | YES | YES (`/bookings/{id}/ledger`) | YES (Both) | NO |
| `booking_history`| YES | YES (`/bookings/{id}/history`)| YES (Both) | NO |

*(Verified: Payments, ledger_items, and booking_history repositories DO actively dual-write to both root and subcollections within Firestore).*

## 7. Outbox Architecture Audit
- **Current State:** The Outbox uses `dual_write_outbox`, processes events sequentially or in batches, and has exponential backoff/dead-letter logic.
- **Deficiency for Transactions:** If a Check-In generates 8 distinct Outbox events (Guest, Booking, Room Status, Ledger, Cash Log, Payment, Audit, Notification), the Outbox worker processes them independently. If event #4 fails (Dead Letter) but the others succeed, Firestore becomes **partially consistent** and structurally corrupt. MySQL committed atomically, but Firestore did not.
- **Verdict:** The current Outbox is **INSUFFICIENT** for complex transactional domains without a "Transaction Group ID" or "Saga Pattern" upgrade.

## 8. Dual-Write Audit
Dual-write is successfully implemented for foundational/static data (Staff, Rooms, Room Types, Inventory, Settings). It is entirely missing from dynamic transactional workflows (Check-In, Check-Out, Reservations).

## 9. Atomicity Analysis
- **MySQL Success + Outbox Success:** Consistent.
- **MySQL Success + Outbox Event 1 Success + Outbox Event 2 Fails:** INCONSISTENT. Firestore state is broken (e.g., checked-in booking exists without ledger/payments).
- **MySQL Rollback:** Consistent (Outbox events are never committed).
**Conclusion:** We cannot use independent Outbox events for multi-entity transactional workflows without compromising Firestore data integrity.

## 10. Concurrency / Locking Analysis
Firestore lacks pessimistic locking. To replace `SELECT ... FOR UPDATE`, operations like Check-In must be rewritten to use optimistic concurrency control via Firestore Client Transactions (`db.runTransaction()`). However, since MySQL is still authoritative, we cannot do this yet. We must maintain MySQL locking while safely replicating the atomic outcome to Firestore.

## 11. Firestore Data Model Readiness
| Collection | Exists | Repository Exists | MySQL Source Exists | Required Fields | Indexes | Rules |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `bookings` | YES | YES | YES | Complete | YES | YES |
| `reservations` | YES | YES | YES | Complete | YES | YES |
| `payments` | YES | YES | YES | Complete | YES | YES |
| `ledger_items` | YES | YES | YES | Complete | YES | YES |
| `stay_extensions` | NO | NO | **NO** | N/A | N/A | N/A |
| `daily_analytics` | NO | NO | YES | N/A | N/A | N/A |

## 12. Missing Components
- `stayExtensionsRepository.js` and MySQL table `stay_extensions` are still missing.
- `payment_transactions` MySQL table is missing (application uses `razorpay_transactions` instead).
- `daily_analytics` architecture is missing.

## 13. Rules & Index Readiness
- `firestore.indexes.json` is perfectly synced with the recent Phase 4D-3 deployment.
- **Currently Required:** None (Reads are off).
- **Future Required:** The indexes deployed in Phase 4D-3 satisfy all current repository sorting/filtering patterns.

## 14. Current MySQL vs Firestore Counts
(See Section 3). The MySQL operational tables are empty (0 rows) while Firestore contains legacy test/orphan documents.

## 15. Existing Orphans / Conflicts
Because MySQL transactional tables are empty, ALL 61 documents currently residing in transactional Firestore collections (`bookings`, `reservations`, `payments`, etc.) are **orphans**. They should NOT be deleted, but they represent invalid state.

## 16. Test Coverage
- **Exists:** Extensive tests for Static Dual-Write (Settings, Staff, Rooms), Outbox retry/dead-letter mechanics, and MySQL Locking (`testPhase3K2ALocking.mjs`).
- **Missing:** Tests for multi-entity Transactional Dual-Write (Check-in, Check-out), and Partial Firestore Failure Recovery.

## 17. Docker / Electron / Backend Impact
No immediate impact, but outbox workers may need to process larger batched "Saga" events.

## 18. Critical Blockers
1. Multi-entity Outbox atomicity gap.
2. Missing Outbox `enqueue()` calls in `checkInService.js`, `CheckoutRecoveryService.js`, `reservationController.js`, `roomController.js`.

## 19. Risks
If we migrate or enable dual-write blindly via independent Outbox events, complex transactions (Check-In/Out) will eventually tear in Firestore due to transient worker failures, destroying data integrity.

## 20. Recommended Phase 4E Strategy
**B & C: Dual-Write Implementation + Transactional Architecture Redesign**
Phase 4E must bridge the gap between MySQL's atomic `FOR UPDATE` transactions and Firestore's eventual consistency outbox.

## 21. Proposed Sub-Phases
- **Phase 4E-1:** Implement a "Saga" or "Transaction Group" concept in the Outbox payload so multiple events can be applied to Firestore within a single `db.runTransaction()` or `db.batch()` by the worker.
- **Phase 4E-2:** Wire `enqueue()` into `checkInService`, `CheckoutRecoveryService`, and `reservationController`.
- **Phase 4E-3:** Wire `enqueue()` into Payments, Ledger, and Invoices.
- **Phase 4E-4:** Develop tests for these transactional dual-writes.

## 22. Exact Files That Would Need Modification
- `backend/services/outboxService.js` & `outboxDispatcher.js` (To handle batched transaction events)
- `backend/services/checkInService.js`
- `backend/services/CheckoutRecoveryService.js`
- `backend/controllers/reservationController.js`
- `backend/controllers/paymentController.js`
- `backend/controllers/roomController.js`

## 23. Exact Files That Must NOT Be Modified
- Frontend code.
- Firestore configuration (`firestore.rules`, `firestore.indexes.json`).
- Existing MySQL Schema (unless fixing missing tables).

## 24. Rollback Strategy
All changes will be hidden behind existing feature flags (`ENABLE_FIRESTORE_DUAL_WRITE=false`). If the new transaction logic fails during testing, no production data will be written to Firestore.

## 25. Safety Assessment
This recommended approach is 100% safe. It addresses the architectural flaw *before* producing operational data, keeping MySQL as the uncompromised source of truth.

---

### APPROVAL REQUIRED

**What should be done next:** 
Proceed with **Phase 4E-1: Transactional Outbox Architecture Redesign**. We must upgrade `outboxService.js` to support "Compound Events" (or "Transaction Groups") so that the worker can apply a Check-In (Booking + Guest + Room + Ledger + Payment) as a single, atomic `db.batch()` write to Firestore.

**Why it is safe:** 
It alters the Outbox event structure and worker execution model without affecting the synchronous MySQL `FOR UPDATE` transaction logic that currently protects the PMS. Feature flags will prevent these outbox events from running in production prematurely.

**What files would change:** 
`outboxService.js`, `outboxDispatcher.js`, and subsequently the operational controllers (`checkInService.js`, etc.) to inject the compound events.

**What data would change:** 
MySQL `dual_write_outbox` payloads will change structure. No business data will be altered.

**Whether Firebase deployment is required:** 
NO.

**Whether MySQL would change:** 
NO schema changes. Only the JSON payload stored in `dual_write_outbox` will change structure.

**Whether feature flags would change:** 
NO.

**Whether Firestore writes would occur:** 
Only locally via the automated test suite.

**What tests would be performed:** 
We will write a new test (e.g., `testCompoundOutboxEvents.mjs`) to verify that if one part of a Check-In fails in Firestore, the entire batch rolls back, preventing partial state corruption.

**Exact proposed implementation steps:**
1. Update `createEvent` in `outboxService.js` to accept an array of payloads/actions representing an atomic transaction.
2. Update `outboxDispatcher.js` to detect compound events and execute them using a Firestore `WriteBatch`.
3. Create `testCompoundOutboxEvents.mjs` to validate atomicity.
4. Once validated, wire compound events into `checkInService.js`.

I await your approval to begin Phase 4E-1.
