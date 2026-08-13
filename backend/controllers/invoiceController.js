import pool from '../db.js';
import { BusinessDateService } from '../services/businessDateService.js';
import { enqueue } from '../services/outboxService.js';
import { isFirestoreDualWriteEnabled } from '../config/featureFlags.js';
import { formatBookingId } from '../services/compoundEventBuilder.js';

/**
 * POST /api/invoices/generate/:bookingId
 *
 * Returns the invoice_number for a booking.
 *
 * Strategy:
 *   1. Check if invoice already exists for this booking.
 *      - If Paid → return immediately.
 *      - If Draft → refresh totals from latest booking data.
 *   2. If none exists, generate sequential number and INSERT.
 *   3. Enqueue INVOICE_CREATED outbox event using the SAME transaction connection
 *      BEFORE commit when isFirestoreDualWriteEnabled() is true.
 */
export const getOrGenerateInvoiceNumber = async (req, res) => {
  const { bookingId } = req.params;
  const parsedId = parseInt(bookingId, 10);

  if (!bookingId || isNaN(parsedId)) {
    return res.status(400).json({ error: 'Valid Booking ID is required' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── Step 1: Check for existing invoice ─────────────
    const [existing] = await connection.query(
      'SELECT id, invoice_number, status, total_amount, paid_amount, balance_due, business_date FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
      [parsedId]
    );

    if (existing.length > 0) {
      const inv = existing[0];

      // Already Paid (checkout wrote it) → return as-is
      if (inv.status === 'Paid') {
        await connection.commit();
        return res.json({ invoiceNumber: inv.invoice_number });
      }

      // Draft exists — refresh totals from latest booking data, then return
      const [bookingRows] = await connection.query(
        'SELECT booking_number, total_amount, advance_amount, payment_status FROM bookings WHERE id = ?',
        [parsedId]
      );

      let finalTotal = inv.total_amount;
      let finalPaid = inv.paid_amount;
      let finalBalance = inv.balance_due;
      let finalStatus = inv.status;
      let bookingNum = null;

      if (bookingRows.length > 0) {
        const b = bookingRows[0];
        bookingNum = b.booking_number;
        const isPaid = b.payment_status === 'Paid';
        finalTotal = b.total_amount || 0;
        finalPaid = isPaid ? finalTotal : (b.advance_amount || 0);
        finalBalance = isPaid ? 0 : Math.max(0, finalTotal - finalPaid);
        finalStatus = isPaid ? 'Paid' : 'Draft';

        await connection.query(
          `UPDATE invoices
             SET total_amount = ?,
                 paid_amount  = ?,
                 balance_due  = ?,
                 status       = ?
           WHERE booking_id = ?`,
          [finalTotal, finalPaid, finalBalance, finalStatus, parsedId]
        );
      }

      if (isFirestoreDualWriteEnabled()) {
        const eventOccurredAt = new Date().toISOString();
        await enqueue(connection, {
          event_type: 'INVOICE_CREATED',
          aggregate_type: 'INVOICE',
          aggregate_id: inv.invoice_number,
          payload: {
            invoice_number: inv.invoice_number,
            booking_id: bookingNum ? formatBookingId(bookingNum) : `bkg_${parsedId}`,
            mysql_booking_id: parsedId,
            total_amount: finalTotal,
            paid_amount: finalPaid,
            balance_due: finalBalance,
            outstanding_amount: finalBalance,
            status: finalStatus,
            invoice_status: finalStatus,
            business_date: inv.business_date,
            mysql_invoice_id: inv.id,
            created_at: eventOccurredAt,
            updated_at: eventOccurredAt
          }
        });
      }

      await connection.commit();
      return res.json({ invoiceNumber: inv.invoice_number });
    }

    // ── Step 2: Generate a new sequential invoice number ─────────────────────
    const [maxRow] = await connection.query('SELECT MAX(id) as maxId FROM invoices');
    const nextNum  = (maxRow[0].maxId || 0) + 1;
    const year     = new Date().getFullYear();
    const invoiceNumber = `INV-${year}-${String(nextNum).padStart(6, '0')}`;

    const businessDate = await BusinessDateService.getBusinessDate(connection);

    const [bookingRows] = await connection.query(
      'SELECT booking_number, total_amount, advance_amount, payment_status FROM bookings WHERE id = ?',
      [parsedId]
    );

    let totalAmount = 0;
    let paidAmount  = 0;
    let balanceDue  = 0;
    let status      = 'Draft';
    let bookingNum  = null;

    if (bookingRows.length > 0) {
      const b = bookingRows[0];
      bookingNum  = b.booking_number;
      totalAmount = b.total_amount  || 0;
      paidAmount  = b.payment_status === 'Paid' ? totalAmount : (b.advance_amount || 0);
      balanceDue  = b.payment_status === 'Paid' ? 0 : Math.max(0, totalAmount - paidAmount);
      status      = b.payment_status === 'Paid' ? 'Paid' : 'Draft';
    }

    let mysqlInvoiceId = null;
    try {
      const [insertResult] = await connection.query(
        `INSERT IGNORE INTO invoices
           (invoice_number, booking_id, total_amount, paid_amount, balance_due, status, business_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [invoiceNumber, parsedId, totalAmount, paidAmount, balanceDue, status, businessDate]
      );
      mysqlInvoiceId = insertResult.insertId;
    } catch (insertErr) {
      if (insertErr.code === 'ER_DUP_ENTRY') {
        const [fallback] = await connection.query(
          'SELECT id, invoice_number FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
          [parsedId]
        );
        if (fallback.length > 0) {
          await connection.commit();
          return res.json({ invoiceNumber: fallback[0].invoice_number });
        }
      }
      throw insertErr;
    }

    const [afterInsert] = await connection.query(
      'SELECT id, invoice_number FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
      [parsedId]
    );
    const finalNumber = afterInsert.length > 0 ? afterInsert[0].invoice_number : invoiceNumber;
    const finalMysqlId = afterInsert.length > 0 ? afterInsert[0].id : mysqlInvoiceId;

    if (isFirestoreDualWriteEnabled()) {
      const eventOccurredAt = new Date().toISOString();
      await enqueue(connection, {
        event_type: 'INVOICE_CREATED',
        aggregate_type: 'INVOICE',
        aggregate_id: finalNumber,
        payload: {
          invoice_number: finalNumber,
          booking_id: bookingNum ? formatBookingId(bookingNum) : `bkg_${parsedId}`,
          mysql_booking_id: parsedId,
          total_amount: totalAmount,
          paid_amount: paidAmount,
          balance_due: balanceDue,
          outstanding_amount: balanceDue,
          status: status,
          invoice_status: status,
          business_date: businessDate,
          mysql_invoice_id: finalMysqlId,
          created_at: eventOccurredAt,
          updated_at: eventOccurredAt
        }
      });
    }

    await connection.commit();
    return res.json({ invoiceNumber: finalNumber });

  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error('Error generating invoice number:', err);
    res.status(500).json({ error: 'Failed to generate invoice number' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};


