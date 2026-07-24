/**
 * Migration 003 - Staff Management Table
 * ---------------------------------------------------------------------------
 * UP:   Creates the `staff` table for production-ready staff management.
 *       Completely independent of the `users` table — does not modify any
 *       existing table or column.
 *
 * DOWN: Drops only the `staff` table created by this migration.
 *       Uses DROP TABLE IF EXISTS — safe to run on rollback even if partial.
 *
 * NO existing tables are modified.
 * NO existing data is touched.
 */

// Helper: check if a table exists
async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  return rows[0].cnt > 0;
}

export async function up(connection) {
  const exists = await tableExists(connection, 'staff');
  if (exists) {
    console.log('    ~ Table staff already exists, skipped.');
    return;
  }

  await connection.query(`
    CREATE TABLE \`staff\` (
      \`id\`            INT AUTO_INCREMENT PRIMARY KEY,
      \`full_name\`     VARCHAR(255)  NOT NULL,
      \`username\`      VARCHAR(100)  NOT NULL UNIQUE,
      \`email\`         VARCHAR(255)  NOT NULL UNIQUE,
      \`password_hash\` VARCHAR(255)  NOT NULL,
      \`role\`          ENUM(
                          'ADMIN',
                          'RECEPTIONIST',
                          'CHEF',
                          'KITCHEN_HELPER',
                          'PANTRY_BOY',
                          'CLEANER'
                        ) NOT NULL DEFAULT 'RECEPTIONIST',
      \`department\`    ENUM(
                          'Administration',
                          'Front Office',
                          'Kitchen',
                          'Pantry',
                          'Housekeeping'
                        ) NOT NULL DEFAULT 'Front Office',
      \`shift\`         ENUM('Morning', 'Night') NOT NULL DEFAULT 'Morning',
      \`phone\`         VARCHAR(30)  DEFAULT NULL,
      \`status\`        ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
      \`deleted\`       TINYINT(1)   NOT NULL DEFAULT 0,
      \`created_at\`    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\`    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`last_login\`    TIMESTAMP    DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('    + Created table: staff');
}

export async function down(connection) {
  await connection.query(`DROP TABLE IF EXISTS \`staff\`;`);
  console.log('    - Dropped table: staff');
}
