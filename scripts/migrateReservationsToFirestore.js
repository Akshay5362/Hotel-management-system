import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { SafeFirestoreBatchWriter } from './utils/firestoreBatch.js';

const isCommit = process.argv.includes('--commit');

async function migrateReservations() {
  console.log(`=== MIGRATING MYSQL RESERVATIONS TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM reservations ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    const documentsToInsert = [];

    for (const row of rows) {
      const docId = `reservation_${row.id}`;
      const docData = {
        mysql_reservation_id: row.id,
        reservation_number: row.reservation_number,
        guest_name: row.guest_name,
        email: row.email || null,
        phone: row.phone || null,
        mysql_room_id: row.room_id || null,
        mysql_booking_id: row.booking_id || null,
        check_in_date: row.check_in_date ? new Date(row.check_in_date).toISOString() : null,
        check_out_date: row.check_out_date ? new Date(row.check_out_date).toISOString() : null,
        status: row.status || 'Confirmed',
        notes: row.notes || null,
        mysql_created_by: row.created_by || null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Expected Firestore Collection: /reservations (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    if (!isFirebaseConfigured || !db) {
      throw new Error('Firebase Admin SDK is not initialized.');
    }

    console.log('Executing batched Firestore write operation via SafeFirestoreBatchWriter...');
    const batchWriter = new SafeFirestoreBatchWriter(db, {
      collectionName: 'reservations',
      maxBatchSize: 250,
      isDryRun: false
    });

    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('reservations').doc(docId);
      await batchWriter.set(ref, docData, { merge: true });
    }

    await batchWriter.finalize();
    console.log(`Successfully committed ${documentsToInsert.length} /reservations documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Reservations migration error:', err.message);
    process.exit(1);
  }
}

migrateReservations();
