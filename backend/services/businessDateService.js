/**
 * BusinessDateService
 * ===================
 * Single authoritative source for all Hotel PMS Business Date operations.
 *
 * Rules enforced:
 *  1. Business Date is ALWAYS read from system_settings.system_date (MySQL).
 *  2. No controller or service may query system_settings.system_date directly.
 *  3. No OS clock (new Date(), Date.now()) may be used for hotel business logic.
 *  4. During Day End, Business Date may advance by EXACTLY one calendar day only.
 *  5. Backward movement and same-day re-runs are always rejected by default.
 *  6. Skipped days (jump of >1 day) are always rejected during Day End.
 *  7. setBusinessDate() with opts.allowBackward=true allows backward movement
 *     (super_admin / override_business_date permission holders only).
 *  8. rollbackBusinessDate() moves the date back by exactly one calendar day.
 *     It requires a conn already inside a started transaction and writes an
 *     audit log of action='ROLLBACK_DATE'.
 *  9. resetToSystemDate() is a DEV-ONLY helper that sets Business Date to the
 *     current OS wall-clock date. It MUST NOT be called in production.
 *
 * Public API:
 *  - BusinessDateService.parseDate(str)               → 'YYYY-MM-DD' | null
 *  - BusinessDateService.formatDate(yyyymmdd)         → 'YYYY-MM-DD' (normaliser)
 *  - BusinessDateService.addDays(dateStr, n)          → 'YYYY-MM-DD'
 *  - BusinessDateService.compareDates(a, b)           → -1 | 0 | 1
 *  - BusinessDateService.getBusinessDate(conn?)       → Promise<string 'YYYY-MM-DD'>
 *  - BusinessDateService.setBusinessDate(conn, date, opts?)   → Promise<void>
 *  - BusinessDateService.advanceBusinessDate(conn, nextDate, opts) → Promise<void>
 *  - BusinessDateService.rollbackBusinessDate(conn, opts)     → Promise<string> (prev date)
 *  - BusinessDateService.resetToSystemDate(conn, opts)        → Promise<string> (new date)
 *  - BusinessDateService.resetDailyCounters(conn)    → Promise<void>
 *  - BusinessDateService.acquireLock(conn)            → Promise<void>
 */

import pool from '../db.js';
import { enqueue } from './outboxService.js';
import { isFirestoreDualWriteEnabled } from '../config/featureFlags.js';

// ─── Error codes ────────────────────────────────────────────────────────────
export const BD_ERRORS = {
  MISSING:          'BD_MISSING',          // system_date not in DB
  INVALID_FORMAT:   'BD_INVALID_FORMAT',   // date string unrecognisable
  BACKWARD:         'BD_BACKWARD',         // nextDate < currentDate
  SAME_DATE:        'BD_SAME_DATE',        // nextDate === currentDate
  SKIP:             'BD_SKIP',             // nextDate > currentDate + 1
  ALREADY_RAN:      'BD_ALREADY_RAN',      // DAY_END already committed for nextDate
  PRODUCTION_GUARD: 'BD_PRODUCTION_GUARD', // operation blocked in production
};

class BusinessDateError extends Error {
  constructor(code, message) {
    super(message);
    this.name  = 'BusinessDateError';
    this.code  = code;
    this.httpStatus = code === BD_ERRORS.ALREADY_RAN ? 409 : 400;
  }
}

// ─── Month lookup tables ─────────────────────────────────────────────────────
const MON_TO_NUM = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
const NUM_TO_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Normalise any date string the PMS has ever used → 'YYYY-MM-DD'.
 * Accepts:  'YYYY-MM-DD'  |  'DD-Mon-YYYY'  |  JS Date object
 * Returns null if unparseable.
 */
