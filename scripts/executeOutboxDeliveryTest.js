import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';
import { processOutboxBatch } from '../backend/services/outboxWorker.js';

async function runOutboxDeliveryTest() {
  console.log('\n================================================================');
  console.log('  HPMS SKY5 — FIRST LOCAL OUTBOX DELIVERY TEST');
  console.log('================================================================\n');

  try {
    // STEP 1: Enable Worker env in memory
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    process.env.ENABLE_FIRESTORE_OUTBOX_WORKER = 'true';

    console.log('STEP 1: Feature Flags Set for Test');
    console.log(` - ENABLE_FIRESTORE_DUAL_WRITE  : ${process.env.ENABLE_FIRESTORE_DUAL_WRITE}`);
    console.log(` - ENABLE_FIRESTORE_OUTBOX_WORKER: ${process.env.ENABLE_FIRESTORE_OUTBOX_WORKER}`);

    // Capture Business Tables Counts BEFORE
    const businessTables = [
      'rooms', 'room_types', 'staff', 'guests', 'bookings', 'reservations',
      'payments', 'invoices', 'ledger_items', 'inventory_products',
      'inventory_categories', 'system_settings'
    ];
    const countsBefore = {};
    for (const tbl of businessTables) {
      const [res] = await pool.query(`SELECT COUNT(*) as cnt FROM \`${tbl}\``);
      countsBefore[tbl] = res[0].cnt;
    }

    // Check PENDING events in outbox BEFORE
    const [pendingBefore] = await pool.query(
      `SELECT id, event_id, event_type, aggregate_id, status FROM dual_write_outbox WHERE status = 'PENDING'`
    );
    console.log(`\nSTEP 2: Initial Pending Outbox Events: ${pendingBefore.length}`);
    pendingBefore.forEach(r => console.log(` - ID ${r.id}: ${r.event_type} (${r.aggregate_id})`));

    // STEP 3: Execute Outbox Batch Delivery
    console.log('\nSTEP 3: Executing processOutboxBatch()...');
    const result = await processOutboxBatch(10, 5);
    console.log(` - Batch Result: Processed = ${result.processed}, Failed = ${result.failed}`);

    // STEP 4: Verify MySQL Outbox State AFTER
    console.log('\nSTEP 4: Verifying MySQL Outbox State');
    const [rowsAfter] = await pool.query(
      `SELECT id, event_id, event_type, aggregate_id, status, attempts, processed_at, last_error FROM dual_write_outbox WHERE id IN (357, 359)`
    );

    let id357Status = 'N/A';
    let id359Status = 'N/A';

    rowsAfter.forEach(r => {
      console.log(` - ID ${r.id}: ${r.event_type} (${r.aggregate_id}) -> Status: ${r.status} | Attempts: ${r.attempts} | ProcessedAt: ${r.processed_at}`);
      if (r.id === 357) id357Status = r.status;
      if (r.id === 359) id359Status = r.status;
    });

    // STEP 5: Verify Firestore Documents
    console.log('\nSTEP 5: Verifying Firestore Documents');
    const docIds = ['bkg_BKG-218865', 'bkg_BKG-492109'];
    let firestoreVerified = true;

    for (const docId of docIds) {
      const snap = await db.collection('bookings').doc(docId).get();
      const exists = snap.exists;
      console.log(` - Document /bookings/${docId} Exists: ${exists ? 'YES (PASS)' : 'NO (FAIL)'}`);
      if (exists) {
        const data = snap.data();
        const keys = Object.keys(data);
        console.log(`   * Fields Present: [${keys.join(', ')}]`);
        console.log(`   * Deterministic ID Match: ${snap.id === docId ? 'YES' : 'NO'}`);
      } else {
        firestoreVerified = false;
      }
    }

    // Check total documents in Firestore /bookings collection
    const bookingsCollectionSnap = await db.collection('bookings').get();
    console.log(` - Total /bookings Firestore Documents: ${bookingsCollectionSnap.size}`);

    // STEP 6: Verify Business Tables Counts AFTER
    console.log('\nSTEP 6: Verifying MySQL Business Data Unchanged');
    let businessIntact = true;
    for (const tbl of businessTables) {
      const [res] = await pool.query(`SELECT COUNT(*) as cnt FROM \`${tbl}\``);
      const cntAfter = res[0].cnt;
      const cntBefore = countsBefore[tbl];
      const match = cntAfter === cntBefore;
      console.log(` - \`${tbl.padEnd(20)}\`: Before=${cntBefore}, After=${cntAfter} -> ${match ? 'UNTOUCHED (PASS)' : 'MISMATCH (FAIL)'}`);
      if (!match) businessIntact = false;
    }

    // STEP 7: Restore Feature Flags
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    process.env.ENABLE_FIRESTORE_OUTBOX_WORKER = 'false';
    console.log('\nSTEP 7: Feature Flags Restored to FALSE');

    const pass = id357Status === 'PROCESSED' && id359Status === 'PROCESSED' && firestoreVerified && businessIntact;

    console.log('\n================================================================');
    console.log(`OVERALL TEST VERDICT: ${pass ? 'PASS — FIRST LOCAL OUTBOX DELIVERY TEST PASSED' : 'FAIL — ISSUES DETECTED'}`);
    console.log('================================================================\n');

    process.exit(pass ? 0 : 1);

  } catch (err) {
    console.error('Outbox Delivery Test Error:', err.message);
    process.exit(1);
  }
}

runOutboxDeliveryTest();
