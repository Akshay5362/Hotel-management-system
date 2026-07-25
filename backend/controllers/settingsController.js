import pool from '../db.js';
import { RoomStatusService } from '../services/roomStatusService.js';
import { hasPermission } from './authController.js';

export const getBusinessDateInfo = async (req, res) => {
  try {
    const [settings] = await pool.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || null;

    if (!businessDate) {
      console.error('[CRITICAL] system_settings.system_date is missing from database.');
      return res.status(500).json({ error: 'System configuration error: Business Date is missing. Please contact administrator.' });
    }

    const [logs] = await pool.query(`
      SELECT created_at 
      FROM audit_logs 
      WHERE action = 'DAY_END' 
      ORDER BY created_at DESC 
      LIMIT 1
    `);
    const lastDayEnd = logs.length > 0 ? logs[0].created_at : null;

    // Fetch room statuses to calculate stats
    const processedRooms = await RoomStatusService.getRoomStatuses(pool, businessDate);
    
    let occupiedRooms = 0;
    let bookedRooms = 0;
    let dirtyRooms = 0;
    let pendingCheckouts = 0;

    const bDateObj = new Date(businessDate);
    bDateObj.setHours(0, 0, 0, 0);

    for (const room of processedRooms) {
      if (room.status === 'occupied') {
        occupiedRooms++;
        
        // Check if expected checkout is today or earlier
        if (room.expectedCheckOutDate) {
          const expDateObj = new Date(room.expectedCheckOutDate);
          expDateObj.setHours(0, 0, 0, 0);
          if (expDateObj <= bDateObj) {
            pendingCheckouts++;
          }
        }
      } else if (room.status === 'booked') {
        bookedRooms++;
      }
      
      if (room.housekeeping_status === 'Dirty') {
        dirtyRooms++;
      }
    }

    res.json({
      businessDate,
      systemDate: new Date().toISOString(),
      lastDayEnd,
      stats: {
        occupiedRooms,
        bookedRooms,
        dirtyRooms,
        pendingCheckouts
      }
    });
  } catch (error) {
    console.error('Error fetching business date info:', error);
    res.status(500).json({ error: 'Failed to fetch business date information.' });
  }
};

export const updateBusinessDate = async (req, res) => {
  const { newDate, reason } = req.body;
  const adminId = req.user?.id;
  const username = req.user?.username;
  const role = req.user?.role;
  const clientIp = req.ip || req.connection.remoteAddress;

  if (!newDate || !reason) {
    return res.status(400).json({ error: 'New date and reason are required.' });
  }

  if (!/^\d{2}-[A-Z][a-z]{2}-\d{4}$/.test(newDate)) {
    return res.status(400).json({ error: 'Invalid date format. Expected DD-Mon-YYYY' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    
    // Acquire a NOWAIT lock on system_settings to prevent modification if Day End is running
    // If Day End is running, it will have locked the rows and this will throw an error immediately
    try {
      await connection.query('SELECT value_val FROM system_settings WHERE key_name = ? FOR UPDATE NOWAIT', ['system_date']);
    } catch (lockError) {
      // ER_LOCK_NOWAIT (3572) or ER_LOCK_DEADLOCK (1213)
      if (lockError.code === 'ER_LOCK_NOWAIT' || lockError.code === 'ER_LOCK_DEADLOCK') {
        return res.status(409).json({ error: 'Cannot modify Business Date. A Day End / Night Audit process is currently running.' });
      }
      throw lockError;
    }

    await connection.beginTransaction();

    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const oldDate = settings[0]?.value_val;

    if (!oldDate) {
      throw new Error('System configuration error: Business Date is missing.');
    }

    const dOld = new Date(oldDate);
    const dNew = new Date(newDate);
    dOld.setHours(0, 0, 0, 0);
    dNew.setHours(0, 0, 0, 0);

    const canModify = await hasPermission(req, 'modify_business_date');
    if (!canModify) {
      await connection.rollback();
      return res.status(403).json({ error: 'You do not have permission to modify the business date.' });
    }

    const canOverride = await hasPermission(req, 'override_business_date');

    // Prevent backwards time travel unless Super Admin
    if (dNew < dOld && !canOverride) {
      await connection.rollback();
      return res.status(403).json({ error: 'Business Date cannot be moved backwards. Only a Super Administrator can bypass this restriction.' });
    }

    await connection.query(
      'UPDATE system_settings SET value_val = ? WHERE key_name = ?',
      [newDate, 'system_date']
    );

    const auditDetails = `Manual Business Date change via override. Old: ${oldDate}, New: ${newDate}`;
    
    await connection.query(
      `INSERT INTO audit_logs (
        user_id, action, details, business_date, 
        previous_business_date, new_business_date, reason, 
        username, role, client_ip, application_version
      ) VALUES (?, 'MANUAL_DATE_CHANGE', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        adminId, auditDetails, newDate,
        oldDate, newDate, reason,
        username || null, role || null, clientIp || null, '1.0.0'
      ]
    );

    await connection.commit();
    res.json({ message: 'Business Date updated successfully.', newDate });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error updating business date:', error);
    res.status(500).json({ error: 'Failed to update business date.' });
  } finally {
    if (connection) connection.release();
  }
};
