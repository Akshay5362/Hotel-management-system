import pool from '../db.js';

const [rooms] = await pool.query('SELECT id, number, status, housekeeping_status FROM rooms WHERE number = ?', ['16']);
const room = rooms[0];
console.log('ROOM ROW:', JSON.stringify(room));

const [bookings] = await pool.query(
  `SELECT id, booking_status, payment_status, check_in_date,
          expected_check_out_date, check_out_date
   FROM bookings WHERE room_id = ? ORDER BY id DESC LIMIT 5`,
  [room.id]
);
console.log('\nBOOKINGS (newest first):');
bookings.forEach(b => console.log(JSON.stringify(b)));

const [sys] = await pool.query("SELECT value_val FROM system_settings WHERE key_name = 'system_date'");
console.log('\nSYSTEM DATE:', sys[0]?.value_val);

await pool.end();
