/**
 * backend/tests/auditCanonicalRoomActiveField.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT READ-ONLY AUDIT: CANONICAL ROOM ACTIVE FIELD
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';

const CANONICAL_ROOM_DOC_IDS = [
  'room_1', 'room_2', 'room_3', 'room_4', 'room_5', 'room_6', 'room_7', 'room_8',
  'room_9', 'room_10', 'room_11', 'room_12', 'room_14', 'room_16', 'room_17',
  'room_19', 'room_20'
];

async function inspectRooms() {
  const rooms = [];
  for (const docId of CANONICAL_ROOM_DOC_IDS) {
    const snap = await db.collection('rooms').doc(docId).get();
    if (snap.exists) {
      const data = snap.data();
      const activeRaw = data.active;
      const isActiveRaw = data.is_active;

      rooms.push({
        docId,
        roomNumber: data.number ?? data.room_number ?? data.roomNumber ?? docId.replace(/^room_/, ''),
        activeVal: activeRaw,
        activeType: activeRaw === undefined ? 'undefined' : typeof activeRaw,
        isActiveVal: isActiveRaw,
        isActiveType: isActiveRaw === undefined ? 'undefined' : typeof isActiveRaw,
        status: data.status ?? data.occupancy_status ?? 'N/A',
        hkStatus: data.housekeeping_status ?? 'N/A',
        roomType: data.type ?? data.room_type ?? data.roomType ?? 'N/A',
        rawKeys: Object.keys(data).sort()
      });
    } else {
      rooms.push({ docId, missing: true });
    }
  }

  console.log(JSON.stringify(rooms, null, 2));
}

inspectRooms().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
