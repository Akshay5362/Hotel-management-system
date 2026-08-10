import { db } from '../../config/firebaseAdmin.js';

export async function getAllCashLogsFirestore() {
  const snap = await db.collection('cash_logs').get();
  const cashLogs = [];
  snap.forEach(doc => {
    const d = doc.data();
    cashLogs.push({
      id: d.mysql_cash_id || Number(doc.id.replace('cash_', '')),
      time: d.time,
      room: d.room,
      guest: d.guest,
      type: d.type,
      amount: d.amount,
      business_date: d.business_date,
      booking_id: d.mysql_booking_id
    });
  });
  return cashLogs.sort((a, b) => a.id - b.id);
}
