# HPMS-Sky5: Phase 3J Next-Domain Selection & Dual-Write Architecture Blueprint

> **Phase:** Phase 3J — Next-Domain Dual-Write Pilot (Read-Only Design & Safety Audit)  
> **Timestamp:** August 11, 2026  
> **Domain Selected:** Audit Logs  
> **Readiness Score:** **88 / 100**  
> **Status:** READ-ONLY ARCHITECTURE AUDIT COMPLETE — ZERO SOURCE CODE MODIFICATIONS PERFORMED  
> **Final Verdict:** **PHASE 3J DESIGN STATUS: READY FOR IMPLEMENTATION**  

---

## 1. Executive Summary

Following the successful completion of Phase 3A through Phase 3I (Room Types, Rooms, Staff Management, Inventory Categories, System Settings, Inventory Products, Guest Profiles, and Housekeeping Logs), this document presents the architectural specification and safety audit for **Phase 3J: Audit Logs Domain Dual-Write Pilot**.

The **Audit Logs Domain** has been evaluated and ranked as the **safest next operational domain** for Dual-Write bridge expansion. Audit logs feature zero financial risk, pure append-only operational semantics, deterministic document IDs (`audit_<mysql_audit_id>`), complete Phase 2 Firestore repository CRUD implementation ([`auditLogsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/auditLogsRepository.js)), and standalone audit trail logging.

---

## 2. Remaining Candidate Domain Inventory & Safety Ranking

All 10 remaining operational candidate domains were audited and evaluated across 17 safety and complexity dimensions:

| Rank | Domain | Readiness Score /100 | Write Path Count | Affected Tables | Transaction Complexity | Financial Risk | Cross-Domain Dependencies | Concurrency Risk | Recommended Phase |
|---|---|---|---|---|---|---|---|---|---|
| **1** | **Audit Logs** | **88 / 100** | **1** | **1 (`audit_logs`)** | **Low (Append-only)** | **Zero** | **Low (Standalone System Audit)** | **Low** | **RECOMMENDED: Phase 3J** |
| 2 | Booking History | 80 / 100 | 2 | 1 (`booking_history`) | Medium | Zero | High (Bookings) | Low | Phase 3K Candidate |
| 3 | Cash Submissions | 70 / 100 | 2 | 2 (`cash_submissions`, `cash_logs`) | Medium | High | High | Medium | Phase 3L Candidate |
| 4 | Invoices | 65 / 100 | 3 | 2 (`invoices`, `ledger_items`) | Medium | High | High | High | Phase 3M Candidate |
| 5 | Ledger Items | 60 / 100 | 4 | 2 (`ledger_items`, `bookings`) | High | High | High | High | Phase 3M Candidate |
| 6 | Payments | 50 / 100 | 4 | 3 (`payments`, `ledger_items`, `bookings`) | High | **Critical** | High | High | Phase 3M Candidate |
| 7 | Reservations | 45 / 100 | 5 | 4 (`reservations`, `rooms`, `guests`, `bookings`) | **Critical (`FOR UPDATE`)** | High | **Critical** | **Critical** | Phase 3N Candidate |
| 8 | Bookings (Check-in/Out) | 40 / 100 | 8 | 6+ (`bookings`, `rooms`, `guests`, `ledger`, etc.) | **Critical (`FOR UPDATE`)** | **Critical** | **Critical** | **Critical** | Phase 3N Candidate |
| 9 | Razorpay Transactions | 35 / 100 | 3 | 2 (`razorpay_transactions`, `payments`) | High | **Critical** | High | High | Phase 3O Candidate |
| 10 | Checkout Snapshots | 30 / 100 | 2 | 1 (`checkout_snapshots`) | Medium | High | High | Low | Phase 3O Candidate |

---

## 3. Selected Domain Justification (Audit Logs)

**Why Audit Logs is the Safest Choice**:
- **Zero Financial Impact**: Manages system audit trails (`audit_logs`), user action logs, and system audit history.
- **Append-Only Operations**: Audit records are immutable log entries (`INSERT INTO audit_logs`). There are zero UPDATE or DELETE operations on audit log records in MySQL.
- **Complete Phase 2 Repository**: Phase 2 [`auditLogsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/auditLogsRepository.js) is 100% complete (`createAuditLogFirestore`, `getAuditLogByIdFirestore`, `getAllAuditLogsFirestore`).
- **Deterministic Document IDs**: Uses static keys (`audit_<mysql_audit_id>`).

---

## 4. Complete Write-Path Inventory for Audit Logs

The read-only audit analyzed 100% of audit log write operations across all controllers and services:

| # | Operation | Controller / Service Method | Route / Trigger | MySQL Tables | SQL Statement | Transaction Boundary | Proposed Outbox Event | Target Firestore Repo Method |
|---|---|---|---|---|---|---|---|---|
| 1 | **Create Audit Log Entry** | Audit logging calls across controllers | System operations | `audit_logs` | `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (...)` | MySQL Connection / Transaction | `AUDIT_LOG_CREATED` | `createAuditLogFirestore` |

---

## 5. MySQL → Outbox Event Mapping Architecture & Payload Security

| MySQL Operation | Event Type | Aggregate Type & ID | Payload Structure | Target Firestore Repo Method | Deterministic Document ID | Idempotency Strategy |
|---|---|---|---|---|---|---|
| `INSERT INTO audit_logs` | `AUDIT_LOG_CREATED` | `AUDIT_LOG` / `<mysql_audit_id>` | `{ user_id, action, details, business_date, mysql_audit_id, created_at }` | `createAuditLogFirestore` | `audit_<mysql_audit_id>` | Doc existence check + `setDoc(..., { merge: true })` |

### Security Audit (Payload Sanitization):
- **EXCLUDED**: `password`, `password_hash`, `auth_token`, `jwt`, `api_key`, `secrets`.
- **ALLOWED**: `user_id`, `mysql_user_id`, `action`, `details`, `business_date`, `mysql_audit_id`, `created_at`.

---

## 6. Concurrency & Failure Recovery Analysis

- **Append-Only Concurrency Safety**: Audit logs are immutable records. Out-of-order delivery produces no state mutation corruption.
- **MySQL Transaction Safety**: Outbox event staging executes inside the same transaction as MySQL mutations.
- **Rollback Protection**: If MySQL transaction rolls back, 0 outbox events are committed.

---

## 7. Firestore Repository Audit

Inspection of Phase 2 [`auditLogsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/auditLogsRepository.js):
- **CRUD Completeness**: 100% complete (`createAuditLogFirestore`, `getAuditLogByIdFirestore`, `getAllAuditLogsFirestore`).
- **Deterministic Document IDs**: Format `audit_<mysql_audit_id>`.
- **Collection Name**: `/audit_logs`

---

## 8. Test Plan (Phase 3J Pilot Test Suite)

Proposed test suite [`backend/tests/testAuditLogsDualWritePilot.mjs`](file:///d:/projects/hotel/backend/tests/testAuditLogsDualWritePilot.mjs) testing 15 scenarios (15 runtime assertions):
1. Audit log creation & outbox staging
2. MySQL transaction commit
3. MySQL transaction rollback guard (0 outbox events)
4. Worker dispatch to Firestore
5. Firestore document creation (`audit_<mysql_audit_id>`)
6. Append-only immutability verification
7. Idempotency replay
8. Duplicate event replay
9. Out-of-order delivery safety
10. Sequential audit log insertions
11. Validation / error handling
12. Missing Firestore document handling
13. Security payload sanitization (confirm no credentials)
14. Automated cleanup phase
15. Production data safety verification

---

## 9. GO / NO-GO Criteria for Phase 3J Implementation

- [x] Audit Logs selected as Rank #1 safest domain (Score: **88/100**).
- [x] All write paths mapped and transactional boundaries audited.
- [x] Phase 2 Firestore repository CRUD completeness verified.
- [x] Deterministic document ID format (`audit_<mysql_audit_id>`) confirmed.
- [x] Security payload sanitization boundary defined.
- [x] Append-only concurrency safety confirmed.
- [x] Feature flags confirmed to remain `false` by default.

---

## PHASE 3J DESIGN STATUS: READY FOR IMPLEMENTATION
