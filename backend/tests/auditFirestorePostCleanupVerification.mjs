/**
 * backend/tests/auditFirestorePostCleanupVerification.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT READ-ONLY POST-CLEANUP FIRESTORE AUDIT
 *
 * Target: hpms-sky5 Cloud Firestore
 * Mode  : STRICT READ-ONLY. Zero mutations will be performed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';

const EXPECTED_CANONICAL_ROOM_TYPES = Object.freeze([
  'room_type_1',
  'room_type_2',
  'room_type_3'
]);

const EXPECTED_CANONICAL_ROOMS = Object.freeze([
  'room_1',
  'room_2',
  'room_3',
  'room_4',
  'room_5',
  'room_6',
  'room_7',
  'room_8',
  'room_9',
  'room_10',
  'room_11',
  'room_12',
  'room_14',
  'room_16',
  'room_17',
  'room_19',
  'room_20'
]);

const DELETED_TARGET_FIXTURES = Object.freeze([
  // Room Types (4)
  { collection: 'room_types', docId: 'room_type_4' },
  { collection: 'room_types', docId: 'type_RT_2002' },
  { collection: 'room_types', docId: 'type_RT_5000' },
  { collection: 'room_types', docId: 'type_RT_7820' },

  // Rooms (6)
  { collection: 'rooms', docId: 'room_901_2177' },
  { collection: 'rooms', docId: 'room_901_7797' },
  { collection: 'rooms', docId: 'room_901_9438' },
  { collection: 'rooms', docId: 'room_902_2177' },
  { collection: 'rooms', docId: 'room_902_7797' },
  { collection: 'rooms', docId: 'room_902_9438' },

  // Bookings (12)
  { collection: 'bookings', docId: 'bkg_test_1787639229438_1' },
  { collection: 'bookings', docId: 'bkg_test_1787639229438_2' },
  { collection: 'bookings', docId: 'bkg_test_1787639229438_3' },
  { collection: 'bookings', docId: 'bkg_test_1787639229438_4' },

  { collection: 'bookings', docId: 'bkg_test_1787639482177_1' },
  { collection: 'bookings', docId: 'bkg_test_1787639482177_2' },
  { collection: 'bookings', docId: 'bkg_test_1787639482177_3' },
  { collection: 'bookings', docId: 'bkg_test_1787639482177_4' },

  { collection: 'bookings', docId: 'bkg_test_1787639517797_1' },
  { collection: 'bookings', docId: 'bkg_test_1787639517797_2' },
  { collection: 'bookings', docId: 'bkg_test_1787639517797_3' },
  { collection: 'bookings', docId: 'bkg_test_1787639517797_4' }
]);

const SEARCH_TERMS = new Set([
  'room_type_4', 'P3B_GSL8W', 'p3b_gsl8w',
  'type_RT_2002', 'RT_2002', 'rt_2002',
  'type_RT_5000', 'RT_5000', 'rt_5000',
  'type_RT_7820', 'RT_7820', 'rt_7820',
  'room_901_2177', '901_2177',
  'room_901_7797', '901_7797',
  'room_901_9438', '901_9438',
  'room_902_2177', '902_2177',
  'room_902_7797', '902_7797',
  'room_902_9438', '902_9438'
]);

const KNOWN_COLLECTIONS = [
  'bookings', 'reservations', 'payments', 'invoices', 'ledger_items', 'ledger',
  'room_ledger', 'cash_logs', 'cash_submissions', 'audit_logs', 'guests',
  'guest_requests', 'extension_requests', 'feedback', 'idempotency_keys',
  'room_status_history', 'booking_history', 'housekeeping', 'housekeeping_logs',
  'inventory_products', 'inventory_categories', 'staff', 'roles', 'settings',
  'notifications', 'outbox_events', 'razorpay_transactions', 'master_bills',
  'rooms', 'room_types', 'checkout_snapshots'
];

function findTermsInObject(obj, targetTerms, prefix = '') {
  const matches = [];
  if (!obj || typeof obj !== 'object') return matches;

  for (const [key, val] of Object.entries(obj)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (val === null || val === undefined) continue;

    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      const valStr = String(val).trim();
      for (const term of targetTerms) {
        if (valStr === term || valStr.toLowerCase() === term.toLowerCase()) {
          matches.push({ fieldPath, matchedTerm: term, matchedValue: valStr });
        }
      }
    } else if (Array.isArray(val)) {
      val.forEach((item, idx) => {
        if (typeof item === 'object' && item !== null) {
          matches.push(...findTermsInObject(item, targetTerms, `${fieldPath}[${idx}]`));
        } else if (item !== null && item !== undefined) {
          const itemStr = String(item).trim();
          for (const term of targetTerms) {
            if (itemStr === term || itemStr.toLowerCase() === term.toLowerCase()) {
              matches.push({ fieldPath: `${fieldPath}[${idx}]`, matchedTerm: term, matchedValue: itemStr });
            }
          }
        }
      });
    } else if (typeof val === 'object') {
      matches.push(...findTermsInObject(val, targetTerms, fieldPath));
    }
  }

  return matches;
}

async function runPostCleanupAudit() {
  console.log('========================================================================');
  console.log('       HPMS CLOUD FIRESTORE STRICT POST-CLEANUP AUDIT');
  console.log('========================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('Project  : hpms-sky5');
  console.log('Mode     : STRICT READ-ONLY. Zero mutations will be performed.\n');

  if (!db) {
    console.error('ERROR: Firebase Admin DB is not initialized.');
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Audit Canonical room_types
  // ─────────────────────────────────────────────────────────────────────────
  console.log('>>> [1/4] AUDITING CANONICAL ROOM TYPES ...');
  const rtSnap = await db.collection('room_types').get();
  const foundRtDocIds = rtSnap.docs.map(d => d.id).sort();
  console.log(`  Found ${foundRtDocIds.length} document(s) in 'room_types':`, foundRtDocIds.join(', '));

  let canonicalRoomTypesCount = 0;
  for (const expId of EXPECTED_CANONICAL_ROOM_TYPES) {
    const docSnap = await db.collection('room_types').doc(expId).get();
    if (docSnap.exists) {
      const data = docSnap.data();
      canonicalRoomTypesCount++;
      console.log(`  ✓ Canonical RT [${expId}]: Code: ${data.code} | Name: ${data.name || data.title} | Active: ${data.is_active !== false}`);
    } else {
      console.error(`  ✗ MISSING Canonical RT [${expId}]!`);
    }
  }

  const exactRoomTypesMatch = (foundRtDocIds.length === 3) &&
    EXPECTED_CANONICAL_ROOM_TYPES.every(id => foundRtDocIds.includes(id));
  console.log(`  Room Types Match Exact Expected Canonical List: ${exactRoomTypesMatch ? 'YES' : 'NO'}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Audit Canonical rooms
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [2/4] AUDITING CANONICAL ROOMS ...');
  const roomsSnap = await db.collection('rooms').get();
  const foundRoomDocIds = roomsSnap.docs.map(d => d.id).sort();
  console.log(`  Found ${foundRoomDocIds.length} document(s) in 'rooms':`, foundRoomDocIds.join(', '));

  let canonicalRoomsCount = 0;
  for (const expId of EXPECTED_CANONICAL_ROOMS) {
    const docSnap = await db.collection('rooms').doc(expId).get();
    if (docSnap.exists) {
      const data = docSnap.data();
      canonicalRoomsCount++;
      console.log(`  ✓ Canonical Room [${expId.padEnd(10, ' ')}]: RoomNum: ${String(data.number).padEnd(4, ' ')} Type: ${String(data.type).padEnd(12, ' ')} Status: ${String(data.status).padEnd(8, ' ')} HK: ${String(data.housekeeping_status).padEnd(8, ' ')} Active: ${data.is_active !== false}`);
    } else {
      console.error(`  ✗ MISSING Canonical Room [${expId}]!`);
    }
  }

  const exactRoomsMatch = (foundRoomDocIds.length === 17) &&
    EXPECTED_CANONICAL_ROOMS.every(id => foundRoomDocIds.includes(id));
  console.log(`  Rooms Match Exact Expected Canonical List: ${exactRoomsMatch ? 'YES' : 'NO'}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Confirm All 22 Target Fixtures are Absent
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [3/4] VERIFYING ABSENCE OF 22 TARGET DELETION FIXTURES ...');
  let deletedTargetsStillPresent = 0;

  for (let i = 0; i < DELETED_TARGET_FIXTURES.length; i++) {
    const { collection, docId } = DELETED_TARGET_FIXTURES[i];
    const snap = await db.collection(collection).doc(docId).get();
    if (snap.exists) {
      deletedTargetsStillPresent++;
      console.error(`  ✗ Target [${i + 1}/22] STILL PRESENT: ${collection}/${docId}`);
    } else {
      console.log(`  ✓ Target [${String(i + 1).padStart(2, ' ')}/22] CONFIRMED ABSENT: ${collection.padEnd(11, ' ')} / ${docId}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Scan All Collections for References to Deleted Targets
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [4/4] SCANNING ALL COLLECTIONS FOR DANGLING REFERENCES ...');
  let collectionsToScan = [...KNOWN_COLLECTIONS];
  try {
    const rootCols = await db.listCollections();
    const discovered = rootCols.map(c => c.id);
    collectionsToScan = Array.from(new Set([...collectionsToScan, ...discovered])).sort();
  } catch (_) {}

  console.log(`Scanning ${collectionsToScan.length} collections:`, collectionsToScan.join(', '));
  const matchedReferences = [];

  for (const col of collectionsToScan) {
    try {
      const snap = await db.collection(col).get();
      if (snap.empty) continue;

      snap.forEach(docSnap => {
        const docId = docSnap.id;
        const data = docSnap.data();

        const matches = findTermsInObject(data, SEARCH_TERMS);
        if (matches.length > 0) {
          matches.forEach(m => {
            matchedReferences.push({
              collection: col,
              docId,
              fieldPath: m.fieldPath,
              matchedTerm: m.matchedTerm,
              matchedValue: m.matchedValue
            });
          });
        }
      });
    } catch (colErr) {
      console.warn(`  Warning scanning ${col}: ${colErr.message}`);
    }
  }

  console.log(`Dangling Reference Matches Found: ${matchedReferences.length}`);
  if (matchedReferences.length > 0) {
    matchedReferences.forEach(m => {
      console.error(`  ✗ Dangling ref in [${m.collection}/${m.docId}] field: ${m.fieldPath} => "${m.matchedValue}"`);
    });
  } else {
    console.log('  ✓ Zero dangling references found across all collections.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Summary & Status
  // ─────────────────────────────────────────────────────────────────────────
  const isClean = exactRoomTypesMatch &&
    exactRoomsMatch &&
    canonicalRoomTypesCount === 3 &&
    canonicalRoomsCount === 17 &&
    deletedTargetsStillPresent === 0 &&
    matchedReferences.length === 0;

  const status = isClean ? 'CLEAN' : 'NEEDS_REVIEW';

  console.log('\n===============================================================');
  console.log('HPMS POST-CLEANUP FIRESTORE VERIFICATION');
  console.log('===============================================================');
  console.log(`Canonical Room Types: ${canonicalRoomTypesCount}`);
  console.log(`Canonical Rooms: ${canonicalRoomsCount}`);
  console.log(`Deleted Targets Still Present: ${deletedTargetsStillPresent}`);
  console.log(`References To Deleted Targets: ${matchedReferences.length}`);
  console.log('');
  console.log(`STATUS: ${status}`);
  console.log('');
  console.log('NO DATA WAS MODIFIED.');
  console.log('===============================================================');

  if (status === 'CLEAN') {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runPostCleanupAudit().catch(err => {
  console.error('Post-cleanup audit encountered an error:', err);
  console.log('NO DATA WAS MODIFIED.');
  process.exit(1);
});
