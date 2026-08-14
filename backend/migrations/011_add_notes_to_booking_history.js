/**
 * Migration 011 -- Add notes column to booking_history table
 * ─────────────────────────────────────────────────────────────────────────────
 * REASON:
 *   checkOutService.js and reservationController.js insert audit/event descriptions
 *   into booking_history.notes:
 *     INSERT INTO booking_history (booking_id, action, old_room_id, new_room_id, changed_by, business_date, notes)
 *
 *   Without this column, checking out a room throws:
 *     ER_BAD_FIELD_ERROR: Unknown column 'notes' in 'field list'
 *
 * IDEMPOTENCY:
 *   Uses INFORMATION_SCHEMA checks — safe on all databases.
 */

export async function up(connection) {
  console.log('\n  [011] Adding notes column to booking_history table...\n');

  const [rows] = await connection.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = 'booking_history'
       AND COLUMN_NAME  = 'notes'`
  );

  if (rows[0].cnt === 0) {
    await connection.query('ALTER TABLE `booking_history` ADD COLUMN `notes` TEXT DEFAULT NULL AFTER `business_date`');
    console.log('    + Added column: booking_history.notes');
  } else {
    console.log('    ~ Already exists, skipped: booking_history.notes');
  }

  console.log('\n  [011] Done.\n');
}

export async function down(connection) {
  console.log('\n  [011] Rolling back notes column from booking_history...\n');

  const [rows] = await connection.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = 'booking_history'
       AND COLUMN_NAME  = 'notes'`
  );

  if (rows[0].cnt > 0) {
    await connection.query('ALTER TABLE `booking_history` DROP COLUMN `notes`');
    console.log('    - Dropped column: booking_history.notes');
  }

  console.log('\n  [011] Rollback complete.\n');
}
