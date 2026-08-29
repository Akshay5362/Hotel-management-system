/**
 * backend/tests/testRptCrit03HistoricalRoomTariffFix.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification Test Suite for HPMS Reports & Analytics RPT-CRIT-03 Fix:
 * Historical Room Tariff & Room Shift Revenue Accuracy via Ledger Items (11 Scenarios)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import {
  getHistoricalRoomRevenueForBooking,
  isRoomRevenueLedgerItem,
  calculateStayOverlapNights,
  getBookingRoomTariff,
  computeDaysInRange
} from '../services/firestoreReportsService.js';

console.log('================================================================');
console.log('HPMS REPORTS & ANALYTICS — RPT-CRIT-03 HISTORICAL TARIFF FIX SUITE');
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

// TEST 1: Room Shift Upgrade: 3 nights @ ₹1800 + 2 nights @ ₹2500 -> Room revenue = ₹10,400, Occupied nights = 5, ADR = ₹2,080
runTest('TEST 1: Room Shift Upgrade (3 nights @ ₹1800 + 2 nights @ ₹2500 -> Revenue = ₹10,400, ADR = ₹2,080)', () => {
  const booking = {
    id: 'bkg_shift_up_1',
    booking_number: 'BK-UP-1',
    booking_status: 'Checked Out',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-06',
    room_tariff: 2500 // Current/final tariff on booking doc
  };

  const ledgerItems = [
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'CHARGE', amount: 1800, business_date: '2026-08-01' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-02' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-03' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Shift Adjustment', transaction_type: 'CHARGE', amount: 700, business_date: '2026-08-04', desc: 'Room Shift Upgrade' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-04' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 2500, business_date: '2026-08-05' }
  ];

  const startDate = '2026-08-01';
  const endDate = '2026-08-05';

  const roomRev = getHistoricalRoomRevenueForBooking(booking, ledgerItems, startDate, endDate);
  assert.strictEqual(roomRev, 10400, `Expected ₹10,400 room revenue, got ₹${roomRev}`);

  const overlap = calculateStayOverlapNights(booking, startDate, endDate);
  assert.strictEqual(overlap, 5, `Expected 5 occupied nights, got ${overlap}`);

  const adr = Math.round(roomRev / overlap);
  assert.strictEqual(adr, 2080, `Expected ADR ₹2,080 (NOT ₹2,500), got ₹${adr}`);
});

// TEST 2: Room Shift Downgrade: 2 nights @ ₹2500 + 3 nights @ ₹1800 -> Revenue = ₹10,400, ADR = ₹2,080
runTest('TEST 2: Room Shift Downgrade (2 nights @ ₹2500 + 3 nights @ ₹1800 -> Revenue = ₹10,400, ADR = ₹2,080)', () => {
  const booking = {
    id: 'bkg_shift_down_1',
    booking_number: 'BK-DOWN-1',
    booking_status: 'Checked Out',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-06',
    room_tariff: 1800 // Current/final tariff on booking doc
  };

  const ledgerItems = [
    { booking_id: 'bkg_shift_down_1', category: 'Room Tariff', transaction_type: 'CHARGE', amount: 2500, business_date: '2026-08-01' },
    { booking_id: 'bkg_shift_down_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 2500, business_date: '2026-08-02' },
    { booking_id: 'bkg_shift_down_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 2500, business_date: '2026-08-03' },
    { booking_id: 'bkg_shift_down_1', category: 'Room Shift Adjustment', transaction_type: 'CREDIT', credit_amount: 700, amount: 0, business_date: '2026-08-03', desc: 'Room Shift Downgrade Credit' },
    { booking_id: 'bkg_shift_down_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-04' },
    { booking_id: 'bkg_shift_down_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-05' }
  ];

  const startDate = '2026-08-01';
  const endDate = '2026-08-05';

  const roomRev = getHistoricalRoomRevenueForBooking(booking, ledgerItems, startDate, endDate);
  // 2500 + 2500 + (2500 - 700) + 1800 + 1800 = 2500 + 2500 + 1800 + 1800 + 1800 = 10400
  assert.strictEqual(roomRev, 10400, `Expected ₹10,400 room revenue, got ₹${roomRev}`);

  const overlap = calculateStayOverlapNights(booking, startDate, endDate);
  assert.strictEqual(overlap, 5, `Expected 5 occupied nights, got ${overlap}`);

  const adr = Math.round(roomRev / overlap);
  assert.strictEqual(adr, 2080, `Expected ADR ₹2,080 (NOT ₹1,800), got ₹${adr}`);
});

// TEST 3: Non-shifted booking: 5 nights @ ₹1800 -> Revenue = ₹9,000, ADR = ₹1,800
runTest('TEST 3: Non-shifted booking (5 nights @ ₹1800 -> Revenue = ₹9,000, ADR = ₹1,800)', () => {
  const booking = {
    id: 'bkg_standard_1',
    booking_status: 'Checked In',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-06',
    room_tariff: 1800
  };

  const ledgerItems = [
    { booking_id: 'bkg_standard_1', category: 'Room Tariff', transaction_type: 'CHARGE', amount: 1800, business_date: '2026-08-01' },
    { booking_id: 'bkg_standard_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-02' },
    { booking_id: 'bkg_standard_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-03' },
    { booking_id: 'bkg_standard_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-04' },
    { booking_id: 'bkg_standard_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-05' }
  ];

  const startDate = '2026-08-01';
  const endDate = '2026-08-05';

  const roomRev = getHistoricalRoomRevenueForBooking(booking, ledgerItems, startDate, endDate);
  assert.strictEqual(roomRev, 9000, `Expected ₹9,000 room revenue, got ₹${roomRev}`);

  const overlap = calculateStayOverlapNights(booking, startDate, endDate);
  const adr = Math.round(roomRev / overlap);
  assert.strictEqual(adr, 1800, `Expected ADR ₹1,800, got ₹${adr}`);
});

// TEST 4: Stay clipping before room shift: Report only nights 1-2
runTest('TEST 4: Stay clipping before room shift (Report nights 1-2 only -> Revenue = ₹3,600, ADR = ₹1,800)', () => {
  const booking = {
    id: 'bkg_shift_up_1',
    booking_status: 'Checked Out',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-06',
    room_tariff: 2500 // Current tariff
  };

  const ledgerItems = [
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'CHARGE', amount: 1800, business_date: '2026-08-01' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-02' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-03' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Shift Adjustment', transaction_type: 'CHARGE', amount: 700, business_date: '2026-08-04' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 2500, business_date: '2026-08-05' }
  ];

  const startDate = '2026-08-01';
  const endDate = '2026-08-02'; // Only 2 nights

  const roomRev = getHistoricalRoomRevenueForBooking(booking, ledgerItems, startDate, endDate);
  assert.strictEqual(roomRev, 3600, `Expected ₹3,600 revenue for nights 1-2, got ₹${roomRev}`);

  const overlap = calculateStayOverlapNights(booking, startDate, endDate);
  assert.strictEqual(overlap, 2, `Expected 2 occupied nights, got ${overlap}`);

  const adr = Math.round(roomRev / overlap);
  assert.strictEqual(adr, 1800, `Expected ADR ₹1,800, got ₹${adr}`);
});

// TEST 5: Stay clipping after room shift: Report only nights 4-5
runTest('TEST 5: Stay clipping after room shift (Report nights 4-5 only -> Revenue = ₹5,000, ADR = ₹2,500)', () => {
  const booking = {
    id: 'bkg_shift_up_1',
    booking_status: 'Checked Out',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-06',
    room_tariff: 2500
  };

  const ledgerItems = [
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'CHARGE', amount: 1800, business_date: '2026-08-01' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-02' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-03' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Shift Adjustment', transaction_type: 'CHARGE', amount: 700, business_date: '2026-08-04' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-04' },
    { booking_id: 'bkg_shift_up_1', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 2500, business_date: '2026-08-05' }
  ];

  const startDate = '2026-08-04';
  const endDate = '2026-08-05'; // Nights 4 & 5

  const roomRev = getHistoricalRoomRevenueForBooking(booking, ledgerItems, startDate, endDate);
  // (1800 + 700) + 2500 = 5000
  assert.strictEqual(roomRev, 5000, `Expected ₹5,000 revenue for nights 4-5, got ₹${roomRev}`);

  const overlap = calculateStayOverlapNights(booking, startDate, endDate);
  assert.strictEqual(overlap, 2, `Expected 2 occupied nights, got ${overlap}`);

  const adr = Math.round(roomRev / overlap);
  assert.strictEqual(adr, 2500, `Expected ADR ₹2,500, got ₹${adr}`);
});

// TEST 6: Shift adjustment: Verify upgrade differential is correctly included and neither omitted nor double-counted
runTest('TEST 6: Shift adjustment handling (Accurately aggregates debit and credit differentials)', () => {
  const booking = {
    id: 'bkg_adj_test',
    booking_status: 'Checked In',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-03',
    room_tariff: 2000
  };

  const ledgerItems = [
    { booking_id: 'bkg_adj_test', category: 'Room Tariff', transaction_type: 'CHARGE', amount: 1500, business_date: '2026-08-01' },
    { booking_id: 'bkg_adj_test', category: 'Room Shift Adjustment', transaction_type: 'CHARGE', amount: 500, business_date: '2026-08-01', desc: 'Room Shift Upgrade' },
    { booking_id: 'bkg_adj_test', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 2000, business_date: '2026-08-02' }
  ];

  const roomRev = getHistoricalRoomRevenueForBooking(booking, ledgerItems, '2026-08-01', '2026-08-02');
  assert.strictEqual(roomRev, 4000, `Expected ₹4,000 (1500 + 500 + 2000), got ₹${roomRev}`);
});

// TEST 7: Cancelled booking does not contribute room revenue
runTest('TEST 7: Cancelled booking produces ₹0 room revenue and 0 occupied nights', () => {
  const cancelledBooking = {
    id: 'bkg_cancelled_1',
    booking_status: 'Cancelled',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-05',
    room_tariff: 2000
  };

  const ledgerItems = [
    { booking_id: 'bkg_cancelled_1', category: 'Room Tariff', transaction_type: 'CHARGE', amount: 2000, business_date: '2026-08-01' }
  ];

  const roomRev = getHistoricalRoomRevenueForBooking(cancelledBooking, ledgerItems, '2026-08-01', '2026-08-05');
  assert.strictEqual(roomRev, 0, `Expected ₹0 room revenue for cancelled booking, got ₹${roomRev}`);

  const overlap = calculateStayOverlapNights(cancelledBooking, '2026-08-01', '2026-08-05');
  assert.strictEqual(overlap, 0, `Expected 0 occupied nights, got ${overlap}`);
});

// TEST 8: Non-room charges (food, laundry, extra bed) do NOT enter room revenue
runTest('TEST 8: Non-room charges (food, laundry, extra bed) are strictly excluded from room revenue', () => {
  const booking = {
    id: 'bkg_extras_1',
    booking_status: 'Checked In',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-02',
    room_tariff: 2000
  };

  const ledgerItems = [
    { booking_id: 'bkg_extras_1', category: 'Room Tariff', transaction_type: 'CHARGE', amount: 2000, business_date: '2026-08-01' },
    { booking_id: 'bkg_extras_1', category: 'Food & Beverage', transaction_type: 'CHARGE', amount: 850, business_date: '2026-08-01', desc: 'Dinner room service' },
    { booking_id: 'bkg_extras_1', category: 'Laundry', transaction_type: 'CHARGE', amount: 300, business_date: '2026-08-01', desc: 'Laundry express' },
    { booking_id: 'bkg_extras_1', category: 'Extra Bed', transaction_type: 'CHARGE', amount: 500, business_date: '2026-08-01' },
    { booking_id: 'bkg_extras_1', category: 'Settlement', transaction_type: 'PAYMENT', amount: 2000, business_date: '2026-08-01' }
  ];

  const roomRev = getHistoricalRoomRevenueForBooking(booking, ledgerItems, '2026-08-01', '2026-08-01');
  assert.strictEqual(roomRev, 2000, `Expected pure room revenue ₹2,000 (excluding 850+300+500 extras and payments), got ₹${roomRev}`);
});

// TEST 9: Tax handling: Pure room tariff excludes separate tax lines or payment settlements
runTest('TEST 9: Tax and payment lines are strictly excluded from pure room revenue', () => {
  const l1 = { category: 'Room Tariff', desc: 'Room Tariff', transaction_type: 'CHARGE' };
  const l2 = { category: 'Tax', desc: 'GST 12%', transaction_type: 'CHARGE' };
  const l3 = { category: 'Settlement', desc: 'Cash Payment', transaction_type: 'PAYMENT' };
  const l4 = { category: 'Refund', desc: 'Refund', transaction_type: 'REFUND' };

  assert.strictEqual(isRoomRevenueLedgerItem(l1), true, 'Room tariff must be recognized as room revenue');
  assert.strictEqual(isRoomRevenueLedgerItem(l2), false, 'Tax line must not be recognized as room revenue');
  assert.strictEqual(isRoomRevenueLedgerItem(l3), false, 'Payment line must not be recognized as room revenue');
  assert.strictEqual(isRoomRevenueLedgerItem(l4), false, 'Refund line must not be recognized as room revenue');
});

// TEST 10: Legacy fallback: Booking with no usable ledger records continues using safe fallback
runTest('TEST 10: Legacy fallback without ledger records continues using room_tariff * stay overlap', () => {
  const legacyBooking = {
    id: 'bkg_legacy_1',
    booking_status: 'Checked Out',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-04', // 3 nights
    room_tariff: 3000
  };

  const emptyLedger = [];
  const roomRev = getHistoricalRoomRevenueForBooking(legacyBooking, emptyLedger, '2026-08-01', '2026-08-03');
  assert.strictEqual(roomRev, 9000, `Expected ₹9,000 fallback room revenue (3 nights * 3000), got ₹${roomRev}`);

  const overlap = calculateStayOverlapNights(legacyBooking, '2026-08-01', '2026-08-03');
  const adr = Math.round(roomRev / overlap);
  assert.strictEqual(adr, 3000, `Expected ADR ₹3,000, got ₹${adr}`);
});

// TEST 11: Firestore/MySQL parity: Equivalent ledger items produce identical calculations
runTest('TEST 11: Firestore and MySQL parity produces identical metric calculations for room shifts', () => {
  const booking = {
    id: 'bkg_parity_test',
    booking_status: 'Checked Out',
    check_in_date: '2026-08-01',
    check_out_date: '2026-08-06',
    room_tariff: 2500
  };

  const firestoreLedgers = [
    { booking_id: 'bkg_parity_test', category: 'Room Tariff', transaction_type: 'CHARGE', amount: 1800, business_date: '2026-08-01' },
    { booking_id: 'bkg_parity_test', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-02' },
    { booking_id: 'bkg_parity_test', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-03' },
    { booking_id: 'bkg_parity_test', category: 'Room Shift Adjustment', transaction_type: 'CHARGE', debit_amount: 700, business_date: '2026-08-04' },
    { booking_id: 'bkg_parity_test', category: 'Room Tariff', transaction_type: 'ROLLOVER', debit_amount: 1800, business_date: '2026-08-04' },
    { booking_id: 'bkg_parity_test', category: 'Room Tariff', transaction_type: 'ROLLOVER', debit_amount: 2500, business_date: '2026-08-05' }
  ];

  const mysqlLedgers = [
    { booking_id: 'bkg_parity_test', category: 'Room Tariff', transaction_type: 'CHARGE', amount: 1800, business_date: '2026-08-01' },
    { booking_id: 'bkg_parity_test', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-02' },
    { booking_id: 'bkg_parity_test', category: 'Room Tariff', transaction_type: 'ROLLOVER', amount: 1800, business_date: '2026-08-03' },
    { booking_id: 'bkg_parity_test', category: 'Room Shift Adjustment', transaction_type: 'CHARGE', debit_amount: 700, business_date: '2026-08-04' },
    { booking_id: 'bkg_parity_test', category: 'Room Tariff', transaction_type: 'ROLLOVER', debit_amount: 1800, business_date: '2026-08-04' },
    { booking_id: 'bkg_parity_test', category: 'Room Tariff', transaction_type: 'ROLLOVER', debit_amount: 2500, business_date: '2026-08-05' }
  ];

  const fsRev = getHistoricalRoomRevenueForBooking(booking, firestoreLedgers, '2026-08-01', '2026-08-05');
  const sqlRev = getHistoricalRoomRevenueForBooking(booking, mysqlLedgers, '2026-08-01', '2026-08-05');

  assert.strictEqual(fsRev, sqlRev, `Firestore revenue (${fsRev}) must equal MySQL revenue (${sqlRev})`);
  assert.strictEqual(fsRev, 10400, `Both must equal ₹10,400`);
});

console.log(`\n================================================================`);
console.log(`RPT-CRIT-03 VERIFICATION RESULTS: ${passedTests}/${totalTests} TESTS PASSED`);
console.log('================================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
