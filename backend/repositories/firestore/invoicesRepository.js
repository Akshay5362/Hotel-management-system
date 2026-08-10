import { db } from '../../config/firebaseAdmin.js';

export async function getAllInvoicesFirestore() {
  const snap = await db.collection('invoices').get();
  const invoices = [];
  snap.forEach(doc => {
    const d = doc.data();
    invoices.push({
      id: d.mysql_invoice_id || Number(doc.id.replace('invoice_', '')),
      invoice_number: d.invoice_number,
      invoice_type: d.invoice_type,
      booking_id: d.mysql_booking_id,
      total_amount: d.total_amount,
      tax_amount: d.tax_amount,
      discount_amount: d.discount_amount,
      paid_amount: d.paid_amount,
      balance_due: d.balance_due,
      status: d.status,
      issued_at: d.issued_at,
      due_date: d.due_date,
      business_date: d.business_date
    });
  });
  return invoices.sort((a, b) => a.id - b.id);
}
