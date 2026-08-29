/**
 * backend/tests/cleanupFirestoreOrphanedTestFixtures.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE-TIME, STRICTLY SCOPED FIRESTORE CLEANUP SCRIPT
 *
 * Target: hpms-sky5 Cloud Firestore
 * Scope : EXACTLY 22 pre-audited orphaned test fixture documents.
 *
 * Safety Constraints:
 * - Immutable manifest of 22 exact document references.
 * - No collection scans, queries, wildcards, or dynamic discovery.
 * - Direct doc-by-doc precheck, scoped delete, and post-delete verification.
 * - Fails closed and halts immediately on any error.
 * - Canonical 17 rooms and 3 room types are strictly preserved.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';

// Exact 22-document deletion manifest (Immutable)
const DELETION_MANIFEST = Object.freeze([
  // 1. Suspect Room Types (4)
  Object.freeze({ collection: 'room_types', docId: 'room_type_4' }),
  Object.freeze({ collection: 'room_types', docId: 'type_RT_2002' }),
  Object.freeze({ collection: 'room_types', docId: 'type_RT_5000' }),
  Object.freeze({ collection: 'room_types', docId: 'type_RT_7820' }),

  // 2. Suspect 9xx Rooms (6)
  Object.freeze({ collection: 'rooms', docId: 'room_901_2177' }),
  Object.freeze({ collection: 'rooms', docId: 'room_901_7797' }),
  Object.freeze({ collection: 'rooms', docId: 'room_901_9438' }),
  Object.freeze({ collection: 'rooms', docId: 'room_902_2177' }),
  Object.freeze({ collection: 'rooms', docId: 'room_902_7797' }),
  Object.freeze({ collection: 'rooms', docId: 'room_902_9438' }),

  // 3. Orphaned Phase 2 Step 9 Ephemeral Test Bookings (12)
  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639229438_1' }),
  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639229438_2' }),
  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639229438_3' }),
  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639229438_4' }),

  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639482177_1' }),
  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639482177_2' }),
  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639482177_3' }),
  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639482177_4' }),

  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639517797_1' }),
  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639517797_2' }),
  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639517797_3' }),
  Object.freeze({ collection: 'bookings', docId: 'bkg_test_1787639517797_4' })
]);

// Canonical Production Document IDs established by audit
const CANONICAL_ROOM_TYPE_DOC_IDS = Object.freeze(['room_type_1', 'room_type_2', 'room_type_3']);
const CANONICAL_ROOM_DOC_IDS = Object.freeze([
  'room_1', 'room_2', 'room_3', 'room_4', 'room_5', 'room_6', 'room_7', 'room_8',
  'room_9', 'room_10', 'room_11', 'room_12', 'room_14', 'room_16', 'room_17',
  'room_19', 'room_20'
]);

const ALLOWED_COLLECTIONS = new Set(['room_types', 'rooms', 'bookings']);

async function executeScopedCleanup() {
  console.log('===============================================================');
  console.log('   HPMS FIRESTORE ORPHANED TEST FIXTURE SCOPED CLEANUP');
  console.log('===============================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('Project  : hpms-sky5\n');

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
    22,
    `Safety assertion failed: Manifest must contain exactly 22 targets (found ${DELETION_MANIFEST.length})`
  );

  for (let i = 0; i < DELETION_MANIFEST.length; i++) {
    const item = DELETION_MANIFEST[i];
    if (!item.collection || !ALLOWED_COLLECTIONS.has(item.collection)) {
      throw new Error(`Manifest validation failed at index ${i}: Invalid collection '${item.collection}'`);
    }
    if (!item.docId || typeof item.docId !== 'string' || item.docId.trim().length === 0) {
      throw new Error(`Manifest validation failed at index ${i}: Invalid docId '${item.docId}'`);
    }
    // Explicit protection against deleting canonical documents
    if (CANONICAL_ROOM_TYPE_DOC_IDS.includes(item.docId) || CANONICAL_ROOM_DOC_IDS.includes(item.docId)) {
      throw new Error(`CRITICAL: Manifest contains canonical production document ID '${item.docId}'! Aborting.`);
    }
  }
  console.log('  ✓ Manifest integrity validated: Exactly 22 valid scoped targets.');

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Pre-Check Existence of Target Documents
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [2/5] PRE-CHECKING TARGET DOCUMENT EXISTENCE IN FIRESTORE ...');
  let precheckExistsCount = 0;

  for (let i = 0; i < DELETION_MANIFEST.length; i++) {
    const { collection, docId } = DELETION_MANIFEST[i];
    const snap = await db.collection(collection).doc(docId).get();
    const exists = snap.exists;
    if (exists) precheckExistsCount++;
    console.log(`  [${String(i + 1).padStart(2, ' ')}/22] Target: ${collection.padEnd(11, ' ')} / ${docId.padEnd(30, ' ')} | Currently Exists: ${exists ? 'YES' : 'NO'}`);
  }
  console.log(`\n  Precheck complete: ${precheckExistsCount} of 22 targets currently exist in Firestore.`);

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: Execute Scoped Deletion with Immediate Confirmation
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [3/5] EXECUTING SCOPED DELETIONS & IMMEDIATE CONFIRMATION ...');
  let deletedCount = 0;
  let failuresCount = 0;

  for (let i = 0; i < DELETION_MANIFEST.length; i++) {
    const { collection, docId } = DELETION_MANIFEST[i];
    console.log(`  Deleting [${i + 1}/22]: ${collection}/${docId} ...`);

    try {
      await db.collection(collection).doc(docId).delete();

      // Immediate verification read
      const verifySnap = await db.collection(collection).doc(docId).get();
      if (verifySnap.exists) {
        throw new Error(`Post-delete verification failed: Document ${collection}/${docId} still exists!`);
      }

      deletedCount++;
      console.log(`    ✓ SUCCESS: ${collection}/${docId} deleted and confirmed absent.`);
    } catch (err) {
      failuresCount++;
      console.error(`    ✗ CRITICAL DELETION FAILURE for ${collection}/${docId}:`, err.message);
      console.error('Halting further cleanup operations immediately.');
      process.exit(1);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4: Post-Cleanup Full Manifest Re-Verification
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [4/5] RE-VERIFYING ABSENCE OF ALL 22 TARGET DOCUMENTS ...');
  let verifiedAbsentCount = 0;

  for (const { collection, docId } of DELETION_MANIFEST) {
    const checkSnap = await db.collection(collection).doc(docId).get();
    if (!checkSnap.exists) {
      verifiedAbsentCount++;
    } else {
      console.error(`  ✗ Post-check failure: ${collection}/${docId} is still present!`);
      failuresCount++;
    }
  }

  assert.strictEqual(
    verifiedAbsentCount,
    22,
    `Post-cleanup verification assertion failed: Expected 22 absent, got ${verifiedAbsentCount}`
  );
  console.log('  ✓ All 22 targeted documents verified 100% absent in Firestore.');

  // ─────────────────────────────────────────────────────────────────────────
  // Step 5: Final Sanity Check on Canonical Production Master Data
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [5/5] SANITY CHECKING CANONICAL PRODUCTION MASTER DATA ...');
  
  // Verify room_types contains only canonical production items
  const postRtSnap = await db.collection('room_types').get();
  const remainingRtDocIds = postRtSnap.docs.map(d => d.id);
  console.log(`  Remaining room_types documents (${remainingRtDocIds.length}):`, remainingRtDocIds.join(', '));
  assert.strictEqual(
    remainingRtDocIds.length,
    3,
    `Sanity check failed: Expected exactly 3 room_types documents, found ${remainingRtDocIds.length}`
  );
  for (const expId of CANONICAL_ROOM_TYPE_DOC_IDS) {
    assert.ok(remainingRtDocIds.includes(expId), `Canonical room_type '${expId}' missing!`);
  }

  // Verify rooms contains exactly the 17 canonical production rooms
  const postRoomsSnap = await db.collection('rooms').get();
  const remainingRoomDocIds = postRoomsSnap.docs.map(d => d.id);
  console.log(`  Remaining rooms documents (${remainingRoomDocIds.length}):`, remainingRoomDocIds.join(', '));
  assert.strictEqual(
    remainingRoomDocIds.length,
    17,
    `Sanity check failed: Expected exactly 17 rooms documents, found ${remainingRoomDocIds.length}`
  );
  for (const expId of CANONICAL_ROOM_DOC_IDS) {
    assert.ok(remainingRoomDocIds.includes(expId), `Canonical room '${expId}' missing!`);
  }
  console.log('  ✓ Canonical production master data (3 room types, 17 rooms) 100% intact.');

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────
  const status = failuresCount === 0 && deletedCount === 22 && verifiedAbsentCount === 22
    ? 'CLEANUP SUCCESS'
    : 'CLEANUP FAILED';

  console.log('\n===============================================================');
  console.log('HPMS FIRESTORE ORPHANED TEST FIXTURE CLEANUP');
  console.log('===============================================================');
  console.log(`TARGET DOCUMENTS : ${DELETION_MANIFEST.length}`);
  console.log(`PRECHECK EXISTS  : ${precheckExistsCount}`);
  console.log(`DELETED          : ${deletedCount}`);
  console.log(`VERIFIED ABSENT  : ${verifiedAbsentCount}`);
  console.log(`FAILURES         : ${failuresCount}`);
  console.log('');
  console.log(`Canonical room types remaining: ${remainingRtDocIds.length}`);
  console.log(`Canonical rooms remaining: ${remainingRoomDocIds.length}`);
  console.log('');
  console.log(`STATUS: ${status}`);
  console.log('');
  console.log('NO OTHER DOCUMENTS WERE TARGETED.');
  console.log('===============================================================');

  if (status === 'CLEANUP SUCCESS') {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

executeScopedCleanup().catch(err => {
  console.error('Fatal error during cleanup execution:', err);
  process.exit(1);
});
