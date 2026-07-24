/**
 * seed_staff.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Seeds default staff accounts for Hotel Sky-5.
 *
 * Rules:
 *   - Uses INSERT IGNORE (no error if email/username already exists).
 *   - Checks existence by email before hashing, so bcrypt is skipped if the
 *     account is already there (avoids unnecessary CPU work on re-runs).
 *   - Passwords are hashed with bcrypt (12 rounds).
 *   - Safe to run multiple times — idempotent.
 *
 * NOTE: The staff table shift ENUM only supports 'Morning' | 'Night'.
 *       "Reception Evening" is therefore stored as shift='Night'.
 *
 * Run with:
 *   node seed_staff.js
 */

import pool from './db.js';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

const DEFAULT_STAFF = [
  {
    full_name:  'Admin',
    username:   'admin',
    email:      'admin@hotelsky5.com',
    password:   'Admin@123',
    role:       'ADMIN',
    department: 'Administration',
    shift:      'Morning',
    phone:      null,
    status:     'Active',
  },
  {
    full_name:  'Reception Morning',
    username:   'reception_morning',
    email:      'reception.morning@hotelsky5.com',
    password:   'Reception@123',
    role:       'RECEPTIONIST',
    department: 'Front Office',
    shift:      'Morning',
    phone:      null,
    status:     'Active',
  },
  {
    full_name:  'Reception Evening',
    username:   'reception_evening',
    email:      'reception.evening@hotelsky5.com',
    password:   'Reception@123',
    role:       'RECEPTIONIST',
    department: 'Front Office',
    shift:      'Night',   // ENUM has Morning/Night; Evening → Night
    phone:      null,
    status:     'Active',
  },
  {
    full_name:  'Reception Night',
    username:   'reception_night',
    email:      'reception.night@hotelsky5.com',
    password:   'Reception@123',
    role:       'RECEPTIONIST',
    department: 'Front Office',
    shift:      'Night',
    phone:      null,
    status:     'Active',
  },
  {
    full_name:  'Chef',
    username:   'chef',
    email:      'chef@hotelsky5.com',
    password:   'Kitchen@123',
    role:       'CHEF',
    department: 'Kitchen',
    shift:      'Morning',
    phone:      null,
    status:     'Active',
  },
  {
    full_name:  'Kitchen Helper',
    username:   'helper',
    email:      'helper@hotelsky5.com',
    password:   'Kitchen@123',
    role:       'KITCHEN_HELPER',
    department: 'Kitchen',
    shift:      'Morning',
    phone:      null,
    status:     'Active',
  },
  {
    full_name:  'Pantry Boy 1',
    username:   'pantry1',
    email:      'pantry1@hotelsky5.com',
    password:   'Pantry@123',
    role:       'PANTRY_BOY',
    department: 'Pantry',
    shift:      'Morning',
    phone:      null,
    status:     'Active',
  },
  {
    full_name:  'Pantry Boy 2',
    username:   'pantry2',
    email:      'pantry2@hotelsky5.com',
    password:   'Pantry@123',
    role:       'PANTRY_BOY',
    department: 'Pantry',
    shift:      'Night',
    phone:      null,
    status:     'Active',
  },
  {
    full_name:  'Cleaner 1',
    username:   'cleaner1',
    email:      'cleaner1@hotelsky5.com',
    password:   'House@123',
    role:       'CLEANER',
    department: 'Housekeeping',
    shift:      'Morning',
    phone:      null,
    status:     'Active',
  },
  {
    full_name:  'Cleaner 2',
    username:   'cleaner2',
    email:      'cleaner2@hotelsky5.com',
    password:   'House@123',
    role:       'CLEANER',
    department: 'Housekeeping',
    shift:      'Night',
    phone:      null,
    status:     'Active',
  },
];

async function seed() {
  console.log('\nHotel Sky-5 — Staff Seeder\n' + '─'.repeat(50));

  let created = 0;
  let skipped = 0;

  for (const member of DEFAULT_STAFF) {
    // Check by email first — cheapest unique key
    const [existing] = await pool.query(
      'SELECT id FROM staff WHERE email = ? OR username = ? LIMIT 1',
      [member.email, member.username]
    );

    if (existing.length > 0) {
      console.log(`  ~ SKIP  ${member.username.padEnd(20)} (already exists)`);
      skipped++;
      continue;
    }

    // Only hash when we actually need to insert
    const password_hash = await bcrypt.hash(member.password, BCRYPT_ROUNDS);

    await pool.query(
      `INSERT INTO staff
         (full_name, username, email, password_hash, role, department, shift, phone, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        member.full_name,
        member.username,
        member.email,
        password_hash,
        member.role,
        member.department,
        member.shift,
        member.phone,
        member.status,
      ]
    );

    console.log(`  + CREATE ${member.username.padEnd(20)} [${member.role}] ${member.department} / ${member.shift}`);
    created++;
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`  Created : ${created}`);
  console.log(`  Skipped : ${skipped} (already existed)`);
  console.log(`  Total   : ${DEFAULT_STAFF.length}\n`);

  process.exit(0);
}

seed().catch(err => {
  console.error('\nSeeder failed:', err.message);
  process.exit(1);
});
