import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

async function verifyPayments() {
  console.log('=== VERIFYING FIRESTORE /payments COLLECTION ===\n');

  try {
    const [mysqlRows] = await pool.query('SELECT * FROM payments ORDER BY id ASC');
    const firestoreSnap = await db.collection('payments').get();

    console.log(`MySQL Record Count     : ${mysqlRows.length}`);
    console.log(`Firestore Document Count: ${firestoreSnap.size}`);

    if (mysqlRows.length !== firestoreSnap.size) {
      console.error(`COUNT MISMATCH! MySQL: ${mysqlRows.length}, Firestore: ${firestoreSnap.size}`);
      process.exit(1);
    }

    let mysqlAmountSum = 0;
    mysqlRows.forEach(r => mysqlAmountSum += Number(r.amount || 0));

    let firestoreAmountSum = 0;
    firestoreSnap.forEach(doc => firestoreAmountSum += Number(doc.data().amount || 0));

    console.log('\nFINANCIAL RECONCILIATION:');
    console.log(` - MySQL amount SUM   : ₹${mysqlAmountSum}`);
    console.log(` - Firestore amount SUM: ₹${firestoreAmountSum}`);

    if (mysqlAmountSum !== firestoreAmountSum) {
      console.error('PAYMENT FINANCIAL TOTAL MISMATCH REJECTED!');
      process.exit(1);
    }

    let mismatches = 0;
    for (const row of mysqlRows) {
      const docId = `payment_${row.id}`;
      const docSnap = await db.collection('payments').doc(docId).get();
      if (!docSnap.exists) {
        console.error(`Missing Firestore document: ${docId}`);
        mismatches++;
        continue;
      }
      const data = docSnap.data();
      if (Number(data.amount) !== Number(row.amount)) {
        console.error(`Amount mismatch in ${docId}`);
        mismatches++;
      }
    }

    console.log(`\nMismatches: ${mismatches}`);
    console.log(`VERDICT: ${mismatches === 0 ? 'PAYMENTS MIGRATION VERIFIED' : 'FAILED'}`);
    process.exit(mismatches === 0 ? 0 : 1);

  } catch (err) {
    console.error('Verification error:', err.message);
    process.exit(1);
  }
}

verifyPayments();
