/**
 * backend/tests/auditFirestoreSuspectMasterDataReferences.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT READ-ONLY SUSPECT MASTER DATA REFERENCE AUDIT SCRIPT
 *
 * Scans ALL Cloud Firestore collections for references to:
 *   Suspect Room Doc IDs:
 *     - room_901_2177, room_901_7797, room_901_9438, room_902_2177, room_902_7797, room_902_9438
 *   Suspect Room Numbers:
 *     - 901_2177, 901_7797, 901_9438, 902_2177, 902_7797, 902_9438
 *   Suspect Room Type Doc IDs:
 *     - room_type_4, type_RT_2002, type_RT_5000, type_RT_7820
 *   Suspect Room Type Codes:
 *     - P3B_GSL8W, RT_2002, RT_5000, RT_7820
 *
 * Performs zero writes, updates, deletions, or schema mutations.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';

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

const SUSPECT_ROOM_TYPE_DOC_IDS = [
  'room_type_4',
  'type_RT_2002',
  'type_RT_5000',
  'type_RT_7820'
];

const SUSPECT_ROOM_TYPE_CODES = [
  'P3B_GSL8W',
  'RT_2002',
  'RT_5000',
  'RT_7820'
];

// Target search terms set
const TARGET_TERMS = new Set([
  ...SUSPECT_ROOM_DOC_IDS,
  ...SUSPECT_ROOM_NUMBERS,
  ...SUSPECT_ROOM_TYPE_DOC_IDS,
  ...SUSPECT_ROOM_TYPE_CODES
]);

// Known Firestore collections in HPMS architecture
const KNOWN_COLLECTIONS = [
  'bookings',
  'reservations',
  'payments',
  'invoices',
  'ledger_items',
  'ledger',
  'room_ledger',
  'cash_logs',
  'audit_logs',
  'guests',
  'guest_requests',
  'extension_requests',
  'feedback',
  'idempotency_keys',
  'room_status_history',
  'booking_history',
  'housekeeping',
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
  'room_types'
];

function findMatchesInObject(obj, prefix = '') {
  const matches = [];
  if (!obj || typeof obj !== 'object') return matches;

  for (const [key, val] of Object.entries(obj)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (val === null || val === undefined) continue;

    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      const valStr = String(val).trim();
      // Check exact match or inclusion
      for (const term of TARGET_TERMS) {
        if (valStr === term || valStr.toLowerCase() === term.toLowerCase() || (term.length > 5 && valStr.includes(term))) {
          matches.push({
            fieldPath,
            matchedTerm: term,
            matchedValue: valStr
          });
        }
      }
    } else if (Array.isArray(val)) {
      val.forEach((item, idx) => {
        if (typeof item === 'object' && item !== null) {
          matches.push(...findMatchesInObject(item, `${fieldPath}[${idx}]`));
        } else if (item !== null && item !== undefined) {
          const itemStr = String(item).trim();
          for (const term of TARGET_TERMS) {
            if (itemStr === term || itemStr.toLowerCase() === term.toLowerCase() || (term.length > 5 && itemStr.includes(term))) {
              matches.push({
                fieldPath: `${fieldPath}[${idx}]`,
                matchedTerm: term,
                matchedValue: itemStr
              });
            }
          }
        }
      });
    } else if (typeof val === 'object') {
      matches.push(...findMatchesInObject(val, fieldPath));
    }
  }

  return matches;
}

async function auditSuspectMasterDataReferences() {
  console.log('================================================================================');
  console.log('    HPMS CLOUD FIRESTORE SUSPECT MASTER DATA REFERENCE AUDIT (READ-ONLY)       ');
  console.log('================================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('Mode: STRICT READ-ONLY. Zero mutations will be performed.\n');

  if (!db) {
    console.error('ERROR: Firebase Admin db is not initialized.');
    process.exit(1);
  }

  console.log('TARGET SUSPECT ROOM IDS       :', SUSPECT_ROOM_DOC_IDS.join(', '));
  console.log('TARGET SUSPECT ROOM NUMBERS   :', SUSPECT_ROOM_NUMBERS.join(', '));
  console.log('TARGET SUSPECT ROOM TYPE IDS  :', SUSPECT_ROOM_TYPE_DOC_IDS.join(', '));
  console.log('TARGET SUSPECT ROOM TYPE CODES:', SUSPECT_ROOM_TYPE_CODES.join(', '));
  console.log('');

  // 1. Direct Inspection of the Suspect Master Data Documents in rooms & room_types
  console.log('>>> [1/3] DIRECT INSPECTION OF SUSPECT MASTER DOCUMENTS');
  console.log('────────────────────────────────────────────────────────────────────────────────');

  console.log('Checking Suspect Room Documents in collection("rooms"):');
  const suspectRoomDirectFindings = [];
  for (const docId of SUSPECT_ROOM_DOC_IDS) {
    const snap = await db.collection('rooms').doc(docId).get();
    if (snap.exists) {
      const data = snap.data();
      const currentBooking = data.current_booking_id || null;
      const guestId = data.guest_id || data.current_guest_id || null;
      const status = data.status || data.occupancy_status || 'N/A';
      const number = data.number || docId.replace(/^room_/, '');
      suspectRoomDirectFindings.push({
        docId,
        number,
        status,
        currentBooking,
        guestId,
        rawFields: Object.keys(data).sort().join(', ')
      });
      console.log(`  - Doc: [${docId}] | RoomNum: ${number} | Status: ${status} | CurrentBooking: ${currentBooking || 'NONE'} | GuestId: ${guestId || 'NONE'}`);
    } else {
      console.log(`  - Doc: [${docId}] does NOT exist in rooms collection.`);
    }
  }

  console.log('\nChecking Suspect Room Type Documents in collection("room_types"):');
  for (const docId of SUSPECT_ROOM_TYPE_DOC_IDS) {
    const snap = await db.collection('room_types').doc(docId).get();
    if (snap.exists) {
      const data = snap.data();
      const code = data.code || 'N/A';
      const title = data.title || data.name || 'N/A';
      console.log(`  - Doc: [${docId}] | Code: ${code} | Title: ${title}`);
    } else {
      console.log(`  - Doc: [${docId}] does NOT exist in room_types collection.`);
    }
  }

  // 2. Discover all Collections to search
  console.log('\n>>> [2/3] DISCOVERING ALL FIRESTORE ROOT COLLECTIONS ...');
  let discoveredCollections = [];
  try {
    const rootCollections = await db.listCollections();
    discoveredCollections = rootCollections.map(c => c.id);
  } catch (err) {
    console.warn('  Note: db.listCollections() not supported or failed, falling back to known collection list:', err.message);
  }

  // Merge with known collections to ensure complete coverage
  const allCollectionsToScan = Array.from(new Set([...discoveredCollections, ...KNOWN_COLLECTIONS])).sort();
  console.log(`Scanning ${allCollectionsToScan.length} collections:`, allCollectionsToScan.join(', '));
  console.log('');

  // 3. Scan all documents across all collections
  console.log('>>> [3/3] SCANNING COLLECTIONS FOR REFERENCES ...');
  console.log('────────────────────────────────────────────────────────────────────────────────');

  const allReferenceMatches = [];

  for (const colName of allCollectionsToScan) {
    try {
      const snap = await db.collection(colName).get();
      if (snap.empty) continue;

      snap.forEach(docSnap => {
        const docId = docSnap.id;
        const data = docSnap.data();

        // Skip self-declarations (e.g. suspect room document defining its own number/docId in 'rooms')
        if (colName === 'rooms' && SUSPECT_ROOM_DOC_IDS.includes(docId)) {
          return;
        }
        if (colName === 'room_types' && SUSPECT_ROOM_TYPE_DOC_IDS.includes(docId)) {
          return;
        }

        const matches = findMatchesInObject(data);
        if (matches.length > 0) {
          const relatedBooking = data.booking_id || data.booking_number || data.bookingId || data.bookingNumber || null;
          const relatedReservation = data.reservation_id || data.reservation_number || data.reservationId || data.reservationNumber || null;
          const relatedGuest = data.guest_id || data.guestId || data.guest_name || data.guestName || null;

          matches.forEach(m => {
            const isTestLike = /(test|soak|fixture|phase|sample|mock|temp|dummy)/i.test(docId) ||
                               /(test|soak|fixture|phase|sample|mock|temp|dummy)/i.test(JSON.stringify(data));

            allReferenceMatches.push({
              collection: colName,
              docId,
              fieldPath: m.fieldPath,
              matchedTerm: m.matchedTerm,
              matchedValue: m.matchedValue,
              relatedBooking,
              relatedReservation,
              relatedGuest,
              nature: isTestLike ? 'TEST_FIXTURE_REFERENCE' : 'OPERATIONAL_REFERENCE'
            });
          });
        }
      });
    } catch (colErr) {
      console.warn(`  Warning: Could not scan collection '${colName}': ${colErr.message}`);
    }
  }

  // 4. Report Findings
  console.log('\n================================================================================');
  console.log('                          REFERENCE AUDIT RESULTS                               ');
  console.log('================================================================================');

  if (allReferenceMatches.length === 0) {
    console.log('NO FIRESTORE REFERENCES FOUND FOR SUSPECT MASTER DATA.\n');
    console.log('Search summary:');
    console.log('  - Scanned Collections : ' + allCollectionsToScan.length);
    console.log('  - Total Matched Refs  : 0');
    console.log('');
    console.log('================================================================================');
    console.log('SAFE_TO_DELETE:');
    console.log('YES');
    console.log('Explanation: Zero historical or active references exist in any Firestore');
    console.log('collection (bookings, reservations, payments, invoices, ledger, cash_logs,');
    console.log('audit_logs, housekeeping, or guest records) for any of the 6 suspect rooms');
    console.log('or 4 suspect room types.');
    console.log('================================================================================');
  } else {
    console.log(`FOUND ${allReferenceMatches.length} REFERENCE(S) IN FIRESTORE:\n`);
    console.log(
      '| Collection         | Document ID               | Matched Field        | Matched Value       | Nature                   | Related Info'
    );
    console.log(
      '|--------------------|---------------------------|----------------------|---------------------|--------------------------|--------------------------------'
    );

    allReferenceMatches.forEach(r => {
      const col = String(r.collection).padEnd(18, ' ');
      const doc = String(r.docId).slice(0, 25).padEnd(25, ' ');
      const field = String(r.fieldPath).slice(0, 20).padEnd(20, ' ');
      const val = String(r.matchedValue).slice(0, 19).padEnd(19, ' ');
      const nature = String(r.nature).padEnd(24, ' ');
      const related = `Bkg:${r.relatedBooking || '-'} | Res:${r.relatedReservation || '-'} | Gst:${r.relatedGuest || '-'}`;
      console.log(`| ${col} | ${doc} | ${field} | ${val} | ${nature} | ${related}`);
    });

    console.log('\nDetailed Reference Findings:\n');
    allReferenceMatches.forEach((r, idx) => {
      console.log(`[REF-${idx + 1}] Collection: ${r.collection} | DocId: ${r.docId}`);
      console.log(`        MatchedField: ${r.fieldPath} => "${r.matchedValue}" (Term: ${r.matchedTerm})`);
      console.log(`        Nature: ${r.nature}`);
      console.log(`        Related: Booking=${r.relatedBooking || 'N/A'}, Reservation=${r.relatedReservation || 'N/A'}, Guest=${r.relatedGuest || 'N/A'}`);
      console.log('');
    });

    const hasOperationalRefs = allReferenceMatches.some(r => r.nature === 'OPERATIONAL_REFERENCE');

    console.log('================================================================================');
    console.log('SAFE_TO_DELETE:');
    if (hasOperationalRefs) {
      console.log('NO');
      console.log('Explanation: Operational references were discovered for one or more suspect records.');
    } else {
      console.log('NEEDS_REVIEW');
      console.log('Explanation: References were found, but they appear to be contained within other test fixtures/artifacts.');
    }
    console.log('================================================================================');
  }

  console.log('NO DATA WAS MODIFIED.');
  console.log('================================================================================');
}

auditSuspectMasterDataReferences()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('Audit encountered an unexpected error:', err);
    console.log('NO DATA WAS MODIFIED.');
    process.exit(1);
  });
