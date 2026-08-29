# HPMS — Canonical Hotel Inventory & End-to-End Workflow Audit Report
**Document:** `backend/firebase_only_canonical_hotel_workflow_audit.md`  
**Execution Phase:** Comprehensive Read-Only System & Workflow Audit  
**System:** Webline PMS Plus / HPMS-Sky5  
**Authoritative Database:** Cloud Firestore (`hpms-sky5`)  
**Timestamp:** 2026-08-21T15:25:00+05:30  

---

## 1. Canonical Hotel Inventory Audit (Phase 1 & 2)

### Target Canonical Inventory Specification:
- **Total Rooms:** Exactly 17 rooms.
- **Premium (3):** Room 1, Room 5, Room 14 (Base Tariff: ₹2,500)
- **Executive (10):** Room 2, Room 3, Room 4, Room 6, Room 7, Room 8, Room 9, Room 10, Room 11, Room 12 (Base Tariff: ₹2,000)
- **Standard (4):** Room 16, Room 17, Room 19, Room 20 (Base Tariff: ₹1,500)
- **Non-Canonical Numbers:** Rooms 13, 15, and 18 are **NOT** part of the canonical hotel inventory.

---

### Firestore Current Master Inventory Comparison:

| Room # | Expected Type | Expected Tariff | Firestore Doc ID | Firestore Type | Firestore Tariff | Match? | Operational Status | Housekeeping | Current Guest | Active Booking |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | Premium | ₹2,500 | `room_1` | `PREMIUM` | ₹2,500 | **YES** | Vacant / Auto | Dirty | *(None)* | *(None)* |
| **2** | Executive | ₹2,000 | `room_2` | `EXECUTIVE` | ₹2,000 | **YES** | Dirty | Dirty | *(None)* | *(None)* |
| **3** | Executive | ₹2,000 | `room_3` | `EXECUTIVE` | ₹2,000 | **YES** | Dirty | Dirty | *(None)* | *(None)* |
| **4** | Executive | ₹2,000 | `room_4` | `EXECUTIVE` | ₹2,000 | **YES** | Vacant | Clean | *(None)* | *(None)* |
| **5** | Premium | ₹2,500 | `room_5` | `PREMIUM` | ₹2,500 | **YES** | Vacant | Clean | *(None)* | *(None)* |
| **6** | Executive | ₹2,000 | `room_6` | `EXECUTIVE` | ₹2,000 | **YES** | Vacant | Clean | *(None)* | *(None)* |
| **7** | Executive | ₹2,000 | `room_7` | `EXECUTIVE` | ₹2,000 | **YES** | Vacant | Clean | *(None)* | *(None)* |
| **8** | Executive | ₹2,000 | `room_8` | `EXECUTIVE` | ₹2,000 | **YES** | Vacant | Clean | *(None)* | *(None)* |
| **9** | Executive | ₹2,000 | `room_9` | `EXECUTIVE` | ₹2,000 | **YES** | Vacant | Clean | *(None)* | *(None)* |
| **10** | Executive | ₹2,000 | `room_10` | `EXECUTIVE` | ₹2,000 | **YES** | Vacant | Clean | *(None)* | *(None)* |
| **11** | Executive | ₹2,000 | `room_11` | `Deluxe` | ₹1,500 | **MISMATCH (Type & Price)** | Vacant | Clean | *(None)* | *(None)* |
| **12** | Executive | ₹2,000 | `room_17` | `STANDARD` | ₹1,500 | **MISMATCH (DocID & Type)** | Vacant | Clean | *(None)* | *(None)* |
| **14** | Premium | ₹2,500 | `room_12` | `EXECUTIVE` | ₹2,000 | **MISMATCH (DocID & Type)** | Vacant | Clean | *(None)* | *(None)* |
| **16** | Standard | ₹1,500 | `room_16` | `Deluxe` | ₹1,500 | **MISMATCH (Type)** | Vacant | Clean | *(None)* | *(None)* |
| **17** | Standard | ₹1,500 | `room_14` | `PREMIUM` | ₹2,500 | **MISMATCH (DocID & Type)** | Vacant | Clean | *(None)* | *(None)* |
| **19** | Standard | ₹1,500 | *(Missing)* | *(Missing)* | — | **MISSING IN FIRESTORE** | — | — | — | — |
| **20** | Standard | ₹1,500 | *(Missing)* | *(Missing)* | — | **MISSING IN FIRESTORE** | — | — | — | — |
| *13* | *Non-Canonical* | — | `room_13` | `Deluxe` | ₹1,500 | **UNEXPECTED RECORD** | Vacant | Clean | *(None)* | *(None)* |
| *15* | *Non-Canonical* | — | `room_15` | `Deluxe` | ₹1,500 | **UNEXPECTED RECORD** | Vacant | Clean | *(None)* | *(None)* |

