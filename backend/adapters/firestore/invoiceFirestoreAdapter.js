import { db } from '../../config/firebaseAdmin.js';
import { formatBookingId, formatInvoiceId } from '../../repositories/firestore/firestoreUtils.js';

/**
 * Invoice Firestore Adapter
 * Handles atomic creation, retrieval, numbering and status updates for invoices.
 */
export class InvoiceFirestoreAdapter {
  /**
   * Generates or retrieves an invoice for a booking within an atomic Firestore transaction.
   */
  static async getOrGenerateInvoiceFirestore({ bookingId, businessDate = new Date().toISOString().split('T')[0], idempotencyKey = null }) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');

    const parsedId = parseInt(bookingId, 10);
    const nowIso = new Date().toISOString();
    const strBookingId = String(bookingId);

    // Determine normalized booking document ID
    const primaryDocId = strBookingId.startsWith('booking_') || strBookingId.startsWith('bkg_')
      ? strBookingId
      : `booking_${strBookingId}`;

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

      // 1. READ BOOKING DOCUMENT
      const bkgRef = db.collection('bookings').doc(primaryDocId);
      const bkgSnap = await transaction.get(bkgRef);
      const bkgData = bkgSnap.exists ? bkgSnap.data() : null;

      // 2. CHECK FOR EXISTING INVOICE FOR THIS BOOKING
      let existingInvoice = null;
      let existingInvoiceRef = null;

      if (bkgData?.invoice_number) {
        const invRef = db.collection('invoices').doc(`invoice_${bkgData.invoice_number}`);
        const invSnap = await transaction.get(invRef);
        if (invSnap.exists) {
          existingInvoice = invSnap.data();
          existingInvoiceRef = invRef;
        }
      }

      if (existingInvoice && existingInvoiceRef) {
        // If already Paid, return as-is
        if (existingInvoice.status === 'Paid') {
          const res = { invoiceNumber: existingInvoice.invoice_number, status: 'Paid' };
          if (idempotencyKey) {
            transaction.set(db.collection('idempotency_keys').doc(String(idempotencyKey)), {
              status: 'COMPLETED',
              result: res,
              created_at: nowIso
            });
          }
          return res;
        }

        // Draft/Issued exists — recalculate totals from booking
        const isPaid = bkgData?.payment_status === 'Paid';
        const finalTotal = Number(bkgData?.total_amount || existingInvoice.total_amount || 0);
        const finalPaid = isPaid ? finalTotal : Number(bkgData?.advance_amount || existingInvoice.paid_amount || 0);
        const finalBalance = isPaid ? 0 : Math.max(0, finalTotal - finalPaid);
        const finalStatus = isPaid ? 'Paid' : 'Draft';

        transaction.set(existingInvoiceRef, {
          total_amount: finalTotal,
          paid_amount: finalPaid,
          balance_due: finalBalance,
          outstanding_amount: finalBalance,
          status: finalStatus,
          invoice_status: finalStatus,
          updated_at: nowIso
        }, { merge: true });

        const res = { invoiceNumber: existingInvoice.invoice_number, status: finalStatus };
        if (idempotencyKey) {
          transaction.set(db.collection('idempotency_keys').doc(String(idempotencyKey)), {
            status: 'COMPLETED',
            result: res,
            created_at: nowIso
          });
        }
        return res;
      }

      // 3. GENERATE SEQUENTIAL INVOICE NUMBER
      // Format: INV-YYYY-NNNNNN
      const year = new Date().getFullYear();
      const seqTimestamp = (Date.now() % 900000) + 100000;
      const invoiceNumber = `INV-${year}-${String(seqTimestamp).padStart(6, '0')}`;
      const newInvoiceRef = db.collection('invoices').doc(`invoice_${invoiceNumber}`);

      // Calculate totals from booking if available
      const isPaid = bkgData?.payment_status === 'Paid';
      const totalAmount = Number(bkgData?.total_amount || 0);
      const paidAmount = isPaid ? totalAmount : Number(bkgData?.advance_amount || 0);
      const balanceDue = isPaid ? 0 : Math.max(0, totalAmount - paidAmount);
      const status = isPaid ? 'Paid' : 'Draft';

      transaction.set(newInvoiceRef, {
        invoice_number: invoiceNumber,
        booking_id: primaryDocId,
        mysql_booking_id: isNaN(parsedId) ? null : parsedId,
        booking_number: bkgData?.booking_number || primaryDocId,
        guest_name: bkgData?.guest_name || 'GUEST',
        room_number: bkgData?.room_number || null,
        total_amount: totalAmount,
        paid_amount: paidAmount,
        balance_due: balanceDue,
        outstanding_amount: balanceDue,
        status: status,
        invoice_status: status,
        business_date: businessDate,
        created_at: nowIso,
        updated_at: nowIso
      });

      // Also record invoice_number on the booking document if booking exists
      if (bkgSnap.exists) {
        transaction.set(bkgRef, {
          invoice_number: invoiceNumber,
          updated_at: nowIso
        }, { merge: true });
      }

      const result = { invoiceNumber, status };

      if (idempotencyKey) {
        transaction.set(db.collection('idempotency_keys').doc(String(idempotencyKey)), {
          idempotency_key: String(idempotencyKey),
          status: 'COMPLETED',
          result,
          created_at: nowIso
        });
      }

      return result;
    });
  }

  /**
   * Retrieves an invoice by its invoice number.
   */
  static async getInvoiceByNumberFirestore(invoiceNumber) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');
    const snap = await db.collection('invoices').doc(`invoice_${invoiceNumber}`).get();
    if (!snap.exists) {
      const altSnap = await db.collection('invoices').doc(String(invoiceNumber)).get();
      return altSnap.exists ? { id: altSnap.id, ...altSnap.data() } : null;
    }
    return { id: snap.id, ...snap.data() };
  }

  /**
   * Updates invoice status and balances in Firestore.
   */
  static async updateInvoiceFirestore(invoiceNumber, updateData) {
    if (!db) throw new Error('Firebase Admin DB is not initialized.');
    const docId = invoiceNumber.startsWith('invoice_') ? invoiceNumber : `invoice_${invoiceNumber}`;
    const nowIso = new Date().toISOString();
    await db.collection('invoices').doc(docId).set({
      ...updateData,
      updated_at: nowIso
    }, { merge: true });
    return { success: true, invoiceNumber };
  }
}

export default InvoiceFirestoreAdapter;
