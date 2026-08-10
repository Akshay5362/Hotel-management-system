import { db } from '../../config/firebaseAdmin.js';

export async function getAllBookingHistoryFirestore() {
  const snap = await db.collection('booking_history').get();
  const history = [];
  snap.forEach(doc => {
    const d = doc.data();
    history.push({
      id: d.mysql_history_id || Number(doc.id.replace('history_', '')),
      booking_id: d.mysql_booking_id,
      action: d.action,
      details: d.details,
      changed_by: d.mysql_changed_by,
      business_date: d.business_date,
      created_at: d.created_at
    });
  });
  return history.sort((a, b) => a.id - b.id);
}
