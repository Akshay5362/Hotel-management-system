import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const host = process.env.DB_HOST || 'localhost';
const user = process.env.DB_USER || 'root';
const password = process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'root';
const dbName = process.env.DB_NAME || 'hotel_pms';
const port = parseInt(process.env.DB_PORT || '3306', 10);

async function addColumn(dbConn, table, columnDef) {
  try {
    await dbConn.query(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    console.log(`Added column ${columnDef.split(' ')[0]} to ${table}.`);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log(`Column ${columnDef.split(' ')[0]} already exists in ${table}.`);
    } else {
      throw err;
    }
  }
}

async function migrate() {
  const dbConn = await mysql.createConnection({ host, user, password, database: dbName, port });
  console.log(`Connected to database ${dbName}. Running housekeeping migration...`);

  try {
    // 1. Add columns to rooms table
    await addColumn(dbConn, 'rooms', "housekeeping_status VARCHAR(50) DEFAULT 'Clean'");
    await addColumn(dbConn, 'rooms', "housekeeping_assigned_to INT DEFAULT NULL");
    await addColumn(dbConn, 'rooms', "housekeeping_priority VARCHAR(20) DEFAULT 'Normal'");
    await addColumn(dbConn, 'rooms', "last_cleaned_at TIMESTAMP NULL DEFAULT NULL");

    // Add foreign key constraint if it doesn't exist
    try {
      await dbConn.query(`
        ALTER TABLE rooms 
        ADD CONSTRAINT fk_rooms_hk_assign 
        FOREIGN KEY (housekeeping_assigned_to) REFERENCES users(id) ON DELETE SET NULL
      `);
      console.log('Added foreign key for housekeeping_assigned_to.');
    } catch (fkErr) {
      if (fkErr.code === 'ER_DUP_KEYNAME') {
         console.log('Foreign key fk_rooms_hk_assign already exists.');
      } else {
         console.log('Foreign key fk_rooms_hk_assign error:', fkErr.message);
      }
    }

    // 2. Create housekeeping_logs table
    const createLogsQuery = `
      CREATE TABLE IF NOT EXISTS housekeeping_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_id INT NOT NULL,
        action VARCHAR(100) NOT NULL,
        performed_by INT DEFAULT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
    await dbConn.query(createLogsQuery);
    console.log('Created housekeeping_logs table.');

    // 3. Drop existing 'housekeeping' table if it was an unused legacy table to avoid confusion
    try {
      await dbConn.query('DROP TABLE IF EXISTS housekeeping');
      console.log('Dropped unused legacy housekeeping table.');
    } catch (dropErr) { }

    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await dbConn.end();
  }
}

migrate();
