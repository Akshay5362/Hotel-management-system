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

const COLLECTION = 'housekeeping';

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

export async function getHousekeepingByIdFirestore(id, options = {}) {
  if (!id) return null;
  const docId = String(id).startsWith('hk_') ? String(id) : `hk_${id}`;
  return await getDoc(COLLECTION, docId, options);
}

export async function getHousekeepingByRoomFirestore(roomId, options = {}) {
  if (!roomId) return null;
  const roomDocId = String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId);
  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'room_id', op: '==', value: roomDocId }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllHousekeepingFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'updated_at', direction: 'desc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createHousekeepingRecordFirestore(hkData, options = {}) {
  validateRequiredFields(hkData, ['room_id'], 'Housekeeping');

  const roomDocId = String(hkData.room_id).startsWith('room_') ? String(hkData.room_id) : formatRoomId(hkData.room_id);
  const docId = String(hkData.docId || `hk_${roomDocId}`);

  const existing = await getDoc(COLLECTION, docId, options);

  const payload = {
    room_id: roomDocId,
    room_number: hkData.room_number || hkData.number || '',
    status: hkData.status || hkData.housekeeping_status || 'Clean',
    assigned_to: hkData.assigned_to ? String(hkData.assigned_to) : null,
    cleaned_by: hkData.cleaned_by ? String(hkData.cleaned_by) : null,
    notes: hkData.notes || '',
    priority: hkData.priority || 'Normal',
    mysql_housekeeping_id: hkData.mysql_housekeeping_id || hkData.id || null,
    created_at: hkData.created_at || new Date().toISOString(),
    updated_at: hkData.updated_at || new Date().toISOString()
  };

  if (existing && isStaleUpdate(existing, payload)) {
    console.log(`[OutboxGuard] Ignored stale housekeeping record for ${docId}`);
    return existing;
  }

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateHousekeepingRecordFirestore(id, hkData, options = {}) {
  if (!id) throw new RepositoryError('Housekeeping ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(id).startsWith('hk_') ? String(id) : `hk_${id}`;

  const existing = await getDoc(COLLECTION, docId, options);

  const payload = typeof hkData === 'object' && hkData !== null ? { ...hkData } : {};
  payload.updated_at = payload.updated_at || new Date().toISOString();

  if (existing && isStaleUpdate(existing, payload)) {
    console.log(`[OutboxGuard] Ignored stale housekeeping update for ${docId}`);
    return existing;
  }

  if (!existing) {
    return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
  }

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function deleteHousekeepingRecordFirestore(id, options = {}) {
  if (!id) throw new RepositoryError('Housekeeping ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(id).startsWith('hk_') ? String(id) : `hk_${id}`;
  return await deleteDoc(COLLECTION, docId, options);
}
