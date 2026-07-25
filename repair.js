import pool from './backend/db.js';

async function repair() {
  console.log('Starting DB Repair...');
  const [reservations] = await pool.query("SELECT id, room_number FROM reservations WHERE room_id IS NULL AND room_number IS NOT NULL AND room_number != ''");
  let updated = 0;
  for (const res of reservations) {
    const [rooms] = await pool.query('SELECT id FROM rooms WHERE number = ?', [res.room_number]);
    if (rooms.length > 0) {
      await pool.query('UPDATE reservations SET room_id = ? WHERE id = ?', [rooms[0].id, res.id]);
      updated++;
      console.log('Fixed reservation ' + res.id + ', set room_id = ' + rooms[0].id);
    }
  }
  console.log('Repair complete. Fixed ' + updated + ' reservations.');
  process.exit(0);
}

repair().catch(console.error);
