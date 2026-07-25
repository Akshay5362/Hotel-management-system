import db from '../db.js';

export const getHousekeepingRooms = async (req, res) => {
  try {
    const query = `
      SELECT 
        r.id, r.number, r.type, r.status as occupancy_status,
        r.housekeeping_status, r.housekeeping_priority, r.last_cleaned_at,
        r.housekeeping_assigned_to, u.name as assigned_to_name,
        (SELECT name FROM guests g JOIN bookings b ON b.guest_id = g.id WHERE b.room_id = r.id AND b.booking_status = 'Checked In' LIMIT 1) as guest_name
      FROM rooms r
      LEFT JOIN users u ON r.housekeeping_assigned_to = u.id
      ORDER BY r.number ASC
    `;
    const [rows] = await db.query(query);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching housekeeping rooms:', error);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
};

export const assignHousekeeper = async (req, res) => {
  const { roomId, userId, priority } = req.body;
  const performedBy = req.user?.id || null;
  
  if (!roomId) return res.status(400).json({ error: 'Room ID is required' });

  try {
    const updateQuery = `
      UPDATE rooms 
      SET housekeeping_assigned_to = ?, housekeeping_priority = COALESCE(?, housekeeping_priority)
      WHERE id = ?
    `;
    await db.query(updateQuery, [userId || null, priority, roomId]);

    let staffName = 'Unassigned';
    if (userId) {
      const [uRows] = await db.query('SELECT name FROM users WHERE id = ?', [userId]);
      if (uRows.length > 0) staffName = uRows[0].name;
    }

    const action = userId ? `Assigned to ${staffName}` : 'Unassigned';
    await db.query(`
      INSERT INTO housekeeping_logs (room_id, action, performed_by, notes)
      VALUES (?, ?, ?, ?)
    `, [roomId, action, performedBy, priority ? `Priority updated to ${priority}` : null]);

    if (req.io) {
      req.io.emit('housekeeping_update', { roomId, action, userId, priority });
    }

    res.json({ success: true, message: 'Assignment updated successfully' });
  } catch (error) {
    console.error('Error assigning housekeeper:', error);
    res.status(500).json({ error: 'Failed to assign housekeeper' });
  }
};

export const updateHousekeepingStatus = async (req, res) => {
  const { roomId, status, notes } = req.body;
  const performedBy = req.user?.id || null;
  
  if (!roomId || !status) return res.status(400).json({ error: 'Room ID and status are required' });

  try {
    // Fetch current room data — NEVER touch occupancy status (rooms.status), only housekeeping_status
    const [roomRows] = await db.query(
      'SELECT r.number, r.housekeeping_status FROM rooms r WHERE r.id = ?',
      [roomId]
    );
    if (roomRows.length === 0) return res.status(404).json({ error: 'Room not found' });
    const oldHkStatus = roomRows[0].housekeeping_status;
    const roomNumber  = roomRows[0].number;

    // Resolve performer's name for the audit trail
    let performerName = 'System';
    if (performedBy) {
      const [userRows] = await db.query('SELECT name FROM users WHERE id = ?', [performedBy]);
      if (userRows.length > 0) performerName = userRows[0].name;
    }

    // Get business date
    const [settings] = await db.query(
      "SELECT value_val FROM system_settings WHERE key_name = 'system_date'"
    );
    const businessDate = settings[0]?.value_val || '25-Jul-2026';

    // Build update — only housekeeping_status is changed, occupancy status is never touched
    let updateFields = 'housekeeping_status = ?';
    const params = [status];
    
    if (status === 'Clean' || status === 'Inspected' || status === 'Vacant Ready') {
      updateFields += ', last_cleaned_at = CURRENT_TIMESTAMP';
    }

    await db.query(`UPDATE rooms SET ${updateFields} WHERE id = ?`, [...params, roomId]);

    // Housekeeping action log
    await db.query(`
      INSERT INTO housekeeping_logs (room_id, action, performed_by, notes)
      VALUES (?, ?, ?, ?)
    `, [roomId, `Status changed from ${oldHkStatus} to ${status}`, performedBy, notes || null]);

    // Req 3 (new): Structured audit log — consistent JSON format across all room status changes
    const structuredDetails = JSON.stringify({
      Room:             roomNumber,
      Occupancy_Before: 'unchanged',  // HK panel never modifies occupancy status
      Occupancy_After:  'unchanged',
      HK_Before:        oldHkStatus,
      HK_After:         status,
      User:             performerName,
      Business_Date:    businessDate
    });
    await db.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'HK_STATUS_CHANGE', ?, ?)`,
      [performedBy, structuredDetails, businessDate]
    );

    if (req.io) {
      req.io.emit('housekeeping_update', { roomId, status });
    }

    res.json({ success: true, message: 'Status updated successfully' });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
};

export const getHousekeepingLogs = async (req, res) => {
  const { roomId } = req.params;
  try {
    const query = `
      SELECT h.*, u.name as performed_by_name
      FROM housekeeping_logs h
      LEFT JOIN users u ON h.performed_by = u.id
      WHERE h.room_id = ?
      ORDER BY h.created_at DESC
    `;
    const [rows] = await db.query(query, [roomId]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching housekeeping logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
};
