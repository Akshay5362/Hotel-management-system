/**
 * backend/services/firestoreRoomStatusService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Native Firestore Room Status Aggregator for HPMS.
 *
 * Provides 100% semantic and structural parity with the MySQL RoomStatusService
 * and auditController getStatus response without performing multi-table SQL joins.
 *
 * NOTE: During migration phase 1, MySQL remains the production source of truth.
 * This service provides the verified NoSQL room status aggregator.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';
import { listDocs, getDoc, getDocsByIds, formatRoomId, formatBookingId, formatGuestId } from '../repositories/firestore/firestoreUtils.js';
import { parseToComparableDate, sortRoomsNumerically } from './firestoreAvailabilityService.js';
import { globalTtlCache } from '../utils/ttlCache.js';

const ROOMS_COLLECTION = 'rooms';
const BOOKINGS_COLLECTION = 'bookings';
const RESERVATIONS_COLLECTION = 'reservations';
const GUESTS_COLLECTION = 'guests';
const LEDGER_COLLECTION = 'ledger_items';

export const ROOM_STATUS_CACHE_TTL_MS = 30000; // 30 seconds TTL aligned with polling intervals

/**
 * Invalidate all cached room status aggregations immediately upon room/booking mutation.
 */
export function invalidateRoomStatusCache() {
  globalTtlCache.deleteByPrefix('room_status_');
}

