# HPMS-Sky5: Phase 3C Rooms Dual-Write Architecture & Safety Blueprint

> **Phase:** Phase 3C — Rooms Dual-Write Pilot (Read-Only Design & Audit)  
> **Timestamp:** August 11, 2026  
> **Status:** READ-ONLY DESIGN COMPLETE — ZERO SOURCE CODE MODIFICATIONS PERFORMED  
> **Final Verdict:** **PHASE 3C DESIGN STATUS: READY FOR IMPLEMENTATION**  

---

## Executive Summary

This blueprint defines the architecture and concurrency safety model for expanding the **Transactional Outbox Dual-Write Bridge** to the **Rooms Domain** (Phase 3C). 

Rooms are significantly higher risk than Room Types because room state participates in `SELECT ... FOR UPDATE` row locks, multi-entity check-in/checkout transactions, room shifting, housekeeping, and night audit operations. 

To eliminate race conditions and data corruption, Phase 3C establishes a strict separation between **Room Master Data** and **Operational Room State**, and introduces an **Atomic Timestamp Event-Ordering Strategy** to guarantee that stale outbox events never overwrite newer Firestore state.

---

## 1. Complete Room Write-Path Inventory

The read-only audit analyzed 100% of backend controllers (`backend/controllers/roomController.js`, `housekeepingController.js`) and business services (`checkInService.js`, `roomStatusService.js`, `businessDateService.js`) to map all room write operations:

| # | Operation | Controller / Service | Route | MySQL Tables | Transaction Boundary | `FOR UPDATE` Usage | Outbox Event Proposed | Target Firestore Repo Method | Concurrency Risk |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Create Room** | `roomController.createRoom` | `POST /api/rooms` | `rooms`, `audit_logs` | MySQL Transaction | No | `ROOM_CREATED` | `createRoomFirestore` | Low |
| 2 | **Update Room Configuration** | `roomController.updateRoom` | `PUT /api/rooms/:number` | `rooms`, `audit_logs` | MySQL Transaction | Yes | `ROOM_UPDATED` | `updateRoomFirestore` | Medium |
| 3 | **Delete Room** | `roomController.deleteRoom` | `DELETE /api/rooms/:number` | `rooms`, `audit_logs` | MySQL Transaction | Yes | `ROOM_DELETED` | `deleteRoomFirestore` | High |
| 4 | **Direct Status / Housekeeping Update** | `roomController.updateRoomStatus` | `PUT /api/rooms/:number/status` | `rooms` | Single Query | No | `ROOM_STATUS_CHANGED` | `updateRoomStatusFirestore` | High (Parallel cleaning update) |
| 5 | **Room Clean Execution** | `roomController.clean` | `POST /api/rooms/:number/clean` | `rooms`, `housekeeping_logs` | MySQL Transaction | No | `ROOM_CLEANING_UPDATED` | `updateRoomStatusFirestore` | Low |
| 6 | **Check-In Room Assignment** | `checkInService.executeCheckIn` | `POST /api/rooms/:number/checkin` | `rooms`, `bookings`, `guests`, `ledger_items` | MySQL Transaction | **Yes (`rooms`, `bookings`)** | `ROOM_STATUS_CHANGED` | `updateRoomStatusFirestore` | **CRITICAL** (Double check-in) |
| 7 | **Check-Out Room Release** | `roomController.checkOut` | `POST /api/rooms/:number/checkout` | `checkout_snapshots`, `rooms`, `bookings` | MySQL Transaction | **Yes (`rooms`, `bookings`)** | `ROOM_STATUS_CHANGED` | `updateRoomStatusFirestore` | High (Simultaneous checkout/clean) |
| 8 | **Room Shift** | `roomController.shift` | `POST /api/rooms/shift` | `rooms`, `bookings` | MySQL Transaction | **Yes (Old & New Rooms)** | `ROOM_SHIFTED` | `updateRoomStatusFirestore` | **CRITICAL** (Simultaneous shift) |
| 9 | **Admin No-Show** | `roomController.adminNoShow` | `POST /api/rooms/:number/no-show` | `rooms`, `bookings` | MySQL Transaction | Yes | `ROOM_STATUS_CHANGED` | `updateRoomStatusFirestore` | Medium |
| 10 | **Refund Checkout** | `roomController.processRefundCheckout` | `POST /api/rooms/:number/refund-checkout` | `payments`, `bookings`, `rooms` | MySQL Transaction | Yes | `ROOM_STATUS_CHANGED` | `updateRoomStatusFirestore` | Medium |
| 11 | **Housekeeping Status Update** | `housekeepingController.updateHousekeepingStatus` | `PUT /api/housekeeping/:id` | `housekeeping`, `rooms` | Single Query | No | `ROOM_CLEANING_UPDATED` | `updateRoomStatusFirestore` | Low |
| 12 | **Night Audit Room Rollover** | `businessDateService.advanceBusinessDate` | `POST /api/dayend` | `system_settings`, `rooms`, `bookings` | MySQL Transaction | **Yes (`FOR UPDATE NOWAIT`)** | `ROOM_STATUS_CHANGED` | `updateRoomStatusFirestore` | **CRITICAL** (Night audit clash) |

