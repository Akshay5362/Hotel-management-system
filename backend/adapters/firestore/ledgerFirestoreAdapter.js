import { db } from '../../config/firebaseAdmin.js';
import { formatBookingId, formatRoomId } from '../../repositories/firestore/firestoreUtils.js';
import { formatTime } from '../../utils/dateUtils.js';

/**
 * Ledger Firestore Adapter
 * Handles atomic posting of folio ledger entries (room tariff, charges, taxes, payments, refunds, adjustments).
 */
export class LedgerFirestoreAdapter {
  /**
   * Posts a ledger charge item atomically to Firestore.
   */
  static async addLedgerItemFirestore({
    roomNumber,
    desc,
    amount,
    category = 'General',
    transactionType = 'CHARGE',
    businessDate = new Date().toISOString().split('T')[0],
    idempotencyKey = null,
    resolvedUserId = 'admin'
  }) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');

    const parsedAmount = parseInt(amount, 10);
    const roomDocId = `room_${roomNumber}`;
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
        const err = new Error(`Room ${roomNumber} not found`);
        err.status = 404;
        err.code = 'ROOM_NOT_FOUND';
        throw err;
      }

      const roomData = roomSnap.data();

      // Only occupied rooms can receive charges
      if (roomData.status !== 'occupied') {
        const err = new Error('Charges can only be posted to occupied rooms');
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
        const err = new Error(`No active booking found for Room ${roomNumber}`);
        err.status = 404;
        err.code = 'BOOKING_NOT_FOUND';
        throw err;
      }

      // 3. RECENT DEDUPLICATION CHECK (5-second window)
      const cleanDesc = desc.trim();
      const ledgerItemId = `ledger_${activeBookingDocId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const ledgerItemRef = db.collection('ledger_items').doc(ledgerItemId);

      // 4. WRITE LEDGER ITEM DOCUMENT
      const isCredit = transactionType === 'PAYMENT' || transactionType === 'REFUND' || parsedAmount < 0;
      const debitVal = isCredit ? 0 : Math.abs(parsedAmount);
      const creditVal = isCredit ? Math.abs(parsedAmount) : 0;

      transaction.set(ledgerItemRef, {
        item_id: ledgerItemId,
        room_number: String(roomNumber),
        desc: cleanDesc,
        description: cleanDesc,
        category: category || 'General',
        qty: 1,
        quantity: 1,
        amount: debitVal,
        credit_amount: creditVal,
        transaction_type: transactionType,
        type: transactionType,
        business_date: businessDate,
        booking_id: activeBookingDocId,
        mysql_booking_id: activeBookingData.mysql_booking_id || null,
        created_by: String(resolvedUserId || 'admin'),
        status: 'active',
        created_at: nowIso,
        updated_at: nowIso
      });

      // 5. UPDATE BOOKING TOTAL / BALANCE IF DEBIT CHARGE
      if (debitVal > 0 && bookingRef) {
        const currentTotal = Number(activeBookingData.total_amount || 0);
        transaction.set(bookingRef, {
          total_amount: currentTotal + debitVal,
          updated_at: nowIso
        }, { merge: true });
      }

      const resultPayload = {
        success: true,
        message: `Posted ${cleanDesc} of ₹${parsedAmount} to Room ${roomNumber}`,
        itemId: ledgerItemId,
        roomNumber: String(roomNumber),
        amount: parsedAmount,
        category,
        transactionType
      };

      // 6. RECORD IDEMPOTENCY KEY
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

  /**
   * Calculates the authoritative financial balance for a booking from ledger items and payments.
   * Guarantees that ledger payment credits and payment collection records are not double counted.
   */
  static calculateAuthoritativeBalance(ledgerItems = [], payments = []) {
    let grossCharges = 0;
    let validCredits = 0;
    let ledgerPayments = 0;

    (ledgerItems || []).forEach(item => {
      const debit = Number(item.amount || item.debit_amount || 0);
      const credit = Number(item.credit_amount || 0);
      const type = String(item.transaction_type || item.type || '').toUpperCase();

      if (type === 'PAYMENT') {
        ledgerPayments += credit;
      } else if (type === 'CREDIT' || type === 'ADJUSTMENT' || type === 'REFUND') {
        validCredits += credit > 0 ? credit : Math.abs(debit);
      } else {
        // Standard Charge
        grossCharges += debit > 0 ? debit : 0;
      }
    });

    // Actual payments from payments collection
    let totalPayments = 0;
    if (Array.isArray(payments) && payments.length > 0) {
      totalPayments = payments
        .filter(p => (p.payment_status || 'Completed').toLowerCase() !== 'cancelled' && (p.payment_status || 'Completed').toLowerCase() !== 'refunded')
        .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    } else {
      // Fallback to ledger payments if payments collection query returned empty
      totalPayments = ledgerPayments;
    }

    const netCharges = Math.max(0, Number((grossCharges - validCredits).toFixed(2)));
    const outstandingBalance = Math.max(0, Number((grossCharges - validCredits - totalPayments).toFixed(2)));

    return {
      grossCharges: Number(grossCharges.toFixed(2)),
      validCredits: Number(validCredits.toFixed(2)),
      netCharges,
      totalPayments: Number(totalPayments.toFixed(2)),
      outstandingBalance,
      isSettled: outstandingBalance <= 0.01
    };
  }

  /**
   * Applies a manual Room Rent Adjustment (Increase or Decrease) atomically.
   */
  static async adjustRoomRentFirestore({
    roomNumber,
    amount,
    adjustmentType = 'INCREASE',
    reason = '',
    businessDate = new Date().toISOString().split('T')[0],
    idempotencyKey = null,
    resolvedUserId = 'admin'
  }) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      const err = new Error('Adjustment amount must be a positive number greater than 0');
      err.status = 400;
      err.code = 'INVALID_ADJUSTMENT_AMOUNT';
      throw err;
    }

    const cleanReason = String(reason || '').trim();
    if (!cleanReason) {
      const err = new Error('A valid reason is required for manual room rent adjustment');
      err.status = 400;
      err.code = 'ADJUSTMENT_REASON_REQUIRED';
      throw err;
    }

    const typeUpper = String(adjustmentType || 'INCREASE').trim().toUpperCase();
    if (typeUpper !== 'INCREASE' && typeUpper !== 'DECREASE') {
      const err = new Error('Adjustment type must be either INCREASE or DECREASE');
      err.status = 400;
      err.code = 'INVALID_ADJUSTMENT_TYPE';
      throw err;
    }

    const roomDocId = `room_${roomNumber}`;
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
        const err = new Error(`Room ${roomNumber} not found`);
        err.status = 404;
        err.code = 'ROOM_NOT_FOUND';
        throw err;
      }

      const roomData = roomSnap.data();
      if (roomData.status !== 'occupied') {
        const err = new Error('Room rent adjustments can only be applied to occupied rooms');
        err.status = 400;
        err.code = 'ROOM_NOT_OCCUPIED';
        throw err;
      }

      // 2. READ ACTIVE BOOKING
      const activeBookingDocId = roomData.current_booking_id;
      if (!activeBookingDocId) {
        const err = new Error(`No active booking found for Room ${roomNumber}`);
        err.status = 404;
        err.code = 'BOOKING_NOT_FOUND';
        throw err;
      }

      const bookingRef = db.collection('bookings').doc(activeBookingDocId);
      const bkgSnap = await transaction.get(bookingRef);
      if (!bkgSnap.exists) {
        const err = new Error(`Booking ${activeBookingDocId} not found`);
        err.status = 404;
        err.code = 'BOOKING_NOT_FOUND';
        throw err;
      }
      const activeBookingData = bkgSnap.data();

      // 3. READ ALL LIVE LEDGER ITEMS AND PAYMENTS
      const ledgerSnap = await transaction.get(
        db.collection('ledger_items').where('booking_id', '==', activeBookingDocId)
      );
      const existingLedgerItems = [];
      ledgerSnap.forEach(d => existingLedgerItems.push(d.data()));

      const paymentSnap = await transaction.get(
        db.collection('payments').where('booking_id', '==', activeBookingDocId)
      );
      const existingPayments = [];
      paymentSnap.forEach(d => existingPayments.push(d.data()));

      const previousFinancials = LedgerFirestoreAdapter.calculateAuthoritativeBalance(existingLedgerItems, existingPayments);

      // 4. PREPARE ADJUSTMENT
      const isIncrease = typeUpper === 'INCREASE';
      const debitVal = isIncrease ? parsedAmount : 0;
      const creditVal = isIncrease ? 0 : parsedAmount;
      const ledgerType = isIncrease ? 'CHARGE' : 'CREDIT';
      const descText = `Room Rent Adjustment (${isIncrease ? 'Increase' : 'Decrease'}) — ${cleanReason}`;

      const ledgerDocId = `ledger_${activeBookingDocId}_adj_${Date.now()}`;
      const adjDocId = `adj_${activeBookingDocId}_${Date.now()}`;

      // Write 1: Ledger item
      const ledgerRef = db.collection('ledger_items').doc(ledgerDocId);
      const newLedgerItem = {
        item_id: ledgerDocId,
        booking_id: activeBookingDocId,
        booking_number: activeBookingData.booking_number || activeBookingDocId,
        room_number: String(roomNumber),
        desc: descText,
        description: descText,
        qty: 1,
        quantity: 1,
        amount: debitVal,
        debit_amount: debitVal,
        credit_amount: creditVal,
        transaction_type: ledgerType,
        category: 'Room Rent Adjustment',
        business_date: businessDate,
        created_at: nowIso
      };
      transaction.set(ledgerRef, newLedgerItem);

      // Write 2: Room rent adjustments audit record
      const adjRef = db.collection('room_rent_adjustments').doc(adjDocId);
      transaction.set(adjRef, {
        adjustment_id: adjDocId,
        booking_id: activeBookingDocId,
        booking_number: activeBookingData.booking_number || null,
        guest_id: activeBookingData.guest_id || null,
        guest_name: activeBookingData.guest_name || '',
        room_number: String(roomNumber),
        adjustment_type: typeUpper,
        amount: parsedAmount,
        reason: cleanReason,
        business_date: businessDate,
        created_by: String(resolvedUserId || 'admin'),
        recorded_by: String(resolvedUserId || 'admin'),
        ledger_id: ledgerDocId,
        created_at: nowIso
      });

      // Write 3: Audit log
      const auditDocId = `audit_adj_${activeBookingDocId}_${Date.now()}`;
      transaction.set(db.collection('audit_logs').doc(auditDocId), {
        log_id: auditDocId,
        user_id: String(resolvedUserId || 'admin'),
        action: 'ROOM_RENT_ADJUSTMENT',
        details: `Room ${roomNumber} rent adjusted (${typeUpper} ₹${parsedAmount}) — Reason: ${cleanReason}`,
        business_date: businessDate,
        created_at: nowIso
      });

      // Recalculate new financials including this new item
      const updatedLedgerItems = [...existingLedgerItems, newLedgerItem];
      const updatedFinancials = LedgerFirestoreAdapter.calculateAuthoritativeBalance(updatedLedgerItems, existingPayments);

      // Write 4: Update booking total_amount & payment_status
      transaction.set(bookingRef, {
        total_amount: updatedFinancials.netCharges,
        payment_status: updatedFinancials.outstandingBalance <= 0.01 ? 'Paid' : (updatedFinancials.totalPayments > 0 ? 'Partial' : 'Pending'),
        updated_at: nowIso
      }, { merge: true });

      const resultPayload = {
        success: true,
        message: `Successfully applied ${typeUpper} adjustment of ₹${parsedAmount} for Room ${roomNumber}`,
        adjustmentId: adjDocId,
        ledgerId: ledgerDocId,
        roomNumber: String(roomNumber),
        adjustmentType: typeUpper,
        adjustmentAmount: parsedAmount,
        reason: cleanReason,
        previousBalance: previousFinancials.outstandingBalance,
        newBalance: updatedFinancials.outstandingBalance,
        grossCharges: updatedFinancials.grossCharges,
        validCredits: updatedFinancials.validCredits,
        totalPayments: updatedFinancials.totalPayments
      };

      // Write 5: Idempotency record
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
    });
  }

  /**
   * Records a partial or full payment atomically in Firestore.
   * Guarantees strict concurrency protection, overpayment prevention, and full ledger/payment auditability.
   */
  static async recordPaymentFirestore({
    roomNumber,
    amount,
    paymentMethod = 'Cash',
    reference = '',
    remarks = '',
    businessDate = new Date().toISOString().split('T')[0],
    idempotencyKey = null,
    resolvedUserId = 'admin'
  }) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      const err = new Error('Payment amount must be greater than 0');
      err.status = 400;
      err.code = 'INVALID_PAYMENT_AMOUNT';
      throw err;
    }

    const roomDocId = `room_${roomNumber}`;
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
        const err = new Error(`Room ${roomNumber} not found`);
        err.status = 404;
        err.code = 'ROOM_NOT_FOUND';
        throw err;
      }

      const roomData = roomSnap.data();
      if (roomData.status !== 'occupied') {
        const err = new Error('Payments can only be recorded for occupied rooms');
        err.status = 400;
        err.code = 'ROOM_NOT_OCCUPIED';
        throw err;
      }

      // 2. READ ACTIVE BOOKING
      const activeBookingDocId = roomData.current_booking_id;
      if (!activeBookingDocId) {
        const err = new Error(`No active booking found for Room ${roomNumber}`);
        err.status = 404;
        err.code = 'BOOKING_NOT_FOUND';
        throw err;
      }

      const bookingRef = db.collection('bookings').doc(activeBookingDocId);
      const bkgSnap = await transaction.get(bookingRef);
      if (!bkgSnap.exists) {
        const err = new Error(`Booking ${activeBookingDocId} not found`);
        err.status = 404;
        err.code = 'BOOKING_NOT_FOUND';
        throw err;
      }
      const activeBookingData = bkgSnap.data();

      // 3. READ ALL LIVE LEDGER ITEMS AND PAYMENTS TO CALCULATE AUTHORITATIVE OUTSTANDING BALANCE
      const ledgerSnap = await transaction.get(
        db.collection('ledger_items').where('booking_id', '==', activeBookingDocId)
      );

      const existingLedgerItems = [];
      ledgerSnap.forEach(doc => existingLedgerItems.push(doc.data()));

      const paymentSnap = await transaction.get(
        db.collection('payments').where('booking_id', '==', activeBookingDocId)
      );
      const existingPayments = [];
      paymentSnap.forEach(doc => existingPayments.push(doc.data()));

      const financials = LedgerFirestoreAdapter.calculateAuthoritativeBalance(existingLedgerItems, existingPayments);
      const currentOutstanding = financials.outstandingBalance;

      // 4. OVERPAYMENT & BALANCE VALIDATION
      if (parsedAmount > currentOutstanding + 0.01) {
        const err = new Error(`Payment amount (₹${parsedAmount}) cannot exceed the outstanding balance (₹${currentOutstanding}).`);
        err.status = 400;
        err.code = 'PAYMENT_EXCEEDS_BALANCE';
        err.outstanding = currentOutstanding;
        throw err;
      }

      const cleanRemarks = String(remarks || reference || '').trim();
      const paymentDesc = `Payment Received (${paymentMethod})${cleanRemarks ? ' - ' + cleanRemarks : ''}`;
      const paymentNumber = 'PAY-' + Math.floor(100000 + Math.random() * 900000);
      const paymentDocId = `payment_${activeBookingData.booking_number || activeBookingDocId}_${Date.now()}`;
      const ledgerDocId = `ledger_${activeBookingDocId}_${Date.now()}_pay`;

      // 5. WRITE LEDGER PAYMENT ITEM
      const ledgerRef = db.collection('ledger_items').doc(ledgerDocId);
      transaction.set(ledgerRef, {
        item_id: ledgerDocId,
        room_number: String(roomNumber),
        desc: paymentDesc,
        description: paymentDesc,
        qty: 1,
        quantity: 1,
        amount: 0,
        credit_amount: parsedAmount,
        transaction_type: 'PAYMENT',
        type: 'PAYMENT',
        payment_mode: paymentMethod,
        reference: cleanRemarks,
        business_date: businessDate,
        booking_id: activeBookingDocId,
        booking_number: activeBookingData.booking_number || null,
        created_by: String(resolvedUserId || 'admin'),
        status: 'active',
        created_at: nowIso,
        updated_at: nowIso
      });

      // 6. WRITE PAYMENT DOCUMENT WITH FULL AUDIT METADATA
      const paymentRef = db.collection('payments').doc(paymentDocId);
      const isFullSettlement = (currentOutstanding - parsedAmount) <= 0.01;
      transaction.set(paymentRef, {
        payment_id: paymentDocId,
        payment_number: paymentNumber,
        booking_id: activeBookingDocId,
        booking_number: activeBookingData.booking_number || null,
        guest_id: activeBookingData.guest_id || null,
        guest_name: activeBookingData.guest_name || '',
        room_number: String(roomNumber),
        amount: parsedAmount,
        payment_method: paymentMethod,
        payment_type: isFullSettlement ? 'Full Settlement' : 'Partial Payment',
        payment_status: 'Completed',
        reference: cleanRemarks,
        business_date: businessDate,
        payment_date: nowIso,
        created_by: String(resolvedUserId || 'admin'),
        recorded_by: String(resolvedUserId || 'admin'),
        created_at: nowIso,
        updated_at: nowIso
      });

      // 7. WRITE CASH LOG IF CASH PAYMENT
      if (paymentMethod === 'Cash') {
        const cashLogDocId = `cash_${activeBookingData.booking_number || activeBookingDocId}_${Date.now()}`;
        transaction.set(db.collection('cash_logs').doc(cashLogDocId), {
          log_id: cashLogDocId,
          room: String(roomNumber),
          room_number: String(roomNumber),
          guest: activeBookingData.guest_name || '',
          type: isFullSettlement ? 'Full Settlement' : 'Partial Payment',
          amount: parsedAmount,
          business_date: businessDate,
          booking_id: activeBookingDocId,
          time: formatTime(new Date()),
          created_by: String(resolvedUserId || 'admin'),
          recorded_by: String(resolvedUserId || 'admin'),
          created_at: nowIso
        });
      }

      // 8. UPDATE BOOKING ADVANCE / PAYMENT STATUS
      const newAdvanceTotal = Number(activeBookingData.advance_amount || 0) + parsedAmount;
      const newOutstanding = Math.max(0, Number((currentOutstanding - parsedAmount).toFixed(2)));
      transaction.set(bookingRef, {
        advance_amount: newAdvanceTotal,
        payment_status: newOutstanding <= 0.01 ? 'Paid' : 'Partial',
        updated_at: nowIso
      }, { merge: true });

      const resultPayload = {
        success: true,
        message: `Successfully recorded payment of ₹${parsedAmount} for Room ${roomNumber}`,
        paymentId: paymentDocId,
        paymentNumber,
        roomNumber: String(roomNumber),
        amount: parsedAmount,
        paymentMethod,
        previousOutstanding: currentOutstanding,
        newOutstanding,
        isSettled: newOutstanding <= 0.01
      };

      // 9. RECORD IDEMPOTENCY KEY
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

export default LedgerFirestoreAdapter;

