/**
 * Migration 005 - Create Cash Submissions and Razorpay Transactions Tables
 * ---------------------------------------------------------------------------
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
  // 1. Create Razorpay Transactions Table
  const razorpayExists = await tableExists(connection, 'razorpay_transactions');
  if (!razorpayExists) {
    await connection.query(`
      CREATE TABLE \`razorpay_transactions\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`order_id\` VARCHAR(100) NOT NULL,
        \`payment_id\` VARCHAR(100),
        \`signature\` VARCHAR(255),
        \`amount\` INT NOT NULL,
        \`status\` VARCHAR(20) NOT NULL,
        \`booking_id\` INT DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(\`order_id\`),
        FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\`(\`id\`) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('    + Created table: razorpay_transactions');
  } else {
    console.log('    ~ Table razorpay_transactions already exists, skipped.');
  }

  // 2. Create Cash Submissions Table
  const cashExists = await tableExists(connection, 'cash_submissions');
  if (!cashExists) {
    await connection.query(`
      CREATE TABLE \`cash_submissions\` (
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
    console.log('    + Created table: cash_submissions');
  } else {
    console.log('    ~ Table cash_submissions already exists, skipped.');
  }
}

export async function down(connection) {
  await connection.query(`DROP TABLE IF EXISTS \`razorpay_transactions\`;`);
  console.log('    - Dropped table: razorpay_transactions');
  
  await connection.query(`DROP TABLE IF EXISTS \`cash_submissions\`;`);
  console.log('    - Dropped table: cash_submissions');
}
