import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  formatRoomId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'rooms';

export async function getRoomByIdFirestore(roomId, options = {}) {
  if (!roomId) return null;
  const docId = String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getRoomByNumberFirestore(roomNumber, options = {}) {
  if (!roomNumber) return null;
  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'number', op: '==', value: String(roomNumber) }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllRoomsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'number', direction: 'asc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

/**
 * Checks whether an incoming payload is stale compared to the existing Firestore document.
 */
function isStaleUpdate(existingDoc, incomingData) {
  if (!existingDoc || !existingDoc.updated_at || !incomingData || !incomingData.updated_at) {
    return false;
  }
  const existingTime = new Date(existingDoc.updated_at).getTime();
  const incomingTime = new Date(incomingData.updated_at).getTime();
  return !isNaN(existingTime) && !isNaN(incomingTime) && existingTime > incomingTime;
}

export async function createRoomFirestore(roomData, options = {}) {
  validateRequiredFields(roomData, ['number', 'type'], 'Room');
  const docId = formatRoomId(roomData.number);

  const existing = await getDoc(COLLECTION, docId, options);
  if (existing) {
    throw new RepositoryError(`Room with number '${roomData.number}' already exists`, 'DUPLICATE_KEY', 400);
  }

  const nowIso = roomData.updated_at || roomData.created_at || new Date().toISOString();

  const payload = {
    number: String(roomData.number),
    type: String(roomData.type),
    status: roomData.status || 'vacant',
    is_active: roomData.is_active !== undefined ? Boolean(roomData.is_active) : (roomData.is_active_val !== undefined ? Boolean(roomData.is_active_val) : true),
    cleaning_status: roomData.cleaning_status || roomData.housekeeping_status || 'Clean',
    housekeeping_status: roomData.housekeeping_status || roomData.cleaning_status || 'Clean',
    price: Number(roomData.price || roomData.base_rate || 0),
    room_type_id: roomData.room_type_id || roomData.mysql_room_type_id || null,
    mysql_room_id: roomData.mysql_room_id || roomData.id || null,
    amenities: Array.isArray(roomData.amenities) ? roomData.amenities : [],
    housekeeping_assigned_to: roomData.housekeeping_assigned_to || null,
    current_booking_id: roomData.current_booking_id || null,
    created_at: nowIso,
    updated_at: nowIso
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateRoomFirestore(roomId, roomData, options = {}) {
  if (!roomId) throw new RepositoryError('Room ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId);

  const existing = await getDoc(COLLECTION, docId, options);
  if (!existing) {
    // If doc doesn't exist yet, create room cleanly
    return await setDoc(COLLECTION, docId, {
      number: String(roomData.number || roomId),
      type: String(roomData.type || 'SUITE'),
      ...roomData,
      updated_at: roomData.updated_at || new Date().toISOString()
    }, { ...options, merge: true });
  }

  if (isStaleUpdate(existing, roomData)) {
    console.log(`[OutboxGuard] Ignored stale room update for ${docId}`);
    return existing;
  }

  const updatePayload = {
    ...roomData,
    updated_at: roomData.updated_at || new Date().toISOString()
  };

  return await updateDoc(COLLECTION, docId, updatePayload, options);
}

export async function updateRoomStatusFirestore(roomId, statusData, options = {}) {
  const docId = String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId);
  const payload = typeof statusData === 'string' ? { status: statusData } : { ...statusData };

  if (payload.housekeeping_status && !payload.cleaning_status) {
    payload.cleaning_status = payload.housekeeping_status;
  }

  payload.updated_at = payload.updated_at || new Date().toISOString();
  return await updateRoomFirestore(docId, payload, options);
}

export async function deleteRoomFirestore(roomId, options = {}) {
  if (!roomId) throw new RepositoryError('Room ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId);
  return await deleteDoc(COLLECTION, docId, options).catch(err => {
    if (err.code === 'NOT_FOUND') return null; // Idempotent delete
    throw err;
  });
}
