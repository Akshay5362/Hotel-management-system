import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

const isCommit = process.argv.includes('--commit');

async function migratePayments() {
  console.log(`=== MIGRATING MYSQL PAYMENTS TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM payments ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    let amountSum = 0;
    const documentsToInsert = [];

    for (const row of rows) {
      amountSum += Number(row.amount || 0);

      const docId = `payment_${row.id}`;
      const docData = {
        mysql_payment_id: row.id,
        mysql_booking_id: row.booking_id || null,
        mysql_guest_id: row.guest_id || null,
        amount: Number(row.amount || 0),
        currency: row.currency || 'INR',
        payment_method: row.payment_method || 'Cash',
        payment_status: row.payment_status || 'Pending',
        payment_type: row.payment_type || null,
        payment_source: row.payment_source || 'front_desk',
        payment_gateway: row.payment_gateway || 'Internal',
        transaction_id: row.transaction_id || null,
        mysql_collected_by: row.collected_by || null,
        mysql_created_by: row.created_by || null,
        business_date: row.business_date || null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Financial Totals Assertion:`);
    console.log(` - SUM(amount) : ₹${amountSum}`);
    console.log(`Expected Firestore Collection: /payments (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    console.log('Executing batched Firestore write operation...');
    const batch = db.batch();
    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('payments').doc(docId);
      batch.set(ref, docData, { merge: true });
    }
    await batch.commit();

    console.log(`Successfully committed ${documentsToInsert.length} /payments documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Payments migration error:', err.message);
    process.exit(1);
  }
}

migratePayments();
