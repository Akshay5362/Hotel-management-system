/**
 * Diagnostic: reproduce the PUT /api/rooms/:number/status 500 error
 * and capture the full Node.js stack trace.
 */
import pool from './db.js';
import { verifyToken } from './controllers/authController.js';
import { updateRoomStatus } from './controllers/roomController.js';

// --- minimal req/res mock ---
function makeMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data)   { this.body = data; return this; },
  };
  return res;
}

// --- get a real admin token from DB ---
const [adminRows] = await pool.query(`SELECT id FROM users LIMIT 1`);
const adminUser = adminRows[0];
console.log('Using admin user:', adminUser);

// simulate req.user for admin (non-staff)
const reqAdmin = {
  params: { number: '7' },
  body:   { action: 'mark_dirty' },
  user:   { id: adminUser.id, type: undefined },
};

// --- also test with a staff user ---
const [staffRows] = await pool.query(`SELECT id, role FROM staff LIMIT 1`);
const staffUser = staffRows[0];
console.log('Using staff user:', staffUser);

const reqStaff = {
  params: { number: '7' },
  body:   { action: 'mark_dirty' },
  user:   { id: staffUser.id, role: staffUser.role, type: 'staff' },
};

// --- Run for admin ---
console.log('\n====== TEST 1: Admin user ======');
try {
  const res = makeMockRes();
  await updateRoomStatus(reqAdmin, res);
  console.log('Admin result:', res.statusCode, JSON.stringify(res.body));
} catch (e) {
  console.error('Admin THREW:', e.message);
  console.error(e.stack);
}

// --- Run for staff ---
console.log('\n====== TEST 2: Staff user ======');
try {
  const res = makeMockRes();
  await updateRoomStatus(reqStaff, res);
  console.log('Staff result:', res.statusCode, JSON.stringify(res.body));
} catch (e) {
  console.error('Staff THREW:', e.message);
  console.error(e.stack);
}

await pool.end();
