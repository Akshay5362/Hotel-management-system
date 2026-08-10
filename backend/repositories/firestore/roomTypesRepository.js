import { db } from '../../config/firebaseAdmin.js';

export async function getAllRoomTypesFirestore() {
  const snap = await db.collection('room_types').get();
  const roomTypes = [];
  snap.forEach(doc => {
    const d = doc.data();
    roomTypes.push({
      id: d.mysql_room_type_id || Number(doc.id.replace('room_type_', '')),
      name: d.name,
      base_price: d.base_price,
      max_occupancy: d.max_occupancy,
      description: d.description || ''
    });
  });
  return roomTypes.sort((a, b) => a.id - b.id);
}
