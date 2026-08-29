import { db, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import pool from '../db.js';
import { FirestoreLedgerService } from '../services/firestoreLedgerService.js';
import { LedgerCutoverService } from '../services/ledgerCutoverService.js';
import {
  isFirestoreLedgerServingEnabled,
  isFirestoreCheckInServingEnabled,
  isFirestoreCheckOutServingEnabled,
  isFirestoreAvailabilityServingEnabled,
  isFirestoreRoomStatusServingEnabled,
  isFirestoreReportsServingEnabled
} from '../config/featureFlags.js';

async function runLedgerCutoverTestSuite() {
  console.log('========================================================================');
  console.log('  HPMS PHASE 2 STEP 6: CONTROLLED LEDGER/FOLIO CUTOVER TEST SUITE');
  console.log('========================================================================\n');

  if (!isFirebaseConfigured || !db) {
    console.log('⚠️ Firebase Admin SDK is not configured. Skipping test.');
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;
  const createdTestDocs = [];

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASSED: ${message}`);
      passed++;
    } else {
      console.error(`  ✕ FAILED: ${message}`);
      failed++;
    }
  }

  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 7);
  const tag = `step6_${timestamp}_${rand}`;

  // Unique isolated keys
  const roomNum1 = `921`;
  const roomNum2 = `922`;
  const roomNum3 = `923`;
  const roomDoc1 = `room_${roomNum1}`;
  const roomDoc2 = `room_${roomNum2}`;
  const roomDoc3 = `room_${roomNum3}`;

  const bkgId1 = `bkg_${tag}_1`;
  const bkgId2 = `bkg_${tag}_2`;

  try {
    console.log('--- Step 1: Feature Flag & Authority Verification ---');
    assert(typeof isFirestoreLedgerServingEnabled() === 'boolean', 'Ledger Flag: USE_FIRESTORE_LEDGER is configured');
    assert(isFirestoreCheckInServingEnabled() === true, 'Cutover State: USE_FIRESTORE_CHECKIN is TRUE');
    assert(isFirestoreCheckOutServingEnabled() === true, 'Cutover State: USE_FIRESTORE_CHECKOUT is TRUE');
    assert(isFirestoreRoomStatusServingEnabled() === true, 'Cutover State: USE_FIRESTORE_ROOM_STATUS is TRUE');
    assert(isFirestoreAvailabilityServingEnabled() === true, 'Cutover State: USE_FIRESTORE_AVAILABILITY is TRUE');
    assert(isFirestoreReportsServingEnabled() === false, 'Cutover Invariant: USE_FIRESTORE_REPORTS is strictly FALSE');

    console.log('\n--- Step 2: Setting Up Isolated Firestore Cutover Fixtures ---');

    // Room 921: Occupied with active Checked In booking & comprehensive ledger
    await db.collection('rooms').doc(roomDoc1).set({
      number: roomNum1,
      type: 'DELUXE',
      status: 'occupied',
      current_booking_id: bkgId1,
      housekeeping_status: 'Clean',
      is_active: true,
      price: 3500,
      rate: 3500,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: roomDoc1 });

    await db.collection('bookings').doc(bkgId1).set({
      booking_number: `BKG-921-${rand}`,
      room_number: roomNum1,
      guest_name: 'VIKRAM MALHOTRA',
      phone: '9888877777',
      advance_amount: 1500,
      total_amount: 8500,
      room_tariff: 3500,
      booking_status: 'Checked In',
      check_in_date: '2026-08-18',
      expected_check_out_date: '2026-08-20',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'bookings', id: bkgId1 });

    // Item 1: Initial Room Tariff Charge (Debit 3500)
    const ledgerDoc1 = `ledger_${bkgId1}_1`;
    await db.collection('ledger_items').doc(ledgerDoc1).set({
      booking_id: bkgId1,
      room_number: roomNum1,
      desc: 'Room Tariff (Night 1, Incl. GST)',
      amount: 3500,
      credit_amount: 0,
      transaction_type: 'CHARGE',
      business_date: '2026-08-18',
      created_at: '2026-08-18T10:00:00.000Z'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledgerDoc1 });

    // Item 2: Check-in Advance Deposit (Credit 1500)
    const ledgerDoc2 = `ledger_${bkgId1}_2`;
    await db.collection('ledger_items').doc(ledgerDoc2).set({
      booking_id: bkgId1,
      room_number: roomNum1,
      desc: 'Check-in Advance Deposit (UPI)',
      amount: 0,
      credit_amount: 1500,
      transaction_type: 'CHECKIN_DEPOSIT',
      payment_mode: 'UPI',
      business_date: '2026-08-18',
      created_at: '2026-08-18T10:05:00.000Z'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledgerDoc2 });

    // Item 3: Rollover Night 2 (Debit 3500)
    const ledgerDoc3 = `ledger_${bkgId1}_3`;
    await db.collection('ledger_items').doc(ledgerDoc3).set({
      booking_id: bkgId1,
      room_number: roomNum1,
      desc: 'Room Tariff (Rollover, Incl. GST)',
      amount: 3500,
      credit_amount: 0,
      transaction_type: 'ROLLOVER',
      business_date: '2026-08-19',
      created_at: '2026-08-19T00:05:00.000Z'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledgerDoc3 });

    // Item 4: Room Service Charge (Debit 500)
    const ledgerDoc4 = `ledger_${bkgId1}_4`;
    await db.collection('ledger_items').doc(ledgerDoc4).set({
      booking_id: bkgId1,
      room_number: roomNum1,
      desc: 'Room Service Dinner',
      amount: 500,
      credit_amount: 0,
      transaction_type: 'CHARGE',
      business_date: '2026-08-19',
      created_at: '2026-08-19T20:30:00.000Z'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledgerDoc4 });

    // Item 5: Mid-stay Cash Payment (Credit 2000)
    const ledgerDoc5 = `ledger_${bkgId1}_5`;
    await db.collection('ledger_items').doc(ledgerDoc5).set({
      booking_id: bkgId1,
      room_number: roomNum1,
      desc: 'Interim Cash Payment',
      amount: 0,
      credit_amount: 2000,
      transaction_type: 'PAYMENT',
      payment_mode: 'Cash',
      business_date: '2026-08-19',
      created_at: '2026-08-19T21:00:00.000Z'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledgerDoc5 });

    // Room 922: Occupied room with zero ledger items (Empty folio)
    await db.collection('rooms').doc(roomDoc2).set({
      number: roomNum2,
      type: 'STANDARD',
      status: 'occupied',
      current_booking_id: bkgId2,
      housekeeping_status: 'Clean',
      is_active: true,
      price: 2000,
      rate: 2000,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: roomDoc2 });

    await db.collection('bookings').doc(bkgId2).set({
      booking_number: `BKG-922-${rand}`,
      room_number: roomNum2,
      guest_name: 'POOJA JOSHI',
      advance_amount: 0,
      booking_status: 'Checked In',
      check_in_date: '2026-08-19',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'bookings', id: bkgId2 });

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 1: Folio Topologies & Running Balance Parity (Scenarios 1-15)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 1: Folio Topologies & Running Balance Parity (Scenarios 1-15) ---');

    const folio1 = await FirestoreLedgerService.getRoomLedger(roomNum1);

    // 1. Booking Resolution
    assert(folio1.booking && folio1.booking.guest_name === 'VIKRAM MALHOTRA', 'TEST 1: Active checked-in booking resolved correctly for room');

    // 2. Total Charges (3500 + 3500 + 500 = 7500)
    assert(folio1.summary.totalCharges === 7500, `TEST 2: Total charges sum debits correctly (Expected 7500, Got ${folio1.summary.totalCharges})`);

    // 3. Total Payments (1500 + 2000 = 3500)
    assert(folio1.summary.totalPayments === 3500, `TEST 3: Total payments sum credits correctly (Expected 3500, Got ${folio1.summary.totalPayments})`);

    // 4. Outstanding Balance (7500 - 3500 = 4000)
    assert(folio1.summary.outstanding === 4000, `TEST 4: Outstanding balance = totalCharges - totalPayments (4000)`);

    // 5. Running Balance Verification Row-by-Row
    // Row 1: +3500 -> 3500
    // Row 2: -1500 -> 2000
    // Row 3: +3500 -> 5500
    // Row 4: +500  -> 6000
    // Row 5: -2000 -> 4000
    assert(folio1.ledger.length === 5, 'TEST 5: All 5 ledger rows retrieved');
    assert(folio1.ledger[0].balance === 3500, 'TEST 6: Row 1 running balance is 3500');
    assert(folio1.ledger[1].balance === 2000, 'TEST 7: Row 2 running balance is 2000');
    assert(folio1.ledger[2].balance === 5500, 'TEST 8: Row 3 running balance is 5500');
    assert(folio1.ledger[3].balance === 6000, 'TEST 9: Row 4 running balance is 6000');
    assert(folio1.ledger[4].balance === 4000, 'TEST 10: Row 5 running balance is 4000');

    // 11. Transaction Types Preservation
    const types = folio1.ledger.map(i => i.transaction_type);
    assert(types.includes('CHARGE') && types.includes('CHECKIN_DEPOSIT') && types.includes('ROLLOVER') && types.includes('PAYMENT'), 'TEST 11: Preserves CHARGE, CHECKIN_DEPOSIT, ROLLOVER, and PAYMENT transaction types');

    // 12. Payment Mode Preservation
    assert(folio1.ledger[1].payment_mode === 'UPI' && folio1.ledger[4].payment_mode === 'Cash', 'TEST 12: Preserves UPI and Cash payment modes on credit rows');

    // 13. Empty Folio Handling (Room 922)
    const emptyFolio = await FirestoreLedgerService.getRoomLedger(roomNum2);
    assert(emptyFolio.booking && emptyFolio.ledger.length === 0 && emptyFolio.summary.outstanding === 0, 'TEST 13: Empty folio returns clean 0 summary with booking header');

    // 14. Non-existent Room Handling
    const nonExistentFolio = await FirestoreLedgerService.getRoomLedger('9999_nonexistent');
    assert(nonExistentFolio.booking === null && nonExistentFolio.summary.outstanding === 0, 'TEST 14: Non-existent room returns null booking and zero summary');

    // 15. Dynamic Adjustments & Refunds Posting
    const adj = await FirestoreLedgerService.addLedgerItem({
      room_number: roomNum1,
      desc: 'Manager Courtesy Discount',
      amount: 0,
      credit_amount: 500,
      transaction_type: 'ADJUSTMENT',
      booking_id: bkgId1
    });
    createdTestDocs.push({ collection: 'ledger_items', id: adj.id });

    const updatedFolio1 = await FirestoreLedgerService.getRoomLedger(roomNum1);
    assert(updatedFolio1.summary.totalPayments === 4000 && updatedFolio1.summary.outstanding === 3500, 'TEST 15: Posting adjustment credit updates total payments and outstanding balance accurately');

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 2: Controlled Serving & Emergency Fallback (Scenarios 16-24)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 2: Controlled Serving & Emergency Fallback (Scenarios 16-24) ---');

    process.env.USE_FIRESTORE_LEDGER = 'true';

    // 16. Primary Firestore Serving
    const servingRes = await LedgerCutoverService.getLedgerWithFallback(roomNum1);
    assert(servingRes && servingRes.source === 'FIRESTORE' && servingRes.summary.outstanding === 3500, 'TEST 16: Primary serving returns Firestore ledger with source = FIRESTORE');

    // 17. Business Error (Room with no active booking throws 404, does NOT fallback)
    const room924Doc = `room_924`;
    await db.collection('rooms').doc(room924Doc).set({ number: '924', status: 'vacant', housekeeping_status: 'Clean', is_active: true });
    createdTestDocs.push({ collection: 'rooms', id: room924Doc });

    let threw404 = false;
    try {
      await LedgerCutoverService.getLedgerWithFallback('924');
    } catch (err) {
      if (err.status === 404 || err.code === 'BOOKING_NOT_FOUND') threw404 = true;
    }
    assert(threw404, 'TEST 17: Vacant room with no active booking throws HTTP 404 without invoking fallback');

    // 18. Firestore Timeout Safely Fails Closed Without MySQL Fallback
    let timeoutThrew = false;
    try {
      await LedgerCutoverService.getLedgerWithFallback(roomNum1, { timeoutMs: 1 });
    } catch (err) {
      if (err.message && err.message.includes('FIRESTORE_TIMEOUT')) {
        timeoutThrew = true;
      }
    }
    assert(timeoutThrew, 'TEST 18: Firestore timeout safely fails closed without invoking MySQL fallback');

    // 19. Disabling Firestore Ledger Serving Fails Closed under Decommission Guard
    const prevFlag = process.env.USE_FIRESTORE_LEDGER;
    let guardBlocked = false;
    try {
      process.env.USE_FIRESTORE_LEDGER = 'false';
      await LedgerCutoverService.getLedgerWithFallback(roomNum1);
    } catch (err) {
      if (err.code === 'ER_MYSQL_DECOMMISSIONED' || (err.message && err.message.includes('MYSQL_DECOMMISSIONED_GUARD'))) {
        guardBlocked = true;
      }
    } finally {
      process.env.USE_FIRESTORE_LEDGER = prevFlag;
    }
    assert(guardBlocked, 'TEST 19: Disabling Firestore Ledger flag fails closed under MYSQL_DECOMMISSIONED_GUARD');

    // 20. Output Contract Shape Validation
    assert(servingRes.hasOwnProperty('booking') && servingRes.hasOwnProperty('ledger') && servingRes.hasOwnProperty('summary'), 'TEST 20: Output contract matches { booking, ledger, summary }');

    // 21. Summary Mathematics Integrity
    assert(Math.abs(servingRes.summary.outstanding - (servingRes.summary.totalCharges - servingRes.summary.totalPayments)) < 0.01, 'TEST 21: Summary strictly satisfies outstanding = totalCharges - totalPayments');

    // 22. Production Cutover Invariant Assertion
    assert(process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS === 'true', 'TEST 22: Production cutover invariant: DISABLE_MYSQL_CUTOVER_FALLBACKS is strictly TRUE with MySQL decommissioned');

  } catch (err) {
    console.error('Unhandled cutover test suite error:', err);
    failed++;
  } finally {
    console.log('\n--- Test Document Cleanup ---');
    for (const doc of createdTestDocs) {
      try {
        await db.collection(doc.collection).doc(doc.id).delete();
        console.log(`  ✓ Cleaned test doc: /${doc.collection}/${doc.id}`);
      } catch (cleanErr) {
        console.warn(`  ⚠️ Failed to delete test doc /${doc.collection}/${doc.id}:`, cleanErr.message);
      }
    }
  }

  console.log('\n========================================================================');
  console.log(`  LEDGER CUTOVER TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runLedgerCutoverTestSuite();
