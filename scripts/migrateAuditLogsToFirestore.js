import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

const isCommit = process.argv.includes('--commit');

async function migrateAuditLogs() {
  console.log(`=== MIGRATING MYSQL AUDIT LOGS TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM audit_logs ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    const documentsToInsert = [];

    for (const row of rows) {
      const docId = `audit_${row.id}`;
      const docData = {
        mysql_audit_id: row.id,
        mysql_user_id: row.user_id || null,
        action: row.action,
        details: row.details || null,
        business_date: row.business_date,
        previous_business_date: row.previous_business_date || null,
        new_business_date: row.new_business_date || null,
        reason: row.reason || null,
        username: row.username || null,
        role: row.role || null,
        client_ip: row.client_ip || null,
        application_version: row.application_version || '1.0.0',
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Expected Firestore Collection: /audit_logs (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    console.log('Executing batched Firestore write operation...');
    // Batched writing in chunks of 400 docs
    const chunkSize = 400;
    for (let i = 0; i < documentsToInsert.length; i += chunkSize) {
      const chunk = documentsToInsert.slice(i, i + chunkSize);
      const batch = db.batch();
      for (const { docId, docData } of chunk) {
        const ref = db.collection('audit_logs').doc(docId);
        batch.set(ref, docData, { merge: true });
      }
      await batch.commit();
    }

    console.log(`Successfully committed ${documentsToInsert.length} /audit_logs documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Audit logs migration error:', err.message);
    process.exit(1);
  }
}

migrateAuditLogs();
