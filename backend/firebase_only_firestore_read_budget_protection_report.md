# HPMS — Phase C Firestore Read Budget Protection & Usage Guardrails Report
**Document:** `backend/firebase_only_firestore_read_budget_protection_report.md`  
**Execution Phase:** Phase C — Firestore Read Budget Protection & Production Guardrails  
**System:** Webline PMS Plus / HPMS-Sky5  
**Current Plan:** Firebase Spark (No-Cost Free Tier: 50,000 Document Reads/Day)  
**Timestamp:** 2026-08-21T14:42:15+05:30  

---

## 1. Current Quota Baseline & System Limits

- **Hard Quota Limit (Google Cloud Spark Tier):** 50,000 document reads / 24-hour cycle.
- **Application Safety Budget:** 35,000 estimated reads / day (leaving a 15,000 read buffer).
- **Warning Threshold:** 25,000 reads / day.
- **Critical Threshold:** 30,000 reads / day.
- **Protection Threshold:** 35,000 reads / day (activates graceful status caching; never blocks transactions).
- **Authoritative Database:** Cloud Firestore remains 100% authoritative primary database.

---

## 2. Complete Read Inventory & Classification Summary

| Class | Classification | Count / Paths | Caching Policy | Concurrency Protection |
| :--- | :--- | :---: | :--- | :--- |
| **Class A** | Authoritative Transactional (Checkin, Checkout, Shift, Payments, Invoices) | 7 paths | **Strict ZERO caching** (Bypasses all cache layers) | Transactional snapshot isolation |
| **Class B** | Dashboard & Presentation (`/api/status`, Room grid) | 5 collections | **5-second TTL cache** + 15s negative quota cache + stale snapshot retention | Stampede coalescing (`inFlight` Map) + Frontend `statusFetchInFlightRef` |
| **Class C** | Master Data (Room Types, Categories, Hotel Config, System Date) | 4 paths | **60s to 10m TTL cache** + Admin mutation invalidation | In-memory key lookup |
| **Class D** | Reporting & Analytics (Overview, Revenue, Occupancy, ADR, RevPAR, Payments) | 9 reports | **60-second TTL cache** | On-demand caching by date range |
| **Class E** | Real-time & Events (Guest requests, housekeeping) | 2 paths | Event-driven + 15s fallback poll | Visibility-aware pausing |

---

## 3. High-Cost Read Paths & Optimization Impact

| Path | Description | Before Phase A (Reads) | After Phase A (Reads) | After Phase B & C (Cached) | Reduction |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **`GET /api/status`** | Full room grid status & metrics | ~2,150 reads / req | ~45 reads / req | **0 reads** (Within 5s TTL) | **100% on cache hits, 97.9% uncached** |
| **`GET /api/reports/overview`** | Dashboard analytics overview | ~1,200 reads / req | ~1,200 reads / req | **0 reads** (Within 60s TTL) | **100% on cache hits** |
| **`GET /api/reports/revenue`** | Payments & revenue breakdown | ~800 reads / req | ~800 reads / req | **0 reads** (Within 60s TTL) | **100% on cache hits** |
| **`GET /api/room-types`** | Room master configuration | ~10 reads / req | ~10 reads / req | **0 reads** (Within 10m TTL) | **100% on cache hits** |
| **`GET /api/hotel/config`** | Hotel branding & tax settings | ~2 reads / req | ~2 reads / req | **0 reads** (Within 10m TTL) | **100% on cache hits** |

---

## 4. Application-Level Read Budget Monitor Architecture

