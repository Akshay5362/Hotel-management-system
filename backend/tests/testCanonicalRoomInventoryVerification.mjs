import crypto from 'crypto';
import { listDocs } from '../repositories/firestore/firestoreUtils.js';

const JWT_SECRET = 'hotel-pms-super-secret-key-12345!';
function generateLegacyToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'staff' });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return base64Payload + '.' + signature;
}

const EXPECTED_CANONICAL = [
  { number: '1', type: 'PREMIUM', rate: 2500, doc_id: 'room_1' },
  { number: '2', type: 'EXECUTIVE', rate: 2000, doc_id: 'room_2' },
  { number: '3', type: 'EXECUTIVE', rate: 2000, doc_id: 'room_3' },
  { number: '4', type: 'EXECUTIVE', rate: 2000, doc_id: 'room_4' },
  { number: '5', type: 'PREMIUM', rate: 2500, doc_id: 'room_5' },
  { number: '6', type: 'EXECUTIVE', rate: 2000, doc_id: 'room_6' },
  { number: '7', type: 'EXECUTIVE', rate: 2000, doc_id: 'room_7' },
  { number: '8', type: 'EXECUTIVE', rate: 2000, doc_id: 'room_8' },
  { number: '9', type: 'EXECUTIVE', rate: 2000, doc_id: 'room_9' },
  { number: '10', type: 'EXECUTIVE', rate: 2000, doc_id: 'room_10' },
  { number: '11', type: 'EXECUTIVE', rate: 2000, doc_id: 'room_11' },
  { number: '12', type: 'EXECUTIVE', rate: 2000, doc_id: 'room_12' },
  { number: '14', type: 'PREMIUM', rate: 2500, doc_id: 'room_14' },
  { number: '16', type: 'STANDARD', rate: 1500, doc_id: 'room_16' },
  { number: '17', type: 'STANDARD', rate: 1500, doc_id: 'room_17' },
  { number: '19', type: 'STANDARD', rate: 1500, doc_id: 'room_19' },
  { number: '20', type: 'STANDARD', rate: 1500, doc_id: 'room_20' }
];

async function verifyCanonicalInventory() {
  console.log('============================================================');
  console.log('HPMS CANONICAL ROOM INVENTORY & STATUS VERIFICATION');
  console.log('============================================================');

  // 1. Direct Firestore Verification
  const fsRooms = await listDocs('rooms');
  console.log(`\n1. Direct Firestore /rooms Count: ${fsRooms.length} (Expected: 17)`);

  if (fsRooms.length !== 17) {
    console.error(`❌ Expected 17 rooms in Firestore, but found ${fsRooms.length}`);
    process.exit(1);
  }

  // 2. Live API /status Verification
  const token = generateLegacyToken({ id: 1, role: 'admin', type: 'staff' });
  const res = await fetch('http://127.0.0.1:5000/api/status', {
    headers: { Authorization: 'Bearer ' + token }
  });

  console.log(`\n2. Live GET /api/status HTTP Code: ${res.status}`);
  if (res.status !== 200) {
    console.error('❌ /api/status returned non-200 status');
    process.exit(1);
  }

  const data = await res.json();
  console.log(`   Data Status: ${data.data_status}`);
  console.log(`   Total Rooms in API Response: ${data.rooms?.length} (Expected: 17)`);

  const apiRooms = data.rooms || [];
  let allMatched = true;

  console.log('\n--- ROOM-BY-ROOM CANONICAL PARITY CHECK ---');
  EXPECTED_CANONICAL.forEach((exp, idx) => {
    const found = apiRooms.find(r => String(r.number) === exp.number);
    if (!found) {
      console.error(`❌ Room #${exp.number} missing from /api/status!`);
      allMatched = false;
      return;
    }

    const typeMatch = String(found.type).toUpperCase() === exp.type;
    const rateMatch = Number(found.rate) === exp.rate;
    const docIdMatch = found.doc_id === exp.doc_id;

    console.log(` - Room #${exp.number}: Type=${found.type} (Expected: ${exp.type}) | Rate=₹${found.rate} (Expected: ₹${exp.rate}) | Status=${found.status} | DocID=${found.doc_id}`);

    if (!typeMatch || !rateMatch || !docIdMatch) {
      console.error(`   ⚠️ Discrepancy on Room #${exp.number}: typeMatch=${typeMatch}, rateMatch=${rateMatch}, docIdMatch=${docIdMatch}`);
      allMatched = false;
    }
  });

  // Verify Non-canonical exclusions (13, 15, 18 must NOT be in API response)
  const nonCanonicalNumbers = ['13', '15', '18'];
  nonCanonicalNumbers.forEach(n => {
    const found = apiRooms.find(r => String(r.number) === n);
    if (found) {
      console.error(`❌ Non-canonical Room #${n} found in /api/status!`);
      allMatched = false;
    } else {
      console.log(` ✅ Confirmed: Non-canonical Room #${n} is absent from /api/status.`);
    }
  });

  // Verify Distribution (3 Premium, 10 Executive, 4 Standard)
  const premiumCount = apiRooms.filter(r => String(r.type).toUpperCase() === 'PREMIUM').length;
  const executiveCount = apiRooms.filter(r => String(r.type).toUpperCase() === 'EXECUTIVE').length;
  const standardCount = apiRooms.filter(r => String(r.type).toUpperCase() === 'STANDARD').length;

  console.log('\n--- ROOM TYPE DISTRIBUTION ---');
  console.log(` Premium: ${premiumCount} (Expected: 3 - Rooms 1, 5, 14)`);
  console.log(` Executive: ${executiveCount} (Expected: 10 - Rooms 2, 3, 4, 6, 7, 8, 9, 10, 11, 12)`);
  console.log(` Standard: ${standardCount} (Expected: 4 - Rooms 16, 17, 19, 20)`);

  if (premiumCount !== 3 || executiveCount !== 10 || standardCount !== 4) {
    console.error('❌ Room type distribution mismatch!');
    allMatched = false;
  }

  // 3. Health Check
  const healthRes = await fetch('http://127.0.0.1:5000/api/health');
  console.log(`\n3. Live GET /api/health HTTP Code: ${healthRes.status}`);

  if (allMatched && healthRes.status === 200) {
    console.log('\n============================================================');
    console.log('✅ ALL CANONICAL INVENTORY & WORKFLOW CHECKS PASSED (100%)');
    console.log('============================================================');
  } else {
    console.error('\n❌ VERIFICATION FAILED');
    process.exit(1);
  }
}

verifyCanonicalInventory();
