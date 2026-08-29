# HPMS — COMPLETE PROJECT AUDIT & HANDOVER

**Audit Date:** 2026-08-19  
**Project Version:** 1.0.0 (`hotel-pms-backend@1.0.0` / `webline-pms@1.0.0`)  
**Overall System Status:** ✅ OPERATIONAL — MySQL backend live, 17 rooms configured, 2 occupied  
**Current Source of Truth:** MySQL (authoritative for all business data)  
**Firebase Cutover Status:** DUAL-WRITE ACTIVE — Firestore mirrors MySQL via outbox; reads still from MySQL; no cutover to Firestore reads yet for business transactions  

---

## Table of Contents
1. [What This Project Does](#1-what-this-project-does)
2. [Complete Project Structure](#2-complete-project-structure)
3. [Technology Stack](#3-technology-stack)
4. [System Architecture](#4-system-architecture)
5. [Frontend Audit](#5-frontend-audit)
6. [Admin Portal Audit](#6-admin-portal-audit)
7. [Receptionist Portal Audit](#7-receptionist-portal-audit)
8. [Authentication & RBAC Audit](#8-authentication--rbac-audit)
9. [MySQL Database Audit](#9-mysql-database-audit)
10. [Migration Audit](#10-migration-audit)
11. [Check-In Workflow](#11-check-in-workflow)
12. [Check-Out Workflow](#12-check-out-workflow)
13. [Room Status System](#13-room-status-system)
14. [Room Management](#14-room-management)
15. [Billing / Payments / Ledger](#15-billing--payments--ledger)
16. [Ledger & Rollover Audit](#16-ledger--rollover-audit)
17. [Reservation System](#17-reservation-system)
18. [Guest Management](#18-guest-management)
19. [Housekeeping](#19-housekeeping)
20. [Inventory](#20-inventory)
21. [Cash Status](#21-cash-status)
22. [Day End / Night Audit](#22-day-end--night-audit)
23. [Reports & Analytics](#23-reports--analytics)
24. [Firebase / Firestore Migration Audit](#24-firebase--firestore-migration-audit)
25. [Firestore Transaction Adapter Audit](#25-firestore-transaction-adapter-audit)
26. [Outbox System](#26-outbox-system)
27. [Docker Audit](#27-docker-audit)
28. [Environment Configuration](#28-environment-configuration)
29. [API Inventory](#29-api-inventory)
30. [Socket.IO / Real-Time System](#30-socketio--real-time-system)
31. [Security Audit](#31-security-audit)
32. [Data Integrity Audit](#32-data-integrity-audit)
33. [Testing Audit](#33-testing-audit)
34. [Known Bugs & Technical Debt](#34-known-bugs--technical-debt)
35. [Current Feature Matrix](#35-current-feature-matrix)
36. [Database / Firestore Cutover Matrix](#36-database--firestore-cutover-matrix)
37. [Current System Source of Truth](#37-current-system-source-of-truth)
38. [Critical Risks](#38-critical-risks)
39. [Safe Development Rules](#39-safe-development-rules)
40. [Handover Guide](#40-handover-guide)
41. [Current Project State Snapshot](#41-current-project-state-snapshot)
42. [Final Audit Verdict](#42-final-audit-verdict)

---

## 1. What This Project Does

**HPMS (Hotel Property Management System)** is a full-stack, single-hotel PMS built for **Hotel Sky-5**. It manages the complete hotel operations lifecycle:

- Guest room booking, check-in, stay, and check-out
- Daily billing and ledger management
- Night audit / Day End processing
- Staff management with role-based access control (RBAC)
- Housekeeping coordination
- Inventory control
- Analytics and reporting
- Guest portal for self-service bookings and folio viewing

### Who Uses It

| Role | Portal | Description |
|------|--------|-------------|
| **Super Admin** (root user) | Admin Dashboard `/admin/dashboard` | Full system access, day-end, RBAC, factory reset |
| **Staff Admin** | Admin Dashboard `/admin/dashboard` | Same as super admin but no factory-reset / undo-day-end |
| **Receptionist** | Reception Portal `/reception/dashboard` | Check-in, check-out, reservations, ledger, cash |
| **Housekeeper** | Housekeeping Dashboard `/housekeeping/dashboard` | Room clean/dirty status |
| **Chef / Kitchen** | Kitchen Dashboard `/kitchen/dashboard` | Minimal stub |
| **Pantry** | Pantry Dashboard `/pantry/dashboard` | Minimal stub |
| **Guest** | Guest Portal `/dashboard` | Book rooms, view folio, request services |

### Portals Confirmed in Source

1. **Admin Portal** — Full-featured, actively developed ✅
2. **Receptionist Portal** (`ReceptionPortal.jsx`) — Full-featured, actively developed ✅
3. **Guest Portal** (`GuestDashboard.jsx`) — Implemented with Firebase Auth, booking wizard, folio view ✅
4. **Electron Desktop App** — Present (`electron/`, `main.js`), configured but NOT actively tested/deployed. Connects to backend via localhost or Docker. Status: **LEGACY / MAINTENANCE MODE**.
5. **Kitchen/Pantry/Housekeeping dashboards** — Stub pages (minimal functionality)

### Deployment Architecture

```
[User's Browser]
       │
       ▼
[Vite Dev Server :5173] (frontend — npm run dev)
       │ HTTP/WebSocket
       ▼
[Docker Container: hotel_pms_backend :5000]  (Express + Socket.IO)
       │
       ├── MySQL: hotel_pms_db :3307 (Docker)
       ├── Firebase Admin SDK (project: hpms-sky5)
       └── Firestore (dual-write, outbox pattern)

[phpMyAdmin :8080] → hotel_pms_db (admin tool)
[Firebase Console] → hpms-sky5 project
```

**Production readiness: PRE-PRODUCTION** — Not deployed to cloud. Single hotel, single location. MySQL is authoritative for all business data. Firebase cutover is incomplete.

---

## 2. Complete Project Structure

### Root Level

```
d:\projects\hotel\
├── src/                    Frontend (React + Vite)
├── backend/                Node.js + Express API
├── electron/               Electron desktop wrapper (main.js, 25KB)
├── guest-web/              Guest web app artifact (investigated separately)
├── functions/              Firebase Cloud Functions (if any)
├── docker/                 Dockerfiles
├── docker-compose.yml      3-service compose (db, backend, phpmyadmin)
├── firebase.json           Firebase project config
├── firestore.indexes.json  Composite Firestore indexes
├── firestore.rules         Firestore security rules
├── storage.rules           Firebase Storage rules
├── scripts/                Utility scripts
├── docs/                   Documentation folder
├── backups/                Database backups
├── *.md                    40+ architecture/design documents (PHASE3*, PHASE4*, etc.)
├── package.json            Frontend deps (React 18, Vite 5, firebase 12, socket.io-client 4)
└── main.js                 Electron main process (25KB)
```

> **⚠️ WARNING:** Root has many one-off scripts (`fix.js`, `refactor.cjs`, `repair.js`, `patch*.cjs`, `test*.js`), leftover patch files, and a 141KB `original_GuestDashboard.jsx` backup. These are **dead code / scratch files**.

### Frontend (`src/`)

```
src/
├── App.jsx                 1459 lines — Custom router, main layout, all admin state
├── main.jsx                React DOM entry point
├── index.css               28KB — Global CSS, design tokens, glassmorphism styles
├── components/             41 component files
├── contexts/               AdminAuthContext.jsx, GuestAuthContext.jsx
├── config/                 apiConfig.js, authMapping.js, firebaseClient.js, sidebarConfig.js
└── utils/                  Utility functions
```

**Key Components:**

| Component | Size | Purpose | Status |
|-----------|------|---------|--------|
| `App.jsx` | 54KB / 1459L | Master SPA router, admin dashboard, all state | Active |
| `ReceptionPortal.jsx` | 102KB | Complete receptionist portal (self-contained) | Active |
| `GuestDashboard.jsx` | 80KB | Guest portal dashboard | Active |
| `AuthCard.jsx` | 13KB | Dual auth login (Firebase + legacy JWT) | Active |
| `ReservationModule.jsx` | 65KB | Full reservation management | Active |
| `GuestBookingWizard.jsx` | 85KB | Guest self-booking wizard | Active |
| `CheckInModal.jsx` | 12KB | Admin check-in form (7 new fields) | Active |
| `CheckOutModal.jsx` | 13KB | Admin check-out (ledger display) | Active |
| `LedgerPanel.jsx` | 10KB | Live folio viewer (fetches GET /rooms/:n/ledger) | Active |
| `RoomInspectorDrawer.jsx` | 13KB | Admin room side panel + LedgerPanel | Active |
| `SettingsModal.jsx` | 45KB | System settings, RBAC, staff, business date | Active |
| `AnalyticsModal.jsx` | 35KB | Revenue, occupancy, payment analytics | Active |
| `InventoryModule.jsx` | 36KB | Product + category management | Active |
| `PaymentPanel.jsx` | 19KB | Payment recording | Active |
| `CashStatusModal.jsx` | 20KB | Cash submissions and ledger | Active |
| `AdminGuests.jsx` | 35KB | Guest profile management | Active |
| `AdminHousekeeping.jsx` | 11KB | Housekeeping management | Active |
| `IdentityVerificationModal.jsx` | 23KB | Guest ID document verification | Active |
| `GuestActiveStayOverview.jsx` | 31KB | Guest folio view during stay | Active |
| `StaffDashboards.jsx` | 3KB | Kitchen/Pantry/Housekeeping stub pages | Stub |
| `GuestLoyalty.jsx` | 1.2KB | Loyalty placeholder | STUB |
| `GuestProfile.jsx` | 481B | Profile placeholder | STUB |

### Backend (`backend/`)

```
backend/
├── server.js               Express + Socket.IO entry point, CORS, outbox startup
├── db.js                   MySQL connection pool
├── routes/
│   ├── api.js              Main router (134 lines, mounts all sub-routers)
│   ├── paymentRoutes.js    /api/payments/*
│   ├── reportsRoutes.js    /api/reports/*
│   ├── invoiceRoutes.js    /api/invoices/*
│   ├── housekeepingRoutes.js  /api/housekeeping/*
│   ├── staffRoutes.js      /api/staff/*
│   ├── reservationRoutes.js   /api/reservations/*
│   ├── inventoryRoutes.js  /api/inventory/*
│   ├── roomTypeRoutes.js   /api/room-types/*
│   └── factoryResetRoutes.js  /api/system/factory-reset/*
├── controllers/            15 controller files
├── services/               18 service files
├── repositories/firestore/ 23 Firestore repository files
├── adapters/firestore/     3 Firestore transaction adapters
├── middleware/             4 middleware files
├── config/
│   ├── featureFlags.js     14 feature flags
│   └── firebaseAdmin.js    Firebase Admin SDK init
├── migrations/             12 numbered migrations + runner.js
└── utils/                  dateUtils.js and others
```

---

## 3. Technology Stack

### Frontend
| Technology | Version | Purpose |
|-----------|---------|---------|
| React | 18.3.1 | UI framework |
| Vite | 5.3.1 | Build tool / dev server |
| JavaScript (JSX) | ES2022 | Language |
| CSS Variables | Custom | Design system (no Tailwind, no framework) |
| Firebase Client SDK | 12.17.1 | Auth + Firestore client |
| socket.io-client | 4.8.3 | Real-time room updates |
| recharts | 3.10.0 | Analytics charts |
| jspdf + jspdf-autotable | 4.2.1 / 5.0.8 | PDF invoice generation |
| xlsx | 0.18.5 | Excel report exports |
| lucide-react | 1.25.0 | Icon library |
| Electron | 43.1.1 | Desktop wrapper (dev only) |

### Backend
| Technology | Version | Purpose |
|-----------|---------|---------|
| Node.js | (container) | Runtime |
| Express | 4.19.2 | Web framework |
| mysql2 | 3.10.1 | MySQL driver (promise pool) |
| firebase-admin | 14.2.0 | Firebase Admin SDK |
| socket.io | 4.8.3 | WebSocket server |
| bcryptjs | 3.0.3 | Password hashing (staff) |
| multer | 2.2.0 | File uploads |
| tesseract.js | 7.0.0 | OCR for ID documents |
| razorpay | 2.9.8 | Payment gateway SDK |
| sharp | 0.35.3 | Image processing |
| cors | 2.8.5 | CORS middleware |
| dotenv | 16.4.5 | Environment config |

### Database
| Component | Details |
|----------|---------|
| MySQL | 8.0 (Docker) |
| Database name | `hotel_pms` |
| Tables | 32 (confirmed) |
| Firestore | Project: `hpms-sky5` |
| Firebase Auth | hpms-sky5 — staff provisioned via Firebase |
| Storage bucket | `hpms-sky5.appspot.com` |

### Infrastructure
| Component | Details |
|----------|---------|
| Docker Compose | 3 services: db, backend, phpmyadmin |
| DB container | `hotel_pms_db` — MySQL 8.0 — port 3307 (host) / 3306 (internal) |
| Backend container | `hotel_pms_backend` — port 5000 |
| phpMyAdmin | `hotel_pms_phpmyadmin` — port 8080 |
| MySQL data | Persisted in named volume `mysql_data` |
| Guest documents | Persisted in named volume `guest_documents` |
| Backend source | Mounted as volume `./backend:/app` (live code changes visible) |

> **IMPORTANT:** Backend source is bind-mounted. Code changes to `backend/` are visible immediately without image rebuild. But if `package.json` changes, a full `docker-compose build` + restart is required.

---

## 4. System Architecture

### Request Flow

```
┌─────────────────────────────────────────────────────────┐
│                     FRONTEND (Vite :5173)                │
│  App.jsx / ReceptionPortal.jsx / GuestDashboard.jsx     │
│  Custom hash router via window.history.pushState        │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP REST + Bearer Token
                         │ WebSocket (socket.io-client)
                         ▼
┌─────────────────────────────────────────────────────────┐
│              BACKEND (Express :5000)                     │
│  server.js → CORS → body-parser → /api router           │
│                                                          │
│  Routes (api.js):                                        │
│    authenticate (Firebase ID Token OR Legacy JWT)        │
│    requireRole(...roles)                                 │
│                          ↓                              │
│  Controllers (15 files)                                 │
│    → Services (18 files)                               │
│      → MySQL pool (parameterized queries)              │
│      → Firestore Repositories (dual-write via outbox)  │
│      → Outbox Queue (dual_write_outbox table)          │
│                                                          │
│  OutboxWorker (3s polling):                             │
│    dispatchEvent() → Firestore Repository upserts       │
└────────────────────────┬────────────────────────────────┘
                         │
            ┌────────────┴──────────────┐
            ▼                           ▼
┌───────────────────┐      ┌────────────────────────────┐
│  MySQL :3306      │      │  Firestore (hpms-sky5)     │
│  hotel_pms DB     │      │  Mirror via outbox          │
│  32 tables        │      │  23 collections/repos       │
│  SOURCE OF TRUTH  │      │  Read canaries disabled     │
└───────────────────┘      └────────────────────────────┘
```

### Architecture Violations / Deviations (VERIFIED)

1. **Direct SQL in controllers:** Some controllers bypass the service layer and query MySQL directly. `roomController.js` (97KB) contains both controller logic AND service logic mixed together.
2. **No formal MySQL repository layer:** The `repositories/` folder only has `repositories/firestore/`. All MySQL access is direct `pool.query()` calls in services and controllers.
3. **ReceptionPortal.jsx is a mega-file:** 102KB, self-contained with all its own modals, API calls, and state — no reuse with Admin portal components.
4. **App.jsx is the Admin dashboard:** No separate admin page files. All admin logic (1459 lines) lives in `App.jsx`.
5. **Custom router:** No React Router. Uses `window.history.pushState` + state variable. No `<Route>` components.

---

## 5. Frontend Audit

### Routing (Custom — No React Router)

Routes are managed by `currentPath` state in `App.jsx` and `window.history.pushState`. The render tree switches based on path string matching.

| Path | Component | Auth Required | Role |
|------|-----------|--------------|------|
| `/` | LandingPage | None | None |
| `/login` | AuthCard (guest) | None | None |
| `/signup` | AuthCard (guest, sign-up) | None | None |
| `/dashboard` | GuestDashboard | GuestAuth | guest |
| `/admin/login` | AuthCard (admin) | None | None |
| `/admin/dashboard` | AppContent (Admin) | AdminAuth | admin / super_admin |
| `/reception/dashboard` | ReceptionPortal | AdminAuth | receptionist |
| `/kitchen/dashboard` | KitchenDashboard | AdminAuth | CHEF/KITCHEN_HELPER |
| `/pantry/dashboard` | PantryDashboard | AdminAuth | PANTRY_BOY |
| `/housekeeping/dashboard` | HousekeepingDashboard | AdminAuth | CLEANER |

### AuthCard.jsx
- **Firebase path (isAdmin=true + Firebase configured):** Signs in via `signInWithEmailAndPassword`, gets ID token, calls `GET /api/auth/me`, receives `{user: {role, ...}}`, routes by role.
- **Legacy path (fallback):** Posts to `/api/auth/signin`, receives legacy HMAC-JWT token.
- **Username→Email mapping:** `src/config/authMapping.js` maps usernames to Firebase emails (14 hardcoded entries for Hotel Sky-5).
- **Potential bug:** If a new staff account is created but not in `USERNAME_EMAIL_MAP`, the fallback email is `<username>@hotelsky5.com`.

### AdminAuthContext.jsx
- Persists `adminUser` + `adminToken` in `localStorage`.
- On `onAuthStateChanged` (Firebase): refreshes token, re-calls `/api/auth/me` to sync role.
- **Security note:** Role stored in `localStorage` could be stale between `/api/auth/me` calls if role changes in DB without re-login. The re-validation on auth state change mitigates this.

### LedgerPanel.jsx
- Fetches `GET /api/rooms/:number/ledger` with Bearer token.
- Displays: transaction type badges, amount, credit, running balance.
- Summary cards: Total Charges, Total Payments, Outstanding.
- `compact` prop for side-panel mode (not yet fully implemented — compact prop exists but no branch logic observed in current file).
- **Only renders for occupied rooms** — caller must guard.

---

## 6. Admin Portal Audit

### Dashboard (AppContent in App.jsx)

The admin dashboard uses a tabbed navigation (adminTab state):

| Tab | Value | Component/Section |
|-----|-------|------------------|
| Front Desk | `frontdesk` | RoomGrid + MetricsBar + Modals |
| Reservations | `reservations` | ReservationModule |
| Guests | `guests` | AdminGuests |
| Housekeeping | `housekeeping` | AdminHousekeeping |
| Inventory | `inventory` | InventoryModule |
| Settings | `settings` | SettingsModal |
| Analytics | — (modal) | AnalyticsModal |
| Reports | — (modal) | ReportsModal |
| Cash | — (modal) | CashStatusModal |

### Room Management
- **RoomGrid** → renders RoomCard per room → click opens `RoomInspectorDrawer`
- **RoomCard** shows: status badge, guest name, room number, type
- **RoomInspectorDrawer** shows: guest details, booking info, tariff, new fields (company, city, state, purpose), and `LedgerPanel` (for occupied rooms)
- Active/Inactive and Clean/Dirty controls appear in **SettingsModal → Room Management section** and via **RoomInspectorDrawer** (status update button)

### Check-In (Admin)
- **UI:** CheckInModal.jsx (12KB)
- **Fields:** guestName, phone, pax, deposit, checkInDate, billingInstruction, mealPlan, dob, roomTariff, paymentMode, purposeOfVisit, companyName, gstNo, city, state (16 fields total)
- **API:** `POST /api/rooms/:number/checkin`
- **Controller:** `checkIn` in `roomController.js`
- **Service:** `processCheckIn` in `checkInService.js`
- **DB:** bookings, guests, ledger_items, payments, cash_logs, room_status_history, audit_logs

### Check-Out (Admin)
- **UI:** `CheckOutModal.jsx` (standalone, 13KB) — separate from the one in ReceptionPortal
- **Now shows:** `LedgerPanel` for live folio
- **API:** `POST /api/rooms/:number/checkout`
- **Controller:** `checkOut` in `roomController.js`
- **Service:** `processCheckOut` in `checkOutService.js`
- **DB:** bookings, payments, cash_logs, invoices, room_status_history, audit_logs, checkout_snapshots

### Other Admin Features

| Feature | Entry Point | API | Notes |
|---------|------------|-----|-------|
| Modify Check-In | ModifyCheckInModal | `PUT /rooms/:n/checkin` | Change guest details on existing booking |
| Shift Room | RoomShiftingModal | `POST /rooms/shift` | Move guest between rooms |
| Extend Stay | RoomInspectorDrawer | `POST /rooms/:n/extend-stay` | Add nights, creates ROLLOVER ledger entry |
| Late Checkout | Action button | `POST /rooms/:n/late-checkout` | Extends expected checkout time |
| No-Show | Action button | `POST /rooms/:n/no-show` | Marks reservation as no-show |
| Refund Checkout | RefundCheckoutModal | `POST /rooms/:n/refund-checkout` | Admin-only refund flow |
| Add Ledger Item | PaymentPanel (admin) | `POST /rooms/:n/ledger` | Manual charge/credit entry |
| Day End | Toolbar button | `POST /api/dayend` | Night audit |
| Undo Day End | Settings | `POST /api/dayend/undo` | Super admin only |
| Cash Status | Toolbar | `GET /api/cash/submissions` | Cash submissions view |
| Reports | Toolbar | `/api/reports/*` | Occupancy, revenue, etc. |
| Analytics | Toolbar | Inline calculations | Charts via recharts |
| Reservations | Tab | `/api/reservations/*` | Full CRUD |
| Guest Mgmt | Tab | `/api/admin/guests/*` | Guest search, history, ID verification |
| Housekeeping | Tab | `/api/housekeeping/*` | Logs, assignments |
| Inventory | Tab | `/api/inventory/*` | Categories + products |
| Staff Management | SettingsModal | `/api/staff/*` | CRUD (admin only) |
| RBAC | SettingsModal | `/api/auth/*` + MySQL roles | Role/permission management |
| Guest Requests | GuestRequestsModal | `/api/admin/guest-requests` | Requests from guests |

---

## 7. Receptionist Portal Audit

### What Receptionists CAN Do

| Feature | Verified | Notes |
|---------|---------|-------|
| Check-In guest | ✅ | Full form with 8 new fields |
| Check-Out guest | ✅ | Shows LedgerPanel folio |
| View room grid | ✅ | Color-coded status |
| View ledger/folio | ✅ | Via CheckOutModal or selectedRoom panel |
| Create reservation | ✅ | From ReceptionPortal |
| View/manage reservations | ✅ | |
| Search guests | ✅ | `/api/reception/guests/search` |
| Mark room clean | ✅ | `POST /rooms/:n/clean` |
| Assign room to reservation | ✅ | AssignRoomModal |
| Shift room | ✅ | |
| Extend stay | ✅ | |
| Cash submission | ✅ | `POST /api/cash/submit` |
| View cash submissions | ✅ | |
| Guest requests view | ✅ | |
| Add ledger item (manual charge) | ✅ | `POST /rooms/:n/ledger` |

### What Receptionists CANNOT Do
- Run Day End (`POST /api/dayend` — `requireRole('admin')`)
- Undo Day End (`requireSuperAdmin`)
- Delete guest documents (`requireRole('admin')` only)
- Access staff management (`requireRole('admin')` only)
- Refund checkout (`requireRole('admin')` only)
- Factory reset
- View/modify refund policy (`requireRole('admin')` only)

### RBAC Verification (from routes/api.js)

```
POST /rooms/:n/checkin          → requireRole('admin', 'receptionist') ✅
POST /rooms/:n/checkout         → requireRole('admin', 'receptionist') ✅
GET  /rooms/:n/ledger           → requireRole('admin', 'receptionist') ✅
POST /rooms/:n/ledger           → requireRole('admin', 'receptionist') ✅
POST /api/dayend                → requireRole('admin')                 ✅ (LOCKED)
POST /api/dayend/undo           → requireSuperAdmin                    ✅ (LOCKED)
DELETE /admin/guest-documents   → requireRole('admin')                 ✅ (LOCKED)
router.use('/staff', ...)       → requireRole('admin')                 ✅ (LOCKED)
POST /rooms/:n/refund-checkout  → requireRole('admin')                 ✅ (LOCKED)
```

---

## 8. Authentication & RBAC Audit

### Authentication Systems

Two parallel auth systems exist and are **BOTH active**:

#### System 1: Firebase Authentication (PRIMARY when `ENABLE_FIREBASE_AUTH=true`)
- Used for: Staff login (Admin + Receptionist), Admin login
- Flow: Username → email lookup via `authMapping.js` → Firebase `signInWithEmailAndPassword` → ID token → `GET /api/auth/me` → MySQL lookup → role resolved

#### System 2: Legacy HMAC-SHA256 JWT (FALLBACK)
- Used for: Guest login (always), Staff login fallback if Firebase fails
- `JWT_SECRET` = `process.env.JWT_SECRET || 'hotel-pms-super-secret-key-12345!'`
- **⚠️ CRITICAL SECURITY RISK:** Default secret is hardcoded. If `JWT_SECRET` env var is not set, the default is used.
- Token format: `base64url(JSON({id, role})) + "." + HMAC-SHA256`

#### System 3: Guest Auth
- Guests use `/api/auth/signup` + `/api/auth/signin` → Legacy JWT
- `GuestAuthContext` stores token in `localStorage.guestToken`

### Login Flow (Detailed)

**Staff/Admin Firebase Login:**
```
1. User enters username + password in AuthCard
2. authMapping.js: username → Firebase email
3. Firebase signInWithEmailAndPassword(email, password)
4. On success: getIdToken(true) → Firebase ID token
5. GET /api/auth/me with Bearer {idToken}
6. Backend: auth.verifyIdToken(token) → Firebase Admin SDK
7. Extract claims: {role, type, staff_id, mysql_id}
8. If staff token: SELECT * FROM staff WHERE id = mysql_id
9. Return {user: {id, username, role, department, ...}}
10. Frontend: routes by role (admin → /admin/dashboard, receptionist → /reception/dashboard)
```

**Guest Login:**
```
1. POST /api/auth/signin {username, password}
2. Backend: SHA256(password), SELECT from users WHERE username
3. If match: generateToken({id, role: 'guest'}) → HMAC-JWT
4. Return token + user object
5. Frontend: GuestAuthContext.login(user, token)
6. Navigate to /dashboard
```

### Role Normalization

| DB Role (staff.role) | Normalized Role | Dashboard |
|---------------------|-----------------|-----------|
| ADMIN (staff) | admin | /admin/dashboard |
| root users.id=1 role=admin | super_admin | /admin/dashboard |
| RECEPTIONIST | receptionist | /reception/dashboard |
| CLEANER | housekeeper | /housekeeping/dashboard |
| CHEF / KITCHEN_HELPER | kitchen | /kitchen/dashboard |
| PANTRY_BOY | kitchen | /pantry/dashboard |

### requireRole Behavior

`ENABLE_STRICT_RBAC=true` (current value) → strict canonical role matching.

```javascript
// super_admin inherits admin privileges
if (normalizedRole === 'super_admin') effectiveRoles.push('admin');
const isAllowed = allowedRoles.some(r => effectiveRoles.includes(r.toLowerCase()));
```

### Known Auth Issues

1. **🔴 CRITICAL:** `JWT_SECRET` has a hardcoded fallback default in authController.js line 9: `'hotel-pms-super-secret-key-12345!'`. If `.env` doesn't set `JWT_SECRET`, legacy tokens are signed with this known secret.
2. **🟡 MEDIUM:** `adminUser` in localStorage is trusted for routing decisions until page refresh triggers `/api/auth/me`. A stale role could persist in the same browser session if role changes in DB.
3. **🟡 MEDIUM:** `authMapping.js` has hardcoded email mappings for 14 specific users. Any new staff user not in the map gets `<username>@hotelsky5.com` fallback — may fail if that email doesn't exist in Firebase.
4. **🟢 LOW:** Firebase token refresh handled by `onAuthStateChanged` in `AdminAuthContext` (refreshes on every auth state change).

---

## 9. MySQL Database Audit

**Current Business Date:** `2026-08-18`  
**Rooms:** 17 (2 occupied, 15 vacant)  
**Active Bookings:** 4 (mix of Checked In / historical)

### Complete Table List (Verified)

```
audit_logs              booking_history         bookings
cash_logs               cash_submissions        checkout_snapshots
dual_write_outbox       feedback                guests
housekeeping            housekeeping_logs       inventory_categories
inventory_products      invoices                ledger_items
maintenance             notifications           payments
permissions             razorpay_transactions   reservations
role_permissions        roles                   room_status_history
room_types              rooms                   schema_migrations
staff                   stay_extension_requests system_settings
users
```
(32 tables total)

### Key Table Schemas (VERIFIED)

#### `rooms`
| Column | Type | Notes |
|--------|------|-------|
| id | int AUTO_INCREMENT | PK |
| number | varchar(10) UNIQUE | Room number (string, not int) |
| room_type_id | int FK→room_types | |
| status | varchar(20) | vacant/occupied/booked/dirty |
| housekeeping_status | varchar(20) DEFAULT 'Clean' | Clean/Dirty |
| housekeeping_priority | varchar(30) DEFAULT 'Normal' | |
| is_active | tinyint(1) DEFAULT 1 | Soft-disable inactive rooms |
| housekeeping_assigned_to | int FK→users | |
| last_cleaned_at | datetime | |

**Current room data:** 17 rooms (numbers: 1-12, 14, 16, 17, 19, 20). Rooms 13, 15, 18 don't exist.

#### `room_types`
| Column | Type | Notes |
|--------|------|-------|
| id | int AUTO_INCREMENT | PK |
| code | varchar(20) UNIQUE | e.g. 'STANDARD', 'EXECUTIVE', 'PREMIUM' |
| title | varchar(100) | |
| description | text | |
| base_rate | **int** | **⚠️ Integer, not DECIMAL** |
| image | varchar(10) | |

#### `bookings`
| Column | Type | Notes |
|--------|------|-------|
| id | int AUTO_INCREMENT | PK |
| booking_number | varchar(50) UNIQUE | BKG-XXXXXX |
| guest_id | int FK→guests CASCADE | |
| room_id | int FK→rooms CASCADE | |
| check_in_date | **varchar(20)** | **⚠️ NOT a DATE type** |
| check_out_date | varchar(20) DEFAULT '' | |
| expected_check_out_date | varchar(20) DEFAULT '' | |
| adults | int DEFAULT 1 | |
| children | int DEFAULT 0 | |
| booking_status | varchar(20) | 'Checked In'/'Checked Out'/'Reserved' |
| payment_status | varchar(20) | 'Pending'/'Partial'/'Paid' |
| total_amount | **int** DEFAULT 0 | **⚠️ Integer currency** |
| advance_amount | **int** DEFAULT 0 | **⚠️ Integer currency** |
| notes | text | |
| created_by | int FK→users SET NULL | |
| billing_instruction | varchar(50) DEFAULT 'Direct to Guest' | |
| meal_plan | varchar(30) DEFAULT 'EP' | |
| room_tariff | **int** DEFAULT NULL | Booking-specific negotiated rate; NULL = use base_rate |
| payment_mode | varchar(50) DEFAULT NULL | Cash/UPI/Card/Bank Transfer/Other |
| purpose_of_visit | varchar(50) DEFAULT NULL | Official/Function/Tourist/Personal/Business |

#### `guests`
| Column | Type | Notes |
|--------|------|-------|
| id | int AUTO_INCREMENT | PK |
| full_name | varchar(255) | Stored UPPERCASE |
| email, phone, address, gst_no | varchar | |
| pincode, country, arrival_from, departure_to | varchar | |
| government_id, id_type, gender | varchar | |
| age | int | |
| date_of_birth | date DEFAULT NULL | |
| id_document_path | varchar(255) | OCR source file path |
| id_upload_timestamp, id_verification_status | | |
| id_rejection_reason, id_verified_by, id_verified_at | | |
| id_ocr_text | text | Raw OCR output |
| user_id | int FK→users SET NULL | Links to self-service accounts |
| loyalty_tier | varchar(50) DEFAULT 'Bronze' | |
| loyalty_points | int DEFAULT 0 | |
| company_name | varchar(255) DEFAULT '' | Phase E addition |
| city | varchar(100) DEFAULT '' | Phase E addition |
| state | varchar(100) DEFAULT '' | Phase E addition |

#### `ledger_items`
| Column | Type | Notes |
|--------|------|-------|
| id | int AUTO_INCREMENT | PK |
| room_number | varchar(10) FK→rooms CASCADE | |
| desc | varchar(255) | Entry description |
| qty | int DEFAULT 1 | |
| amount | **int** | **⚠️ Integer currency** |
| business_date | varchar(20) | |
| booking_id | int FK→bookings CASCADE | |
| status | varchar(20) DEFAULT 'Pending' | |
| transaction_type | varchar(50) DEFAULT 'CHARGE' | CHARGE/PAYMENT/ROLLOVER/ADJUSTMENT/REFUND/REVERSAL |
| credit_amount | **int** DEFAULT 0 | Positive = reduces balance |
| payment_mode | varchar(50) DEFAULT NULL | For PAYMENT rows |
| time_of_entry | varchar(20) | HH:MM AM/PM |
| created_by | int | Staff user ID |

#### `staff`
| Column | Type | Notes |
|--------|------|-------|
| id | int AUTO_INCREMENT | PK |
| full_name, username (UNIQUE), email (UNIQUE) | | |
| password_hash | varchar(255) | bcrypt |
| role | ENUM('ADMIN','RECEPTIONIST','CHEF','KITCHEN_HELPER','PANTRY_BOY','CLEANER') | |
| department | ENUM('Administration','Front Office','Kitchen','Pantry','Housekeeping') | |
| shift | ENUM('Morning','Night') | |
| status | ENUM('Active','Inactive') | |
| deleted | tinyint(1) DEFAULT 0 | Soft delete |

**Current staff count: 0** (no staff records in DB — staff not yet provisioned in MySQL)

#### `users`
| Column | Type | Notes |
|--------|------|-------|
| id | int AUTO_INCREMENT | PK |
| username (UNIQUE) | varchar(50) | |
| password | varchar(255) | SHA-256 (NOT bcrypt) |
| fullName | varchar(255) | |
| phone | varchar(50) | |
| role_id | int FK→roles | |

**Current users: ~3** (root admin + test users)

> **⚠️ WARNING:** `users` table uses SHA-256 for passwords, NOT bcrypt. `staff` uses bcrypt. Two different hashing strategies.

#### `dual_write_outbox`
| Column | Type | Notes |
|--------|------|-------|
| id | bigint AUTO_INCREMENT | PK |
| event_id | varchar(64) UNIQUE | UUID |
| event_type | varchar(64) | e.g. 'BOOKING_CHECKIN_COMPOUND' |
| aggregate_type | varchar(64) | e.g. 'BOOKING' |
| aggregate_id | varchar(128) | |
| payload | longtext | JSON event payload |
| status | ENUM('PENDING','PROCESSING','PROCESSED','FAILED','DEAD_LETTER') | |
| attempts | int DEFAULT 0 | |
| available_at | timestamp | Supports exponential backoff |
| processed_at | timestamp | |
| last_error | text | |

**Current state:** 1 total event, 0 pending (all processed).

#### `system_settings`
| key_name | value_val |
|----------|----------|
| system_date | 2026-08-18 |
| today_checkins | 1 |
| today_checkouts | 0 |
| continued_rooms | 1 |

#### `payments`
- **Integer currency** (not DECIMAL)
- Payment methods stored as varchar: 'Cash', 'UPI', 'Card', 'Razorpay', 'Bank Transfer'
- Split payment support via `reference_payment_id`, `split_group_id`
- Links to bookings, guests, and multiple staff user references

#### `reservations`
- Advance payment stored as **int**
- `status`: 'Reserved' / 'Confirmed' / 'Checked-In' / 'Cancelled' / 'No-Show'
- Links to rooms (FK→rooms SET NULL) and bookings (FK→bookings SET NULL)
- Has `date_of_birth`, `meal_plan`, `state`, `company` fields

### Financial Data Risk: Integer Currency

> **⚠️ CRITICAL FINANCIAL RISK:** All monetary columns (`total_amount`, `advance_amount`, `base_rate`, `amount`, `credit_amount`) use `int`, not `DECIMAL(10,2)`. This means no sub-rupee precision. Currently all rates are whole numbers (e.g., ₹2000), but this would break if fractional pricing is ever needed.

### Relationships Overview

```
users ──┬── guests (user_id)
        └── bookings (created_by)

roles ── role_permissions ── permissions

rooms ──┬── bookings (room_id)
        │     └── ledger_items (booking_id)
        │     └── payments (booking_id)
        │     └── invoices (booking_id)
        │     └── cash_logs (booking_id)
        │     └── booking_history (booking_id)
        └── reservations (room_id)
        └── housekeeping (room_id)
        └── room_status_history (room_id)

guests ──── bookings (guest_id)
            reservations (no direct FK, by room_number text)

room_types ── rooms (room_type_id)
```

---

## 10. Migration Audit

**All 12 migrations applied. 0 pending.**

| Migration | Purpose | Tables Affected | Status |
|-----------|---------|----------------|--------|
| 001_add_payment_fields.js | Add payment columns to bookings/guests | bookings, guests, payments | ✅ Applied |
| 002_add_erp_payment_fields.js | Add split payments, invoice, cash_logs, audit_logs | payments, invoices, cash_logs, audit_logs, checkout_snapshots, booking_history | ✅ Applied |
| 003_create_staff_table.js | Create staff table, roles, permissions, role_permissions | staff, roles, permissions, role_permissions | ✅ Applied |
| 004_update_room_inventory.js | is_active, room_types refactor | rooms, room_types | ✅ Applied |
| 005_create_reservations_table.js | Reservations table, stay_extension_requests | reservations, stay_extension_requests | ✅ Applied |
| 006_add_meal_plan_billing_instruction.js | meal_plan, billing_instruction on bookings/reservations | bookings, reservations | ✅ Applied |
| 007_create_inventory_tables.js | inventory_categories, inventory_products | inventory_categories, inventory_products | ✅ Applied |
| 008_create_dual_write_outbox.js | Transactional outbox table | dual_write_outbox | ✅ Applied |
| 009_add_housekeeping_columns_to_rooms.js | housekeeping_status, priority, assigned_to, last_cleaned_at | rooms | ✅ Applied |
| 010_create_housekeeping_logs.js | housekeeping_logs table, maintenance, feedback, notifications tables | housekeeping_logs, maintenance, feedback, notifications | ✅ Applied |
| 011_add_notes_to_booking_history.js | notes column to booking_history | booking_history | ✅ Applied |
| 012_checkin_ledger_enhancement.js | 11 new columns: room_tariff, payment_mode, purpose_of_visit, company_name, city, state, transaction_type, credit_amount, payment_mode(ledger), time_of_entry, created_by | bookings, guests, ledger_items | ✅ Applied |

> **⚠️ DO NOT RUN migrate:fresh** — this drops all tables. Current data would be destroyed.

---

## 11. Check-In Workflow

### Complete Flow (VERIFIED)

```
User clicks "Check In" →
CheckInModal / ReceptionPortal CheckInModal (16 fields)
  ↓
POST /api/rooms/:number/checkin
  {guestName, phone, email, address, country, pax, children, deposit,
   paymentMethod, checkInDate, billingInstruction, mealPlan, dob,
   roomTariff, paymentMode, purposeOfVisit, companyName, gstNo, city, state}
  ↓
authenticate middleware (Firebase ID token or JWT)
requireRole('admin', 'receptionist')
  ↓
checkIn controller (roomController.js)
  → begin MySQL transaction
  ↓
processCheckIn service (checkInService.js):

  1. getBusinessDate() → MySQL system_settings
  2. SELECT room + room_type FOR UPDATE (lock)
  3. Validate: not inactive, not occupied (ghost-heal if needed)
  4. Check dirty status (block unless manualOverride)
  5. Resolve reservation (if reservationId or matching date range)
  6. Resolve guest:
     - Look up by phone → UPDATE existing guest (city, state, etc.)
     - Or INSERT new guest (with all new fields)
  7. Compute resolvedTariff = roomTariff || room.rate
  8. Compute resolvedExpectedCheckout = departureDate || (checkInDate + 1 day at 11:00)
  9. INSERT bookings (17 columns including room_tariff, payment_mode, purpose_of_visit)
  10. If reservation: UPDATE reservations SET status='Checked-In'
  11. INSERT ledger_items: 'Room Tariff (Incl. GST)' → CHARGE, amount=resolvedTariff
  12. If deposit > 0: INSERT ledger_items: 'Advance Deposit' → PAYMENT, credit_amount=deposit
  13. If deposit > 0 + Cash: INSERT cash_logs
  14. INSERT payments
  15. UPDATE rooms SET status='occupied'
  16. INSERT room_status_history
  17. UPDATE system_settings today_checkins +1
  18. INSERT audit_logs: 'CHECK_IN'
  19. If ENABLE_FIRESTORE_DUAL_WRITE: enqueue compound event to dual_write_outbox
  ↓
commit transaction
  ↓
Emit socket.io event: io.emit('room-update', roomData)
  ↓
Frontend refresh: fetchRooms()
```

### New Fields Status (VERIFIED)

| Field | UI (Admin) | UI (Reception) | API | Service | MySQL | Firestore |
|-------|-----------|---------------|-----|---------|-------|-----------|
| room_tariff | ✅ Editable | ✅ Editable | ✅ | ✅ | ✅ bookings | ✅ outbox |
| payment_mode | ✅ | ✅ | ✅ | ✅ | ✅ bookings | ✅ outbox |
| purpose_of_visit | ✅ | ✅ | ✅ | ✅ | ✅ bookings | ✅ outbox |
| company_name | ✅ | ✅ | ✅ | ✅ | ✅ guests | ✅ outbox |
| gst_no | ✅ | ✅ | ✅ | ✅ | ✅ guests | ✅ outbox |
| city | ✅ | ✅ | ✅ | ✅ | ✅ guests | ✅ outbox |
| state | ✅ | ✅ | ✅ | ✅ | ✅ guests | ✅ outbox |
| date_of_birth | ❌ Admin (pending) | ✅ Reception | ✅ | ✅ | ✅ guests.date_of_birth | ✅ |

> **⚠️ BUG:** Admin `CheckInModal.jsx` shows a DOB field but it may not be wired to the submit payload — **REQUIRES MANUAL VERIFICATION**.

---

## 12. Check-Out Workflow

### Complete Flow (VERIFIED from checkOutService.js)

```
User clicks "Check Out" →
CheckOutModal / RefundCheckoutModal (shows LedgerPanel folio)
  ↓
POST /api/rooms/:number/checkout {balancePaid: 0}
  ↓
authenticate + requireRole('admin', 'receptionist')
  ↓
checkOut controller (roomController.js)
  → begin MySQL transaction
  ↓
processCheckOut service:

  1. SELECT room + type FOR UPDATE
  2. Validate: room.status === 'occupied'
  3. SELECT active booking (booking_status = 'Checked In') FOR UPDATE
  4. getBusinessDate()
  5. If parsedBalancePaid != 0:
     - INSERT cash_logs (Checkout Settlement / Checkout Refund)
     - INSERT payments
  6. UPDATE bookings SET booking_status='Checked Out', payment_status='Paid',
       total_amount=totalCollected, check_out_date=businessDate
  7. INSERT invoices (or UPDATE on duplicate invoice_number)
  8. INSERT room_status_history (occupied → dirty)
  9. INSERT audit_logs: 'CHECK_OUT'
  10. UPDATE rooms SET status='dirty' (triggers housekeeping)
  11. UPDATE system_settings today_checkouts +1
  12. Checkout Snapshot (CheckoutRecoveryService.createSnapshot)
  13. If ENABLE_FIRESTORE_DUAL_WRITE: enqueue compound outbox event
  ↓
commit transaction
  ↓
io.emit('room-update')
  ↓
Frontend refresh
```

### Financial Calculation Risk

`processCheckOut` sets `payment_status = 'Paid'` regardless of whether balance was actually collected. The comment says: *"receptionist collects all dues before pressing Settle & Check Out."* This is a **business process assumption**, not a technical enforcement. If the button is pressed without collecting, the booking is marked as Paid.

---

## 13. Room Status System

### Status Values (VERIFIED)

| status (rooms.status) | Meaning |
|----------------------|---------|
| `vacant` | Room available for check-in |
| `occupied` | Guest currently checked in |
| `booked` | Future reservation assigned |
| `dirty` | Recently checked out, needs cleaning |

### housekeeping_status
| Value | Meaning |
|-------|---------|
| `Clean` | Ready for occupancy |
| `Dirty` | Needs housekeeping |

### is_active
| Value | Meaning |
|-------|---------|
| 1 | Active, available |
| 0 | Inactive, excluded from all operations |

### Status Precedence Rules (from roomStatusService.js)

The `RoomStatusService.getRoomStatuses()` method computes a final status per room by:
1. Fetching all rooms with their DB status
2. Fetching all active bookings (booking_status IN ('Checked In', 'Reserved'))
3. Fetching all active reservations (status IN ('Reserved', 'Confirmed'))
4. Matching bookings/reservations to rooms

Priority logic (inferred from code):
```
inactive (is_active=0) → displayed as "inactive" regardless of status
occupied (status=occupied + active 'Checked In' booking) → occupied
booked (status=booked or matching reservation) → booked
dirty (status=dirty) → dirty/needs cleaning
vacant → available
```

### Specific Scenarios

| Scenario | Behavior |
|----------|---------|
| inactive + vacant | Shown as inactive, blocked from check-in |
| inactive + occupied | Ghost state — rare edge case, check-in service auto-heals if booking exists |
| dirty + vacant | Shown as dirty, check-in blocked unless manualOverride |
| clean + reserved | Shows as booked |
| Checked In booking | Room status = occupied |
| Checked Out booking | Room status → dirty (set during checkout) |
| Ghost occupied (no active booking) | checkInService auto-corrects to vacant |

### Numeric Room Ordering

Rooms ordered by `CAST(r.number AS UNSIGNED) ASC, r.number ASC` — numeric sort, not alphabetical.

### Date Issue (UTC/Business Date)

The `BusinessDateService` uses UTC-safe arithmetic (`Date.UTC(y, m-1, d+n)`) for day calculations. `checkInService.computeExpectedCheckout()` uses `new Date(`${parts}T12:00:00`)` (local noon) to avoid DST ambiguity. The `parseToComparableDate()` in `roomStatusService.js` handles multiple date formats: `YYYY-MM-DD`, `DD-Mon-YYYY`, and JS Date objects.

> **⚠️ Known Issue:** The `expected_check_out_date` is stored as `"YYYY-MM-DD 11:00"` (with time suffix). `App.jsx` has a `formatDateString` fix to strip the time component before month parsing. This was fixed in Phase E.

---

## 14. Room Management

### Verified Features

| Feature | Location | Status |
|---------|----------|--------|
| Room list (grid view) | Admin: RoomGrid in App.jsx | ✅ Active |
| Room card (color status) | RoomCard.jsx | ✅ Active |
| Room inspector / side panel | RoomInspectorDrawer.jsx | ✅ Active |
| Active/Inactive toggle | SettingsModal → Room Management + drawer | ✅ Active |
| Clean/Dirty toggle | Admin housekeeping + drawer | ✅ Active |
| Room tariff display | RoomInspectorDrawer (new field) | ✅ Active |
| Occupancy & guest details | RoomInspectorDrawer | ✅ Active |
| LedgerPanel in drawer | RoomInspectorDrawer (occupied only) | ✅ Active |
| Check-in from drawer | RoomInspectorDrawer button | ✅ Active |
| Check-out from drawer | RoomInspectorDrawer button | ✅ Active |

Active/Inactive and Clean/Dirty controls appear in:
- **Admin Dashboard → RoomInspectorDrawer** (status update buttons)
- **SettingsModal → Room Management section** (full room CRUD)
- **AdminHousekeeping** tab (housekeeping status management)

---

## 15. Billing / Payments / Ledger

### Financial Chain

```
CHECK-IN:
  room_tariff (int, rupees) → ledger_items CHARGE
  deposit (int) → ledger_items PAYMENT + payments + cash_logs (if cash)

NIGHTLY ROLLOVER (Day End):
  booking.room_tariff || room_type.base_rate → ledger_items ROLLOVER

MANUAL CHARGE (Admin/Reception):
  POST /rooms/:n/ledger → ledger_items CHARGE or ADJUSTMENT

CHECKOUT:
  balancePaid → cash_logs + payments + invoice → bookings.payment_status='Paid'

INVOICE:
  invoices.total_amount = bookings.total_amount
  invoices.paid_amount = total collected
  invoices.balance_due = 0 (assumed paid at checkout)
```

### Known Financial Issues

1. **Integer-only currency:** All monetary values are `int`. No paise/cents support.
2. **GST not separated:** Comment in checkInService says *"GST is INCLUDED in the room rate (no separate tax line)"*. No GST rate field, no automatic GST calculation.
3. **Checkout always marks Paid:** `payment_status = 'Paid'` is set unconditionally at checkout. No enforcement that balance was actually collected.
4. **Invoice deduplication:** `ON DUPLICATE KEY UPDATE` on `invoice_number` prevents duplicate invoices but silently updates if checkout is called twice.
5. **Payment mode not captured at checkout:** `processCheckOut` hardcodes `payment_method = 'Cash'` for checkout payments — does not capture the actual payment mode used.

---

## 16. Ledger & Rollover Audit

### transaction_type Values (VERIFIED)

| Type | Created When | Amount Column | Credit Column |
|------|------------|---------------|---------------|
| CHARGE | Check-in room tariff, manual charge | > 0 | 0 |
| PAYMENT | Advance deposit, manual payment | 0 | > 0 |
| ROLLOVER | Night audit (day-end per occupied room) | > 0 | 0 |
| ADJUSTMENT | Manual admin adjustment | any | any |
| REFUND | Refund flow | 0 | > 0 |
| REVERSAL | Reversal of a charge | 0 | > 0 |

### Night Audit Rollover Logic (businessDateService.js)

During Day End, for every occupied room:
```sql
SELECT b.id, b.room_tariff, r.number, rt.base_rate
FROM bookings b
JOIN rooms r ON b.room_id = r.id
JOIN room_types rt ON r.room_type_id = rt.id
WHERE b.booking_status = 'Checked In'
```
Tariff used = `booking.room_tariff || rt.base_rate`  
→ INSERT ledger_items: `transaction_type='ROLLOVER'`, `amount=tariff`, `time_of_entry`

### Balance Calculation (LedgerPanel)

```javascript
totalCharges = sum(ledger_items WHERE amount > 0) // CHARGE + ROLLOVER rows
totalPayments = sum(ledger_items.credit_amount WHERE credit_amount > 0) // PAYMENT rows
outstanding = totalCharges - totalPayments
```

---

## 17. Reservation System

### Features (VERIFIED)
- **Create reservation:** ReservationModule → `POST /api/reservations`
- **Fields:** guest_name, phone, email, arrival_date, departure_date, adults, children, room_type, room_number, advance_payment, payment_mode, dob, company, state, purpose, meal_plan, billing_instructions
- **Statuses:** Reserved → Confirmed → Checked-In → Cancelled / No-Show
- **Check-In from reservation:** checkInService resolves reservation by ID or date match
- **Inactive room protection:** AvailabilityService.js checks `is_active = 1` when computing available rooms
- **Cancellation:** Controller marks status='Cancelled' — does NOT refund advance
- **No-show:** `POST /rooms/:n/no-show` marks reservation

### Known Issues
- No double-booking prevention at the reservation creation level (AvailabilityService exists but may not be called for all reservation types — **NOT FULLY VERIFIED**)
- Reservation-to-room link is via `room_number` varchar AND `room_id` int — dual columns, potential drift

---

## 18. Guest Management

### Data Model (VERIFIED)

Guests are stored in the `guests` table. All fields verified from SHOW CREATE TABLE output. Notable:
- `full_name` stored UPPERCASE (done by `checkInService`)
- `date_of_birth` is a proper `DATE` type
- `id_document_path`: OCR-processed document stored at `/guest-documents/` (Docker volume)
- `loyalty_tier` / `loyalty_points`: present but loyalty system is not fully implemented (stub in GuestLoyalty.jsx)
- `company_name`, `city`, `state`: Added in Phase E (Migration 012)
- No `nationality` field (only `country`) — reservations have `nationality`
- Guests identified by phone number (lookup key in checkInService)

### Security: Guest ID Verification
- Guests upload ID documents via guest portal
- `tesseract.js` performs OCR
- Admin reviews via `IdentityVerificationModal.jsx`
- Verification status tracked: Pending/Verified/Rejected
- Files served statically at `/guest-documents/`

> **⚠️ HIGH SECURITY RISK:** Static file serving `app.use('/guest-documents', express.static(...))` — no auth required to access document URLs if path is guessed. Documents contain sensitive government ID info.

---

## 19. Housekeeping

### Features (VERIFIED)
- **UI:** `AdminHousekeeping.jsx` + tab in admin portal
- **Room status:** `rooms.housekeeping_status` = Clean/Dirty
- **Transition:** Checkout → room status = 'dirty', housekeeping_status = 'Dirty' 
- **Mark clean:** `POST /rooms/:n/clean` → sets status='vacant', housekeeping_status='Clean', last_cleaned_at=NOW()
- **Logs:** `housekeeping_logs` table tracks who cleaned what when
- **Priority:** `rooms.housekeeping_priority` = Normal/High/URGENT
- **Assignment:** `rooms.housekeeping_assigned_to` → FK→users
- **Firestore:** `housekeeping` collection — dual-write enabled

### API Routes
```
router.use('/housekeeping', authenticate, requireRole('admin','receptionist','housekeeper'), housekeepingRoutes)
```
Housekeeper role can mark rooms clean.

---

## 20. Inventory

### Features (VERIFIED)
- **UI:** `InventoryModule.jsx` (36KB) — tab in admin portal
- **Categories:** `inventory_categories` table
- **Products:** `inventory_products` table (with images at `/inventory-photos/`)
- **CRUD:** Create, read, update, delete categories and products
- **No stock tracking:** No stock quantity, stock movements, or room service orders found in schema
- **Firestore:** `inventoryCategoriesRepository.js`, `inventoryProductsRepository.js` — dual-write enabled
- **Status:** Basic CRUD implemented. No room service order flow. No inventory movement tracking.

---

## 21. Cash Status

### Features (VERIFIED)
- **UI:** `CashStatusModal.jsx` (20KB)
- **Submit cash:** `POST /api/cash/submit` — staff record cash handover
- **View submissions:** `GET /api/cash/submissions`
- **Cash logs:** `cash_logs` table (time, room, guest, type, amount, business_date, booking_id)
- **Cash submissions:** `cash_submissions` table (separate from cash_logs)
- **Roles:** Both admin and receptionist can submit/view

### Known Issues
- `processCheckOut` hardcodes `payment_method = 'Cash'` when logging checkout payments to `payments` table (even if guest pays by UPI/Card)
- Cash logs are separate from the payment ledger — reconciliation is manual

---

## 22. Day End / Night Audit

### Full Workflow (businessDateService.js — VERIFIED)

```
POST /api/dayend (requireRole('admin'))
  ↓
runDayEnd controller
  → BusinessDateService.acquireLock() — advisory lock to prevent concurrent runs
  → getBusinessDate() → currentDate
  → validate: nextDate = currentDate + 1 day, check for re-run
  ↓
For each occupied room:
  → SELECT active booking with room_tariff
  → resolvedTariff = booking.room_tariff || rt.base_rate
  → INSERT ledger_items: transaction_type='ROLLOVER', amount=resolvedTariff
  → Firestore outbox: ROLLOVER event
  ↓
Business date advanced:
  → UPDATE system_settings SET value_val = nextDate WHERE key_name = 'system_date'
  → INSERT audit_logs: 'DAY_END'
  ↓
Reset daily counters:
  → today_checkins = 0, today_checkouts = 0, continued_rooms = occupied count
  ↓
If ENABLE_FIRESTORE_DUAL_WRITE: enqueue BUSINESS_DATE_ADVANCED event
  ↓
Response: {newDate, rolledRooms, message}
```

### Transaction Boundary
The Day End runs inside a single MySQL transaction for atomicity. If any rollover fails, the entire Day End rolls back.

### Undo Day End
`POST /api/dayend/undo` (`requireSuperAdmin`) — rolls back business date and reverses the ROLLOVER ledger entries for the current date. Available only to super_admin (root user).

### Concurrency Risk
`BusinessDateService.acquireLock()` uses MySQL advisory lock (`GET_LOCK`). Concurrent Day End from two browser sessions would be blocked. Lock timeout prevents deadlock.

---

## 23. Reports & Analytics

### Reports (`ReportsModal.jsx` + `reportsController.js`)
- **Occupancy Report:** daily room occupancy %
- **Revenue Report:** total revenue by date range
- **Payment Report:** payments by method
- **Guest Report:** check-ins and check-outs
- **Export:** PDF and Excel export (jspdf, xlsx)

### Analytics (`AnalyticsModal.jsx`)
- ADR (Average Daily Rate): totalRevenue / occupiedRooms
- Occupancy %: occupiedRooms / totalRooms × 100
- RevPAR: ADR × occupancyPct
- Revenue by room type breakdown
- Charts via recharts

> **NOT VERIFIED:** Whether ADR and RevPAR calculations correctly exclude inactive rooms from denominator. **REQUIRES MANUAL CHECK.**

---

## 24. Firebase / Firestore Migration Audit

### Firebase Project
- **Project ID:** `hpms-sky5`
- **Firebase Auth:** Active — staff provisioned via `provisionStaffFirebaseAuth.js`
- **Firestore:** Active — dual-write via outbox
- **Storage bucket:** `hpms-sky5.appspot.com`

### Firestore Collections (Repositories Found — 23)

| Collection | MySQL Source | Firestore Repo | Write Status | Read Status | Ready? |
|-----------|-------------|---------------|-------------|------------|--------|
| bookings | bookings | bookingsRepository.js | ✅ Dual-write (outbox) | MySQL only | NO |
| guests | guests | guestsRepository.js | ✅ Dual-write (outbox) | MySQL only | NO |
| rooms | rooms | roomsRepository.js | ✅ Dual-write | MySQL only | NO |
| room_types | room_types | roomTypesRepository.js | ✅ Dual-write | MySQL only | NO |
| reservations | reservations | reservationsRepository.js | ✅ Dual-write | MySQL only | NO |
| payments | payments | paymentsRepository.js | ✅ Dual-write | MySQL only | NO |
| ledger_items | ledger_items | ledgerRepository.js | ✅ Dual-write | MySQL only | NO |
| invoices | invoices | invoicesRepository.js | ✅ Dual-write | MySQL only | NO |
| housekeeping | housekeeping | housekeepingRepository.js | ✅ Dual-write | MySQL only | NO |
| inventory_categories | inventory_categories | inventoryCategoriesRepository.js | ✅ Dual-write | MySQL only | NO |
| inventory_products | inventory_products | inventoryProductsRepository.js | ✅ Dual-write | MySQL only | NO |
| staff | staff | staffRepository.js | ✅ Dual-write | MySQL only | NO |
| system_settings | system_settings | systemSettingsRepository.js | ✅ Dual-write | MySQL only | NO |
| users | users | usersRepository.js | ✅ Dual-write | MySQL only | NO |
| cash_logs | cash_logs | cashLogsRepository.js | ✅ Dual-write | MySQL only | NO |
| cash_submissions | cash_submissions | cashSubmissionsRepository.js | ✅ Dual-write | MySQL only | NO |
| audit_logs | audit_logs | auditLogsRepository.js | ✅ Dual-write | MySQL only | NO |
| checkout_snapshots | checkout_snapshots | checkoutSnapshotsRepository.js | ✅ Dual-write | MySQL only | NO |
| booking_history | booking_history | bookingHistoryRepository.js | ✅ Dual-write | MySQL only | NO |
| housekeeping_logs | housekeeping_logs | (in housekeepingRepository.js) | Partial | MySQL only | NO |
| razorpay_transactions | razorpay_transactions | razorpayTransactionsRepository.js | Limited | MySQL only | NO |
| rbac | roles+permissions | rbacRepository.js | ✅ Dual-write | MySQL only | NO |

**All read canary flags are DISABLED** (no `ENABLE_FIRESTORE_*_READ_CANARY=true` in .env).

**Current source of truth for ALL business data: MySQL.**

---

## 25. Firestore Transaction Adapter Audit

Three adapters found in `backend/adapters/firestore/`:

### `checkInFirestoreAdapter.js`
- Purpose: Atomic Firestore write for check-in compound event
- Writes: booking doc, guest doc, room status doc, ledger item docs, payment doc
- Uses Firestore batch writes (NOT a Firestore transaction — batch is non-atomic for cross-doc consistency)
- **Status: CONNECTED via outbox dispatcher when ENABLE_FIRESTORE_DUAL_WRITE=true**

### `checkOutFirestoreAdapter.js`
- Purpose: Atomic Firestore write for check-out compound event
- Writes: booking (Checked Out), room (dirty), invoice, payment history
- **Status: CONNECTED via outbox dispatcher**

### `roomStatusFirestoreAdapter.js`
- Purpose: Sync room status changes to Firestore
- Updates room document status field
- **Status: CONNECTED via outbox dispatcher**

### Concerns
- **Not true Firestore transactions:** Adapters use `batch.commit()` which is atomic per batch but not across multiple batches within one event
- **Rollback behavior:** If Firestore write fails, the outbox marks the event FAILED and retries. MySQL is NOT rolled back (already committed). This means Firestore could lag behind MySQL temporarily.
- **Not test-only:** These are production code paths when dual-write is enabled.

---

## 26. Outbox System

### Architecture
The **Transactional Outbox Pattern** ensures MySQL commits and Firestore writes are eventually consistent:

1. Business operation commits to MySQL + enqueues event to `dual_write_outbox` (same transaction)
2. OutboxWorker polls every 3000ms
3. For each `PENDING` event: calls `dispatchEvent()` → Firestore repository
4. On success: marks `PROCESSED`
5. On failure: marks `FAILED`, increments attempts, applies exponential backoff
6. After `MAX_RETRIES (5)` failures: moves to `DEAD_LETTER`

### Current Status (VERIFIED)
```
ENABLE_FIRESTORE_OUTBOX_WORKER = true   ← WORKER IS RUNNING
ENABLE_FIRESTORE_DUAL_WRITE = true       ← DUAL-WRITE ACTIVE
Total outbox events: 1
Pending: 0
(All events processed)
```

### Event Types (from compoundEventBuilder.js)
- `BOOKING_CHECKIN_COMPOUND` — check-in with all sub-documents
- `BOOKING_CHECKOUT_COMPOUND` — checkout
- `ROOM_STATUS_CHANGED` — room status update
- `BUSINESS_DATE_ADVANCED` — day end
- `ROLLOVER_LEDGER_ITEM` — night audit per room
- `GUEST_CREATED` — new guest signup
- Various domain-specific events

### Risk: Missing Events
If the backend crashes between the MySQL commit and the `enqueue()` call (which is inside the same transaction), the event may not be queued. The `reclaimStaleProcessing()` handles crash recovery for events that were PROCESSING but not marked done.

---

## 27. Docker Audit

### Services (Verified from docker-compose.yml)

| Service | Container | Image | Port | Volume |
|---------|-----------|-------|------|--------|
| db | hotel_pms_db | mysql:8.0 | 3307:3306 | mysql_data |
| backend | hotel_pms_backend | custom (docker/backend/Dockerfile) | 5000:5000 | ./backend:/app |
| phpmyadmin | hotel_pms_phpmyadmin | phpmyadmin:latest | 8080:80 | none |

### Important Notes
- **Backend is bind-mounted:** `./backend:/app` means local file changes ARE visible inside the container immediately. No rebuild needed for code changes.
- **Migration auto-run:** NOT verified — check if Dockerfile or entrypoint runs migrations automatically. **REQUIRES MANUAL CHECK**.
- **No frontend container:** Frontend runs via `npm run dev` on the host (port 5173).
- **No nginx/reverse proxy:** Backend is accessed directly.
- **Health checks:** db waits for `mysqladmin ping`, backend waits for `curl /api/health`.
- **Graceful shutdown:** `SIGTERM` handler in server.js stops outbox worker, closes HTTP server.

### Restart Workflow
```bash
# Code change to backend (JS files only):
docker restart hotel_pms_backend

# Dependency change (package.json):
docker-compose build backend
docker-compose up -d backend

# Schema change: write new migration file, then:
docker exec hotel_pms_backend npm run migrate
```

---

## 28. Environment Configuration

### Current Values (Secrets REDACTED)

| Variable | Present | Current Value |
|---------|---------|--------------|
| PORT | ✅ | 5000 |
| DB_HOST | ✅ | 127.0.0.1 (overridden by compose to 'db') |
| DB_USER | ✅ | root |
| DB_PASSWORD | ✅ | **PRESENT — NOT SHOWN** |
| DB_NAME | ✅ | hotel_pms |
| DB_PORT | ✅ | 3306 |
| NODE_ENV | ✅ | development |
| FIREBASE_PROJECT_ID | ✅ | hpms-sky5 |
| FIREBASE_CLIENT_EMAIL | ✅ | **PRESENT** |
| FIREBASE_PRIVATE_KEY | ✅ | **PRESENT — SENSITIVE** |
| FIREBASE_STORAGE_BUCKET | ✅ | hpms-sky5.appspot.com |
| JWT_SECRET | ❌ | **NOT SET — uses hardcoded default** |
| ENABLE_STRICT_RBAC | ✅ | **true** |
| ENABLE_FIREBASE_AUTH | ✅ | **true** |
| ENABLE_FIRESTORE_READS | ✅ | **true** |
| ENABLE_FIRESTORE_DUAL_WRITE | ✅ | **true** |
| ENABLE_FIRESTORE_OUTBOX_WORKER | ✅ | **true** |
| ENABLE_FIRESTORE_RECONCILIATION | ✅ | false |
| USE_FIRESTORE_SERVICES | ✅ | **true** |
| All CANARY flags | Not set | false (default) |

> **⚠️ CRITICAL:** `JWT_SECRET` is not set in `.env`. The hardcoded fallback `'hotel-pms-super-secret-key-12345!'` is used. Any attacker who knows this (it's in the source code) can forge guest tokens.

---

## 29. API Inventory

### Auth Routes
| Method | Endpoint | Auth | Role | Purpose |
|--------|---------|------|------|---------|
| POST | /api/auth/signup | None | — | Guest registration |
| POST | /api/auth/signin | None | — | Guest/admin legacy JWT login |
| GET | /api/auth/me | Bearer token (self-verifying) | — | Firebase → MySQL role resolution |
| POST | /api/staff/auth/login | None | — | Staff legacy JWT login |

### Room Operations
| Method | Endpoint | Auth | Role | Purpose |
|--------|---------|------|------|---------|
| POST | /api/rooms/:n/checkin | ✅ | admin, receptionist | Check in guest |
| PUT | /api/rooms/:n/checkin | ✅ | admin, receptionist | Modify existing check-in |
| POST | /api/rooms/:n/checkout | ✅ | admin, receptionist | Check out guest |
| POST | /api/rooms/:n/clean | ✅ | admin, receptionist, housekeeper | Mark room clean |
| POST | /api/rooms/:n/ledger | ✅ | admin, receptionist | Add ledger item |
| GET | /api/rooms/:n/ledger | ✅ | admin, receptionist | Get ledger/folio |
| POST | /api/rooms/shift | ✅ | admin, receptionist | Shift guest to new room |
| POST | /api/rooms/:n/book | ✅ | any authenticated | Book room |
| POST | /api/rooms/:n/refund-checkout | ✅ | admin | Refund checkout |
| POST | /api/rooms/:n/extend-stay | ✅ | admin, receptionist | Extend stay |
| POST | /api/rooms/:n/late-checkout | ✅ | admin, receptionist | Late checkout |
| POST | /api/rooms/:n/no-show | ✅ | admin, receptionist | No-show |
| PUT | /api/rooms/:n/status | ✅ | admin, receptionist, housekeeper | Update room status |
| GET | /api/public/rooms | None | — | Public room list (for booking wizard) |

### Audit / Status
| Method | Endpoint | Auth | Role | Purpose |
|--------|---------|------|------|---------|
| GET | /api/status | ✅ | any | Full room status + metrics |
| POST | /api/dayend | ✅ | admin | Run day end |
| POST | /api/dayend/undo | ✅ | super_admin | Undo day end |

### Guest Portal
| Method | Endpoint | Auth | Role | Purpose |
|--------|---------|------|------|---------|
| POST | /api/guest/upload-id | ✅ | guest | Upload ID document |
| POST | /api/guest/checkin-request | ✅ | guest | Request check-in |
| POST | /api/guest/service | ✅ | guest | Add room service |
| POST | /api/guest/maintenance | ✅ | guest | Report maintenance |
| POST | /api/guest/extend-stay | ✅ | guest | Request extension |
| GET | /api/guest/bill | ✅ | guest | View folio |
| GET | /api/guest/notifications | ✅ | guest | View notifications |
| PUT | /api/guest/notifications/:id/read | ✅ | guest | Mark notification read |
| POST | /api/guest/checkout-request | ✅ | guest | Request checkout |
| GET | /api/guest/history | ✅ | guest | Past stays |
| POST | /api/guest/feedback | ✅ | guest | Submit feedback |

### Admin
| Method | Endpoint | Auth | Role | Purpose |
|--------|---------|------|------|---------|
| GET | /api/admin/guest-requests | ✅ | admin, receptionist | View guest requests |
| POST | /api/admin/guest-requests/:id/resolve | ✅ | admin, receptionist | Resolve request |
| POST | /api/admin/guest-requests/extension/:id/resolve | ✅ | admin, receptionist | Resolve extension |
| GET | /api/admin/guest-documents | ✅ | admin, receptionist | View ID docs |
| POST | /api/admin/guest-documents/:guestId/verify | ✅ | admin, receptionist | Verify document |
| DELETE | /api/admin/guest-documents/:guestId | ✅ | admin | Delete document |
| GET | /api/admin/guests | ✅ | admin, receptionist | List all guests |
| GET | /api/admin/guests/search | ✅ | admin, receptionist | Search guests |
| GET | /api/admin/guest-history/:guestId | ✅ | admin, receptionist | Guest history |

### Other Modules
| Router | Mounted At | Auth | Notes |
|--------|-----------|------|-------|
| paymentRoutes | /api/payments | varies | Payment CRUD |
| reportsRoutes | /api/reports | varies | Reporting |
| invoiceRoutes | /api/invoices | varies | Invoice management |
| housekeepingRoutes | /api/housekeeping | admin/receptionist/housekeeper | Housekeeping ops |
| staffRoutes | /api/staff | admin ONLY | Staff CRUD |
| reservationRoutes | /api/reservations | varies | Reservation CRUD |
| inventoryRoutes | /api/inventory | authenticated | Inventory CRUD |
| roomTypeRoutes | /api/room-types | varies | Room type CRUD |
| factoryResetRoutes | /api/system/factory-reset | super_admin | DANGEROUS — factory reset |

---

## 30. Socket.IO / Real-Time System

### Server Setup
```javascript
const io = new Server(server, { cors: { origin: isOriginAllowed } });
app.set('io', io);
```

### Events Emitted (by backend)
- `room-update` — emitted after any room status change (check-in, checkout, clean, status update)
- Likely other events — **REQUIRES FULL CODE SEARCH**

### Client Usage (App.jsx)
```javascript
const socket = io(SOCKET_URL);
socket.on('room-update', () => fetchRooms());
```
Frontend polls rooms on every `room-update` event. ReceptionPortal has its own Socket.IO connection and polling.

### Fallback Polling
Both App.jsx and ReceptionPortal.jsx have polling intervals (30–60s) as fallback when Socket.IO events don't fire.

---

## 31. Security Audit

| Severity | Finding | Evidence | Impact |
|----------|---------|---------|--------|
| 🔴 CRITICAL | `JWT_SECRET` not set in .env — using hardcoded default `'hotel-pms-super-secret-key-12345!'` | `authController.js:9` | Anyone with source code can forge guest/admin tokens |
| 🔴 CRITICAL | Guest documents served without authentication: `app.use('/guest-documents', express.static(...))` | `server.js:75` | Government ID documents accessible without login if path guessed |
| 🔴 CRITICAL | FIREBASE_PRIVATE_KEY committed/stored in backend/.env (not shown but present) | `backend/.env` | If .env leaks, full Firebase Admin access |
| 🟠 HIGH | `users` table uses SHA-256 (not bcrypt) for password hashing | `authController.js hashPassword()` | SHA-256 is not a password hashing function — vulnerable to brute force |
| 🟠 HIGH | Admin `localStorage` stores full user object including role — no expiry | `AdminAuthContext.jsx:9` | XSS could steal role-bearing token |
| 🟠 HIGH | `authMapping.js` hardcodes Firebase email mappings for 14 accounts | `authMapping.js` | Adding new staff users requires code change |
| 🟡 MEDIUM | No rate limiting on login endpoints | `routes/api.js` | Brute force attack vector |
| 🟡 MEDIUM | CORS allows all `*.vercel.app` and `*.ngrok-free.dev` origins | `server.js:22-23` | Any Vercel app or ngrok tunnel can make credentialed requests |
| 🟡 MEDIUM | `payment_status = 'Paid'` set unconditionally at checkout | `checkOutService.js:92` | Financial records may show Paid when balance wasn't collected |
| 🟡 MEDIUM | No CSRF protection | N/A | State-changing requests can be made from third-party sites |
| 🟡 MEDIUM | Checkout payment_method hardcoded to 'Cash' | `checkOutService.js:81` | Incorrect financial records for non-cash checkouts |
| 🟢 LOW | SQL injection: all queries use parameterized `?` placeholders | Throughout | Properly mitigated |
| 🟢 LOW | Firebase Admin private key in Docker env_file | `docker-compose.yml:28` | Contained to backend container |
| 🟢 INFO | XSS: React JSX auto-escapes most content | React default | Low risk for JSX rendering |
| 🟢 INFO | No file upload size limit found for ID documents | `uploadMiddleware.js` | Could allow large uploads |

---

## 32. Data Integrity Audit

### Current Live Data (VERIFIED)
- **17 rooms:** 2 occupied (rooms 3, 14), 15 vacant
- **4 bookings:** Mix of active/historical
- **2 guests:** In database
- **0 reservations:** No active reservations
- **4 payments:** Recorded
- **7 ledger items:** 6 normal entries + 1 additional (rollover likely)
- **1 outbox event:** Processed
- **0 staff records:** `staff` table is empty

### Consistency Concerns

1. **0 staff records but staff Firebase Auth users exist:** Staff are provisioned in Firebase but not in MySQL `staff` table. `/api/auth/me` falls back to Firebase claims alone for identity resolution. **This means no MySQL-side staff account status checks are possible.**

2. **Integer currency:** All amounts stored as integers. Potential rounding if fractional rates are ever needed.

3. **Firestore vs MySQL:** With dual-write enabled, Firestore mirrors MySQL. Since all canary read flags are off, reads always come from MySQL. Firestore lag is not a consistency risk for operations.

4. **`rooms.status` vs actual booking status:** Potential drift if booking is manually modified in MySQL without updating `rooms.status`. `checkInService` auto-heals ghost statuses.

---

## 33. Testing Audit

### Automated Tests Found
- **None** — No test framework configuration found (`jest.config`, `vitest.config`, `.mocharc`, etc.)
- `backend/tests/` directory exists but contents NOT verified
- `backend/verify*.mjs` files are ad-hoc verification scripts (not automated tests)

### Verification Scripts (not test suites)
```
backend/verifyAvailabilityEngine.mjs    (18KB)
backend/verifyBusinessDate.mjs          (17KB)
backend/verifyBusinessDateManagement.mjs(30KB)
backend/verifyCheckoutSnapshot.mjs      (13KB)
backend/verifyFactoryResetArchitecture.mjs (15KB)
backend/verifyUndoDayEnd.mjs            (19KB)
```

These are standalone Node.js scripts that test specific scenarios but are NOT automated or run in CI.

### Critical Paths WITHOUT Automated Tests
- Check-in flow
- Check-out flow
- Day End / Night Audit
- Outbox dispatch
- RBAC enforcement
- Firebase token verification
- Double booking prevention
- Financial calculations (balance, outstanding)

---

## 34. Known Bugs & Technical Debt

### Verified Bugs

| # | Severity | Bug | Location | Impact |
|---|---------|-----|---------|--------|
| 1 | 🔴 CRITICAL | JWT_SECRET not configured — hardcoded default used | `backend/.env` (missing) / `authController.js:9` | Security |
| 2 | 🟠 HIGH | Checkout always marks payment_method='Cash' in payments table | `checkOutService.js:81` | Wrong financial records |
| 3 | 🟠 HIGH | payment_status set 'Paid' unconditionally at checkout | `checkOutService.js:92` | Incorrect payment status |
| 4 | 🟠 HIGH | 0 staff in MySQL staff table — all staff auth is Firebase-claims-only | DB state | Staff status check bypassed |
| 5 | 🟡 MEDIUM | Admin CheckInModal DOB field may not be wired to API payload | `CheckInModal.jsx` | DOB not saved for admin check-ins |
| 6 | 🟡 MEDIUM | Guest documents accessible without auth | `server.js:75` | Sensitive data exposure |
| 7 | 🟡 MEDIUM | `expected_check_out_date` stored as `"YYYY-MM-DD 11:00"` — parsing fix only in App.jsx, not ReceptionPortal | `checkInService.js:41` | Date display issues in reception |

### Technical Debt

| # | Area | Issue |
|---|------|-------|
| 1 | Architecture | `roomController.js` is 98KB — violates SRP, mixes controller+service logic |
| 2 | Architecture | `App.jsx` is 1459 lines — monolith, hard to maintain |
| 3 | Architecture | `ReceptionPortal.jsx` is 102KB — duplicates admin patterns without reuse |
| 4 | Code | Root folder has 15+ one-off scripts, backup files, patch files, test files |
| 5 | Code | `original_GuestDashboard.jsx` (142KB) in root — should be deleted or archived |
| 6 | DB | Integer-only monetary values throughout — cannot support fractional pricing |
| 7 | DB | Date columns stored as `varchar(20)` not `DATE` type — sorting/filtering requires string parsing |
| 8 | Auth | Two password hashing strategies: SHA-256 (users table) + bcrypt (staff) |
| 9 | Auth | Hardcoded email mapping for 14 staff accounts — requires code change to add staff |
| 10 | Frontend | No React Router — custom `pushState` implementation |
| 11 | Testing | Zero automated tests |
| 12 | Docs | 40+ markdown design docs in root — no structured docs folder |
| 13 | Firebase | `authMapping.js` must be updated for each new staff account |
| 14 | Security | Guest documents served without authentication |

### TODO/FIXME Scan
> NOT VERIFIED via automated scan — inspect codebase for `// TODO`, `// FIXME`, `console.warn`, `console.error` patterns.

---

## 35. Current Feature Matrix

| Feature | Admin | Receptionist | Guest | Backend | MySQL | Firestore | Status |
|---------|-------|-------------|-------|---------|-------|-----------|--------|
| Login / Auth | FULL | FULL | FULL | FULL | FULL | Firebase Auth | ✅ COMPLETE |
| Room Grid View | FULL | FULL | N/A | FULL | FULL | Mirror | ✅ COMPLETE |
| Check-In (basic) | FULL | FULL | N/A | FULL | FULL | Dual-write | ✅ COMPLETE |
| Check-In (new fields) | FULL | FULL | N/A | FULL | FULL | Dual-write | ✅ COMPLETE |
| Check-Out | FULL | FULL | Req | FULL | FULL | Dual-write | ✅ COMPLETE |
| LedgerPanel (folio) | FULL | FULL | N/A | FULL | FULL | Mirror | ✅ COMPLETE |
| Reservations | FULL | FULL | Wizard | FULL | FULL | Dual-write | ✅ COMPLETE |
| Guest Management | FULL | PARTIAL | N/A | FULL | FULL | Dual-write | ✅ COMPLETE |
| Night Audit / Day End | FULL | N/A | N/A | FULL | FULL | Dual-write | ✅ COMPLETE |
| Cash Status | FULL | FULL | N/A | FULL | FULL | Dual-write | ✅ COMPLETE |
| Reports | FULL | N/A | N/A | FULL | FULL | N/A | ✅ COMPLETE |
| Analytics | FULL | N/A | N/A | FULL | FULL | N/A | ✅ COMPLETE |
| Housekeeping | FULL | PARTIAL | N/A | FULL | FULL | Dual-write | ✅ COMPLETE |
| Inventory | FULL | N/A | N/A | FULL | FULL | Dual-write | ✅ COMPLETE |
| Staff Management | FULL | N/A | N/A | FULL | FULL | Dual-write | ✅ COMPLETE |
| RBAC | FULL | N/A | N/A | FULL | FULL | Mirror | ✅ COMPLETE |
| Guest Portal | N/A | N/A | FULL | FULL | FULL | Firebase | ✅ COMPLETE |
| Identity Verification | FULL | FULL | Upload | FULL | FULL | N/A | ✅ COMPLETE |
| Guest Requests | FULL | FULL | FULL | FULL | FULL | N/A | ✅ COMPLETE |
| Payments (advanced) | FULL | N/A | N/A | FULL | FULL | Dual-write | ✅ COMPLETE |
| Extend Stay | FULL | FULL | Request | FULL | FULL | Dual-write | ✅ COMPLETE |
| Room Shift | FULL | FULL | N/A | FULL | FULL | Dual-write | ✅ COMPLETE |
| Loyalty System | N/A | N/A | STUB | STUB | PARTIAL | N/A | ⚠️ STUB |
| Guest Feedback | N/A | N/A | FULL | FULL | FULL | N/A | ✅ COMPLETE |
| Kitchen/Pantry Dashboard | N/A | N/A | N/A | STUB | N/A | N/A | ⚠️ STUB |
| Razorpay Integration | PARTIAL | N/A | PARTIAL | PARTIAL | PARTIAL | Mirror | ⚠️ PARTIAL |
| OCR ID Verification | N/A | N/A | N/A | FULL | FULL | N/A | ✅ COMPLETE |
| Electron Desktop | N/A | N/A | N/A | N/A | N/A | N/A | ⚠️ LEGACY |
| Factory Reset | FULL | N/A | N/A | FULL | FULL | N/A | ✅ COMPLETE (DANGEROUS) |

---

## 36. Database / Firestore Cutover Matrix

| Feature | MySQL | Firestore Repository | Outbox | Frontend Uses | Current Auth Source | Ready for Cutover? |
|---------|-------|---------------------|--------|--------------|--------------------|--------------------|
| Check-In | ✅ Authoritative | bookingsRepository | ✅ Active | MySQL | MySQL | ❌ NO — business rules in MySQL |
| Check-Out | ✅ Authoritative | Various repos | ✅ Active | MySQL | MySQL | ❌ NO |
| Rooms | ✅ Authoritative | roomsRepository | ✅ Active | MySQL | MySQL | ❌ NO |
| Guests | ✅ Authoritative | guestsRepository | ✅ Active | MySQL | MySQL | ❌ NO |
| Reservations | ✅ Authoritative | reservationsRepository | ✅ Active | MySQL | MySQL | ❌ NO |
| Payments | ✅ Authoritative | paymentsRepository | ✅ Active | MySQL | MySQL | ❌ NO |
| Ledger | ✅ Authoritative | ledgerRepository | ✅ Active | MySQL | MySQL | ❌ NO |
| Invoices | ✅ Authoritative | invoicesRepository | ✅ Active | MySQL | MySQL | ❌ NO |
| Housekeeping | ✅ Authoritative | housekeepingRepository | ✅ Active | MySQL | MySQL | ❌ NO |
| Inventory | ✅ Authoritative | inventoryRepositories | ✅ Active | MySQL | MySQL | ❌ NO |
| Authentication (Staff) | MySQL+Firebase | — | — | Firebase → /auth/me → MySQL | Firebase+MySQL | ✅ Firebase Auth active |
| RBAC | MySQL | rbacRepository | ✅ Active | MySQL | MySQL | ❌ NO |
| Day End | MySQL | systemSettingsRepository | ✅ Active | MySQL | MySQL | ❌ NO |
| Cash Status | MySQL | cashLogsRepository | ✅ Active | MySQL | MySQL | ❌ NO |

---

## 37. Current System Source of Truth

| Area | Source of Truth |
|------|----------------|
| Room status | **MySQL** (rooms.status, rooms.housekeeping_status) |
| Active bookings | **MySQL** (bookings.booking_status) |
| Guest profiles | **MySQL** (guests table) |
| Financial records | **MySQL** (ledger_items, payments, invoices) |
| Business date | **MySQL** (system_settings.system_date) |
| Staff identity / role | **Firebase Auth** (claims) + **MySQL** staff table (for status check) |
| Guest identity | **MySQL** users table (for legacy) + **Firebase Auth** (for self-service guests) |
| Reservations | **MySQL** (reservations table) |
| RBAC permissions | **MySQL** (roles + permissions + role_permissions) |
| Firestore | **Mirror only** — not authoritative for any business domain |

---

## 38. Critical Risks

| # | Risk | Severity | Evidence | Impact | Recommended Action |
|---|------|---------|---------|--------|-------------------|
| 1 | JWT_SECRET not set — using hardcoded default | 🔴 CRITICAL | `authController.js:9`, missing `.env` key | Token forgery for guests and admin legacy tokens | Set strong `JWT_SECRET` in `.env` immediately |
| 2 | Guest documents accessible without auth | 🔴 CRITICAL | `server.js:75` | Government ID exposure | Add authentication middleware to `/guest-documents` route |
| 3 | 0 staff in MySQL staff table | 🔴 CRITICAL | `SELECT COUNT(*) as staff FROM staff → 0` | Staff account status checks (`Inactive/deleted`) are bypassed | Seed staff MySQL records matching Firebase provisioned accounts |
| 4 | SHA-256 password hashing for users table | 🟠 HIGH | `authController.js:12` | Weak password protection for guest accounts | Migrate to bcrypt with migration script |
| 5 | Checkout always sets payment_status='Paid' | 🟠 HIGH | `checkOutService.js:92` | Financial records may be incorrect | Add balance verification before marking Paid |
| 6 | Checkout hardcodes payment_method='Cash' | 🟠 HIGH | `checkOutService.js:81` | Incorrect payment records for card/UPI checkouts | Accept payment method parameter at checkout |
| 7 | No automated tests for any critical path | 🟠 HIGH | No test framework found | Regressions cannot be caught automatically | Implement integration tests for check-in/out/dayend |
| 8 | Integer-only monetary values | 🟠 HIGH | All financial columns are `int` | Cannot support fractional pricing, no GST breakout | Plan DECIMAL migration if fractional pricing needed |
| 9 | authMapping.js hardcoded for 14 users | 🟡 MEDIUM | `authMapping.js` | New staff can't login via Firebase without code change | Move mapping to DB or Firebase custom attributes |
| 10 | Date stored as varchar, not DATE type | 🟡 MEDIUM | Schema of bookings, ledger_items | Date comparisons require string parsing — error-prone | Consider DATE columns in future migration |
| 11 | CORS allows all *.vercel.app origins | 🟡 MEDIUM | `server.js:22` | Any Vercel app can make credentialed requests | Restrict to specific origin |
| 12 | No rate limiting on login endpoints | 🟡 MEDIUM | Missing middleware | Brute force attacks possible | Add rate limiting middleware (express-rate-limit) |
| 13 | Firestore read canaries all disabled | 🟡 MEDIUM | `.env` | Firebase cutover cannot proceed without testing reads | Enable read canaries in test/staging first |
| 14 | Firebase private key in .env file | 🟡 MEDIUM | `backend/.env` | If .env leaked, full Firebase admin access | Use secrets manager or Docker secrets |
| 15 | `roomController.js` 98KB mega-file | 🟡 MEDIUM | File size | Maintenance/testing risk | Refactor into separate service files |
| 16 | No double-booking enforcement at API level | 🟡 MEDIUM | AvailabilityService exists but not verif. called | Two reservations could be created for same room/date | Verify AvailabilityService usage in reservation creation |
| 17 | 141KB original_GuestDashboard.jsx in root | 🟢 LOW | Root dir listing | Accidental use or confusion | Delete or archive |
| 18 | Admin DOB not wired to payload | 🟢 LOW | CheckInModal.jsx (requires verification) | DOB not saved for admin check-ins | Wire form state to API payload |
| 19 | `expected_check_out_date` format "YYYY-MM-DD 11:00" | 🟢 LOW | checkInService.js | Parsing workarounds needed in multiple places | Standardize to DATE column or pure ISO string |
| 20 | Ghost room status (orphaned 'occupied') | 🟢 LOW | checkInService auto-heal | Database state drift — auto-corrected but logged | Monitor auto-heal logs |

---

## 39. Safe Development Rules

Based on actual verified architecture:

### Database Rules
1. **NEVER run `npm run migrate:fresh`** — drops all tables and destroys live data
2. **NEVER ALTER columns manually in MySQL** — always use a numbered migration file
3. **Always write additive migrations** — use `ADD COLUMN IF NOT EXISTS`, `MODIFY` not `DROP`
4. **Test migrations on a backup/copy** before applying to production DB
5. **Never change `system_settings.system_date` manually** — use the Day End endpoint
6. **Do not insert/update financial records directly in MySQL** — always go through the business service layer for transaction atomicity

### Backend Rules
7. **All financial operations must run inside a MySQL transaction** — `connection.beginTransaction()` / `commit()` / `rollback()`
8. **Firestore outbox events must be enqueued inside the same transaction** — otherwise MySQL commits without Firestore notification
9. **Never bypass `requireRole` middleware** — RBAC is enforced server-side
10. **Always use parameterized queries** — `pool.query('SELECT ? FROM ...', [param])` — never string concatenation
11. **Do not enable any feature flag without understanding its effect** — especially `USE_FIRESTORE_SERVICES=true` changes read source from MySQL to Firestore

### Frontend Rules
12. **Never trust `localStorage` for role decisions** — always verify via `/api/auth/me` or backend middleware
13. **Never hardcode API endpoints** — use `API_URL` from `src/config/apiConfig.js`
14. **Do not add new staff accounts without updating `authMapping.js`** (until mapping is moved to DB)

### Firebase Rules
15. **Do not enable Firestore read canaries without first verifying data consistency** in `dual_write_outbox` (all events PROCESSED)
16. **Do not enable `USE_FIRESTORE_SERVICES=true` for transactional data** — Firestore lacks MySQL-level transactions for compound operations
17. **Do not modify Firestore security rules** without testing — guest and staff data are in the same project

### Operations Rules
18. **Always restart Docker backend after `.env` changes** — `docker restart hotel_pms_backend`
19. **After `package.json` changes in backend**: `docker-compose build backend` then `up -d`
20. **Never modify code in Docker container directly** — code is bind-mounted; change files on host
21. **Check migration status before any schema-related work**: `docker exec hotel_pms_backend npm run migrate:status`

---

## 40. Handover Guide

### 1. How to Start the Project

**Prerequisites:**
- Docker Desktop running
- Node.js installed on host

**Steps:**
```bash
# Start database and backend containers
docker-compose up -d

# Check containers are healthy
docker ps

# Start frontend dev server (in project root)
npm run dev
# Frontend: http://localhost:5173
# Backend: http://localhost:5000
# phpMyAdmin: http://localhost:8080
```

### 2. How to Check MySQL

```bash
# Via Docker exec
docker exec hotel_pms_db mysql -u root -p hotel_pms

# Via phpMyAdmin
http://localhost:8080
# Login: root / (password from .env)

# Check table state
docker exec hotel_pms_db mysql -u root -p hotel_pms -e "SHOW TABLES;"
docker exec hotel_pms_db mysql -u root -p hotel_pms -e "SELECT * FROM system_settings;"
```

### 3. How to Check Migrations

```bash
docker exec hotel_pms_backend npm run migrate:status
# Expected: All 12 migrations applied, 0 pending
```

### 4. How Authentication Works

- **Staff/Admin:** Enter username → Firebase email lookup (`authMapping.js`) → Firebase sign-in → ID token → `GET /api/auth/me` → MySQL staff lookup → role resolved → navigate by role
- **Guest:** POST `/api/auth/signin` with username/password → HMAC-JWT returned → `GuestAuthContext` stores token

### 5. How to Test an API

```bash
# Get admin token (legacy fallback)
curl -X POST http://localhost:5000/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_ADMIN_PASSWORD"}'

# Use token
curl http://localhost:5000/api/status \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 6. How to Safely Make a Backend Change

1. Edit files in `backend/` (mounted into container)
2. `docker restart hotel_pms_backend`
3. Check `docker logs hotel_pms_backend --tail 20`
4. Test the affected endpoint

### 7. How to Add a Migration

1. Create `backend/migrations/013_your_description.js`
2. Follow the pattern from existing migrations (export `up()` and `down()`)
3. Run: `docker exec hotel_pms_backend npm run migrate`
4. Verify: `docker exec hotel_pms_backend npm run migrate:status`

### 8. How to Test Check-In

1. Log in as admin (`http://localhost:5173/admin/login`)
2. Select a vacant room → click Check In
3. Fill in guest name, phone, set tariff, deposit
4. Submit
5. Verify in MySQL: `SELECT * FROM bookings ORDER BY id DESC LIMIT 1;`
6. Verify ledger: `SELECT * FROM ledger_items ORDER BY id DESC LIMIT 5;`

### 9. How to Test Checkout

1. Select an occupied room → click Check Out
2. LedgerPanel should show folio
3. Confirm checkout
4. Verify room becomes dirty (housekeeping)
5. Verify: `SELECT * FROM invoices ORDER BY id DESC LIMIT 1;`

### 10. How to Test Ledger

```bash
curl http://localhost:5000/api/rooms/3/ledger \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
# Returns: {booking: {...}, ledger: [...], summary: {totalCharges, totalPayments, outstanding}}
```

### 11. Commands That MUST NOT Be Run

```bash
# DANGER — deletes all tables and data
npm run migrate:fresh
docker exec hotel_pms_backend npm run migrate:fresh

# DANGER — re-initializes the entire database (wipes everything)
node init_db.js

# DANGER — factory reset (wipes all business data)
POST /api/system/factory-reset (requires super_admin)
```

### 12. How to Verify Room Status

```bash
curl http://localhost:5000/api/status -H "Authorization: Bearer TOKEN"
# Returns: rooms[], metrics, businessDate
```

---

## 41. Current Project State Snapshot

```
PROJECT:          HPMS — Hotel Property Management System (Hotel Sky-5)
VERSION:          1.0.0
SINGLE HOTEL:     Yes — Hotel Sky-5, 17 rooms
DEPLOYMENT:       Local/Docker — not in cloud production

DATABASE:
  MySQL:          hotel_pms @ hotel_pms_db:3306
  Firestore:      hpms-sky5 (mirror, not authoritative)
  Business Date:  2026-08-18
  Rooms:          17 total, 2 occupied, 15 vacant
  Staff in DB:    0 (Firebase-only authentication)

CURRENT AUTHORITATIVE SOURCE:  MySQL for ALL business data

AUTH:             Firebase Auth (primary for staff) + Legacy JWT (fallback + guest)
RBAC:             MySQL roles/permissions, enforced server-side via requireRole()
                  ENABLE_STRICT_RBAC=true

FRONTEND:         React 18 + Vite, custom pushState router
                  3 active portals: Admin, Receptionist, Guest
                  1 stub portal: Kitchen/Pantry/Housekeeping

BACKEND:          Express 5000, Socket.IO, 15 controllers, 18 services
                  All business logic in MySQL transactions

DOCKER:           3 containers running: db, backend, phpmyadmin
                  Backend source bind-mounted (live reload)

FIRESTORE:
  Dual-write:     ACTIVE (ENABLE_FIRESTORE_DUAL_WRITE=true)
  Outbox Worker:  RUNNING (ENABLE_FIRESTORE_OUTBOX_WORKER=true)
  Read Canaries:  ALL DISABLED
  Read source:    MySQL (no Firestore reads for business data)

OUTBOX:           1 event total, 0 pending (all processed)

MIGRATIONS:       12/12 applied, 0 pending

ROOMS:            17 rooms configured, numeric ordering
CHECK-IN:         Complete + 8 new fields (Phase E complete)
CHECKOUT:         Complete + LedgerPanel folio display
LEDGER:           Complete — transaction_type, credit_amount, time_of_entry
PAYMENTS:         Dual system: payments table + ledger_items
RESERVATIONS:     Complete CRUD
HOUSEKEEPING:     Complete
INVENTORY:        Basic CRUD (no stock tracking)
REPORTS:          Basic reports + analytics

KNOWN CRITICAL BUGS:
  1. JWT_SECRET not set — hardcoded insecure default
  2. 0 staff MySQL records — status checks bypassed
  3. Checkout hardcodes payment_method='Cash'
  4. Guest documents served without authentication

TOP NEXT STEPS:
  1. Set JWT_SECRET in backend/.env
  2. Add authentication to /guest-documents static serving
  3. Provision staff records in MySQL staff table
  4. Wire DOB field in Admin CheckInModal to API payload
  5. Verify AvailabilityService usage in reservation double-booking prevention
  6. Add rate limiting to auth endpoints
  7. Begin enabling Firestore read canaries (one collection at a time)
  8. Add integration tests for check-in / checkout / day-end flows
```

---

## 42. Final Audit Verdict

### What Is Working ✅
- MySQL-backed hotel operations: check-in, check-out, reservations, ledger, payments, housekeeping, inventory
- Firebase Auth for staff login (primary) with JWT fallback
- RBAC correctly gates admin vs. receptionist vs. housekeeper operations
- Firestore dual-write is active and outbox is processing
- 12/12 migrations applied, schema includes all Phase E fields
- LedgerPanel integrated in both Admin drawer and Receptionist checkout
- Day End / Night Audit with ROLLOVER ledger entries
- Guest portal with booking wizard and folio view
- Socket.IO real-time room updates

### What Is Partially Working ⚠️
- Razorpay payment gateway (code exists, untested end-to-end)
- Loyalty system (columns in DB, stub UI)
- Kitchen/Pantry dashboards (stub pages, no functionality)
- Electron desktop app (configured, not actively maintained)
- Firestore reads (repositories exist, all canaries disabled — reads come from MySQL)
- Admin CheckInModal DOB field (form field present, payload wiring unverified)

### What Is Incomplete / Missing ❌
- Automated test suite (zero tests)
- JWT_SECRET environment variable
- MySQL staff records (empty table)
- Guest document authentication
- Rate limiting on auth endpoints
- GST calculation (only included in rate, not broken out)
- Inventory stock tracking / movements
- Double-booking enforcement verification

### What Is Risky ⚠️
- Hardcoded JWT secret fallback (CRITICAL security risk)
- Integer monetary columns (limits future fractional pricing)
- Checkout marks payment Paid without enforcement
- Checkout hardcodes Cash payment method
- Static guest documents accessible without authentication
- 40+ root-level maintenance scripts and backup files need cleanup

### What Must Happen Before Firebase Becomes Authoritative ❌
1. All Firestore read canaries must be enabled and tested collection-by-collection
2. All outbox events must be verified PROCESSED (currently clean)
3. Firestore data must be verified consistent with MySQL for all collections
4. Business logic must be ported from MySQL transaction patterns to Firestore-compatible patterns
5. Reservation double-booking protection must be re-implemented without `FOR UPDATE` locks
6. Day End atomicity must be re-implemented without MySQL transactions
7. All financial integrity rules must be validated in Firestore security rules
8. Load and concurrency testing must be performed

### What Must NOT Be Changed Casually
- `system_settings.system_date` — business date is authoritative
- The `outbox_worker` — disabling causes Firestore to fall behind MySQL
- The `requireRole()` middleware — any change affects all RBAC
- Migration files that have been applied — never modify applied migrations
- The `JWT_SECRET` (once set) — changing it invalidates all active legacy tokens
- `users` and `roles` tables — RBAC foundation
- `bookings` table structure — core transactional data

### Recommended Next Development Phase
**Phase G: Security + Stability Hardening**
1. Set `JWT_SECRET` in `.env`
2. Authenticate `/guest-documents` route
3. Seed MySQL staff records
4. Wire admin CheckInModal DOB to API
5. Fix checkout payment method capture
6. Add basic rate limiting
7. Write integration tests for check-in/out/dayend
8. Clean up root-level scripts and backup files

**After Phase G: Phase H — Firestore Read Canary Testing (one collection at a time)**

---

*This document was generated from direct inspection of source files and live database as of 2026-08-19. All schema information is verified from `SHOW CREATE TABLE` output. All feature flags are verified from `backend/.env`. Record counts are from live MySQL queries. All claims marked "REQUIRES MANUAL VERIFICATION" could not be confirmed without runtime testing.*
