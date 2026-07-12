import pool from '../db.js';

// Helper to format time (e.g. 09:30 AM)
function formatTime(date) {
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 should be 12
  return `${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
}

export const checkIn = async (req, res) => {
  const { number } = req.params;
  const { guestName, phone, pax, deposit, checkInDate } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Check if room exists and is vacant
    const [roomRows] = await connection.query('SELECT * FROM rooms WHERE number = ?', [number]);
    if (roomRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `Room ${number} not found` });
    }

    const room = roomRows[0];
    if (room.status !== 'vacant') {
      await connection.rollback();
      return res.status(400).json({ error: `Room ${number} is not vacant` });
    }

    const guestNameUpper = (guestName || '').toUpperCase();

    // Update room status and details
    await connection.query(
      `UPDATE rooms 
       SET status = 'occupied', guestName = ?, phone = ?, pax = ?, deposit = ?, checkInDate = ?
       WHERE number = ?`,
      [guestNameUpper, phone || '', pax || 1, deposit || 0, checkInDate || '', number]
    );

    // Add initial ledger entries (Room Tariff Charge and Taxes)
    const tariffAmount = room.rate;
    const taxesAmount = Math.round(tariffAmount * 0.12);

    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount) VALUES (?, ?, 1, ?)',
      [number, 'Room Tariff Charge', tariffAmount]
    );
    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount) VALUES (?, ?, 1, ?)',
      [number, 'Taxes & GST (12%)', taxesAmount]
    );

    // Get current business date
    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    // Insert cash log transaction if advance deposit paid
    if (deposit > 0) {
      const timeStr = formatTime(new Date());
      await connection.query(
        `INSERT INTO cash_logs (time, room, guest, type, amount, business_date)
         VALUES (?, ?, ?, 'Advance Deposit', ?, ?)`,
        [timeStr, number, guestNameUpper, deposit, businessDate]
      );
    }

    // Increment todayCheckins count
    await connection.query(
      `UPDATE system_settings 
       SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR)
       WHERE key_name = 'today_checkins'`
    );

    await connection.commit();
    res.json({ message: `Successfully checked in to Room ${number}` });
  } catch (error) {
    await connection.rollback();
    console.error('Error during checkin controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    connection.release();
  }
};

export const checkOut = async (req, res) => {
  const { number } = req.params;
  const { balancePaid } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Check if room is occupied
    const [roomRows] = await connection.query('SELECT * FROM rooms WHERE number = ?', [number]);
    if (roomRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `Room ${number} not found` });
    }

    const room = roomRows[0];
    if (room.status !== 'occupied') {
      await connection.rollback();
      return res.status(400).json({ error: `Room ${number} is not occupied` });
    }

    // Fetch system settings for business date
    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    // Insert cash log transaction if there's any transaction amount
    if (balancePaid !== 0) {
      const timeStr = formatTime(new Date());
      const transactionType = balancePaid > 0 ? 'Checkout Settlement' : 'Checkout Refund';
      await connection.query(
        `INSERT INTO cash_logs (time, room, guest, type, amount, business_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [timeStr, number, room.guestName, transactionType, Math.abs(balancePaid), businessDate]
      );
    }

    // Reset room fields and set status to dirty
    await connection.query(
      `UPDATE rooms 
       SET status = 'dirty', guestName = '', phone = '', pax = 0, deposit = 0, checkInDate = ''
       WHERE number = ?`,
      [number]
    );

    // Remove ledger items
    await connection.query('DELETE FROM ledger_items WHERE room_number = ?', [number]);

    // Increment todayCheckouts count
    await connection.query(
      `UPDATE system_settings 
       SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR)
       WHERE key_name = 'today_checkouts'`
    );

    await connection.commit();
    res.json({ message: `Successfully checked out Room ${number}` });
  } catch (error) {
    await connection.rollback();
    console.error('Error during checkout controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    connection.release();
  }
};

export const clean = async (req, res) => {
  const { number } = req.params;

  try {
    const [result] = await pool.query(
      `UPDATE rooms SET status = 'vacant' WHERE number = ? AND status = 'dirty'`,
      [number]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ error: `Room ${number} is not dirty or does not exist` });
    }

    res.json({ message: `Room ${number} marked as CLEAN and vacant` });
  } catch (error) {
    console.error('Error during cleaning controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const addLedgerItem = async (req, res) => {
  const { number } = req.params;
  const { desc, amount } = req.body;

  if (!desc || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid charge description or amount' });
  }

  try {
    const [rooms] = await pool.query('SELECT status FROM rooms WHERE number = ?', [number]);
    if (rooms.length === 0 || rooms[0].status !== 'occupied') {
      return res.status(400).json({ error: 'Charges can only be posted to occupied rooms' });
    }

    await pool.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount) VALUES (?, ?, 1, ?)',
      [number, desc, amount]
    );

    res.json({ message: `Posted ${desc} of ₹${amount} to Room ${number}` });
  } catch (error) {
    console.error('Error posting ledger charge controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const shift = async (req, res) => {
  const { fromRoomNumber, toRoomNumber } = req.body;

  if (!fromRoomNumber || !toRoomNumber) {
    return res.status(400).json({ error: 'Source and target room numbers are required' });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [fromRooms] = await connection.query('SELECT * FROM rooms WHERE number = ?', [fromRoomNumber]);
    if (fromRooms.length === 0 || fromRooms[0].status !== 'occupied') {
      await connection.rollback();
      return res.status(400).json({ error: `Source Room ${fromRoomNumber} is not occupied` });
    }
    const sourceRoom = fromRooms[0];

    const [toRooms] = await connection.query('SELECT * FROM rooms WHERE number = ?', [toRoomNumber]);
    if (toRooms.length === 0 || toRooms[0].status !== 'vacant') {
      await connection.rollback();
      return res.status(400).json({ error: `Target Room ${toRoomNumber} is not vacant` });
    }
    const targetRoom = toRooms[0];

    // Move guest registry details to target room
    await connection.query(
      `UPDATE rooms 
       SET status = 'occupied', guestName = ?, phone = ?, pax = ?, deposit = ?, checkInDate = ?
       WHERE number = ?`,
      [sourceRoom.guestName, sourceRoom.phone, sourceRoom.pax, sourceRoom.deposit, sourceRoom.checkInDate, toRoomNumber]
    );

    // Reset source room to vacant
    await connection.query(
      `UPDATE rooms 
       SET status = 'vacant', guestName = '', phone = '', pax = 0, deposit = 0, checkInDate = ''
       WHERE number = ?`,
      [fromRoomNumber]
    );

    // Move and adjust ledger items
    await connection.query(
      `DELETE FROM ledger_items 
       WHERE room_number = ? AND (\`desc\` LIKE '%Tariff%' OR \`desc\` LIKE '%Taxes%')`,
      [fromRoomNumber]
    );

    await connection.query(
      'UPDATE ledger_items SET room_number = ? WHERE room_number = ?',
      [toRoomNumber, fromRoomNumber]
    );

    const targetTariff = targetRoom.rate;
    const targetTaxes = Math.round(targetTariff * 0.12);

    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount) VALUES (?, ?, 1, ?)',
      [toRoomNumber, `Room Tariff (${targetRoom.type})`, targetTariff]
    );
    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount) VALUES (?, ?, 1, ?)',
      [toRoomNumber, 'Taxes & GST (12%)', targetTaxes]
    );

    await connection.commit();
    res.json({ message: `Successfully shifted guest from Room ${fromRoomNumber} to ${toRoomNumber}` });
  } catch (error) {
    await connection.rollback();
    console.error('Error during room shifting controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    connection.release();
  }
};
