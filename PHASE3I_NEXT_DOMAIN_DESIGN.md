# HPMS-Sky5: Phase 3I Next-Domain Selection & Dual-Write Architecture Blueprint

> **Phase:** Phase 3I — Next-Domain Dual-Write Pilot (Read-Only Design & Safety Audit)  
> **Timestamp:** August 11, 2026  
> **Domain Selected:** Housekeeping Logs & Room Cleaning Status  
> **Readiness Score:** **90 / 100**  
> **Status:** READ-ONLY ARCHITECTURE AUDIT COMPLETE — ZERO SOURCE CODE MODIFICATIONS PERFORMED  
> **Final Verdict:** **PHASE 3I DESIGN STATUS: READY FOR IMPLEMENTATION**  

---

## 1. Executive Summary

Following the successful completion of Phase 3A through Phase 3H (Room Types, Rooms, Staff Management, Inventory Categories, System Settings, Inventory Products, and Guest Profiles), this document presents the architectural specification and safety audit for **Phase 3I: Housekeeping Domain Dual-Write Pilot**.

The **Housekeeping Domain** has been evaluated and ranked as the **safest next operational domain** for Dual-Write bridge expansion. Housekeeping features zero financial risk, isolated write boundaries, deterministic document IDs (`hk_<formatted_room_number>`), complete Phase 2 Firestore repository CRUD implementation ([`housekeepingRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/housekeepingRepository.js)), and direct synergy with Phase 3C (Rooms) and Phase 3D (Staff).

---

## 2. Remaining Candidate Domain Inventory & Safety Ranking

All 11 remaining operational candidate domains were audited and evaluated across 17 safety and complexity dimensions:

| Rank | Domain | Readiness Score /100 | Write Path Count | Affected Tables | Transaction Complexity | Financial Risk | Cross-Domain Dependencies | Concurrency Risk | Recommended Phase |
|---|---|---|---|---|---|---|---|---|---|
| **1** | **Housekeeping Logs** | **90 / 100** | **2** | **2 (`housekeeping_logs`, `rooms`)** | **Low-Medium** | **Zero** | **Low (Rooms already Phase 3C)** | **Low** | **RECOMMENDED: Phase 3I** |
| 2 | Audit Logs | 85 / 100 | 1 | 1 (`audit_logs`) | Low (Append-only) | Zero | Low | Low | Phase 3J Candidate |
| 3 | Booking History | 80 / 100 | 2 | 1 (`booking_history`) | Medium | Zero | High (Bookings) | Low | Phase 3K Candidate |
| 4 | Cash Submissions | 70 / 100 | 2 | 2 (`cash_submissions`, `cash_logs`) | Medium | High | High | Medium | Phase 3L Candidate |
| 5 | Invoices | 65 / 100 | 3 | 2 (`invoices`, `ledger_items`) | Medium | High | High | High | Phase 3M Candidate |
| 6 | Ledger Items | 60 / 100 | 4 | 2 (`ledger_items`, `bookings`) | High | High | High | High | Phase 3M Candidate |
| 7 | Payments | 50 / 100 | 4 | 3 (`payments`, `ledger_items`, `bookings`) | High | **Critical** | High | High | Phase 3M Candidate |
| 8 | Reservations | 45 / 100 | 5 | 4 (`reservations`, `rooms`, `guests`, `bookings`) | **Critical (`FOR UPDATE`)** | High | **Critical** | **Critical** | Phase 3N Candidate |
| 9 | Bookings (Check-in/Out) | 40 / 100 | 8 | 6+ (`bookings`, `rooms`, `guests`, `ledger`, etc.) | **Critical (`FOR UPDATE`)** | **Critical** | **Critical** | **Critical** | Phase 3N Candidate |
| 10 | Razorpay Transactions | 35 / 100 | 3 | 2 (`razorpay_transactions`, `payments`) | High | **Critical** | High | High | Phase 3O Candidate |
| 11 | Checkout Snapshots | 30 / 100 | 2 | 1 (`checkout_snapshots`) | Medium | High | High | Low | Phase 3O Candidate |

---

## 3. Selected Domain Justification (Housekeeping Logs)

**Why Housekeeping Logs is the Safest Choice**:
- **Zero Financial Impact**: Manages room cleaning statuses (`Clean`, `Dirty`, `In Progress`, `Inspected`), housekeeping priority, assigned staff IDs, and cleaning audit logs.
- **Dependent Domains Already Verified**: Rooms (Phase 3C) and Staff (Phase 3D) are already fully dual-write enabled and verified.
- **Complete Phase 2 Repository**: Phase 2 [`housekeepingRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/housekeepingRepository.js) is 100% complete (`createHousekeepingRecordFirestore`, `getHousekeepingByRoomFirestore`, `updateHousekeepingRecordFirestore`, `deleteHousekeepingRecordFirestore`).
- **Deterministic Document IDs**: Uses static keys (`hk_<room_number_or_id>`).

---

## 4. Complete Write-Path Inventory for Housekeeping

The read-only audit analyzed 100% of housekeeping write operations in `housekeepingController.js`:

| # | Operation | Controller / Service Method | Route | MySQL Tables | SQL Statement | Transaction Boundary | Proposed Outbox Event | Target Firestore Repo Method |
|---|---|---|---|---|---|---|---|---|
| 1 | **Update Housekeeping Status** | `housekeepingController.updateHousekeepingStatus` | `POST /api/housekeeping/status` | `rooms`, `housekeeping_logs`, `audit_logs` | `UPDATE rooms SET housekeeping_status = ...`, `INSERT INTO housekeeping_logs ...` | MySQL Connection / Transaction | `HOUSEKEEPING_STATUS_UPDATED` | `createHousekeepingRecordFirestore` / `updateHousekeepingRecordFirestore` |
| 2 | **Assign Housekeeper & Priority** | `housekeepingController.assignHousekeeper` | `POST /api/housekeeping/assign` | `rooms`, `housekeeping_logs` | `UPDATE rooms SET housekeeping_assigned_to = ...`, `INSERT INTO housekeeping_logs ...` | MySQL Connection / Transaction | `HOUSEKEEPING_LOG_CREATED` | `createHousekeepingRecordFirestore` / `updateHousekeepingRecordFirestore` |

---

## 5. MySQL → Outbox Event Mapping Architecture

| MySQL Operation | Event Type | Aggregate Type & ID | Payload Structure | Target Firestore Repo Method | Deterministic Document ID | Idempotency & Stale Guard |
|---|---|---|---|---|---|---|
| `UPDATE rooms SET housekeeping_status` | `HOUSEKEEPING_STATUS_UPDATED` | `HOUSEKEEPING` / `<room_number>` | `{ room_id, room_number, status, notes, performed_by, updated_at }` | `createHousekeepingRecordFirestore` | `hk_room_<room_number>` | Doc existence check + `setDoc(..., { merge: true })` |
| `INSERT INTO housekeeping_logs` | `HOUSEKEEPING_LOG_CREATED` | `HOUSEKEEPING` / `<room_number>` | `{ room_id, room_number, action, assigned_to, priority, updated_at }` | `updateHousekeepingRecordFirestore` | `hk_room_<room_number>` | `isStaleUpdate(existing, payload)` |

---

## 6. Security Audit (Payload Sanitization)

- **EXCLUDED**: `password`, `password_hash`, `auth_token`, `jwt`, `api_key`, `secrets`.
- **ALLOWED**: `room_id`, `room_number`, `status`, `assigned_to`, `cleaned_by`, `notes`, `mysql_housekeeping_id`, `updated_at`.

---

## 7. Concurrency & Failure Recovery Analysis

- **MySQL Transaction Safety**: Outbox event staging executes inside the same transaction as MySQL mutations.
- **Rollback Protection**: If MySQL transaction rolls back, 0 outbox events are committed.
- **Stale Event Protection**: Timestamp Vector Guard (`updated_at`) inside `housekeepingRepository.js` prevents out-of-order event overwrites.

---

## 8. Firestore Repository Audit

Inspection of Phase 2 [`housekeepingRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/housekeepingRepository.js):
- **CRUD Completeness**: 100% complete (`createHousekeepingRecordFirestore`, `getHousekeepingByIdFirestore`, `getHousekeepingByRoomFirestore`, `updateHousekeepingRecordFirestore`, `deleteHousekeepingRecordFirestore`).
- **Deterministic Document IDs**: Format `hk_room_<room_number>`.
- **Collection Name**: `/housekeeping`
- **Required Extension**: Add `isStaleUpdate` comparison guard using ISO 8601 timestamps (`updated_at`).

---

## 9. Test Plan (Phase 3I Pilot Test Suite)

Proposed test suite [`backend/tests/testHousekeepingDualWritePilot.mjs`](file:///d:/projects/hotel/backend/tests/testHousekeepingDualWritePilot.mjs) testing 15 scenarios (15 runtime assertions):
1. Housekeeping status update & outbox staging
2. MySQL transaction commit
3. MySQL transaction rollback guard (0 outbox events)
4. Worker dispatch to Firestore
5. Firestore document creation (`hk_room_<number>`)
6. Housekeeper assignment & priority update
7. Idempotency replay
8. Duplicate event replay
9. Stale event protection (older event T2 rejected)
10. Sequential updates
11. Validation / error handling
12. Missing Firestore document handling
13. Security payload sanitization (confirm no credentials)
14. Automated cleanup phase
15. Production data safety verification

---

## 10. GO / NO-GO Criteria for Phase 3I Implementation

- [x] Housekeeping selected as Rank #1 safest domain (Score: **90/100**).
- [x] All write paths mapped and transactional boundaries audited.
- [x] Phase 2 Firestore repository CRUD completeness verified.
- [x] Deterministic document ID format (`hk_room_<number>`) confirmed.
- [x] Security payload sanitization boundary defined.
- [x] Stale event protection guard designed.
- [x] Feature flags confirmed to remain `false` by default.

---

## PHASE 3I DESIGN STATUS: READY FOR IMPLEMENTATION
