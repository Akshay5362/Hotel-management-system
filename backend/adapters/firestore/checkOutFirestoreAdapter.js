import { db } from '../../config/firebaseAdmin.js';
import { formatTime } from '../../utils/dateUtils.js';

/**
 * Atomic Firestore Transaction Adapter for Checkout.
 * Coordinates booking status update, room status transition to dirty/vacant,
 * invoice generation, payment logs, and snapshot creation.
 */
export const processCheckOutFirestoreTransaction = async ({
  number,
  parsedBalancePaid = 0,
  resolvedUserId = 'admin',
  businessDate = '2026-08-17'
}) => {
  if (!db) {
    throw new Error('Firebase Admin DB is not initialized.');
  }

  const roomDocId = `room_${number}`;

  return await db.runTransaction(async (transaction) => {
    // 1. READ ROOM DOCUMENT (Inside Transaction)
    const roomRef = db.collection('rooms').doc(roomDocId);
    const roomSnap = await transaction.get(roomRef);

    if (!roomSnap.exists) {
      throw { status: 404, message: `Room ${number} not found` };
    }

    const roomData = roomSnap.data();

    // Verify room is occupied
    if (roomData.status !== 'occupied') {
      throw { status: 400, message: `Room ${number} is not occupied` };
    }

    // 2. READ ACTIVE BOOKING FOR THIS ROOM
    // Find active booking with booking_status == 'Checked In'
    const bookingsSnap = await db.collection('bookings')
      .where('room_id', '==', roomRef.id)
      .where('booking_status', '==', 'Checked In')
      .limit(1)
      .get();

    let activeBookingDocId = roomData.current_booking_id;
    let activeBookingData = null;

    if (!bookingsSnap.empty) {
      activeBookingDocId = bookingsSnap.docs[0].id;
      activeBookingData = bookingsSnap.docs[0].data();
    } else if (activeBookingDocId) {
      const bSnap = await transaction.get(db.collection('bookings').doc(activeBookingDocId));
      if (bSnap.exists) activeBookingData = bSnap.data();
    }

    if (!activeBookingData) {
      throw { status: 404, message: `No active Checked In booking found for Room ${number}` };
    }

    const bookingRef = db.collection('bookings').doc(activeBookingDocId);
    const nowIso = new Date().toISOString();

    const advanceAmount = Number(activeBookingData.advance_amount || 0);
    const totalCollected = advanceAmount + Number(parsedBalancePaid);

    // 3. UPDATE BOOKING DOCUMENT
    transaction.set(bookingRef, {
      booking_status: 'Checked Out',
      payment_status: 'Paid',
      total_amount: totalCollected,
      check_out_date: businessDate,
      updated_at: nowIso
    }, { merge: true });

    // 4. CREATE INVOICE DOCUMENT
    const invoiceNumber = `INV-${businessDate.replace(/-/g, '')}-${activeBookingDocId.replace('booking_', '').slice(-4)}`;
    const invoiceRef = db.collection('invoices').doc(`invoice_${invoiceNumber}`);
    transaction.set(invoiceRef, {
      invoice_number: invoiceNumber,
      booking_id: bookingRef.id,
      total_amount: totalCollected,
      paid_amount: totalCollected,
      balance_due: 0,
      status: 'Paid',
      invoice_status: 'Paid',
      business_date: businessDate,
      created_at: nowIso,
      updated_at: nowIso
    }, { merge: true });

    // 5. LOG SETTLEMENT PAYMENT & CASH LOG
    if (parsedBalancePaid !== 0) {
      const paymentRef = db.collection('payments').doc(`payment_${activeBookingDocId}_checkout`);
      const transactionType = parsedBalancePaid > 0 ? 'Checkout Settlement' : 'Checkout Refund';
      
      transaction.set(paymentRef, {
        booking_id: bookingRef.id,
        amount: Math.abs(parsedBalancePaid),
        payment_method: 'Cash',
        payment_status: 'Completed',
        payment_type: transactionType,
        business_date: businessDate,
        created_at: nowIso
      });

      const cashLogRef = db.collection('cash_logs').doc(`cash_${activeBookingDocId}_checkout`);
      transaction.set(cashLogRef, {
        time: formatTime(new Date()),
        room: String(number),
        guest: activeBookingData.guest_name || 'GUEST',
        type: transactionType,
        amount: Math.abs(parsedBalancePaid),
        business_date: businessDate,
        booking_id: bookingRef.id,
        created_at: nowIso
      });
    }

    // 6. UPDATE ROOM STATUS TO DIRTY & VACANT
    transaction.set(roomRef, {
      status: 'dirty',
      housekeeping_status: 'Dirty',
      housekeeping_priority: 'High Priority',
      current_booking_id: null,
      updated_at: nowIso
    }, { merge: true });

    // 7. CREATE CHECKOUT SNAPSHOT DOCUMENT
    const snapshotRef = db.collection('checkout_snapshots').doc(`snap_${bookingRef.id}`);
    transaction.set(snapshotRef, {
      snapshot_id: snapshotRef.id,
      booking_id: bookingRef.id,
      room_number: String(number),
      total_collected: totalCollected,
      business_date: businessDate,
      created_at: nowIso
    });

    return {
      success: true,
      bookingId: bookingRef.id,
      roomNumber: number,
      totalCollected
    };
  });
};
