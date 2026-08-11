/**
 * Migration 008 - Transactional Dual-Write Outbox Table
 * ---------------------------------------------------------------------------
 * UP:   Creates the `dual_write_outbox` table for Phase 3 asynchronous dual-writing.
 *       Stages outbox events atomically within MySQL transactions.
 *
 * DOWN: Drops only the `dual_write_outbox` table created by this migration.
 *       Uses DROP TABLE IF EXISTS — safe to run on rollback even if partial.
 *
 * NO existing operational tables are modified.
 * NO existing data is touched.
 */

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
  const exists = await tableExists(connection, 'dual_write_outbox');
  if (exists) {
    console.log('    ~ Table dual_write_outbox already exists, skipped.');
    return;
  }

  await connection.query(`
    CREATE TABLE \`dual_write_outbox\` (
      \`id\`             BIGINT AUTO_INCREMENT PRIMARY KEY,
      \`event_id\`       VARCHAR(64)   NOT NULL UNIQUE,
      \`event_type\`     VARCHAR(64)   NOT NULL,
      \`aggregate_type\` VARCHAR(64)   NOT NULL,
      \`aggregate_id\`   VARCHAR(128)  NOT NULL,
      \`payload\`        LONGTEXT      NOT NULL,
      \`status\`         ENUM('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER') NOT NULL DEFAULT 'PENDING',
      \`attempts\`       INT           NOT NULL DEFAULT 0,
      \`available_at\`   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`processed_at\`   TIMESTAMP     NULL DEFAULT NULL,
      \`last_error\`     TEXT          NULL DEFAULT NULL,
      \`created_at\`     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\`     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX \`idx_outbox_status\` (\`status\`),
      INDEX \`idx_outbox_available\` (\`available_at\`),
      INDEX \`idx_outbox_event\` (\`event_id\`),
      INDEX \`idx_outbox_aggregate\` (\`aggregate_type\`, \`aggregate_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('    + Created table: dual_write_outbox');
}

export async function down(connection) {
  await connection.query(`DROP TABLE IF EXISTS \`dual_write_outbox\`;`);
  console.log('    - Dropped table: dual_write_outbox');
}
