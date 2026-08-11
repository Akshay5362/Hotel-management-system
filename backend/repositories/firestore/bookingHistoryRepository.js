import {
  getDoc,
  listDocs,
  setDoc,
  formatBookingId,
  validateRequiredFields
} from './firestoreUtils.js';

const COLLECTION = 'booking_history';
const PARENT_COLLECTION = 'bookings';

export async function getBookingHistoryByIdFirestore(historyId, options = {}) {
  if (!historyId) return null;
  const docId = String(historyId).startsWith('history_') || String(historyId).startsWith('hist_')
    ? String(historyId)
    : `history_${historyId}`;

  const rootDoc = await getDoc(COLLECTION, docId, options);
  if (rootDoc) return rootDoc;

  const { bookingId } = options;
  if (bookingId) {
    const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
    return await getDoc(PARENT_COLLECTION, parentId, {
      ...options,
      subcollectionName: 'history',
      subDocId: docId
    });
  }

  return null;
}

export async function getBookingHistoryByBookingFirestore(bookingId, options = {}) {
  if (!bookingId) return [];
  const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
  const rawId = String(bookingId).replace(/^bkg_/, '');

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

  const subDocs = await listDocs(PARENT_COLLECTION, {
    parentDocId: parentId,
    subcollectionName: 'history',
    transaction: options.transaction
  });

  const map = new Map();
  [...rootByDocId, ...rootByRawId, ...rootByMysqlId, ...subDocs].forEach(item => {
    if (item && item.id) map.set(item.id, item);
  });

  return Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

export async function getAllBookingHistoryFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createBookingHistoryFirestore(historyData, options = {}) {
  validateRequiredFields(historyData, ['action', 'details'], 'BookingHistory');

  const historyId = historyData.history_id || `history_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const bookingId = historyData.booking_id;
  const parentId = bookingId ? (String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId)) : null;

  const payload = {
    history_id: historyId,
    booking_id: parentId,
    mysql_booking_id: historyData.mysql_booking_id || (bookingId && !isNaN(Number(bookingId)) ? Number(bookingId) : null),
    action: String(historyData.action),
    details: String(historyData.details),
    changed_by: historyData.changed_by ? String(historyData.changed_by) : null,
    mysql_changed_by: historyData.mysql_changed_by || null,
    business_date: historyData.business_date || new Date().toISOString().split('T')[0],
    mysql_history_id: historyData.mysql_history_id || historyData.id || null,
    created_at: historyData.created_at || new Date().toISOString()
  };

  await setDoc(COLLECTION, historyId, payload, { ...options, merge: true });

  if (parentId) {
    await setDoc(PARENT_COLLECTION, parentId, payload, {
      ...options,
      subcollectionName: 'history',
      subDocId: historyId,
      merge: true
    });
  }

  return { id: historyId, ...payload };
}
