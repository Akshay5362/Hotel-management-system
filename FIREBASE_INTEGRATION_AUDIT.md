# HPMS-Sky5: Firebase Integration Audit & Architecture Strategy Report

> **Project Name:** HPMS-Sky5  
> **Firebase Target:** Cloud Firestore (Standard Edition, Production Mode)  
> **Audit Type:** Read-Only Integration Audit (Non-Destructive & Dual-Stack Ready)  
> **Status:** Architectural Audit Complete — Pending Approval  

---

## Executive Summary

This audit evaluates the **HPMS (Hotel Property Management System)** codebase for integrating **Firebase (HPMS-Sky5)** alongside the existing MySQL relational database. The goal is to provide a zero-downtime, incremental, reversible migration path that maintains **100% operational functionality of the existing MySQL system** while introducing Firebase capabilities in a controlled, phased approach.

---

## Section A: Current Architecture Analysis

### 1. Project Structure
The repository is structured into distinct application components:
* **`backend/`**: Express 4.x REST API + Socket.IO server with custom MySQL connection pool (`db.js`), hand-written SQL controllers, business services, and static document serving.
* **`src/`**: Primary Front-Office / Admin React frontend built with Vite and Tailwind/Vanilla CSS.
* **`guest-web/`**: Dedicated Guest Portal React application built with Vite.
* **`electron/`**: Electron desktop application wrapper that manages background Node server spawning (`backend-launcher.js`) and IPC desktop integration.
* **`docker/`**: Containerization setup for production deployment.

### 2. Frontend Architecture
* **Admin/Staff UI (`src/`)**: Component-driven architecture (`ReceptionPortal`, `AdminHousekeeping`, `InventoryModule`, `GuestRequestsModal`, `RefundCheckoutModal`) consuming REST endpoints and Socket.IO real-time events.
* **Guest UI (`guest-web/src/`)**: Guest-facing workflow (`GuestDashboard`, `GuestActiveStayOverview`) handling room service requests, identity document uploads, maintenance reports, stay extensions, and bill viewing.

### 3. Backend Architecture
* **Server**: Node.js Express server (`backend/server.js`) listening on HTTP/Socket.IO.
* **Database Access**: Direct SQL execution using `mysql2/promise` connection pooling (`backend/db.js`).
* **Service Layer**: Business logic encapsulated in `services/` (`businessDateService.js`, `AvailabilityService.js`, `checkInService.js`, `CheckoutRecoveryService.js`, `FactoryResetService.js`, `roomStatusService.js`, `ocrService.js`).
* **Controllers**: 14 controller modules in `backend/controllers/` handling API routing logic.

### 4. Electron Architecture
* Spawns `backend/server.js` as a background child process via `backend-launcher.js`.
* Loads local application frontend or Vite dev server into an Electron `BrowserWindow`.
* Configured via `electron/config.js`, `main.js`, and `preload.js`.

### 5. Database Access Layer
* Connection pool instantiated in `backend/db.js` using process environment variables (`DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`).
* Database schema creation & seeding handled destructively via `backend/init_db.js`.
* Incremental migrations executed sequentially via custom runner `backend/migrations/runner.js`.

---

## Section B: MySQL Dependency Map

The HPMS relational database consists of **30 distinct MySQL tables**:

