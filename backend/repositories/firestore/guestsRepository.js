import { db } from '../../config/firebaseAdmin.js';

export async function getAllGuestsFirestore() {
  const snap = await db.collection('guests').get();
  const guests = [];
  snap.forEach(doc => {
    const d = doc.data();
    guests.push({
      id: d.mysql_guest_id || Number(doc.id.replace('guest_', '')),
      user_id: d.mysql_user_id || null,
      full_name: d.full_name,
      email: d.email || null,
      phone: d.phone || null,
      user_uid: d.user_uid || null,
      loyalty_tier: d.loyalty_tier || 'Bronze',
      loyalty_points: d.loyalty_points || 0
    });
  });
  return guests.sort((a, b) => a.id - b.id);
}
