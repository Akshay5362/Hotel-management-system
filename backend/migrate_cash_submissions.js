/**
 * migrate_cash_submissions.js
 * Safe one-time migration to add the cash_submissions table.
 * Uses CREATE TABLE IF NOT EXISTS — safe to run multiple times.
 */

import pool from './db.js';

async function migrate() {
  const connection = await pool.getConnection();
  try {
    console.log('Running migration: cash_submissions table...');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`cash_submissions\` (
        \`id\`                INT AUTO_INCREMENT PRIMARY KEY,
        \`receipt_id\`        VARCHAR(30)  NOT NULL UNIQUE,
        \`business_date\`     VARCHAR(20)  NOT NULL,
        \`submitted_at\`      DATETIME     NOT NULL,
        \`receptionist_name\` VARCHAR(255) NOT NULL,
        \`receiver_name\`     VARCHAR(255) NOT NULL,
        \`amount\`            INT          NOT NULL,
        \`remaining_cash\`    INT          NOT NULL,
        \`remarks\`           TEXT,
        \`created_at\`        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log('✓ cash_submissions table ready.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    connection.release();
  }
}

migrate();
