/**
 * Migration 010 -- Create housekeeping_logs table
 * ─────────────────────────────────────────────────────────────────────────────
 * REASON:
 *   housekeepingController.js, FactoryResetService.js, and test files all
 *   reference a `housekeeping_logs` table that:
 *
 *     - Was originally created by backend/migrate_hk.js (a pre-migration-system
 *       standalone script that is no longer run on new deployments).
 *     - Was NEVER incorporated into init_db.js or the numbered migrations.
 *     - Is NOT the same as the `housekeeping` table (which records daily status
 *       snapshots per business_date).
 *
 *   housekeeping_logs is an EVENT LOG of individual housekeeping actions
 *   (assign, mark clean, mark dirty, inspect, etc.) with who performed them.
 *
 *   Without this table:
 *     - Factory Reset fails: "Table hotel_pms.housekeeping_logs doesn't exist"
 *     - housekeepingController.assignHousekeeper() throws ER_NO_SUCH_TABLE
 *     - housekeepingController.updateHousekeepingStatus() throws ER_NO_SUCH_TABLE
 *
 * SCHEMA SOURCE:
 *   Derived from migrate_hk.js (lines 59-71) and the INSERT statements in
 *   housekeepingController.js:
 *     INSERT INTO housekeeping_logs (room_id, action, performed_by, notes)
 *
 * IDEMPOTENCY:
 *   Uses CREATE TABLE IF NOT EXISTS — safe on existing installations where
 *   migrate_hk.js has already run.
 */

export async function up(connection) {
  console.log('\n  [010] Creating housekeeping_logs table...\n');

  await connection.query(`
    CREATE TABLE IF NOT EXISTS \`housekeeping_logs\` (
      \`id\`           INT AUTO_INCREMENT PRIMARY KEY,
      \`room_id\`      INT NOT NULL,
      \`action\`       VARCHAR(100) NOT NULL,
      \`performed_by\` INT DEFAULT NULL,
      \`notes\`        TEXT DEFAULT NULL,
      \`created_at\`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`room_id\`)      REFERENCES \`rooms\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`performed_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log('    + Table housekeeping_logs created (or already existed).');
  console.log('\n  [010] Done.\n');
}

export async function down(connection) {
  console.log('\n  [010] Dropping housekeeping_logs table...\n');
  await connection.query('DROP TABLE IF EXISTS `housekeeping_logs`');
  console.log('    - Dropped housekeeping_logs.');
  console.log('\n  [010] Rollback complete.\n');
}
