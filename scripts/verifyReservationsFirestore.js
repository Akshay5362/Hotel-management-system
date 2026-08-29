import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

async function verifyReservations() {
  console.log('=== VERIFYING FIRESTORE /reservations COLLECTION ===\n');

  try {
    const [mysqlRows] = await pool.query('SELECT * FROM reservations ORDER BY id ASC');
    const firestoreSnap = await db.collection('reservations').get();

    console.log(`MySQL Record Count     : ${mysqlRows.length}`);
    console.log(`Firestore Document Count: ${firestoreSnap.size}`);

    if (mysqlRows.length !== firestoreSnap.size) {
      console.error(`COUNT MISMATCH! MySQL: ${mysqlRows.length}, Firestore: ${firestoreSnap.size}`);
      process.exit(1);
    }

    let mismatches = 0;
    for (const row of mysqlRows) {
      const docId = `reservation_${row.id}`;
      const docSnap = await db.collection('reservations').doc(docId).get();
      if (!docSnap.exists) {
        console.error(`Missing Firestore document: ${docId}`);
        mismatches++;
        continue;
      }
      const data = docSnap.data();
      if (data.reservation_number !== row.reservation_number) {
        console.error(`Field mismatch in ${docId}`);
        mismatches++;
      }
    }

    console.log(`\nMismatches: ${mismatches}`);
    console.log(`VERDICT: ${mismatches === 0 ? 'RESERVATIONS MIGRATION VERIFIED' : 'FAILED'}`);
    process.exit(mismatches === 0 ? 0 : 1);

  } catch (err) {
    console.error('Verification error:', err.message);
    process.exit(1);
  }
}

verifyReservations();
