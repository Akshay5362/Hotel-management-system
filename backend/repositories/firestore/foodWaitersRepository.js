/**
 * backend/repositories/firestore/foodWaitersRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore data-access layer for Food Waiters Master.
 *
 * Dedicated collection:
 *   food_waiters — restaurant waiter/server names for order assignment.
 *   Intentionally separate from the hotel `staff` collection: waiters here
 *   are lightweight named records with no login credentials or RBAC role.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'food_waiters';

export function generateFoodWaiterDocId(name) {
  const clean = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').slice(0, 30);
  return `fwtr_${clean || Date.now()}`;
}

export async function getFoodWaiterByIdFirestore(waiterId, options = {}) {
  if (!waiterId) return null;
  const docId = String(waiterId).startsWith('fwtr_') ? String(waiterId) : `fwtr_${waiterId}`;
  return await getDoc(COLLECTION, docId, options);
}

export async function listFoodWaitersFirestore(options = {}) {
  const { activeOnly = false, transaction } = options;
  const filters = [];

  if (activeOnly) {
    filters.push({ field: 'is_active', op: '==', value: true });
  }

  const results = await listDocs(COLLECTION, {
    filters,
    transaction
  });

  return results.sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999));
}

export async function createFoodWaiterFirestore(waiterData, options = {}) {
  validateRequiredFields(waiterData, ['waiter_name'], 'FoodWaiter');

  const waiterName = String(waiterData.waiter_name).trim();
  const docId = waiterData.waiter_id || generateFoodWaiterDocId(waiterName);
  const now = new Date().toISOString();

  const payload = {
    waiter_id:     docId,
    waiter_name:   waiterName,
    is_active:     waiterData.is_active !== false,
    display_order: Number(waiterData.display_order || 0),
    created_at:    now,
    updated_at:    now
  };

  await setDoc(COLLECTION, docId, payload, options);
  return { id: docId, ...payload };
}

export async function updateFoodWaiterFirestore(waiterId, updateData, options = {}) {
  if (!waiterId) throw new RepositoryError('Waiter ID required for update', 'VALIDATION_ERROR', 400);
  const docId = String(waiterId).startsWith('fwtr_') ? String(waiterId) : `fwtr_${waiterId}`;

  const payload = {
    ...updateData,
    updated_at: new Date().toISOString()
  };

  return await updateDoc(COLLECTION, docId, payload, options);
}

export async function deleteFoodWaiterFirestore(waiterId, options = {}) {
  if (!waiterId) throw new RepositoryError('Waiter ID required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(waiterId).startsWith('fwtr_') ? String(waiterId) : `fwtr_${waiterId}`;
  return await deleteDoc(COLLECTION, docId, options);
}
