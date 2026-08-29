/**
 * backend/tests/testPhase2ReportsBusinessDateAlignment.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification Test Suite for HPMS Reports & Analytics Phase 2:
 * Business Date Alignment & Filter Normalization Fixes (10 Scenarios)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import {
  formatDateOnly,
  parseDateString,
  calculatePresetDateRange
} from '../../src/utils/reportDateUtils.js';

console.log('================================================================');
console.log('HPMS REPORTS & ANALYTICS — PHASE 2 BUSINESS DATE ALIGNMENT SUITE');
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

// TEST 1: Business Date = 2026-08-19, Today -> 2026-08-19 to 2026-08-19
runTest('TEST 1: Business Date = 2026-08-19, Today -> 2026-08-19 to 2026-08-19', () => {
  const range = calculatePresetDateRange('Today', '2026-08-19');
  assert(range !== null, 'Range must not be null');
  assert.strictEqual(range.startStr, '2026-08-19', `Expected startStr '2026-08-19', got '${range.startStr}'`);
  assert.strictEqual(range.endStr, '2026-08-19', `Expected endStr '2026-08-19', got '${range.endStr}'`);
});

// TEST 2: Business Date = 2026-08-19, Yesterday -> 2026-08-18 to 2026-08-18
runTest('TEST 2: Business Date = 2026-08-19, Yesterday -> 2026-08-18 to 2026-08-18', () => {
  const range = calculatePresetDateRange('Yesterday', '2026-08-19');
  assert(range !== null, 'Range must not be null');
  assert.strictEqual(range.startStr, '2026-08-18', `Expected startStr '2026-08-18', got '${range.startStr}'`);
  assert.strictEqual(range.endStr, '2026-08-18', `Expected endStr '2026-08-18', got '${range.endStr}'`);
});

// TEST 3: Business Date = 2026-08-19, This Month -> 2026-08-01 to 2026-08-19
runTest('TEST 3: Business Date = 2026-08-19, This Month -> 2026-08-01 to 2026-08-19', () => {
  const range = calculatePresetDateRange('This Month', '2026-08-19');
  assert(range !== null, 'Range must not be null');
  assert.strictEqual(range.startStr, '2026-08-01', `Expected startStr '2026-08-01', got '${range.startStr}'`);
  assert.strictEqual(range.endStr, '2026-08-19', `Expected endStr '2026-08-19', got '${range.endStr}'`);
});

// TEST 4: Business Date = 2026-08-19, This Year -> 2026-01-01 to 2026-08-19
runTest('TEST 4: Business Date = 2026-08-19, This Year -> 2026-01-01 to 2026-08-19', () => {
  const range = calculatePresetDateRange('This Year', '2026-08-19');
  assert(range !== null, 'Range must not be null');
  assert.strictEqual(range.startStr, '2026-01-01', `Expected startStr '2026-01-01', got '${range.startStr}'`);
  assert.strictEqual(range.endStr, '2026-08-19', `Expected endStr '2026-08-19', got '${range.endStr}'`);
});

// TEST 5: Business Date = 2026-08-19 (Wednesday), This Week -> 2026-08-17 (Monday) to 2026-08-19
runTest('TEST 5: Business Date = 2026-08-19, This Week -> 2026-08-17 to 2026-08-19', () => {
  const range = calculatePresetDateRange('This Week', '2026-08-19');
  assert(range !== null, 'Range must not be null');
  assert.strictEqual(range.startStr, '2026-08-17', `Expected startStr '2026-08-17', got '${range.startStr}'`);
  assert.strictEqual(range.endStr, '2026-08-19', `Expected endStr '2026-08-19', got '${range.endStr}'`);
});

// TEST 6: IST Timezone Simulation: Date = 2026-08-26 -> serialized string is 2026-08-26 (never 2026-08-25)
runTest('TEST 6: IST Timezone Simulation: Serialized date is 2026-08-26 (never 2026-08-25)', () => {
  const dateStr = '2026-08-26';
  const formatted = formatDateOnly(dateStr);
  assert.strictEqual(formatted, '2026-08-26', `Expected '2026-08-26', got '${formatted}'`);

  const parsed = parseDateString(dateStr);
  const formattedAgain = formatDateOnly(parsed);
  assert.strictEqual(formattedAgain, '2026-08-26', `Expected '2026-08-26', got '${formattedAgain}'`);
});

// TEST 7: Independent from system wall clock: Hotel business date fixed at 2026-08-19
runTest('TEST 7: Independent from system clock: Hotel Business Date fixed at 2026-08-19', () => {
  // Regardless of what new Date() returns on the host machine, calculation with businessDate '2026-08-19' returns '2026-08-19'
  const range = calculatePresetDateRange('Today', '2026-08-19');
  assert.strictEqual(range.startStr, '2026-08-19');
  assert.strictEqual(range.endStr, '2026-08-19');
});

// TEST 8: Custom Range: 2026-08-05 to 2026-08-07 preserved verbatim
runTest('TEST 8: Custom Range: 2026-08-05 to 2026-08-07 preserved verbatim', () => {
  const range = calculatePresetDateRange('Custom Date Range', '2026-08-19', '2026-08-05', '2026-08-07');
  assert(range !== null, 'Range must not be null');
  assert.strictEqual(range.startStr, '2026-08-05', `Expected startStr '2026-08-05', got '${range.startStr}'`);
  assert.strictEqual(range.endStr, '2026-08-07', `Expected endStr '2026-08-07', got '${range.endStr}'`);
});

// TEST 9: Business Date API failure / missing -> No silent fallback to new Date()
runTest('TEST 9: Business Date API failure -> No silent fallback to browser date (returns null)', () => {
  const rangeNull = calculatePresetDateRange('Today', null);
  assert.strictEqual(rangeNull, null, 'Must return null when business date is missing');

  const rangeEmpty = calculatePresetDateRange('Today', '');
  assert.strictEqual(rangeEmpty, null, 'Must return null when business date is empty');

  const rangeInvalid = calculatePresetDateRange('Today', 'invalid-date');
  assert.strictEqual(rangeInvalid, null, 'Must return null when business date is invalid format');
});

// TEST 10: Sunday week boundary check
runTest('TEST 10: Sunday week boundary (e.g. 2026-08-23 Sunday -> start of week 2026-08-17 Monday)', () => {
  const range = calculatePresetDateRange('This Week', '2026-08-23');
  assert(range !== null);
  assert.strictEqual(range.startStr, '2026-08-17', `Expected startStr '2026-08-17', got '${range.startStr}'`);
  assert.strictEqual(range.endStr, '2026-08-23', `Expected endStr '2026-08-23', got '${range.endStr}'`);
});

console.log(`\n================================================================`);
console.log(`PHASE 2 VERIFICATION RESULTS: ${passedTests}/${totalTests} TESTS PASSED`);
console.log('================================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
