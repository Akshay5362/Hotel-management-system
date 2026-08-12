import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

async function verifyInvoices() {
  console.log('=== VERIFYING FIRESTORE /invoices COLLECTION ===\n');

  try {
    const [mysqlRows] = await pool.query('SELECT * FROM invoices ORDER BY id ASC');
    const firestoreSnap = await db.collection('invoices').get();

    console.log(`MySQL Record Count     : ${mysqlRows.length}`);
    console.log(`Firestore Document Count: ${firestoreSnap.size}`);

    if (mysqlRows.length !== firestoreSnap.size) {
      console.error(`COUNT MISMATCH! MySQL: ${mysqlRows.length}, Firestore: ${firestoreSnap.size}`);
      process.exit(1);
    }

    let mysqlTotalSum = 0;
    mysqlRows.forEach(r => mysqlTotalSum += Number(r.total_amount || 0));

    let firestoreTotalSum = 0;
    firestoreSnap.forEach(doc => firestoreTotalSum += Number(doc.data().total_amount || 0));

    console.log('\nFINANCIAL RECONCILIATION:');
    console.log(` - MySQL total_amount SUM   : ₹${mysqlTotalSum}`);
    console.log(` - Firestore total_amount SUM: ₹${firestoreTotalSum}`);

    if (mysqlTotalSum !== firestoreTotalSum) {
      console.error('INVOICES FINANCIAL TOTAL MISMATCH REJECTED!');
      process.exit(1);
    }

    let mismatches = 0;
    for (const row of mysqlRows) {
      const docId = `invoice_${row.id}`;
      const docSnap = await db.collection('invoices').doc(docId).get();
      if (!docSnap.exists) {
        console.error(`Missing Firestore document: ${docId}`);
        mismatches++;
        continue;
      }
      const data = docSnap.data();
      if (Number(data.total_amount) !== Number(row.total_amount) || data.invoice_number !== row.invoice_number) {
        console.error(`Field mismatch in ${docId}`);
        mismatches++;
      }
    }

    console.log(`\nMismatches: ${mismatches}`);
    console.log(`VERDICT: ${mismatches === 0 ? 'INVOICES MIGRATION VERIFIED' : 'FAILED'}`);
    process.exit(mismatches === 0 ? 0 : 1);

  } catch (err) {
    console.error('Verification error:', err.message);
    process.exit(1);
  }
}

verifyInvoices();
