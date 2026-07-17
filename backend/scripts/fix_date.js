import pool from '../db.js';

const today = '17-Jul-2026';

try {
  await pool.query("UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'", [today]);
  const [rows] = await pool.query("SELECT key_name, value_val FROM system_settings WHERE key_name IN ('system_date','today_checkins','today_checkouts')");
  console.log('System date reset done:', rows);
} catch (e) {
  console.error('Error:', e.message);
} finally {
  process.exit(0);
}
