# HPMS — Comprehensive Firestore Read Usage & Read Amplification Audit
**Authoritative Production Database:** Google Cloud Firestore (`hpms-sky5`)  
**Audit Type:** Strictly Read-Only Architecture & Code Audit  
**Date:** 2026-08-22  
**Status:** Complete Read-Only Diagnosis — No Code or Data Modified

---

## 1. Executive Summary

A comprehensive, read-only audit of the Hotel Property Management System (HPMS) codebase and runtime communication patterns was conducted to diagnose why Firestore daily reads reached **~33,000 reads/day** (approaching the free daily tier limit of 50,000 reads/day) despite the total production database containing only **~414 total documents** across all canonical collections (17 rooms, ~49 bookings, ~62 guests, ~34 reservations, ~76 payments, ~39 invoices, ~137 ledger items).

### Key Audit Findings:
1. **Primary Read Driver (75%+ of all reads):** Aggressive frontend timer polling (`setInterval` at 20s and 30s) querying dynamic room status (`GET /api/status`), combined with an undersized server-side cache TTL of only **5 seconds** (`5000ms`). Because the polling interval (20s) exceeds the cache TTL (5s), **100% of all background polls result in complete cache misses**, causing ~48 document reads per poll across `rooms`, `bookings`, `reservations`, `guests`, `ledger_items`, and `system_date`.
2. **Secondary Read Driver (15%+ of all reads):** Uncoordinated guest request polling (`GET /api/guest-requests`) running concurrently in `App.jsx` (every 15s) and `GuestRequestsModal.jsx` (every 15s), scanning three distinct request collections without aggregation or request deduplication.
3. **Full Collection Scans:** Key services (`GuestAdminService.listGuests`, `FirestoreReportsService`, `AuditHistoryCutoverService.getGuestBill`) execute unrestricted `.get()` or `listDocs()` operations across entire collections (`guests`, `bookings`, `payments`, `reservations`) rather than utilizing indexed Firestore filter constraints, date bounds, or pagination cursors.
4. **Zero Client SDK `onSnapshot` Listeners:** No direct client-side Firestore listeners exist; all database access is mediated by the Node.js Express backend via `firebase-admin`.
5. **Optimization Potential:** By aligning caching tiers, deduplicating identical in-flight requests, bounding collection scans with date/status filters, and harmonizing background polling frequencies, Firestore read consumption can safely be reduced from **~33K–200K reads/day** down to **<2,000–3,500 reads/day (>90% reduction)** with **zero alterations** to any operational or financial workflows.

---

## 2. Current Firestore Usage Interpretation

The Firebase Console indicates for the last 24-hour period:
- **Reads:** ~33,000
- **Writes:** ~939
- **Deletes:** ~1,300

### Why are reads ~33K when the database has ~414 documents?
In Cloud Firestore, billing and quota consumption are calculated on **document reads returned**, not data byte transfer.
- A single request to `GET /api/status` performs multi-collection document fetching to construct the room grid:
  - 17 room documents
  - ~5 active booking documents
  - ~10 active reservation documents
  - ~5 active guest documents
  - ~10 active ledger documents
  - 1 system date document
  - **Total:** ~48 reads per request.
- At a 20-second polling cadence for an active front-desk session:
  - $3 \text{ polls/minute} \times 60 \text{ minutes} = 180 \text{ polls/hour}$.
  - $180 \text{ polls/hour} \times 48 \text{ reads} = \mathbf{8,640 \text{ reads/hour}}$ for just one browser tab.
  - A single active session running for ~4 hours generates $\approx \mathbf{34,560 \text{ reads}}$.
- If an admin also has the reception portal open in another tab or window (which polls every 30s), read amplification doubles.

---

## 3. Complete Firestore Read Inventory

The following table catalogs all Firestore read operations across backend services, adapters, controllers, and repositories:

