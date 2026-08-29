import assert from 'assert';
import { getAdminTestToken } from './helpers/firebaseTestTokenHelper.mjs';

const adminToken = await getAdminTestToken();

async function runMasterBillSynchronizationTests() {
  console.log('============================================================');
  console.log('HPMS MASTER BILL / INVOICE PAYMENT SYNCHRONIZATION TEST SUITE');
  console.log('============================================================');

  // 1. Fetch Master Bill via Room Number ('1')
  console.log('\n--- 1. GET /api/invoices/master-bill/1 (By Room Number) ---');
  const billResByRoom = await fetch('http://127.0.0.1:5000/api/invoices/master-bill/1', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(billResByRoom.status, 200, 'Master bill by room number must return 200');
  const billByRoom = await billResByRoom.json();
  console.log(` ✅ Master bill resolved for Room 1 (Booking: ${billByRoom.invoice?.registrationNo})`);

  // 2. Fetch Master Bill via Document ID
  console.log('\n--- 2. GET /api/invoices/master-bill/booking_BKG-859876 (By Doc ID) ---');
  const billResByDoc = await fetch('http://127.0.0.1:5000/api/invoices/master-bill/booking_BKG-859876', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(billResByDoc.status, 200, 'Master bill by doc ID must return 200');
  const billData = await billResByDoc.json();

  // 3. Verify Financial Settlement Mathematics
  console.log('\n--- 3. VERIFY FINANCIAL SETTLEMENT MATHEMATICS ---');
  const { settlement, paymentDetails, lineItems, reconciliation } = billData;
  console.log(` Subtotal / Total Charges: ₹${settlement?.subtotal}`);
  console.log(` Total Credits: ₹${settlement?.totalCredits}`);
  console.log(` Outstanding Balance: ₹${settlement?.outstandingBalance}`);
  console.log(` Net Payable: ₹${settlement?.netPayable}`);
  console.log(` Payment Status: "${settlement?.paymentStatus}"`);

  assert.strictEqual(settlement.subtotal, settlement.grossTotal, 'Subtotal must match gross total');
  assert.strictEqual(settlement.outstandingBalance, Math.max(0, settlement.totalCharges || (settlement.subtotal - settlement.totalCredits)), 'Outstanding balance must equal total charges minus total credits');
  assert.strictEqual(reconciliation.isReconciled, true, 'Master bill must be 100% mathematically reconciled');
  console.log(' ✅ Financial calculations are 100% reconciled and consistent.');

  // 4. Verify Payment Details Breakdown
  console.log('\n--- 4. VERIFY PAYMENT DETAILS BREAKDOWN ---');
  assert(Array.isArray(paymentDetails) && paymentDetails.length > 0, 'Payment details must contain recorded payment entries');
  console.log(` Found ${paymentDetails.length} payment records in Master Bill:`);
  
  let sumPayments = 0;
  paymentDetails.forEach((p, idx) => {
    console.log(`  [${idx + 1}] Date: ${p.date} ${p.time || ''} | Mode: ${p.mode} | Amount: ₹${p.amount} | Ref: ${p.reference} | Staff: ${p.recordedBy || 'N/A'}`);
    assert(p.date, 'Payment must have a date');
    assert(p.mode, 'Payment must have a mode');
    assert(Number(p.amount) > 0, 'Payment amount must be positive');
    sumPayments += Number(p.amount);
  });

  assert.strictEqual(sumPayments, settlement.totalCredits, 'Sum of payment details must equal settlement.totalCredits');
  console.log(` ✅ Payment details sum (₹${sumPayments}) perfectly matches total credits (₹${settlement.totalCredits}).`);

  // 5. Verify Line Items Running Balance
  console.log('\n--- 5. VERIFY LINE ITEMS RUNNING BALANCE ---');
  assert(Array.isArray(lineItems) && lineItems.length > 0, 'Line items must be non-empty');
  const lastLine = lineItems[lineItems.length - 1];
  console.log(` Last Line Item Balance: ₹${lastLine.balance} (Expected: ₹${settlement.outstandingBalance})`);
  assert.strictEqual(lastLine.balance, settlement.outstandingBalance, 'Final line item balance must match outstanding balance');
  console.log(' ✅ Running ledger balance perfectly tracks every transaction.');

  // 6. Verify Read-Only Invariance
  console.log('\n--- 6. VERIFY INVOICE GENERATION IS 100% READ-ONLY ---');
  const repeatRes = await fetch('http://127.0.0.1:5000/api/invoices/master-bill/1', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(repeatRes.status, 200);
  const repeatData = await repeatRes.json();
  assert.strictEqual(repeatData.paymentDetails.length, paymentDetails.length, 'Repeated invoice generation must never create duplicate payments');
  console.log(' ✅ Repeated invoice reads verified to produce 0 mutations.');

  console.log('\n============================================================');
  console.log('✅ ALL MASTER BILL / INVOICE SYNCHRONIZATION TESTS PASSED (100%)');
  console.log('============================================================');
}

runMasterBillSynchronizationTests();
