import { db } from '../../config/firebaseAdmin.js';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';

export class RepositoryError extends Error {
  constructor(message, code = 'REPOSITORY_ERROR', status = 500, details = null) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Validate presence of required non-empty fields on input object
 */
export function validateRequiredFields(data, requiredFields = [], domain = 'Record') {
  if (!data || typeof data !== 'object') {
    throw new RepositoryError(`Invalid payload for ${domain}: Expected object`, 'VALIDATION_ERROR', 400);
  }
  const missing = [];
  for (const field of requiredFields) {
    const val = data[field];
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    throw new RepositoryError(
      `Missing required fields for ${domain}: [${missing.join(', ')}]`,
      'VALIDATION_ERROR',
      400,
      { missingFields: missing }
    );
  }
}

/**
 * Normalizes input date/timestamp into standard ISO-8601 string representation
 */
export function normalizeTimestamp(val) {
  if (!val) return new Date().toISOString();
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'number') return new Date(val).toISOString();
  if (typeof val === 'string') {
    const parsed = new Date(val);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Formats a Firestore Document Snapshot into a clean plain JavaScript object
 */
export function formatDocSnapshot(docSnap) {
  if (!docSnap.exists) return null;
  const d = docSnap.data();
  return {
    id: docSnap.id,
    doc_id: docSnap.id,
    ...d
  };
}

/**
 * Returns a document reference (supports optional subcollections)
 */
export function getRef(collectionName, docId, subcollectionName = null, subDocId = null) {
  let ref = db.collection(collectionName).doc(String(docId));
  if (subcollectionName && subDocId) {
    ref = ref.collection(subcollectionName).doc(String(subDocId));
  }
  return ref;
}

/**
 * Generic Read by ID supporting optional Firestore Transactions
 */
export async function getDoc(collectionName, docId, options = {}) {
  const { transaction, subcollectionName, subDocId } = options;
  const ref = getRef(collectionName, docId, subcollectionName, subDocId);

  let docSnap;
  if (transaction) {
    docSnap = await transaction.get(ref);
  } else {
    docSnap = await ref.get();
  }

  return formatDocSnapshot(docSnap);
}

/**
 * Generic List/Query supporting filtering, pagination, sorting, and optional Transactions
 */
export async function listDocs(collectionName, options = {}) {
  const {
    filters = [],
    orderBy = [],
    limit = 50,
    startAfterDoc = null,
    transaction = null,
    subcollectionName = null,
    parentDocId = null
  } = options;

  let queryRef;
  if (subcollectionName && parentDocId) {
    queryRef = db.collection(collectionName).doc(String(parentDocId)).collection(subcollectionName);
  } else {
    queryRef = db.collection(collectionName);
  }

  // Apply filters: [{ field, op, value }]
  for (const f of filters) {
    if (f && f.field && f.op !== undefined && f.value !== undefined) {
      queryRef = queryRef.where(f.field, f.op, f.value);
    }
  }

  // Apply orderBy: [{ field, direction: 'asc'|'desc' }]
  for (const ob of orderBy) {
    if (ob && ob.field) {
      queryRef = queryRef.orderBy(ob.field, ob.direction || 'asc');
    }
  }

  // Apply pagination startAfter
  if (startAfterDoc) {
    queryRef = queryRef.startAfter(startAfterDoc);
  }

  // Apply limit
  if (limit && typeof limit === 'number' && limit > 0) {
    queryRef = queryRef.limit(limit);
  }

  let snap;
  if (transaction) {
    snap = await transaction.get(queryRef);
  } else {
    snap = await queryRef.get();
  }

  const results = [];
  snap.forEach(doc => {
    results.push(formatDocSnapshot(doc));
  });

  return results;
}

/**
 * Generic Write/Set supporting optional Firestore Transactions or WriteBatches
 */
export async function setDoc(collectionName, docId, data, options = {}) {
  const { transaction, batch, merge = true, subcollectionName, subDocId } = options;
  const ref = getRef(collectionName, docId, subcollectionName, subDocId);

  const payload = {
    ...data,
    updated_at: data.updated_at || new Date().toISOString()
  };
  if (!merge && !payload.created_at) {
    payload.created_at = new Date().toISOString();
  }

  if (transaction) {
    transaction.set(ref, payload, { merge });
  } else if (batch) {
    batch.set(ref, payload, { merge });
  } else {
    await ref.set(payload, { merge });
  }

  return { id: ref.id, ...payload };
}

/**
 * Generic Update supporting optional Firestore Transactions or WriteBatches
 */
export async function updateDoc(collectionName, docId, data, options = {}) {
  const { transaction, batch, subcollectionName, subDocId } = options;
  const ref = getRef(collectionName, docId, subcollectionName, subDocId);

  const payload = {
    ...data,
    updated_at: data.updated_at || new Date().toISOString()
  };

  if (transaction) {
    transaction.update(ref, payload);
  } else if (batch) {
    batch.update(ref, payload);
  } else {
    await ref.update(payload);
  }

  return { id: ref.id, ...payload };
}

/**
 * Generic Delete supporting optional Firestore Transactions or WriteBatches
 */
export async function deleteDoc(collectionName, docId, options = {}) {
  const { transaction, batch, subcollectionName, subDocId } = options;
  const ref = getRef(collectionName, docId, subcollectionName, subDocId);

  if (transaction) {
    transaction.delete(ref);
  } else if (batch) {
    batch.delete(ref);
  } else {
    await ref.delete();
  }

  return { id: ref.id, deleted: true };
}

// ── Deterministic ID Formatters ──────────────────────────────────────────────
export const formatRoomId = (roomNumber) => `room_${String(roomNumber).trim()}`;
export const formatBookingId = (ref) => `bkg_${String(ref).trim()}`;
export const formatReservationId = (ref) => `res_${String(ref).trim()}`;
export const formatGuestId = (uidOrId) => `guest_${String(uidOrId).trim()}`;
export const formatStaffId = (uidOrId) => `staff_${String(uidOrId).trim()}`;
export const formatInvoiceId = (num) => `inv_${String(num).trim()}`;
export const formatCategoryDocId = (val) => `cat_${String(val).toLowerCase().trim().replace(/[^a-z0-9]/g, '_')}`;
export const formatProductDocId = (val) => `prod_${String(val).toLowerCase().trim().replace(/[^a-z0-9]/g, '_')}`;
