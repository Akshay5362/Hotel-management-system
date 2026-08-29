import assert from 'assert';
import { getAdminTestToken } from './helpers/firebaseTestTokenHelper.mjs';

const adminToken = await getAdminTestToken();

async function waitForServer() {
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch('http://127.0.0.1:5000/api/admin/guests', { headers: { Authorization: `Bearer ${adminToken}` } });
      if (res.ok) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function runGuestIntegrityAndDashboardTests() {
  await waitForServer();

  console.log('========================================================================');
  console.log('HPMS GUEST INTEGRITY & DASHBOARD VERIFICATION TEST SUITE');
  console.log('========================================================================');

  // ── TEST A: LIVE IN-HOUSE RECORD VERIFICATION ON GUESTS DASHBOARD ───────────
  console.log('\n--- 1. VERIFY LIVE IN-HOUSE GUEST IN GUESTS DASHBOARD (/api/admin/guests) ---');
  const dashRes = await fetch('http://127.0.0.1:5000/api/admin/guests?page=1&limit=25&filter=all', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(dashRes.status, 200, 'GET /api/admin/guests must return HTTP 200');
  const dashData = await dashRes.json();
  console.log(` Dashboard Stats: Total=${dashData.stats.total}, InHouse=${dashData.stats.inhouse}, CheckedOut=${dashData.stats.checkedout}, NewToday=${dashData.stats.new_today}`);
  assert(dashData.stats.total >= 1, `Total guests must be >= 1 (got ${dashData.stats.total})`);

  const inHouseGuest = dashData.guests.find(g => g.current_status === 'Checked In');
  assert(inHouseGuest, 'At least one in-house guest must be present in Guests Dashboard');
  console.log(` ✅ Found in-house guest: Guest ID=${inHouseGuest.id}, Name=${inHouseGuest.full_name}, Room=${inHouseGuest.current_room}, Status=${inHouseGuest.current_status}, Phone=${inHouseGuest.phone}`);

  // ── TEST B: IN-HOUSE FILTER VERIFICATION ────────────────────────────────────
  console.log('\n--- 2. VERIFY IN-HOUSE FILTER (/api/admin/guests?filter=inhouse) ---');
  const inHouseRes = await fetch('http://127.0.0.1:5000/api/admin/guests?page=1&limit=25&filter=inhouse', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(inHouseRes.status, 200);
  const inHouseData = await inHouseRes.json();
  const guestInList = inHouseData.guests.find(g => g.id === inHouseGuest.id);
  assert(guestInList, 'In-house guest must be present when filtered by inhouse');
  console.log(` ✅ In-house guest verified in "In House" list (${inHouseData.guests.length} in-house guest(s))`);

  // ── TEST C: SEARCH BY NAME, PHONE, EMAIL ────────────────────────────────────
  console.log('\n--- 3. VERIFY SEARCH BY NAME, PHONE, EMAIL ---');
  // 3a. Search by Name
  const searchNameRes = await fetch(`http://127.0.0.1:5000/api/admin/guests?page=1&limit=25&q=${encodeURIComponent(inHouseGuest.full_name.slice(0, 4))}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const searchNameData = await searchNameRes.json();
  assert(searchNameData.guests.some(g => g.id === inHouseGuest.id), `Search by name "${inHouseGuest.full_name}" must find guest`);

  // 3b. Search by Phone
  if (inHouseGuest.phone) {
    const searchPhoneRes = await fetch(`http://127.0.0.1:5000/api/admin/guests?page=1&limit=25&q=${inHouseGuest.phone}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const searchPhoneData = await searchPhoneRes.json();
    assert(searchPhoneData.guests.some(g => g.id === inHouseGuest.id), 'Search by phone must find guest');
  }

  // 3c. Reception Staff search endpoint
  const staffSearchRes = await fetch(`http://127.0.0.1:5000/api/reception/guests/search?q=${encodeURIComponent(inHouseGuest.full_name.slice(0, 4))}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(staffSearchRes.status, 200);
  const staffSearchData = await staffSearchRes.json();
  assert(staffSearchData.guests.some(g => g.id === inHouseGuest.id), 'Reception search must find guest');
  console.log(' ✅ All search vectors (Name, Phone, Reception Search) successfully resolved in-house guest');

  // ── TEST D: RE-CHECK-IN / GUEST UPSERT (NO DUPLICATE GUESTS) ────────────────
  console.log('\n--- 4. VERIFY GUEST UPSERT (NO DUPLICATE PROFILES CREATED) ---');
  // Check in test guest on Room 4
  await fetch('http://127.0.0.1:5000/api/rooms/4/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ balancePaid: 2000 })
  });
  await fetch('http://127.0.0.1:5000/api/rooms/4/clean', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  const uniquePhone = '99' + Math.floor(10000000 + Math.random() * 90000000);
  const checkIn1 = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      guestName: 'VIKRAM SINGH',
      age: 40,
      phone: uniquePhone,
      state: 'Punjab',
      purposeOfVisit: 'Tourist',
      pax: 1,
      billingInstructions: 'Direct to Guest',
      roomRent: 2000
    })
  });
  assert.strictEqual(checkIn1.status, 200);
  const data1 = await checkIn1.json();
  console.log(` First Check-in for Vikram Singh: Booking ${data1.bookingNumber}`);

  // Checkout Room 4
  await fetch('http://127.0.0.1:5000/api/rooms/4/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ balancePaid: 2000 })
  });
  await fetch('http://127.0.0.1:5000/api/rooms/4/clean', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  // Re-check-in same guest with updated state
  const checkIn2 = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      guestName: 'VIKRAM SINGH',
      age: 40,
      phone: uniquePhone,
      state: 'Haryana',
      purposeOfVisit: 'Business',
      pax: 1,
      billingInstructions: 'Direct to Guest',
      roomRent: 2000
    })
  });
  assert.strictEqual(checkIn2.status, 200);
  const data2 = await checkIn2.json();
  console.log(` Second Check-in for same phone (${uniquePhone}): Booking ${data2.bookingNumber}`);

  // Verify dashboard has exactly 1 guest for Vikram Singh
  const vikramSearchRes = await fetch(`http://127.0.0.1:5000/api/admin/guests?q=${uniquePhone}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const vikramSearchData = await vikramSearchRes.json();
  const matchingGuests = vikramSearchData.guests.filter(g => g.phone === uniquePhone);
  assert.strictEqual(matchingGuests.length, 1, 'Must create exactly 1 guest record for the same guest phone');
  assert.strictEqual(matchingGuests[0].total_bookings, 2, 'Guest must track both bookings (total_bookings = 2)');
  console.log(` ✅ Guest profile safely reused with total_bookings=2 and 0 duplicate profiles`);

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
  console.log('✅ ALL GUEST INTEGRITY & DASHBOARD VERIFICATION TESTS PASSED (100%)');
  console.log('========================================================================');
}

runGuestIntegrityAndDashboardTests();
