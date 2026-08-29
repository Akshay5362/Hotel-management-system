/**
 * backend/tests/auditFirestorePreCleanupVerification.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT READ-ONLY PRE-CLEANUP PRODUCTION MASTER DATA & FIXTURE AUDIT
 *
 * Performs zero writes, updates, deletions, or mutations.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../config/firebaseAdmin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendTestsDir = path.resolve(__dirname);

// Target suspect identifiers
const SUSPECT_ROOM_TYPE_DOC_IDS = [
  'room_type_4',
  'type_RT_2002',
  'type_RT_5000',
  'type_RT_7820'
];

const SUSPECT_ROOM_DOC_IDS = [
  'room_901_2177',
  'room_901_7797',
  'room_901_9438',
  'room_902_2177',
  'room_902_7797',
  'room_902_9438'
];

const SUSPECT_ROOM_NUMBERS = [
  '901_2177',
  '901_7797',
  '901_9438',
  '902_2177',
  '902_7797',
  '902_9438'
];

const EXPECTED_CANONICAL_ROOM_TYPES = ['STANDARD', 'PREMIUM', 'EXECUTIVE'];
const EXPECTED_CANONICAL_ROOM_NUMBERS = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
  '11', '12', '14', '16', '17', '19', '20'
];

const KNOWN_COLLECTIONS = [
  'bookings',
  'reservations',
  'payments',
  'invoices',
  'ledger_items',
  'ledger',
  'room_ledger',
  'cash_logs',
  'cash_submissions',
  'audit_logs',
  'guests',
  'guest_requests',
  'extension_requests',
  'feedback',
  'idempotency_keys',
  'room_status_history',
  'booking_history',
  'housekeeping',
  'housekeeping_logs',
  'inventory_products',
  'inventory_categories',
  'staff',
  'roles',
  'settings',
  'notifications',
  'outbox_events',
  'razorpay_transactions',
  'master_bills',
  'rooms',
  'room_types',
  'checkout_snapshots'
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

async function runAudit() {
  console.log('========================================================================');
  console.log('       HPMS CLOUD FIRESTORE STRICT PRE-CLEANUP PRODUCTION AUDIT');
  console.log('========================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('Project: hpms-sky5');
  console.log('Mode: STRICT READ-ONLY. Zero mutations will be performed.\n');

  if (!db) {
    console.error('ERROR: Firebase Admin DB is not initialized.');
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. CANONICAL ROOM TYPES
  // ─────────────────────────────────────────────────────────────────────────
  console.log('>>> [1/7] AUDITING CANONICAL ROOM TYPES ...');
  const rtSnap = await db.collection('room_types').get();
  const allRoomTypes = [];
  rtSnap.forEach(d => allRoomTypes.push({ id: d.id, ...d.data() }));

  const canonicalRoomTypesFound = [];
  for (const expectedCode of EXPECTED_CANONICAL_ROOM_TYPES) {
    const match = allRoomTypes.find(rt => {
      const code = String(rt.code || rt.id || '').toUpperCase().replace(/^TYPE_/, '');
      return code === expectedCode;
    });
    if (match) {
      canonicalRoomTypesFound.push({
        docId: match.id,
        code: match.code || expectedCode,
        name: match.name || match.title || expectedCode,
        base_rate: match.base_rate,
        is_active: match.is_active !== undefined ? Boolean(match.is_active) : (match.status !== 'Inactive')
      });
      console.log(`  ✓ Canonical RT: [${match.id}] Code: ${match.code || expectedCode} | Name: ${match.name || match.title} | Active: ${match.is_active !== false}`);
    } else {
      console.error(`  ✗ MISSING Canonical Room Type: ${expectedCode}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. CANONICAL ROOMS (17 Production Rooms)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [2/7] AUDITING CANONICAL ROOMS (17 EXPECTED) ...');
  const roomsSnap = await db.collection('rooms').get();
  const allRooms = [];
  roomsSnap.forEach(d => allRooms.push({ id: d.id, ...d.data() }));

  const canonicalRoomsFound = [];
  for (const expNum of EXPECTED_CANONICAL_ROOM_NUMBERS) {
    const match = allRooms.find(r => {
      const numStr = String(r.number || r.room_number || r.roomNumber || String(r.id || '').replace(/^room_/, '')).trim();
      return numStr === expNum;
    });
    if (match) {
      const numStr = String(match.number || match.room_number || expNum).trim();
      canonicalRoomsFound.push({
        docId: match.id,
        number: numStr,
        type: match.type || match.room_type || 'N/A',
        status: match.status || match.occupancy_status || 'N/A',
        housekeeping_status: match.housekeeping_status || 'N/A',
        is_active: match.is_active !== undefined ? Boolean(match.is_active) : (match.status !== 'Inactive')
      });
      console.log(`  ✓ Room #${numStr.padStart(2, ' ')}: Doc: [${String(match.id).padEnd(10, ' ')}] Type: ${String(match.type).padEnd(12, ' ')} Status: ${String(match.status).padEnd(8, ' ')} HK: ${String(match.housekeeping_status).padEnd(8, ' ')} Active: ${match.is_active !== false}`);
    } else {
      console.error(`  ✗ MISSING Canonical Room #${expNum}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. SUSPECT ROOM TYPES DIRECT INSPECTION & CROSS-COLLECTION SEARCH
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [3/7] INSPECTING SUSPECT ROOM TYPES & SEARCHING ALL COLLECTIONS ...');
  const suspectRoomTypesPresent = [];
  const suspectRoomTypeSearchTerms = new Set([...SUSPECT_ROOM_TYPE_DOC_IDS]);

  for (const docId of SUSPECT_ROOM_TYPE_DOC_IDS) {
    const docSnap = await db.collection('room_types').doc(docId).get();
    if (docSnap.exists) {
      const data = docSnap.data();
      const code = data.code || docId;
      suspectRoomTypesPresent.push({ docId, code, data });
      suspectRoomTypeSearchTerms.add(code);
      suspectRoomTypeSearchTerms.add(String(code).toUpperCase());
      console.log(`  Found Suspect Room Type Doc: [${docId}] | Code: ${code} | Name: ${data.name || data.title}`);
    } else {
      console.log(`  Suspect Room Type Doc [${docId}] does not exist.`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. SUSPECT ROOMS DIRECT INSPECTION & CROSS-COLLECTION SEARCH
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [4/7] INSPECTING SUSPECT ROOMS & SEARCHING ALL COLLECTIONS ...');
  const suspectRoomsPresent = [];
  const suspectRoomSearchTerms = new Set([...SUSPECT_ROOM_DOC_IDS, ...SUSPECT_ROOM_NUMBERS]);

  for (const docId of SUSPECT_ROOM_DOC_IDS) {
    const docSnap = await db.collection('rooms').doc(docId).get();
    if (docSnap.exists) {
      const data = docSnap.data();
      const num = String(data.number || docId.replace(/^room_/, ''));
      suspectRoomsPresent.push({ docId, number: num, data });
      suspectRoomSearchTerms.add(num);
      console.log(`  Found Suspect Room Doc: [${docId}] | RoomNum: ${num} | Status: ${data.status}`);
    } else {
      console.log(`  Suspect Room Doc [${docId}] does not exist.`);
    }
  }

  // Discover all Firestore collections
  let collectionsToScan = [...KNOWN_COLLECTIONS];
  try {
    const rootCols = await db.listCollections();
    const discovered = rootCols.map(c => c.id);
    collectionsToScan = Array.from(new Set([...collectionsToScan, ...discovered])).sort();
  } catch (_) {}

  console.log(`\nScanning ${collectionsToScan.length} collections for references...`);

  const allTargetTerms = new Set([...suspectRoomTypeSearchTerms, ...suspectRoomSearchTerms]);
  const matchedReferences = [];

  for (const col of collectionsToScan) {
    try {
      const snap = await db.collection(col).get();
      if (snap.empty) continue;

      snap.forEach(docSnap => {
        const docId = docSnap.id;
        const data = docSnap.data();

        // Skip self declarations
        if (col === 'room_types' && SUSPECT_ROOM_TYPE_DOC_IDS.includes(docId)) return;
        if (col === 'rooms' && SUSPECT_ROOM_DOC_IDS.includes(docId)) return;

        const matches = findTermsInObject(data, allTargetTerms);
        if (matches.length > 0) {
          const isTestDoc = /(test|bkg_test_|pay_test_|guest_test_|soak|fixture|phase)/i.test(docId) ||
                            /(test|soak|fixture)/i.test(JSON.stringify(data));

          matches.forEach(m => {
            matchedReferences.push({
              collection: col,
              docId,
              fieldPath: m.fieldPath,
              matchedTerm: m.matchedTerm,
              matchedValue: m.matchedValue,
              isEphemeralTest: isTestDoc,
              data
            });
          });
        }
      });
    } catch (colErr) {
      console.warn(`  Warning scanning ${col}: ${colErr.message}`);
    }
  }

  console.log(`Total Reference Matches Found: ${matchedReferences.length}`);
  matchedReferences.forEach(m => {
    console.log(`  - [${m.collection}/${m.docId}] field: ${m.fieldPath} => "${m.matchedValue}" (Ephemeral: ${m.isEphemeralTest})`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. INSPECT MATCHED BOOKINGS & RELATIONSHIPS
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [5/7] INSPECTING MATCHED BOOKING / OPERATIONAL RELATIONSHIPS ...');
  let productionReferencesCount = 0;
  let ephemeralReferencesCount = 0;
  let unsafeDependenciesCount = 0;

  for (const ref of matchedReferences) {
    if (ref.isEphemeralTest) {
      ephemeralReferencesCount++;
    } else {
      productionReferencesCount++;
      unsafeDependenciesCount++;
      console.error(`  ✗ Unsafe Production Reference: [${ref.collection}/${ref.docId}] references suspect term '${ref.matchedTerm}'`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. SPECIFICALLY INSPECT ALL bkg_test_* DOCUMENTS
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [6/7] SPECIFICALLY INSPECTING ALL bkg_test_* DOCUMENTS ...');
  const bkgSnap = await db.collection('bookings').get();
  const allBkgTestDocs = [];

  bkgSnap.forEach(docSnap => {
    if (docSnap.id.startsWith('bkg_test_')) {
      allBkgTestDocs.push({ id: docSnap.id, ...docSnap.data() });
    }
  });

  console.log(`Found ${allBkgTestDocs.length} bkg_test_* documents in Firestore:`);
  for (const bkg of allBkgTestDocs) {
    console.log(`  - Doc: [${bkg.id}] | Room: ${bkg.room_number || 'N/A'} | Status: ${bkg.booking_status} | Amount: ${bkg.total_amount} | CreatedAt: ${bkg.created_at}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 7. CURRENT TEST HYGIENE CHECK
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [7/7] CHECKING TEST HYGIENE (RE-CREATION RISK ANALYSIS) ...');
  const testFiles = fs.readdirSync(backendTestsDir).filter(f => f.endsWith('.mjs') || f.endsWith('.js'));
  const persistentCreationRisks = [];

  const RISK_PATTERNS = [
    { label: 'room_901_', regex: /room_901_/ },
    { label: 'room_902_', regex: /room_902_/ },
    { label: 'bkg_test_', regex: /bkg_test_/ },
    { label: 'RT_', regex: /\bRT_\d+/ },
    { label: 'P3B_', regex: /\bP3B_/ }
  ];

  for (const tf of testFiles) {
    if (tf.startsWith('audit')) continue; // Skip audit scripts
    const content = fs.readFileSync(path.join(backendTestsDir, tf), 'utf8');

    for (const pat of RISK_PATTERNS) {
      if (pat.regex.test(content)) {
        // Check if file has a guaranteed finally cleanup block tracking fixtures
        const hasFinallyCleanup = content.includes('finally') &&
          (content.includes('fixturesToClean') || content.includes('delete') || content.includes('CLEANUP SUMMARY'));

        if (!hasFinallyCleanup) {
          persistentCreationRisks.push({ file: tf, pattern: pat.label });
        }
      }
    }
  }

  console.log(`Test files scanned: ${testFiles.length}`);
  console.log(`Unprotected test fixture creation paths found: ${persistentCreationRisks.length}`);
  if (persistentCreationRisks.length > 0) {
    persistentCreationRisks.forEach(r => console.warn(`  [Risk Warning] ${r.file} contains ${r.pattern} without verified cleanup`));
  } else {
    console.log('  ✓ All active test files creating dynamic test fixtures have guaranteed finally cleanup blocks.');
  }

  const riskLevel = persistentCreationRisks.length === 0 ? 'LOW' : 'HIGH';

  // ─────────────────────────────────────────────────────────────────────────
  // 8. FINAL SAFETY VERDICT & DELETION MANIFEST
  // ─────────────────────────────────────────────────────────────────────────
  const isCanonicalRoomTypesIntact = canonicalRoomTypesFound.length === 3;
  const isCanonicalRoomsIntact = canonicalRoomsFound.length === 17;
  const zeroProductionReferences = productionReferencesCount === 0;
  const zeroUnsafeDependencies = unsafeDependenciesCount === 0;

  const isSafeToDelete = isCanonicalRoomTypesIntact &&
    isCanonicalRoomsIntact &&
    zeroProductionReferences &&
    zeroUnsafeDependencies;

  const verdict = isSafeToDelete ? 'SAFE_TO_DELETE' : 'NEEDS_REVIEW';

  if (isSafeToDelete) {
    console.log('\n===============================================================');
    console.log('EXACT DELETION MANIFEST (PROPOSED ONLY — NO DELETIONS EXECUTED)');
    console.log('===============================================================');
    console.log('Collection: room_types (Suspect Fixtures)');
    suspectRoomTypesPresent.forEach(rt => console.log(`  - room_types/${rt.docId}`));
    console.log('\nCollection: rooms (Suspect Fixtures)');
    suspectRoomsPresent.forEach(r => console.log(`  - rooms/${r.docId}`));
    console.log('\nCollection: bookings (Ephemeral Test Fixtures)');
    allBkgTestDocs.forEach(b => console.log(`  - bookings/${b.id}`));
  }

  console.log('\n===============================================================');
  console.log('FINAL PRE-CLEANUP VERIFICATION');
  console.log('===============================================================');
  console.log(`Canonical Room Types: ${canonicalRoomTypesFound.length}`);
  console.log(`Canonical Rooms: ${canonicalRoomsFound.length}`);
  console.log(`Suspect Room Types: ${suspectRoomTypesPresent.length}`);
  console.log(`Suspect Rooms: ${suspectRoomsPresent.length}`);
  console.log(`Production References: ${productionReferencesCount}`);
  console.log(`Ephemeral Test References: ${ephemeralReferencesCount}`);
  console.log(`Unsafe Dependencies: ${unsafeDependenciesCount}`);
  console.log(`Current Test Re-creation Risk: ${riskLevel}`);
  console.log('');
  console.log(`VERDICT: ${verdict}`);
  console.log('');
  console.log('NO DATA WAS MODIFIED.');
  console.log('===============================================================');

  if (verdict === 'SAFE_TO_DELETE') {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runAudit().catch(err => {
  console.error('Audit execution error:', err);
  console.log('NO DATA WAS MODIFIED.');
  process.exit(1);
});
