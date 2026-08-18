import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { SafeFirestoreBatchWriter } from './utils/firestoreBatch.js';

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
        sku: String(row.sku || ''),
        name: String(row.name || ''),
        mysql_category_id: row.category_id ? Number(row.category_id) : null,
        category_id: row.category_id ? `cat_${row.category_id}` : null,
        unit_of_measure: String(row.unit_of_measure || 'pcs'),
        minimum_stock_level: Number(row.minimum_stock_level || 0),
        current_stock: Number(row.current_stock || 0),
        unit_price: Number(row.unit_price || 0),
        photo_url: row.photo_url || null,
        status: String(row.status || 'Active'),
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

    if (!isFirebaseConfigured || !db) {
      throw new Error('Firebase Admin SDK is not initialized.');
    }

    console.log('Executing batched Firestore write operation via SafeFirestoreBatchWriter...');
    const batchWriter = new SafeFirestoreBatchWriter(db, {
      collectionName: 'inventory_products',
      maxBatchSize: 250,
      isDryRun: false
    });

    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('inventory_products').doc(docId);
      await batchWriter.set(ref, docData, { merge: true });
    }

    await batchWriter.finalize();
    console.log(`Successfully committed ${documentsToInsert.length} /inventory_products documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Inventory products migration error:', err.message);
    process.exit(1);
  }
}

migrateInventoryProducts();
