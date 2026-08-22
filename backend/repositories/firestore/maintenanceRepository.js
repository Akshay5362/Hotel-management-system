import {
  getDoc,
  listDocs,
  setDoc,
  deleteDoc,
  formatRoomId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'maintenance';

export function formatMaintenanceId(id) {
  if (!id) return null;
  const str = String(id).trim();
  if (str.startsWith('maint_') || str.startsWith('maintenance_')) return str;
  return `maint_${str}`;
}

export async function getMaintenanceByIdFirestore(maintenanceId, options = {}) {
  if (!maintenanceId) return null;
  const docId = formatMaintenanceId(maintenanceId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getMaintenanceByRoomFirestore(roomId, options = {}) {
  if (!roomId) return [];
  const roomDocId = String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId);
  const rawId = String(roomId).replace(/^room_/, '');

  const byDocId = await listDocs(COLLECTION, {
    filters: [{ field: 'room_id', op: '==', value: roomDocId }],
    transaction: options.transaction
  });

  const byRawId = await listDocs(COLLECTION, {
    filters: [{ field: 'room_id', op: '==', value: rawId }],
    transaction: options.transaction
  });

  const byRoomNumber = await listDocs(COLLECTION, {
    filters: [{ field: 'room_number', op: '==', value: String(rawId) }],
    transaction: options.transaction
  });

  const map = new Map();
  [...byDocId, ...byRawId, ...byRoomNumber].forEach(item => {
    if (item && item.id) map.set(item.id, item);
  });

  return Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

export async function getAllMaintenanceFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createMaintenanceRecordFirestore(data, options = {}) {
  validateRequiredFields(data, ['issue'], 'Maintenance');

  const rawId = data.mysql_maintenance_id || data.id || data.maintenance_id || Date.now();
  const docId = formatMaintenanceId(rawId);

  const rawRoom = data.room_id || data.room_number || data.room;
  const roomDocId = rawRoom ? (String(rawRoom).startsWith('room_') ? String(rawRoom) : formatRoomId(rawRoom)) : null;
  const roomNum = data.room_number || (rawRoom ? String(rawRoom).replace(/^room_/, '') : null);

  const payload = {
    maintenance_id: docId,
    room_id: roomDocId,
    room_number: roomNum,
    mysql_room_id: data.mysql_room_id || (!isNaN(Number(roomNum)) ? Number(roomNum) : null),
    reported_by: data.reported_by ? String(data.reported_by) : null,
    mysql_reported_by: data.mysql_reported_by || (data.reported_by && !isNaN(Number(data.reported_by)) ? Number(data.reported_by) : null),
    assigned_to: data.assigned_to ? String(data.assigned_to) : null,
    mysql_assigned_to: data.mysql_assigned_to || (data.assigned_to && !isNaN(Number(data.assigned_to)) ? Number(data.assigned_to) : null),
    issue: String(data.issue),
    status: data.status || 'Pending',
    business_date: data.business_date || new Date().toISOString().split('T')[0],
    mysql_maintenance_id: data.mysql_maintenance_id || (data.id && !isNaN(Number(data.id)) ? Number(data.id) : null),
    created_at: data.created_at || new Date().toISOString(),
    updated_at: data.updated_at || new Date().toISOString(),
    resolved_at: data.status === 'Resolved' ? (data.resolved_at || new Date().toISOString()) : null
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateMaintenanceRecordFirestore(maintenanceId, updateData, options = {}) {
  if (!maintenanceId) throw new RepositoryError('Maintenance ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = formatMaintenanceId(maintenanceId);

  const payload = {
    ...updateData,
    updated_at: updateData.updated_at || new Date().toISOString()
  };

  if (updateData.status === 'Resolved' && !payload.resolved_at) {
    payload.resolved_at = new Date().toISOString();
  }

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function deleteMaintenanceRecordFirestore(maintenanceId, options = {}) {
  if (!maintenanceId) throw new RepositoryError('Maintenance ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = formatMaintenanceId(maintenanceId);
  return await deleteDoc(COLLECTION, docId, options);
}
