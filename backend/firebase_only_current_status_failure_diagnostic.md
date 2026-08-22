# HPMS — Current Status Failure & Offline Dashboard Runtime Diagnostic
**Document:** `backend/firebase_only_current_status_failure_diagnostic.md`  
**Execution Phase:** Phase 1 (Current Runtime Diagnosis)  
**System:** Webline PMS Plus / HPMS-Sky5  
**Timestamp:** 2026-08-21T11:49:45+05:30  

---

## 1. Executive Summary

This diagnostic details the exact runtime failure chain that causes the Admin Dashboard to display **"Offline Mode (Backend Unreachable)"**, **"Permission: Disabled"**, **Total Rooms: 0**, and **Occupancy: NaN%** when the Node.js backend server is running and healthy on port 5000 (`GET /api/health` returns `HTTP 200`).

---

## 2. Exact Request Chain

```
[Browser / Admin Dashboard]
  │
  ├── 1. fetchStatus() auto-poll triggered by useEffect (every 20s)
  │      GET http://localhost:5000/api/status
  │
  ▼
[backend/server.js : Port 5000]
  │
  ├── 2. Route handler: auditRoutes.js -> auditController.getStatus
  │
  ▼
[backend/controllers/auditController.js (getStatus)]
  │
  ├── 3. Calls SafeCutoverFallbackService.executeWithFallback({ domain: 'room_status' })
  │
  ▼
[backend/services/firestoreRoomStatusService.js (getRoomStatuses)]
  │
  ├── 4. Cache Miss on room_status_2026-08-19_with_ledger (initial load after process start)
  │      Executes _fetchRoomStatusesFromFirestore() -> listDocs('rooms')
  │
  ▼
[Firestore Admin SDK (gRPC @google-cloud/firestore)]
  │
  └── 5. Google Cloud Firestore rejects stream:
         code: 8
         details: "Quota exceeded."
         message: "8 RESOURCE_EXHAUSTED: Quota exceeded."
  │
  ▲
[SafeCutoverFallbackService.js]
  │
  ├── 6. Step 13.2 Fail-Closed invariant enforces zero MySQL queries.
  │      Re-throws the error to auditController.
  │
  ▲
[auditController.js (getStatus)]
  │
  ├── 7. Catch block catches error and responds with:
  │      HTTP 500
  │      Body: {"error": "Internal Server Error"}
  │
  ▲
[src/App.jsx (fetchStatus)]
  │
  ├── 8. Receives HTTP 500 (res.ok === false)
  │      Throws: new Error("Failed to fetch dashboard data: HTTP 500")
  │
  ▼
[src/App.jsx (catch block)]
  │
  ├── 9. Executes setIsBackendOnline(false)
  │      Leaves rooms state as [] (initial empty array)
  │
  ▼
[src/components/MetricsBar.jsx & Dashboard UI]
  │
  └── 10. Renders:
          - System: Offline Mode (Backend Unreachable)
          - Online Sync Permission: Disabled
          - Total Rooms: 0
          - Occupied Rooms: 0
          - Vacant Rooms: 0
          - Occupancy: NaN% (0 / 0 * 100)
```

---

## 3. Exact Failure Points

| Attribute | Details |
| :--- | :--- |
| **Exact Failing Function** | `FirestoreRoomStatusService._fetchRoomStatusesFromFirestore` via `listDocs('rooms')` |
| **Exact Firestore Operation** | `db.collection('rooms').get()` |
| **Exact gRPC Error** | `code: 8, message: "8 RESOURCE_EXHAUSTED: Quota exceeded."` |
| **Backend Response** | `HTTP 500 {"error": "Internal Server Error"}` |
| **Frontend Trap** | `src/App.jsx` `catch (err)` interprets any non-200 status as `setIsBackendOnline(false)` |

---

## 4. Root Causes & Secondary Failures

1. **Root Cause:** Free-tier daily quota limit on Google Cloud Firestore project `hpms-sky5` was reached earlier due to unbounded scans before Phase A/B optimizations.
2. **Secondary Backend Failure:** `/api/status` in `auditController.js` does not preserve or return a last-known-good snapshot when Firestore is temporarily quota-exhausted, but instead returns a blind `HTTP 500`.
3. **Secondary Frontend Failure:** `src/App.jsx` conflates "Backend Unreachable" (network down) with "Database Quota Degraded", setting `isBackendOnline = false` and resetting room data to empty.
4. **Polling Amplification:** `src/App.jsx` polls every 20 seconds even when browser tabs are hidden or inactive.

---

## 5. Recommended Stabilization Strategy

1. **Backend Resilience & Last-Known-Good Snapshot Retention:**
   - Retain the most recent successful `/api/status` computed payload in memory (`lastKnownGoodStatusSnapshot`).
   - If Firestore returns `RESOURCE_EXHAUSTED` (or transient connectivity error) and a last-known-good snapshot exists:
     - Return the snapshot with explicit metadata: `data_status: "stale"`, `stale_reason: "FIRESTORE_RESOURCE_EXHAUSTED"`, `http_status: 200`.
   - If no previous snapshot exists, return `HTTP 503` with structured error `{ error: "Firestore quota exceeded", code: "FIRESTORE_RESOURCE_EXHAUSTED", firestore_degraded: true }` instead of generic 500.
2. **Frontend Error Handling & State Separation:**
   - In `src/App.jsx`:
     - If status returns HTTP 200 (fresh or stale): set `isBackendOnline(true)`, `setRooms(data.rooms)`.
     - If status returns HTTP 503 / 500 from an online backend: set `isBackendOnline(true)`, do **not** clear existing `rooms` state. Display non-blocking banner: *"Data temporarily cached / Firestore quota limit reached"*.
     - Only set `isBackendOnline(false)` on true network failures (e.g. `TypeError: Failed to fetch` or connection refused).
3. **Visibility-Aware Polling:**
   - In `src/App.jsx`: pause or skip 20s interval polling when `document.hidden` is true. Trigger a single controlled refresh when tab returns to focus.
4. **Transactional Authoritative Invariant:**
   - Zero changes to check-in, check-out, room shift, payment, or ledger transactions (they must continue to query Firestore directly).
