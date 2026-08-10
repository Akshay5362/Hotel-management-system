import { db } from '../../config/firebaseAdmin.js';

export async function getAllLedgerItemsFirestore() {
  const snap = await db.collection('ledger_items').get();
  const ledgerItems = [];
  snap.forEach(doc => {
    const d = doc.data();
    ledgerItems.push({
      id: d.mysql_ledger_id || Number(doc.id.replace('ledger_', '')),
      booking_id: d.mysql_booking_id,
      room_number: d.room_number,
      desc: d.description,
      qty: d.qty,
      amount: d.amount,
      status: d.status,
      business_date: d.business_date
    });
  });
  return ledgerItems.sort((a, b) => a.id - b.id);
}
