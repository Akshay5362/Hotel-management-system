const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'controllers', 'roomController.js');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add paymentMethod and transactionId to req.body destructing
content = content.replace(
  /extraServices\s*\n\s*} = req\.body;/,
  "extraServices,\n    paymentMethod,\n    transactionId\n  } = req.body;"
);

// 2. Add Razorpay validation logic right after room check
const oldRoomCheck = `
    const room = roomRows[0];

    // Determine effective check-in`;

const newRoomCheck = `
    const room = roomRows[0];

    // Razorpay Online Payment Validation
    if (paymentMethod === 'Online') {
      if (!transactionId) {
        await connection.rollback();
        return res.status(400).json({ error: 'Transaction ID is required for online payments.' });
      }
      const [txnRows] = await connection.query(
        "SELECT id, amount, status, booking_id FROM razorpay_transactions WHERE id = ? FOR UPDATE",
        [transactionId]
      );
      if (txnRows.length === 0) {
        await connection.rollback();
        return res.status(400).json({ error: 'Invalid transaction ID.' });
      }
      const txn = txnRows[0];
      if (txn.status !== 'SUCCESS') {
        await connection.rollback();
        return res.status(400).json({ error: 'Payment was not successful.' });
      }
      if (txn.booking_id !== null) {
        await connection.rollback();
        return res.status(400).json({ error: 'Payment already consumed by another booking.' });
      }
      if (txn.amount < parsedDeposit) {
        await connection.rollback();
        return res.status(400).json({ error: 'Paid amount is less than the required deposit.' });
      }
    }

    // Determine effective check-in`;
content = content.replace(oldRoomCheck, newRoomCheck);

// 3. Modify payment logging to handle Online Payment vs Cash
const oldPaymentLog = `    // Insert cash log transaction if deposit paid
    if (parsedDeposit > 0) {
      const timeStr = formatTime(new Date());
      await connection.query(
        \`INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
         VALUES (?, ?, ?, 'Advance Deposit', ?, ?, ?)\`,
        [timeStr, number, guestNameUpper, parsedDeposit, businessDate, bookingId]
      );

      // Log Payment transaction
      await connection.query(
        \`INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
         VALUES (?, ?, 'Cash', 'Advance Deposit', ?)\`,
        [bookingId, parsedDeposit, businessDate]
      );
    }`;

const newPaymentLog = `    // Insert payment/cash log transaction if deposit paid
    if (parsedDeposit > 0) {
      if (paymentMethod === 'Online') {
        // Link razorpay transaction
        await connection.query(
          "UPDATE razorpay_transactions SET booking_id = ? WHERE id = ?",
          [bookingId, transactionId]
        );
        // Log Payment transaction as Razorpay
        await connection.query(
          \`INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
           VALUES (?, ?, 'Razorpay', 'Advance Deposit', ?)\`,
          [bookingId, parsedDeposit, businessDate]
        );
      } else {
        const timeStr = formatTime(new Date());
        await connection.query(
          \`INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
           VALUES (?, ?, ?, 'Advance Deposit', ?, ?, ?)\`,
          [timeStr, number, guestNameUpper, parsedDeposit, businessDate, bookingId]
        );

        // Log Payment transaction as Cash
        await connection.query(
          \`INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
           VALUES (?, ?, 'Cash', 'Advance Deposit', ?)\`,
          [bookingId, parsedDeposit, businessDate]
        );
      }
    }`;

content = content.replace(oldPaymentLog, newPaymentLog);

fs.writeFileSync(filePath, content);
console.log("Updated bookRoom in roomController.js");
