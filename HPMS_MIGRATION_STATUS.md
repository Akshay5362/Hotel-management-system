# HPMS-Sky5 — Master Firestore Migration & Dual-Write Status Report
**Document Version**: 2.0.0  
**Audit Date**: August 11, 2026  
**Migration Strategy**: Asynchronous Transactional Outbox Dual-Write  

---

## 1. Migration Architecture Summary

HPMS-Sky5 employs a non-disruptive, asynchronous Transactional Outbox pattern to mirror relational MySQL domain events to Google Cloud Firestore shadow collections.

```
MySQL Transaction Boundary
  ├── Business Table Write (e.g. INSERT INTO rooms)
  └── Outbox Event Enqueue (INSERT INTO dual_write_outbox)
              │
              ▼ (Post-Commit)
Outbox Worker Daemon (backend/services/outboxWorker.js)
              │
              ▼
Outbox Dispatcher (backend/services/outboxDispatcher.js)
              │
              ▼
Firestore Repository Layer (backend/repositories/firestore/*.js)
              │
              ▼
Cloud Firestore Document Set/Update (Stale Event Protected)
```

---

## 2. Phase 2 & Phase 3 Domain Migration Status

| Domain / Phase | Scope | Outbox Event Types | Firestore Collection | Feature Flag | Live Dual-Write Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Phase 2** | 19 Repositories | Read/Write Methods | 19 Collections | `ENABLE_FIRESTORE_READS=true` | Operational Read Layer |
| **Phase 3A** | Outbox Infrastructure | All Event Types | N/A (`dual_write_outbox`) | `ENABLE_FIRESTORE_OUTBOX_WORKER=false` | Infrastructure Ready |
| **Phase 3B** | Room Types | `ROOM_TYPE_CREATED`, `UPDATED`, `DELETED` | `room_types` | `ENABLE_FIRESTORE_DUAL_WRITE=false` | Pilot Verified |
| **Phase 3C** | Rooms | `ROOM_CREATED`, `UPDATED`, `STATUS_CHANGED`, `DELETED` | `rooms` | `ENABLE_FIRESTORE_DUAL_WRITE=false` | Pilot Verified |
| **Phase 3D** | Staff | `STAFF_CREATED`, `UPDATED`, `STATUS_CHANGED`, `DELETED` | `staff` | `ENABLE_FIRESTORE_DUAL_WRITE=false` | Pilot Verified |
| **Phase 3E** | Categories | `INVENTORY_CATEGORY_CREATED`, `UPDATED`, `DELETED` | `inventory_categories` | `ENABLE_FIRESTORE_DUAL_WRITE=false` | Pilot Verified |
| **Phase 3F** | System Settings | `SYSTEM_DATE_UPDATED`, `SYSTEM_SETTING_UPDATED` | `system_settings` | `ENABLE_FIRESTORE_DUAL_WRITE=false` | Pilot Verified |
| **Phase 3G** | Products | `INVENTORY_PRODUCT_CREATED`, `UPDATED`, `STOCK`, `DELETED` | `inventory_products` | `ENABLE_FIRESTORE_DUAL_WRITE=false` | Pilot Verified |
| **Phase 3H** | Guest Profiles | `GUEST_CREATED`, `GUEST_UPDATED` | `guests` | `ENABLE_FIRESTORE_DUAL_WRITE=false` | Pilot Verified |
| **Phase 3I** | Housekeeping | `HOUSEKEEPING_STATUS_UPDATED`, `LOG_CREATED` | `housekeeping` | `ENABLE_FIRESTORE_DUAL_WRITE=false` | Pilot Verified |
| **Phase 3J** | Audit Logs | `AUDIT_LOG_CREATED` | `audit_logs` | `ENABLE_FIRESTORE_DUAL_WRITE=false` | Pilot Verified |

---

## 3. MySQL-Only Domains (Not Yet Dual-Written)

The following financial and transactional domains are currently **MySQL-only** for mutations. Outbox event staging is not yet implemented for these domains:
1. **Bookings & Check-In / Check-Out**: `bookings`, `booking_history` (Candidate for Phase 3K)
2. **Reservations**: `reservations`
3. **Payments**: `payments`
4. **Ledger**: `ledger_items`
5. **Invoices**: `invoices`
6. **Cash Logs & Submissions**: `cash_logs`, `cash_submissions`
7. **Night Audit**: Multi-table roll forward and snapshotting

---

## 4. Prerequisites for Enabling Live Dual-Write

Before setting `ENABLE_FIRESTORE_DUAL_WRITE=true` in production:
1. **One-Click Initial Seed Reconciliation**: Execute historical data catch-up scripts (`scripts/migrateRoomsToFirestore.js`, `scripts/migrateGuestsToFirestore.js`, etc.) to align Firestore collections with active MySQL rows.
2. **Outbox Worker Daemon Supervision**: Ensure PM2 or systemd background process supervisor manages `outboxWorker.js` to guarantee continuous event polling.
3. **Monitoring & Alerting**: Verify dead-letter outbox retry limits (`attempts >= 5`) trigger admin notifications.
