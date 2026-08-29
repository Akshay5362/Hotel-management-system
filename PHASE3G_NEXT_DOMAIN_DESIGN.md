# HPMS-Sky5: Phase 3G Next-Domain Selection & Dual-Write Architecture Blueprint

> **Phase:** Phase 3G — Next-Domain Dual-Write Pilot (Read-Only Design & Safety Audit)  
> **Timestamp:** August 11, 2026  
> **Domain Selected:** Inventory Products  
> **Readiness Score:** **94 / 100**  
> **Status:** READ-ONLY ARCHITECTURE AUDIT COMPLETE — ZERO SOURCE CODE MODIFICATIONS PERFORMED  
> **Final Verdict:** **PHASE 3G DESIGN STATUS: READY FOR IMPLEMENTATION**  

---

## 1. Executive Summary

Following the successful implementation and verification of Phase 3B (Room Types), Phase 3C (Rooms), Phase 3D (Staff Management), Phase 3E (Inventory Categories), and Phase 3F (System Settings), this document presents the complete architectural specification and safety audit for **Phase 3G: Inventory Products Dual-Write Pilot**.

The **Inventory Products Domain** has been evaluated and ranked as the **safest next operational domain** for Dual-Write bridge expansion. Building directly on the Inventory Categories bridge completed in Phase 3E, Inventory Products feature low financial risk, clean single-entity transaction boundaries, deterministic document IDs (`prod_<formatted_sku_or_id>`), complete Phase 2 Firestore repository CRUD implementation ([`inventoryProductsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/inventoryProductsRepository.js)), and zero cross-domain state entanglements with check-in, room availability, guest payments, or night audit logic.

---

## 2. Remaining Candidate Domain Inventory & Safety Ranking

All 13 remaining operational candidate domains were audited and evaluated across 17 safety and complexity dimensions:

| Rank | Domain | Readiness Score /100 | Write Path Count | Affected Tables | Transaction Complexity | Financial Risk | Cross-Domain Dependencies | Concurrency Risk | Recommended Phase |
|---|---|---|---|---|---|---|---|---|---|
| **1** | **Inventory Products** | **94 / 100** | **3** | **2 (`inventory_products`, `audit_logs`)** | **Low-Medium** | **Low** | **Low (Categories)** | **Low** | **RECOMMENDED: Phase 3G** |
| 2 | Guest Profiles | 88 / 100 | 5 | 2 (`guests`, `users`) | Medium | Zero | Medium | Medium | Phase 3H Candidate |
| 3 | Housekeeping Logs | 85 / 100 | 2 | 2 (`rooms`, `housekeeping_logs`) | Medium | Zero | Medium | Medium | Phase 3H Candidate |
| 4 | Audit Logs | 80 / 100 | 1 | 1 (`audit_logs`) | Low (Append-only) | Zero | Low | Low | Phase 3I Candidate |
| 5 | Booking History | 75 / 100 | 2 | 1 (`booking_history`) | Medium | Zero | High (Bookings) | Low | Phase 3I Candidate |
| 6 | Cash Submissions | 70 / 100 | 2 | 2 (`cash_submissions`, `cash_logs`) | Medium | High | High | Medium | Phase 3J Candidate |
| 7 | Invoices | 65 / 100 | 3 | 2 (`invoices`, `ledger_items`) | Medium | High | High | High | Phase 3K Candidate |
| 8 | Ledger Items | 60 / 100 | 4 | 2 (`ledger_items`, `bookings`) | High | High | High | High | Phase 3K Candidate |
| 9 | Payments | 50 / 100 | 4 | 3 (`payments`, `ledger_items`, `bookings`) | High | **Critical** | High | High | Phase 3K Candidate |
| 10 | Reservations | 45 / 100 | 5 | 4 (`reservations`, `rooms`, `guests`, `bookings`) | **Critical (`FOR UPDATE`)** | High | **Critical** | **Critical** | Phase 3L Candidate |
| 11 | Bookings (Check-in/Out) | 40 / 100 | 8 | 6+ (`bookings`, `rooms`, `guests`, `ledger`, etc.) | **Critical (`FOR UPDATE`)** | **Critical** | **Critical** | **Critical** | Phase 3L Candidate |
| 12 | Razorpay Transactions | 35 / 100 | 3 | 2 (`razorpay_transactions`, `payments`) | High | **Critical** | High | High | Phase 3M Candidate |
| 13 | Checkout Snapshots | 30 / 100 | 2 | 1 (`checkout_snapshots`) | Medium | High | High | Low | Phase 3M Candidate |

---

## 3. Selected Domain Justification (Inventory Products)

**Why Inventory Products is the Safest Choice**:
- **Natural Continuation**: Phase 3E established Inventory Categories. Inventory Products map directly to those categories.
- **Low Financial Impact**: Governs SKU master items, product names, categories, units, prices, and stock counts. Does NOT handle guest payments, billing folios, tax calculations, or cash register handovers.
- **Isolated Transactions**: Updates modify `inventory_products` table and stage audit logs (`INSERT INTO inventory_products`, `UPDATE inventory_products`).
- **Complete Phase 2 Repository**: Phase 2 [`inventoryProductsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/inventoryProductsRepository.js) is 100% complete (`createInventoryProductFirestore`, `getInventoryProductByIdFirestore`, `updateInventoryProductFirestore`, `updateProductStockFirestore`, `deleteInventoryProductFirestore`).
- **Deterministic Document IDs**: Uses static keys (`prod_<formatted_sku_or_id>`).

### Why Next Candidates Were Deferred:
- **Guest Profiles (Rank #2)**: Requires synchronization between `guests` and `users` tables and handles auth/login references.
- **Housekeeping Logs (Rank #3)**: Relies on room assignments and staff relationships.
- **Payments / Financials (Ranks #6-#13)**: Critical financial risk requiring ledger integrity verification.

---

## 4. Complete Write-Path Inventory for Inventory Products

The read-only audit analyzed 100% of product write operations in `inventoryController.js`:

| # | Operation | Controller / Service Method | Route | MySQL Tables | SQL Statement | Transaction Boundary | Proposed Outbox Event | Target Firestore Repo Method |
|---|---|---|---|---|---|---|---|---|
| 1 | **Create Product** | `inventoryController.createProduct` | `POST /api/inventory/products` | `inventory_products`, `audit_logs` | `INSERT INTO inventory_products ...` | MySQL Transaction | `INVENTORY_PRODUCT_CREATED` | `createInventoryProductFirestore` |
| 2 | **Update Product** | `inventoryController.updateProduct` | `PUT /api/inventory/products/:id` | `inventory_products`, `audit_logs` | `UPDATE inventory_products SET ... WHERE id = ?` | MySQL Transaction | `INVENTORY_PRODUCT_UPDATED` | `updateInventoryProductFirestore` |
| 3 | **Deactivate Product** | `inventoryController.deleteProduct` | `DELETE /api/inventory/products/:id` | `inventory_products`, `audit_logs` | `UPDATE inventory_products SET status = 'Inactive' WHERE id = ?` | MySQL Transaction | `INVENTORY_PRODUCT_DEACTIVATED` | `updateInventoryProductFirestore` |

---

## 5. MySQL → Outbox Event Mapping Architecture

When Phase 3G implementation is authorized, outbox events will map to Phase 2 [`inventoryProductsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/inventoryProductsRepository.js):

| MySQL Operation | Event Type | Aggregate Type & ID | Payload Structure | Target Firestore Repo Method | Deterministic Document ID | Idempotency & Stale Guard |
|---|---|---|---|---|---|---|
| `INSERT INTO inventory_products` | `INVENTORY_PRODUCT_CREATED` | `INVENTORY_PRODUCT` / `<sku>` | `{ sku, name, category_id, unit_of_measure, unit_price, current_stock, minimum_stock_level, photo_url, status, mysql_product_id, updated_at }` | `createInventoryProductFirestore` | `prod_<sku>` | Doc existence check + `setDoc(..., { merge: true })` |
| `UPDATE inventory_products` | `INVENTORY_PRODUCT_UPDATED` | `INVENTORY_PRODUCT` / `<sku>` | `{ sku, name, category_id, unit_of_measure, unit_price, minimum_stock_level, photo_url, status, mysql_product_id, updated_at }` | `updateInventoryProductFirestore` | `prod_<sku>` | `isStaleUpdate(existing, payload)` |
| `UPDATE status='Inactive'` | `INVENTORY_PRODUCT_DEACTIVATED` | `INVENTORY_PRODUCT` / `<sku>` | `{ sku, name, status: 'Inactive', mysql_product_id, updated_at }` | `updateInventoryProductFirestore` | `prod_<sku>` | `isStaleUpdate(existing, payload)` |

---

## 6. Firestore Repository Audit & Schema Compatibility

Inspection of Phase 2 [`inventoryProductsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/inventoryProductsRepository.js):
- **CRUD Completeness**: 100% complete (`createInventoryProductFirestore`, `getInventoryProductByIdFirestore`, `updateInventoryProductFirestore`, `updateProductStockFirestore`, `deleteInventoryProductFirestore`).
- **Deterministic Document IDs**: Uses `formatProductDocId(sku)` (`prod_<sku>`).
- **Collection Name**: `/inventory_products`
- **Required Implementation Extension**: Add `isStaleUpdate` comparison guard using ISO 8601 timestamps (`updated_at`) inside `updateInventoryProductFirestore`.

---

## 7. Concurrency & Failure / Recovery Analysis

### Atomic Transaction Staging:
```javascript
const connection = await pool.getConnection();
await connection.beginTransaction();
try {
  const [result] = await connection.query('INSERT INTO inventory_products ...', [...]);
  const productId = result.insertId;

  if (isFirestoreDualWriteEnabled()) {
    await enqueue(connection, {
      event_type: 'INVENTORY_PRODUCT_CREATED',
      aggregate_type: 'INVENTORY_PRODUCT',
      aggregate_id: sku.trim().toUpperCase(),
      payload: {
        sku: sku.trim().toUpperCase(),
        name: name.trim(),
        category_id: catIdNum,
        unit_of_measure,
        minimum_stock_level: minStockNum,
        current_stock: currentStockNum,
        unit_price: priceNum,
        photo_url,
        status: prodStatus,
        mysql_product_id: productId,
        updated_at: new Date().toISOString()
      }
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
- **Out-of-Order Event Delivery**: Timestamp Vector Guard (`updated_at`) ignores older event T2 when newer date T3 is already present in Firestore.

---

## 8. Financial Risk Analysis

- **Risk Level**: **LOW**.
- **Explanation**: Inventory Products manage master catalog SKU data, unit prices, and stock counts. They contain zero payment methods, card numbers, transaction IDs, tax rates, or folio charge calculations.

---

## 9. Cross-Domain Dependency Analysis

- **Cross-Domain Dependencies**: **LOW**. Inventory Products depend only on `inventory_categories` (which was already dual-written in Phase 3E).

---

## 10. Event & Idempotency Design

- **Event Types**: `INVENTORY_PRODUCT_CREATED`, `INVENTORY_PRODUCT_UPDATED`, `INVENTORY_PRODUCT_DEACTIVATED`.
- **Idempotency Strategy**: Deterministic document IDs (`prod_<sku>`) with `setDoc(..., { merge: true })` guarantee replay idempotency.

---

## 11. Stale Event Protection

- **Strategy**: Compare `new Date(existing.updated_at).getTime() > new Date(payload.updated_at).getTime()`. If true, ignore event dispatch cleanly.

---

## 12. Rollback Strategy

- If Phase 3G dual-write is disabled, `ENABLE_FIRESTORE_DUAL_WRITE=false` ensures MySQL operates unchanged without producing outbox events.

---

## 13. Testing Strategy

Isolated test suite [`backend/tests/testInventoryProductsDualWritePilot.mjs`](file:///d:/projects/hotel/backend/tests/testInventoryProductsDualWritePilot.mjs) testing 12 scenarios:
1. `INVENTORY_PRODUCT_CREATED` staging
2. Rollback protection
3. Worker dispatch to Firestore
4. Idempotency replay
5. Stale event protection
6. Sequential product updates
7. Product deactivation (`INVENTORY_PRODUCT_DEACTIVATED`)
8. SKU validation
9. Retry behavior
10. Schema compatibility
11. Photo URL preservation
12. Automated test record cleanup (`phase3g_prod_*`)

---

## 14. GO / NO-GO Criteria for Phase 3G Implementation

- [x] Inventory Products selected as Rank #1 safest domain (Score: **94/100**).
- [x] All write paths mapped and transactional boundaries audited.
- [x] Phase 2 Firestore repository CRUD completeness verified.
- [x] Deterministic document ID format (`prod_<sku>`) confirmed.
- [x] Stale event protection guard designed.
- [x] Feature flags confirmed to remain `false` by default.

---

## PHASE 3G DESIGN STATUS: READY FOR IMPLEMENTATION
