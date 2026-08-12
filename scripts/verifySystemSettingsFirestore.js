import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

async function verifySystemSettings() {
  console.log('=== VERIFYING FIRESTORE /system_settings COLLECTION ===\n');

  try {
    const [mysqlRows] = await pool.query('SELECT * FROM system_settings ORDER BY key_name ASC');
    const firestoreSnap = await db.collection('system_settings').get();

    console.log(`MySQL Record Count     : ${mysqlRows.length}`);
    console.log(`Firestore Document Count: ${firestoreSnap.size}`);

    if (mysqlRows.length !== firestoreSnap.size) {
      console.error(`COUNT MISMATCH! MySQL: ${mysqlRows.length}, Firestore: ${firestoreSnap.size}`);
      process.exit(1);
    }

    let mismatches = 0;
    for (const row of mysqlRows) {
      const docId = `setting_${row.key_name}`;
      const docSnap = await db.collection('system_settings').doc(docId).get();
      if (!docSnap.exists) {
        console.error(`Missing Firestore document: ${docId}`);
        mismatches++;
        continue;
      }
      const data = docSnap.data();
      if (data.value_val !== row.value_val) {
        console.error(`Value mismatch in ${docId}`);
        mismatches++;
      }
    }

    console.log(`\nMismatches: ${mismatches}`);
    console.log(`VERDICT: ${mismatches === 0 ? 'SYSTEM SETTINGS MIGRATION VERIFIED' : 'FAILED'}`);
    process.exit(mismatches === 0 ? 0 : 1);

  } catch (err) {
    console.error('Verification error:', err.message);
    process.exit(1);
  }
}

verifySystemSettings();
