import db from '../db.js';
import { BusinessDateService } from '../services/businessDateService.js';
import { enqueue } from '../services/outboxService.js';
import { isFirestoreDualWriteEnabled } from '../config/featureFlags.js';

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

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [roomRows] = await connection.query('SELECT number FROM rooms WHERE id = ?', [roomId]);
    const roomNumber = roomRows.length > 0 ? roomRows[0].number : String(roomId);

    const updateQuery = `
      UPDATE rooms 
      SET housekeeping_assigned_to = ?, housekeeping_priority = COALESCE(?, housekeeping_priority)
      WHERE id = ?
    `;
    await connection.query(updateQuery, [userId || null, priority, roomId]);

    let staffName = 'Unassigned';
    if (userId) {
      const [uRows] = await connection.query('SELECT fullName as name FROM users WHERE id = ?', [userId]);
      if (uRows.length > 0) staffName = uRows[0].name;
    }

    const action = userId ? `Assigned to ${staffName}` : 'Unassigned';
    const [logResult] = await connection.query(`
      INSERT INTO housekeeping_logs (room_id, action, performed_by, notes)
      VALUES (?, ?, ?, ?)
    `, [roomId, action, performedBy, priority ? `Priority updated to ${priority}` : null]);

    if (isFirestoreDualWriteEnabled()) {
      await enqueue(connection, {
        event_type: 'HOUSEKEEPING_LOG_CREATED',
        aggregate_type: 'HOUSEKEEPING',
        aggregate_id: String(roomNumber),
        payload: {
          room_id: String(roomId),
          room_number: String(roomNumber),
          action: action,
          assigned_to: userId ? String(userId) : null,
          priority: priority || 'Normal',
          mysql_housekeeping_id: logResult.insertId,
          updated_at: new Date().toISOString()
        }
      });
    }

    await connection.commit();

    if (req.io) {
      req.io.emit('housekeeping_update', { roomId, action, userId, priority });
    }

    res.json({ success: true, message: 'Assignment updated successfully' });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) {}
    }
    console.error('Error assigning housekeeper:', error);
    res.status(500).json({ error: 'Failed to assign housekeeper' });
  } finally {
    if (connection) connection.release();
  }
};

export const updateHousekeepingStatus = async (req, res) => {
  const { roomId, status, notes } = req.body;
  const performedBy = req.user?.id || null;
  
  if (!roomId || !status) return res.status(400).json({ error: 'Room ID and status are required' });

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Fetch current room data — NEVER touch occupancy status (rooms.status), only housekeeping_status
    const [roomRows] = await connection.query(
      'SELECT r.number, r.housekeeping_status FROM rooms r WHERE r.id = ?',
      [roomId]
    );
    if (roomRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Room not found' });
    }
    const oldHkStatus = roomRows[0].housekeeping_status;
    const roomNumber  = roomRows[0].number;

    // Resolve performer's name for the audit trail
    let performerName = 'System';
    if (performedBy) {
      const [userRows] = await connection.query('SELECT fullName as name FROM users WHERE id = ?', [performedBy]);
      if (userRows.length > 0) performerName = userRows[0].name;
    }

    // Get business date
    const businessDate = await BusinessDateService.getBusinessDate(connection);

    // Build update — only housekeeping_status is changed, occupancy status is never touched
    let updateFields = 'housekeeping_status = ?';
    const params = [status];
    
    if (status === 'Clean' || status === 'Inspected' || status === 'Vacant Ready') {
      updateFields += ', last_cleaned_at = CURRENT_TIMESTAMP';
    }

    await connection.query(`UPDATE rooms SET ${updateFields} WHERE id = ?`, [...params, roomId]);

    // Housekeeping action log
    const [logResult] = await connection.query(`
      INSERT INTO housekeeping_logs (room_id, action, performed_by, notes)
      VALUES (?, ?, ?, ?)
    `, [roomId, `Status changed from ${oldHkStatus} to ${status}`, performedBy, notes || null]);

    // Structured audit log
    const structuredDetails = JSON.stringify({
      Room:             roomNumber,
      Occupancy_Before: 'unchanged',
      Occupancy_After:  'unchanged',
      HK_Before:        oldHkStatus,
      HK_After:         status,
      User:             performerName,
      Business_Date:    businessDate
    });
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'HK_STATUS_CHANGE', ?, ?)`,
      [performedBy, structuredDetails, businessDate]
    );

    // Enqueue Transactional Outbox Event if feature flag enabled
    if (isFirestoreDualWriteEnabled()) {
      await enqueue(connection, {
        event_type: 'ROOM_STATUS_CHANGED',
        aggregate_type: 'ROOM',
        aggregate_id: String(roomNumber),
        payload: {
          number: String(roomNumber),
          room_number: String(roomNumber),
          housekeeping_status: status,
          cleaning_status: status,
          updated_at: new Date().toISOString()
        }
      });

      await enqueue(connection, {
        event_type: 'HOUSEKEEPING_STATUS_UPDATED',
        aggregate_type: 'HOUSEKEEPING',
        aggregate_id: String(roomNumber),
        payload: {
          room_id: String(roomId),
          room_number: String(roomNumber),
          status: status,
          notes: notes || null,
          performed_by: performerName,
          mysql_housekeeping_id: logResult.insertId,
          updated_at: new Date().toISOString()
        }
      });
    }

    await connection.commit();

    if (req.io) {
      req.io.emit('housekeeping_update', { roomId, status });
    }

    res.json({ success: true, message: 'Status updated successfully' });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) {}
    }
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  } finally {
    if (connection) connection.release();
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
