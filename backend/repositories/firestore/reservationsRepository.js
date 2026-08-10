import { db } from '../../config/firebaseAdmin.js';

export async function getAllReservationsFirestore() {
  const snap = await db.collection('reservations').get();
  const reservations = [];
  snap.forEach(doc => {
    const d = doc.data();
    reservations.push({
      id: d.mysql_reservation_id || Number(doc.id.replace('reservation_', '')),
      reservation_number: d.reservation_number,
      guest_name: d.guest_name,
      email: d.email,
      phone: d.phone,
      room_id: d.mysql_room_id,
      booking_id: d.mysql_booking_id,
      check_in_date: d.check_in_date,
      check_out_date: d.check_out_date,
      status: d.status,
      notes: d.notes
    });
  });
  return reservations.sort((a, b) => a.id - b.id);
}
