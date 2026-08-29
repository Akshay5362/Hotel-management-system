/**
 * backend/services/guestRequestsService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Authoritative Firestore Service for Guest Requests Management.
 *
 * Provides:
 *  1. Short-TTL caching (15s) aligned with UI polling intervals
 *  2. In-flight promise deduplication (single-flight / stampede protection)
 *  3. Targeted Firestore query filters for active/pending requests only
 *  4. Proactive cache invalidation on request creation/resolution
 *  5. Complete schema parity with frontend expectations
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';
import { listDocs, getDoc, setDoc, updateDoc, getDocsByIds, formatBookingId, formatRoomId, formatGuestId } from '../repositories/firestore/firestoreUtils.js';
import { globalTtlCache } from '../utils/ttlCache.js';
import { FirestoreAvailabilityService } from './firestoreAvailabilityService.js';
import { invalidateRoomStatusCache } from './firestoreRoomStatusService.js';

export const GUEST_REQUESTS_CACHE_KEY = 'admin_guest_requests';
export const GUEST_REQUESTS_CACHE_TTL_MS = 15000; // 15 seconds

/**
 * Proactively invalidates the guest requests cache upon any request mutation.
 */
export function invalidateGuestRequestsCache() {
  globalTtlCache.delete(GUEST_REQUESTS_CACHE_KEY);
}

export class GuestRequestsService {

  /**
   * Retrieves all pending/active guest requests across categories with short-TTL caching
   * and single-flight in-flight request deduplication.
   *
   * @param {object} [options]
   * @param {boolean} [options.skipCache=false]
   * @param {number} [options.ttlMs=15000]
   * @returns {Promise<{ requests: Array<object>, total: number }>}
   */
  static async getGuestRequests(options = {}) {
    const { skipCache = false, ttlMs = GUEST_REQUESTS_CACHE_TTL_MS } = options;

    return await globalTtlCache.getOrSet(
      GUEST_REQUESTS_CACHE_KEY,
      () => this._fetchGuestRequestsFromFirestore(),
      ttlMs,
      { skipCache }
    );
  }

