/**
 * CheckoutRecoveryService.js
 * ==========================
 * Phase 1 — Infrastructure only.
 *
 * Provides the architecture for future Undo Checkout support.
 * No recovery logic is active yet. No existing flow is modified
 * except that createSnapshot() is called inside the checkout
 * transaction immediately before COMMIT.
 *
 * Phase 1 contract:
 *   - createSnapshot()       → captures full state, inserts into checkout_snapshots
 *   - restoreSnapshot()      → NOT IMPLEMENTED (Phase 2)
 *   - validateRecovery()     → NOT IMPLEMENTED (Phase 2)
 *   - expireSnapshots()      → NOT IMPLEMENTED (Phase 3)
 *   - getUndoEligibility()   → NOT IMPLEMENTED (Phase 2)
 *
 * SAFETY RULES (enforced here, not in callers):
 *   - Snapshots are immutable — always INSERT, never UPDATE an existing row.
 *   - A snapshot failure MUST NOT abort the checkout transaction.
 *     createSnapshot() catches its own errors and logs them.
 *   - No controller may call restoreSnapshot() until Phase 2 is approved.
 */

import pool from '../db.js';

const SNAPSHOT_TTL_HOURS = 48; // Snapshots expire after 48 hours by default

export class CheckoutRecoveryService {

  // ─────────────────────────────────────────────────────────────────────────────
  // createSnapshot
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Captures a complete, immutable snapshot of the checkout state
   * immediately before the checkout COMMIT fires.
   *
   * Called from: checkOut() in roomController.js
   *              → inside the existing checkout transaction
   *              → immediately before connection.commit()
   *
   * @param {object} connection  — The active MySQL connection (within transaction)
   * @param {object} context     — All data already fetched during checkout:
   *   {
   *     bookingId      : number,
   *     roomId         : number,
   *     guestId        : number,
   *     userId         : number|null,   // who performed the checkout
   *     room           : object,        // rooms row snapshot
   *     booking        : object,        // bookings row snapshot
   *     ledgerItems    : array,         // ledger_items rows at time of checkout
   *     totalCollected : number,
   *     businessDate   : string,
   *   }
   *
   * @returns {Promise<number>} The inserted snapshot id, or null on failure.
   *
   * IMPORTANT: This method MUST NOT throw. Errors are logged and swallowed
   * so that a snapshot failure never blocks a successful checkout.
   */
  static async createSnapshot(connection, context) {
    try {
      const {
        bookingId,
        roomId,
        guestId,
        userId,
        room,
        booking,
        ledgerItems = [],
        totalCollected,
        businessDate,
      } = context;

      // Fetch the latest invoice record for this booking (written earlier in same tx)
      const [invoiceRows] = await connection.query(
        'SELECT * FROM invoices WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
        [bookingId]
      );
      const invoice = invoiceRows[0] || null;

      // Fetch the latest payment record for this booking (written earlier in same tx)
      const [paymentRows] = await connection.query(
        'SELECT * FROM payments WHERE booking_id = ? ORDER BY id DESC LIMIT 1',
        [bookingId]
      );
      const payment = paymentRows[0] || null;

      // Calculate expiry
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + SNAPSHOT_TTL_HOURS);
      const expiresAtStr = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

      // Build the immutable snapshots
      const bookingSnapshot = JSON.stringify({
        ...booking,
        _snapshotVersion: 1,
        _capturedAt: new Date().toISOString(),
        _totalCollected: totalCollected,
        _businessDate: businessDate,
      });

      const roomSnapshot = JSON.stringify({
        ...room,
        _snapshotVersion: 1,
        _capturedAt: new Date().toISOString(),
      });

      const invoiceSnapshot = JSON.stringify({
        ...(invoice || {}),
        _snapshotVersion: 1,
        _capturedAt: new Date().toISOString(),
      });

      const ledgerSnapshot = JSON.stringify({
        items: ledgerItems,
        _snapshotVersion: 1,
        _capturedAt: new Date().toISOString(),
        _count: ledgerItems.length,
      });

      const paymentSnapshot = JSON.stringify({
        ...(payment || {}),
        _snapshotVersion: 1,
        _capturedAt: new Date().toISOString(),
      });

      // INSERT — never UPDATE. Every checkout gets a new snapshot row.
      const [result] = await connection.query(
        `INSERT INTO checkout_snapshots
           (booking_id, room_id, guest_id, invoice_id, payment_id,
            booking_snapshot, room_snapshot, invoice_snapshot, ledger_snapshot, payment_snapshot,
            created_by, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [
          bookingId,
          roomId,
          guestId,
          invoice?.id    || null,
          payment?.id    || null,
          bookingSnapshot,
          roomSnapshot,
          invoiceSnapshot,
          ledgerSnapshot,
          paymentSnapshot,
          userId         || null,
          expiresAtStr,
        ]
      );

      console.log(`[CheckoutRecoveryService] Snapshot created: id=${result.insertId}, booking=${bookingId}, room=${room?.number}`);
      return result.insertId;

    } catch (snapshotErr) {
      // CRITICAL: Never let snapshot failure block checkout.
      // Log prominently but swallow the error.
      console.error(
        '[CheckoutRecoveryService] createSnapshot FAILED (checkout will still proceed):',
        snapshotErr.message
      );
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // restoreSnapshot  — Phase 2 (NOT IMPLEMENTED)
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Reverses a completed checkout by restoring all snapshotted state.
   *
   * @param {number} snapshotId
   * @param {number} requestedByUserId
   * @returns {Promise<object>}
   *
   * STATUS: NOT IMPLEMENTED — Phase 2
   */
  static async restoreSnapshot(snapshotId, requestedByUserId) {
    throw new Error(
      '[CheckoutRecoveryService.restoreSnapshot] Not Implemented — Phase 2. ' +
      `Called with snapshotId=${snapshotId}, userId=${requestedByUserId}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // validateRecovery — Phase 2 (NOT IMPLEMENTED)
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Validates that a snapshot can safely be restored without data conflicts.
   * Checks: booking still exists, room is still dirty (not re-checked-in), etc.
   *
   * @param {number} snapshotId
   * @returns {Promise<{ eligible: boolean, reason: string }>}
   *
   * STATUS: NOT IMPLEMENTED — Phase 2
   */
  static async validateRecovery(snapshotId) {
    throw new Error(
      '[CheckoutRecoveryService.validateRecovery] Not Implemented — Phase 2. ' +
      `Called with snapshotId=${snapshotId}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // expireSnapshots — Phase 3 (NOT IMPLEMENTED)
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Marks all snapshots past their expires_at as EXPIRED.
   * Intended to run as a nightly scheduled job.
   *
   * @returns {Promise<number>} Count of rows marked EXPIRED.
   *
   * STATUS: NOT IMPLEMENTED — Phase 3
   */
  static async expireSnapshots() {
    throw new Error(
      '[CheckoutRecoveryService.expireSnapshots] Not Implemented — Phase 3.'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // getUndoEligibility — Phase 2 (NOT IMPLEMENTED)
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Returns whether a given booking can still be undone.
   * Factors: snapshot exists, not expired, room not re-used, invoice not reconciled.
   *
   * @param {number} bookingId
   * @returns {Promise<{ eligible: boolean, snapshotId: number|null, reason: string }>}
   *
   * STATUS: NOT IMPLEMENTED — Phase 2
   */
  static async getUndoEligibility(bookingId) {
    throw new Error(
      '[CheckoutRecoveryService.getUndoEligibility] Not Implemented — Phase 2. ' +
      `Called with bookingId=${bookingId}`
    );
  }
}