| # | MySQL Table Name | Primary Purpose | Key Foreign Keys | MySQL Specifics & Locking Dependencies |
|---|------------------|-----------------|------------------|----------------------------------------|
| 1 | `roles` | RBAC role master | None | `AUTO_INCREMENT`, `UNIQUE` name constraint |
| 2 | `permissions` | RBAC permission master | None | `AUTO_INCREMENT`, `UNIQUE` permission name |
| 3 | `role_permissions` | M:N Role-Permission mapping | `role_id`→`roles`, `permission_id`→`permissions` | Composite PK, `ON DELETE CASCADE` |
| 4 | `users` | User accounts (Admin, Guest) | `role_id`→`roles` | `AUTO_INCREMENT`, `UNIQUE` username, `ON DELETE SET NULL` |
| 5 | `staff` | Hotel staff accounts | None | `AUTO_INCREMENT`, `UNIQUE` username/email, ENUMs |
| 6 | `guests` | Master guest profile & document metadata | `user_id`→`users` | `AUTO_INCREMENT`, `ON DELETE SET NULL` |
| 7 | `room_types` | Category master & tariff configuration | None | `AUTO_INCREMENT`, `UNIQUE` code constraint |
| 8 | `rooms` | Physical room state & status | `room_type_id`→`room_types` | `AUTO_INCREMENT`, `UNIQUE` number, `ON DELETE CASCADE` |
| 9 | `bookings` | Master stay folio records | `guest_id`→`guests`, `room_id`→`rooms`, `created_by`→`users` | `AUTO_INCREMENT`, `UNIQUE` booking_number, `FOR UPDATE` locks |
| 10 | `reservations` | Advance booking reservations | `room_id`→`rooms`, `booking_id`→`bookings`, `created_by`→`users` | `AUTO_INCREMENT`, `FOR UPDATE` locks during check-in |
| 11 | `booking_history` | Lifecycle audit trail | `booking_id`→`bookings`, `changed_by`→`users` | `AUTO_INCREMENT`, `ON DELETE CASCADE` |
| 12 | `ledger_items` | Itemized room folio charges | `room_number`→`rooms.number`, `booking_id`→`bookings` | `AUTO_INCREMENT`, `ON DELETE CASCADE` |
| 13 | `payments` | Financial payment transactions | `booking_id`→`bookings` | `AUTO_INCREMENT`, `ON DELETE SET NULL` |
| 14 | `invoices` | Billing tax invoices | `booking_id`→`bookings` | `AUTO_INCREMENT`, `UNIQUE` invoice_number, `ON DELETE CASCADE` |
| 15 | `housekeeping` | Current room cleaning state | `room_id`→`rooms`, `cleaned_by`→`users` | `AUTO_INCREMENT`, `ON DELETE CASCADE` |
| 16 | `housekeeping_logs` | Historical cleaning logs | `room_id`→`rooms` | `AUTO_INCREMENT`, `ON DELETE CASCADE` |
| 17 | `maintenance` | Maintenance ticket tracking | `room_id`→`rooms`, `reported_by`→`users`, `assigned_to`→`users` | `AUTO_INCREMENT`, `ON DELETE CASCADE` |
| 18 | `room_status_history` | Status change audit trail | `room_id`→`rooms`, `changed_by`→`users` | `AUTO_INCREMENT`, `ON DELETE CASCADE` |
| 19 | `audit_logs` | System-wide security audit | `user_id`→`users` | `AUTO_INCREMENT`, `ON DELETE SET NULL` |
| 20 | `notifications` | User alerts & system notifications | `user_id`→`users` | `AUTO_INCREMENT`, `ON DELETE CASCADE` |
| 21 | `cash_logs` | Front desk cash drawer entries | `booking_id`→`bookings` | `AUTO_INCREMENT`, `ON DELETE SET NULL` |
| 22 | `cash_submissions` | Daily shift cash handovers | None | `AUTO_INCREMENT` |
| 23 | `system_settings` | Authoritative Business Date & Counters | None | PK `key_name`, `FOR UPDATE NOWAIT` locking |
| 24 | `feedback` | Post-checkout guest reviews | `booking_id`→`bookings`, `guest_id`→`guests` | `AUTO_INCREMENT`, `ON DELETE CASCADE` |
| 25 | `stay_extension_requests` | Guest stay extension requests | `booking_id`→`bookings`, `guest_id`→`guests`, `room_id`→`rooms` | `AUTO_INCREMENT`, `ON DELETE CASCADE` |
| 26 | `razorpay_transactions` | Online payment gateway orders | None | `AUTO_INCREMENT`, `UNIQUE` order_id |
| 27 | `checkout_snapshots` | Checkout zero-loss state backups | `booking_id`→`bookings` | `AUTO_INCREMENT`, `ON DELETE RESTRICT` |
| 28 | `inventory_categories` | Inventory master categories | None | `AUTO_INCREMENT`, `UNIQUE` name constraint |
| 29 | `inventory_products` | Inventory product catalog & stock | `category_id`→`inventory_categories` | `AUTO_INCREMENT`, `UNIQUE` sku, `ON DELETE RESTRICT` |
| 30 | `schema_migrations` | Migration version history | None | `AUTO_INCREMENT`, SQL runner tracking |

---

## Section C: Firebase Integration Points

To integrate **HPMS-Sky5** alongside MySQL without breaking existing functionality, Firebase will be attached at 4 strategic abstraction layers:

1. **Authentication Layer (Firebase Auth)**:
   * Firebase Auth handles user identity, emitting JWT ID tokens.
   * Node backend verifies Firebase ID tokens alongside existing legacy JWTs using a dual-auth middleware wrapper (`authMiddleware.js`).
