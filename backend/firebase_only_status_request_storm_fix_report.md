# HPMS — Status API Request Storm & Error Classification Fix Implementation Report
**Document:** `backend/firebase_only_status_request_storm_fix_report.md`  
**Execution Phase:** Production-Safe Request Storm & Error Classification Stabilization  
**System:** Webline PMS Plus / HPMS-Sky5  
**Timestamp:** 2026-08-21T12:06:45+05:30  

---

## 1. Root Cause Summary

1. **Negative Cache Gap:** When Google Cloud Firestore is quota-exhausted (`code: 8 RESOURCE_EXHAUSTED`), `ttlCache.js` only caches successful resolved objects. Unsuccessful query attempts were uncached, allowing every subsequent `/api/status` request to re-attempt live Firestore queries.
2. **Cold-Start Snapshot Absence:** Process restarts cleared the in-memory `lastKnownGoodStatusSnapshot`. When restarted during an active quota limit, the backend could not serve a stale snapshot and returned `HTTP 503`.
3. **Duplicate Startup Effects:** In `src/App.jsx`, two separate `useEffect` hooks called `fetchStatus()` upon mounting, initiating simultaneous initial network requests.
4. **Misclassified AbortErrors:** Slow or pending responses exceeding 5000ms were aborted by client-side `AbortController`, triggering `catch (err)` that logged `[API Network Error] Backend unreachable` and set `isBackendOnline(false)` despite the backend server being active and healthy.

---

## 2. Changes Implemented

### 1. 15-Second Negative Quota Caching ([`backend/controllers/auditController.js`](file:///d:/projects/hotel/backend/controllers/auditController.js))
- Added `quotaExhaustedUntil` timestamp state with `NEGATIVE_QUOTA_CACHE_TTL_MS = 15000` (15 seconds).
- When a status query encounters `isQuotaError` (`RESOURCE_EXHAUSTED` / `code: 8`), `quotaExhaustedUntil` is set to `Date.now() + 15000`.
- Subsequent calls within the 15-second window **immediately** return the degraded snapshot or structured `HTTP 503` with `retry_after_seconds` without executing any Firestore gRPC calls.
- When a query succeeds, `quotaExhaustedUntil` is immediately reset to `0`.

### 2. In-Flight Request Protection ([`src/App.jsx`](file:///d:/projects/hotel/src/App.jsx))
- Introduced `statusFetchInFlightRef = useRef(false)`.
- If a status request is already pending, subsequent calls to `fetchStatus()` return immediately, guaranteeing that at most **one** `/api/status` request is ever in-flight from the Admin dashboard.

### 3. Consolidated Polling & Startup Effects ([`src/App.jsx`](file:///d:/projects/hotel/src/App.jsx))
- Streamlined startup logic: For Admin users, initial status is fetched cleanly by the primary polling effect; the secondary effect now activates only for guests (`guestToken && !adminToken`).
- Retained visibility-aware polling: Background 20-second interval polls are skipped when `document.hidden === true`.

### 4. Corrected Error Classification & Abort Handling ([`src/App.jsx`](file:///d:/projects/hotel/src/App.jsx))
- Distinguishes `AbortError` (5-second client timeout) from true network disconnection. On timeout, preserves `isBackendOnline = true` and updates `dataStatus = 'degraded'` with `staleReason = 'REQUEST_TIMEOUT'`.
- Preserves `rooms` state during `HTTP 503` and quota errors, preventing sudden `rooms = []` or `NaN%` occupancy flashes.
- Only true network failures (e.g. `Failed to fetch`, connection refused) toggle `isBackendOnline(false)`.

---

## 3. Request-Rate Behavior Comparison

| Metric | Before Fix | After Fix |
| :--- | :--- | :--- |
| **Concurrent Status Requests** | Unbounded (multiple overlapping fetches) | **Strictly 1 in-flight maximum** (`statusFetchInFlightRef`) |
| **Startup Mount Requests** | 2 simultaneous fetches | **1 controlled fetch** |
| **Background Tab Polling** | Unrestricted / periodic | **0 requests while hidden** |
| **Repeated Firestore Calls during Quota Limit** | Every poll attempt hits Firestore | **1 Firestore attempt per 15s window** (served from memory) |
| **Client Abort Classification** | Marked as "Backend Unreachable" | **Preserves Backend Online** (`REQUEST_TIMEOUT`) |
| **Room Data State on 503** | Reset to `[]` with `NaN%` occupancy | **Preserves last-known valid room data** |

---

## 4. Verification & Test Results

### 1. Dedicated Request Storm & Resilience Suite:
- **Test File:** `backend/tests/testStatusRequestStormFix.mjs`
- **Result:** **22/22 PASSED (100%)**
  - Initial `RESOURCE_EXHAUSTED` triggers Firestore attempt and activates 15s negative cache.
  - Second request within 15s immediately returns 503 in 0ms from memory without Firestore gRPC call.
  - Last-known-good snapshot returns HTTP 200 with `data_status: 'stale'` and preserved rooms.
  - In-flight guard coalesces 3 simultaneous calls to 1 network request.
  - Visibility rules verified: hidden tab skips polling, tab focus triggers controlled refresh.
  - Error classification verified for HTTP 503, `AbortError`, and true network failures.

### 2. Regression Suites:
- `testFirestoreStatusResilience.mjs`: **15/15 PASSED (100%)**
- `testPhaseBFirestoreReadOptimization.mjs`: **23/23 PASSED (100%)**
- `testPhase3FirestoreReadOptimizationPhaseA.mjs`: **9/9 PASSED (100%)**
- `testPhase3Step13Step4LegacyServicesDecommission.mjs`: **13/13 PASSED (100%)**
- `testPhase3Step13Step3OutboxDecommission.mjs`: **15/15 PASSED (100%)**
- `npm run build`: **PASSED (0 errors in 19.20s)**
- `GET /api/health`: **HTTP 200 OK (8ms)**

---

## 5. Architectural Safety Compliance

- **Source files modified:** **2** (`backend/controllers/auditController.js`, `src/App.jsx`)
- **Firestore mutations:** **0**
- **Firebase Auth mutations:** **0**
- **MySQL mutations:** **0**
- **MySQL fallback restored:** **NO**
- **Outbox restored:** **NO**
- **Shadow verification restored:** **NO**
- **Factory Reset executed:** **NO**
- **Phase 3 Step 13.5 started:** **NO**
- **Preserved `backend/db.js`, `mysql2`, `docker-compose.yml`, `FactoryResetService.js`:** **YES**
