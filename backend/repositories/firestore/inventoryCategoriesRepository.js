import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  formatCategoryDocId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

import { globalTtlCache } from '../../utils/ttlCache.js';

const COLLECTION = 'inventory_categories';

/**
 * Invalidate all cached inventory categories immediately upon mutation.
 */
export function invalidateInventoryCategoriesCache() {
  globalTtlCache.deleteByPrefix('inventory_categories_');
}

export async function getInventoryCategoryByIdFirestore(catId, options = {}) {
  if (!catId) return null;
  const docId = String(catId).startsWith('cat_') ? String(catId) : formatCategoryDocId(catId);
  const direct = await getDoc(COLLECTION, docId, options);
  if (direct) return direct;

  if (!isNaN(Number(catId))) {
    const byMySqlId = await listDocs(COLLECTION, {
      filters: [{ field: 'mysql_category_id', op: '==', value: Number(catId) }],
      limit: 1,
      transaction: options.transaction
    });
    if (byMySqlId[0]) return byMySqlId[0];
  }
  return null;
}

export async function getAllInventoryCategoriesFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'name', direction: 'asc' }], limit = 100, cursor = null, transaction = null, skipCache = false } = options;

  if (transaction || cursor || filters.length > 0 || limit !== 100 || skipCache) {
    return await listDocs(COLLECTION, {
      filters,
      orderBy,
      limit,
      startAfterDoc: cursor,
      transaction
    });
  }

  return await globalTtlCache.getOrSet(
    'inventory_categories_all',
    () => listDocs(COLLECTION, { filters, orderBy, limit, startAfterDoc: cursor, transaction }),
    600000 // 10 minutes TTL
  );
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

export async function createInventoryCategoryFirestore(catData, options = {}) {
  validateRequiredFields(catData, ['name'], 'InventoryCategory');
  const docId = formatCategoryDocId(catData.name);

  const existing = await getDoc(COLLECTION, docId, options);
  if (existing) {
    throw new RepositoryError(`Category '${catData.name}' already exists`, 'DUPLICATE_KEY', 400);
  }

  const nowIso = catData.updated_at || catData.created_at || new Date().toISOString();

  const payload = {
    name: String(catData.name).trim(),
    department: catData.department || 'General',
    description: catData.description || '',
    mysql_category_id: catData.mysql_category_id || catData.id || null,
    created_at: nowIso,
    updated_at: nowIso
  };

  const result = await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
  invalidateInventoryCategoriesCache();
  return result;
}

export async function updateInventoryCategoryFirestore(catId, catData, options = {}) {
  if (!catId) throw new RepositoryError('Category ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(catId).startsWith('cat_') ? String(catId) : formatCategoryDocId(catId);

  const existing = await getDoc(COLLECTION, docId, options);
  if (!existing) {
    // Upsert fallback if document does not exist in Firestore yet
    const res = await setDoc(COLLECTION, docId, {
      name: String(catData.name || catId).trim(),
      department: catData.department || 'General',
      ...catData,
      updated_at: catData.updated_at || new Date().toISOString()
    }, { ...options, merge: true });
    invalidateInventoryCategoriesCache();
    return res;
  }

  if (isStaleUpdate(existing, catData)) {
    console.log(`[OutboxGuard] Ignored stale inventory category update for ${docId}`);
    return existing;
  }

  const updatePayload = {
    ...catData,
    updated_at: catData.updated_at || new Date().toISOString()
  };

  const result = await updateDoc(COLLECTION, docId, updatePayload, options);
  invalidateInventoryCategoriesCache();
  return result;
}

export async function deleteInventoryCategoryFirestore(catId, options = {}) {
  if (!catId) throw new RepositoryError('Category ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(catId).startsWith('cat_') ? String(catId) : formatCategoryDocId(catId);
  const result = await deleteDoc(COLLECTION, docId, options).catch(err => {
    if (err.code === 'NOT_FOUND') return null; // Idempotent deletion handling
    throw err;
  });
  invalidateInventoryCategoriesCache();
  return result;
}
