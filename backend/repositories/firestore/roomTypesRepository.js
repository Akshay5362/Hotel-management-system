import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

import { globalTtlCache } from '../../utils/ttlCache.js';

const COLLECTION = 'room_types';

/**
 * Invalidate all cached room types immediately upon mutation.
 */
export function invalidateRoomTypesCache() {
  globalTtlCache.deleteByPrefix('room_types_');
}

export async function getRoomTypeByIdFirestore(typeId, options = {}) {
  if (!typeId) return null;
  const docId = String(typeId).startsWith('type_') ? String(typeId) : `type_${String(typeId).toUpperCase()}`;
  const direct = await getDoc(COLLECTION, docId, options);
  if (direct) return direct;

  const codeLookup = await getRoomTypeByCodeFirestore(typeId, options);
  if (codeLookup) return codeLookup;

  if (!isNaN(Number(typeId))) {
    const byMySqlId = await listDocs(COLLECTION, {
      filters: [{ field: 'mysql_room_type_id', op: '==', value: Number(typeId) }],
      limit: 1,
      transaction: options.transaction
    });
    if (byMySqlId[0]) return byMySqlId[0];
  }
  return null;
}

export async function getRoomTypeByCodeFirestore(code, options = {}) {
  if (!code) return null;
  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'code', op: '==', value: String(code).toUpperCase().trim() }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllRoomTypesFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'name', direction: 'asc' }], limit = 50, cursor = null, transaction = null, skipCache = false } = options;

  if (transaction || cursor || filters.length > 0 || limit !== 50 || skipCache) {
    return await listDocs(COLLECTION, {
      filters,
      orderBy,
      limit,
      startAfterDoc: cursor,
      transaction
    });
  }

  return await globalTtlCache.getOrSet(
    'room_types_all',
    () => listDocs(COLLECTION, { filters, orderBy, limit, startAfterDoc: cursor, transaction }),
    600000 // 10 minutes TTL
  );
}

export async function createRoomTypeFirestore(typeData, options = {}) {
  validateRequiredFields(typeData, ['name', 'code', 'base_rate'], 'RoomType');

  const codeStr = String(typeData.code).toUpperCase().trim();
  const docId = `type_${codeStr}`;

  const existing = await getDoc(COLLECTION, docId, options);
  if (existing) {
    throw new RepositoryError(`Room type code '${codeStr}' already exists`, 'DUPLICATE_KEY', 400);
  }

  const payload = {
    name: String(typeData.name).trim(),
    code: codeStr,
    description: typeData.description || '',
    base_rate: Number(typeData.base_rate),
    max_occupancy: Number(typeData.max_occupancy || 2),
    amenities: Array.isArray(typeData.amenities) ? typeData.amenities : [],
    mysql_room_type_id: typeData.mysql_room_type_id || typeData.id || null,
    created_at: new Date().toISOString()
  };

  const result = await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
  invalidateRoomTypesCache();
  return result;
}

export async function updateRoomTypeFirestore(typeId, typeData, options = {}) {
  if (!typeId) throw new RepositoryError('Room type ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(typeId).startsWith('type_') ? String(typeId) : `type_${typeId}`;
  const result = await updateDoc(COLLECTION, docId, typeData, options);
  invalidateRoomTypesCache();
  return result;
}

export async function deleteRoomTypeFirestore(typeId, options = {}) {
  if (!typeId) throw new RepositoryError('Room type ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(typeId).startsWith('type_') ? String(typeId) : `type_${typeId}`;
  const result = await deleteDoc(COLLECTION, docId, options);
  invalidateRoomTypesCache();
  return result;
}
