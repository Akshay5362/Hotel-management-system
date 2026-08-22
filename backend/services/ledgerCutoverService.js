import { isFirestoreLedgerServingEnabled } from '../config/featureFlags.js';
import { FirestoreLedgerService } from './firestoreLedgerService.js';
import pool from '../db.js';

export class LedgerCutoverService {
  /**
   * Native MySQL Ledger Reader (Used as authoritative source when flag is off)
   */
  static async getMySQLLedger(roomNumber) {
    let connection;
    try {
      connection = await pool.getConnection();

      const [bookingRows] = await connection.query(
        `SELECT b.id, b.booking_number, b.room_tariff, b.total_amount, b.advance_amount, b.payment_mode,
                b.purpose_of_visit, b.check_in_date, b.expected_check_out_date,
                g.full_name as guestName, g.phone, g.company_name
         FROM bookings b
         JOIN guests g ON b.guest_id = g.id
         WHERE b.booking_status = 'Checked In'
           AND b.room_id = (SELECT id FROM rooms WHERE number = ? LIMIT 1)
         LIMIT 1`,
        [roomNumber]
      );

      if (bookingRows.length === 0) {
        const error = new Error(`No active booking found for Room ${roomNumber}`);
        error.status = 404;
        error.code = 'BOOKING_NOT_FOUND';
        throw error;
      }
      const booking = bookingRows[0];

      const [items] = await connection.query(
        `SELECT id, \`desc\` as description, qty, amount, credit_amount,
                transaction_type, payment_mode, time_of_entry, business_date, created_at, status
         FROM ledger_items
         WHERE booking_id = ?
         ORDER BY id ASC`,
        [booking.id]
      );

      let balance = 0;
      const ledgerWithBalance = items.map(item => {
        const debit  = Number(item.amount       || 0);
        const credit = Number(item.credit_amount || 0);
        balance += debit - credit;
        return {
          ...item,
          amount: debit,
          credit_amount: credit,
          balance
        };
      });

      const totalCharges  = items.reduce((s, i) => s + Number(i.amount       || 0), 0);
      const totalPayments = items.reduce((s, i) => s + Number(i.credit_amount || 0), 0);
      const outstanding   = totalCharges - totalPayments;

      return {
        booking: {
          id: booking.id,
          booking_number: booking.booking_number,
          room_number: roomNumber,
          guest_name: booking.guestName,
          phone: booking.phone,
          company_name: booking.company_name || '',
          room_tariff: booking.room_tariff,
          purpose_of_visit: booking.purpose_of_visit,
          payment_mode: booking.payment_mode,
          check_in_date: booking.check_in_date,
          expected_check_out_date: booking.expected_check_out_date
        },
        ledger: ledgerWithBalance,
        summary: { totalCharges, totalPayments, outstanding }
      };
    } finally {
      if (connection) connection.release();
    }
  }

  /**
   * Retrieves ledger with primary Firestore serving and safe fail-closed error handling.
   */
  static async getLedgerWithFallback(roomNumber, options = {}) {
    const servingEnabled = isFirestoreLedgerServingEnabled();
    const { timeoutMs = 3000 } = options;

    if (!servingEnabled) {
      const mysqlResult = await this.getMySQLLedger(roomNumber);
      return { ...mysqlResult, source: 'MYSQL' };
    }

    // ── Primary Firestore Path ──────────────────────────────────────────────
    const startTime = Date.now();

    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`FIRESTORE_TIMEOUT: Ledger retrieval exceeded ${timeoutMs}ms limit`));
        }, timeoutMs);
      });

      const firestorePromise = FirestoreLedgerService.getRoomLedger(roomNumber, options).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const fsResult = await Promise.race([firestorePromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      // Validate response structure
      if (!fsResult || !fsResult.summary || typeof fsResult.summary.outstanding !== 'number') {
        throw new Error('FIRESTORE_VALIDATION_FAILED: Invalid ledger response structure or missing summary');
      }

      // Check if no active booking was found
      if (!fsResult.booking) {
        const error = new Error(`No active booking found for Room ${roomNumber}`);
        error.status = 404;
        error.code = 'BOOKING_NOT_FOUND';
        throw error;
      }

      console.log(`[CUTOVER_SERVING:LEDGER] Serving primary from Firestore in ${durationMs}ms:`, {
        domain: 'ledger',
        source: 'FIRESTORE',
        roomNumber,
        bookingId: fsResult.booking.id,
        outstanding: fsResult.summary.outstanding
      });

      return {
        ...fsResult,
        source: 'FIRESTORE',
        durationMs
      };

    } catch (fsErr) {
      const durationMs = Date.now() - startTime;

      // ── Detect Business Validation Errors (MUST NOT FALL BACK) ─────────────
      if (fsErr.status === 404 || fsErr.code === 'BOOKING_NOT_FOUND' || fsErr.status === 400) {
        throw fsErr;
      }

      // ── Fail-Closed Error Path (Step 13.2: No MySQL Fallback) ─────────────
      console.error(`[FAIL_CLOSED:LEDGER] Ledger retrieval failed in Firestore (${fsErr.message}) in ${durationMs}ms. Failing closed.`);
      throw fsErr;
    }
  }

  static async getLedger(roomNumber, options = {}) {
    return this.getLedgerWithFallback(roomNumber, options);
  }
}

export default LedgerCutoverService;
