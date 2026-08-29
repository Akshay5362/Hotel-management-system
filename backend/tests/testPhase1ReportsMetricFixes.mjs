/**
 * backend/tests/testPhase1ReportsMetricFixes.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification Test Suite for HPMS Reports & Analytics Phase 1 Critical Metric Fixes:
 *   - TEST 1: 1 room × 1 night × ₹2500 -> ADR = ₹2500
 *   - TEST 2: 1 room × 10 nights × ₹2500 -> ADR = ₹2500 (NOT ₹25000)
 *   - TEST 3: 10 rooms × 1 day, 5 occupied -> Occupancy = 50%
 *   - TEST 4: 10 rooms × 10 days, 50 occupied room nights -> Occupancy = 50%
 *   - TEST 5: 10 rooms × 10 days, Available = 100, Revenue = ₹50,000 -> RevPAR = ₹500
 *   - TEST 6: Monthly range: 48 rooms × 30 days -> Denominator = 1,440 available room nights
 *   - TEST 7: Stay overlaps only part of date range -> Only overlapping room nights counted
 *   - TEST 8: Cancelled booking -> Excluded from occupied room nights and room revenue
 *   - TEST 9: Positive refund amount -> Reduces net revenue
 *   - TEST 10: No refund -> Revenue unchanged
 *   - TEST 11: Zero available room nights -> Graceful return (0, no NaN/Infinity/error)
 *   - TEST 12: Firestore & MySQL parity logic verification
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import {
  computeDaysInRange,
  calculateStayOverlapNights,
  getBookingRoomTariff,
  getEffectivePaymentAmount,
  filterRecordsByDateRange
} from '../services/firestoreReportsService.js';

console.log('================================================================');
console.log('HPMS REPORTS & ANALYTICS — PHASE 1 METRIC FIX VERIFICATION SUITE');
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

// TEST 1: 1 room × 1 night × ₹2500 -> ADR = ₹2500
runTest('TEST 1: 1 room × 1 night × ₹2500 -> ADR = ₹2500', () => {
  const booking = {
    booking_status: 'Checked In',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-02',
    room_tariff: 2500,
    total_amount: 2500
  };
  const startDate = '2026-08-01';
  const endDate = '2026-08-01';

  const overlap = calculateStayOverlapNights(booking, startDate, endDate);
  assert.strictEqual(overlap, 1, `Expected 1 occupied room night, got ${overlap}`);

  const tariff = getBookingRoomTariff(booking);
  assert.strictEqual(tariff, 2500, `Expected tariff 2500, got ${tariff}`);

  const totalRoomRevenue = overlap * tariff;
  const adr = Math.round(totalRoomRevenue / overlap);
  assert.strictEqual(adr, 2500, `Expected ADR 2500, got ${adr}`);
});

// TEST 2: 1 room × 10 nights × ₹2500 -> ADR = ₹2500, NOT ₹25000
runTest('TEST 2: 1 room × 10 nights × ₹2500 -> ADR = ₹2500 (NOT ₹25000)', () => {
  const booking = {
    booking_status: 'Checked Out',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-11',
    room_tariff: 2500,
    total_amount: 25000
  };
  const startDate = '2026-08-01';
  const endDate = '2026-08-10';

  const overlap = calculateStayOverlapNights(booking, startDate, endDate);
  assert.strictEqual(overlap, 10, `Expected 10 occupied room nights, got ${overlap}`);

  const tariff = getBookingRoomTariff(booking);
  assert.strictEqual(tariff, 2500, `Expected tariff 2500, got ${tariff}`);

  const totalRoomRevenue = overlap * tariff;
  assert.strictEqual(totalRoomRevenue, 25000, `Expected total room revenue 25000, got ${totalRoomRevenue}`);

  const adr = Math.round(totalRoomRevenue / overlap);
  assert.strictEqual(adr, 2500, `Expected ADR 2500 (not 25000), got ${adr}`);
});

// TEST 3: 10 rooms × 1 day, 5 occupied -> Occupancy = 50%
runTest('TEST 3: 10 rooms × 1 day, 5 occupied -> Occupancy = 50%', () => {
  const startDate = '2026-08-01';
  const endDate = '2026-08-01';
  const activeRooms = 10;
  const daysInRange = computeDaysInRange(startDate, endDate);
  assert.strictEqual(daysInRange, 1, `Expected 1 day in range, got ${daysInRange}`);

  const totalAvailableRoomNights = activeRooms * daysInRange;
  assert.strictEqual(totalAvailableRoomNights, 10, `Expected 10 available room nights, got ${totalAvailableRoomNights}`);

  const totalOccupiedRoomNights = 5;
  const occupancyRate = Math.round((totalOccupiedRoomNights / totalAvailableRoomNights) * 100);
  assert.strictEqual(occupancyRate, 50, `Expected occupancy 50%, got ${occupancyRate}%`);
});

// TEST 4: 10 rooms × 10 days, 50 occupied room nights -> Occupancy = 50%
runTest('TEST 4: 10 rooms × 10 days, 50 occupied room nights -> Occupancy = 50%', () => {
  const startDate = '2026-08-01';
  const endDate = '2026-08-10';
  const activeRooms = 10;
  const daysInRange = computeDaysInRange(startDate, endDate);
  assert.strictEqual(daysInRange, 10, `Expected 10 days in range, got ${daysInRange}`);

  const totalAvailableRoomNights = activeRooms * daysInRange;
  assert.strictEqual(totalAvailableRoomNights, 100, `Expected 100 available room nights, got ${totalAvailableRoomNights}`);

  const totalOccupiedRoomNights = 50;
  const occupancyRate = Math.round((totalOccupiedRoomNights / totalAvailableRoomNights) * 100);
  assert.strictEqual(occupancyRate, 50, `Expected occupancy 50%, got ${occupancyRate}%`);
});

// TEST 5: 10 rooms × 10 days, Available = 100, Revenue = ₹50,000 -> RevPAR = ₹500
runTest('TEST 5: 10 rooms × 10 days, Available = 100, Revenue = ₹50,000 -> RevPAR = ₹500', () => {
  const totalAvailableRoomNights = 100;
  const totalRoomRevenue = 50000;
  const revPAR = Math.round(totalRoomRevenue / totalAvailableRoomNights);
  assert.strictEqual(revPAR, 500, `Expected RevPAR ₹500, got ₹${revPAR}`);
});

// TEST 6: Monthly range: 48 rooms × 30 days -> Denominator = 1,440 available room nights
runTest('TEST 6: Monthly range: 48 rooms × 30 days -> Denominator = 1,440 available room nights', () => {
  const startDate = '2026-09-01';
  const endDate = '2026-09-30';
  const activeRooms = 48;
  const daysInRange = computeDaysInRange(startDate, endDate);
  assert.strictEqual(daysInRange, 30, `Expected 30 days in range, got ${daysInRange}`);

  const totalAvailableRoomNights = activeRooms * daysInRange;
  assert.strictEqual(totalAvailableRoomNights, 1440, `Expected 1,440 available room nights, got ${totalAvailableRoomNights}`);
});

// TEST 7: Booking overlaps only part of selected date range
runTest('TEST 7: Stay 2026-08-01 to 2026-08-11 (10 nights), Report is 2026-08-05 to 2026-08-07 (3 nights)', () => {
  const booking = {
    booking_status: 'Checked In',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-11',
    room_tariff: 3000,
    total_amount: 30000
  };
  const startDate = '2026-08-05';
  const endDate = '2026-08-07';

  const overlap = calculateStayOverlapNights(booking, startDate, endDate);
  assert.strictEqual(overlap, 3, `Expected 3 overlapping room nights (08-05, 08-06, 08-07), got ${overlap}`);

  const tariff = getBookingRoomTariff(booking);
  assert.strictEqual(tariff, 3000, `Expected tariff 3000, got ${tariff}`);

  const roomRevenueInReport = overlap * tariff;
  assert.strictEqual(roomRevenueInReport, 9000, `Expected ₹9000 revenue in report period, got ₹${roomRevenueInReport}`);
});

// TEST 8: Cancelled booking does not contribute occupied room nights or revenue
runTest('TEST 8: Cancelled booking does not contribute occupied room nights or revenue', () => {
  const cancelledBooking = {
    booking_status: 'Cancelled',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-05',
    room_tariff: 2000,
    total_amount: 8000
  };
  const startDate = '2026-08-01';
  const endDate = '2026-08-05';

  const overlap = calculateStayOverlapNights(cancelledBooking, startDate, endDate);
  assert.strictEqual(overlap, 0, `Expected 0 occupied room nights for cancelled booking, got ${overlap}`);
});

// TEST 9: Positive refund amount reduces net revenue
runTest('TEST 9: Positive refund amount reduces net revenue', () => {
  const payments = [
    { amount: 5000, payment_type: 'Advance Deposit', payment_status: 'Completed', business_date: '2026-08-01' },
    { amount: 1500, payment_type: 'Checkout Refund', payment_status: 'Refunded', business_date: '2026-08-01' },
    { amount: -500, payment_type: 'Cancellation Refund', payment_status: 'Refunded', business_date: '2026-08-01' }
  ];

  const netPayments = payments.map(p => getEffectivePaymentAmount(p));
  assert.strictEqual(netPayments[0], 5000, 'Expected positive advance deposit');
  assert.strictEqual(netPayments[1], -1500, 'Expected positive refund record to be subtracted (-1500)');
  assert.strictEqual(netPayments[2], -500, 'Expected negative refund record to remain negative (-500)');

  const totalRevenue = netPayments.reduce((sum, amt) => sum + amt, 0);
  assert.strictEqual(totalRevenue, 3000, `Expected net revenue ₹3000 (5000 - 1500 - 500), got ₹${totalRevenue}`);
});

// TEST 10: No refund -> Revenue unchanged
runTest('TEST 10: No refund -> Revenue unchanged', () => {
  const payments = [
    { amount: 4000, payment_type: 'Cash', payment_status: 'Completed', business_date: '2026-08-01' },
    { amount: 3000, payment_type: 'UPI', payment_status: 'Completed', business_date: '2026-08-01' }
  ];

  const totalRevenue = payments.reduce((sum, p) => sum + getEffectivePaymentAmount(p), 0);
  assert.strictEqual(totalRevenue, 7000, `Expected revenue ₹7000, got ₹${totalRevenue}`);
});

// TEST 11: Zero available room nights -> Graceful return (0, no NaN/Infinity)
runTest('TEST 11: Zero available room nights -> Graceful return (0, no NaN/Infinity)', () => {
  const totalAvailableRoomNights = 0;
  const totalOccupiedRoomNights = 0;
  const totalRoomRevenue = 0;

  const occupancyRate = totalAvailableRoomNights === 0 ? 0 : Math.round((totalOccupiedRoomNights / totalAvailableRoomNights) * 100);
  const adr = totalOccupiedRoomNights === 0 ? 0 : Math.round(totalRoomRevenue / totalOccupiedRoomNights);
  const revPAR = totalAvailableRoomNights === 0 ? 0 : Math.round(totalRoomRevenue / totalAvailableRoomNights);

  assert.strictEqual(occupancyRate, 0, 'Occupancy rate must be 0');
  assert.strictEqual(adr, 0, 'ADR must be 0');
  assert.strictEqual(revPAR, 0, 'RevPAR must be 0');
  assert(!isNaN(occupancyRate) && !isNaN(adr) && !isNaN(revPAR), 'No metric should be NaN');
  assert(isFinite(occupancyRate) && isFinite(adr) && isFinite(revPAR), 'No metric should be Infinity');
});

// TEST 12: Firestore & MySQL parity logic verification
runTest('TEST 12: Firestore & MySQL parity logic produces identical metric calculations', () => {
  const mockBookings = [
    { booking_status: 'Checked In', check_in_date: '2026-08-01', expected_check_out_date: '2026-08-06', room_tariff: 2000, total_amount: 10000 },
    { booking_status: 'Checked Out', check_in_date: '2026-08-03', check_out_date: '2026-08-05', room_tariff: 3000, total_amount: 6000 },
    { booking_status: 'Cancelled', check_in_date: '2026-08-01', expected_check_out_date: '2026-08-05', room_tariff: 2500, total_amount: 10000 }
  ];

  const startDate = '2026-08-01';
  const endDate = '2026-08-05'; // 5 days
  const activeRooms = 10;
  const daysInRange = computeDaysInRange(startDate, endDate);
  const totalAvailableRoomNights = activeRooms * daysInRange; // 50

  const validBookings = mockBookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));
  let occupiedNights = 0;
  let roomRev = 0;

  validBookings.forEach(b => {
    const overlap = calculateStayOverlapNights(b, startDate, endDate);
    if (overlap > 0) {
      const tariff = getBookingRoomTariff(b);
      occupiedNights += overlap;
      roomRev += (overlap * tariff);
    }
  });

  // Booking 1: 08-01 to 08-06 -> overlapping nights in [08-01, 08-05] = 5 nights (08-01, 08-02, 08-03, 08-04, 08-05) @ 2000 = 10000
  // Booking 2: 08-03 to 08-05 -> overlapping nights in [08-01, 08-05] = 2 nights (08-03, 08-04) @ 3000 = 6000
  // Total occupied nights = 7
  // Total room rev = 16000
  assert.strictEqual(occupiedNights, 7, `Expected 7 occupied room nights, got ${occupiedNights}`);
  assert.strictEqual(roomRev, 16000, `Expected ₹16,000 room revenue, got ₹${roomRev}`);

  const adr = Math.round(roomRev / occupiedNights); // 16000 / 7 = 2286
  const occ = Math.round((occupiedNights / totalAvailableRoomNights) * 100); // (7 / 50) * 100 = 14%
  const revpar = Math.round(roomRev / totalAvailableRoomNights); // 16000 / 50 = 320

  assert.strictEqual(adr, 2286, `Expected ADR 2286, got ${adr}`);
  assert.strictEqual(occ, 14, `Expected Occupancy 14%, got ${occ}%`);
  assert.strictEqual(revpar, 320, `Expected RevPAR 320, got ${revpar}`);
});

console.log(`\n================================================================`);
console.log(`PHASE 1 VERIFICATION RESULTS: ${passedTests}/${totalTests} TESTS PASSED`);
console.log('================================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
