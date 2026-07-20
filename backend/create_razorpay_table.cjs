const mysql = require('mysql2/promise');

async function createTable() {
  const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'Akshu@5362',
    database: 'hotel_pms',
    port: 3306,
  });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`razorpay_transactions\` (
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
    console.log("Created razorpay_transactions table successfully.");
  } catch (error) {
    console.error("Failed to create table:", error);
  } finally {
    if (connection) connection.release();
    process.exit(0);
  }
}

createTable();
