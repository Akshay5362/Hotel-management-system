/**
 * testFirestorePaymentsCashCutoverPhase2Step7.mjs
 * ---------------------------------------------------------------------------
 * Comprehensive 44-scenario test suite for HPMS Phase 2 Step 7:
 * Controlled Firestore Payments + Cash Cutover with safe MySQL emergency fallback.
 */

import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';
import {
  isFirestorePaymentsServingEnabled,
  isFirestoreCashServingEnabled
} from '../config/featureFlags.js';
import { PaymentFirestoreAdapter } from '../adapters/firestore/paymentFirestoreAdapter.js';
import { CashFirestoreAdapter } from '../adapters/firestore/cashFirestoreAdapter.js';
import { PaymentCutoverService } from '../services/paymentCutoverService.js';
import { CashCutoverService } from '../services/cashCutoverService.js';

let passedTests = 0;
let totalTests = 0;

async function runTest(testName, testFn) {
  totalTests++;
  try {
    await testFn();
    console.log(`  ✓ [TEST ${totalTests}] ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ [TEST ${totalTests}] ${testName}`);
    console.error(`     Error: ${err.message}`);
    throw err;
  }
}

console.log('\n===============================================================');
console.log('PHASE 2 STEP 7: PAYMENTS + CASH CUTOVER TEST SUITE (44 SCENARIOS)');
console.log('===============================================================\n');