2. **Real-time Listener Layer (Firestore Client SDK)**:
   * Client applications (`src` and `guest-web`) attach Firestore `onSnapshot()` listeners to `/rooms`, `/guest_requests`, and `/housekeeping` collections.
   * Eliminates 15s–30s polling loops and Socket.IO fallback disconnections.
3. **Dual-Write Abstraction Layer (Database Bridge Service)**:
   * A service module (`FirebaseSyncService.js`) handles dual-writing. Whenever a MySQL transaction completes, state changes are pushed asynchronously or inside the API response to Firestore documents.
4. **File Storage Layer (Firebase Storage SDK)**:
   * Direct client-side or server-side upload to Cloud Storage for Firebase, returning persistent HTTPS URLs stored in both MySQL and Firestore.

---

## Section D: Recommended Firestore Data Model (`HPMS-Sky5`)

### Root Collections Architecture

#### 1. Collection: `/settings`
* **Document ID: `system_date`**
  ```json
  {
    "current_date": "2026-08-10",
    "today_checkins": 2,
    "today_checkouts": 4,
    "continued_rooms": 3,
    "updated_at": "2026-08-10T10:00:00Z"
  }
  ```
* **Document ID: `refund_policy`**
  ```json
  {
    "policy_text": "Standard 24-hour cancellation rule...",
    "cancellation_fee_percentage": 10
  }
  ```

#### 2. Collection: `/users`
* **Document ID: `{firebase_uid}`**
  ```json
  {
    "uid": "USER_UID_123",
    "mysql_user_id": 14,
    "username": "keval",
    "email": "keval@example.com",
    "fullName": "KEVAL PATEL",
    "role": "admin",
    "phone": "+91 9999999999",
    "created_at": "2026-08-10T10:00:00Z"
  }
  ```

#### 3. Collection: `/guests`
* **Document ID: `{guest_id}`** (e.g. `guest_103`)
  ```json
  {
    "guest_id": "guest_103",
    "mysql_id": 2,
    "user_uid": "USER_UID_123",
    "full_name": "KATARI AKHILESH",
    "phone": "+91 9123456789",
    "email": "akhilesh@gmail.com",
    "address": "Mumbai, India",
    "government_id": "A1234567",
    "id_type": "Passport",
    "id_document_url": "https://firebasestorage.googleapis.com/...",
    "id_verification_status": "Verified",
    "loyalty_tier": "Gold",
    "loyalty_points": 1500
  }
  ```

#### 4. Collection: `/rooms`
* **Document ID: `{room_id}`** (e.g. `room_101`)
  ```json
  {
    "room_id": "room_101",
    "number": "101",
    "room_type_code": "PREMIUM",
    "status": "occupied",
    "housekeeping_status": "Clean",
    "base_rate": 2500,
    "current_booking_id": "bkg_501"
  }
  ```

#### 5. Collection: `/bookings`
* **Document ID: `{booking_id}`** (e.g. `bkg_501`)
  ```json
  {
    "booking_id": "bkg_501",
    "booking_number": "BKG-749201",
    "guest_id": "guest_103",
    "guest_name": "KATARI AKHILESH",
    "room_id": "room_101",
    "room_number": "101",
    "check_in_date": "2026-08-10",
    "expected_check_out_date": "2026-08-12",
    "booking_status": "Checked In",
    "payment_status": "Partial",
    "total_amount": 5720,
    "advance_amount": 2000,
    "created_at": "2026-08-10T10:00:00Z"
  }
  ```
  * **Sub-collection: `/bookings/{booking_id}/ledger_items`**
    * Document `{item_id}`: `desc`, `qty`, `amount`, `business_date`.
  * **Sub-collection: `/bookings/{booking_id}/payments`**
    * Document `{payment_id}`: `amount`, `payment_method`, `payment_type`, `business_date`.

#### 6. Collection: `/reservations`
* **Document ID: `{reservation_id}`**
  ```json
  {
    "reservation_id": "res_301",
    "reservation_number": "RES-102938",
    "guest_name": "RAJESH SINGH",
    "phone": "+91 8888888888",
    "arrival_date": "2026-08-15",
    "departure_date": "2026-08-18",
    "room_type": "EXECUTIVE",
    "room_id": "room_102",
    "status": "Reserved"
  }
  ```

