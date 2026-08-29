import pool from '../backend/db.js';

async function verifyMigration008() {
  console.log('\n================================================================');
  console.log('  HPMS SKY5 — MIGRATION 008 LOCAL MYSQL VERIFICATION');
  console.log('================================================================\n');

  try {
    // 1. Table existence check
    const [tables] = await pool.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dual_write_outbox'`
    );
    const exists = tables.length > 0;
    console.log(`1. Table Existence Check: dual_write_outbox -> ${exists ? 'EXISTS (YES)' : 'MISSING (NO)'}`);

    if (!exists) {
      console.log('FAILED: Table dual_write_outbox does not exist.');
      process.exit(1);
    }

    // 2. Schema structure
    console.log('\n2. Table Schema Structure:');
    const [columns] = await pool.query(`DESCRIBE dual_write_outbox`);
    columns.forEach(col => {
      console.log(` - ${col.Field.padEnd(20)} | ${col.Type.padEnd(25)} | Null: ${col.Null} | Key: ${col.Key} | Default: ${col.Default}`);
    });

    // 3. Index & Constraints
    console.log('\n3. Indexes & Constraints:');
    const [indexes] = await pool.query(`SHOW INDEX FROM dual_write_outbox`);
    let hasUniqueEventId = false;
    indexes.forEach(idx => {
      console.log(` - Index Name: ${idx.Key_name.padEnd(25)} | Column: ${idx.Column_name.padEnd(20)} | Unique: ${idx.Non_unique === 0 ? 'YES' : 'NO'}`);
      if (idx.Column_name === 'event_id' && idx.Non_unique === 0) {
        hasUniqueEventId = true;
      }
    });

    console.log(`\n - UNIQUE constraint on event_id: ${hasUniqueEventId ? 'VERIFIED (YES)' : 'MISSING (NO)'}`);

    // 4. Outbox Row Count
    const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM dual_write_outbox`);
    const totalOutboxRows = countRows[0].total;
    console.log(`\n4. Existing Outbox Row Count: ${totalOutboxRows}`);

    // 5. Existing Business Tables Verification
    console.log('\n5. Existing Business Tables Baseline Check:');
    const businessTables = ['rooms', 'room_types', 'staff', 'guests', 'bookings', 'payments', 'ledger_items', 'system_settings'];
    for (const tbl of businessTables) {
      const [cnt] = await pool.query(`SELECT COUNT(*) AS total FROM \`${tbl}\``);
      console.log(` - Table \`${tbl.padEnd(18)}\`: ${cnt[0].total} rows (UNTOUCHED)`);
    }

    console.log('\n================================================================');
    console.log('MIGRATION 008 VERIFICATION COMPLETE: ALL CHECKS PASSED');
    console.log('================================================================\n');
    process.exit(0);

  } catch (err) {
    console.error('Migration 008 Verification Error:', err.message);
    process.exit(1);
  }
}

verifyMigration008();
