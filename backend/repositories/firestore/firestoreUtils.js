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
 * Exact decimal precision serializer for financial/monetary fields.
 * Preserves exact MySQL DECIMAL representation as fixed 2-decimal strings without floating-point loss.
 */
export function formatDecimal(val) {
  if (val === null || val === undefined || val === '') {
    return null;
  }

  const str = String(val).trim();
  if (str === '' || str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined') {
    return null;
  }

  const isNegative = str.startsWith('-');
  const cleanStr = isNegative ? str.slice(1) : str;

  const parts = cleanStr.split('.');
  const intPart = parts[0].replace(/^0+(?=\d)/, '') || '0';
  let fracPart = parts[1] || '';

  if (fracPart.length === 0) {
    fracPart = '00';
  } else if (fracPart.length === 1) {
    fracPart = fracPart + '0';
  } else if (fracPart.length > 2) {
    fracPart = fracPart.slice(0, 2);
  }

  const result = `${isNegative && (intPart !== '0' || fracPart !== '00') ? '-' : ''}${intPart}.${fracPart}`;
  return result;
}

const FORBIDDEN_KEY_PATTERNS = [
  'password',
  'password_hash',
  'passwordhash',
  'jwt',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'private_key',
  'privatekey',
  'service_account',
  'service_account_key',
  'serviceaccount',
  'api_key',
  'apikey',
  'secret',
  'card_number',
  'cardnumber',
  'cvv',
  'pin'
];

/**
 * Recursively strips forbidden credential keys from an object or array.
 * OWASP excessive data exposure protection at repository & API boundaries.
 */
export function sanitizeSensitiveFields(target) {
  if (!target || typeof target !== 'object') {
    return target;
  }

  if (Array.isArray(target)) {
    return target.map(item => sanitizeSensitiveFields(item));
  }

  if (target instanceof Date || target.constructor?.name === 'Timestamp' || target.constructor?.name === 'FieldValue') {
    return target;
  }

  const cleanObj = {};
  for (const key of Object.keys(target)) {
    const lowerKey = key.toLowerCase();
    const isForbidden = FORBIDDEN_KEY_PATTERNS.some(p => lowerKey === p || lowerKey === p.replace(/_/g, ''));

    if (isForbidden) {
      continue;
    }

    cleanObj[key] = sanitizeSensitiveFields(target[key]);
  }

  return cleanObj;
}

/**
 * Formats a Firestore Document Snapshot into a clean plain JavaScript object
 */
export function formatDocSnapshot(docSnap) {
  if (!docSnap.exists) return null;
  const d = docSnap.data();
  return sanitizeSensitiveFields({
    id: docSnap.id,
    doc_id: docSnap.id,
    ...d
  });
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
