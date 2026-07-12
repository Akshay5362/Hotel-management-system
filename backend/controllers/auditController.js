import pool from '../db.js';

export const getStatus = async (req, res) => {
  try {
    const [settings] = await pool.query('SELECT * FROM system_settings');
    const settingsMap = {};
    settings.forEach(s => {
      settingsMap[s.key_name] = s.value_val;
    });

    const systemDate = settingsMap['system_date'] || '11-Jul-2026';
    const todayCheckins = parseInt(settingsMap['today_checkins'] || '0', 10);
    const todayCheckouts = parseInt(settingsMap['today_checkouts'] || '0', 10);
    const continuedRooms = parseInt(settingsMap['continued_rooms'] || '0', 10);

    const [rooms] = await pool.query('SELECT * FROM rooms');

    const [ledgerItems] = await pool.query('SELECT * FROM ledger_items');
    const ledgerMap = {};
    ledgerItems.forEach(item => {
      if (!ledgerMap[item.room_number]) {
        ledgerMap[item.room_number] = [];
      }
      ledgerMap[item.room_number].push({
        id: item.id,
        desc: item.desc,
        qty: item.qty,
        amount: item.amount
      });
    });

    const processedRooms = rooms.map(r => ({
      ...r,
      ledger: ledgerMap[r.number] || []
    }));

    const [cashLog] = await pool.query('SELECT * FROM cash_logs WHERE business_date = ?', [systemDate]);

    res.json({
      systemDate,
      todayCheckins,
      todayCheckouts,
      continuedRooms,
      rooms: processedRooms,
      cashLog
    });
  } catch (error) {
    console.error('Error in getStatus controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const runDayEnd = async (req, res) => {
  const { nextDate } = req.body;
  if (!nextDate) {
    return res.status(400).json({ error: 'Next business date is required' });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [occupiedRooms] = await connection.query("SELECT * FROM rooms WHERE status = 'occupied'");

    for (const room of occupiedRooms) {
      const tariff = room.rate;
      const taxes = Math.round(tariff * 0.12);

      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount) VALUES (?, ?, 1, ?)',
        [room.number, 'Room Tariff Charge (Rollover)', tariff]
      );
      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount) VALUES (?, ?, 1, ?)',
        [room.number, 'Taxes & GST (12%)', taxes]
      );
    }

    await connection.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'",
      [nextDate]
    );

    await connection.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'continued_rooms'",
      [String(occupiedRooms.length)]
    );

    await connection.query(
      "UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkins'"
    );
    await connection.query(
      "UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkouts'"
    );

    await connection.commit();
    res.json({ message: `Night audit complete. Business date rolled to ${nextDate}` });
  } catch (error) {
    await connection.rollback();
    console.error('Error in runDayEnd controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    connection.release();
  }
};
