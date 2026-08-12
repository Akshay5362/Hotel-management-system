import pool from '../backend/db.js';
import fs from 'fs';
import path from 'path';

async function backupStaleOutboxRows() {
  console.log('\n================================================================');
  console.log('  HPMS SKY5 — READ-ONLY BACKUP OF STALE DUAL_WRITE_OUTBOX ROWS');
  console.log('================================================================\n');

  try {
    const staleIds = [7, 339, 340, 341, 342, 343, 347];
    const [staleRows] = await pool.query(
      `SELECT id, event_id, event_type, aggregate_type, aggregate_id, status, attempts, available_at, processed_at, last_error, payload, created_at
       FROM dual_write_outbox 
       WHERE id IN (?) 
       ORDER BY id ASC`,
      [staleIds]
    );

    console.log(`Fetched ${staleRows.length} stale outbox rows for backup.`);

    const backupDir = path.resolve('backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const backupFilePath = path.join(backupDir, `stale_outbox_backup_${Date.now()}.json`);
    fs.writeFileSync(backupFilePath, JSON.stringify(staleRows, null, 2), 'utf8');

    console.log(`Backup successfully written to: ${backupFilePath}`);

    // Verify Real Pending Rows (IDs 357, 359)
    const [realRows] = await pool.query(
      `SELECT id, event_id, event_type, aggregate_type, aggregate_id, status, created_at 
       FROM dual_write_outbox 
       WHERE id IN (357, 359)`
    );

    console.log('\nReal Pending Rows Verification:');
    realRows.forEach(r => {
      console.log(` - ID: ${r.id} | Event: ${r.event_type} | Aggregate: ${r.aggregate_id} | Status: ${r.status}`);
    });

    // Check MySQL Bookings for BKG-218865 and BKG-492109
    const [bookings] = await pool.query(
      `SELECT id, booking_number, guest_id, room_id, total_amount, booking_status 
       FROM bookings 
       WHERE booking_number IN ('BKG-218865', 'BKG-492109')`
    );

    console.log('\nCorresponding Real MySQL Bookings:');
    bookings.forEach(b => {
      console.log(` - Booking Number: ${b.booking_number} | Guest ID: ${b.guest_id} | Room ID: ${b.room_id} | Amount: ₹${b.total_amount} | Status: ${b.booking_status}`);
    });

    // Check schema for archive table or column
    const [schemaCols] = await pool.query(`DESCRIBE dual_write_outbox`);
    const colNames = schemaCols.map(c => c.Field);
    const hasArchiveCol = colNames.includes('archived_at') || colNames.includes('is_archived');

    const [archiveTableCheck] = await pool.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dual_write_outbox_archive'`
    );
    const hasArchiveTable = archiveTableCheck.length > 0;

    console.log('\nArchive Mechanism Audit:');
    console.log(` - Archive Column in dual_write_outbox: ${hasArchiveCol ? 'YES' : 'NO'}`);
    console.log(` - Dedicated dual_write_outbox_archive Table: ${hasArchiveTable ? 'YES' : 'NO'}`);

    console.log('\n================================================================');
    console.log('BACKUP AND AUDIT COMPLETE');
    console.log('================================================================\n');

    process.exit(0);

  } catch (err) {
    console.error('Backup Error:', err.message);
    process.exit(1);
  }
}

backupStaleOutboxRows();
