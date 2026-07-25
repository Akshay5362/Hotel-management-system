import pool from './backend/db.js';
async function test() {
  const [rows] = await pool.query('SELECT value_val FROM system_settings WHERE key_name = "system_date"');
  console.log(rows[0]);
  process.exit(0);
}
test().catch(console.error);
