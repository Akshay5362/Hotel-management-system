# HPMS — Check-Out / Room Occupancy Consistency & Factory Reset Diagnostic Report
**Document:** `backend/firebase_only_checkout_factory_reset_consistency_diagnostic.md`  
**Execution Phase:** Read-Only Deep Diagnostic Investigation  
**System:** Webline PMS Plus / HPMS-Sky5  
**Authoritative Database:** Cloud Firestore (`hpms-sky5`)  
**Timestamp:** 2026-08-21T15:42:30+05:30  

---

## 1. Executive Summary & Root Cause

### Core Problem:
The Admin Dashboard displays **Room 2 as Occupied with guest ANKITA**, but executing Check-Out for Room 2 fails with:
`{"error": "Room 2 is not occupied", "code": "ROOM_NOT_OCCUPIED"}`.

### The Exact Root Cause:
1. **Dashboard (`GET /api/status`) Decision Path:**
   `FirestoreRoomStatusService` queries the `/bookings` collection for active bookings (`booking_status in ['Checked In', 'Reserved']`). It finds document `bkg_BKG-381166` (`booking_status: 'Checked In'`, `guest_name: 'ANKITA'`, `room_number: '2'`). Because an active `Checked In` booking exists for Room 2, the status aggregator computes Room 2 as **`occupied`**.
