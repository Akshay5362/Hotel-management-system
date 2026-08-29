/**
 * backend/repositories/firestore/foodTablesRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore data-access layer for Food Tables Master.
 *
 * Dedicated collection:
 *   food_tables — restaurant table configurations (capacity, location, status).
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

const COLLECTION = 'food_tables';

export function generateFoodTableDocId(name) {
  const clean = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').slice(0, 30);
  return `ftbl_${clean || Date.now()}`;
}

export async function getFoodTableByIdFirestore(tableId, options = {}) {
  if (!tableId) return null;
  const docId = String(tableId).startsWith('ftbl_') ? String(tableId) : `ftbl_${tableId}`;
  return await getDoc(COLLECTION, docId, options);
}

export async function listFoodTablesFirestore(options = {}) {
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

export async function createFoodTableFirestore(tableData, options = {}) {
  validateRequiredFields(tableData, ['table_name'], 'FoodTable');

  const tableName = String(tableData.table_name).trim();
  const docId = tableData.table_id || generateFoodTableDocId(tableName);
  const now = new Date().toISOString();

  const payload = {
    table_id:      docId,
    table_name:    tableName,
    capacity:      Number(tableData.capacity || 4),
    location:      tableData.location ? String(tableData.location).trim() : 'Main Dining',
    is_active:     tableData.is_active !== false,
    display_order: Number(tableData.display_order || 0),
    created_at:    now,
    updated_at:    now
  };

  await setDoc(COLLECTION, docId, payload, options);
  return { id: docId, ...payload };
}

export async function updateFoodTableFirestore(tableId, updateData, options = {}) {
  if (!tableId) throw new RepositoryError('Table ID required for update', 'VALIDATION_ERROR', 400);
  const docId = String(tableId).startsWith('ftbl_') ? String(tableId) : `ftbl_${tableId}`;

  const payload = {
    ...updateData,
    updated_at: new Date().toISOString()
  };

  return await updateDoc(COLLECTION, docId, payload, options);
}

export async function deleteFoodTableFirestore(tableId, options = {}) {
  if (!tableId) throw new RepositoryError('Table ID required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(tableId).startsWith('ftbl_') ? String(tableId) : `ftbl_${tableId}`;
  return await deleteDoc(COLLECTION, docId, options);
}
