import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

const isCommit = process.argv.includes('--commit');

async function migrateBookings() {
  console.log(`=== MIGRATING MYSQL BOOKINGS TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM bookings ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    let totalAmountSum = 0;
    let advanceAmountSum = 0;
    const documentsToInsert = [];

    for (const row of rows) {
      totalAmountSum += Number(row.total_amount || 0);
      advanceAmountSum += Number(row.advance_amount || 0);

      const docId = `booking_${row.id}`;
      const docData = {
        mysql_booking_id: row.id,
        booking_number: row.booking_number,
        mysql_guest_id: row.guest_id,
        mysql_room_id: row.room_id,
        check_in_date: row.check_in_date ? new Date(row.check_in_date).toISOString() : null,
        check_out_date: row.check_out_date ? new Date(row.check_out_date).toISOString() : null,
        expected_check_out_date: row.expected_check_out_date ? new Date(row.expected_check_out_date).toISOString() : null,
        adults: row.adults || 1,
        children: row.children || 0,
        booking_status: row.booking_status,
        payment_status: row.payment_status,
        total_amount: Number(row.total_amount || 0),
        advance_amount: Number(row.advance_amount || 0),
        notes: row.notes || null,
        billing_instruction: row.billing_instruction || 'Direct to Guest',
        meal_plan: row.meal_plan || 'EP',
        mysql_created_by: row.created_by || null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Financial Totals Assertion:`);
    console.log(` - SUM(total_amount)   : ₹${totalAmountSum}`);
    console.log(` - SUM(advance_amount) : ₹${advanceAmountSum}`);
    console.log(`Expected Firestore Collection: /bookings (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    console.log('Executing batched Firestore write operation...');
    const batch = db.batch();
    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('bookings').doc(docId);
      batch.set(ref, docData, { merge: true });
    }
    await batch.commit();

    console.log(`Successfully committed ${documentsToInsert.length} /bookings documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Bookings migration error:', err.message);
    process.exit(1);
  }
}

migrateBookings();