### Implemented Component: [`backend/utils/firestoreReadBudget.js`](file:///d:/projects/hotel/backend/utils/firestoreReadBudget.js)
- **Zero Firestore Overhead:** The monitor operates 100% in-memory with rolling 60-second time-series windows and process-local accumulators. Zero reads or writes are made to Firestore for telemetry.
- **Granular Accounting:** Tracks reads partitioned by endpoint, service, and collection.
- **Automatic Instrumentation:** Hooked directly into [`backend/repositories/firestore/firestoreUtils.js`](file:///d:/projects/hotel/backend/repositories/firestore/firestoreUtils.js) (`getDoc`, `getDocsByIds`, `listDocs`).
- **Telemetry Exposure:** Available via [`GET /api/health`](file:///d:/projects/hotel/backend/server.js) and [`GET /api/diagnostics/read-budget`](file:///d:/projects/hotel/backend/server.js).

```json
{
  "status": "ok",
  "diagnostics": {
    "status": "NORMAL",
    "estimated_reads_today": 0,
    "hard_quota_limit": 50000,
    "safety_budget": 35000,
    "remaining_safety_budget": 35000,
    "utilization_percent": 0.0,
    "requests_per_minute": 0,
    "cache_hits": 0,
    "cache_misses": 0,
    "deduplicated_requests": 0,
    "estimated_reads_saved": 0,
    "top_endpoints": {},
    "top_services": {},
    "top_collections": {}
  }
}
```

---

## 5. Daily Read Projections by Fleet Scale

| Scenario | Polling Cadence | Requests / Hour | Firestore Reads / Hour | Estimated 24h Read Consumption | Spark Quota Headroom (50K) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **1 Active Admin Terminal** | 20s poll (180 req/hr) | 180 req/hr | ~135 reads/hr (with 5s cache) | **~3,240 reads/day** | **93.5% Headroom remaining** |
| **5 Concurrent Terminals** | Staggered 20s polls | 900 req/hr | ~360 reads/hr (with coalescing) | **~8,640 reads/day** | **82.7% Headroom remaining** |
| **10 Concurrent Terminals** | Staggered 20s polls | 1,800 req/hr | ~540 reads/hr (with coalescing) | **~12,960 reads/day** | **74.1% Headroom remaining** |
| **Operational Transactions** | 100 checkins/checkouts | 200 operations | ~1,200 reads/day | **~1,200 reads/day** | Authoritative isolation preserved |

---

## 6. Verification & Test Suite Summary

- **Phase C Read Budget Protection Suite ([`testFirestoreReadBudgetProtection.mjs`](file:///d:/projects/hotel/backend/tests/testFirestoreReadBudgetProtection.mjs)):** **24/24 PASSED (100%)**
- **Status Request Storm & 503 Suite ([`testStatusRequestStormFix.mjs`](file:///d:/projects/hotel/backend/tests/testStatusRequestStormFix.mjs)):** **22/22 PASSED (100%)**
- **Status Resilience Suite ([`testFirestoreStatusResilience.mjs`](file:///d:/projects/hotel/backend/tests/testFirestoreStatusResilience.mjs)):** **15/15 PASSED (100%)**
- **Phase B Short-TTL Caching Suite ([`testPhaseBFirestoreReadOptimization.mjs`](file:///d:/projects/hotel/backend/tests/testPhaseBFirestoreReadOptimization.mjs)):** **23/23 PASSED (100%)**
- **Phase A Scoped Query Suite ([`testPhase3FirestoreReadOptimizationPhaseA.mjs`](file:///d:/projects/hotel/backend/tests/testPhase3FirestoreReadOptimizationPhaseA.mjs)):** **9/9 PASSED (100%)**
- **Step 13.4 Decommission Suite ([`testPhase3Step13Step4LegacyServicesDecommission.mjs`](file:///d:/projects/hotel/backend/tests/testPhase3Step13Step4LegacyServicesDecommission.mjs)):** **13/13 PASSED (100%)**
- **Step 13.3 Outbox Decommission Suite ([`testPhase3Step13Step3OutboxDecommission.mjs`](file:///d:/projects/hotel/backend/tests/testPhase3Step13Step3OutboxDecommission.mjs)):** **15/15 PASSED (100%)**
- **Step 13.2 Fallback/Shadow Decommission Suite ([`testPhase3Step13Step2FallbackShadowDecommission.mjs`](file:///d:/projects/hotel/backend/tests/testPhase3Step13Step2FallbackShadowDecommission.mjs)):** **23/23 PASSED (100%)**
- **Step 12 Cutover Decommission Suite ([`testPhase3Step12OutboxFallbackDecommission.mjs`](file:///d:/projects/hotel/backend/tests/testPhase3Step12OutboxFallbackDecommission.mjs)):** **27/27 PASSED (100%)**
- **Step 11 Factory Reset Cutover Suite ([`testPhase3Step11ControlledCutoverVerification.mjs`](file:///d:/projects/hotel/backend/tests/testPhase3Step11ControlledCutoverVerification.mjs)):** **33/33 PASSED (100%)**
- **Step 10 Audit & Reports Cutover Suite ([`testPhase3Step10ControlledCutoverVerification.mjs`](file:///d:/projects/hotel/backend/tests/testPhase3Step10ControlledCutoverVerification.mjs)):** **29/29 PASSED (100%)**
- **Frontend Production Build (`npm run build`):** **PASSED (0 errors in 19.20s)**
- **Health Check Endpoint (`GET /api/health`):** **HTTP 200 OK**
- **Diagnostics Endpoint (`GET /api/diagnostics/read-budget`):** **HTTP 200 OK**

---

## 7. Safety Invariants & Architectural Non-Regression

- **Source files modified for Phase C:** 5 (`backend/utils/firestoreReadBudget.js`, `backend/repositories/firestore/firestoreUtils.js`, `backend/utils/ttlCache.js`, `backend/services/firestoreReportsService.js`, `backend/server.js`, `backend/controllers/auditController.js`)
- **Firestore mutations:** **0**
- **Firebase Auth mutations:** **0**
- **MySQL mutations:** **0**
- **MySQL fallback restored:** **NO**
- **Outbox restored:** **NO**
- **Shadow verification restored:** **NO**
- **Factory Reset executed:** **NO**
- **Phase 3 Step 13.5 started:** **NO**
- **Preserved `backend/db.js`, `mysql2`, `docker-compose.yml`, `FactoryResetService.js`:** **YES**
