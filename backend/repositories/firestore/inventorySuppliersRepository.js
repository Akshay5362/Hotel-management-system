/**
 * inventorySuppliersRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore access for `inventory_suppliers` (Phase A).
 *
 * Document id: sup_<name-slug>   e.g. sup_vasanta_ram_kiryana
 * Fields:
 *   name, search_name (lowercased for search), contact_person, phone, whatsapp,
 *   email, address, gstin, payment_terms, notes, is_active,
 *   created_by, updated_by, created_at, updated_at
 *
 * Supplier data is only readable by MANAGE roles (see inventoryRoutes.js).
 */

import { getDoc, listDocs, setDoc, updateDoc, RepositoryError } from './firestoreUtils.js';
import { MASTER_LIST_FETCH_CAP } from '../../utils/inventoryConstants.js';

export const SUPPLIERS_COLLECTION = 'inventory_suppliers';

export function formatSupplierDocId(name) {
  const s = String(name || '').trim().toLowerCase();
  if (s.startsWith('sup_')) return s;
  return `sup_${s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

function cleanString(v, max = 300) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

export async function getInventorySupplierByIdFirestore(supplierId, options = {}) {
  if (!supplierId) return null;
  return await getDoc(SUPPLIERS_COLLECTION, formatSupplierDocId(supplierId), options);
}

/** Bounded fetch (MASTER_LIST_FETCH_CAP) ordered by name; filtering is done by the caller. */
export async function getAllInventorySuppliersFirestore(options = {}) {
  const { transaction = null } = options;
  return await listDocs(SUPPLIERS_COLLECTION, {
    orderBy: [{ field: 'name', direction: 'asc' }],
    limit: MASTER_LIST_FETCH_CAP,
    transaction
  });
}

export async function createInventorySupplierFirestore(supData, options = {}) {
  const name = cleanString(supData.name, 200);
  if (!name) throw new RepositoryError('Supplier name is required', 'VALIDATION_ERROR', 400);
  const docId = formatSupplierDocId(name);
  if (docId === 'sup_') throw new RepositoryError('Supplier name must contain letters or digits', 'VALIDATION_ERROR', 400);
  const existing = await getDoc(SUPPLIERS_COLLECTION, docId, options);
  if (existing) throw new RepositoryError(`Supplier '${name}' already exists`, 'DUPLICATE_KEY', 409);

  const now = new Date().toISOString();
  const payload = {
    name,
    search_name: name.toLowerCase(),
    contact_person: cleanString(supData.contact_person, 200),
    phone: cleanString(supData.phone, 40),
    whatsapp: cleanString(supData.whatsapp, 40),
    email: cleanString(supData.email, 200)?.toLowerCase() || null,
    address: cleanString(supData.address, 500),
    gstin: cleanString(supData.gstin, 20)?.toUpperCase() || null,
    payment_terms: cleanString(supData.payment_terms, 200),
    notes: cleanString(supData.notes, 1000),
    is_active: supData.is_active === undefined ? true : Boolean(supData.is_active),
    created_by: supData.created_by || null,
    updated_by: supData.updated_by || supData.created_by || null,
    created_at: now,
    updated_at: now
  };
  return await setDoc(SUPPLIERS_COLLECTION, docId, payload, { ...options, merge: false });
}

export async function updateInventorySupplierFirestore(supplierId, supData, options = {}) {
  const docId = formatSupplierDocId(supplierId);
  const existing = await getDoc(SUPPLIERS_COLLECTION, docId, options);
  if (!existing) throw new RepositoryError(`Supplier '${supplierId}' not found`, 'NOT_FOUND', 404);

  const payload = {};
  if (supData.name !== undefined) {
    const name = cleanString(supData.name, 200);
    if (!name) throw new RepositoryError('Supplier name cannot be empty', 'VALIDATION_ERROR', 400);
    payload.name = name;
    payload.search_name = name.toLowerCase();
  }
  for (const f of ['contact_person', 'phone', 'whatsapp', 'address', 'payment_terms', 'notes']) {
    if (supData[f] !== undefined) payload[f] = cleanString(supData[f], f === 'notes' ? 1000 : 500);
  }
  if (supData.email !== undefined) payload.email = cleanString(supData.email, 200)?.toLowerCase() || null;
  if (supData.gstin !== undefined) payload.gstin = cleanString(supData.gstin, 20)?.toUpperCase() || null;
  if (supData.is_active !== undefined) payload.is_active = Boolean(supData.is_active);
  payload.updated_by = supData.updated_by || null;
  payload.updated_at = new Date().toISOString();

  const result = await updateDoc(SUPPLIERS_COLLECTION, docId, payload, options);
  return { ...existing, ...result };
}

export async function deactivateInventorySupplierFirestore(supplierId, actor = null, options = {}) {
  return await updateInventorySupplierFirestore(supplierId, { is_active: false, updated_by: actor }, options);
}
