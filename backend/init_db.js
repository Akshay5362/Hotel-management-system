/**
 * ⚠️  WARNING — DESTRUCTIVE OPERATION  ⚠️
 * ─────────────────────────────────────────────────────────────────────────────
 * This file DROPS and recreates the entire database from scratch.
 * Running it WILL DESTROY all existing data and migrations.
 *
 * DO NOT RUN THIS FILE UNLESS YOU INTEND TO RESET THE ENTIRE DATABASE.
 *
 * For schema changes, use the migration system instead:
 *   npm run migrate          -> apply all pending migrations
 *   npm run migrate:down     -> roll back the last migration
 *   npm run migrate:status   -> show migration status
 *
 * To run anyway (e.g. fresh dev environment), you MUST explicitly set:
 *   $env:FORCE_INIT_DB="yes"  (PowerShell)
 *   FORCE_INIT_DB=yes         (bash/cmd)
 * ─────────────────────────────────────────────────────────────────────────────
 */
if (process.env.FORCE_INIT_DB !== 'yes') {
  console.error('\n  BLOCKED: init_db.js requires FORCE_INIT_DB=yes to run.');
  console.error('  Use migration scripts instead: npm run migrate\n');
  process.exit(1);
}

import mysql from 'mysql2/promise';

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const host = process.env.DB_HOST || 'localhost';
const user = process.env.DB_USER || 'root';
const password = process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'root';
const dbName = process.env.DB_NAME || 'hotel_pms';
const port = parseInt(process.env.DB_PORT || '3306', 10);

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

const INITIAL_ROOM_TYPES = [
  { code: 'STANDARD', title: 'Standard Cozy Room', description: 'Experience coziness in our signature Standard Room. Designed with sleek modern decor, premium bedding, and a peaceful environment, it is the perfect sanctuary for solo travelers or couples.', base_rate: 1500, image: '🛏️' },
  { code: 'EXECUTIVE', title: 'Executive Work Room', description: 'Tailored for business leaders and discerning guests, the Executive Room offers a spacious layout, an integrated professional workstation, high-speed fiber connectivity, and sophisticated comfort.', base_rate: 2000, image: '💼' },
  { code: 'PREMIUM', title: 'Premium Suite Room', description: 'Indulge in ultimate refinement. Our Premium Suite is an expansive heaven featuring a private living lounge, scenic architecture, a deep soaking tub, and bespoke luxury amenities.', base_rate: 2500, image: '👑' }
];

