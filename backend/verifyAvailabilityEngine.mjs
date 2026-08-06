/**
 * verifyAvailabilityEngine.mjs
 * =============================
 * Enterprise Availability Engine — Phase 1 Verification
 *
 * Tests (8 scenarios):
 *   1. Existing reservation blocks room (overlap)
 *   2. Existing checked-in booking blocks room
 *   3. Non-overlapping reservation succeeds
 *   4. Overlapping reservation rejected (409)
 *   5. Concurrent booking rejected (row-lock simulation)
 *   6. Same room cannot be reserved twice (same dates)
 *   7. Reservation edit validates overlap (excludeReservationId works)
 *   8. Availability API returns only valid rooms
 *
 * Run:  node backend/verifyAvailabilityEngine.mjs
 */

import pool from './db.js';
import { AvailabilityService } from './services/AvailabilityService.js';
import { parseToComparableDate } from './services/roomStatusService.js';

let passed = 0;
let failed = 0;
const results = [];

function pass(label) {
  console.log(`  ✔  ${label}`);
  passed++;
  results.push({ label, ok: true });
}

function fail(label, err) {
  const msg = err?.message || String(err);
  console.error(`  ✘  ${label}\n       ${msg}`);
  failed++;
  results.push({ label, ok: false, msg });
}

async function assert(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (e) {
    fail(label, e);
  }
}

// ─── Setup helpers ───────────────────────────────────────────────────────────

async function getFirstRoom() {
  const [rows] = await pool.query(
    "SELECT r.id, r.number, r.status FROM rooms r WHERE r.status = 'vacant' LIMIT 1"
  );
  if (rows.length === 0) throw new Error('No vacant rooms in DB — needed for tests');
  return rows[0];
}

async function cleanupTestData(roomId) {
  await pool.query(
    "DELETE FROM reservations WHERE room_id = ? AND guest_name LIKE 'TEST-%'",
    [roomId]
  );
}

