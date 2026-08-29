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
  const strId = String(bookingId).trim();

  // 1. Direct document lookup (handles 'booking_BKG-859876', 'bkg_101', exact doc ID)
  const directDoc = await getDoc(COLLECTION, strId, options);
  if (directDoc) return directDoc;

  // 2. Try variations of prefixes
  const candidates = [
    strId.startsWith('booking_') ? strId : `booking_${strId}`,
    strId.startsWith('bkg_') ? strId : `bkg_${strId}`,
    formatBookingId(strId)
  ];

  for (const candidateId of candidates) {
    const doc = await getDoc(COLLECTION, candidateId, options);
    if (doc) return doc;
  }

  // 3. Query by booking_number field
  const byNumber = await getBookingByNumberFirestore(strId, options);
  if (byNumber) return byNumber;

  // 4. If query looks like a room number or room ID, resolve room's active or most recent booking
  const cleanRoomNum = strId.replace(/^room_/, '');
  const roomDoc = await getDoc('rooms', `room_${cleanRoomNum}`, options);
  if (roomDoc && roomDoc.current_booking_id) {
    const activeBkg = await getDoc(COLLECTION, roomDoc.current_booking_id, options);
    if (activeBkg) return activeBkg;
  }

  // Fallback: search most recent booking associated with this room number (sorted in-memory to avoid index dependency)
  const roomBookingsByNum = await listDocs(COLLECTION, {
    filters: [{ field: 'room_number', op: '==', value: cleanRoomNum }],
    transaction: options.transaction
  });
  const roomBookingsById = await listDocs(COLLECTION, {
    filters: [{ field: 'room_id', op: '==', value: `room_${cleanRoomNum}` }],
    transaction: options.transaction
  });
  const combined = [...roomBookingsByNum, ...roomBookingsById].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  if (combined.length > 0) {
    return combined[0];
  }

  return null;
}

export async function getBookingByNumberFirestore(bookingNumber, options = {}) {
  if (!bookingNumber) return null;
  const numStr = String(bookingNumber).trim();
  const candidates = [
    numStr,
    numStr.startsWith('BKG-') ? numStr : `BKG-${numStr}`,
    numStr.replace(/^(booking_|bkg_)/, '')
  ];

  for (const c of candidates) {
    const results = await listDocs(COLLECTION, {
      filters: [{ field: 'booking_number', op: '==', value: c }],
      limit: 1,
      transaction: options.transaction
    });
    if (results && results.length > 0) return results[0];
  }

  return null;
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

export async function getBookingsByGuestFirestore(guestId, options = {}) {
  if (!guestId) return [];
  const gStr = String(guestId).trim();
  const rawId = gStr.replace(/^guest_/, '');
  const candidates = Array.from(new Set([
    gStr,
    `guest_${rawId}`,
    rawId
  ])).slice(0, 10);

  const map = new Map();

  const byGuestId = await listDocs(COLLECTION, {
    filters: [{ field: 'guest_id', op: 'in', value: candidates }],
    transaction: options.transaction
  });
  byGuestId.forEach(item => { if (item && item.id) map.set(item.id, item); });

  const numIds = candidates.map(Number).filter(n => !isNaN(n));
  if (numIds.length > 0) {
    const byMysqlGuestId = await listDocs(COLLECTION, {
      filters: [{ field: 'mysql_guest_id', op: 'in', value: numIds.slice(0, 10) }],
      transaction: options.transaction
    });
    byMysqlGuestId.forEach(item => { if (item && item.id) map.set(item.id, item); });
  }

  return Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
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
    // ── New fields (Phase D) ────────────────────────────────────────────────
    room_tariff:       bookingData.room_tariff !== undefined ? Number(bookingData.room_tariff) || null : null,
    payment_mode:      bookingData.payment_mode      || null,
    purpose_of_visit:  bookingData.purpose_of_visit  || null,
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
