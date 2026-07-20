import pool from '../db.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';

// Initialize Razorpay (Using dummy test keys since no real keys exist in .env)
// The plan states we use standard test keys.
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret',
});

// Auto-migration for razorpay_transactions table
const initRazorpayTable = async () => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`razorpay_transactions\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`order_id\` VARCHAR(100) NOT NULL,
        \`payment_id\` VARCHAR(100),
        \`signature\` VARCHAR(255),
        \`amount\` INT NOT NULL,
        \`status\` VARCHAR(20) NOT NULL,
        \`booking_id\` INT DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(\`order_id\`),
        FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\`(\`id\`) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } catch (err) {
    console.error('Failed to init razorpay_transactions:', err);
  } finally {
    if (connection) connection.release();
  }
};

// Fire on startup
initRazorpayTable();

export const createRazorpayOrder = async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const options = {
      amount: amount * 100, // amount in the smallest currency unit (paise for INR)
      currency: "INR",
      receipt: "rcpt_" + Date.now(),
    };

    const order = await razorpay.orders.create(options);
    
    // We insert a PENDING transaction
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.query(
        "INSERT INTO razorpay_transactions (order_id, amount, status) VALUES (?, ?, 'PENDING')",
        [order.id, amount]
      );
    } finally {
      if (connection) connection.release();
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

    // Mark as SUCCESS
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

    if (updateResult.affectedRows === 0) {
       return res.status(400).json({ error: 'Order not found or already verified' });
    }

    // Return the generated transaction record ID for the frontend to pass into bookRoom
    let conn2;
    try {
       conn2 = await pool.getConnection();
       const [rows] = await conn2.query("SELECT id FROM razorpay_transactions WHERE order_id = ?", [razorpay_order_id]);
       res.json({ success: true, transaction_id: rows[0].id });
    } finally {
       if (conn2) conn2.release();
    }

  } catch (error) {
    console.error('Razorpay Verify Error:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
};
