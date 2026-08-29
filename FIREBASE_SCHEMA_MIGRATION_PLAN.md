# HPMS-Sky5: Firestore Schema & Architecture Migration Plan

> **Project Target:** HPMS-Sky5 (Cloud Firestore Standard Edition, Location: asia-south1)  
> **Document Type:** Read-Only Schema Architecture & Mapping Plan  
> **Status:** Read-Only Verification Complete — Pending Approval  

---

## 1. Executive Summary & Strategy Overview

This document provides an exhaustive, read-only architectural breakdown of the **HPMS (Hotel Property Management System)** relational database (30 MySQL tables) and details the target **Google Cloud Firestore NoSQL schema design** for project **HPMS-Sky5**.

### Key Migration Directives:
* **Zero MySQL Disruption:** MySQL remains the primary production database.
* **No Database Cutover Yet:** Data migration and dual-write triggers are deferred to subsequent approved tasks.
* **Server-Side Security:** Concurrency-critical workflows (Check-In, Check-Out, Night Audit, Payment Webhooks) will remain server-side using Node.js / Cloud Functions to execute atomic Firestore transactions.

---

## 2. Subsystem Architecture & Dependency Analysis

### 1. MySQL Tables Used (30 Tables Total)
`roles`, `permissions`, `role_permissions`, `users`, `staff`, `guests`, `room_types`, `rooms`, `bookings`, `reservations`, `booking_history`, `ledger_items`, `payments`, `invoices`, `housekeeping`, `housekeeping_logs`, `maintenance`, `room_status_history`, `audit_logs`, `notifications`, `cash_logs`, `cash_submissions`, `system_settings`, `feedback`, `stay_extension_requests`, `razorpay_transactions`, `checkout_snapshots`, `inventory_categories`, `inventory_products`, `schema_migrations`.

### 2. Foreign-Key Relationships & Dependencies
Relational integrity in MySQL is enforced via InnoDB Foreign Keys (`ON DELETE CASCADE`, `ON DELETE SET NULL`, `ON DELETE RESTRICT`). In Firestore:
* **Embedded Sub-collections** replace 1:M parent-child tables (e.g. `/bookings/{bookingId}/ledger_items` and `/bookings/{bookingId}/payments`).
* **Document References & Denormalization** replace JOIN queries (e.g. embedding `guest_name`, `room_number`, and `base_rate` directly inside booking documents).

### 3. Transactions & Pessimistic Locking Mechanics
* **MySQL:** Uses `SELECT ... FOR UPDATE` and `FOR UPDATE NOWAIT` in `checkInService.js`, `businessDateService.js`, `AvailabilityService.js`, and `roomController.js`.
* **Firestore Strategy:** Converted to **Optimistic Concurrency Control (OCC)** via `db.runTransaction()`. All reads must precede writes within the transaction scope; Firestore automatically retries if concurrent updates occur.

### 4. Reports & Analytics Aggregations
* **MySQL:** Queries `payments`, `bookings`, `rooms`, and `ledger_items` on demand to calculate RevPAR, ADR, Occupancy Rate, and Total Revenue.
* **Firestore Strategy:** Firestore lacks SQL `SUM()` and `GROUP BY`. Aggregations will be pre-calculated into daily summary documents under `/daily_analytics/{YYYY-MM-DD}` via non-blocking document write triggers (`FieldValue.increment()`).

### 5. Night Audit & Business Date Rollover Logic
* **MySQL:** Centralized in `BusinessDateService.js`. Locks `system_settings` (`system_date`), advances date by +1 day, posts automated tariff charges to occupied room ledgers, and resets daily counters (`today_checkins`, `today_checkouts`).
* **Firestore Strategy:** Executed via a server-side Cloud Function transaction updating `/settings/system_date`, adding sub-collection ledger items to active bookings, and resetting counters in a single atomic batch.

### 6. File & Document Storage Dependencies
* **MySQL:** Local filesystem storage in `backend/guest-documents/` and `backend/inventory-photos/` with paths saved in MySQL columns (`guests.id_document_path`, `inventory_products.photo_url`).
* **Firestore Strategy:** Files stored in Cloud Storage for Firebase (`HPMS-Sky5.appspot.com`), with persistent HTTPS URLs saved in Firestore documents and backfilled to MySQL.

### 7. Real-Time Socket.IO / Polling Dependencies
* **MySQL:** Custom Socket.IO server emitting events (`new_guest_request`, `housekeeping_update`) with HTTP 15s–30s polling fallbacks.
* **Firestore Strategy:** Client applications (`src` and `guest-web`) subscribe directly to Firestore collections via `onSnapshot()` listeners, eliminating Socket.IO server reliance and polling loops.

---

## 3. Comprehensive Table-to-Firestore Mapping Matrix (All 30 Tables)

