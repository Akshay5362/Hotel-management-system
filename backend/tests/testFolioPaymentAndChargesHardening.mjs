import assert from 'assert';
import { getAdminTestToken } from './helpers/firebaseTestTokenHelper.mjs';

const adminToken = await getAdminTestToken();

async function runFolioHardeningTests() {
  console.log('============================================================');
  console.log('HPMS FOLIO / CHECKOUT PAYMENT & POST CHARGES TEST SUITE');
  console.log('============================================================');

  // Clean room 4 and check in
  console.log('\n--- 0. SEED TEST STAY ON ROOM 4 ---');
  await fetch('http://127.0.0.1:5000/api/rooms/4/clean', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  const checkInPayload = {
    guestName: 'KEVAL PATEL',
    age: 30,
    phone: '9876543210',
    email: 'keval@example.com',
    country: 'India',
    state: 'Gujarat',
    address: 'Ahmedabad, Gujarat',
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
  assert.strictEqual(ciRes.status, 200, 'Check-in must succeed');

  // 1. Fetch Room 4 Live Ledger
  console.log('\n--- 1. GET /api/rooms/4/ledger (Live Active Stay) ---');
  const ledgerRes = await fetch('http://127.0.0.1:5000/api/rooms/4/ledger', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(ledgerRes.status, 200, 'Ledger endpoint must return 200');
  const ledgerData = await ledgerRes.json();
  console.log(` Room 4 Active Booking: ${ledgerData.booking?.id || ledgerData.booking?.doc_id}`);
  console.log(` Total Charges: ₹${ledgerData.summary?.totalCharges}`);
  console.log(` Total Payments: ₹${ledgerData.summary?.totalPayments}`);
  console.log(` Outstanding Balance: ₹${ledgerData.summary?.outstanding}`);

  const initialOutstanding = ledgerData.summary?.outstanding;
  assert(initialOutstanding > 0, 'Room 4 should have an outstanding balance for testing');

  // 2. Charge Validation Tests (Reject <= 0, NaN, missing desc)
  console.log('\n--- 2. CHARGE VALIDATION TESTS (HTTP 400) ---');
  const invalidChargeCases = [
    { name: 'Zero Charge', desc: 'Laundry', amount: 0 },
    { name: 'Negative Charge', desc: 'Laundry', amount: -500 },
    { name: 'Empty Description', desc: '', amount: 300 }
  ];

  for (const tc of invalidChargeCases) {
    const res = await fetch('http://127.0.0.1:5000/api/rooms/4/ledger', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify(tc)
    });
    assert.strictEqual(res.status, 400, `Case [${tc.name}] must return 400`);
    console.log(` ✅ Passed [${tc.name}] -> Rejected with HTTP 400`);
  }

  // 3. Post Predefined Charge (Laundry ₹300)
  console.log('\n--- 3. POST PREDEFINED CHARGE (Laundry ₹300) ---');
  const postChargeRes = await fetch('http://127.0.0.1:5000/api/rooms/4/ledger', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      desc: 'Laundry Service',
      amount: 300,
      category: 'Laundry'
    })
  });
  assert.strictEqual(postChargeRes.status, 200, 'Posting valid charge must return 200');
  console.log(' ✅ Successfully posted Laundry charge of ₹300.');

  // Verify updated balance
  const ledgerAfterCharge = await (await fetch('http://127.0.0.1:5000/api/rooms/4/ledger', {
    headers: { Authorization: `Bearer ${adminToken}` }
  })).json();
  console.log(` New Outstanding after charge: ₹${ledgerAfterCharge.summary?.outstanding} (Expected: ₹${initialOutstanding + 300})`);
  assert.strictEqual(ledgerAfterCharge.summary?.outstanding, initialOutstanding + 300);

  // 4. Payment Validation Tests (Reject <= 0, > Balance, NaN)
  console.log('\n--- 4. PAYMENT VALIDATION & OVERPAYMENT REJECTION ---');
  const currentBal = ledgerAfterCharge.summary?.outstanding;

  // Case A: Overpayment attempt
  const overpayRes = await fetch('http://127.0.0.1:5000/api/rooms/4/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      amount: currentBal + 500,
      paymentMethod: 'UPI',
      remarks: 'Overpayment test'
    })
  });
  assert.strictEqual(overpayRes.status, 400, 'Overpayment must return 400');
  const overpayData = await overpayRes.json();
  assert.strictEqual(overpayData.code, 'PAYMENT_EXCEEDS_BALANCE', 'Code must be PAYMENT_EXCEEDS_BALANCE');
  console.log(` ✅ Overpayment rejected with 400: "${overpayData.error}"`);

  // Case B: Zero payment attempt
  const zeroPayRes = await fetch('http://127.0.0.1:5000/api/rooms/4/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ amount: 0, paymentMethod: 'Cash' })
  });
  assert.strictEqual(zeroPayRes.status, 400, 'Zero payment must return 400');
  console.log(' ✅ Zero payment rejected with 400.');

  // 5. Record Partial Payment (₹300)
  console.log('\n--- 5. RECORD PARTIAL PAYMENT (₹300 UPI) ---');
  const idemKey = `test_pay_${Date.now()}`;
  const payRes = await fetch('http://127.0.0.1:5000/api/rooms/4/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      amount: 300,
      paymentMethod: 'UPI',
      remarks: 'Partial Payment Demo',
      idempotencyKey: idemKey
    })
  });
  assert.strictEqual(payRes.status, 200, 'Valid payment must return 200');
  const payData = await payRes.json();
  assert.strictEqual(payData.success, true);
  assert.strictEqual(payData.amount, 300);
  console.log(` ✅ Partial payment recorded: ₹${payData.amount} (New Outstanding: ₹${payData.newOutstanding})`);

  // 6. Idempotency Test: Replay duplicate payment with same idempotencyKey
  console.log('\n--- 6. IDEMPOTENCY PROTECTION TEST ---');
  const replayRes = await fetch('http://127.0.0.1:5000/api/rooms/4/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      amount: 300,
      paymentMethod: 'UPI',
      remarks: 'Partial Payment Demo',
      idempotencyKey: idemKey
    })
  });
  assert.strictEqual(replayRes.status, 200);
  const replayData = await replayRes.json();
  assert.strictEqual(replayData.replayed, true, 'Duplicate request must return replayed: true');
  console.log(' ✅ Duplicate payment request intercepted and replayed without second mutation.');

  // 7. Verify Final Ledger State & Master Bill Synchronization
  console.log('\n--- 7. VERIFY FOLIO & MASTER BILL SYNCHRONIZATION ---');
  const finalLedger = await (await fetch('http://127.0.0.1:5000/api/rooms/4/ledger', {
    headers: { Authorization: `Bearer ${adminToken}` }
  })).json();

  const finalPayments = finalLedger.ledger.filter(item => item.transaction_type === 'PAYMENT');
  console.log(` Total Payments in Ledger: ${finalPayments.length}`);
  console.log(` Final Outstanding Balance: ₹${finalLedger.summary?.outstanding}`);
  assert.strictEqual(finalLedger.summary?.outstanding, initialOutstanding);

  // Check Master Bill for Room 4 reflects the ₹300 payment
  const billRes = await fetch('http://127.0.0.1:5000/api/invoices/master-bill/4', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(billRes.status, 200);
  const billData = await billRes.json();
  console.log(` Master Bill Outstanding: ₹${billData.settlement?.outstandingBalance}`);
  console.log(` Master Bill Total Credits: ₹${billData.settlement?.totalCredits}`);
  assert.strictEqual(billData.settlement?.outstandingBalance, finalLedger.summary?.outstanding);
  assert.strictEqual(billData.settlement?.totalCredits, 300);

  // Clean up Room 4 stay
  await fetch('http://127.0.0.1:5000/api/rooms/4/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ balancePaid: 2000 })
  });

  console.log('\n============================================================');
  console.log('✅ ALL FOLIO PAYMENT & POST CHARGES TESTS PASSED (100%)');
  console.log('============================================================');
}

runFolioHardeningTests();
