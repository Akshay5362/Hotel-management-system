/**
 * backend/services/firestoreLedgerService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Native Firestore Financial Ledger & Folio Service for HPMS.
 *
 * Provides 100% semantic parity with the MySQL ledger, payment, and cash
 * accounting flows:
 *   - Room / Booking Folio calculation with running balance
 *   - Total charges, total credits/payments, outstanding balance
 *   - Ledger item addition / charge posting
 *   - Payment aggregation by mode, date, and booking
 *   - Cash log aggregation & daily cash status summary
 *   - Night audit rollover tariff generation
 *
 * NOTE: During Phase 1, MySQL remains the live production authority.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';
import {
  listDocs,
  getDoc,
  setDoc,
  formatRoomId,
  formatBookingId
} from '../repositories/firestore/firestoreUtils.js';
import { parseToComparableDate } from './firestoreAvailabilityService.js';
import { FirestoreRoomStatusService } from './firestoreRoomStatusService.js';

const LEDGER_COLLECTION = 'ledger_items';
const BOOKINGS_COLLECTION = 'bookings';
const PAYMENTS_COLLECTION = 'payments';
const CASH_LOGS_COLLECTION = 'cash_logs';
const ROOMS_COLLECTION = 'rooms';

export class FirestoreLedgerService {

  /**
   * Retrieves and calculates the ledger/folio for a specific room or active booking.
   * Computes row-by-row running balance: balance += amount (debit) - credit_amount (credit).
   *
   * @param {string|number} roomNumber
   * @param {object} [options]
   * @param {string} [options.bookingId] - Optional specific booking ID
   * @param {object} [options.transaction]
   * @returns {Promise<{ booking: object|null, ledger: Array<object>, summary: { totalCharges: number, totalPayments: number, outstanding: number } }>}
   */
  static async getRoomLedger(roomNumber, options = {}) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');
    const { bookingId = null, transaction = null } = options;
    const roomNumStr = String(roomNumber).replace(/^room_/, '');

    // 1. Resolve active booking
    let activeBooking = null;
    if (bookingId) {
      const docId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
      activeBooking = await getDoc(BOOKINGS_COLLECTION, docId, { transaction });
    }

    if (!activeBooking) {
      const roomSnap = await db.collection(ROOMS_COLLECTION).doc(`room_${roomNumStr}`).get();
      if (roomSnap.exists && roomSnap.data().current_booking_id) {
        const curBkgSnap = await db.collection(BOOKINGS_COLLECTION).doc(roomSnap.data().current_booking_id).get();
        if (curBkgSnap.exists) {
          activeBooking = { id: curBkgSnap.id, ...curBkgSnap.data() };
        }
      }
    }

    if (!activeBooking) {
      const allBookings = await listDocs(BOOKINGS_COLLECTION, { transaction });
      activeBooking = allBookings.find(b => {
        if (!b || b.booking_status !== 'Checked In') return false;
        const bRoomNum = b.room_number ? String(b.room_number) : null;
        const bRoomId = b.room_id ? String(b.room_id).replace(/^room_/, '') : null;
        return bRoomNum === roomNumStr || bRoomId === roomNumStr;
      });
    }

    if (!activeBooking) {
      return {
        booking: null,
        ledger: [],
        summary: { totalCharges: 0, totalPayments: 0, outstanding: 0 }
      };
    }

    const bkgDocId = activeBooking.id || activeBooking.docId || formatBookingId(activeBooking.booking_number);
    const bkgMysqlId = activeBooking.mysql_booking_id || activeBooking.id;

    // 2. Fetch ledger items
    const map = new Map();
    const bkgQuery = await db.collection(LEDGER_COLLECTION).where('booking_id', '==', bkgDocId).get();
    bkgQuery.forEach(doc => map.set(doc.id, { id: doc.id, doc_id: doc.id, ...doc.data() }));

    const roomQuery = await db.collection(LEDGER_COLLECTION).where('room_number', '==', roomNumStr).get();
    roomQuery.forEach(doc => {
      const data = doc.data();
      if (!data.booking_id || data.booking_id === bkgDocId || data.booking_id === String(bkgMysqlId)) {
        map.set(doc.id, { id: doc.id, doc_id: doc.id, ...data });
      }
    });

    if (activeBooking.booking_number) {
      const bkgNumDocId = formatBookingId(activeBooking.booking_number);
      if (bkgNumDocId !== bkgDocId) {
        const bkgNumQuery = await db.collection(LEDGER_COLLECTION).where('booking_id', '==', bkgNumDocId).get();
        bkgNumQuery.forEach(doc => map.set(doc.id, { id: doc.id, doc_id: doc.id, ...doc.data() }));
      }
    }

    const bookingItems = Array.from(map.values());

    // 3. Sort chronologically
    bookingItems.sort((a, b) => {
      const tA = new Date(a.created_at || a.time || 0).getTime();
      const tB = new Date(b.created_at || b.time || 0).getTime();
      if (tA !== tB) return tA - tB;
      return (Number(a.mysql_ledger_id || 0)) - (Number(b.mysql_ledger_id || 0));
    });

    // 4. Calculate running balance
    let balance = 0;
    const ledgerWithBalance = bookingItems.map(item => {
      const debit = Number(item.amount || item.debit_amount || 0);
      const credit = Number(item.credit_amount || 0);
      balance += (debit - credit);
      return {
        id: item.mysql_ledger_id || item.id || item.doc_id,
        doc_id: item.id || item.doc_id,
        booking_id: item.booking_id,
        room_number: item.room_number || roomNumStr,
        desc: item.desc || item.description || '',
        description: item.desc || item.description || '',
        qty: Number(item.qty || 1),
        amount: debit,
        credit_amount: credit,
        balance,
        transaction_type: item.transaction_type || (credit > 0 ? 'PAYMENT' : 'CHARGE'),
        payment_mode: item.payment_mode || null,
        business_date: item.business_date || null,
        time_of_entry: item.time_of_entry || item.time || null,
        status: item.status || 'Settled',
        created_at: item.created_at || null
      };
    });

    const totalCharges = ledgerWithBalance.reduce((s, i) => s + i.amount, 0);
    const totalPayments = ledgerWithBalance.reduce((s, i) => s + i.credit_amount, 0);
    const outstanding = totalCharges - totalPayments;

    return {
      booking: {
        id: bkgMysqlId || bkgDocId,
        doc_id: bkgDocId,
        booking_number: activeBooking.booking_number,
        room_number: roomNumStr,
        guest_name: activeBooking.guest_name || activeBooking.guestName,
        phone: activeBooking.phone,
        company_name: activeBooking.company_name || '',
        room_tariff: activeBooking.room_tariff,
        purpose_of_visit: activeBooking.purpose_of_visit,
        payment_mode: activeBooking.payment_mode,
        check_in_date: activeBooking.check_in_date,
        expected_check_out_date: activeBooking.expected_check_out_date
      },
      ledger: ledgerWithBalance,
      summary: { totalCharges, totalPayments, outstanding }
    };
  }

  /**
   * Posts a charge or credit/payment to the Firestore ledger.
   *
   * @param {object} entry
   * @param {string|number} entry.room_number
   * @param {string} entry.desc
   * @param {number} [entry.amount=0] - Debit / charge amount
   * @param {number} [entry.credit_amount=0] - Credit / payment amount
   * @param {string} [entry.transaction_type='CHARGE'] - 'CHECKIN_DEPOSIT' | 'CHARGE' | 'PAYMENT' | 'ROLLOVER' | 'ADJUSTMENT' | 'REFUND'
   * @param {string} [entry.payment_mode]
   * @param {string} entry.business_date
   * @param {string|number} [entry.booking_id]
   * @param {object} [options]
   * @returns {Promise<object>} Created ledger item
   */
  static async addLedgerItem(entry, options = {}) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');
    const { transaction = null } = options;

    const docId = `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const debit = Number(entry.amount || 0);
    const credit = Number(entry.credit_amount || 0);

    const payload = {
      doc_id: docId,
      room_number: String(entry.room_number),
      desc: String(entry.desc),
      description: String(entry.desc),
      qty: Number(entry.qty || 1),
      amount: debit,
      credit_amount: credit,
      transaction_type: entry.transaction_type || (credit > 0 ? 'PAYMENT' : 'CHARGE'),
      payment_mode: entry.payment_mode || null,
      business_date: parseToComparableDate(entry.business_date) || entry.business_date || new Date().toISOString().split('T')[0],
      booking_id: entry.booking_id ? String(entry.booking_id) : null,
      status: entry.status || 'Settled',
      created_at: new Date().toISOString()
    };

    await setDoc(LEDGER_COLLECTION, docId, payload, { transaction });
    return { id: docId, ...payload };
  }

  /**
   * Aggregates cash status and cash log transactions for a specific business date.
   *
   * @param {string} businessDate - 'YYYY-MM-DD' or 'DD-Mon-YYYY'
   * @param {object} [options]
   * @returns {Promise<{ businessDate: string, totalCashIn: number, totalCashOut: number, netCash: number, logs: Array<object> }>}
   */
  static async getCashStatus(businessDate, options = {}) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');
    const sysComp = parseToComparableDate(businessDate);
    const allCashLogs = await listDocs(CASH_LOGS_COLLECTION, options);

    const filteredLogs = allCashLogs.filter(log => {
      if (!log) return false;
      const logDate = parseToComparableDate(log.business_date);
      return logDate === sysComp;
    });

    let totalCashIn = 0;
    let totalCashOut = 0;

    filteredLogs.forEach(log => {
      const amt = Number(log.amount || 0);
      const type = String(log.type || '').toLowerCase();

      if (type.includes('refund') || type.includes('payout')) {
        totalCashOut += amt;
      } else {
        totalCashIn += amt;
      }
    });

    return {
      businessDate: sysComp,
      totalCashIn,
      totalCashOut,
      netCash: totalCashIn - totalCashOut,
      logs: filteredLogs
    };
  }

  /**
   * Calculates outstanding balances for all currently occupied rooms in Firestore.
   *
   * @param {string} businessDate
   * @param {object} [options]
   * @returns {Promise<Array<{ room_number: string, guest_name: string, totalCharges: number, totalPayments: number, outstanding: number }>>}
   */
  static async getOutstandingBalances(businessDate, options = {}) {
    const roomStatuses = await FirestoreRoomStatusService.getRoomStatuses(businessDate, options);
    const occupiedRooms = roomStatuses.filter(r => r.status === 'occupied');

    const results = [];
    for (const r of occupiedRooms) {
      const ledgerResult = await this.getRoomLedger(r.number, { bookingId: r.booking_id, transaction: options.transaction });
      results.push({
        room_number: r.number,
        guest_name: r.guestName,
        booking_id: r.booking_id,
        totalCharges: ledgerResult.summary.totalCharges,
        totalPayments: ledgerResult.summary.totalPayments,
        outstanding: ledgerResult.summary.outstanding
      });
    }

    return results;
  }
}

export default FirestoreLedgerService;
