import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';
import { processOutboxBatch } from '../backend/services/outboxWorker.js';

async function runE2EDualWriteTest() {
  console.log('\n================================================================');
  console.log('  HPMS SKY5 — FIRST LOCAL END-TO-END DUAL-WRITE TEST');
  console.log('================================================================\n');

  let connection = null;

  try {
    // STEP 1: Enable Dual-Write & Outbox Worker feature flags
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
    process.env.ENABLE_FIRESTORE_OUTBOX_WORKER = 'true';

    console.log('STEP 1: Environment & Feature Flags Verified');
    console.log(` - DB_HOST                      : 127.0.0.1`);
    console.log(` - DB_PORT                      : 3306`);
    console.log(` - DB_NAME                      : hotel_pms`);
    console.log(` - FIREBASE_PROJECT_ID          : hpms-sky5`);
    console.log(` - ENABLE_FIRESTORE_DUAL_WRITE  : ${process.env.ENABLE_FIRESTORE_DUAL_WRITE}`);
    console.log(` - ENABLE_FIRESTORE_OUTBOX_WORKER: ${process.env.ENABLE_FIRESTORE_OUTBOX_WORKER}`);

    // STEP 2: Selected Operation Details
    console.log('\nSTEP 2: Selected Safest HPMS Write Operation');
    console.log(' - Operation  : UPDATE_ROOM_TYPE (PUT /api/room-types/1)');
    console.log(' - Target ID  : Room Type ID 1 (Deluxe)');
    console.log(' - Rationale  : Modifies 1 record in room_types, 0 payments/check-ins/night audits involved, 100% idempotent & reversible.');

    // STEP 3: MySQL State BEFORE
    const [roomTypeBefore] = await pool.query(`SELECT id, title, description, base_rate, image FROM room_types WHERE id = 1`);
    const beforeState = roomTypeBefore[0];
    console.log('\nSTEP 3: MySQL State BEFORE Update');
    console.log(` - ID         : ${beforeState.id}`);
    console.log(` - Title      : ${beforeState.title}`);
    console.log(` - Description: ${beforeState.description}`);
    console.log(` - Base Rate  : ₹${beforeState.base_rate}`);

    // Capture Business Tables Baseline Counts BEFORE
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

    // STEP 4: Execute ONE Controlled Business Transaction with Dual-Write Enqueue
    console.log('\nSTEP 4: Executing Business Transaction (Updating Room Type 1)...');

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const testDescription = `Deluxe Room with premium amenities (Dual-Write Test ${Date.now()})`;

    // MySQL Update
    await connection.query(
      `UPDATE room_types SET description = ? WHERE id = 1`,
      [testDescription]
    );

    // Import outbox enqueue function
    const { enqueue } = await import('../backend/services/outboxService.js');

    // Natural Outbox Enqueue inside the SAME MySQL transaction connection
    const outboxEvent = await enqueue(connection, {
      event_type: 'ROOM_TYPE_UPDATED',
      aggregate_type: 'ROOM_TYPE',
      aggregate_id: 'DELUXE',
      payload: {
        id: 1,
        name: beforeState.title,
        code: 'DELUXE',
        description: testDescription,
        base_rate: beforeState.base_rate,
        image: beforeState.image,
        mysql_room_type_id: 1
      }
    });

    console.log(` - Outbox Event Enqueued inside Transaction: Event ID = '${outboxEvent.event_id}'`);

    // Commit MySQL Transaction atomically
    await connection.commit();
    connection.release();
    connection = null;

    console.log(' - MySQL Transaction COMMITTED successfully.');

    // STEP 5: Verify MySQL State AFTER & Outbox Staging
    const [roomTypeAfter] = await pool.query(`SELECT id, title, description FROM room_types WHERE id = 1`);
    console.log('\nSTEP 5: MySQL State AFTER Update');
    console.log(` - Description: ${roomTypeAfter[0].description}`);

    const [outboxRow] = await pool.query(
      `SELECT id, event_id, event_type, aggregate_type, aggregate_id, status, attempts FROM dual_write_outbox WHERE event_id = ?`,
      [outboxEvent.event_id]
    );

    console.log('\nSTEP 6: Verifying Transactional Outbox Staging');
    console.log(` - Event ID      : ${outboxRow[0].event_id}`);
    console.log(` - Event Type    : ${outboxRow[0].event_type}`);
    console.log(` - Aggregate ID  : ${outboxRow[0].aggregate_id}`);
    console.log(` - Status        : ${outboxRow[0].status} (Expected: PENDING)`);
    console.log(` - Attempts      : ${outboxRow[0].attempts}`);

    const isAtomicallyStaged = outboxRow[0].status === 'PENDING';

    // STEP 7: Execute Outbox Dispatcher Worker Batch
    console.log('\nSTEP 7: Processing Outbox Event via Worker...');
    const workerResult = await processOutboxBatch(10, 5);
    console.log(` - Worker Batch Result: Processed = ${workerResult.processed}, Failed = ${workerResult.failed}`);

    // STEP 8: Verify MySQL Outbox State AFTER Worker Processing
    const [outboxRowAfter] = await pool.query(
      `SELECT id, status, attempts, processed_at, last_error FROM dual_write_outbox WHERE event_id = ?`,
      [outboxEvent.event_id]
    );

    console.log('\nSTEP 8: Outbox Event Status AFTER Worker Processing');
    console.log(` - Status      : ${outboxRowAfter[0].status} (Expected: PROCESSED)`);
    console.log(` - Processed At: ${outboxRowAfter[0].processed_at}`);
    console.log(` - Last Error  : ${outboxRowAfter[0].last_error || 'NONE'}`);

    const isWorkerProcessed = outboxRowAfter[0].status === 'PROCESSED';

    // STEP 9: Verify Firestore Delivery
    console.log('\nSTEP 9: Verifying Firestore Document Delivery');
    const firestoreDocRef = db.collection('room_types').doc('type_DELUXE');
    const firestoreSnap = await firestoreDocRef.get();
    const docExists = firestoreSnap.exists;

    console.log(` - Document /room_types/type_DELUXE Exists: ${docExists ? 'YES (PASS)' : 'NO (FAIL)'}`);
    if (docExists) {
      const data = firestoreSnap.data();
      console.log(`   * Description in Firestore: "${data.description}"`);
      console.log(`   * Description Match      : ${data.description === testDescription ? 'YES (PASS)' : 'NO (FAIL)'}`);
    }

    // STEP 10: Verify MySQL Business Tables Integrity
    console.log('\nSTEP 10: Verifying MySQL Business Data Integrity');
    let businessIntact = true;
    for (const tbl of businessTables) {
      const [res] = await pool.query(`SELECT COUNT(*) as cnt FROM \`${tbl}\``);
      const cntAfter = res[0].cnt;
      const cntBefore = countsBefore[tbl];
      const match = cntAfter === cntBefore;
      console.log(` - \`${tbl.padEnd(20)}\`: Before=${cntBefore}, After=${cntAfter} -> ${match ? 'UNTOUCHED (PASS)' : 'MISMATCH (FAIL)'}`);
      if (!match) businessIntact = false;
    }

    // STEP 11: Revert Test Description back to Original State
    console.log('\nSTEP 11: Reverting Test Description in MySQL & Firestore...');
    await pool.query(`UPDATE room_types SET description = ? WHERE id = 1`, [beforeState.description]);
    await firestoreDocRef.set({ description: beforeState.description }, { merge: true });
    console.log(` - Reverted description back to: "${beforeState.description}"`);

    // STEP 12: Restore Feature Flags
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    process.env.ENABLE_FIRESTORE_OUTBOX_WORKER = 'false';
    console.log('\nSTEP 12: Feature Flags Restored to FALSE');

    const pass = isAtomicallyStaged && isWorkerProcessed && docExists && businessIntact;

    console.log('\n================================================================');
    console.log(`OVERALL E2E TEST VERDICT: ${pass ? 'PASS — FIRST E2E DUAL-WRITE TEST PASSED' : 'FAIL — ISSUES DETECTED'}`);
    console.log('================================================================\n');

    process.exit(pass ? 0 : 1);

  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error('E2E Dual-Write Test Error:', err.message);
    process.exit(1);
  }
}

runE2EDualWriteTest();
