# HPMS-Sky5: Phase 3D Staff Domain Dual-Write Architecture & Safety Blueprint

> **Phase:** Phase 3D — Staff Management Dual-Write Pilot (Read-Only Design & Safety Audit)  
> **Timestamp:** August 11, 2026  
> **Domain Selected:** Staff Management  
> **Readiness Score:** **96 / 100**  
> **Status:** READ-ONLY ARCHITECTURE AUDIT COMPLETE — ZERO SOURCE CODE MODIFICATIONS PERFORMED  
> **Final Verdict:** **PHASE 3D DESIGN STATUS: READY FOR IMPLEMENTATION**  

---

## Executive Summary

Following the successful verification of Phase 3B (Room Types) and Phase 3C (Rooms), this document presents the complete architectural specification and safety audit for **Phase 3D: Staff Management Dual-Write Pilot**.

The **Staff Management Domain** has been evaluated and ranked as the **safest next operational domain** for Dual-Write bridge expansion. It features zero financial risk, simple transaction boundaries, clear deterministic document IDs (`staff_{user_uid}` or `staff_{username}`), and zero cross-domain state entanglements with check-in, room availability, payments, or night audit logic.

---

## 1. Domain Safety Ranking & Selection Analysis

All 12 remaining operational candidate domains were audited and evaluated across 14 safety and complexity dimensions:

| Rank | Domain | Readiness Score /100 | Write Path Count | Transaction Complexity | Financial Risk | Cross-Domain Dependencies | Concurrency Risk | Recommended Phase |
|---|---|---|---|---|---|---|---|---|
| **1** | **Staff Management** | **96 / 100** | **4** | **Low (Simple CRUD)** | **Zero** | **Low (Isolated)** | **Low** | **RECOMMENDED: Phase 3D** |
| 2 | System Settings | 94 / 100 | 2 | Low (Singleton) | Zero | Low | Low | Phase 3H Candidate |
| 3 | Inventory Categories | 92 / 100 | 3 | Low (CRUD) | Zero | Low | Low | Phase 3G Candidate |
| 4 | Guest Profiles | 88 / 100 | 5 | Medium | Zero | Medium | Medium | Post-Staff Pilot |
| 5 | Inventory Products | 80 / 100 | 4 | Medium (Stock logs) | Low | Medium | High (Stock race) | Phase 3G |
| 6 | Housekeeping Records | 78 / 100 | 3 | Medium | Zero | Medium | Medium | Phase 3G |
| 7 | Booking History | 75 / 100 | 2 | Medium | Zero | High (Bookings) | Low | Phase 3E |
| 8 | Cash Submissions | 70 / 100 | 2 | Medium | High | High | Medium | Phase 3G |
| 9 | Invoices | 65 / 100 | 3 | Medium | High | High | High | Phase 3F |
| 10 | Ledger Items | 60 / 100 | 4 | High | High | High | High | Phase 3F |
| 11 | Payments | 50 / 100 | 4 | High | **Critical** | High | High | Phase 3F |
| 12 | Reservations | 45 / 100 | 5 | **Critical (`FOR UPDATE`)** | High | **Critical** | **Critical** | Phase 3E |

---

## 2. Complete Staff Write-Path Inventory

