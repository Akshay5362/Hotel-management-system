/**
 * housekeepingCutoverService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cutover Service for Housekeeping Management Master Data.
 * Routes operations to Firestore when USE_FIRESTORE_HOUSEKEEPING=true.
 * Provides safe fail-closed error handling without silent MySQL fallback.
 */

import pool from '../db.js';
import { db as firestoreDb } from '../config/firebaseAdmin.js';
import { isFirestoreHousekeepingEnabled } from '../config/featureFlags.js';
import { BusinessDateService } from './businessDateService.js';
import {
  getAllHousekeepingFirestore,
  getHousekeepingByRoomFirestore,
  createHousekeepingRecordFirestore,
  updateHousekeepingRecordFirestore
} from '../repositories/firestore/housekeepingRepository.js';
import {
  getAllRoomsFirestore,
  getRoomByIdFirestore,
  updateRoomFirestore
} from '../repositories/firestore/roomsRepository.js';

export class HousekeepingCutoverService {

  static async getHousekeepingRooms() {
    if (isFirestoreHousekeepingEnabled()) {
      try {
        const rooms = await getAllRoomsFirestore();
        if (Array.isArray(rooms)) {
          const formatted = rooms.map(r => ({
            id: r.id || r.mysql_room_id || r.docId,
            number: String(
              r.number ||
              r.room_number ||
              r.roomNumber ||
              r.room_no ||
              (r.id ? String(r.id).replace(/^room_/, '') : '') ||
              (r.docId ? String(r.docId).replace(/^room_/, '') : '') ||
              ''
            ).trim(),
            type: r.type || r.room_type || 'DELUXE',
            occupancy_status: r.status || r.occupancy_status || 'vacant',
            housekeeping_status: r.housekeeping_status || (r.status === 'dirty' ? 'Dirty' : 'Clean'),
            housekeeping_priority: r.housekeeping_priority || 'Normal',
            last_cleaned_at: r.last_cleaned_at || null,
            housekeeping_assigned_to: r.housekeeping_assigned_to || null,
            assigned_to_name: r.assigned_to_name || null,
            guest_name: r.guest_name || null
          }));
          formatted.sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10));
          return formatted;
        }
      } catch (err) {
        console.error('[FAIL_CLOSED:HOUSEKEEPING] Firestore getHousekeepingRooms failed:', err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    const query = `
      SELECT 
        r.id, r.number, COALESCE(rt.code, 'DELUXE') as type, r.status as occupancy_status,
        r.housekeeping_status, r.housekeeping_priority, r.last_cleaned_at,
        r.housekeeping_assigned_to, s.full_name as assigned_to_name,
        (SELECT full_name FROM guests g JOIN bookings b ON b.guest_id = g.id WHERE b.room_id = r.id AND b.booking_status = 'Checked In' LIMIT 1) as guest_name
      FROM rooms r
      LEFT JOIN room_types rt ON r.room_type_id = rt.id
      LEFT JOIN staff s ON r.housekeeping_assigned_to = s.id
      ORDER BY CAST(r.number AS UNSIGNED) ASC
    `;
    const [rows] = await pool.query(query);
    return rows;
  }

  static async assignHousekeeper({ roomId, userId, priority, performedBy, io }) {
    if (isFirestoreHousekeepingEnabled()) {
      try {
        const room = await getRoomByIdFirestore(roomId);
        if (!room) {
          const notFoundErr = new Error('Room not found');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        const roomNumber = String(room.number);
        const action = userId ? `Assigned to ${userId}` : 'Unassigned';

        await updateRoomFirestore(room.docId || roomId, {
          housekeeping_assigned_to: userId ? String(userId) : null,
          housekeeping_priority: priority || room.housekeeping_priority || 'Normal',
          updated_at: new Date().toISOString()
        });

        if (firestoreDb) {
          await firestoreDb.collection('housekeeping_logs').add({
            room_id: String(roomId),
            room_number: roomNumber,
            action,
            performed_by: performedBy ? String(performedBy) : 'System',
            notes: priority ? `Priority updated to ${priority}` : null,
            created_at: new Date().toISOString()
          });
        }

        if (io) {
          io.emit('housekeeping_update', { roomId, action, userId, priority });
        }

        return { success: true, message: 'Assignment updated successfully' };
      } catch (err) {
        if (err.status === 404 || err.status === 400) throw err;
        console.error(`[FAIL_CLOSED:HOUSEKEEPING] Firestore assignHousekeeper failed for ${roomId}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [roomRows] = await connection.query('SELECT id, number FROM rooms WHERE id = ? OR number = ?', [roomId, roomId]);
      if (roomRows.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Room not found');
        notFoundErr.status = 404;
        throw notFoundErr;
      }
      const actualRoomId = roomRows[0].id;
      const roomNumber = roomRows[0].number;

      let assignedStaffId = null;
      let staffName = 'Unassigned';
      if (userId) {
        if (!isNaN(parseInt(userId, 10))) {
          assignedStaffId = parseInt(userId, 10);
          const [sRows] = await connection.query('SELECT full_name as name FROM staff WHERE id = ?', [assignedStaffId]);
          if (sRows.length > 0) staffName = sRows[0].name;
        } else {
          const [sRows] = await connection.query('SELECT id, full_name as name FROM staff WHERE username = ?', [userId]);
          if (sRows.length > 0) {
            assignedStaffId = sRows[0].id;
            staffName = sRows[0].name;
          }
        }
      }

      let actualPerformedBy = null;
      if (performedBy && !isNaN(parseInt(performedBy, 10))) {
        actualPerformedBy = parseInt(performedBy, 10);
      }

      const updateQuery = `
        UPDATE rooms 
        SET housekeeping_assigned_to = ?, housekeeping_priority = COALESCE(?, housekeeping_priority)
        WHERE id = ?
      `;
      await connection.query(updateQuery, [assignedStaffId, priority, actualRoomId]);

      const action = userId ? `Assigned to ${staffName}` : 'Unassigned';
      const [logResult] = await connection.query(`
        INSERT INTO housekeeping_logs (room_id, action, performed_by, notes)
        VALUES (?, ?, ?, ?)
      `, [actualRoomId, action, actualPerformedBy, priority ? `Priority updated to ${priority}` : null]);

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'HOUSEKEEPING_LOG_CREATED',
          aggregate_type: 'HOUSEKEEPING',
          aggregate_id: String(roomNumber),
          payload: {
            room_id: String(actualRoomId),
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

      if (io) {
        io.emit('housekeeping_update', { roomId: actualRoomId, action, userId, priority });
      }

      return { success: true, message: 'Assignment updated successfully' };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async updateHousekeepingStatus({ roomId, status, notes, performedBy, io }) {
    if (isFirestoreHousekeepingEnabled()) {
      try {
        const room = await getRoomByIdFirestore(roomId);
        if (!room) {
          const notFoundErr = new Error('Room not found');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        const roomNumber = String(room.number);
        const oldStatus = room.housekeeping_status || 'Clean';
        const nowIso = new Date().toISOString();

        const updates = {
          housekeeping_status: status,
          updated_at: nowIso
        };
        if (status === 'Clean' || status === 'Inspected' || status === 'Vacant Ready') {
          updates.last_cleaned_at = nowIso;
        }

        await updateRoomFirestore(room.docId || roomId, updates);

        if (firestoreDb) {
          await firestoreDb.collection('housekeeping_logs').add({
            room_id: String(roomId),
            room_number: roomNumber,
            action: `Status changed from ${oldStatus} to ${status}`,
            performed_by: performedBy ? String(performedBy) : 'System',
            notes: notes || null,
            created_at: nowIso
          });
        }

        if (io) {
          io.emit('housekeeping_update', { roomId, status });
        }

        return { success: true, message: 'Status updated successfully' };
      } catch (err) {
        if (err.status === 404 || err.status === 400) throw err;
        console.error(`[FAIL_CLOSED:HOUSEKEEPING] Firestore updateHousekeepingStatus failed for ${roomId}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [roomRows] = await connection.query(
        'SELECT r.id, r.number, r.housekeeping_status FROM rooms r WHERE r.id = ? OR r.number = ?',
        [roomId, roomId]
      );
      if (roomRows.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Room not found');
        notFoundErr.status = 404;
        throw notFoundErr;
      }
      const actualRoomId = roomRows[0].id;
      const oldHkStatus = roomRows[0].housekeeping_status;
      const roomNumber  = roomRows[0].number;

      let performerName = 'System';
      let actualPerformedBy = null;
      if (performedBy && !isNaN(parseInt(performedBy, 10))) {
        actualPerformedBy = parseInt(performedBy, 10);
        const [userRows] = await connection.query('SELECT fullName as name FROM users WHERE id = ?', [actualPerformedBy]);
        if (userRows.length > 0) performerName = userRows[0].name;
      } else if (performedBy) {
        performerName = String(performedBy);
      }

      const businessDate = await BusinessDateService.getBusinessDate(connection);

      let updateFields = 'housekeeping_status = ?';
      const params = [status];
      if (status === 'Clean' || status === 'Inspected' || status === 'Vacant Ready') {
        updateFields += ', last_cleaned_at = CURRENT_TIMESTAMP';
      }

      await connection.query(`UPDATE rooms SET ${updateFields} WHERE id = ?`, [...params, actualRoomId]);

      const [logResult] = await connection.query(`
        INSERT INTO housekeeping_logs (room_id, action, performed_by, notes)
        VALUES (?, ?, ?, ?)
      `, [actualRoomId, `Status changed from ${oldHkStatus} to ${status}`, actualPerformedBy, notes || null]);

      const structuredDetails = JSON.stringify({
        Room: roomNumber,
        HK_Before: oldHkStatus,
        HK_After: status,
        User: performerName,
        Business_Date: businessDate
      });
      await connection.query(
        `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'HK_STATUS_CHANGE', ?, ?)`,
        [actualPerformedBy, structuredDetails, businessDate]
      );

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
            room_id: String(actualRoomId),
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

      if (io) {
        io.emit('housekeeping_update', { roomId: actualRoomId, status });
      }

      return { success: true, message: 'Status updated successfully' };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async getHousekeepingLogs(roomId) {
    if (isFirestoreHousekeepingEnabled()) {
      try {
        if (firestoreDb) {
          const snap = await firestoreDb.collection('housekeeping_logs')
            .where('room_id', '==', String(roomId))
            .get();

          if (!snap.empty) {
            const logs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            logs.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
            return logs;
          }
        }
        return [];
      } catch (err) {
        console.error(`[FAIL_CLOSED:HOUSEKEEPING] Firestore getHousekeepingLogs failed for ${roomId}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    const query = `
      SELECT h.*, COALESCE(u.fullName, u.username) as performed_by_name
      FROM housekeeping_logs h
      LEFT JOIN users u ON h.performed_by = u.id
      WHERE h.room_id = ?
      ORDER BY h.created_at DESC
    `;
    const [rows] = await pool.query(query, [roomId]);
    return rows;
  }
}

export default HousekeepingCutoverService;