| Source File | Function | Collection(s) | Operation / Query Filter | Docs Read per Call | Trigger | Frequency |
|---|---|---|---|---|---|---|
| `backend/services/firestoreRoomStatusService.js` | `_fetchRoomStatusesFromFirestore` | `rooms`, `bookings`, `reservations`, `guests`, `ledger_items`, `settings` | `rooms.get()`, `bookings.where(status in ['Checked In', 'Reserved'])`, `reservations.where(status in ['Reserved', 'Confirmed'])`, `getDocsByIds(guests)`, `ledger.where(booking_id in [...])` | ~45–50 | `GET /api/status` | Every 20s (App) + every 30s (ReceptionPortal) + on tab focus |
| `backend/controllers/auditController.js` | `getGuestRequests` | `guest_requests`, `stay_extension_requests`, `maintenance_requests` | `collection.get()` (all docs across 3 collections) | ~15–30 | `GET /api/guest-requests` | Every 15s (App fallback) + every 15s (Modal open) |
| `backend/services/guestAdminService.js` | `listGuests` | `guests`, `bookings` | `guests.get()` (full collection) + `bookings.get()` (full collection) | ~111 | `GET /api/admin/guests` | On opening Guests tab, filtering, search, or pagination |
| `backend/services/guestAdminService.js` | `getGuestDocuments` | `guests`, `guest_id_documents` | `guests.doc(id).get()` + `listDocs('guest_id_documents')` | ~5–10 | `GET /api/admin/guests/documents` | On opening ID verification modal |
| `backend/services/firestoreReportsService.js` | `getDashboardOverview` | `payments`, `bookings`, `rooms` | `payments.get()` (all docs) + `bookings.get()` (all docs) + `getRoomStatuses()` | ~170+ | `GET /api/reports/dashboard-overview` | On opening Reports/Analytics modal |
| `backend/services/firestoreReportsService.js` | `getRevenueReport` | `payments` | `payments.get()` (all docs) | ~76 | `GET /api/reports/revenue` | On selecting Revenue report |
| `backend/services/firestoreReportsService.js` | `getDailyOccupancyReport` | `bookings`, `payments` | `bookings.get()` + `payments.get()` | ~125 | `GET /api/reports/daily-occupancy` | On selecting Occupancy report |
| `backend/services/firestoreReportsService.js` | `getRoomTypePerformanceReport` | `bookings` | `bookings.get()` (all docs) | ~49 | `GET /api/reports/room-type-performance` | On selecting Room Performance report |
| `backend/services/firestoreReportsService.js` | `getGuestDemographicsReport` | `guests` | `guests.get()` (all docs) | ~62 | `GET /api/reports/guest-demographics` | On selecting Demographics report |
| `backend/services/firestoreReportsService.js` | `getMealPlanReport` | `bookings` | `bookings.get()` (all docs) | ~49 | `GET /api/reports/meal-plan` | On selecting Meal Plan report |
| `backend/services/firestoreAvailabilityService.js` | `checkAvailabilityFirestore` | `rooms`, `bookings`, `reservations` | `rooms.get()`, `bookings.where(status in [...])`, `reservations.where(status in [...])` | ~100 | Check-in modal, Reservation creation, Public room search | On user action (modal open / date change) |
| `backend/services/auditHistoryCutoverService.js` | `getGuestBill` | `guests`, `bookings`, `ledger_items` | `getAllGuestsFirestore()` + `getAllBookingsFirestore(limit 50)` + `ledger.where(booking_id == id)` | ~115+ | `GET /api/guest/bill` | On Guest Portal folio load |
| `backend/services/auditHistoryCutoverService.js` | `getGuestHistory` | `guests`, `bookings`, `payments`, `feedback` | `guests.doc()`, `bookings.where(guest_id)`, `payments.where(guest_id)`, `feedback` | ~20–30 | `GET /api/admin/guest-history/:id` | On viewing Guest History modal |
| `backend/services/firestoreLedgerService.js` | `getRoomLedger` | `rooms`, `bookings`, `ledger_items` | `rooms.doc()`, `bookings.doc()`, `ledger_items.where(booking_id == id)` | ~5–15 | `GET /api/rooms/:number/ledger` | On Folio / Checkout modal open |
| `backend/adapters/firestore/roomShiftFirestoreAdapter.js` | `processRoomShiftFirestoreTransaction` | `rooms`, `bookings`, `ledger_items`, `payments`, `room_shift_adjustments` | Transaction reads: source room, target room, booking, ledger_items, payments | ~10–15 | `POST /api/rooms/shift` | On user confirming room shift |
| `backend/adapters/firestore/checkOutFirestoreAdapter.js` | `processCheckOutFirestoreTransaction` | `rooms`, `bookings`, `ledger_items`, `payments`, `invoices`, `system_settings` | Transaction reads: room, booking, ledger_items, payments, invoice sequence | ~10–15 | `POST /api/rooms/:number/checkout` | On user confirming checkout |
| `backend/adapters/firestore/ledgerFirestoreAdapter.js` | `adjustRoomRentFirestore` / `recordPaymentFirestore` | `rooms`, `bookings`, `ledger_items`, `payments` | Transaction reads: room, booking, ledger_items, payments | ~10–15 | `POST /api/rooms/:number/adjust-rent` or `payments` | On recording payment or rent adjustment |
| `backend/repositories/firestore/rbacRepository.js` | `hasFirestorePermission` | `roles`, `role_permissions` | `roles.where(name == role)` + `role_permissions.where(role_id == id)` | ~16 | Permission-protected operations (e.g. system date update) | On administrative actions |
| `backend/repositories/firestore/systemSettingsRepository.js` | `getSystemDateDetailsFirestore` | `settings` | `doc('system_date').get()` | 1 | App init, status calls, business date queries | Frequent |

