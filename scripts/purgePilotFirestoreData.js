/**
 * Purge Pilot & Stale Firestore Data Utility
 * ============================================
 * Identifies and purges stale/pilot documents across all Firestore collections
 * that are NOT backed by active records in MySQL.
 *
 * SAFETY RULES:
 *  - Defaults to DRY-RUN mode (`--dry-run`).
 *  - ZERO deletes performed unless `--commit` is explicitly supplied.
 *  - Preserves ALL 53 active MySQL-backed documents (`DO_NOT_DELETE` set).
 *  - Uses SafeFirestoreBatchWriter for safe chunked batch deletes (max 250 ops/batch).
 *
 * Usage:
 *  node scripts/purgePilotFirestoreData.js           (Runs Dry-Run mode)
 *  node scripts/purgePilotFirestoreData.js --dry-run  (Runs Dry-Run mode)
 *  node scripts/purgePilotFirestoreData.js --commit   (Performs Firestore commit purge)
 */

import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { SafeFirestoreBatchWriter } from './utils/firestoreBatch.js';

const isCommitMode = process.argv.includes('--commit');
const isDryRunMode = !isCommitMode;

async function runPilotDataPurge() {
  console.log('\n========================================================================================');
  console.log(`  FIRESTORE PILOT-DATA PURGE (${isCommitMode ? 'COMMIT EXECUTION MODE' : 'DRY-RUN MODE'})`);
  console.log('========================================================================================\n');

  if (!isFirebaseConfigured || !db) {
    console.error('❌ Firebase Admin SDK is not initialized. Cannot perform purge.');
    process.exit(1);
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // 1. Load active MySQL Primary Key sets
    const [users] = await connection.query('SELECT id FROM users');
    const [staff] = await connection.query('SELECT id FROM staff');
    const [rooms] = await connection.query('SELECT id FROM rooms');
    const [roomTypes] = await connection.query('SELECT id FROM room_types');
    const [categories] = await connection.query('SELECT id FROM inventory_categories');
    const [products] = await connection.query('SELECT id FROM inventory_products');
    const [guests] = await connection.query('SELECT id FROM guests');
    const [settings] = await connection.query('SELECT key_name FROM system_settings');
    const [bookings] = await connection.query('SELECT id, booking_number FROM bookings');
    const [invoices] = await connection.query('SELECT id, invoice_number FROM invoices');
    const [payments] = await connection.query('SELECT id FROM payments');
    const [ledger] = await connection.query('SELECT id FROM ledger_items');
    const [cash] = await connection.query('SELECT id FROM cash_logs');
    const [auditLogs] = await connection.query('SELECT id FROM audit_logs');
    const [reservations] = await connection.query('SELECT id FROM reservations');
    const [bookingHistory] = await connection.query('SELECT id FROM booking_history');

    const validDocIdMap = {
      room_types: new Set(roomTypes.map(rt => `room_type_${rt.id}`)),
      rooms: new Set(rooms.map(r => `room_${r.id}`)),
      staff: new Set(users.map(u => `staff_${u.id}`).concat(staff.map(s => `staff_${s.id}`))),
      guests: new Set(guests.map(g => `guest_${g.id}`)),
      housekeeping: new Set(rooms.map(r => `hk_room_${r.id}`)),
      inventory_categories: new Set(categories.map(c => `cat_${c.id}`)),
      inventory_products: new Set(products.map(p => `product_${p.id}`).concat(products.map(p => `prod_${p.id}`))),
      system_settings: new Set(settings.map(s => `setting_${s.key_name}`)),
      reservations: new Set(reservations.map(r => `reservation_${r.id}`)),
      bookings: new Set(bookings.map(b => `booking_${b.id}`).concat(bookings.map(b => `bkg_${b.booking_number}`))),
      booking_history: new Set(bookingHistory.map(bh => `history_${bh.id}`)),
      invoices: new Set(invoices.map(i => `invoice_${i.id}`).concat(invoices.map(i => `inv_${i.invoice_number}`))),
      payments: new Set(payments.map(p => `payment_${p.id}`)),
      ledger_items: new Set(ledger.map(l => `ledger_${l.id}`)),
      cash_logs: new Set(cash.map(c => `cash_${c.id}`)),
      audit_logs: new Set(auditLogs.map(a => `audit_${a.id}`)),
      settings: new Set() // Legacy collection - 0 valid
    };

    const COLLECTIONS = [
      'room_types', 'rooms', 'staff', 'guests', 'housekeeping',
      'inventory_categories', 'inventory_products', 'system_settings',
      'settings', 'reservations', 'bookings', 'booking_history',
      'invoices', 'payments', 'ledger_items', 'cash_logs', 'audit_logs'
    ];

    const purgeCandidates = [];
    const protectedDocs = [];
    const breakdown = {};

    // 2. Scan all collections
    for (const colName of COLLECTIONS) {
      const validSet = validDocIdMap[colName] || new Set();
      const colRef = db.collection(colName);
      const snapshot = await colRef.get();
      let colPurgeCount = 0;
      let colKeepCount = 0;

      snapshot.forEach(doc => {
        const docId = doc.id;
        const isProtected = colName !== 'settings' && validSet.has(docId);

        if (isProtected) {
          colKeepCount++;
          protectedDocs.push({ collection: colName, docId });
        } else {
          colPurgeCount++;
          purgeCandidates.push({ collection: colName, docId });
        }
      });

      breakdown[colName] = {
        total: snapshot.size,
        protected_keep: colKeepCount,
        pilot_purge: colPurgeCount
      };
    }

    // 3. Print Pre-Purge Validation Report
    console.log('--- PURGE CANDIDATES BREAKDOWN PER COLLECTION ---');
    console.table(breakdown);

    console.log(`\nTOTAL FIRESTORE DOCUMENTS EXAMINED : ${protectedDocs.length + purgeCandidates.length}`);
    console.log(`PROTECTED DOCUMENTS TO KEEP (DO_NOT_DELETE) : ${protectedDocs.length}`);
    console.log(`STALE/PILOT DOCUMENTS TO PURGE (SAFE_DELETE) : ${purgeCandidates.length}`);

    // Verification Checks
    if (purgeCandidates.length !== 183) {
      throw new Error(`SAFETY STOP: Expected exactly 183 purge candidates, found ${purgeCandidates.length}. Aborting purge.`);
    }
    if (protectedDocs.length !== 53) {
      throw new Error(`SAFETY STOP: Expected exactly 53 protected documents, found ${protectedDocs.length}. Aborting purge.`);
    }

    console.log('\n✔ All safety verification assertions PASSED.');

    if (isDryRunMode) {
      console.log('\n========================================================================================');
      console.log('  DRY-RUN COMPLETE: ZERO FIRESTORE DOCUMENTS DELETED.');
      console.log('  ZERO MYSQL WRITES PERFORMED.');
      console.log('========================================================================================\n');
      return;
    }

    // 4. Execute Commit Mode Deletions using SafeFirestoreBatchWriter
    console.log(`\n[Commit Mode] Committing deletion of ${purgeCandidates.length} stale Firestore documents...`);

    const batchWriter = new SafeFirestoreBatchWriter(db, {
      collectionName: 'purge_pilot_data',
      maxBatchSize: 250,
      isDryRun: false
    });

    for (const item of purgeCandidates) {
      const docRef = db.collection(item.collection).doc(item.docId);
      await batchWriter.delete(docRef);
    }

    await batchWriter.finalize();
    console.log(`\n✔ [SUCCESS] Successfully deleted ${purgeCandidates.length} stale pilot documents from Cloud Firestore.\n`);

  } catch (error) {
    console.error('\n❌ Purge Error:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

runPilotDataPurge();
