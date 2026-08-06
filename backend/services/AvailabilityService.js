/**
 * AvailabilityService.js
 * ======================
 * Enterprise-grade Room Availability Engine.
 *
 * Single source of truth for ALL availability checks across:
 *   - Reservation creation & modification
 *   - Walk-in check-in
 *   - Room shift
 *   - Available rooms API dropdown
 *   - Future online booking
 *
 * ─── Availability Rules ───────────────────────────────────────────────────
 * A room is AVAILABLE only when ALL of the following are true:
 *   1. rooms.status NOT IN ('occupied','dirty','out_of_order','maintenance','blocked')
 *   2. housekeeping_status != 'Dirty'
 *   3. No active reservation (status IN Reserved, Confirmed) overlaps requested dates
 *   4. No active booking (booking_status = 'Checked In') overlaps requested dates
 *
 * ─── Overlap Rule (industry-standard) ────────────────────────────────────
 *   Two date ranges [A, B) and [C, D) overlap when:
 *       A < D  AND  C < B
 *   i.e. new_arrival < existing_departure AND existing_arrival < new_departure
 *
 * ─── Concurrency ──────────────────────────────────────────────────────────
 *   validateAndLockRoom() uses SELECT ... FOR UPDATE inside a caller-supplied
 *   transaction so two simultaneous reservations for the same room are
 *   serialised at the DB level.
 */

import { parseToComparableDate, isDateOverlap } from './roomStatusService.js';

export class AvailabilityService {

