import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  formatGuestId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'guests';

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

export async function getGuestByIdFirestore(guestId, options = {}) {
  if (!guestId) return null;
  const docId = String(guestId).startsWith('guest_') ? String(guestId) : formatGuestId(guestId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getGuestByUidFirestore(uid, options = {}) {
  if (!uid) return null;
  const docId = String(uid).startsWith('guest_') ? String(uid) : formatGuestId(uid);
  const byDoc = await getDoc(COLLECTION, docId, options);
  if (byDoc) return byDoc;

  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'user_uid', op: '==', value: String(uid) }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getGuestByPhoneFirestore(phone, options = {}) {
  if (!phone) return null;
  const docId = formatGuestId(phone);
  const byDoc = await getDoc(COLLECTION, docId, options);
  if (byDoc) return byDoc;

  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'phone', op: '==', value: String(phone).trim() }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllGuestsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'full_name', direction: 'asc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createGuestFirestore(guestData, options = {}) {
  validateRequiredFields(guestData, ['full_name'], 'Guest');

  const idKey = guestData.phone || guestData.user_uid || guestData.guest_id || Date.now();
  const docId = formatGuestId(idKey);

  const existing = await getDoc(COLLECTION, docId, options);

  const payload = {
    full_name: String(guestData.full_name).trim(),
    email: guestData.email ? String(guestData.email).toLowerCase().trim() : null,
    phone: guestData.phone ? String(guestData.phone).trim() : null,
    address: guestData.address || '',
    government_id: guestData.government_id || null,
    id_type: guestData.id_type || null,
    id_document_url: guestData.id_document_url || null,
    id_verification_status: guestData.id_verification_status || 'Pending',
    loyalty_tier: guestData.loyalty_tier || 'Bronze',
    loyalty_points: Number(guestData.loyalty_points || 0),
    user_uid: guestData.user_uid || null,
    mysql_guest_id: guestData.mysql_guest_id || guestData.id || null,
    mysql_user_id: guestData.mysql_user_id || null,
    created_at: guestData.created_at || new Date().toISOString(),
    updated_at: guestData.updated_at || new Date().toISOString()
  };

  if (existing) {
    if (isStaleUpdate(existing, payload)) {
      console.log(`[OutboxGuard] Ignored stale guest create/upsert for ${docId}`);
      return existing;
    }
    return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
  }

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateGuestFirestore(guestId, guestData, options = {}) {
  if (!guestId) throw new RepositoryError('Guest ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(guestId).startsWith('guest_') ? String(guestId) : formatGuestId(guestId);

  const existing = await getDoc(COLLECTION, docId, options);

  const payload = typeof guestData === 'object' && guestData !== null ? { ...guestData } : {};
  payload.updated_at = payload.updated_at || new Date().toISOString();

  // Explicit security sanitization check - strip password/credentials if inadvertently present
  delete payload.password;
  delete payload.password_hash;
  delete payload.token;
  delete payload.secret;

  if (existing && isStaleUpdate(existing, payload)) {
    console.log(`[OutboxGuard] Ignored stale guest update for ${docId}`);
    return existing;
  }

  if (!existing) {
    if (!payload.full_name) {
      throw new RepositoryError(`Guest '${guestId}' not found`, 'NOT_FOUND', 404);
    }
    return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
  }

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function deleteGuestFirestore(guestId, options = {}) {
  if (!guestId) throw new RepositoryError('Guest ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(guestId).startsWith('guest_') ? String(guestId) : formatGuestId(guestId);
  return await deleteDoc(COLLECTION, docId, options);
}
