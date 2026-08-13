# PHASE 4D-2: FIRESTORE INDEX AUDIT

## 1. Executive Summary
This audit evaluated all Firestore repositories, existing `firestore.indexes.json`, and backend queries to determine composite index requirements for the Phase 4 Firebase migration.

**Key Findings:**
1. **Frontend Isolation:** The frontend currently makes **zero** direct Firestore queries. All Firestore interaction is handled securely through backend repositories.
2. **In-Memory Sorting:** Many subcollection/relational queries (e.g., `getPaymentsByBookingFirestore`, `getLedgerItemsByBookingFirestore`) fetch via equality (`booking_id == X`) and sort the results **in memory** in JavaScript. These do NOT require composite indexes.
3. **Invalid Legacy Indexes:** The current `firestore.indexes.json` contains several invalid, unused, or outdated indexes (e.g., referencing `arrival_date` instead of `check_in_date` for reservations).
4. **Missing Production Indexes:** The default `getAll...` repository methods enforce `orderBy: [{ field: 'created_at', direction: 'desc' }]`. Any future frontend pagination that combines a filter (e.g., `status == 'Active'`) with these endpoints will require new composite indexes not currently defined.

## 2. Existing Index Configuration
The `firestore.indexes.json` currently contains the following indexes:
- `bookings`: `[room_id ASC, booking_status ASC, check_in_date ASC]`
- `bookings`: `[guest_id ASC, booking_status ASC]`
- `bookings`: `[check_in_date ASC, check_out_date ASC]`
- `bookings`: `[booking_status ASC, room_number ASC]`
- `reservations`: `[room_id ASC, status ASC, arrival_date ASC]`
- `ledger_items` (Collection Group): `[booking_id ASC, business_date ASC]`
- `notifications`: `[user_uid ASC, is_read ASC]`
- `cash_logs`: `[business_date ASC, booking_id ASC]`
- `audit_logs`: `[action ASC, business_date ASC]`
- `housekeeping`: `[room_id ASC, created_at ASC]`
- `inventory_products`: `[status ASC, category_id ASC]`

## 3. Complete Firestore Query Inventory
| Domain / Repository | Query Method | Filters Used | OrderBy Used | Collection Scope |
| :--- | :--- | :--- | :--- | :--- |
| **staff** | `getAllStaff` / `getByUid` | `user_uid`, `username` | `full_name` ASC | Collection |
| **room_types** | `getAll` / `getByCode` | `code` | `name` ASC | Collection |
| **rooms** | `getAll` / `getByNumber` | `number` | `number` ASC | Collection |
| **reservations** | `getAll` / `getByNum` | `reservation_number` | `check_in_date` ASC | Collection |
| **payments** | `getAll` | *dynamic* | `created_at` DESC | Collection |
| **payments** | `getByBooking` | `booking_id`, `mysql_booking_id` | *In-Memory* | Collection + Sub |
| **ledger_items** | `getAll` | *dynamic* | `created_at` DESC | Collection |
| **ledger_items** | `getByBooking` | `booking_id`, `mysql_booking_id` | *In-Memory* | Collection + Sub |
| **booking_history** | `getAll` | *dynamic* | `created_at` DESC | Collection |
| **booking_history** | `getByBooking` | `booking_id`, `mysql_booking_id` | *In-Memory* | Collection + Sub |
| **bookings** | `getAll` | `booking_number` | `created_at` DESC | Collection |
| **invoices** | `getAll` | `invoice_number` | `created_at` DESC | Collection |
| **inventory_products**| `getAll` | `sku` | `name` ASC | Collection |
| **inventory_categories**| `getAll` | *dynamic* | `name` ASC | Collection |
| **guests** | `getAll` | `user_uid`, `phone` | `full_name` ASC | Collection |
| **cash_logs** | `getAll` | *dynamic* | `created_at` DESC | Collection |
| **cash_submissions** | `getAll` | *dynamic* | `created_at` DESC | Collection |
| **housekeeping** | `getAll` | `room_id` | `updated_at` DESC | Collection |
| **audit_logs** | `getAll` | *dynamic* | `created_at` DESC | Collection |

## 4. Queries Requiring Composite Indexes (Category C)
Because `getAll{Domain}Firestore(options = { filters, orderBy })` allows dynamic filters injected by controllers, any API endpoint that passes an equality filter while relying on the default repository `orderBy` requires a composite index.

