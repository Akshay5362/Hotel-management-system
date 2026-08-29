import { db } from '../../config/firebaseAdmin.js';
import crypto from 'crypto';
import { formatBookingId, formatPaymentId, formatInvoiceId } from '../../repositories/firestore/firestoreUtils.js';

function parseToComparableDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr).substring(0, 10);
  return d.toISOString().split('T')[0];
}

function generateTransactionId() {
  return 'TXN-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

export class PaymentFirestoreAdapter {
  /**
   * Finalizes a payment for a booking in Firestore atomically with idempotency.
   */
  static async processFinalizePaymentFirestore(params) {
    const { bookingId, paymentMethod, user = {}, idempotencyKey = null } = params;

    if (!bookingId) {
      const err = new Error('bookingId is required');
      err.status = 400;
      throw err;
    }

    const allowedMethods = ['Cash', 'UPI', 'Debit Card', 'Credit Card', 'QR Code', 'Net Banking', 'Wallet'];
    const method = allowedMethods.includes(paymentMethod) ? paymentMethod : 'Cash';
    const gateway = method === 'Cash' ? 'Internal' : 'Gateway';
    const remarks = method === 'Cash'
      ? 'Cash to be collected at reception during check-in'
      : `${method} — awaiting gateway confirmation`;

    const bkgDocId = String(bookingId).startsWith('bkg_') || String(bookingId).startsWith('booking_')
      ? String(bookingId)
      : `booking_${bookingId}`;
    const rawBkgId = String(bookingId).replace(/^bkg_/, '').replace(/^booking_/, '');
    const userId = user.id || user.uid || null;
    const nowIso = new Date().toISOString();

    return await db.runTransaction(async (transaction) => {
      // ════════════════════════════════════════════════════════════════════════
      // PHASE 1: ALL READS FIRST (Strict Firestore Invariant)
      // ════════════════════════════════════════════════════════════════════════

      // 1. Idempotency Check Read
      let cachedResult = null;
      let idemRef = null;
      if (idempotencyKey) {
        idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
        const idemSnap = await transaction.get(idemRef);
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED' && idemSnap.data()?.result) {
          console.log(`[Idempotency] Returning cached finalizePayment result for key ${idempotencyKey}`);
          cachedResult = idemSnap.data().result;
        }
      }

      if (cachedResult) {
        return cachedResult;
      }

      // 2. Query Pending Payment Document
      const rootPaySnap1 = await transaction.get(
        db.collection('payments').where('booking_id', '==', bkgDocId).limit(10)
      );
      let payDocSnap = rootPaySnap1.docs.find(d => d.data()?.payment_status === 'Pending') || null;

      if (!payDocSnap && rawBkgId !== bkgDocId) {
        const rootPaySnap2 = await transaction.get(
          db.collection('payments').where('booking_id', '==', rawBkgId).limit(10)
        );
        payDocSnap = rootPaySnap2.docs.find(d => d.data()?.payment_status === 'Pending') || null;
      }

      if (!payDocSnap) {
        const subSnap = await transaction.get(
          db.collection('bookings').doc(bkgDocId).collection('payments').limit(10)
        );
        payDocSnap = subSnap.docs.find(d => d.data()?.payment_status === 'Pending') || null;
      }

      if (!payDocSnap) {
        return {
          success: true,
          message: 'No pending payment found — booking may already be finalised.',
          alreadyFinalised: true
        };
      }

      const paymentData = payDocSnap.data() || {};
      const paymentDocId = payDocSnap.id;
      const transactionId = generateTransactionId();

      // 3. Query Invoice Document
      const invQuery = db.collection('invoices')
        .where('booking_id', '==', bkgDocId)
        .limit(1);
      let invSnaps = await transaction.get(invQuery);
      if (invSnaps.empty && rawBkgId !== bkgDocId) {
        invSnaps = await transaction.get(
          db.collection('invoices').where('booking_id', '==', rawBkgId).limit(1)
        );
      }

      // ════════════════════════════════════════════════════════════════════════
      // PHASE 2: ALL WRITES AFTER READS
      // ════════════════════════════════════════════════════════════════════════

      // Write 1: Update Payment Document in Root
      const updatedPaymentPayload = {
        payment_method: method,
        payment_status: 'Pending',
        payment_gateway: gateway,
        payment_source: 'guest_portal',
        transaction_id: transactionId,
        created_by: userId ? String(userId) : null,
        received_by: null,
        remarks,
        payment_date: null,
        updated_at: nowIso
      };

      const rootPayRef = db.collection('payments').doc(paymentDocId);
      transaction.set(rootPayRef, updatedPaymentPayload, { merge: true });

      // Write 2: Update Payment Document in Subcollection
      const subPayRef = db.collection('bookings').doc(bkgDocId).collection('payments').doc(paymentDocId);
      transaction.set(subPayRef, updatedPaymentPayload, { merge: true });

      // Write 3: Update Invoice Status
      if (!invSnaps.empty) {
        const invDoc = invSnaps.docs[0];
        const invData = invDoc.data();
        const balDue = Number(invData.balance_due || 0);
        const paidAmt = Number(invData.paid_amount || 0);
        const invStatus = balDue <= 0 ? 'Paid' : (paidAmt > 0 ? 'Partially Paid' : 'Issued');

        transaction.set(invDoc.ref, {
          status: invStatus,
          invoice_status: invStatus,
          issued_at: invData.issued_at || nowIso,
          updated_at: nowIso
        }, { merge: true });
      }

      const result = {
        success: true,
        message: method === 'Cash'
          ? `Booking confirmed. Cash payment of ₹${paymentData.amount || 0} is pending — please pay at the reception desk during check-in.`
          : `Payment recorded. ${method} processing pending gateway integration.`,
        paymentId: paymentDocId,
        transactionId,
        method,
        status: 'Pending',
        cashPending: method === 'Cash'
      };

      // Write 4: Store Idempotency Record
      if (idemRef) {
        transaction.set(idemRef, {
          key: idempotencyKey,
          status: 'COMPLETED',
          domain: 'payments_finalize',
          booking_id: bkgDocId,
          result,
          created_at: nowIso
        });
      }

      return result;
    });
  }

  /**
   * Confirms a Cash Payment received at reception atomically with cash logs & ledger credit.
   */
  static async processConfirmCashPaymentFirestore(params) {
    const { bookingId, adminId = null, idempotencyKey = null } = params;

    if (!bookingId) {
      const err = new Error('bookingId is required');
      err.status = 400;
      throw err;
    }

    const bkgDocId = String(bookingId).startsWith('bkg_') || String(bookingId).startsWith('booking_')
      ? String(bookingId)
      : `booking_${bookingId}`;
    const rawBkgId = String(bookingId).replace(/^bkg_/, '').replace(/^booking_/, '');
    const nowIso = new Date().toISOString();

    return await db.runTransaction(async (transaction) => {
      // ════════════════════════════════════════════════════════════════════════
      // PHASE 1: ALL READS FIRST (Strict Firestore Invariant)
      // ════════════════════════════════════════════════════════════════════════

      // 1. Idempotency Check Read
      let cachedResult = null;
      let idemRef = null;
      if (idempotencyKey) {
        idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
        const idemSnap = await transaction.get(idemRef);
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED' && idemSnap.data()?.result) {
          console.log(`[Idempotency] Returning cached confirmCashPayment result for key ${idempotencyKey}`);
          cachedResult = idemSnap.data().result;
        }
      }

      if (cachedResult) {
        return cachedResult;
      }

      // 2. Find Pending Cash Payment
      const rootPaySnap1 = await transaction.get(
        db.collection('payments').where('booking_id', '==', bkgDocId).limit(10)
      );
      let payDocSnap = rootPaySnap1.docs.find(d => {
        const data = d.data();
        return data?.payment_method === 'Cash' && data?.payment_status === 'Pending';
      }) || null;

      if (!payDocSnap && rawBkgId !== bkgDocId) {
        const rootPaySnap2 = await transaction.get(
          db.collection('payments').where('booking_id', '==', rawBkgId).limit(10)
        );
        payDocSnap = rootPaySnap2.docs.find(d => {
          const data = d.data();
          return data?.payment_method === 'Cash' && data?.payment_status === 'Pending';
        }) || null;
      }

      if (!payDocSnap) {
        const subSnap = await transaction.get(
          db.collection('bookings').doc(bkgDocId).collection('payments').limit(10)
        );
        payDocSnap = subSnap.docs.find(d => {
          const data = d.data();
          return data?.payment_method === 'Cash' && data?.payment_status === 'Pending';
        }) || null;
      }

      if (!payDocSnap) {
        const err = new Error('No pending Cash payment found for this booking.');
        err.status = 404;
        err.code = 'BOOKING_PAYMENT_NOT_FOUND';
        throw err;
      }

      const paymentData = payDocSnap.data() || {};
      const paymentDocId = payDocSnap.id;
      const amount = Number(paymentData.amount || 0);

      // 3. Read Booking Document
      const bkgRef = db.collection('bookings').doc(bkgDocId);
      const bkgSnap = await transaction.get(bkgRef);
      const bookingData = bkgSnap.exists ? bkgSnap.data() : {};
      const roomNumber = String(bookingData.room_number || paymentData.room_number || '101');

      // 4. Read Invoice Document
      let invSnaps = await transaction.get(
        db.collection('invoices').where('booking_id', '==', bkgDocId).limit(1)
      );
      if (invSnaps.empty && rawBkgId !== bkgDocId) {
        invSnaps = await transaction.get(
          db.collection('invoices').where('booking_id', '==', rawBkgId).limit(1)
        );
      }

      // ════════════════════════════════════════════════════════════════════════
      // PHASE 2: ALL WRITES AFTER READS
      // ════════════════════════════════════════════════════════════════════════

      // Write 1: Update Payment in Root
      const updatedPaymentPayload = {
        payment_status: 'Paid',
        payment_date: nowIso,
        received_by: adminId ? String(adminId) : 'Admin',
        remarks: 'Cash received at reception',
        updated_at: nowIso
      };

      transaction.set(payDocSnap.ref, updatedPaymentPayload, { merge: true });

      // Write 2: Update Payment in Subcollection
      const subPayRef = db.collection('bookings').doc(bkgDocId).collection('payments').doc(paymentDocId);
      transaction.set(subPayRef, updatedPaymentPayload, { merge: true });

      // Write 3: Update Invoice
      let finalBookingPaymentStatus = 'Paid';
      if (!invSnaps.empty) {
        const invDoc = invSnaps.docs[0];
        const invData = invDoc.data();
        const totAmt = Number(invData.total_amount || amount);
        const paidAmt = Number(invData.paid_amount || 0) + amount;
        const balDue = Math.max(0, totAmt - paidAmt);
        const invStatus = balDue <= 0 ? 'Paid' : (paidAmt > 0 ? 'Partially Paid' : 'Issued');
        finalBookingPaymentStatus = balDue <= 0 ? 'Paid' : 'Partial';

        transaction.set(invDoc.ref, {
          paid_amount: paidAmt,
          balance_due: balDue,
          outstanding_amount: balDue,
          status: invStatus,
          invoice_status: invStatus,
          updated_at: nowIso
        }, { merge: true });
      }

      // Write 4: Update Booking Payment Status
      if (bkgSnap.exists) {
        transaction.set(bkgRef, {
          payment_status: finalBookingPaymentStatus,
          advance_amount: amount,
          updated_at: nowIso
        }, { merge: true });
      }

      // Write 5: Record Cash Log
      const cashLogDocId = `cash_log_${paymentDocId}_confirm`;
      const cashLogRef = db.collection('cash_logs').doc(cashLogDocId);
      transaction.set(cashLogRef, {
        log_id: cashLogDocId,
        amount,
        type: 'Advance Deposit',
        payment_mode: 'Cash',
        booking_id: bkgDocId,
        room_number: roomNumber,
        business_date: paymentData.business_date || nowIso.split('T')[0],
        user_id: adminId ? String(adminId) : null,
        created_at: nowIso
      }, { merge: true });

      // Write 6: Record Ledger Item Credit
      const ledgerDocId = `ledger_${paymentDocId}_credit`;
      const ledgerRef = db.collection('ledger_items').doc(ledgerDocId);
      transaction.set(ledgerRef, {
        doc_id: ledgerDocId,
        room_number: roomNumber,
        booking_id: bkgDocId,
        desc: 'Advance Deposit (Cash)',
        description: 'Advance Deposit (Cash)',
        qty: 1,
        amount: 0,
        credit_amount: amount,
        transaction_type: 'PAYMENT',
        payment_mode: 'Cash',
        business_date: paymentData.business_date || nowIso.split('T')[0],
        status: 'Settled',
        created_at: nowIso
      }, { merge: true });

      const result = {
        success: true,
        message: `Cash payment of ₹${amount} confirmed successfully.`,
        paymentId: paymentDocId,
        amount
      };

      // Write 7: Idempotency Completion
      if (idemRef) {
        transaction.set(idemRef, {
          key: idempotencyKey,
          status: 'COMPLETED',
          domain: 'payments_confirm_cash',
          booking_id: bkgDocId,
          result,
          created_at: nowIso
        });
      }

      return result;
    });
  }

  /**
   * Retrieves all payments for a booking from Firestore.
   */
  static async getPaymentsByBookingFirestore(bookingId, user = {}) {
    if (!bookingId) return { success: false, message: 'bookingId is required' };

    const bkgDocId = String(bookingId).startsWith('bkg_') || String(bookingId).startsWith('booking_')
      ? String(bookingId)
      : `booking_${bookingId}`;
    const rawBkgId = String(bookingId).replace(/^bkg_/, '').replace(/^booking_/, '');

    const rootByDocId = await db.collection('payments')
      .where('booking_id', '==', bkgDocId)
      .get();

    const map = new Map();
    rootByDocId.forEach(doc => map.set(doc.id, { id: doc.id, ...doc.data() }));

    if (rawBkgId !== bkgDocId) {
      const rootByRawId = await db.collection('payments')
        .where('booking_id', '==', rawBkgId)
        .get();
      rootByRawId.forEach(doc => map.set(doc.id, { id: doc.id, ...doc.data() }));
    }

    const subSnaps = await db.collection('bookings').doc(bkgDocId).collection('payments').get();
    subSnaps.forEach(doc => map.set(doc.id, { id: doc.id, ...doc.data() }));

    const payments = Array.from(map.values()).map(p => ({
      id: p.mysql_payment_id || p.id,
      booking_id: p.mysql_booking_id || (!isNaN(Number(rawBkgId)) ? Number(rawBkgId) : bkgDocId),
      amount: Number(p.amount || 0),
      currency: p.currency || 'INR',
      payment_method: p.payment_method || 'Cash',
      payment_type: p.payment_type || 'Advance',
      payment_source: p.payment_source || 'Guest Portal',
      payment_status: p.payment_status || 'Pending',
      payment_gateway: p.payment_gateway || 'Internal',
      transaction_id: p.transaction_id || '',
      payment_date: p.payment_date || null,
      remarks: p.remarks || '',
      business_date: p.business_date || '',
      created_at: p.created_at || null,
      created_by_name: p.created_by || 'Staff',
      received_by_name: p.received_by || null
    }));

    let invSnaps = await db.collection('invoices')
      .where('booking_id', '==', bkgDocId)
      .limit(1)
      .get();
    if (invSnaps.empty && rawBkgId !== bkgDocId) {
      invSnaps = await db.collection('invoices')
        .where('booking_id', '==', rawBkgId)
        .limit(1)
        .get();
    }
    const invoice = !invSnaps.empty ? { id: invSnaps.docs[0].id, ...invSnaps.docs[0].data() } : null;

    const totalPaid = payments.filter(p => p.payment_status === 'Paid').reduce((s, p) => s + p.amount, 0);
    const totalPending = payments.filter(p => p.payment_status === 'Pending').reduce((s, p) => s + p.amount, 0);
    const totalRefunded = payments.filter(p => p.payment_status === 'Refunded').reduce((s, p) => s + p.amount, 0);

    return {
      success: true,
      bookingId: !isNaN(Number(rawBkgId)) ? Number(rawBkgId) : bookingId,
      payments,
      invoice,
      summary: {
        totalPaid,
        totalPending,
        totalRefunded,
        count: payments.length
      }
    };
  }

  /**
   * Returns current guest's complete payment history across all bookings from Firestore.
   */
  static async getMyPaymentsFirestore(userId) {
    if (!userId) return { success: true, payments: [], count: 0 };
    const targetId = String(userId);

    const paySnaps = await db.collection('payments').get();
    const userPayments = [];

    paySnaps.forEach(doc => {
      const p = doc.data();
      if (!p) return;
      const isOwner = String(p.guest_user_id) === targetId ||
                      String(p.user_id) === targetId ||
                      String(p.guest_id) === targetId ||
                      String(p.created_by) === targetId;

      if (isOwner) {
        userPayments.push({
          id: p.mysql_payment_id || doc.id,
          booking_id: p.mysql_booking_id || p.booking_id || 1,
          amount: Number(p.amount || 0),
          currency: p.currency || 'INR',
          payment_method: p.payment_method || 'Cash',
          payment_type: p.payment_type || 'Advance',
          payment_source: p.payment_source || 'Guest Portal',
          payment_status: p.payment_status || 'Paid',
          transaction_id: p.transaction_id || '',
          payment_date: p.payment_date || p.created_at || null,
          business_date: p.business_date || '',
          created_at: p.created_at || null,
          booking_number: p.booking_number || 'BK-1001',
          room_number: p.room_number || '101'
        });
      }
    });

    userPayments.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    return {
      success: true,
      payments: userPayments,
      count: userPayments.length
    };
  }

  /**
   * Returns payment status of guest's active Reserved booking in Firestore.
   */
  static async getGuestPaymentStatusFirestore(userId) {
    if (!userId) return { success: true, hasActivePayment: false };
    const targetId = String(userId);

    const bkgSnaps = await db.collection('bookings')
      .where('booking_status', '==', 'Reserved')
      .get();

    let matchingBkg = null;
    bkgSnaps.forEach(doc => {
      const b = doc.data();
      if (String(b.user_id) === targetId || String(b.guest_user_uid) === targetId || String(b.guest_id) === targetId) {
        matchingBkg = { id: doc.id, ...b };
      }
    });

    if (!matchingBkg) {
      return { success: true, hasActivePayment: false };
    }

    const paySnaps = await db.collection('payments')
      .where('booking_id', '==', matchingBkg.id)
      .get();

    let payDocs = [];
    paySnaps.forEach(doc => payDocs.push({ id: doc.id, ...doc.data() }));

    if (payDocs.length === 0) {
      const rawBkgId = String(matchingBkg.id).replace(/^booking_/, '');
      const paySnapsRaw = await db.collection('payments')
        .where('booking_id', '==', rawBkgId)
        .get();
      paySnapsRaw.forEach(doc => payDocs.push({ id: doc.id, ...doc.data() }));
    }

    if (payDocs.length === 0) {
      return { success: true, hasActivePayment: false };
    }

    payDocs.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const p = payDocs[0];

    return {
      success: true,
      hasActivePayment: true,
      paymentStatus: p.payment_status || 'Pending',
      paymentMethod: p.payment_method || 'Cash',
      amount: Number(p.amount || matchingBkg.advance_amount || 0),
      paymentConfirmed: p.payment_status === 'Paid',
      cashPendingConfirmation: p.payment_method === 'Cash' && p.payment_status === 'Pending',
      bookingId: matchingBkg.id,
      bookingNumber: matchingBkg.booking_number || 'BKG-101',
      remarks: p.remarks || ''
    };
  }
}

export default PaymentFirestoreAdapter;
