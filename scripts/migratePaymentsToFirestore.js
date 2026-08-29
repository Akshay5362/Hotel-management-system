import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { SafeFirestoreBatchWriter } from './utils/firestoreBatch.js';

const isCommit = process.argv.includes('--commit');

async function migratePayments() {
  console.log(`=== MIGRATING MYSQL PAYMENTS TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM payments ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    let totalAmountSum = 0;
    const documentsToInsert = [];

    for (const row of rows) {
      totalAmountSum += Number(row.amount || 0);

      const docId = `payment_${row.id}`;
      const docData = {
        mysql_payment_id: row.id,
        mysql_booking_id: row.booking_id,
        amount: Number(row.amount || 0),
        payment_method: row.payment_method || 'Cash',
        payment_status: row.payment_status || 'Completed',
        payment_type: row.payment_type || null,
        business_date: row.business_date || null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Financial Totals Assertion:`);
    console.log(` - SUM(amount) : ₹${totalAmountSum}`);
    console.log(`Expected Firestore Collection: /payments (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    if (!isFirebaseConfigured || !db) {
      throw new Error('Firebase Admin SDK is not initialized.');
    }

    console.log('Executing batched Firestore write operation via SafeFirestoreBatchWriter...');
    const batchWriter = new SafeFirestoreBatchWriter(db, {
      collectionName: 'payments',
      maxBatchSize: 250,
      isDryRun: false
    });

    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('payments').doc(docId);
      await batchWriter.set(ref, docData, { merge: true });
    }

    await batchWriter.finalize();
    console.log(`Successfully committed ${documentsToInsert.length} /payments documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Payments migration error:', err.message);
    process.exit(1);
  }
}

migratePayments();