/**
 * Checks if a booking or reservation entity matches a given room.
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

let lastKnownGoodRoomStatuses = null;

export class FirestoreRoomStatusService {

  /**
   * Aggregates dynamic room statuses across Firestore collections with safe 30-second TTL caching
   * and single-flight in-flight request deduplication to eliminate stampedes.
   *
   * @param {string} businessDate - Business date string (e.g. '2026-08-19' or '19-Aug-2026')
   * @param {object} [options]
   * @param {boolean} [options.includeLedger=true] - Whether to attach folio ledger items
   * @param {object} [options.transaction] - Optional Firestore transaction
   * @param {boolean} [options.skipCache=false] - Bypass cache
   * @param {number} [options.ttlMs] - Optional custom TTL override (defaults to 30000ms)
   * @returns {Promise<Array<object>>} Computed room statuses in natural numerical order
   */
  static async getRoomStatuses(businessDate = '2026-08-19', options = {}) {
    const { includeLedger = true, transaction = null, skipCache = false, ttlMs = ROOM_STATUS_CACHE_TTL_MS } = options;

    // Transactional reads or explicit skipCache bypass cache completely
    if (transaction || skipCache) {
      return await this._fetchRoomStatusesFromFirestore(businessDate, options);
    }

    const sysComp = parseToComparableDate(businessDate) || new Date().toISOString().split('T')[0];
    const cacheKey = `room_status_${sysComp}_${includeLedger ? 'with_ledger' : 'no_ledger'}`;

    return await globalTtlCache.getOrSet(
      cacheKey,
      () => this._fetchRoomStatusesFromFirestore(businessDate, options),
      ttlMs,
      { skipCache }
    );
  }

  /**
   * Internal authoritative Firestore query execution with last-known-good fallback on quota exhaustion.
   */
  static async _fetchRoomStatusesFromFirestore(businessDate = '2026-08-19', options = {}) {
    if (!db) {
      throw new Error('Firebase Admin DB is not initialized.');
    }

    const { includeLedger = true, transaction = null } = options;
    const sysComp = parseToComparableDate(businessDate) || new Date().toISOString().split('T')[0];

    try {

    // ── 1. Batch fetch rooms (finite inventory) ──────────────────────────────
    const allRooms = await listDocs(ROOMS_COLLECTION, { transaction });

    // ── 2. Query ONLY active bookings (Checked In / Reserved) ────────────────
    const activeBookings = await listDocs(BOOKINGS_COLLECTION, {
      filters: [{ field: 'booking_status', op: 'in', value: ['Checked In', 'Reserved'] }],
      transaction
    });

    // ── 3. Query ONLY active reservations (Reserved / Confirmed) ─────────────
    const activeReservations = await listDocs(RESERVATIONS_COLLECTION, {
      filters: [{ field: 'status', op: 'in', value: ['Reserved', 'Confirmed'] }],
      transaction
    });

    // ── 4. Batch fetch ONLY required guest profiles by ID ────────────────────
    const guestIdsNeeded = new Set();
    activeBookings.forEach(b => {
      if (b.guest_id) {
        guestIdsNeeded.add(String(b.guest_id).startsWith('guest_') ? String(b.guest_id) : formatGuestId(b.guest_id));
        guestIdsNeeded.add(String(b.guest_id));
      }
      if (b.mysql_guest_id) {
        guestIdsNeeded.add(formatGuestId(b.mysql_guest_id));
        guestIdsNeeded.add(String(b.mysql_guest_id));
      }
    });

    let guestsMap = new Map();
    if (guestIdsNeeded.size > 0) {
      const activeGuests = await getDocsByIds(GUESTS_COLLECTION, Array.from(guestIdsNeeded), { transaction });
      activeGuests.forEach(g => {
        if (!g) return;
        if (g.id) guestsMap.set(String(g.id), g);
        if (g.doc_id) guestsMap.set(String(g.doc_id), g);
        if (g.mysql_guest_id) guestsMap.set(String(g.mysql_guest_id), g);
        if (g.mysql_id) guestsMap.set(String(g.mysql_id), g);
        if (g.user_id) guestsMap.set(String(g.user_id), g);
        if (g.phone) guestsMap.set(String(g.phone), g);
      });
    }

    // ── 5. Query ONLY relevant ledger items for active bookings ───────────────
    let ledgerByBookingMap = new Map();
    let ledgerByRoomMap = new Map();
    if (includeLedger && activeBookings.length > 0) {
      const targetBkgKeys = new Set();
      const targetRoomNumbers = new Set();

      activeBookings.forEach(b => {
        if (b.id) targetBkgKeys.add(String(b.id));
        if (b.docId) targetBkgKeys.add(String(b.docId));
        if (b.booking_id) targetBkgKeys.add(String(b.booking_id));
        if (b.mysql_booking_id) {
          targetBkgKeys.add(String(b.mysql_booking_id));
          targetBkgKeys.add(`bkg_${b.mysql_booking_id}`);
        }
        if (b.booking_number) {
          targetBkgKeys.add(String(b.booking_number));
          targetBkgKeys.add(`bkg_${b.booking_number}`);
        }
        if (b.room_number) {
          targetRoomNumbers.add(String(b.room_number));
        }
      });

      const bkgKeyList = Array.from(targetBkgKeys).filter(Boolean);
      let allLedgerItems = [];

      if (bkgKeyList.length > 0) {
        // Chunk booking IDs into batches of up to 30 for Firestore 'in' query
        const chunkSize = 30;
        for (let i = 0; i < bkgKeyList.length; i += chunkSize) {
          const chunk = bkgKeyList.slice(i, i + chunkSize);
          const chunkItems = await listDocs(LEDGER_COLLECTION, {
            filters: [{ field: 'booking_id', op: 'in', value: chunk }],
            transaction
          });
          allLedgerItems.push(...chunkItems);
        }
      }

      // Also fetch any room-level ledger items for active occupied rooms
      const roomNumList = Array.from(targetRoomNumbers).filter(Boolean);
      if (roomNumList.length > 0) {
        const chunkSize = 30;
        for (let i = 0; i < roomNumList.length; i += chunkSize) {
          const chunk = roomNumList.slice(i, i + chunkSize);
          const chunkItems = await listDocs(LEDGER_COLLECTION, {
            filters: [{ field: 'room_number', op: 'in', value: chunk }],
            transaction
          });
          allLedgerItems.push(...chunkItems);
        }
      }

      // Deduplicate fetched ledger items by ID
      const seenLedgerIds = new Set();
      allLedgerItems.forEach(item => {
        if (!item) return;
        const itemId = item.id || item.doc_id || item.mysql_ledger_id;
        if (itemId && seenLedgerIds.has(String(itemId))) return;
        if (itemId) seenLedgerIds.add(String(itemId));

        const bkgKey = item.booking_id ? String(item.booking_id) : null;
        const roomKey = item.room_number ? String(item.room_number) : (item.room_id ? String(item.room_id).replace(/^room_/, '') : null);

        const cleanItem = {
          id: item.mysql_ledger_id || item.id || item.doc_id,
          desc: item.desc || item.description || '',
          qty: Number(item.qty || 1),
          amount: Number(item.amount || item.debit_amount || 0),
          transaction_type: item.transaction_type || 'DEBIT',
          payment_mode: item.payment_mode || null,
          time: item.time || null,
          business_date: item.business_date || sysComp
        };

        if (bkgKey) {
          if (!ledgerByBookingMap.has(bkgKey)) ledgerByBookingMap.set(bkgKey, []);
          ledgerByBookingMap.get(bkgKey).push(cleanItem);
          const rawBkgKey = bkgKey.replace(/^bkg_/, '');
          if (rawBkgKey !== bkgKey) {
            if (!ledgerByBookingMap.has(rawBkgKey)) ledgerByBookingMap.set(rawBkgKey, []);
            ledgerByBookingMap.get(rawBkgKey).push(cleanItem);
          }
        }
        if (roomKey) {
          if (!ledgerByRoomMap.has(roomKey)) ledgerByRoomMap.set(roomKey, []);
          ledgerByRoomMap.get(roomKey).push(cleanItem);
        }
      });
    }

    // ── 6. Deterministically calculate room status & merge guest data ─────────
    const processedRooms = allRooms.map(r => {
      const roomNumStr = String(
        r.number ||
        r.room_number ||
        r.roomNumber ||
        r.room_no ||
        (r.id ? String(r.id).replace(/^room_/, '') : '') ||
        (r.docId ? String(r.docId).replace(/^room_/, '') : '') ||
        ''
      ).trim();
      const roomDocId = r.id || r.docId || (roomNumStr ? formatRoomId(roomNumStr) : null);
      const mysqlRoomId = r.mysql_room_id !== undefined && r.mysql_room_id !== null ? Number(r.mysql_room_id) : (!isNaN(Number(roomNumStr)) ? Number(roomNumStr) : null);
      const isActive = r.is_active !== false && r.is_active !== 0 && r.is_active !== '0';

      const dbStatus = r.status || 'vacant';
      let computedStatus = dbStatus;
      let currentBooking = null;
      let currentReservation = null;

      // ── MATCH ACTIVE BOOKING ────────────────────────────────────────────────
      const matchingBooking = activeBookings.find(b => {
        if (!b) return false;
        if (b.booking_status !== 'Checked In') return false;
        return matchesRoom(b, roomDocId, roomNumStr, mysqlRoomId);
      });

      if (matchingBooking) {
        currentBooking = matchingBooking;
        computedStatus = 'occupied';
      }

      // ── AUTO-HEAL GHOST OCCUPANCY ───────────────────────────────────────────
      // If doc says 'occupied' but no active Checked In booking exists, revert to 'vacant'
      if (dbStatus === 'occupied' && !currentBooking) {
        computedStatus = 'vacant';
      }

      // ── MATCH ACTIVE RESERVATION ────────────────────────────────────────────
      if (computedStatus === 'vacant' && !currentBooking) {
        const matchingRes = activeReservations.find(res => {
          if (!matchesRoom(res, roomDocId, roomNumStr, mysqlRoomId)) return false;
          const arrComp = parseToComparableDate(res.check_in_date || res.arrival_date);
          const depComp = parseToComparableDate(res.check_out_date || res.departure_date);
          if (arrComp && depComp && sysComp) {
            return arrComp <= sysComp && sysComp < depComp;
          }
          return arrComp === sysComp;
        });

        if (matchingRes) {
          computedStatus = 'booked';
          currentReservation = matchingRes;
        }
      }

      // ── HOUSEKEEPING DIRTY OVERRIDE ─────────────────────────────────────────
      const isHkDirty = r.housekeeping_status === 'Dirty' || r.cleaning_status === 'Dirty' || dbStatus === 'dirty';
      if ((computedStatus === 'vacant' || computedStatus === 'booked') && !currentBooking && isHkDirty) {
        computedStatus = 'dirty';
      }

      // ── OPERATIONAL INACTIVE OVERRIDE ───────────────────────────────────────
      if (!isActive && computedStatus === 'vacant' && !currentBooking) {
        computedStatus = 'inactive';
      }

      // ── GUEST & FOLIO ENRICHMENT ────────────────────────────────────────────
      let guestName = '';
      let phone = '';
      let dateOfBirth = '';
      let pax = 0;
      let deposit = 0;
      let checkInDate = '';
      let expectedCheckOutDate = '';
      let address = '';
      let gstNo = '';
      let pincode = '';
      let country = '';
      let arrivalFrom = '';
      let departureTo = '';
      let companyName = '';
      let city = '';
      let state = '';
      let userId = null;
      let bookingId = null;
      let reservationId = null;
      let bookingNumber = null;
      let billingInstruction = 'Direct to Guest';
      let mealPlan = 'EP';
      let roomTariff = Number(r.price || r.base_rate || r.rate || 0);
      let paymentMode = null;
      let purposeOfVisit = null;

      if (currentBooking) {
        // Resolve guest document for enriched profile fields if missing from booking
        const gstDoc = (currentBooking.guest_id && guestsMap.get(String(currentBooking.guest_id))) ||
                       (currentBooking.mysql_guest_id && guestsMap.get(String(currentBooking.mysql_guest_id))) ||
                       null;

        guestName = String(currentBooking.guest_name || currentBooking.guestName || gstDoc?.full_name || '').toUpperCase();
        phone = currentBooking.phone || gstDoc?.phone || '';
        dateOfBirth = currentBooking.date_of_birth || gstDoc?.date_of_birth || '';
        pax = Number(currentBooking.adults || 1) + Number(currentBooking.children || 0);
        deposit = Number(currentBooking.advance_amount || currentBooking.deposit || 0);
        checkInDate = currentBooking.check_in_date || currentBooking.checkInDate || '';
        expectedCheckOutDate = currentBooking.expected_check_out_date || currentBooking.expectedCheckOutDate || '';
        address = currentBooking.address || gstDoc?.address || '';
        gstNo = currentBooking.gst_no || gstDoc?.gst_no || '';
        pincode = currentBooking.pincode || gstDoc?.pincode || '';
        country = currentBooking.country || gstDoc?.country || '';
        arrivalFrom = currentBooking.arrival_from || gstDoc?.arrival_from || '';
        departureTo = currentBooking.departure_to || gstDoc?.departure_to || '';
        companyName = currentBooking.company_name || gstDoc?.company_name || '';
        city = currentBooking.city || gstDoc?.city || '';
        state = currentBooking.state || gstDoc?.state || '';
        userId = currentBooking.user_id || currentBooking.guest_user_uid || gstDoc?.user_id || null;
        bookingId = currentBooking.mysql_booking_id || currentBooking.id || currentBooking.docId;
        bookingNumber = currentBooking.booking_number || (currentBooking.id ? String(currentBooking.id).replace(/^bkg_/, '') : null);
        billingInstruction = currentBooking.billing_instruction || 'Direct to Guest';
        mealPlan = currentBooking.meal_plan || 'EP';
        roomTariff = currentBooking.room_tariff !== undefined && currentBooking.room_tariff !== null ? Number(currentBooking.room_tariff) : Number(r.price || r.base_rate || r.rate || 0);
        paymentMode = currentBooking.payment_mode || currentBooking.bookingPaymentMode || null;
        purposeOfVisit = currentBooking.purpose_of_visit || null;
      } else if (currentReservation) {
        guestName = String(currentReservation.guest_name || currentReservation.guestName || '').toUpperCase();
        phone = currentReservation.phone || '';
        dateOfBirth = currentReservation.date_of_birth || '';
        pax = Number(currentReservation.pax || currentReservation.adults || 1);
        deposit = Number(currentReservation.advance_payment || currentReservation.deposit || 0);
        checkInDate = currentReservation.arrival_date || currentReservation.check_in_date || '';
        expectedCheckOutDate = currentReservation.departure_date || currentReservation.check_out_date || '';
        reservationId = currentReservation.mysql_reservation_id || currentReservation.id || currentReservation.docId;
        bookingNumber = currentReservation.reservation_number || currentReservation.booking_number || null;
        billingInstruction = currentReservation.billing_instructions || currentReservation.billing_instruction || 'Direct to Guest';
        mealPlan = currentReservation.meal_plan || 'EP';
      }

      // Resolve room ledger items for occupied rooms
      let ledger = [];
      if (includeLedger) {
        if (bookingId && ledgerByBookingMap.has(String(bookingId))) {
          ledger = ledgerByBookingMap.get(String(bookingId));
        } else if (currentBooking?.id && ledgerByBookingMap.has(String(currentBooking.id))) {
          ledger = ledgerByBookingMap.get(String(currentBooking.id));
        } else if (currentBooking?.docId && ledgerByBookingMap.has(String(currentBooking.docId))) {
          ledger = ledgerByBookingMap.get(String(currentBooking.docId));
        } else if (bookingNumber && ledgerByBookingMap.has(String(bookingNumber))) {
          ledger = ledgerByBookingMap.get(String(bookingNumber));
        } else if (roomNumStr && ledgerByRoomMap.has(roomNumStr)) {
          ledger = ledgerByRoomMap.get(roomNumStr);
        }
      }

      return {
        id: mysqlRoomId || roomDocId,
        doc_id: roomDocId,
        number: roomNumStr,
        type: r.type || r.room_type || 'EXECUTIVE',
        status: computedStatus,
        is_active: isActive,
        housekeeping_status: isHkDirty ? 'Dirty' : 'Clean',
        rate: Number(r.price || r.base_rate || r.rate || 0),
        guestName,
        phone,
        date_of_birth: dateOfBirth,
        pax,
        deposit,
        checkInDate,
        expectedCheckOutDate,
        address,
        gst_no: gstNo,
        pincode,
        country,
        arrival_from: arrivalFrom,
        departure_to: departureTo,
        company_name: companyName,
        city,
        state,
        user_id: userId,
        booking_id: bookingId,
        reservation_id: reservationId,
        booking_number: bookingNumber,
        billing_instruction: billingInstruction,
        meal_plan: mealPlan,
        room_tariff: roomTariff,
        payment_mode: paymentMode,
        purpose_of_visit: purposeOfVisit,
        db_status: dbStatus,
        ledger,
        activeBooking: currentBooking || null,
        activeReservation: currentReservation || null
      };
    });

    const sortedRooms = sortRoomsNumerically(processedRooms);
    if (Array.isArray(sortedRooms) && sortedRooms.length > 0) {
      lastKnownGoodRoomStatuses = sortedRooms;
    }
    return sortedRooms;
  } catch (err) {
    const isQuota = err.code === 8 ||
      (err.message && (err.message.includes('RESOURCE_EXHAUSTED') || err.message.includes('Quota exceeded'))) ||
      (err.details && err.details.includes('Quota exceeded'));

    if (isQuota && lastKnownGoodRoomStatuses && Array.isArray(lastKnownGoodRoomStatuses) && lastKnownGoodRoomStatuses.length > 0 && !transaction) {
      console.warn('[FirestoreRoomStatusService] Returning last-known-good room status array due to Firestore quota exhaustion');
      return lastKnownGoodRoomStatuses;
    }
    throw err;
  }
}

  /**
   * Retrieves single room status in Firestore.
   */
  static async getRoomStatus(roomId, businessDate = '2026-08-19', options = {}) {
    const statuses = await this.getRoomStatuses(businessDate, options);
    const targetStr = String(roomId).replace(/^room_/, '');
    return statuses.find(r => String(r.id) === String(roomId) || String(r.number) === targetStr || r.doc_id === `room_${targetStr}`);
  }
}

export default FirestoreRoomStatusService;
