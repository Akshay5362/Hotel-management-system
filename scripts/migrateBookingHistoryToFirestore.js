import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

const isCommit = process.argv.includes('--commit');

async function migrateBookingHistory() {
  console.log(`=== MIGRATING MYSQL BOOKING HISTORY TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM booking_history ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    const documentsToInsert = [];

    for (const row of rows) {
      const docId = `history_${row.id}`;
      const docData = {
        mysql_history_id: row.id,
        mysql_booking_id: row.booking_id,
        action: row.action,
        details: row.details || null,
        mysql_changed_by: row.changed_by || null,
        business_date: row.business_date,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Expected Firestore Collection: /booking_history (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    console.log('Executing batched Firestore write operation...');
    const batch = db.batch();
    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('booking_history').doc(docId);
      batch.set(ref, docData, { merge: true });
    }
    await batch.commit();

    console.log(`Successfully committed ${documentsToInsert.length} /booking_history documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Booking history migration error:', err.message);
    process.exit(1);
  }
}

migrateBookingHistory();