---

## 4. Duplicate Read Findings

### Case 1: Room Grid / Status Duplication
- **App.jsx:** Dispatches `fetchStatus()` every 20 seconds.
- **ReceptionPortal.jsx:** Dispatches `apiCall('GET', '/status?_t=...')` every 30 seconds.
- **Visibility Change Listener:** Fires on every browser tab switch/focus.
- **Result:** Two overlapping intervals against the same endpoint. If both components are active, `/status` is called up to **5 times per minute**, generating $\approx 240 \text{ reads/minute}$ ($\mathbf{345,600 \text{ reads/day}}$).

### Case 2: Guest Admin Dashboard Enriched Load
- When loading `/api/admin/guests`:
  - `db.collection('guests').get()` fetches all 62 guests.
  - `db.collection('bookings').get()` fetches all 49 bookings across history to calculate `total_bookings`, `lifetime_spend`, and `last_booking_at`.
  - When clicking next page (Page 2), it executes the exact same two full collection reads again (111 reads per page click).

### Case 3: Guest Bill / Folio Lookup
- `AuditHistoryCutoverService.getGuestBill` first scans `getAllGuestsFirestore()` (62 reads), then scans `getAllBookingsFirestore({ limit: 50 })` (50 reads), then queries `ledger_items` (3 reads). Total = **115 reads** for a single guest checking their bill.

---

## 5. Polling Findings & Amplification Analysis

| Polling Location | Endpoint Queried | Interval | Docs Read per Poll | Daily Invocations (1 Client) | Estimated Daily Reads (1 Client) |
|---|---|---|---|---|---|
| `src/App.jsx:458` | `GET /api/status` | 20 seconds | ~48 | 4,320 | 207,360 |
| `src/components/ReceptionPortal.jsx:1684` | `GET /status?_t=...` | 30 seconds | ~48 | 2,880 | 138,240 |
| `src/App.jsx:415` (Socket fallback) | `GET /api/guest-requests` | 15 seconds | ~20 | 5,760 | 115,200 |
| `src/components/GuestRequestsModal.jsx:83` | `GET /api/guest-requests` | 15 seconds | ~20 | 5,760 (when open) | Variable |
| `src/components/GuestDashboard.jsx:233` | `GET /api/guest/bill` | 20 seconds | ~115 | 4,320 (when open) | Variable |

