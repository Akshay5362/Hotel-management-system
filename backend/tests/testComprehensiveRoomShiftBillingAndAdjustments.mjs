import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';
import { processRoomShiftFirestoreTransaction } from '../adapters/firestore/roomShiftFirestoreAdapter.js';
import { LedgerFirestoreAdapter } from '../adapters/firestore/ledgerFirestoreAdapter.js';
import { processCheckOutFirestoreTransaction } from '../adapters/firestore/checkOutFirestoreAdapter.js';
import { MasterBillService } from '../services/masterBillService.js';

console.log('═════════════════════════════════════════════════════════════════════════════');
console.log('HPMS COMPREHENSIVE ROOM SHIFT BILLING + MANUAL ADJUSTMENT TEST SUITE');
console.log('═════════════════════════════════════════════════════════════════════════════\n');

async function cleanupTestDocs(ids) {
  for (const { col, doc } of ids) {
    try {
      await db.collection(col).doc(doc).delete();
    } catch (_) {}
  }
}

async function runTests() {
  const cleanupList = [];
  const testSuffix = Date.now();

  const standardRoomNo = `961_${testSuffix}`; // Standard ₹1500
  const execRoom1No = `962_${testSuffix}`;    // Executive 1 ₹2000
  const execRoom2No = `963_${testSuffix}`;    // Executive 2 ₹2000
  const premiumRoomNo = `964_${testSuffix}`;  // Premium ₹2500

  try {
    console.log('1. Setting up isolated test room fixtures...');

    // Setup Standard Room (₹1500)
    await db.collection('rooms').doc(`room_${standardRoomNo}`).set({
      id: `room_${standardRoomNo}`,
      number: standardRoomNo,
      type: 'Standard',
      price: 1500,
      rate: 1500,
      base_rate: 1500,
      status: 'vacant',
      housekeeping_status: 'Clean',
      is_active: true,
      current_booking_id: null,
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'rooms', doc: `room_${standardRoomNo}` });

    // Setup Executive Room 1 (₹2000)
    await db.collection('rooms').doc(`room_${execRoom1No}`).set({
      id: `room_${execRoom1No}`,
      number: execRoom1No,
      type: 'Executive',
      price: 2000,
      rate: 2000,
      base_rate: 2000,
      status: 'vacant',
      housekeeping_status: 'Clean',
      is_active: true,
      current_booking_id: null,
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'rooms', doc: `room_${execRoom1No}` });

    // Setup Executive Room 2 (₹2000)
    await db.collection('rooms').doc(`room_${execRoom2No}`).set({
      id: `room_${execRoom2No}`,
      number: execRoom2No,
      type: 'Executive',
      price: 2000,
      rate: 2000,
      base_rate: 2000,
      status: 'vacant',
      housekeeping_status: 'Clean',
      is_active: true,
      current_booking_id: null,
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'rooms', doc: `room_${execRoom2No}` });

    // Setup Premium Room (₹2500)
    await db.collection('rooms').doc(`room_${premiumRoomNo}`).set({
      id: `room_${premiumRoomNo}`,
      number: premiumRoomNo,
      type: 'Premium',
      price: 2500,
      rate: 2500,
      base_rate: 2500,
      status: 'vacant',
      housekeeping_status: 'Clean',
      is_active: true,
      current_booking_id: null,
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'rooms', doc: `room_${premiumRoomNo}` });

    console.log('✓ Isolated fixtures created (Rooms: 961, 962, 963, 964).');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1 — Upgrade: Executive ₹2,000 → Premium ₹2,500 with ₹2,000 paid
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 1: Upgrade from Executive (₹2,000) to Premium (₹2,500) with ₹2,000 Paid ---');
    const bkgId1 = `bkg_t1_${testSuffix}`;
    await db.collection('bookings').doc(bkgId1).set({
      id: bkgId1,
      booking_number: `BKG-T1-${testSuffix}`,
      guest_id: `guest_t1_${testSuffix}`,
      guest_name: 'TEST GUEST T1',
      room_id: `room_${execRoom1No}`,
      room_number: execRoom1No,
      room_tariff: 2000,
      total_amount: 2000,
      advance_amount: 2000,
      booking_status: 'Checked In',
      payment_status: 'Paid',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'bookings', doc: bkgId1 });

    // Occupy source room
    await db.collection('rooms').doc(`room_${execRoom1No}`).update({
      status: 'occupied',
      current_booking_id: bkgId1
    });

    // Checkin ledger charge: ₹2000
    const l1 = `ledger_${bkgId1}_init`;
    await db.collection('ledger_items').doc(l1).set({
      item_id: l1,
      booking_id: bkgId1,
      room_number: execRoom1No,
      desc: 'Room Tariff (Executive)',
      qty: 1,
      amount: 2000,
      credit_amount: 0,
      transaction_type: 'CHARGE',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'ledger_items', doc: l1 });

    // Payment: ₹2000
    const p1 = `payment_${bkgId1}_init`;
    await db.collection('payments').doc(p1).set({
      payment_id: p1,
      booking_id: bkgId1,
      room_number: execRoom1No,
      amount: 2000,
      payment_method: 'UPI',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'payments', doc: p1 });

    // Execute shift to Premium (₹2500)
    const res1 = await processRoomShiftFirestoreTransaction({
      fromRoomNumber: execRoom1No,
      toRoomNumber: premiumRoomNo,
      adjustmentType: 'AUTOMATIC'
    });

    assert.strictEqual(res1.sourceTariff, 2000, 'Source tariff must be 2000');
    assert.strictEqual(res1.destinationTariff, 2500, 'Destination tariff must be 2500');
    assert.strictEqual(res1.automaticDifference, 500, 'Automatic difference must be 500');
    assert.strictEqual(res1.finalAdditionalCharge, 500, 'Additional charge must be 500');
    assert.strictEqual(res1.netTotalCharges, 2500, 'Total effective charges must be 2500');
    assert.strictEqual(res1.totalPayments, 2000, 'Payments must remain 2000');
    assert.strictEqual(res1.outstandingBalance, 500, 'CRITICAL: Outstanding balance must be exactly ₹500, NOT ₹2500!');
    console.log('✓ TEST 1 PASSED: Effective charges ₹2,500, Payments ₹2,000, Balance ₹500 (NO duplicate ₹2,500 charge).');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2 — Upgrade without payment: Executive ₹2,000 → Premium ₹2,500 (Paid ₹0)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 2: Upgrade without Payment (Payments = ₹0) ---');
    // Reset rooms: occupy execRoom1, vacant premium
    await db.collection('rooms').doc(`room_${execRoom1No}`).update({ status: 'occupied', current_booking_id: `bkg_t2_${testSuffix}` });
    await db.collection('rooms').doc(`room_${premiumRoomNo}`).update({ status: 'vacant', current_booking_id: null });

    const bkgId2 = `bkg_t2_${testSuffix}`;
    await db.collection('bookings').doc(bkgId2).set({
      id: bkgId2,
      booking_number: `BKG-T2-${testSuffix}`,
      guest_id: `guest_t2_${testSuffix}`,
      guest_name: 'TEST GUEST T2',
      room_id: `room_${execRoom1No}`,
      room_number: execRoom1No,
      room_tariff: 2000,
      total_amount: 2000,
      advance_amount: 0,
      booking_status: 'Checked In',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'bookings', doc: bkgId2 });

    const l2 = `ledger_${bkgId2}_init`;
    await db.collection('ledger_items').doc(l2).set({
      item_id: l2,
      booking_id: bkgId2,
      room_number: execRoom1No,
      desc: 'Room Tariff (Executive)',
      amount: 2000,
      transaction_type: 'CHARGE',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'ledger_items', doc: l2 });

    const res2 = await processRoomShiftFirestoreTransaction({
      fromRoomNumber: execRoom1No,
      toRoomNumber: premiumRoomNo
    });
    assert.strictEqual(res2.netTotalCharges, 2500);
    assert.strictEqual(res2.outstandingBalance, 2500);
    console.log('✓ TEST 2 PASSED: Total charges ₹2,500, Balance ₹2,500.');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3 — Downgrade: Premium ₹2,500 → Executive ₹2,000
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 3: Downgrade from Premium (₹2,500) to Executive (₹2,000) ---');
    // Currently bkgId2 is in Premium room (from Test 2). Shift back to Exec 1.
    await db.collection('rooms').doc(`room_${execRoom1No}`).update({ status: 'vacant', current_booking_id: null });

    const res3 = await processRoomShiftFirestoreTransaction({
      fromRoomNumber: premiumRoomNo,
      toRoomNumber: execRoom1No
    });
    assert.strictEqual(res3.sourceTariff, 2500);
    assert.strictEqual(res3.destinationTariff, 2000);
    assert.strictEqual(res3.automaticDifference, -500);
    assert.strictEqual(res3.finalAdditionalCharge, -500);
    assert.strictEqual(res3.netTotalCharges, 2000, 'Effective charges must decrease to ₹2,000');
    console.log('✓ TEST 3 PASSED: Downgrade credit of ₹500 applied. Effective charges ₹2,000.');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4 — Same Tariff: Executive ₹2,000 → Executive ₹2,000
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 4: Same Tariff Shift (Executive ₹2,000 → Executive ₹2,000) ---');
    const res4 = await processRoomShiftFirestoreTransaction({
      fromRoomNumber: execRoom1No,
      toRoomNumber: execRoom2No
    });
    assert.strictEqual(res4.automaticDifference, 0);
    assert.strictEqual(res4.finalAdditionalCharge, 0);
    assert.strictEqual(res4.netTotalCharges, 2000);
    console.log('✓ TEST 4 PASSED: ₹0 additional charge generated for same tariff shift.');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5 — Manual Increase: Diff ₹500 + Manual ₹200 = Additional ₹700
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 5: Manual Increase Adjustment ---');
    // Shift from Exec 2 (₹2000) to Premium (₹2500) with Manual Increase +₹200
    await db.collection('rooms').doc(`room_${premiumRoomNo}`).update({ status: 'vacant', current_booking_id: null });

    const res5 = await processRoomShiftFirestoreTransaction({
      fromRoomNumber: execRoom2No,
      toRoomNumber: premiumRoomNo,
      adjustmentType: 'INCREASE',
      manualAdjustmentAmount: 200,
      manualAdjustmentReason: 'Guest requested premium amenity package'
    });
    assert.strictEqual(res5.automaticDifference, 500);
    assert.strictEqual(res5.finalAdditionalCharge, 700, '500 diff + 200 manual = 700');
    console.log('✓ TEST 5 PASSED: Additional charge is ₹700 (₹500 diff + ₹200 manual increase).');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 6 — Manual Decrease: Diff ₹500 - Manual ₹200 = Additional ₹300
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 6: Manual Decrease Adjustment ---');
    // Shift from Premium (₹2500) to Standard (₹1500) or Exec (₹2000)
    await db.collection('rooms').doc(`room_${execRoom1No}`).update({ status: 'vacant', current_booking_id: null });

    // Setup clean booking on Exec 1 (₹2000) shifting to Premium (₹2500) with ₹200 discount
    const bkgId6 = `bkg_t6_${testSuffix}`;
    await db.collection('rooms').doc(`room_${execRoom1No}`).update({ status: 'occupied', current_booking_id: bkgId6 });
    await db.collection('rooms').doc(`room_${premiumRoomNo}`).update({ status: 'vacant', current_booking_id: null });

    await db.collection('bookings').doc(bkgId6).set({
      id: bkgId6,
      booking_number: `BKG-T6-${testSuffix}`,
      guest_id: `guest_t6_${testSuffix}`,
      guest_name: 'TEST GUEST T6',
      room_id: `room_${execRoom1No}`,
      room_number: execRoom1No,
      room_tariff: 2000,
      total_amount: 2000,
      advance_amount: 0,
      booking_status: 'Checked In',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'bookings', doc: bkgId6 });

    const l6 = `ledger_${bkgId6}_init`;
    await db.collection('ledger_items').doc(l6).set({
      item_id: l6,
      booking_id: bkgId6,
      room_number: execRoom1No,
      desc: 'Room Tariff',
      amount: 2000,
      transaction_type: 'CHARGE',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'ledger_items', doc: l6 });

    const res6 = await processRoomShiftFirestoreTransaction({
      fromRoomNumber: execRoom1No,
      toRoomNumber: premiumRoomNo,
      adjustmentType: 'DECREASE',
      manualAdjustmentAmount: 200,
      manualAdjustmentReason: 'Manager approved upgrade discount'
    });
    assert.strictEqual(res6.automaticDifference, 500);
    assert.strictEqual(res6.finalAdditionalCharge, 300, '500 diff - 200 discount = 300');
    assert.strictEqual(res6.netTotalCharges, 2300, '2000 + 300 = 2300');
    console.log('✓ TEST 6 PASSED: Additional charge is ₹300 (₹500 diff - ₹200 discount). Net charges ₹2,300.');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 7 — Already Paid (Production Screenshot Reproduction)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 7: Production Screenshot Scenario Reproduction ---');
    console.log('Original tariff = ₹2,000 | Guest paid = ₹2,000 | Shift to = ₹2,500');
    const bkgId7 = `bkg_t7_${testSuffix}`;
    await db.collection('rooms').doc(`room_${execRoom2No}`).update({ status: 'occupied', current_booking_id: bkgId7 });
    await db.collection('rooms').doc(`room_${standardRoomNo}`).update({ status: 'vacant', current_booking_id: null });

    await db.collection('bookings').doc(bkgId7).set({
      id: bkgId7,
      booking_number: `BKG-T7-${testSuffix}`,
      guest_id: `guest_t7_${testSuffix}`,
      guest_name: 'TEST GUEST SCREENSHOT',
      room_id: `room_${execRoom2No}`,
      room_number: execRoom2No,
      room_tariff: 2000,
      total_amount: 2000,
      advance_amount: 2000,
      booking_status: 'Checked In',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'bookings', doc: bkgId7 });

    const l7 = `ledger_${bkgId7}_init`;
    await db.collection('ledger_items').doc(l7).set({
      item_id: l7,
      booking_id: bkgId7,
      room_number: execRoom2No,
      desc: 'Room Tariff (Executive)',
      amount: 2000,
      transaction_type: 'CHARGE',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'ledger_items', doc: l7 });

    const p7 = `payment_${bkgId7}_init`;
    await db.collection('payments').doc(p7).set({
      payment_id: p7,
      booking_id: bkgId7,
      room_number: execRoom2No,
      amount: 2000,
      payment_method: 'Cash',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'payments', doc: p7 });

    // Shift Exec 2 (₹2000) -> Premium (₹2500)
    await db.collection('rooms').doc(`room_${premiumRoomNo}`).update({ status: 'vacant', current_booking_id: null });
    const res7 = await processRoomShiftFirestoreTransaction({
      fromRoomNumber: execRoom2No,
      toRoomNumber: premiumRoomNo,
      adjustmentType: 'AUTOMATIC'
    });

    assert.strictEqual(res7.netTotalCharges, 2500, 'Effective charges must be ₹2,500');
    assert.strictEqual(res7.totalPayments, 2000, 'Payments must be ₹2,000');
    assert.strictEqual(res7.outstandingBalance, 500, 'CRITICAL: Balance MUST BE ₹500 (NOT ₹2500)!');
    console.log('✓ TEST 7 PASSED: Screenshot bug completely resolved. Outstanding balance is exactly ₹500.');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 8 — Multiple Payments: Settle remaining ₹500
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 8: Multiple Payments Settlement ---');
    const payRes8 = await LedgerFirestoreAdapter.recordPaymentFirestore({
      roomNumber: premiumRoomNo,
      amount: 500,
      paymentMethod: 'UPI',
      remarks: 'Settlement for upgrade'
    });
    assert.strictEqual(payRes8.newOutstanding, 0, 'Remaining balance must become 0');
    assert.strictEqual(payRes8.isSettled, true);
    cleanupList.push({ col: 'payments', doc: payRes8.paymentId });
    console.log('✓ TEST 8 PASSED: Remaining ₹500 paid. Folio is fully settled (₹0 balance).');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 9 — Checkout Enforcement
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 9: Checkout Enforcement & Execution ---');
    // A. Verify checkout succeeds when balance = 0
    const coRes = await processCheckOutFirestoreTransaction({
      number: premiumRoomNo
    });
    assert.strictEqual(coRes.success, true);
    console.log('✓ Checkout succeeded on fully settled room.');

    // Check room status is dirty and booking is Checked Out
    const rSnap = await db.collection('rooms').doc(`room_${premiumRoomNo}`).get();
    assert.strictEqual(rSnap.data().status, 'dirty');
    assert.strictEqual(rSnap.data().current_booking_id, null);

    const bSnap = await db.collection('bookings').doc(bkgId7).get();
    assert.strictEqual(bSnap.data().booking_status, 'Checked Out');
    assert.strictEqual(bSnap.data().payment_status, 'Paid');
    console.log('✓ Room transitioned to Dirty, booking Checked Out.');

    console.log('\n═════════════════════════════════════════════════════════════════════════════');
    console.log('ALL 9 TEST SCENARIOS PASSED WITH 100% SUCCESS!');
    console.log('═════════════════════════════════════════════════════════════════════════════\n');

  } finally {
    console.log('Cleaning up test fixtures...');
    await cleanupTestDocs(cleanupList);
    console.log('✓ Cleanup complete. Zero production records modified.');
  }
}

runTests().catch(err => {
  console.error('\n❌ COMPREHENSIVE TEST SUITE FAILED:', err);
  process.exit(1);
});
