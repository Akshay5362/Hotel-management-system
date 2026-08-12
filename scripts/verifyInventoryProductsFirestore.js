import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

async function verifyInventoryProducts() {
  console.log('=== VERIFYING FIRESTORE /inventory_products COLLECTION ===\n');

  try {
    const [mysqlRows] = await pool.query('SELECT * FROM inventory_products ORDER BY id ASC');
    const firestoreSnap = await db.collection('inventory_products').get();

    console.log(`MySQL Record Count     : ${mysqlRows.length}`);
    console.log(`Firestore Document Count: ${firestoreSnap.size}`);

    if (mysqlRows.length !== firestoreSnap.size) {
      console.error(`COUNT MISMATCH! MySQL: ${mysqlRows.length}, Firestore: ${firestoreSnap.size}`);
      process.exit(1);
    }

    let mismatches = 0;
    for (const row of mysqlRows) {
      const docId = `product_${row.id}`;
      const docSnap = await db.collection('inventory_products').doc(docId).get();
      if (!docSnap.exists) {
        console.error(`Missing Firestore document: ${docId}`);
        mismatches++;
        continue;
      }
      const data = docSnap.data();
      if (data.sku !== row.sku || data.name !== row.name) {
        console.error(`Field mismatch in ${docId}`);
        mismatches++;
      }
    }

    console.log(`\nMismatches: ${mismatches}`);
    console.log(`VERDICT: ${mismatches === 0 ? 'INVENTORY PRODUCTS MIGRATION VERIFIED' : 'FAILED'}`);
    process.exit(mismatches === 0 ? 0 : 1);

  } catch (err) {
    console.error('Verification error:', err.message);
    process.exit(1);
  }
}

verifyInventoryProducts();
