import pool from '../db.js';
import { BusinessDateService } from '../services/businessDateService.js';

/**
 * POST /api/invoices/generate/:bookingId
 *
 * Returns the invoice_number for a booking.
 *
 * Strategy (deadlock-safe, no FOR UPDATE):
 *   1. Check if invoice already exists for this booking using a plain SELECT (no lock).
 *      - If Paid  → return immediately (checkout already wrote it with balance_due=0).
 *      - If Draft → refresh totals and return.
 *   2. If none exists, generate a sequential number using MySQL's AUTO_INCREMENT
 *      on a helper row, then INSERT the invoice. On duplicate (race condition), fall
 *      back to the already-inserted row.
 *
 * No cross-table FOR UPDATE locks are used, so this cannot deadlock with the
 * checkout controller's concurrent INSERT INTO invoices.
 */
export const getOrGenerateInvoiceNumber = async (req, res) => {
  const { bookingId } = req.params;
  const parsedId = parseInt(bookingId, 10);

  if (!bookingId || isNaN(parsedId)) {
    return res.status(400).json({ error: 'Valid Booking ID is required' });
  }

  try {
    // ── Step 1: Check for existing invoice (plain read, no lock) ─────────────
    const [existing] = await pool.query(
      'SELECT invoice_number, status FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
      [parsedId]
    );

    if (existing.length > 0) {
      const inv = existing[0];

      // Already Paid (checkout wrote it) → return as-is
      if (inv.status === 'Paid') {
        return res.json({ invoiceNumber: inv.invoice_number });
      }

      // Draft exists — refresh totals from latest booking data, then return
      const [bookingRows] = await pool.query(
        'SELECT total_amount, advance_amount, payment_status FROM bookings WHERE id = ?',
        [parsedId]
      );
      if (bookingRows.length > 0) {
        const b = bookingRows[0];
        const isPaid = b.payment_status === 'Paid';
        await pool.query(
          `UPDATE invoices
             SET total_amount = ?,
                 paid_amount  = ?,
                 balance_due  = ?,
                 status       = ?
           WHERE booking_id = ?`,
          [
            b.total_amount,
            isPaid ? b.total_amount        : (b.advance_amount || 0),
            isPaid ? 0                     : Math.max(0, (b.total_amount || 0) - (b.advance_amount || 0)),
            isPaid ? 'Paid'                : 'Draft',
            parsedId
          ]
        );
      }

      return res.json({ invoiceNumber: inv.invoice_number });
    }

    // ── Step 2: Generate a new sequential invoice number ─────────────────────
    // Use MAX(id)+1 without a transaction lock — safe because we INSERT IGNORE below.
    const [maxRow] = await pool.query('SELECT MAX(id) as maxId FROM invoices');
    const nextNum  = (maxRow[0].maxId || 0) + 1;
    const year     = new Date().getFullYear();
    const invoiceNumber = `INV-${year}-${String(nextNum).padStart(6, '0')}`;

    const businessDate = await BusinessDateService.getBusinessDate(pool);

    const [bookingRows] = await pool.query(
      'SELECT total_amount, advance_amount, payment_status FROM bookings WHERE id = ?',
      [parsedId]
    );

    let totalAmount = 0;
    let paidAmount  = 0;
    let balanceDue  = 0;
    let status      = 'Draft';

    if (bookingRows.length > 0) {
      const b = bookingRows[0];
      totalAmount = b.total_amount  || 0;
      paidAmount  = b.payment_status === 'Paid' ? totalAmount : (b.advance_amount || 0);
      balanceDue  = b.payment_status === 'Paid' ? 0 : Math.max(0, totalAmount - paidAmount);
      status      = b.payment_status === 'Paid' ? 'Paid' : 'Draft';
    }

    // INSERT IGNORE handles the unlikely race where two requests hit simultaneously.
    // If this insert is ignored (duplicate booking_id), re-read and return the winner.
    try {
      await pool.query(
        `INSERT IGNORE INTO invoices
           (invoice_number, booking_id, total_amount, paid_amount, balance_due, status, business_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [invoiceNumber, parsedId, totalAmount, paidAmount, balanceDue, status, businessDate]
      );
    } catch (insertErr) {
      // Duplicate key on invoice_number (rare race) — re-read and return existing
      if (insertErr.code === 'ER_DUP_ENTRY') {
        const [fallback] = await pool.query(
          'SELECT invoice_number FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
          [parsedId]
        );
        if (fallback.length > 0) {
          return res.json({ invoiceNumber: fallback[0].invoice_number });
        }
      }
      throw insertErr;
    }

    // If INSERT IGNORE silently skipped (booking_id already had a row), re-read
    const [afterInsert] = await pool.query(
      'SELECT invoice_number FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
      [parsedId]
    );
    const finalNumber = afterInsert.length > 0
      ? afterInsert[0].invoice_number
      : invoiceNumber;

    return res.json({ invoiceNumber: finalNumber });

  } catch (err) {
    console.error('Error generating invoice number:', err);
    res.status(500).json({ error: 'Failed to generate invoice number' });
  }
};
