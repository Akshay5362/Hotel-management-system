import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

const isCommit = process.argv.includes('--commit');

async function migrateInventoryProducts() {
  console.log(`=== MIGRATING MYSQL INVENTORY PRODUCTS TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM inventory_products ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    const documentsToInsert = [];

    for (const row of rows) {
      const docId = `product_${row.id}`;
      const docData = {
        mysql_product_id: row.id,
        sku: row.sku,
        name: row.name,
        mysql_category_id: row.category_id,
        unit_of_measure: row.unit_of_measure,
        minimum_stock_level: Number(row.minimum_stock_level || 0),
        current_stock: Number(row.current_stock || 0),
        unit_price: Number(row.unit_price || 0),
        photo_url: row.photo_url || null,
        status: row.status || 'Active',
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Expected Firestore Collection: /inventory_products (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    console.log('Executing batched Firestore write operation...');
    const batch = db.batch();
    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('inventory_products').doc(docId);
      batch.set(ref, docData, { merge: true });
    }
    await batch.commit();

    console.log(`Successfully committed ${documentsToInsert.length} /inventory_products documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Inventory products migration error:', err.message);
    process.exit(1);
  }
}

migrateInventoryProducts();
