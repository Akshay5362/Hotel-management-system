/**
 * roomShiftCutoverService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cutover Service for Room Shifting (Phase 3 Step 8).
 * Provides Firestore primary serving with safe fail-closed error handling and
 * unknown outcome reconciliation.
 */

import { isFirestoreRoomShiftEnabled } from '../config/featureFlags.js';
import { processRoomShiftFirestoreTransaction } from '../adapters/firestore/roomShiftFirestoreAdapter.js';
import { processRoomShift } from './roomShiftService.js';
import { db } from '../config/firebaseAdmin.js';
import { invalidateRoomStatusCache } from './firestoreRoomStatusService.js';
import { invalidateGuestDirectoryCache } from './guestAdminService.js';

export class RoomShiftCutoverService {
  /**
   * Reconcile unknown outcome: checks if a room shift or idempotency key was committed.
   */
  static async reconcileUnknownOutcome({ idempotencyKey, fromRoomNumber, toRoomNumber }) {
    try {
      if (!db) return { committed: false };

      // 1. Check idempotency key if available
      if (idempotencyKey) {
        const idemSnap = await db.collection('idempotency_keys').doc(String(idempotencyKey)).get();
        if (idemSnap.exists && idemSnap.data().status === 'COMPLETED') {
          return { committed: true, result: idemSnap.data().result };
        }
      }

      // 2. Check source and target room status in Firestore
      const targetRoomSnap = await db.collection('rooms').doc(`room_${toRoomNumber}`).get();
      if (targetRoomSnap.exists && targetRoomSnap.data().status === 'occupied' && targetRoomSnap.data().current_booking_id) {
        const sourceRoomSnap = await db.collection('rooms').doc(`room_${fromRoomNumber}`).get();
        if (sourceRoomSnap.exists && sourceRoomSnap.data().status === 'vacant') {
          const bkgSnap = await db.collection('bookings').doc(targetRoomSnap.data().current_booking_id).get();
          if (bkgSnap.exists && bkgSnap.data().room_number === String(toRoomNumber)) {
            return {
              committed: true,
              result: {
                success: true,
                message: `Successfully shifted guest from Room ${fromRoomNumber} to ${toRoomNumber}`,
                bookingId: bkgSnap.id,
                fromRoomNumber: String(fromRoomNumber),
                toRoomNumber: String(toRoomNumber)
              }
            };
          }
        }
      }

      return { committed: false };
    } catch (reconcileErr) {
      console.warn('[RoomShiftCutover] Reconciliation check failed:', reconcileErr.message);
      return { committed: false, error: reconcileErr };
    }
  }

  /**
   * Executes room shift with Firestore primary serving and safe fail-closed error handling.
   */
  static async executeRoomShift({
    connection,
    params,
    timeoutMs = 8000
  }) {
    const servingEnabled = isFirestoreRoomShiftEnabled();
    const {
      fromRoomNumber,
      toRoomNumber,
      adjustmentType,
      manualAdjustmentAmount,
      manualAmount,
      manualAdjustmentReason,
      reason,
      resolvedUserId,
      idempotencyKey
    } = params;

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
        await processRoomShift(useConn, params);
        if (isLocalConn) await useConn.commit();
        return {
          success: true,
          message: `Successfully shifted guest from Room ${fromRoomNumber} to ${toRoomNumber}`,
          source: 'MYSQL'
        };
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
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: Room shift transaction exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const firestorePromise = processRoomShiftFirestoreTransaction({
        fromRoomNumber,
        toRoomNumber,
        adjustmentType,
        manualAdjustmentAmount,
        manualAmount,
        manualAdjustmentReason,
        reason,
        resolvedUserId,
        idempotencyKey
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([firestorePromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      console.log(`[CUTOVER_SERVING:ROOM_SHIFT] Serving primary from Firestore in ${durationMs}ms:`, {
        domain: 'room_shift',
        source: 'FIRESTORE',
        fromRoomNumber,
        toRoomNumber
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
        fsErr.code === 'SAME_ROOM_SHIFT' ||
        fsErr.code === 'SOURCE_ROOM_NOT_FOUND' ||
        fsErr.code === 'TARGET_ROOM_NOT_FOUND' ||
        fsErr.code === 'SOURCE_ROOM_NOT_OCCUPIED' ||
        fsErr.code === 'TARGET_ROOM_INACTIVE' ||
        fsErr.code === 'TARGET_ROOM_NOT_VACANT' ||
        fsErr.code === 'TARGET_ROOM_DIRTY' ||
        fsErr.code === 'BOOKING_NOT_FOUND' ||
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

      // ── Handle Unknown Outcome & Prevent Double Shift ─────────────────────
      const isTimeout = fsErr.message && fsErr.message.includes('FIRESTORE_TIMEOUT');
      if (!isTimeout) {
        const reconciliation = await this.reconcileUnknownOutcome({
          idempotencyKey,
          fromRoomNumber,
          toRoomNumber
        });

        if (reconciliation.committed && reconciliation.result) {
          console.log('[RoomShiftCutover] Reconciled successful Firestore room shift after transient error:', { fromRoomNumber, toRoomNumber });
          return { ...reconciliation.result, source: 'FIRESTORE_RECONCILED' };
        }
      }

      // ── Fail-Closed Error Path (Step 13.2: No MySQL Fallback) ─────────────
      console.error(`[FAIL_CLOSED:ROOM_SHIFT] Room shift failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }
}

export default RoomShiftCutoverService;