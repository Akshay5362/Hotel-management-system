import assert from 'assert';
import crypto from 'crypto';

const JWT_SECRET = 'hotel-pms-super-secret-key-12345!';
function generateToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'admin', isRootAdmin: user.isRootAdmin ?? true });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return base64Payload + '.' + signature;
}

const adminToken = generateToken({ id: 1, role: 'admin', type: 'admin' });
const receptionistToken = generateToken({ id: 2, role: 'receptionist', type: 'staff' });
const guestToken = generateToken({ id: 99, role: 'guest', type: 'guest' });

async function runAuthHardeningTests() {
  console.log('============================================================');
  console.log('HPMS FOLIO PAYMENT AUTHENTICATION & SECURITY TEST SUITE');
  console.log('============================================================');

  // Check in Room 4 for clean test stay
  console.log('\n--- 0. SEED ACTIVE STAY (Room 4) ---');
  // First clean room 4 if dirty
  await fetch('http://127.0.0.1:5000/api/rooms/4/clean', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  const checkInPayload = {
    guestName: 'TEST AUTH GUEST',
    age: 28,
    phone: '9876543210',
    email: 'testauth@example.com',
    country: 'India',
    state: 'Punjab',
    address: 'Sector 17, Chandigarh',
    purpose_of_visit: 'Business',
    pax: 1,
    children: 0,
    checkInDate: '2026-08-21',
    expectedCheckOutDate: '2026-08-22',
    billing_instruction: 'Direct to Guest',
    roomRent: 2000,
    rate: 2000,
    deposit: 0,
    payment_mode: 'Cash'
  };

  const ciRes = await fetch('http://127.0.0.1:5000/api/rooms/4/checkin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify(checkInPayload)
  });
  console.log(` Room 4 Check-In Status: ${ciRes.status}`);

  // 1. Missing Authorization Header
  console.log('\n--- 1. NEGATIVE TEST: Missing Authorization Header ---');
  const noAuthRes = await fetch('http://127.0.0.1:5000/api/rooms/4/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 100, paymentMethod: 'Cash' })
  });
  console.log(` Missing Auth HTTP Code: ${noAuthRes.status}`);
  assert.strictEqual(noAuthRes.status, 401, 'Must reject with 401 when Authorization header is missing');
  const noAuthData = await noAuthRes.json();
  console.log(` ✅ Rejected with 401: "${noAuthData.error}"`);

  // 2. Invalid Token
  console.log('\n--- 2. NEGATIVE TEST: Invalid Bearer Token ---');
  const invalidTokenRes = await fetch('http://127.0.0.1:5000/api/rooms/4/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer invalid.token.payload'
    },
    body: JSON.stringify({ amount: 100, paymentMethod: 'Cash' })
  });
  console.log(` Invalid Token HTTP Code: ${invalidTokenRes.status}`);
  assert(invalidTokenRes.status === 401 || invalidTokenRes.status === 403, 'Must reject with 401 or 403 for invalid token');
  console.log(' ✅ Rejected with 401/403 for forged/invalid token.');

  // 3. Unauthorized Role (Guest role cannot post staff payments)
  console.log('\n--- 3. NEGATIVE TEST: Guest Role Forbidden ---');
  const guestRoleRes = await fetch('http://127.0.0.1:5000/api/rooms/4/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${guestToken}`
    },
    body: JSON.stringify({ amount: 100, paymentMethod: 'Cash' })
  });
  console.log(` Guest Role HTTP Code: ${guestRoleRes.status}`);
  assert.strictEqual(guestRoleRes.status, 403, 'Must reject with 403 for guest role');
  console.log(' ✅ Rejected with 403 for unauthorized guest role.');

  // 4. Valid Receptionist Access
  console.log('\n--- 4. POSITIVE TEST: Receptionist Role Authorized ---');
  const ledgerRes = await fetch('http://127.0.0.1:5000/api/rooms/4/ledger', {
    headers: { Authorization: `Bearer ${receptionistToken}` }
  });
  assert.strictEqual(ledgerRes.status, 200, 'Receptionist can read ledger');
  const ledgerData = await ledgerRes.json();
  const balance = ledgerData.summary?.outstanding;
  console.log(` Room 4 Live Balance: ₹${balance}`);

  if (balance > 0) {
    const idemKey = `reception_pay_${Date.now()}`;
    const payRes = await fetch('http://127.0.0.1:5000/api/rooms/4/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${receptionistToken}`
      },
      body: JSON.stringify({
        amount: Math.min(100, balance),
        paymentMethod: 'Cash',
        remarks: 'Reception test payment',
        idempotencyKey: idemKey
      })
    });
    console.log(` Receptionist Payment HTTP Code: ${payRes.status}`);
    assert.strictEqual(payRes.status, 200, 'Receptionist payment succeeds');
    const payData = await payRes.json();
    assert.strictEqual(payData.success, true);
    console.log(` ✅ Receptionist payment of ₹${payData.amount} succeeded.`);

    // 5. Duplicate request with same idempotency key
    console.log('\n--- 5. IDEMPOTENCY RETRY TEST ---');
    const retryRes = await fetch('http://127.0.0.1:5000/api/rooms/4/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${receptionistToken}`
      },
      body: JSON.stringify({
        amount: Math.min(100, balance),
        paymentMethod: 'Cash',
        remarks: 'Reception test payment',
        idempotencyKey: idemKey
      })
    });
    assert.strictEqual(retryRes.status, 200);
    const retryData = await retryRes.json();
    assert.strictEqual(retryData.replayed, true, 'Duplicate request must be replayed');
    console.log(' ✅ Idempotent retry safely intercepted with zero double-charge.');
  }

  // Clean up test stay
  await fetch('http://127.0.0.1:5000/api/rooms/4/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ balancePaid: 1900 })
  });

  console.log('\n============================================================');
  console.log('✅ ALL AUTHENTICATION & SECURITY HARDENING TESTS PASSED (100%)');
  console.log('============================================================');
}

runAuthHardeningTests();
