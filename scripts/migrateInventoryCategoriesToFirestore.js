import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

const isCommit = process.argv.includes('--commit');

async function migrateInventoryCategories() {
  console.log(`=== MIGRATING MYSQL INVENTORY CATEGORIES TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM inventory_categories ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    const documentsToInsert = [];

    for (const row of rows) {
      const docId = `category_${row.id}`;
      const docData = {
        mysql_category_id: row.id,
        name: row.name,
        department: row.department || 'General',
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Expected Firestore Collection: /inventory_categories (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    console.log('Executing batched Firestore write operation...');
    const batch = db.batch();
    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('inventory_categories').doc(docId);
      batch.set(ref, docData, { merge: true });
    }
    await batch.commit();

    console.log(`Successfully committed ${documentsToInsert.length} /inventory_categories documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Inventory categories migration error:', err.message);
    process.exit(1);
  }
}

migrateInventoryCategories();
