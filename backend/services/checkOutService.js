import { BusinessDateService } from './businessDateService.js';
import { CheckoutRecoveryService } from './CheckoutRecoveryService.js';
import { formatTime } from '../utils/dateUtils.js';
import { isFirestoreDualWriteEnabled } from '../config/featureFlags.js';
import { enqueue } from './outboxService.js';
import {
  createCompoundEventBuilder,
  formatBookingId,
  formatRoomId,
  formatPaymentId,
  formatCashLogId,
  formatHistoryId,
  formatInvoiceId
} from './compoundEventBuilder.js';

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

  // Update Room Status History
  await connection.query(
    `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
     VALUES (?, 'occupied', 'dirty', ?, ?)`,
    [room.id, resolvedUserId, businessDate]
  );

  // Insert Audit Log entry
  await connection.query(
    `INSERT INTO audit_logs (user_id, action, details, business_date)
     VALUES (?, 'CHECK_OUT', ?, ?)`,
    [resolvedUserId, `Checked out Room ${number}. Booking ID: ${activeBooking.id}. Balance paid: ₹${parsedBalancePaid}`, businessDate]
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
    [activeBooking.id, room.id, room.id, resolvedUserId, businessDate,
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

  // ── Phase 1: Snapshot capture (immediately before commit) ─────────────────
  // Stores an immutable copy of all checkout state for future Undo support.
  // A snapshot failure is caught inside createSnapshot() — checkout proceeds.
  const [ledgerItemsForSnapshot] = await connection.query(
    'SELECT * FROM ledger_items WHERE booking_id = ? ORDER BY id ASC',
    [activeBooking.id]
  );

  // ── Phase 4E-B4: Compound Outbox Event ──────────────────────────────────────
  if (isFirestoreDualWriteEnabled()) {
    const eventOccurredAt = new Date().toISOString();
    const bkgDocId = formatBookingId(activeBooking.booking_number);
    const roomDocId = formatRoomId(room.number);
    const invoiceDocId = formatInvoiceId(invoiceNumber);
    const historyDocId = formatHistoryId(historyMysqlId);

    const builder = createCompoundEventBuilder({
      event_type:     'COMPOUND_CHECK_OUT',
      aggregate_type: 'BOOKING',
      aggregate_id:   activeBooking.booking_number,
      operation_id:   `op_checkout_${activeBooking.booking_number}_${activeBooking.id}`,
      occurred_at:    eventOccurredAt,
      business_date:  businessDate
    });

    // 1. Booking document (root)
    builder.addRootWrite({
      collection:  'bookings',
      document_id: bkgDocId,
      operation:   'set_merge',
      data: {
        booking_status: 'Checked Out',
        payment_status: 'Paid',
        total_amount:   totalCollected,
        check_out_date: businessDate,
        updated_at:     eventOccurredAt
      }
    });

    // 2. Room document (root)
    builder.addRootWrite({
      collection:  'rooms',
      document_id: roomDocId,
      operation:   'set_merge',
      data: {
        status:              'dirty',
        housekeeping_status: 'Dirty',
        housekeeping_priority: 'High Priority',
        updated_at:          eventOccurredAt
      }
    });

    // 3. Invoice document (root)
    builder.addRootWrite({
      collection:  'invoices',
      document_id: invoiceDocId,
      operation:   'set_merge',
      data: {
        invoice_number: invoiceNumber,
        booking_id:     bkgDocId,
        mysql_booking_id: activeBooking.id,
        total_amount:   totalCollected,
        paid_amount:    totalCollected,
        balance_due:    0,
        status:         'Paid',
        invoice_status: 'Paid',
        business_date:  businessDate,
        updated_at:     eventOccurredAt
      }
    });

    // 4+5. Booking History (dual write)
    const historyData = {
      history_id:       historyDocId,
      booking_id:       bkgDocId,
      mysql_booking_id: activeBooking.id,
      action:           'CHECKED_OUT',
      details:          `Checkout settled. Total collected: ₹${totalCollected}. Payment status: Paid.`,
      changed_by:       resolvedUserId ? String(resolvedUserId) : null,
      mysql_changed_by: resolvedUserId || null,
      business_date:    businessDate,
      mysql_history_id: historyMysqlId,
      created_at:       eventOccurredAt
    };
    builder.addDualWrite({
      rootCollection:   'booking_history',
      document_id:       historyDocId,
      parentCollection:  'bookings',
      parent_id:         bkgDocId,
      subcollection:     'history',
      operation:         'set_merge',
      data:              historyData
    });

    // 6. Payment (dual write, conditional)
    if (parsedBalancePaid !== 0) {
      const paymentDocId = formatPaymentId(paymentMysqlId);
      const paymentData = {
        payment_id:       paymentDocId,
        booking_id:       bkgDocId,
        mysql_booking_id: activeBooking.id,
        amount:           Math.abs(parsedBalancePaid),
        payment_method:   'Cash',
        payment_status:   'Completed',
        payment_type:     parsedBalancePaid > 0 ? 'Checkout Settlement' : 'Checkout Refund',
        business_date:    businessDate,
        mysql_payment_id: paymentMysqlId,
        created_at:       eventOccurredAt
      };
      builder.addDualWrite({
        rootCollection:   'payments',
        document_id:       paymentDocId,
        parentCollection:  'bookings',
        parent_id:         bkgDocId,
        subcollection:     'payments',
        operation:         'set_merge',
        data:              paymentData
      });

      // 7. Cash Log (root only, conditional)
      const cashLogDocId = formatCashLogId(cashLogMysqlId);
      builder.addRootWrite({
        collection:  'cash_logs',
        document_id: cashLogDocId,
        operation:   'set_merge',
        data: {
          log_id:           cashLogDocId,
          amount:           Math.abs(parsedBalancePaid),
          type:             parsedBalancePaid > 0 ? 'Checkout Settlement' : 'Checkout Refund',
          category:         'Room Payment',
          description:      `Checkout for ${number} — ${activeBooking.guestName}`,
          booking_id:       bkgDocId,
          mysql_booking_id: activeBooking.id,
          business_date:    businessDate,
          mysql_cash_log_id: cashLogMysqlId,
          created_at:       eventOccurredAt
        }
      });
    }

    // 8. Settings Counter
    builder.addRootWrite({
      collection:  'settings',
      document_id: 'system_date',
      operation:   'set_merge',
      data: {
        today_checkouts: todayCheckoutsAbsolute
      }
    });

    // 9. Checkout Snapshot (root only)
    const snapshotDocId = `snap_${bkgDocId}`;
    const bookingSnapshot = {
      ...activeBooking,
      _snapshotVersion: 1,
      _capturedAt: eventOccurredAt,
      _totalCollected: totalCollected,
      _businessDate: businessDate,
    };
    const roomSnapshot = {
      ...room,
      _snapshotVersion: 1,
      _capturedAt: eventOccurredAt,
    };
    const invoiceSnapshot = {
      invoice_number: invoiceNumber,
      booking_id: activeBooking.id,
      total_amount: totalCollected,
      paid_amount: totalCollected,
      balance_due: 0,
      status: 'Paid',
      business_date: businessDate,
      _snapshotVersion: 1,
      _capturedAt: eventOccurredAt,
    };
    const ledgerSnapshot = {
      items: ledgerItemsForSnapshot,
      _snapshotVersion: 1,
      _capturedAt: eventOccurredAt,
      _count: ledgerItemsForSnapshot.length,
    };
    const paymentSnapshot = paymentMysqlId ? {
      id: paymentMysqlId,
      booking_id: activeBooking.id,
      amount: Math.abs(parsedBalancePaid),
      payment_method: 'Cash',
      payment_type: parsedBalancePaid > 0 ? 'Checkout Settlement' : 'Checkout Refund',
      business_date: businessDate,
      _snapshotVersion: 1,
      _capturedAt: eventOccurredAt,
    } : { _snapshotVersion: 1, _capturedAt: eventOccurredAt };

    const snapshotData = JSON.stringify({
      bookingSnapshot: JSON.stringify(bookingSnapshot),
      roomSnapshot: JSON.stringify(roomSnapshot),
      invoiceSnapshot: JSON.stringify(invoiceSnapshot),
      ledgerSnapshot: JSON.stringify(ledgerSnapshot),
      paymentSnapshot: JSON.stringify(paymentSnapshot)
    });

    builder.addRootWrite({
      collection:  'checkout_snapshots',
      document_id: snapshotDocId,
      operation:   'set_merge',
      data: {
        snapshot_id:      snapshotDocId,
        booking_id:       bkgDocId,
        mysql_booking_id: activeBooking.id,
        snapshot_data:    snapshotData,
        created_at:       eventOccurredAt
      }
    });

    const compoundPayload = builder.build();

    await enqueue(connection, {
      event_type:     compoundPayload.event_type,
      aggregate_type: compoundPayload.aggregate_type,
      aggregate_id:   compoundPayload.aggregate_id,
      payload:        compoundPayload
    });

    console.log(`[checkOutService] Compound outbox event enqueued: ${compoundPayload.operation_id} (${compoundPayload.writes.length} writes)`);
  }

  await CheckoutRecoveryService.createSnapshot(connection, {
    bookingId:      activeBooking.id,
    roomId:         room.id,
    guestId:        activeBooking.guest_id,
    userId:         resolvedUserId,
    room,
    booking:        activeBooking,
    ledgerItems:    ledgerItemsForSnapshot,
    totalCollected,
    businessDate,
  });

  return { 
    bookingId: activeBooking.id, 
    roomId: room.id 
  };
};