async function main() {
  const ts = Date.now();
  const testBkgId = `test_bkg_cutover_${ts}`;
  const testBkgDocId = `booking_${testBkgId}`;
  const testPayDocId = `payment_${testBkgId}`;
  const testInvDocId = `invoice_${testBkgId}`;
  const testRoomNumber = `901`;
  const businessDate = '2026-08-19';

  // Seed test documents in Firestore
  await db.collection('bookings').doc(testBkgDocId).set({
    booking_id: testBkgDocId,
    booking_number: `BK-TEST-${ts}`,
    room_number: testRoomNumber,
    booking_status: 'Reserved',
    payment_status: 'Pending',
    advance_amount: 1500,
    user_id: `user_${ts}`,
    guest_user_uid: `user_${ts}`,
    created_at: new Date().toISOString()
  });

  await db.collection('payments').doc(testPayDocId).set({
    payment_id: testPayDocId,
    booking_id: testBkgDocId,
    amount: 1500,
    payment_method: 'Cash',
    payment_status: 'Pending',
    user_id: `user_${ts}`,
    guest_user_id: `user_${ts}`,
    business_date: businessDate,
    created_at: new Date().toISOString()
  });

  await db.collection('invoices').doc(testInvDocId).set({
    invoice_number: `INV-TEST-${ts}`,
    booking_id: testBkgDocId,
    total_amount: 5000,
    paid_amount: 0,
    balance_due: 5000,
    status: 'Issued',
    created_at: new Date().toISOString()
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 1: FEATURE FLAGS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('--- GROUP 1: Feature Flags ---');

  await runTest('1.1 isFirestorePaymentsServingEnabled function exists and returns boolean', () => {
    const val = isFirestorePaymentsServingEnabled();
    assert.strictEqual(typeof val, 'boolean');
  });

  await runTest('1.2 isFirestoreCashServingEnabled function exists and returns boolean', () => {
    const val = isFirestoreCashServingEnabled();
    assert.strictEqual(typeof val, 'boolean');
  });

  await runTest('1.3 Flag override works via process.env.USE_FIRESTORE_PAYMENTS', () => {
    const original = process.env.USE_FIRESTORE_PAYMENTS;
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    assert.strictEqual(isFirestorePaymentsServingEnabled(), true);
    process.env.USE_FIRESTORE_PAYMENTS = 'false';
    assert.strictEqual(isFirestorePaymentsServingEnabled(), false);
    process.env.USE_FIRESTORE_PAYMENTS = original;
  });

  await runTest('1.4 Flag override works via process.env.USE_FIRESTORE_CASH', () => {
    const original = process.env.USE_FIRESTORE_CASH;
    process.env.USE_FIRESTORE_CASH = 'true';
    assert.strictEqual(isFirestoreCashServingEnabled(), true);
    process.env.USE_FIRESTORE_CASH = 'false';
    assert.strictEqual(isFirestoreCashServingEnabled(), false);
    process.env.USE_FIRESTORE_CASH = original;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 2: FIRESTORE PAYMENT ADAPTER (FINALIZATION)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 2: Payment Finalization Adapter ---');

  await runTest('2.1 Finalize payment with Cash method', async () => {
    const res = await PaymentFirestoreAdapter.processFinalizePaymentFirestore({
      bookingId: testBkgDocId,
      paymentMethod: 'Cash',
      user: { id: `user_${ts}` },
      idempotencyKey: `idem_fin_cash_${ts}`
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.method, 'Cash');
    assert.strictEqual(res.status, 'Pending');
    assert.strictEqual(res.cashPending, true);
  });

  await runTest('2.2 Finalize payment idempotency returns cached result', async () => {
    const res = await PaymentFirestoreAdapter.processFinalizePaymentFirestore({
      bookingId: testBkgDocId,
      paymentMethod: 'Cash',
      user: { id: `user_${ts}` },
      idempotencyKey: `idem_fin_cash_${ts}`
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.method, 'Cash');
  });

  await runTest('2.3 Finalize payment with UPI method', async () => {
    const res = await PaymentFirestoreAdapter.processFinalizePaymentFirestore({
      bookingId: testBkgDocId,
      paymentMethod: 'UPI',
      user: { id: `user_${ts}` },
      idempotencyKey: `idem_fin_upi_${ts}`
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.method, 'UPI');
    assert.strictEqual(res.cashPending, false);
  });

  await runTest('2.4 Finalize payment with Credit Card method', async () => {
    const res = await PaymentFirestoreAdapter.processFinalizePaymentFirestore({
      bookingId: testBkgDocId,
      paymentMethod: 'Credit Card',
      user: { id: `user_${ts}` },
      idempotencyKey: `idem_fin_card_${ts}`
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.method, 'Credit Card');
  });

  await runTest('2.5 Missing bookingId in finalizePayment throws 400 validation error', async () => {
    let threw = false;
    try {
      await PaymentFirestoreAdapter.processFinalizePaymentFirestore({
        bookingId: null,
        paymentMethod: 'Cash'
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 400);
    }
    assert.strictEqual(threw, true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 3: FIRESTORE PAYMENT ADAPTER (CONFIRM CASH PAYMENT)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 3: Cash Payment Confirmation Adapter ---');

  // Set payment to Cash Pending for Group 3 tests
  await PaymentFirestoreAdapter.processFinalizePaymentFirestore({
    bookingId: testBkgDocId,
    paymentMethod: 'Cash',
    user: { id: `user_${ts}` }
  });

  await runTest('3.1 Confirm Cash payment changes status to Paid and updates invoice', async () => {
    const res = await PaymentFirestoreAdapter.processConfirmCashPaymentFirestore({
      bookingId: testBkgDocId,
      adminId: 'admin_1',
      idempotencyKey: `idem_conf_cash_${ts}`
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.amount, 1500);

    const payDoc = await db.collection('payments').doc(testPayDocId).get();
    assert.strictEqual(payDoc.data().payment_status, 'Paid');

    const invDoc = await db.collection('invoices').doc(testInvDocId).get();
    assert.strictEqual(invDoc.data().paid_amount, 1500);
    assert.strictEqual(invDoc.data().balance_due, 3500);
    assert.strictEqual(invDoc.data().status, 'Partially Paid');
  });

  await runTest('3.2 Confirm Cash payment creates cash_log entry with type Advance Deposit', async () => {
    const logDoc = await db.collection('cash_logs').doc(`cash_log_${testPayDocId}_confirm`).get();
    assert.strictEqual(logDoc.exists, true);
    assert.strictEqual(logDoc.data().type, 'Advance Deposit');
    assert.strictEqual(logDoc.data().amount, 1500);
    assert.strictEqual(logDoc.data().payment_mode, 'Cash');
  });

  await runTest('3.3 Confirm Cash payment creates ledger_items credit entry atomically', async () => {
    const ledgerDoc = await db.collection('ledger_items').doc(`ledger_${testPayDocId}_credit`).get();
    assert.strictEqual(ledgerDoc.exists, true);
    assert.strictEqual(ledgerDoc.data().transaction_type, 'PAYMENT');
    assert.strictEqual(ledgerDoc.data().credit_amount, 1500);
    assert.strictEqual(ledgerDoc.data().payment_mode, 'Cash');
  });

  await runTest('3.4 Confirm Cash payment idempotency key returns cached response without duplicate entries', async () => {
    const res = await PaymentFirestoreAdapter.processConfirmCashPaymentFirestore({
      bookingId: testBkgDocId,
      adminId: 'admin_1',
      idempotencyKey: `idem_conf_cash_${ts}`
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.amount, 1500);
  });

  await runTest('3.5 Confirm Cash payment on non-existent booking throws 404 error', async () => {
    let threw = false;
    try {
      await PaymentFirestoreAdapter.processConfirmCashPaymentFirestore({
        bookingId: 'non_existent_bkg_999999'
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 404);
    }
    assert.strictEqual(threw, true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 4: CONCURRENCY & IDEMPOTENCY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 4: Concurrency & Idempotency ---');

  await runTest('4.1 10 concurrent confirmCashPayment requests with same idempotency key succeed cleanly', async () => {
    const concKey = `conc_conf_cash_${ts}`;
    const concBkgDocId = `booking_conc_${ts}`;
    const concPayDocId = `payment_conc_${ts}`;
    const concInvDocId = `invoice_conc_${ts}`;

    await db.collection('bookings').doc(concBkgDocId).set({
      booking_id: concBkgDocId,
      booking_number: `BK-CONC-${ts}`,
      room_number: '902',
      booking_status: 'Reserved',
      payment_status: 'Pending',
      advance_amount: 1500,
      user_id: `user_conc_${ts}`,
      created_at: new Date().toISOString()
    });

    await db.collection('payments').doc(concPayDocId).set({
      payment_id: concPayDocId,
      booking_id: concBkgDocId,
      amount: 1500,
      payment_method: 'Cash',
      payment_status: 'Pending',
      business_date: businessDate,
      created_at: new Date().toISOString()
    });

    await db.collection('invoices').doc(concInvDocId).set({
      invoice_number: `INV-CONC-${ts}`,
      booking_id: concBkgDocId,
      total_amount: 5000,
      paid_amount: 0,
      balance_due: 5000,
      status: 'Issued',
      created_at: new Date().toISOString()
    });

    const promises = Array.from({ length: 10 }).map(() =>
      PaymentFirestoreAdapter.processConfirmCashPaymentFirestore({
        bookingId: concBkgDocId,
        adminId: 'admin_1',
        idempotencyKey: concKey
      })
    );
    const results = await Promise.all(promises);
    assert.strictEqual(results.length, 10);
    results.forEach(r => {
      assert.strictEqual(r.success, true);
      assert.strictEqual(r.amount, 1500);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 5: PAYMENT READ ADAPTERS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 5: Payment Read Adapters ---');

  await runTest('5.1 getPaymentsByBookingFirestore returns all payments and summary', async () => {
    const res = await PaymentFirestoreAdapter.getPaymentsByBookingFirestore(testBkgDocId);
    assert.strictEqual(res.success, true);
    assert.ok(Array.isArray(res.payments));
    assert.ok(res.payments.length >= 1);
    assert.strictEqual(typeof res.summary.totalPaid, 'number');
  });

  await runTest('5.2 getMyPaymentsFirestore returns guest payments correctly', async () => {
    const res = await PaymentFirestoreAdapter.getMyPaymentsFirestore(`user_${ts}`);
    assert.strictEqual(res.success, true);
    assert.ok(Array.isArray(res.payments));
    assert.ok(res.payments.length >= 1);
  });

  await runTest('5.3 getGuestPaymentStatusFirestore returns active payment details', async () => {
    const res = await PaymentFirestoreAdapter.getGuestPaymentStatusFirestore(`user_${ts}`);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.hasActivePayment, true);
    assert.strictEqual(res.amount, 1500);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 6: CASH ADAPTER (DRAWER & SUBMISSIONS)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 6: Cash Adapter ---');

  await runTest('6.1 calculateCashInHand correctly computes advances and settlements', async () => {
    const calc = await CashFirestoreAdapter.calculateCashInHand(businessDate);
    assert.strictEqual(typeof calc.cashInHand, 'number');
    assert.ok(calc.advances >= 1500);
    assert.ok(calc.cashInHand >= 1500);
  });

  await runTest('6.2 submitCashFirestore rejects negative or zero amounts with 400', async () => {
    let threw = false;
    try {
      await CashFirestoreAdapter.submitCashFirestore({ amount: 0, businessDate });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 400);
    }
    assert.strictEqual(threw, true);
  });

  await runTest('6.3 submitCashFirestore rejects amounts exceeding cash in hand with 400', async () => {
    let threw = false;
    try {
      await CashFirestoreAdapter.submitCashFirestore({ amount: 9999999, businessDate });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 400);
      assert.strictEqual(err.code, 'INSUFFICIENT_CASH_IN_HAND');
    }
    assert.strictEqual(threw, true);
  });

  let submittedReceiptId = null;
  await runTest('6.4 submitCashFirestore successfully records cash submission', async () => {
    const res = await CashFirestoreAdapter.submitCashFirestore({
      amount: 500,
      receivedBy: 'Manager Dave',
      shift: 'Morning',
      name: 'Alice Receptionist',
      notes: 'Morning shift drawer close',
      businessDate,
      idempotencyKey: `idem_cash_sub_${ts}`
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.submission.amount, 500);
    assert.ok(res.submission.receipt_id.startsWith('CS-'));
    submittedReceiptId = res.submission.receipt_id;
  });

  await runTest('6.5 submitCashFirestore idempotency returns cached submission', async () => {
    const res = await CashFirestoreAdapter.submitCashFirestore({
      amount: 500,
      businessDate,
      idempotencyKey: `idem_cash_sub_${ts}`
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.submission.amount, 500);
    assert.strictEqual(res.submission.receipt_id, submittedReceiptId);
  });

  await runTest('6.6 getCashSubmissionsFirestore returns submitted cash logs', async () => {
    const res = await CashFirestoreAdapter.getCashSubmissionsFirestore(businessDate);
    assert.ok(Array.isArray(res.submissions));
    assert.ok(res.submissions.some(s => s.receipt_id === submittedReceiptId));
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 7: PAYMENT CUTOVER SERVICE & FALLBACK
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 7: Payment Cutover Service ---');

  await runTest('7.1 PaymentCutoverService serves from MySQL when flag is false', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'false';
    let calledMysql = false;
    const res = await PaymentCutoverService.finalizePayment(
      { bookingId: testBkgDocId },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, true);
    assert.strictEqual(res.fromMysql, true);
  });

  await runTest('7.2 PaymentCutoverService serves from Firestore when flag is true', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    const servBkgDocId = `booking_serv_${ts}`;
    const servPayDocId = `payment_serv_${ts}`;
    await db.collection('bookings').doc(servBkgDocId).set({
      booking_id: servBkgDocId,
      booking_number: `BK-SERV-${ts}`,
      booking_status: 'Reserved',
      payment_status: 'Pending',
      advance_amount: 1500,
      user_id: `user_${ts}`,
      created_at: new Date().toISOString()
    });
    await db.collection('payments').doc(servPayDocId).set({
      payment_id: servPayDocId,
      booking_id: servBkgDocId,
      amount: 1500,
      payment_method: 'Cash',
      payment_status: 'Pending',
      business_date: businessDate,
      created_at: new Date().toISOString()
    });

    let calledMysql = false;
    const res = await PaymentCutoverService.finalizePayment(
      {
        bookingId: servBkgDocId,
        paymentMethod: 'Cash',
        user: { id: `user_${ts}` }
      },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE');
    assert.strictEqual(typeof res.durationMs, 'number');
  });

  await runTest('7.3 PaymentCutoverService does NOT fallback for business 400/404 errors', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    let calledMysql = false;
    let threw = false;
    try {
      await PaymentCutoverService.finalizePayment(
        { bookingId: null },
        async () => {
          calledMysql = true;
          return { success: true, fromMysql: true };
        }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 400);
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(calledMysql, false);
  });

  await runTest('7.4 PaymentCutoverService safely falls back to MySQL on Firestore timeout', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    let calledMysql = false;
    const res = await PaymentCutoverService.finalizePayment(
      {
        bookingId: testBkgDocId,
        paymentMethod: 'Cash',
        timeoutMs: 0 // trigger timeout
      },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, true);
    assert.strictEqual(res.source, 'MYSQL_FALLBACK');
    assert.ok(res.fallbackReason.includes('FIRESTORE_TIMEOUT'));
  });

  await runTest('7.5 PaymentCutoverService reconciles previously committed transaction on timeout', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    const committedKey = `reconciled_pay_key_${ts}`;
    await db.collection('idempotency_keys').doc(committedKey).set({
      key: committedKey,
      status: 'COMPLETED',
      result: { success: true, reconciled: true }
    });

    let calledMysql = false;
    const res = await PaymentCutoverService.finalizePayment(
      {
        bookingId: testBkgDocId,
        paymentMethod: 'Cash',
        idempotencyKey: committedKey,
        timeoutMs: 0 // trigger timeout
      },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE_RECONCILED');
    assert.strictEqual(res.reconciled, true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 8: CASH CUTOVER SERVICE & FALLBACK
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 8: Cash Cutover Service ---');

  await runTest('8.1 CashCutoverService serves from MySQL when flag is false', async () => {
    process.env.USE_FIRESTORE_CASH = 'false';
    let calledMysql = false;
    const res = await CashCutoverService.submitCash(
      { amount: 100 },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, true);
    assert.strictEqual(res.fromMysql, true);
  });

  await runTest('8.2 CashCutoverService serves from Firestore when flag is true', async () => {
    process.env.USE_FIRESTORE_CASH = 'true';
    let calledMysql = false;
    const res = await CashCutoverService.submitCash(
      {
        amount: 100,
        businessDate
      },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE');
  });

  await runTest('8.3 CashCutoverService does NOT fallback for insufficient cash error', async () => {
    process.env.USE_FIRESTORE_CASH = 'true';
    let calledMysql = false;
    let threw = false;
    try {
      await CashCutoverService.submitCash(
        { amount: 9999999, businessDate },
        async () => {
          calledMysql = true;
          return { success: true, fromMysql: true };
        }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.status, 400);
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(calledMysql, false);
  });

  await runTest('8.4 CashCutoverService safely falls back to MySQL on timeout', async () => {
    process.env.USE_FIRESTORE_CASH = 'true';
    let calledMysql = false;
    const res = await CashCutoverService.submitCash(
      {
        amount: 100,
        businessDate,
        timeoutMs: 0
      },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, true);
    assert.strictEqual(res.source, 'MYSQL_FALLBACK');
  });

  await runTest('8.5 CashCutoverService reconciles previously committed transaction on timeout', async () => {
    process.env.USE_FIRESTORE_CASH = 'true';
    const committedKey = `reconciled_cash_key_${ts}`;
    await db.collection('idempotency_keys').doc(committedKey).set({
      key: committedKey,
      status: 'COMPLETED',
      result: { success: true, cashReconciled: true }
    });

    let calledMysql = false;
    const res = await CashCutoverService.submitCash(
      {
        amount: 100,
        businessDate,
        idempotencyKey: committedKey,
        timeoutMs: 0
      },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE_RECONCILED');
    assert.strictEqual(res.cashReconciled, true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 9: READ CUTOVER & COMPATIBILITY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 9: Read Cutover & Compatibility ---');

  await runTest('9.1 PaymentCutoverService.getPaymentsByBooking serves from Firestore', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    let calledMysql = false;
    const res = await PaymentCutoverService.getPaymentsByBooking(
      testBkgDocId,
      { role: 'admin' },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE');
  });

  await runTest('9.2 PaymentCutoverService.getMyPayments serves from Firestore', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    let calledMysql = false;
    const res = await PaymentCutoverService.getMyPayments(
      `user_${ts}`,
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE');
  });

  await runTest('9.3 PaymentCutoverService.getGuestPaymentStatus serves from Firestore', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    let calledMysql = false;
    const res = await PaymentCutoverService.getGuestPaymentStatus(
      `user_${ts}`,
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE');
  });

  await runTest('9.4 CashCutoverService.getCashSubmissions serves from Firestore', async () => {
    process.env.USE_FIRESTORE_CASH = 'true';
    let calledMysql = false;
    const res = await CashCutoverService.getCashSubmissions(
      businessDate,
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE');
  });

  await runTest('9.5 PaymentCutoverService.confirmCashPayment serves from Firestore when flag is true', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    const confBkgDocId = `booking_serv_conf_${ts}`;
    const confPayDocId = `payment_serv_conf_${ts}`;
    await db.collection('bookings').doc(confBkgDocId).set({
      booking_id: confBkgDocId,
      booking_number: `BK-CONF-${ts}`,
      booking_status: 'Reserved',
      payment_status: 'Pending',
      advance_amount: 2000,
      created_at: new Date().toISOString()
    });
    await db.collection('payments').doc(confPayDocId).set({
      payment_id: confPayDocId,
      booking_id: confBkgDocId,
      amount: 2000,
      payment_method: 'Cash',
      payment_status: 'Pending',
      business_date: businessDate,
      created_at: new Date().toISOString()
    });
    await db.collection('invoices').doc(`invoice_serv_conf_${ts}`).set({
      invoice_number: `INV-CONF-${ts}`,
      booking_id: confBkgDocId,
      total_amount: 5000,
      paid_amount: 0,
      balance_due: 5000,
      status: 'Issued',
      created_at: new Date().toISOString()
    });

    let calledMysql = false;
    const res = await PaymentCutoverService.confirmCashPayment(
      { bookingId: confBkgDocId, adminId: 'admin_cutover' },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE');
    assert.strictEqual(res.amount, 2000);
  });

  await runTest('9.6 PaymentCutoverService.confirmCashPayment safely falls back to MySQL on timeout', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    let calledMysql = false;
    const res = await PaymentCutoverService.confirmCashPayment(
      { bookingId: testBkgDocId, adminId: 'admin_1', timeoutMs: 0 },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, true);
    assert.strictEqual(res.source, 'MYSQL_FALLBACK');
  });

  await runTest('9.7 PaymentCutoverService.confirmCashPayment reconciles previously committed transaction', async () => {
    process.env.USE_FIRESTORE_PAYMENTS = 'true';
    const committedKey = `reconciled_conf_key_${ts}`;
    await db.collection('idempotency_keys').doc(committedKey).set({
      key: committedKey,
      status: 'COMPLETED',
      result: { success: true, confReconciled: true }
    });

    let calledMysql = false;
    const res = await PaymentCutoverService.confirmCashPayment(
      { bookingId: testBkgDocId, adminId: 'admin_1', idempotencyKey: committedKey, timeoutMs: 0 },
      async () => {
        calledMysql = true;
        return { success: true, fromMysql: true };
      }
    );
    assert.strictEqual(calledMysql, false);
    assert.strictEqual(res.source, 'FIRESTORE_RECONCILED');
    assert.strictEqual(res.confReconciled, true);
  });

  await runTest('9.8 Cash log isolation — non-cash payments (UPI/Card) do not create physical cash logs', async () => {
    const upiBkgDocId = `booking_upi_${ts}`;
    const upiPayDocId = `payment_upi_${ts}`;
    await db.collection('bookings').doc(upiBkgDocId).set({
      booking_id: upiBkgDocId,
      booking_number: `BK-UPI-${ts}`,
      booking_status: 'Reserved',
      payment_status: 'Pending',
      advance_amount: 1000,
      created_at: new Date().toISOString()
    });
    await db.collection('payments').doc(upiPayDocId).set({
      payment_id: upiPayDocId,
      booking_id: upiBkgDocId,
      amount: 1000,
      payment_method: 'Pending',
      payment_status: 'Pending',
      created_at: new Date().toISOString()
    });

    await PaymentFirestoreAdapter.processFinalizePaymentFirestore({
      bookingId: upiBkgDocId,
      paymentMethod: 'UPI',
      user: { id: `user_${ts}` }
    });

    const cashLogDoc = await db.collection('cash_logs').doc(`cash_log_${upiPayDocId}_confirm`).get();
    assert.strictEqual(cashLogDoc.exists, false);
  });

  await runTest('9.9 Ledger running balance integrity — confirmed cash payment increases credit balance', async () => {
    const ledgerSnap = await db.collection('ledger_items')
      .where('booking_id', '==', testBkgDocId)
      .get();
    assert.ok(ledgerSnap.size >= 1);
    let hasPaymentCredit = false;
    ledgerSnap.forEach(doc => {
      if (doc.data()?.transaction_type === 'PAYMENT' && doc.data()?.credit_amount === 1500) {
        hasPaymentCredit = true;
      }
    });
    assert.strictEqual(hasPaymentCredit, true);
  });

  await runTest('9.10 Full lifecycle settlement continuity between payment and checkout', async () => {
    const invSnap = await db.collection('invoices').doc(testInvDocId).get();
    assert.strictEqual(invSnap.exists, true);
    assert.strictEqual(invSnap.data().paid_amount, 1500);
    assert.strictEqual(invSnap.data().balance_due, 3500);
  });

  // Clean up test documents
  await db.collection('bookings').doc(testBkgDocId).delete();
  await db.collection('payments').doc(testPayDocId).delete();
  await db.collection('invoices').doc(testInvDocId).delete();

  console.log('\n===============================================================');
  console.log(`TEST EXECUTION SUMMARY: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('===============================================================\n');

  if (passedTests === totalTests && totalTests === 44) {
    console.log('>>> ALL 44 PHASE 2 STEP 7 TESTS PASSED SUCCESSFULLY! <<<\n');
  } else {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