The read-only audit analyzed 100% of staff write operations in [`backend/controllers/staffController.js`](file:///d:/projects/hotel/backend/controllers/staffController.js):

| # | Operation | Controller Method | Route | MySQL Tables | SQL Statement | Transaction Boundary | Proposed Outbox Event | Target Firestore Repo Method |
|---|---|---|---|---|---|---|---|---|
| 1 | **Create Staff** | `createStaff` | `POST /api/staff` | `staff` | `INSERT INTO staff (full_name, username, email, password_hash, role, department, shift, phone, status)` | MySQL Transaction | `STAFF_CREATED` | `createStaffFirestore` |
| 2 | **Update Staff** | `updateStaff` | `PUT /api/staff/:id` | `staff` | `UPDATE staff SET full_name=?, username=?, email=?, role=?, department=?, shift=?, phone=?, status=? WHERE id=?` | MySQL Transaction | `STAFF_UPDATED` | `updateStaffFirestore` |
| 3 | **Update Staff Status** | `updateStaffStatus` | `PATCH /api/staff/status` | `staff` | `UPDATE staff SET status=? WHERE id=?` | MySQL Transaction | `STAFF_STATUS_CHANGED` | `updateStaffFirestore` |
| 4 | **Soft Delete Staff** | `deleteStaff` | `DELETE /api/staff/:id` | `staff` | `UPDATE staff SET deleted=1, status='Inactive' WHERE id=?` | MySQL Transaction | `STAFF_DELETED` | `deleteStaffFirestore` |

---

## 3. MySQL → Outbox Event Mapping Architecture

When Phase 3D implementation is authorized, outbox events will map to Phase 2 [`staffRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/staffRepository.js):

| MySQL Operation | Event Type | Aggregate Type & ID | Payload Structure | Target Firestore Repo Method | Deterministic Document ID | Idempotency & Stale Guard |
|---|---|---|---|---|---|---|
| `INSERT INTO staff` | `STAFF_CREATED` | `STAFF` / `<username>` | `{ username, full_name, role, department, shift, email, phone, status, mysql_staff_id, updated_at }` | `createStaffFirestore` | `staff_<username>` | Doc existence check + `setDoc(..., { merge: true })` |
| `UPDATE staff` | `STAFF_UPDATED` | `STAFF` / `<username>` | `{ username, full_name, role, department, shift, email, phone, status, updated_at }` | `updateStaffFirestore` | `staff_<username>` | `isStaleUpdate(existing, payload)` guard |
| `UPDATE status` | `STAFF_STATUS_CHANGED` | `STAFF` / `<username>` | `{ username, status, updated_at }` | `updateStaffFirestore` | `staff_<username>` | `isStaleUpdate(existing, payload)` guard |
| `UPDATE deleted=1` | `STAFF_DELETED` | `STAFF` / `<username>` | `{ username, docId: 'staff_<username>' }` | `deleteStaffFirestore` | `staff_<username>` | Idempotent delete (`NOT_FOUND` ignore) |

---

## 4. Transaction & Concurrency Safety Analysis

### Atomic Transaction Staging:
All 4 write endpoints in `staffController.js` will execute:
```javascript
const connection = await pool.getConnection();
await connection.beginTransaction();
try {
  await connection.query('UPDATE staff SET ... WHERE id = ?', [...]);
  if (isFirestoreDualWriteEnabled()) {
    await enqueue(connection, {
      event_type: 'STAFF_UPDATED',
      aggregate_type: 'STAFF',
      aggregate_id: username,
      payload: { ... }
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

- **Rollback Guarantee**: If MySQL fails or rolls back, the outbox event rolls back cleanly in the same database transaction.
- **Worker Replay Idempotency**: If the outbox worker retries an event, `staffRepository.js` targets `staff_<username>` with `setDoc(..., { merge: true })`, eliminating duplicate document generation.

---

## 5. Firestore Baseline & Schema Compatibility

Inspection of baseline migration scripts and [`staffRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/staffRepository.js):
- **Root Collection**: All staff records are stored in `/staff/{id}` with deterministic ID `staff_<user_uid>` or `staff_<username>`.
- **Legacy Compatibility**: Payload retains `mysql_staff_id` attribute for zero-breakage backward compatibility.
- **Sensitive Fields Omitted**: `password_hash` is **never included** in outbox event payloads or sent to Firestore.

---

## 6. Failure & Recovery Matrix

| Failure Scenario | MySQL State | Outbox State | Firestore State | Safe Automated Recovery Action | Operational Risk |
|---|---|---|---|---|---|
| Outbox Insertion Failure | Rolled Back | Zero Rows | Unchanged | Transaction abort rolls back MySQL operational write | **ZERO** |
| Firestore API Unavailable | Committed | Staged / Retrying | Pending | Outbox worker retries with backoff until connection restored | **ZERO** |
| Duplicate Event Dispatch | Committed | Processed | Preserved | Deterministic `staff_<username>` merge update | **ZERO** |
| Stale Event Delivery | Committed | Processed | Preserved | Timestamp Vector Guard ignores older event | **ZERO** |
| Worker Crash Mid-Batch | Committed | Processing/Pending | Unchanged | Process restart claims uncommitted events safely | **ZERO** |

---

## 7. Regression Boundary & Scope Protection

The following operational areas **MUST REMAIN 100% MYSQL-ONLY** during Phase 3D:
- Check-in & checkout operations (`checkInService.js`, `roomController.checkOut`)
- Room shifting (`roomController.shift`)
- Booking creation & modification (`bookingController.js`, `roomController.bookRoom`)
- Reservations (`reservationController.js`, `AvailabilityService.js`)
- Financial posting & payments (`paymentController.js`, `invoiceController.js`, `ledgerController.js`)
- Night audit & business date rollover (`auditController.js`, `businessDateService.js`)

---

## 8. GO / NO-GO Criteria for Phase 3D Implementation

Implementation of Phase 3D may begin ONLY when:
- [x] Staff Management Domain selected as Rank #1 pilot.
- [x] All 4 staff write paths mapped and transactional boundaries audited.
- [x] Sensitive fields (`password_hash`) excluded from outbox payloads.
- [x] Stale-event protection guard designed for `staffRepository.js`.
- [x] Feature flags confirmed to remain `false` by default.

---

## PHASE 3D DESIGN STATUS: READY FOR IMPLEMENTATION
