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

const COLLECTION = 'inventory_categories';

export async function getInventoryCategoryByIdFirestore(catId, options = {}) {
  if (!catId) return null;
  const docId = String(catId).startsWith('cat_') ? String(catId) : formatCategoryDocId(catId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getAllInventoryCategoriesFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'name', direction: 'asc' }], limit = 100, cursor = null, transaction = null } = options;
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

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateInventoryCategoryFirestore(catId, catData, options = {}) {
  if (!catId) throw new RepositoryError('Category ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(catId).startsWith('cat_') ? String(catId) : formatCategoryDocId(catId);

  const existing = await getDoc(COLLECTION, docId, options);
  if (!existing) {
    // Upsert fallback if document does not exist in Firestore yet
    return await setDoc(COLLECTION, docId, {
      name: String(catData.name || catId).trim(),
      department: catData.department || 'General',
      ...catData,
      updated_at: catData.updated_at || new Date().toISOString()
    }, { ...options, merge: true });
  }

  if (isStaleUpdate(existing, catData)) {
    console.log(`[OutboxGuard] Ignored stale inventory category update for ${docId}`);
    return existing;
  }

  const updatePayload = {
    ...catData,
    updated_at: catData.updated_at || new Date().toISOString()
  };

  return await updateDoc(COLLECTION, docId, updatePayload, options);
}

export async function deleteInventoryCategoryFirestore(catId, options = {}) {
  if (!catId) throw new RepositoryError('Category ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(catId).startsWith('cat_') ? String(catId) : formatCategoryDocId(catId);
  return await deleteDoc(COLLECTION, docId, options).catch(err => {
    if (err.code === 'NOT_FOUND') return null; // Idempotent deletion handling
    throw err;
  });
}
