import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const host = process.env.DB_HOST || 'localhost';
const user = process.env.DB_USER || 'root';
const password = process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'root';
const dbName = process.env.DB_NAME || 'hotel_pms';
const port = parseInt(process.env.DB_PORT || '3306', 10);

const INITIAL_ROOMS = [
  { number: '101', type: 'PREMIUM', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 3000, deposit: 0, checkInDate: '', ledger: [] },
  { number: '102', type: 'EXECUTIVE', status: 'occupied', guestName: 'RAJVEER SINGH', pax: 2, phone: '+91 9876543210', rate: 2500, deposit: 1000, checkInDate: '10-Jul-2026', ledger: [{ desc: 'Room Tariff Charge', qty: 1, amount: 2500 }, { desc: 'Taxes & GST (12%)', qty: 1, amount: 300 }] },
  { number: '103', type: 'EXECUTIVE', status: 'occupied', guestName: 'KATARI AKHILESH', pax: 1, phone: '+91 9123456789', rate: 2500, deposit: 2000, checkInDate: '09-Jul-2026', ledger: [{ desc: 'Room Tariff Charge (2 Nights)', qty: 2, amount: 5000 }, { desc: 'Taxes & GST (12%)', qty: 1, amount: 600 }, { desc: 'Room Service (Mineral Water)', qty: 2, amount: 120 }] },
  { number: '104', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', ledger: [] },
  { number: '105', type: 'PREMIUM', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 3000, deposit: 0, checkInDate: '', ledger: [] },
  { number: '106', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', ledger: [] },
  { number: '107', type: 'EXECUTIVE', status: 'occupied', guestName: 'RAJESH', pax: 1, phone: '+91 8888888888', rate: 2500, deposit: 500, checkInDate: '11-Jul-2026', ledger: [{ desc: 'Room Tariff Charge', qty: 1, amount: 2500 }, { desc: 'Taxes & GST (12%)', qty: 1, amount: 300 }] },
  { number: '108', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', ledger: [] },
  { number: '110', type: 'EXECUTIVE', status: 'occupied', guestName: 'MR. NAVEEN SONI', pax: 2, phone: '+91 7777777777', rate: 2500, deposit: 1500, checkInDate: '10-Jul-2026', ledger: [{ desc: 'Room Tariff Charge', qty: 1, amount: 2500 }, { desc: 'Taxes & GST (12%)', qty: 1, amount: 300 }, { desc: 'Restaurant Posting (Dinner)', qty: 1, amount: 480 }] },
  { number: '111', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', ledger: [] },
  { number: '112', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', ledger: [] },
  { number: '114', type: 'SUPER DELUXE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 3500, deposit: 0, checkInDate: '', ledger: [] },
  { number: '116', type: 'STANDARD', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 1500, deposit: 0, checkInDate: '', ledger: [] },
  { number: '117', type: 'STANDARD', status: 'occupied', guestName: 'RAGHUBEER', pax: 1, phone: '+91 9999999999', rate: 1500, deposit: 1000, checkInDate: '11-Jul-2026', ledger: [{ desc: 'Room Tariff Charge', qty: 1, amount: 1500 }, { desc: 'Taxes & GST (12%)', qty: 1, amount: 180 }] },
  { number: '119', type: 'STANDARD', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 1500, deposit: 0, checkInDate: '', ledger: [] },
  { number: '120', type: 'STANDARD', status: 'dirty', guestName: '', pax: 0, phone: '', rate: 1500, deposit: 0, checkInDate: '', ledger: [] }
];

const INITIAL_CASH_LOGS = [
  { time: '09:30 AM', room: '102', guest: 'RAJVEER SINGH', type: 'Advance Deposit', amount: 1000, business_date: '11-Jul-2026' },
  { time: '10:45 AM', room: '110', guest: 'MR. NAVEEN SONI', type: 'Advance Deposit', amount: 1500, business_date: '11-Jul-2026' },
  { time: '11:15 AM', room: '117', guest: 'RAGHUBEER', type: 'Advance Deposit', amount: 1000, business_date: '11-Jul-2026' },
  { time: '12:05 PM', room: '105', guest: 'AMIT ROY', type: 'Checkout Settlement', amount: 2800, business_date: '11-Jul-2026' }
];

const INITIAL_SYSTEM_SETTINGS = [
  { key_name: 'system_date', value_val: '11-Jul-2026' },
  { key_name: 'today_checkins', value_val: '2' },
  { key_name: 'today_checkouts', value_val: '4' },
  { key_name: 'continued_rooms', value_val: '3' }
];

async function initialize() {
  console.log(`Connecting to MySQL server at ${host}:${port}...`);
  const conn = await mysql.createConnection({ host, user, password, port });

  console.log(`Creating database ${dbName} if not exists...`);
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
  await conn.end();

  // Connect to the specific database
  const dbConn = await mysql.createConnection({ host, user, password, database: dbName, port });
  console.log(`Connected to database ${dbName}. Initializing tables...`);

  // Drop tables if exist to start fresh and clean
  await dbConn.query(`DROP TABLE IF EXISTS \`ledger_items\`;`);
  await dbConn.query(`DROP TABLE IF EXISTS \`cash_logs\`;`);
  await dbConn.query(`DROP TABLE IF EXISTS \`rooms\`;`);
  await dbConn.query(`DROP TABLE IF EXISTS \`system_settings\`;`);

  // Create tables
  await dbConn.query(`
    CREATE TABLE \`rooms\` (
      \`number\` VARCHAR(10) PRIMARY KEY,
      \`type\` VARCHAR(50) NOT NULL,
      \`status\` VARCHAR(20) NOT NULL,
      \`rate\` INT NOT NULL,
      \`guestName\` VARCHAR(255) DEFAULT '',
      \`phone\` VARCHAR(50) DEFAULT '',
      \`pax\` INT DEFAULT 0,
      \`deposit\` INT DEFAULT 0,
      \`checkInDate\` VARCHAR(20) DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await dbConn.query(`
    CREATE TABLE \`ledger_items\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`room_number\` VARCHAR(10) NOT NULL,
      \`desc\` VARCHAR(255) NOT NULL,
      \`qty\` INT DEFAULT 1,
      \`amount\` INT NOT NULL,
      FOREIGN KEY (\`room_number\`) REFERENCES \`rooms\`(\`number\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await dbConn.query(`
    CREATE TABLE \`cash_logs\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`time\` VARCHAR(20) NOT NULL,
      \`room\` VARCHAR(10) NOT NULL,
      \`guest\` VARCHAR(255) NOT NULL,
      \`type\` VARCHAR(100) NOT NULL,
      \`amount\` INT NOT NULL,
      \`business_date\` VARCHAR(20) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await dbConn.query(`
    CREATE TABLE \`system_settings\` (
      \`key_name\` VARCHAR(50) PRIMARY KEY,
      \`value_val\` VARCHAR(100) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('Tables created. Populating initial data...');

  // Populate system settings
  for (const setting of INITIAL_SYSTEM_SETTINGS) {
    await dbConn.query(
      `INSERT INTO \`system_settings\` (\`key_name\`, \`value_val\`) VALUES (?, ?);`,
      [setting.key_name, setting.value_val]
    );
  }

  // Populate rooms & ledger
  for (const room of INITIAL_ROOMS) {
    await dbConn.query(
      `INSERT INTO \`rooms\` (\`number\`, \`type\`, \`status\`, \`rate\`, \`guestName\`, \`phone\`, \`pax\`, \`deposit\`, \`checkInDate\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [room.number, room.type, room.status, room.rate, room.guestName, room.phone, room.pax, room.deposit, room.checkInDate]
    );

    for (const item of room.ledger) {
      await dbConn.query(
        `INSERT INTO \`ledger_items\` (\`room_number\`, \`desc\`, \`qty\`, \`amount\`) VALUES (?, ?, ?, ?);`,
        [room.number, item.desc, item.qty || 1, item.amount]
      );
    }
  }

  // Populate cash logs
  for (const log of INITIAL_CASH_LOGS) {
    await dbConn.query(
      `INSERT INTO \`cash_logs\` (\`time\`, \`room\`, \`guest\`, \`type\`, \`amount\`, \`business_date\`)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [log.time, log.room, log.guest, log.type, log.amount, log.business_date]
    );
  }

  console.log('Database initialization and seeding completed successfully!');
  await dbConn.end();
}

initialize().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
