/**
 * backend/services/firestoreAvailabilityService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Native Firestore Room Availability Engine for HPMS.
 *
 * Enterprise-grade date-range availability computation against Firestore
 * collections (/rooms, /bookings, /reservations) with 100% parity to the
 * existing MySQL AvailabilityService.
 *
 * NOTE: This service is transaction-compatible and operates on Firestore.
 * During migration phase 1, MySQL remains the live operational source of truth;
 * this service provides the validated NoSQL availability implementation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { listDocs, getDoc, formatRoomId, formatBookingId, formatReservationId } from '../repositories/firestore/firestoreUtils.js';

const ROOMS_COLLECTION = 'rooms';
const BOOKINGS_COLLECTION = 'bookings';
const RESERVATIONS_COLLECTION = 'reservations';

const BLOCKED_ROOM_STATUSES = Object.freeze(['occupied', 'dirty', 'out_of_order', 'maintenance', 'blocked']);
const ACTIVE_BOOKING_STATUSES = Object.freeze(['Checked In', 'Reserved']);
const ACTIVE_RESERVATION_STATUSES = Object.freeze(['Reserved', 'Confirmed', 'Pending']);

/**
 * Standardize any date input into YYYY-MM-DD format.
 */
export function parseToComparableDate(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const parts = str.split('-');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const mon = months[parts[1].toLowerCase()];
    const yr = parts[2];
    if (mon && yr) {
      return `${yr}-${mon}-${day}`;
    }
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }
  return str;
}

/**
 * Industry-standard hotel reservation date-range overlap rule:
 * Two half-open intervals [A, B) and [C, D) overlap when:
 *   A < D  AND  C < B
 * (i.e. new_arrival < existing_departure AND existing_arrival < new_departure)
 *
 * Example: Stay ending on 22nd (11:00 AM checkout) and stay beginning on 22nd (12:00 PM checkin)
 * do NOT overlap.
 */
export function isDateOverlap(start1, end1, start2, end2) {
  const s1 = parseToComparableDate(start1);
  const e1 = parseToComparableDate(end1);
  const s2 = parseToComparableDate(start2);
  const e2 = parseToComparableDate(end2);
  if (!s1 || !e1 || !s2 || !e2) return false;
  return s1 < e2 && s2 < e1;
}

/**
 * Checks if a booking or reservation entity matches a given room identifier.
 */
function matchesRoom(entity, targetRoomDocId, targetRoomNumber, targetMysqlId = null) {
  if (!entity) return false;
  const entityRoomId = entity.room_id ? String(entity.room_id) : null;
  const entityRoomNum = entity.room_number ? String(entity.room_number) : null;
  const entityMysqlId = entity.mysql_room_id !== undefined && entity.mysql_room_id !== null ? Number(entity.mysql_room_id) : null;

  const targetDocIdStr = targetRoomDocId ? String(targetRoomDocId) : null;
  const targetNumStr = targetRoomNumber ? String(targetRoomNumber) : null;

  if (targetDocIdStr && entityRoomId && (entityRoomId === targetDocIdStr || entityRoomId === targetDocIdStr.replace(/^room_/, ''))) {
    return true;
  }
  if (targetNumStr && (entityRoomNum === targetNumStr || entityRoomId === targetNumStr || entityRoomId === `room_${targetNumStr}`)) {
    return true;
  }
  if (targetMysqlId !== null && entityMysqlId !== null && entityMysqlId === Number(targetMysqlId)) {
    return true;
  }
  return false;
}

/**
 * Checks if an entity matches exclusion ID (for updates).
 */
function matchesExclusion(entity, excludeId) {
  if (!excludeId || !entity) return false;
  const exStr = String(excludeId).trim();
  const idStr = String(entity.id || entity.doc_id || '');
  const numStr = String(entity.reservation_number || entity.booking_number || '');
  const mysqlId = entity.mysql_reservation_id || entity.mysql_booking_id || entity.id;

  if (idStr === exStr || idStr === `res_${exStr}` || idStr === `bkg_${exStr}`) return true;
  if (numStr === exStr) return true;
  if (mysqlId && String(mysqlId) === exStr) return true;
  return false;
}

/**
 * Sorts an array of room objects in natural numeric order (e.g. 1, 2, 3, ... 10, 11, ... 20).
 */
export function sortRoomsNumerically(rooms) {
  return [...rooms].sort((a, b) => {
    const numA = parseInt(String(a.number || '').replace(/\D/g, ''), 10);
    const numB = parseInt(String(b.number || '').replace(/\D/g, ''), 10);
    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
      return numA - numB;
    }
    return String(a.number || '').localeCompare(String(b.number || ''));
  });
}

/**
 * Retrieves conflicting active bookings from Firestore for a given room and date range.
 */
