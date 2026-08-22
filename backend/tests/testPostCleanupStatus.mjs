import crypto from 'crypto';
import { listDocs } from '../repositories/firestore/firestoreUtils.js';

const JWT_SECRET = 'hotel-pms-super-secret-key-12345!';
function generateLegacyToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'staff' });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return base64Payload + '.' + signature;
}

async function validate() {
  console.log('=== 1. FIRESTORE DATABASE VALIDATION ===');
  const rooms = await listDocs('rooms');
  console.log(`Total Rooms in Firestore: ${rooms.length} (Expected: 17)`);

  const bookings = await listDocs('bookings');
  console.log(`Total Bookings in Firestore: ${bookings.length}`);

  const activeBookings = bookings.filter(b => b.booking_status === 'Checked In');
  console.log(`Active Checked In Bookings: ${activeBookings.length} (Expected: 3)`);
  activeBookings.forEach(b => {
    console.log(` - Booking ID: ${b.id} | Guest: ${b.guest_name} | Room: ${b.room_number || b.room_id}`);
  });

  console.log('\n=== 2. LIVE /api/status ENDPOINT VALIDATION ===');
  const token = generateLegacyToken({ id: 1, role: 'admin', type: 'staff' });
  const res = await fetch('http://localhost:5000/api/status', {
    headers: { Authorization: 'Bearer ' + token }
  });

  console.log('HTTP Status:', res.status);
  const data = await res.json();
  console.log('Data Status:', data.data_status);
  console.log('Total Rooms in Status:', data.rooms?.length);

  const occupied = data.rooms?.filter(r => r.status === 'occupied') || [];
  const vacant = data.rooms?.filter(r => r.status === 'vacant') || [];
  const dirty = data.rooms?.filter(r => r.status === 'dirty') || [];
  const inactive = data.rooms?.filter(r => r.status === 'inactive') || [];

  console.log(`Occupied Rooms (${occupied.length}):`, occupied.map(r => `#${r.number} (${r.guestName})`).join(', '));
  console.log(`Vacant Rooms (${vacant.length}):`, vacant.map(r => `#${r.number}`).join(', '));
  console.log(`Dirty Rooms (${dirty.length}):`, dirty.map(r => `#${r.number}`).join(', '));
  console.log(`Inactive Rooms (${inactive.length}):`, inactive.map(r => `#${r.number}`).join(', '));

  console.log('\nALL 17 ROOMS STATUS:');
  data.rooms?.forEach(r => {
    console.log(` - Room #${r.number} [${r.type}]: status=${r.status}, housekeeping=${r.housekeeping_status}, guest=${r.guestName || '(none)'}`);
  });

  const passed = (
    rooms.length === 17 &&
    data.rooms?.length === 17 &&
    occupied.length === 3 &&
    vacant.length === 14 &&
    occupied.some(r => String(r.number) === '1' && r.guestName === 'KEVAL') &&
    occupied.some(r => String(r.number) === '2' && r.guestName === 'ANKITA') &&
    occupied.some(r => String(r.number) === '3' && r.guestName === 'AKSHIT')
  );

  if (passed) {
    console.log('\n✅ POST-CLEANUP VALIDATION 100% SUCCESSFUL: Exactly 17 rooms (3 occupied, 14 vacant).');
  } else {
    console.error('\n❌ POST-CLEANUP VALIDATION FAILED');
    process.exit(1);
  }
}

validate();
