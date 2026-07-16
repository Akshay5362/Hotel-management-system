import pool from './db.js';
async function test() {
  const [u] = await pool.query('SELECT id, username FROM users WHERE username = "harsh"');
  if (u.length === 0) { console.log('no user harsh'); process.exit(0); }
  const [b] = await pool.query('SELECT b.booking_status, b.room_id, r.status as room_status, r.number, g.user_id FROM bookings b JOIN guests g ON b.guest_id = g.id JOIN rooms r ON b.room_id = r.id WHERE g.user_id = ?', [u[0].id]);
  console.log('User:', u, 'Bookings/Rooms:', b);
  process.exit(0);
}
test();
