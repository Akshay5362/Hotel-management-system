# HPMS — Status Resilience & Graceful Degradation Implementation Report
**Document:** `backend/firebase_only_status_resilience_implementation.md`  
**Execution Phase:** Emergency Production-Safe Runtime Stabilization  
**System:** Webline PMS Plus / HPMS-Sky5  
**Timestamp:** 2026-08-21T11:55:00+05:30  

---

## 1. Root Cause Analysis

1. **Quota Exhaustion (`code: 8 RESOURCE_EXHAUSTED`):** Google Cloud Firestore free-tier daily document read quotas were exhausted earlier prior to the Phase A & Phase B scoping and caching optimizations.
2. **Backend Error Handling Gap:** `auditController.getStatus` previously caught Firestore errors and unconditionally returned a blind `HTTP 500 {"error": "Internal Server Error"}` instead of serving a cached/last-known-good snapshot.
3. **Frontend Connection State Conflation:** In `src/App.jsx`, non-200 responses caused `setIsBackendOnline(false)`, rendering `"Backend Unreachable"` and `"Offline Mode"` and resetting room data to `[]` with `NaN%` occupancy rate, even though the Node.js backend server was completely healthy and responsive.
4. **Polling Storms in Inactive Tabs:** `src/App.jsx` polled `/api/status` every 20 seconds unconditionally even when the browser tab was backgrounded or inactive.

---

## 2. Files Changed & Summary of Modifications

### 1. `backend/controllers/auditController.js`
- Added process-local `lastKnownGoodStatusSnapshot` retention.
- When Firestore returns fresh room data, snapshot is stored in memory.
- When Firestore returns `RESOURCE_EXHAUSTED` (code 8) or temporary degradation:
  - If a previous valid snapshot exists: returns `HTTP 200` with `data_status: "stale"`, `stale_reason: "FIRESTORE_RESOURCE_EXHAUSTED"`, and `stale_since` timestamp.
  - If no snapshot exists: returns `HTTP 503` with structured metadata `{ error: "Firestore quota exceeded", code: "FIRESTORE_RESOURCE_EXHAUSTED", firestore_degraded: true, backend_online: true }`.
- Preserves all existing room fields, daily counters, and cash logs.

### 2. `backend/services/firestoreRoomStatusService.js`
- Added `lastKnownGoodRoomStatuses` fallback in memory for read-only aggregation calls.
- Transactional operations passing `{ transaction }` strictly bypass snapshots and fail closed to maintain authoritative transactional integrity.

### 3. `src/App.jsx`
- Added `dataStatus` (`'fresh' | 'stale' | 'degraded'`) and `staleReason` reactive state.
- Decoupled backend reachability from database quota exhaustion: `setIsBackendOnline(true)` on any HTTP response from the backend.
- Prevents resetting `rooms` to `[]` on transient 503/500 errors.
- Guarded `occupancyRate` calculation against empty arrays (`rooms.length === 0 ? 0 : ...`), eliminating `NaN%`.
- Implemented **Visibility-Aware Polling**: background 20-second interval polls are skipped when `document.hidden` is true; a single controlled refresh is triggered when returning to the tab.

### 4. `src/components/MetricsBar.jsx`
- Added support for structured data states (`fresh`, `stale`, `degraded`, `offline`).
- Displays amber sync indicator: `"System: Online (Cached Snapshot — FIRESTORE_RESOURCE_EXHAUSTED)"` during quota limitations instead of red `"Backend Unreachable"`.

### 5. `backend/tests/testFirestoreStatusResilience.mjs`
- Dedicated 15-point verification test suite verifying resilience, schema integrity, NaN protection, stampede protection, and transactional bypass.

---

## 3. Before vs. After Behavior

| Scenario | Before Stabilization | After Stabilization |
| :--- | :--- | :--- |
| **Firestore Normal** | HTTP 200, green indicator | HTTP 200, `data_status: "fresh"`, green indicator |
| **Firestore Quota Exceeded (Snapshot Exists)** | HTTP 500 -> "Backend Unreachable", 0 rooms, NaN% occupancy | **HTTP 200**, `data_status: "stale"`, preserved rooms, 50% occupancy, amber indicator: *"Online (Cached Snapshot)"* |
| **Firestore Quota Exceeded (No Snapshot)** | HTTP 500 -> "Offline Mode" | **HTTP 503** with `backend_online: true`, existing UI rooms preserved |
| **Hidden / Minimized Browser Tab** | Polled Firestore every 20s continuously | **Polling paused while hidden**; 1 refresh on focus |
| **Check-In / Out Transactions** | Authoritative Firestore | **Authoritative Firestore** (Strict cache bypass) |

---

## 4. Verification & Regression Results

### 1. Dedicated Status Resilience Suite (`testFirestoreStatusResilience.mjs`):
- **15/15 PASSED (100%)**
  - All 27 room fields preserved in response contract.
  - Occupancy NaN protection verified (`0%` on empty list).
  - Snapshot retention and stale metadata (`data_status`, `stale_reason`, `stale_since`) verified.
  - Stampede protection coalescing 5 concurrent requests into 1 loader verified.
  - Transactional bypass and zero MySQL/Outbox invariants verified.

### 2. Phase B Short-TTL Caching Suite (`testPhaseBFirestoreReadOptimization.mjs`):
- **23/23 PASSED (100%)**

### 3. Phase A Read Optimization Suite (`testPhase3FirestoreReadOptimizationPhaseA.mjs`):
- **9/9 PASSED (100%)**

### 4. Step 13.4 Decommission Suite (`testPhase3Step13Step4LegacyServicesDecommission.mjs`):
- **13/13 PASSED (100%)**

### 5. Step 13.3 Outbox Decommission Suite (`testPhase3Step13Step3OutboxDecommission.mjs`):
- **15/15 PASSED (100%)**

### 6. Production Frontend Build:
- `npm run build`: **PASSED (0 errors in 12.68s)**

### 7. Backend Health Endpoint:
- `GET /api/health`: **HTTP 200 OK (8ms)**

---

## 5. Architectural Safety Compliance

- **Firestore authoritative primary database:** **YES**
- **MySQL restored:** **NO**
- **MySQL fallback restored:** **NO**
- **Outbox restored:** **NO**
- **Shadow verification restored:** **NO**
- **Factory Reset executed:** **NO**
- **Step 13.5 started:** **NO**
- **Preserved `backend/db.js`, `mysql2`, `docker-compose.yml`, `FactoryResetService.js`:** **YES**