#### 7. Collection: `/daily_analytics` (Reporting & Aggregations)
* **Document ID: `{YYYY-MM-DD}`**
  ```json
  {
    "date": "2026-08-10",
    "total_revenue": 14500,
    "room_revenue": 12500,
    "total_bookings": 5,
    "occupied_rooms": 4,
    "total_rooms": 17,
    "occupancy_rate": 24,
    "adr": 2500,
    "revpar": 735,
    "cancellations": 0
  }
  ```

---

## Section E: Recommended Firebase Authentication Architecture

* **Authentication Gateway**: Firebase Authentication managing identity across Admin, Reception, and Guest Portals.
* **Custom Claims Strategy**: Assign roles (`admin`, `staff`, `guest`) to Firebase ID tokens using `firebaseAdmin.auth().setCustomUserClaims(uid, { role: 'admin' })`.
* **Dual-Authentication Middleware**:
  * Create `backend/middleware/firebaseAuthMiddleware.js` that checks for a Firebase Bearer ID Token (`req.headers.authorization`).
  * If valid, resolves the user and attaches `req.user = { uid, role: decodedClaims.role }`.
  * If invalid or missing, falls back seamlessly to verifying the existing legacy HMAC-SHA256 JWT.

---

## Section F: Recommended Firebase Storage Architecture

* **Bucket Setup**: Production Cloud Storage bucket `HPMS-Sky5.appspot.com`.
* **Folder Hierarchy**:
  * `/guest-documents/{guest_id}/{uuid}.pdf` — Guest Aadhaar/Passport scans (Strict Security Rule: Admin & Guest owner access only).
  * `/inventory-photos/{product_sku}/{uuid}.jpg` — Inventory item images (Public read, Staff write).
* **Migration Bridge**: Standardize document URLs stored in MySQL `guests.id_document_path` to accept both local paths (`/guest-documents/id_doc_xxx.png`) and Firebase Storage HTTPS URLs (`https://firebasestorage.googleapis.com/...`).

---

## Section G: Recommended Cloud Functions Architecture

Firebase Cloud Functions (v2 Node.js runtime) will host isolated microservices for concurrency-critical and background background logic:

1. **`onCheckInTransaction`**: Executed when a check-in is initiated. Performs atomic Firestore multi-document transaction across `/rooms/{roomId}`, `/bookings/{bookingId}`, `/guests/{guestId}`, and `/settings/system_date`.
2. **`onNightAuditRollover`**: Scheduled Cron / HTTP trigger executing Night Audit day-end date advancement and posting rollover charges.
3. **`onBookingChangeTrigger`**: Firestore trigger (`onDocumentWritten`) listening to `/bookings/{bookingId}` to automatically re-calculate and update pre-aggregated stats in `/daily_analytics/{YYYY-MM-DD}`.
4. **`onRazorpayWebhook`**: Secure HTTP Cloud Function handling online payment gateway webhooks and signature verification.

---

## Section H: Transaction Conversion Plan (MySQL Locking → Firestore OCC)

### MySQL Concurrency Mechanics
Currently, `checkInService.js`, `businessDateService.js`, and `AvailabilityService.js` acquire pessimistic database locks:
```sql
SELECT * FROM system_settings WHERE key_name = 'system_date' FOR UPDATE NOWAIT;
SELECT * FROM rooms WHERE number = '101' FOR UPDATE;
```

### Firestore Transaction Conversion
Firestore uses **Optimistic Concurrency Control (OCC)** via `db.runTransaction()`.
1. All document reads must occur before any document writes within the transaction block.
2. If a concurrent operation modifies `/rooms/room_101` or `/settings/system_date` while the transaction is running, Firestore automatically rolls back and retries the transaction.

```javascript
await db.runTransaction(async (transaction) => {
  const roomRef = db.collection('rooms').doc(roomId);
  const roomDoc = await transaction.get(roomRef);
  
  if (roomDoc.data().status === 'occupied') {
    throw new Error('Room is already occupied');
  }

  transaction.update(roomRef, { status: 'occupied' });
  transaction.set(bookingRef, newBookingData);
});
```

---

## Section I: Realtime Listener Migration Plan (Socket.IO → Firestore `onSnapshot`)

### Current State
* Express server mounts Socket.IO (`backend/server.js`).
* Components rely on 15s–30s polling intervals when disconnected.

### Target State
* Front-end components subscribe directly to Firestore collections using `onSnapshot()`:
```javascript
// Example in AdminHousekeeping.jsx
useEffect(() => {
  const unsubscribe = onSnapshot(collection(db, 'rooms'), (snapshot) => {
    const updatedRooms = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    setRooms(updatedRooms);
  });
  return () => unsubscribe();
}, []);
```
* **Benefits**: Instant UI updates across desktop and web, zero Socket.IO server overhead, complete elimination of fallback HTTP polling loops.

