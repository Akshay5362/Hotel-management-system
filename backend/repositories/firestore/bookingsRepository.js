import { db } from '../../config/firebaseAdmin.js';

export async function getAllBookingsFirestore() {
  const snap = await db.collection('bookings').get();
  const bookings = [];
  snap.forEach(doc => {
    const d = doc.data();
    bookings.push({
      id: d.mysql_booking_id || Number(doc.id.replace('booking_', '')),
      booking_number: d.booking_number,
      guest_id: d.mysql_guest_id,
      room_id: d.mysql_room_id,
      check_in_date: d.check_in_date,
      check_out_date: d.check_out_date,
      expected_check_out_date: d.expected_check_out_date,
      adults: d.adults,
      children: d.children,
      booking_status: d.booking_status,
      payment_status: d.payment_status,
      total_amount: d.total_amount,
      advance_amount: d.advance_amount,
      notes: d.notes,
      billing_instruction: d.billing_instruction,
      meal_plan: d.meal_plan
    });
  });
  return bookings.sort((a, b) => a.id - b.id);
}