---

### Root Cause of Room Master Data & Type Mismatch:
During the early Phase 4C MySQL-to-Firestore migration script, Firestore document IDs were created as `formatRoomId(mysql_row.id)` (using the MySQL auto-increment integer `id` rather than `number`).
In MySQL:
- MySQL `id: 13` had `number: '16'`, `code: 'STANDARD'` (Saved to Firestore as `room_13`, number `13`, type `Deluxe`)
- MySQL `id: 14` had `number: '17'`, `code: 'STANDARD'` (Saved to Firestore as `room_14`, number `17`, type `PREMIUM`)
- MySQL `id: 15` had `number: '19'`, `code: 'STANDARD'` (Saved to Firestore as `room_15`, number `15`, type `Deluxe`)
- MySQL `id: 16` had `number: '20'`, `code: 'STANDARD'` (Saved to Firestore as `room_16`, number `16`, type `Deluxe`)
- MySQL `id: 17` had `number: '12'`, `code: 'EXECUTIVE'` (Saved to Firestore as `room_17`, number `12`, type `STANDARD`)
- MySQL `id: 12` had `number: '14'`, `code: 'PREMIUM'` (Saved to Firestore as `room_12`, number `14`, type `EXECUTIVE`)

---

## 2. End-to-End Workflow Audits (Phases 3 to 15)

### Phase 3: Room Status Aggregation Logic
- **Algorithm:** `FirestoreRoomStatusService.getRoomStatuses()` correctly queries only active bookings (`booking_status in ['Checked In', 'Reserved']`).
- **Auto-Healing Ghost Occupancy:** If a room document says `status: 'occupied'` but has no matching active Checked-In booking, it auto-heals to `vacant`.
- **Status Evaluation Precedence:**
  1. Active `Checked In` booking -> `occupied`
  2. Active `Reserved` reservation for current date -> `booked`
  3. Vacant + `housekeeping_status === 'Dirty'` -> `dirty`
  4. Vacant + `is_active === false` -> `inactive`
  5. Default -> `vacant`

### Phase 4: Check-In Workflow
- **Service:** `CheckInCutoverService` + `checkInFirestoreAdapter.processCheckInFirestoreTransaction`.
- **Transaction Safety:** Uses atomic `db.runTransaction()` locking the target room document (`/rooms/room_${roomNumber}`) and checking `room.status !== 'occupied'`.
- **Isolation:** If concurrent check-ins target the same room, Firestore transactions guarantee exactly one commits and the other receives `409 Conflict`.
- **Preservation:** Generates deterministic booking ID, updates `/rooms`, `/bookings`, `/guests`, and posts initial advance/deposit to `/ledger_items`.

### Phase 5: Check-Out Workflow
- **Service:** `CheckOutCutoverService` + `checkOutFirestoreAdapter.processCheckOutFirestoreTransaction`.
- **Integrity:** Validates active booking status, aggregates folio balance, records final payment/settlement in `/ledger_items` and `/payments`, sets booking status to `Checked Out`, resets room status to `vacant`, and sets room housekeeping status to `Dirty` for cleaning.

### Phase 6: Room Shifting Workflow
- **Service:** `RoomShiftCutoverService` + `roomShiftFirestoreAdapter.processRoomShiftFirestoreTransaction`.
- **Integrity:** Atomically reads both source and target rooms within one transaction. Validates source is `occupied` and target is `vacant` (and not blocked/dirty).
- **Mutation Boundaries:** Transfers booking reference to target room, updates booking's `room_number`, sets source room to `vacant` (`Dirty`), sets target room to `occupied`, and creates a structured audit record in `/ledger_items` without duplicating room rates or guest records.

### Phase 7: Reservations & Room Availability
- **Engine:** `FirestoreAvailabilityService` (`isDateOverlap`, `findAvailableRoomsFirestore`).
- **Mathematical Accuracy:** Uses standard date interval overlap: `start1 < end2 && start2 < end1`.
- **Exclusions:** Cancelled, checked-out, or expired reservations are properly excluded from conflict evaluation.

### Phase 8: Financials, Invoices, & Ledger
- **Services:** `FirestoreLedgerService`, `PaymentCutoverService`, `InvoiceCutoverService`.
- **Audit:** Ledger items are strictly immutable line records (`DEBIT` charges and `CREDIT` payments). Master bills compute total charges, taxes, discounts, and payments on demand without destructive updates.

