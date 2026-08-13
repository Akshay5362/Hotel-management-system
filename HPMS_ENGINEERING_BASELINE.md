# HPMS-Sky5 — Master Engineering Baseline & System Architecture Audit
**Document Version**: 2.0.0  
**Audit Date**: August 11, 2026  
**Audit Type**: Read-Only Architecture & Runtime Inventory  
**System Baseline Status**: **YELLOW**

---

## 1. System Overview & Technology Inventory

HPMS-Sky5 (Webline PMS Plus) is a multi-tenant, enterprise Hotel Property Management System operating under a dual-tier architecture: MySQL relational database (Port 3306) serves as the primary operational single source of truth, while Google Cloud Firestore operates as a shadow data layer synchronized via an asynchronous Transactional Outbox pattern.

### Technology Stack Summary

| Layer | Primary Technology | Version | Purpose & Usage |
| :--- | :--- | :--- | :--- |
| **Backend API** | Node.js / Express | Node `>=20.0.0`, Express `4.19.2` | RESTful API server (`backend/server.js`, port 5000) |
| **Real-Time Gateway** | Socket.IO | `4.8.3` | Multi-room WebSocket server for dashboard live updates |
| **Relational DB** | MySQL 8.x | `mysql2 3.10.1` | **Single Source of Truth** (`hotel_pms` database, pool size 10) |
| **NoSQL Shadow DB** | Google Cloud Firestore | `firebase-admin 14.2.0` | Asynchronous read/write shadow database (`hpms-sky5`) |
| **Authentication** | Firebase Auth & Custom Claims | Client `12.17.1`, Admin `14.2.0` | ID Token validation, RBAC claims (`super_admin`, `admin`, `receptionist`, `housekeeper`, `kitchen`, `guest`) |
| **Admin/Reception SPA** | React / Vite | React `18.3.1`, Vite `5.3.1` | Main desktop SPA for hotel management (`src/`, port 5173) |
| **Guest Web Application**| React / Vite / React Router | React `19.2.7`, Vite `8.1.1` | Standalone guest self-service portal (`guest-web/src/`) |
| **Desktop Wrapper** | Electron | `43.1.1` | Desktop launcher & packager (`electron-builder 26.15.3`) |
| **Cloud Functions** | Firebase Cloud Functions v2 | Node 20 runtime | Infrastructure scaffold (`functions/index.js`) |
| **Document Processing** | Sharp & Tesseract.js | Sharp `0.35.3`, Tesseract `7.0.0` | Guest ID photo cropping & OCR document processing |
| **Payment Gateway** | Razorpay SDK | `2.9.8` | Online booking payments and signature verification |

---

## 2. Project Architecture & Runtime Topology

```
d:\projects\hotel\
├── backend/                       # Express Node.js Backend Server
│   ├── server.js                  # Express API Server Entry Point (Port 5000)
│   ├── db.js                      # MySQL mysql2 Connection Pool
│   ├── init_db.js                 # Initial MySQL Table DDL & Schema Provisioning
│   ├── config/                    # Environment & Feature Flags (featureFlags.js, firebaseAdmin.js)
│   ├── controllers/               # 15 Controller modules (roomController, paymentController, etc.)
│   ├── middleware/                # Express middleware (firebaseAuthMiddleware, uploadMiddleware)
│   ├── migrations/                # Migration scripts & runner (runner.js, 001-008 migrations)
│   ├── repositories/firestore/    # 21 Firestore Repository Abstractions
│   ├── routes/                    # API Route definitions (api.js & sub-routers)
│   ├── services/                  # Business logic services & Outbox Worker engine
│   └── tests/                     # 11 Automated Pilot & Repository Test Suites
│
├── src/                           # Primary React SPA (Admin & Reception Desk)
│   ├── main.jsx                   # React 18 Entry Point
│   ├── App.jsx                    # Root App Component, Tab Routing & Auth Context
│   ├── components/                # 40 UI Components (ReceptionPortal, ReservationModule, etc.)
│   └── config/                    # Client Config (firebaseClient.js, sidebarConfig.js)
│
├── guest-web/                     # Standalone Guest Portal (React 19, Vite 8)
│   └── src/                       # Guest Self-Service UI (GuestBookingWizard, etc.)
│
├── electron/                      # Desktop Application Container
│   ├── main.js                    # Electron Main Process (Window Creation & IPC Setup)
│   ├── backend-launcher.js        # Spawns Backend Node Child Process
│   └── preload.js                 # Context Bridge API (`window.electronAPI`)
│
├── functions/                     # Cloud Functions v2 Infrastructure Scaffold
│   └── index.js                   # Empty export ready for future server triggers
│
└── scripts/                       # 74 Utility, Migration & E2E Verification Scripts
```

