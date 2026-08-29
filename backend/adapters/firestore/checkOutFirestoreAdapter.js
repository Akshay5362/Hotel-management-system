import { db } from '../../config/firebaseAdmin.js';
import { formatTime } from '../../utils/dateUtils.js';
import { LedgerFirestoreAdapter } from './ledgerFirestoreAdapter.js';

/**
 * Atomic Firestore Transaction Adapter for Checkout.
 * Coordinates booking status update, room status transition to dirty/Dirty,
 * independent zero-balance enforcement, invoice generation, checkout snapshot, and idempotency.
 */
export const processCheckOutFirestoreTransaction = async ({
  number,
  parsedBalancePaid = 0,
  resolvedUserId = 'admin',
  businessDate = new Date().toISOString().split('T')[0],
  idempotencyKey = null,
  paymentMethod = 'Cash'
}) => {
  if (!db) {
    throw new Error('Firebase Admin DB is not initialized.');
  }

  const roomDocId = `room_${number}`;

  return await db.runTransaction(async (transaction) => {
    // 0. IDEMPOTENCY CHECK
    if (idempotencyKey) {
      const idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
      const idemSnap = await transaction.get(idemRef);
      if (idemSnap.exists && idemSnap.data().status === 'COMPLETED') {
        console.log(`[CheckOutFirestore] Idempotent request replayed for key: ${idempotencyKey}`);
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

    // 2. RESOLVE ACTIVE BOOKING FOR THIS ROOM
    let activeBookingDocId = roomData.current_booking_id;
    let activeBookingData = null;
    let candidateCheckedOutBooking = null;
    const roomNumStr = String(number).trim();

    // Primary Path: Check if room.current_booking_id points to an active Checked In booking for this room
    if (activeBookingDocId) {
      const bSnap = await transaction.get(db.collection('bookings').doc(activeBookingDocId));
      if (bSnap.exists) {
        const candidate = bSnap.data();
        const candidateRoomNum = String(candidate.room_number || '').trim();
        const candidateRoomId = String(candidate.room_id || '').trim();
        const isMatchRoom = candidateRoomNum === roomNumStr || candidateRoomId === roomDocId || candidateRoomId === roomNumStr;

        if (isMatchRoom) {
          if (candidate.booking_status === 'Checked In') {
            activeBookingData = candidate;
          } else if (candidate.booking_status === 'Checked Out') {
            candidateCheckedOutBooking = candidate;
          }
        }
      }
    }

    // Safe Fallback: If current_booking_id is null, missing, stale, points to Checked Out booking,
    // or points to another room, query Firestore bookings collection for active Checked In stays
    if (!activeBookingData) {
      // Query bookings matching this room number with 'Checked In' status
      const activeQuery = await transaction.get(
        db.collection('bookings')
          .where('booking_status', '==', 'Checked In')
          .where('room_number', '==', roomNumStr)
      );

      if (activeQuery.empty) {
        // Also check by room_id if room_number query was empty
        const activeByIdQuery = await transaction.get(
          db.collection('bookings')
            .where('booking_status', '==', 'Checked In')
            .where('room_id', '==', roomDocId)
        );

        if (activeByIdQuery.size === 1) {
          activeBookingDocId = activeByIdQuery.docs[0].id;
          activeBookingData = activeByIdQuery.docs[0].data();
        } else if (activeByIdQuery.size > 1) {
          const err = new Error(`FIRESTORE_DATA_INCONSISTENCY: Multiple active Checked In bookings found for Room ${number}`);
          err.status = 409;
          err.code = 'DATA_INCONSISTENCY';
          throw err;
        }
      } else if (activeQuery.size === 1) {
        activeBookingDocId = activeQuery.docs[0].id;
        activeBookingData = activeQuery.docs[0].data();
      } else {
        // More than one active Checked In booking found -> FAIL CLOSED!
        const err = new Error(`FIRESTORE_DATA_INCONSISTENCY: Multiple active Checked In bookings found for Room ${number}`);
        err.status = 409;
        err.code = 'DATA_INCONSISTENCY';
        throw err;
      }
    }

    // If zero active bookings exist anywhere:
    if (!activeBookingData) {
      if (candidateCheckedOutBooking) {
        const err = new Error(`Booking for Room ${number} is already checked out`);
        err.status = 400;
        err.code = 'ALREADY_CHECKED_OUT';
        throw err;
      }
      const err = new Error(`Room ${number} is not occupied`);
      err.status = 400;
      err.code = 'ROOM_NOT_OCCUPIED';
      throw err;
    }

    // Validate booking status
    if (activeBookingData.booking_status === 'Checked Out') {
      const err = new Error(`Booking for Room ${number} is already checked out`);
      err.status = 400;
      err.code = 'ALREADY_CHECKED_OUT';
      throw err;
    }

    const bookingRef = db.collection('bookings').doc(activeBookingDocId);
    const nowIso = new Date().toISOString();

    // 3. INDEPENDENT AUTHORITATIVE BALANCE VERIFICATION
    const existingLedgers = [];
    const ledgerSnap = await transaction.get(
      db.collection('ledger_items').where('booking_id', '==', activeBookingDocId)
    );
    ledgerSnap.forEach(d => existingLedgers.push(d.data()));

    const existingPayments = [];
    const paymentSnap = await transaction.get(
      db.collection('payments').where('booking_id', '==', activeBookingDocId)
    );
    paymentSnap.forEach(d => existingPayments.push(d.data()));

    const financials = LedgerFirestoreAdapter.calculateAuthoritativeBalance(existingLedgers, existingPayments);

    let grossCharges = financials.grossCharges;
    if (grossCharges === 0) {
      grossCharges = Number(activeBookingData.total_amount || activeBookingData.room_tariff || roomData.price || roomData.rate || 0);
    }
    const validCredits = financials.validCredits;
    const netCharges = Math.max(0, Number((grossCharges - validCredits).toFixed(2)));

    let existingTotalPayments = financials.totalPayments;
    if (existingTotalPayments === 0 && Number(activeBookingData.advance_amount || 0) > 0) {
      existingTotalPayments = Number(activeBookingData.advance_amount || 0);
    }

    const settlementAmount = Number(parsedBalancePaid || 0);
    const outstandingBeforeSettlement = Number((netCharges - existingTotalPayments).toFixed(2));
    const finalOutstanding = Number((outstandingBeforeSettlement - settlementAmount).toFixed(2));

    if (finalOutstanding > 0.01) {
      const err = new Error(`Checkout cannot be completed. Outstanding balance is ₹${finalOutstanding.toLocaleString('en-IN')}. Please record the guest's payment before checking out.`);
      err.status = 400;
      err.code = 'BALANCE_DUE';
      err.bookingId = activeBookingDocId;
      err.totalCharges = grossCharges;
      err.totalCredits = validCredits;
      err.totalPayments = existingTotalPayments + settlementAmount;
      err.balanceDue = finalOutstanding;
      throw err;
    }

    const totalCollected = Number((existingTotalPayments + settlementAmount).toFixed(2));
    const finalCharges = netCharges;

    // 4. WRITE SETTLEMENT PAYMENT, CASH LOG, AND LEDGER IF SETTLEMENT AMOUNT != 0
    if (settlementAmount !== 0) {
      const isRefund = settlementAmount < 0;
      const paymentDocId = `payment_${activeBookingDocId}_checkout`;
      const paymentRef = db.collection('payments').doc(paymentDocId);

      transaction.set(paymentRef, {
        payment_id: paymentDocId,
        payment_number: 'PAY-OUT-' + Math.floor(100000 + Math.random() * 900000),
        booking_id: activeBookingDocId,
        booking_number: activeBookingData.booking_number || activeBookingDocId,
        guest_id: activeBookingData.guest_id || null,
        guest_name: activeBookingData.guest_name || 'GUEST',
        room_number: String(number),
        amount: isRefund ? Math.abs(settlementAmount) : settlementAmount,
        payment_method: paymentMethod || 'Cash',
        payment_type: isRefund ? 'Checkout Refund' : 'Checkout Settlement',
        type: isRefund ? 'Checkout Refund' : 'Checkout Settlement',
        payment_status: isRefund ? 'Refunded' : 'Completed',
        business_date: businessDate,
        payment_date: nowIso,
        created_by: String(resolvedUserId || 'admin'),
        recorded_by: String(resolvedUserId || 'admin'),
        created_at: nowIso,
        updated_at: nowIso
      });

      if ((paymentMethod || 'Cash') === 'Cash') {
        const cashLogDocId = `cash_${activeBookingDocId}_checkout`;
        const cashLogRef = db.collection('cash_logs').doc(cashLogDocId);
        transaction.set(cashLogRef, {
          log_id: cashLogDocId,
          room: String(number),
          room_number: String(number),
          guest: activeBookingData.guest_name || 'GUEST',
          type: isRefund ? 'Checkout Refund' : 'Checkout Settlement',
          amount: isRefund ? Math.abs(settlementAmount) : settlementAmount,
          payment_mode: 'Cash',
          business_date: businessDate,
          booking_id: activeBookingDocId,
          time: formatTime(new Date()),
          created_by: String(resolvedUserId || 'admin'),
          recorded_by: String(resolvedUserId || 'admin'),
          created_at: nowIso
        });
      }

      const ledgerDocId = `ledger_${activeBookingDocId}_checkout`;
      const ledgerRef = db.collection('ledger_items').doc(ledgerDocId);
      transaction.set(ledgerRef, {
        item_id: ledgerDocId,
        room_number: String(number),
        desc: `Checkout ${isRefund ? 'Refund' : 'Settlement'} (${paymentMethod || 'Cash'})`,
        description: `Checkout ${isRefund ? 'Refund' : 'Settlement'} (${paymentMethod || 'Cash'})`,
        qty: 1,
        quantity: 1,
        amount: isRefund ? Math.abs(settlementAmount) : 0,
        credit_amount: isRefund ? 0 : settlementAmount,
        debit_amount: isRefund ? Math.abs(settlementAmount) : 0,
        transaction_type: isRefund ? 'REFUND' : 'PAYMENT',
        type: isRefund ? 'REFUND' : 'PAYMENT',
        payment_mode: paymentMethod || 'Cash',
        business_date: businessDate,
        booking_id: activeBookingDocId,
        booking_number: activeBookingData.booking_number || null,
        created_by: String(resolvedUserId || 'admin'),
        status: 'active',
        created_at: nowIso,
        updated_at: nowIso
      });
    }

    // 5. UPDATE BOOKING DOCUMENT
    transaction.set(bookingRef, {
      booking_status: 'Checked Out',
      payment_status: 'Paid',
      total_amount: finalCharges,
      advance_amount: totalCollected,
      check_out_date: businessDate,
      updated_at: nowIso
    }, { merge: true });

    // 6. CREATE / UPDATE INVOICE DOCUMENT
    const numPart = activeBookingData.booking_number 
      ? activeBookingData.booking_number.replace(/^BKG-/, '') 
      : activeBookingDocId.replace('booking_', '').slice(-4);
    const invoiceNumber = `INV-${businessDate.replace(/-/g, '')}-${numPart}`;
    const invoiceRef = db.collection('invoices').doc(`invoice_${invoiceNumber}`);
    
    transaction.set(invoiceRef, {
      invoice_number: invoiceNumber,
      booking_id: bookingRef.id,
      booking_number: activeBookingData.booking_number || bookingRef.id,
      guest_name: activeBookingData.guest_name || 'GUEST',
      room_number: String(number),
      total_amount: finalCharges,
      paid_amount: totalCollected,
      balance_due: 0,
      status: 'Paid',
      invoice_status: 'Paid',
      business_date: businessDate,
      created_at: nowIso,
      updated_at: nowIso
    }, { merge: true });

    // 7. UPDATE ROOM STATUS TO DIRTY (HIGH PRIORITY)
    transaction.set(roomRef, {
      status: 'dirty',
      housekeeping_status: 'Dirty',
      housekeeping_priority: 'High Priority',
      current_booking_id: null,
      updated_at: nowIso
    }, { merge: true });

    // 8. CREATE CHECKOUT SNAPSHOT DOCUMENT
    const bkgCleanId = bookingRef.id.startsWith('bkg_') ? bookingRef.id : `bkg_${bookingRef.id}`;
    const snapshotRef = db.collection('checkout_snapshots').doc(`snap_${bkgCleanId}`);
    transaction.set(snapshotRef, {
      snapshot_id: snapshotRef.id,
      booking_id: bookingRef.id,
      booking_number: activeBookingData.booking_number || bookingRef.id,
      room_number: String(number),
      guest_name: activeBookingData.guest_name || 'GUEST',
      total_collected: totalCollected,
      business_date: businessDate,
      snapshot_data: {
        booking: activeBookingData,
        room: roomData,
        invoice_number: invoiceNumber,
        total_collected: totalCollected,
        balance_paid: parsedBalancePaid,
        business_date: businessDate
      },
      created_at: nowIso
    });

    // 9. ROOM STATUS HISTORY AUDIT DOCUMENT
    const rshRef = db.collection('room_status_history').doc(`rsh_${bookingRef.id}_checkout`);
    transaction.set(rshRef, {
      room_id: roomRef.id,
      room_number: String(number),
      old_status: 'occupied',
      new_status: 'dirty',
      changed_by: resolvedUserId || 'admin',
      business_date: businessDate,
      created_at: nowIso
    });

    const resultPayload = {
      success: true,
      bookingId: bookingRef.id,
      bookingNumber: activeBookingData.booking_number || bookingRef.id,
      roomNumber: String(number),
      totalCollected,
      invoiceNumber
    };

    // 10. IDEMPOTENCY RECORD WRITE
    if (idempotencyKey) {
      const idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
      transaction.set(idemRef, {
        idempotency_key: String(idempotencyKey),
        status: 'COMPLETED',
        result: resultPayload,
        created_at: nowIso
      });
    }

    return resultPayload;
  }, { maxAttempts: 1 });
};
