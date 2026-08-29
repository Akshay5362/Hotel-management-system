import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';
import { getAdminTestToken } from './helpers/firebaseTestTokenHelper.mjs';

const adminToken = await getAdminTestToken();

async function resetRoom4() {
  await fetch('http://127.0.0.1:5000/api/rooms/4/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ balancePaid: 2000 })
  });
  await fetch('http://127.0.0.1:5000/api/rooms/4/clean', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
}

async function waitForServer() {
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch('http://127.0.0.1:5000/api/admin/guests', { headers: { Authorization: `Bearer ${adminToken}` } });
      if (res.ok) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function runGenderAndPincodeTests() {
  await waitForServer();
  console.log('========================================================================');
  console.log('HPMS CHECK-IN GENDER & PINCODE VERIFICATION TEST SUITE');
  console.log('========================================================================');

  const runTag = Date.now().toString().slice(-5);
  const phone1 = `9811${runTag}`;
  const phone2 = `9822${runTag}`;
  const phone3 = `9833${runTag}`;
  const phone4 = `9844${runTag}`;

  // ── TEST 1: Gender provided + Pincode provided ─────────────────────────────
  console.log('\n--- TEST 1: Gender provided + Pincode provided ---');
  await resetRoom4();

  const res1 = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      guestName: 'PRIYA SHARMA',
      age: 28,
      dob: '1998-05-12',
      gender: 'Female',
      phone: phone1,
      email: 'priya@example.com',
      country: 'India',
      state: 'Himachal Pradesh',
      address: 'Mall Road, Shimla',
      pincode: '171001',
      purposeOfVisit: 'Tourist',
      pax: 2,
      billingInstruction: 'Direct to Guest',
      roomRent: 2000
    })
  });
  assert.strictEqual(res1.status, 200, 'Check-In with Gender and Pincode must succeed');
  const data1 = await res1.json();
  console.log(` Check-in success: Booking ${data1.bookingNumber}`);

  // Verify Firestore guest doc
  const guest1Doc = await db.collection('guests').doc(`guest_${phone1}`).get();
  assert(guest1Doc.exists, 'Guest doc must exist');
  const g1 = guest1Doc.data();
  assert.strictEqual(g1.gender, 'Female', 'Guest gender must be Female');
  assert.strictEqual(g1.pincode, '171001', 'Guest pincode must be 171001');
  assert.strictEqual(g1.full_name, 'PRIYA SHARMA');
  console.log(` ✅ TEST 1 Passed: Guest persisted with gender="Female", pincode="171001"`);

  // ── TEST 2: Gender blank + Pincode provided ─────────────────────────────────
  console.log('\n--- TEST 2: Gender blank + Pincode provided ---');
  await resetRoom4();

  const res2 = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      guestName: 'RAHUL VERMA',
      age: 34,
      phone: phone2,
      gender: '',
      state: 'Delhi',
      pincode: '110001',
      purposeOfVisit: 'Business',
      pax: 1,
      billingInstruction: 'Direct to Guest',
      roomRent: 2000
    })
  });
  assert.strictEqual(res2.status, 200);
  const guest2Doc = await db.collection('guests').doc(`guest_${phone2}`).get();
  const g2 = guest2Doc.data();
  assert.strictEqual(g2.gender, null, 'Gender must be null when blank');
  assert.strictEqual(g2.pincode, '110001', 'Pincode must be 110001');
  console.log(` ✅ TEST 2 Passed: Gender blank + Pincode provided succeeded (gender=null, pincode="110001")`);

  // ── TEST 3: Gender provided + Pincode blank ─────────────────────────────────
  console.log('\n--- TEST 3: Gender provided + Pincode blank ---');
  await resetRoom4();

  const res3 = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      guestName: 'ALEX MORGAN',
      age: 29,
      phone: phone3,
      gender: 'Other',
      state: 'Goa',
      pincode: '',
      purposeOfVisit: 'Tourist',
      pax: 1,
      billingInstruction: 'Direct to Guest',
      roomRent: 2000
    })
  });
  assert.strictEqual(res3.status, 200);
  const guest3Doc = await db.collection('guests').doc(`guest_${phone3}`).get();
  const g3 = guest3Doc.data();
  assert.strictEqual(g3.gender, 'Other', 'Gender must be Other');
  assert.strictEqual(g3.pincode, '', 'Pincode must be empty string');
  console.log(` ✅ TEST 3 Passed: Gender provided + Pincode blank succeeded (gender="Other", pincode="")`);

  // ── TEST 4: Gender blank + Pincode blank ───────────────────────────────────
  console.log('\n--- TEST 4: Gender blank + Pincode blank ---');
  await resetRoom4();

  const res4 = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      guestName: 'SIMRAN KAUR',
      age: 26,
      phone: phone4,
      state: 'Punjab',
      purposeOfVisit: 'Function',
      pax: 1,
      billingInstruction: 'Direct to Guest',
      roomRent: 2000
    })
  });
  assert.strictEqual(res4.status, 200);
  const guest4Doc = await db.collection('guests').doc(`guest_${phone4}`).get();
  const g4 = guest4Doc.data();
  assert.strictEqual(g4.gender, null, 'Gender must default to null when omitted');
  assert.strictEqual(g4.pincode, '', 'Pincode must default to empty when omitted');
  console.log(` ✅ TEST 4 Passed: Both blank succeeded without errors`);

  // ── TEST 5: Existing guest checks in again with Gender/Pincode (UPSERT) ─────
  console.log('\n--- TEST 5: Existing guest checks in again with Gender/Pincode (UPSERT) ---');
  await resetRoom4();

  // Re-check-in phone4 (Simran Kaur) now adding Gender="Female" and Pincode="143001"
  const res5 = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      guestName: 'SIMRAN KAUR',
      age: 26,
      gender: 'Female',
      pincode: '143001',
      phone: phone4,
      state: 'Punjab',
      purposeOfVisit: 'Personal',
      pax: 1,
      billingInstruction: 'Direct to Guest',
      roomRent: 2000
    })
  });
  assert.strictEqual(res5.status, 200);
  const guest5Doc = await db.collection('guests').doc(`guest_${phone4}`).get();
  const g5 = guest5Doc.data();
  assert.strictEqual(g5.gender, 'Female', 'Gender must be updated to Female');
  assert.strictEqual(g5.pincode, '143001', 'Pincode must be updated to 143001');

  // Verify no duplicate guest created on dashboard
  const dashRes = await fetch(`http://127.0.0.1:5000/api/admin/guests?q=${phone4}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const dashData = await dashRes.json();
  const matches = dashData.guests.filter(g => g.phone === phone4);
  assert.strictEqual(matches.length, 1, 'Exactly 1 guest record must exist');
  assert.strictEqual(matches[0].total_bookings, 2, 'Must track total_bookings = 2');
  console.log(` ✅ TEST 5 Passed: Existing guest safely reused & updated; total_bookings=2, 0 duplicates`);

  // ── TEST 6: Existing guest checks in without Gender/Pincode ─────────────────
  console.log('\n--- TEST 6: Existing guest checks in without Gender/Pincode ---');
  await resetRoom4();

  // Re-check-in Priya Sharma (phone1) without sending gender or pincode
  const res6 = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      guestName: 'PRIYA SHARMA',
      age: 28,
      phone: phone1,
      state: 'Himachal Pradesh',
      purposeOfVisit: 'Tourist',
      pax: 1,
      billingInstruction: 'Direct to Guest',
      roomRent: 2000
    })
  });
  assert.strictEqual(res6.status, 200);
  const guest6Doc = await db.collection('guests').doc(`guest_${phone1}`).get();
  const g6 = guest6Doc.data();
  // Existing profile values should be preserved
  assert.strictEqual(g6.gender, 'Female', 'Existing gender Female must remain preserved');
  assert.strictEqual(g6.pincode, '171001', 'Existing pincode 171001 must remain preserved');
  console.log(` ✅ TEST 6 Passed: Existing guest values preserved when re-checking in without them`);

  // Clean up Room 4
  await resetRoom4();

  console.log('\n========================================================================');
  console.log('✅ ALL GENDER & PINCODE TESTS PASSED (6/6)');
  console.log('========================================================================');
}

runGenderAndPincodeTests();
