import crypto from 'crypto';

const JWT_SECRET = 'hotel-pms-super-secret-key-12345!';
function generateLegacyToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'staff' });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return base64Payload + '.' + signature;
}

async function testLiveStatus() {
  const token = generateLegacyToken({ id: 1, role: 'admin', type: 'staff' });
  const res = await fetch('http://localhost:5000/api/status', {
    headers: { Authorization: 'Bearer ' + token }
  });
  console.log('LIVE /api/status HTTP STATUS:', res.status);
  const data = await res.json();
  console.log('DATA STATUS:', data.data_status);
  console.log('TOTAL ROOMS IN RESPONSE:', data.rooms?.length);
  console.log('SYSTEM DATE:', data.systemDate);
  console.log('TODAY CHECKINS:', data.todayCheckins);
  console.log('SAMPLE ROOMS:');
  data.rooms?.slice(0, 5).forEach(r => {
    console.log(` - Room #${r.number} [${r.type}]: status=${r.status}, guestName=${r.guestName || '(none)'}`);
  });

  if (res.status === 200 && Array.isArray(data.rooms) && data.rooms.length > 0) {
    console.log('\n✅ /api/status VERIFICATION SUCCESSFUL: HTTP 200 with', data.rooms.length, 'rooms');
  } else {
    console.error('\n❌ /api/status FAILED:', res.status, data);
    process.exit(1);
  }
}
testLiveStatus();
