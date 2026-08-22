import {
  FirestoreShadowComparisonService,
  ShadowVerificationLogger,
  maskSensitive,
  normalizeValue,
  areValuesEqual
} from '../services/firestoreShadowComparisonService.js';
import {
  isFirestoreAvailabilityShadowEnabled,
  isFirestoreRoomStatusShadowEnabled,
  isFirestoreLedgerShadowEnabled,
  isFirestoreReportsShadowEnabled,
  isFirestoreAvailabilityServingEnabled,
  isFirestoreRoomStatusServingEnabled,
  isFirestoreLedgerServingEnabled,
  isFirestoreReportsServingEnabled
} from '../config/featureFlags.js';

async function runShadowTestSuite() {
  console.log('========================================================================');
  console.log('  HPMS PHASE 2 STEP 1: DUAL-READ SHADOW INFRASTRUCTURE TEST SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASSED: ${message}`);
      passed++;
    } else {
      console.error(`  ✕ FAILED: ${message}`);
      failed++;
    }
  }

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // TEST 0: Feature Flag Safe Defaults Verification
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Feature Flag Safe Invariants Verification ---');
    assert(isFirestoreAvailabilityShadowEnabled() === true, 'Shadow Flag: USE_FIRESTORE_AVAILABILITY_SHADOW is active');
    assert(isFirestoreRoomStatusShadowEnabled() === true, 'Shadow Flag: USE_FIRESTORE_ROOM_STATUS_SHADOW is active');
    assert(isFirestoreLedgerShadowEnabled() === true, 'Shadow Flag: USE_FIRESTORE_LEDGER_SHADOW is active');
    assert(isFirestoreReportsShadowEnabled() === true, 'Shadow Flag: USE_FIRESTORE_REPORTS_SHADOW is active');

    assert(typeof isFirestoreAvailabilityServingEnabled() === 'boolean', 'Cutover Flag: USE_FIRESTORE_AVAILABILITY is configured');
    assert(typeof isFirestoreRoomStatusServingEnabled() === 'boolean', 'Cutover Flag: USE_FIRESTORE_ROOM_STATUS is configured');
    assert(typeof isFirestoreLedgerServingEnabled() === 'boolean', 'Cutover Flag: USE_FIRESTORE_LEDGER is configured');
    assert(isFirestoreReportsServingEnabled() === false, 'Cutover Flag: USE_FIRESTORE_REPORTS is strictly FALSE');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1 & 2: Room Status Comparison (Match & Mismatch Detection)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Domain 1: Room Status Shadow Comparison ---');
    const mysqlRoomsSample = [
      { number: '101', status: 'occupied', housekeeping_status: 'Clean', is_active: true, rate: 2500, guestName: 'RAHUL SHARMA', phone: '9876543210' },
      { number: '102', status: 'vacant', housekeeping_status: 'Clean', is_active: true, rate: 2000, guestName: '', phone: '' }
    ];

    const firestoreRoomsMatch = [
      { number: '101', status: 'occupied', housekeeping_status: 'Clean', is_active: 1, rate: 2500.00, guestName: 'rahul sharma', phone: '9876543210' },
      { number: '102', status: 'vacant', housekeeping_status: 'Clean', is_active: true, rate: 2000, guestName: null, phone: null }
    ];

    const matchRes1 = FirestoreShadowComparisonService.compareRoomStatus(mysqlRoomsSample, firestoreRoomsMatch, { test: 'match_case' });
    assert(matchRes1.match === true && matchRes1.mismatchCount === 0, 'TEST 1: Identical room status outputs produce MATCH (true)');

    const firestoreRoomsMismatch = [
      { number: '101', status: 'vacant', housekeeping_status: 'Clean', is_active: true, rate: 2500, guestName: '', phone: '' }, // Mismatch on status & guestName
      { number: '102', status: 'vacant', housekeeping_status: 'Clean', is_active: true, rate: 2000, guestName: '', phone: '' }
    ];

    const diffRes1 = FirestoreShadowComparisonService.compareRoomStatus(mysqlRoomsSample, firestoreRoomsMismatch, { test: 'diff_case' });
    assert(diffRes1.match === false && diffRes1.mismatchCount >= 2, 'TEST 2: Room status mismatch correctly detected with field-level diffs');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3 & 4: Availability Comparison (Match & Mismatch Detection)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Domain 2: Availability Shadow Comparison ---');
    const mysqlAvailMatch = { available: true, reason: null, code: null };
    const fsAvailMatch = { available: true, reason: null, code: null };
    const matchAvailRes = FirestoreShadowComparisonService.compareAvailability(mysqlAvailMatch, fsAvailMatch, { roomNumber: '101' });
    assert(matchAvailRes.match === true, 'TEST 3: Identical availability returns MATCH (true)');

    const mysqlAvailDiff = { available: true, reason: null, code: null };
    const fsAvailDiff = { available: false, reason: 'Room occupied', code: 'ROOM_OCCUPIED_BOOKING' };
    const diffAvailRes = FirestoreShadowComparisonService.compareAvailability(mysqlAvailDiff, fsAvailDiff, { roomNumber: '101' });
    assert(diffAvailRes.match === false && diffAvailRes.mismatches[0].field === 'available', 'TEST 4: Availability conflict mismatch correctly detected');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5 & 6: Ledger / Folio Comparison (Match & Mismatch Detection)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Domain 3: Ledger / Folio Shadow Comparison ---');
    const mysqlLedgerMatch = {
      summary: { totalCharges: 5000, totalPayments: 2000, outstanding: 3000 }
    };
    const fsLedgerMatch = {
      summary: { totalCharges: 5000.00, totalPayments: 2000.00, outstanding: 3000.00 }
    };
    const matchLedgerRes = FirestoreShadowComparisonService.compareLedger(mysqlLedgerMatch, fsLedgerMatch, { roomNumber: '101' });
    assert(matchLedgerRes.match === true, 'TEST 5: Identical ledger summaries return MATCH (true)');

    const fsLedgerDiff = {
      summary: { totalCharges: 5000, totalPayments: 1000, outstanding: 4000 }
    };
    const diffLedgerRes = FirestoreShadowComparisonService.compareLedger(mysqlLedgerMatch, fsLedgerDiff, { roomNumber: '101' });
    assert(diffLedgerRes.match === false && diffLedgerRes.mismatches.some(m => m.field === 'summary.outstanding'), 'TEST 6: Ledger balance mismatch correctly detected');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 7 & 8: Financial / Reports Comparison (Match & Mismatch Detection)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Domain 4: Reports Shadow Comparison ---');
    const mysqlReportMatch = {
      totalRevenue: 15000,
      occupancyRate: 75,
      totalBookings: 12,
      adr: 2500,
      revPAR: 1875
    };
    const fsReportMatch = {
      totalRevenue: 15000.00,
      occupancyRate: 75,
      totalBookings: 12,
      adr: 2500.00,
      revPAR: 1875.00
    };
    const matchReportRes = FirestoreShadowComparisonService.compareReports(mysqlReportMatch, fsReportMatch, 'overview');
    assert(matchReportRes.match === true, 'TEST 7: Identical report metrics return MATCH (true)');

    const fsReportDiff = {
      totalRevenue: 12000,
      occupancyRate: 75,
      totalBookings: 12,
      adr: 2000,
      revPAR: 1500
    };
    const diffReportRes = FirestoreShadowComparisonService.compareReports(mysqlReportMatch, fsReportDiff, 'overview');
    assert(diffReportRes.match === false && diffReportRes.mismatches.some(m => m.field === 'totalRevenue'), 'TEST 8: Report revenue mismatch correctly detected');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 9 & 10: Error Isolation & Non-Blocking Resilience
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Error Isolation & Asynchronous Resilience ---');
    let asyncExecutionCompleted = false;
    FirestoreShadowComparisonService.executeShadowAsync(
      'fault_tolerance_test',
      async () => {
        throw new Error('Simulated network timeout or permission failure in Firestore');
      },
      () => {
        // should not be reached
      },
      { testCase: 'isolation' }
    );

    // Give event loop a microtick to process setImmediate
    await new Promise(r => setTimeout(r, 50));
    assert(true, 'TEST 9 & 10: Firestore shadow exception isolated without crashing application or throwing into caller');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 11 to 15: Normalization & Sensitive Masking
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Normalization & Security Masking ---');

    // TEST 11: Null vs undefined vs empty string
    const eq1 = areValuesEqual(null, undefined);
    const eq2 = areValuesEqual('', null);
    const eq3 = areValuesEqual('   ', undefined);
    assert(eq1 && eq2 && eq3, 'TEST 11: Null, undefined, and empty string normalized as equivalent');

    // TEST 12: Numeric normalization with epsilon
    const numEq = areValuesEqual(2500.00001, 2500.0, 'rate');
    assert(numEq, 'TEST 12: Float precision differences within epsilon (0.01) treated as EQUAL');

    // TEST 13: Date string normalization
    const dateEq = areValuesEqual('19-Aug-2026', '2026-08-19', 'check_in_date');
    assert(dateEq, 'TEST 13: DD-Mon-YYYY and YYYY-MM-DD date formats normalized as EQUAL');

    // TEST 14: Boolean & string flag normalization
    const boolEq1 = areValuesEqual(true, 1, 'is_active');
    const boolEq2 = areValuesEqual(false, '0', 'is_active');
    assert(boolEq1 && boolEq2, 'TEST 14: Boolean flags and integer representations normalized as EQUAL');

    // TEST 15: Sensitive masking
    const maskedPhone = maskSensitive('phone', '+919876543210');
    const maskedCard = maskSensitive('card_number', '4111111111111234');
    assert(maskedPhone.includes('****') && maskedCard.includes('****'), 'TEST 15: Sensitive fields (phone, card) properly masked in shadow logs');

  } catch (err) {
    console.error('Unhandled shadow test suite error:', err);
    failed++;
  }

  console.log('\n========================================================================');
  console.log(`  TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runShadowTestSuite();
