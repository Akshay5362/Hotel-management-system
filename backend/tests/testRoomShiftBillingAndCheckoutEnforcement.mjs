import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';
import { processRoomShiftFirestoreTransaction } from '../adapters/firestore/roomShiftFirestoreAdapter.js';
import { LedgerFirestoreAdapter } from '../adapters/firestore/ledgerFirestoreAdapter.js';
import { processCheckOutFirestoreTransaction } from '../adapters/firestore/checkOutFirestoreAdapter.js';
import { MasterBillService } from '../services/masterBillService.js';

console.log('─────────────────────────────────────────────────────────────────────────────');
console.log('HPMS — ROOM SHIFT BILLING + PAYMENTS + CHECKOUT ENFORCEMENT TEST SUITE');
console.log('─────────────────────────────────────────────────────────────────────────────\n');

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
  const roomStandardNo = `981_${testSuffix}`;
  const roomExecNo = `982_${testSuffix}`;
  const roomPremiumNo = `983_${testSuffix}`;
  const testBkgId = `booking_test_shift_${testSuffix}`;
  const testBkgNumber = `BKG-TEST-${testSuffix}`;
  const testGuestId = `guest_test_${testSuffix}`;

  try {
    // ═════════════════════════════════════════════════════════════════════════
    // SETUP: Isolated Rooms & Booking in Firestore
    // ═════════════════════════════════════════════════════════════════════════
    console.log('1. Setting up isolated test fixtures...');
    
    // Standard Room: ₹1500
    await db.collection('rooms').doc(`room_${roomStandardNo}`).set({
      id: `room_${roomStandardNo}`,
      number: roomStandardNo,
      type: 'Standard',
      price: 1500,
      rate: 1500,
      base_rate: 1500,
      status: 'occupied',
      housekeeping_status: 'Clean',
      is_active: true,
      current_booking_id: testBkgId,
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'rooms', doc: `room_${roomStandardNo}` });

    // Executive Room: ₹2000
    await db.collection('rooms').doc(`room_${roomExecNo}`).set({
      id: `room_${roomExecNo}`,
      number: roomExecNo,
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
    cleanupList.push({ col: 'rooms', doc: `room_${roomExecNo}` });

    // Premium Room: ₹2500
    await db.collection('rooms').doc(`room_${roomPremiumNo}`).set({
      id: `room_${roomPremiumNo}`,
      number: roomPremiumNo,
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
    cleanupList.push({ col: 'rooms', doc: `room_${roomPremiumNo}` });

    // Guest Document
    await db.collection('guests').doc(testGuestId).set({
      id: testGuestId,
      full_name: 'TEST GUEST',
      phone: '9999999999',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'guests', doc: testGuestId });

    // Active Booking
    await db.collection('bookings').doc(testBkgId).set({
      id: testBkgId,
      booking_number: testBkgNumber,
      guest_id: testGuestId,
      guest_name: 'TEST GUEST',
      room_id: `room_${roomStandardNo}`,
      room_number: roomStandardNo,
      room_tariff: 1500,
      total_amount: 1500,
      advance_amount: 0,
      booking_status: 'Checked In',
      payment_status: 'Pending',
      check_in_date: '2026-08-22',
      expected_check_out_date: '2026-08-23 11:00',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'bookings', doc: testBkgId });

    // Initial check-in room tariff ledger item
    const initLedgerId = `ledger_${testBkgId}_1`;
    await db.collection('ledger_items').doc(initLedgerId).set({
      item_id: initLedgerId,
      booking_id: testBkgId,
      booking_number: testBkgNumber,
      room_number: roomStandardNo,
      desc: 'Room Tariff (Incl. GST)',
      description: 'Room Tariff (Incl. GST)',
      qty: 1,
      amount: 1500,
      credit_amount: 0,
      transaction_type: 'CHARGE',
      business_date: '2026-08-22',
      created_at: new Date().toISOString()
    });
    cleanupList.push({ col: 'ledger_items', doc: initLedgerId });

    console.log('✓ Setup complete.');

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 1: Room Shift does NOT create duplicate full room tariff charge
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n2. Testing Room Shift from Standard (₹1500) to Executive (₹2000)...');
    
    const shiftResult = await processRoomShiftFirestoreTransaction({
      fromRoomNumber: roomStandardNo,
      toRoomNumber: roomExecNo,
      resolvedUserId: 'admin_test'
    });

    assert.strictEqual(shiftResult.success, true, 'Room shift must return success: true');
    console.log('✓ Room shift transaction succeeded.');

    // Verify source room is vacant
    const srcSnap = await db.collection('rooms').doc(`room_${roomStandardNo}`).get();
    assert.strictEqual(srcSnap.data().status, 'vacant', 'Source room must become vacant');
    assert.strictEqual(srcSnap.data().current_booking_id, null, 'Source room current_booking_id must be null');

    // Verify target room is occupied
    const tgtSnap = await db.collection('rooms').doc(`room_${roomExecNo}`).get();
    assert.strictEqual(tgtSnap.data().status, 'occupied', 'Target room must become occupied');
    assert.strictEqual(tgtSnap.data().current_booking_id, testBkgId, 'Target room must point to booking');

    // Verify booking room_tariff is updated to 2000
    const bkgSnap = await db.collection('bookings').doc(testBkgId).get();
    assert.strictEqual(bkgSnap.data().room_number, roomExecNo, 'Booking room_number must be updated to target room');
    assert.strictEqual(bkgSnap.data().room_tariff, 2000, 'Booking room_tariff must automatically reflect destination room master tariff (2000)');

    // Verify differential upgrade charge was added (₹500), NO duplicate full ₹2000 charge
    const ledgersSnap = await db.collection('ledger_items').where('booking_id', '==', testBkgId).get();
    const chargeItems = ledgersSnap.docs.filter(d => d.data().transaction_type === 'CHARGE');
    assert.strictEqual(chargeItems.length, 2, 'MUST have 2 charges: Initial ₹1500 + Differential ₹500');
    const totalChargeAmt = chargeItems.reduce((s, d) => s + (d.data().amount || 0), 0);
    assert.strictEqual(totalChargeAmt, 2000, 'Total charges must be ₹2000 (NOT ₹3500 duplicate)');
    console.log('✓ Verified: Initial charge ₹1500 + Upgrade differential ₹500 = Total ₹2000 (NO duplicate ₹2000 full tariff created).');

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 2: Manual Room Rent Adjustment (Increase and Decrease)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n3. Testing Manual Room Rent Adjustment...');

    // A. Validation: zero / negative amount rejected
    try {
      await LedgerFirestoreAdapter.adjustRoomRentFirestore({
        roomNumber: roomExecNo,
        amount: 0,
        adjustmentType: 'INCREASE',
        reason: 'Test reason'
      });
      assert.fail('Should have rejected 0 amount');
    } catch (err) {
      assert.strictEqual(err.code, 'INVALID_ADJUSTMENT_AMOUNT', 'Must reject <= 0 adjustment amount');
      console.log('✓ Rejected 0 adjustment amount.');
    }

    // B. Validation: missing reason rejected
    try {
      await LedgerFirestoreAdapter.adjustRoomRentFirestore({
        roomNumber: roomExecNo,
        amount: 200,
        adjustmentType: 'INCREASE',
        reason: ''
      });
      assert.fail('Should have rejected empty reason');
    } catch (err) {
      assert.strictEqual(err.code, 'ADJUSTMENT_REASON_REQUIRED', 'Must reject empty reason');
      console.log('✓ Rejected empty adjustment reason.');
    }

    // C. Valid Adjustment: Increase +₹200
    const adjIncResult = await LedgerFirestoreAdapter.adjustRoomRentFirestore({
      roomNumber: roomExecNo,
      amount: 200,
      adjustmentType: 'INCREASE',
      reason: 'Approved extra service upgrade',
      resolvedUserId: 'admin_test'
    });
    assert.strictEqual(adjIncResult.success, true);
    cleanupList.push({ col: 'ledger_items', doc: adjIncResult.ledgerId });
    cleanupList.push({ col: 'room_rent_adjustments', doc: adjIncResult.adjustmentId });
    console.log(`✓ Applied Increase Adjustment (+₹200). New Balance: ₹${adjIncResult.newBalance}`);

    // D. Valid Adjustment: Decrease -₹100
    const adjDecResult = await LedgerFirestoreAdapter.adjustRoomRentFirestore({
      roomNumber: roomExecNo,
      amount: 100,
      adjustmentType: 'DECREASE',
      reason: 'Promotional discount voucher',
      resolvedUserId: 'admin_test'
    });
    assert.strictEqual(adjDecResult.success, true);
    cleanupList.push({ col: 'ledger_items', doc: adjDecResult.ledgerId });
    cleanupList.push({ col: 'room_rent_adjustments', doc: adjDecResult.adjustmentId });
    console.log(`✓ Applied Decrease Adjustment (-₹100). New Balance: ₹${adjDecResult.newBalance}`);

    // Gross: 2000 + 200 = 2200. Credits: 100. Net: 2100.
    const allLedgersSnap = await db.collection('ledger_items').where('booking_id', '==', testBkgId).get();
    const ledgerList = allLedgersSnap.docs.map(d => d.data());
    const financialsAfterAdj = LedgerFirestoreAdapter.calculateAuthoritativeBalance(ledgerList);
    assert.strictEqual(financialsAfterAdj.grossCharges, 2200, 'Gross charges must be ₹2200');
    assert.strictEqual(financialsAfterAdj.validCredits, 100, 'Valid credits must be ₹100');
    assert.strictEqual(financialsAfterAdj.outstandingBalance, 2100, 'Outstanding balance must be ₹2100');
    console.log(`✓ Financial reconciliation verified: Gross ₹${financialsAfterAdj.grossCharges} - Credits ₹${financialsAfterAdj.validCredits} = Net Balance ₹${financialsAfterAdj.outstandingBalance}`);

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 3: Checkout is BLOCKED when Balance > 0
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n4. Testing Checkout Block when Balance > 0 (₹2100 outstanding)...');

    try {
      await processCheckOutFirestoreTransaction({
        number: roomExecNo,
        resolvedUserId: 'admin_test'
      });
      assert.fail('Checkout should have been blocked!');
    } catch (err) {
      assert.strictEqual(err.code, 'BALANCE_DUE', 'Checkout must throw BALANCE_DUE when balance > 0');
      assert.strictEqual(err.balanceDue, 2100, 'Error details must contain exact balance due (2100)');
      console.log(`✓ Checkout BLOCKED as expected with code BALANCE_DUE. Balance: ₹${err.balanceDue}`);
    }

    // Verify room is STILL occupied and booking is STILL Checked In
    const roomCheckSnap = await db.collection('rooms').doc(`room_${roomExecNo}`).get();
    assert.strictEqual(roomCheckSnap.data().status, 'occupied', 'Room must remain occupied after blocked checkout');
    const bkgCheckSnap = await db.collection('bookings').doc(testBkgId).get();
    assert.strictEqual(bkgCheckSnap.data().booking_status, 'Checked In', 'Booking must remain Checked In');
    console.log('✓ Verified: Zero state mutations occurred on blocked checkout.');

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 4: Partial and Multiple Payment Settlement
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n5. Testing Partial and Multiple Payments...');

    // A. Overpayment rejection (> 2100)
    try {
      await LedgerFirestoreAdapter.recordPaymentFirestore({
        roomNumber: roomExecNo,
        amount: 2500,
        paymentMethod: 'Cash'
      });
      assert.fail('Should reject overpayment');
    } catch (err) {
      assert.strictEqual(err.code, 'PAYMENT_EXCEEDS_BALANCE', 'Must reject overpayment');
      console.log('✓ Overpayment (> remaining balance) correctly rejected.');
    }

    // B. Partial Payment 1: ₹600 via UPI
    const pay1 = await LedgerFirestoreAdapter.recordPaymentFirestore({
      roomNumber: roomExecNo,
      amount: 600,
      paymentMethod: 'UPI',
      remarks: 'UPI-TXN-12345',
      resolvedUserId: 'admin_test'
    });
    assert.strictEqual(pay1.success, true);
    assert.strictEqual(pay1.newOutstanding, 1500, 'Remaining balance must be ₹1500');
    cleanupList.push({ col: 'payments', doc: pay1.paymentId });
    console.log('✓ Partial Payment 1 (₹600 UPI) recorded. Remaining Balance: ₹1500');

    // C. Partial Payment 2: ₹1500 via Cash (Pay Full)
    const pay2 = await LedgerFirestoreAdapter.recordPaymentFirestore({
      roomNumber: roomExecNo,
      amount: 1500,
      paymentMethod: 'Cash',
      remarks: 'Full settlement at desk',
      resolvedUserId: 'admin_test'
    });
    assert.strictEqual(pay2.success, true);
    assert.strictEqual(pay2.newOutstanding, 0, 'Remaining balance must be ₹0');
    assert.strictEqual(pay2.isSettled, true, 'isSettled must be true');
    cleanupList.push({ col: 'payments', doc: pay2.paymentId });
    console.log('✓ Partial Payment 2 (₹1500 Cash) recorded. Remaining Balance: ₹0 (Fully Settled)');

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 5: Master Bill Financial Synchronization
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n6. Testing Master Bill financial synchronization...');
    const masterBill = await MasterBillService.getMasterBill(testBkgId);
    assert.strictEqual(masterBill.settlement.outstandingBalance, 0, 'Master bill outstanding balance must be 0');
    assert.strictEqual(masterBill.settlement.paymentStatus, 'PAID IN FULL', 'Master bill status must be PAID IN FULL');
    assert.strictEqual(masterBill.paymentDetails.length, 2, 'Master bill must list both payment records');
    console.log('✓ Master Bill financial reconciliation matches exact ledger & payments.');

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 6: Checkout Succeeded with Balance = 0
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n7. Testing Checkout Execution with Balance = 0...');
    const checkoutResult = await processCheckOutFirestoreTransaction({
      number: roomExecNo,
      resolvedUserId: 'admin_test'
    });

    assert.strictEqual(checkoutResult.success, true, 'Checkout must succeed');
    console.log(`✓ Checkout SUCCEEDED. Invoice generated: ${checkoutResult.invoiceNumber}`);

    // Verify room is dirty and current_booking_id is cleared
    const coRoomSnap = await db.collection('rooms').doc(`room_${roomExecNo}`).get();
    assert.strictEqual(coRoomSnap.data().status, 'dirty', 'Room status must transition to dirty');
    assert.strictEqual(coRoomSnap.data().current_booking_id, null, 'Room current_booking_id must be null');

    // Verify booking is Checked Out
    const coBkgSnap = await db.collection('bookings').doc(testBkgId).get();
    assert.strictEqual(coBkgSnap.data().booking_status, 'Checked Out', 'Booking status must be Checked Out');
    assert.strictEqual(coBkgSnap.data().payment_status, 'Paid', 'Booking payment_status must be Paid');
    console.log('✓ Room transitioned to Dirty, booking marked Checked Out, current_booking_id cleared.');

    console.log('\n═════════════════════════════════════════════════════════════════════════');
    console.log('ALL 7 TEST SCENARIOS PASSED WITH 100% SUCCESS!');
    console.log('═════════════════════════════════════════════════════════════════════════\n');

  } finally {
    console.log('Cleaning up test fixtures...');
    await cleanupTestDocs(cleanupList);
    console.log('✓ Test cleanup complete. No production data modified.');
  }
}

runTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
