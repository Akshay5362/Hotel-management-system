import pool from '../backend/db.js';
import fs from 'fs';
import path from 'path';

async function executeOutboxCleanup() {
  console.log('\n================================================================');
  console.log('  HPMS SKY5 — TARGETED CLEANUP OF 7 STALE OUTBOX ROWS');
  console.log('================================================================\n');

  try {
    const targetIds = [7, 339, 340, 341, 342, 343, 347];

    // BEFORE DELETE VERIFICATION
    console.log('--- BEFORE DELETE VERIFICATION ---');

    // 1. Verify backup file exists
    const backupDir = path.resolve('backups');
    const backupFiles = fs.readdirSync(backupDir).filter(f => f.startsWith('stale_outbox_backup_'));
    console.log(` - Backup File Found: ${backupFiles.length > 0 ? 'YES' : 'NO'} (${backupFiles.join(', ')})`);

    if (backupFiles.length === 0) {
      console.error('ABORTING: No backup file found in backups/ directory!');
      process.exit(1);
    }

    // 2. Select target IDs
    const [targetRows] = await pool.query(
      `SELECT id, event_id, event_type, status FROM dual_write_outbox WHERE id IN (?)`,
      [targetIds]
    );
    console.log(` - Target Rows Selected for Deletion: ${targetRows.length} (Expected: 7)`);
    targetRows.forEach(r => console.log(`   * ID ${r.id}: ${r.event_type} (${r.status})`));

    // 3. Verify IDs 357 & 359 are NOT in target list
    const containsPreserved = targetIds.includes(357) || targetIds.includes(359);
    console.log(` - Preserved IDs 357 / 359 in Target List: ${containsPreserved ? 'DANGER (YES)' : 'SAFE (NO)'}`);
    if (containsPreserved) {
      console.error('ABORTING: Target list illegally contains preserved IDs!');
      process.exit(1);
    }

    // 4. Capture Business Tables Baseline Counts BEFORE Delete
    const businessTables = [
      'rooms', 'room_types', 'staff', 'guests', 'bookings', 'reservations',
      'payments', 'invoices', 'ledger_items', 'inventory_products',
      'inventory_categories', 'system_settings'
    ];

    const countsBefore = {};
    for (const tbl of businessTables) {
      const [res] = await pool.query(`SELECT COUNT(*) as cnt FROM \`${tbl}\``);
      countsBefore[tbl] = res[0].cnt;
    }

    // EXECUTE DELETE
    console.log('\n--- EXECUTING TARGETED DELETE ---');
    const [deleteResult] = await pool.query(
      `DELETE FROM dual_write_outbox WHERE id IN (?)`,
      [targetIds]
    );
    console.log(` - Executed SQL: DELETE FROM dual_write_outbox WHERE id IN (7, 339, 340, 341, 342, 343, 347);`);
    console.log(` - Rows Affected / Deleted: ${deleteResult.affectedRows}`);

    // AFTER DELETE VERIFICATION
    console.log('\n--- AFTER DELETE VERIFICATION ---');

    // 1. Verify deleted IDs no longer exist
    const [checkDeleted] = await pool.query(
      `SELECT id FROM dual_write_outbox WHERE id IN (?)`,
      [targetIds]
    );
    console.log(` - Remaining Stale Target IDs in DB: ${checkDeleted.length} (Expected: 0)`);

    // 2. Verify IDs 357 & 359 still exist
    const [preservedRows] = await pool.query(
      `SELECT id, event_id, event_type, status FROM dual_write_outbox WHERE id IN (357, 359)`
    );
    console.log(` - Preserved Rows Remaining: ${preservedRows.length} (Expected: 2)`);
    preservedRows.forEach(r => console.log(`   * ID ${r.id}: ${r.event_type} (${r.status})`));

    // 3. Verify total remaining outbox rows
    const [totalOutbox] = await pool.query(`SELECT COUNT(*) as total FROM dual_write_outbox`);
    const remainingTotal = totalOutbox[0].total;
    console.log(` - Total Remaining Outbox Rows: ${remainingTotal} (Expected: 2)`);

    // 4. Verify Business Tables Baseline Counts AFTER Delete
    console.log('\n - Business Tables Verification:');
    let businessTablesIntact = true;
    for (const tbl of businessTables) {
      const [res] = await pool.query(`SELECT COUNT(*) as cnt FROM \`${tbl}\``);
      const cntAfter = res[0].cnt;
      const cntBefore = countsBefore[tbl];
      const match = cntAfter === cntBefore;
      console.log(`   * \`${tbl.padEnd(20)}\`: Before=${cntBefore}, After=${cntAfter} -> ${match ? 'UNTOUCHED (PASS)' : 'MISMATCH (FAIL)'}`);
      if (!match) businessTablesIntact = false;
    }

    console.log('\n================================================================');
    console.log(`FINAL STATUS: ${deleteResult.affectedRows === 7 && remainingTotal === 2 && businessTablesIntact ? 'SUCCESS — OUTBOX CLEANUP COMPLETE' : 'FAILED — VERIFICATION ISSUE'}`);
    console.log('================================================================\n');

    process.exit(0);

  } catch (err) {
    console.error('Cleanup Error:', err.message);
    process.exit(1);
  }
}

executeOutboxCleanup();
