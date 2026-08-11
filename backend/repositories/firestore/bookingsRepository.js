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

const COLLECTION = 'bookings';

export async function getBookingByIdFirestore(bookingId, options = {}) {
  if (!bookingId) return null;
  const docId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getBookingByNumberFirestore(bookingNumber, options = {}) {
  if (!bookingNumber) return null;
  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'booking_number', op: '==', value: String(bookingNumber) }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllBookingsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 50, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createBookingFirestore(bookingData, options = {}) {
  validateRequiredFields(bookingData, ['booking_number', 'guest_id', 'room_id', 'check_in_date'], 'Booking');

  const docId = formatBookingId(bookingData.booking_number);

  const existing = await getDoc(COLLECTION, docId, options);
  if (existing) {
    throw new RepositoryError(`Booking with number '${bookingData.booking_number}' already exists`, 'DUPLICATE_KEY', 400);
  }

  const payload = {
    booking_number: String(bookingData.booking_number),
    guest_id: String(bookingData.guest_id || ''),
    mysql_guest_id: bookingData.mysql_guest_id || null,
    guest_user_uid: bookingData.guest_user_uid || null,
    guest_name: bookingData.guest_name || '',
    room_id: String(bookingData.room_id || ''),
    mysql_room_id: bookingData.mysql_room_id || null,
    room_number: bookingData.room_number || '',
    check_in_date: String(bookingData.check_in_date || ''),
    check_out_date: bookingData.check_out_date ? String(bookingData.check_out_date) : null,
    expected_check_out_date: bookingData.expected_check_out_date ? String(bookingData.expected_check_out_date) : String(bookingData.check_out_date || ''),
    adults: !isNaN(Number(bookingData.adults)) ? Number(bookingData.adults) : 1,
    children: !isNaN(Number(bookingData.children)) ? Number(bookingData.children) : 0,
    booking_status: bookingData.booking_status || 'Checked In',
    payment_status: bookingData.payment_status || 'Pending',
    total_amount: !isNaN(Number(bookingData.total_amount)) ? Number(bookingData.total_amount) : 0,
    advance_amount: !isNaN(Number(bookingData.advance_amount)) ? Number(bookingData.advance_amount) : 0,
    notes: bookingData.notes || '',
    billing_instruction: bookingData.billing_instruction || '',
    meal_plan: bookingData.meal_plan || 'EP',
    mysql_booking_id: bookingData.mysql_booking_id || bookingData.id || null,
    created_at: bookingData.created_at || new Date().toISOString(),
    updated_at: bookingData.updated_at || new Date().toISOString()
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

function isStaleUpdate(existingDoc, incomingData) {
  if (!existingDoc || !existingDoc.updated_at || !incomingData || !incomingData.updated_at) {
    return false;
  }
  const existingTime = new Date(existingDoc.updated_at).getTime();
  const incomingTime = new Date(incomingData.updated_at).getTime();
  return !isNaN(existingTime) && !isNaN(incomingTime) && existingTime > incomingTime;
}

export async function updateBookingFirestore(bookingId, bookingData, options = {}) {
  if (!bookingId) throw new RepositoryError('Booking ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);

  const existing = await getDoc(COLLECTION, docId, options);
  if (!existing) {
    const bookingNum = bookingData.booking_number || String(bookingId).replace(/^bkg_/, '');
    return await setDoc(COLLECTION, docId, {
      booking_number: String(bookingNum),
      guest_id: String(bookingData.guest_id || ''),
      room_id: String(bookingData.room_id || ''),
      check_in_date: String(bookingData.check_in_date || new Date().toISOString().split('T')[0]),
      ...bookingData,
      updated_at: bookingData.updated_at || new Date().toISOString()
    }, { ...options, merge: true });
  }

  if (isStaleUpdate(existing, bookingData)) {
    console.log(`[OutboxGuard] Ignored stale booking update for ${docId}`);
    return existing;
  }

  const payload = {
    updated_at: bookingData.updated_at || new Date().toISOString()
  };
  for (const [key, value] of Object.entries(bookingData)) {
    if (value !== undefined && !Number.isNaN(value)) {
      payload[key] = value;
    }
  }

  return await updateDoc(COLLECTION, docId, payload, options);
}

export async function updateBookingStatusFirestore(bookingId, bookingStatus, paymentStatus = null, options = {}) {
  const payload = {};
  if (bookingStatus) payload.booking_status = bookingStatus;
  if (paymentStatus) payload.payment_status = paymentStatus;
  if (options.updated_at) payload.updated_at = options.updated_at;
  return await updateBookingFirestore(bookingId, payload, options);
}

export async function deleteBookingFirestore(bookingId, options = {}) {
  if (!bookingId) throw new RepositoryError('Booking ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
  return await deleteDoc(COLLECTION, docId, options);
}
