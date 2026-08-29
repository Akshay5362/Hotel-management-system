import { db } from '../config/firebaseAdmin.js';
import { isFirestoreReservationsServingEnabled } from '../config/featureFlags.js';
import { ReservationFirestoreAdapter } from '../adapters/firestore/reservationFirestoreAdapter.js';
import { invalidateRoomStatusCache } from './firestoreRoomStatusService.js';

const CUTOVER_TIMEOUT_MS = 3000;

export class ReservationCutoverService {
  /**
   * Helper to execute a promise bounded by a strict timeout.
   */
  static async withTimeout(promise, timeoutMs = CUTOVER_TIMEOUT_MS, operationName = 'ReservationOperation') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`FIRESTORE_TIMEOUT: ${operationName} exceeded ${timeoutMs}ms limit`);
        err.code = 'FIRESTORE_TIMEOUT';
        err.name = 'TimeoutError';
        reject(err);
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Inspects idempotency collection to see if Firestore transaction committed prior to failure.
   */
  static async reconcileUnknownReservationOutcome(idempotencyKey) {
    if (!idempotencyKey) return null;
    try {
      const snap = await db.collection('idempotency_keys').doc(String(idempotencyKey)).get();
      if (snap.exists && snap.data()?.status === 'COMPLETED' && snap.data()?.result) {
        return snap.data().result;
      }
    } catch (err) {
      console.warn(`[ReservationCutoverService] Idempotency reconciliation check failed:`, err.message);
    }
    return null;
  }

  /**
   * Creates a reservation with Firestore PRIMARY cutover & safe fail-closed error handling.
   */
  static async createReservation(params, mysqlFallbackFn) {
    const isPrimary = isFirestoreReservationsServingEnabled();

    if (!isPrimary && typeof mysqlFallbackFn === 'function') {
      return await mysqlFallbackFn();
    }

    const startTime = Date.now();
    const timeout = params.timeoutMs !== undefined ? params.timeoutMs : CUTOVER_TIMEOUT_MS;

    try {
      const result = await this.withTimeout(
        ReservationFirestoreAdapter.createReservationFirestore(params),
        timeout,
        'createReservation'
      );

      const durationMs = Date.now() - startTime;
      console.log(`[CUTOVER_SERVING:RESERVATIONS] createReservation served from Firestore in ${durationMs}ms:`, {
        domain: 'reservations_create',
        source: 'FIRESTORE',
        reservationNumber: result?.reservation?.reservation_number
      });

      // Invalidate room status cache
      invalidateRoomStatusCache();

      return {
        ...result,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // 1. Business validation errors (400, 404, 409) must NEVER trigger fallback
      const isBusinessError = fsErr.status === 400 ||
                              fsErr.status === 404 ||
                              fsErr.status === 409 ||
                              fsErr.code === 'ROOM_ALREADY_BOOKED' ||
                              fsErr.code === 'ROOM_INACTIVE' ||
                              fsErr.code === 'ROOM_NOT_FOUND' ||
                              fsErr.code === 'INVALID_DATES';

      if (isBusinessError) {
        throw fsErr;
      }

      console.warn(`[CUTOVER_FALLBACK:RESERVATIONS] createReservation Firestore error (${fsErr.message}) in ${durationMs}ms. Reconciling...`);

      // 2. Unknown outcome reconciliation for mid-flight timeouts/disconnects
      if (params.idempotencyKey) {
        const reconciled = await this.reconcileUnknownReservationOutcome(params.idempotencyKey);
        if (reconciled) {
          console.log(`[CUTOVER_RECONCILED:RESERVATIONS] Found previously committed Firestore transaction.`);
          invalidateRoomStatusCache();
          return {
            ...reconciled,
            source: 'FIRESTORE_RECONCILED',
            durationMs
          };
        }
      }

      // Step 13.2: Fail closed safely
      console.error(`[FAIL_CLOSED:RESERVATIONS] createReservation failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }

  /**
   * Updates a reservation with Firestore PRIMARY cutover & safe fail-closed error handling.
   */
  static async updateReservation(resId, updateData, user = {}, mysqlFallbackFn) {
    const isPrimary = isFirestoreReservationsServingEnabled();

    if (!isPrimary && typeof mysqlFallbackFn === 'function') {
      return await mysqlFallbackFn();
    }

    const startTime = Date.now();
    const timeout = updateData.timeoutMs !== undefined ? updateData.timeoutMs : CUTOVER_TIMEOUT_MS;

    try {
      const result = await this.withTimeout(
        ReservationFirestoreAdapter.updateReservationFirestore(resId, updateData, user, updateData.idempotencyKey),
        timeout,
        'updateReservation'
      );

      const durationMs = Date.now() - startTime;
      console.log(`[CUTOVER_SERVING:RESERVATIONS] updateReservation served from Firestore in ${durationMs}ms:`, {
        domain: 'reservations_update',
        source: 'FIRESTORE',
        reservationId: resId
      });

      // Invalidate room status cache
      invalidateRoomStatusCache();

      return {
        ...result,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      const isBusinessError = fsErr.status === 400 ||
                              fsErr.status === 404 ||
                              fsErr.status === 409 ||
                              fsErr.code === 'ROOM_ALREADY_BOOKED' ||
                              fsErr.code === 'RESERVATION_NOT_FOUND';

      if (isBusinessError) {
        throw fsErr;
      }

      console.warn(`[CUTOVER_FALLBACK:RESERVATIONS] updateReservation Firestore error (${fsErr.message}) in ${durationMs}ms. Reconciling...`);

      if (updateData.idempotencyKey) {
        const reconciled = await this.reconcileUnknownReservationOutcome(updateData.idempotencyKey);
        if (reconciled) {
          console.log(`[CUTOVER_RECONCILED:RESERVATIONS] Found previously committed Firestore transaction.`);
          invalidateRoomStatusCache();
          return {
            ...reconciled,
            source: 'FIRESTORE_RECONCILED',
            durationMs
          };
        }
      }

      // Step 13.2: Fail closed safely
      console.error(`[FAIL_CLOSED:RESERVATIONS] updateReservation failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }

  /**
   * Cancels a reservation with Firestore PRIMARY cutover & safe fail-closed error handling.
   */
  static async cancelReservation(resId, params = {}, user = {}, mysqlFallbackFn) {
    const isPrimary = isFirestoreReservationsServingEnabled();

    if (!isPrimary && typeof mysqlFallbackFn === 'function') {
      return await mysqlFallbackFn();
    }

    const startTime = Date.now();
    const timeout = params.timeoutMs !== undefined ? params.timeoutMs : CUTOVER_TIMEOUT_MS;

    try {
      const result = await this.withTimeout(
        ReservationFirestoreAdapter.cancelReservationFirestore(resId, params, user, params.idempotencyKey),
        timeout,
        'cancelReservation'
      );

      const durationMs = Date.now() - startTime;
      console.log(`[CUTOVER_SERVING:RESERVATIONS] cancelReservation served from Firestore in ${durationMs}ms:`, {
        domain: 'reservations_cancel',
        source: 'FIRESTORE',
        reservationId: resId
      });

      // Invalidate room status cache
      invalidateRoomStatusCache();

      return {
        ...result,
        source: 'FIRESTORE',
        durationMs
      };
    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      const isBusinessError = fsErr.status === 400 ||
                              fsErr.status === 404 ||
                              fsErr.code === 'RESERVATION_NOT_FOUND';

      if (isBusinessError) {
        throw fsErr;
      }

      console.warn(`[CUTOVER_FALLBACK:RESERVATIONS] cancelReservation Firestore error (${fsErr.message}) in ${durationMs}ms. Reconciling...`);

      if (params.idempotencyKey) {
        const reconciled = await this.reconcileUnknownReservationOutcome(params.idempotencyKey);
        if (reconciled) {
          console.log(`[CUTOVER_RECONCILED:RESERVATIONS] Found previously committed Firestore transaction.`);
          return {
            ...reconciled,
            source: 'FIRESTORE_RECONCILED',
            durationMs
          };
        }
      }

      // Step 13.2: Fail closed safely
      console.error(`[FAIL_CLOSED:RESERVATIONS] cancelReservation failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }

  /**
   * Retrieves list of reservations from Firestore PRIMARY with fail-closed error handling.
   */
  static async getReservations(query, mysqlFallbackFn) {
    const isPrimary = isFirestoreReservationsServingEnabled();

    if (!isPrimary && typeof mysqlFallbackFn === 'function') {
      return await mysqlFallbackFn();
    }

    try {
      const result = await this.withTimeout(
        ReservationFirestoreAdapter.getReservationsFirestore(query),
        CUTOVER_TIMEOUT_MS,
        'getReservations'
      );
      return {
        ...result,
        source: 'FIRESTORE'
      };
    } catch (fsErr) {
      console.error(`[FAIL_CLOSED:RESERVATIONS] getReservations failed in Firestore: ${fsErr.message}. Failing closed.`);
      throw fsErr;
    }
  }

  /**
   * Retrieves single reservation by ID from Firestore PRIMARY with fail-closed error handling.
   */
  static async getReservationById(id, mysqlFallbackFn) {
    const isPrimary = isFirestoreReservationsServingEnabled();

    if (!isPrimary && typeof mysqlFallbackFn === 'function') {
      return await mysqlFallbackFn();
    }

    try {
      const result = await this.withTimeout(
        ReservationFirestoreAdapter.getReservationByIdFirestore(id),
        CUTOVER_TIMEOUT_MS,
        'getReservationById'
      );
      return {
        ...result,
        source: 'FIRESTORE'
      };
    } catch (fsErr) {
      if (fsErr.status === 404) {
        throw fsErr;
      }
      console.error(`[FAIL_CLOSED:RESERVATIONS] getReservationById failed in Firestore: ${fsErr.message}. Failing closed.`);
      throw fsErr;
    }
  }

  /**
   * Retrieves reservation summary report from Firestore PRIMARY with fail-closed error handling.
   */
  static async getReservationReport(query, mysqlFallbackFn) {
    const isPrimary = isFirestoreReservationsServingEnabled();

    if (!isPrimary && typeof mysqlFallbackFn === 'function') {
      return await mysqlFallbackFn();
    }

    try {
      const result = await this.withTimeout(
        ReservationFirestoreAdapter.getReservationReportFirestore(query),
        CUTOVER_TIMEOUT_MS,
        'getReservationReport'
      );
      return {
        ...result,
        source: 'FIRESTORE'
      };
    } catch (fsErr) {
      console.error(`[FAIL_CLOSED:RESERVATIONS] getReservationReport failed in Firestore: ${fsErr.message}. Failing closed.`);
      throw fsErr;
    }
  }
}

export default ReservationCutoverService;
