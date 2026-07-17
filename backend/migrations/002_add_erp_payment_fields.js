/**
 * Migration 002 - ERP-Grade Payment Fields
 * ---------------------------------------------------------------------------
 * Expands the payments and invoices tables to support production hotel ERP
 * requirements:
 *
 *  payments  (+7 columns):
 *    payment_source       - where the payment originated
 *    received_by          - staff who physically received the money
 *    created_by           - who created this record
 *    updated_by           - who last modified this record
 *    reference_payment_id - links refund rows back to their source payment
 *    split_group_id       - groups split-payment transactions (UUID)
 *    is_security_deposit  - flags security deposit rows
 *
 *  invoices  (+5 columns):
 *    invoice_type         - standard | proforma | receipt
 *    tax_amount           - total GST/tax captured on invoice
 *    discount_amount      - total discount applied
 *    issued_at            - when the invoice was formally issued
 *    due_date             - payment due date
 *
 *  Backfills (UPDATE only, no deletes):
 *    - Normalises payment_type to snake_case taxonomy
 *    - Sets payment_source based on booking origin
 *    - Sets invoice status from booking.payment_status
 *    - Recalculates invoice paid_amount and balance_due from actual payments
 *
 * BACKWARD COMPATIBILITY:
 *    All new columns have safe DEFAULT values.
 *    Every existing INSERT that omits the new columns continues to work.
 *
 * ROLLBACK (down):
 *    Drops only the columns and FK constraints added by this migration.
 *    Restores original payment_type free-text values.
 *    No table is dropped. No rows are deleted.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`    + Added column: ${table}.${column}`);
  } else {
    console.log(`    ~ Already exists, skipped: ${table}.${column}`);
  }
}

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
    await connection.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    console.log(`    - Dropped column: ${table}.${column}`);
  } else {
    console.log(`    ~ Already absent, skipped: ${table}.${column}`);
  }
}

async function addFKIfMissing(connection, table, constraintName, column, refTable, refColumn, onDelete) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA    = DATABASE()
       AND TABLE_NAME      = ?
       AND CONSTRAINT_NAME = ?`,
    [table, constraintName]
  );
  if (rows[0].cnt === 0) {
    await connection.query(`
      ALTER TABLE \`${table}\`
        ADD CONSTRAINT \`${constraintName}\`
        FOREIGN KEY (\`${column}\`) REFERENCES \`${refTable}\`(\`${refColumn}\`) ON DELETE ${onDelete}
    `);
    console.log(`    + Added FK: ${constraintName} (${table}.${column} -> ${refTable}.${refColumn})`);
  } else {
    console.log(`    ~ FK already exists, skipped: ${constraintName}`);
  }
}

async function dropFKIfPresent(connection, table, constraintName) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA    = DATABASE()
       AND TABLE_NAME      = ?
       AND CONSTRAINT_NAME = ?`,
    [table, constraintName]
  );
  if (rows[0].cnt > 0) {
    await connection.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${constraintName}\``);
    console.log(`    - Dropped FK: ${constraintName}`);
  }
}

// ---------------------------------------------------------------------------
// UP
// ---------------------------------------------------------------------------
export async function up(connection) {

  // ── PAYMENTS TABLE ────────────────────────────────────────────────────────
  console.log('\n  [002] Adding ERP columns to payments...\n');

  // 1. payment_source - where the payment originated
  //    Existing rows default to 'front_desk'; portal bookings backfilled below.
  await addColumnIfMissing(
    connection, 'payments', 'payment_source',
    "VARCHAR(50) NOT NULL DEFAULT 'front_desk' AFTER `payment_type`"
  );

  // 2. received_by - staff who physically received/processed the money
  //    Semantically the same as collected_by but with the correct ERP name.
  //    collected_by is kept for backward compatibility.
  await addColumnIfMissing(
    connection, 'payments', 'received_by',
    'INT DEFAULT NULL AFTER `collected_by`'
  );

  // 3. created_by - who created this payment record
  await addColumnIfMissing(
    connection, 'payments', 'created_by',
    'INT DEFAULT NULL AFTER `received_by`'
  );

  // 4. updated_by - who last modified this payment record
  await addColumnIfMissing(
    connection, 'payments', 'updated_by',
    'INT DEFAULT NULL AFTER `created_by`'
  );

  // 5. reference_payment_id - for refunds: points to the original payment
  await addColumnIfMissing(
    connection, 'payments', 'reference_payment_id',
    'INT DEFAULT NULL AFTER `booking_id`'
  );

  // 6. split_group_id - UUID that groups multiple split-payment rows together
  await addColumnIfMissing(
    connection, 'payments', 'split_group_id',
    'VARCHAR(50) DEFAULT NULL AFTER `reference_payment_id`'
  );

  // 7. is_security_deposit - flags whether this payment is a security deposit
  await addColumnIfMissing(
    connection, 'payments', 'is_security_deposit',
    "TINYINT(1) NOT NULL DEFAULT 0 AFTER `split_group_id`"
  );

  // ── PAYMENTS FOREIGN KEYS ─────────────────────────────────────────────────
  await addFKIfMissing(connection, 'payments', 'fk_payments_received_by',   'received_by',          'users',    'id', 'SET NULL');
  await addFKIfMissing(connection, 'payments', 'fk_payments_created_by',    'created_by',           'users',    'id', 'SET NULL');
  await addFKIfMissing(connection, 'payments', 'fk_payments_updated_by',    'updated_by',           'users',    'id', 'SET NULL');
  await addFKIfMissing(connection, 'payments', 'fk_payments_reference_id',  'reference_payment_id', 'payments', 'id', 'SET NULL');

  // ── INVOICES TABLE ────────────────────────────────────────────────────────
  console.log('\n  [002] Adding ERP columns to invoices...\n');

  // 1. invoice_type - classification of the invoice
  await addColumnIfMissing(
    connection, 'invoices', 'invoice_type',
    "VARCHAR(30) NOT NULL DEFAULT 'standard' AFTER `invoice_number`"
  );

  // 2. tax_amount - total GST/tax amount captured on the invoice
  await addColumnIfMissing(
    connection, 'invoices', 'tax_amount',
    'INT NOT NULL DEFAULT 0 AFTER `total_amount`'
  );

  // 3. discount_amount - total discount applied on the invoice
  await addColumnIfMissing(
    connection, 'invoices', 'discount_amount',
    'INT NOT NULL DEFAULT 0 AFTER `tax_amount`'
  );

  // 4. issued_at - when the invoice was formally issued to the guest
  await addColumnIfMissing(
    connection, 'invoices', 'issued_at',
    'DATETIME DEFAULT NULL AFTER `status`'
  );

  // 5. due_date - payment due date (matches expected_check_out_date in most cases)
  await addColumnIfMissing(
    connection, 'invoices', 'due_date',
    'VARCHAR(20) DEFAULT NULL AFTER `issued_at`'
  );

  // ── BACKFILL 1: Normalise payment_type values to snake_case taxonomy ──────
  //    Maps existing free-text values to standardised enum strings.
  //    Only UPDATEs rows whose current value matches the old format.
  //    Rows already in snake_case are left untouched.
  console.log('\n  [002] Backfilling payment_type to snake_case...\n');

  const typeMap = [
    ['Advance Deposit',      'advance_deposit'],
    ['Checkout Settlement',  'checkout_settlement'],
    ['Cancellation Refund',  'cancellation_refund'],
    ['Partial Payment',      'partial_payment'],
    ['Full Settlement',      'full_settlement'],
    ['Security Deposit',     'security_deposit'],
    ['Checkout Refund',      'cancellation_refund'],  // legacy alias
  ];

  let totalTypeUpdates = 0;
  for (const [oldVal, newVal] of typeMap) {
    const [res] = await connection.query(
      'UPDATE `payments` SET `payment_type` = ? WHERE `payment_type` = ?',
      [newVal, oldVal]
    );
    if (res.affectedRows > 0) {
      console.log(`    Normalised ${res.affectedRows} row(s): "${oldVal}" -> "${newVal}"`);
      totalTypeUpdates += res.affectedRows;
    }
  }
  console.log(`    Total payment_type rows normalised: ${totalTypeUpdates}`);

  // ── BACKFILL 2: Set payment_source based on booking origin ────────────────
  //    If the booking was created by a guest (created_by has a guest role),
  //    the payment source is 'guest_portal'; otherwise 'front_desk'.
  console.log('\n  [002] Backfilling payment_source...\n');

  // Guest portal payments: booking created by a user with role 'guest'
  const [guestSourceRes] = await connection.query(`
    UPDATE payments p
    INNER JOIN bookings b ON p.booking_id = b.id
    INNER JOIN users u    ON b.created_by = u.id
    INNER JOIN roles r    ON u.role_id    = r.id
    SET p.payment_source = 'guest_portal'
    WHERE r.name = 'guest'
      AND p.payment_source = 'front_desk'
  `);
  console.log(`    Set payment_source = 'guest_portal' for ${guestSourceRes.affectedRows} row(s)`);

  // ── BACKFILL 3: Populate received_by from collected_by ───────────────────
  //    received_by is the ERP-standard audit name for the same field.
  //    Populate from collected_by so existing data is not lost.
  const [rcvRes] = await connection.query(`
    UPDATE payments
    SET received_by = collected_by
    WHERE collected_by IS NOT NULL
      AND received_by IS NULL
  `);
  console.log(`    Populated received_by from collected_by for ${rcvRes.affectedRows} row(s)`);

  // ── BACKFILL 4: Sync invoice status from booking payment_status ───────────
  //    All invoices were 'Draft'. Promote to correct status based on the
  //    actual booking payment_status in the bookings table.
  console.log('\n  [002] Syncing invoice status from bookings...\n');

  const [invPaidRes] = await connection.query(`
    UPDATE invoices i
    INNER JOIN bookings b ON i.booking_id = b.id
    SET i.status = 'Paid'
    WHERE b.payment_status = 'Paid'
      AND i.status = 'Draft'
  `);
  console.log(`    Set invoice status = 'Paid' for ${invPaidRes.affectedRows} invoice(s)`);

  const [invPartialRes] = await connection.query(`
    UPDATE invoices i
    INNER JOIN bookings b ON i.booking_id = b.id
    SET i.status = 'Partially Paid'
    WHERE b.payment_status = 'Partial'
      AND i.status = 'Draft'
  `);
  console.log(`    Set invoice status = 'Partially Paid' for ${invPartialRes.affectedRows} invoice(s)`);

  const [invRefundRes] = await connection.query(`
    UPDATE invoices i
    INNER JOIN bookings b ON i.booking_id = b.id
    SET i.status = 'Refunded'
    WHERE b.payment_status = 'Refunded'
      AND i.status = 'Draft'
  `);
  console.log(`    Set invoice status = 'Refunded' for ${invRefundRes.affectedRows} invoice(s)`);

  // ── BACKFILL 5: Recalculate invoice paid_amount and balance_due ───────────
  //    Sums actual Paid/advance payment rows per booking.
  //    Excludes refunds from the positive paid total.
  const [invAmtRes] = await connection.query(`
    UPDATE invoices i
    INNER JOIN (
      SELECT
        booking_id,
        SUM(CASE
          WHEN payment_status = 'Paid'
           AND payment_type NOT IN ('cancellation_refund', 'partial_refund', 'full_refund', 'security_deposit_refund')
          THEN amount
          ELSE 0
        END) AS actual_paid
      FROM payments
      GROUP BY booking_id
    ) AS p ON p.booking_id = i.booking_id
    SET
      i.paid_amount = p.actual_paid,
      i.balance_due = GREATEST(0, i.total_amount - p.actual_paid)
  `);
  console.log(`    Recalculated paid_amount / balance_due for ${invAmtRes.affectedRows} invoice(s)`);

  console.log('\n  [002] Done.\n');
}

// ---------------------------------------------------------------------------
// DOWN - Rolls back everything added above. No tables dropped.
// ---------------------------------------------------------------------------
export async function down(connection) {
  console.log('\n  [002] Rolling back ERP payment fields...\n');

  // Drop payments FKs first
  const pmtFKs = [
    'fk_payments_received_by',
    'fk_payments_created_by',
    'fk_payments_updated_by',
    'fk_payments_reference_id',
  ];
  for (const fk of pmtFKs) {
    await dropFKIfPresent(connection, 'payments', fk);
  }

  // Drop payments columns (reverse order)
  const pmtCols = [
    'is_security_deposit',
    'split_group_id',
    'reference_payment_id',
    'updated_by',
    'created_by',
    'received_by',
    'payment_source',
  ];
  for (const col of pmtCols) {
    await dropColumnIfPresent(connection, 'payments', col);
  }

  // Drop invoices columns (reverse order)
  const invCols = ['due_date', 'issued_at', 'discount_amount', 'tax_amount', 'invoice_type'];
  for (const col of invCols) {
    await dropColumnIfPresent(connection, 'invoices', col);
  }

  // Restore original payment_type free-text values
  console.log('\n  [002] Restoring original payment_type free-text values...\n');
  const restoreMap = [
    ['advance_deposit',     'Advance Deposit'],
    ['checkout_settlement', 'Checkout Settlement'],
    ['cancellation_refund', 'Cancellation Refund'],
    ['partial_payment',     'Partial Payment'],
    ['full_settlement',     'Full Settlement'],
    ['security_deposit',    'Security Deposit'],
  ];
  for (const [newVal, oldVal] of restoreMap) {
    const [res] = await connection.query(
      'UPDATE `payments` SET `payment_type` = ? WHERE `payment_type` = ?',
      [oldVal, newVal]
    );
    if (res.affectedRows > 0) {
      console.log(`    Restored ${res.affectedRows} row(s): "${newVal}" -> "${oldVal}"`);
    }
  }

  // Reset invoice status back to Draft (conservative rollback)
  await connection.query("UPDATE invoices SET status = 'Draft' WHERE status IN ('Paid', 'Partially Paid', 'Refunded')");
  console.log('    Reset invoice statuses back to Draft');

  console.log('\n  [002] Rollback complete.\n');
}