function _normalise(input) {
  if (!input) return null;

  // Already ISO
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    return input.trim();
  }

  // DD-Mon-YYYY  (e.g. "05-Aug-2026")
  if (typeof input === 'string') {
    const parts = input.trim().split('-');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const mon = MON_TO_NUM[parts[1].toLowerCase()];
      const yr  = parts[2];
      if (mon && /^\d{4}$/.test(yr) && /^\d{1,2}$/.test(parts[0])) {
        return `${yr}-${mon}-${day}`;
      }
    }
  }

  // JS Date object (used only for timestamps – but accept here for utility)
  if (input instanceof Date && !isNaN(input.getTime())) {
    return input.toISOString().split('T')[0];
  }

  return null;
}

/** Convert 'YYYY-MM-DD' → { y, m, d } integers */
function _parts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/** Get the current OS date as 'YYYY-MM-DD' — ONLY for resetToSystemDate (dev only). */
function _osDateNow() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── Public static API ───────────────────────────────────────────────────────
export const BusinessDateService = {

  // ── Date utilities ──────────────────────────────────────────────────────

  /**
   * Parse any PMS date string → 'YYYY-MM-DD'.
   * Returns null if format is unrecognised.
   */
  parseDate(str) {
    return _normalise(str);
  },

  /**
   * Normalise a 'YYYY-MM-DD' string (no-op if already valid, otherwise parse).
   */
  formatDate(str) {
    const iso = _normalise(str);
    if (!iso) throw new BusinessDateError(BD_ERRORS.INVALID_FORMAT, `Cannot format invalid date: ${str}`);
    return iso;
  },

  /**
   * Add n calendar days to a date string (n may be negative).
   * Uses UTC arithmetic only — never the host OS timezone.
   */
  addDays(dateStr, n) {
    const iso = _normalise(dateStr);
    if (!iso) throw new BusinessDateError(BD_ERRORS.INVALID_FORMAT, `addDays: invalid input "${dateStr}"`);
    const { y, m, d } = _parts(iso);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().split('T')[0];
  },

  /**
   * Compare two date strings.
   * Returns -1 (a < b) | 0 (a === b) | 1 (a > b)
   */
  compareDates(a, b) {
    const isoA = _normalise(a);
    const isoB = _normalise(b);
    if (!isoA) throw new BusinessDateError(BD_ERRORS.INVALID_FORMAT, `compareDates: invalid a="${a}"`);
    if (!isoB) throw new BusinessDateError(BD_ERRORS.INVALID_FORMAT, `compareDates: invalid b="${b}"`);
    if (isoA < isoB) return -1;
    if (isoA > isoB) return  1;
    return 0;
  },

  // ── Database operations ─────────────────────────────────────────────────

  /**
   * Read the current Business Date from MySQL.
   * @param {object} [conn] Optional existing connection/pool. Defaults to pool.
   * @returns {Promise<string>} 'YYYY-MM-DD'
   * @throws BusinessDateError (BD_MISSING) if row not found.
   */
  async getBusinessDate(conn) {
    const db = conn || pool;
    const [rows] = await db.query(
      "SELECT value_val FROM system_settings WHERE key_name = 'system_date'"
    );
    if (!rows.length || !rows[0].value_val) {
      throw new BusinessDateError(
        BD_ERRORS.MISSING,
        '[CRITICAL] system_settings.system_date is missing from database. Please contact administrator.'
      );
    }
    const iso = _normalise(rows[0].value_val);
    if (!iso) {
      throw new BusinessDateError(
        BD_ERRORS.INVALID_FORMAT,
        `[CRITICAL] system_settings.system_date has an unrecognised format: "${rows[0].value_val}"`
      );
    }
    return iso;
  },

  /**
   * Overwrite the Business Date (admin manual override).
   * Validates format. Rejects backward movement unless opts.allowBackward=true.
   * Does NOT write an audit log — callers must do that themselves.
   *
   * @param {object} conn   Active MySQL connection (must be in a transaction).
   * @param {string} date   New date ('YYYY-MM-DD' or 'DD-Mon-YYYY').
   * @param {object} [opts]
   * @param {boolean} [opts.allowBackward=false]  Allow backward movement.
   * @param {boolean} [opts.allowSameDate=false]  Skip same-date guard (used by resetToSystemDate).
   */
  async setBusinessDate(conn, date, opts = {}) {
    const newIso = _normalise(date);
    if (!newIso) {
      throw new BusinessDateError(BD_ERRORS.INVALID_FORMAT, `Invalid date format: "${date}". Expected YYYY-MM-DD or DD-Mon-YYYY.`);
    }

    const currentIso = await this.getBusinessDate(conn);
    const cmp = this.compareDates(newIso, currentIso);

    if (cmp === 0 && !opts.allowSameDate) {
      throw new BusinessDateError(BD_ERRORS.SAME_DATE, `Business Date is already ${currentIso}. No change made.`);
    }
    if (cmp < 0 && !opts.allowBackward) {
      throw new BusinessDateError(BD_ERRORS.BACKWARD, `Business Date cannot move backward (current: ${currentIso}, requested: ${newIso}).`);
    }

    await conn.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'",
      [newIso]
    );

    if (isFirestoreDualWriteEnabled()) {
      await enqueue(conn, {
        event_type: 'SYSTEM_DATE_UPDATED',
        aggregate_type: 'SYSTEM_SETTING',
        aggregate_id: 'system_date',
        payload: {
          key_name: 'system_date',
          current_date: newIso,
          system_date: newIso,
          value_val: newIso,
          updated_at: new Date().toISOString()
        }
      });
    }
  },

  /**
   * Reset today_checkins and today_checkouts to '0'.
   * Must be called within an active transaction.
   */
  async resetDailyCounters(conn) {
    await conn.query("UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkins'");
    await conn.query("UPDATE system_settings SET value_val = '0' WHERE key_name = 'today_checkouts'");
  },

  /**
   * Atomic Day End: advance Business Date by exactly one calendar day.
   *
   * Enforces:
   *  - nextDate must equal currentDate + 1 day (no skip, no backward, no same).
   *  - Duplicate prevention: rejects if DAY_END audit log already exists for nextDate.
   *  - Locks system_settings for the duration of the transaction.
   *  - Posts nightly ledger charges for all occupied rooms.
   *  - Resets daily counters.
   *  - Inserts DAY_END audit log.
   *  - Commits atomically.
   *
   * @param {object} conn           Active MySQL connection (caller must call getConnection).
   * @param {string} nextDate       Target next business date.
   * @param {object} opts
   * @param {number|null} opts.auditorId  User ID of the operator running Day End.
   * @throws BusinessDateError      On validation failure (no commit, caller must rollback).
   */
  async advanceBusinessDate(conn, nextDate, opts = {}) {
    const nextIso = _normalise(nextDate);
    if (!nextIso) {
      throw new BusinessDateError(BD_ERRORS.INVALID_FORMAT, `Invalid nextDate format: "${nextDate}".`);
    }

    // ── Lock system_settings to block concurrent Day End calls ────────────
    await conn.query('SELECT * FROM system_settings FOR UPDATE');

    const currentIso = await this.getBusinessDate(conn);
    const expectedNext = this.addDays(currentIso, 1);
    const cmp = this.compareDates(nextIso, currentIso);

    // Same-date guard
    if (cmp === 0) {
      throw new BusinessDateError(BD_ERRORS.SAME_DATE,
        `Day End rejected: nextDate (${nextIso}) equals current Business Date (${currentIso}). Business Date has not changed.`);
    }
    // Backward guard
    if (cmp < 0) {
      throw new BusinessDateError(BD_ERRORS.BACKWARD,
        `Day End rejected: nextDate (${nextIso}) is before current Business Date (${currentIso}).`);
    }
    // Skip guard — must be exactly +1 day
    if (nextIso !== expectedNext) {
      throw new BusinessDateError(BD_ERRORS.SKIP,
        `Day End rejected: nextDate (${nextIso}) skips a calendar day. Expected exactly ${expectedNext}.`);
    }

    // ── Duplicate prevention ──────────────────────────────────────────────
    const [existingRun] = await conn.query(
      "SELECT id FROM audit_logs WHERE action = 'DAY_END' AND business_date = ? LIMIT 1",
      [nextIso]
    );
    if (existingRun.length > 0) {
      throw new BusinessDateError(BD_ERRORS.ALREADY_RAN,
        `Day End has already been executed for ${nextIso} (audit log #${existingRun[0].id}).`);
    }

    // ── Post nightly ledger charges for occupied rooms ────────────────────
    const [occupiedRooms] = await conn.query(`
      SELECT r.id, r.number, r.status, rt.base_rate as rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.status = 'occupied'
    `);

    for (const room of occupiedRooms) {
      const tariff = room.rate;
      // GST is included in the room rate — no separate tax line

      const [bookings] = await conn.query(
        "SELECT id FROM bookings WHERE room_id = ? AND booking_status = 'Checked In'",
        [room.id]
      );
      const bookingId = bookings[0]?.id || null;

      const [existingTariff] = await conn.query(
        "SELECT id FROM ledger_items WHERE room_number = ? AND business_date = ? AND booking_id = ? AND `desc` LIKE 'Room Tariff%Rollover%'",
        [room.number, nextIso, bookingId]
      );
      if (existingTariff.length === 0) {
        await conn.query(
          "INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)",
          [room.number, 'Room Tariff (Rollover, Incl. GST)', tariff, nextIso, bookingId]
        );
        console.log(`[DayEnd] Ledger: Room Tariff for Room ${room.number} on ${nextIso}`);
      }
    }

    // ── Advance Business Date ──────────────────────────────────────────────
    console.log(`[DayEnd] Advancing Business Date: ${currentIso} → ${nextIso}`);
    await conn.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'",
      [nextIso]
    );

    // ── Update continued_rooms counter ────────────────────────────────────
    await conn.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'continued_rooms'",
      [String(occupiedRooms.length)]
    );

    // ── Reset daily counters ──────────────────────────────────────────────
    await this.resetDailyCounters(conn);

    // ── Write audit log ───────────────────────────────────────────────────
    const auditorId  = opts.auditorId || null;
    const auditDetail = `Night audit run. Business date rolled from ${currentIso} to ${nextIso}. Occupied rooms at rollover: ${occupiedRooms.length}.`;
    await conn.query(
      "INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'DAY_END', ?, ?)",
      [auditorId, auditDetail, nextIso]
    );

    console.log(`[DayEnd] Complete. Business Date is now ${nextIso}.`);
  },

  /**
   * Rollback Business Date by exactly one calendar day.
   *
   * Purpose: If the Business Date was accidentally advanced too far
   * (e.g. multiple Day Ends), an administrator can call this to step
   * back one day at a time without manually typing dates.
   *
   * Validates:
   *  - Acquires NOWAIT lock on system_settings.
   *  - Reads current Business Date.
   *  - Computes previousDate = currentDate - 1.
   *  - Updates system_settings.
   *  - Writes audit log action='ROLLBACK_DATE'.
   *  - Does NOT touch ledger items or daily counters (caller decides).
   *
   * @param {object} conn   Active MySQL connection inside a started transaction.
   * @param {object} opts
   * @param {number|null}  opts.userId    Who is performing the rollback.
   * @param {string|null}  opts.username
   * @param {string|null}  opts.role
   * @param {string}       opts.reason    Why (mandatory).
   * @param {string|null}  opts.clientIp
   * @returns {Promise<{previousDate: string, newDate: string}>}
   */
  async rollbackBusinessDate(conn, opts = {}) {
    const { userId = null, username = null, role = null, reason = '', clientIp = null } = opts;

    if (!reason || !reason.trim()) {
      throw new BusinessDateError(BD_ERRORS.INVALID_FORMAT, 'A reason is required for rollback operations.');
    }

    // Lock
    await conn.query("SELECT value_val FROM system_settings WHERE key_name = 'system_date' FOR UPDATE");

    const currentIso = await this.getBusinessDate(conn);
    const previousIso = this.addDays(currentIso, -1);

    console.log(`[Rollback] Rolling back Business Date: ${currentIso} → ${previousIso}`);

    await conn.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'",
      [previousIso]
    );

    const auditDetails = `Manual rollback. Business date rolled back from ${currentIso} to ${previousIso}. Reason: ${reason}`;
    await conn.query(
      `INSERT INTO audit_logs (
        user_id, action, details, business_date,
        previous_business_date, new_business_date, reason,
        username, role, client_ip, application_version
      ) VALUES (?, 'ROLLBACK_DATE', ?, ?, ?, ?, ?, ?, ?, ?, '1.0.0')`,
      [userId, auditDetails, previousIso, currentIso, previousIso, reason, username, role, clientIp]
    );

    console.log(`[Rollback] Complete. Business Date is now ${previousIso}.`);
    return { previousDate: currentIso, newDate: previousIso };
  },

  /**
   * DEV-ONLY: Reset Business Date to the current OS wall-clock date.
   *
   * SAFETY: Throws BusinessDateError(BD_PRODUCTION_GUARD) if NODE_ENV !== 'development'.
   * This must never be called in production code paths.
   *
   * @param {object} conn   Active MySQL connection inside a started transaction.
   * @param {object} opts
   * @param {number|null}  opts.userId
   * @param {string|null}  opts.username
   * @param {string|null}  opts.role
   * @param {string}       opts.reason
   * @param {string|null}  opts.clientIp
   * @returns {Promise<{previousDate: string, newDate: string}>}
   */
  async resetToSystemDate(conn, opts = {}) {
    if (process.env.NODE_ENV !== 'development') {
      throw new BusinessDateError(
        BD_ERRORS.PRODUCTION_GUARD,
        'Reset to System Date is only available in development mode.'
      );
    }

    const { userId = null, username = null, role = null, reason = 'Dev reset to OS date', clientIp = null } = opts;

    // Lock
    await conn.query("SELECT value_val FROM system_settings WHERE key_name = 'system_date' FOR UPDATE");

    const currentIso = await this.getBusinessDate(conn);
    const todayIso   = _osDateNow();

    console.log(`[DevReset] Setting Business Date from ${currentIso} to OS date ${todayIso}`);

    await conn.query(
      "UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'",
      [todayIso]
    );

    const auditDetails = `DEV: Reset business date from ${currentIso} to OS date ${todayIso}. Reason: ${reason}`;
    await conn.query(
      `INSERT INTO audit_logs (
        user_id, action, details, business_date,
        previous_business_date, new_business_date, reason,
        username, role, client_ip, application_version
      ) VALUES (?, 'RESET_TO_SYSTEM_DATE', ?, ?, ?, ?, ?, ?, ?, ?, '1.0.0')`,
      [userId, auditDetails, todayIso, currentIso, todayIso, reason, username, role, clientIp]
    );

    console.log(`[DevReset] Complete. Business Date is now ${todayIso}.`);
    return { previousDate: currentIso, newDate: todayIso };
  },

  /**
   * Acquire a NOWAIT row-level lock on the system_settings row for system_date.
   * Throws ER_LOCK_NOWAIT if another transaction already holds the lock (e.g. Day End).
   * Caller must be inside a started (but not yet committed) transaction.
   */
  async acquireLock(conn) {
    await conn.query(
      "SELECT value_val FROM system_settings WHERE key_name = 'system_date' FOR UPDATE NOWAIT"
    );
  },
};

export default BusinessDateService;
