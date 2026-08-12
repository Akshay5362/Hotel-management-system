import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

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
        key_name: row.key_name,
        value_val: row.value_val,
        migrated_at: new Date().toISOString(),
        source_table: 'system_settings'
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Expected Firestore Collection: /system_settings (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    console.log('Executing batched Firestore write operation...');
    const batch = db.batch();
    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('system_settings').doc(docId);
      batch.set(ref, docData, { merge: true });
    }
    await batch.commit();

    console.log(`Successfully committed ${documentsToInsert.length} /system_settings documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('System settings migration error:', err.message);
    process.exit(1);
  }
}

migrateSystemSettings();
