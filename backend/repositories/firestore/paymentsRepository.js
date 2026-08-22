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
  const strId = String(bookingId).trim();
  const rawId = strId.replace(/^(booking_|bkg_)/, '');
  const bookingNumber = rawId.startsWith('BKG-') ? rawId : `BKG-${rawId}`;

  const queryIds = Array.from(new Set([
    strId,
    rawId,
    `booking_${rawId}`,
    `bkg_${rawId}`,
    `booking_${bookingNumber}`,
    `bkg_${bookingNumber}`,
    bookingNumber,
    formatBookingId(strId)
  ])).slice(0, 10);

  const map = new Map();

  const [byBookingId, byBookingNumber] = await Promise.all([
    listDocs(COLLECTION, {
      filters: [{ field: 'booking_id', op: 'in', value: queryIds }],
      transaction: options.transaction
    }),
    listDocs(COLLECTION, {
      filters: [{ field: 'booking_number', op: 'in', value: queryIds }],
      transaction: options.transaction
    })
  ]);

  byBookingId.forEach(item => { if (item && item.id) map.set(item.id, item); });
  byBookingNumber.forEach(item => { if (item && item.id) map.set(item.id, item); });

  const numIds = queryIds.map(Number).filter(n => !isNaN(n));
  if (numIds.length > 0) {
    const byMysql = await listDocs(COLLECTION, {
      filters: [{ field: 'mysql_booking_id', op: 'in', value: numIds.slice(0, 10) }],
      transaction: options.transaction
    });
    byMysql.forEach(item => { if (item && item.id) map.set(item.id, item); });
  }

  // Deduplicate and sort chronologically
  return Array.from(map.values()).sort((a, b) => new Date(a.created_at || 0) - new Date(a.created_at || 0));
}

export async function getPaymentsByGuestFirestore(userId, options = {}) {
  if (!userId || isNaN(Number(userId))) return [];
  const targetId = Number(userId);

  // Defense in depth: Query root collection and filter strictly by guest ownership
  const allDocs = await listDocs(COLLECTION, {
    transaction: options.transaction
  });

  return allDocs.filter(p => {
    if (!p) return false;
    if (p.guest_user_id === targetId || p.user_id === targetId) return true;
    if (p.guest_id === null || p.guest_id === undefined || p.guest_id === '') return false;
    const gNum = Number(p.guest_id);
    return !isNaN(gNum) && gNum === targetId;
  }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
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
