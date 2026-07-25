import pool from '../db.js';

export const getOrGenerateInvoiceNumber = async (req, res) => {
  const { bookingId } = req.params;
  
  if (!bookingId || isNaN(parseInt(bookingId))) {
    return res.status(400).json({ error: 'Valid Booking ID is required' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Check if invoice already exists
    const [existing] = await connection.query('SELECT invoice_number FROM invoices WHERE booking_id = ? LIMIT 1', [bookingId]);
    if (existing.length > 0) {
      await connection.rollback();
      connection.release();
      return res.json({ invoiceNumber: existing[0].invoice_number });
    }

    // 2. Generate new sequential invoice number
    const [latest] = await connection.query('SELECT invoice_number FROM invoices ORDER BY id DESC LIMIT 1 FOR UPDATE');
    let nextNum = 1;
    if (latest.length > 0) {
      const latestStr = latest[0].invoice_number;
      // Handle formats like INV-2026-000001 or INV-001
      const match = latestStr.match(/INV-(?:\d{4}-)?(\d+)/);
      if (match) {
        nextNum = parseInt(match[1], 10) + 1;
      }
    }

    const year = new Date().getFullYear();
    const invoiceNumber = `INV-${year}-${String(nextNum).padStart(6, '0')}`;

    // Get current business date
    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '25-Jul-2026';

    // 3. Create a draft invoice record to reserve the number
    // Fetch booking details to populate totals
    const [booking] = await connection.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    let totalAmount = 0;
    let paidAmount = 0;
    
    if (booking.length > 0) {
      totalAmount = booking[0].total_amount;
      paidAmount = booking[0].advance_amount;
    }

    const balanceDue = Math.max(0, totalAmount - paidAmount);

    await connection.query(
      `INSERT INTO invoices (invoice_number, booking_id, total_amount, paid_amount, balance_due, status, business_date)
       VALUES (?, ?, ?, ?, ?, 'Draft', ?)`,
      [invoiceNumber, bookingId, totalAmount, paidAmount, balanceDue, businessDate]
    );

    await connection.commit();
    connection.release();

    res.json({ invoiceNumber });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error('Error generating invoice number:', err);
    res.status(500).json({ error: 'Failed to generate invoice number' });
  }
};
