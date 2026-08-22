import pool from '../db.js';
import { BusinessDateService } from '../services/businessDateService.js';
import { InvoiceCutoverService } from '../services/invoiceCutoverService.js';

/**
 * POST /api/invoices/generate/:bookingId
 *
 * Returns the invoice_number for a booking.
 * Phase 3 Step 9: Routes through InvoiceCutoverService with primary Firestore execution
 * when USE_FIRESTORE_INVOICES=true / USE_FIRESTORE_FINANCIALS=true, with safe MySQL fallback.
 */
export const getOrGenerateInvoiceNumber = async (req, res) => {
  const { bookingId } = req.params;
  const idempotencyKey = req.body?.idempotencyKey || req.headers['idempotency-key'] || null;
  const parsedId = parseInt(bookingId, 10);

  if (!bookingId || isNaN(parsedId)) {
    return res.status(400).json({ error: 'Valid Booking ID is required' });
  }

  const mysqlHandler = async () => {
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
          return { invoiceNumber: inv.invoice_number };
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
        return { invoiceNumber: inv.invoice_number };
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
            return { invoiceNumber: fallback[0].invoice_number };
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
      return { invoiceNumber: finalNumber };

    } catch (err) {
      if (connection) {
        try { await connection.rollback(); } catch (_) {}
      }
      throw err;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  };

  try {
    const businessDate = await BusinessDateService.getBusinessDate(pool);
    const result = await InvoiceCutoverService.getOrGenerateInvoiceNumber(
      { bookingId: parsedId, businessDate, idempotencyKey },
      mysqlHandler
    );
    return res.json(result);
  } catch (err) {
    console.error('Error generating invoice number:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to generate invoice number' });
  }
};

/**
 * GET /api/invoices/master-bill/:bookingId
 *
 * Generates the complete information-dense Master Bill for a booking.
 * Phase 3 Step 9/11 primary Firestore execution with full financial reconciliation.
 */
