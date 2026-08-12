import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

const isCommit = process.argv.includes('--commit');

async function migrateCashLogs() {
  console.log(`=== MIGRATING MYSQL CASH LOGS TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM cash_logs ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    let amountSum = 0;
    const documentsToInsert = [];

    for (const row of rows) {
      amountSum += Number(row.amount || 0);

      const docId = `cash_${row.id}`;
      const docData = {
        mysql_cash_id: row.id,
        time: row.time,
        room: row.room,
        guest: row.guest,
        type: row.type,
        amount: Number(row.amount || 0),
        business_date: row.business_date,
        mysql_booking_id: row.booking_id || null
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Financial Totals Assertion:`);
    console.log(` - SUM(amount) : ₹${amountSum}`);
    console.log(`Expected Firestore Collection: /cash_logs (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    console.log('Executing batched Firestore write operation...');
    const batch = db.batch();
    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('cash_logs').doc(docId);
      batch.set(ref, docData, { merge: true });
    }
    await batch.commit();

    console.log(`Successfully committed ${documentsToInsert.length} /cash_logs documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Cash logs migration error:', err.message);
    process.exit(1);
  }
}

migrateCashLogs();