export async function getConflictingBookingsFirestore({
  roomId,
  roomNumber = null,
  arrivalDate,
  departureDate,
  excludeBookingId = null,
  transaction = null
}) {
  const sArr = parseToComparableDate(arrivalDate);
  const sDep = parseToComparableDate(departureDate);
  if (!sArr || !sDep || sArr >= sDep) return [];

  const targetDocId = roomId ? (String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId)) : null;
  const targetNumber = roomNumber || (roomId ? String(roomId).replace(/^room_/, '') : null);
  const targetMysqlId = !isNaN(Number(targetNumber)) ? Number(targetNumber) : null;

  // Retrieve active bookings only (Checked In / Reserved)
  const allBookings = await listDocs(BOOKINGS_COLLECTION, {
    filters: [{ field: 'booking_status', op: 'in', value: ['Checked In', 'Reserved'] }],
    transaction
  });

  return allBookings.filter(b => {
    if (!b) return false;
    if (matchesExclusion(b, excludeBookingId)) return false;

    // Status filter: only active checked in or reserved bookings block inventory
    const status = b.booking_status || 'Checked In';
    if (!ACTIVE_BOOKING_STATUSES.includes(status)) return false;

    // Room filter
    if (!matchesRoom(b, targetDocId, targetNumber, targetMysqlId)) return false;

    // Date overlap check
    const bStart = b.check_in_date;
    const bEnd = b.expected_check_out_date || b.check_out_date || b.check_in_date;
    return isDateOverlap(sArr, sDep, bStart, bEnd);
  });
}

/**
 * Retrieves conflicting active reservations from Firestore for a given room and date range.
 */
export async function getConflictingReservationsFirestore({
  roomId,
  roomNumber = null,
  arrivalDate,
  departureDate,
  excludeReservationId = null,
  transaction = null
}) {
  const sArr = parseToComparableDate(arrivalDate);
  const sDep = parseToComparableDate(departureDate);
  if (!sArr || !sDep || sArr >= sDep) return [];

  const targetDocId = roomId ? (String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId)) : null;
  const targetNumber = roomNumber || (roomId ? String(roomId).replace(/^room_/, '') : null);
  const targetMysqlId = !isNaN(Number(targetNumber)) ? Number(targetNumber) : null;

  // Retrieve active reservations only (Reserved / Confirmed / Pending)
  const allReservations = await listDocs(RESERVATIONS_COLLECTION, {
    filters: [{ field: 'status', op: 'in', value: ['Reserved', 'Confirmed', 'Pending'] }],
    transaction
  });

  return allReservations.filter(r => {
    if (!r) return false;
    if (matchesExclusion(r, excludeReservationId)) return false;

    // Status filter: only active reservations block inventory
    const status = r.status || 'Confirmed';
    if (!ACTIVE_RESERVATION_STATUSES.includes(status)) return false;

    // Room filter
    if (!matchesRoom(r, targetDocId, targetNumber, targetMysqlId)) return false;

    // Date overlap check
    const rStart = r.arrival_date || r.check_in_date;
    const rEnd = r.departure_date || r.check_out_date;
    return isDateOverlap(sArr, sDep, rStart, rEnd);
  });
}

/**
 * Checks whether a specific room is available for the given date range in Firestore.
 *
 * @param {object} params
 * @param {string|number} params.roomId
 * @param {string} [params.roomNumber]
 * @param {string} params.arrivalDate
 * @param {string} params.departureDate
 * @param {string|number} [params.excludeReservationId]
 * @param {string|number} [params.excludeBookingId]
 * @param {object} [params.transaction]
 *
 * @returns {Promise<{ available: boolean, reason: string|null, code: string|null, room: object|null }>}
 */