**Required for standard operations (Status + Sort):**
- **bookings**: `booking_status` ASC + `created_at` DESC
- **reservations**: `status` ASC + `check_in_date` ASC
- **housekeeping**: `room_id` ASC + `updated_at` DESC
- **payments**: `booking_id` ASC + `created_at` DESC (if filtered natively rather than in-memory)

## 5. Queries Not Requiring Composite Indexes (Category A & B)
- **All `getByBooking` methods (Payments, Ledger, History):** They rely entirely on equality filters (`booking_id == X`) and perform sorting in JavaScript (`sort((a, b) => ...)`). No composite index required.
- **Unique Lookups:** `getByUid`, `getByCode`, `getByNumber`, `getByPhone`. These are single-field equality queries.
- **Unfiltered Lists:** `getAllRooms()`, `getAllStaff()` without filters rely on the default single-field `orderBy` index, which Firestore generates automatically.

## 6. Exact Proposed Composite Index Definitions
To support the repository defaults and typical PMS dashboard filters safely, the following indexes should be explicitly defined in a future `firestore.indexes.json`:

```json
{
  "collectionGroup": "bookings",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "booking_status", "order": "ASCENDING" },
    { "fieldPath": "created_at", "order": "DESCENDING" }
  ]
}
```
```json
{
  "collectionGroup": "reservations",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "check_in_date", "order": "ASCENDING" }
  ]
}
```
```json
{
  "collectionGroup": "housekeeping",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "room_id", "order": "ASCENDING" },
    { "fieldPath": "updated_at", "order": "DESCENDING" }
  ]
}
```

## 7. Redundant/Invalid Existing Indexes
The current `firestore.indexes.json` contains several invalid or unused indexes:
1. **reservations `arrival_date`:** The index targets `arrival_date`, but the `reservationsRepository.js` explicitly maps and sorts by `check_in_date`. This index is **INVALID** and unused.
2. **ledger_items `COLLECTION_GROUP`:** The repository uses `COLLECTION` and subcollection queries separately, merging them in memory. It does not use `db.collectionGroup()`. This index is **UNUSED**.
3. **bookings `room_id` + `booking_status` + `check_in_date`:** Highly specific. Unless an exact API endpoint queries exactly `room_id == X AND booking_status == Y ORDER BY check_in_date`, this is **UNUSED**.

## 8. Missing Repository / Query Domains
The following domains are explicitly **NOT IMPLEMENTED** in the backend Firestore repositories:
- `stay_extensions` (Missing table and repository)
- `guest_requests` (No repository)
- `maintenance` (No repository, distinct from housekeeping)
- `daily_analytics` (No repository)

*Index requirements for these cannot yet be verified.*

## 9. MySQL-vs-Firestore Query Gaps
The following current MySQL query paradigms cannot be solved by Firestore native indexes:
1. **`LIKE '%name%'` Searches:** MySQL allows substring searches for guest names. Firestore requires exact matches, prefix bounds (which are fragile), or a third-party search provider (e.g., Algolia).
2. **`SELECT ... FOR UPDATE`:** Transactions on bookings/rooms check availability with a blocking read. Firestore requires rewriting these as atomic `db.runTransaction` blocks, which indexes cannot solve.
3. **Cross-Domain JOINs:** Fetching a booking with the `guest_name` requires data duplication (which Phase 4D-1 implements) because Firestore cannot `JOIN guests` on the fly.

## 10. Potential Performance Issues
The "Dual-Read + In-Memory Sort" pattern used in `paymentsRepository.js` and `ledgerRepository.js` (fetching from root, then fetching from subcollection, merging `Map`, and array sorting) is safe for small bookings but will degrade linearly with the number of ledger items per booking. Over time, paginating a massive folio natively through Firestore will be impossible with this pattern.

## 11. Security/Rules Dependencies
`firestore.rules` natively supports subcollection reads (e.g., `match /bookings/{bookingId}/payments/{paymentId}`). Indexes are evaluated after rules, so as long as the rule allows the read, the composite index will function correctly for the permitted user.

## 12. Recommended Index Implementation Order
1. Remove all unused/invalid legacy indexes from `firestore.indexes.json` to prevent billing/limit exhaustion.
2. Add the `booking_status + created_at` composite index.
3. Add the `status + check_in_date` composite index for reservations.
4. Deploy indexes via Firebase CLI.

## 13. Blockers
None for index deployment itself.

## 14. Exact Next Action
Wait for explicit user approval. If approved, overwrite `firestore.indexes.json` with the pruned, corrected composite indexes and execute `firebase deploy --only firestore:indexes`.
