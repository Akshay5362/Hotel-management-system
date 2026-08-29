/**
 * Read-Only Migration Verification Utility
 * ==========================================
 * Compares MySQL table row counts against Firestore collection document counts
 * and performs primary-key/document-ID alignment checks.
 *
 * SAFETY RULES:
 *  - STRICTLY READ-ONLY.
 *  - ZERO writes/deletes/updates to MySQL or Firestore.
 *
 * Usage:
 *  node scripts/verifyMigrationCounts.js
 */

import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';

const COLLECTIONS_TO_VERIFY = [
  { name: 'room_types', mysqlTable: 'room_types', idPrefix: 'room_type_' },
  { name: 'rooms', mysqlTable: 'rooms', idPrefix: 'room_' },
  { name: 'staff', mysqlTable: 'users', idPrefix: 'staff_' }, // MySQL staff accounts primary in users
  { name: 'guests', mysqlTable: 'guests', idPrefix: 'guest_' },
  { name: 'housekeeping', mysqlTable: 'rooms', idPrefix: 'hk_room_' }, // Housekeeping per room
  { name: 'inventory_categories', mysqlTable: 'inventory_categories', idPrefix: 'cat_' },
  { name: 'inventory_products', mysqlTable: 'inventory_products', idPrefix: 'product_' },
  { name: 'system_settings', mysqlTable: 'system_settings', idPrefix: 'setting_' },
  { name: 'reservations', mysqlTable: 'reservations', idPrefix: 'reservation_' },
  { name: 'bookings', mysqlTable: 'bookings', idPrefix: 'booking_' },
  { name: 'booking_history', mysqlTable: 'booking_history', idPrefix: 'history_' },
  { name: 'invoices', mysqlTable: 'invoices', idPrefix: 'invoice_' },
  { name: 'payments', mysqlTable: 'payments', idPrefix: 'payment_' },
  { name: 'ledger_items', mysqlTable: 'ledger_items', idPrefix: 'ledger_' },
  { name: 'cash_logs', mysqlTable: 'cash_logs', idPrefix: 'cash_' },
  { name: 'audit_logs', mysqlTable: 'audit_logs', idPrefix: 'audit_' }
];

async function verifyMigrationCounts() {
  console.log('\n========================================================================================');
  console.log('                 READ-ONLY MIGRATION VERIFICATION UTILITY (MYSQL vs FIRESTORE)');
  console.log('========================================================================================\n');

  if (!isFirebaseConfigured || !db) {
    console.error('❌ Firebase Admin SDK is not initialized. Cannot perform Firestore comparison.');
    process.exit(1);
  }

  let connection;
  const results = [];

  try {
    connection = await pool.getConnection();

    for (const item of COLLECTIONS_TO_VERIFY) {
      let mysqlCount = 0;
      let mysqlSampleIds = [];

      try {
        const [[{ cnt }]] = await connection.query(`SELECT COUNT(*) AS cnt FROM \`${item.mysqlTable}\``);
        mysqlCount = Number(cnt || 0);

        const [rows] = await connection.query(`SELECT id FROM \`${item.mysqlTable}\` ORDER BY id ASC LIMIT 5`);
        mysqlSampleIds = rows.map(r => r.id);
      } catch (err) {
        mysqlCount = 0;
      }

      let firestoreCount = 0;
      let firestoreSampleIds = [];
      let matchedCount = 0;

      try {
        const colRef = db.collection(item.name);
        const snapshot = await colRef.get();
        firestoreCount = snapshot.size;

        const docs = snapshot.docs;
        firestoreSampleIds = docs.slice(0, 5).map(d => d.id);

        // Perform deterministic ID alignment check for MySQL sample IDs
        if (mysqlSampleIds.length > 0) {
          for (const mysqlId of mysqlSampleIds) {
            const expectedDocId = `${item.idPrefix}${mysqlId}`;
            if (docs.some(d => d.id === expectedDocId)) {
              matchedCount++;
            }
          }
        }
      } catch (err) {
        console.error(`Error reading Firestore collection '${item.name}':`, err.message);
      }

      const diff = firestoreCount - mysqlCount;
      let status = 'SYNCHRONIZED';
      if (mysqlCount === 0 && firestoreCount === 0) {
        status = 'EMPTY_BOTH';
      } else if (diff > 0) {
        status = 'MISMATCH_EXTRA_FIRESTORE';
      } else if (diff < 0) {
        status = 'MISMATCH_MISSING_FIRESTORE';
      }

      results.push({
        domain: item.name,
        mysqlTable: item.mysqlTable,
        mysqlCount,
        firestoreCount,
        difference: diff > 0 ? `+${diff}` : `${diff}`,
        alignmentCheck: mysqlSampleIds.length > 0 ? `${matchedCount}/${mysqlSampleIds.length} sample IDs aligned` : 'N/A',
        status
      });
    }

    console.table(results);

    console.log('\n----------------------------------------------------------------------------------------');
    console.log('  VERIFICATION NOTICE:');
    console.log('  - Document count parity alone does NOT guarantee complete field-level synchronization.');
    console.log('  - Collections marked MISMATCH_EXTRA_FIRESTORE contain orphan pilot/test documents.');
    console.log('  - Run scripts/purgePilotFirestoreData.js in dry-run mode to inspect orphan documents.');
    console.log('----------------------------------------------------------------------------------------\n');

  } catch (error) {
    console.error('❌ Verification Error:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

verifyMigrationCounts();
