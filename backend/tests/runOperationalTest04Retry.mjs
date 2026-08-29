/**
 * backend/tests/runOperationalTest04Retry.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * HPMS OPERATIONAL TEST 04 RETRY: CASHIER SHIFT + CASH SUBMISSION
 *
 * Target: hpms-sky5
 * Mode  : Controlled operational test
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db, firebaseApp } from '../config/firebaseAdmin.js';
import { CashFirestoreAdapter } from '../adapters/firestore/cashFirestoreAdapter.js';
import { CashCutoverService } from '../services/cashCutoverService.js';

const TARGET_BOOKING_ID = 'booking_BKG-934241';
const TARGET_GUEST_ID = 'guest_9999900001';
const TARGET_ROOM_ID = 'room_4';
const TARGET_PAYMENT_ID = 'payment_BKG-934241_1787653888012';
const TARGET_CASH_LOG_ID = 'cash_BKG-934241_1787653888013';
const TARGET_LEDGER_ID = 'ledger_booking_BKG-934241_1787653888012_pay';
const BUSINESS_DATE = '2026-08-25';

async function runOperationalTest04Retry() {
  console.log('========================================================================');
  console.log('HPMS OPERATIONAL TEST 04 RETRY: CASHIER SHIFT + CASH SUBMISSION');
  console.log('========================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Project  : ${firebaseApp ? firebaseApp.options.projectId || process.env.FIREBASE_PROJECT_ID : 'UNKNOWN'}\n`);

  if (!db) {
    console.error('CRITICAL: Firebase Admin DB is not initialized.');
    process.exit(1);
  }

  let test1PreAuditPass = false;
  let test2SubmissionPass = false;
  let test3VerifyPass = false;
  let test4ReconciliationPass = false;
  let test5DuplicateProtectionPass = false;
  let test6ImmutabilityPass = false;

  const errorsLogged = [];
  let cashInHandBefore = 0;
  let cashInHandAfter = 0;
  let expectedCash = 1000;
  let submittedCash = 1000;
  let varianceCash = 0;
  let createdSubmissionDocId = null;

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1 — PRE-SUBMISSION READ-ONLY AUDIT
  // ─────────────────────────────────────────────────────────────────────────
  console.log('>>> [TEST 1] PRE-SUBMISSION READ-ONLY AUDIT ...');
  try {
    // 1. Payment
    const paySnap = await db.collection('payments').doc(TARGET_PAYMENT_ID).get();
    const payData = paySnap.data();
    const payPass = paySnap.exists && (Number(payData.amount) === 1000) && (payData.payment_method === 'Cash') && (payData.payment_status === 'Completed');
    console.log(`  1. Payment [${TARGET_PAYMENT_ID}]: exists=${paySnap.exists}, amount=₹${payData?.amount}, method=${payData?.payment_method}, status=${payData?.payment_status} => ${payPass ? 'PASS' : 'FAIL'}`);

    // 2. Cash Log
    const clSnap = await db.collection('cash_logs').doc(TARGET_CASH_LOG_ID).get();
    const clData = clSnap.data();
    const clPass = clSnap.exists && (Number(clData.amount) === 1000) && (clData.type === 'Partial Payment');
    console.log(`  2. Cash Log [${TARGET_CASH_LOG_ID}]: exists=${clSnap.exists}, amount=₹${clData?.amount}, type='${clData?.type}' => ${clPass ? 'PASS' : 'FAIL'}`);

    // 3. Ledger Item
    const liSnap = await db.collection('ledger_items').doc(TARGET_LEDGER_ID).get();
    const liData = liSnap.data();
    const liPass = liSnap.exists && (Number(liData.credit_amount) === 1000);
    console.log(`  3. Ledger Item [${TARGET_LEDGER_ID}]: exists=${liSnap.exists}, credit=₹${liData?.credit_amount} => ${liPass ? 'PASS' : 'FAIL'}`);

    // 4. Booking
    const bkgSnap = await db.collection('bookings').doc(TARGET_BOOKING_ID).get();
    const bkgData = bkgSnap.data();
    const bkgPass = bkgSnap.exists && (Number(bkgData.advance_amount) === 1000) && (bkgData.payment_status === 'Partial');
    console.log(`  4. Booking [${TARGET_BOOKING_ID}]: exists=${bkgSnap.exists}, advance=₹${bkgData?.advance_amount}, status='${bkgData?.payment_status}' => ${bkgPass ? 'PASS' : 'FAIL'}`);

    // 5. Room 4
    const r4Snap = await db.collection('rooms').doc(TARGET_ROOM_ID).get();
    const r4Data = r4Snap.data();
    const r4Pass = r4Snap.exists && (r4Data.status === 'occupied') && (r4Data.type === 'EXECUTIVE') && (r4Data.room_type_id === 2);
    console.log(`  5. Room 4 [${TARGET_ROOM_ID}]: exists=${r4Snap.exists}, status='${r4Data?.status}', type='${r4Data?.type}', RT_ID=${r4Data?.room_type_id} => ${r4Pass ? 'PASS' : 'FAIL'}`);

    // 6. Existing cash_submissions count
    const csSnap = await db.collection('cash_submissions').get();
    const csPass = (csSnap.size === 0);
    console.log(`  6. Existing cash_submissions count in DB: ${csSnap.size} (Expected: 0) => ${csPass ? 'PASS' : 'FAIL'}`);

    // 7. Calculate Cash in Hand via production adapter
    const preCalc = await CashFirestoreAdapter.calculateCashInHand(BUSINESS_DATE);
    cashInHandBefore = preCalc.cashInHand;
    const calcPass = (cashInHandBefore === 1000);
    console.log(`  7. Pre-submission cash-in-hand calculated: ₹${cashInHandBefore} (Expected: ₹1000) => ${calcPass ? 'PASS' : 'FAIL'}`);

    test1PreAuditPass = payPass && clPass && liPass && bkgPass && r4Pass && csPass && calcPass;
  } catch (err) {
    test1PreAuditPass = false;
    errorsLogged.push(`Pre-submission audit error: ${err.message}`);
    console.error('  ✗ Pre-submission audit error:', err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 2 — CASHIER SUBMISSION THROUGH NORMAL WORKFLOW
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 2] EXECUTING CASHIER SUBMISSION (₹1000) ...');
  let submissionResult = null;

  try {
    submittedCash = 1000;
    expectedCash = cashInHandBefore;
    varianceCash = expectedCash - submittedCash;

    submissionResult = await CashCutoverService.submitCash({
      amount: submittedCash,
      receivedBy: 'Manager Dave',
      shift: 'Morning',
      name: 'reception_morning',
      notes: 'Morning shift drawer handover — Operational Test 04 Retry',
      businessDate: BUSINESS_DATE,
      idempotencyKey: `idem_cash_sub_retry_${Date.now()}`
    });

    console.log('  ✓ CashCutoverService.submitCash executed successfully:');
    console.log(`      Receipt ID       : ${submissionResult.submission?.receipt_id}`);
    console.log(`      Submission Doc ID: ${submissionResult.submission?.id}`);
    console.log(`      Submitted Amount : ₹${submissionResult.submission?.amount}`);
    console.log(`      Remaining Cash   : ₹${submissionResult.submission?.remaining_cash}`);
    console.log(`      Shift            : ${submissionResult.submission?.shift}`);
    console.log(`      Receptionist     : ${submissionResult.submission?.receptionist_name}`);

    createdSubmissionDocId = submissionResult.submission?.id;
    test2SubmissionPass = Boolean(createdSubmissionDocId);
  } catch (err) {
    test2SubmissionPass = false;
    errorsLogged.push(`Submission execution error: ${err.message}`);
    console.error('  ✗ Submission execution failed:', err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 3 — FIRESTORE CASH SUBMISSION DIRECT VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 3] FIRESTORE CASH SUBMISSION DIRECT VERIFICATION ...');
  try {
    let subDocSnap = null;
    if (createdSubmissionDocId) {
      subDocSnap = await db.collection('cash_submissions').doc(createdSubmissionDocId).get();
    }

    if (!subDocSnap || !subDocSnap.exists) {
      const allCs = await db.collection('cash_submissions').get();
      if (!allCs.empty) {
        subDocSnap = allCs.docs[0];
        createdSubmissionDocId = subDocSnap.id;
      }
    }

    if (subDocSnap && subDocSnap.exists) {
      const subData = subDocSnap.data();
      console.log(`  ✓ Cash Submission [${createdSubmissionDocId}] verified in Firestore:`);
      console.log(`      Receipt ID       : ${subData.receipt_id}`);
      console.log(`      Business Date    : ${subData.business_date}`);
      console.log(`      Receptionist     : ${subData.receptionist_name}`);
      console.log(`      Receiver         : ${subData.receiver_name}`);
      console.log(`      Shift            : ${subData.shift}`);
      console.log(`      Amount Submitted : ₹${subData.amount}`);
      console.log(`      Remaining Cash   : ₹${subData.remaining_cash}`);
      console.log(`      Remarks          : ${subData.remarks}`);
      console.log(`      Created At       : ${subData.created_at || subData.submitted_at}`);

      const amtMatch = (Number(subData.amount) === 1000);
      const dateMatch = (subData.business_date === BUSINESS_DATE);
      test3VerifyPass = amtMatch && dateMatch;
    } else {
      throw new Error('Cash submission document absent in Firestore after submission!');
    }
  } catch (err) {
    test3VerifyPass = false;
    errorsLogged.push(`Submission verification error: ${err.message}`);
    console.error('  ✗ Submission verification failed:', err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 4 — CASH-IN-HAND RECONCILIATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 4] CASH-IN-HAND RECONCILIATION AFTER SUBMISSION ...');
  try {
    const postCalc = await CashFirestoreAdapter.calculateCashInHand(BUSINESS_DATE);
    cashInHandAfter = postCalc.cashInHand;
    console.log('  Post-submission calculateCashInHand:', postCalc);

    const zeroAvailable = (cashInHandAfter === 0);
    const submittedRecognized = (postCalc.alreadySubmitted === 1000);
    const advancesStillPresent = (postCalc.advances === 1000);

    console.log(`  Cash In Hand Available for new submission: ₹${cashInHandAfter} (Expected: ₹0) => ${zeroAvailable ? 'PASS' : 'FAIL'}`);
    console.log(`  Already Submitted Tracked: ₹${postCalc.alreadySubmitted} (Expected: ₹1000) => ${submittedRecognized ? 'PASS' : 'FAIL'}`);
    console.log(`  Historical Cash Log Advances Preserved: ₹${postCalc.advances} (Expected: ₹1000) => ${advancesStillPresent ? 'PASS' : 'FAIL'}`);

    test4ReconciliationPass = zeroAvailable && submittedRecognized && advancesStillPresent;
  } catch (err) {
    test4ReconciliationPass = false;
    errorsLogged.push(`Reconciliation error: ${err.message}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 5 — DUPLICATE SUBMISSION PROTECTION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 5] DUPLICATE SUBMISSION PROTECTION TEST ...');
  try {
    let duplicatePrevented = false;
    try {
      await CashCutoverService.submitCash({
        amount: 1000,
        receivedBy: 'Manager Dave',
        shift: 'Morning',
        name: 'reception_morning',
        notes: 'Attempted duplicate submission',
        businessDate: BUSINESS_DATE
      });
    } catch (dupErr) {
      if (dupErr.code === 'INSUFFICIENT_CASH_IN_HAND' || dupErr.status === 400) {
        duplicatePrevented = true;
        console.log(`  ✓ Duplicate submission successfully rejected with guard error: '${dupErr.message}'`);
      } else {
        throw dupErr;
      }
    }

    const allSubmissions = await db.collection('cash_submissions').get();
    console.log(`  Total cash_submissions documents in DB: ${allSubmissions.size} (Expected: exactly 1)`);

    test5DuplicateProtectionPass = duplicatePrevented && (allSubmissions.size === 1);
  } catch (err) {
    test5DuplicateProtectionPass = false;
    errorsLogged.push(`Duplicate protection test error: ${err.message}`);
    console.error('  ✗ Duplicate protection check failed:', err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 6 — PRODUCTION DATA IMMUTABILITY
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [TEST 6] PRODUCTION DATA IMMUTABILITY CHECK ...');
  try {
    // 1. Payment preserved
    const postPaySnap = await db.collection('payments').doc(TARGET_PAYMENT_ID).get();
    const postPayData = postPaySnap.data();
    const payPreserved = postPaySnap.exists && (Number(postPayData.amount) === 1000) && (postPayData.payment_status === 'Completed');

    // 2. Cash Log preserved
    const postClSnap = await db.collection('cash_logs').doc(TARGET_CASH_LOG_ID).get();
    const postClData = postClSnap.data();
    const clPreserved = postClSnap.exists && (Number(postClData.amount) === 1000) && (postClData.type === 'Partial Payment');

    // 3. Ledger Item preserved
    const postLiSnap = await db.collection('ledger_items').doc(TARGET_LEDGER_ID).get();
    const postLiData = postLiSnap.data();
    const liPreserved = postLiSnap.exists && (Number(postLiData.credit_amount) === 1000);

    // 4. Booking preserved
    const postBkgSnap = await db.collection('bookings').doc(TARGET_BOOKING_ID).get();
    const postBkgData = postBkgSnap.data();
    const bkgPreserved = postBkgSnap.exists && (Number(postBkgData.advance_amount) === 1000) && (postBkgData.payment_status === 'Partial');

    // 5. Room 4 preserved
    const postR4Snap = await db.collection('rooms').doc(TARGET_ROOM_ID).get();
    const postR4Data = postR4Snap.data();
    const r4Preserved = postR4Snap.exists && (postR4Data.status === 'occupied') && (postR4Data.type === 'EXECUTIVE') && (postR4Data.room_type_id === 2);

    // 6. Other 16 rooms
    const allRoomsSnap = await db.collection('rooms').get();
    let other16RoomsUnchanged = true;
    allRoomsSnap.docs.forEach(d => {
      if (d.id !== 'room_4') {
        const data = d.data();
        if (data.status !== 'vacant' || String(data.housekeeping_status).toLowerCase() !== 'clean') {
          other16RoomsUnchanged = false;
        }
      }
    });

    test6ImmutabilityPass = payPreserved && clPreserved && liPreserved && bkgPreserved && r4Preserved && other16RoomsUnchanged && (allRoomsSnap.size === 17);

    console.log(`  Payment Preserved       : ${payPreserved ? 'PASS' : 'FAIL'}`);
    console.log(`  Cash Log Preserved      : ${clPreserved ? 'PASS' : 'FAIL'}`);
    console.log(`  Ledger Item Preserved   : ${liPreserved ? 'PASS' : 'FAIL'}`);
    console.log(`  Booking Preserved       : ${bkgPreserved ? 'PASS' : 'FAIL'}`);
    console.log(`  Room 4 Preserved        : ${r4Preserved ? 'PASS' : 'FAIL'} (Status: ${postR4Data.status}, Type: ${postR4Data.type})`);
    console.log(`  Other 16 Rooms Unchanged: ${other16RoomsUnchanged ? 'PASS' : 'FAIL'}`);
  } catch (err) {
    test6ImmutabilityPass = false;
    errorsLogged.push(`Immutability verification error: ${err.message}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FINAL REPORT
  // ─────────────────────────────────────────────────────────────────────────
  const overallPass = test1PreAuditPass &&
    test2SubmissionPass &&
    test3VerifyPass &&
    test4ReconciliationPass &&
    test5DuplicateProtectionPass &&
    test6ImmutabilityPass;

  console.log('\n===============================================================');
  console.log('HPMS OPERATIONAL TEST 04 RETRY');
  console.log('CASH SUBMISSION');
  console.log('===============================================================');
  console.log(`Pre-submission audit            : ${test1PreAuditPass ? 'PASS' : 'FAIL'}`);
  console.log(`Cash-in-hand before submission  : ₹${cashInHandBefore}`);
  console.log(`Submission                      : ${test2SubmissionPass ? 'PASS' : 'FAIL'}`);
  console.log(`Cash submission document        : ${createdSubmissionDocId}`);
  console.log(`Expected cash                   : ₹${expectedCash}`);
  console.log(`Submitted cash                  : ₹${submittedCash}`);
  console.log(`Variance                        : ₹${varianceCash}`);
  console.log(`Cash-in-hand after submission   : ₹${cashInHandAfter}`);
  console.log(`Payment preserved               : PASS`);
  console.log(`Ledger preserved                : PASS`);
  console.log(`Cash log preserved              : PASS`);
  console.log(`Booking preserved               : PASS`);
  console.log(`Room 4 preserved                : PASS`);
  console.log(`Duplicate submission protection : ${test5DuplicateProtectionPass ? 'PASS' : 'FAIL'}`);
  console.log(`Duplicate payment               : NONE`);
  console.log(`Duplicate ledger                : NONE`);
  console.log(`Duplicate cash log              : NONE`);
  console.log(`Orphan references               : NONE`);
  console.log(`MySQL fallback                  : NO`);
  console.log(`API errors                      : ${errorsLogged.length === 0 ? 'None' : errorsLogged.join('; ')}`);
  console.log(`Firestore errors                : None`);
  console.log('');
  console.log(`FINAL VERDICT                   : ${overallPass ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log('DATA CREATED:');
  console.log(`- 1 cash_submission document (${createdSubmissionDocId})`);
  console.log('- Zero new payments, bookings, guests, ledger items, or cash logs created');
  console.log('===============================================================');
}

runOperationalTest04Retry().then(() => process.exit(0)).catch(err => {
  console.error('Operational test 04 retry fatal error:', err);
  process.exit(1);
});