---

## Section J: Reporting Strategy (SQL Aggregations → Firestore Pre-Aggregation)

### Challenge
Firestore does not support SQL relational `SUM()`, `AVG()`, or multi-table `JOIN` aggregations. Querying raw historic ledgers on demand will cause high read costs and slow response times.

### Solution: Pre-Aggregated Analytics Engine
1. Maintain pre-aggregated summary documents in `/daily_analytics/{YYYY-MM-DD}`.
2. Every payment insertion or status change updates the corresponding daily summary document atomically using `FieldValue.increment()`:
```javascript
transaction.update(analyticsRef, {
  total_revenue: FieldValue.increment(paymentAmount),
  occupied_rooms: FieldValue.increment(1)
});
```
3. `reportsController.js` and frontend report components query the single `/daily_analytics` document for the date range instead of iterating over thousands of raw ledger rows.

---

## Section K: Electron Integration Requirements

* Current setup uses `electron/backend-launcher.js` to spawn `backend/server.js` as a local Node child process.
* **Firebase Integration**:
  * Desktop app initialized with Firebase JS Client SDK (`firebase/app`, `firebase/firestore`).
  * Enables **Firestore Offline Persistence** (`enableIndexedDbPersistence(db)`), allowing reception staff to continue viewing and queueing operations during internet outages.
  * No modification to existing Electron backend-launcher during Phase 1.

---

## Section L: Vercel Deployment Implications

* Front-end web applications (`guest-web` and `src`) are deployed on Vercel (`hotel-management-system-lac-xi.vercel.app`).
* Vercel serverless functions have execution timeouts (10s–60s).
* Long-running operations (such as Tesseract OCR or Night Audit) will be delegated to Firebase Cloud Functions rather than running inside Vercel serverless API handlers.

---

## Section M: Required Firebase Packages (Future Phase)

> *Note: These packages will NOT be installed yet.*

```json
{
  "dependencies": {
    "firebase": "^10.8.0",
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^4.7.0"
  }
}
```

---

## Section N: Required Environment Variables

To be added to `backend/.env` and `.env.example` in a future phase:

```env
FIREBASE_PROJECT_ID=HPMS-Sky5
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@HPMS-Sky5.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"
FIREBASE_STORAGE_BUCKET=HPMS-Sky5.appspot.com
```

---

## Section O: Security Rules Requirements (`HPMS-Sky5`)

### Firestore Security Rules Baseline (`firestore.rules`)
```firestore
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    function isAdmin() {
      return request.auth != null && request.auth.token.role == 'admin';
    }
    
    function isStaff() {
      return request.auth != null && (request.auth.token.role == 'admin' || request.auth.token.role == 'staff');
    }
    
    match /settings/{doc} {
      allow read: if request.auth != null;
      allow write: if isAdmin();
    }
    
    match /rooms/{roomId} {
      allow read: if request.auth != null;
      allow write: if isStaff();
    }
    
    match /bookings/{bookingId} {
      allow read, write: if isStaff();
      allow read: if request.auth != null && resource.data.guest_id == request.auth.uid;
    }
  }
}
```

---

## Section P: Data Migration / ETL Strategy (MySQL → Firestore)

1. **Extraction**: Create a Node.js CLI script (`scripts/migrate_mysql_to_firestore.mjs`).
2. **Transformation**:
   * Map MySQL `int` PKs (`id = 103`) to formatted Firestore IDs (`guest_103`).
   * Format dates to ISO strings (`YYYY-MM-DD`).
   * Convert boolean flags (`1`/`0`) to native JSON booleans (`true`/`false`).
3. **Loading**: Write documents in Firestore batches of 500 using `db.batch()`.
4. **Validation Checksum**: Compare row count in MySQL tables vs document count in Firestore collections.

---

## Section Q: Dual-Write Strategy

To guarantee **zero disruption to existing MySQL operations**, dual-writing will be implemented in a non-blocking bridge pattern:

```
[API Endpoint / Service]
       │
       ▼
1. Execute MySQL Transaction (Primary Source of Truth)
       │
       ├─► MySQL Commit Successful
       │
       ▼
2. Asynchronous Push to Firebase (Non-blocking Bridge)
       │
       ├─► Update Firestore Document (/rooms, /bookings)
       └─► Trigger Client Real-time Listeners (onSnapshot)
```

