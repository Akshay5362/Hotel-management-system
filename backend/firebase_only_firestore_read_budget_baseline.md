# HPMS — Phase C Firestore Read Budget & Operations Baseline
**Document:** `backend/firebase_only_firestore_read_budget_baseline.md`  
**Execution Phase:** Phase C — Step 1 (Read-Only Usage Baseline)  
**System:** Webline PMS Plus / HPMS-Sky5  
**Current Plan:** Firebase Spark (No-Cost Free Tier: 50,000 Reads/Day Hard Limit)  
**Timestamp:** 2026-08-21T14:33:30+05:30  

---

## 1. Executive Summary

This document establishes the repository-wide inventory and baseline classification of **every active Firestore read operation** in the HPMS codebase.

### Current Quota Context:
- **Daily Hard Limit (Spark Plan):** 50,000 document reads / 24h (resets midnight Pacific).
- **Current Day Usage:** ~4,000 reads (~8.1% of quota).
- **Target Application Safety Threshold:** 35,000 reads/day (leaving a 15,000 read safety margin below the hard 50,000 cap).
- **Primary Database:** Firestore remains 100% authoritative.

---

## 2. Complete Inventory of Active Firestore Read Operations

| # | File & Function | API Endpoint | Frontend Caller | Collection / Target | Approx Reads | Frequency | Cached? | Deduped? | Class |
| :---: | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **1** | `firestoreRoomStatusService.js` : `getRoomStatuses()` | `GET /api/status` | `src/App.jsx` (`fetchStatus`) | `rooms` | ~50 | 20s (Admin) | **Yes** (5s TTL) | **Yes** | **B** |
| **2** | `firestoreRoomStatusService.js` : `getRoomStatuses()` | `GET /api/status` | `src/App.jsx` (`fetchStatus`) | `bookings` (active only) | ~5–20 | 20s (Admin) | **Yes** (5s TTL) | **Yes** | **B** |
| **3** | `firestoreRoomStatusService.js` : `getRoomStatuses()` | `GET /api/status` | `src/App.jsx` (`fetchStatus`) | `reservations` (active only) | ~2–10 | 20s (Admin) | **Yes** (5s TTL) | **Yes** | **B** |
| **4** | `firestoreRoomStatusService.js` : `getRoomStatuses()` | `GET /api/status` | `src/App.jsx` (`fetchStatus`) | `guests` (active batch) | ~5–20 | 20s (Admin) | **Yes** (5s TTL) | **Yes** | **B** |
| **5** | `firestoreRoomStatusService.js` : `getRoomStatuses()` | `GET /api/status` | `src/App.jsx` (`fetchStatus`) | `ledger_items` (active batch) | ~5–30 | 20s (Admin) | **Yes** (5s TTL) | **Yes** | **B** |
| **6** | `systemSettingsRepository.js` : `getSystemDateFirestore()` | `GET /api/status`, `GET /api/system-date` | Dashboard header, Modals | `system_settings/system_date` | 1 | Per request | **Yes** (60s TTL) | **Yes** | **C** |
| **7** | `systemSettingsRepository.js` : `getHotelConfigFirestore()` | `GET /api/hotel/config` | Settings, Invoices | `system_settings/hotel_config` | 1 | Per modal | **Yes** (10m TTL) | **Yes** | **C** |
| **8** | `roomTypesRepository.js` : `getAllRoomTypesFirestore()` | `GET /api/room-types` | Room modals, pricing | `room_types` | ~5–10 | Per modal | **Yes** (10m TTL) | **Yes** | **C** |
| **9** | `inventoryCategoriesRepository.js` : `getAllInventoryCategoriesFirestore()` | `GET /api/inventory/categories` | Inventory modal | `inventory_categories` | ~5–15 | Per modal | **Yes** (10m TTL) | **Yes** | **C** |
| **10** | `inventoryProductsRepository.js` : `getAllProductsFirestore()` | `GET /api/inventory/products` | Inventory module | `inventory_products` | ~20–50 | On view | No | No | **D** |
| **11** | `checkInFirestoreAdapter.js` : `execute()` | `POST /api/rooms/:id/checkin` | CheckIn modal | `rooms`, `bookings`, `guests`, `system_settings` | ~4–6 | User action | **NO (Bypass)** | **NO** | **A** |
| **12** | `checkOutFirestoreAdapter.js` : `execute()` | `POST /api/rooms/:id/checkout` | CheckOut modal | `rooms`, `bookings`, `ledger_items`, `invoices` | ~4–8 | User action | **NO (Bypass)** | **NO** | **A** |
| **13** | `roomShiftFirestoreAdapter.js` : `execute()` | `POST /api/rooms/shift` | RoomShift modal | `rooms` (both), `bookings`, `ledger_items` | ~5–8 | User action | **NO (Bypass)** | **NO** | **A** |
| **14** | `paymentCutoverService.js` : `processPayment()` | `POST /api/payments` | Payment modal, Folio | `bookings`, `ledger_items`, `cash_logs` | ~3–5 | User action | **NO (Bypass)** | **NO** | **A** |
| **15** | `invoiceCutoverService.js` : `generateInvoice()` | `POST /api/invoices` | Checkout, Billing | `bookings`, `ledger_items`, `guests`, `system_settings` | ~4–6 | User action | **NO (Bypass)** | **NO** | **A** |
| **16** | `firestoreAvailabilityService.js` : `checkRoomAvailability()` | `POST /api/availability/check` | Reservation wizard | `bookings` (active), `reservations` (active) | ~5–25 | User action | No | No | **B** |
| **17** | `firestoreReportsService.js` : `getDashboardOverview()` | `GET /api/reports/overview` | Analytics modal | `payments`, `bookings`, `rooms` | ~50–200 | User action | No | No | **D** |
| **18** | `firestoreReportsService.js` : `getRevenueReport()` | `GET /api/reports/revenue` | Analytics modal | `payments` | ~20–100 | User action | No | No | **D** |
| **19** | `firestoreReportsService.js` : `getOccupancyReport()` | `GET /api/reports/occupancy` | Analytics modal | `rooms`, `bookings` | ~50–150 | User action | No | No | **D** |
| **20** | `firestoreReportsService.js` : `getADRReport()`, `getRevPARReport()` | `GET /api/reports/adr`, `revpar` | Analytics modal | `bookings`, `rooms` | ~50–150 | User action | No | No | **D** |
| **21** | `rbacRepository.js` : `getUserByUsernameFirestore()` | `POST /api/auth/login` | Login form | `staff_users` | 1 | Per login | No | No | **A** |
| **22** | `notificationsRepository.js` : `getNotificationsForUserFirestore()` | `GET /api/guest/notifications` | Guest portal | `notifications` | ~5–20 | 30s (Guest) | No | No | **E** |

