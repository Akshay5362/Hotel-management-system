# HPMS — Status API Request Storm & HTTP 503 Loop Diagnostic Audit
**Document:** `backend/firebase_only_status_request_storm_audit.md`  
**Execution Mode:** READ-ONLY INVESTIGATION (Zero Mutations / Zero Restorations)  
**System:** Webline PMS Plus / HPMS-Sky5  
**Timestamp:** 2026-08-21T12:00:30+05:30  

---

## 1. Executive Summary

A comprehensive read-only audit of all frontend and backend `/api/status` invocation chains, effect lifecycles, timer registrations, and error handling paths has been performed.

### Key Finding:
1. **HTTP 503 Cause:** When the backend process starts (or restarts), the in-memory `lastKnownGoodStatusSnapshot` is initially `null`. Because the Firestore daily quota on project `hpms-sky5` was exhausted, the initial query fails with `8 RESOURCE_EXHAUSTED`. With no prior snapshot available in process memory, `auditController.getStatus` returns `HTTP 503 Service Unavailable`.
2. **Negative Cache Gap:** `TtlCache.getOrSet` does not cache failed loader executions. Consequently, every incoming `/api/status` request bypasses the cache and repeats the failing Firestore gRPC request.
3. **Frontend Network Error Log:** In `src/App.jsx`, when `/api/status` requests encounter a 5000ms `AbortController` timeout or when multiple overlapping fetches occur, the promise rejection enters `catch (err)`, which logs `[API Network Error] Backend unreachable / connection error` and executes `setIsBackendOnline(false)`.
4. **Multiple Concurrent Timers & Polling Triggers:** Multiple independent `useEffect` hooks in `src/App.jsx` and child modules (`ReceptionPortal.jsx`, `GuestDashboard.jsx`) register duplicate interval timers and immediate mount calls.

---

## 2. Complete Inventory of All `/api/status` Callers

| Caller Location | Component / Function | Line | Trigger | Frequency / Condition | Concurrency & Timer Risk |
| :--- | :--- | :---: | :--- | :--- | :--- |
| **`src/App.jsx`** | `poll()` in `useEffect` | 443–444 | Admin tab active; interval poll | Every **20 seconds** + immediate on mount + on tab visible | Multiple renders can register duplicate intervals if dependencies mutate |
| **`src/App.jsx`** | `useEffect` (auth init) | 464 | `adminToken` or `guestToken` present | Immediate on mount / token change | Runs concurrently with `poll()` |
| **`src/App.jsx`** | `businessDateChanged` | 470 | Custom event from date adjustment | On demand | Non-debounced |
| **`src/App.jsx`** | `factoryResetComplete` | 477 | Custom event from settings | On demand | Non-debounced |
| **`src/App.jsx`** | `handleRoomClick` | 514 | Direct room card click | User action | Direct inline `fetch('/status')` |
| **`src/App.jsx`** | `handleActionClick('checkout')` | 562 | Checkout modal open | User action | Direct inline `fetch('/status')` |
| **`src/App.jsx`** | Modal closures & actions | 629, 670, 718, 742, 754, 784, 830, 853, 879, 914, 936, 1370 | Shift, Cash, DayEnd, RoomStatus, etc. | User actions | Calls `fetchStatus()` |
| **`ReceptionPortal.jsx`** | `fetchData` in `useEffect` | 1589, 1604 | Reception dashboard mounted | Immediate on mount + every **30 seconds** | Independent timer from `App.jsx` |
| **`GuestDashboard.jsx`** | `useEffect` (tab switch) | 135 | Tab switch (`dashTab`) | On tab change | Fires on every tab navigation |
| **`GuestDashboard.jsx`** | `useEffect` (mount) | 143 | Guest token present | Immediate on mount | Runs on guest portal load |
| **`GuestDashboard.jsx`** | `useEffect` (poll) | 178 | Guest session active | Every **30 seconds** | Independent timer |
| **`GuestBookingWizard.jsx`** | Booking/Payment completion | 420, 439 | Post-booking | User action | On demand |
| **`ReservationModule.jsx`** | Create/Update/Cancel | 163, 200, 236, 270 | Reservation edits | User action | On demand |

---

## 3. Actual Polling Interval & Rate Calculation

- **Baseline Interval (Admin):** 1 request per 20 seconds.
- **Clock Runner Interaction:** `src/App.jsx` line 503 runs `setInterval(updateTime, 1000)` which triggers a state update on `currentTime` every **1 second**.
- **Theoretical Worst-Case Request Rate:**
  - Single Admin Tab: 1 request / 20s (normal) + mount bursts (2 requests at t=0).
  - Multi-Tab / Multi-Role: If an admin tab and a reception tab are open simultaneously, intervals fire at 20s and 30s asynchronously.
  - If a 5000ms timeout occurs due to slow gRPC Firestore response, pending requests queue up and overlap, giving the appearance of rapid successive errors.

---

## 4. Request Lifecycle & Feedback Loop Analysis