  /**
   * Internal authoritative Firestore query execution fetching only pending/active items.
   */
  static async _fetchGuestRequestsFromFirestore() {
    if (!db) {
      throw new Error('Firebase Admin DB is not initialized.');
    }

    try {
      // 1. Fetch pending service requests (ledger_items with status == 'Pending')
      const rawServiceItems = await listDocs('ledger_items', {
        filters: [{ field: 'status', op: '==', value: 'Pending' }],
        limit: 100
      });

      // Filter out non-service charges
      const serviceItems = rawServiceItems.filter(item => {
        const desc = String(item.desc || item.description || '');
        return !desc.includes('Room Tariff') &&
               !desc.includes('Taxes') &&
               !desc.includes('GST') &&
               !desc.includes('Deposit') &&
               !desc.includes('Advance');
      });

      // 2. Fetch pending maintenance requests
      const maintenanceItems = await listDocs('maintenance', {
        filters: [{ field: 'status', op: 'in', value: ['Pending', 'In Progress'] }],
        limit: 100
      });

      // 3. Fetch pending stay extension requests
      const extensionRequests = await listDocs('stay_extension_requests', {
        filters: [{ field: 'status', op: '==', value: 'Pending' }],
        limit: 100
      });

      // 4. Fetch checkout requests from audit_logs
      const checkoutLogs = await listDocs('audit_logs', {
        filters: [{ field: 'action', op: '==', value: 'GUEST_CHECKOUT_REQUEST' }],
        limit: 50
      });

      // Collect IDs for enrichment
      const bookingIdsToFetch = new Set();
      const roomIdsToFetch = new Set();
      const guestIdsToFetch = new Set();

      const allItems = [...serviceItems, ...maintenanceItems, ...extensionRequests, ...checkoutLogs];
      allItems.forEach(item => {
        if (item.booking_id) {
          bookingIdsToFetch.add(String(item.booking_id).startsWith('bkg_') ? String(item.booking_id) : formatBookingId(item.booking_id));
        }
        if (item.room_id || item.room_number) {
          const rId = item.room_id ? String(item.room_id) : `room_${item.room_number}`;
          roomIdsToFetch.add(rId.startsWith('room_') ? rId : formatRoomId(rId));
        }
        if (item.guest_id) {
          guestIdsToFetch.add(String(item.guest_id).startsWith('guest_') ? String(item.guest_id) : formatGuestId(item.guest_id));
        }
      });

      // Batch lookups for related documents
      const [bookingsList, roomsList, guestsList] = await Promise.all([
        bookingIdsToFetch.size > 0 ? getDocsByIds('bookings', Array.from(bookingIdsToFetch)) : [],
        roomIdsToFetch.size > 0 ? getDocsByIds('rooms', Array.from(roomIdsToFetch)) : [],
        guestIdsToFetch.size > 0 ? getDocsByIds('guests', Array.from(guestIdsToFetch)) : []
      ]);

      const bookingsMap = new Map();
      bookingsList.forEach(b => {
        if (!b) return;
        if (b.id) bookingsMap.set(String(b.id), b);
        if (b.booking_number) bookingsMap.set(String(b.booking_number), b);
        if (b.mysql_booking_id) bookingsMap.set(String(b.mysql_booking_id), b);
      });

      const roomsMap = new Map();
      roomsList.forEach(r => {
        if (!r) return;
        const num = String(r.number || r.room_number || '').replace(/^room_/, '');
        if (num) roomsMap.set(num, r);
        if (r.id) roomsMap.set(String(r.id), r);
      });

      const guestsMap = new Map();
      guestsList.forEach(g => {
        if (!g) return;
        if (g.id) guestsMap.set(String(g.id), g);
        if (g.mysql_guest_id) guestsMap.set(String(g.mysql_guest_id), g);
        if (g.user_id) guestsMap.set(String(g.user_id), g);
        if (g.user_uid) guestsMap.set(String(g.user_uid), g);
      });

      // Format Service Requests
      const formattedServices = serviceItems.map(item => {
        const bkg = (item.booking_id && bookingsMap.get(String(item.booking_id))) || {};
        const roomNum = item.room_number || bkg.room_number || '';
        const roomObj = roomsMap.get(String(roomNum)) || {};
        const guestObj = (bkg.guest_id && guestsMap.get(String(bkg.guest_id))) || {};

        return {
          id: `svc_${item.id || item.mysql_ledger_id || item.doc_id}`,
          raw_id: item.id || item.mysql_ledger_id || item.doc_id,
          desc: item.desc || item.description || 'Service Request',
          qty: Number(item.qty || 1),
          amount: Number(item.amount || item.debit_amount || 0),
          business_date: item.business_date || null,
          created_at: item.created_at || new Date().toISOString(),
          room_number: String(roomNum),
          room_type: roomObj.type || roomObj.room_type || 'Standard',
          guest_name: bkg.guest_name || guestObj.full_name || 'Guest',
          guest_phone: guestObj.phone || '',
          booking_number: bkg.booking_number || '',
          booking_id: item.booking_id || bkg.id || null,
          request_type: 'service',
          status: item.status || 'Pending'
        };
      });

      // Format Maintenance Requests
      const formattedMaintenance = maintenanceItems.map(item => {
        const roomNum = item.room_number || (item.room_id ? String(item.room_id).replace(/^room_/, '') : '');
        const roomObj = roomsMap.get(String(roomNum)) || (item.room_id && roomsMap.get(String(item.room_id))) || {};
        const guestObj = (item.reported_by && guestsMap.get(String(item.reported_by))) || {};

        return {
          id: `mnt_${item.id || item.mysql_maintenance_id || item.doc_id}`,
          raw_id: item.id || item.mysql_maintenance_id || item.doc_id,
          desc: item.issue || item.desc || 'Maintenance Issue',
          status: item.status || 'Pending',
          business_date: item.business_date || null,
          created_at: item.created_at || new Date().toISOString(),
          room_number: String(roomNum),
          room_type: roomObj.type || roomObj.room_type || 'Standard',
          guest_name: guestObj.full_name || 'Guest',
          guest_phone: guestObj.phone || '',
          booking_number: item.booking_number || '',
          booking_id: item.booking_id || null,
          request_type: 'maintenance'
        };
      });

      // Format Stay Extension Requests
      const formattedExtensions = extensionRequests.map(item => {
        const bkg = (item.booking_id && bookingsMap.get(String(item.booking_id))) || {};
        const roomNum = item.room_number || bkg.room_number || (item.room_id ? String(item.room_id).replace(/^room_/, '') : '');
        const roomObj = roomsMap.get(String(roomNum)) || {};
        const guestObj = (item.guest_id && guestsMap.get(String(item.guest_id))) || (bkg.guest_id && guestsMap.get(String(bkg.guest_id))) || {};

        return {
          id: `ext_${item.id || item.request_id || item.mysql_extension_id}`,
          raw_id: item.id || item.request_id || item.mysql_extension_id,
          desc: `Requested Extension to: ${item.requested_checkout_date}`,
          business_date: item.business_date || null,
          created_at: item.created_at || new Date().toISOString(),
          request_type: 'extension_request',
          status: item.status || 'Pending',
          guest_name: bkg.guest_name || guestObj.full_name || 'Guest',
          guest_phone: guestObj.phone || '',
          booking_number: bkg.booking_number || '',
          booking_id: item.booking_id || bkg.id || null,
          room_number: String(roomNum),
          room_type: roomObj.type || roomObj.room_type || 'Standard',
          requested_checkout_date: item.requested_checkout_date
        };
      });

      // Format Checkout Requests
      const formattedCheckout = checkoutLogs.map(item => {
        const guestObj = (item.user_id && guestsMap.get(String(item.user_id))) || {};
        return {
          id: `co_${item.id || item.log_id}`,
          raw_id: item.id || item.log_id,
          desc: item.details || 'Guest requested checkout assistance',
          business_date: item.business_date || null,
          created_at: item.created_at || new Date().toISOString(),
          request_type: 'checkout_request',
          status: 'Pending',
          guest_name: guestObj.full_name || 'Guest',
          room_number: item.room_number || '',
          room_type: 'Standard'
        };
      });

      // Combine and sort chronologically (newest first)
      const allRequests = [
        ...formattedServices,
        ...formattedMaintenance,
        ...formattedCheckout,
        ...formattedExtensions
      ].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

      return {
        requests: allRequests,
        total: allRequests.length
      };
    } catch (err) {
      console.error('[GuestRequestsService] Firestore fetch failed:', err.message);
      throw err;
    }
  }

