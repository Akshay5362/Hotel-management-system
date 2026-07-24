import pool from './db.js';
import bcrypt from 'bcryptjs';

async function updatePasswords() {
  const updates = [
    { username: 'chef', pass: 'chef123' },
    { username: 'reception_morning', pass: 'recep123' },
    { username: 'pantry1', pass: 'pantry123' },
    { username: 'cleaner1', pass: 'clean123' }
  ];

  for (const u of updates) {
    const hash = await bcrypt.hash(u.pass, 12);
    await pool.query('UPDATE staff SET password_hash = ? WHERE username = ?', [hash, u.username]);
    console.log(`Updated ${u.username} to ${u.pass}`);
  }
  process.exit(0);
}

updatePasswords().catch(console.error);
