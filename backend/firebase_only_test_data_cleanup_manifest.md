# HPMS — Production Firestore Test Data Cleanup Manifest
**Document:** `backend/firebase_only_test_data_cleanup_manifest.md`  
**Execution Phase:** Phase 1 & 2 — Pre-Cleanup Manifest & Safety Verification  
**System:** Webline PMS Plus / HPMS-Sky5  
**Authoritative Database:** Google Cloud Firestore (`hpms-sky5`)  
**Timestamp:** 2026-08-21T15:09:40+05:30  

---

## 1. Safety Boundaries & Preservation Contract

The following canonical hotel production records are strictly **PRESERVED** and will **NEVER** be deleted or modified:

1. **Canonical Hotel Rooms (17 total):**
   - `room_1`, `room_2`, `room_3`, `room_4`, `room_5`, `room_6`, `room_7`, `room_8`, `room_9`, `room_10`, `room_11`, `room_12`, `room_13`, `room_14`, `room_15`, `room_16`, `room_17`.
2. **Preserved Genuine Guest Stays & Bookings:**
   - **KEVAL** (Room 1, booking `bkg_BKG-794888` / `bkg_BKG-316416`)
   - **ANKITA** (Room 2, booking `bkg_BKG-381166`)
   - **AKSHIT** (Room 3, booking `bkg_BKG-295734`)
   - All associated guest profiles, ledger items, payments, and folio history.
3. **Master Room Types & System Settings:**
   - Room types (`SINGLE`, `DOUBLE`, `DELUXE`, `EXECUTIVE`, `PREMIUM`, `SUITE`)
   - System date and hotel configuration.

---

## 2. Test Fixture Rooms to Delete (12 documents)

| Document ID | Collection | Room Number | Type | Reason for Deletion |
| :--- | :--- | :---: | :--- | :--- |
| `room_777_1201` | `rooms` | `777_1201` | EXECUTIVE | Automated test room created during Step 9 Invoice/Payment Cutover verification |
| `room_777_4889` | `rooms` | `777_4889` | EXECUTIVE | Automated test room created during Step 9 Invoice/Payment Cutover verification |
| `room_801_6882` | `rooms` | `801_6882` | DELUXE | Automated test room created during Step 7 Master Data verification |
| `room_802_6882` | `rooms` | `802_6882` | DELUXE | Automated test room created during Step 7 Master Data verification |
| `room_803_6882` | `rooms` | `803_6882` | STANDARD | Automated test room created during Step 7 Master Data verification |
| `room_804_6882` | `rooms` | `804_6882` | STANDARD | Automated test room created during Step 7 Master Data verification |
| `room_980` | `rooms` | `980` | EXECUTIVE | Automated test room created during Step 10 Timeout & Resilience verification |
| `room_981` | `rooms` | `981` | EXECUTIVE | Automated test room created during Step 10 Direct MySQL verification |
| `room_982` | `rooms` | `982` | EXECUTIVE | Automated test room created during Housekeeping dirty test fixture |
| `room_983` | `rooms` | `983` | EXECUTIVE | Automated test room created during Housekeeping dirty test fixture |
| `room_999_4641` | `rooms` | `999_4641` | EXECUTIVE | Automated test room created during Step 9 Financials verification |
| `room_999_8426` | `rooms` | `999_8426` | EXECUTIVE | Automated test room created during Step 9 Financials verification |

---

## 3. Test Bookings to Delete (38 documents)