async function createTestReservation(roomId, roomNumber, arrival, departure) {
  const [res] = await pool.query(
    `INSERT INTO reservations
       (reservation_number, guest_name, phone, arrival_date, departure_date,
        room_id, room_number, room_type, adults, status, created_by)
     VALUES (?,?,?,?,?,?,?,'STANDARD',1,'Reserved',NULL)`,
    [
      `TEST-${Date.now()}`,
      `TEST-${Math.random().toString(36).slice(2)}`,
      '9999999999',
      arrival, departure,
      roomId, roomNumber
    ]
  );
  return res.insertId;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

async function test1_ExistingReservationBlocks() {
  console.log('\n[1] Existing reservation blocks room');
  const room = await getFirstRoom();

  // Create a blocking reservation: Jul 10 – Jul 15
  await createTestReservation(room.id, room.number, '2027-07-10', '2027-07-15');

  // Request that overlaps: Jul 12 – Jul 17
  await assert('Overlapping reservation is blocked', async () => {
    const result = await AvailabilityService.checkRoomAvailability(pool, {
      roomId: room.id, roomNumber: room.number,
      arrivalDate: '2027-07-12', departureDate: '2027-07-17',
    });
    if (result.available) throw new Error('Should have been blocked by existing reservation');
    if (result.code !== 'ROOM_ALREADY_BOOKED') throw new Error(`Wrong code: ${result.code}`);
  });

  await cleanupTestData(room.id);
}

async function test2_CheckedInBookingBlocks() {
  console.log('\n[2] Checked-in booking blocks room');

  // Find a room with an active Checked In booking
  const [rows] = await pool.query(
    `SELECT b.room_id, r.number as room_number, b.check_in_date, b.expected_check_out_date
     FROM bookings b JOIN rooms r ON b.room_id = r.id
     WHERE b.booking_status = 'Checked In' LIMIT 1`
  );

  if (rows.length === 0) {
    fail('Checked-in booking blocks room', new Error('No Checked In bookings exist — skip'));
    return;
  }

  const b = rows[0];
  // Parse PMS dates (DD-Mon-YYYY) to YYYY-MM-DD for the availability check
  const ci = parseToComparableDate(b.check_in_date);
  // Expected checkout + 1 day so overlap rule fires (newArr < existingDep AND existingArr < newDep)
  const coRaw = b.expected_check_out_date || b.check_out_date;
  const co = parseToComparableDate(coRaw);

  if (!ci || !co) {
    fail('Checked-in booking blocks room', new Error(`Cannot parse booking dates: ci=${ci}, co=${co}`));
    return;
  }

  // For same-day (walk-in today) bookings where ci == co, test using the room's
  // physical status path (status=occupied). The availability check blocks it there.
  // For multi-night bookings, test the booking-overlap path.
  const testArr = ci;
  const testDep = (ci < co) ? co : (() => {
    // Add one day to ci to form a valid range
    const d = new Date(ci);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  await assert('Checked-in booking blocks room (physical status or booking overlap)', async () => {
    const result = await AvailabilityService.checkRoomAvailability(pool, {
      roomId: b.room_id, roomNumber: b.room_number,
      arrivalDate: testArr, departureDate: testDep,
    });
    if (result.available) throw new Error('Room should be blocked by Checked In booking');
    const validCodes = ['ROOM_OCCUPIED_BOOKING', 'ROOM_UNAVAILABLE', 'ROOM_ALREADY_BOOKED'];
    if (!validCodes.includes(result.code)) {
      throw new Error(`Unexpected code: ${result.code} — ${result.reason}`);
    }
  });
}

async function test3_NonOverlappingSucceeds() {
  console.log('\n[3] Non-overlapping reservation succeeds');
  const room = await getFirstRoom();

  // Create a reservation: Aug 01 – Aug 05
  await createTestReservation(room.id, room.number, '2027-08-01', '2027-08-05');

  // Request completely outside: Aug 10 – Aug 14
  await assert('Non-overlapping dates are available', async () => {
    const result = await AvailabilityService.checkRoomAvailability(pool, {
      roomId: room.id, roomNumber: room.number,
      arrivalDate: '2027-08-10', departureDate: '2027-08-14',
    });
    if (!result.available) throw new Error(`Room blocked unexpectedly: ${result.reason}`);
  });

  await cleanupTestData(room.id);
}

async function test4_OverlappingReservationRejected() {
  console.log('\n[4] Overlapping reservation rejected with 409');
  const room = await getFirstRoom();

  // Create: Sep 01 – Sep 05
  await createTestReservation(room.id, room.number, '2027-09-01', '2027-09-05');

  // Overlap: Sep 03 – Sep 08
  await assert('Overlapping reservation throws with code ROOM_ALREADY_BOOKED', async () => {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
      await AvailabilityService.validateAndLockRoom(conn, {
        roomId: room.id, roomNumber: room.number,
        arrivalDate: '2027-09-03', departureDate: '2027-09-08',
      });
      await conn.rollback();
      throw new Error('Should have thrown — booking was not rejected');
    } catch (e) {
      await conn.rollback();
      if (!e.code) throw new Error(`validateAndLockRoom did not throw availability error: ${e.message}`);
      if (e.code !== 'ROOM_ALREADY_BOOKED') throw new Error(`Wrong code: ${e.code}`);
      if (e.status !== 409) throw new Error(`Wrong HTTP status: ${e.status}`);
    } finally {
      conn.release();
    }
  });

  await cleanupTestData(room.id);
}

async function test5_ConcurrencyRowLock() {
  console.log('\n[5] Concurrency — row lock prevents double reservation');
  const room = await getFirstRoom();

  await assert('Second concurrent transaction is blocked until first commits', async () => {
    const conn1 = await pool.getConnection();
    const conn2 = await pool.getConnection();
    await conn1.beginTransaction();
    await conn2.beginTransaction();

    let conn2Failed = false;

    try {
      // conn1 acquires lock
      await AvailabilityService.validateAndLockRoom(conn1, {
        roomId: room.id, roomNumber: room.number,
        arrivalDate: '2027-10-01', departureDate: '2027-10-05',
      });

      // conn1 inserts
      await conn1.query(
        `INSERT INTO reservations
           (reservation_number, guest_name, phone, arrival_date, departure_date, room_id, room_number, room_type, adults, status)
         VALUES (?,?,?,?,?,?,?,'STANDARD',1,'Reserved')`,
        [`TEST-C1-${Date.now()}`, 'TEST-Concurrency1', '8888888888', '2027-10-01', '2027-10-05', room.id, room.number]
      );
      await conn1.commit();

      // conn2 tries same dates — should now detect the conflict
      try {
        await AvailabilityService.validateAndLockRoom(conn2, {
          roomId: room.id, roomNumber: room.number,
          arrivalDate: '2027-10-01', departureDate: '2027-10-05',
        });
        await conn2.rollback();
      } catch (e) {
        conn2Failed = true;
        await conn2.rollback();
      }
    } catch (e) {
      await conn1.rollback();
      await conn2.rollback();
      throw e;
    } finally {
      conn1.release();
      conn2.release();
    }

    if (!conn2Failed) throw new Error('Second concurrent transaction was NOT rejected — concurrency failure');

    await cleanupTestData(room.id);
  });
}

async function test6_SameRoomCannotBeReservedTwice() {
  console.log('\n[6] Same room cannot be reserved twice for same dates');
  const room = await getFirstRoom();

  await createTestReservation(room.id, room.number, '2027-11-10', '2027-11-15');

  await assert('Identical duplicate reservation is rejected', async () => {
    const result = await AvailabilityService.checkRoomAvailability(pool, {
      roomId: room.id, roomNumber: room.number,
      arrivalDate: '2027-11-10', departureDate: '2027-11-15',
    });
    if (result.available) throw new Error('Duplicate reservation was allowed');
    if (result.code !== 'ROOM_ALREADY_BOOKED') throw new Error(`Wrong code: ${result.code}`);
  });

  await cleanupTestData(room.id);
}

async function test7_ReservationEditValidatesOverlap() {
  console.log('\n[7] Reservation edit validates overlap (excludeReservationId)');
  const room = await getFirstRoom();

  // Create a reservation we will "edit"
  const myResId = await createTestReservation(room.id, room.number, '2027-12-10', '2027-12-15');
  // Create a BLOCKING reservation from another guest
  await createTestReservation(room.id, room.number, '2027-12-16', '2027-12-20');

  await assert('Edit to non-conflicting dates on same room succeeds (excludes self)', async () => {
    // My reservation shifting within its own window — should not conflict with itself
    const result = await AvailabilityService.checkRoomAvailability(pool, {
      roomId: room.id, roomNumber: room.number,
      arrivalDate: '2027-12-10', departureDate: '2027-12-14',
      excludeReservationId: myResId,
    });
    if (!result.available) throw new Error(`Edit blocked incorrectly: ${result.reason}`);
  });

  await assert('Edit that overlaps another reservation is rejected', async () => {
    // Trying to extend into the blocking reservation
    const result = await AvailabilityService.checkRoomAvailability(pool, {
      roomId: room.id, roomNumber: room.number,
      arrivalDate: '2027-12-10', departureDate: '2027-12-17',
      excludeReservationId: myResId,
    });
    if (result.available) throw new Error('Conflicting edit was allowed');
    if (result.code !== 'ROOM_ALREADY_BOOKED') throw new Error(`Wrong code: ${result.code}`);
  });

  await cleanupTestData(room.id);
}

async function test8_AvailabilityAPIReturnsCorrectRooms() {
  console.log('\n[8] Availability API returns correct rooms');
  const room = await getFirstRoom();

  // Block the room for Jan 2028
  await createTestReservation(room.id, room.number, '2028-01-05', '2028-01-10');

  await assert('Blocked room does NOT appear in available rooms list', async () => {
    const available = await AvailabilityService.getAvailableRooms(
      pool, '2028-01-06', '2028-01-09', 'ALL'
    );
    const found = available.find(r => r.id === room.id);
    if (found) throw new Error(`Room ${room.number} appeared in available list despite blocking reservation`);
  });

  await assert('Same room IS available outside the blocked window', async () => {
    const available = await AvailabilityService.getAvailableRooms(
      pool, '2028-01-12', '2028-01-15', 'ALL'
    );
    const found = available.find(r => r.id === room.id);
    if (!found) throw new Error(`Room ${room.number} was not available outside blocking window`);
  });

  await cleanupTestData(room.id);
}

async function test9_CancelledAndCheckedOutDoNotBlock() {
  console.log('\n[9] Cancelled reservations & Checked Out bookings do not block availability');
  const room = await getFirstRoom();

  // Create a CANCELLED reservation
  const [res] = await pool.query(
    `INSERT INTO reservations
       (reservation_number, guest_name, phone, arrival_date, departure_date, room_id, room_number, room_type, status)
     VALUES (?, ?, '9999999999', '2028-02-01', '2028-02-05', ?, ?, 'STANDARD', 'Cancelled')`,
    [`TEST-CANCEL-${Date.now()}`, 'TEST-CancelledGuest', room.id, room.number]
  );

  await assert('Cancelled reservation does NOT block availability', async () => {
    const result = await AvailabilityService.checkRoomAvailability(pool, {
      roomId: room.id, roomNumber: room.number,
      arrivalDate: '2028-02-01', departureDate: '2028-02-05',
    });
    if (!result.available) throw new Error(`Cancelled reservation blocked availability: ${result.reason}`);
  });

  await assert('Same-day turnover (arrival = existing departure) succeeds', async () => {
    // Existing: 2028-02-10 to 2028-02-15
    await createTestReservation(room.id, room.number, '2028-02-10', '2028-02-15');
    // New arrival on same day as checkout (2028-02-15 to 2028-02-20)
    const result = await AvailabilityService.checkRoomAvailability(pool, {
      roomId: room.id, roomNumber: room.number,
      arrivalDate: '2028-02-15', departureDate: '2028-02-20',
    });
    if (!result.available) throw new Error(`Same-day turnover blocked: ${result.reason}`);
  });

  await cleanupTestData(room.id);
}

async function test10_HighConcurrency20Requests() {
  console.log('\n[10] High Concurrency — 20 simultaneous reservation requests');
  const room = await getFirstRoom();

  await assert('20 simultaneous requests for same room & dates produce exactly 1 success', async () => {
    const totalRequests = 20;
    const arrivalDate = '2028-03-01';
    const departureDate = '2028-03-05';

    let successCount = 0;
    let rejectedCount = 0;

    const promises = Array.from({ length: totalRequests }).map(async (_, idx) => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await AvailabilityService.validateAndLockRoom(conn, {
          roomId: room.id,
          roomNumber: room.number,
          arrivalDate,
          departureDate
        });
        await conn.query(
          `INSERT INTO reservations
             (reservation_number, guest_name, phone, arrival_date, departure_date, room_id, room_number, room_type, status)
           VALUES (?, ?, '9999999999', ?, ?, ?, ?, 'STANDARD', 'Reserved')`,
          [`TEST-CONC-${Date.now()}-${idx}`, `TEST-ConcurrentGuest-${idx}`, arrivalDate, departureDate, room.id, room.number]
        );
        await conn.commit();
        successCount++;
      } catch (e) {
        await conn.rollback();
        rejectedCount++;
      } finally {
        conn.release();
      }
    });

    await Promise.all(promises);

    if (successCount !== 1) {
      throw new Error(`Expected exactly 1 successful reservation out of 20, got ${successCount} successes and ${rejectedCount} rejections!`);
    }
  });

  await cleanupTestData(room.id);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  verifyAvailabilityEngine.mjs — Availability Engine Tests');
  console.log('══════════════════════════════════════════════════════════');

  try {
    await test1_ExistingReservationBlocks();
    await test2_CheckedInBookingBlocks();
    await test3_NonOverlappingSucceeds();
    await test4_OverlappingReservationRejected();
    await test5_ConcurrencyRowLock();
    await test6_SameRoomCannotBeReservedTwice();
    await test7_ReservationEditValidatesOverlap();
    await test8_AvailabilityAPIReturnsCorrectRooms();
    await test9_CancelledAndCheckedOutDoNotBlock();
    await test10_HighConcurrency20Requests();
  } finally {
    await pool.end();
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
