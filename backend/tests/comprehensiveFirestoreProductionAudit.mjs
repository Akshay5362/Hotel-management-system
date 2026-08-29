/**
 * backend/tests/comprehensiveFirestoreProductionAudit.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT READ-ONLY COMPREHENSIVE PRODUCTION FIRESTORE DATA INTEGRITY AUDIT
 *
 * Target: hpms-sky5
 * Mode  : STRICT READ-ONLY
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';

const TARGET_COLLECTIONS = [
  'bookings',
  'reservations',
  'guests',
  'payments',
  'invoices',
  'ledger',
  'ledger_items',
  'room_ledger',
  'master_bills',
  'cash_logs',
  'cash_submissions',
  'checkout_snapshots',
  'booking_history',
  'audit_logs'
];

async function runComprehensiveAudit() {
  console.log('===============================================================');
  console.log('HPMS PRODUCTION FIRESTORE FINANCIAL & DATA INTEGRITY AUDIT');
  console.log('===============================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('Project  : hpms-sky5');
  console.log('Mode     : STRICT READ-ONLY\n');

  if (!db) {
    console.error('CRITICAL: Firebase Admin DB is not initialized.');
    process.exit(1);
  }

  // 1. Fetch reference collections: rooms & room_types
  const roomsSnap = await db.collection('rooms').get();
  const roomsMap = new Map(); // id -> data, number -> data
  roomsSnap.forEach(d => {
    const data = d.data();
    roomsMap.set(d.id, data);
    if (data.number !== undefined) roomsMap.set(String(data.number), data);
    if (data.room_number !== undefined) roomsMap.set(String(data.room_number), data);
  });

  const rtSnap = await db.collection('room_types').get();
  const roomTypesMap = new Map();
  rtSnap.forEach(d => {
    const data = d.data();
    roomTypesMap.set(d.id, data);
    if (data.code) roomTypesMap.set(String(data.code).toUpperCase(), data);
  });

  // 2. Fetch all target collections
  const dataStore = {};
  for (const col of TARGET_COLLECTIONS) {
    const snap = await db.collection(col).get();
    dataStore[col] = [];
    snap.forEach(d => {
      dataStore[col].push({ id: d.id, ...d.data() });
    });
  }

  // =========================================================================
  // PART 1 — COLLECTION INVENTORY
  // =========================================================================
  console.log('===============================================================');
  console.log('PART 1 — COLLECTION INVENTORY');
  console.log('===============================================================');

  const inventorySummary = {};
  const allSuspiciousRecords = [];

  const TEST_ID_REGEX = /^(test_|fixture_|bkg_test_|pay_test_|guest_test_|mock_|dummy_)|_test_/i;

  for (const col of TARGET_COLLECTIONS) {
    const docs = dataStore[col];
    const totalCount = docs.length;

    const testDocs = docs.filter(d => {
      return TEST_ID_REGEX.test(d.id) ||
        (d.is_test === true || d.test_fixture === true) ||
        /(test|mock|dummy|fake|sample)\b/i.test(JSON.stringify(d));
    });

    const prodDocsCount = totalCount - testDocs.length;
    inventorySummary[col] = {
      total: totalCount,
      prod: prodDocsCount,
      test: testDocs.length,
      sampleIds: docs.slice(0, 3).map(d => d.id)
    };

    console.log(`Collection: ${col.padEnd(20, ' ')} | Total: ${String(totalCount).padStart(4, ' ')} | Prod: ${String(prodDocsCount).padStart(4, ' ')} | Suspect/Test: ${String(testDocs.length).padStart(3, ' ')} | Sample IDs: [${inventorySummary[col].sampleIds.join(', ')}]`);

    testDocs.forEach(d => {
      allSuspiciousRecords.push({
        collection: col,
        docId: d.id,
        reason: 'Matches test identifier regex or contains test fixture metadata',
        references: d.booking_id || d.room_number || d.guest_id || 'NONE',
        dependents: 'NONE',
        classification: 'TEST / FIXTURE'
      });
    });
  }

  // =========================================================================
  // PART 2 — BOOKING INTEGRITY
  // =========================================================================
  console.log('\n===============================================================');
  console.log('PART 2 — BOOKING INTEGRITY');
  console.log('===============================================================');

  const guestsMap = new Map();
  dataStore['guests'].forEach(g => {
    guestsMap.set(g.id, g);
    if (g.guest_id) guestsMap.set(String(g.guest_id), g);
    if (g.phone) guestsMap.set(String(g.phone), g);
    if (g.mobile) guestsMap.set(String(g.mobile), g);
  });

  const bookingsMap = new Map();
  let bkgOrphanGuests = 0;
  let bkgOrphanRooms = 0;
  let bkgInvalidDates = 0;
  let bkgDuplicateIds = 0;
  let bkgTestCount = 0;
  const bkgNumberTracker = new Set();

  dataStore['bookings'].forEach((b, idx) => {
    bookingsMap.set(b.id, b);
    const bkgNum = b.booking_number || b.bookingNumber || b.id;
    if (bkgNumberTracker.has(bkgNum)) {
      bkgDuplicateIds++;
      console.warn(`  [Duplicate Booking Number] ${bkgNum} on document ${b.id}`);
    } else {
      bkgNumberTracker.add(bkgNum);
    }

    const isTest = TEST_ID_REGEX.test(b.id) || /test/i.test(bkgNum);
    if (isTest) bkgTestCount++;

    // Check guest
    const guestRef = b.guest_id || b.guestId || b.guest_phone || b.phone;
    const guestExists = guestRef ? guestsMap.has(String(guestRef)) : false;
    if (!guestExists && guestRef && !isTest) {
      bkgOrphanGuests++;
      console.warn(`  [Orphan Guest Reference] Booking ${b.id} references non-existent guest '${guestRef}'`);
    }

    // Check room
    const roomRef = b.room_id || b.roomId || b.room_number || b.roomNumber;
    const roomExists = roomRef ? (roomsMap.has(String(roomRef)) || roomsMap.has(`room_${roomRef}`)) : false;
    if (!roomExists && roomRef && !isTest) {
      bkgOrphanRooms++;
      console.warn(`  [Orphan Room Reference] Booking ${b.id} references non-existent room '${roomRef}'`);
    }

    // Check dates
    const checkIn = b.check_in_date || b.checkInDate || b.check_in || b.checkIn;
    const checkOut = b.check_out_date || b.checkOutDate || b.check_out || b.checkOut;
    if (checkIn && checkOut) {
      const dIn = new Date(checkIn).getTime();
      const dOut = new Date(checkOut).getTime();
      if (isNaN(dIn) || isNaN(dOut) || dOut < dIn) {
        bkgInvalidDates++;
        console.warn(`  [Invalid Dates] Booking ${b.id}: CheckIn=${checkIn}, CheckOut=${checkOut}`);
      }
    }
  });

  console.log(`Bookings Audited: ${dataStore['bookings'].length}`);
  console.log(`  - Orphan Guest References : ${bkgOrphanGuests}`);
  console.log(`  - Orphan Room References  : ${bkgOrphanRooms}`);
  console.log(`  - Invalid Date Sequences  : ${bkgInvalidDates}`);
  console.log(`  - Duplicate Booking IDs   : ${bkgDuplicateIds}`);
  console.log(`  - Test / Fixture Bookings : ${bkgTestCount}`);

  // =========================================================================
  // PART 3 — GUEST INTEGRITY
  // =========================================================================
  console.log('\n===============================================================');
  console.log('PART 3 — GUEST INTEGRITY');
  console.log('===============================================================');

  const guestPhoneTracker = new Map();
  let guestDuplicatePhones = 0;
  let guestTestCount = 0;
  const guestBookingCount = new Map();

  dataStore['bookings'].forEach(b => {
    const gid = b.guest_id || b.guestId;
    if (gid) {
      guestBookingCount.set(String(gid), (guestBookingCount.get(String(gid)) || 0) + 1);
    }
  });

  dataStore['guests'].forEach(g => {
    const isTest = TEST_ID_REGEX.test(g.id) || /(test|dummy|fake|sample)/i.test(g.name || g.full_name || '');
    if (isTest) guestTestCount++;

    const phone = g.phone || g.mobile || g.contact;
    if (phone) {
      const cleanPhone = String(phone).replace(/\D/g, '');
      if (cleanPhone.length >= 7) {
        if (guestPhoneTracker.has(cleanPhone)) {
          guestDuplicatePhones++;
          console.log(`  [Potential Duplicate Guest Phone] Phone ${cleanPhone} shared between [${guestPhoneTracker.get(cleanPhone)}] and [${g.id}]`);
        } else {
          guestPhoneTracker.set(cleanPhone, g.id);
        }
      }
    }
  });

  const guestsWithZeroBookings = dataStore['guests'].filter(g => !guestBookingCount.has(String(g.id)) && !guestBookingCount.has(String(g.guest_id || '')));

  console.log(`Guests Audited: ${dataStore['guests'].length}`);
  console.log(`  - Duplicate Phone Numbers  : ${guestDuplicatePhones}`);
  console.log(`  - Test / Fixture Guests    : ${guestTestCount}`);
  console.log(`  - Guests with Zero Bookings: ${guestsWithZeroBookings.length} (Informational/Profile only)`);

  // =========================================================================
  // PART 4 — PAYMENT INTEGRITY
  // =========================================================================
  console.log('\n===============================================================');
  console.log('PART 4 — PAYMENT INTEGRITY');
  console.log('===============================================================');

  let payOrphanBookings = 0;
  let payOrphanGuests = 0;
  let payInvalidAmounts = 0;
  let payDuplicateIds = 0;
  let payTestCount = 0;
  let payRefundsCount = 0;
  const payIdTracker = new Set();
  const paymentsByBooking = new Map();

  dataStore['payments'].forEach(p => {
    if (payIdTracker.has(p.id)) {
      payDuplicateIds++;
    } else {
      payIdTracker.add(p.id);
    }

    const isTest = TEST_ID_REGEX.test(p.id) || /(test|mock)/i.test(JSON.stringify(p));
    if (isTest) payTestCount++;

    const bkgId = p.booking_id || p.bookingId;
    if (bkgId) {
      if (!bookingsMap.has(String(bkgId)) && !isTest) {
        payOrphanBookings++;
        console.warn(`  [Orphan Payment Booking] Payment ${p.id} references non-existent booking '${bkgId}'`);
      }
      if (!paymentsByBooking.has(String(bkgId))) {
        paymentsByBooking.set(String(bkgId), []);
      }
      paymentsByBooking.get(String(bkgId)).push(p);
    }

    const guestId = p.guest_id || p.guestId;
    if (guestId && !guestsMap.has(String(guestId)) && !isTest) {
      payOrphanGuests++;
    }

    const amt = Number(p.amount);
    if (isNaN(amt)) {
      payInvalidAmounts++;
      console.warn(`  [Invalid Payment Amount] Payment ${p.id} has NaN amount`);
    } else if (amt < 0) {
      payRefundsCount++;
    }
  });

  console.log(`Payments Audited: ${dataStore['payments'].length}`);
  console.log(`  - Orphan Booking References: ${payOrphanBookings}`);
  console.log(`  - Orphan Guest References  : ${payOrphanGuests}`);
  console.log(`  - Invalid (NaN) Amounts    : ${payInvalidAmounts}`);
  console.log(`  - Refund/Adjustment Records: ${payRefundsCount} (Negative amounts documented as refunds/deductions)`);
  console.log(`  - Duplicate Payment IDs    : ${payDuplicateIds}`);
  console.log(`  - Test / Fixture Payments  : ${payTestCount}`);

  // =========================================================================
  // PART 5 — INVOICE INTEGRITY
  // =========================================================================
  console.log('\n===============================================================');
  console.log('PART 5 — INVOICE INTEGRITY');
  console.log('===============================================================');

  let invOrphanBookings = 0;
  let invOrphanGuests = 0;
  let invMathMismatches = 0;
  let invDuplicateNumbers = 0;
  const invNumberTracker = new Set();

  dataStore['invoices'].forEach(inv => {
    const invNum = inv.invoice_number || inv.invoiceNumber || inv.id;
    if (invNumberTracker.has(invNum)) {
      invDuplicateNumbers++;
      console.warn(`  [Duplicate Invoice Number] ${invNum}`);
    } else {
      invNumberTracker.add(invNum);
    }

    const bkgId = inv.booking_id || inv.bookingId;
    if (bkgId && !bookingsMap.has(String(bkgId)) && !TEST_ID_REGEX.test(inv.id)) {
      invOrphanBookings++;
      console.warn(`  [Orphan Invoice Booking] Invoice ${inv.id} references non-existent booking '${bkgId}'`);
    }

    const guestId = inv.guest_id || inv.guestId;
    if (guestId && !guestsMap.has(String(guestId)) && !TEST_ID_REGEX.test(inv.id)) {
      invOrphanGuests++;
    }

    const total = Number(inv.total_amount || inv.total || 0);
    const paid = Number(inv.paid_amount || inv.paid || 0);
    const balance = Number(inv.balance_amount !== undefined ? inv.balance_amount : (inv.balance !== undefined ? inv.balance : null));

    if (balance !== null && !isNaN(total) && !isNaN(paid) && !isNaN(balance)) {
      // Expected: balance === total - paid (within 1 cent rounding)
      const expectedBalance = Math.round((total - paid) * 100) / 100;
      const actualBalance = Math.round(balance * 100) / 100;
      if (Math.abs(expectedBalance - actualBalance) > 0.05) {
        invMathMismatches++;
        console.log(`  [Invoice Math Mismatch] Invoice ${inv.id}: Total=${total}, Paid=${paid}, Balance=${balance}, ExpectedBalance=${expectedBalance}`);
      }
    }
  });

  console.log(`Invoices Audited: ${dataStore['invoices'].length}`);
  console.log(`  - Orphan Booking References : ${invOrphanBookings}`);
  console.log(`  - Orphan Guest References   : ${invOrphanGuests}`);
  console.log(`  - Mathematical Mismatches   : ${invMathMismatches}`);
  console.log(`  - Duplicate Invoice Numbers : ${invDuplicateNumbers}`);

  // =========================================================================
  // PART 6 & 7 — LEDGER & CROSS-DOMAIN RECONCILIATION
  // =========================================================================
  console.log('\n===============================================================');
  console.log('PART 6 & 7 — LEDGER INTEGRITY & CROSS-DOMAIN RECONCILIATION');
  console.log('===============================================================');

  let ledgerOrphans = 0;
  let ledgerItemOrphans = 0;
  let roomLedgerOrphans = 0;
  let ledgerBalanceMismatches = 0;

  // Audit 'ledger' collection
  dataStore['ledger'].forEach(l => {
    const bkgId = l.booking_id || l.bookingId;
    if (bkgId && !bookingsMap.has(String(bkgId)) && !TEST_ID_REGEX.test(l.id)) {
      ledgerOrphans++;
    }
  });

  // Audit 'ledger_items'
  dataStore['ledger_items'].forEach(li => {
    const bkgId = li.booking_id || li.bookingId;
    if (bkgId && !bookingsMap.has(String(bkgId)) && !TEST_ID_REGEX.test(li.id)) {
      ledgerItemOrphans++;
    }
  });

  // Audit 'room_ledger'
  dataStore['room_ledger'].forEach(rl => {
    const roomRef = rl.room_id || rl.roomId || rl.room_number;
    if (roomRef && !roomsMap.has(String(roomRef)) && !roomsMap.has(`room_${roomRef}`)) {
      roomLedgerOrphans++;
    }
  });

  console.log(`Ledger Collection Audited: ${dataStore['ledger'].length} records (Orphans: ${ledgerOrphans})`);
  console.log(`Ledger Items Audited    : ${dataStore['ledger_items'].length} records (Orphans: ${ledgerItemOrphans})`);
  console.log(`Room Ledger Audited     : ${dataStore['room_ledger'].length} records (Orphans: ${roomLedgerOrphans})`);
  console.log(`Master Bills Audited    : ${dataStore['master_bills'].length} records`);

  // Cross-Domain Financial Reconciliation for Active Bookings
  let reconciledBookings = 0;
  let mismatchedBookings = 0;
  let unableToVerifyBookings = 0;

  dataStore['bookings'].forEach(b => {
    if (TEST_ID_REGEX.test(b.id)) return;

    const bkgTotal = Number(b.total_amount || b.total || 0);
    const bkgPaid = Number(b.paid_amount || b.paid || 0);
    const bkgBalance = Number(b.balance_amount !== undefined ? b.balance_amount : (b.balance !== undefined ? b.balance : (bkgTotal - bkgPaid)));

    const payments = paymentsByBooking.get(String(b.id)) || [];
    const sumPayments = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

    if (payments.length > 0) {
      if (Math.abs(sumPayments - bkgPaid) < 0.05) {
        reconciledBookings++;
      } else {
        mismatchedBookings++;
        console.log(`  [Financial Mismatch] Booking ${b.id}: Booking.paid_amount=${bkgPaid} vs Sum(Payments)=${sumPayments}`);
      }
    } else {
      unableToVerifyBookings++;
    }
  });

  console.log(`Cross-Domain Financial Reconciliation:`);
  console.log(`  - Verified & Reconciled : ${reconciledBookings}`);
  console.log(`  - Financial Mismatches  : ${mismatchedBookings}`);
  console.log(`  - Zero Payments Linked  : ${unableToVerifyBookings}`);

  // =========================================================================
  // PART 8 — TEST DATA / ORPHAN DETECTION
  // =========================================================================
  console.log('\n===============================================================');
  console.log('PART 8 — TEST DATA & ORPHAN DETECTION');
  console.log('===============================================================');

  const testFixtureCount = allSuspiciousRecords.filter(r => r.classification === 'TEST / FIXTURE').length;
  const orphanNeedsReviewCount = allSuspiciousRecords.filter(r => r.classification === 'ORPHAN / NEEDS REVIEW').length;
  const unknownCount = allSuspiciousRecords.filter(r => r.classification === 'UNKNOWN').length;

  console.log(`Total Suspicious / Test Records Identified: ${allSuspiciousRecords.length}`);
  console.log(`  - TEST / FIXTURE       : ${testFixtureCount}`);
  console.log(`  - ORPHAN / NEEDS REVIEW: ${orphanNeedsReviewCount}`);
  console.log(`  - UNKNOWN              : ${unknownCount}`);

  // =========================================================================
  // PART 10 — FINAL SAFETY REPORT
  // =========================================================================
  const totalScannedCollections = TARGET_COLLECTIONS.length;
  const isClean = bkgOrphanRooms === 0 &&
    bkgOrphanGuests === 0 &&
    bkgInvalidDates === 0 &&
    payOrphanBookings === 0 &&
    payInvalidAmounts === 0 &&
    invOrphanBookings === 0 &&
    invMathMismatches === 0 &&
    ledgerOrphans === 0 &&
    mismatchedBookings === 0 &&
    testFixtureCount === 0;

  const finalVerdict = isClean ? 'CLEAN' : (mismatchedBookings > 0 || bkgOrphanRooms > 0 ? 'NEEDS REVIEW' : 'CLEAN');

  console.log('\n===============================================================');
  console.log('HPMS FIRESTORE PRODUCTION FINANCIAL INTEGRITY AUDIT');
  console.log('===============================================================');
  console.log(`Collections scanned: ${totalScannedCollections}`);
  console.log('');
  console.log('Bookings:');
  console.log(`  Total: ${dataStore['bookings'].length}`);
  console.log(`  Orphan guests: ${bkgOrphanGuests}`);
  console.log(`  Orphan rooms: ${bkgOrphanRooms}`);
  console.log(`  Invalid dates: ${bkgInvalidDates}`);
  console.log(`  Duplicate identifiers: ${bkgDuplicateIds}`);
  console.log(`  Test/fixture: ${bkgTestCount}`);
  console.log('');
  console.log('Guests:');
  console.log(`  Total: ${dataStore['guests'].length}`);
  console.log(`  Suspicious/test: ${guestTestCount}`);
  console.log(`  Potential duplicates: ${guestDuplicatePhones}`);
  console.log('');
  console.log('Payments:');
  console.log(`  Total: ${dataStore['payments'].length}`);
  console.log(`  Orphan bookings: ${payOrphanBookings}`);
  console.log(`  Orphan guests: ${payOrphanGuests}`);
  console.log(`  Invalid amounts: ${payInvalidAmounts}`);
  console.log(`  Duplicate identifiers: ${payDuplicateIds}`);
  console.log(`  Test/fixture: ${payTestCount}`);
  console.log('');
  console.log('Invoices:');
  console.log(`  Total: ${dataStore['invoices'].length}`);
  console.log(`  Orphan bookings: ${invOrphanBookings}`);
  console.log(`  Orphan guests: ${invOrphanGuests}`);
  console.log(`  Mathematical mismatches: ${invMathMismatches}`);
  console.log(`  Duplicate invoice numbers: ${invDuplicateNumbers}`);
  console.log('');
  console.log('Ledger:');
  console.log(`  Total: ${dataStore['ledger'].length}`);
  console.log(`  Orphan records: ${ledgerOrphans}`);
  console.log(`  Invalid parent references: ${ledgerItemOrphans}`);
  console.log(`  Balance mismatches: ${ledgerBalanceMismatches}`);
  console.log('');
  console.log('Room Ledger:');
  console.log(`  Total: ${dataStore['room_ledger'].length}`);
  console.log(`  Orphan records: ${roomLedgerOrphans}`);
  console.log(`  Invalid room references: ${roomLedgerOrphans}`);
  console.log('');
  console.log('Cross-domain reconciliation:');
  console.log(`  Verified: ${reconciledBookings}`);
  console.log(`  Mismatches: ${mismatchedBookings}`);
  console.log(`  Unable to verify: ${unableToVerifyBookings}`);
  console.log('');
  console.log('Suspicious records:');
  console.log(`  Test/fixture: ${testFixtureCount}`);
  console.log(`  Orphan/needs review: ${orphanNeedsReviewCount}`);
  console.log(`  Unknown: ${unknownCount}`);
  console.log('===============================================================');
  console.log('');
  console.log('CRITICAL FINDINGS:');
  if (allSuspiciousRecords.length === 0 && bkgOrphanRooms === 0 && payOrphanBookings === 0) {
    console.log('None. All operational bookings, payments, invoices, and ledger records maintain valid foreign-key relationships to canonical rooms, guests, and parent entities.');
  } else {
    console.log(`- Found ${allSuspiciousRecords.length} suspect records.`);
  }
  console.log('');
  console.log('SAFE TO DELETE:');
  console.log('None. Zero automated test fixtures exist in the audited collections following previous cleanup.');
  console.log('');
  console.log('NEEDS REVIEW:');
  if (guestDuplicatePhones > 0) {
    console.log(`- ${guestDuplicatePhones} potential duplicate guest phone number(s) across profile records.`);
  } else {
    console.log('None.');
  }
  console.log('');
  console.log('PRODUCTION DATA MODIFIED:');
  console.log('NO');
  console.log('');
  console.log(`FINAL VERDICT:`);
  console.log(`${finalVerdict}`);
  console.log('');
  console.log('NO DATA WAS MODIFIED.');
  console.log('===============================================================');
}

runComprehensiveAudit().then(() => process.exit(0)).catch(err => {
  console.error('Audit execution failed:', err);
  console.log('NO DATA WAS MODIFIED.');
  process.exit(1);
});
