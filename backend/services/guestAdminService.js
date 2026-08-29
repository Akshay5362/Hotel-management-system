/**
 * backend/services/guestAdminService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Authoritative Firestore-Only Guest Administration Service.
 *
 * Provides high-performance, unified querying and management for:
 *   1. Guests Dashboard list, KPI statistics, filtering, search, and pagination.
 *   2. Quick guest search for Reception staff & Admin.
 *   3. Guest government ID document verification and lifecycle.
 *
 * Optimized with:
 *   - 15-second short-TTL caching with single-flight stampede protection.
 *   - Proactive mutation invalidation across check-in, checkout, room shift, and guest profile edits.
 *   - Zero API contract changes (exact response schema parity).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';
import { formatGuestId, listDocs } from '../repositories/firestore/firestoreUtils.js';
import { globalTtlCache } from '../utils/ttlCache.js';

export const GUEST_DIRECTORY_CACHE_KEY = 'guest_directory_all';
export const GUEST_DOCUMENTS_CACHE_KEY = 'guest_documents_all';
export const GUEST_DIRECTORY_CACHE_TTL_MS = 15000; // 15 seconds

/**
 * Proactively invalidates all guest directory and document caches upon mutation.
 */
export function invalidateGuestDirectoryCache() {
  globalTtlCache.deleteByPrefix('guest_');
}

export class GuestAdminService {

  /**
   * Internal authoritative Firestore query execution fetching all guests and bookings,
   * enriching them with booking stats, active stay status, and history.
   */
  static async _loadAllEnrichedGuestsFromFirestore() {
    if (!db) {
      throw new Error('Firebase Admin DB is not initialized.');
    }

    const [allGuestsDocs, allBookingsDocs] = await Promise.all([
      listDocs('guests'),
      listDocs('bookings')
    ]);

    const guestsMap = new Map();
    allGuestsDocs.forEach(data => {
      if (!data) return;
      const gId = data.id || data.guest_id;
      guestsMap.set(gId, {
        id: gId,
        guest_id: gId,
        full_name: data.full_name || '',
        phone: data.phone || '',
        email: data.email || '',
        address: data.address || '',
        gst_no: data.gst_no || '',
        company_name: data.company_name || '',
        pincode: data.pincode || '',
        country: data.country || '',
        date_of_birth: data.date_of_birth || null,
        arrival_from: data.arrival_from || '',
        departure_to: data.departure_to || '',
        government_id: data.government_id || '',
        id_type: data.id_type || '',
        gender: data.gender || '',
        age: data.age !== undefined && data.age !== null ? data.age : '',
        id_verification_status: data.id_verification_status || 'Not Uploaded',
        loyalty_tier: data.loyalty_tier || 'Bronze',
        loyalty_points: Number(data.loyalty_points || 0),
        created_at: data.created_at || new Date().toISOString(),
        updated_at: data.updated_at || new Date().toISOString(),
        total_bookings: 0,
        lifetime_spend: 0,
        last_booking_at: null,
        current_room: null,
        current_status: null,
        current_booking_number: null,
        has_checked_out: false,
        bookings_history: []
      });
    });

    // Enrich guests with booking metrics and active stay data
    allBookingsDocs.forEach(b => {
      if (!b) return;
      let gId = b.guest_id || null;

      // Fallback matching if guest_id was formatted differently
      if (!gId || !guestsMap.has(gId)) {
        if (b.phone) {
          const phoneKey = `guest_${b.phone.trim()}`;
          if (guestsMap.has(phoneKey)) gId = phoneKey;
        }
      }

      if (!gId || !guestsMap.has(gId)) return;

      const guest = guestsMap.get(gId);
      guest.total_bookings += 1;
      guest.lifetime_spend += Number(b.total_amount || 0);

      const bCreated = b.created_at || b.check_in_date || '';
      if (!guest.last_booking_at || (bCreated && new Date(bCreated) > new Date(guest.last_booking_at))) {
        guest.last_booking_at = bCreated;
      }

      // Track active occupancy (prioritizing Checked In over Reserved)
      if (b.booking_status === 'Checked In') {
        guest.current_room = b.room_number ? String(b.room_number) : null;
        guest.current_status = 'Checked In';
        guest.current_booking_number = b.booking_number || null;
      } else if (b.booking_status === 'Reserved' && guest.current_status !== 'Checked In') {
        guest.current_room = b.room_number ? String(b.room_number) : null;
        guest.current_status = 'Reserved';
        guest.current_booking_number = b.booking_number || null;
      } else if (b.booking_status === 'Checked Out') {
        guest.has_checked_out = true;
      }

      guest.bookings_history.push({
        id: b.id,
        booking_number: b.booking_number,
        booking_status: b.booking_status,
        check_in_date: b.check_in_date,
        check_out_date: b.check_out_date,
        room_number: b.room_number,
        total_amount: Number(b.total_amount || 0),
        created_at: b.created_at
      });
    });

    return Array.from(guestsMap.values());
  }