```
1. App mounts / Auth token loaded
   │
   ├──> Effect 1 (poll) triggers immediate fetchStatus()
   └──> Effect 2 (auth init) triggers immediate fetchStatus()
        │
        ▼
2. GET /api/status sent to Backend (Port 5000)
   │
   ├──> FirestoreRoomStatusService queries Firestore
   └──> Firestore throws code 8: RESOURCE_EXHAUSTED (Quota exceeded)
        │
        ▼
3. auditController.getStatus checks lastKnownGoodStatusSnapshot
   │
   ├──> Snapshot is null (clean process start, no previous success)
   └──> Responds with HTTP 503 {"code": "FIRESTORE_RESOURCE_EXHAUSTED"}
        │
        ▼
4. Frontend receives HTTP 503
   │
   ├──> If response received within 5s:
   │    App.jsx sets dataStatus='degraded', staleReason='FIRESTORE_RESOURCE_EXHAUSTED'
   │    MetricsBar displays "System: Online (Database Quota Reached)"
   │
   └──> If response exceeds 5s timeout:
        AbortController triggers controller.abort()
        Promise rejects with AbortError
        catch (err) executes:
          console.error('[API Network Error] Backend unreachable / connection error')
          setIsBackendOnline(false)
```

---

## 5. Socket.IO Audit

- **Socket.IO Server Connection:** Connects to `http://localhost:5000` via `io(SOCKET_URL)` in `src/App.jsx` (line 386) and `AdminHousekeeping.jsx` (line 38).
- **Events Handled:**
  - `new_guest_request`: Calls `fetchRequestCount()` (fetches `/api/admin/guest-requests`, **not** `/api/status`).
  - `housekeeping_update`: In `AdminHousekeeping.jsx`, calls `fetchRooms()` (fetches `/api/housekeeping/rooms`, **not** `/api/status`).
- **Conclusion:** Socket.IO events **do NOT** trigger `/api/status` request storms. Socket.IO is properly decoupled.

---

## 6. Backend /api/status & Firestore Quota Interaction

1. **Why HTTP 503 is returned:**
   - In `auditController.js`:
     ```javascript
     if (lastKnownGoodStatusSnapshot && Array.isArray(lastKnownGoodStatusSnapshot.rooms) && lastKnownGoodStatusSnapshot.rooms.length > 0) {
       return res.json({ ...lastKnownGoodStatusSnapshot, data_status: 'stale', ... });
     }
     if (isQuotaError) {
       return res.status(503).json({ error: 'Firestore database is temporarily unavailable...', code: 'FIRESTORE_RESOURCE_EXHAUSTED', ... });
     }
     ```
   - When the backend container restarts, `lastKnownGoodStatusSnapshot` is `null`. If Firestore is already quota-exhausted upon restart, no snapshot can be built, forcing `HTTP 503`.
2. **Cache Bypass on Errors:**
   - `TtlCache.getOrSet` only caches resolved values (`result !== undefined`). When Firestore throws an error, the exception is propagated without caching.
   - Consequently, every incoming request attempts a fresh Firestore query, repeating the quota error.

---

## 7. Root Cause vs. Secondary Causes vs. Symptoms

| Category | Finding | Description |
| :--- | :--- | :--- |
| **P0 Root Cause 1** | **No Negative Caching on Backend Quota Error** | When Firestore returns `RESOURCE_EXHAUSTED`, the error is not cached short-term (e.g. 15s). Every poll attempts a live Firestore read. |
| **P0 Root Cause 2** | **Cold-Start Snapshot Absence** | On backend process restart during active quota exhaustion, `lastKnownGoodStatusSnapshot` is `null`, forcing 503. |
| **P1 Secondary Cause** | **Duplicate Mount Polling Effects** | `src/App.jsx` has two separate `useEffect` hooks calling `fetchStatus()` on mount. |
| **P2 Secondary Cause** | **5000ms AbortController Race** | When Firestore queries hang before throwing quota error, client-side abort triggers false network error logs. |
| **P3 Symptom** | **UI "Database Quota Reached" / 0 Rooms** | Expected behavior when no snapshot exists and Firestore rejects all document reads. |

---

## 8. Minimum Safe Fix Plan (Proposal Only — Not Implemented)

### Step 1: Backend Short-Term Quota-Degraded Caching (`auditController.js` & `ttlCache.js`)
- Introduce a **15-second negative cache** for `FIRESTORE_RESOURCE_EXHAUSTED` in `auditController.js` or `ttlCache.js`.
- If Firestore is in a known quota-exhausted state and has no snapshot, immediately return `HTTP 503` from memory for 15 seconds without making repeated gRPC calls to Google Cloud.

### Step 2: Consolidate Frontend Polling in `src/App.jsx`
- Merge the two overlapping mount `useEffect` hooks in `src/App.jsx` into a single, debounced status coordinator.
- Prevent duplicate `fetchStatus()` executions if an existing fetch is already in flight.

### Step 3: Refine AbortController Handling in `fetchStatus`
- In `fetchStatus`, distinguish `AbortError` / HTTP 503 from true connection loss.
- Only log `[API Network Error]` and set `setIsBackendOnline(false)` if the error is a true network disconnection (`TypeError: Failed to fetch` without server response).

---

## 9. Verification & Safety Compliance

- **Source code modifications made:** `0` (Strictly read-only)
- **Firestore mutations made:** `0`
- **MySQL mutations made:** `0`
- **MySQL fallback restored:** `NO`
- **Outbox restored:** `NO`
- **Shadow verification restored:** `NO`
- **Factory Reset executed:** `NO`
- **Phase 3 Step 13.5 started:** `NO`
- **Preserved `backend/db.js`, `mysql2`, `docker-compose.yml`, `FactoryResetService.js`:** `YES`
