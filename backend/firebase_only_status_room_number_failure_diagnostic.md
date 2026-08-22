# HPMS — /api/status "Room number is missing" Root-Cause Diagnostic Report
**Document:** `backend/firebase_only_status_room_number_failure_diagnostic.md`  
**Execution Phase:** Phase 2 — Read-Only Diagnostic Investigation  
**System:** Webline PMS Plus / HPMS-Sky5  
**Timestamp:** 2026-08-21T14:53:00+05:30  

---

## 1. Executive Summary & Root Cause

The `/api/status` endpoint was returning `HTTP 500` with:
`{"error": "FIRESTORE_VALIDATION_FAILED: Room number is missing", "code": "STATUS_ERROR", "backend_online": true}`.

### Exact Failing Chain:
1. **Failing Function:** `SafeCutoverFallbackService.validateRoomStatuses(rooms)` in [`backend/services/safeCutoverFallbackService.js`](file:///d:/projects/hotel/backend/services/safeCutoverFallbackService.js) at line 34.
2. **Causing Transformation:** `FirestoreRoomStatusService._fetchRoomStatusesFromFirestore` in [`backend/services/firestoreRoomStatusService.js`](file:///d:/projects/hotel/backend/services/firestoreRoomStatusService.js) at line 238:
   ```javascript
   const roomNumStr = String(r.number || '');
   ```
3. **The Data Reality in Firestore `rooms` Collection:**
   In Firestore, while the standard rooms (1–17) contain `{ number: "1", ... }`, several test/cutover documents created during earlier step verifications exist in `/rooms`:
   - `room_777_1201`: has `{ room_number: "777_1201" }` without `number`.
   - `room_777_4889`: has `{ room_number: "777_4889" }` without `number`.
   - `room_980`, `room_981`, `room_982`, `room_983`: have doc ID `room_980` with `{ status: "occupied", current_booking_id: "..." }` where the room number is in the document ID itself (`room_980`).
   - `room_999_4641`, `room_999_8426`: have `{ room_number: "999_4641" }` without `number`.
4. **Why `/api/status` Failed:**
   Because `r.number` was `undefined` on those documents, `roomNumStr` evaluated to `""` (empty string).
   In `processedRooms`, `number: ""` was produced.
   `SafeCutoverFallbackService.validateRoomStatuses` checked `if (!r.number && r.number !== 0)` and failed the array with `Room number is missing`.
   Because Step 13.2 decommissioned MySQL fallback (fail-closed architecture), the controller threw a 500 error instead of falling back to MySQL, causing the Admin Dashboard to receive `HTTP 500` and display 0 rooms.

---

## 2. Schema Comparison

### Expected Output Room Schema:
```typescript
interface ProcessedRoom {
  id: string | number;
  doc_id: string;
  number: string; // Non-empty string representing room number (e.g. "101", "7", "980")
  type: string;
  status: 'occupied' | 'vacant' | 'dirty' | 'inactive' | 'booked';
  is_active: boolean;
  housekeeping_status: 'Clean' | 'Dirty';
  rate: number;
  // ... 27 canonical room response fields
}
```

### Actual Firestore Document Formats Found in `/rooms`:
1. **Format A (Standard Master Seed):**
   `{"id": "room_7", "number": "7", "type": "EXECUTIVE", "status": "occupied", ...}`
2. **Format B (Cutover / Test Fixture):**
   `{"id": "room_777_1201", "room_number": "777_1201", "status": "occupied", ...}`
3. **Format C (Doc-ID Keyed Partial Update):**
   `{"id": "room_980", "status": "occupied", "current_booking_id": "bkg_BKG-237877", ...}`

---

## 3. Did Phase A / B / C Cause or Expose the Issue?

- **Phase A (Query Scoping):** Reduced status reads from 2,150 to ~45 by scoping bookings/guests. It did not alter the room document extraction logic.
- **Phase B (Short-TTL Caching):** Cached the computed room status.
- **Phase C (Budget Monitor):** Added budget telemetry.
- **Root Trigger:** The issue was exposed because `SafeCutoverFallbackService.validateRoomStatuses` was added during Phase 2 Step 3 to ensure strict data validation before serving. When `FirestoreRoomStatusService` processed room documents whose room number was in `r.room_number` or in the document ID `room_<number>`, `String(r.number || '')` became `""`, triggering the validation guard.

---

## 4. Minimal Safe Fix Proposal

In [`backend/services/firestoreRoomStatusService.js`](file:///d:/projects/hotel/backend/services/firestoreRoomStatusService.js):
Robustly resolve `roomNumStr` and `roomDocId` from all valid canonical room number representations:
```javascript
const roomNumStr = String(
  r.number ||
  r.room_number ||
  r.roomNumber ||
  r.room_no ||
  (r.id ? String(r.id).replace(/^room_/, '') : '') ||
  (r.docId ? String(r.docId).replace(/^room_/, '') : '') ||
  ''
).trim();
const roomDocId = r.id || r.docId || (roomNumStr ? formatRoomId(roomNumStr) : null);
```

Also in [`backend/services/housekeepingCutoverService.js`](file:///d:/projects/hotel/backend/services/housekeepingCutoverService.js):
```javascript
number: String(r.number || r.room_number || (r.id ? String(r.id).replace(/^room_/, '') : '') || '').trim(),
```

### Safety Invariants:
- **Files to Modify:** `backend/services/firestoreRoomStatusService.js`, `backend/services/housekeepingCutoverService.js`.
- **Files NOT to Modify:** `backend/db.js`, `checkInFirestoreAdapter.js`, `checkOutFirestoreAdapter.js`, `roomShiftFirestoreAdapter.js`, `paymentCutoverService.js`, `invoiceCutoverService.js`.
- **Zero Firestore Data Mutations:** The fix handles all existing and future document representations in code without modifying Firestore production data.
- **Zero MySQL Restorations:** Fails closed, operates 100% on authoritative Firestore.