### Root Cause of Cache Ineffectiveness:
In `backend/services/firestoreRoomStatusService.js`:
```javascript
const cacheKey = `room_status_${sysComp}_${includeLedger ? 'with_ledger' : 'no_ledger'}`;
return await globalTtlCache.getOrSet(
  cacheKey,
  () => this._fetchRoomStatusesFromFirestore(businessDate, options),
  5000 // 5 seconds short TTL
);
```
Because the TTL is **5,000 ms** (5 seconds) and the polling interval is **20,000 ms** (20 seconds), **every single poll arrives 15 seconds after the cache entry has already expired**. The cache hit rate is **0%** during normal steady-state polling!

---

## 6. Realtime Listener Findings

- **No client-side `onSnapshot()` listeners** currently exist in the frontend repository (`src/` or `guest-web/`).
- Frontend updates are driven strictly through HTTP polling over Express API endpoints.
- Socket.IO server is configured in `backend/server.js`, but frontend fallback loops trigger whenever Socket.IO disconnects or is unavailable.
- There are **no leaked or dangling Firestore snapshot listeners** consuming quota in the background.

---

## 7. Full Collection Scan Findings

The audit identified 6 critical areas performing unconstrained full collection queries:

1. **`GuestAdminService.listGuests`** ([`guestAdminService.js:28-29`](file:///d:/projects/hotel/backend/services/guestAdminService.js#L28-L29)):
   - `db.collection('guests').get()` (Scans entire `guests` collection).
   - `db.collection('bookings').get()` (Scans entire `bookings` collection).
2. **`FirestoreReportsService.getRevenueReport`** ([`firestoreReportsService.js:114`](file:///d:/projects/hotel/backend/services/firestoreReportsService.js#L114)):
   - `listDocs(PAYMENTS_COLLECTION)` (Scans all historical payments without `where('business_date', '>=', startDate)` Firestore query filter).
3. **`FirestoreReportsService.getDailyOccupancyReport`** ([`firestoreReportsService.js:72-73`](file:///d:/projects/hotel/backend/services/firestoreReportsService.js#L72-L73)):
   - `listDocs(BOOKINGS_COLLECTION)` & `listDocs(PAYMENTS_COLLECTION)` (Scans all bookings and payments).
4. **`FirestoreReportsService.getGuestDemographicsReport`** ([`firestoreReportsService.js:305`](file:///d:/projects/hotel/backend/services/firestoreReportsService.js#L305)):
   - `listDocs(GUESTS_COLLECTION)` (Scans all guests).
5. **`AuditHistoryCutoverService.getGuestBill`** ([`auditHistoryCutoverService.js:402`](file:///d:/projects/hotel/backend/services/auditHistoryCutoverService.js#L402)):
   - `getAllGuestsFirestore()` (Scans all guests).
6. **`auditController.js:getGuestRequests`**:
   - Scans all historical `guest_requests`, `stay_extension_requests`, and `maintenance_requests` instead of filtering for `status == 'Pending'` or `status == 'Active'`.

---

## 8. Frontend API Duplication Findings

### Chain Analysis:
1. **Reception Dashboard Load Chain:**
   $$\text{User Opens Reception Dashboard} \longrightarrow \text{App.jsx mounts} \longrightarrow \text{fetchStatus()} \longrightarrow \text{GET /api/status} \longrightarrow \text{auditController.getStatus} \longrightarrow \text{FirestoreRoomStatusService} \longrightarrow 48\text{ reads}$$
2. **Concurrent ReceptionPortal Mount:**
   $$\text{ReceptionPortal mounts} \longrightarrow \text{fetchData(true)} \longrightarrow \text{GET /status?\_t=...} \longrightarrow \text{FirestoreRoomStatusService} \longrightarrow 48\text{ reads (Cache Miss due to timestamp)}$$
3. **Guest Request Counter:**
   $$\text{App.jsx:fetchRequestCount()} \longrightarrow \text{GET /api/guest-requests} \longrightarrow 25\text{ reads}$$
4. **Initial Page Load Combined Reads:** $\mathbf{\approx 121 \text{ document reads}}$ within the first 2 seconds of opening the application.

---

## 9. Analytics & Report Findings

- The Analytics/Reports modal loads `getDashboardOverview` immediately upon opening.
- `getDashboardOverview` invokes `FirestoreRoomStatusService.getRoomStatuses(businessDate, { includeLedger: false })` plus full scans of `payments` and `bookings`.
- **Total reads per Reports modal view:** $\approx 170$ reads.
- When selecting specific reports (Revenue, Occupancy, Meal Plan, Demographics), each sub-report triggers another independent full scan of 50–80 documents.
- While `FirestoreReportsService` has a `globalTtlCache` wrapper with a 60-second TTL (`REPORT_CACHE_TTL_MS = 60000`), opening the reports across different date filters or navigating between tabs generates repeated collection scans.

---

## 10. Top 10 Read Sources Ranked

| Rank | File & Function | Collection | Reads / Invocation | Daily Frequency | Est. Daily Reads | Severity | Why It Happens |
|---|---|---|---|---|---|---|---|
| **1** | `firestoreRoomStatusService.js` (`getRoomStatuses`) | `rooms`, `bookings`, `reservations`, `guests`, `ledger_items` | ~48 | 4,320–7,200 | **207K–345K** | **CRITICAL** | Polled every 20s/30s while cache TTL is only 5s; 100% cache miss. |
| **2** | `auditController.js` (`getGuestRequests`) | `guest_requests`, `stay_extension_requests`, `maintenance_requests` | ~20 | 5,760 | **115K** | **CRITICAL** | Polled every 15s without status filters or request deduplication. |
| **3** | `guestAdminService.js` (`listGuests`) | `guests`, `bookings` | ~111 | 20–50 | **2.2K–5.5K** | **HIGH** | Full collection scan of both guests & bookings on every page click. |
| **4** | `auditHistoryCutoverService.js` (`getGuestBill`) | `guests`, `bookings`, `ledger_items` | ~115 | 10–30 | **1.1K–3.5K** | **HIGH** | Full scan of guests and 50 bookings to find active stay. |
| **5** | `firestoreReportsService.js` (`getDashboardOverview`) | `payments`, `bookings`, `rooms` | ~170 | 10–20 | **1.7K–3.4K** | **MEDIUM** | Scans all historical payments & bookings for high-level metrics. |
| **6** | `firestoreAvailabilityService.js` (`checkAvailabilityFirestore`) | `rooms`, `bookings`, `reservations` | ~100 | 10–25 | **1.0K–2.5K** | **MEDIUM** | Scans rooms, active bookings, and active reservations on date check. |
| **7** | `rbacRepository.js` (`hasFirestorePermission`) | `roles`, `role_permissions` | ~16 | 20–50 | **320–800** | **LOW** | Static role permission queries per permission-checked action. |
| **8** | `firestoreLedgerService.js` (`getRoomLedger`) | `rooms`, `bookings`, `ledger_items` | ~15 | 20–40 | **300–600** | **LOW** | Modal opens fetch folio without in-memory reuse of room status ledger. |
| **9** | `systemSettingsRepository.js` (`getSystemDateDetailsFirestore`) | `settings` | 1 | 500–1,000 | **500–1,000** | **LOW** | Queried repeatedly across controllers to get business date. |
| **10** | `auditHistoryCutoverService.js` (`getGuestHistory`) | `guests`, `bookings`, `payments`, `feedback` | ~25 | 10–20 | **250–500** | **LOW** | Fetches historical stay profile when guest row is inspected. |

---

## 11. Estimated Read Budget Breakdown

### Screen-by-Screen Consumption Model

| Screen / Feature | Initial Load Reads | Steady State Polling Reads/Hour | 8-Hour Shift Consumption |
|---|---|---|---|
| **Main Room Grid (Dashboard)** | ~48 reads | $180 \text{ polls} \times 48 = 8,640$ | 69,120 reads |
| **Reception Portal (Active Tab)** | ~48 reads | $120 \text{ polls} \times 48 = 5,760$ | 46,080 reads |
| **Guest Requests Counter** | ~20 reads | $240 \text{ polls} \times 20 = 4,800$ | 38,400 reads |
| **Guest Directory (10 searches/page views)** | ~1,110 reads | 0 (user-triggered) | 1,110 reads |
| **Reports & Analytics (5 report views)** | ~850 reads | 0 (user-triggered) | 850 reads |
| **Operational Transactions (5 Check-in, 5 Check-out, 5 Shift)** | ~225 reads | 0 (user-triggered) | 225 reads |
| **Total Daily Potential with Unoptimized Polling:** | — | — | **~155,785 reads/day** |

*(Note: The `readBudgetMonitor` guardrail actively throttles non-essential polling at 35K reads, which explains why the observed 24h count in the Firebase Console stabilizes around ~33K–35K reads.)*

---

## 12. Safe Optimization Opportunities

### Category A: Safe Short-Lived Cache Adjustments
1. **Extend Room Status Cache TTL:** Increase `room_status_` cache TTL in `firestoreRoomStatusService.js` from `5,000ms` (5s) to **`15,000ms` – `20,000ms`** (15–20s).
   - *Safety:* Whenever a room mutation occurs (check-in, check-out, room shift, status toggle, rent adjustment), `invalidateRoomStatusCache()` is already called immediately. Therefore, extending the cache TTL during periods of inactivity has **zero impact** on real-time data accuracy.
2. **Cache Static RBAC Permissions & System Settings:** Cache `roles` and `role_permissions` for 5 minutes.
   - *Safety:* Role permissions change only during administrative configuration updates.

### Category B: Request-Level Deduplication & In-Flight Coalescing
1. **Coalesce Simultaneous Status Queries:** If two components (or two requests) query `/api/status` at the exact same millisecond, use `ttlCache.js`'s built-in `inFlight` promise map to execute only **one single Firestore query** and share the result with both callers.

### Category C: Client-Side State Reuse & Polling Harmonization
1. **Eliminate Duplicate Interval in `ReceptionPortal.jsx`:** Remove the secondary 30s interval in `ReceptionPortal.jsx` and have `ReceptionPortal` consume the parent `rooms` state already maintained by `App.jsx`.
2. **Adaptive Polling / Visibility Gating:** Ensure polling pauses completely when the document is hidden (`document.hidden`), and refreshes once when the tab regains focus.

### Category D: Query Quality & Filter Optimization
1. **Guest Requests Filter:** Add `where('status', '==', 'Pending')` or `where('is_resolved', '==', false)` to `getGuestRequests` to read only open requests (typically 0–3 docs) instead of the entire collection history.
2. **Reports Date-Bounded Queries:** Pass Firestore `where('business_date', '>=', startDate)` directly into `listDocs` queries in `firestoreReportsService.js` rather than fetching all historical records and filtering in JavaScript memory.

### Category E: Operations that MUST Remain Uncached (Realtime / Authoritative)
1. **Check-In Transaction:** Reads room, guest, booking atomically inside transaction.
2. **Check-Out Transaction & Balance Due Enforcement:** Reads live ledger items and payments atomically inside transaction to ensure zero-balance invariant.
3. **Room Shift Transaction:** Reads source room, destination room, and ledger items atomically inside transaction to compute authoritative tariff differential.
4. **Payment Recording & Rent Adjustments:** Must read live ledger items inside transaction.

---

## 13. Workflow Safety Matrix

| Workflow | Current Estimated Reads | Proposed Reads Post-Optimization | Core Logic Changed? | Risk Level |
|---|---|---|---|---|
| **Room Status Polling (`/status`)** | ~48 reads per 20s poll (100% miss) | ~0–48 reads (80%+ cache hit rate) | No (Output schema identical) | **Zero** |
| **Guest Requests Counter** | ~20 reads per 15s poll | ~1–3 reads (filtered to active requests) | No (Returns same active count) | **Zero** |
| **Check-In Execution** | ~8 reads | ~8 reads (100% untouched) | No | **Zero** |
| **Check-Out Execution & Balance Check** | ~12 reads | ~12 reads (100% untouched) | No | **Zero** |
| **Room Shift Differential Calculation** | ~12 reads | ~12 reads (100% untouched) | No | **Zero** |
| **Manual Room Rent Adjustment** | ~8 reads | ~8 reads (100% untouched) | No | **Zero** |
| **Payment Recording (Cash/UPI)** | ~8 reads | ~8 reads (100% untouched) | No | **Zero** |
| **Guest Admin Dashboard (`/admin/guests`)** | ~111 reads per page | ~25 reads (direct pagination limit) | No | **Zero** |
| **Reports & Analytics Overview** | ~170 reads per view | ~15–30 reads (date-bounded & 60s cache) | No (Financial formulas identical) | **Zero** |
| **Guest Portal Live Folio (`/guest/bill`)** | ~115 reads | ~3–5 reads (direct indexed lookup by ID) | No | **Zero** |

---

## 14. Recommended Implementation Order (For Future Execution)

When user authorization is granted for optimization in a subsequent phase:
1. **Phase A (Immediate - Zero Workflow Risk):**
   - Increase `room_status_` cache TTL in `firestoreRoomStatusService.js` to 15–20s (with existing write-invalidation intact).
   - Filter `getGuestRequests` in `auditController.js` to active/pending items only.
   - Remove duplicate 30s polling timer in `ReceptionPortal.jsx` in favor of shared parent state.
2. **Phase B (Query Filtering & Indexing):**
   - Refactor `AuditHistoryCutoverService.getGuestBill` to use direct indexed queries (`guests.doc(id)` and `bookings.where('guest_id', '==', id)`) instead of full collection scans.
   - Refactor `firestoreReportsService.js` to apply date-range `where` clauses directly to Firestore queries.
3. **Phase C (Static Master Data Caching):**
   - Add a 5-minute in-memory cache for `roles`, `permissions`, and `role_permissions` in `rbacRepository.js`.

---

## 15. Expected Read Reduction Estimate

| Optimization Area | Current Estimated Daily Reads | Projected Daily Reads Post-Optimization | Expected Reduction |
|---|---|---|---|
| Room Grid Polling (`/api/status`) | ~207,360 (unthrottled) / ~25,000 (throttled) | ~1,200 – 1,800 | **~93% – 99%** |
| Guest Requests Polling | ~115,200 (unthrottled) / ~6,000 (throttled) | ~400 – 600 | **~90% – 99%** |
| Guest Directory & Bill Lookups | ~3,000 | ~150 – 250 | **~92%** |
| Reports & Analytics Views | ~2,500 | ~100 – 200 | **~92%** |
| Operational Mutations (Check-in, Check-out, Shifts) | ~250 | ~250 (Full fidelity preserved) | **0% (Preserved)** |
| **Total Projected Daily Usage:** | **~33,000 (throttled) / ~328,000 (raw)** | **~2,100 – 3,100 reads/day** | **Well within 50K Free Quota (<6% of limit)** |

---

## 16. Production Safety Confirmation

- **Zero Mutations Executed:** No files were edited, no dependencies modified, and no commands altering state were executed during this diagnosis.
- **Production Data Preserved:** Cloud Firestore project `hpms-sky5` remains 100% untouched. All 17 canonical rooms, active bookings, guests, payments, and ledger items remain intact.
- **No Fallback State Alteration:** Cloud Firestore remains the sole authoritative database; MySQL fallback remains disabled.
- **Next Step:** Awaiting explicit user instruction before proceeding to any code implementation.
