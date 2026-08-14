/**
 * Migration 009 -- Add housekeeping columns to rooms table
 * The application code in roomStatusService.js, housekeepingController.js,
 * checkOutService.js, AvailabilityService.js, FactoryResetService.js etc
 * all reference 4 columns on rooms that were never in init_db.js or migrations:
 *   rooms.housekeeping_status      VARCHAR(20) 'Clean'/'Dirty'/'Cleaning'
 *   rooms.housekeeping_priority    VARCHAR(30) 'Normal'/'High Priority'
 *   rooms.housekeeping_assigned_to INT FK->users.id
 *   rooms.last_cleaned_at          DATETIME
 * Without these, GET /api/status throws ER_BAD_FIELD_ERROR on every request.
 */

async function addColumnIfMissing(connection, table, column, definition) {
  const [rows] = await connection.query(
    'SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  if (rows[0].cnt === 0) {
    await connection.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + definition);
    console.log('    + Added column: ' + table + '.' + column);
  } else {
    console.log('    ~ Already exists, skipped: ' + table + '.' + column);
  }
}

async function dropColumnIfPresent(connection, table, column) {
  const [rows] = await connection.query(
    'SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  if (rows[0].cnt > 0) {
    await connection.query('ALTER TABLE `' + table + '` DROP COLUMN `' + column + '`');
    console.log('    - Dropped column: ' + table + '.' + column);
  } else {
    console.log('    ~ Already absent, skipped: ' + table + '.' + column);
  }
}

export async function up(connection) {
  console.log('\n  [009] Adding housekeeping columns to rooms table...\n');

  await addColumnIfMissing(connection, 'rooms', 'housekeeping_status',
    "VARCHAR(20) NOT NULL DEFAULT 'Clean' AFTER `status`");

  await addColumnIfMissing(connection, 'rooms', 'housekeeping_priority',
    "VARCHAR(30) NOT NULL DEFAULT 'Normal' AFTER `housekeeping_status`");

  await addColumnIfMissing(connection, 'rooms', 'housekeeping_assigned_to',
    'INT DEFAULT NULL AFTER `housekeeping_priority`');

  await addColumnIfMissing(connection, 'rooms', 'last_cleaned_at',
    'DATETIME DEFAULT NULL AFTER `housekeeping_assigned_to`');

  const [fkRows] = await connection.query(
    "SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND CONSTRAINT_NAME = 'fk_rooms_hk_assigned_to'"
  );
  if (fkRows[0].cnt === 0) {
    await connection.query(
      'ALTER TABLE `rooms` ADD CONSTRAINT `fk_rooms_hk_assigned_to` FOREIGN KEY (`housekeeping_assigned_to`) REFERENCES `users`(`id`) ON DELETE SET NULL'
    );
    console.log('    + Added FK: rooms.housekeeping_assigned_to -> users.id');
  } else {
    console.log('    ~ FK fk_rooms_hk_assigned_to already exists, skipped.');
  }

  const [dirtyResult] = await connection.query(
    "UPDATE `rooms` SET `housekeeping_status` = 'Dirty', `housekeeping_priority` = 'High Priority' WHERE `status` = 'dirty' AND `housekeeping_status` = 'Clean'"
  );
  console.log('\n    Backfilled ' + dirtyResult.affectedRows + ' dirty room(s) -> Dirty / High Priority');

  const [cleanResult] = await connection.query(
    "UPDATE `rooms` SET `housekeeping_status` = 'Clean', `housekeeping_priority` = 'Normal' WHERE `status` != 'dirty' AND (`housekeeping_status` IS NULL OR `housekeeping_status` = '')"
  );
  console.log('    Backfilled ' + cleanResult.affectedRows + ' clean room(s) -> Clean / Normal');

  console.log('\n  [009] Done.\n');
}

export async function down(connection) {
  console.log('\n  [009] Rolling back housekeeping columns from rooms...\n');

  const [rows] = await connection.query(
    "SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND CONSTRAINT_NAME = 'fk_rooms_hk_assigned_to'"
  );
  if (rows[0].cnt > 0) {
    await connection.query('ALTER TABLE `rooms` DROP FOREIGN KEY `fk_rooms_hk_assigned_to`');
    console.log('    - Dropped FK: fk_rooms_hk_assigned_to');
  }

  for (const col of ['last_cleaned_at', 'housekeeping_assigned_to', 'housekeeping_priority', 'housekeeping_status']) {
    await dropColumnIfPresent(connection, 'rooms', col);
  }

  console.log('\n  [009] Rollback complete.\n');
}
