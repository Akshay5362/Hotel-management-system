import pool from '../backend/db.js';
import bcrypt from '../backend/node_modules/bcryptjs/index.js';

const tests = ['Admin@5362', 'Akshu@5362', 'Admin123', 'Password@1', 'Sky@2024', 'Hotel@123', 'admin@5362', 'Admin@123', 'Sky5@admin', 'Webline@1', 'staff@123', 'Staff@123', 'Test@1234', 'Hpms@2024', 'Admin@2024', 'Hotel@2024', 'Sky5@2024', 'Recep@123', 'Admin@1234', 'hotel@sky5', 'Hotel@Sky5', 'HotelSky5', 'hotelsky5'];

const [rows] = await pool.query('SELECT id, full_name, email, username, password_hash FROM staff WHERE id IN (1,2) ORDER BY id');
for (const staff of rows) {
  console.log(`\n--- ${staff.full_name} (${staff.email}) ---`);
  for (const pw of tests) {
    const match = await bcrypt.compare(pw, staff.password_hash);
    if (match) console.log(`  MATCH: ${pw}`);
  }
}
process.exit(0);
