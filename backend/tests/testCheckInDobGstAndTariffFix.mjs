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

async function waitForServer() {
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch('http://127.0.0.1:5000/api/health', { headers: { Authorization: `Bearer ${adminToken}` } });
      if (res.ok || res.status === 200 || res.status === 404) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function runDobGstAndTariffTests() {
  await waitForServer();
  console.log('========================================================================');
  console.log('HPMS CHECK-IN DOB, GST & ROOM RENT VALIDATION VERIFICATION');
  console.log('========================================================================');

  const baseCheckIn = {
    fullName: 'Rohan Sharma',
    age: 34,
    contactNumber: '9812345678',
    state: 'Punjab',
    purposeOfVisit: 'Business',
    pax: 2,
    billingInstructions: 'Direct to Guest',
    roomRent: 2000
  };

  // ── TEST A: Existing complete Check-In data, DOB blank, Company GST blank, Room Rent = ₹2000
  console.log('\n--- TEST A: Complete Check-In data, DOB blank, Company GST blank, Room Rent = ₹2000 ---');
  const testA = validateCheckInPayload({ ...baseCheckIn, dob: '', gstNo: '', roomRent: 2000 });
  assert.strictEqual(testA.isValid, true, 'Check-in must succeed with DOB blank and GST blank');
  assert.strictEqual(testA.sanitized.roomTariff, 2000);
  assert.strictEqual(testA.sanitized.dob, null);
  assert.strictEqual(testA.sanitized.gstNo, '');
  console.log(' ✅ TEST A Passed: SUCCESS with DOB blank, GST blank, Room Rent ₹2000.');

  // ── TEST B: DOB provided, GST blank
  console.log('\n--- TEST B: DOB provided, GST blank ---');
  const testB = validateCheckInPayload({ ...baseCheckIn, dob: '1990-05-15', gstNo: '' });
  assert.strictEqual(testB.isValid, true);
  assert.strictEqual(testB.sanitized.dob, '1990-05-15');
  assert.strictEqual(testB.sanitized.dateOfBirth, '1990-05-15');
  console.log(' ✅ TEST B Passed: SUCCESS and DOB stored.');

  // ── TEST C: DOB blank, GST provided
  console.log('\n--- TEST C: DOB blank, GST provided ---');
  const testC = validateCheckInPayload({ ...baseCheckIn, dob: '', gstNo: '06AAAAA0000A1Z5' });
  assert.strictEqual(testC.isValid, true);
  assert.strictEqual(testC.sanitized.gstNo, '06AAAAA0000A1Z5');
  console.log(' ✅ TEST C Passed: SUCCESS and GST stored.');

  // ── TEST D: DOB provided, GST provided
  console.log('\n--- TEST D: DOB provided, GST provided ---');
  const testD = validateCheckInPayload({ ...baseCheckIn, dob: '1992-11-20', gstNo: '07BBBBB1111B1Z2' });
  assert.strictEqual(testD.isValid, true);
  assert.strictEqual(testD.sanitized.dob, '1992-11-20');
  assert.strictEqual(testD.sanitized.gstNo, '07BBBBB1111B1Z2');
  console.log(' ✅ TEST D Passed: SUCCESS and both DOB and GST stored.');

  // ── TEST E: Room Rent = ₹1500
  console.log('\n--- TEST E: Room Rent = ₹1500 ---');
  const testE = validateCheckInPayload({ ...baseCheckIn, roomRent: 1500 });
  assert.strictEqual(testE.isValid, true);
  assert.strictEqual(testE.sanitized.roomTariff, 1500);
  console.log(' ✅ TEST E Passed: Room Rent ₹1500 is VALID.');

  // ── TEST F: Room Rent = ₹2000
  console.log('\n--- TEST F: Room Rent = ₹2000 ---');
  const testF = validateCheckInPayload({ ...baseCheckIn, roomRent: 2000 });
  assert.strictEqual(testF.isValid, true);
  assert.strictEqual(testF.sanitized.roomTariff, 2000);
  console.log(' ✅ TEST F Passed: Room Rent ₹2000 is VALID.');

  // ── TEST G: Room Rent = ₹2500
  console.log('\n--- TEST G: Room Rent = ₹2500 ---');
  const testG = validateCheckInPayload({ ...baseCheckIn, roomRent: 2500 });
  assert.strictEqual(testG.isValid, true);
  assert.strictEqual(testG.sanitized.roomTariff, 2500);
  console.log(' ✅ TEST G Passed: Room Rent ₹2500 is VALID.');

  // ── TEST H: Invalid negative room rent
  console.log('\n--- TEST H: Invalid negative room rent ---');
  const testH = validateCheckInPayload({ ...baseCheckIn, roomRent: -500 });
  assert.strictEqual(testH.isValid, false);
  assert(testH.errors.roomRent);
  console.log(` ✅ TEST H Passed: Negative room rent BLOCKED (${testH.errors.roomRent}).`);

  // ── TEST I: Non-numeric room rent
  console.log('\n--- TEST I: Non-numeric room rent ---');
  const testI = validateCheckInPayload({ ...baseCheckIn, roomRent: 'abc' });
  assert.strictEqual(testI.isValid, false);
  assert(testI.errors.roomRent);
  console.log(` ✅ TEST I Passed: Non-numeric room rent BLOCKED (${testI.errors.roomRent}).`);

  // ── TEST J: Live Check-In with DOB and GST + Master Bill / Invoice Sync
  console.log('\n--- TEST J: Live API Check-In on Room 4 with DOB and GST ---');
  await fetch('http://127.0.0.1:5000/api/rooms/4/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ balancePaid: 2000 })
  });

  await fetch('http://127.0.0.1:5000/api/rooms/4/clean', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  const checkInRes = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      guestName: 'TEST CORPORATE GUEST',
      age: 35,
      dateOfBirth: '1989-08-15',
      dob: '1989-08-15',
      phone: '9988776655',
      state: 'Haryana',
      purposeOfVisit: 'Official',
      pax: 2,
      billingInstructions: 'Bill to Company',
      companyName: 'Acme Corp Pvt Ltd',
      gstNo: '06AABCA1234A1Z5',
      roomRent: 2000
    })
  });

  assert.strictEqual(checkInRes.status, 200);
  const checkInData = await checkInRes.json();
  console.log(` ✅ Live Check-In succeeded: Booking ${checkInData.bookingNumber}`);

  // Verify Master Bill includes GST
  const billRes = await fetch('http://127.0.0.1:5000/api/invoices/master-bill/4', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(billRes.status, 200);
  const billData = await billRes.json();
  assert.strictEqual(billData.guest.gstin, '06AABCA1234A1Z5', 'Master Bill must display guest GSTIN');
  assert.strictEqual(billData.settlement.grossTotal, 2000, 'Master bill gross total must match ₹2000');
  assert.strictEqual(billData.settlement.outstandingBalance, 2000, 'Master bill outstanding balance must match ₹2000');
  console.log(` ✅ Master Bill verified: Guest GSTIN "${billData.guest.gstin}" attached to bill`);

  // Clean up test stay on Room 4
  await fetch('http://127.0.0.1:5000/api/rooms/4/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ balancePaid: 2000 })
  });

  await fetch('http://127.0.0.1:5000/api/rooms/4/clean', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  console.log('\n========================================================================');
  console.log('✅ ALL DOB, GST, TARIFF & MODIFY CHECK-IN TESTS PASSED (10/10)');
  console.log('========================================================================');
}

runDobGstAndTariffTests();
