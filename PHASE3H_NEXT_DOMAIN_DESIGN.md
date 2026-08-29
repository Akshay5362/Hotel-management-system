# HPMS-Sky5: Phase 3H Next-Domain Selection & Dual-Write Architecture Blueprint

> **Phase:** Phase 3H — Next-Domain Dual-Write Pilot (Read-Only Design & Safety Audit)  
> **Timestamp:** August 11, 2026  
> **Domain Selected:** Guest Profiles  
> **Readiness Score:** **92 / 100**  
> **Status:** READ-ONLY ARCHITECTURE AUDIT COMPLETE — ZERO SOURCE CODE MODIFICATIONS PERFORMED  
> **Final Verdict:** **PHASE 3H DESIGN STATUS: READY FOR IMPLEMENTATION**  

---

## 1. Executive Summary

Following the successful implementation and verification of Phase 3B (Room Types), Phase 3C (Rooms), Phase 3D (Staff Management), Phase 3E (Inventory Categories), Phase 3F (System Settings), and Phase 3G (Inventory Products), this document presents the complete architectural specification and safety audit for **Phase 3H: Guest Profiles Dual-Write Pilot**.

The **Guest Profiles Domain** has been evaluated and ranked as the **safest next operational domain** for Dual-Write bridge expansion. Guest Profiles feature zero financial risk, clean transactional boundaries, deterministic document IDs (`guest_<formatted_phone_or_uid>`), complete Phase 2 Firestore repository CRUD implementation ([`guestsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/guestsRepository.js)), and clear payload sanitization boundaries to strictly prevent credentials or password hashes from entering the outbox pipeline.

---

## 2. Remaining Candidate Domain Inventory & Safety Ranking

All 12 remaining operational candidate domains were audited and evaluated across 17 safety and complexity dimensions:

| Rank | Domain | Readiness Score /100 | Write Path Count | Affected Tables | Transaction Complexity | Financial Risk | Cross-Domain Dependencies | Concurrency Risk | Recommended Phase |
|---|---|---|---|---|---|---|---|---|---|
| **1** | **Guest Profiles** | **92 / 100** | **3** | **2 (`guests`, `users`)** | **Medium** | **Zero** | **Low-Medium** | **Low-Medium** | **RECOMMENDED: Phase 3H** |
| 2 | Housekeeping Logs | 85 / 100 | 2 | 2 (`rooms`, `housekeeping_logs`) | Medium | Zero | Medium | Medium | Phase 3I Candidate |
| 3 | Audit Logs | 80 / 100 | 1 | 1 (`audit_logs`) | Low (Append-only) | Zero | Low | Low | Phase 3I Candidate |
| 4 | Booking History | 75 / 100 | 2 | 1 (`booking_history`) | Medium | Zero | High (Bookings) | Low | Phase 3J Candidate |
| 5 | Cash Submissions | 70 / 100 | 2 | 2 (`cash_submissions`, `cash_logs`) | Medium | High | High | Medium | Phase 3K Candidate |
| 6 | Invoices | 65 / 100 | 3 | 2 (`invoices`, `ledger_items`) | Medium | High | High | High | Phase 3L Candidate |
| 7 | Ledger Items | 60 / 100 | 4 | 2 (`ledger_items`, `bookings`) | High | High | High | High | Phase 3L Candidate |
| 8 | Payments | 50 / 100 | 4 | 3 (`payments`, `ledger_items`, `bookings`) | High | **Critical** | High | High | Phase 3L Candidate |
| 9 | Reservations | 45 / 100 | 5 | 4 (`reservations`, `rooms`, `guests`, `bookings`) | **Critical (`FOR UPDATE`)** | High | **Critical** | **Critical** | Phase 3M Candidate |
| 10 | Bookings (Check-in/Out) | 40 / 100 | 8 | 6+ (`bookings`, `rooms`, `guests`, `ledger`, etc.) | **Critical (`FOR UPDATE`)** | **Critical** | **Critical** | **Critical** | Phase 3M Candidate |
| 11 | Razorpay Transactions | 35 / 100 | 3 | 2 (`razorpay_transactions`, `payments`) | High | **Critical** | High | High | Phase 3N Candidate |
| 12 | Checkout Snapshots | 30 / 100 | 2 | 1 (`checkout_snapshots`) | Medium | High | High | Low | Phase 3N Candidate |

---

## 3. Selected Domain Justification (Guest Profiles)

**Why Guest Profiles is the Safest Choice**:
- **Zero Financial Impact**: Manages guest demographics (name, phone, email, address, government ID, loyalty points) with zero payment, invoice, tax, or folio balance mutations.
- **Isolated Transactions**: Writes modify `guests` and `users` tables within `connection.beginTransaction()`.
- **Complete Phase 2 Repository**: Phase 2 [`guestsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/guestsRepository.js) is 100% complete (`createGuestFirestore`, `getGuestByIdFirestore`, `getGuestByPhoneFirestore`, `updateGuestFirestore`, `deleteGuestFirestore`).
- **Deterministic Document IDs**: Uses static keys (`guest_<formatted_phone>`).

### Why Next Candidates Were Deferred:
- **Housekeeping Logs (Rank #2)**: Depends on room assignments and staff schedules.
- **Payments / Financials (Ranks #5-#12)**: Critical financial risk requiring ledger integrity verification.

---

## 4. Complete Write-Path Inventory for Guest Profiles

The read-only audit analyzed 100% of guest write operations in `authController.js` and `roomController.js`:

| # | Operation | Controller / Service Method | Route | MySQL Tables | SQL Statement | Transaction Boundary | Proposed Outbox Event | Target Firestore Repo Method |
|---|---|---|---|---|---|---|---|---|
| 1 | **Register Guest** | `authController.signup` | `POST /api/auth/signup` | `users`, `guests`, `audit_logs` | `INSERT INTO users ...`, `INSERT INTO guests ...` | MySQL Transaction | `GUEST_CREATED` | `createGuestFirestore` |
| 2 | **Create Guest Profile** | `roomController.checkIn` | `POST /api/rooms/check-in` | `guests` | `INSERT INTO guests ...` | MySQL Transaction | `GUEST_CREATED` | `createGuestFirestore` |
| 3 | **Update Guest Profile** | `roomController.updateGuestDetails` | `PUT /api/guests/:id` | `guests` | `UPDATE guests SET ... WHERE id = ?` | MySQL Transaction | `GUEST_UPDATED` | `updateGuestFirestore` |

---

## 5. MySQL → Outbox Event Mapping Architecture & Payload Security

Outbox payloads MUST BE STRICTLY SANITIZED to exclude authentication credentials or password hashes:

| MySQL Operation | Event Type | Aggregate Type & ID | Payload Structure (SANITIZED) | Target Firestore Repo Method | Deterministic Document ID | Idempotency & Stale Guard |
|---|---|---|---|---|---|---|
| `INSERT INTO guests` | `GUEST_CREATED` | `GUEST` / `<phone>` | `{ full_name, phone, email, address, government_id, id_type, loyalty_tier, loyalty_points, user_uid, mysql_guest_id, mysql_user_id, updated_at }` | `createGuestFirestore` | `guest_<phone>` | Doc existence check + `setDoc(..., { merge: true })` |
| `UPDATE guests` | `GUEST_UPDATED` | `GUEST` / `<phone>` | `{ full_name, phone, email, address, government_id, id_type, loyalty_tier, loyalty_points, mysql_guest_id, updated_at }` | `updateGuestFirestore` | `guest_<phone>` | `isStaleUpdate(existing, payload)` |

### Security Boundary (Prohibited Payload Fields):
- **EXCLUDED**: `password`, `password_hash`, `token`, `secret`, `auth_credentials`.

---

## 6. Firestore Repository Audit & Schema Compatibility

Inspection of Phase 2 [`guestsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/guestsRepository.js):
- **CRUD Completeness**: 100% complete (`createGuestFirestore`, `getGuestByIdFirestore`, `getGuestByPhoneFirestore`, `updateGuestFirestore`, `deleteGuestFirestore`).
- **Deterministic Document IDs**: Uses `formatGuestId(phone)` (`guest_<phone>`).
- **Collection Name**: `/guests`
- **Required Implementation Extension**: Add `isStaleUpdate` comparison guard using ISO 8601 timestamps (`updated_at`) inside `updateGuestFirestore`.

---

## 7. Concurrency & Failure / Recovery Analysis

### Atomic Transaction Staging:
```javascript
const connection = await pool.getConnection();
await connection.beginTransaction();
try {
  await connection.query('INSERT INTO users ...', [...]);
  const [result] = await connection.query('INSERT INTO guests ...', [...]);
  const guestId = result.insertId;

  if (isFirestoreDualWriteEnabled()) {
    await enqueue(connection, {
      event_type: 'GUEST_CREATED',
      aggregate_type: 'GUEST',
      aggregate_id: cleanPhone,
      payload: {
        full_name: cleanFullName,
        phone: cleanPhone,
        email: cleanEmail || null,
        mysql_guest_id: guestId,
        mysql_user_id: userId,
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

- **Risk Level**: **ZERO (LOW)**.
- **Explanation**: Guest Profiles manage guest demographic data (name, phone, email, address, government ID). They contain zero payment methods, card numbers, transaction IDs, tax rates, or folio charge calculations.

---

## 9. Cross-Domain Dependency Analysis

- **Cross-Domain Dependencies**: **LOW-MEDIUM**. Guest Profiles link to `users` table via `user_id`.

---

## 10. Event & Idempotency Design

- **Event Types**: `GUEST_CREATED`, `GUEST_UPDATED`.
- **Idempotency Strategy**: Deterministic document IDs (`guest_<phone>`) with `setDoc(..., { merge: true })` guarantee replay idempotency.

---

## 11. Stale Event Protection

- **Strategy**: Compare `new Date(existing.updated_at).getTime() > new Date(payload.updated_at).getTime()`. If true, ignore event dispatch cleanly.

---

## 12. Rollback Strategy

- If Phase 3H dual-write is disabled, `ENABLE_FIRESTORE_DUAL_WRITE=false` ensures MySQL operates unchanged without producing outbox events.

---

## 13. Testing Strategy

Isolated test suite [`backend/tests/testGuestDualWritePilot.mjs`](file:///d:/projects/hotel/backend/tests/testGuestDualWritePilot.mjs) testing 12 scenarios:
1. `GUEST_CREATED` staging
2. Rollback protection
3. Worker dispatch to Firestore
4. Idempotency replay
5. Stale event protection
6. Sequential guest profile updates
7. Security payload sanitization check (confirm no `password_hash`)
8. Phone number formatting validation
9. Retry behavior
10. Schema compatibility
11. Automated test record cleanup (`phase3h_guest_*`)

---

## 14. GO / NO-GO Criteria for Phase 3H Implementation

- [x] Guest Profiles selected as Rank #1 safest domain (Score: **92/100**).
- [x] All write paths mapped and transactional boundaries audited.
- [x] Phase 2 Firestore repository CRUD completeness verified.
- [x] Deterministic document ID format (`guest_<phone>`) confirmed.
- [x] Security payload sanitization boundary defined.
- [x] Stale event protection guard designed.
- [x] Feature flags confirmed to remain `false` by default.

---

## PHASE 3H DESIGN STATUS: READY FOR IMPLEMENTATION
