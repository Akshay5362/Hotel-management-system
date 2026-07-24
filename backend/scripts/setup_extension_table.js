import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'root',
  database: process.env.DB_NAME || 'hotel_pms',
  port: parseInt(process.env.DB_PORT || '3306', 10),
});

async function run() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`stay_extension_requests\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`booking_id\` INT NOT NULL,
        \`guest_id\` INT NOT NULL,
        \`room_id\` INT NOT NULL,
        \`current_checkout_date\` VARCHAR(20) NOT NULL,
        \`requested_checkout_date\` VARCHAR(20) NOT NULL,
        \`status\` VARCHAR(20) DEFAULT 'Pending',
        \`admin_id\` INT DEFAULT NULL,
        \`remarks\` TEXT,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\`(\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`guest_id\`) REFERENCES \`guests\`(\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`room_id\`) REFERENCES \`rooms\`(\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('stay_extension_requests table created or already exists.');
    process.exit(0);
  } catch (err) {
    console.error('Error creating table:', err);
    process.exit(1);
  }
}
run();