2. **Check-Out (`POST /api/rooms/:number/checkout`) Decision Path:**
   `processCheckOutFirestoreTransaction` in [`checkOutFirestoreAdapter.js`](file:///d:/projects/hotel/backend/adapters/firestore/checkOutFirestoreAdapter.js) reads the physical room document `/rooms/room_2`.
   In Firestore `/rooms/room_2`, the room document contains:
   - `status: 'dirty'` (not `'occupied'`)
   - `current_booking_id: 'bkg_BKG-611860'` (an obsolete historical checked-out booking for guest `GGGG`).
   Line 51 of `checkOutFirestoreAdapter.js` strictly checks `if (roomData.status !== 'occupied')` and throws:
   `Error("Room 2 is not occupied")` with `code: 'ROOM_NOT_OCCUPIED'`.
3. **Double Failure in Check-Out:**
   Even if `roomData.status` were bypassed, `checkOutFirestoreAdapter.js` lines 59–67 attempts to read `roomData.current_booking_id` (`bkg_BKG-611860`). Because `bkg_BKG-611860` has `booking_status: 'Checked Out'`, line 77 throws:
   `Error("Booking for Room 2 is already checked out")`.
   `checkOutFirestoreAdapter.js` lacks the dynamic query fallback present in `FirestoreRoomStatusService` to find the authoritative `Checked In` booking (`bkg_BKG-381166`) when `current_booking_id` is stale or missing.

---

## 2. Room 2 Data & Active Booking Trace

### A. Raw Firestore Room Document (`/rooms/room_2`):
```json
{
  "id": "room_2",
  "number": "2",
  "room_number": "2",
  "type": "EXECUTIVE",
  "room_type_code": "EXECUTIVE",
  "room_type_id": 2,
  "room_type_title": "Executive Work Room",
  "price": 2000,
  "base_rate": 2000,
  "status": "dirty",
  "housekeeping_status": "Dirty",
  "cleaning_status": "Clean",
  "is_active": true,
  "current_booking_id": "bkg_BKG-611860",
  "mysql_room_id": 2,
  "mysql_id": 2
}
```

### B. All Bookings Linked to Room 2 in `/bookings`:
1. `bkg_BKG-348266`: Guest `HARSH`, Status `Checked Out` (Historical)
2. `bkg_BKG-381166`: Guest `ANKITA`, Status **`Checked In`** (Check-in: `20-Aug-2026`, Expected Out: `2026-08-21 11:00`) — **AUTHORITATIVE ACTIVE STAY**
3. `bkg_BKG-611860`: Guest `GGGG`, Status `Checked Out` (Historical — Stale pointer in room document)

---

## 3. Decision Path Comparison: Dashboard vs. Check-Out

| Stage | Operation / Workflow | Code Location | Data Source & Lookup | Expected Condition | Actual State in Firestore | Outcome |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A** | **Dashboard Occupancy Aggregator** | `FirestoreRoomStatusService.js` (L105–L257) | Scoped query on `/bookings` where `booking_status == 'Checked In'` and matches Room 2 | Finds matching active booking | Found `bkg_BKG-381166` (`Checked In`, ANKITA) | Room 2 evaluated as **`occupied`** |
| **B** | **Check-Out Room Status Check** | `checkOutFirestoreAdapter.js` (L51) | Point read on `/rooms/room_2` | `roomData.status === 'occupied'` | `roomData.status === 'dirty'` | **Throws 400: `Room 2 is not occupied`** |
| **C** | **Check-Out Active Booking Lookup** | `checkOutFirestoreAdapter.js` (L59) | Reads document referenced by `roomData.current_booking_id` | Document exists with `booking_status === 'Checked In'` | Reads stale `bkg_BKG-611860` (`Checked Out`) | **Throws 400: `Already checked out`** |

---

## 4. Analysis of Rooms 1, 2, and 3 Consistency

All 3 currently occupied rooms have the exact same inconsistency between their room document and their authoritative active booking in `/bookings`:

| Room | Stored Room Document Status | Stored `current_booking_id` | Authoritative Active Booking (`Checked In`) | Dashboard Output | Check-Out Execution Outcome |
| :---: | :---: | :---: | :---: | :---: | :--- |
| **Room 1** | `vacant` | `null` | `bkg_BKG-794888` (Guest: **KEVAL**) | Occupied (KEVAL) | **Fails: `Room 1 is not occupied`** |
| **Room 2** | `dirty` | `bkg_BKG-611860` (Checked Out) | `bkg_BKG-381166` (Guest: **ANKITA**) | Occupied (ANKITA) | **Fails: `Room 2 is not occupied`** |
| **Room 3** | `dirty` | `bkg_BKG-508313` (Checked Out) | `bkg_BKG-295734` (Guest: **AKSHIT**) | Occupied (AKSHIT) | **Fails: `Room 3 is not occupied`** |

---

## 5. Why Dashboard Displays "Booked" / Occupied (Cache Audit)

- **Root Driver:** The dashboard state is driven by the live `/bookings` collection where `bkg_BKG-381166` is genuinely `Checked In`.
- **Cache Contribution:** Phase B's 5-second TTL cache (`room_status_...`) caches the successful aggregation. When the backend or client refreshes, the 5-second cache re-executes `_fetchRoomStatusesFromFirestore()`, which re-queries `/bookings` and consistently finds the 3 active `Checked In` bookings.
- **Conclusion:** The dashboard display is NOT stale cache; it reflects the true authoritative state of the `/bookings` collection.

---

## 6. Factory Reset Diagnostic & Failure Root Cause

### Why Data Factory Reset Currently Does Not Work:
1. **Feature Flag State:** In `backend/.env`, `USE_FIRESTORE_FACTORY_RESET=false`.
2. **Cutover Routing:** In [`factoryResetCutoverService.js`](file:///d:/projects/hotel/backend/services/factoryResetCutoverService.js):
   ```javascript
   if (!isFirestoreFactoryResetEnabled()) {
     return typeof mysqlFallbackFn === 'function' ? mysqlFallbackFn() : FactoryResetService.verifyReset();
   }
   ```
   Because the flag is `false`, reset requests route to legacy MySQL [`FactoryResetService.js`](file:///d:/projects/hotel/backend/services/FactoryResetService.js), which executes SQL queries (`DELETE FROM rooms`, `TRUNCATE bookings`).
3. **Decommissioned MySQL Architecture:** Since Phase 3 Step 13.2, MySQL cutovers fail-closed and MySQL is no longer the runtime database. Running reset on MySQL produces zero mutations in Firestore.
4. **Security Guards:** `POST /api/system/factory-reset` requires `requireSuperAdmin` and confirmation phrase `"RESET HOTEL DATA"`.

### Factory Reset Safety Assessment (If Enabled):
- **Scope:** [`firestoreFactoryResetService.js`](file:///d:/projects/hotel/backend/services/firestoreFactoryResetService.js) is designed as a **DEVELOPMENT/QA RESET**.
- **What It Purges:** Deletes all transactional collections (`bookings`, `guests`, `reservations`, `ledger_items`, `payments`, `invoices`, `audit_logs`, `cash_logs`, `housekeeping_logs`, guest-uploaded ID files).
- **What It Preserves:** Master data collections (`roles`, `permissions`, `staff`, `room_types`, `inventory_*`) and staff/admin accounts in `/users`.
- **Room State After Reset:** Resets all rooms in `/rooms` to `status: 'vacant'`, `housekeeping_status: 'Clean'`, `current_booking_id: null`.

---

## 7. Minimal Safe Fix Proposal (Read-Only Recommendation)

When approved, the minimal production-safe resolution requires two coordinated actions:

### Action A: Check-Out Adapter Active Booking Resolution
Update [`checkOutFirestoreAdapter.js`](file:///d:/projects/hotel/backend/adapters/firestore/checkOutFirestoreAdapter.js) to dynamically resolve the active `Checked In` booking for the room if `roomData.current_booking_id` is missing, stale, or if `roomData.status` is not explicitly `'occupied'`:
```javascript
// Dynamic active booking resolution fallback inside checkout transaction
let activeBookingDocId = roomData.current_booking_id;
let activeBookingData = null;

if (activeBookingDocId) {
  const bSnap = await transaction.get(db.collection('bookings').doc(activeBookingDocId));
  if (bSnap.exists && bSnap.data().booking_status === 'Checked In') {
    activeBookingData = bSnap.data();
  }
}

// Fallback query if current_booking_id was stale or null
if (!activeBookingData) {
  const activeBkgQuery = await db.collection('bookings')
    .where('room_number', '==', String(number))
    .where('booking_status', '==', 'Checked In')
    .limit(1)
    .get();
  
  if (!activeBkgQuery.empty) {
    activeBookingDocId = activeBkgQuery.docs[0].id;
    activeBookingData = activeBkgQuery.docs[0].data();
  }
}
```

### Action B: Synchronize Rooms 1, 2, 3 Document Pointers
Synchronize the room documents `/rooms/room_1`, `/rooms/room_2`, `/rooms/room_3` in Firestore so their `status` is `'occupied'` and their `current_booking_id` points to their active bookings (`bkg_BKG-794888`, `bkg_BKG-381166`, `bkg_BKG-295734`).

---

## 8. Safety Verification & Invariants

- **Firestore mutations performed during diagnostic:** **0**
- **MySQL mutations performed during diagnostic:** **0**
- **Firebase Auth mutations performed during diagnostic:** **0**
- **Factory Reset executed:** **NO**
- **Phase 3 Step 13.5 started:** **NO**
- **MySQL fallback restored:** **NO**
- **Outbox restored:** **NO**
- **Authoritative Primary Database:** Cloud Firestore (`hpms-sky5`)
