/**
 * backend/tests/investigateProtectedDataDiscrepancy.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT READ-ONLY PROTECTED DATA DISCREPANCY INVESTIGATION
 *
 * Target: hpms-sky5
 * Mode  : STRICT READ-ONLY
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db, firebaseApp } from '../config/firebaseAdmin.js';

const CS_IDS = [
  'cs_CS-20260819-0001', 'cs_CS-20260819-0002', 'cs_CS-20260819-0003',
  'cs_CS-20260819-0004', 'cs_CS-20260819-0005', 'cs_CS-20260819-0006',
  'cs_CS-20260819-0007', 'cs_CS-20260819-0008', 'cs_CS-20260819-0009',
  'cs_CS-20260819-0010', 'cs_CS-20260819-0011'
];

const PAY_BKG_IDS = [
  'payment_BKG-203121_1', 'payment_BKG-399970_1',
  'payment_BKG-701920_1', 'payment_BKG-999448_1'
];

const LEDGER_BKG_IDS = [
  'ledger_BKG-203121_1', 'ledger_BKG-203121_2', 'ledger_BKG-245851_1',
  'ledger_BKG-354526_1', 'ledger_BKG-378544_1', 'ledger_BKG-399970_1',
  'ledger_BKG-399970_2', 'ledger_BKG-517027_1', 'ledger_BKG-543364_1',
  'ledger_BKG-550332_1', 'ledger_BKG-559949_1', 'ledger_BKG-561889_1',
  'ledger_BKG-603209_1', 'ledger_BKG-692901_1', 'ledger_BKG-701920_1',
  'ledger_BKG-701920_2', 'ledger_BKG-748655_1', 'ledger_BKG-986794_1',
  'ledger_BKG-999448_1', 'ledger_BKG-999448_2'
];

async function investigate() {
  console.log('========================================================================');
  console.log('HPMS PROTECTED DATA DISCREPANCY INVESTIGATION');
  console.log('========================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  // Part 2: Project info
  const projectId = firebaseApp ? firebaseApp.options.projectId || process.env.FIREBASE_PROJECT_ID : 'UNKNOWN';
  console.log(`Firebase Project ID: ${projectId}`);

  // Part 1 & 3: Direct reads on cash_submissions
  console.log('\n>>> [PART 1 & 3] DIRECT READ: cash_submissions ...');
  const csColSnap = await db.collection('cash_submissions').get();
  console.log(`  collection('cash_submissions').get() => size: ${csColSnap.size}`);
  csColSnap.docs.forEach(d => console.log(`    Doc in collection: [${d.id}] =>`, JSON.stringify(d.data())));

  console.log('  Direct doc(id).get() on expected 11 IDs:');
  let csDirectFound = 0;
  for (const id of CS_IDS) {
    const snap = await db.collection('cash_submissions').doc(id).get();
    if (snap.exists) {
      csDirectFound++;
      console.log(`    ✓ Exists: ${id} =>`, JSON.stringify(snap.data()));
    } else {
      console.log(`    ✗ Absent: ${id}`);
    }
  }

  // Part 1 & 3: Direct reads on payments
  console.log('\n>>> [PART 1 & 3] DIRECT READ: payments ...');
  const payColSnap = await db.collection('payments').get();
  console.log(`  collection('payments').get() => size: ${payColSnap.size}`);
  payColSnap.docs.forEach(d => console.log(`    Doc in collection: [${d.id}] =>`, JSON.stringify(d.data())));

  console.log('  Direct doc(id).get() on expected payment_BKG-* IDs:');
  let payDirectFound = 0;
  for (const id of PAY_BKG_IDS) {
    const snap = await db.collection('payments').doc(id).get();
    if (snap.exists) {
      payDirectFound++;
      console.log(`    ✓ Exists: ${id} =>`, JSON.stringify(snap.data()));
    } else {
      console.log(`    ✗ Absent: ${id}`);
    }
  }

  // Part 1 & 3: Direct reads on ledger_items
  console.log('\n>>> [PART 1 & 3] DIRECT READ: ledger_items ...');
  const liColSnap = await db.collection('ledger_items').get();
  console.log(`  collection('ledger_items').get() => size: ${liColSnap.size}`);
  liColSnap.docs.forEach(d => console.log(`    Doc in collection: [${d.id}] =>`, JSON.stringify(d.data())));

  console.log('  Direct doc(id).get() on expected ledger_BKG-* IDs:');
  let liDirectFound = 0;
  for (const id of LEDGER_BKG_IDS) {
    const snap = await db.collection('ledger_items').doc(id).get();
    if (snap.exists) {
      liDirectFound++;
      console.log(`    ✓ Exists: ${id} =>`, JSON.stringify(snap.data()));
    } else {
      console.log(`    ✗ Absent: ${id}`);
    }
  }

  // Check audit_logs to see if any recent audit/reset occurred
  console.log('\n>>> [AUDIT LOGS CHECK] ...');
  const auditSnap = await db.collection('audit_logs').get();
  auditSnap.forEach(d => console.log(`  Audit Log [${d.id}]:`, JSON.stringify(d.data())));

  console.log('\n========================================================================');
  console.log('INVESTIGATION SUMMARY:');
  console.log(`Firebase Project: ${projectId}`);
  console.log(`cash_submissions : Found ${csColSnap.size} by collection, ${csDirectFound}/11 by direct ID`);
  console.log(`payment_BKG-*    : Found ${payColSnap.size} by collection, ${payDirectFound}/4 by direct ID`);
  console.log(`ledger_BKG-*     : Found ${liColSnap.size} by collection, ${liDirectFound}/20 by direct ID`);
  console.log('========================================================================');
}

investigate().then(() => process.exit(0)).catch(err => {
  console.error('Investigation error:', err);
  process.exit(1);
});