import { db } from '../../config/firebaseAdmin.js';

export async function getAllRoomsFirestore() {
  const snap = await db.collection('rooms').get();
  const rooms = [];
  snap.forEach(doc => {
    const d = doc.data();
    rooms.push({
      id: d.mysql_room_id || Number(doc.id.replace('room_', '')),
      number: d.number,
      type: d.type,
      status: d.status,
      cleaning_status: d.cleaning_status,
      room_type_id: d.mysql_room_type_id,
      housekeeping_assigned_to: d.housekeeping_assigned_to || null,
      price: d.price || 0,
      amenities: d.amenities || []
    });
  });
  return rooms.sort((a, b) => a.id - b.id);
}

export async function getRoomByIdFirestore(id) {
  const docSnap = await db.collection('rooms').doc(`room_${id}`).get();
  if (!docSnap.exists) return null;
  const d = docSnap.data();
  return {
    id: d.mysql_room_id || id,
    number: d.number,
    type: d.type,
    status: d.status,
    cleaning_status: d.cleaning_status,
    room_type_id: d.mysql_room_type_id,
    housekeeping_assigned_to: d.housekeeping_assigned_to || null,
    price: d.price || 0,
    amenities: d.amenities || []
  };
}
