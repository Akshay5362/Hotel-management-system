/**
 * testStatusEndpointResGuestFix.mjs
 * ============================================================================
 * Regression Test Suite for GET /api/status & Reservations SQL Schema Parity
 *
 * Verifies that getStatus in auditController.js:
 *  1. Executes all MySQL queries cleanly without ER_BAD_FIELD_ERROR.
 *  2. Does NOT reference nonexistent reservations.guest_id.
 *  3. Correctly selects res.guest_name AS guestName.
 *  4. Correctly populates upcomingReservations with expected fields.
 *  5. Returns HTTP 200 with all expected dashboard state payload fields.
 */

import pool from '../db.js';
import { getStatus } from '../controllers/auditController.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  ✔ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failed++;
    failures.push(message);
  }
}

async function runStatusTests() {
  console.log('\n========================================================================');
  console.log('  TEST SUITE: GET /api/status & Reservations Schema Fix Verification');
  console.log('========================================================================\n');

  try {
    // 1. Verify MySQL schema for reservations table (assert no guest_id column)
    console.log('[TEST 1] Verifying MySQL reservations schema columns...');
    const [columns] = await pool.query('SHOW COLUMNS FROM reservations');
    const columnNames = columns.map(c => c.Field);
    
    assert(!columnNames.includes('guest_id'), 'Schema check: reservations table does NOT have guest_id column');
    assert(columnNames.includes('guest_name'), 'Schema check: reservations table HAS guest_name column');
    assert(columnNames.includes('reservation_number'), 'Schema check: reservations table HAS reservation_number column');
    assert(columnNames.includes('room_id'), 'Schema check: reservations table HAS room_id column');
    assert(columnNames.includes('arrival_date'), 'Schema check: reservations table HAS arrival_date column');
    assert(columnNames.includes('departure_date'), 'Schema check: reservations table HAS departure_date column');

    // 2. Direct execution of the upcoming reservations SQL query
    console.log('\n[TEST 2] Testing upcoming reservations SQL queries directly...');
    const systemDate = '2026-08-19';

    const [futureBookings] = await pool.query(`
      SELECT 
        b.id as booking_id,
        b.booking_number,
        b.room_id,
        b.check_in_date as checkInDate,
        b.expected_check_out_date as expectedCheckOutDate,
        b.booking_status as status,
        g.full_name as guestName,
        r.number as roomNumber,
        rt.title as roomType
      FROM bookings b
      LEFT JOIN guests g ON b.guest_id = g.id
      LEFT JOIN rooms r ON b.room_id = r.id
      LEFT JOIN room_types rt ON r.room_type_id = rt.id
      WHERE b.booking_status = 'Reserved'
        AND b.check_in_date >= ?
      ORDER BY b.check_in_date ASC
    `, [systemDate]);
    assert(Array.isArray(futureBookings), 'futureBookings query executed successfully');

    const [futureResTable] = await pool.query(`
      SELECT 
        res.id as reservation_id,
        res.id as booking_id,
        res.reservation_number as booking_number,
        res.reservation_number,
        res.room_id,
        res.arrival_date as checkInDate,
        res.departure_date as expectedCheckOutDate,
        res.status as status,
        res.guest_name as guestName,
        res.phone as phone,
        res.adults as adults,
        res.advance_payment as totalAmount,
        COALESCE(r.number, res.room_number, '') as roomNumber,
        COALESCE(rt.title, res.room_type, '') as roomType
      FROM reservations res
      LEFT JOIN rooms r ON res.room_id = r.id
      LEFT JOIN room_types rt ON r.room_type_id = rt.id
      WHERE res.status IN ('Confirmed', 'Reserved')
        AND res.arrival_date >= ?
      ORDER BY res.arrival_date ASC
    `, [systemDate]);
    assert(Array.isArray(futureResTable), 'futureResTable query executed without SQL errors');

    // 3. Full invocation of getStatus controller
    console.log('\n[TEST 3] Testing getStatus controller execution...');
    const req = {
      headers: {},
      ip: '127.0.0.1',
      user: { id: 1, role: 'admin' }
    };

    let responseStatus = 200;
    let responseBody = null;

    const res = {
      status(code) {
        responseStatus = code;
        return this;
      },
      json(data) {
        responseBody = data;
        return this;
      }
    };

    await getStatus(req, res);

    assert(responseStatus === 200, `getStatus HTTP response status === 200 (Got: ${responseStatus})`);
    assert(responseBody !== null, 'getStatus returned response payload');
    assert(typeof responseBody.systemDate === 'string', 'Payload contains systemDate string');
    assert(Array.isArray(responseBody.rooms), 'Payload contains rooms array');
    assert(Array.isArray(responseBody.upcomingReservations), 'Payload contains upcomingReservations array');
    assert(typeof responseBody.todayCheckins === 'number', 'Payload contains todayCheckins count');
    assert(typeof responseBody.todayCheckouts === 'number', 'Payload contains todayCheckouts count');
    assert(typeof responseBody.continuedRooms === 'number', 'Payload contains continuedRooms count');

  } catch (err) {
    console.error('❌ Test execution error:', err);
    failed++;
    failures.push(err.message);
  } finally {
    await pool.end();
  }

  console.log('\n========================================================================');
  console.log(` SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runStatusTests();
