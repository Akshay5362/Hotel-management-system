import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { SafeFirestoreBatchWriter } from './utils/firestoreBatch.js';

const isCommit = process.argv.includes('--commit');

async function migrateSystemSettings() {
  console.log(`=== MIGRATING MYSQL SYSTEM SETTINGS TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM system_settings ORDER BY key_name ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    const documentsToInsert = [];

    for (const row of rows) {
      const docId = `setting_${row.key_name}`;
      const docData = {
        key_name: String(row.key_name),
        value_val: String(row.value_val || ''),
        updated_at: new Date().toISOString(),
        source_table: 'system_settings'
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Expected Firestore Collection: /system_settings (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    if (!isFirebaseConfigured || !db) {
      throw new Error('Firebase Admin SDK is not initialized.');
    }

    console.log('Executing batched Firestore write operation via SafeFirestoreBatchWriter...');
    const batchWriter = new SafeFirestoreBatchWriter(db, {
      collectionName: 'system_settings',
      maxBatchSize: 250,
      isDryRun: false
    });

    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('system_settings').doc(docId);
      await batchWriter.set(ref, docData, { merge: true });
    }

    await batchWriter.finalize();
    console.log(`Successfully committed ${documentsToInsert.length} /system_settings documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('System settings migration error:', err.message);
    process.exit(1);
  }
}

migrateSystemSettings();
