import { db } from '../../config/firebaseAdmin.js';

export async function getAllPaymentsFirestore() {
  const snap = await db.collection('payments').get();
  const payments = [];
  snap.forEach(doc => {
    const d = doc.data();
    payments.push({
      id: d.mysql_payment_id || Number(doc.id.replace('payment_', '')),
      booking_id: d.mysql_booking_id,
      guest_id: d.mysql_guest_id,
      amount: d.amount,
      currency: d.currency,
      payment_method: d.payment_method,
      payment_status: d.payment_status,
      payment_type: d.payment_type,
      payment_source: d.payment_source,
      payment_gateway: d.payment_gateway,
      transaction_id: d.transaction_id
    });
  });
  return payments.sort((a, b) => a.id - b.id);
}
