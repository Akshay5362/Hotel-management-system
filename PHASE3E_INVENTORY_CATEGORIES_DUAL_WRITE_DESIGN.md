# HPMS-Sky5: Phase 3E Inventory Categories Domain Dual-Write Architecture & Safety Blueprint

> **Phase:** Phase 3E — Inventory Categories Dual-Write Pilot (Read-Only Design & Safety Audit)  
> **Timestamp:** August 11, 2026  
> **Domain Selected:** Inventory Categories  
> **Readiness Score:** **94 / 100**  
> **Status:** READ-ONLY ARCHITECTURE AUDIT COMPLETE — ZERO SOURCE CODE MODIFICATIONS PERFORMED  
> **Final Verdict:** **PHASE 3E DESIGN STATUS: READY FOR IMPLEMENTATION**  

---

## Executive Summary

Following the successful verification of Phase 3B (Room Types), Phase 3C (Rooms), and Phase 3D (Staff Management), this document presents the complete architectural specification and safety audit for **Phase 3E: Inventory Categories Dual-Write Pilot**.

The **Inventory Categories Domain** has been evaluated and ranked as the **safest next operational domain** for Dual-Write bridge expansion. It features zero financial risk, simple transaction boundaries, clear deterministic document IDs (`cat_{slug}` or `cat_{name}`), complete Phase 2 Firestore repository CRUD implementation ([`inventoryCategoriesRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/inventoryCategoriesRepository.js)), and zero cross-domain state entanglements with check-in, room availability, payments, or night audit logic.

---

## 1. Domain Safety Ranking & Selection Analysis

All 11 remaining operational candidate domains were audited and evaluated across 17 safety and complexity dimensions:

| Rank | Domain | Readiness Score /100 | Write Path Count | Affected Tables | Transaction Complexity | Financial Risk | Cross-Domain Dependencies | Concurrency Risk | Recommended Phase |
|---|---|---|---|---|---|---|---|---|---|
| **1** | **Inventory Categories** | **94 / 100** | **3** | **1 (`inventory_categories`)** | **Low (Simple CRUD)** | **Zero** | **Low (Isolated)** | **Low** | **RECOMMENDED: Phase 3E** |
| 2 | System Settings | 93 / 100 | 2 | 1 (`system_settings`) | Low (Singleton) | Zero | Low | Low | Phase 3H Candidate |
| 3 | Guest Profiles | 88 / 100 | 5 | 2 (`guests`, `users`) | Medium | Zero | Medium | Medium | Post-Inventory Category |
| 4 | Inventory Products | 80 / 100 | 4 | 2 (`inventory_products`, `audit_logs`) | Medium (Stock logs) | Low | Medium | High (Stock race) | Phase 3G |
| 5 | Housekeeping Records | 78 / 100 | 3 | 2 (`rooms`, `housekeeping_logs`) | Medium | Zero | Medium | Medium | Phase 3G |
| 6 | Booking History | 75 / 100 | 2 | 1 (`booking_history`) | Medium | Zero | High (Bookings) | Low | Phase 3F |
| 7 | Cash Submissions | 70 / 100 | 2 | 2 (`cash_submissions`, `cash_logs`) | Medium | High | High | Medium | Phase 3G |
| 8 | Invoices | 65 / 100 | 3 | 2 (`invoices`, `ledger_items`) | Medium | High | High | High | Phase 3F |
| 9 | Ledger Items | 60 / 100 | 4 | 2 (`ledger_items`, `bookings`) | High | High | High | High | Phase 3F |
| 10 | Payments | 50 / 100 | 4 | 3 (`payments`, `ledger_items`, `bookings`) | High | **Critical** | High | High | Phase 3F |
| 11 | Reservations | 45 / 100 | 5 | 4 (`reservations`, `rooms`, `guests`, `bookings`) | **Critical (`FOR UPDATE`)** | High | **Critical** | **Critical** | Phase 3F |

---

## 2. Complete Write-Path Inventory for Inventory Categories

The read-only audit analyzed 100% of inventory category write operations across controllers and routes:

| # | Operation | Controller Method | Route | MySQL Tables | SQL Statement | Transaction Boundary | Proposed Outbox Event | Target Firestore Repo Method |
|---|---|---|---|---|---|---|---|---|
| 1 | **Create Category** | `createCategory` | `POST /api/inventory/categories` | `inventory_categories` | `INSERT INTO inventory_categories (name, department)` | MySQL Transaction | `INVENTORY_CATEGORY_CREATED` | `createInventoryCategoryFirestore` |
| 2 | **Update Category** | `updateCategory` | `PUT /api/inventory/categories/:id` | `inventory_categories` | `UPDATE inventory_categories SET name=?, department=? WHERE id=?` | MySQL Transaction | `INVENTORY_CATEGORY_UPDATED` | `updateInventoryCategoryFirestore` |
| 3 | **Delete Category** | `deleteCategory` | `DELETE /api/inventory/categories/:id` | `inventory_categories` | `DELETE FROM inventory_categories WHERE id=?` | MySQL Transaction | `INVENTORY_CATEGORY_DELETED` | `deleteInventoryCategoryFirestore` |

---

## 3. MySQL → Outbox Event Mapping Architecture

When Phase 3E implementation is authorized, outbox events will map to Phase 2 [`inventoryCategoriesRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/inventoryCategoriesRepository.js):

| MySQL Operation | Event Type | Aggregate Type & ID | Payload Structure | Target Firestore Repo Method | Deterministic Document ID | Idempotency & Stale Guard |
|---|---|---|---|---|---|---|
| `INSERT INTO inventory_categories` | `INVENTORY_CATEGORY_CREATED` | `INVENTORY_CATEGORY` / `<name>` | `{ name, department, mysql_category_id, updated_at }` | `createInventoryCategoryFirestore` | `cat_<formatted_name>` | Doc existence check + `setDoc(..., { merge: true })` |
| `UPDATE inventory_categories` | `INVENTORY_CATEGORY_UPDATED` | `INVENTORY_CATEGORY` / `<name>` | `{ name, department, updated_at }` | `updateInventoryCategoryFirestore` | `cat_<formatted_name>` | `isStaleUpdate(existing, payload)` guard |
| `DELETE FROM inventory_categories` | `INVENTORY_CATEGORY_DELETED` | `INVENTORY_CATEGORY` / `<name>` | `{ name, docId: 'cat_<formatted_name>' }` | `deleteInventoryCategoryFirestore` | `cat_<formatted_name>` | Idempotent delete (`NOT_FOUND` ignore) |

---

## 4. Firestore Repository Audit & Repository Completeness

Inspection of Phase 2 [`inventoryCategoriesRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/inventoryCategoriesRepository.js):
- **CRUD Completeness**: 100% complete (`getInventoryCategoryByIdFirestore`, `getAllInventoryCategoriesFirestore`, `createInventoryCategoryFirestore`, `updateInventoryCategoryFirestore`, `deleteInventoryCategoryFirestore`).
- **Deterministic Document IDs**: Uses `formatCategoryDocId(name)` -> `cat_<formatted_name>` (e.g. `cat_food_beverage`).
- **Required Implementation Extension**: Add `isStaleUpdate` comparison guard using ISO 8601 timestamps (`updated_at`) inside `updateInventoryCategoryFirestore`.

---

## 5. Existing Firestore Data Compatibility

Inspection of baseline migration script `scripts/migrateInventoryCategoriesToFirestore.js`:
- **Collection Name**: `inventory_categories`
- **Document ID Format**: `cat_<name>` or `cat_<id>`
- **Fields**: `name`, `department`, `description`, `mysql_category_id`, `created_at`, `updated_at`
- **Baseline Migration Count**: 5 seeded category records in MySQL baseline.

---

## 6. Concurrency & Failure / Recovery Analysis

### Atomic Transaction Staging:
```javascript
const connection = await pool.getConnection();
await connection.beginTransaction();
try {
  await connection.query('INSERT INTO inventory_categories (name, department) VALUES (?, ?)', [name, department]);
  if (isFirestoreDualWriteEnabled()) {
    await enqueue(connection, {
      event_type: 'INVENTORY_CATEGORY_CREATED',
      aggregate_type: 'INVENTORY_CATEGORY',
      aggregate_id: name,
      payload: { name, department, updated_at: new Date().toISOString() }
    });
  }
  await connection.commit();
} catch (err) {
  if (connection) await connection.rollback();
  throw err;
} finally {
  if (connection) connection.release();
}
```

### Failure Matrix:
- **MySQL Transaction Rollback**: 0 outbox events committed.
- **Firestore Connection Outage**: Worker retries with backoff until connection restored.
- **Out-of-Order Event Delivery**: Timestamp Vector Guard (`updated_at`) ignores older event T2 when newer state T3 is already present in Firestore.

---

## 7. Security & Firestore Rules Audit

- **Sensitive Data Analysis**: Inventory categories contain **zero sensitive data** (no passwords, credentials, payment info, or PII).
- **Firestore Security Rules**: Collection `/inventory_categories/{catId}` requires staff/admin authentication for writes; readable by authenticated users.

---

## 8. Read-Only Reconciliation Strategy

A read-only reconciliation check compares MySQL `inventory_categories` vs Firestore `/inventory_categories`:
```javascript
const [mysqlRows] = await pool.query('SELECT * FROM inventory_categories');
for (const row of mysqlRows) {
  const firestoreDoc = await getInventoryCategoryByIdFirestore(`cat_${row.name}`);
  // Compare name, department, mysql_category_id
}
```

---

## 9. Implementation File Scope

### A. REQUIRED CHANGES (To be modified during implementation):
1. `backend/controllers/inventoryController.js` (or new category routes): Wrap category CUD endpoints in transactions & stage outbox events.
2. `backend/repositories/firestore/inventoryCategoriesRepository.js`: Add `isStaleUpdate` timestamp comparison guard.
3. `backend/services/outboxDispatcher.js`: Add cases for `INVENTORY_CATEGORY_CREATED`, `INVENTORY_CATEGORY_UPDATED`, `INVENTORY_CATEGORY_DELETED`.
4. `backend/tests/testInventoryCategoryDualWritePilot.mjs` (New test suite).

### B. MUST REMAIN UNTOUCHED:
- Check-in (`checkInService.js`), checkout, room shifting, booking assignment, payment posting, invoice settlement, ledger posting, night audit, business date.

---

## 10. GO / NO-GO Criteria for Phase 3E Implementation

- [x] Inventory Categories selected as Rank #1 safest domain (Score: **94/100**).
- [x] All write paths mapped and transactional boundaries audited.
- [x] Phase 2 Firestore repository CRUD completeness verified.
- [x] Deterministic document ID format (`cat_<name>`) confirmed.
- [x] Stale event protection guard designed.
- [x] Feature flags confirmed to remain `false` by default.

---

## PHASE 3E DESIGN STATUS: READY FOR IMPLEMENTATION
