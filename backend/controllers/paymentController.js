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
import { isMyPaymentsReadCanaryEnabled, isFirestorePaymentsServingEnabled } from '../config/featureFlags.js';
import { PaymentCutoverService } from '../services/paymentCutoverService.js';

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
  const idempotencyKey = req.body?.idempotencyKey || req.headers['idempotency-key'] || null;

  if (!bookingId) {
    return res.status(400).json({ success: false, message: 'bookingId is required' });
  }

  const allowedMethods = ['Cash', 'UPI', 'Debit Card', 'Credit Card', 'QR Code', 'Net Banking', 'Wallet'];
  const method = allowedMethods.includes(paymentMethod) ? paymentMethod : 'Cash';
  const gateway = method === 'Cash' ? 'Internal' : 'Gateway';
  const remarks = method === 'Cash'
    ? 'Cash to be collected at reception during check-in'
    : `${method} — awaiting gateway confirmation`;
  const userId = req.user?.id || null;
  const eventOccurredAt = new Date().toISOString();

  const mysqlHandler = async () => {
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

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
        await connection.rollback();
        return {
          success: true,
          message: 'No pending payment found — booking may already be finalised.',
          alreadyFinalised: true
        };
      }

      const payment = rows[0];
      const transactionId = generateTransactionId();

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

      await connection.commit();

      return {
        success: true,
        message: method === 'Cash'
          ? 'Booking confirmed. Cash payment of ₹' + payment.amount + ' is pending — please pay at the reception desk during check-in.'
          : `Payment recorded. ${method} processing pending gateway integration.`,
        paymentId: payment.id,
        transactionId,
        method,
        status: 'Pending',
        cashPending: method === 'Cash'
      };
    } finally {
      if (connection) connection.release();
    }
  };

  try {
    const result = await PaymentCutoverService.finalizePayment(
      { bookingId, paymentMethod, user: req.user, idempotencyKey },
      mysqlHandler
    );
    return res.status(200).json(result);
  } catch (err) {
    console.error('finalizePayment error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Payment finalisation failed.' });
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

  const mysqlHandler = async () => {
    // Ownership check for guests
    if (userRole !== 'admin') {
      const [ownerCheck] = await pool.query(
        `SELECT b.id FROM bookings b
         JOIN guests g ON b.guest_id = g.id
         WHERE b.id = ? AND g.user_id = ?`,
        [bookingId, userId]
      );
      if (ownerCheck.length === 0) {
        const err = new Error('Access denied.');
        err.status = 403;
        throw err;
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

    return {
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
    };
  };

  try {
    const result = await PaymentCutoverService.getPaymentsByBooking(bookingId, req.user, mysqlHandler);
    return res.status(200).json(result);
  } catch (err) {
    console.error('getPaymentsByBooking error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to load payment records.' });
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

  const mysqlHandler = async () => {
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

    return {
      success: true,
      payments,
      count: payments.length
    };
  };

  try {
    const result = await PaymentCutoverService.getMyPayments(userId, mysqlHandler);
    return res.status(200).json(result);
  } catch (err) {
    console.error('getMyPayments error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to load payment history.' });
  }
};

// ---------------------------------------------------------------------------
// PUT /api/payments/booking/:bookingId/confirm-cash  (Admin only)
// ---------------------------------------------------------------------------
/**
 * Admin calls this after physically receiving cash from the guest at reception.
 */
export const confirmCashPayment = async (req, res) => {
  const { bookingId } = req.params;
  const adminId = req.user?.id;
  const idempotencyKey = req.body?.idempotencyKey || req.headers['idempotency-key'] || null;

  const eventOccurredAt = new Date().toISOString();

  const mysqlHandler = async () => {
    let connection;
    let bookingForNotification = null;
    let paymentAmountForNotification = 0;

    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

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
        const err = new Error('No pending Cash payment found for this booking.');
        err.status = 404;
        err.code = 'BOOKING_PAYMENT_NOT_FOUND';
        throw err;
      }

      const payment = rows[0];
      paymentAmountForNotification = payment.amount;

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

      bookingForNotification = { _payment_id: payment.id, _booking_id: bookingId };

      await connection.commit();

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
          console.error('confirmCashPayment notification error (non-fatal):', notifErr);
        }
      }

      return {
        success: true,
        message: `Cash payment of ₹${payment.amount} confirmed successfully.`,
        paymentId: payment.id,
        amount: payment.amount
      };
    } finally {
      if (connection) connection.release();
    }
  };

  try {
    const result = await PaymentCutoverService.confirmCashPayment(
      { bookingId, adminId, idempotencyKey },
      mysqlHandler
    );
    return res.status(200).json(result);
  } catch (err) {
    console.error('confirmCashPayment error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to confirm cash payment.' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/payments/guest/payment-status  (Guest only)
// ---------------------------------------------------------------------------
/**
 * Returns the payment status of the guest's active (Reserved) booking.
 */
export const getGuestPaymentStatus = async (req, res) => {
  const userId = req.user?.id;

  const mysqlHandler = async () => {
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
      return { success: true, hasActivePayment: false };
    }

    const p = rows[0];
    return {
      success: true,
      hasActivePayment: true,
      paymentStatus: p.payment_status,
      paymentMethod: p.payment_method,
      amount: p.amount,
      paymentConfirmed: p.payment_status === 'Paid',
      cashPendingConfirmation: p.payment_method === 'Cash' && p.payment_status === 'Pending',
      bookingId: p.booking_id,
      bookingNumber: p.booking_number,
      remarks: p.remarks
    };
  };

  try {
    const result = await PaymentCutoverService.getGuestPaymentStatus(userId, mysqlHandler);
    return res.status(200).json(result);
  } catch (err) {
    console.error('getGuestPaymentStatus error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to load payment status.' });
  }
};
