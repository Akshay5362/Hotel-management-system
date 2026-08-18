import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { SafeFirestoreBatchWriter } from './utils/firestoreBatch.js';

const isCommit = process.argv.includes('--commit');

async function migrateLedger() {
  console.log(`=== MIGRATING MYSQL LEDGER ITEMS TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM ledger_items ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    let totalAmountSum = 0;
    const documentsToInsert = [];

    for (const row of rows) {
      totalAmountSum += Number(row.amount || 0);

      const docId = `ledger_${row.id}`;
      const docData = {
        mysql_ledger_id: row.id,
        mysql_booking_id: row.booking_id,
        description: row.desc || row.description || 'Room Charge',
        amount: Number(row.amount || 0),
        type: row.type || 'CHARGE',
        room_number: row.room_number || null,
        business_date: row.business_date || null,
        status: row.status || 'Posted',
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Financial Totals Assertion:`);
    console.log(` - SUM(amount) : ₹${totalAmountSum}`);
    console.log(`Expected Firestore Collection: /ledger_items (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    if (!isFirebaseConfigured || !db) {
      throw new Error('Firebase Admin SDK is not initialized.');
    }

    console.log('Executing batched Firestore write operation via SafeFirestoreBatchWriter...');
    const batchWriter = new SafeFirestoreBatchWriter(db, {
      collectionName: 'ledger_items',
      maxBatchSize: 250,
      isDryRun: false
    });

    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('ledger_items').doc(docId);
      await batchWriter.set(ref, docData, { merge: true });
    }

    await batchWriter.finalize();
    console.log(`Successfully committed ${documentsToInsert.length} /ledger_items documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Ledger items migration error:', err.message);
    process.exit(1);
  }
}

migrateLedger();
