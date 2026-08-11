import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  formatBookingId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'payments';
const PARENT_COLLECTION = 'bookings';

export async function getPaymentByIdFirestore(paymentId, options = {}) {
  if (!paymentId) return null;
  const docId = String(paymentId).startsWith('payment_') || String(paymentId).startsWith('pay_')
    ? String(paymentId)
    : `payment_${paymentId}`;

  // First check root collection
  const rootDoc = await getDoc(COLLECTION, docId, options);
  if (rootDoc) return rootDoc;

  // Fallback to subcollection if bookingId provided
  const { bookingId } = options;
  if (bookingId) {
    const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
    return await getDoc(PARENT_COLLECTION, parentId, {
      ...options,
      subcollectionName: COLLECTION,
      subDocId: docId
    });
  }

  return null;
}

export async function getPaymentsByBookingFirestore(bookingId, options = {}) {
  if (!bookingId) return [];
  const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
  const rawId = String(bookingId).replace(/^bkg_/, '');

  // 1. Query root collection by booking_id or mysql_booking_id
  const rootByDocId = await listDocs(COLLECTION, {
    filters: [{ field: 'booking_id', op: '==', value: parentId }],
    transaction: options.transaction
  });

  const rootByRawId = await listDocs(COLLECTION, {
    filters: [{ field: 'booking_id', op: '==', value: rawId }],
    transaction: options.transaction
  });

  const rootByMysqlId = !isNaN(Number(rawId))
    ? await listDocs(COLLECTION, {
        filters: [{ field: 'mysql_booking_id', op: '==', value: Number(rawId) }],
        transaction: options.transaction
      })
    : [];

  // 2. Query subcollection
  const subDocs = await listDocs(PARENT_COLLECTION, {
    parentDocId: parentId,
    subcollectionName: COLLECTION,
    transaction: options.transaction
  });

  // Deduplicate results by document ID
  const map = new Map();
  [...rootByDocId, ...rootByRawId, ...rootByMysqlId, ...subDocs].forEach(item => {
    if (item && item.id) map.set(item.id, item);
  });

  return Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

export async function getAllPaymentsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 50, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createPaymentFirestore(paymentData, options = {}) {
  validateRequiredFields(paymentData, ['amount', 'payment_method'], 'Payment');

  const paymentId = paymentData.payment_id || `payment_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const bookingId = paymentData.booking_id;
  const parentId = bookingId ? (String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId)) : null;

  const payload = {
    payment_id: paymentId,
    booking_id: parentId,
    mysql_booking_id: paymentData.mysql_booking_id || (bookingId && !isNaN(Number(bookingId)) ? Number(bookingId) : null),
    guest_id: paymentData.guest_id ? String(paymentData.guest_id) : null,
    mysql_guest_id: paymentData.mysql_guest_id || null,
    amount: Number(paymentData.amount),
    currency: paymentData.currency || 'INR',
    payment_method: String(paymentData.payment_method),
    payment_status: paymentData.payment_status || 'Completed',
    payment_type: paymentData.payment_type || 'Room Charge',
    payment_source: paymentData.payment_source || 'front_desk',
    payment_gateway: paymentData.payment_gateway || 'Internal',
    transaction_id: paymentData.transaction_id || null,
    business_date: paymentData.business_date || new Date().toISOString().split('T')[0],
    mysql_payment_id: paymentData.mysql_payment_id || paymentData.id || null,
    created_at: paymentData.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // Write to root collection
  await setDoc(COLLECTION, paymentId, payload, { ...options, merge: true });

  // Dual-write to subcollection if parent booking exists
  if (parentId) {
    await setDoc(PARENT_COLLECTION, parentId, payload, {
      ...options,
      subcollectionName: COLLECTION,
      subDocId: paymentId,
      merge: true
    });
  }

  return { id: paymentId, ...payload };
}

export async function updatePaymentFirestore(paymentId, paymentData, options = {}) {
  if (!paymentId) throw new RepositoryError('Payment ID is required for update', 'VALIDATION_ERROR', 400);

  const docId = String(paymentId).startsWith('payment_') || String(paymentId).startsWith('pay_')
    ? String(paymentId)
    : `payment_${paymentId}`;

  const { bookingId } = options;
  if (bookingId) {
    const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
    await updateDoc(PARENT_COLLECTION, parentId, paymentData, {
      ...options,
      subcollectionName: COLLECTION,
      subDocId: docId
    });
  }

  return await updateDoc(COLLECTION, docId, paymentData, options);
}

export async function deletePaymentFirestore(paymentId, options = {}) {
  if (!paymentId) throw new RepositoryError('Payment ID is required for deletion', 'VALIDATION_ERROR', 400);

  const docId = String(paymentId).startsWith('payment_') || String(paymentId).startsWith('pay_')
    ? String(paymentId)
    : `payment_${paymentId}`;

  const { bookingId } = options;
  if (bookingId) {
    const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
    await deleteDoc(PARENT_COLLECTION, parentId, {
      ...options,
      subcollectionName: COLLECTION,
      subDocId: docId
    });
  }

  return await deleteDoc(COLLECTION, docId, options);
}
