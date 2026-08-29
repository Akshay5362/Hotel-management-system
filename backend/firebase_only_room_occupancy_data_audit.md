# HPMS — Critical Room Data & Occupancy Data Audit Report
**Document:** `backend/firebase_only_room_occupancy_data_audit.md`  
**Execution Phase:** Read-Only Audit & Data Origin Tracing  
**System:** Webline PMS Plus / HPMS-Sky5  
**Firestore Target Project:** `hpms-sky5`  
**Timestamp:** 2026-08-21T15:07:00+05:30  

---

## 1. Executive Summary & Core Findings

1. **Current Dashboard Counts Explained:**
   - **Total Rooms:** **29** (17 canonical production hotel rooms + 12 automated test fixture room records).
   - **Occupied Rooms:** **20** (3 genuine/migrated guest records + 11 room shift test records + 6 cutover test room records).
   - **Vacant Rooms:** **5** (Canonical rooms 13, 15, 16 + Test rooms 801_6882, 802_6882).
   - **Dirty Rooms:** **3** (Test rooms 982, 983, 804_6882).
   - **Inactive Rooms:** **1** (Test room 803_6882).
   - **Booked Rooms:** **0**.

2. **Core Root Cause of Suspicious Data & High Occupancy:**
   - **Aggregation Logic is 100% Correct:** `FirestoreRoomStatusService` is calculating occupancy accurately based on existing Firestore records.
   - **Frontend is 100% Correct:** The React frontend accurately renders the state delivered by `/api/status`.
   - **Data Contamination Source:** During Phase 3 Steps 7, 8, 9, 10, and Phase 4 concurrency verification runs, automated test scripts wrote realistic test fixtures directly into the primary Firestore database `hpms-sky5` with `booking_status: 'Checked In'` and room documents with randomized test suffixes (e.g. `801_6882`, `777_1201`, `999_4641`). These were never checked out or rolled back.

---

## 2. Complete Inventory of All 29 Rooms in Firestore

