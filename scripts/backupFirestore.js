/**
 * Read-Only Firestore Backup Utility
 * =====================================
 * Exports top-level Firestore collections to local JSON files in `backups/`.
 *
 * SAFETY RULES:
 *  - STRICTLY READ-ONLY. Zero writes/updates/deletes to Firestore.
 *  - NO credential logging or password exposure.
 *  - Defaults to `--dry-run` mode if specified.
 *
 * Usage:
 *  node scripts/backupFirestore.js --dry-run   (Dry-run verification only)
 *  node scripts/backupFirestore.js            (Performs full JSON backup)
 */

import fs from 'fs';
import path from 'path';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';

const isDryRun = process.argv.includes('--dry-run');

const COLLECTIONS_TO_BACKUP = [
  'room_types',
  'rooms',
  'staff',
  'guests',
  'housekeeping',
  'inventory_categories',
  'inventory_products',
  'system_settings',
  'settings',
  'reservations',
  'bookings',
  'booking_history',
  'invoices',
  'payments',
  'ledger_items',
  'cash_logs',
  'audit_logs'
];

async function backupFirestore() {
  console.log('\n========================================================================================');
  console.log(`  FIRESTORE BACKUP UTILITY (${isDryRun ? 'DRY-RUN MODE' : 'EXPORT MODE'})`);
  console.log('========================================================================================\n');

  if (!isFirebaseConfigured || !db) {
    console.error('❌ Firebase Admin SDK is not initialized. Cannot perform backup.');
    process.exit(1);
  }

  const backupDir = path.join(process.cwd(), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupSummary = {
    timestamp,
    mode: isDryRun ? 'DRY-RUN' : 'FULL_EXPORT',
    collections: {}
  };

  try {
    for (const colName of COLLECTIONS_TO_BACKUP) {
      console.log(`[Export] Fetching collection '/${colName}'...`);
      const snapshot = await db.collection(colName).get();
      const docs = [];

      snapshot.forEach(doc => {
        docs.push({
          _id: doc.id,
          ...doc.data()
        });
      });

      backupSummary.collections[colName] = docs.length;

      if (!isDryRun && docs.length > 0) {
        const filePath = path.join(backupDir, `firestore_${colName}_${timestamp}.json`);
        fs.writeFileSync(filePath, JSON.stringify(docs, null, 2), 'utf8');
        console.log(`  ✔ Saved ${docs.length} documents to ${path.basename(filePath)}`);
      } else {
        console.log(`  ℹ Dry-run check: ${docs.length} documents identified.`);
      }
    }

    console.log('\n----------------------------------------------------------------------------------------');
    console.log(`  FIRESTORE BACKUP ${isDryRun ? 'DRY-RUN VERIFICATION' : 'EXPORT'} COMPLETE`);
    console.table(backupSummary.collections);
    console.log('----------------------------------------------------------------------------------------\n');

  } catch (error) {
    console.error('❌ Backup Error:', error.message);
    process.exitCode = 1;
  }
}

backupFirestore();
