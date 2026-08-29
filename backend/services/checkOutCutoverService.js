import { isFirestoreCheckOutEnabled, isFirestoreCheckOutServingEnabled } from '../config/featureFlags.js';
import { processCheckOutFirestoreTransaction } from '../adapters/firestore/checkOutFirestoreAdapter.js';
import { processCheckOut } from './checkOutService.js';
import { db } from '../config/firebaseAdmin.js';
import { invalidateRoomStatusCache } from './firestoreRoomStatusService.js';
import { invalidateGuestDirectoryCache } from './guestAdminService.js';

export class CheckOutCutoverService {
  /**
   * Reconcile unknown outcome: checks if a checkout or idempotency key was committed.
   */
  static async reconcileUnknownOutcome({ idempotencyKey, number }) {
    try {
      if (!db) return { committed: false };

      // 1. Check idempotency key if available
      if (idempotencyKey) {
        const idemSnap = await db.collection('idempotency_keys').doc(String(idempotencyKey)).get();
        if (idemSnap.exists && idemSnap.data().status === 'COMPLETED') {
          return { committed: true, result: idemSnap.data().result };
        }
      }

      // 2. Check room status
      const roomSnap = await db.collection('rooms').doc(`room_${number}`).get();
      if (roomSnap.exists) {
        const roomData = roomSnap.data();
        if (roomData.status === 'dirty' || roomData.housekeeping_status === 'Dirty') {
          return {
            committed: true,
            result: {
              success: true,
              roomNumber: String(number),
              status: 'dirty'
            }
          };
        }
      }

      return { committed: false };
    } catch (reconcileErr) {
      console.warn('[CheckOutCutover] Reconciliation check failed:', reconcileErr.message);
      return { committed: false, error: reconcileErr };
    }
  }

  /**
   * Executes checkout with Firestore primary serving and safe fail-closed error handling.
   */
  static async executeCheckOut({
    connection,
    params,
    timeoutMs = 8000
  }) {
    const servingEnabled = isFirestoreCheckOutEnabled() || isFirestoreCheckOutServingEnabled();
    const { number, parsedBalancePaid, resolvedUserId, idempotencyKey, businessDate, paymentMethod } = params;

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
        const result = await processCheckOut(useConn, params);
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
          reject(new Error(`FIRESTORE_TIMEOUT: Checkout transaction exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const firestorePromise = processCheckOutFirestoreTransaction({
        number,
        parsedBalancePaid,
        resolvedUserId,
        businessDate,
        idempotencyKey,
        paymentMethod
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([firestorePromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      // Validate result format
      if (!fsResult || !fsResult.bookingId) {
        throw new Error('FIRESTORE_VALIDATION_FAILED: Checkout returned empty or invalid booking ID');
      }

      console.log(`[CUTOVER_SERVING:CHECK_OUT] Serving primary from Firestore in ${durationMs}ms:`, {
        domain: 'checkout',
        source: 'FIRESTORE',
        bookingId: fsResult.bookingId,
        roomNumber: number,
        invoiceNumber: fsResult.invoiceNumber
      });

      // Invalidate room status aggregation cache
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
        fsErr.code === 'BALANCE_DUE' ||
        fsErr.code === 'ALREADY_CHECKED_OUT' ||
        fsErr.code === 'ROOM_NOT_OCCUPIED' ||
        fsErr.code === 'ROOM_NOT_FOUND' ||
        fsErr.code === 'BOOKING_NOT_FOUND' ||
        fsErr.status === 400 ||
        fsErr.status === 404 ||
        fsErr.status === 409
      ) {
        throw fsErr;
      }

      // ── Handle Unknown Outcome & Prevent Double Checkout ───────────────────
      const isTimeout = fsErr.message && fsErr.message.includes('FIRESTORE_TIMEOUT');
      if (!isTimeout) {
        const reconciliation = await this.reconcileUnknownOutcome({
          idempotencyKey,
          number
        });

        if (reconciliation.committed && reconciliation.result) {
          console.log('[CheckOutCutover] Reconciled successful Firestore checkout after transient error:', reconciliation.result.bookingId);
          return { ...reconciliation.result, source: 'FIRESTORE_RECONCILED' };
        }
      }

      // ── Fail-Closed Error Path (Step 13.2: No MySQL Fallback) ─────────────
      console.error(`[FAIL_CLOSED:CHECK_OUT] Checkout failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }
}

export default CheckOutCutoverService;