export async function checkRoomAvailabilityFirestore(param1, param2, param3, param4, param5) {
  let roomId, roomNumber = null, arrivalDate, departureDate, excludeReservationId = null, excludeBookingId = null, transaction = null;

  // Case 1: param1 is connection/pool and param2 is options object
  if (param1 && typeof param1 === 'object' && !param1.arrivalDate && param2 && typeof param2 === 'object') {
    ({
      roomId,
      roomNumber = null,
      arrivalDate,
      departureDate,
      excludeReservationId = null,
      excludeBookingId = null,
      transaction = null
    } = param2);
  }
  // Case 2: param1 is options object
  else if (param1 && typeof param1 === 'object' && (param1.arrivalDate || param1.roomId || param1.roomNumber)) {
    ({
      roomId,
      roomNumber = null,
      arrivalDate,
      departureDate,
      excludeReservationId = null,
      excludeBookingId = null,
      transaction = null
    } = param1);
  }
  // Case 3: Positional with connection: (pool, roomId, arrivalDate, departureDate, excludeReservationId)
  else if (param1 && typeof param1 === 'object' && (typeof param2 === 'string' || typeof param2 === 'number')) {
    roomId = param2;
    arrivalDate = param3;
    departureDate = param4;
    excludeReservationId = param5 || null;
  }
  // Case 4: Positional without connection: (roomId, arrivalDate, departureDate, excludeReservationId)
  else {
    roomId = param1;
    arrivalDate = param2;
    departureDate = param3;
    excludeReservationId = param4 || null;
  }

  const sArr = parseToComparableDate(arrivalDate);
  const sDep = parseToComparableDate(departureDate);

  if (!sArr || !sDep || sArr >= sDep) {
    return { available: false, reason: 'Arrival date must be strictly before departure date', code: 'INVALID_DATES', room: null };
  }

  // 1. Resolve room document from Firestore
  const docId = roomId ? (String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId)) : (roomNumber ? formatRoomId(roomNumber) : null);
  if (!docId) {
    return { available: false, reason: 'Room ID or room number is required', code: 'INVALID_ROOM_PARAM', room: null };
  }

  let room = await getDoc(ROOMS_COLLECTION, docId, { transaction });
  if (!room && roomNumber) {
    const byNum = await listDocs(ROOMS_COLLECTION, {
      filters: [{ field: 'number', op: '==', value: String(roomNumber) }],
      limit: 1,
      transaction
    });
    room = byNum[0] || null;
  }

  if (!room) {
    return { available: false, reason: `Room ${roomNumber || roomId} not found`, code: 'ROOM_NOT_FOUND', room: null };
  }

  // 2. Active status check
  const isActive = room.is_active !== undefined ? Boolean(room.is_active) : (room.is_active_val !== undefined ? Boolean(room.is_active_val) : true);
  if (!isActive) {
    return { available: false, reason: `Room ${room.number} is inactive`, code: 'ROOM_INACTIVE', room };
  }

  // 3. Physical status check
  const roomStatus = room.status || 'vacant';
  if (BLOCKED_ROOM_STATUSES.includes(roomStatus)) {
    return {
      available: false,
      reason: `Room ${room.number} is not available (status: ${roomStatus})`,
      code: 'ROOM_UNAVAILABLE',
      room
    };
  }

  // 4. Housekeeping status check
  const hkStatus = room.housekeeping_status || room.cleaning_status || 'Clean';
  if (hkStatus === 'Dirty' || roomStatus === 'dirty') {
    return {
      available: false,
      reason: `Room ${room.number} is under housekeeping and not yet clean`,
      code: 'ROOM_DIRTY',
      room
    };
  }

  // 5. Active booking conflicts
  const bookingConflicts = await getConflictingBookingsFirestore({
    roomId: room.id || docId,
    roomNumber: room.number,
    arrivalDate: sArr,
    departureDate: sDep,
    excludeBookingId,
    transaction
  });

  if (bookingConflicts.length > 0) {
    return {
      available: false,
      reason: `Room ${room.number} is occupied during the requested dates`,
      code: 'ROOM_OCCUPIED_BOOKING',
      room
    };
  }

  // 6. Active reservation conflicts
  const resConflicts = await getConflictingReservationsFirestore({
    roomId: room.id || docId,
    roomNumber: room.number,
    arrivalDate: sArr,
    departureDate: sDep,
    excludeReservationId,
    transaction
  });

  if (resConflicts.length > 0) {
    return {
      available: false,
      reason: `Room ${room.number} already has a reservation during the requested dates`,
      code: 'ROOM_ALREADY_BOOKED',
      room
    };
  }

  return { available: true, reason: null, code: null, room };
}

/**
 * Boolean helper for read-only availability checks.
 */
export async function isRoomAvailableFirestore(params) {
  const result = await checkRoomAvailabilityFirestore(params);
  return result.available;
}

/**
 * Finds all available rooms in Firestore for a given date range and optional room type filter.
 *
 * @param {object} params
 * @param {string} params.arrivalDate
 * @param {string} params.departureDate
 * @param {string} [params.roomType='ALL']
 * @param {string|number} [params.roomTypeId]
 * @param {string|number} [params.excludeReservationId]
 * @param {string|number} [params.excludeBookingId]
 * @param {object} [params.transaction]
 *
 * @returns {Promise<Array<object>>} Available room objects in natural numeric order
 */
