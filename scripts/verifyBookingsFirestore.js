import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

async function verifyBookings() {
  console.log('=== VERIFYING FIRESTORE /bookings COLLECTION ===\n');

  try {
    const [mysqlRows] = await pool.query('SELECT * FROM bookings ORDER BY id ASC');
    const firestoreSnap = await db.collection('bookings').get();

    console.log(`MySQL Record Count     : ${mysqlRows.length}`);
    console.log(`Firestore Document Count: ${firestoreSnap.size}`);

    if (mysqlRows.length !== firestoreSnap.size) {
      console.error(`COUNT MISMATCH! MySQL: ${mysqlRows.length}, Firestore: ${firestoreSnap.size}`);
      process.exit(1);
    }

    let mysqlTotalSum = 0;
    let mysqlAdvanceSum = 0;
    mysqlRows.forEach(r => {
      mysqlTotalSum += Number(r.total_amount || 0);
      mysqlAdvanceSum += Number(r.advance_amount || 0);
    });

    let firestoreTotalSum = 0;
    let firestoreAdvanceSum = 0;
    firestoreSnap.forEach(doc => {
      const data = doc.data();
      firestoreTotalSum += Number(data.total_amount || 0);
      firestoreAdvanceSum += Number(data.advance_amount || 0);
    });

    console.log('\nFINANCIAL RECONCILIATION:');
    console.log(` - MySQL total_amount SUM   : ₹${mysqlTotalSum}`);
    console.log(` - Firestore total_amount SUM: ₹${firestoreTotalSum}`);
    console.log(` - MySQL advance_amount SUM : ₹${mysqlAdvanceSum}`);
    console.log(` - Firestore advance_amount SUM: ₹${firestoreAdvanceSum}`);

    const isTotalMatch = mysqlTotalSum === firestoreTotalSum;
    const isAdvanceMatch = mysqlAdvanceSum === firestoreAdvanceSum;

    if (!isTotalMatch || !isAdvanceMatch) {
      console.error('FINANCIAL TOTAL MISMATCH REJECTED!');
      process.exit(1);
    }

    console.log('\nFIELD-BY-FIELD DOCUMENT AUDIT:');
    let mismatches = 0;

    for (const row of mysqlRows) {
      const docId = `booking_${row.id}`;
      const docSnap = await db.collection('bookings').doc(docId).get();
      if (!docSnap.exists) {
        console.error(`Missing Firestore document: ${docId}`);
        mismatches++;
        continue;
      }

      const data = docSnap.data();
      if (Number(data.total_amount) !== Number(row.total_amount) || data.booking_number !== row.booking_number) {
        console.error(`Field mismatch in ${docId}`);
        mismatches++;
      }
    }

    console.log(`\nMismatches: ${mismatches}`);
    console.log(`VERDICT: ${mismatches === 0 ? 'BOOKINGS MIGRATION VERIFIED' : 'FAILED'}`);
    process.exit(mismatches === 0 ? 0 : 1);

  } catch (err) {
    console.error('Verification error:', err.message);
    process.exit(1);
  }
}

verifyBookings();