  // ─────────────────────────────────────────────────────────────────────────
  // CORE: Single-room availability check
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check whether a specific room is available for the given date range.
   *
   * @param {object}  connection  — Active DB connection (inside or outside transaction)
   * @param {object}  params
   * @param {number}  params.roomId         — rooms.id
   * @param {string}  params.roomNumber     — rooms.number (for human-readable errors)
   * @param {string}  params.arrivalDate    — YYYY-MM-DD or DD-Mon-YYYY
   * @param {string}  params.departureDate  — YYYY-MM-DD or DD-Mon-YYYY
   * @param {number}  [params.excludeReservationId]  — skip this reservation (for updates)
   * @param {boolean} [params.forUpdate]    — if true, acquires SELECT … FOR UPDATE row lock
   *
   * @returns {Promise<{ available: boolean, reason: string, code: string|null }>}
   */
  static async checkRoomAvailability(connection, {
    roomId,
    roomNumber,
    arrivalDate,
    departureDate,
    excludeReservationId = null,
    forUpdate = false,
  }) {
    const sArr = parseToComparableDate(arrivalDate);
    const sDep = parseToComparableDate(departureDate);

    if (!sArr || !sDep || sArr >= sDep) {
      return { available: false, reason: 'Arrival date must be strictly before departure date', code: 'INVALID_DATES' };
    }

    // 1. Room physical status
    const lockClause = forUpdate ? 'FOR UPDATE' : '';
    const [roomRows] = await connection.query(
      `SELECT id, number, status, housekeeping_status
       FROM rooms WHERE id = ? ${lockClause}`,
      [roomId]
    );

    if (roomRows.length === 0) {
      return { available: false, reason: `Room ${roomNumber || roomId} not found`, code: 'ROOM_NOT_FOUND' };
    }

    const room = roomRows[0];
    const blockedStatuses = ['occupied', 'dirty', 'out_of_order', 'maintenance', 'blocked'];

    if (blockedStatuses.includes(room.status)) {
      return {
        available: false,
        reason: `Room ${room.number} is not available (status: ${room.status})`,
        code: 'ROOM_UNAVAILABLE'
      };
    }

    if (room.housekeeping_status === 'Dirty') {
      return {
        available: false,
        reason: `Room ${room.number} is under housekeeping and not yet clean`,
        code: 'ROOM_DIRTY'
      };
    }

    // 2. Active checked-in booking overlap
    const [bookingConflicts] = await connection.query(
      `SELECT b.id, b.check_in_date, b.expected_check_out_date, b.check_out_date
       FROM bookings b
       WHERE b.room_id = ? AND b.booking_status = 'Checked In'`,
      [roomId]
    );

    for (const b of bookingConflicts) {
      const bEnd = b.expected_check_out_date || b.check_out_date || b.check_in_date;
      if (isDateOverlap(sArr, sDep, b.check_in_date, bEnd)) {
        return {
          available: false,
          reason: `Room ${room.number} is occupied during the requested dates`,
          code: 'ROOM_OCCUPIED_BOOKING'
        };
      }
    }

    // 3. Active reservation overlap
    let resQuery = `
      SELECT id, arrival_date, departure_date
      FROM reservations
      WHERE room_id = ? AND status IN ('Reserved', 'Confirmed')
    `;
    const resParams = [roomId];

    if (excludeReservationId) {
      resQuery += ' AND id != ?';
      resParams.push(excludeReservationId);
    }

    const [resConflicts] = await connection.query(resQuery, resParams);

    for (const r of resConflicts) {
      if (isDateOverlap(sArr, sDep, r.arrival_date, r.departure_date)) {
        return {
          available: false,
          reason: `Room ${room.number} already has a reservation during the requested dates`,
          code: 'ROOM_ALREADY_BOOKED'
        };
      }
    }

    return { available: true, reason: null, code: null };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CORE: Validate + acquire lock (for write operations)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Locks the room row FOR UPDATE and runs a full availability check.
   * Must be called inside an open transaction.
   *
   * Throws an object { status, message, code } if unavailable,
   * to be caught by the caller and returned as HTTP 409.
   *
   * @param {object} connection  — Must be inside beginTransaction()
   * @param {object} params      — Same as checkRoomAvailability
   */
  static async validateAndLockRoom(connection, params) {
    const result = await this.checkRoomAvailability(connection, { ...params, forUpdate: true });
    if (!result.available) {
      throw {
        status: 409,
        message: result.reason,
        code: result.code || 'ROOM_ALREADY_BOOKED'
      };
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BULK: Get all available rooms for a date range (for dropdowns / API)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns all rooms that pass availability for the given date range.
   * Runs efficiently with a single batch query approach — no N+1 queries.
   *
   * @param {object}  db           — pool or connection
   * @param {string}  arrivalDate
   * @param {string}  departureDate
   * @param {string}  [roomType]   — 'ALL' or a room type code (e.g. 'STANDARD')
   * @param {number}  [excludeReservationId]  — skip during modification
   *
   * @returns {Promise<Array>} Available room objects
   */
  static async getAvailableRooms(db, arrivalDate, departureDate, roomType = 'ALL', excludeReservationId = null) {
    const sArr = parseToComparableDate(arrivalDate);
    const sDep = parseToComparableDate(departureDate);
    if (!sArr || !sDep || sArr >= sDep) {
      throw new Error('Arrival date must be strictly before departure date');
    }

    // Get all rooms excluding physically blocked ones
    const [rooms] = await db.query(`
      SELECT r.id, r.number, r.status, r.housekeeping_status,
             rt.code as room_type, rt.title, rt.base_rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.status NOT IN ('out_of_order', 'maintenance', 'blocked')
    `);

    // Get ALL active checked-in bookings (single query, not N+1)
    const [activeBookings] = await db.query(`
      SELECT b.room_id, b.check_in_date,
             b.expected_check_out_date, b.check_out_date
      FROM bookings b
      WHERE b.booking_status = 'Checked In'
    `);

    // Get ALL active reservations (single query, not N+1)
    let resQuery = `
      SELECT room_id, arrival_date, departure_date
      FROM reservations
      WHERE status IN ('Reserved', 'Confirmed')
    `;
    const resParams = [];
    if (excludeReservationId) {
      resQuery += ' AND id != ?';
      resParams.push(excludeReservationId);
    }
    const [activeReservations] = await db.query(resQuery, resParams);

    return rooms.filter(room => {
      // Room type filter
      if (roomType && roomType !== 'ALL' && room.room_type !== roomType) return false;

      // Housekeeping lock
      if (room.status === 'dirty' || room.housekeeping_status === 'Dirty') return false;

      // Occupied / dirty physical status
      if (['occupied', 'dirty'].includes(room.status)) return false;

      // Booking conflict
      const bookingBlocked = activeBookings.some(b => {
        if (b.room_id !== room.id) return false;
        const bEnd = b.expected_check_out_date || b.check_out_date || b.check_in_date;
        return isDateOverlap(sArr, sDep, b.check_in_date, bEnd);
      });
      if (bookingBlocked) return false;

      // Reservation conflict
      const resBlocked = activeReservations.some(r => {
        if (r.room_id !== room.id) return false;
        return isDateOverlap(sArr, sDep, r.arrival_date, r.departure_date);
      });
      if (resBlocked) return false;

      return true;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UTILITY: Check undo eligibility (public read, no lock)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns availability status for a room without any locking.
   * Use this for read-only checks (UI display, reporting).
   *
   * @param {object} db
   * @param {number} roomId
   * @param {string} arrivalDate
   * @param {string} departureDate
   * @param {number} [excludeReservationId]
   */
  static async isRoomAvailable(db, roomId, arrivalDate, departureDate, excludeReservationId = null) {
    const result = await this.checkRoomAvailability(db, {
      roomId,
      arrivalDate,
      departureDate,
      excludeReservationId,
      forUpdate: false,
    });
    return result.available;
  }
}
