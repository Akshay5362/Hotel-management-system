/**
 * backend/tests/cleanupFirestoreFinal18HistoricalTestArtifacts.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE-TIME STRICTLY SCOPED FIRESTORE CLEANUP SCRIPT
 *
 * Target: hpms-sky5 Cloud Firestore
 * Scope : EXACTLY 18 pre-audited secondary test artifact documents.
 *
 * Safety Constraints:
 * - Immutable manifest of 18 explicit collection + document ID pairs.
 * - Zero dynamic discovery, wildcard matching, or collection sweeps.
 * - Multi-stage fail-closed precheck: halts before any delete if any target is missing.
 * - Canonical master data & production collections strictly protected:
 *   • room_types (room_type_1..3)
 *   • rooms (room_1..20)
 *   • cash_submissions (ALL)
 *   • ledger_items (ALL ledger_BKG-*)
 *   • payments (ALL payment_BKG-*)
 * - Direct per-document deletion with immediate verification read.
 * - Post-cleanup verification validating total absence and production data integrity.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';

// Canonical Protected Master Data
const PROTECTED_ROOM_TYPES = Object.freeze(['room_type_1', 'room_type_2', 'room_type_3']);
const PROTECTED_ROOMS = Object.freeze([
  'room_1', 'room_2', 'room_3', 'room_4', 'room_5', 'room_6', 'room_7', 'room_8',
  'room_9', 'room_10', 'room_11', 'room_12', 'room_14', 'room_16', 'room_17',
  'room_19', 'room_20'
]);

// Exact Immutable 18-Document Deletion Manifest
const DELETION_MANIFEST = Object.freeze([
  // PAYMENTS (2)
  Object.freeze({ collection: 'payments', docId: 'payment_upi_1787635569578' }),
  Object.freeze({ collection: 'payments', docId: 'payment_upi_1787638148882' }),

  // LEDGER_ITEMS (7)
  Object.freeze({ collection: 'ledger_items', docId: 'ledger_payment_conc_1787634211529_credit' }),
  Object.freeze({ collection: 'ledger_items', docId: 'ledger_payment_conc_1787635482821_credit' }),
  Object.freeze({ collection: 'ledger_items', docId: 'ledger_payment_conc_1787635531391_credit' }),
  Object.freeze({ collection: 'ledger_items', docId: 'ledger_payment_conc_1787635569578_credit' }),
  Object.freeze({ collection: 'ledger_items', docId: 'ledger_payment_conc_1787638148882_credit' }),
  Object.freeze({ collection: 'ledger_items', docId: 'ledger_payment_serv_conf_1787635569578_credit' }),
  Object.freeze({ collection: 'ledger_items', docId: 'ledger_payment_serv_conf_1787638148882_credit' }),

  // CASH_LOGS (9)
  Object.freeze({ collection: 'cash_logs', docId: 'cash_log_payment_conc_1787634211529_confirm' }),
  Object.freeze({ collection: 'cash_logs', docId: 'cash_log_payment_conc_1787635482821_confirm' }),
  Object.freeze({ collection: 'cash_logs', docId: 'cash_log_payment_conc_1787635531391_confirm' }),
  Object.freeze({ collection: 'cash_logs', docId: 'cash_log_payment_conc_1787635569578_confirm' }),
  Object.freeze({ collection: 'cash_logs', docId: 'cash_log_payment_conc_1787638148882_confirm' }),
  Object.freeze({ collection: 'cash_logs', docId: 'cash_log_payment_serv_conf_1787635569578_confirm' }),
  Object.freeze({ collection: 'cash_logs', docId: 'cash_log_payment_serv_conf_1787638148882_confirm' }),
  Object.freeze({ collection: 'cash_logs', docId: 'cash_log_res_RES-20261020-1001_advance' }),
  Object.freeze({ collection: 'cash_logs', docId: 'cash_log_res_RES-20261020-1002_advance' })
]);

const ALLOWED_COLLECTIONS = new Set(['payments', 'ledger_items', 'cash_logs']);

async function executeFinal18Cleanup() {
  console.log('===============================================================');
  console.log('HPMS FINAL 18-DOCUMENT HISTORICAL TEST ARTIFACT CLEANUP');
  console.log('===============================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('Project: hpms-sky5\n');

  if (!db) {
    console.error('CRITICAL: Firebase Admin DB is not initialized.');
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [1/5] MANIFEST VALIDATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('>>> [1/5] MANIFEST VALIDATION ...');
  assert.strictEqual(
    DELETION_MANIFEST.length,
    18,
    `Safety assertion failed: Manifest must contain exactly 18 targets (found ${DELETION_MANIFEST.length})`
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

    // Canonical & Production Protections
    if (item.collection === 'room_types' || PROTECTED_ROOM_TYPES.includes(item.docId)) {
      throw new Error(`CRITICAL: Protected room_type '${item.docId}' in manifest! Aborting.`);
    }
    if (item.collection === 'rooms' || PROTECTED_ROOMS.includes(item.docId)) {
      throw new Error(`CRITICAL: Protected room '${item.docId}' in manifest! Aborting.`);
    }
    if (item.collection === 'cash_submissions') {
      throw new Error(`CRITICAL: Protected collection 'cash_submissions' in manifest! Aborting.`);
    }
    if (item.docId.startsWith('ledger_BKG-') || item.docId.startsWith('payment_BKG-')) {
      throw new Error(`CRITICAL: Protected production BKG record '${item.docId}' in manifest! Aborting.`);
    }

    countByCollection[item.collection] = (countByCollection[item.collection] || 0) + 1;
  }

  assert.strictEqual(countByCollection['payments'], 2, 'payments count must be 2');
  assert.strictEqual(countByCollection['ledger_items'], 7, 'ledger_items count must be 7');
  assert.strictEqual(countByCollection['cash_logs'], 9, 'cash_logs count must be 9');

  console.log('  ✓ Manifest validated: Exactly 18 targets (Payments: 2, Ledger Items: 7, Cash Logs: 9).');
  console.log('  ✓ Zero protected documents in manifest.');

  // ─────────────────────────────────────────────────────────────────────────
  // [2/5] PRE-CLEANUP EXISTENCE & DEPENDENCY CHECK
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [2/5] PRE-CLEANUP EXISTENCE & DEPENDENCY CHECK ...');
  let precheckPresentCount = 0;
  const missingTargets = [];

  // Snapshot protected records before deletion for later comparison
  const preCsSnap = await db.collection('cash_submissions').get();
  const preCsIds = preCsSnap.docs.map(d => d.id).sort();

  const preLiSnap = await db.collection('ledger_items').get();
  const preLiBkgIds = preLiSnap.docs.filter(d => d.id.startsWith('ledger_BKG-')).map(d => d.id).sort();

  const prePaySnap = await db.collection('payments').get();
  const prePayBkgIds = prePaySnap.docs.filter(d => d.id.startsWith('payment_BKG-')).map(d => d.id).sort();

  for (let i = 0; i < DELETION_MANIFEST.length; i++) {
    const { collection, docId } = DELETION_MANIFEST[i];
    const snap = await db.collection(collection).doc(docId).get();
    if (snap.exists) {
      precheckPresentCount++;
      const data = snap.data();
      console.log(`  [${String(i + 1).padStart(2, ' ')}/18] Present: ${collection.padEnd(14, ' ')} / ${docId.padEnd(48, ' ')} | Amount: ₹${data.amount || 0}`);
    } else {
      missingTargets.push(`${collection}/${docId}`);
      console.error(`  ✗ MISSING TARGET [${i + 1}/18]: ${collection}/${docId}`);
    }
  }

  console.log(`\n  Precheck complete: Found ${precheckPresentCount} of 18 expected targets.`);
  if (missingTargets.length > 0) {
    console.error(`CRITICAL PRECHECK FAILURE: ${missingTargets.length} target(s) missing from Firestore!`);
    console.error('Halting execution immediately before any mutation is performed.');
    process.exit(1);
  }
  console.log('  ✓ 100% of manifest targets verified present. Proceeding to deletion.');

  // ─────────────────────────────────────────────────────────────────────────
  // [3/5] EXACT 18 DOCUMENT DELETION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [3/5] EXACT 18 DOCUMENT DELETION ...');
  let deleteSuccess = 0;
  let deleteFailures = 0;

  for (let i = 0; i < DELETION_MANIFEST.length; i++) {
    const { collection, docId } = DELETION_MANIFEST[i];
    console.log(`  Deleting [${i + 1}/18]: ${collection}/${docId} ...`);

    try {
      await db.collection(collection).doc(docId).delete();

      // Immediate verification read
      const verifySnap = await db.collection(collection).doc(docId).get();
      if (verifySnap.exists) {
        throw new Error(`Post-delete verification failed: Document ${collection}/${docId} still exists!`);
      }

      deleteSuccess++;
      console.log(`    ✓ SUCCESS: ${collection}/${docId} confirmed absent.`);
    } catch (err) {
      deleteFailures++;
      console.error(`    ✗ CRITICAL DELETION FAILURE for ${collection}/${docId}:`, err.message);
      console.error('Halting further cleanup operations immediately.');
      process.exit(1);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [4/5] POST-DELETION ABSENCE VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [4/5] POST-DELETION ABSENCE VERIFICATION ...');
  let postcheckAbsent = 0;

  for (const { collection, docId } of DELETION_MANIFEST) {
    const checkSnap = await db.collection(collection).doc(docId).get();
    if (!checkSnap.exists) {
      postcheckAbsent++;
    } else {
      console.error(`  ✗ Post-check failure: ${collection}/${docId} is still present!`);
    }
  }

  assert.strictEqual(
    postcheckAbsent,
    18,
    `Post-cleanup verification assertion failed: Expected 18 absent, got ${postcheckAbsent}`
  );
  console.log('  ✓ All 18 targeted documents verified 100% absent in Firestore.');

  // ─────────────────────────────────────────────────────────────────────────
  // [5/5] PROTECTED PRODUCTION DATA VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [5/5] PROTECTED PRODUCTION DATA VERIFICATION ...');

  // Verify room_types
  const postRtSnap = await db.collection('room_types').get();
  const remainingRtDocIds = postRtSnap.docs.map(d => d.id);
  const rtPass = (remainingRtDocIds.length === 3) && PROTECTED_ROOM_TYPES.every(id => remainingRtDocIds.includes(id));
  assert.ok(rtPass, 'Canonical room_types protection check failed!');

  // Verify rooms
  const postRoomsSnap = await db.collection('rooms').get();
  const remainingRoomDocIds = postRoomsSnap.docs.map(d => d.id);
  const roomsPass = (remainingRoomDocIds.length === 17) && PROTECTED_ROOMS.every(id => remainingRoomDocIds.includes(id));
  assert.ok(roomsPass, 'Canonical rooms protection check failed!');

  // Verify cash_submissions
  const postCsSnap = await db.collection('cash_submissions').get();
  const postCsIds = postCsSnap.docs.map(d => d.id).sort();
  const csPass = (postCsIds.length === preCsIds.length) && preCsIds.every((id, idx) => id === postCsIds[idx]);
  assert.ok(csPass, 'cash_submissions protection check failed!');

  // Verify ledger_BKG-*
  const postLiSnap = await db.collection('ledger_items').get();
  const postLiBkgIds = postLiSnap.docs.filter(d => d.id.startsWith('ledger_BKG-')).map(d => d.id).sort();
  const liBkgPass = (postLiBkgIds.length === preLiBkgIds.length) && preLiBkgIds.every((id, idx) => id === postLiBkgIds[idx]);
  assert.ok(liBkgPass, 'ledger_BKG-* protection check failed!');

  // Verify payment_BKG-*
  const postPaySnap = await db.collection('payments').get();
  const postPayBkgIds = postPaySnap.docs.filter(d => d.id.startsWith('payment_BKG-')).map(d => d.id).sort();
  const payBkgPass = (postPayBkgIds.length === prePayBkgIds.length) && prePayBkgIds.every((id, idx) => id === postPayBkgIds[idx]);
  assert.ok(payBkgPass, 'payment_BKG-* protection check failed!');

  console.log('  ✓ Canonical room_types (3): PASS');
  console.log('  ✓ Canonical rooms (17)    : PASS');
  console.log(`  ✓ cash_submissions (${postCsIds.length})   : PASS`);
  console.log(`  ✓ ledger_BKG-* (${postLiBkgIds.length})     : PASS`);
  console.log(`  ✓ payment_BKG-* (${postPayBkgIds.length})    : PASS`);

  // ─────────────────────────────────────────────────────────────────────────
  // DELETION SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  const status = deleteFailures === 0 && deleteSuccess === 18 && postcheckAbsent === 18
    ? 'SUCCESS'
    : 'ABORTED';

  console.log('\n===============================================================');
  console.log('DELETION SUMMARY:');
  console.log(`TARGETS: ${DELETION_MANIFEST.length}`);
  console.log(`PRECHECK PRESENT: ${precheckPresentCount}`);
  console.log(`DELETE SUCCESS: ${deleteSuccess}`);
  console.log(`DELETE FAILURES: ${deleteFailures}`);
  console.log(`POSTCHECK ABSENT: ${postcheckAbsent}`);
  console.log('');
  console.log('PROTECTED DATA:');
  console.log(`Canonical room types: ${rtPass ? 'PASS' : 'FAIL'}`);
  console.log(`Canonical rooms: ${roomsPass ? 'PASS' : 'FAIL'}`);
  console.log(`cash_submissions: ${csPass ? 'PASS' : 'FAIL'}`);
  console.log(`ledger_BKG-* production projections: ${liBkgPass ? 'PASS' : 'FAIL'}`);
  console.log(`payment_BKG-* production payments: ${payBkgPass ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log('FINAL STATUS:');
  console.log(status);
  console.log('');
  console.log('NO UNAUTHORIZED DATA MODIFIED.');
  console.log('===============================================================');

  if (status === 'SUCCESS') {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

executeFinal18Cleanup().catch(err => {
  console.error('Fatal error during cleanup execution:', err);
  process.exit(1);
});
