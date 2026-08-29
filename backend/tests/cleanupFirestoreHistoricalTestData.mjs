/**
 * backend/tests/cleanupFirestoreHistoricalTestData.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE-TIME STRICTLY SCOPED FIRESTORE CLEANUP UTILITY
 *
 * Target: hpms-sky5 Cloud Firestore
 * Scope : EXACTLY 124 pre-audited historical test fixture documents.
 *
 * Safety Constraints:
 * - Immutable manifest of 124 explicit collection + docId pairs.
 * - Zero dynamic discovery, wildcard matching, or collection sweeps.
 * - Strict bottom-up topological deletion ordering (leaves -> parents -> roots).
 * - Multi-stage fail-closed precheck: halts before any delete if any target is missing.
 * - Canonical master data & production collections strictly protected.
 * - Direct per-document deletion with immediate verification read.
 * - Post-cleanup verification validating total absence and master data integrity.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';

// Canonical Protected Records
const PROTECTED_ROOM_TYPES = Object.freeze(['room_type_1', 'room_type_2', 'room_type_3']);
const PROTECTED_ROOMS = Object.freeze([
  'room_1', 'room_2', 'room_3', 'room_4', 'room_5', 'room_6', 'room_7', 'room_8',
  'room_9', 'room_10', 'room_11', 'room_12', 'room_14', 'room_16', 'room_17',
  'room_19', 'room_20'
]);

// Immutable Deletion Manifest (124 Targets across 6 Topological Phases)
const DELETION_MANIFEST = Object.freeze([
  // =========================================================================
  // PHASE 1 — LEAF HISTORICAL TEST RECORDS (14 docs)
  // =========================================================================
  // audit_logs (3)
  Object.freeze({ phase: 1, collection: 'audit_logs', docId: 'audit_adj_booking_test_shift_1787638862176_1787638864447' }),
  Object.freeze({ phase: 1, collection: 'audit_logs', docId: 'audit_adj_booking_test_shift_1787638862176_1787638864755' }),
  Object.freeze({ phase: 1, collection: 'audit_logs', docId: 'audit_shift_booking_test_shift_1787638862176_1787638863547' }),

  // booking_history (1)
  Object.freeze({ phase: 1, collection: 'booking_history', docId: 'bh_booking_test_shift_1787638862176_shift_1787638863547' }),

  // checkout_snapshots (1)
  Object.freeze({ phase: 1, collection: 'checkout_snapshots', docId: 'snap_bkg_booking_test_shift_1787638862176' }),

  // room_status_history (1)
  Object.freeze({ phase: 1, collection: 'room_status_history', docId: 'rsh_booking_test_shift_1787638862176_checkout' }),

  // room_shift_adjustments (8)
  Object.freeze({ phase: 1, collection: 'room_shift_adjustments', docId: 'rsa_booking_test_shift_1787374423924_1787374425249' }),
  Object.freeze({ phase: 1, collection: 'room_shift_adjustments', docId: 'rsa_booking_test_shift_1787374453620_1787374454844' }),
  Object.freeze({ phase: 1, collection: 'room_shift_adjustments', docId: 'rsa_booking_test_shift_1787374469004_1787374470251' }),
  Object.freeze({ phase: 1, collection: 'room_shift_adjustments', docId: 'rsa_booking_test_shift_1787375152249_1787375153506' }),
  Object.freeze({ phase: 1, collection: 'room_shift_adjustments', docId: 'rsa_booking_test_shift_1787375651021_1787375652274' }),
  Object.freeze({ phase: 1, collection: 'room_shift_adjustments', docId: 'rsa_booking_test_shift_1787376340006_1787376341228' }),
  Object.freeze({ phase: 1, collection: 'room_shift_adjustments', docId: 'rsa_booking_test_shift_1787377213769_1787377214999' }),
  Object.freeze({ phase: 1, collection: 'room_shift_adjustments', docId: 'rsa_booking_test_shift_1787638862176_1787638863547' }),

  // =========================================================================
  // PHASE 2 — TEST CASH LOGS (6 docs)
  // =========================================================================
  Object.freeze({ phase: 2, collection: 'cash_logs', docId: 'cash_BKG-TEST-1787638862176_1787638866314' }),
  Object.freeze({ phase: 2, collection: 'cash_logs', docId: 'cash_log_payment_test_bkg_cutover_1787634211529_confirm' }),
  Object.freeze({ phase: 2, collection: 'cash_logs', docId: 'cash_log_payment_test_bkg_cutover_1787635482821_confirm' }),
  Object.freeze({ phase: 2, collection: 'cash_logs', docId: 'cash_log_payment_test_bkg_cutover_1787635531391_confirm' }),
  Object.freeze({ phase: 2, collection: 'cash_logs', docId: 'cash_log_payment_test_bkg_cutover_1787635569578_confirm' }),
  Object.freeze({ phase: 2, collection: 'cash_logs', docId: 'cash_log_payment_test_bkg_cutover_1787638148882_confirm' }),

  // =========================================================================
  // PHASE 3 — TEST FINANCIAL CHILDREN (30 docs: 8 ledger_items + 22 payments)
  // =========================================================================
  // ledger_items (8)
  Object.freeze({ phase: 3, collection: 'ledger_items', docId: 'ledger_booking_test_shift_1787638862176_1787638866055_pay' }),
  Object.freeze({ phase: 3, collection: 'ledger_items', docId: 'ledger_booking_test_shift_1787638862176_1787638866314_pay' }),
  Object.freeze({ phase: 3, collection: 'ledger_items', docId: 'ledger_booking_test_shift_1787638862176_shift_1787638863547' }),
  Object.freeze({ phase: 3, collection: 'ledger_items', docId: 'ledger_payment_test_bkg_cutover_1787634211529_credit' }),
  Object.freeze({ phase: 3, collection: 'ledger_items', docId: 'ledger_payment_test_bkg_cutover_1787635482821_credit' }),
  Object.freeze({ phase: 3, collection: 'ledger_items', docId: 'ledger_payment_test_bkg_cutover_1787635531391_credit' }),
  Object.freeze({ phase: 3, collection: 'ledger_items', docId: 'ledger_payment_test_bkg_cutover_1787635569578_credit' }),
  Object.freeze({ phase: 3, collection: 'ledger_items', docId: 'ledger_payment_test_bkg_cutover_1787638148882_credit' }),

  // payments (22)
  Object.freeze({ phase: 3, collection: 'payments', docId: 'pay_test_1787639229438_1' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'pay_test_1787639229438_2' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'pay_test_1787639229438_3' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'pay_test_1787639482177_1' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'pay_test_1787639482177_2' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'pay_test_1787639482177_3' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'pay_test_1787639517797_1' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'pay_test_1787639517797_2' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'pay_test_1787639517797_3' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_conc_1787634211529' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_conc_1787635482821' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_conc_1787635531391' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_conc_1787635569578' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_conc_1787638148882' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_serv_1787635531391' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_serv_1787635569578' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_serv_1787638148882' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_serv_conf_1787635569578' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_serv_conf_1787638148882' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_test_bkg_cutover_1787634211529' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_test_bkg_cutover_1787635482821' }),
  Object.freeze({ phase: 3, collection: 'payments', docId: 'payment_test_bkg_cutover_1787635531391' }),

  // =========================================================================
  // PHASE 4 — TEST INVOICES (11 docs)
  // =========================================================================
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_INV-20260825-TEST-1787638862176' }),
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_conc_1787634211529' }),
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_conc_1787635482821' }),
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_conc_1787635531391' }),
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_conc_1787635569578' }),
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_conc_1787638148882' }),
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_serv_conf_1787635569578' }),
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_serv_conf_1787638148882' }),
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_test_bkg_cutover_1787634211529' }),
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_test_bkg_cutover_1787635482821' }),
  Object.freeze({ phase: 4, collection: 'invoices', docId: 'invoice_test_bkg_cutover_1787635531391' }),

  // =========================================================================
  // PHASE 5 — TEST BOOKINGS & RESERVATIONS (55 docs: 17 bookings + 38 reservations)
  // =========================================================================
  // bookings (17)
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_conc_1787634211529' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_conc_1787635482821' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_conc_1787635531391' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_conc_1787635569578' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_conc_1787638148882' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_serv_1787635531391' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_serv_1787635569578' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_serv_1787638148882' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_serv_conf_1787635569578' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_serv_conf_1787638148882' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_test_bkg_cutover_1787634211529' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_test_bkg_cutover_1787635482821' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_test_bkg_cutover_1787635531391' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_test_checkedin_1787634016071' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_test_checkedin_1787640017743' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_upi_1787635569578' }),
  Object.freeze({ phase: 5, collection: 'bookings', docId: 'booking_upi_1787638148882' }),

  // reservations (38)
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20260901-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20260901-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20260910-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20260910-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20260920-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20260920-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261001-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261001-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261010-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261010-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261020-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261020-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261101-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261101-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261101-1003' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261101-1004' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261220-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20261220-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270101-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270101-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270201-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270201-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270301-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270301-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270401-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270401-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270501-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270501-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270701-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270701-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270801-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270801-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270801-1003' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270801-1004' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270901-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20270901-1002' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20271001-1001' }),
  Object.freeze({ phase: 5, collection: 'reservations', docId: 'res_RES-20271001-1002' }),

  // =========================================================================
  // PHASE 6 — TEST GUESTS (8 docs)
  // =========================================================================
  Object.freeze({ phase: 6, collection: 'guests', docId: 'guest_9876543226' }),
  Object.freeze({ phase: 6, collection: 'guests', docId: 'guest_9876543231' }),
  Object.freeze({ phase: 6, collection: 'guests', docId: 'guest_test_1787639229438_1' }),
  Object.freeze({ phase: 6, collection: 'guests', docId: 'guest_test_1787639229438_2' }),
  Object.freeze({ phase: 6, collection: 'guests', docId: 'guest_test_1787639482177_1' }),
  Object.freeze({ phase: 6, collection: 'guests', docId: 'guest_test_1787639482177_2' }),
  Object.freeze({ phase: 6, collection: 'guests', docId: 'guest_test_1787639517797_1' }),
  Object.freeze({ phase: 6, collection: 'guests', docId: 'guest_test_1787639517797_2' })
]);

const ALLOWED_COLLECTIONS = new Set([
  'audit_logs', 'booking_history', 'checkout_snapshots', 'room_status_history',
  'room_shift_adjustments', 'cash_logs', 'ledger_items', 'payments',
  'invoices', 'bookings', 'reservations', 'guests'
]);

async function executeScopedCleanup() {
  console.log('===============================================================');
  console.log('HPMS FIRESTORE HISTORICAL TEST DATA SCOPED CLEANUP');
  console.log('===============================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('Project: hpms-sky5\n');

  if (!db) {
    console.error('CRITICAL: Firebase Admin DB is not initialized.');
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Manifest Integrity & Safety Assertions
  // ─────────────────────────────────────────────────────────────────────────
  console.log('>>> [1/5] VALIDATING MANIFEST INTEGRITY & PRECONDITIONS ...');
  assert.strictEqual(
    DELETION_MANIFEST.length,
    124,
    `Safety assertion failed: Manifest must contain exactly 124 targets (found ${DELETION_MANIFEST.length})`
  );

  const countByCollection = {};
  for (let i = 0; i < DELETION_MANIFEST.length; i++) {
    const item = DELETION_MANIFEST[i];
    if (!item.collection || !ALLOWED_COLLECTIONS.has(item.collection)) {
      throw new Error(`Manifest validation failed at index ${i}: Disallowed collection '${item.collection}'`);
    }
    if (!item.docId || typeof item.docId !== 'string' || item.docId.trim().length === 0) {
      throw new Error(`Manifest validation failed at index ${i}: Invalid docId '${item.docId}'`);
    }

    // Canonical Protection Assertions
    if (item.collection === 'room_types' || PROTECTED_ROOM_TYPES.includes(item.docId)) {
      throw new Error(`CRITICAL: Protected room_type '${item.docId}' in manifest! Aborting.`);
    }
    if (item.collection === 'rooms' || PROTECTED_ROOMS.includes(item.docId)) {
      throw new Error(`CRITICAL: Protected room '${item.docId}' in manifest! Aborting.`);
    }
    if (item.collection === 'cash_submissions') {
      throw new Error(`CRITICAL: Protected collection 'cash_submissions' in manifest! Aborting.`);
    }

    countByCollection[item.collection] = (countByCollection[item.collection] || 0) + 1;
  }

  // Verify exact category counts
  assert.strictEqual(countByCollection['audit_logs'], 3, 'audit_logs count must be 3');
  assert.strictEqual(countByCollection['booking_history'], 1, 'booking_history count must be 1');
  assert.strictEqual(countByCollection['checkout_snapshots'], 1, 'checkout_snapshots count must be 1');
  assert.strictEqual(countByCollection['room_status_history'], 1, 'room_status_history count must be 1');
  assert.strictEqual(countByCollection['room_shift_adjustments'], 8, 'room_shift_adjustments count must be 8');
  assert.strictEqual(countByCollection['cash_logs'], 6, 'cash_logs count must be 6');
  assert.strictEqual(countByCollection['ledger_items'], 8, 'ledger_items count must be 8');
  assert.strictEqual(countByCollection['payments'], 22, 'payments count must be 22');
  assert.strictEqual(countByCollection['invoices'], 11, 'invoices count must be 11');
  assert.strictEqual(countByCollection['bookings'], 17, 'bookings count must be 17');
  assert.strictEqual(countByCollection['reservations'], 38, 'reservations count must be 38');
  assert.strictEqual(countByCollection['guests'], 8, 'guests count must be 8');

  console.log('  ✓ Manifest integrity validated: Exactly 124 targets across all 6 phases.');

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Precheck Existence of All 124 Target Documents
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [2/5] PRECHECKING TARGET DOCUMENT EXISTENCE IN FIRESTORE ...');
  let precheckFoundCount = 0;
  const missingTargets = [];

  for (let i = 0; i < DELETION_MANIFEST.length; i++) {
    const { phase, collection, docId } = DELETION_MANIFEST[i];
    const snap = await db.collection(collection).doc(docId).get();
    if (snap.exists) {
      precheckFoundCount++;
    } else {
      missingTargets.push(`${collection}/${docId}`);
      console.error(`  ✗ MISSING TARGET [${i + 1}/124]: ${collection}/${docId}`);
    }
  }

  console.log(`\n  Precheck complete: Found ${precheckFoundCount} of 124 expected targets.`);
  if (missingTargets.length > 0) {
    console.error(`CRITICAL PRECHECK FAILURE: ${missingTargets.length} target(s) missing from Firestore!`);
    console.error('Halting execution immediately before any mutation is performed.');
    process.exit(1);
  }
  console.log('  ✓ 100% of manifest targets verified present. Proceeding to deletion phases.');

  // Snapshot initial cash_submissions count
  const initialCsSnap = await db.collection('cash_submissions').get();
  const initialCsIds = initialCsSnap.docs.map(d => d.id).sort();

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: Execute Scoped Deletion with Immediate Confirmation
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [3/5] EXECUTING TOPOLOGICAL DELETIONS & IMMEDIATE CONFIRMATION ...');
  let deletionAttempts = 0;
  let deletionSuccess = 0;
  let deletionFailures = 0;

  for (let i = 0; i < DELETION_MANIFEST.length; i++) {
    const { phase, collection, docId } = DELETION_MANIFEST[i];
    deletionAttempts++;
    console.log(`  [Phase ${phase}] Deleting [${i + 1}/124]: ${collection}/${docId} ...`);

    try {
      await db.collection(collection).doc(docId).delete();

      // Immediate verification read
      const verifySnap = await db.collection(collection).doc(docId).get();
      if (verifySnap.exists) {
        throw new Error(`Post-delete verification failed: Document ${collection}/${docId} still exists!`);
      }

      deletionSuccess++;
      console.log(`    ✓ SUCCESS: ${collection}/${docId} confirmed absent.`);
    } catch (err) {
      deletionFailures++;
      console.error(`    ✗ CRITICAL DELETION FAILURE for ${collection}/${docId}:`, err.message);
      console.error('Halting further cleanup operations immediately.');
      process.exit(1);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4: Post-Cleanup Full Manifest Re-Verification
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [4/5] RE-VERIFYING ABSENCE OF ALL 124 TARGET DOCUMENTS ...');
  let targetsRemaining = 0;

  for (const { collection, docId } of DELETION_MANIFEST) {
    const checkSnap = await db.collection(collection).doc(docId).get();
    if (checkSnap.exists) {
      console.error(`  ✗ Post-check failure: ${collection}/${docId} is still present!`);
      targetsRemaining++;
    }
  }

  assert.strictEqual(
    targetsRemaining,
    0,
    `Post-cleanup verification assertion failed: Expected 0 remaining, got ${targetsRemaining}`
  );
  console.log('  ✓ All 124 targeted documents verified 100% absent in Firestore.');

  // ─────────────────────────────────────────────────────────────────────────
  // Step 5: Sanity Check Canonical Master Data & Protected Collections
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [5/5] SANITY CHECKING CANONICAL PRODUCTION MASTER DATA ...');

  // Verify room_types
  const postRtSnap = await db.collection('room_types').get();
  const remainingRtDocIds = postRtSnap.docs.map(d => d.id);
  assert.strictEqual(
    remainingRtDocIds.length,
    3,
    `Sanity check failed: Expected exactly 3 room_types, found ${remainingRtDocIds.length}`
  );
  for (const expId of PROTECTED_ROOM_TYPES) {
    assert.ok(remainingRtDocIds.includes(expId), `Canonical room_type '${expId}' missing!`);
  }

  // Verify rooms
  const postRoomsSnap = await db.collection('rooms').get();
  const remainingRoomDocIds = postRoomsSnap.docs.map(d => d.id);
  assert.strictEqual(
    remainingRoomDocIds.length,
    17,
    `Sanity check failed: Expected exactly 17 rooms, found ${remainingRoomDocIds.length}`
  );
  for (const expId of PROTECTED_ROOMS) {
    assert.ok(remainingRoomDocIds.includes(expId), `Canonical room '${expId}' missing!`);
  }

  // Verify cash_submissions
  const postCsSnap = await db.collection('cash_submissions').get();
  const postCsIds = postCsSnap.docs.map(d => d.id).sort();
  assert.strictEqual(
    postCsIds.length,
    initialCsIds.length,
    `Sanity check failed: cash_submissions count changed (${initialCsIds.length} -> ${postCsIds.length})`
  );
  assert.deepStrictEqual(
    postCsIds,
    initialCsIds,
    'Sanity check failed: cash_submissions document IDs changed!'
  );

  console.log('  ✓ Canonical production master data (3 room types, 17 rooms) 100% intact.');
  console.log('  ✓ Protected collection cash_submissions 100% unmodified.');

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────
  const status = deletionFailures === 0 && deletionSuccess === 124 && targetsRemaining === 0
    ? 'SUCCESS'
    : 'FAILED / FAIL-CLOSED';

  console.log('\n===============================================================');
  console.log('HPMS FIRESTORE HISTORICAL TEST DATA SCOPED CLEANUP');
  console.log('===============================================================');
  console.log('Project: hpms-sky5');
  console.log('');
  console.log(`Manifest targets: ${DELETION_MANIFEST.length}`);
  console.log('');
  console.log('Precheck:');
  console.log(`Expected: ${DELETION_MANIFEST.length}`);
  console.log(`Found: ${precheckFoundCount}`);
  console.log('');
  console.log('Deletion:');
  console.log(`Attempts: ${deletionAttempts}`);
  console.log(`Success: ${deletionSuccess}`);
  console.log(`Failures: ${deletionFailures}`);
  console.log('');
  console.log('Post-cleanup:');
  console.log(`Targets remaining: ${targetsRemaining}`);
  console.log(`Canonical room types remaining: ${remainingRtDocIds.length}`);
  console.log(`Canonical rooms remaining: ${remainingRoomDocIds.length}`);
  console.log('Cash submissions modified: NO');
  console.log('');
  console.log('===============================================================');
  console.log('');
  console.log('FINAL STATUS:');
  console.log(status);
  console.log('');
  console.log('===============================================================');

  if (status === 'SUCCESS') {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

executeScopedCleanup().catch(err => {
  console.error('Fatal error during cleanup execution:', err);
  process.exit(1);
});
