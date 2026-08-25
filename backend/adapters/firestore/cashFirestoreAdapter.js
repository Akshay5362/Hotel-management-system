import { db } from '../../config/firebaseAdmin.js';

function parseToComparableDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr).substring(0, 10);
  return d.toISOString().split('T')[0];
}

function formatTime(date) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

export class CashFirestoreAdapter {
  /**
   * Generates sequential receipt ID in Firestore: CS-YYYYMMDD-NNNN
   */
  static async generateReceiptId(businessDate) {
    const compDate = parseToComparableDate(businessDate) || '2026-08-19';
    const datePart = compDate.replace(/-/g, '');

    const snap = await db.collection('cash_submissions')
      .where('business_date', 'in', [businessDate, compDate])
      .get();

    const seq = (snap.size + 1).toString().padStart(4, '0');
    return `CS-${datePart}-${seq}`;
  }

  /**
   * Calculates cash in hand from Firestore cash_logs and cash_submissions.
   */
  static async calculateCashInHand(businessDate, options = {}) {
    const { transaction = null } = options;
    const compDate = parseToComparableDate(businessDate) || businessDate;

    // 1. Query Cash Logs
    const logQuery = db.collection('cash_logs');
    const logSnap = transaction ? await transaction.get(logQuery) : await logQuery.get();

    let advances = 0, settlements = 0, refunds = 0;
    logSnap.forEach(doc => {
      const log = doc.data();
      if (!log) return;
      const logDate = parseToComparableDate(log.business_date) || log.business_date;
      if (logDate === compDate || logDate === businessDate) {
        const type = String(log.type || '').trim();
        const amt = Number(log.amount || 0);
        if (amt <= 0) return;

        if (
          type === 'Advance Deposit' ||
          type === 'Partial Payment' ||
          type === 'Full Settlement' ||
          type === 'IN'
        ) {
          advances += amt;
        } else if (
          type === 'Checkout Settlement' ||
          type === 'Settlement'
        ) {
          settlements += amt;
        } else if (
          type.toLowerCase().includes('refund') ||
          type.toUpperCase() === 'OUT' ||
          type.toLowerCase().includes('payout')
        ) {
          refunds += amt;
        }
      }
    });

    // 2. Query Cash Submissions
    const subQuery = db.collection('cash_submissions');
    const subSnap = transaction ? await transaction.get(subQuery) : await subQuery.get();

    let alreadySubmitted = 0;
    subSnap.forEach(doc => {
      const sub = doc.data();
      if (!sub) return;
      const subDate = parseToComparableDate(sub.business_date) || sub.business_date;
      if (subDate === compDate || subDate === businessDate) {
        alreadySubmitted += Number(sub.amount || 0);
      }
    });

    const cashInHand = advances + settlements - refunds - alreadySubmitted;
    return { advances, settlements, refunds, alreadySubmitted, cashInHand };
  }

  /**
   * Submits cash in Firestore atomically with idempotency and cash-in-hand validation.
   */
  static async submitCashFirestore(params) {
    const {
      amount,
      receivedBy = 'N/A',
      shift = 'General',
      name = 'Receptionist',
      notes = '',
      businessDate = '2026-08-19',
      idempotencyKey = null
    } = params;

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      const err = new Error('Invalid amount. Must be a positive number.');
      err.status = 400;
      throw err;
    }

    const parsedAmount = Math.round(Number(amount));
    const receptionistName = (name || '').trim() || 'Receptionist';
    const receiverName = (receivedBy || '').trim() || 'N/A';
    const shiftLabel = (shift || '').trim() || 'General';
    const combinedRemarks = [
      shiftLabel !== 'General' ? `Shift: ${shiftLabel}` : '',
      notes ? notes.trim() : ''
    ].filter(Boolean).join(' | ') || null;

    const receiptId = await this.generateReceiptId(businessDate);
    const submittedAt = new Date();
    const nowIso = submittedAt.toISOString();

    return await db.runTransaction(async (transaction) => {
      // 1. Idempotency Check
      if (idempotencyKey) {
        const idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
        const idemSnap = await transaction.get(idemRef);
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED' && idemSnap.data()?.result) {
          console.log(`[Idempotency] Returning cached submitCash result for key ${idempotencyKey}`);
          return idemSnap.data().result;
        }
      }

      // 2. Validate Cash in Hand
      const { cashInHand } = await this.calculateCashInHand(businessDate, { transaction });

      if (parsedAmount > cashInHand) {
        const err = new Error(`Cannot submit ₹${parsedAmount.toLocaleString('en-IN')}. Cash in hand is only ₹${cashInHand.toLocaleString('en-IN')}.`);
        err.status = 400;
        err.code = 'INSUFFICIENT_CASH_IN_HAND';
        throw err;
      }

      const remainingCash = cashInHand - parsedAmount;
      const subDocId = `cs_${receiptId}`;
      const subRef = db.collection('cash_submissions').doc(subDocId);

      const submissionPayload = {
        receipt_id: receiptId,
        business_date: businessDate,
        submitted_at: nowIso,
        receptionist_name: receptionistName,
        receiver_name: receiverName,
        shift: shiftLabel,
        amount: parsedAmount,
        remaining_cash: remainingCash,
        remarks: combinedRemarks,
        created_at: nowIso
      };

      transaction.set(subRef, submissionPayload, { merge: true });

      const result = {
        success: true,
        message: `₹${parsedAmount.toLocaleString('en-IN')} submitted successfully.`,
        submission: {
          id: subDocId,
          receipt_id: receiptId,
          business_date: businessDate,
          submitted_at: nowIso,
          receptionist_name: receptionistName,
          receiver_name: receiverName,
          shift: shiftLabel,
          amount: parsedAmount,
          remaining_cash: remainingCash,
          remarks: combinedRemarks,
          time: formatTime(submittedAt)
        }
      };

      // 3. Store Idempotency Record
      if (idempotencyKey) {
        const idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
        transaction.set(idemRef, {
          key: idempotencyKey,
          status: 'COMPLETED',
          domain: 'cash_submit',
          result,
          created_at: nowIso
        });
      }

      return result;
    });
  }

  /**
   * Retrieves cash submissions from Firestore.
   */
  static async getCashSubmissionsFirestore(businessDate) {
    const compDate = parseToComparableDate(businessDate) || businessDate;

    const snap = await db.collection('cash_submissions').get();
    const submissions = [];

    snap.forEach(doc => {
      const sub = doc.data();
      if (!sub) return;
      const subDate = parseToComparableDate(sub.business_date) || sub.business_date;
      if (subDate === compDate || subDate === businessDate) {
        submissions.push({ id: doc.id, ...sub });
      }
    });

    submissions.sort((a, b) => new Date(a.submitted_at || 0) - new Date(b.submitted_at || 0));

    return { submissions };
  }
}

export default CashFirestoreAdapter;