// Room inventory: 17 rooms — 3 Premium, 10 Executive, 4 Standard
// Rooms 13, 15, 18 are intentionally excluded.
// Seed status: 5 occupied by active bookings (2, 3, 7, 10, 17), 1 dirty (20), 11 vacant
const INITIAL_ROOMS = [
  { number: '1', type: 'PREMIUM', status: 'vacant' },
  { number: '2', type: 'EXECUTIVE', status: 'occupied' },
  { number: '3', type: 'EXECUTIVE', status: 'occupied' },
  { number: '4', type: 'EXECUTIVE', status: 'vacant' },
  { number: '5', type: 'PREMIUM', status: 'vacant' },
  { number: '6', type: 'EXECUTIVE', status: 'vacant' },
  { number: '7', type: 'EXECUTIVE', status: 'occupied' },
  { number: '8', type: 'EXECUTIVE', status: 'vacant' },
  { number: '9', type: 'EXECUTIVE', status: 'vacant' },
  { number: '10', type: 'EXECUTIVE', status: 'occupied' },
  { number: '11', type: 'EXECUTIVE', status: 'vacant' },
  { number: '12', type: 'EXECUTIVE', status: 'vacant' },
  { number: '14', type: 'PREMIUM', status: 'vacant' },
  { number: '16', type: 'STANDARD', status: 'vacant' },
  { number: '17', type: 'STANDARD', status: 'occupied' },
  { number: '19', type: 'STANDARD', status: 'vacant' },
  { number: '20', type: 'STANDARD', status: 'dirty' },
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

  // Disable FK checks so tables can be dropped in any order
  await dbConn.query('SET FOREIGN_KEY_CHECKS = 0;');

  // Drop all known tables (base schema + migration-added tables)
  // Migration-added tables must appear here so re-initialization works cleanly
  const tablesToDrop = [
    // Migration 007: inventory
    'inventory_products',
    'inventory_categories',
    // Migration 008: outbox
    'firestore_outbox',
    // Migration 002: Razorpay
    'razorpay_transactions',
    'cash_submissions',
    // Migration 006: (billing instruction lives in bookings column — no new table)
    // Migration 005: reservations (also in base schema now)
    'checkout_snapshots',
    // Migration 003: staff
    'staff',
    // Audit / history
    'room_status_history',
    'booking_history',
    'maintenance',
    'housekeeping_logs',
    'housekeeping',
    // Transactional
    'stay_extension_requests',
    'feedback',
    'payments',
    'invoices',
    'ledger_items',
    'reservations',
    'cash_logs',
    'bookings',
    'guests',
    'rooms',
    'room_types',
    'role_permissions',
    'permissions',
    'audit_logs',
    'notifications',
    'users',
    'roles',
    'system_settings',
    'schema_migrations',
  ];
  for (const t of tablesToDrop) {
    await dbConn.query(`DROP TABLE IF EXISTS \`${t}\`;`);
  }

  await dbConn.query('SET FOREIGN_KEY_CHECKS = 1;');

  // 1. Roles Table
  await dbConn.query(`
    CREATE TABLE \`roles\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`name\` VARCHAR(50) UNIQUE NOT NULL,
      \`description\` VARCHAR(255) DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 2. Permissions Table
  await dbConn.query(`
    CREATE TABLE \`permissions\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`name\` VARCHAR(100) UNIQUE NOT NULL,
      \`description\` VARCHAR(255) DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 3. Role Permissions Table
  await dbConn.query(`
    CREATE TABLE \`role_permissions\` (
      \`role_id\` INT NOT NULL,
      \`permission_id\` INT NOT NULL,
      PRIMARY KEY (\`role_id\`, \`permission_id\`),
      FOREIGN KEY (\`role_id\`) REFERENCES \`roles\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`permission_id\`) REFERENCES \`permissions\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 4. Users Table
  await dbConn.query(`
    CREATE TABLE \`users\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`username\` VARCHAR(50) UNIQUE NOT NULL,
      \`password\` VARCHAR(255) NOT NULL,
      \`fullName\` VARCHAR(255) NOT NULL,
      \`phone\` VARCHAR(50) DEFAULT '',
      \`role_id\` INT DEFAULT NULL,
      FOREIGN KEY (\`role_id\`) REFERENCES \`roles\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 5. Guests Table
  await dbConn.query(`
    CREATE TABLE \`guests\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`full_name\` VARCHAR(255) NOT NULL,
      \`email\` VARCHAR(255) DEFAULT '',
      \`phone\` VARCHAR(50) DEFAULT '',
      \`address\` VARCHAR(255) DEFAULT '',
      \`gst_no\` VARCHAR(50) DEFAULT '',
      \`pincode\` VARCHAR(20) DEFAULT '',
      \`country\` VARCHAR(100) DEFAULT '',
      \`arrival_from\` VARCHAR(255) DEFAULT '',
      \`departure_to\` VARCHAR(255) DEFAULT '',
      \`government_id\` VARCHAR(50) DEFAULT '',
      \`id_type\` VARCHAR(50) DEFAULT '',
      \`gender\` VARCHAR(20) DEFAULT '',
      \`age\` INT DEFAULT NULL,
      \`id_document_path\` VARCHAR(255) DEFAULT NULL,
      \`id_upload_timestamp\` TIMESTAMP DEFAULT NULL,
      \`id_verification_status\` VARCHAR(50) DEFAULT 'Pending',
      \`id_rejection_reason\` VARCHAR(255) DEFAULT NULL,
      \`id_verified_by\` INT DEFAULT NULL,
      \`id_verified_at\` TIMESTAMP DEFAULT NULL,
      \`id_ocr_text\` TEXT DEFAULT NULL,
      \`user_id\` INT DEFAULT NULL,
      \`loyalty_tier\` VARCHAR(50) DEFAULT 'Bronze',
      \`loyalty_points\` INT DEFAULT 0,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 6. Room Types Table
  await dbConn.query(`
    CREATE TABLE \`room_types\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`code\` VARCHAR(20) UNIQUE NOT NULL,
      \`title\` VARCHAR(100) NOT NULL,
      \`description\` TEXT DEFAULT NULL,
      \`base_rate\` INT NOT NULL,
      \`image\` VARCHAR(10) DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 7. Rooms Table
  // NOTE: housekeeping_status/priority/assigned_to/last_cleaned_at are required
  // by roomStatusService.js, housekeepingController.js, checkOutService.js,
  // AvailabilityService.js, FactoryResetService.js and many other services.
  // Migration 009 adds these same columns to existing databases.
  await dbConn.query(`
    CREATE TABLE \`rooms\` (
      \`id\`                       INT AUTO_INCREMENT PRIMARY KEY,
      \`number\`                   VARCHAR(10) UNIQUE NOT NULL,
      \`room_type_id\`             INT NOT NULL,
      \`status\`                   VARCHAR(20) NOT NULL,
      \`housekeeping_status\`      VARCHAR(20) NOT NULL DEFAULT 'Clean',
      \`housekeeping_priority\`    VARCHAR(30) NOT NULL DEFAULT 'Normal',
      \`housekeeping_assigned_to\` INT DEFAULT NULL,
      \`last_cleaned_at\`          DATETIME DEFAULT NULL,
      FOREIGN KEY (\`room_type_id\`) REFERENCES \`room_types\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);


  // Add FK for housekeeping_assigned_to -> users (added separately since users is declared before rooms
  // but the constraint references both; safest to add as ALTER after both tables exist)
  await dbConn.query(`
    ALTER TABLE \`rooms\`
      ADD CONSTRAINT \`fk_rooms_hk_assigned_to\`
      FOREIGN KEY (\`housekeeping_assigned_to\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
  `);

  // 8. Bookings Table
  await dbConn.query(`
    CREATE TABLE \`bookings\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`booking_number\` VARCHAR(50) UNIQUE NOT NULL,
      \`guest_id\` INT NOT NULL,
      \`room_id\` INT NOT NULL,
      \`check_in_date\` VARCHAR(20) NOT NULL,
      \`check_out_date\` VARCHAR(20) DEFAULT '',
      \`expected_check_out_date\` VARCHAR(20) DEFAULT '',
      \`adults\` INT DEFAULT 1,
      \`children\` INT DEFAULT 0,
      \`booking_status\` VARCHAR(20) NOT NULL, -- 'Reserved', 'Checked In', 'Checked Out', 'Cancelled'
      \`payment_status\` VARCHAR(20) NOT NULL, -- 'Pending', 'Partial', 'Paid'
      \`total_amount\` INT DEFAULT 0,
      \`advance_amount\` INT DEFAULT 0,
      \`notes\` TEXT DEFAULT NULL,
      \`created_by\` INT DEFAULT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (\`guest_id\`) REFERENCES \`guests\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`room_id\`) REFERENCES \`rooms\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 8b. Reservations Table
  await dbConn.query(`
    CREATE TABLE \`reservations\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`reservation_number\` VARCHAR(50) UNIQUE NOT NULL,
      \`guest_name\` VARCHAR(255) NOT NULL,
      \`address\` TEXT DEFAULT NULL,
      \`phone\` VARCHAR(50) NOT NULL,
      \`email\` VARCHAR(255) DEFAULT '',
      \`nationality\` VARCHAR(100) DEFAULT 'Indian',
      \`state\` VARCHAR(100) DEFAULT '',
      \`company\` VARCHAR(255) DEFAULT '',
      \`purpose\` VARCHAR(255) DEFAULT '',
      \`arrival_date\` VARCHAR(20) NOT NULL,
      \`arrival_time\` VARCHAR(20) DEFAULT '12:00 PM',
      \`departure_date\` VARCHAR(20) NOT NULL,
      \`adults\` INT DEFAULT 1,
      \`children\` INT DEFAULT 0,
      \`room_type\` VARCHAR(50) NOT NULL DEFAULT 'STANDARD',
      \`room_id\` INT DEFAULT NULL,
      \`room_number\` VARCHAR(10) DEFAULT '',
      \`booking_source\` VARCHAR(100) DEFAULT 'Direct',
      \`booking_mode\` VARCHAR(100) DEFAULT 'Offline',
      \`booked_by\` VARCHAR(255) DEFAULT '',
      \`booked_by_contact\` VARCHAR(50) DEFAULT '',
      \`advance_payment\` INT DEFAULT 0,
      \`payment_mode\` VARCHAR(50) DEFAULT 'Cash',
      \`billing_instructions\` VARCHAR(255) DEFAULT '',
      \`transport_mode\` VARCHAR(100) DEFAULT 'Self',
      \`remarks\` TEXT DEFAULT NULL,
      \`status\` VARCHAR(20) DEFAULT 'Reserved',
      \`booking_id\` INT DEFAULT NULL,
      \`created_by\` INT DEFAULT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (\`room_id\`) REFERENCES \`rooms\`(\`id\`) ON DELETE SET NULL,
      FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\`(\`id\`) ON DELETE SET NULL,
      FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 9. Booking History Table
  await dbConn.query(`
    CREATE TABLE \`booking_history\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`booking_id\` INT NOT NULL,
      \`action\` VARCHAR(50) NOT NULL, -- 'CREATED', 'CHECKED_IN', 'SHIFTED', 'CHECKED_OUT', 'CANCELLED'
      \`old_room_id\` INT DEFAULT NULL,
      \`new_room_id\` INT DEFAULT NULL,
      \`changed_by\` INT DEFAULT NULL,
      \`business_date\` VARCHAR(20) NOT NULL,
      \`notes\` TEXT DEFAULT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`changed_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 9b. Checkout Snapshots Table (Phase 1 recovery infrastructure)
  await dbConn.query(`
    CREATE TABLE IF NOT EXISTS \`checkout_snapshots\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`booking_id\` INT NOT NULL,
      \`room_id\` INT NOT NULL,
      \`guest_id\` INT NOT NULL,
      \`invoice_id\` INT DEFAULT NULL,
      \`payment_id\` INT DEFAULT NULL,
      \`booking_snapshot\` JSON NOT NULL,
      \`room_snapshot\` JSON NOT NULL,
      \`invoice_snapshot\` JSON NOT NULL,
      \`ledger_snapshot\` JSON NOT NULL,
      \`payment_snapshot\` JSON NOT NULL,
      \`created_by\` INT DEFAULT NULL,
      \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`expires_at\` DATETIME NOT NULL,
      \`recovered_at\` DATETIME DEFAULT NULL,
      \`status\` ENUM('ACTIVE','RECOVERED','EXPIRED','VOIDED') NOT NULL DEFAULT 'ACTIVE',
      PRIMARY KEY (\`id\`),
      INDEX \`idx_cs_booking_id\` (\`booking_id\`),
      INDEX \`idx_cs_status\` (\`status\`),
      INDEX \`idx_cs_expires_at\` (\`expires_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 10. Ledger Items Table (Folio transactions)
  await dbConn.query(`
    CREATE TABLE \`ledger_items\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`room_number\` VARCHAR(10) NOT NULL,
      \`desc\` VARCHAR(255) NOT NULL,
      \`qty\` INT DEFAULT 1,
      \`amount\` INT NOT NULL,
      \`business_date\` VARCHAR(20) NOT NULL,
      \`booking_id\` INT DEFAULT NULL,
      \`status\` VARCHAR(20) DEFAULT 'Pending',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`room_number\`) REFERENCES \`rooms\`(\`number\`) ON DELETE CASCADE,
      FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);


  // 11. Payments Table
  await dbConn.query(`
    CREATE TABLE \`payments\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`booking_id\` INT DEFAULT NULL,
      \`amount\` INT NOT NULL,
      \`payment_method\` VARCHAR(50) DEFAULT 'Cash',
      \`payment_type\` VARCHAR(50) NOT NULL, -- 'Advance Deposit', 'Checkout Settlement', 'Checkout Refund'
      \`business_date\` VARCHAR(20) NOT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 12. Invoices Table
  await dbConn.query(`
    CREATE TABLE \`invoices\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`invoice_number\` VARCHAR(50) UNIQUE NOT NULL,
      \`booking_id\` INT NOT NULL,
      \`total_amount\` INT NOT NULL,
      \`paid_amount\` INT NOT NULL,
      \`balance_due\` INT NOT NULL,
      \`status\` VARCHAR(20) NOT NULL, -- 'Draft', 'Issued', 'Paid', 'Refunded'
      \`business_date\` VARCHAR(20) NOT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 13. Housekeeping Table
  await dbConn.query(`
    CREATE TABLE \`housekeeping\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`room_id\` INT NOT NULL,
      \`cleaned_by\` INT DEFAULT NULL,
      \`status\` VARCHAR(20) NOT NULL, -- 'Clean', 'Dirty', 'Cleaning'
      \`notes\` TEXT DEFAULT NULL,
      \`business_date\` VARCHAR(20) NOT NULL,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (\`room_id\`) REFERENCES \`rooms\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`cleaned_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 13b. Housekeeping Logs Table — event log of individual HK actions (assign, clean, inspect)
  // Referenced by: housekeepingController.js, FactoryResetService.js
  // NOTE: This is NOT the same as the 'housekeeping' table above.
  //   'housekeeping'      = daily status snapshot per business_date (used by business date system)
  //   'housekeeping_logs' = timestamped event log of who did what to which room
  // Migration 010 adds this table to existing databases.
  await dbConn.query(`
    CREATE TABLE \`housekeeping_logs\` (
      \`id\`           INT AUTO_INCREMENT PRIMARY KEY,
      \`room_id\`      INT NOT NULL,
      \`action\`       VARCHAR(100) NOT NULL,
      \`performed_by\` INT DEFAULT NULL,
      \`notes\`        TEXT DEFAULT NULL,
      \`created_at\`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`room_id\`)      REFERENCES \`rooms\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`performed_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 14. Maintenance Table

  await dbConn.query(`
    CREATE TABLE \`maintenance\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`room_id\` INT NOT NULL,
      \`reported_by\` INT DEFAULT NULL,
      \`assigned_to\` INT DEFAULT NULL,
      \`issue\` TEXT NOT NULL,
      \`status\` VARCHAR(20) NOT NULL, -- 'Pending', 'In Progress', 'Resolved', 'Cancelled'
      \`business_date\` VARCHAR(20) NOT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`room_id\`) REFERENCES \`rooms\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`reported_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL,
      FOREIGN KEY (\`assigned_to\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 15. Room Status History Table
  await dbConn.query(`
    CREATE TABLE \`room_status_history\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`room_id\` INT NOT NULL,
      \`old_status\` VARCHAR(20) NOT NULL,
      \`new_status\` VARCHAR(20) NOT NULL,
      \`changed_by\` INT DEFAULT NULL,
      \`business_date\` VARCHAR(20) NOT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`room_id\`) REFERENCES \`rooms\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`changed_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 16. Audit Logs Table
  await dbConn.query(`
    CREATE TABLE \`audit_logs\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`user_id\` INT DEFAULT NULL,
      \`action\` VARCHAR(100) NOT NULL,
      \`details\` TEXT DEFAULT NULL,
      \`business_date\` VARCHAR(20) NOT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 17. Notifications Table
  await dbConn.query(`
    CREATE TABLE \`notifications\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`user_id\` INT DEFAULT NULL,
      \`title\` VARCHAR(100) NOT NULL,
      \`message\` TEXT NOT NULL,
      \`is_read\` TINYINT(1) DEFAULT 0,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 18. Cash Logs Table
  await dbConn.query(`
    CREATE TABLE \`cash_logs\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`time\` VARCHAR(20) NOT NULL,
      \`room\` VARCHAR(10) NOT NULL,
      \`guest\` VARCHAR(255) NOT NULL,
      \`type\` VARCHAR(100) NOT NULL,
      \`amount\` INT NOT NULL,
      \`business_date\` VARCHAR(20) NOT NULL,
      \`booking_id\` INT DEFAULT NULL,
      FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\`(\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 19. System Settings Table
  await dbConn.query(`
    CREATE TABLE \`system_settings\` (
      \`key_name\` VARCHAR(50) PRIMARY KEY,
      \`value_val\` VARCHAR(100) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 20. Feedback Table (Post-checkout guest reviews)
  await dbConn.query(`
    CREATE TABLE \`feedback\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`booking_id\` INT NOT NULL,
      \`guest_id\` INT NOT NULL,
      \`overall_rating\` TINYINT NOT NULL,
      \`room_cleanliness\` TINYINT DEFAULT NULL,
      \`service_quality\` TINYINT DEFAULT NULL,
      \`value_for_money\` TINYINT DEFAULT NULL,
      \`comments\` TEXT DEFAULT NULL,
      \`would_recommend\` TINYINT(1) DEFAULT 1,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`guest_id\`) REFERENCES \`guests\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await dbConn.query(`
    CREATE TABLE \`stay_extension_requests\` (
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

  console.log('Tables created successfully. Seeding initial data...');

  // A. Seed Roles
  const [adminRoleRes] = await dbConn.query("INSERT INTO roles (name, description) VALUES ('admin', 'System Administrator with full access')");
  const [guestRoleRes] = await dbConn.query("INSERT INTO roles (name, description) VALUES ('guest', 'Standard Guest Customer account')");
  const adminRoleId = adminRoleRes.insertId;
  const guestRoleId = guestRoleRes.insertId;

  // B. Seed Permissions
  const permissionsList = ['view_dashboard', 'manage_rooms', 'manage_bookings', 'run_audit', 'make_payment'];
  const permIdsMap = {};
  for (const perm of permissionsList) {
    const [res] = await dbConn.query("INSERT INTO permissions (name, description) VALUES (?, ?)", [perm, `Grants permission to ${perm.replace('_', ' ')}`]);
    permIdsMap[perm] = res.insertId;
  }

  // C. Seed Role Permissions
  // Admin gets all
  for (const perm of permissionsList) {
    await dbConn.query("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)", [adminRoleId, permIdsMap[perm]]);
  }
  // Guest gets view_dashboard and make_payment
  await dbConn.query("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)", [guestRoleId, permIdsMap['view_dashboard']]);
  await dbConn.query("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)", [guestRoleId, permIdsMap['make_payment']]);

  // D. Populate system settings
  for (const setting of INITIAL_SYSTEM_SETTINGS) {
    await dbConn.query(
      `INSERT INTO \`system_settings\` (\`key_name\`, \`value_val\`) VALUES (?, ?);`,
      [setting.key_name, setting.value_val]
    );
  }

  // E. Populate initial users
  const adminPasswordHash = hashPassword('admin123');
  const kevalPasswordHash = hashPassword('keval123');
  const guestPasswordHash = hashPassword('guest123');

  const [adminUserRes] = await dbConn.query(
    `INSERT INTO \`users\` (\`username\`, \`password\`, \`fullName\`, \`phone\`, \`role_id\`) VALUES (?, ?, ?, ?, ?);`,
    ['admin', adminPasswordHash, 'ADMINISTRATOR', '', adminRoleId]
  );
  const adminUserId = adminUserRes.insertId;

  await dbConn.query(
    `INSERT INTO \`users\` (\`username\`, \`password\`, \`fullName\`, \`phone\`, \`role_id\`) VALUES (?, ?, ?, ?, ?);`,
    ['keval', kevalPasswordHash, 'KEVAL PATEL', '+91 9999999999', adminRoleId]
  );

  const [guestUserResult] = await dbConn.query(
    `INSERT INTO \`users\` (\`username\`, \`password\`, \`fullName\`, \`phone\`, \`role_id\`) VALUES (?, ?, ?, ?, ?);`,
    ['guest', guestPasswordHash, 'KATARI AKHILESH', '+91 9123456789', guestRoleId]
  );
  const guestUserId = guestUserResult.insertId;

  // F. Insert Room Types
  const roomTypesMap = {};
  for (const rt of INITIAL_ROOM_TYPES) {
    const [res] = await dbConn.query(
      "INSERT INTO room_types (code, title, description, base_rate, image) VALUES (?, ?, ?, ?, ?)",
      [rt.code, rt.title, rt.description, rt.base_rate, rt.image]
    );
    roomTypesMap[rt.code] = res.insertId;
  }

  // G. Insert Rooms
  const roomsMap = {};
  for (const r of INITIAL_ROOMS) {
    const typeId = roomTypesMap[r.type];
    const isDirty = r.status === 'dirty';
    const [res] = await dbConn.query(
      `INSERT INTO \`rooms\` (\`number\`, \`room_type_id\`, \`status\`, \`housekeeping_status\`, \`housekeeping_priority\`) VALUES (?, ?, ?, ?, ?);`,
      [r.number, typeId, r.status, isDirty ? 'Dirty' : 'Clean', isDirty ? 'High Priority' : 'Normal']
    );
    roomsMap[r.number] = res.insertId;

    // Seed initial housekeeping daily snapshot
    await dbConn.query(
      "INSERT INTO housekeeping (room_id, status, notes, business_date) VALUES (?, ?, ?, '11-Jul-2026')",
      [res.insertId, isDirty ? 'Dirty' : 'Clean', 'Initial startup state matches room status.']
    );

    // Seed initial housekeeping_logs event record (required by FactoryResetService re-seed pattern)
    await dbConn.query(
      "INSERT INTO housekeeping_logs (room_id, action, performed_by, notes) VALUES (?, 'Clean', NULL, 'Initial setup — room ready for check-in.')",
      [res.insertId]
    );
  }

  // H. Sample guests configuration
  // NOTE: The 'number' field here is a SEED LOOKUP KEY that must match an actual
  // room number from INITIAL_ROOMS (1-20). It is NOT an arbitrary identifier.
  // Rooms assigned: 2(EXECUTIVE), 3(EXECUTIVE), 7(EXECUTIVE), 10(EXECUTIVE), 17(STANDARD)
  const guestsToCreate = [
    { number: '2',  full_name: 'RAJVEER SINGH',   phone: '+91 9876543210', email: 'rajveer@gmail.com',   address: 'Delhi, India',     govId: '1234-5678-9012', idType: 'Aadhaar Card',   userId: null,        loyalty_tier: 'Bronze',   loyalty_points: 120  },
    { number: '3',  full_name: 'KATARI AKHILESH', phone: '+91 9123456789', email: 'akhilesh@gmail.com', address: 'Mumbai, India',    govId: 'A1234567',      idType: 'Passport',       userId: guestUserId, loyalty_tier: 'Gold',     loyalty_points: 1500 },
    { number: '7',  full_name: 'RAJESH',           phone: '+91 8888888888', email: 'rajesh@gmail.com',   address: 'Bangalore, India', govId: 'XY789012',      idType: 'Driver License', userId: null,        loyalty_tier: 'Silver',   loyalty_points: 450  },
    { number: '10', full_name: 'MR. NAVEEN SONI',  phone: '+91 7777777777', email: 'naveen@gmail.com',   address: 'Jaipur, India',    govId: '9988-7766-5544', idType: 'Aadhaar Card',  userId: null,        loyalty_tier: 'Platinum', loyalty_points: 3200 },
    { number: '17', full_name: 'RAGHUBEER',        phone: '+91 9999999999', email: 'raghubeer@gmail.com', address: 'Pune, India',     govId: 'ZZ554433',      idType: 'Voter ID',       userId: null,        loyalty_tier: 'Bronze',   loyalty_points: 0    }
  ];

  // Map to store inserted guest IDs
  const guestIdsMap = {};
  for (const g of guestsToCreate) {
    const [res] = await dbConn.query(
      `INSERT INTO \`guests\` (\`full_name\`, \`email\`, \`phone\`, \`address\`, \`government_id\`, \`id_type\`, \`user_id\`, \`loyalty_tier\`, \`loyalty_points\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [g.full_name, g.email, g.phone, g.address, g.govId, g.idType, g.userId, g.loyalty_tier, g.loyalty_points]
    );
    guestIdsMap[g.number] = res.insertId;
  }

  // I. Create Bookings, Invoices & corresponding Ledger Items / Cash Logs
  // IMPORTANT: 'number' must be a room number that exists in INITIAL_ROOMS.
  // Guests are linked by the same key. Room rates:
  //   STANDARD=1500, EXECUTIVE=2000, PREMIUM=2500
  const activeBookings = [
    {
      number: '2',         // Room 2 — EXECUTIVE (₹2000/night)
      check_in_date: '10-Jul-2026',
      adults: 2,
      advance_amount: 1000,
      total_amount: 2800,
      ledger: [
        { desc: 'Room Tariff Charge', qty: 1, amount: 2000, business_date: '10-Jul-2026' },
        { desc: 'Dining Charge',      qty: 1, amount: 500,  business_date: '10-Jul-2026' },
        { desc: 'Taxes & GST (10%)',  qty: 1, amount: 300,  business_date: '10-Jul-2026' }
      ],
      cash: [
        { time: '09:30 AM', type: 'Advance Deposit', amount: 1000, business_date: '11-Jul-2026' }
      ]
    },
    {
      number: '3',         // Room 3 — EXECUTIVE (₹2000/night)
      check_in_date: '09-Jul-2026',
      adults: 1,
      advance_amount: 2000,
      total_amount: 4720,
      ledger: [
        { desc: 'Room Tariff Charge (2 Nights)', qty: 2, amount: 4000, business_date: '09-Jul-2026' },
        { desc: 'Taxes & GST (5%)',              qty: 1, amount: 600,  business_date: '09-Jul-2026' },
        { desc: 'Room Service (Mineral Water)',  qty: 2, amount: 120,  business_date: '10-Jul-2026' }
      ],
      cash: []
    },
    {
      number: '7',         // Room 7 — EXECUTIVE (₹2000/night)
      check_in_date: '11-Jul-2026',
      adults: 1,
      advance_amount: 500,
      total_amount: 2300,
      ledger: [
        { desc: 'Room Tariff Charge', qty: 1, amount: 2000, business_date: '11-Jul-2026' },
        { desc: 'Taxes & GST (5%)',   qty: 1, amount: 300,  business_date: '11-Jul-2026' }
      ],
      cash: []
    },
    {
      number: '10',        // Room 10 — EXECUTIVE (₹2000/night)
      check_in_date: '10-Jul-2026',
      adults: 2,
      advance_amount: 1500,
      total_amount: 3280,
      ledger: [
        { desc: 'Room Tariff Charge',          qty: 1, amount: 2000, business_date: '10-Jul-2026' },
        { desc: 'Taxes & GST (5%)',            qty: 1, amount: 300,  business_date: '10-Jul-2026' },
        { desc: 'Restaurant Posting (Dinner)', qty: 1, amount: 980,  business_date: '10-Jul-2026' }
      ],
      cash: [
        { time: '10:45 AM', type: 'Advance Deposit', amount: 1500, business_date: '11-Jul-2026' }
      ]
    },
    {
      number: '17',        // Room 17 — STANDARD (₹1500/night)
      check_in_date: '11-Jul-2026',
      adults: 1,
      advance_amount: 1000,
      total_amount: 1680,
      ledger: [
        { desc: 'Room Tariff Charge', qty: 1, amount: 1500, business_date: '11-Jul-2026' },
        { desc: 'Taxes & GST (5%)',   qty: 1, amount: 180,  business_date: '11-Jul-2026' }
      ],
      cash: [
        { time: '11:15 AM', type: 'Advance Deposit', amount: 1000, business_date: '11-Jul-2026' }
      ]
    }
  ];

  // ── Pre-flight validation: every booking's room number MUST exist in INITIAL_ROOMS ──
  const missingRooms = activeBookings
    .filter(b => !roomsMap[b.number])
    .map(b => b.number);
  if (missingRooms.length > 0) {
    throw new Error(
      `Seed data error: the following booking room numbers do not exist in INITIAL_ROOMS: ` +
      `[${missingRooms.join(', ')}]. ` +
      `INITIAL_ROOMS contains: [${INITIAL_ROOMS.map(r => r.number).join(', ')}]`
    );
  }

  for (const b of activeBookings) {
    const bookingNumber = 'BKG-' + Math.floor(100000 + Math.random() * 900000);
    const guestId = guestIdsMap[b.number];
    const roomId  = roomsMap[b.number];

    if (!roomId) {
      throw new Error(`Seed data error: booking references room ${b.number}, but that room does not exist in INITIAL_ROOMS`);
    }
    if (!guestId) {
      throw new Error(`Seed data error: booking references guest key ${b.number}, but no guest was created with that key`);
    }

    const [bookingRes] = await dbConn.query(
      `INSERT INTO \`bookings\` (\`booking_number\`, \`guest_id\`, \`room_id\`, \`check_in_date\`, \`adults\`, \`booking_status\`, \`payment_status\`, \`total_amount\`, \`advance_amount\`, \`created_by\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [bookingNumber, guestId, roomId, b.check_in_date, b.adults, 'Checked In', 'Partial', b.total_amount, b.advance_amount, adminUserId]
    );
    const bookingId = bookingRes.insertId;

    // Ensure room is marked occupied in rooms table
    await dbConn.query("UPDATE `rooms` SET `status` = 'occupied' WHERE `id` = ?", [roomId]);

    // Create a Room Status History record for initial check-in (vacant -> occupied)
    await dbConn.query(
      `INSERT INTO \`room_status_history\` (\`room_id\`, \`old_status\`, \`new_status\`, \`changed_by\`, \`business_date\`)
       VALUES (?, 'vacant', 'occupied', ?, '11-Jul-2026')`,
      [roomId, adminUserId]
    );

    // Create a Booking History record
    await dbConn.query(
      `INSERT INTO \`booking_history\` (\`booking_id\`, \`action\`, \`new_room_id\`, \`changed_by\`, \`business_date\`)
       VALUES (?, 'CHECKED_IN', ?, ?, '11-Jul-2026')`,
      [bookingId, roomId, adminUserId]
    );

    // Create Invoice
    const invoiceNum = 'INV-' + Math.floor(100000 + Math.random() * 900000);
    await dbConn.query(
      `INSERT INTO \`invoices\` (\`invoice_number\`, \`booking_id\`, \`total_amount\`, \`paid_amount\`, \`balance_due\`, \`status\`, \`business_date\`)
       VALUES (?, ?, ?, ?, ?, 'Draft', '11-Jul-2026')`,
      [invoiceNum, bookingId, b.total_amount, b.advance_amount, b.total_amount - b.advance_amount]
    );

    // Insert Ledger Items
    for (const item of b.ledger) {
      await dbConn.query(
        `INSERT INTO \`ledger_items\` (\`room_number\`, \`desc\`, \`qty\`, \`amount\`, \`business_date\`, \`booking_id\`) VALUES (?, ?, ?, ?, ?, ?);`,
        [b.number, item.desc, item.qty || 1, item.amount, item.business_date, bookingId]
      );
    }

    // Insert Cash Logs & Payments
    for (const cash of b.cash) {
      await dbConn.query(
        `INSERT INTO \`cash_logs\` (\`time\`, \`room\`, \`guest\`, \`type\`, \`amount\`, \`business_date\`, \`booking_id\`)
         VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [cash.time, b.number, guestsToCreate.find(g => g.number === b.number).full_name, cash.type, cash.amount, cash.business_date, bookingId]
      );

      // Insert Payments entry
      await dbConn.query(
        `INSERT INTO \`payments\` (\`booking_id\`, \`amount\`, \`payment_method\`, \`payment_type\`, \`business_date\`)
         VALUES (?, ?, 'Cash', ?, ?)`,
        [bookingId, cash.amount, cash.type, cash.business_date]
      );
    }
  }

  // Insert general cash checkout logs (without booking association — represents a past-checkout settlement)
  // NOTE: room number must be a real room number (1-20). Room 5 = PREMIUM.
  const generalCashLogs = [
    { time: '12:05 PM', room: '5', guest: 'AMIT ROY', type: 'Checkout Settlement', amount: 2800, business_date: '11-Jul-2026' }
  ];
  for (const log of generalCashLogs) {
    await dbConn.query(
      `INSERT INTO \`cash_logs\` (\`time\`, \`room\`, \`guest\`, \`type\`, \`amount\`, \`business_date\`, \`booking_id\`)
       VALUES (?, ?, ?, ?, ?, ?, NULL);`,
      [log.time, log.room, log.guest, log.type, log.amount, log.business_date]
    );
  }

  // Create initial System Audit Logs for initialization
  await dbConn.query(
    `INSERT INTO \`audit_logs\` (\`user_id\`, \`action\`, \`details\`, \`business_date\`)
     VALUES (?, 'SYSTEM_INIT', 'Database schema loaded and seeded with core PMS records.', '11-Jul-2026')`,
    [adminUserId]
  );

  console.log('Database initialization and seeding completed successfully!');
  await dbConn.end();
}

initialize().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