If the Firestore update fails, the error is logged without failing the primary MySQL response.

---

## Section R: Rollback Strategy

1. **Instant Circuit Breaker**: Controlled via environment variable `ENABLE_FIREBASE_SYNC=false`.
2. **Dual-Stack Fallback**: The Express backend will continue executing MySQL queries as primary. Disabling Firebase integration simply reverts the app back to pure MySQL REST/Socket.IO operation without data loss.

---

## Section S: Risk Matrix & Assessment

| Major Subsystem | Risk Level | Primary Risk Factors | Mitigation Strategy |
|-----------------|------------|----------------------|---------------------|
| **Room Availability & Check-in** | **HIGH** | Simultaneous booking attempts leading to double bookings. | Firestore `runTransaction()` OCC validation + dual-write locking. |
| **Night Audit / Day-End Rollover** | **HIGH** | Automated date advancement & room tariff posting mismatch. | Cloud Function execution with atomic multi-document writes. |
| **Financial Reports & Analytics** | **MEDIUM** | Query latency / high read unit costs on unindexed aggregations. | Pre-aggregated daily statistics documents (`/daily_analytics`). |
| **Authentication & RBAC** | **MEDIUM** | Legacy JWT vs Firebase ID Token token structure mismatch. | Dual-Auth middleware verifying both legacy JWT and Firebase ID token. |
| **File Storage Uploads** | **LOW** | Broken image links during migration. | Dual URL support accepting local disk paths & Firebase Storage URLs. |
| **Housekeeping & Realtime Logs** | **LOW** | Minor UI sync delay. | Direct Firestore `onSnapshot()` subscription. |

---

## Section T: Recommended Implementation Roadmap

```mermaid
gantt
    title HPMS-Sky5 Incremental Firebase Migration Plan
    dateFormat  YYYY-MM-DD
    section Phase 1
    Firebase SDK Setup & Dual-Auth Middleware      :a1, 2026-08-11, 3d
    section Phase 2
    Master Data Sync (Rooms, Types, Settings)      :a2, after a1, 3d
    section Phase 3
    Dual-Write Bridge (Bookings & Check-in)         :a3, after a2, 4d
    section Phase 4
    Realtime Listeners (Housekeeping & Requests)   :a4, after a3, 4d
    section Phase 5
    Cloud Functions & Pre-Aggregated Analytics      :a5, after a4, 5d
```

---

## Final Deliverables & Requirements Checklist

### 1. Files That Would Eventually Need Modification
*(No source code modified in this phase)*
* `backend/server.js` — Mount Firebase Admin SDK & dual-auth middleware.
* `backend/routes/api.js` — Attach dual-write bridge to write endpoints.
* `backend/middleware/authController.js` — Add Firebase ID token verification.
* `backend/services/checkInService.js` — Add asynchronous Firestore sync on check-in commit.
* `backend/services/businessDateService.js` — Sync Business Date changes to Firestore `/settings/system_date`.
* `src/config/apiConfig.js` — Initialize Firebase Web Client SDK.
* `src/components/AdminHousekeeping.jsx` — Replace Socket.IO with Firestore `onSnapshot()`.
* `src/components/GuestRequestsModal.jsx` — Replace 15s polling timer with `onSnapshot()`.

### 2. Files That Should NOT Be Modified Initially
* `backend/db.js` — Must remain unchanged so MySQL connection pool functions normally.
* `backend/init_db.js` — Schema reset tool must remain strictly MySQL-focused.
* `backend/migrations/*` — Existing MySQL migration files must remain untouched.
* `electron/main.js` & `electron/backend-launcher.js` — Must continue launching Node/MySQL server.

### 3. Packages That Would Eventually Be Required
* `firebase-admin` (Node.js backend)
* `firebase` (React frontend client SDK)

### 4. Firebase Services Required (HPMS-Sky5)
* **Cloud Firestore** (Standard Edition, Production Mode)
* **Firebase Authentication** (Email/Password, Custom Claims)
* **Cloud Storage for Firebase** (Document & Photo uploads)
* **Firebase Cloud Functions v2** (Serverless background jobs & webhooks)

### 5. First Implementation Task Only
**Task 1:** Create `backend/config/firebaseAdmin.js` to initialize the Firebase Admin SDK using non-blocking environment variables and create `backend/middleware/firebaseAuthMiddleware.js` for dual-token validation without altering any existing MySQL queries or routes.

---

> **Awaiting User Approval to proceed with Task 1.**
