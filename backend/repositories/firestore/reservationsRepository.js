import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  formatReservationId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'reservations';

export async function getReservationByIdFirestore(resId, options = {}) {
  if (!resId) return null;
  const docId = String(resId).startsWith('res_') ? String(resId) : formatReservationId(resId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getReservationByNumberFirestore(resNumber, options = {}) {
  if (!resNumber) return null;
  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'reservation_number', op: '==', value: String(resNumber) }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllReservationsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'check_in_date', direction: 'asc' }], limit = 50, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createReservationFirestore(resData, options = {}) {
  validateRequiredFields(resData, ['reservation_number', 'guest_name', 'room_id', 'check_in_date', 'check_out_date'], 'Reservation');
  const docId = formatReservationId(resData.reservation_number);

  const existing = await getDoc(COLLECTION, docId, options);
  if (existing) {
    throw new RepositoryError(`Reservation '${resData.reservation_number}' already exists`, 'DUPLICATE_KEY', 400);
  }

  const payload = {
    reservation_number: String(resData.reservation_number),
    guest_name: String(resData.guest_name),
    email: resData.email || null,
    phone: resData.phone || null,
    date_of_birth: resData.date_of_birth || resData.dob || null,
    room_id: String(resData.room_id),
    mysql_room_id: resData.mysql_room_id || null,
    booking_id: resData.booking_id || null,
    mysql_booking_id: resData.mysql_booking_id || null,
    check_in_date: String(resData.check_in_date),
    check_out_date: String(resData.check_out_date),
    status: resData.status || 'Confirmed',
    notes: resData.notes || '',
    mysql_reservation_id: resData.mysql_reservation_id || resData.id || null,
    created_at: new Date().toISOString()
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateReservationFirestore(resId, resData, options = {}) {
  if (!resId) throw new RepositoryError('Reservation ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(resId).startsWith('res_') ? String(resId) : formatReservationId(resId);

  const existing = await getDoc(COLLECTION, docId, options);
  if (!existing) {
    throw new RepositoryError(`Reservation '${resId}' not found`, 'NOT_FOUND', 404);
  }

  return await updateDoc(COLLECTION, docId, resData, options);
}

export async function deleteReservationFirestore(resId, options = {}) {
  if (!resId) throw new RepositoryError('Reservation ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(resId).startsWith('res_') ? String(resId) : formatReservationId(resId);
  return await deleteDoc(COLLECTION, docId, options);
}
