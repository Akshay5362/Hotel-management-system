/**
 * Migration 001 - Expand payments table for full Payment Module
 * ---------------------------------------------------------------------------
 * UP:   Adds 11 new columns to the existing `payments` table.
 *       All new columns are nullable with safe defaults so every existing
 *       INSERT that omits them continues to work without modification.
 *       After adding columns, backfills `payment_status = "Paid"` for all
 *       existing rows (they were all real completed transactions).
 *
 * DOWN: Removes only the columns added by this migration.
 *       Uses DROP COLUMN IF EXISTS (MySQL 8.0.17+) so it is safe to run
 *       even if a previous partial rollback already removed some of them.
 *
 * NO tables are created, dropped, or truncated.
 * NO existing data is modified except the backfill described above.
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

// ============================================================================
// UP — Apply migration
// ============================================================================
export async function up(connection) {
  console.log('\n  [001] Expanding payments table...\n');

  // 1. guest_id — links the payment directly to the guest record
  //    payment_method = 'Cash' (hardcoded in existing bookRoom/checkIn)
  await addColumnIfMissing(
    connection, 'payments', 'guest_id',
    'INT DEFAULT NULL AFTER `booking_id`'
  );

  // 2. currency — ISO 4217 currency code, default INR for all existing rows
  await addColumnIfMissing(
    connection, 'payments', 'currency',
    "VARCHAR(10) NOT NULL DEFAULT 'INR' AFTER `amount`"
  );

  // 3. payment_status — lifecycle state of the payment
  //    Allowed values: Pending | Partially Paid | Paid | Failed | Cancelled | Refunded
  //    Existing rows are real completed payments, backfilled to 'Paid' after ALTER.
  await addColumnIfMissing(
    connection, 'payments', 'payment_status',
    "VARCHAR(30) NOT NULL DEFAULT 'Pending' AFTER `payment_method`"
  );

  // 4. payment_gateway — which gateway processed this payment
  //    Allowed values: Internal | Razorpay | Paytm | Stripe
  await addColumnIfMissing(
    connection, 'payments', 'payment_gateway',
    "VARCHAR(50) NOT NULL DEFAULT 'Internal' AFTER `payment_status`"
  );

  // 5. gateway_order_id — order ID returned by the payment gateway (e.g. Razorpay order_id)
  await addColumnIfMissing(
    connection, 'payments', 'gateway_order_id',
    'VARCHAR(100) DEFAULT NULL AFTER `payment_gateway`'
  );

  // 6. gateway_payment_id — payment ID returned by the gateway (e.g. Razorpay payment_id)
  await addColumnIfMissing(
    connection, 'payments', 'gateway_payment_id',
    'VARCHAR(100) DEFAULT NULL AFTER `gateway_order_id`'
  );

  // 7. transaction_id — our internal unique transaction reference (UUID v4)
  await addColumnIfMissing(
    connection, 'payments', 'transaction_id',
    'VARCHAR(100) DEFAULT NULL AFTER `gateway_payment_id`'
  );

  // 8. collected_by — FK to users.id (which staff member processed the payment)
  await addColumnIfMissing(
    connection, 'payments', 'collected_by',
    'INT DEFAULT NULL AFTER `transaction_id`'
  );

  // 9. payment_date — when the payment was actually completed (NULL = not yet paid)
  await addColumnIfMissing(
    connection, 'payments', 'payment_date',
    'DATETIME DEFAULT NULL AFTER `collected_by`'
  );

  // 10. remarks — free-text note (reason for refund, partial payment note, etc.)
  await addColumnIfMissing(
    connection, 'payments', 'remarks',
    'TEXT DEFAULT NULL AFTER `payment_date`'
  );

  // 11. updated_at — auto-maintained update timestamp
  await addColumnIfMissing(
    connection, 'payments', 'updated_at',
    'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`'
  );

  // -- Add FK constraint for guest_id (only if it does not already exist) ----
  const [fkRows] = await connection.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA    = DATABASE()
       AND TABLE_NAME      = 'payments'
       AND CONSTRAINT_NAME = 'fk_payments_guest_id'`
  );
  if (fkRows[0].cnt === 0) {
    await connection.query(`
      ALTER TABLE \`payments\`
        ADD CONSTRAINT \`fk_payments_guest_id\`
        FOREIGN KEY (\`guest_id\`) REFERENCES \`guests\`(\`id\`) ON DELETE SET NULL
    `);
    console.log('    + Added FK: payments.guest_id -> guests.id');
  } else {
    console.log('    ~ FK fk_payments_guest_id already exists, skipped.');
  }

  // -- Add FK constraint for collected_by ------------------------------------
  const [fkRows2] = await connection.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA    = DATABASE()
       AND TABLE_NAME      = 'payments'
       AND CONSTRAINT_NAME = 'fk_payments_collected_by'`
  );
  if (fkRows2[0].cnt === 0) {
    await connection.query(`
      ALTER TABLE \`payments\`
        ADD CONSTRAINT \`fk_payments_collected_by\`
        FOREIGN KEY (\`collected_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    `);
    console.log('    + Added FK: payments.collected_by -> users.id');
  } else {
    console.log('    ~ FK fk_payments_collected_by already exists, skipped.');
  }

  // -- Backfill: all existing records are real completed payments -------------
  //    Set payment_status = 'Paid' and payment_date = created_at for existing rows
  const [backfillResult] = await connection.query(`
    UPDATE \`payments\`
    SET
      \`payment_status\` = 'Paid',
      \`payment_date\`   = \`created_at\`
    WHERE \`payment_status\` = 'Pending'
      AND \`created_at\`     IS NOT NULL
  `);
  console.log(`\n    Backfilled ${backfillResult.affectedRows} existing payment record(s) -> status: Paid`);

  console.log('\n  [001] Done.\n');
}

// ============================================================================
// DOWN — Roll back migration (removes all columns added above)
// ============================================================================
export async function down(connection) {
  console.log('\n  [001] Rolling back payments table expansion...\n');

  // Remove FK constraints first (they reference the columns we are about to drop)
  const constraints = ['fk_payments_guest_id', 'fk_payments_collected_by'];
  for (const constraint of constraints) {
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS cnt
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA    = DATABASE()
         AND TABLE_NAME      = 'payments'
         AND CONSTRAINT_NAME = ?`,
      [constraint]
    );
    if (rows[0].cnt > 0) {
      await connection.query(
        `ALTER TABLE \`payments\` DROP FOREIGN KEY \`${constraint}\``
      );
      console.log(`    - Dropped FK: ${constraint}`);
    }
  }

  // Drop all added columns in reverse order
  const columns = [
    'updated_at',
    'remarks',
    'payment_date',
    'collected_by',
    'transaction_id',
    'gateway_payment_id',
    'gateway_order_id',
    'payment_gateway',
    'payment_status',
    'currency',
    'guest_id',
  ];

  for (const col of columns) {
    await dropColumnIfPresent(connection, 'payments', col);
  }

  console.log('\n  [001] Rollback complete.\n');
}
