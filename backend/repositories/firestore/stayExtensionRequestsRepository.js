import {
  getDoc,
  listDocs,
  setDoc,
  deleteDoc,
  formatBookingId,
  formatGuestId,
  formatRoomId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'stay_extension_requests';

export function formatExtensionRequestId(id) {
  if (!id) return null;
  const str = String(id).trim();
  if (str.startsWith('ext_') || str.startsWith('extension_')) return str;
  return `ext_${str}`;
}

export async function getStayExtensionRequestByIdFirestore(requestId, options = {}) {
  if (!requestId) return null;
  const docId = formatExtensionRequestId(requestId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getStayExtensionRequestsByBookingFirestore(bookingId, options = {}) {
  if (!bookingId) return [];
  const bkgDocId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
  const rawId = String(bookingId).replace(/^bkg_/, '');

  const byDocId = await listDocs(COLLECTION, {
    filters: [{ field: 'booking_id', op: '==', value: bkgDocId }],
    transaction: options.transaction
  });

  const byRawId = await listDocs(COLLECTION, {
    filters: [{ field: 'booking_id', op: '==', value: rawId }],
    transaction: options.transaction
  });

  let byMysqlId = [];
  if (!isNaN(Number(rawId))) {
    byMysqlId = await listDocs(COLLECTION, {
      filters: [{ field: 'mysql_booking_id', op: '==', value: Number(rawId) }],
      transaction: options.transaction
    });
  }

  const map = new Map();
  [...byDocId, ...byRawId, ...byMysqlId].forEach(item => {
    if (item && item.id) map.set(item.id, item);
  });

  return Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

export async function getStayExtensionRequestsByGuestFirestore(guestId, options = {}) {
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

export async function getAllStayExtensionRequestsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createStayExtensionRequestFirestore(data, options = {}) {
  validateRequiredFields(data, ['booking_id', 'current_checkout_date', 'requested_checkout_date'], 'StayExtensionRequest');

  const rawId = data.mysql_extension_id || data.id || data.request_id || Date.now();
  const docId = formatExtensionRequestId(rawId);

  const bkgId = data.booking_id ? (String(data.booking_id).startsWith('bkg_') ? String(data.booking_id) : formatBookingId(data.booking_id)) : null;
  const gstId = data.guest_id ? (String(data.guest_id).startsWith('guest_') ? String(data.guest_id) : formatGuestId(data.guest_id)) : null;
  const rawRoom = data.room_id || data.room_number;
  const roomDocId = rawRoom ? (String(rawRoom).startsWith('room_') ? String(rawRoom) : formatRoomId(rawRoom)) : null;

  const payload = {
    request_id: docId,
    booking_id: bkgId,
    mysql_booking_id: data.mysql_booking_id || (bkgId && !isNaN(Number(String(bkgId).replace(/^bkg_/, ''))) ? Number(String(bkgId).replace(/^bkg_/, '')) : null),
    guest_id: gstId,
    mysql_guest_id: data.mysql_guest_id || (gstId && !isNaN(Number(String(gstId).replace(/^guest_/, ''))) ? Number(String(gstId).replace(/^guest_/, '')) : null),
    room_id: roomDocId,
    room_number: data.room_number || (rawRoom ? String(rawRoom).replace(/^room_/, '') : null),
    current_checkout_date: String(data.current_checkout_date),
    requested_checkout_date: String(data.requested_checkout_date),
    status: data.status || 'Pending',
    admin_id: data.admin_id ? String(data.admin_id) : null,
    mysql_admin_id: data.mysql_admin_id || (data.admin_id && !isNaN(Number(data.admin_id)) ? Number(data.admin_id) : null),
    remarks: data.remarks ? String(data.remarks) : null,
    mysql_extension_id: data.mysql_extension_id || (data.id && !isNaN(Number(data.id)) ? Number(data.id) : null),
    created_at: data.created_at || new Date().toISOString(),
    updated_at: data.updated_at || new Date().toISOString()
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateStayExtensionRequestStatusFirestore(requestId, status, metadata = {}, options = {}) {
  if (!requestId) throw new RepositoryError('Request ID is required for status update', 'VALIDATION_ERROR', 400);
  const docId = formatExtensionRequestId(requestId);

  const payload = {
    status,
    ...metadata,
    updated_at: new Date().toISOString()
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function deleteStayExtensionRequestFirestore(requestId, options = {}) {
  if (!requestId) throw new RepositoryError('Request ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = formatExtensionRequestId(requestId);
  return await deleteDoc(COLLECTION, docId, options);
}
