import assert from 'assert';
import crypto from 'crypto';
import { db } from '../config/firebaseAdmin.js';
import { getDoc } from '../repositories/firestore/firestoreUtils.js';

const JWT_SECRET = 'hotel-pms-super-secret-key-12345!';
function generateLegacyToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'staff' });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return base64Payload + '.' + signature;
}

async function runCheckoutConsistencyTests() {
  console.log('============================================================');
  console.log('HPMS CHECK-OUT CONSISTENCY & FALLBACK RESOLUTION TESTS');
  console.log('============================================================');

  // 1. Check Room Documents
  const r1 = await getDoc('rooms', 'room_1');
  const r2 = await getDoc('rooms', 'room_2');
  const r3 = await getDoc('rooms', 'room_3');

  console.log('\n--- 1. ROOM DOCUMENT INTEGRITY ---');
  console.log(` Room 1: status=${r1.status}, current_booking_id=${r1.current_booking_id}`);
  console.log(` Room 2: status=${r2.status}, current_booking_id=${r2.current_booking_id}`);
  console.log(` Room 3: status=${r3.status}, current_booking_id=${r3.current_booking_id}`);

  assert.strictEqual(r1.status, 'occupied', 'Room 1 must be occupied');
  assert.strictEqual(r1.current_booking_id, 'bkg_BKG-794888', 'Room 1 current_booking_id matches active stay');

  assert.strictEqual(r2.status, 'occupied', 'Room 2 must be occupied');
  assert.strictEqual(r2.current_booking_id, 'bkg_BKG-381166', 'Room 2 current_booking_id matches active stay');

  assert.strictEqual(r3.status, 'occupied', 'Room 3 must be occupied');
  assert.strictEqual(r3.current_booking_id, 'bkg_BKG-295734', 'Room 3 current_booking_id matches active stay');
  console.log(' ✅ Room documents verified as occupied with correct active booking pointers.');

  // 2. Active Stay Resolution Verification (Non-mutating resolution check)
  console.log('\n--- 2. ACTIVE STAY RESOLUTION LOGIC VERIFICATION ---');
  for (const num of [1, 2, 3]) {
    const activeQuery = await db.collection('bookings')
      .where('booking_status', '==', 'Checked In')
      .where('room_number', '==', String(num))
      .get();

    console.log(` Room ${num} active Checked In bookings found: ${activeQuery.size}`);
    assert.strictEqual(activeQuery.size, 1, `Exactly 1 active booking for room ${num}`);
    const bData = activeQuery.docs[0].data();
    console.log(`  -> Booking: ${activeQuery.docs[0].id}, Guest: ${bData.guest_name}`);
  }
  console.log(' ✅ Active stays verified for Rooms 1, 2, and 3.');

  // 3. GET /api/status Dashboard Parity
  console.log('\n--- 3. LIVE GET /api/status DASHBOARD PARITY ---');
  const token = generateLegacyToken({ id: 1, role: 'admin', type: 'staff' });
  const statusRes = await fetch('http://127.0.0.1:5000/api/status', {
    headers: { Authorization: 'Bearer ' + token }
  });

  assert.strictEqual(statusRes.status, 200, 'GET /api/status must return 200');
  const statusData = await statusRes.json();
  const rooms = statusData.rooms || [];

  console.log(` Total Rooms: ${rooms.length}`);
  console.log(` Occupied: ${statusData.occupied || rooms.filter(r => r.status === 'occupied').length}`);
  console.log(` Vacant: ${statusData.vacant || rooms.filter(r => r.status === 'vacant').length}`);

  assert.strictEqual(rooms.length, 17, 'Exactly 17 canonical rooms');

  const occ1 = rooms.find(r => String(r.number) === '1');
  const occ2 = rooms.find(r => String(r.number) === '2');
  const occ3 = rooms.find(r => String(r.number) === '3');

  assert.strictEqual(occ1.status, 'occupied', 'Room 1 must be occupied in dashboard');
  assert.strictEqual(occ2.status, 'occupied', 'Room 2 must be occupied in dashboard');
  assert.strictEqual(occ3.status, 'occupied', 'Room 3 must be occupied in dashboard');

  console.log(` Room 1 Guest: ${occ1.guestName} (Expected: KEVAL)`);
  console.log(` Room 2 Guest: ${occ2.guestName} (Expected: ANKITA)`);
  console.log(` Room 3 Guest: ${occ3.guestName} (Expected: AKSHIT)`);

  // 4. Vacant Room Check-Out Validation (Must return 400 ROOM_NOT_OCCUPIED)
  console.log('\n--- 4. VACANT ROOM CHECK-OUT VALIDATION (Room 4) ---');
  const coVacantRes = await fetch('http://127.0.0.1:5000/api/rooms/4/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify({ balancePaid: 0 })
  });

  console.log(` Room 4 Check-Out Response HTTP Code: ${coVacantRes.status}`);
  const coVacantData = await coVacantRes.json();
  console.log(` Room 4 Check-Out Error Code: ${coVacantData.code}`);
  console.log(` Room 4 Check-Out Error Message: ${coVacantData.error}`);

  assert.strictEqual(coVacantRes.status, 400, 'Vacant room checkout must return 400');
  assert.strictEqual(coVacantData.code, 'ROOM_NOT_OCCUPIED', 'Error code must be ROOM_NOT_OCCUPIED');
  console.log(' ✅ Vacant room correctly rejected with ROOM_NOT_OCCUPIED.');

  // 5. Non-Existent Room Check-Out Validation
  console.log('\n--- 5. NON-EXISTENT ROOM CHECK-OUT VALIDATION (Room 99) ---');
  const coNonExistRes = await fetch('http://127.0.0.1:5000/api/rooms/99/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify({ balancePaid: 0 })
  });

  console.log(` Room 99 Check-Out Response HTTP Code: ${coNonExistRes.status}`);
  assert.strictEqual(coNonExistRes.status, 404, 'Non-existent room checkout must return 404');
  console.log(' ✅ Non-existent room correctly rejected with 404.');

  // 6. Health Check
  const healthRes = await fetch('http://127.0.0.1:5000/api/health');
  assert.strictEqual(healthRes.status, 200, 'GET /api/health must return 200');

  console.log('\n============================================================');
  console.log('✅ ALL CHECK-OUT CONSISTENCY & FALLBACK TESTS PASSED (100%)');
  console.log('============================================================');
}

runCheckoutConsistencyTests();
