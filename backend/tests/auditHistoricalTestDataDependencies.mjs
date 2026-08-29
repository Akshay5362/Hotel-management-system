/**
 * backend/tests/auditHistoricalTestDataDependencies.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT READ-ONLY HISTORICAL TEST DATA DEPENDENCY AUDIT
 *
 * Target: hpms-sky5
 * Mode  : STRICT READ-ONLY
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';

const KNOWN_COLLECTIONS = [
  'audit_logs', 'booking_history', 'bookings', 'cash_logs', 'cash_submissions',
  'checkout_snapshots', 'counters', 'extension_requests', 'feedback',
  'guest_requests', 'guests', 'housekeeping', 'housekeeping_logs',
  'idempotency_keys', 'inventory_categories', 'inventory_products', 'invoices',
  'ledger', 'ledger_items', 'master_bills', 'notifications', 'outbox_events',
  'payments', 'permissions', 'razorpay_transactions', 'reservations',
  'role_permissions', 'roles', 'room_ledger', 'room_shift_adjustments',
  'room_status_history', 'room_types', 'rooms', 'settings', 'staff',
  'system_settings', 'users'
];

const TEST_ID_REGEX = /^(test_|fixture_|bkg_test_|pay_test_|guest_test_|mock_|dummy_)|_test_/i;

function isTestIdentifier(id, data = {}) {
  if (TEST_ID_REGEX.test(id)) return true;
  if (/^(booking_conc_|booking_serv_|booking_upi_|res_RES-202[67]|guest_17876|payment_conc_|payment_serv_|payment_upi_|payment_test_|invoice_conc_|invoice_serv_|invoice_test_|cash_BKG-TEST-|snap_bkg_booking_test_|bh_booking_test_|audit_adj_booking_test_)/i.test(id)) return true;
  if (data.is_test === true || data.test_fixture === true) return true;
  if (data.source === 'TEST' || data.source === 'CANARY_TEST') return true;
  return false;
}

async function runDependencyAudit() {
  console.log('===============================================================');
  console.log('HPMS HISTORICAL TEST DATA DEPENDENCY AUDIT');
  console.log('===============================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('Project  : hpms-sky5');
  console.log('Mode     : STRICT READ-ONLY\n');

  if (!db) {
    console.error('CRITICAL: Firebase Admin DB is not initialized.');
    process.exit(1);
  }

  // 1. Fetch all collections
  const collectionsData = new Map();
  const allCollectionNames = [...KNOWN_COLLECTIONS];

  try {
    const rootCols = await db.listCollections();
    rootCols.forEach(c => {
      if (!allCollectionNames.includes(c.id)) allCollectionNames.push(c.id);
    });
  } catch (_) {}

  for (const colName of allCollectionNames) {
    const snap = await db.collection(colName).get();
    const docs = [];
    snap.forEach(d => docs.push({ id: d.id, collection: colName, ...d.data() }));
    collectionsData.set(colName, docs);
  }

  // 2. Separate Production Records vs Suspicious Test Records
  const suspiciousRecords = [];
  const prodRecords = [];

  for (const [colName, docs] of collectionsData.entries()) {
    // Preserve canonical master data entirely
    if (colName === 'rooms' || colName === 'room_types' || colName === 'roles' || colName === 'permissions' || colName === 'users') {
      prodRecords.push(...docs);
      continue;
    }

    for (const doc of docs) {
      if (isTestIdentifier(doc.id, doc)) {
        suspiciousRecords.push(doc);
      } else {
        prodRecords.push(doc);
      }
    }
  }

  console.log(`Total Scanned Collections : ${collectionsData.size}`);
  console.log(`Total Documents Scanned   : ${[...collectionsData.values()].reduce((acc, d) => acc + d.length, 0)}`);
  console.log(`Total Suspicious Records  : ${suspiciousRecords.length}`);
  console.log(`Total Production Records  : ${prodRecords.length}\n`);

  // Build index of all searchable identifiers for each suspicious record
  const suspiciousMap = new Map(); // id -> suspiciousRecord
  suspiciousRecords.forEach(r => suspiciousMap.set(r.id, r));

  // Cross-reference scanner
  const dependencyGraph = []; // { doc, parentRefs, childRefs, prodRefs, classification }

  for (const suspect of suspiciousRecords) {
    const suspectCol = suspect.collection;
    const suspectId = suspect.id;

    // Keys and identifiers associated with this suspect
    const associatedKeys = new Set([
      suspectId,
      suspect.booking_number,
      suspect.bookingNumber,
      suspect.invoice_number,
      suspect.invoiceNumber,
      suspect.payment_id,
      suspect.transaction_id,
      suspect.reservation_number
    ].filter(Boolean).map(String));

    // 1. Find parents referenced by suspect
    const parentRefs = [];
    if (suspect.booking_id && suspect.booking_id !== suspectId) parentRefs.push(`bookings/${suspect.booking_id}`);
    if (suspect.guest_id) parentRefs.push(`guests/${suspect.guest_id}`);
    if (suspect.room_id) parentRefs.push(`rooms/${suspect.room_id}`);
    if (suspect.room_number) parentRefs.push(`rooms/${suspect.room_number}`);
    if (suspect.invoice_id) parentRefs.push(`invoices/${suspect.invoice_id}`);
    if (suspect.payment_id && suspect.payment_id !== suspectId) parentRefs.push(`payments/${suspect.payment_id}`);
    if (suspect.submission_id) parentRefs.push(`cash_submissions/${suspect.submission_id}`);

    // 2. Find children / dependents across ALL collections
    const childRefs = [];
    const prodRefs = [];

    for (const [colName, docs] of collectionsData.entries()) {
      for (const otherDoc of docs) {
        if (otherDoc.collection === suspectCol && otherDoc.id === suspectId) continue;

        // Check if otherDoc references any of associatedKeys
        const otherStr = JSON.stringify(otherDoc);
        let matches = false;
        for (const key of associatedKeys) {
          if (otherStr.includes(`"${key}"`) || otherStr.includes(`/${key}`)) {
            matches = true;
            break;
          }
        }

        if (matches) {
          const refDesc = `${colName}/${otherDoc.id}`;
          if (suspiciousMap.has(otherDoc.id)) {
            childRefs.push(refDesc);
          } else {
            prodRefs.push(refDesc);
          }
        }
      }
    }

    // 3. Determine Classification
    let classification = 'UNKNOWN';
    if (prodRefs.length > 0) {
      classification = 'PRODUCTION_DEPENDENCY';
    } else if (childRefs.length === 0 && parentRefs.length === 0) {
      classification = 'SAFE_TEST_ISOLATED';
    } else if (childRefs.length > 0 && parentRefs.length === 0) {
      classification = 'HISTORICAL_TEST_CHAIN';
    } else if (childRefs.length === 0 && parentRefs.length > 0) {
      classification = 'TEST_WITH_TEST_DEPENDENCIES';
    } else {
      classification = 'HISTORICAL_TEST_CHAIN';
    }

    dependencyGraph.push({
      collection: suspectCol,
      docId: suspectId,
      createdAt: suspect.created_at || suspect.timestamp || suspect.date || 'N/A',
      businessDate: suspect.business_date || 'N/A',
      status: suspect.status || suspect.payment_status || 'N/A',
      parentRefs: Array.from(new Set(parentRefs)),
      childRefs: Array.from(new Set(childRefs)),
      prodRefs: Array.from(new Set(prodRefs)),
      classification
    });
  }

  // Summary counts
  const summaryCounts = {
    SAFE_TEST_ISOLATED: dependencyGraph.filter(d => d.classification === 'SAFE_TEST_ISOLATED').length,
    TEST_WITH_TEST_DEPENDENCIES: dependencyGraph.filter(d => d.classification === 'TEST_WITH_TEST_DEPENDENCIES').length,
    HISTORICAL_TEST_CHAIN: dependencyGraph.filter(d => d.classification === 'HISTORICAL_TEST_CHAIN').length,
    PRODUCTION_DEPENDENCY: dependencyGraph.filter(d => d.classification === 'PRODUCTION_DEPENDENCY').length,
    NEEDS_REVIEW: dependencyGraph.filter(d => d.classification === 'NEEDS_REVIEW').length,
    UNKNOWN: dependencyGraph.filter(d => d.classification === 'UNKNOWN').length
  };

  console.log('===============================================================');
  console.log('SUMMARY CLASSIFICATION');
  console.log('===============================================================');
  console.log(`Total suspicious records          : ${dependencyGraph.length}`);
  console.log(`Total SAFE_TEST_ISOLATED          : ${summaryCounts.SAFE_TEST_ISOLATED}`);
  console.log(`Total TEST_WITH_TEST_DEPENDENCIES : ${summaryCounts.TEST_WITH_TEST_DEPENDENCIES}`);
  console.log(`Total HISTORICAL_TEST_CHAIN       : ${summaryCounts.HISTORICAL_TEST_CHAIN}`);
  console.log(`Total PRODUCTION_DEPENDENCY       : ${summaryCounts.PRODUCTION_DEPENDENCY}`);
  console.log(`Total NEEDS_REVIEW                : ${summaryCounts.NEEDS_REVIEW}`);
  console.log(`Total UNKNOWN                     : ${summaryCounts.UNKNOWN}\n`);

  // Print Dependency Breakdown by Collection
  console.log('===============================================================');
  console.log('DEPENDENCY GRAPH BY COLLECTION');
  console.log('===============================================================');
  const byCol = {};
  dependencyGraph.forEach(d => {
    if (!byCol[d.collection]) byCol[d.collection] = [];
    byCol[d.collection].push(d);
  });

  for (const [col, records] of Object.entries(byCol)) {
    console.log(`\n--- Collection: ${col} (${records.length} records) ---`);
    records.forEach(r => {
      console.log(`  • [${r.docId}] | Class: ${r.classification}`);
      if (r.parentRefs.length > 0) console.log(`      Parents: ${r.parentRefs.join(', ')}`);
      if (r.childRefs.length > 0) console.log(`      Children: ${r.childRefs.join(', ')}`);
      if (r.prodRefs.length > 0) console.log(`      PROD REFS: ${r.prodRefs.join(', ')}`);
    });
  }

  // Theoretical Deletion Order (Bottom-Up DAG topological ordering)
  console.log('\n===============================================================');
  console.log('THEORETICAL SAFE DELETION ORDER (LEAVES FIRST)');
  console.log('===============================================================');
  const deletionPhases = [
    { phase: 1, name: 'Leaf Historical Logs & Snapshots', collections: ['audit_logs', 'booking_history', 'checkout_snapshots'] },
    { phase: 2, name: 'Cash Logs', collections: ['cash_logs'] },
    { phase: 3, name: 'Financial Line Items & Payments', collections: ['ledger_items', 'payments'] },
    { phase: 4, name: 'Invoices', collections: ['invoices'] },
    { phase: 5, name: 'Bookings & Reservations', collections: ['bookings', 'reservations'] },
    { phase: 6, name: 'Test Guests', collections: ['guests'] }
  ];

  deletionPhases.forEach(p => {
    const phaseRecords = dependencyGraph.filter(d => p.collections.includes(d.collection));
    console.log(`Phase ${p.phase}: ${p.name} (${phaseRecords.length} records)`);
    phaseRecords.forEach(r => console.log(`  - ${r.collection}/${r.docId}`));
  });

  console.log('\n===============================================================');
  console.log('PRODUCTION DATA MODIFIED:');
  console.log('NO');
  console.log('');
  console.log('FINAL VERDICT:');
  console.log(summaryCounts.PRODUCTION_DEPENDENCY === 0 ? 'READY_FOR_SCOPED_CLEANUP' : 'NEEDS_REVIEW');
  console.log('');
  console.log('NO DATA WAS MODIFIED.');
  console.log('===============================================================');
}

runDependencyAudit().then(() => process.exit(0)).catch(err => {
  console.error('Dependency audit error:', err);
  console.log('NO DATA WAS MODIFIED.');
  process.exit(1);
});
