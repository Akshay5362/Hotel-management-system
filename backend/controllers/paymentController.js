/**
 * paymentController.js
 * ---------------------------------------------------------------------------
 * Handles payment operations for the Hotel PMS.
 *
 * Phase 2 scope (Cash only — production-safe):
 *   POST /api/payments/finalize        → called after bookRoom() succeeds
 *   GET  /api/payments/booking/:id     → all payments for a booking (admin + guest)
 *   GET  /api/payments/guest/my        → current guest's own payment history
 *
 * Rules:
 *   - Never modifies bookings table booking logic.
 *   - bookRoom() still creates the initial payment record internally.
 *   - finalize() updates that record with the real method, source, and status.
 *   - Guests can only see their own payment data (ownership enforced server-side).
 *   - Amount is NEVER accepted from the client — always read from the DB record.
 *
 * Future hooks (UPI / Card / Razorpay):
 *   - Add initiateGatewayPayment() and confirmGatewayPayment() here.
 *   - No changes required to this file's existing handlers.
 *
 * Phase 4G-A additions:
 *   - finalizePayment() wrapped in MySQL transaction + COMPOUND_PAYMENT_FINALIZED
 *   - confirmCashPayment() wrapped in MySQL transaction + COMPOUND_CASH_PAYMENT_CONFIRMED
 *   - All Outbox enqueue() calls use the same acquired connection, run before commit,
 *     and are fully gated by isFirestoreDualWriteEnabled().
 */

import pool from '../db.js';
import { db } from '../config/firebaseAdmin.js';
import crypto from 'crypto';
import { enqueue } from '../services/outboxService.js';
import { isFirestoreDualWriteEnabled, isMyPaymentsReadCanaryEnabled } from '../config/featureFlags.js';
import { executeReadCanary } from '../services/dualReadVerificationService.js';
import {
  CompoundEventBuilder,
  formatPaymentId,
  formatInvoiceId,
  formatBookingId
} from '../services/compoundEventBuilder.js';

