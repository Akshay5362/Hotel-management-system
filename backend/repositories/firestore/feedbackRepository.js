import {
  getDoc,
  listDocs,
  setDoc,
  deleteDoc,
  formatBookingId,
  formatGuestId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'feedback';

export function formatFeedbackId(id) {
  if (!id) return null;
  const str = String(id).trim();
  if (str.startsWith('fb_') || str.startsWith('feedback_')) return str;
  return `fb_${str}`;
}

export async function getFeedbackByIdFirestore(feedbackId, options = {}) {
  if (!feedbackId) return null;
  const docId = formatFeedbackId(feedbackId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getFeedbackByBookingFirestore(bookingId, options = {}) {
  if (!bookingId) return null;
  const bkgDocId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
  const rawId = String(bookingId).replace(/^bkg_/, '');

  const byDocId = await listDocs(COLLECTION, {
    filters: [{ field: 'booking_id', op: '==', value: bkgDocId }],
    transaction: options.transaction
  });
  if (byDocId.length > 0) return byDocId[0];

  const byRawId = await listDocs(COLLECTION, {
    filters: [{ field: 'booking_id', op: '==', value: rawId }],
    transaction: options.transaction
  });
  if (byRawId.length > 0) return byRawId[0];

  if (!isNaN(Number(rawId))) {
    const byMysqlId = await listDocs(COLLECTION, {
      filters: [{ field: 'mysql_booking_id', op: '==', value: Number(rawId) }],
      transaction: options.transaction
    });
    if (byMysqlId.length > 0) return byMysqlId[0];
  }

  return null;
}

export async function getFeedbackByGuestFirestore(guestId, options = {}) {
  if (!guestId) return [];
  const guestDocId = String(guestId).startsWith('guest_') ? String(guestId) : formatGuestId(guestId);
  const rawId = String(guestId).replace(/^guest_/, '');

  const byDocId = await listDocs(COLLECTION, {
    filters: [{ field: 'guest_id', op: '==', value: guestDocId }],
    transaction: options.transaction
  });

  const byRawId = await listDocs(COLLECTION, {
    filters: [{ field: 'guest_id', op: '==', value: rawId }],
    transaction: options.transaction
  });

  let byMysqlId = [];
  if (!isNaN(Number(rawId))) {
    byMysqlId = await listDocs(COLLECTION, {
      filters: [{ field: 'mysql_guest_id', op: '==', value: Number(rawId) }],
      transaction: options.transaction
    });
  }

  const map = new Map();
  [...byDocId, ...byRawId, ...byMysqlId].forEach(item => {
    if (item && item.id) map.set(item.id, item);
  });

  return Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

export async function getAllFeedbackFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createFeedbackFirestore(data, options = {}) {
  validateRequiredFields(data, ['booking_id', 'guest_id', 'overall_rating'], 'Feedback');

  const rawId = data.mysql_feedback_id || data.id || data.feedback_id || Date.now();
  const docId = formatFeedbackId(rawId);

  const bkgId = data.booking_id ? (String(data.booking_id).startsWith('bkg_') ? String(data.booking_id) : formatBookingId(data.booking_id)) : null;
  const gstId = data.guest_id ? (String(data.guest_id).startsWith('guest_') ? String(data.guest_id) : formatGuestId(data.guest_id)) : null;

  const wouldRecBool = data.would_recommend === undefined || data.would_recommend === null || data.would_recommend === true || data.would_recommend === 1 || data.would_recommend === '1';

  const payload = {
    feedback_id: docId,
    booking_id: bkgId,
    mysql_booking_id: data.mysql_booking_id || (bkgId && !isNaN(Number(String(bkgId).replace(/^bkg_/, ''))) ? Number(String(bkgId).replace(/^bkg_/, '')) : null),
    guest_id: gstId,
    mysql_guest_id: data.mysql_guest_id || (gstId && !isNaN(Number(String(gstId).replace(/^guest_/, ''))) ? Number(String(gstId).replace(/^guest_/, '')) : null),
    overall_rating: Number(data.overall_rating),
    room_cleanliness: data.room_cleanliness !== undefined && data.room_cleanliness !== null ? Number(data.room_cleanliness) : null,
    service_quality: data.service_quality !== undefined && data.service_quality !== null ? Number(data.service_quality) : null,
    value_for_money: data.value_for_money !== undefined && data.value_for_money !== null ? Number(data.value_for_money) : null,
    comments: data.comments ? String(data.comments) : null,
    would_recommend: wouldRecBool,
    mysql_feedback_id: data.mysql_feedback_id || (data.id && !isNaN(Number(data.id)) ? Number(data.id) : null),
    created_at: data.created_at || new Date().toISOString()
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateFeedbackFirestore(feedbackId, updateData, options = {}) {
  if (!feedbackId) throw new RepositoryError('Feedback ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = formatFeedbackId(feedbackId);
  return await setDoc(COLLECTION, docId, updateData, { ...options, merge: true });
}

export async function deleteFeedbackFirestore(feedbackId, options = {}) {
  if (!feedbackId) throw new RepositoryError('Feedback ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = formatFeedbackId(feedbackId);
  return await deleteDoc(COLLECTION, docId, options);
}
