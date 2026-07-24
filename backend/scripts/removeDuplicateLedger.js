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
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function runCleanup() {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    console.log('--- Starting Duplicate Ledger Cleanup ---');

    // Find duplicates based on exact same booking, room, date, and description
    const [duplicates] = await connection.query(`
      SELECT 
        booking_id, 
        room_number, 
        business_date, 
        \`desc\`, 
        COUNT(*) as count,
        MIN(id) as keep_id
      FROM ledger_items 
      WHERE \`desc\` LIKE 'Room Tariff%Rollover%' OR \`desc\` LIKE 'Taxes & GST%'
      GROUP BY booking_id, room_number, business_date, \`desc\`
      HAVING count > 1
    `);

    if (duplicates.length === 0) {
      console.log('No duplicate rollover or tax entries found. Ledger is clean.');
      await connection.commit();
      process.exit(0);
    }

    let totalDeleted = 0;

    for (const dup of duplicates) {
      const { booking_id, room_number, business_date, desc, count, keep_id } = dup;
      console.log(`Found ${count} duplicate entries for Booking: ${booking_id}, Room: ${room_number}, Date: ${business_date}, Desc: "${desc}". Keeping ID: ${keep_id}.`);

      const [result] = await connection.query(`
        DELETE FROM ledger_items 
        WHERE booking_id = ? 
          AND room_number = ? 
          AND business_date = ? 
          AND \`desc\` = ? 
          AND id != ?
      `, [booking_id, room_number, business_date, desc, keep_id]);

      console.log(`Deleted ${result.affectedRows} duplicates.`);
      totalDeleted += result.affectedRows;
    }

    console.log(`\nCleanup complete. Safely removed ${totalDeleted} duplicate ledger entries.`);
    
    await connection.commit();
    process.exit(0);
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Failed to run cleanup:', error);
    process.exit(1);
  }
}

runCleanup();
