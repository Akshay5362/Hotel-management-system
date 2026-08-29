/**
 * backend/tests/auditRoomToRoomTypeRelationship.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT READ-ONLY AUDIT: ROOM TO ROOM TYPE RELATIONSHIPS
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';

const CANONICAL_ROOM_DOC_IDS = [
  'room_1', 'room_2', 'room_3', 'room_4', 'room_5', 'room_6', 'room_7', 'room_8',
  'room_9', 'room_10', 'room_11', 'room_12', 'room_14', 'room_16', 'room_17',
  'room_19', 'room_20'
];

async function inspectRoomTypeRelationships() {
  // 1. Fetch all room types
  const rtSnap = await db.collection('room_types').get();
  const roomTypes = [];
  rtSnap.forEach(d => {
    roomTypes.push({ id: d.id, ...d.data() });
  });

  // 2. Fetch all rooms
  const rooms = [];
  for (const docId of CANONICAL_ROOM_DOC_IDS) {
    const snap = await db.collection('rooms').doc(docId).get();
    if (snap.exists) {
      const data = snap.data();
      rooms.push({
        docId,
        number: data.number ?? data.room_number ?? data.roomNumber,
        type: data.type,
        room_type: data.room_type,
        roomType: data.roomType,
        room_type_id: data.room_type_id,
        roomTypeId: data.roomTypeId,
        room_type_code: data.room_type_code,
        room_type_title: data.room_type_title,
        mysql_room_type_id: data.mysql_room_type_id,
        mysql_id: data.mysql_id,
        price: data.price,
        base_rate: data.base_rate,
        rate: data.rate
      });
    } else {
      rooms.push({ docId, missing: true });
    }
  }

  console.log('=== ROOM TYPES ===');
  console.log(JSON.stringify(roomTypes, null, 2));

  console.log('\n=== ROOMS ===');
  console.log(JSON.stringify(rooms, null, 2));
}

inspectRoomTypeRelationships().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
