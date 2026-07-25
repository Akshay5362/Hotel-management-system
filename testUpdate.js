import pool from './backend/db.js';
import { updateReservation } from './backend/controllers/reservationController.js';

async function testUpdate() {
  console.log('Testing updateReservation healing...');
  const req = {
    params: { id: 4 },
    body: { roomNumber: '1', arrivalDate: '2026-07-25', departureDate: '2026-07-28' }
  };
  const res = {
    status: (code) => ({ json: (d) => console.log('STATUS ' + code, d) }),
    json: (d) => console.log('OK', d)
  };
  await pool.query('UPDATE reservations SET room_id = NULL WHERE id = 4'); // Corrupt it again
  await updateReservation(req, res);
  const [rows] = await pool.query('SELECT room_id FROM reservations WHERE id = 4');
  console.log('Healed room_id:', rows[0].room_id);
  process.exit(0);
}

testUpdate().catch(console.error);