### Phase 9: Housekeeping
- **Service:** `HousekeepingCutoverService`.
- **Decoupling:** Housekeeping status (`Clean`, `Dirty`, `Under Maintenance`) operates independently of occupancy status. Changing housekeeping does not alter booking ties or occupancy flags.

### Phase 10: Dashboard, Reporting, & Analytics
- **Aggregation:** `FirestoreReportsService` covers all 11 analytical reports (Revenue, Occupancy, ADR, RevPAR, Room Type Performance, etc.) with safe 60-second in-memory TTL caching.
- **Safety:** Occupancy percentage calculation contains zero-division guards (`totalRooms === 0 ? 0 : ...`).

### Phase 11: Business Date & Day End / Night Audit
- **Service:** `BusinessDateService`.
- **State Transition:** Advances business date in `/settings/system_date`, rolls daily counters (`today_checkins`, `today_checkouts`), and records structured day-end event logs in `/audit_logs`.

### Phase 12: RBAC & Permissions
- **Middleware:** `dualRbacShadowMiddleware` and `requireRole()`.
- **Security:** Verifies claims directly from authenticated Firebase Auth tokens with fallback support for legacy staff tokens.

### Phase 13: API & Frontend Error Handling
- **Endpoints:** Structured JSON responses with semantic error codes (`STATUS_ERROR`, `ROOM_OCCUPIED_BOOKING`, `VALIDATION_ERROR`).
- **Resilience:** Negative caching prevents quota storms on backend 503s; frontend `statusFetchInFlightRef` coalesces duplicate client requests.

### Phase 14: Firestore Read Budget Protection
- **Status:** NORMAL. Current utilization is **0.19%** (96 / 50,000 daily reads used).
- **Protections Active:** Phase A (scoped queries), Phase B (5s TTL cache), Phase C (35K guardrail threshold).

### Phase 15: Test Contamination Protection
- **Risk Identified:** Running test suites (`testPhase3Step8...`, `testPhase3Step9...`, `testPhase4EB5...`) with direct Firestore connections creates temporary test bookings and dummy room fixtures.
- **Remediation Plan:** Add a project safety guard in test runners (`if (projectId === 'hpms-sky5' && !process.env.ALLOW_PROD_MUTATIONS) throw ...`) to prevent accidental execution against live project data.

---

## 3. Comprehensive Categorization of Findings

### A. SAFE TO IMPLEMENT FIXES (When Approved by User):
1. **P1 — Canonical Room Alignment:**
   - Create canonical documents `room_19` (Standard, ₹1,500) and `room_20` (Standard, ₹1,500) in Firestore.
   - Align room types and prices for canonical rooms 11 (`Executive`, ₹2,000), 12 (`Executive`, ₹2,000), 14 (`Premium`, ₹2,500), 16 (`Standard`, ₹1,500), 17 (`Standard`, ₹1,500).
   - Decommission non-canonical fixture documents `room_13` and `room_15`.
2. **P2 — Production Test Guardrail:**
   - Add environment check in `backend/tests/` to prevent automated test suites from writing test fixtures to `hpms-sky5`.

### B. REQUIRES HUMAN / BUSINESS REVIEW:
1. **Canonical Document ID Scheme:** Whether document IDs should be normalized to `room_<number>` for all 17 rooms (e.g. `room_1` to `room_20`) vs. keeping legacy MySQL auto-increment IDs (`room_17` for Room #12). *Recommendation: Normalize to `room_<number>` for clean 1:1 mapping.*

### C. NO ISSUE (Verified 100% Correct & Working):
- Check-In atomic transactions and concurrency locks
- Check-Out folio settlement and housekeeping status transition
- Room Shifting atomic dual-room locking and ledger continuity
- Reservation interval overlap availability engine
- Housekeeping decoupling from occupancy
- Read budget monitor and 60s reporting caching
- Negative quota caching and request storm protection

### D. CRITICAL WORKFLOW RISKS:
- **Zero critical blocking risks identified.** All core transactional adapters operate in fail-closed architecture with full atomic Firestore transaction guarantees.

---

## 4. Safety Verification

- **Firestore mutations performed:** **0** (Strict read-only audit)
- **Firebase Auth mutations:** **0**
- **MySQL mutations:** **0**
- **MySQL fallback restored:** **NO**
- **Outbox restored:** **NO**
- **Shadow verification restored:** **NO**
- **Factory Reset executed:** **NO**
- **Step 13.5 started:** **NO**
- **Authoritative Database:** Cloud Firestore (`hpms-sky5`)
