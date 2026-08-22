import { isFirestoreCheckInEnabled, isFirestoreCheckInServingEnabled } from '../config/featureFlags.js';
import { processCheckInFirestoreTransaction } from '../adapters/firestore/checkInFirestoreAdapter.js';
import { processCheckIn } from './checkInService.js';
import { db } from '../config/firebaseAdmin.js';
import { invalidateRoomStatusCache } from './firestoreRoomStatusService.js';
import { invalidateGuestDirectoryCache } from './guestAdminService.js';

export class CheckInCutoverService {
  /**
   * Reconcile unknown outcome: checks if a booking or idempotency key was committed.
   */
  static async reconcileUnknownOutcome({ idempotencyKey, roomNumber, phone, checkInDate }) {
    try {
      if (!db) return { committed: false };

      // 1. Check idempotency key if available
      if (idempotencyKey) {
        const idemSnap = await db.collection('idempotency_keys').doc(String(idempotencyKey)).get();
        if (idemSnap.exists && idemSnap.data().status === 'COMPLETED') {
          return { committed: true, result: idemSnap.data().result };
        }
      }

      // 2. Check room status and current booking
      const roomSnap = await db.collection('rooms').doc(`room_${roomNumber}`).get();
      if (roomSnap.exists && roomSnap.data().status === 'occupied' && roomSnap.data().current_booking_id) {
        const bkgSnap = await db.collection('bookings').doc(roomSnap.data().current_booking_id).get();
        if (bkgSnap.exists) {
          const bkg = bkgSnap.data();
          if (bkg.room_number === String(roomNumber) && bkg.check_in_date === checkInDate) {
            return {
              committed: true,
              result: {
                success: true,
                bookingId: bkgSnap.id,
                bookingNumber: bkg.booking_number,
                roomNumber: String(roomNumber),
                guestName: bkg.guest_name,
                checkInDate: bkg.check_in_date
              }
            };
          }
        }
      }

      return { committed: false };
    } catch (reconcileErr) {
      console.warn('[CheckInCutover] Reconciliation check failed:', reconcileErr.message);
      return { committed: false, error: reconcileErr };
    }
  }

  /**
   * Executes check-in with Firestore primary serving and safe fail-closed error handling.
   */
  static async executeCheckIn({
    connection,
    params,
    timeoutMs = 8000
  }) {
    const servingEnabled = isFirestoreCheckInEnabled() || isFirestoreCheckInServingEnabled();
    const { roomNumber, guestName, phone, checkInDate, idempotencyKey } = params;

    if (!servingEnabled) {
      let useConn = connection;
      let isLocalConn = false;
      if (!useConn) {
        const poolModule = await import('../db.js');
        useConn = await poolModule.default.getConnection();
        await useConn.beginTransaction();
        isLocalConn = true;
      }
      try {
        const result = await processCheckIn(useConn, params);
        if (isLocalConn) await useConn.commit();
        return { ...result, source: 'MYSQL' };
      } catch (mysqlErr) {
        if (isLocalConn && useConn) {
          try { await useConn.rollback(); } catch (_) {}
        }
        throw mysqlErr;
      } finally {
        if (isLocalConn && useConn) useConn.release();
      }
    }

    // ── Primary Firestore Path ──────────────────────────────────────────────
    const startTime = Date.now();

    try {
      // Bound Firestore execution with strict timeout
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: Check-in transaction exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const firestorePromise = processCheckInFirestoreTransaction(params).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([firestorePromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      // Validate result format
      if (!fsResult || !fsResult.bookingId) {
        throw new Error('FIRESTORE_VALIDATION_FAILED: Check-in returned empty or invalid booking ID');
      }

      console.log(`[CUTOVER_SERVING:CHECK_IN] Serving primary from Firestore in ${durationMs}ms:`, {
        domain: 'checkin',
        source: 'FIRESTORE',
        bookingId: fsResult.bookingId,
        bookingNumber: fsResult.bookingNumber,
        roomNumber
      });

      // Invalidate room status and guest directory aggregation caches
      invalidateRoomStatusCache();
      invalidateGuestDirectoryCache();

      return {
        ...fsResult,
        source: 'FIRESTORE',
        durationMs
      };

    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // ── Detect Business Validation Errors (MUST NOT FALL BACK) ─────────────
      if (
        fsErr.code === 'ALREADY_CHECKED_IN' ||
        fsErr.code === 'ROOM_INACTIVE' ||
        fsErr.code === 'ROOM_DIRTY' ||
        fsErr.code === 'ROOM_NOT_FOUND' ||
        fsErr.status === 400 ||
        fsErr.status === 404 ||
        fsErr.status === 409
      ) {
        throw fsErr;
      }

      // ── Detect Firestore Quota / Resource Exhaustion ───────────────────────
      if (fsErr.code === 8 || (fsErr.message && fsErr.message.includes('RESOURCE_EXHAUSTED')) || (fsErr.details && fsErr.details.includes('Quota exceeded'))) {
        const quotaErr = new Error('Firestore project daily quota has been exceeded (Google Cloud Spark Tier limit). Operation safely failed closed.');
        quotaErr.status = 503;
        quotaErr.code = 'FIRESTORE_RESOURCE_EXHAUSTED';
        throw quotaErr;
      }

      // ── Handle Unknown Outcome & Prevent Double Check-In ────────────────────
      const isTimeout = fsErr.message && fsErr.message.includes('FIRESTORE_TIMEOUT');
      if (!isTimeout) {
        const reconciliation = await this.reconcileUnknownOutcome({
          idempotencyKey,
          roomNumber,
          phone,
          checkInDate
        });

        if (reconciliation.committed && reconciliation.result) {
          console.log('[CheckInCutover] Reconciled successful Firestore check-in after transient error:', reconciliation.result.bookingNumber);
          return { ...reconciliation.result, source: 'FIRESTORE_RECONCILED' };
        }
      }

      // ── Fail-Closed Error Path (Step 13.2: No MySQL Fallback) ─────────────
      console.error(`[FAIL_CLOSED:CHECK_IN] Check-in failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }
}

export default CheckInCutoverService;
