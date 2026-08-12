/**
 * scripts/resetReceptionPassword.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses the application's existing Admin staff-management API to reset the
 * password for reception.morning@hotelsky5.com (Staff ID 2).
 *
 * This script does NOT touch raw SQL password hashes.
 * Password is accepted from the RECEPTION_TEMP_PASSWORD environment variable.
 * Do NOT hardcode or commit credentials.
 *
 * Usage:
 *   $env:RECEPTION_TEMP_PASSWORD = "YourTempPass@123"
 *   node scripts/resetReceptionPassword.js
 */

// Uses globalThis.fetch (native in Node 18+).

const BACKEND = 'http://localhost:5000/api';
const ADMIN_EMAIL = 'admin@hotelsky5.com';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'Admin@123';
const TARGET_STAFF_ID = 2;
const NEW_PASSWORD = process.env.RECEPTION_TEMP_PASSWORD;

if (!NEW_PASSWORD) {
  console.error('ERROR: Set RECEPTION_TEMP_PASSWORD environment variable before running.');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'ngrok-skip-browser-warning': 'true'
};

// Step 1: Admin login
const loginRes = await fetch(`${BACKEND}/staff/auth/login`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS })
});
const loginData = await loginRes.json();
if (!loginData.token) {
  console.error('Admin login FAILED:', JSON.stringify(loginData));
  process.exit(1);
}
const token = loginData.token;
console.log('Admin login OK. Token acquired.');

// Step 2: Fetch current reception staff record (to preserve all existing fields)
const getRes = await fetch(`${BACKEND}/staff/${TARGET_STAFF_ID}`, {
  headers: { ...headers, Authorization: `Bearer ${token}` }
});
const getData = await getRes.json();
if (!getData.staff) {
  console.error('Staff record fetch FAILED:', JSON.stringify(getData));
  process.exit(1);
}
const current = getData.staff;
console.log(`Fetched staff record: ${current.full_name} (${current.email}), Role: ${current.role}`);

// Step 3: PUT with password — application bcrypt-hashes it automatically
const updateBody = {
  full_name: current.full_name,
  username:  current.username,
  email:     current.email,
  role:      current.role,
  department: current.department,
  shift:     current.shift,
  phone:     current.phone || null,
  status:    current.status,
  password:  NEW_PASSWORD           // application will bcrypt hash this
};

const updateRes = await fetch(`${BACKEND}/staff/${TARGET_STAFF_ID}`, {
  method: 'PUT',
  headers: { ...headers, Authorization: `Bearer ${token}` },
  body: JSON.stringify(updateBody)
});
const updateData = await updateRes.json();

if (updateRes.status !== 200 || !updateData.staff) {
  console.error('Password reset FAILED:', JSON.stringify(updateData));
  process.exit(1);
}
console.log('Password reset OK:', updateData.message);
console.log('Updated staff:', JSON.stringify(updateData.staff, null, 2));

// Step 4: Verify new password works by logging in
const verifyRes = await fetch(`${BACKEND}/staff/auth/login`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ email: current.email, password: NEW_PASSWORD })
});
const verifyData = await verifyRes.json();

if (verifyRes.status === 200 && verifyData.token) {
  console.log('\n✅ RECEPTION LOGIN VERIFIED:');
  console.log(`   HTTP Status : 200`);
  console.log(`   Message     : ${verifyData.message}`);
  console.log(`   Staff ID    : ${verifyData.staff.id}`);
  console.log(`   Full Name   : ${verifyData.staff.name}`);
  console.log(`   Role        : ${verifyData.staff.role}`);
  console.log(`   Department  : ${verifyData.staff.department}`);
  console.log(`   JWT Issued  : YES`);
  process.exit(0);
} else {
  console.error('\n❌ RECEPTION LOGIN VERIFICATION FAILED:', JSON.stringify(verifyData));
  process.exit(1);
}
