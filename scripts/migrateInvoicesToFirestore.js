import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

const isCommit = process.argv.includes('--commit');

async function migrateInvoices() {
  console.log(`=== MIGRATING MYSQL INVOICES TO FIRESTORE [MODE: ${isCommit ? 'COMMIT' : 'DRY-RUN'}] ===\n`);

  try {
    const [rows] = await pool.query('SELECT * FROM invoices ORDER BY id ASC');
    console.log(`MySQL source record count: ${rows.length}`);

    let totalSum = 0;
    let taxSum = 0;
    let paidSum = 0;
    const documentsToInsert = [];

    for (const row of rows) {
      totalSum += Number(row.total_amount || 0);
      taxSum += Number(row.tax_amount || 0);
      paidSum += Number(row.paid_amount || 0);

      const docId = `invoice_${row.id}`;
      const docData = {
        mysql_invoice_id: row.id,
        invoice_number: row.invoice_number,
        invoice_type: row.invoice_type || 'standard',
        mysql_booking_id: row.booking_id,
        total_amount: Number(row.total_amount || 0),
        tax_amount: Number(row.tax_amount || 0),
        discount_amount: Number(row.discount_amount || 0),
        paid_amount: Number(row.paid_amount || 0),
        balance_due: Number(row.balance_due || 0),
        status: row.status,
        issued_at: row.issued_at ? new Date(row.issued_at).toISOString() : null,
        due_date: row.due_date || null,
        business_date: row.business_date,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
      };

      documentsToInsert.push({ docId, docData });
    }

    console.log(`Financial Totals Assertion:`);
    console.log(` - SUM(total_amount) : ₹${totalSum}`);
    console.log(` - SUM(tax_amount)   : ₹${taxSum}`);
    console.log(` - SUM(paid_amount)  : ₹${paidSum}`);
    console.log(`Expected Firestore Collection: /invoices (${documentsToInsert.length} documents)\n`);

    if (!isCommit) {
      console.log('DRY-RUN COMPLETE — Zero writes performed to Cloud Firestore.');
      process.exit(0);
    }

    console.log('Executing batched Firestore write operation...');
    const batch = db.batch();
    for (const { docId, docData } of documentsToInsert) {
      const ref = db.collection('invoices').doc(docId);
      batch.set(ref, docData, { merge: true });
    }
    await batch.commit();

    console.log(`Successfully committed ${documentsToInsert.length} /invoices documents to Cloud Firestore.`);
    process.exit(0);

  } catch (err) {
    console.error('Invoices migration error:', err.message);
    process.exit(1);
  }
}

migrateInvoices();
