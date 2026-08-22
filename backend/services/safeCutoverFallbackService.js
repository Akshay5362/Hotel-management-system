/**
 * backend/services/safeCutoverFallbackService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Safe Validation & Fail-Closed Execution Infrastructure for HPMS-Sky5.
 *
 * Provides:
 *   1. Bounded execution timeouts (e.g. 2500ms) to prevent Firestore hangs.
 *   2. Strict response schema validation before returning Firestore data.
 *   3. Fail-closed error handling (No silent MySQL fallback in Phase 3 Step 13.2).
 *   4. Structured observability logging.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DEFAULT_CUTOVER_TIMEOUT_MS = 2500;

export class SafeCutoverFallbackService {

  /**
   * Validates Room Status array before serving to clients.
   */
  static validateRoomStatuses(rooms) {
    if (!Array.isArray(rooms) || rooms.length === 0) {
      return { valid: false, reason: 'Room status response is empty or not an array' };
    }

    const seenNumbers = new Set();
    const validStatuses = ['occupied', 'vacant', 'dirty', 'inactive', 'booked'];

    for (const r of rooms) {
      if (!r || typeof r !== 'object') {
        return { valid: false, reason: 'Room record is not an object' };
      }
      if (!r.number && r.number !== 0) {
        return { valid: false, reason: 'Room number is missing' };
      }
      const numStr = String(r.number).trim();
      if (seenNumbers.has(numStr)) {
        return { valid: false, reason: `Duplicate room number detected: ${numStr}` };
      }
      seenNumbers.add(numStr);

      const statusLower = String(r.status || '').toLowerCase();
      if (!validStatuses.includes(statusLower)) {
        return { valid: false, reason: `Invalid room status: ${r.status} for room ${numStr}` };
      }
    }

    return { valid: true, count: rooms.length };
  }

  /**
   * Validates single or bulk Availability result before serving.
   */
  static validateAvailabilityResult(res) {
    if (!res || typeof res !== 'object') {
      return { valid: false, reason: 'Availability result is not an object' };
    }
    if (typeof res.available !== 'boolean') {
      return { valid: false, reason: 'Availability result missing boolean available property' };
    }
    return { valid: true };
  }

  /**
   * Validates bulk Available Rooms array.
   */
  static validateAvailableRooms(rooms) {
    if (!Array.isArray(rooms)) {
      return { valid: false, reason: 'Available rooms result is not an array' };
    }
    for (const r of rooms) {
      if (!r || typeof r !== 'object' || (!r.number && r.number !== 0)) {
        return { valid: false, reason: 'Available room object missing room number' };
      }
    }
    return { valid: true, count: rooms.length };
  }

  /**
   * Executes Firestore operation with timeout, validation, and fail-closed error handling.
   *
   * @param {object}   options
   * @param {string}   options.domain               — 'room_status' | 'availability'
   * @param {boolean}  options.servingEnabled       — Flag controlling primary Firestore serving
   * @param {Function} options.firestoreOp          — Async Firestore operation
   * @param {Function} [options.mysqlOp]            — Legacy MySQL operation
   * @param {Function} [options.validate]           — Validator function (returns { valid: boolean, reason?: string })
   * @param {object}   [options.context]            — Request metadata
   * @param {number}   [options.timeoutMs]          — Max wait time for Firestore before failing
   */
  static async executeWithFallback({
    domain,
    servingEnabled = true,
    firestoreOp,
    mysqlOp,
    validate,
    context = {},
    timeoutMs = DEFAULT_CUTOVER_TIMEOUT_MS
  }) {
    const startTime = Date.now();

    // If Firestore serving is explicitly disabled, run legacy operation if provided
    if (!servingEnabled && typeof mysqlOp === 'function') {
      return await mysqlOp();
    }

    try {
      // 1. Execute Firestore with strict timeout protection
      const firestorePromise = firestoreOp();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`FIRESTORE_TIMEOUT: Query exceeded ${timeoutMs}ms limit`)), timeoutMs);
      });

      const fsResult = await Promise.race([firestorePromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      // 2. Validate Firestore response contract
      const validation = validate ? validate(fsResult) : { valid: true };
      if (!validation.valid) {
        throw new Error(`FIRESTORE_VALIDATION_FAILED: ${validation.reason}`);
      }

      // 3. Log Firestore serving success
      console.log(`[CUTOVER_SERVING:${domain.toUpperCase()}] Serving primary from Firestore in ${durationMs}ms`);

      return fsResult;

    } catch (fsErr) {
      const durationMs = Date.now() - startTime;
      console.error(`[FAIL_CLOSED:${domain.toUpperCase()}] Firestore operation failed (${fsErr.message}) in ${durationMs}ms. Failing closed without MySQL fallback.`);

      // Step 13.2: Fail closed safely — No silent fallback to MySQL
      throw fsErr;
    }
  }

  static async execute(options) {
    return this.executeWithFallback(options);
  }
}

export default SafeCutoverFallbackService;