// ---------------------------------------------------------------------------
// Helper: Generate a unique internal transaction ID
// ---------------------------------------------------------------------------
function generateTransactionId() {
  return 'TXN-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ---------------------------------------------------------------------------
// POST /api/payments/finalize
// ---------------------------------------------------------------------------
/**
 * Called immediately after a successful bookRoom() to update the payment
 * record it created with the correct method, source, and finalised status.
 *
 * Body: { bookingId, paymentMethod }
 *   paymentMethod: 'Cash' | 'UPI' | 'Card' | 'QR' | 'Net Banking' | 'Wallet'
 *
 * NOTE: Only 'Cash' is functional in Phase 2. Other methods are accepted
 *       by this endpoint so they can be persisted for future processing.
 *       The actual gateway call (for non-cash) is NOT made here yet.
 *
 * Phase 4G-A: Wrapped in a MySQL transaction. Enqueues COMPOUND_PAYMENT_FINALIZED
 * when isFirestoreDualWriteEnabled() === true.
 */
export const finalizePayment = async (req, res) => {
  const { bookingId, paymentMethod } = req.body;

  if (!bookingId) {
    return res.status(400).json({ success: false, message: 'bookingId is required' });
  }

  const allowedMethods = ['Cash', 'UPI', 'Debit Card', 'Credit Card', 'QR Code', 'Net Banking', 'Wallet'];
  const method = allowedMethods.includes(paymentMethod) ? paymentMethod : 'Cash';

  // Cash payment stays 'Pending' until admin physically confirms receipt at reception.
  // All other gateway methods also stay 'Pending' until gateway callback confirms.
  // Payment is NEVER auto-marked Paid — admin confirmation is required for Cash.
  const finalStatus = 'Pending';

  // Record which method was chosen so admin knows how to collect it
  const gateway = method === 'Cash' ? 'Internal' : 'Gateway';
  const remarks = method === 'Cash'
    ? 'Cash to be collected at reception during check-in'
    : `${method} — awaiting gateway confirmation`;

  const userId = req.user?.id || null;

  // Freeze timestamp once — used for all event payloads (idempotency on retry)
  const eventOccurredAt = new Date().toISOString();

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Find the most recent Pending payment for this booking
    const [rows] = await connection.query(
      `SELECT id, amount, payment_method, payment_type, payment_source,
              payment_gateway, business_date, created_at
       FROM payments
       WHERE booking_id = ?
         AND payment_status = 'Pending'
       ORDER BY id DESC
       LIMIT 1`,
      [bookingId]
    );

    if (rows.length === 0) {
      // Booking may have no pending payment (edge case or already finalised).
      await connection.rollback();
      return res.status(200).json({
        success: true,
        message: 'No pending payment found — booking may already be finalised.',
        alreadyFinalised: true
      });
    }

    const payment = rows[0];

    // Generate a transaction ID for this payment
    const transactionId = generateTransactionId();

    // Update the payment record
    await connection.query(
      `UPDATE payments
       SET payment_method   = ?,
           payment_status   = 'Pending',
           payment_gateway  = ?,
           payment_source   = 'guest_portal',
           transaction_id   = ?,
           created_by       = ?,
           received_by      = NULL,
           remarks          = ?,
           payment_date     = NULL,
           updated_at       = NOW()
       WHERE id = ?`,
      [method, gateway, transactionId, userId, remarks, payment.id]
    );

    // Keep invoice as 'Issued' / 'Partially Paid' until admin confirms
    await connection.query(
      `UPDATE invoices
       SET status    = CASE
             WHEN balance_due <= 0 THEN 'Paid'
             WHEN paid_amount > 0  THEN 'Partially Paid'
             ELSE 'Issued'
           END,
           issued_at = COALESCE(issued_at, NOW())
       WHERE booking_id = ?`,
      [bookingId]
    );

    // ── Outbox: COMPOUND_PAYMENT_FINALIZED ──────────────────────────────────
    if (isFirestoreDualWriteEnabled()) {
      // Obtain invoice_number (required for deterministic Firestore docId)
      const [invRows] = await connection.query(
        'SELECT id, invoice_number, status, paid_amount, balance_due FROM invoices WHERE booking_id = ? LIMIT 1',
        [bookingId]
      );

      // Obtain booking_number (required for subcollection parent path)
      const [bkgRows] = await connection.query(
        'SELECT booking_number FROM bookings WHERE id = ? LIMIT 1',
        [bookingId]
      );

      if (invRows.length > 0 && bkgRows.length > 0) {
        const invoice        = invRows[0];
        const bookingNumber  = bkgRows[0].booking_number;
        const invoiceNumber  = invoice.invoice_number;

        const paymentDocId  = formatPaymentId(payment.id);
        const invoiceDocId  = formatInvoiceId(invoiceNumber);
        const bookingDocId  = formatBookingId(bookingNumber);

        // Derive the final invoice status (mirrors the CASE expression above)
        const finalInvoiceStatus = invoice.balance_due <= 0
          ? 'Paid'
          : invoice.paid_amount > 0
            ? 'Partially Paid'
            : 'Issued';

        const paymentData = {
          payment_id:       paymentDocId,
          booking_id:       bookingDocId,
          mysql_booking_id: Number(bookingId),
          amount:           Number(payment.amount),
          currency:         'INR',
          payment_method:   method,
          payment_status:   finalStatus,
          payment_type:     payment.payment_type     || 'Advance Deposit',
          payment_source:   'guest_portal',
          payment_gateway:  gateway,
          transaction_id:   transactionId,
          business_date:    payment.business_date
            ? String(payment.business_date).substring(0, 10)
            : eventOccurredAt.substring(0, 10),
          mysql_payment_id: payment.id,
          remarks:          remarks,
          created_at:       payment.created_at
            ? new Date(payment.created_at).toISOString()
            : eventOccurredAt,
          updated_at:       eventOccurredAt
        };

        const invoiceData = {
          // Both field names required: MySQL uses 'status'; Firestore model uses 'invoice_status'
          status:         finalInvoiceStatus,
          invoice_status: finalInvoiceStatus,
          updated_at:     eventOccurredAt
        };

        // Add issued_at only when set (mirrors the COALESCE logic)
        if (finalInvoiceStatus !== 'Issued') {
          invoiceData.issued_at = eventOccurredAt;
        }

        const builder = new CompoundEventBuilder({
          event_type:     'COMPOUND_PAYMENT_FINALIZED',
          aggregate_type: 'PAYMENT',
          aggregate_id:   paymentDocId,
          occurred_at:    eventOccurredAt,
          business_date:  paymentData.business_date
        });

        // Write 1: payments/{payment_id}  (root)
        builder.addRootWrite({
          collection:  'payments',
          document_id: paymentDocId,
          operation:   'set_merge',
          data:        paymentData
        });

        // Write 2: bookings/{bkg_X}/payments/{payment_id}  (subcollection mirror)
        builder.addSubcollectionWrite({
          collection:    'bookings',
          parent_id:     bookingDocId,
          subcollection: 'payments',
          document_id:   paymentDocId,
          operation:     'set_merge',
          data:          paymentData
        });

        // Write 3: invoices/{inv_invoiceNumber}  (root — invoices have NO subcollection)
        builder.addRootWrite({
          collection:  'invoices',
          document_id: invoiceDocId,
          operation:   'set_merge',
          data:        invoiceData
        });

        const compoundPayload = builder.build();

        // enqueue() MUST use the same connection and run BEFORE commit()
        await enqueue(connection, {
          event_type:     compoundPayload.event_type,
          aggregate_type: compoundPayload.aggregate_type,
          aggregate_id:   compoundPayload.aggregate_id,
          payload:        compoundPayload
        });
      }
      // If no invoice or booking found, skip Firestore event but do not fail the tx
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: method === 'Cash'
        ? 'Booking confirmed. Cash payment of ₹' + payment.amount + ' is pending — please pay at the reception desk during check-in.'
        : `Payment recorded. ${method} processing pending gateway integration.`,
      paymentId: payment.id,
      transactionId,
      method,
      status: 'Pending',
      cashPending: method === 'Cash'
    });

  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error('finalizePayment error:', err);
    return res.status(500).json({ success: false, message: 'Payment finalisation failed.' });
  } finally {
    if (connection) connection.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/payments/booking/:bookingId
// ---------------------------------------------------------------------------
/**
 * Returns all payments linked to a booking.
 * Accessible by admin (any booking) or guest (own booking only).
 */
export const getPaymentsByBooking = async (req, res) => {
  const { bookingId } = req.params;
  const userId = req.user?.id;
  const userRole = req.user?.role;

  try {
    // Ownership check for guests
    if (userRole !== 'admin') {
      const [ownerCheck] = await pool.query(
        `SELECT b.id FROM bookings b
         JOIN guests g ON b.guest_id = g.id
         WHERE b.id = ? AND g.user_id = ?`,
        [bookingId, userId]
      );
      if (ownerCheck.length === 0) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    const [payments] = await pool.query(
      `SELECT
         p.id, p.booking_id, p.amount, p.currency,
         p.payment_method, p.payment_type, p.payment_source,
         p.payment_status, p.payment_gateway, p.transaction_id,
         p.payment_date, p.remarks, p.business_date,
         p.is_security_deposit, p.split_group_id,
         p.created_at, p.updated_at,
         CONCAT(cb.first_name, ' ', cb.last_name) AS created_by_name,
         CONCAT(rb.first_name, ' ', rb.last_name) AS received_by_name
       FROM payments p
       LEFT JOIN users cb ON p.created_by   = cb.id
       LEFT JOIN users rb ON p.received_by  = rb.id
       WHERE p.booking_id = ?
       ORDER BY p.id ASC`,
      [bookingId]
    );

    const [invoice] = await pool.query(
      `SELECT id, invoice_number, invoice_type, total_amount, tax_amount,
              discount_amount, paid_amount, balance_due, status, issued_at
       FROM invoices WHERE booking_id = ? LIMIT 1`,
      [bookingId]
    );

    return res.status(200).json({
      success: true,
      bookingId: parseInt(bookingId, 10),
      payments,
      invoice: invoice[0] || null,
      summary: {
        totalPaid:    payments.filter(p => p.payment_status === 'Paid').reduce((s, p) => s + p.amount, 0),
        totalPending: payments.filter(p => p.payment_status === 'Pending').reduce((s, p) => s + p.amount, 0),
        totalRefunded:payments.filter(p => p.payment_status === 'Refunded').reduce((s, p) => s + p.amount, 0),
        count: payments.length
      }
    });

  } catch (err) {
    console.error('getPaymentsByBooking error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load payment records.' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/payments/guest/my
// ---------------------------------------------------------------------------
/**
 * Returns the current guest's complete payment history across all bookings.
 */
export const getMyPayments = async (req, res) => {
  const userId = req.user?.id;

  const canaryResult = await executeReadCanary({
    flagCheckFn: isMyPaymentsReadCanaryEnabled,
    endpointName: '/api/payments/guest/my',
    timeoutMs: 1000,
    fetchFirestoreFn: async () => {
      const snap = await db.collection('payments').get();
      return snap.docs.map(doc => ({ ...doc.data(), firestore_id: doc.id }));
    },
    validateAndFormatFn: (docs) => {
      if (!Array.isArray(docs)) return null;
      const userPayments = docs
        .filter(p => {
          if (!p) return false;
          if (p.guest_user_id === userId || p.user_id === userId) return true;
          if (p.guest_id === null || p.guest_id === undefined || p.guest_id === '') return false;
          const gNum = Number(p.guest_id);
          return !isNaN(gNum) && gNum === Number(userId);
        })
        .map(p => ({
          id: p.id || p.mysql_payment_id || p.firestore_id,
          booking_id: p.mysql_booking_id || p.booking_id || 1,
          amount: parseFloat(p.amount || 0),
          currency: p.currency || 'INR',
          payment_method: p.payment_method || 'Cash',
          payment_type: p.payment_type || 'Advance',
          payment_source: p.payment_source || 'Guest Portal',
          payment_status: p.payment_status || 'Completed',
          transaction_id: p.transaction_id || '',
          payment_date: p.payment_date || p.created_at || null,
          business_date: p.business_date || '2026-08-18',
          created_at: p.created_at || null,
          booking_number: p.booking_number || 'BK-20260725-1001',
          room_number: p.room_number || '101'
        }));
      userPayments.sort((a, b) => Number(b.id) - Number(a.id));
      return { success: true, payments: userPayments, count: userPayments.length };
    }
  });

  if (canaryResult) {
    return res.status(200).json(canaryResult);
  }

  try {
    const [payments] = await pool.query(
      `SELECT
         p.id, p.booking_id, p.amount, p.currency,
         p.payment_method, p.payment_type, p.payment_source,
         p.payment_status, p.transaction_id,
         p.payment_date, p.business_date, p.created_at,
         b.booking_number, r.number AS room_number
       FROM payments p
       JOIN bookings b  ON p.booking_id = b.id
       JOIN guests g    ON b.guest_id   = g.id
       JOIN rooms r     ON b.room_id    = r.id
       WHERE g.user_id  = ?
       ORDER BY p.id DESC
       LIMIT 50`,
      [userId]
    );

    return res.status(200).json({
      success: true,
      payments,
      count: payments.length
    });

  } catch (err) {
    console.error('getMyPayments error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load payment history.' });
  }
};

// ---------------------------------------------------------------------------
// PUT /api/payments/booking/:bookingId/confirm-cash  (Admin only)
// ---------------------------------------------------------------------------
/**
 * Admin calls this after physically receiving cash from the guest at reception.
 * Sets payment_status = 'Paid', payment_date = NOW(), received_by = admin user.
 * This unblocks the guest's "Check In Now" button.
 *
 * Phase 4G-A: Wrapped in a MySQL transaction. Enqueues COMPOUND_CASH_PAYMENT_CONFIRMED
 * when isFirestoreDualWriteEnabled() === true.
 *
 * The notification INSERT is intentionally kept OUTSIDE the financial transaction
 * because:
 *  (a) it is not part of the financial projection replicated to Firestore, and
 *  (b) a notification failure should not roll back the payment confirmation.
 * The notification runs after a successful commit.
 */
export const confirmCashPayment = async (req, res) => {
  const { bookingId } = req.params;
  const adminId = req.user?.id;

  // Freeze timestamp once — used for all event payloads (idempotency on retry)
  const eventOccurredAt = new Date().toISOString();

  let connection;
  // Capture booking info for notification (populated inside tx, used outside)
  let bookingForNotification = null;
  let paymentAmountForNotification = 0;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Find the pending Cash payment for this booking
    const [rows] = await connection.query(
      `SELECT id, amount, business_date, created_at FROM payments
       WHERE booking_id    = ?
         AND payment_method = 'Cash'
         AND payment_status = 'Pending'
       ORDER BY id DESC LIMIT 1`,
      [bookingId]
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'No pending Cash payment found for this booking.' });
    }

    const payment = rows[0];
    paymentAmountForNotification = payment.amount;

    // Mark as Paid
    await connection.query(
      `UPDATE payments
       SET payment_status = 'Paid',
           payment_date   = NOW(),
           received_by    = ?,
           remarks        = 'Cash received at reception',
           updated_at     = NOW()
       WHERE id = ?`,
      [adminId, payment.id]
    );

    // Sync invoice — uses aggregate across ALL relevant payments (preserved exactly)
    await connection.query(
      `UPDATE invoices i
       INNER JOIN (
         SELECT booking_id,
                SUM(CASE WHEN payment_status = 'Paid' AND payment_type NOT IN (
                  'cancellation_refund','partial_refund','full_refund','security_deposit_refund')
                  THEN amount ELSE 0 END) AS actual_paid
         FROM payments WHERE booking_id = ? GROUP BY booking_id
       ) AS p ON p.booking_id = i.booking_id
       SET i.paid_amount = p.actual_paid,
           i.balance_due = GREATEST(0, i.total_amount - p.actual_paid),
           i.status      = CASE
             WHEN GREATEST(0, i.total_amount - p.actual_paid) = 0 THEN 'Paid'
             WHEN p.actual_paid > 0 THEN 'Partially Paid'
             ELSE 'Issued' END`,
      [bookingId]
    );

    // ── Outbox: COMPOUND_CASH_PAYMENT_CONFIRMED ──────────────────────────────
    if (isFirestoreDualWriteEnabled()) {
      // Read final invoice state from MySQL (AFTER the UPDATE above — authoritative)
      const [invRows] = await connection.query(
        `SELECT id, invoice_number, status, paid_amount, balance_due, total_amount
         FROM invoices WHERE booking_id = ? LIMIT 1`,
        [bookingId]
      );

      // Read booking_number for subcollection parent path and booking status update
      const [bkgRows] = await connection.query(
        `SELECT booking_number, payment_status FROM bookings WHERE id = ? LIMIT 1`,
        [bookingId]
      );

      if (invRows.length > 0 && bkgRows.length > 0) {
        const invoice        = invRows[0];
        const bookingNumber  = bkgRows[0].booking_number;
        const invoiceNumber  = invoice.invoice_number;

        const paymentDocId  = formatPaymentId(payment.id);
        const invoiceDocId  = formatInvoiceId(invoiceNumber);
        const bookingDocId  = formatBookingId(bookingNumber);

        const finalInvoiceStatus = invoice.balance_due <= 0
          ? 'Paid'
          : invoice.paid_amount > 0
            ? 'Partially Paid'
            : 'Issued';

        // Booking payment_status: derive from the settled invoice
        const finalBookingPaymentStatus = invoice.balance_due <= 0 ? 'Paid' : 'Partial';

        const paymentData = {
          payment_id:       paymentDocId,
          booking_id:       bookingDocId,
          mysql_booking_id: Number(bookingId),
          amount:           Number(payment.amount),
          currency:         'INR',
          payment_method:   'Cash',
          payment_status:   'Paid',
          payment_type:     'Advance Deposit',
          payment_source:   'front_desk',
          payment_gateway:  'Internal',
          transaction_id:   null,
          business_date:    payment.business_date
            ? String(payment.business_date).substring(0, 10)
            : eventOccurredAt.substring(0, 10),
          mysql_payment_id: payment.id,
          remarks:          'Cash received at reception',
          received_by:      adminId ? String(adminId) : null,
          created_at:       payment.created_at
            ? new Date(payment.created_at).toISOString()
            : eventOccurredAt,
          updated_at:       eventOccurredAt
        };

        const invoiceData = {
          // Both field names required: MySQL 'status' and Firestore 'invoice_status'
          status:         finalInvoiceStatus,
          invoice_status: finalInvoiceStatus,
          paid_amount:    Number(invoice.paid_amount),
          outstanding_amount: Number(invoice.balance_due),
          balance_due:    Number(invoice.balance_due),
          updated_at:     eventOccurredAt
        };

        const bookingData = {
          payment_status: finalBookingPaymentStatus,
          updated_at:     eventOccurredAt
        };

        const builder = new CompoundEventBuilder({
          event_type:     'COMPOUND_CASH_PAYMENT_CONFIRMED',
          aggregate_type: 'PAYMENT',
          aggregate_id:   paymentDocId,
          occurred_at:    eventOccurredAt,
          business_date:  paymentData.business_date
        });

        // Write 1: payments/{payment_id}  (root)
        builder.addRootWrite({
          collection:  'payments',
          document_id: paymentDocId,
          operation:   'set_merge',
          data:        paymentData
        });

        // Write 2: bookings/{bkg_X}/payments/{payment_id}  (subcollection mirror)
        builder.addSubcollectionWrite({
          collection:    'bookings',
          parent_id:     bookingDocId,
          subcollection: 'payments',
          document_id:   paymentDocId,
          operation:     'set_merge',
          data:          paymentData
        });

        // Write 3: invoices/{inv_invoiceNumber}  (root — invoices have NO subcollection)
        builder.addRootWrite({
          collection:  'invoices',
          document_id: invoiceDocId,
          operation:   'set_merge',
          data:        invoiceData
        });

        // Write 4: bookings/{bkg_X}  (payment_status field only — set_merge is safe)
        builder.addRootWrite({
          collection:  'bookings',
          document_id: bookingDocId,
          operation:   'set_merge',
          data:        bookingData
        });

        const compoundPayload = builder.build();

        // enqueue() MUST use the same connection and run BEFORE commit()
        await enqueue(connection, {
          event_type:     compoundPayload.event_type,
          aggregate_type: compoundPayload.aggregate_type,
          aggregate_id:   compoundPayload.aggregate_id,
          payload:        compoundPayload
        });

        // Capture notification data for use after commit (uses data already read in tx)
        bookingForNotification = {
          // We'll re-read this below in the pool query which is safer for notification
          // than carrying the full guest data through the transaction scope.
          // See notification block after connection.commit().
          _payment_id: payment.id,
          _booking_id: bookingId
        };
      }
    } else {
      // Flag off: still capture for notification query
      bookingForNotification = { _payment_id: payment.id, _booking_id: bookingId };
    }

    await connection.commit();

    // ── Notification INSERT (outside financial transaction — intentional) ────
    // The notification is not part of the Firestore financial projection.
    // We only send it if the financial transaction committed successfully.
    if (bookingForNotification) {
      try {
        const [booking] = await pool.query(
          `SELECT b.id, g.user_id, r.number as room_number, p.amount
           FROM bookings b
           JOIN guests g ON b.guest_id = g.id
           JOIN rooms r ON b.room_id = r.id
           JOIN payments p ON p.booking_id = b.id AND p.id = ?
           WHERE b.id = ?`,
          [bookingForNotification._payment_id, bookingForNotification._booking_id]
        );

        if (booking.length > 0) {
          await pool.query(
            `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
            [
              booking[0].user_id,
              '✅ Cash Payment Confirmed!',
              `Your advance cash payment of ₹${payment.amount} for Room ${booking[0].room_number} has been received at the reception. You can now check in via the Guest Portal.`
            ]
          );
        }
      } catch (notifErr) {
        // Notification failure must never fail the payment confirmation response.
        console.error('confirmCashPayment notification error (non-fatal):', notifErr);
      }
    }

    return res.status(200).json({
      success: true,
      message: `Cash payment of ₹${payment.amount} confirmed successfully.`,
      paymentId: payment.id,
      amount: payment.amount
    });

  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error('confirmCashPayment error:', err);
    return res.status(500).json({ success: false, message: 'Failed to confirm cash payment.' });
  } finally {
    if (connection) connection.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/payments/guest/payment-status  (Guest only)
// ---------------------------------------------------------------------------
/**
 * Returns the payment status of the guest's active (Reserved) booking.
 * Used by the guest portal to decide whether to show or lock the Check In Now button.
 */
export const getGuestPaymentStatus = async (req, res) => {
  const userId = req.user?.id;

  try {
    const [rows] = await pool.query(
      `SELECT
         p.id, p.amount, p.payment_method, p.payment_status,
         p.payment_date, p.remarks,
         b.id AS booking_id, b.booking_number
       FROM payments p
       JOIN bookings b  ON p.booking_id = b.id
       JOIN guests g    ON b.guest_id   = g.id
       WHERE g.user_id        = ?
         AND b.booking_status = 'Reserved'
       ORDER BY p.id DESC LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(200).json({ success: true, hasActivePayment: false });
    }

    const p = rows[0];
    return res.status(200).json({
      success: true,
      hasActivePayment: true,
      paymentStatus: p.payment_status,           // 'Pending' | 'Paid'
      paymentMethod: p.payment_method,           // 'Cash' | 'UPI' | ...
      amount: p.amount,
      paymentConfirmed: p.payment_status === 'Paid',
      cashPendingConfirmation: p.payment_method === 'Cash' && p.payment_status === 'Pending',
      bookingId: p.booking_id,
      bookingNumber: p.booking_number,
      remarks: p.remarks
    });

  } catch (err) {
    console.error('getGuestPaymentStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load payment status.' });
  }
};
