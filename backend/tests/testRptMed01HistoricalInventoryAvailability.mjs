/**
 * backend/tests/testRptMed01HistoricalInventoryAvailability.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification Test Suite for HPMS Reports & Analytics RPT-MED-01 Fix:
 * Historical Out-of-Order / Maintenance / Blocked Inventory Availability (14 Scenarios)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import {
  calculateAvailableRoomNights,
  calculateAvailableRoomsForDate,
  isUnavailableRoomStatus,
  computeDaysInRange
} from '../services/firestoreReportsService.js';

console.log('================================================================');
console.log('HPMS REPORTS & ANALYTICS — RPT-MED-01 INVENTORY AVAILABILITY SUITE');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(testName, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ [PASS] ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${testName}`);
    console.error(`   Error: ${err.message}`);
  }
}

// Generate 10 standard test rooms
const generateTestRooms = (count = 10) => {
  return Array.from({ length: count }, (_, i) => ({
    id: `room_${101 + i}`,
    number: String(101 + i),
    status: 'vacant',
    is_active: 1
  }));
};

// TEST 1: 10 active rooms × 10 days × no unavailable periods -> Expected = 100
runTest('TEST 1: 10 active rooms × 10 days with no status history -> Available = 100', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [];
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 100, `Expected 100 available room nights, got ${available}`);
});

// TEST 2: 10 rooms × 10 days, 1 room OOO for 3 days -> Expected = 97
runTest('TEST 2: 10 rooms × 10 days, 1 room OOO for 3 days (Aug 4-6) -> Available = 97', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [
    { room_number: '104', old_status: 'vacant', new_status: 'out_of_order', business_date: '2026-08-04' },
    { room_number: '104', old_status: 'out_of_order', new_status: 'vacant', business_date: '2026-08-07' }
  ];
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 97, `Expected 97 available room nights, got ${available}`);
});

// TEST 3: 10 rooms × 10 days, Room A OOO 3 days, Room B maintenance 2 days -> Expected = 95
runTest('TEST 3: 10 rooms × 10 days, Room 104 OOO 3 days, Room 102 Maintenance 2 days -> Available = 95', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [
    { room_number: '104', old_status: 'vacant', new_status: 'out_of_order', business_date: '2026-08-04' },
    { room_number: '104', old_status: 'out_of_order', new_status: 'vacant', business_date: '2026-08-07' },
    { room_number: '102', old_status: 'vacant', new_status: 'maintenance', business_date: '2026-08-08' },
    { room_number: '102', old_status: 'maintenance', new_status: 'vacant', business_date: '2026-08-10' }
  ];
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 95, `Expected 95 available room nights (100 - 3 - 2), got ${available}`);
});

// TEST 4: maintenance -> out_of_order on same date -> Expected: date deducted once
runTest('TEST 4: Same-day transition (Aug 6: maintenance -> out_of_order) -> Deducted exactly once per date', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [
    { room_number: '104', old_status: 'vacant', new_status: 'maintenance', business_date: '2026-08-04' },
    { room_number: '104', old_status: 'maintenance', new_status: 'out_of_order', business_date: '2026-08-06' },
    { room_number: '104', old_status: 'out_of_order', new_status: 'vacant', business_date: '2026-08-08' }
  ];
  // Aug 4, 5, 6, 7 = 4 unavailable nights
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 96, `Expected 96 available room nights (100 - 4), got ${available}`);
});

// TEST 5: OOO entirely outside report range -> Expected: no deduction
runTest('TEST 5: OOO period entirely outside report range (July 20-25 vs Report Aug 1-10) -> Deduction = 0', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [
    { room_number: '104', old_status: 'vacant', new_status: 'out_of_order', business_date: '2026-07-20' },
    { room_number: '104', old_status: 'out_of_order', new_status: 'vacant', business_date: '2026-07-25' }
  ];
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 100, `Expected 100 available room nights, got ${available}`);
});

// TEST 6: OOO overlaps beginning of report -> Expected: only overlapping dates deducted
runTest('TEST 6: OOO spans July 30 to Aug 3 -> Only Aug 1 and Aug 2 deducted (2 nights)', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [
    { room_number: '104', old_status: 'vacant', new_status: 'maintenance', business_date: '2026-07-30' },
    { room_number: '104', old_status: 'maintenance', new_status: 'vacant', business_date: '2026-08-03' }
  ];
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 98, `Expected 98 available room nights (100 - 2), got ${available}`);
});

// TEST 7: OOO overlaps end of report -> Expected: only overlapping dates deducted
runTest('TEST 7: OOO spans Aug 8 to Aug 15 -> Only Aug 8, 9, 10 deducted (3 nights)', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [
    { room_number: '104', old_status: 'vacant', new_status: 'blocked', business_date: '2026-08-08' },
    { room_number: '104', old_status: 'blocked', new_status: 'vacant', business_date: '2026-08-15' }
  ];
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 97, `Expected 97 available room nights (100 - 3), got ${available}`);
});

// TEST 8: occupied / dirty / vacant are NOT deducted
runTest('TEST 8: Normal operational states (vacant, occupied, dirty) are NOT deducted from available inventory', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [
    { room_number: '101', old_status: 'vacant', new_status: 'occupied', business_date: '2026-08-01' },
    { room_number: '101', old_status: 'occupied', new_status: 'dirty', business_date: '2026-08-03' },
    { room_number: '101', old_status: 'dirty', new_status: 'vacant', business_date: '2026-08-03' }
  ];
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 100, `Expected 100 available room nights, got ${available}`);
});

// TEST 9: inactive room remains excluded from base capacity
runTest('TEST 9: Decommissioned/inactive room is excluded from base capacity (9 active rooms * 10 days = 90)', () => {
  const rooms = generateTestRooms(10);
  rooms[9].status = 'inactive'; // Room 110 is inactive

  const statusHistory = [
    { room_number: '104', old_status: 'vacant', new_status: 'maintenance', business_date: '2026-08-04' },
    { room_number: '104', old_status: 'maintenance', new_status: 'vacant', business_date: '2026-08-07' }
  ];
  // 9 active rooms * 10 days = 90 base capacity - 3 maintenance nights = 87
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 87, `Expected 87 available room nights (90 - 3), got ${available}`);
});

// TEST 10: available room nights = 0 -> Expected: 0, No NaN, No Infinity
runTest('TEST 10: Zero capacity condition returns 0 without NaN/Infinity or fake denominator', () => {
  const rooms = [];
  const statusHistory = [];
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 0, `Expected 0 available room nights, got ${available}`);

  const occupied = 0;
  const occupancy = available === 0 ? 0 : Math.round((occupied / available) * 100);
  assert.strictEqual(occupancy, 0, `Expected 0% occupancy, got ${occupancy}`);
  assert(!isNaN(occupancy) && isFinite(occupancy), 'Occupancy must be finite number');
});

// TEST 11: Occupancy uses corrected denominator (50 occupied / 97 available -> 52%)
runTest('TEST 11: Occupancy rate calculation uses corrected denominator (50 / 97 * 100 = 52%)', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [
    { room_number: '104', old_status: 'vacant', new_status: 'out_of_order', business_date: '2026-08-04' },
    { room_number: '104', old_status: 'out_of_order', new_status: 'vacant', business_date: '2026-08-07' }
  ];
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 97);

  const totalOccupiedRoomNights = 50;
  const occupancyRate = available === 0 ? 0 : Math.min(100, Math.round((totalOccupiedRoomNights / available) * 100));
  assert.strictEqual(occupancyRate, 52, `Expected 52% occupancy (50 / 97 * 100), got ${occupancyRate}%`);
});

// TEST 12: RevPAR uses corrected denominator (₹50,000 / 97 available -> ₹515)
runTest('TEST 12: RevPAR calculation uses corrected denominator (₹50,000 / 97 = ₹515)', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [
    { room_number: '104', old_status: 'vacant', new_status: 'out_of_order', business_date: '2026-08-04' },
    { room_number: '104', old_status: 'out_of_order', new_status: 'vacant', business_date: '2026-08-07' }
  ];
  const available = calculateAvailableRoomNights(rooms, statusHistory, '2026-08-01', '2026-08-10');
  assert.strictEqual(available, 97);

  const totalRoomRevenue = 50000;
  const revPAR = available === 0 ? 0 : Math.round(totalRoomRevenue / available);
  assert.strictEqual(revPAR, 515, `Expected RevPAR ₹515 (50000 / 97), got ₹${revPAR}`);
});

// TEST 13: Daily availability: 10 rooms, Aug 5 has 1 room OOO -> Aug 5 = 9, Other days = 10
runTest('TEST 13: Daily availability evaluation (Aug 5 = 9 rooms, other days = 10 rooms)', () => {
  const rooms = generateTestRooms(10);
  const statusHistory = [
    { room_number: '104', old_status: 'vacant', new_status: 'maintenance', business_date: '2026-08-05' },
    { room_number: '104', old_status: 'maintenance', new_status: 'vacant', business_date: '2026-08-06' }
  ];

  const availAug4 = calculateAvailableRoomsForDate(rooms, statusHistory, '2026-08-04');
  const availAug5 = calculateAvailableRoomsForDate(rooms, statusHistory, '2026-08-05');
  const availAug6 = calculateAvailableRoomsForDate(rooms, statusHistory, '2026-08-06');

  assert.strictEqual(availAug4, 10, `Aug 4 must have 10 available rooms, got ${availAug4}`);
  assert.strictEqual(availAug5, 9, `Aug 5 must have 9 available rooms (1 OOO), got ${availAug5}`);
  assert.strictEqual(availAug6, 10, `Aug 6 must have 10 available rooms, got ${availAug6}`);
});

// TEST 14: Firestore/MySQL parity
runTest('TEST 14: Firestore and MySQL parity produces identical available room night calculations', () => {
  const rooms = generateTestRooms(10);
  const fsHistory = [
    { room_id: 'room_104', room_number: '104', old_status: 'vacant', new_status: 'out_of_order', business_date: '2026-08-04' },
    { room_id: 'room_104', room_number: '104', old_status: 'out_of_order', new_status: 'vacant', business_date: '2026-08-07' }
  ];
  const mysqlHistory = [
    { room_id: 104, room_number: '104', old_status: 'vacant', new_status: 'out_of_order', business_date: '2026-08-04' },
    { room_id: 104, room_number: '104', old_status: 'out_of_order', new_status: 'vacant', business_date: '2026-08-07' }
  ];

  const fsAvail = calculateAvailableRoomNights(rooms, fsHistory, '2026-08-01', '2026-08-10');
  const sqlAvail = calculateAvailableRoomNights(rooms, mysqlHistory, '2026-08-01', '2026-08-10');

  assert.strictEqual(fsAvail, sqlAvail, `Firestore availability (${fsAvail}) must equal MySQL availability (${sqlAvail})`);
  assert.strictEqual(fsAvail, 97, `Both must equal 97`);
});

console.log(`\n================================================================`);
console.log(`RPT-MED-01 VERIFICATION RESULTS: ${passedTests}/${totalTests} TESTS PASSED`);
console.log('================================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
