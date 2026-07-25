/**
 * Migration 005: Create Reservations Table
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates a dedicated `reservations` table for advance bookings/reservations.
 * This table operates independently from the active `bookings` table.
 * Creating/confirming a reservation does NOT alter the room status to occupied.
 */

export async function up(connection) {
  console.log('  Running migration 005_create_reservations_table: Creating reservations table...');

  await connection.query(`
    CREATE TABLE IF NOT EXISTS \`reservations\` (
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

  console.log('  ✓ Table `reservations` created successfully.');
}

export async function down(connection) {
  console.log('  Rolling back migration 005_create_reservations_table: Dropping reservations table...');
  await connection.query(`DROP TABLE IF EXISTS \`reservations\`;`);
  console.log('  ✓ Table `reservations` dropped.');
}
