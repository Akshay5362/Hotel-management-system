import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  formatStaffId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'staff';

export async function getStaffByIdFirestore(staffId, options = {}) {
  if (!staffId) return null;
  const docId = String(staffId).startsWith('staff_') ? String(staffId) : formatStaffId(staffId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getStaffByUidFirestore(uid, options = {}) {
  if (!uid) return null;
  const docId = String(uid).startsWith('staff_') ? String(uid) : formatStaffId(uid);
  const byDoc = await getDoc(COLLECTION, docId, options);
  if (byDoc) return byDoc;

  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'user_uid', op: '==', value: String(uid) }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getStaffByUsernameFirestore(username, options = {}) {
  if (!username) return null;
  const docId = formatStaffId(String(username).toLowerCase().trim());
  const byDoc = await getDoc(COLLECTION, docId, options);
  if (byDoc) return byDoc;

  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'username', op: '==', value: String(username).toLowerCase().trim() }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllStaffFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'full_name', direction: 'asc' }], limit = 100, cursor = null, transaction = null, includeInactive = false } = options;
  const docs = await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });

  if (includeInactive) return docs;

  // Active staff filter: Exclude soft-deleted or inactive staff records
  return docs.filter(s => {
    if (!s) return false;
    if (s.deleted === true || s.deleted === 1 || s.is_deleted === true || s.is_deleted === 1 || s.deleted_at) return false;
    if (s.is_active === false || s.is_active === 0 || s.active === false || s.active === 0) return false;
    if (s.status === 'Inactive' || s.status === 'Disabled' || s.status === 'Deleted') return false;
    return true;
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

export async function createStaffFirestore(staffData, options = {}) {
  validateRequiredFields(staffData, ['username', 'full_name', 'role'], 'Staff');

  const idKey = staffData.user_uid || staffData.username;
  const docId = formatStaffId(idKey);

  const existing = await getDoc(COLLECTION, docId, options);
  if (existing) {
    throw new RepositoryError(`Staff profile '${idKey}' already exists`, 'DUPLICATE_KEY', 400);
  }

  const nowIso = staffData.updated_at || staffData.created_at || new Date().toISOString();

  // SECURITY: Strictly omit password_hash or plaintext password from Firestore payload
  const { password_hash, password, ...safeData } = staffData;

  const payload = {
    username: String(safeData.username).toLowerCase().trim(),
    full_name: String(safeData.full_name).trim(),
    email: safeData.email ? String(safeData.email).toLowerCase().trim() : null,
    phone: safeData.phone || null,
    role: String(safeData.role).toLowerCase().trim(),
    department: safeData.department || 'Front Office',
    shift: safeData.shift || 'Morning',
    status: safeData.status || 'Active',
    user_uid: safeData.user_uid || null,
    mysql_staff_id: safeData.mysql_staff_id || safeData.id || null,
    created_at: nowIso,
    updated_at: nowIso
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateStaffFirestore(staffId, staffData, options = {}) {
  if (!staffId) throw new RepositoryError('Staff ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(staffId).startsWith('staff_') ? String(staffId) : formatStaffId(staffId);

  // SECURITY: Strictly omit sensitive credentials
  const { password_hash, password, ...safeData } = staffData;

  const existing = await getDoc(COLLECTION, docId, options);
  if (!existing) {
    return await createStaffFirestore({ ...safeData, username: staffId }, options);
  }

  if (isStaleUpdate(existing, safeData)) {
    console.log(`[OutboxGuard] Ignored stale staff update for ${docId}`);
    return existing;
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

export async function deleteStaffFirestore(staffId, options = {}) {
  if (!staffId) throw new RepositoryError('Staff ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(staffId).startsWith('staff_') ? String(staffId) : formatStaffId(staffId);

  return await deleteDoc(COLLECTION, docId, options).catch(err => {
    if (err.code === 'NOT_FOUND') return null; // Idempotent deletion handling
    throw err;
  });
}
