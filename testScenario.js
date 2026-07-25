import pool from './backend/db.js';
import { getStatus } from './backend/controllers/auditController.js';
async function test() {
  await pool.query("DELETE FROM reservations WHERE room_number IN ('19', '20')");
  await pool.query("INSERT INTO reservations (reservation_number, guest_name, phone, arrival_date, departure_date, room_number, room_id, status) VALUES ('RES-T-1', 'Test 1', '111', '2026-07-27', '2026-07-30', '19', 15, 'Reserved')");
  await pool.query("INSERT INTO reservations (reservation_number, guest_name, phone, arrival_date, departure_date, room_number, room_id, status) VALUES ('RES-T-2', 'Test 2', '222', '2026-07-27', '2026-07-30', '20', 16, 'Reserved')");
  
  const req = {};
  const res = {
    status: (c) => ({ json: (d) => console.log('STATUS', c, d) }),
    json: (d) => {
      console.log('SYSTEM DATE:', d.systemDate);
      const r15 = d.rooms.find(r => r.id === 15);
      const r16 = d.rooms.find(r => r.id === 16);
      console.log('Room 19 (id 15):', r15.status);
      console.log('Room 20 (id 16):', r16.status);
    }
  };
  await getStatus(req, res);
  await pool.query("DELETE FROM reservations WHERE reservation_number IN ('RES-T-1', 'RES-T-2')");
  process.exit(0);
}
test().catch(console.error);