| Document ID | Guest Name | Room Number / ID | Status | Reason for Deletion |
| :--- | :--- | :---: | :---: | :--- |
| `bkg_BKG-151544` | DIRECT MYSQL GUEST | 981 | Checked In | Step 10 Direct MySQL test fixture |
| `bkg_BKG-201948` | DIRECT MYSQL GUEST | 981 | Checked In | Step 10 Direct MySQL test fixture |
| `bkg_BKG-237877` | TIMEOUT GUEST | 980 | Checked In | Step 10 Timeout test fixture |
| `bkg_BKG-283337` | TIMEOUT GUEST | 980 | Checked In | Step 10 Timeout test fixture |
| `bkg_BKG-321220` | DIRECT MYSQL GUEST | 981 | Checked In | Step 10 Direct MySQL test fixture |
| `bkg_BKG-385312` | TIMEOUT GUEST | 980 | Checked In | Step 10 Timeout test fixture |
| `bkg_BKG-455906` | TIMEOUT GUEST | 980 | Checked In | Step 10 Timeout test fixture |
| `bkg_BKG-599777` | DIRECT MYSQL GUEST | 981 | Checked In | Step 10 Direct MySQL test fixture |
| `bkg_BKG-606588` | TIMEOUT GUEST | 980 | Checked In | Step 10 Timeout test fixture |
| `bkg_BKG-762185` | TIMEOUT GUEST | 980 | Checked In | Step 10 Timeout test fixture |
| `bkg_BKG-787573` | TIMEOUT GUEST | 980 | Checked In | Step 10 Timeout test fixture |
| `bkg_BKG-819081` | DIRECT MYSQL GUEST | 981 | Checked In | Step 10 Direct MySQL test fixture |
| `bkg_BKG-935279` | DIRECT MYSQL GUEST | 981 | Checked In | Step 10 Direct MySQL test fixture |
| `bkg_BKG-972815` | DIRECT MYSQL GUEST | 981 | Checked In | Step 10 Direct MySQL test fixture |
| `bkg_cutover_1787218134889` | STEP 9 CUTOVER GUEST | 777_4889 | Checked In | Step 9 Cutover test fixture |
| `bkg_cutover_1787218261201` | STEP 9 CUTOVER GUEST | 777_1201 | Checked In | Step 9 Cutover test fixture |
| `bkg_test_1787218354641` | FINANCE TEST GUEST | 999_4641 | Checked In | Step 9 Financial test fixture |
| `bkg_test_1787218458426` | FINANCE TEST GUEST | 999_8426 | Checked In | Step 9 Financial test fixture |
| `bkg_test_step10_1787220352825`| *(Test)* | 888 | Checked In | Step 10 Test fixture |
| `booking_BKG-145814` | SHIFT SOURCE GUEST | 9 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-230401` | SHIFT SOURCE GUEST | 12 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-315453` | TARGET CONFLICT GUEST | 6 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-409724` | SHIFT TEST GUEST | 8 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-412857` | CONCURRENT SHIFT GUEST | 8 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-421489` | CONCURRENT SHIFT GUEST | 8 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-441028` | SHIFT SOURCE GUEST | 9 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-464146` | SHIFT SOURCE GUEST | 11 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-583999` | TARGET CONFLICT GUEST | 10 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-622967` | SHIFT SOURCE GUEST | 4 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-693355` | SHIFT SOURCE GUEST | 14 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-745214` | CONCURRENT SHIFT GUEST | 5 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-784308` | CONCURRENT SHIFT GUEST A | 17 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_BKG-918014` | SHIFT TEST GUEST | 7 | Checked In | Phase 3 Step 8 Room Shift test fixture |
| `booking_test_bkg_cutover_...` (5 docs) | *(Test Cutover)* | 901 | Reserved | Step 8 Reservation Cutover test fixtures |

---

## 4. Dependent Test-Only Records to Delete

- **Test Guests (28 documents):** `guest_555*` and `guest_9*` exclusively created for `SHIFT SOURCE GUEST`, `CONCURRENT SHIFT GUEST`, `TARGET CONFLICT GUEST`, `SHIFT TEST GUEST`, `DIRECT MYSQL GUEST`, `TIMEOUT GUEST`.
- **Test Ledger Items (35 documents):** Ledger line items linked directly to the above test booking IDs or test rooms.
- **Test Payments (5 documents):** Payment transactions linked to test bookings.
- **Test Invoices (4 documents):** Invoices linked to test bookings.

---

## 5. Canonical Room Operational State Reset (11 Rooms)

After their test bookings are deleted, the following canonical rooms will have their operational state restored to `status = 'vacant'`, `housekeeping_status = 'Clean'`, `cleaning_status = 'Clean'`, `current_booking_id = null`:
- `room_4`, `room_5`, `room_6`, `room_7`, `room_8`, `room_9`, `room_10`, `room_11`, `room_12` (Room #14), `room_14` (Room #17), `room_17` (Room #12).

---

## 6. Pre-Cleanup Verification Checks

- Cross-reference with `KEVAL`: **0 test records linked**
- Cross-reference with `ANKITA`: **0 test records linked**
- Cross-reference with `AKSHIT`: **0 test records linked**
- Cross-reference with rooms 1, 2, 3: **0 deletions targeted**
- Safety verification: **PASSED (100%)**