export async function findAvailableRoomsFirestore(param1, param2, param3, param4, param5) {
  let arrivalDate, departureDate, roomType = 'ALL', roomTypeId = null, excludeReservationId = null, excludeBookingId = null, transaction = null;

  // Case 1: param1 is connection/pool and param2 is options object
  if (param1 && typeof param1 === 'object' && !param1.arrivalDate && param2 && typeof param2 === 'object') {
    ({
      arrivalDate,
      departureDate,
      roomType = 'ALL',
      roomTypeId = null,
      excludeReservationId = null,
      excludeBookingId = null,
      transaction = null
    } = param2);
  }
  // Case 2: param1 is options object
  else if (param1 && typeof param1 === 'object' && param1.arrivalDate) {
    ({
      arrivalDate,
      departureDate,
      roomType = 'ALL',
      roomTypeId = null,
      excludeReservationId = null,
      excludeBookingId = null,
      transaction = null
    } = param1);
  }
  // Case 3: param1 is connection/pool followed by positional arguments: (pool, '2026-09-10', '2026-09-15', 'ALL', excludeReservationId)
  else if (param1 && typeof param1 === 'object' && typeof param2 === 'string') {
    arrivalDate = param2;
    departureDate = param3;
    roomType = param4 || 'ALL';
    excludeReservationId = param5 || null;
  }
  // Case 4: Positional arguments without connection: ('2026-09-10', '2026-09-15', 'ALL', excludeReservationId)
  else {
    arrivalDate = param1;
    departureDate = param2;
    roomType = param3 || 'ALL';
    excludeReservationId = param4 || null;
  }

  const sArr = parseToComparableDate(arrivalDate);
  const sDep = parseToComparableDate(departureDate);
  if (!sArr || !sDep || sArr >= sDep) {
    throw new Error('Arrival date must be strictly before departure date');
  }

  // 1. Fetch all rooms
  const allRooms = await listDocs(ROOMS_COLLECTION, { transaction });

  // 2. Fetch active bookings (single collection read)
  const allBookings = await listDocs(BOOKINGS_COLLECTION, { transaction });
  const activeBookings = allBookings.filter(b => {
    if (!b) return false;
    if (matchesExclusion(b, excludeBookingId)) return false;
    const status = b.booking_status || 'Checked In';
    return ACTIVE_BOOKING_STATUSES.includes(status);
  });

  // 3. Fetch active reservations (single collection read)
  const allReservations = await listDocs(RESERVATIONS_COLLECTION, { transaction });
  const activeReservations = allReservations.filter(r => {
    if (!r) return false;
    if (matchesExclusion(r, excludeReservationId)) return false;
    const status = r.status || 'Confirmed';
    return ACTIVE_RESERVATION_STATUSES.includes(status);
  });

  // 4. Filter available rooms
  const availableRooms = allRooms.filter(room => {
    if (!room) return false;

    // Room active check
    const isActive = room.is_active !== undefined ? Boolean(room.is_active) : (room.is_active_val !== undefined ? Boolean(room.is_active_val) : true);
    if (!isActive) return false;

    // Room type filter
    if (roomType && roomType !== 'ALL') {
      const typeCode = String(room.type || room.room_type || '').toUpperCase();
      if (typeCode !== String(roomType).toUpperCase()) return false;
    }
    if (roomTypeId !== null && roomTypeId !== undefined && room.room_type_id !== undefined && room.room_type_id !== null) {
      if (String(room.room_type_id) !== String(roomTypeId)) return false;
    }

    // Physical & housekeeping status
    const status = room.status || 'vacant';
    const hkStatus = room.housekeeping_status || room.cleaning_status || 'Clean';
    if (BLOCKED_ROOM_STATUSES.includes(status) || status === 'dirty' || hkStatus === 'Dirty') {
      return false;
    }

    const docId = room.id || formatRoomId(room.number);
    const num = room.number;
    const mysqlId = room.mysql_room_id;

    // Check booking overlap
    const hasBookingConflict = activeBookings.some(b => {
      if (!matchesRoom(b, docId, num, mysqlId)) return false;
      const bStart = b.check_in_date;
      const bEnd = b.expected_check_out_date || b.check_out_date || b.check_in_date;
      return isDateOverlap(sArr, sDep, bStart, bEnd);
    });
    if (hasBookingConflict) return false;

    // Check reservation overlap
    const hasReservationConflict = activeReservations.some(r => {
      if (!matchesRoom(r, docId, num, mysqlId)) return false;
      const rStart = r.arrival_date || r.check_in_date;
      const rEnd = r.departure_date || r.check_out_date;
      return isDateOverlap(sArr, sDep, rStart, rEnd);
    });
    if (hasReservationConflict) return false;

    return true;
  });

  return sortRoomsNumerically(availableRooms);
}

export class FirestoreAvailabilityService {
  static parseToComparableDate = parseToComparableDate;
  static isDateOverlap = isDateOverlap;
  static checkRoomAvailability = checkRoomAvailabilityFirestore;
  static isRoomAvailable = isRoomAvailableFirestore;
  static getAvailableRooms = findAvailableRoomsFirestore;
  static getConflictingBookings = getConflictingBookingsFirestore;
  static getConflictingReservations = getConflictingReservationsFirestore;
}

export default FirestoreAvailabilityService;
