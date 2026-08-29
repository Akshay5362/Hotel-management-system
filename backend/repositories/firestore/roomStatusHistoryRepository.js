import {
  getDoc,
  listDocs,
  setDoc,
  deleteDoc,
  formatRoomId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'room_status_history';
const PARENT_COLLECTION = 'rooms';

export function formatRoomStatusHistoryId(id) {
  if (!id) return null;
  const str = String(id).trim();
  if (str.startsWith('rsh_') || str.startsWith('room_status_hist_')) return str;
  return `rsh_${str}`;
}

export async function getRoomStatusHistoryByIdFirestore(historyId, options = {}) {
  if (!historyId) return null;
  const docId = formatRoomStatusHistoryId(historyId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getRoomStatusHistoryByRoomFirestore(roomId, options = {}) {
  if (!roomId) return [];
  const roomDocId = String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId);
  const rawId = String(roomId).replace(/^room_/, '');

  const rootByDocId = await listDocs(COLLECTION, {
    filters: [{ field: 'room_id', op: '==', value: roomDocId }],
    transaction: options.transaction
  });

  const rootByRawId = await listDocs(COLLECTION, {
    filters: [{ field: 'room_id', op: '==', value: rawId }],
    transaction: options.transaction
  });

  const rootByRoomNumber = await listDocs(COLLECTION, {
    filters: [{ field: 'room_number', op: '==', value: String(rawId) }],
    transaction: options.transaction
  });

  const subDocs = await listDocs(PARENT_COLLECTION, {
    parentDocId: roomDocId,
    subcollectionName: 'status_history',
    transaction: options.transaction
  });

  const map = new Map();
  [...rootByDocId, ...rootByRawId, ...rootByRoomNumber, ...subDocs].forEach(item => {
    if (item && item.id) map.set(item.id, item);
  });

  return Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

export async function getAllRoomStatusHistoryFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createRoomStatusHistoryFirestore(data, options = {}) {
  validateRequiredFields(data, ['new_status'], 'RoomStatusHistory');

  const rawId = data.mysql_history_id || data.id || data.history_id || Date.now();
  const docId = formatRoomStatusHistoryId(rawId);

  const rawRoom = data.room_id || data.room_number;
  const roomDocId = rawRoom ? (String(rawRoom).startsWith('room_') ? String(rawRoom) : formatRoomId(rawRoom)) : null;
  const roomNum = data.room_number || (rawRoom ? String(rawRoom).replace(/^room_/, '') : null);

  const payload = {
    history_id: docId,
    room_id: roomDocId,
    room_number: roomNum,
    mysql_room_id: data.mysql_room_id || (!isNaN(Number(roomNum)) ? Number(roomNum) : null),
    old_status: data.old_status || null,
    new_status: String(data.new_status),
    changed_by: data.changed_by ? String(data.changed_by) : null,
    mysql_changed_by: data.mysql_changed_by || (data.changed_by && !isNaN(Number(data.changed_by)) ? Number(data.changed_by) : null),
    business_date: data.business_date || new Date().toISOString().split('T')[0],
    reason: data.reason || data.notes || null,
    mysql_history_id: data.mysql_history_id || (data.id && !isNaN(Number(data.id)) ? Number(data.id) : null),
    created_at: data.created_at || new Date().toISOString()
  };

  await setDoc(COLLECTION, docId, payload, { ...options, merge: true });

  if (roomDocId) {
    await setDoc(PARENT_COLLECTION, roomDocId, payload, {
      ...options,
      subcollectionName: 'status_history',
      subDocId: docId,
      merge: true
    });
  }

  return { id: docId, ...payload };
}

export async function deleteRoomStatusHistoryFirestore(historyId, options = {}) {
  if (!historyId) throw new RepositoryError('History ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = formatRoomStatusHistoryId(historyId);
  return await deleteDoc(COLLECTION, docId, options);
}