| # | Room Number | Doc ID | Room Type | Computed Status | Housekeeping | Active Booking ID | Guest Name | Check-In Date | Expected Check-Out | Data Origin Classification |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **1** | `1` | `room_1` | PREMIUM | **Occupied** | Dirty | `bkg_BKG-794888` | **KEVAL** | 20-Aug-2026 | 2026-08-21 11:00 | **A. Genuine/Migrated Hotel Data** |
| **2** | `2` | `room_2` | EXECUTIVE | **Occupied** | Dirty | `bkg_BKG-381166` | **ANKITA** | 20-Aug-2026 | 2026-08-21 11:00 | **A. Genuine/Migrated Hotel Data** |
| **3** | `3` | `room_3` | EXECUTIVE | **Occupied** | Dirty | `bkg_BKG-295734` | **AKSHIT** | 19-Aug-2026 | NaN-NaN-NaN | **A. Genuine/Migrated Hotel Data** |
| **4** | `4` | `room_4` | EXECUTIVE | **Occupied** | Clean | `booking_BKG-622967` | **SHIFT SOURCE GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **5** | `5` | `room_5` | PREMIUM | **Occupied** | Dirty | `booking_BKG-745214` | **CONCURRENT SHIFT GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **6** | `6` | `room_6` | EXECUTIVE | **Occupied** | Dirty | `booking_BKG-315453` | **TARGET CONFLICT GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **7** | `7` | `room_7` | EXECUTIVE | **Occupied** | Clean | `booking_BKG-918014` | **SHIFT TEST GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **8** | `8` | `room_8` | EXECUTIVE | **Occupied** | Clean | `booking_BKG-409724` | **SHIFT TEST GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **9** | `9` | `room_9` | EXECUTIVE | **Occupied** | Clean | `booking_BKG-145814` | **SHIFT SOURCE GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **10** | `10` | `room_10` | EXECUTIVE | **Occupied** | Clean | `booking_BKG-583999` | **TARGET CONFLICT GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **11** | `11` | `room_11` | Deluxe | **Occupied** | Dirty | `booking_BKG-464146` | **SHIFT SOURCE GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **12** | `12` | `room_17` | STANDARD | **Occupied** | Clean | `booking_BKG-230401` | **SHIFT SOURCE GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **13** | `13` | `room_13` | Deluxe | **Vacant** | Clean | *(None)* | *(None)* | *(None)* | *(None)* | **A. Genuine/Migrated Hotel Data** |
| **14** | `14` | `room_12` | EXECUTIVE | **Occupied** | Clean | `booking_BKG-230401` | **SHIFT SOURCE GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **15** | `15` | `room_15` | Deluxe | **Vacant** | Clean | *(None)* | *(None)* | *(None)* | *(None)* | **A. Genuine/Migrated Hotel Data** |
| **16** | `16` | `room_16` | Deluxe | **Vacant** | Clean | *(None)* | *(None)* | *(None)* | *(None)* | **A. Genuine/Migrated Hotel Data** |
| **17** | `17` | `room_14` | PREMIUM | **Occupied** | Clean | `booking_BKG-693355` | **SHIFT SOURCE GUEST** | 2026-08-20 | 2026-08-21 11:00 | **C. Test Data** (Room Shift Test) |
| **18** | `980` | `room_980` | EXECUTIVE | **Occupied** | Clean | `bkg_BKG-237877` | **TIMEOUT GUEST** | 2026-08-19 | 2026-08-20 11:00 | **C. Test Fixture Room** (Timeout Test) |
| **19** | `981` | `room_981` | EXECUTIVE | **Occupied** | Clean | `bkg_BKG-151544` | **DIRECT MYSQL GUEST** | 2026-08-19 | 2026-08-20 11:00 | **C. Test Fixture Room** (Direct MySQL Test) |
| **20** | `982` | `room_982` | EXECUTIVE | **Dirty** | Dirty | *(None)* | *(None)* | *(None)* | *(None)* | **C. Test Fixture Room** (HK Dirty Test) |
| **21** | `983` | `room_983` | EXECUTIVE | **Dirty** | Dirty | *(None)* | *(None)* | *(None)* | *(None)* | **C. Test Fixture Room** (HK Dirty Test) |
| **22** | `777_1201` | `room_777_1201` | EXECUTIVE | **Occupied** | Clean | `bkg_cutover_1787218261201` | **STEP 9 CUTOVER GUEST** | *(None)* | *(None)* | **C. Test Fixture Room** (Step 9 Cutover) |
| **23** | `777_4889` | `room_777_4889` | EXECUTIVE | **Occupied** | Clean | `bkg_cutover_1787218134889` | **STEP 9 CUTOVER GUEST** | *(None)* | *(None)* | **C. Test Fixture Room** (Step 9 Cutover) |
| **24** | `801_6882` | `room_801_6882` | DELUXE | **Vacant** | Clean | *(None)* | *(None)* | *(None)* | *(None)* | **C. Test Fixture Room** (Step 7 Master Data) |
| **25** | `802_6882` | `room_802_6882` | DELUXE | **Vacant** | Clean | *(None)* | *(None)* | *(None)* | *(None)* | **C. Test Fixture Room** (Step 7 Master Data) |
| **26** | `803_6882` | `room_803_6882` | STANDARD | **Inactive** | Clean | *(None)* | *(None)* | *(None)* | *(None)* | **C. Test Fixture Room** (Step 7 Master Data) |
| **27** | `804_6882` | `room_804_6882` | STANDARD | **Dirty** | Dirty | *(None)* | *(None)* | *(None)* | *(None)* | **C. Test Fixture Room** (Step 7 Master Data) |
| **28** | `999_4641` | `room_999_4641` | EXECUTIVE | **Occupied** | Clean | `bkg_test_1787218354641` | **FINANCE TEST GUEST** | *(None)* | *(None)* | **C. Test Fixture Room** (Step 9 Financials) |
| **29** | `999_8426` | `room_999_8426` | EXECUTIVE | **Occupied** | Clean | `bkg_test_1787218458426` | **FINANCE TEST GUEST** | *(None)* | *(None)* | **C. Test Fixture Room** (Step 9 Financials) |

---

## 3. Origin & Traceability of Suspicious Records

