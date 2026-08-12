import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

const isCommit = process.argv.includes('--commit');

async function migrateLedger() {
  console.log(`=== MIGRATING MYSQL LEDGER ITEMS TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM ledger_items ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    let amountSum = 0;
    const documentsToInsert = [];

    for (const row of rows) {
      amountSum += Number(row.amount || 0);

      const docId = `ledger_${row.id}`;
      const docData = {
        mysql_ledger_id: row.id,
        mysql_booking_id: row.booking_id || null,
        room_number: row.room_number,
        description: row.desc || '',
        qty: Number(row.qty || 1),
        amount: Number(row.amount || 0),
        status: row.status || 'Pending',
        business_date: row.business_date || null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Financial Totals Assertion:`);
    console.log(` - SUM(amount) : ₹${amountSum}`);
    console.log(`Expected Firestore Collection: /ledger_items (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    console.log('Executing batched Firestore write operation...');
    const batch = db.batch();
    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('ledger_items').doc(docId);
      batch.set(ref, docData, { merge: true });
    }
    await batch.commit();

    console.log(`Successfully committed ${documentsToInsert.length} /ledger_items documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Ledger migration error:', err.message);
    process.exit(1);
  }
}

migrateLedger();