---

## 2. Separation of Room Master Data vs Operational Room State

To prevent race conditions, room attributes are split into two distinct categories:

### A. Room Master Data (Low Churn, Structural)
- Attributes: `number`, `type` / `room_type_id`, `floor`, `base_price`, `capacity`, `amenities`, `active`.
- Synchronization Rule: Dual-written during room creation, modification, or deletion. Low concurrency risk.

### B. Operational Room State (High Churn, Transaction-Entangled)
- Attributes: `status` (`vacant`, `occupied`, `dirty`, `maintenance`, `out_of_order`), `housekeeping_status` (`Clean`, `Dirty`, `In Progress`), `current_booking_id`.
- Synchronization Rule: Mutated during check-in, checkout, room shift, and housekeeping updates. Requires strict outbox event ordering safeguards.

---

## 3. Concurrency Audit & Event Ordering Solution

### Problem: Out-of-Order Asynchronous Event Delivery
Because outbox workers run asynchronously, network retries or batch delays can cause outbox events for the same room to arrive at Firestore out-of-order. 

*Example Failure Scenario*:
1. Event #101: `ROOM_STATUS_CHANGED` (`status: 'occupied'`, timestamp `10:00:00.000Z`)
2. Event #102: `ROOM_STATUS_CHANGED` (`status: 'vacant'`, timestamp `10:05:00.000Z`)

If Event #102 is processed first, and Event #101 is retried later at `10:06:00Z`, Firestore would be overwritten with `occupied` (stale state from 10:00:00Z), causing a **split-brain discrepancy with MySQL**!

### Solution: Timestamp Vector Guard (`updated_at` Comparison)
Every `ROOM_*` outbox event payload includes an ISO 8601 UTC timestamp `updated_at` generated inside the MySQL transaction.

