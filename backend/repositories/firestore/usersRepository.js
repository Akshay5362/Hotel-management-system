import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'users';

function formatUserId(id) {
  if (!id) return null;
  const str = String(id).trim();
  if (str.startsWith('user_')) return str;
  return `user_${str}`;
}

export async function getUserByIdFirestore(userId, options = {}) {
  if (!userId) return null;
  const docId = formatUserId(userId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getUserByUidFirestore(uid, options = {}) {
  if (!uid) return null;
  const docId = formatUserId(uid);
  const byDoc = await getDoc(COLLECTION, docId, options);
  if (byDoc) return byDoc;

  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'user_uid', op: '==', value: String(uid) }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getUserByUsernameFirestore(username, options = {}) {
  if (!username) return null;
  const cleanName = String(username).toLowerCase().trim();
  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'username', op: '==', value: cleanName }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllUsersFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'username', direction: 'asc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createUserFirestore(userData, options = {}) {
  validateRequiredFields(userData, ['username', 'full_name', 'role'], 'User');

  const idKey = userData.user_uid || userData.mysql_user_id || userData.username;
  const docId = formatUserId(idKey);

  const existing = await getDoc(COLLECTION, docId, options);
  if (existing) {
    throw new RepositoryError(`User profile '${docId}' already exists`, 'DUPLICATE_KEY', 400);
  }

  const nowIso = userData.updated_at || userData.created_at || new Date().toISOString();

  // SECURITY REQUIREMENT: Omit sensitive passwords or password hashes
  const { password, password_hash, passwordHash, ...safeData } = userData;

  const payload = {
    mysql_user_id: safeData.mysql_user_id || safeData.id || null,
    user_uid: safeData.user_uid || docId,
    email: safeData.email ? String(safeData.email).toLowerCase().trim() : null,
    username: String(safeData.username).toLowerCase().trim(),
    full_name: String(safeData.full_name || safeData.fullName).trim(),
    phone: safeData.phone || null,
    role: String(safeData.role).toLowerCase().trim(),
    user_type: safeData.user_type || 'system',
    created_at: nowIso,
    updated_at: nowIso
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateUserFirestore(userId, userData, options = {}) {
  if (!userId) throw new RepositoryError('User ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = formatUserId(userId);

  // SECURITY REQUIREMENT: Omit sensitive passwords or password hashes
  const { password, password_hash, passwordHash, ...safeData } = userData;

  const existing = await getDoc(COLLECTION, docId, options);
  if (!existing) {
    return await createUserFirestore({ ...safeData, username: userId }, options);
  }

  const updatePayload = {
    ...safeData,
    updated_at: safeData.updated_at || new Date().toISOString()
  };

  if (updatePayload.role) {
    updatePayload.role = String(updatePayload.role).toLowerCase().trim();
  }

  return await updateDoc(COLLECTION, docId, updatePayload, options);
}
