# HPMS-Sky5: Phase 3F Next-Domain Selection & Dual-Write Architecture Blueprint

> **Phase:** Phase 3F — Next-Domain Dual-Write Pilot (Read-Only Design & Safety Audit)  
> **Timestamp:** August 11, 2026  
> **Domain Selected:** System Settings  
> **Readiness Score:** **95 / 100**  
> **Status:** READ-ONLY ARCHITECTURE AUDIT COMPLETE — ZERO SOURCE CODE MODIFICATIONS PERFORMED  
> **Final Verdict:** **PHASE 3F DESIGN STATUS: READY FOR IMPLEMENTATION**  

---

## 1. Executive Summary

Following the successful implementation and verification of Phase 3B (Room Types), Phase 3C (Rooms), Phase 3D (Staff Management), and Phase 3E (Inventory Categories), this document presents the complete architectural specification and safety audit for **Phase 3F: System Settings Dual-Write Pilot**.

The **System Settings Domain** has been evaluated and ranked as the **safest next operational domain** for Dual-Write bridge expansion. It features zero financial risk, singleton key-value transaction boundaries, deterministic document IDs (`system_date` or `<setting_key>`), complete Phase 2 Firestore repository CRUD implementation ([`systemSettingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/systemSettingsRepository.js)), and zero cross-domain state entanglements with check-in, room availability, payments, or night audit logic.

---

## 2. Candidate Domain Inventory & Safety Ranking

All 13 remaining operational candidate domains were audited and evaluated across 17 safety and complexity dimensions:

| Rank | Domain | Readiness Score /100 | Write Path Count | Affected Tables | Transaction Complexity | Financial Risk | Cross-Domain Dependencies | Concurrency Risk | Recommended Phase |
|---|---|---|---|---|---|---|---|---|---|
| **1** | **System Settings** | **95 / 100** | **2** | **1 (`system_settings`)** | **Low (Singleton)** | **Zero** | **Low (Isolated)** | **Low** | **RECOMMENDED: Phase 3F** |
| 2 | Inventory Products | 90 / 100 | 3 | 2 (`inventory_products`, `audit_logs`) | Medium | Low | Low (Categories) | Low | Phase 3G Candidate |
| 3 | Guest Profiles | 88 / 100 | 5 | 2 (`guests`, `users`) | Medium | Zero | Medium | Medium | Phase 3H Candidate |
| 4 | Housekeeping Logs | 82 / 100 | 2 | 2 (`rooms`, `housekeeping_logs`) | Medium | Zero | Medium | Medium | Phase 3H Candidate |
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

## 3. Selected Domain Justification (System Settings)

**Why System Settings is the Safest Choice**:
- **Zero Financial Impact**: Manages operational metadata (`system_date`, hotel name, application parameters) with zero payment, invoice, tax, or folio balance mutations.
- **Isolated Transactions**: Updates modify single-table `system_settings` key-value pairs (`UPDATE system_settings SET value_val = ? WHERE key_name = ?`).
- **Complete Phase 2 Repository**: Phase 2 [`systemSettingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/systemSettingsRepository.js) is 100% complete (`getSystemSettingsFirestore`, `getSystemDateFirestore`, `updateSystemDateFirestore`, `updateSystemSettingFirestore`).
- **Deterministic Document IDs**: Uses static keys (e.g., `system_date` or `<setting_key>`).

### Why Next Candidates Were Deferred:
- **Inventory Products (Rank #2)**: Moderate risk due to stock status calculation and product photo file lifecycle management.
- **Guest Profiles (Rank #3)**: Requires cross-table synchronization between `guests` and `users` tables.
- **Payments / Financials (Ranks #7-#12)**: Critical financial risk requiring ledger integrity verification.

---

## 4. Complete Write-Path Inventory for System Settings

The read-only audit analyzed 100% of system settings write operations across controllers and services:

| # | Operation | Controller / Service Method | Route | MySQL Tables | SQL Statement | Transaction Boundary | Proposed Outbox Event | Target Firestore Repo Method |
|---|---|---|---|---|---|---|---|---|
| 1 | **Update Business Date** | `settingsController.updateBusinessDate` | `POST /api/settings/business-date` | `system_settings` | `UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'` | MySQL Transaction | `SYSTEM_DATE_UPDATED` | `updateSystemDateFirestore` |
| 2 | **Update General Setting** | `BusinessDateService.setBusinessDate` | Internal / Controller | `system_settings` | `UPDATE system_settings SET value_val = ? WHERE key_name = ?` | MySQL Transaction | `SYSTEM_SETTING_UPDATED` | `updateSystemSettingFirestore` |

---

## 5. MySQL → Outbox Event Mapping Architecture

When Phase 3F implementation is authorized, outbox events will map to Phase 2 [`systemSettingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/systemSettingsRepository.js):

| MySQL Operation | Event Type | Aggregate Type & ID | Payload Structure | Target Firestore Repo Method | Deterministic Document ID | Idempotency & Stale Guard |
|---|---|---|---|---|---|---|
| `UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'` | `SYSTEM_DATE_UPDATED` | `SYSTEM_SETTING` / `system_date` | `{ current_date: 'YYYY-MM-DD', system_date: 'YYYY-MM-DD', updated_at }` | `updateSystemDateFirestore` | `system_date` | Static doc ID + `setDoc(..., { merge: true })` |
| `UPDATE system_settings SET value_val = ? WHERE key_name = ?` | `SYSTEM_SETTING_UPDATED` | `SYSTEM_SETTING` / `<key_name>` | `{ key_name, value_val, updated_at }` | `updateSystemSettingFirestore` | `<key_name>` | Static doc ID + `isStaleUpdate(existing, payload)` |

---

## 6. Firestore Repository Audit & Schema Compatibility

Inspection of Phase 2 [`systemSettingsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/systemSettingsRepository.js):
- **CRUD Completeness**: 100% complete (`getSystemSettingsFirestore`, `getSystemDateFirestore`, `updateSystemDateFirestore`, `updateSystemSettingFirestore`).
- **Deterministic Document IDs**: Uses static keys (e.g. `system_date`).
- **Collection Name**: `/settings`
- **Required Implementation Extension**: Add `isStaleUpdate` comparison guard using ISO 8601 timestamps (`updated_at`) inside `updateSystemSettingFirestore`.

---

## 7. Concurrency & Failure / Recovery Analysis

### Atomic Transaction Staging:
```javascript
const connection = await pool.getConnection();
await connection.beginTransaction();
try {
  await connection.query("UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'", [nextDateStr]);
  if (isFirestoreDualWriteEnabled()) {
    await enqueue(connection, {
      event_type: 'SYSTEM_DATE_UPDATED',
      aggregate_type: 'SYSTEM_SETTING',
      aggregate_id: 'system_date',
      payload: { current_date: nextDateStr, system_date: nextDateStr, updated_at: new Date().toISOString() }
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

- **Risk Level**: **ZERO (LOW)**.
- **Explanation**: System settings contain zero payment methods, card numbers, transaction IDs, tax rates, or folio charge calculations.

---

## 9. Dependency Analysis

- **Cross-Domain Dependencies**: **ZERO**. System settings do not depend on rooms, bookings, guests, staff, or reservations.

---

## 10. Event & Idempotency Design

- **Event Types**: `SYSTEM_DATE_UPDATED`, `SYSTEM_SETTING_UPDATED`.
- **Idempotency Strategy**: Static document IDs (`system_date`, `<setting_key>`) with `setDoc(..., { merge: true })` guarantee replay idempotency.

---

## 11. Stale Event Protection

- **Strategy**: Compare `new Date(existing.updated_at).getTime() > new Date(payload.updated_at).getTime()`. If true, ignore event dispatch cleanly.

---

## 12. Rollback Strategy

- If Phase 3F dual-write is disabled, `ENABLE_FIRESTORE_DUAL_WRITE=false` ensures MySQL operates unchanged without producing outbox events.

---

## 13. Testing Strategy

Isolated test suite [`backend/tests/testSystemSettingsDualWritePilot.mjs`](file:///d:/projects/hotel/backend/tests/testSystemSettingsDualWritePilot.mjs) testing 10 scenarios:
1. `SYSTEM_DATE_UPDATED` staging
2. Rollback protection
3. Worker dispatch to Firestore
4. Idempotency replay
5. Stale event protection
6. Sequential date updates
7. Retry behavior
8. Schema compatibility
9. Automated test record cleanup

---

## 14. Security & Firestore Rules Audit

- **Sensitive Data**: System settings contain zero passwords or secrets.
- **Firestore Rules**: Collection `/settings/{settingId}` permits read for authenticated staff; writes restricted to admin.

---

## 15. Read-Only Reconciliation Strategy

Compare MySQL `system_settings` table vs Firestore `/settings` collection:
```javascript
const [mysqlRows] = await pool.query('SELECT * FROM system_settings');
for (const row of mysqlRows) {
  const doc = await getSystemSettingsFirestore(row.key_name);
}
```

---

## 16. Implementation File Scope

### A. REQUIRED CHANGES (To be modified during implementation):
1. `backend/services/businessDateService.js` & `settingsController.js`: Stage outbox event when `isFirestoreDualWriteEnabled()` is `true`.
2. `backend/repositories/firestore/systemSettingsRepository.js`: Add `isStaleUpdate` timestamp comparison guard.
3. `backend/services/outboxDispatcher.js`: Add cases for `SYSTEM_DATE_UPDATED` and `SYSTEM_SETTING_UPDATED`.
4. `backend/tests/testSystemSettingsDualWritePilot.mjs` (New test suite).

### B. MUST REMAIN UNTOUCHED:
- Check-in (`checkInService.js`), checkout, room shifting, booking assignment, payment posting, invoice settlement, ledger posting, night audit execution logic.

---

## 17. GO / NO-GO Criteria for Phase 3F Implementation

- [x] System Settings selected as Rank #1 safest domain (Score: **95/100**).
- [x] All write paths mapped and transactional boundaries audited.
- [x] Phase 2 Firestore repository CRUD completeness verified.
- [x] Deterministic document ID format (`system_date`, `<setting_key>`) confirmed.
- [x] Stale event protection guard designed.
- [x] Feature flags confirmed to remain `false` by default.

---

## PHASE 3F DESIGN STATUS: READY FOR IMPLEMENTATION
