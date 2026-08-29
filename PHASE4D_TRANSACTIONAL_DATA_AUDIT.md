# PHASE 4D: DYNAMIC TRANSACTIONAL DATA AUDIT

## 1. Exact Domain Inventory & Dependencies

| Domain | MySQL Source Table | Firestore Collection | Dependencies (Foreign Keys) |
| :--- | :--- | :--- | :--- |
| **Bookings** | `bookings` | `/bookings/bkg_{number}` | `guests`, `rooms` |
| **Reservations** | `reservations` | `/reservations/res_{number}` | `guests`, `rooms` |
| **Payments** | `payments` | `/payments`, `/bookings/{id}/payments` | `bookings`, `guests` |
| **Invoices** | `invoices` | `/invoices/inv_{number}` | `bookings` |
| **Ledger Items** | `ledger_items` | `/ledger_items`, `/bookings/{id}/ledger_items` | `bookings`, `rooms` |
| **Booking History**| `booking_history` | `/booking_history`, `/bookings/{id}/history`| `bookings` |
| **Cash Logs** | `cash_logs` | `/cash_logs/cash_{id}` | `bookings` (optional) |
| **Cash Submissions**| `cash_submissions` | `/cash_submissions/sub_{id}` | None |
| **Razorpay TXs** | *None (Table missing)* | `/razorpay_transactions` | *N/A* |
| **Checkout Snaps** | *None (Table missing)* | `/checkout_snapshots` | *N/A* |
| **Stay Extensions**| *None (Table missing)* | `/stay_extensions` | *N/A* |

## 2. MySQL Counts (Current Baseline)
*Note: Due to a previous system factory-reset, all transactional tables currently contain 0 rows.*
- `bookings`: 0
- `reservations`: 0
- `payments`: 0
- `invoices`: 0
- `ledger_items`: 0
- `booking_history`: 0
- `cash_logs`: 0
- `cash_submissions`: 0

## 3. Firestore Counts (Existing Orphan/Test Data)
- `bookings`: 8
- `reservations`: 3
- `payments`: 5
- `invoices`: 3
- `ledger_items`: 17
- `booking_history`: 6
- `cash_logs`: 15

*Note: These are legacy/orphan documents. Because MySQL is 0, any migration script will naturally ignore these if doing a SELECT-driven sync. They MUST NOT be deleted automatically.*

## 4. Dependency Graph & Recommended Migration Order
1. **Bookings & Reservations**: Must be migrated first.
2. **Payments, Ledger Items, Booking History**: Depend on Bookings. **CRITICAL FINDING:** The Firestore repositories for these domains perform a **Dual-Write** to both a root collection (`/payments`) and a subcollection (`/bookings/{bkg_id}/payments`). The migration script MUST replicate this exact dual-write behavior.
3. **Invoices**: Depend on Bookings.
4. **Cash Logs & Submissions**: Independent/Leaf nodes.

## 5. Critical Transaction Analysis & Atomicity Blockers

The MySQL backend relies heavily on pessimistic row-level locking (`SELECT ... FOR UPDATE`) within `connection.beginTransaction()` blocks to guarantee atomicity and prevent race conditions.

**Identified Locking Paths:**
- `checkInService.executeCheckIn`: Locks `rooms`.
- `reservationController.createReservation`: Locks `reservations`, `rooms`, `guests`, `bookings`.
- `auditController.runDayEnd` (Night Audit): Locks `system_settings`, `rooms`, `bookings`, `ledger_items`.
- `modifyCheckIn`, `checkOut`, `shift`: Explicitly lock `rooms` and `bookings`.

**Firestore-First Atomicity Blocker:**
Firestore cannot replicate `SELECT ... FOR UPDATE` blocking locks across multiple collections easily. If we switch to Firestore-first, the backend MUST be rewritten to use Firestore Client-Side Transactions (`db.runTransaction()`) to update rooms, bookings, and ledgers simultaneously. Outbox handlers alone are INSUFFICIENT for the write-path, as they only sync state *after* it commits. 

## 6. Security Blockers
- **None.** `firestore.rules` is already configured perfectly for these collections (e.g., `match /bookings/{bookingId}/payments/{paymentId}`). Staff have read/write access. Guests have read access if `user_uid` matches.

## 7. Search / Query Blockers
- MySQL queries frequently use `ORDER BY id DESC` or `ORDER BY check_in_date ASC`.
- Firestore will require composite indexes if we sort by `created_at` while filtering by `booking_status`.
- Guest Name Search (`LIKE '%name%'`) in MySQL cannot be directly replicated in Firestore without a third-party service (e.g., Algolia) or strict prefix-matching arrays.

## 8. Missing Repositories & Tables
- **`stayExtensionsRepository.js`** does not exist in the backend.
- The MySQL tables `payment_transactions`, `checkout_snapshots`, and `stay_extensions` **do not exist** in the schema.

## 9. Missing Fields for Migration
- `bookings` needs `guest_name` and `guest_user_uid` which require a `JOIN guests` during migration.
- Subcollection parent IDs (`booking_id`) must be converted to the `bkg_{number}` format during migration.

## 10. Required Cloud Functions
- No Cloud Functions are strictly required for the *migration* itself.
- For future Firestore-first operation, Night Audit and Checkout calculations might require Cloud Functions if the client cannot safely execute the multi-document transactions.

## 11. Recommended Phase 4D Sub-Phases
Since MySQL is currently empty, we do not need complex batching. However, to establish the architecture safely:
- **Phase 4D-1**: Implement `scripts/phase4D_seedTransactions.mjs` (Dry-Run + Commit). This script will safely map 0 rows, but proves the deterministic mapping logic (including the root+subcollection dual-write) is sound and ready for future use.
- **Phase 4D-2**: Establish Firestore composite indexes required by the repositories.
- **Phase 4D-3**: Address the missing `stayExtensionsRepository.js` if it is an active feature.

## 12. Risk Rating & Exact Next Safest Task
**Risk Rating:** HIGH (Due to complex transaction locking and dual-collection writes).
**Safest Next Task:** Author `scripts/phase4D_seedTransactions.mjs` conforming to the exact dual-write repository logic, run it in `--dry-run` to prove the JOINs and mappers are syntactically valid against the empty tables, and await approval.