  /**
   * Retrieves enriched guests from cache or executes single-flight fetch.
   */
  static async getEnrichedGuests({ skipCache = false, ttlMs = GUEST_DIRECTORY_CACHE_TTL_MS } = {}) {
    return await globalTtlCache.getOrSet(
      GUEST_DIRECTORY_CACHE_KEY,
      () => this._loadAllEnrichedGuestsFromFirestore(),
      ttlMs,
      { skipCache }
    );
  }

  /**
   * Fetches enriched guests and global dashboard metrics from Cloud Firestore with caching and deduplication.
   */
  static async listGuests({ page = 1, limit = 25, q = '', filter = 'all', skipCache = false } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const offset = (pageNum - 1) * limitNum;
    const searchStr = (q || '').trim().toUpperCase();

    // Retrieve cached enriched guests (coalesced into single flight)
    const allGuests = await this.getEnrichedGuests({ skipCache });
    const todayIsoDate = new Date().toISOString().split('T')[0];

    // Compute global Dashboard KPI statistics
    const stats = {
      total: allGuests.length,
      inhouse: allGuests.filter(g => g.current_status === 'Checked In' || g.current_status === 'Reserved').length,
      checkedout: allGuests.filter(g => g.has_checked_out && !g.current_status).length,
      vip: allGuests.filter(g => g.loyalty_tier === 'Gold' || g.loyalty_tier === 'Platinum').length,
      blacklisted: allGuests.filter(g => g.loyalty_tier === 'Blacklisted').length,
      new_today: allGuests.filter(g => (g.created_at || '').startsWith(todayIsoDate)).length
    };

    // Apply Filter
    let filteredGuests = allGuests;
    if (filter === 'inhouse') {
      filteredGuests = filteredGuests.filter(g => g.current_status === 'Checked In' || g.current_status === 'Reserved');
    } else if (filter === 'checkedout') {
      filteredGuests = filteredGuests.filter(g => g.has_checked_out && !g.current_status);
    } else if (filter === 'reserved') {
      filteredGuests = filteredGuests.filter(g => g.current_status === 'Reserved');
    } else if (filter === 'vip') {
      filteredGuests = filteredGuests.filter(g => g.loyalty_tier === 'Gold' || g.loyalty_tier === 'Platinum');
    } else if (filter === 'blacklisted') {
      filteredGuests = filteredGuests.filter(g => g.loyalty_tier === 'Blacklisted');
    }

    // Apply Search Query if provided
    if (searchStr.length >= 2) {
      filteredGuests = filteredGuests.filter(g => {
        const nameMatch = (g.full_name || '').toUpperCase().includes(searchStr);
        const phoneMatch = (g.phone || '').includes(searchStr);
        const emailMatch = (g.email || '').toUpperCase().includes(searchStr);
        const idMatch = (g.government_id || '').toUpperCase().includes(searchStr);
        const guestIdMatch = (g.id || '').toUpperCase().includes(searchStr);
        const roomMatch = (g.current_room || '').includes(searchStr);
        const bookingNumMatch = (g.current_booking_number || '').toUpperCase().includes(searchStr);
        return nameMatch || phoneMatch || emailMatch || idMatch || guestIdMatch || roomMatch || bookingNumMatch;
      });
    }

    // Sort: In-house stays first, then most recent booking / registration
    filteredGuests.sort((a, b) => {
      const aInHouse = a.current_status ? 1 : 0;
      const bInHouse = b.current_status ? 1 : 0;
      if (aInHouse !== bInHouse) return bInHouse - aInHouse;

      const aTime = new Date(a.last_booking_at || a.created_at || 0).getTime();
      const bTime = new Date(b.last_booking_at || b.created_at || 0).getTime();
      return bTime - aTime;
    });

    const total = filteredGuests.length;
    const paginatedGuests = filteredGuests.slice(offset, offset + limitNum);

    return {
      guests: paginatedGuests,
      stats,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum) || 1
      }
    };
  }

  /**
   * Search guests by name, phone, email, or booking number.
   */
  static async searchGuests(q = '', { limit = 20, skipCache = false } = {}) {
    const searchStr = (q || '').trim().toUpperCase();
    if (searchStr.length < 2) return [];

    const result = await this.listGuests({ page: 1, limit: limit, q: searchStr, filter: 'all', skipCache });
    return result.guests;
  }

  /**
   * Search guests for Reception staff (enriched with recent booking summaries).
   */
  static async searchGuestsStaff(q = '', { limit = 30, skipCache = false } = {}) {
    const searchStr = (q || '').trim().toUpperCase();
    if (searchStr.length < 2) return [];

    const result = await this.listGuests({ page: 1, limit: limit, q: searchStr, filter: 'all', skipCache });
    return result.guests.map(g => {
      const lastBooking = g.bookings_history && g.bookings_history.length > 0 ? g.bookings_history[0] : null;
      return {
        ...g,
        last_booking_number: lastBooking ? lastBooking.booking_number : g.current_booking_number,
        last_booking_status: lastBooking ? lastBooking.booking_status : g.current_status,
        last_check_in: lastBooking ? lastBooking.check_in_date : null,
        last_check_out: lastBooking ? lastBooking.check_out_date : null
      };
    });
  }

  /**
   * Fetch all guests who have uploaded government ID documents with short-TTL caching.
   */
  static async getGuestDocuments({ skipCache = false } = {}) {
    return await globalTtlCache.getOrSet(
      GUEST_DOCUMENTS_CACHE_KEY,
      async () => {
        const allGuestsDocs = await listDocs('guests');
        const guests = [];

        allGuestsDocs.forEach(data => {
          if (!data) return;
          if (data.id_document_path || data.id_document_url || data.government_id) {
            guests.push({
              id: data.id || data.guest_id,
              full_name: data.full_name,
              government_id: data.government_id,
              id_type: data.id_type,
              id_document_path: data.id_document_path || data.id_document_url,
              id_upload_timestamp: data.id_upload_timestamp || data.updated_at,
              id_verification_status: data.id_verification_status || 'Pending',
              id_rejection_reason: data.id_rejection_reason || null,
              id_verified_by: data.id_verified_by || null,
              id_verified_at: data.id_verified_at || null,
              id_ocr_text: data.id_ocr_text || null
            });
          }
        });

        return guests;
      },
      GUEST_DIRECTORY_CACHE_TTL_MS,
      { skipCache }
    );
  }

  /**
   * Verify or reject a guest government ID document in Firestore.
   */
  static async verifyGuestDocument(guestId, { status, rejectionReason, adminId }) {
    if (!guestId) throw new Error('Guest ID is required');
    const docId = String(guestId).startsWith('guest_') ? String(guestId) : formatGuestId(guestId);
    const guestRef = db.collection('guests').doc(docId);
    const guestSnap = await guestRef.get();

    if (!guestSnap.exists) {
      const err = new Error('Guest document not found');
      err.status = 404;
      throw err;
    }

    const nowIso = new Date().toISOString();
    const updatePayload = {
      id_verification_status: status,
      id_rejection_reason: status === 'Rejected' ? (rejectionReason || 'Document could not be verified') : null,
      id_verified_by: adminId ? String(adminId) : 'admin',
      id_verified_at: nowIso,
      updated_at: nowIso
    };

    await guestRef.update(updatePayload);
    invalidateGuestDirectoryCache();
    return { success: true, message: `Document successfully marked as ${status}` };
  }

  /**
   * Delete a guest's uploaded identity document in Firestore.
   */
  static async deleteGuestDocument(guestId) {
    if (!guestId) throw new Error('Guest ID is required');
    const docId = String(guestId).startsWith('guest_') ? String(guestId) : formatGuestId(guestId);
    const guestRef = db.collection('guests').doc(docId);
    const guestSnap = await guestRef.get();

    if (!guestSnap.exists) {
      const err = new Error('Guest not found');
      err.status = 404;
      throw err;
    }

    const nowIso = new Date().toISOString();
    await guestRef.update({
      id_document_path: null,
      id_document_url: null,
      id_upload_timestamp: null,
      id_verification_status: 'Pending',
      id_rejection_reason: null,
      id_verified_by: null,
      id_verified_at: null,
      id_ocr_text: null,
      updated_at: nowIso
    });

    invalidateGuestDirectoryCache();
    return { success: true, message: 'Identity document deleted successfully' };
  }
}

export default GuestAdminService;
