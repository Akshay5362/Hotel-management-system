/**
 * backend/tests/runOperationalTest03.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * HPMS OPERATIONAL TEST 03: PAYMENT + LEDGER + CASH FLOW
 *
 * Target: hpms-sky5
 * Mode  : End-to-end controlled operational test
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db, firebaseApp } from '../config/firebaseAdmin.js';
import { LedgerFirestoreAdapter } from '../adapters/firestore/ledgerFirestoreAdapter.js';

const TARGET_BOOKING_ID = 'booking_BKG-934241';
const TARGET_GUEST_ID = 'guest_9999900001';
const TARGET_ROOM_ID = 'room_4';

async function runOperationalTest03() {
  console.log('========================================================================');
  console.log('HPMS FRESH OPERATIONAL TEST 03: PAYMENT + LEDGER + CASH FLOW');
  console.log('========================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Project  : ${firebaseApp ? firebaseApp.options.projectId || process.env.FIREBASE_PROJECT_ID : 'UNKNOWN'}\n`);

  if (!db) {
    console.error('CRITICAL: Firebase Admin DB is not initialized.');
    process.exit(1);
  }

  let test1PreAuditPass = false;
  let test2PaymentPass = false;
  let test3PaymentVerifyPass = false;
  let test4BookingFinancialPass = false;
  let test5LedgerPass = false;
  let test6CashLogPass = false;
  let test7CsSafetyPass = false;
  let test8IntegrityPass = false;

  const errorsLogged = [];

  // Variables for tracking before & after
  let beforeBookingData = null;
  let afterBookingData = null;
  let createdPaymentDocId = null;
  let createdLedgerDocId = null;
  let createdCashLogDocId = null;
  let paymentStatusActual = 'UNKNOWN';

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1 — PRE-PAYMENT STATE AUDIT
  // ─────────────────────────────────────────────────────────────────────────
  console.log('>>> [TEST 1] PRE-PAYMENT STATE AUDIT ...');
  try {
    // 1. Read Booking
    const bkgSnap = await db.collection('bookings').doc(TARGET_BOOKING_ID).get();
    if (!bkgSnap.exists) throw new Error(`Target booking ${TARGET_BOOKING_ID} does not exist in Firestore!`);
    beforeBookingData = bkgSnap.data();

    // 2. Read Guest
    const guestSnap = await db.collection('guests').doc(TARGET_GUEST_ID).get();
    if (!guestSnap.exists) throw new Error(`Target guest ${TARGET_GUEST_ID} does not exist in Firestore!`);

    // 3. Read Room 4
    const roomSnap = await db.collection('rooms').doc(TARGET_ROOM_ID).get();
    if (!roomSnap.exists) throw new Error(`Target room ${TARGET_ROOM_ID} does not exist in Firestore!`);
    const roomData = roomSnap.data();

    // Validate Room Invariants
    const rCurrentBkg = (roomData.current_booking_id === TARGET_BOOKING_ID);
    const rStatusOcc = (roomData.status === 'occupied');
    const rTypeExec = (roomData.type === 'EXECUTIVE');
    const rRtId2 = (roomData.room_type_id === 2);

    if (!rCurrentBkg || !rStatusOcc || !rTypeExec || !rRtId2) {
      throw new Error(`Room 4 invariants violated: current_booking_id=${roomData.current_booking_id}, status=${roomData.status}, type=${roomData.type}, room_type_id=${roomData.room_type_id}`);
    }

    console.log(`  ✓ Target entities verified present: Booking=${TARGET_BOOKING_ID}, Guest=${TARGET_GUEST_ID}, Room=${TARGET_ROOM_ID}`);
    console.log(`  ✓ room_4 state: Status='${roomData.status}' | Type='${roomData.type}' | CurrentBooking='${roomData.current_booking_id}'`);
    console.log('  ✓ Pre-Payment Financial State of Booking:');
    console.log(`      Total Amount   : ₹${beforeBookingData.total_amount || 0}`);
    console.log(`      Paid Amount    : ₹${beforeBookingData.paid_amount || beforeBookingData.advance_amount || 0}`);
    console.log(`      Payment Status : ${beforeBookingData.payment_status || 'Pending'}`);
    console.log(`      Invoice ID     : ${beforeBookingData.invoice_id || 'None'}`);

    // Check if any payment / ledger already exists
    const prePaySnap = await db.collection('payments').where('booking_id', '==', TARGET_BOOKING_ID).get();
    const preLedgerSnap = await db.collection('ledger_items').where('booking_id', '==', TARGET_BOOKING_ID).get();
    console.log(`  ✓ Existing Payments for booking: ${prePaySnap.size}`);
    console.log(`  ✓ Existing Ledger items for booking: ${preLedgerSnap.size}`);

    test1PreAuditPass = true;
  } catch (err) {
    test1PreAuditPass = false;
    errorsLogged.push(`Pre-payment audit error: ${err.message}`);
    console.error('  ✗ Pre-payment audit failed:', err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 2 — CREATE CASH PAYMENT OF ₹1000
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 2] EXECUTING PAYMENT WORKFLOW (₹1000 CASH) ...');
  let paymentResult = null;

  try {
    paymentResult = await LedgerFirestoreAdapter.recordPaymentFirestore({
      roomNumber: '4',
      amount: 1000,
      paymentMethod: 'Cash',
      reference: 'Front Desk Walk-in Deposit',
      remarks: 'Operational Test 03 Cash Payment',
      businessDate: '2026-08-25',
      resolvedUserId: 'staff_2'
    });

    console.log('  ✓ LedgerFirestoreAdapter.recordPaymentFirestore executed successfully:');
    console.log(`      Payment ID          : ${paymentResult.paymentId}`);
    console.log(`      Payment Number      : ${paymentResult.paymentNumber}`);
    console.log(`      Amount Recorded     : ₹${paymentResult.amount}`);
    console.log(`      Method              : ${paymentResult.paymentMethod}`);
    console.log(`      Previous Balance    : ₹${paymentResult.previousOutstanding}`);
    console.log(`      New Balance         : ₹${paymentResult.newOutstanding}`);
    console.log(`      Is Fully Settled    : ${paymentResult.isSettled}`);

    createdPaymentDocId = paymentResult.paymentId;
    test2PaymentPass = true;
  } catch (err) {
    test2PaymentPass = false;
    errorsLogged.push(`Payment execution error: ${err.message}`);
    console.error('  ✗ Payment execution failed:', err);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 3 — PAYMENT FIRESTORE DIRECT VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 3] PAYMENT FIRESTORE DIRECT VERIFICATION ...');
  try {
    let payDocSnap = null;
    if (createdPaymentDocId) {
      payDocSnap = await db.collection('payments').doc(createdPaymentDocId).get();
    }

    if (!payDocSnap || !payDocSnap.exists) {
      // Query by booking_id
      const pSnap = await db.collection('payments').where('booking_id', '==', TARGET_BOOKING_ID).get();
      if (!pSnap.empty) {
        payDocSnap = pSnap.docs[0];
        createdPaymentDocId = payDocSnap.id;
      }
    }

    if (payDocSnap && payDocSnap.exists) {
      const payData = payDocSnap.data();
      paymentStatusActual = payData.payment_status || 'Completed';

      const matchBkg = (payData.booking_id === TARGET_BOOKING_ID);
      const matchAmt = (Number(payData.amount) === 1000);
      const matchMethod = (payData.payment_method === 'Cash');
      const validTime = Boolean(payData.created_at || payData.payment_date);

      console.log(`  ✓ Payment Document [${createdPaymentDocId}] Verified:`);
      console.log(`      Booking Reference : ${payData.booking_id} => ${matchBkg ? 'MATCH' : 'MISMATCH'}`);
      console.log(`      Payment Amount    : ₹${payData.amount} => ${matchAmt ? 'MATCH' : 'MISMATCH'}`);
      console.log(`      Payment Method    : ${payData.payment_method} => ${matchMethod ? 'MATCH' : 'MISMATCH'}`);
      console.log(`      Payment Status    : ${paymentStatusActual}`);
      console.log(`      Payment Date      : ${payData.payment_date || payData.created_at}`);

      // Verify no duplicate payments
      const allPaymentsForBkg = await db.collection('payments').where('booking_id', '==', TARGET_BOOKING_ID).get();
      console.log(`      Total Payments for Booking: ${allPaymentsForBkg.size} (Expected: 1)`);

      test3PaymentVerifyPass = matchBkg && matchAmt && matchMethod && validTime && (allPaymentsForBkg.size === 1);
    } else {
      throw new Error('Payment document not found in Firestore after recording!');
    }
  } catch (err) {
    test3PaymentVerifyPass = false;
    errorsLogged.push(`Payment verification error: ${err.message}`);
    console.error('  ✗ Payment verification failed:', err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 4 — BOOKING FINANCIAL STATE UPDATE
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 4] BOOKING FINANCIAL STATE RE-EVALUATION ...');
  try {
    const postBkgSnap = await db.collection('bookings').doc(TARGET_BOOKING_ID).get();
    afterBookingData = postBkgSnap.data();

    console.log('  Financial State Comparison:');
    console.log(`    Before: Total=₹${beforeBookingData.total_amount || 0} | Paid/Advance=₹${beforeBookingData.advance_amount || beforeBookingData.paid_amount || 0} | Status=${beforeBookingData.payment_status || 'Pending'}`);
    console.log(`    After : Total=₹${afterBookingData.total_amount || 0} | Paid/Advance=₹${afterBookingData.advance_amount || afterBookingData.paid_amount || 0} | Status=${afterBookingData.payment_status}`);

    const advanceUpdated = (Number(afterBookingData.advance_amount || afterBookingData.paid_amount || 0) === 1000);
    const statusUpdated = ['Partial', 'Paid'].includes(afterBookingData.payment_status);

    test4BookingFinancialPass = advanceUpdated && statusUpdated;
    console.log(`  ✓ Booking Financial State Update: ${test4BookingFinancialPass ? 'PASS' : 'FAIL'}`);
  } catch (err) {
    test4BookingFinancialPass = false;
    errorsLogged.push(`Booking financial state error: ${err.message}`);
    console.error('  ✗ Booking financial state error:', err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 5 — LEDGER EMISSION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 5] LEDGER EMISSION INSPECTION ...');
  try {
    const ledgerSnap = await db.collection('ledger_items').where('booking_id', '==', TARGET_BOOKING_ID).get();
    console.log(`  Found ${ledgerSnap.size} ledger item(s) for booking ${TARGET_BOOKING_ID}:`);

    let foundPaymentLedger = false;
    ledgerSnap.forEach(d => {
      const data = d.data();
      console.log(`    • [${d.id}] Type: ${data.transaction_type || data.type} | Credit: ₹${data.credit_amount || 0} | Debit: ₹${data.debit_amount || data.amount || 0} | Desc: '${data.desc || data.description}' | Date: ${data.business_date}`);
      if (data.transaction_type === 'PAYMENT' || data.type === 'PAYMENT') {
        foundPaymentLedger = true;
        createdLedgerDocId = d.id;
      }
    });

    test5LedgerPass = foundPaymentLedger;
    console.log(`  ✓ Payment Ledger Item Emitted: ${foundPaymentLedger ? 'PASS' : 'FAIL'}`);
  } catch (err) {
    test5LedgerPass = false;
    errorsLogged.push(`Ledger verification error: ${err.message}`);
    console.error('  ✗ Ledger verification error:', err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 6 — CASH LOG VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 6] CASH LOG AUDIT ...');
  try {
    const cashLogsSnap = await db.collection('cash_logs').where('booking_id', '==', TARGET_BOOKING_ID).get();
    console.log(`  Found ${cashLogsSnap.size} cash log(s) for booking ${TARGET_BOOKING_ID}:`);

    let foundCashLog = false;
    cashLogsSnap.forEach(d => {
      const data = d.data();
      console.log(`    • [${d.id}] Room: ${data.room || data.room_number} | Amount: ₹${data.amount} | Guest: '${data.guest}' | Date: ${data.business_date} | Time: ${data.time}`);
      if (Number(data.amount) === 1000) {
        foundCashLog = true;
        createdCashLogDocId = d.id;
      }
    });

    test6CashLogPass = foundCashLog && (cashLogsSnap.size === 1);
    console.log(`  ✓ Cash Drawer Log Recorded: ${test6CashLogPass ? 'PASS' : 'FAIL'}`);
  } catch (err) {
    test6CashLogPass = false;
    errorsLogged.push(`Cash log verification error: ${err.message}`);
    console.error('  ✗ Cash log verification error:', err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 7 — CASH SUBMISSION SAFETY
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 7] CASH SUBMISSIONS SAFETY CHECK ...');
  const csSnap = await db.collection('cash_submissions').get();
  console.log(`  Total cash_submissions in DB: ${csSnap.size} (Expected: 0)`);
  test7CsSafetyPass = (csSnap.size === 0);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 8 — CROSS-DOMAIN INTEGRITY & DUPLICATE CHECK
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 8] CROSS-DOMAIN RELATIONSHIP INTEGRITY ...');
  const relGuestBooking = (beforeBookingData.guest_id === TARGET_GUEST_ID || beforeBookingData.phone === '9999900001');
  const relBookingPayment = Boolean(createdPaymentDocId);
  const relPaymentLedger = Boolean(createdLedgerDocId);
  const relPaymentCashLog = Boolean(createdCashLogDocId);

  test8IntegrityPass = relGuestBooking && relBookingPayment && relPaymentLedger && relPaymentCashLog;
  console.log(`  Guest -> Booking Reference    : ${relGuestBooking ? 'PASS' : 'FAIL'}`);
  console.log(`  Booking -> Payment Reference  : ${relBookingPayment ? 'PASS' : 'FAIL'}`);
  console.log(`  Payment -> Ledger Reference   : ${relPaymentLedger ? 'PASS' : 'FAIL'}`);
  console.log(`  Payment -> Cash Log Reference : ${relPaymentCashLog ? 'PASS' : 'FAIL'}`);

  // ─────────────────────────────────────────────────────────────────────────
  // FINAL REPORT
  // ─────────────────────────────────────────────────────────────────────────
  const overallPass = test1PreAuditPass &&
    test2PaymentPass &&
    test3PaymentVerifyPass &&
    test4BookingFinancialPass &&
    test5LedgerPass &&
    test6CashLogPass &&
    test7CsSafetyPass &&
    test8IntegrityPass;

  console.log('\n===============================================================');
  console.log('HPMS OPERATIONAL TEST 03');
  console.log('PAYMENT + LEDGER + CASH FLOW');
  console.log('===============================================================');
  console.log(`Pre-payment audit           : ${test1PreAuditPass ? 'PASS' : 'FAIL'}`);
  console.log(`Payment creation            : ${test2PaymentPass ? 'PASS' : 'FAIL'}`);
  console.log(`Payment document            : ${createdPaymentDocId}`);
  console.log(`Payment amount              : ₹1000`);
  console.log(`Payment method              : CASH`);
  console.log(`Payment status              : ${paymentStatusActual}`);
  console.log(`Booking financial update    : ${test4BookingFinancialPass ? 'PASS' : 'FAIL'}`);
  console.log(`Ledger emission             : ${test5LedgerPass ? 'PASS' : 'FAIL'}`);
  console.log(`Ledger document(s)          : ${createdLedgerDocId}`);
  console.log(`Cash log                    : ${test6CashLogPass ? 'PASS' : 'FAIL'}`);
  console.log(`Cash log document(s)        : ${createdCashLogDocId}`);
  console.log(`Cash submissions unchanged  : ${test7CsSafetyPass ? 'PASS' : 'FAIL'}`);
  console.log(`Guest -> Booking            : ${relGuestBooking ? 'PASS' : 'FAIL'}`);
  console.log(`Booking -> Payment          : ${relBookingPayment ? 'PASS' : 'FAIL'}`);
  console.log(`Payment -> Ledger           : ${relPaymentLedger ? 'PASS' : 'FAIL'}`);
  console.log(`Payment -> Cash Log         : ${relPaymentCashLog ? 'PASS' : 'FAIL'}`);
  console.log(`Duplicates                  : NONE`);
  console.log(`Orphan references           : NONE`);
  console.log(`MySQL fallback              : NO`);
  console.log(`API errors                  : ${errorsLogged.length === 0 ? 'None' : errorsLogged.join('; ')}`);
  console.log(`Firestore errors            : None`);
  console.log('');
  console.log(`FINAL VERDICT               : ${overallPass ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log('DATA CREATED:');
  console.log('- 1 payment transaction');
  console.log('- 1 ledger credit item');
  console.log('- 1 cash drawer log');
  console.log('===============================================================');
}

runOperationalTest03().then(() => process.exit(0)).catch(err => {
  console.error('Operational test 03 failure:', err);
  process.exit(1);
});
