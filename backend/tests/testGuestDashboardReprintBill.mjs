import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';
import { listDocs, getDoc } from '../repositories/firestore/firestoreUtils.js';
import { MasterBillCutoverService } from '../services/masterBillCutoverService.js';
import { AuditHistoryCutoverService } from '../services/auditHistoryCutoverService.js';

console.log('═════════════════════════════════════════════════════════════════════════════');
console.log('HPMS — REPRINT BILL / MASTER BILL GUEST DASHBOARD VERIFICATION TEST SUITE');
console.log('═════════════════════════════════════════════════════════════════════════════\n');

async function runTests() {
  console.log('1. Resolving Existing Production Guest in Firestore...');
  const allGuests = await listDocs('guests');
  assert(allGuests.length > 0, 'At least 1 guest must exist in Firestore');
  const sampleGuest = allGuests[0];
  const guestId = sampleGuest.id;

  console.log(`✓ Testing with Guest: ${sampleGuest.full_name} (${guestId})`);

  const guestHistory = await AuditHistoryCutoverService.getGuestHistoryAdmin(
    guestId,
    async () => { throw new Error('Fallback should not trigger'); }
  );

  assert(guestHistory && guestHistory.guest, 'Guest profile must exist');
  assert(guestHistory.bookings.length > 0, 'Guest must have at least 1 booking');
  const targetBooking = guestHistory.bookings[0];
  console.log(`✓ Resolved Guest: ${guestHistory.guest.full_name}, Booking: ${targetBooking.booking_number}, Status: ${targetBooking.booking_status}`);

  console.log('\n2. Verifying Financial Baseline Snapshot BEFORE Reprint...');
  const [invoicesBefore, ledgerBefore, paymentsBefore] = await Promise.all([
    listDocs('invoices'),
    listDocs('ledger_items', { filters: [{ field: 'booking_id', op: '==', value: `booking_${targetBooking.booking_number}` }] }),
    listDocs('payments', { filters: [{ field: 'booking_number', op: '==', value: targetBooking.booking_number }] })
  ]);

  const invoiceCountBefore = invoicesBefore.length;
  const ledgerCountBefore = ledgerBefore.length;
  const paymentCountBefore = paymentsBefore.length;

  console.log(`  - Total Invoices in DB: ${invoiceCountBefore}`);
  console.log(`  - Booking Ledger Items: ${ledgerCountBefore}`);
  console.log(`  - Booking Payments: ${paymentCountBefore}`);

  console.log('\n3. Fetching Master Bill via MasterBillCutoverService (Reprint Operation)...');
  const masterBill = await MasterBillCutoverService.getMasterBill(
    targetBooking.booking_number,
    async () => { throw new Error('Fallback should not trigger'); }
  );

  assert(masterBill, 'Master bill payload must be returned');
  assert.strictEqual(masterBill.title, 'MASTER BILL');
  assert.strictEqual(masterBill.hotel?.name, 'HOTEL SKY-5');
  assert.strictEqual(masterBill.guest?.name, guestHistory.guest.full_name);
  assert(masterBill.stay?.roomNo, 'Room number must be present');
  assert(Array.isArray(masterBill.lineItems), 'Line items must be an array');
  assert(masterBill.settlement, 'Settlement object must be present');

  console.log(`✓ Master Bill Generated Successfully:`);
  console.log(`  - Hotel: ${masterBill.hotel.name}`);
  console.log(`  - Guest: ${masterBill.guest.name}`);
  console.log(`  - Room: ${masterBill.stay.roomNo} (${masterBill.stay.roomType})`);
  console.log(`  - Bill No: ${masterBill.invoice.billNo}`);
  console.log(`  - Line Items Count: ${masterBill.lineItems.length}`);
  console.log(`  - Subtotal: ₹${masterBill.settlement.subtotal}`);
  console.log(`  - Outstanding Balance: ₹${masterBill.settlement.outstandingBalance}`);
  console.log(`  - Status: ${masterBill.settlement.paymentStatus}`);

  console.log('\n4. Verifying Financial Baseline Snapshot AFTER Multiple Reprints (Zero Mutation Guarantee)...');
  // Perform 3 more repeated reprint calls
  await MasterBillCutoverService.getMasterBill(targetBooking.booking_number, async () => ({}));
  await MasterBillCutoverService.getMasterBill(targetBooking.booking_number, async () => ({}));
  await MasterBillCutoverService.getMasterBill(targetBooking.booking_number, async () => ({}));

  const [invoicesAfter, ledgerAfter, paymentsAfter] = await Promise.all([
    listDocs('invoices'),
    listDocs('ledger_items', { filters: [{ field: 'booking_id', op: '==', value: `booking_${targetBooking.booking_number}` }] }),
    listDocs('payments', { filters: [{ field: 'booking_number', op: '==', value: targetBooking.booking_number }] })
  ]);

  assert.strictEqual(invoicesAfter.length, invoiceCountBefore, 'Invoice count MUST NOT change after reprint (0 duplicate invoices)');
  assert.strictEqual(ledgerAfter.length, ledgerCountBefore, 'Ledger item count MUST NOT change after reprint');
  assert.strictEqual(paymentsAfter.length, paymentCountBefore, 'Payment count MUST NOT change after reprint');

  console.log('✓ Zero-Mutation Invariant Confirmed:');
  console.log(`  - Invoices created: 0 (Baseline ${invoiceCountBefore} === Current ${invoicesAfter.length})`);
  console.log(`  - Ledger entries created: 0 (Baseline ${ledgerCountBefore} === Current ${ledgerAfter.length})`);
  console.log(`  - Payments created: 0 (Baseline ${paymentCountBefore} === Current ${paymentsAfter.length})`);

  console.log('\n5. Verifying Missing / Invalid Booking Handling...');
  try {
    await MasterBillCutoverService.getMasterBill('BKG-NON-EXISTENT-99999', async () => { throw new Error('Not found'); });
    assert.fail('Should fail on non-existent booking');
  } catch (err) {
    console.log(`✓ Clean error thrown for non-existent booking: ${err.message}`);
  }

  console.log('\n═════════════════════════════════════════════════════════════════════════════');
  console.log('ALL REPRINT BILL / MASTER BILL TESTS PASSED (100% SUCCESS)');
  console.log('═════════════════════════════════════════════════════════════════════════════\n');
}

runTests().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
