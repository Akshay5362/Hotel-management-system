# HPMS — Production-Safe Check-Out Consistency & Stale-Pointer Hardening Report
**Document:** `backend/firebase_only_checkout_consistency_fix_report.md`  
**Execution Phase:** Production-Safe Data Consistency & Check-Out Hardening  
**System:** Webline PMS Plus / HPMS-Sky5  
**Authoritative Database:** Cloud Firestore (`hpms-sky5`)  
**Timestamp:** 2026-08-21T15:46:15+05:30  

---

## 1. Root Cause Summary

### Why Check-Out Previously Failed with "Room 2 is not occupied":
1. **Decision Path Disconnect:**
   - **Dashboard (`GET /api/status`):** `FirestoreRoomStatusService` queries `/bookings` for `booking_status in ['Checked In', 'Reserved']` and matched `bkg_BKG-381166` (ANKITA) to Room 2, correctly displaying it as **`occupied`**.
   - **Check-Out (`POST /api/rooms/:number/checkout`):** `checkOutFirestoreAdapter.js` previously performed a rigid check on `/rooms/room_2.status === 'occupied'` and required `/rooms/room_2.current_booking_id` to point to the active booking.
2. **Stale Pointer & Desynchronized Status:**
   - In Firestore, `/rooms/room_2` had `status: 'dirty'` and `current_booking_id: 'bkg_BKG-611860'` (an obsolete historical checked-out stay for guest `GGGG`).
   - Consequently, Check-Out rejected the operation before locating the true active stay.

---

## 2. Before State vs. Repair Mutations

### Phase 1: Pre-Mutation Verification
Verified that each occupied room in `/bookings` has **exactly 1** active `Checked In` stay:
- **Room 1:** `bkg_BKG-794888` (Guest: **KEVAL**, Check-in: `20-Aug-2026`)
- **Room 2:** `bkg_BKG-381166` (Guest: **ANKITA**, Check-in: `20-Aug-2026`)
- **Room 3:** `bkg_BKG-295734` (Guest: **AKSHIT**, Check-in: `19-Aug-2026`)

### Phase 2: Exact Firestore Mutations Performed
Updated ONLY the document status and active booking pointers on the 3 occupied rooms:
1. `rooms/room_1`: `status = "occupied"`, `current_booking_id = "bkg_BKG-794888"`
2. `rooms/room_2`: `status = "occupied"`, `current_booking_id = "bkg_BKG-381166"`
3. `rooms/room_3`: `status = "occupied"`, `current_booking_id = "bkg_BKG-295734"`

*Zero changes were made to tariffs, room numbers, room types, guests, ledger items, or invoices.*

---

## 3. Check-Out Adapter Hardening & Fail-Closed Fallback

Updated [`backend/adapters/firestore/checkOutFirestoreAdapter.js`](file:///d:/projects/hotel/backend/adapters/firestore/checkOutFirestoreAdapter.js) to resolve active stays dynamically and safely:

1. **Primary Path:**
   - Checks `roomData.current_booking_id`. If it points to an existing booking with matching room number/ID and `booking_status === 'Checked In'`, it uses it directly.
2. **Safe Fallback Query:**
   - If `current_booking_id` is null, stale, checked out, or points to another room, it executes a transactional query on `/bookings` for `where('room_number', '==', roomNumStr).where('booking_status', '==', 'Checked In')`.
3. **Fail-Closed Concurrency & Data Consistency Guards:**
   - **Exactly 1 active booking found:** Continues the authoritative check-out transaction.
   - **0 active bookings found:** Throws HTTP 400 `ROOM_NOT_OCCUPIED: Room ${number} is not occupied`.
   - **>1 active bookings found:** Throws HTTP 409 `DATA_INCONSISTENCY: Multiple active Checked In bookings found for Room ${number}`.
4. **Transaction Safety Preserved:**
   - Entire resolution occurs inside `db.runTransaction()`.
   - Folio calculation, invoice generation, settlement logging, cash logs, checkout snapshots, and room transition to `dirty` remain 100% atomic.

---

## 4. Verification & Test Results

### A. Non-Mutating Check-Out Tests ([`testCheckoutConsistencyAndFallback.mjs`](file:///d:/projects/hotel/backend/tests/testCheckoutConsistencyAndFallback.mjs)):
- **Room Documents Integrity:** Verified Rooms 1, 2, 3 as `occupied` with correct active booking IDs.
- **Active Stay Resolution:** Successfully resolved `bkg_BKG-794888` (KEVAL), `bkg_BKG-381166` (ANKITA), `bkg_BKG-295734` (AKSHIT).
- **Vacant Room Check-Out Validation (Room 4):** Rejected with HTTP 400 `ROOM_NOT_OCCUPIED`.
- **Non-Existent Room Validation (Room 99):** Rejected with HTTP 404 `ROOM_NOT_FOUND`.

### B. Live Endpoints:
- `GET /api/health` -> **HTTP 200 OK**
- `GET /api/status` -> **HTTP 200 OK**
  - **Total Rooms:** 17
  - **Occupied:** 3 (Rooms 1, 2, 3)
  - **Vacant:** 14 (Rooms 4–12, 14, 16, 17, 19, 20)
  - **Occupancy Rate:** 17.6%
- `npm run build` -> **PASSED (0 errors, 12.21s)**

---

## 5. System Status & Safety Invariants

- **Authoritative Database:** Cloud Firestore (`hpms-sky5`)
- **MySQL Fallback:** **DISABLED** (Fail-closed)
- **Outbox:** **DISABLED**
- **Factory Reset Executed:** **NO** (`USE_FIRESTORE_FACTORY_RESET=false`)
- **Phase 3 Step 13.5 Started:** **NO**
- **Total Firestore Mutations in this Fix:** **3** room pointer updates
- **Operational Guests Preserved:** **KEVAL** (Room 1), **ANKITA** (Room 2), **AKSHIT** (Room 3) remain checked in.
- **Read Budget Utilization:** **0.38%** (190 / 50,000 daily reads used; 34,810 safety headroom remaining).
