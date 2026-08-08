/**
 * Migration 006 — Add billing_instruction and meal_plan to bookings + reservations
 * ---------------------------------------------------------------------------
 * UP:
 *   bookings.billing_instruction  VARCHAR(50)  DEFAULT 'Direct to Guest' (nullable)
 *   bookings.meal_plan            VARCHAR(30)  DEFAULT 'EP'              (nullable)
 *   reservations.meal_plan        VARCHAR(30)  DEFAULT 'EP'              (nullable)
 *   (reservations.billing_instructions already exists from init_db / migration 005)
 *
 * DOWN:
 *   Drops the three columns added above.
 *
 * RULES:
 *   - No tables are created, dropped, or truncated.
 *   - All new columns are nullable with safe defaults — existing rows are unaffected.
 *   - Idempotent: addColumnIfMissing / dropColumnIfPresent skip if already done.
 */

// Helper: add a column only if it does not already exist
async function addColumnIfMissing(connection, table, column, definition) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = ?
       AND COLUMN_NAME  = ?`,
    [table, column]
  );
  if (rows[0].cnt === 0) {
    await connection.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`
    );
    console.log(`    + Added column: ${table}.${column}`);
  } else {
    console.log(`    ~ Already exists, skipped: ${table}.${column}`);
  }
}

// Helper: drop a column only if it exists
async function dropColumnIfPresent(connection, table, column) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = ?
       AND COLUMN_NAME  = ?`,
    [table, column]
  );
  if (rows[0].cnt > 0) {
    await connection.query(
      `ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``
    );
    console.log(`    - Dropped column: ${table}.${column}`);
  } else {
    console.log(`    ~ Already absent, skipped: ${table}.${column}`);
  }
}

// UP
export async function up(connection) {
  console.log('  Running migration 006: Adding billing_instruction + meal_plan columns...');

  // bookings table
  await addColumnIfMissing(
    connection, 'bookings', 'billing_instruction',
    "VARCHAR(50) NOT NULL DEFAULT 'Direct to Guest'"
  );
  await addColumnIfMissing(
    connection, 'bookings', 'meal_plan',
    "VARCHAR(30) NOT NULL DEFAULT 'EP'"
  );

  // reservations table — billing_instructions already exists; only add meal_plan
  await addColumnIfMissing(
    connection, 'reservations', 'meal_plan',
    "VARCHAR(30) NOT NULL DEFAULT 'EP'"
  );

  console.log('  ? Migration 006 complete.');
}

// DOWN
export async function down(connection) {
  console.log('  Rolling back migration 006: Removing billing_instruction + meal_plan columns...');

  await dropColumnIfPresent(connection, 'bookings', 'billing_instruction');
  await dropColumnIfPresent(connection, 'bookings', 'meal_plan');
  await dropColumnIfPresent(connection, 'reservations', 'meal_plan');

  console.log('  ? Rollback of migration 006 complete.');
}