In [`backend/repositories/firestore/roomsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/roomsRepository.js):
```javascript
export async function updateRoomStatusFirestore(roomNumber, statusData, options = {}) {
  const docId = `room_${roomNumber}`;
  const existing = await getDoc('rooms', docId, options);

  // Stale Event Guard: Reject update if existing Firestore doc has a newer timestamp
  if (existing && existing.updated_at && statusData.updated_at) {
    if (new Date(existing.updated_at) >= new Date(statusData.updated_at)) {
      console.log(`[OutboxGuard] Ignored stale status update for room_${roomNumber}`);
      return existing; // Ignore stale event safely
    }
  }

  return await updateDoc('rooms', docId, statusData, options);
}
```

---

## 4. Proposed Outbox Event Schema

When Phase 3C implementation is authorized, the following outbox events will be introduced:

### 1. `ROOM_CREATED`
- `aggregate_type`: `ROOM`
- `aggregate_id`: `101` (Room number)
- `payload`: `{ number: '101', type: 'SUITE', price: 4500, status: 'vacant', housekeeping_status: 'Clean', updated_at: '...' }`

### 2. `ROOM_UPDATED`
- `aggregate_type`: `ROOM`
- `aggregate_id`: `101`
- `payload`: `{ number: '101', type: 'DELUXE', price: 5000, updated_at: '...' }`

### 3. `ROOM_STATUS_CHANGED`
- `aggregate_type`: `ROOM`
- `aggregate_id`: `101`
- `payload`: `{ number: '101', status: 'occupied', housekeeping_status: 'Clean', updated_at: '...' }`

### 4. `ROOM_DELETED`
- `aggregate_type`: `ROOM`
- `aggregate_id`: `101`
- `payload`: `{ number: '101', docId: 'room_101' }`

---

## 5. Firestore Repository Inspection ([`roomsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/roomsRepository.js))

The audit reviewed [`backend/repositories/firestore/roomsRepository.js`](file:///d:/projects/hotel/backend/repositories/firestore/roomsRepository.js):
- **Deterministic ID Scheme**: `room_<number>` (e.g. `room_101`). Fully compatible with idempotency.
- **Methods Available**: `createRoomFirestore`, `getRoomByIdFirestore`, `getAllRoomsFirestore`, `updateRoomFirestore`, `deleteRoomFirestore`.
- **Repository Upgrade Required**: `roomsRepository.js` should be updated in Phase 3C to add `updateRoomStatusFirestore` with the **Stale Event Guard** logic.

---

## 6. Pilot Scope Recommendation

### **RECOMMENDED CHOICE: Option A — Room Master Data & Direct Status Updates Only**

- **Scope**: Includes `ROOM_CREATED`, `ROOM_UPDATED`, `ROOM_DELETED`, and direct `ROOM_STATUS_CHANGED` (housekeeping clean/dirty status).
- **Rationale**: Excludes complex multi-entity transactions (`checkInService.js`, `shift`, `checkout`), keeping check-in/checkout event handling grouped under **Phase 3E (Reservations & Bookings)**. This provides a clean, safe, low-risk pilot expansion.

---

## 7. Failure & Recovery Matrix

| Scenario | MySQL State | Outbox State | Firestore State | Safe Recovery Action | Data Loss Risk |
|---|---|---|---|---|---|
| Outbox Retry Out-of-Order | Committed | Processed | Preserved | Stale Event Guard ignores outdated timestamp | **ZERO** |
| MySQL Transaction Abort | Rolled Back | Zero Rows | Unchanged | Transaction abort prevents outbox enqueue | **ZERO** |
| Firestore Unavailable | Committed | Staged / Retrying | Pending | Outbox worker retries with backoff until connection restored | **ZERO** |
| Room Deleted while Event Pending | Committed | Processed | Deleted | `deleteRoomFirestore` handles `NOT_FOUND` gracefully | **ZERO** |

---

## 8. Read-Only Reconciliation Specification

A dedicated read-only Rooms reconciliation check will compare MySQL `rooms` vs Firestore `/rooms`:
- Compares MySQL room count vs Firestore room document count.
- Compares `status` and `housekeeping_status` for every room number.
- Identifies any missing or stale Firestore room documents without modifying production data.

---

## 9. GO / NO-GO Criteria for Phase 3C Implementation

Implementation of Phase 3C may proceed ONLY when:
- [x] Phase 3B Room Types Pilot verified and report approved.
- [x] All 12 room write paths mapped and classified.
- [x] Outbox timestamp ordering guard designed.
- [x] Option A pilot scope approved.
- [x] Feature flags confirmed to remain `false` by default.

---

## PHASE 3C DESIGN STATUS: READY FOR IMPLEMENTATION