---

## 3. Database Authority Mapping

| Operational Domain | Authority Model | MySQL Primary Table | Firestore Collection | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Rooms** | **MySQL Primary** | `rooms` | `rooms` | Phase 3C Dual-Write Pilot Ready (`ENABLE_FIRESTORE_DUAL_WRITE=false`) |
| **Room Types** | **MySQL Primary** | `room_types` | `room_types` | Phase 3B Dual-Write Pilot Ready |
| **Staff Profiles** | **MySQL Primary** | `staff` | `staff` | Phase 3D Dual-Write Pilot Ready |
| **Guest Profiles** | **MySQL Primary** | `guests` | `guests` | Phase 3H Dual-Write Pilot Ready |
| **Inventory Categories**| **MySQL Primary** | `inventory_categories` | `inventory_categories` | Phase 3E Dual-Write Pilot Ready |
| **Inventory Products** | **MySQL Primary** | `inventory_products` | `inventory_products` | Phase 3G Dual-Write Pilot Ready |
| **System Settings** | **MySQL Primary** | `system_settings` | `system_settings` | Phase 3F Dual-Write Pilot Ready (Business Date) |
| **Housekeeping Logs** | **MySQL Primary** | `housekeeping_logs` | `housekeeping` | Phase 3I Dual-Write Pilot Ready |
| **Audit Logs** | **MySQL Primary** | `audit_logs` | `audit_logs` | Phase 3J Dual-Write Pilot Ready |
| **Bookings** | **MySQL ONLY** | `bookings` | `bookings` (Phase 2 Read) | Transactional Outbox NOT implemented (Candidate Phase 3K) |
| **Reservations** | **MySQL ONLY** | `reservations` | `reservations` (Phase 2 Read)| Transactional Outbox NOT implemented |
| **Payments** | **MySQL ONLY** | `payments` | `payments` (Phase 2 Read) | Transactional Outbox NOT implemented |
| **Ledger Items** | **MySQL ONLY** | `ledger_items` | `ledger_items` (Phase 2 Read)| Transactional Outbox NOT implemented |
| **Invoices** | **MySQL ONLY** | `invoices` | `invoices` (Phase 2 Read) | Transactional Outbox NOT implemented |
| **Cash Drawer Logs** | **MySQL ONLY** | `cash_logs` | `cash_logs` (Phase 2 Read) | Transactional Outbox NOT implemented |
| **Check-In / Out** | **MySQL ONLY** | `bookings`, `rooms` | None (Direct MySQL) | Complex multi-table transaction boundary |
| **Night Audit** | **MySQL ONLY** | Multi-table | None (Direct MySQL) | Concurrency & financial calculation authority |

---

## 4. Current Operational Environment & Feature Flags

### Active Environment Settings (`backend/.env`)
- `PORT=5000`
- `NODE_ENV=development`
- `FIREBASE_PROJECT_ID=hpms-sky5`
- `ENABLE_STRICT_RBAC=true`

### Feature Flag Safety Locks (`backend/config/featureFlags.js`)
- `ENABLE_FIRESTORE_READS`: `true` (Default read fallback enabled)
- `ENABLE_FIRESTORE_DUAL_WRITE`: `false` (**DISABLED BY DEFAULT — Safety Lock**)
- `ENABLE_FIRESTORE_OUTBOX_WORKER`: `false` (**DISABLED BY DEFAULT — Safety Lock**)
- `ENABLE_FIRESTORE_RECONCILIATION`: `false` (**DISABLED BY DEFAULT — Safety Lock**)

---

## 5. Factory Reset Subsystem Verification

The Factory Reset implementation (`backend/services/FactoryResetService.js`) has been audited following its recent schema alignment fix:
- **Schema Alignment**: Completely updated to reference current schema tables (`housekeeping_logs` instead of obsolete legacy table `housekeeping`).
- **Room Status Reset**: Resets room status to `'vacant'`, housekeeping status to `'Clean'`, assigned staff to `NULL`, priority to `'Normal'`, and `last_cleaned_at` to `CURRENT_TIMESTAMP` on the `rooms` table.
- **Transaction Safety**: All deletions run inside a single MySQL transaction (`conn.beginTransaction()`). Any single failure triggers immediate `conn.rollback()`, leaving MySQL 100% untouched.
- **Preserved Configuration**: Admin and staff accounts (`users` where `role != 'guest'`), `staff` table, `roles`, `permissions`, `room_types`, `rooms` definitions, `inventory_categories`, `inventory_products`, and hotel settings in `system_settings` are strictly preserved.
- **Automated Verification**: Verified by [`backend/tests/testFactoryReset.mjs`](file:///d:/projects/hotel/backend/tests/testFactoryReset.mjs) (10/10 assertions passing).
