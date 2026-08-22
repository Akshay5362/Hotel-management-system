import assert from 'assert';
import { validateCheckInPayload } from '../validators/checkInValidator.js';
import crypto from 'crypto';

const JWT_SECRET = 'hotel-pms-super-secret-key-12345!';
function generateToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'admin', isRootAdmin: true });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return base64Payload + '.' + signature;
}

const adminToken = generateToken({ id: 1, role: 'admin' });

async function runCheckInMandatoryValidationTests() {
  console.log('========================================================================');
  console.log('HPMS CHECK-IN 8 MANDATORY FIELDS & 6 OPTIONAL FIELDS TEST SUITE');
  console.log('========================================================================');

  // Baseline payload with ONLY the 8 mandatory fields
  const baseline8MandatoryPayload = {
    fullName: 'Test Guest',
    age: 28,
    contactNumber: '9876543210',
    state: 'Himachal Pradesh',
    purposeOfVisit: 'Personal',
    pax: 1,
    billingInstructions: 'Direct to Guest',
    roomRent: 2000
  };

  // ── TEST 1: All 8 mandatory fields provided, optional fields all blank ───────
  console.log('\n--- Test 1: All 8 mandatory fields provided, optional fields all blank ---');
  const t1 = validateCheckInPayload(baseline8MandatoryPayload);
  assert.strictEqual(t1.isValid, true, 'Check-in must succeed when only 8 mandatory fields are provided');
  assert.strictEqual(t1.sanitized.guestName, 'Test Guest');
  assert.strictEqual(t1.sanitized.age, 28);
  assert.strictEqual(t1.sanitized.phone, '9876543210');
  assert.strictEqual(t1.sanitized.state, 'Himachal Pradesh');
  assert.strictEqual(t1.sanitized.purposeOfVisit, 'Personal');
  assert.strictEqual(t1.sanitized.pax, 1);
  assert.strictEqual(t1.sanitized.billingInstruction, 'Direct to Guest');
  assert.strictEqual(t1.sanitized.roomTariff, 2000);
  assert.strictEqual(t1.sanitized.email, '');
  assert.strictEqual(t1.sanitized.country, '');
  assert.strictEqual(t1.sanitized.address, '');
  assert.strictEqual(t1.sanitized.children, 0);
  console.log(' ✅ Test 1 Passed: Check-In SUCCESS with only 8 mandatory fields.');

  // ── TEST 2: Email blank only ────────────────────────────────────────────────
  console.log('\n--- Test 2: Email blank only ---');
  const t2 = validateCheckInPayload({ ...baseline8MandatoryPayload, email: '' });
  assert.strictEqual(t2.isValid, true);
  console.log(' ✅ Test 2 Passed: Check-In SUCCESS with blank email.');

  // ── TEST 3: Country blank only ──────────────────────────────────────────────
  console.log('\n--- Test 3: Country blank only ---');
  const t3 = validateCheckInPayload({ ...baseline8MandatoryPayload, country: '' });
  assert.strictEqual(t3.isValid, true);
  console.log(' ✅ Test 3 Passed: Check-In SUCCESS with blank country.');

  // ── TEST 4: Address blank only ──────────────────────────────────────────────
  console.log('\n--- Test 4: Address blank only ---');
  const t4 = validateCheckInPayload({ ...baseline8MandatoryPayload, address: '' });
  assert.strictEqual(t4.isValid, true);
  console.log(' ✅ Test 4 Passed: Check-In SUCCESS with blank address.');

  // ── TEST 5: Arrival Date blank ──────────────────────────────────────────────
  console.log('\n--- Test 5: Arrival Date blank ---');
  const t5 = validateCheckInPayload({ ...baseline8MandatoryPayload, arrivalDate: '' });
  assert.strictEqual(t5.isValid, true);
  console.log(' ✅ Test 5 Passed: Check-In SUCCESS with blank arrival date.');

  // ── TEST 6: Departure Date blank ────────────────────────────────────────────
  console.log('\n--- Test 6: Departure Date blank ---');
  const t6 = validateCheckInPayload({ ...baseline8MandatoryPayload, departureDate: '' });
  assert.strictEqual(t6.isValid, true);
  console.log(' ✅ Test 6 Passed: Check-In SUCCESS with blank departure date.');

  // ── TEST 7: Children blank/zero ─────────────────────────────────────────────
  console.log('\n--- Test 7: Children blank/zero ---');
  const t7a = validateCheckInPayload({ ...baseline8MandatoryPayload, children: '' });
  assert.strictEqual(t7a.isValid, true);
  assert.strictEqual(t7a.sanitized.children, 0);

  const t7b = validateCheckInPayload({ ...baseline8MandatoryPayload, children: 0 });
  assert.strictEqual(t7b.isValid, true);
  assert.strictEqual(t7b.sanitized.children, 0);

  const t7c = validateCheckInPayload({ ...baseline8MandatoryPayload, children: 2 });
  assert.strictEqual(t7c.isValid, true);
  assert.strictEqual(t7c.sanitized.children, 2);
  console.log(' ✅ Test 7 Passed: Check-In SUCCESS with children blank/zero/provided.');

  // ── TEST 8: Name blank (MANDATORY) ──────────────────────────────────────────
  console.log('\n--- Test 8: Name blank ---');
  const t8 = validateCheckInPayload({ ...baseline8MandatoryPayload, fullName: '   ' });
  assert.strictEqual(t8.isValid, false);
  assert(t8.errors.fullName, 'Must flag fullName error');
  console.log(` ✅ Test 8 Passed: BLOCKED -> "${t8.errors.fullName}"`);

  // ── TEST 9: Age blank / zero / invalid (MANDATORY) ──────────────────────────
  console.log('\n--- Test 9: Age blank / zero / invalid ---');
  const t9a = validateCheckInPayload({ ...baseline8MandatoryPayload, age: '' });
  assert.strictEqual(t9a.isValid, false);
  assert(t9a.errors.age);

  const t9b = validateCheckInPayload({ ...baseline8MandatoryPayload, age: 0 });
  assert.strictEqual(t9b.isValid, false);
  assert(t9b.errors.age);

  const t9c = validateCheckInPayload({ ...baseline8MandatoryPayload, age: -5 });
  assert.strictEqual(t9c.isValid, false);

  const t9d = validateCheckInPayload({ ...baseline8MandatoryPayload, age: 130 });
  assert.strictEqual(t9d.isValid, false);
  console.log(` ✅ Test 9 Passed: BLOCKED -> "${t9a.errors.age}"`);

  // ── TEST 10: Contact Number blank (MANDATORY) ───────────────────────────────
  console.log('\n--- Test 10: Contact Number blank ---');
  const t10a = validateCheckInPayload({ ...baseline8MandatoryPayload, contactNumber: '' });
  assert.strictEqual(t10a.isValid, false);
  assert(t10a.errors.contactNumber);

  const t10b = validateCheckInPayload({ ...baseline8MandatoryPayload, contactNumber: '123' });
  assert.strictEqual(t10b.isValid, false);
  console.log(` ✅ Test 10 Passed: BLOCKED -> "${t10a.errors.contactNumber}"`);

  // ── TEST 11: State blank (MANDATORY) ────────────────────────────────────────
  console.log('\n--- Test 11: State blank ---');
  const t11 = validateCheckInPayload({ ...baseline8MandatoryPayload, state: '   ' });
  assert.strictEqual(t11.isValid, false);
  assert(t11.errors.state);
  console.log(` ✅ Test 11 Passed: BLOCKED -> "${t11.errors.state}"`);

  // ── TEST 12: Purpose blank (MANDATORY) ──────────────────────────────────────
  console.log('\n--- Test 12: Purpose blank ---');
  const t12 = validateCheckInPayload({ ...baseline8MandatoryPayload, purposeOfVisit: '' });
  assert.strictEqual(t12.isValid, false);
  assert(t12.errors.purposeOfVisit);
  console.log(` ✅ Test 12 Passed: BLOCKED -> "${t12.errors.purposeOfVisit}"`);

  // ── TEST 13: PAX blank/invalid (MANDATORY) ──────────────────────────────────
  console.log('\n--- Test 13: PAX blank/invalid ---');
  const t13a = validateCheckInPayload({ ...baseline8MandatoryPayload, pax: '' });
  assert.strictEqual(t13a.isValid, false);
  assert(t13a.errors.pax);

  const t13b = validateCheckInPayload({ ...baseline8MandatoryPayload, pax: 0 });
  assert.strictEqual(t13b.isValid, false);
  console.log(` ✅ Test 13 Passed: BLOCKED -> "${t13a.errors.pax}"`);

  // ── TEST 14: Billing Instructions blank (MANDATORY) ─────────────────────────
  console.log('\n--- Test 14: Billing Instructions blank ---');
  const t14 = validateCheckInPayload({ ...baseline8MandatoryPayload, billingInstructions: '' });
  assert.strictEqual(t14.isValid, false);
  assert(t14.errors.billingInstructions);
  console.log(` ✅ Test 14 Passed: BLOCKED -> "${t14.errors.billingInstructions}"`);

  // ── TEST 15: Room Rent blank/zero/invalid (MANDATORY) ────────────────────────
  console.log('\n--- Test 15: Room Rent blank/zero/invalid ---');
  const t15a = validateCheckInPayload({ ...baseline8MandatoryPayload, roomRent: '' });
  assert.strictEqual(t15a.isValid, false);
  assert(t15a.errors.roomRent);

  const t15b = validateCheckInPayload({ ...baseline8MandatoryPayload, roomRent: 0 });
  assert.strictEqual(t15b.isValid, false);

  const t15c = validateCheckInPayload({ ...baseline8MandatoryPayload, roomRent: -100 });
  assert.strictEqual(t15c.isValid, false);
  console.log(` ✅ Test 15 Passed: BLOCKED -> "${t15a.errors.roomRent}"`);

  // ── TEST 16: Optional fields format validation when non-empty ────────────────
  console.log('\n--- Test 16: Format validation on non-empty optional fields ---');
  const t16a = validateCheckInPayload({ ...baseline8MandatoryPayload, email: 'invalid-email-format' });
  assert.strictEqual(t16a.isValid, false);
  assert(t16a.errors.email);

  const t16b = validateCheckInPayload({ ...baseline8MandatoryPayload, children: -1 });
  assert.strictEqual(t16b.isValid, false);
  assert(t16b.errors.children);

  const t16c = validateCheckInPayload({
    ...baseline8MandatoryPayload,
    arrivalDate: '2026-08-25',
    departureDate: '2026-08-24' // Invalid: dep <= arr
  });
  assert.strictEqual(t16c.isValid, false);
  assert(t16c.errors.departureDate);
  console.log(' ✅ Test 16 Passed: Format validation enforced only when optional field is provided.');

  // ── TEST 17: Live API Check-In with ONLY 8 Mandatory Fields (HTTP 200) ──────
  console.log('\n--- Test 17: Live API Check-In with ONLY 8 Mandatory Fields ---');
  await fetch('http://127.0.0.1:5000/api/rooms/4/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ balancePaid: 2000 })
  });

  await fetch('http://127.0.0.1:5000/api/rooms/4/clean', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  const apiRes = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      guestName: 'Only Eight Mandatory',
      age: 27,
      phone: '9876543210',
      state: 'Haryana',
      purposeOfVisit: 'Business',
      pax: 1,
      billingInstructions: 'Direct to Guest',
      roomRent: 2000
    })
  });
  const apiData = await apiRes.json();
  if (apiRes.status !== 200) {
    console.error('Test 17 Error Response:', apiData);
  }
  assert.strictEqual(apiRes.status, 200, 'Live check-in API must succeed with only 8 mandatory fields');
  assert(apiData.bookingId || apiData.bookingNumber, 'Response must have bookingId or bookingNumber');
  console.log(` ✅ Test 17 Passed: Live API Check-In succeeded with status 200 (Booking: ${apiData.bookingNumber})`);

  // Checkout room 4
  await fetch('http://127.0.0.1:5000/api/rooms/4/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ balancePaid: 2000 })
  });

  console.log('\n========================================================================');
  console.log('✅ ALL CHECK-IN MANDATORY FIELD TESTS PASSED (17/17)');
  console.log('========================================================================');
}

runCheckInMandatoryValidationTests();