| # | MySQL Table Name | Proposed Firestore Structure | Relationships / Sub-collections | Primary Read Operations | Primary Write Operations | Transaction Requirements | Indexes Required | Security Rules | Risk Level |
|---|------------------|-----------------------------|---------------------------------|------------------------|-------------------------|--------------------------|------------------|----------------|------------|
| 1 | `roles` | Custom Claims & `/roles/{role_id}` | 1:M with `/users` | Token claim checks, Auth init | Admin setup | None | None | Admin read/write | **LOW** |
| 2 | `permissions` | Custom Claims | M:N with `/roles` | Token claim checks | Admin setup | None | None | Admin read/write | **LOW** |
| 3 | `role_permissions` | Custom Claims array | Dynamic permission mapping | Middleware `hasPermission()` | Admin setup | None | None | Admin read/write | **LOW** |
| 4 | `users` | `/users/{uid}` | 1:1 with `/guests` | User login, RBAC check | Sign up, Staff create | `runTransaction` on Sign up | `email`, `role` | User read self, Admin read/write | **MEDIUM** |
| 5 | `staff` | `/users/{uid}` (field `loginType: 'staff'`) | Independent | Staff login, Staff directory | Create/update staff | None | `username`, `email` | Admin read/write | **LOW** |
| 6 | `guests` | `/guests/{guest_id}` | Linked to `/users/{uid}` | Front desk search, Guest portal | Check-in creation, ID upload | `runTransaction` on check-in | `phone`, `user_uid` | Owner guest read, Staff read/write | **MEDIUM** |
| 7 | `room_types` | `/room_types/{code}` | 1:M with `/rooms` | Pricing calculation, dropdowns | Admin room configuration | None | `code` | Public read, Admin write | **LOW** |
| 8 | `rooms` | `/rooms/{room_id}` | 1:M with `/bookings` | Room grid status, Housekeeping | Status update, Check-in/out | `runTransaction` on Check-in/out | `number`, `status` | Staff read/write | **HIGH** |
| 9 | `bookings` | `/bookings/{booking_id}` | Parent of `ledger_items` & `payments` | Folio viewing, Active stay | Check-in, Check-out update | `runTransaction` on Check-in/out | `booking_number`, `room_id`, `status` | Staff read/write, Guest read self | **HIGH** |
| 10 | `reservations` | `/reservations/{reservation_id}` | Linked to `/bookings/{booking_id}` | Calendar view, Availability check | Reservation booking, Walk-in conversion | `runTransaction` on Check-in conversion | `arrival_date`, `status`, `room_id` | Staff read/write | **HIGH** |
| 11 | `booking_history` | `/bookings/{booking_id}/history/{id}` | Sub-collection of `/bookings` | Stay audit timeline | Log shift, checkin, checkout | `runTransaction` | `created_at` | Staff read-only | **LOW** |
| 12 | `ledger_items` | `/bookings/{booking_id}/ledger_items/{item_id}` | Sub-collection of `/bookings` | Folio billing, Invoice rendering | Add ledger charge, Night audit charge | `runTransaction` on Night Audit | `business_date` | Staff read/write | **HIGH** |
| 13 | `payments` | `/bookings/{booking_id}/payments/{payment_id}` | Sub-collection of `/bookings` | Folio balance, Revenue report | Deposit, Checkout settlement | `runTransaction` on Payment | `business_date`, `payment_method` | Staff read/write | **HIGH** |
| 14 | `invoices` | `/invoices/{invoice_id}` | Linked to `/bookings/{booking_id}` | Print invoice, Billing overview | Generate invoice on checkout | `runTransaction` on Check-out | `invoice_number`, `booking_id` | Staff read/write | **MEDIUM** |
| 15 | `housekeeping` | Field `housekeeping_status` in `/rooms/{room_id}` | Embedded in `/rooms` | Housekeeping grid | Clean room trigger | None | `housekeeping_status` | Housekeeping staff write | **LOW** |
| 16 | `housekeeping_logs` | `/rooms/{room_id}/housekeeping_logs/{id}` | Sub-collection of `/rooms` | Housekeeping history | Log cleaning action | None | `created_at` | Staff read-only | **LOW** |
| 17 | `maintenance` | `/maintenance/{ticket_id}` | Linked to `/rooms/{room_id}` | Maintenance dashboard | Report issue, Update ticket | None | `room_id`, `status` | Staff read/write, Guest write | **LOW** |
| 18 | `room_status_history` | `/room_status_history/{id}` | Standalone audit collection | Room history analytics | Status change log | `runTransaction` | `room_id`, `business_date` | Admin read-only | **LOW** |
| 19 | `audit_logs` | `/audit_logs/{log_id}` | Standalone audit collection | Security audit viewer | Log security actions, Day End | None | `user_id`, `business_date` | Admin read-only | **LOW** |
| 20 | `notifications` | `/notifications/{notification_id}` | Queryable collection | Guest portal alerts | Send guest notification | None | `user_uid`, `created_at` | User read self, Staff write | **LOW** |
| 21 | `cash_logs` | `/cash_logs/{log_id}` | Standalone cash log | Front desk cash balance | Record cash payment/refund | `runTransaction` | `business_date` | Staff read/write | **MEDIUM** |
| 22 | `cash_submissions` | `/cash_submissions/{id}` | Standalone handover log | Shift close overview | Reception cash handover | None | `business_date` | Staff read/write | **LOW** |
| 23 | `system_settings` | `/settings/system_date` & `/settings/config` | Global settings documents | Get Business Date, Counter check | Night Audit rollover, Manual date update | `runTransaction` on Night Audit | None | Public read, Admin write | **HIGH** |
| 24 | `feedback` | `/feedback/{feedback_id}` | Linked to `/bookings` & `/guests` | Guest review dashboard | Guest submit review | None | `booking_id`, `created_at` | Staff read, Guest write self | **LOW** |
| 25 | `stay_extension_requests` | `/stay_extensions/{id}` | Linked to `/bookings` & `/rooms` | Reception requests panel | Guest request, Reception resolve | `runTransaction` on approval | `booking_id`, `status` | Staff write, Guest write self | **MEDIUM** |
| 26 | `razorpay_transactions` | `/payment_gateway_logs/{id}` | Standalone transaction log | Online payment verification | Razorpay webhook trigger | None | `order_id` | Server-side Cloud Function only | **MEDIUM** |
| 27 | `checkout_snapshots` | `/checkout_snapshots/{snapshot_id}` | Immutable backup collection | Recovery validation | Create snapshot before checkout commit | `runTransaction` | `booking_id`, `created_at` | Admin read-only | **MEDIUM** |
| 28 | `inventory_categories` | `/inventory_categories/{id}` | 1:M with `/inventory_products` | Inventory category dropdown | Create/update category | None | `name` | Staff read/write | **LOW** |
| 29 | `inventory_products` | `/inventory_products/{product_id}` | Linked to `/inventory_categories` | Product master, Stock levels | Update stock, Edit product | None | `sku`, `category_id` | Staff read/write | **LOW** |
| 30 | `schema_migrations` | Removed | Deprecated in Firestore | None | None | None | None | N/A | **NONE** |

