import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'razorpay_transactions';

export async function getRazorpayTransactionByOrderIdFirestore(orderId, options = {}) {
  if (!orderId) return null;
  const docId = `rzp_${String(orderId).trim()}`;
  return await getDoc(COLLECTION, docId, options);
}

export async function createRazorpayTransactionFirestore(txData, options = {}) {
  validateRequiredFields(txData, ['order_id', 'amount'], 'RazorpayTransaction');

  const docId = `rzp_${String(txData.order_id).trim()}`;

  const payload = {
    order_id: String(txData.order_id).trim(),
    booking_id: txData.booking_id ? String(txData.booking_id) : null,
    amount: Number(txData.amount),
    currency: txData.currency || 'INR',
    status: txData.status || 'created',
    payment_id: txData.payment_id || null,
    signature: txData.signature || null,
    mysql_transaction_id: txData.mysql_transaction_id || txData.id || null,
    created_at: new Date().toISOString()
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateRazorpayTransactionFirestore(orderId, txData, options = {}) {
  if (!orderId) throw new RepositoryError('Order ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = `rzp_${String(orderId).trim()}`;
  return await updateDoc(COLLECTION, docId, txData, options);
}
