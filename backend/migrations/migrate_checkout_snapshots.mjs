/**
 * migrate_checkout_snapshots.mjs
 * ================================
 * Phase 1 migration — Creates the checkout_snapshots table.
 *
 * Safe to run multiple times (CREATE TABLE IF NOT EXISTS).
 * Never drops or modifies existing tables.
 *
 * Run:
 *   node backend/migrations/migrate_checkout_snapshots.mjs
 */

import pool from '../db.js';

async function runMigration() {
  let connection;
  try {
    connection = await pool.getConnection();
    console.log('Connected to database.');

    // ── Create checkout_snapshots table ────────────────────────────────────────
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`checkout_snapshots\` (
        \`id\`               INT UNSIGNED NOT NULL AUTO_INCREMENT,

        -- FK references (informational — no FOREIGN KEY constraints to avoid
        --   cascade complications when restoring; integrity is validated in code)
        \`booking_id\`       INT          NOT NULL,
        \`room_id\`          INT          NOT NULL,
        \`guest_id\`         INT          NOT NULL,
        \`invoice_id\`       INT          DEFAULT NULL,
        \`payment_id\`       INT          DEFAULT NULL,

        -- Immutable JSON snapshots of every affected row at time of checkout
        \`booking_snapshot\`  JSON         NOT NULL,
        \`room_snapshot\`     JSON         NOT NULL,
        \`invoice_snapshot\`  JSON         NOT NULL,
        \`ledger_snapshot\`   JSON         NOT NULL,
        \`payment_snapshot\`  JSON         NOT NULL,

        -- Audit
        \`created_by\`       INT          DEFAULT NULL,
        \`created_at\`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`expires_at\`       DATETIME     NOT NULL,
        \`recovered_at\`     DATETIME     DEFAULT NULL,

        -- Lifecycle: ACTIVE → RECOVERED | EXPIRED | VOIDED
        \`status\`           ENUM('ACTIVE','RECOVERED','EXPIRED','VOIDED')
                                           NOT NULL DEFAULT 'ACTIVE',

        PRIMARY KEY (\`id\`),

        -- Query by booking for undo eligibility checks
        INDEX \`idx_cs_booking_id\`  (\`booking_id\`),

        -- Query by status for cleanup jobs and admin listings
        INDEX \`idx_cs_status\`      (\`status\`),

        -- Query by expiry for the nightly expiry sweep (Phase 3)
        INDEX \`idx_cs_expires_at\`  (\`expires_at\`)

      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Immutable checkout state snapshots for Phase 2 Undo Checkout support';
    `);

    console.log('✔  checkout_snapshots table created (or already exists).');

    // Verify
    const [cols] = await connection.query('DESCRIBE checkout_snapshots');
    console.log('\nTable structure:');
    cols.forEach(c => {
      console.log(`  ${c.Field.padEnd(20)} ${c.Type.padEnd(30)} ${c.Null === 'NO' ? 'NOT NULL' : 'NULL'}`);
    });

    const [idx] = await connection.query('SHOW INDEX FROM checkout_snapshots');
    console.log('\nIndexes:');
    idx.forEach(i => console.log(`  ${i.Key_name.padEnd(25)} on (${i.Column_name})`));

    console.log('\n✔  Migration complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

runMigration();