---

## 4. Workflows & Server-Side vs. Client SDK Scope

### 1. Operations That MUST Remain Server-Side (Cloud Functions / Express API)
To prevent security leaks, race conditions, and key exposure, the following operations must **NEVER** run directly on the client SDK:
* **Check-In (`checkInService.js`):** Requires validation of room vacant state, guest creation, booking creation, initial tariff posting, payment logging, room status update, and counter increment in one atomic transaction.
* **Check-Out (`roomController.js`):** Requires folio balance computation, payment settlement/refund entry, immutable recovery snapshot generation, room dirty status update, and counter increment.
* **Night Audit Rollover (`businessDateService.js`):** Requires business date advancement, duplicate execution validation, occupied room query, and rollover tariff charge posting across all active stays.
* **Razorpay Webhooks & Payment Verification (`razorpayController.js`):** Requires HMAC-SHA256 signature verification using `RAZORPAY_KEY_SECRET`.
* **Tesseract OCR Extraction (`ocrService.js`):** Offloaded worker process for extracting text from Aadhaar/Passport images.

### 2. Operations Suitable for Direct Client SDK Interaction
The following features will utilize direct client-side Firestore SDK with Security Rules:
* **Real-time Housekeeping Dashboard (`/rooms` collection `onSnapshot` listener).**
* **Guest Portal Real-time Notifications (`/notifications` `onSnapshot` listener).**
* **Front Desk Guest Service Requests (`/stay_extensions` `onSnapshot` listener).**
* **Read-only Master Configuration lookup (`/room_types` and `/inventory_categories`).**

---

## 5. Required Composite Indexes for Firestore (`firestore.indexes.json`)

To support complex queries, the following composite indexes will be created in Firestore:

```json
{
  "indexes": [
    {
      "collectionGroup": "bookings",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "room_id", "order": "ASCENDING" },
        { "fieldPath": "booking_status", "order": "ASCENDING" },
        { "fieldPath": "check_in_date", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "reservations",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "room_id", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "arrival_date", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "ledger_items",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "booking_id", "order": "ASCENDING" },
        { "fieldPath": "business_date", "order": "ASCENDING" }
      ]
    }
  ]
}
```

---

## 6. Pre-Implementation Checklist & Safety Verification

Before executing any data migration scripts or creating Firestore collections in subsequent tasks:

- [x] All 30 MySQL tables analyzed and mapped.
- [x] Concurrency locking logic mapped to Firestore OCC `runTransaction()`.
- [x] Sub-collection and document structure defined.
- [x] Server-side vs Client SDK boundaries established.
- [x] Security Rules & Composite Indexes planned.
- [x] **Zero application source files modified.**
- [x] **Zero MySQL queries or schemas modified.**

---

> **Awaiting User Approval to proceed with Task 3.**