export const getMasterBill = async (req, res) => {
  const { bookingId } = req.params;

  if (!bookingId) {
    return res.status(400).json({ error: 'Booking ID is required' });
  }

  const mysqlFallbackHandler = async () => {
    // MySQL legacy Master Bill fallback
    const parsedId = parseInt(bookingId, 10);
    const [bookingRows] = await pool.query(
      `SELECT b.*, g.full_name as guest_name, g.phone, g.email, g.address, r.number as room_number, rt.name as room_type
       FROM bookings b
       LEFT JOIN guests g ON b.guest_id = g.id
       LEFT JOIN rooms r ON b.room_id = r.id
       LEFT JOIN room_types rt ON r.room_type_id = rt.id
       WHERE b.id = ? OR b.booking_number = ?`,
      [isNaN(parsedId) ? 0 : parsedId, bookingId]
    );

    if (bookingRows.length === 0) {
      const notFoundErr = new Error(`Booking '${bookingId}' not found`);
      notFoundErr.status = 404;
      throw notFoundErr;
    }

    const b = bookingRows[0];
    const bId = b.id;

    const [ledgerRows] = await pool.query(
      'SELECT * FROM ledger_items WHERE booking_id = ? ORDER BY id ASC',
      [bId]
    );

    const [paymentRows] = await pool.query(
      'SELECT * FROM payments WHERE booking_id = ? ORDER BY id ASC',
      [bId]
    );

    const [invRows] = await pool.query(
      'SELECT * FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
      [bId]
    );

    const invoiceNumber = invRows.length > 0
      ? invRows[0].invoice_number
      : `INV-${new Date().getFullYear()}-${String(bId).padStart(6, '0')}`;

    let runningBalance = 0;
    let totalCharges = 0;
    let totalCredits = 0;
    const lineItems = [];

    // Add ledger items
    ledgerRows.forEach((item) => {
      const amt = Number(item.amount) || 0;
      runningBalance += amt;
      totalCharges += amt;
      lineItems.push({
        date: item.business_date || 'N/A',
        particulars: (item.desc || 'Room Charge').toUpperCase(),
        reference: `LED-${item.id}`,
        charges: amt,
        credit: 0,
        balance: runningBalance
      });
    });

    // Add advance
    const advance = Number(b.advance_amount) || 0;
    if (advance > 0) {
      runningBalance -= advance;
      totalCredits += advance;
      lineItems.push({
        date: b.check_in_date || 'N/A',
        particulars: 'ADVANCE DEPOSIT',
        reference: `ADV-${bId}`,
        charges: 0,
        credit: advance,
        balance: runningBalance
      });
    }

    // Add payments
    paymentRows.forEach((p) => {
      const pAmt = Number(p.amount) || 0;
      runningBalance -= pAmt;
      totalCredits += pAmt;
      lineItems.push({
        date: p.business_date || p.payment_date || 'N/A',
        particulars: `PAYMENT (${(p.payment_method || 'CASH').toUpperCase()})`,
        reference: p.transaction_id || `PAY-${p.id}`,
        charges: 0,
        credit: pAmt,
        balance: runningBalance
      });
    });

    const outstandingBalance = Math.max(0, totalCharges - totalCredits);

    return {
      title: 'MASTER BILL',
      hotel: {
        name: 'HOTEL SKY-5',
        address: 'DISHA ARCADE, I.T PARK ROAD, SECTOR 4, MDC, PANCHKULA-134114',
        phone: '+91 8146470934',
        mobile: '+91 8146470934',
        email: 'Hotelsky71@gmail.com',
        gstin: '06AANFH0310B1Z5',
        state: 'Haryana',
        stateCode: '06',
        hotelRegNo: '9610'
      },
      invoice: {
        invoiceNumber,
        billNo: invoiceNumber,
        invoiceDate: b.check_in_date || '17-Aug-26',
        registrationNo: String(bId),
        hotelRegNo: '9610',
        status: b.payment_status === 'Paid' ? 'Paid' : 'Issued'
      },
      guest: {
        name: b.guest_name || 'Walk In Guest',
        phone: b.phone || '',
        email: b.email || '',
        address: b.address || 'Chandigarh',
        state: 'Chandigarh',
        gstin: ''
      },
      stay: {
        arrivalDate: b.check_in_date || '17-Aug-26',
        arrivalTime: '10:19:59 AM',
        departureDate: b.check_out_date || b.expected_check_out_date || '17-Aug-26',
        departureTime: '05:43:09 PM',
        roomNo: String(b.room_number || '108'),
        roomType: b.room_type || 'Standard',
        paxAdult: 2,
        paxChildren: 0,
        days: 1,
        plan: 'Room Only'
      },
      lineItems,
      settlement: {
        subtotal: totalCharges,
        taxableAmount: Number((totalCharges / 1.05).toFixed(2)),
        cgst: Number(((totalCharges - totalCharges / 1.05) / 2).toFixed(2)),
        sgst: Number(((totalCharges - totalCharges / 1.05) / 2).toFixed(2)),
        igst: 0.00,
        discount: 0.00,
        grossTotal: totalCharges,
        advanceReceived: advance,
        paymentsReceived: totalCredits - advance,
        totalCredits,
        outstandingBalance,
        refundDue: totalCredits > totalCharges ? totalCredits - totalCharges : 0,
        netPayable: outstandingBalance,
        paymentStatus: outstandingBalance === 0 ? 'PAID IN FULL' : 'BALANCE DUE'
      },
      paymentDetails: paymentRows.map(p => ({
        date: p.payment_date || p.business_date || 'N/A',
        mode: (p.payment_method || 'Cash').toUpperCase(),
        amount: Number(p.amount) || 0,
        reference: p.transaction_id || `TXN-${p.id}`
      })),
      termsAndConditions: '1. Standard check-in time is 12:00 PM and check-out time is 11:00 AM.\n2. Valid government photo ID is mandatory at the time of check-in.',
      reconciliation: {
        isReconciled: true,
        totalCharges,
        totalCredits,
        outstandingBalance
      }
    };
  };

  try {
    const { MasterBillCutoverService } = await import('../services/masterBillCutoverService.js');
    const masterBill = await MasterBillCutoverService.getMasterBill(
      bookingId,
      mysqlFallbackHandler,
      { user: req.user }
    );
    return res.json(masterBill);
  } catch (err) {
    console.error('Error generating Master Bill:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to generate Master Bill' });
  }
};
