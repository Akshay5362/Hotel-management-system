/**
 * settingsController.js
 * =====================
 * Handles Business Date management endpoints.
 *
 * Single endpoint:  POST /api/settings/business-date
 *
 * Request body:
 *   {
 *     "action":  "update" | "rollback" | "reset_to_today"   // default: "update"
 *     "date":    "YYYY-MM-DD"                               // required for "update"
 *     "reason":  "string"                                   // always required
 *     "force":   false                                       // required for backward
 *   }
 *
 * Authorization:
 *   GET  — any authenticated user (read-only)
 *   POST — requires hasPermission('override_business_date') → 403 otherwise
 *
 * Business Rules:
 *   1. No direct SQL reads of system_date outside BusinessDateService.
 *   2. No OS clock used for business logic.
 *   3. Forward moves: always allowed for authorized users.
 *   4. Backward moves: allowed only when force=true AND reason provided.
 *   5. Rollback: moves business date back by exactly one day.
 *   6. Reset to today: DEV-ONLY (NODE_ENV=development).
 *   7. Every operation writes an audit_log entry.
 *   8. Lock prevents concurrent Day End modification.
 */

import pool from '../db.js';
import { RoomStatusService } from '../services/roomStatusService.js';
import { hasPermission } from './authController.js';
import { BusinessDateService, BD_ERRORS } from '../services/businessDateService.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Validate that a string is non-empty after trim. */
function requireReason(reason) {
  return typeof reason === 'string' && reason.trim().length > 0;
}

// ── GET /api/settings/business-date ─────────────────────────────────────────

