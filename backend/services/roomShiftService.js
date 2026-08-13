import pool from '../db.js';
import { AvailabilityService } from './AvailabilityService.js';
import { isFirestoreDualWriteEnabled } from '../config/featureFlags.js';
import { enqueue } from './outboxService.js';
import { 
  createCompoundEventBuilder, 
  formatBookingId, 
  formatRoomId, 
  formatLedgerItemId 
} from './compoundEventBuilder.js';

/**
 * processRoomShift
 * 
 * Centralized business logic for Room Shifting.
 * Handles MySQL mutations and Firestore Outbox replication in a single transaction.
 */
export async function processRoomShift(connection, {
  fromRoomNumber,
  toRoomNumber,
  resolvedUserId
}) {
  // Lock source and target rooms in deterministic ID order to avoid deadlocks
  const [lockedRooms] = await connection.query(`
    SELECT r.*, rt.base_rate as rate, rt.code as type
    FROM rooms r
    JOIN room_types rt ON r.room_type_id = rt.id
    WHERE r.number IN (?, ?)
    ORDER BY r.id ASC
    FOR UPDATE
  `, [fromRoomNumber, toRoomNumber]);

  const sourceRoom = lockedRooms.find(r => r.number === fromRoomNumber);
  if (!sourceRoom || sourceRoom.status !== 'occupied') {
    const error = new Error(`Source Room ${fromRoomNumber} is not occupied`);
    error.status = 400;
    throw error;
  }

  const targetRoom = lockedRooms.find(r => r.number === toRoomNumber);
  if (!targetRoom || targetRoom.status !== 'vacant') {
    const error = new Error(`Target Room ${toRoomNumber} is not vacant`);
    error.status = 400;
    throw error;
  }

  // Get current business date
  const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
  const businessDate = settings[0]?.value_val || '11-Jul-2026';

  // Find the active check-in booking first to get checkout date
  const [bookings] = await connection.query(
    "SELECT * FROM bookings WHERE room_id = ? AND booking_status = 'Checked In' FOR UPDATE",
    [sourceRoom.id]
  );
  if (bookings.length === 0) {
    const error = new Error(`No active checkin found for Room ${fromRoomNumber}`);
    error.status = 400;
    throw error;
  }
  const booking = bookings[0];

  // Validate target room availability using AvailabilityService
  const avail = await AvailabilityService.checkRoomAvailability(connection, {
    roomId: targetRoom.id,
    roomNumber: toRoomNumber,
    arrivalDate: businessDate,
    // Use the booking's actual checkout date, or if it's somehow missing/same, just use a dummy future date
    departureDate: booking.check_out_date && booking.check_out_date !== businessDate ? booking.check_out_date : '31-Dec-2099',
    forUpdate: true
  });
  
  if (!avail.available && avail.code !== 'ROOM_OCCUPIED_BOOKING') {
    const error = new Error(`Target Room ${toRoomNumber} is not available for shift: ${avail.reason}`);
    error.status = 400;
    throw error;
  }

  // Update booking room_id
  await connection.query(
    "UPDATE bookings SET room_id = ? WHERE id = ?",
    [targetRoom.id, booking.id]
  );

  // Update room statuses
  await connection.query("UPDATE rooms SET status = 'occupied' WHERE id = ?", [targetRoom.id]);
  await connection.query("UPDATE rooms SET status = 'vacant' WHERE id = ?", [sourceRoom.id]);

  // Delete current business date's tariff/tax from source room
  await connection.query(
    `DELETE FROM ledger_items 
     WHERE room_number = ? AND business_date = ? AND (\`desc\` LIKE '%Tariff%' OR \`desc\` LIKE '%Taxes%')`,
    [fromRoomNumber, businessDate]
  );

  // Move all ledger items of this booking to the target room number
  await connection.query(
    'UPDATE ledger_items SET room_number = ? WHERE booking_id = ?',
    [toRoomNumber, booking.id]
  );

  // Insert target room's tariff for the current business date (GST included in rate)
  const targetTariff = targetRoom.rate;
  const [tariffResult] = await connection.query(
    'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
    [toRoomNumber, `Room Tariff — ${targetRoom.type} (Incl. GST)`, targetTariff, businessDate, booking.id]
  );
  const tariffMysqlId = tariffResult.insertId;

  // Log Room Status History for source room
  await connection.query(
    `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
     VALUES (?, 'occupied', 'vacant', ?, ?)`,
    [sourceRoom.id, resolvedUserId, businessDate]
  );

  // Log Room Status History for target room
  await connection.query(
    `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
     VALUES (?, 'vacant', 'occupied', ?, ?)`,
    [targetRoom.id, resolvedUserId, businessDate]
  );

  // Insert Audit Log entry
  await connection.query(
    `INSERT INTO audit_logs (user_id, action, details, business_date)
     VALUES (?, 'SHIFT_ROOM', ?, ?)`,
    [resolvedUserId, `Shifted guest reservation (Booking ID: ${booking.id}) from Room ${fromRoomNumber} to ${toRoomNumber}`, businessDate]
  );

  // ============================================================
  // COMPOUND OUTBOX GENERATION (Dual Write)
  // ============================================================
  if (isFirestoreDualWriteEnabled()) {
    // 1. Re-query all affected ledger items for the booking to capture final state and IDs
    const [affectedLedgers] = await connection.query(
      'SELECT id, room_number, `desc`, qty, amount, business_date, booking_id FROM ledger_items WHERE booking_id = ?',
      [booking.id]
    );

    const bkgDocId = formatBookingId(booking.id);
    const oldRoomDocId = formatRoomId(fromRoomNumber);
    const newRoomDocId = formatRoomId(toRoomNumber);

    const builder = createCompoundEventBuilder({
      event_type: 'COMPOUND_ROOM_SHIFT',
      aggregate_type: 'BOOKING',
      aggregate_id: bkgDocId
    });

    // Write 1: Booking
    builder.addRootWrite({
      collection: 'bookings',
      document_id: bkgDocId,
      operation: 'set_merge',
      data: {
        room_id: targetRoom.id,
        room_number: toRoomNumber
      }
    });

    // Write 2: Old Room
    builder.addRootWrite({
      collection: 'rooms',
      document_id: oldRoomDocId,
      operation: 'set_merge',
      data: {
        status: 'vacant',
        current_booking_id: '' // Cleared upon shifting out
      }
    });

    // Write 3: New Room
    builder.addRootWrite({
      collection: 'rooms',
      document_id: newRoomDocId,
      operation: 'set_merge',
      data: {
        status: 'occupied',
        current_booking_id: bkgDocId
      }
    });

    // Writes 4...N: Ledger Items (Root + Subcollection dual write)
    for (const ledger of affectedLedgers) {
      const ledgerDocId = formatLedgerItemId(ledger.id);
      builder.addDualWrite({
        rootCollection: 'ledger_items',
        document_id: ledgerDocId,
        parentCollection: 'bookings',
        parent_id: bkgDocId,
        subcollection: 'ledger_items',
        operation: 'set_merge',
        data: {
          item_id: ledgerDocId,
          mysql_ledger_id: ledger.id,
          booking_id: bkgDocId,
          mysql_booking_id: booking.id,
          room_number: ledger.room_number,
          description: ledger.desc,
          desc: ledger.desc, // schema compat
          qty: ledger.qty,
          quantity: ledger.qty, // schema compat
          amount: ledger.amount,
          business_date: ledger.business_date
        }
      });
    }

    const payload = builder.build();

    // Batch Size Guard
    const FIRESTORE_MAX_BATCH_OPS = process.env.FIRESTORE_MAX_BATCH_OPS || 500;
    if (payload.writes.length > FIRESTORE_MAX_BATCH_OPS) {
      const error = new Error(`Compound event exceeds maximum batch limit (writes: ${payload.writes.length})`);
      error.status = 500;
      throw error; // Safe failure, rolls back MySQL transaction
    }

    // Enqueue
    await enqueue(connection, {
      event_type: payload.event_type,
      aggregate_type: payload.aggregate_type,
      aggregate_id: payload.aggregate_id,
      payload
    });
  }

  return { booking, targetRoom };
}
