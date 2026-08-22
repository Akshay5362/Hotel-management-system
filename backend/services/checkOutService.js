import { BusinessDateService } from './businessDateService.js';
import { formatTime } from '../utils/dateUtils.js';

export const processCheckOut = async (connection, {
  number,
  parsedBalancePaid,
  resolvedUserId
}) => {
  let cashLogMysqlId = null;
  let paymentMysqlId = null;
  let historyMysqlId = null;

  const [roomRows] = await connection.query(`
    SELECT r.*, rt.base_rate as rate, rt.code as type
    FROM rooms r
    JOIN room_types rt ON r.room_type_id = rt.id
    WHERE r.number = ?
    FOR UPDATE
  `, [number]);
  
  if (roomRows.length === 0) {
    const error = new Error(`Room ${number} not found`);
    error.status = 404;
    throw error;
  }

  const room = roomRows[0];
  if (room.status !== 'occupied') {
    const error = new Error(`Room ${number} is not occupied`);
    error.status = 400;
    throw error;
  }

  // Fetch active Checked In booking
  const [bookingRows] = await connection.query(
    `SELECT b.*, g.full_name as guestName FROM bookings b
     JOIN guests g ON b.guest_id = g.id
     WHERE b.room_id = ? AND b.booking_status = 'Checked In'
     FOR UPDATE`,
    [room.id]
  );

  if (bookingRows.length === 0) {
    const error = new Error(`No active Checked In booking found for Room ${number}`);
    error.status = 404;
    throw error;
  }

  const activeBooking = bookingRows[0];

  // Business date via centralised service
  const businessDate = await BusinessDateService.getBusinessDate(connection);
  if (!businessDate) throw new Error('System configuration error: Business Date is missing.');

  // Insert cash log transaction if there's any transaction amount
  if (parsedBalancePaid !== 0) {
    const timeStr = formatTime(new Date());
    const transactionType = parsedBalancePaid > 0 ? 'Checkout Settlement' : 'Checkout Refund';
    const [cashLogResult] = await connection.query(
      `INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [timeStr, number, activeBooking.guestName, transactionType, Math.abs(parsedBalancePaid), businessDate, activeBooking.id]
    );
    cashLogMysqlId = cashLogResult.insertId;

    // Log Payment transaction
    const [paymentResult] = await connection.query(
      `INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
       VALUES (?, ?, 'Cash', ?, ?)`,
      [activeBooking.id, Math.abs(parsedBalancePaid), transactionType, businessDate]
    );
    paymentMysqlId = paymentResult.insertId;
  }

  // Update booking status to Checked Out
  // Payment is always 'Paid' — receptionist collects all dues before pressing Settle & Check Out.
  const totalCollected = (activeBooking.advance_amount || 0) + parsedBalancePaid;
  await connection.query(
    `UPDATE bookings
     SET booking_status = 'Checked Out', payment_status = 'Paid',
         total_amount = ?, check_out_date = ?
     WHERE id = ?`,
    [totalCollected, businessDate, activeBooking.id]
  );

  // Create invoice with balance_due = 0 (Paid in full)
  const invoiceNumber = `INV-${businessDate.replace(/-/g, '')}-${String(activeBooking.id).padStart(4, '0')}`;
  await connection.query(
    `INSERT INTO invoices
       (invoice_number, booking_id, total_amount, paid_amount, balance_due, status, business_date)
     VALUES (?, ?, ?, ?, 0, 'Paid', ?)
     ON DUPLICATE KEY UPDATE paid_amount = VALUES(paid_amount), balance_due = 0, status = 'Paid'`,
    [invoiceNumber, activeBooking.id, totalCollected, totalCollected, businessDate]
  );

  const resolvedUserIdNum = (resolvedUserId && Number.isInteger(Number(resolvedUserId)) && Number(resolvedUserId) > 0)
    ? Number(resolvedUserId)
    : null;

  // Update Room Status History
  await connection.query(
    `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
     VALUES (?, 'occupied', 'dirty', ?, ?)`,
    [room.id, resolvedUserIdNum, businessDate]
  );

  // Insert Audit Log entry
  await connection.query(
    `INSERT INTO audit_logs (user_id, action, details, business_date)
     VALUES (?, 'CHECK_OUT', ?, ?)`,
    [resolvedUserIdNum, `Checked out Room ${number}. Booking ID: ${activeBooking.id}. Balance paid: ₹${parsedBalancePaid}`, businessDate]
  );

  // Update room status to dirty and housekeeping to Dirty (High Priority)
  await connection.query(
    `UPDATE rooms SET status = 'dirty', housekeeping_status = 'Dirty', housekeeping_priority = 'High Priority' WHERE id = ?`,
    [room.id]
  );

  // Log CHECKED_OUT event in booking_history
  const [historyResult] = await connection.query(
    `INSERT INTO booking_history (booking_id, action, old_room_id, new_room_id, changed_by, business_date, notes)
     VALUES (?, 'CHECKED_OUT', ?, ?, ?, ?, ?)`,
    [activeBooking.id, room.id, room.id, resolvedUserIdNum, businessDate,
     `Checkout settled. Total collected: ₹${totalCollected}. Payment status: Paid.`]
  );
  historyMysqlId = historyResult.insertId;

  // Notify the guest about checkout completion and request feedback
  // Fetch the guest's user_id so we can send them a notification
  const [guestUserRows] = await connection.query(
    `SELECT g.user_id FROM guests g WHERE g.id = ?`,
    [activeBooking.guest_id]
  );
  const guestUserId = guestUserRows[0]?.user_id;
  if (guestUserId) {
    await connection.query(
      `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
      [guestUserId,
       '🏨 Thank You for Staying With Us!',
       `Your checkout from Room ${number} is complete. We hope you had a wonderful stay! Please take a moment to share your experience — your feedback helps us serve you better.`]
    );
  }

  // Increment todayCheckouts count
  await connection.query(
    `UPDATE system_settings 
     SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR)
     WHERE key_name = 'today_checkouts'`
  );
  const [[checkoutCounterRow]] = await connection.query(
    "SELECT value_val FROM system_settings WHERE key_name = 'today_checkouts'"
  );
  const todayCheckoutsAbsolute = Number(checkoutCounterRow.value_val);

  return { 
    bookingId: activeBooking.id, 
    roomId: room.id 
  };
};