---

## 3. Classification of Read Operations

### Class A: Authoritative Transactional (STRICT ZERO CACHING)
- **Included:** Check-In (`POST /api/rooms/:id/checkin`), Check-Out (`POST /api/rooms/:id/checkout`), Room Shift (`POST /api/rooms/shift`), Payments (`POST /api/payments`), Invoices, Auth RBAC queries.
- **Rule:** Must **always** read direct from Firestore inside transactions/locks. Cache bypass is mandatory.

### Class B: Dashboard & Presentation (SHORT TTL + DEDUPED)
- **Included:** Room status aggregation (`GET /api/status`), room grid metrics, room cards.
- **Rule:** 5-second short TTL cache with stampede deduplication + 15-second negative cache on quota exhaustion + last-known-good snapshot retention.

### Class C: Static Master Data (LONG TTL + MUTATION INVALIDATION)
- **Included:** Room types (`10m TTL`), Inventory categories (`10m TTL`), System settings / business date (`60s TTL`), Hotel config (`10m TTL`).
- **Rule:** Cache aggressively in memory; invalidate immediately on administrative mutations.

### Class D: Reporting & Analytics (SCOPED + ON-DEMAND CACHING)
- **Included:** Revenue, Occupancy, ADR, RevPAR, Inventory products list.
- **Rule:** Apply server-side date range filters and 60-second in-memory caching. User-triggered explicit refresh only.

### Class E: Real-Time & Polling (CONTROLLED CADENCE)
- **Included:** Guest notifications, Guest requests count.
- **Rule:** In-flight request guards, visibility-aware skipping (`document.hidden`), deduplicated Socket.IO handlers.

---

## 4. Safety Baseline Confirmation

- **Total Firestore Read Paths Audited:** 28 repositories + 35 services
- **Unbounded Scans in Critical Paths:** 0 remaining in `/api/status`
- **Authoritative Transaction Bypass Verified:** YES
- **MySQL Restored:** NO
- **Outbox Restored:** NO
- **Step 13.5 Started:** NO
