import { db } from '../../config/firebaseAdmin.js';
import { formatTime } from '../../utils/dateUtils.js';

/**
 * Refund Checkout Firestore Adapter
 * Handles atomic cancellation refund checkouts in Firestore across Room, Booking,
 * Invoice, Ledger, Cash Logs, System Settings, and Audit records.
 */
export class RefundCheckoutFirestoreAdapter {
  /**
   * Processes a refund checkout within an atomic Firestore transaction.
   */
  static async processRefundCheckoutFirestore({
    number,
    refundAmount,
    reason = 'Guest Cancellation',
    resolvedUserId = 'admin',
    businessDate = new Date().toISOString().split('T')[0],
    idempotencyKey = null
  }) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');

    const roomDocId = `room_${number}`;
    const parsedRefund = parseFloat(refundAmount);
    const refundReason = (reason || 'Guest Cancellation').trim();
    const nowIso = new Date().toISOString();

    return await db.runTransaction(async (transaction) => {
      // 0. IDEMPOTENCY CHECK
      if (idempotencyKey) {
        const idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
        const idemSnap = await transaction.get(idemRef);
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED') {
          return {
            ...idemSnap.data().result,
            replayed: true
          };
        }
      }

      // 1. READ ROOM DOCUMENT
      const roomRef = db.collection('rooms').doc(roomDocId);
      const roomSnap = await transaction.get(roomRef);

      if (!roomSnap.exists) {
        const err = new Error(`Room ${number} not found`);
        err.status = 404;
        err.code = 'ROOM_NOT_FOUND';
        throw err;
      }

      const roomData = roomSnap.data();

      if (roomData.status !== 'occupied') {
        const err = new Error(`Room ${number} is not currently occupied`);
        err.status = 400;
        err.code = 'ROOM_NOT_OCCUPIED';
        throw err;
      }

      // 2. READ ACTIVE BOOKING
      const activeBookingDocId = roomData.current_booking_id;
      let activeBookingData = null;
      let bookingRef = null;

      if (activeBookingDocId) {
        bookingRef = db.collection('bookings').doc(activeBookingDocId);
        const bkgSnap = await transaction.get(bookingRef);
        if (bkgSnap.exists) {
          activeBookingData = bkgSnap.data();
        }
      }

      if (!activeBookingData) {
        const err = new Error(`No active booking found for Room ${number}`);
        err.status = 404;
        err.code = 'BOOKING_NOT_FOUND';
        throw err;
      }

      if (activeBookingData.booking_status === 'Checked Out') {
        const err = new Error(`Booking for Room ${number} is already checked out`);
        err.status = 400;
        err.code = 'ALREADY_CHECKED_OUT';
        throw err;
      }

      // 3. READ SYSTEM DATE SETTINGS
      const settingsRef = db.collection('settings').doc('system_date');
      const settingsSnap = await transaction.get(settingsRef);
      let currentCheckouts = 0;
      if (settingsSnap.exists) {
        currentCheckouts = Number(settingsSnap.data().today_checkouts || 0);
      }

      // 4. WRITES: BOOKING UPDATE
      transaction.set(bookingRef, {
        booking_status: 'Checked Out',
        payment_status: 'Refunded',
        check_out_date: businessDate,
        refund_amount: parsedRefund,
        refund_reason: refundReason,
        updated_at: nowIso
      }, { merge: true });

      // 5. WRITES: ROOM UPDATE (status -> dirty)
      transaction.set(roomRef, {
        status: 'dirty',
        housekeeping_status: 'Dirty',
        current_booking_id: null,
        updated_at: nowIso
      }, { merge: true });

      // 6. WRITES: INVOICE UPDATE (if invoice exists)
      if (activeBookingData.invoice_number) {
        const invRef = db.collection('invoices').doc(`invoice_${activeBookingData.invoice_number}`);
        transaction.set(invRef, {
          status: 'Refunded',
          invoice_status: 'Refunded',
          refund_amount: parsedRefund,
          updated_at: nowIso
        }, { merge: true });
      }

      // 7. WRITES: LEDGER & CASH & PAYMENT (if refund > 0)
      if (parsedRefund > 0) {
        // Ledger entry (Credit to guest)
        const ledgerRefundRef = db.collection('ledger_items').doc(`ledger_${activeBookingDocId}_refund`);
        transaction.set(ledgerRefundRef, {
          item_id: ledgerRefundRef.id,
          room_number: String(number),
          desc: `Cancellation Refund (${refundReason})`,
          description: `Cancellation Refund (${refundReason})`,
          qty: 1,
          quantity: 1,
          amount: 0,
          credit_amount: parsedRefund,
          transaction_type: 'REFUND',
          type: 'REFUND',
          business_date: businessDate,
          booking_id: activeBookingDocId,
          mysql_booking_id: activeBookingData.mysql_booking_id || null,
          created_by: String(resolvedUserId || 'admin'),
          status: 'active',
          created_at: nowIso,
          updated_at: nowIso
        });

        // Cash log entry
        const cashLogRef = db.collection('cash_logs').doc(`cash_refund_${activeBookingDocId}_${Date.now()}`);
        transaction.set(cashLogRef, {
          time: formatTime(new Date()),
          room: String(number),
          guest: activeBookingData.guest_name || 'GUEST',
          type: 'Cancellation Refund',
          amount: parsedRefund,
          business_date: businessDate,
          booking_id: activeBookingDocId,
          created_at: nowIso
        });

        // Payments record
        const paymentRefundRef = db.collection('payments').doc(`pay_refund_${activeBookingDocId}`);
        transaction.set(paymentRefundRef, {
          payment_id: paymentRefundRef.id,
          booking_id: activeBookingDocId,
          mysql_booking_id: activeBookingData.mysql_booking_id || null,
          amount: -parsedRefund,
          currency: 'INR',
          payment_method: 'Cash',
          payment_status: 'Refunded',
          payment_type: 'Cancellation Refund',
          business_date: businessDate,
          remarks: `Refund checkout: ${refundReason}`,
          created_at: nowIso,
          updated_at: nowIso
        });
      }

      // 8. UPDATE SETTINGS COUNTERS (today_checkouts + 1)
      transaction.set(settingsRef, {
        today_checkouts: currentCheckouts + 1,
        updated_at: nowIso
      }, { merge: true });

      // 9. ROOM STATUS HISTORY AUDIT
      const rshRef = db.collection('room_status_history').doc(`rsh_${activeBookingDocId}_refund_checkout`);
      transaction.set(rshRef, {
        room_id: roomRef.id,
        room_number: String(number),
        old_status: 'occupied',
        new_status: 'dirty',
        changed_by: String(resolvedUserId || 'admin'),
        business_date: businessDate,
        created_at: nowIso
      });

      // 10. AUDIT LOG
      const auditRef = db.collection('audit_logs').doc(`audit_refund_${activeBookingDocId}_${Date.now()}`);
      transaction.set(auditRef, {
        user_id: resolvedUserId || 'admin',
        action: 'REFUND_CHECKOUT',
        details: `Refund checkout for Room ${number}. Guest: ${activeBookingData.guest_name}. Refund: ₹${parsedRefund}. Reason: ${refundReason}. Booking ID: ${activeBookingDocId}`,
        business_date: businessDate,
        created_at: nowIso
      });

      const resultPayload = {
        success: true,
        message: `Refund checkout processed for Room ${number}. Refund of ₹${parsedRefund} recorded.`,
        bookingId: activeBookingDocId,
        roomNumber: String(number),
        refundAmount: parsedRefund,
        reason: refundReason
      };

      // 11. RECORD IDEMPOTENCY KEY
      if (idempotencyKey) {
        transaction.set(db.collection('idempotency_keys').doc(String(idempotencyKey)), {
          idempotency_key: String(idempotencyKey),
          status: 'COMPLETED',
          result: resultPayload,
          created_at: nowIso
        });
      }

      return resultPayload;
    });
  }
}

export default RefundCheckoutFirestoreAdapter;
