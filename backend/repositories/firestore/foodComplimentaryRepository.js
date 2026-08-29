/**
 * backend/repositories/firestore/foodComplimentaryRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore data-access layer for Food Complimentary Authorizations.
 *
 * Dedicated collection:
 *   food_complimentary_requests — records all staff requests & admin/manager approvals.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'food_complimentary_requests';

export const VALID_COMPLIMENTARY_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'];

/**
 * Generates a unique document ID for a complimentary request.
 * Format: fcreq_{epoch_ms}_{4hex}
 */
export function generateFoodComplimentaryDocId() {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `fcreq_${ts}_${rand}`;
}

export async function getComplimentaryRequestByIdFirestore(requestId, options = {}) {
  if (!requestId) return null;
  const docId = String(requestId).startsWith('fcreq_') ? String(requestId) : `fcreq_${requestId}`;
  return await getDoc(COLLECTION, docId, options);
}

export async function getComplimentaryRequestByOrderIdFirestore(orderId, options = {}) {
  if (!orderId) return null;
  const cleanId = String(orderId).startsWith('forder_') ? String(orderId) : `forder_${orderId}`;

  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'food_order_id', op: '==', value: cleanId }],
    orderBy: [{ field: 'requested_at', direction: 'desc' }],
    limit: 1,
    transaction: options.transaction
  });

  return results[0] || null;
}

export async function listComplimentaryRequestsFirestore(options = {}) {
  const { status, limit = 50, transaction } = options;
  const filters = [];

  if (status && VALID_COMPLIMENTARY_STATUSES.includes(status)) {
    filters.push({ field: 'status', op: '==', value: status });
  }

  return await listDocs(COLLECTION, {
    filters,
    orderBy: [{ field: 'requested_at', direction: 'desc' }],
    limit,
    transaction
  });
}

export async function createComplimentaryRequestFirestore(requestData, options = {}) {
  validateRequiredFields(requestData, [
    'food_order_id',
    'food_order_number',
    'amount',
    'recipient',
    'recipient_type',
    'reason',
    'requested_by_uid'
  ], 'ComplimentaryRequest');

  const reqId = requestData.request_id || generateFoodComplimentaryDocId();
  const now = new Date().toISOString();

  const payload = {
    request_id:         reqId,
    food_order_id:      String(requestData.food_order_id),
    food_order_number:  String(requestData.food_order_number),
    amount:             Number(requestData.amount),
    recipient:          String(requestData.recipient),
    recipient_type:     String(requestData.recipient_type || 'GUEST').toUpperCase(),
    room_number:        requestData.room_number ? String(requestData.room_number) : null,
    reason:             String(requestData.reason),
    status:             requestData.status || 'PENDING_APPROVAL',

    requested_by_uid:   String(requestData.requested_by_uid),
    requested_by_name:  requestData.requested_by_name || 'Staff',
    requested_at:       now,

    approved_by_uid:    requestData.approved_by_uid || null,
    approved_by_name:   requestData.approved_by_name || null,
    approved_at:        requestData.approved_at || null,

    rejected_by_uid:    null,
    rejected_by_name:   null,
    rejection_reason:   null,
    rejected_at:        null,

    created_at:         now,
    updated_at:         now
  };

  await setDoc(COLLECTION, reqId, payload, options);
  return { id: reqId, ...payload };
}

export async function updateComplimentaryRequestFirestore(requestId, updateData, options = {}) {
  if (!requestId) throw new RepositoryError('Request ID required', 'VALIDATION_ERROR', 400);
  const docId = String(requestId).startsWith('fcreq_') ? String(requestId) : `fcreq_${requestId}`;

  const payload = {
    ...updateData,
    updated_at: new Date().toISOString()
  };

  return await updateDoc(COLLECTION, docId, payload, options);
}
