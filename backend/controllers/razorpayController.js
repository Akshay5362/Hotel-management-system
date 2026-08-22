import pool from '../db.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';

// Initialize Razorpay (Using dummy test keys since no real keys exist in .env)
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret',
});

export const createRazorpayOrder = async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const options = {
      amount: amount * 100, // amount in paise
      currency: "INR",
      receipt: "rcpt_" + Date.now(),
    };

    const order = await razorpay.orders.create(options);
    
    // Primary Firestore Path
    try {
      const { createRazorpayTransactionFirestore } = await import('../repositories/firestore/razorpayTransactionsRepository.js');
      await createRazorpayTransactionFirestore({
        order_id: order.id,
        amount,
        currency: "INR",
        status: 'PENDING'
      });
    } catch (fsErr) {
      console.warn('[Razorpay] Firestore create transaction warning, attempting MySQL fallback:', fsErr.message);
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.query(
          "INSERT INTO razorpay_transactions (order_id, amount, status) VALUES (?, ?, 'PENDING')",
          [order.id, amount]
        );
      } catch (_) {}
      finally {
        if (connection) connection.release();
      }
    }

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy_key_id'
    });
  } catch (error) {
    console.error('Razorpay Order Error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
};

export const verifyRazorpayPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment parameters' });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret';
    
    // Verify signature
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest('hex');

    if (digest !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Primary Firestore Path
    try {
      const { getRazorpayTransactionByOrderIdFirestore, updateRazorpayTransactionFirestore } = await import('../repositories/firestore/razorpayTransactionsRepository.js');
      const existing = await getRazorpayTransactionByOrderIdFirestore(razorpay_order_id);
      if (existing && existing.status === 'SUCCESS') {
        return res.status(400).json({ error: 'Order not found or already verified' });
      }

      await updateRazorpayTransactionFirestore(razorpay_order_id, {
        payment_id: razorpay_payment_id,
        signature: razorpay_signature,
        status: 'SUCCESS',
        updated_at: new Date().toISOString()
      });

      return res.json({ success: true, transaction_id: razorpay_order_id });
    } catch (fsErr) {
      console.warn('[Razorpay] Firestore verify transaction warning, attempting MySQL fallback:', fsErr.message);

      let connection;
      let updateResult;
      try {
        connection = await pool.getConnection();
        [updateResult] = await connection.query(
          "UPDATE razorpay_transactions SET payment_id = ?, signature = ?, status = 'SUCCESS' WHERE order_id = ? AND status = 'PENDING'",
          [razorpay_payment_id, razorpay_signature, razorpay_order_id]
        );
      } finally {
        if (connection) connection.release();
      }

      if (updateResult && updateResult.affectedRows === 0) {
        return res.status(400).json({ error: 'Order not found or already verified' });
      }

      let conn2;
      try {
        conn2 = await pool.getConnection();
        const [rows] = await conn2.query("SELECT id FROM razorpay_transactions WHERE order_id = ?", [razorpay_order_id]);
        return res.json({ success: true, transaction_id: rows[0]?.id || razorpay_order_id });
      } finally {
        if (conn2) conn2.release();
      }
    }

  } catch (error) {
    console.error('Razorpay Verify Error:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
};