export const getBusinessDateInfo = async (req, res) => {
  try {
    const businessDate = await BusinessDateService.getBusinessDate(pool);

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
    
    let occupiedRooms    = 0;
    let bookedRooms      = 0;
    let dirtyRooms       = 0;
    let pendingCheckouts = 0;

    const bDateObj = new Date(businessDate);
    bDateObj.setHours(0, 0, 0, 0);

    for (const room of processedRooms) {
      if (room.status === 'occupied') {
        occupiedRooms++;
        if (room.expectedCheckOutDate) {
          const expDateObj = new Date(room.expectedCheckOutDate);
          expDateObj.setHours(0, 0, 0, 0);
          if (expDateObj <= bDateObj) pendingCheckouts++;
        }
      } else if (room.status === 'booked') {
        bookedRooms++;
      }
      if (room.status === 'dirty' || room.housekeeping_status === 'Dirty') {
        dirtyRooms++;
      }
    }

    // Include mode so the UI can show DEV badge and allow reset button
    const isDev = process.env.NODE_ENV === 'development';

    res.json({
      businessDate,
      systemDate: new Date().toISOString(),   // wall-clock for UI display only
      lastDayEnd,
      mode: isDev ? 'development' : 'production',
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

// ── POST /api/settings/business-date ────────────────────────────────────────

export const updateBusinessDate = async (req, res) => {
  const { action = 'update', date, reason, force = false } = req.body;
  const adminId  = req.user?.id;
  const username = req.user?.username;
  const role     = req.user?.role;
  const clientIp = req.ip || req.connection?.remoteAddress || null;

  // ── 1. Permission check (permission-based, not hardcoded role) ────────────
  const canOverride = await hasPermission(req, 'override_business_date');
  if (!canOverride) {
    return res.status(403).json({
      error: 'Forbidden: You do not have permission to modify the Business Date.',
      code:  'PERMISSION_DENIED',
    });
  }

  // ── 2. Validate reason (always required) ──────────────────────────────────
  if (!requireReason(reason)) {
    return res.status(400).json({
      error: 'A reason is required for all Business Date modifications.',
      code:  'REASON_REQUIRED',
    });
  }

  // ── 3. Validate action ────────────────────────────────────────────────────
  const VALID_ACTIONS = ['update', 'rollback', 'reset_to_today'];
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({
      error: `Invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(', ')}.`,
      code:  'INVALID_ACTION',
    });
  }

  // ── 4. Additional validation for 'update' action ──────────────────────────
  if (action === 'update') {
    if (!date) {
      return res.status(400).json({ error: 'A target date is required for action=update.', code: 'DATE_REQUIRED' });
    }
    const parsed = BusinessDateService.parseDate(date);
    if (!parsed) {
      return res.status(400).json({
        error: `Invalid date format: "${date}". Expected YYYY-MM-DD.`,
        code:  BD_ERRORS.INVALID_FORMAT,
      });
    }
  }

  // ── 5. Acquire lock and execute ───────────────────────────────────────────
  let connection;
  try {
    connection = await pool.getConnection();

    // Acquire NOWAIT lock — throws immediately if Day End is running
    try {
      await BusinessDateService.acquireLock(connection);
    } catch (lockError) {
      if (lockError.code === 'ER_LOCK_NOWAIT' || lockError.code === 'ER_LOCK_DEADLOCK') {
        return res.status(409).json({
          error: 'Cannot modify Business Date: a Day End / Night Audit process is currently running.',
          code:  'LOCK_CONFLICT',
        });
      }
      throw lockError;
    }

    await connection.beginTransaction();

    const oldDate = await BusinessDateService.getBusinessDate(connection);
    let newDate;
    let auditAction;

    // ── ACTION: update ───────────────────────────────────────────────────────
    if (action === 'update') {
      const targetIso = BusinessDateService.parseDate(date);
      const cmp       = BusinessDateService.compareDates(targetIso, oldDate);

      if (cmp === 0) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({
          error: `Business Date is already ${oldDate}. No change made.`,
          code:  BD_ERRORS.SAME_DATE,
        });
      }

      // Backward movement guard
      if (cmp < 0 && !force) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({
          error: `Business Date cannot move backward (current: ${oldDate}, requested: ${targetIso}). Set force=true to override.`,
          code:  BD_ERRORS.BACKWARD,
        });
      }

      // All clear — delegate write to BusinessDateService
      await BusinessDateService.setBusinessDate(connection, targetIso, { allowBackward: true, allowSameDate: false });
      newDate     = targetIso;
      auditAction = 'MANUAL_DATE_CHANGE';
    }

    // ── ACTION: rollback ─────────────────────────────────────────────────────
    else if (action === 'rollback') {
      const result = await BusinessDateService.rollbackBusinessDate(connection, {
        userId: adminId, username, role, reason: reason.trim(), clientIp,
      });
      // rollbackBusinessDate already writes its own audit log
      newDate     = result.newDate;
      auditAction = null; // already logged inside rollbackBusinessDate
    }

    // ── ACTION: reset_to_today ───────────────────────────────────────────────
    else if (action === 'reset_to_today') {
      if (process.env.NODE_ENV !== 'development') {
        await connection.rollback();
        connection.release();
        return res.status(403).json({
          error: 'Reset to Today is only available in development mode.',
          code:  BD_ERRORS.PRODUCTION_GUARD,
        });
      }
      const result = await BusinessDateService.resetToSystemDate(connection, {
        userId: adminId, username, role, reason: reason.trim(), clientIp,
      });
      // resetToSystemDate already writes its own audit log
      newDate     = result.newDate;
      auditAction = null; // already logged inside resetToSystemDate
    }

    // ── Write audit log for 'update' (rollback/reset write their own) ────────
    if (auditAction) {
      const auditDetails = `Manual Business Date change. Old: ${oldDate}, New: ${newDate}. Force: ${force}`;
      await connection.query(
        `INSERT INTO audit_logs (
          user_id, action, details, business_date,
          previous_business_date, new_business_date, reason,
          username, role, client_ip, application_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0.0')`,
        [
          adminId, auditAction, auditDetails, newDate,
          oldDate, newDate, reason.trim(),
          username || null, role || null, clientIp || null,
        ]
      );
    }

    await connection.commit();

    console.log(`[Settings] Business Date changed: ${oldDate} → ${newDate} (action=${action}, user=${username || adminId})`);

    res.json({
      success: true,
      message: `Business Date successfully changed from ${oldDate} to ${newDate}.`,
      previousDate: oldDate,
      newDate,
      action,
    });

  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }

    // Return structured error for known BusinessDateErrors
    if (error.name === 'BusinessDateError') {
      return res.status(error.httpStatus || 400).json({
        error: error.message,
        code:  error.code,
      });
    }

    console.error('[Settings] Error updating business date:', error);
    res.status(500).json({ error: 'Failed to update business date. Please try again.' });
  } finally {
    if (connection) connection.release();
  }
};