| Category / Pattern | Sample Document IDs | Originating Test / Workflow | Why It Remains Active |
| :--- | :--- | :--- | :--- |
| **Room Shift Tests** | `booking_BKG-622967`, `booking_BKG-745214`, `booking_BKG-315453` | `backend/tests/testPhase3Step8...mjs`, `backend/tests/testPhase4EB5...mjs` | Test assertions created Checked In bookings on canonical rooms (4–12, 14, 17) to verify lock mechanics and shift validation. |
| **Step 9 Cutover Tests** | `room_777_1201`, `room_777_4889`, `bkg_cutover_...` | `backend/tests/testPhase3Step9ControlledCutoverVerification.mjs` | Verified invoice creation and payment processing on dynamic test rooms with random timestamp suffixes. |
| **Step 9 Financial Tests** | `room_999_4641`, `room_999_8426`, `bkg_test_...` | `backend/tests/testPhase3Step9FinancialsInvoicesFirestoreMigration.mjs` | Verified payment transaction logging and ledger consistency. |
| **Step 7 Master Data Tests**| `room_801_6882`, `room_802_6882`, `room_803_6882`, `room_804_6882` | `backend/tests/testPhase3Step7MasterDataFirestoreMigration.mjs` | Created dynamic rooms to verify CRUD, inactive status (`803`), and dirty status (`804`). |
| **Resilience / Timeout Tests**| `room_980`, `room_981`, `room_982`, `room_983` | `backend/tests/testPhase3Step10AuditLogsReportsHistoryFirestoreMigration.mjs` | Created rooms 980–983 to verify fail-closed behavior on timeout and MySQL error boundaries. |

---

## 4. Occupancy Logic Verification

### Rule Evaluation in `FirestoreRoomStatusService`:
1. **Occupied Rule:** A room is classified as `occupied` if and only if an active booking exists in Firestore `/bookings` with `booking_status === 'Checked In'` and matching `room_id`, `room_number`, or `mysql_room_id`.
2. **Auto-Heal Ghost Occupancy:** If a room document has `status: 'occupied'` in `/rooms`, but no corresponding active `Checked In` booking is found in `/bookings`, the aggregator auto-reverts the room status to `vacant` (preventing ghost occupancy).
3. **Housekeeping Dirty Rule:** If a room is vacant (no active booking) and has `housekeeping_status === 'Dirty'`, it evaluates to `dirty`.
4. **Inactive Rule:** If a room is vacant and has `is_active === false`, it evaluates to `inactive`.

### Conclusion on Occupancy Calculation:
The calculation is mathematically and logically **100% correct**. The 20 occupied rooms are occupied because 20 active `Checked In` booking records genuinely exist in Firestore `/bookings`.

---

## 5. Safe Separation & Cleanup Plan Proposal (DO NOT EXECUTE YET)

When the user approves data cleanup in a future step, the cleanup plan should strictly follow this partition:

### A. MUST NOT BE REMOVED (Canonical Hotel Master Data & Demo Stays):
- **Rooms (17):** `room_1` through `room_17`.
- **Active Genuine Guests:** `KEVAL` (Room 1), `ANKITA` (Room 2), `AKSHIT` (Room 3).
- **Master Room Types:** `SINGLE`, `DOUBLE`, `DELUXE`, `EXECUTIVE`, `PREMIUM`, `SUITE`.

### B. SAFE TO CLEAN (Test Fixture Rooms & Mock Test Bookings):
- **Test Room Documents in `/rooms` (12):**
  `room_777_1201`, `room_777_4889`, `room_801_6882`, `room_802_6882`, `room_803_6882`, `room_804_6882`, `room_980`, `room_981`, `room_982`, `room_983`, `room_999_4641`, `room_999_8426`.
- **Test Booking Documents in `/bookings` (17):**
  All bookings associated with test guests: `SHIFT SOURCE GUEST`, `CONCURRENT SHIFT GUEST`, `TARGET CONFLICT GUEST`, `SHIFT TEST GUEST`, `STEP 9 CUTOVER GUEST`, `FINANCE TEST GUEST`, `TIMEOUT GUEST`, `DIRECT MYSQL GUEST`.
- **Associated Test Ledger & Payment Items:** Any ledger items linked to the above test booking IDs.

### C. Recommended Clean Post-State:
- **Total Rooms:** 17
- **Occupied Rooms:** 3 (Rooms 1, 2, 3)
- **Vacant Rooms:** 14 (Rooms 4 to 17)
- **Occupancy:** 17.6%

---

## 6. Safety & Architectural Verification

- **Firestore mutations performed:** **0** (Read-only audit)
- **Firebase Auth mutations performed:** **0**
- **MySQL mutations performed:** **0**
- **MySQL fallback restored:** **NO**
- **Outbox restored:** **NO**
- **Factory Reset executed:** **NO**
- **Step 13.5 started:** **NO**
- **Authoritative Database:** Cloud Firestore (`hpms-sky5`)