  /**
   * Acknowledges and resolves a service, maintenance, or checkout request in Firestore.
   */
  static async resolveRequest(requestId, resolvedUserId = 'admin') {
    if (!requestId) {
      const err = new Error('Request ID is required');
      err.status = 400;
      throw err;
    }

    const strId = String(requestId).trim();
    const nowIso = new Date().toISOString();

    if (strId.startsWith('svc_')) {
      const realId = strId.replace('svc_', '');
      const docId = String(realId).startsWith('ledger_') ? String(realId) : `ledger_${realId}`;
      await setDoc('ledger_items', docId, {
        status: 'Completed',
        resolved_by: String(resolvedUserId),
        resolved_at: nowIso,
        updated_at: nowIso
      }, { merge: true });
    } else if (strId.startsWith('mnt_')) {
      const realId = strId.replace('mnt_', '');
      const docId = String(realId).startsWith('maint_') ? String(realId) : `maint_${realId}`;
      await setDoc('maintenance', docId, {
        status: 'Resolved',
        resolved_by: String(resolvedUserId),
        resolved_at: nowIso,
        updated_at: nowIso
      }, { merge: true });
    } else if (strId.startsWith('co_')) {
      const realId = strId.replace('co_', '');
      const docId = String(realId).startsWith('audit_') ? String(realId) : `audit_${realId}`;
      await setDoc('audit_logs', docId, {
        action: 'GUEST_CHECKOUT_REQUEST_PROCESSED',
        processed_by: String(resolvedUserId),
        processed_at: nowIso,
        updated_at: nowIso
      }, { merge: true });
    } else {
      const err = new Error('Invalid request ID format');
      err.status = 400;
      throw err;
    }

    // Invalidate caches
    invalidateGuestRequestsCache();
    invalidateRoomStatusCache();

    return { success: true, message: 'Request resolved successfully' };
  }

  /**
   * Approves or rejects a stay extension request in Firestore.
   */
  static async resolveExtensionRequest(requestId, action, resolvedUserId = 'admin') {
    if (!requestId) {
      const err = new Error('Request ID is required');
      err.status = 400;
      throw err;
    }

    if (!['approve', 'reject'].includes(action)) {
      const err = new Error('Invalid action. Must be approve or reject');
      err.status = 400;
      throw err;
    }

    const strId = String(requestId).trim();
    const docId = strId.startsWith('ext_') ? strId : `ext_${strId}`;
    const extDoc = await getDoc('stay_extension_requests', docId);

    if (!extDoc || extDoc.status !== 'Pending') {
      const err = new Error('Pending extension request not found');
      err.status = 404;
      throw err;
    }

    const nowIso = new Date().toISOString();

    if (action === 'approve') {
      const bookingDocId = extDoc.booking_id ? (String(extDoc.booking_id).startsWith('bkg_') ? String(extDoc.booking_id) : formatBookingId(extDoc.booking_id)) : null;
      const bkgDoc = bookingDocId ? await getDoc('bookings', bookingDocId) : null;

      if (!bkgDoc) {
        const err = new Error('Associated booking not found for extension');
        err.status = 404;
        throw err;
      }

      // Check room availability for extended period
      const avail = await FirestoreAvailabilityService.checkRoomAvailability(null, {
        roomId: extDoc.room_id || bkgDoc.room_id,
        roomNumber: extDoc.room_number || bkgDoc.room_number,
        arrivalDate: extDoc.current_checkout_date || bkgDoc.expected_check_out_date,
        departureDate: extDoc.requested_checkout_date
      });

      if (!avail.available) {
        const err = new Error(`Cannot approve extension: ${avail.reason || 'Room is unavailable for the selected dates'}`);
        err.status = 400;
        throw err;
      }

      // Update booking expected_check_out_date
      await setDoc('bookings', bookingDocId, {
        expected_check_out_date: extDoc.requested_checkout_date,
        updated_at: nowIso
      }, { merge: true });

      // Update extension request status
      await setDoc('stay_extension_requests', docId, {
        status: 'Approved',
        admin_id: String(resolvedUserId),
        resolved_at: nowIso,
        updated_at: nowIso
      }, { merge: true });

    } else {
      // Reject
      await setDoc('stay_extension_requests', docId, {
        status: 'Rejected',
        admin_id: String(resolvedUserId),
        resolved_at: nowIso,
        updated_at: nowIso
      }, { merge: true });
    }

    // Invalidate caches
    invalidateGuestRequestsCache();
    invalidateRoomStatusCache();

    return {
      success: true,
      message: action === 'approve'
        ? `Stay extension approved to ${extDoc.requested_checkout_date}`
        : 'Stay extension request rejected'
    };
  }
}
