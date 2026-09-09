/**
 * inventoryLocationsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore access for `inventory_locations` (Phase A).
 *
 * Document id: loc_<code-slug>   e.g. loc_main_store, loc_kitchen
 * Fields:
 *   code, name, department, is_active, is_default,
 *   created_by, updated_by, created_at, updated_at
 *
 * `is_default` marks the location used when a caller does not specify one
 * (e.g. opening stock entered from the item form). At most one location
 * should be default; the repository enforces this on write.
 */

import { getDoc, listDocs, setDoc, updateDoc, RepositoryError } from './firestoreUtils.js';
import { globalTtlCache } from '../../utils/ttlCache.js';

export const LOCATIONS_COLLECTION = 'inventory_locations';
const CACHE_KEY = 'inventory_locations_all';

export function formatLocationDocId(code) {
  const s = String(code || '').trim().toLowerCase();
  if (s.startsWith('loc_')) return s;
  return `loc_${s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

export function invalidateInventoryLocationsCache() {
  globalTtlCache.deleteByPrefix('inventory_locations');
}

export async function getInventoryLocationByIdFirestore(locationId, options = {}) {
  if (!locationId) return null;
  return await getDoc(LOCATIONS_COLLECTION, formatLocationDocId(locationId), options);
}

export async function getAllInventoryLocationsFirestore(options = {}) {
  const { transaction = null, skipCache = false, includeInactive = true } = options;
  const load = () => listDocs(LOCATIONS_COLLECTION, { orderBy: [{ field: 'name', direction: 'asc' }], limit: 500, transaction });
  const docs = (transaction || skipCache)
    ? await load()
    : await globalTtlCache.getOrSet(CACHE_KEY, load, 600000);
  return includeInactive ? docs : docs.filter(l => l.is_active !== false);
}

export async function getDefaultInventoryLocationFirestore(options = {}) {
  const all = await getAllInventoryLocationsFirestore({ ...options, includeInactive: false });
  return all.find(l => l.is_default === true) || null;
}

async function clearOtherDefaults(exceptDocId, options) {
  const all = await getAllInventoryLocationsFirestore({ ...options, skipCache: true });
  for (const loc of all) {
    if (loc.id !== exceptDocId && loc.is_default === true) {
      await updateDoc(LOCATIONS_COLLECTION, loc.id, { is_default: false, updated_at: new Date().toISOString() }, options);
    }
  }
}

export async function createInventoryLocationFirestore(locData, options = {}) {
  const code = String(locData.code || '').trim().toUpperCase();
  const name = String(locData.name || '').trim();
  if (!code) throw new RepositoryError('Location code is required', 'VALIDATION_ERROR', 400);
  if (!name) throw new RepositoryError('Location name is required', 'VALIDATION_ERROR', 400);
  const docId = formatLocationDocId(code);
  const existing = await getDoc(LOCATIONS_COLLECTION, docId, options);
  if (existing) throw new RepositoryError(`Location '${code}' already exists`, 'DUPLICATE_KEY', 409);

  const now = new Date().toISOString();
  const payload = {
    code,
    name,
    department: locData.department ? String(locData.department).trim() : 'General',
    is_active: locData.is_active === undefined ? true : Boolean(locData.is_active),
    is_default: Boolean(locData.is_default),
    created_by: locData.created_by || null,
    updated_by: locData.updated_by || locData.created_by || null,
    created_at: now,
    updated_at: now
  };
  const result = await setDoc(LOCATIONS_COLLECTION, docId, payload, { ...options, merge: false });
  if (payload.is_default) await clearOtherDefaults(docId, options);
  invalidateInventoryLocationsCache();
  return result;
}

export async function updateInventoryLocationFirestore(locationId, locData, options = {}) {
  const docId = formatLocationDocId(locationId);
  const existing = await getDoc(LOCATIONS_COLLECTION, docId, options);
  if (!existing) throw new RepositoryError(`Location '${locationId}' not found`, 'NOT_FOUND', 404);

  const payload = {};
  if (locData.name !== undefined) {
    const name = String(locData.name).trim();
    if (!name) throw new RepositoryError('Location name cannot be empty', 'VALIDATION_ERROR', 400);
    payload.name = name;
  }
  if (locData.department !== undefined) payload.department = String(locData.department || 'General').trim();
  if (locData.is_active !== undefined) payload.is_active = Boolean(locData.is_active);
  if (locData.is_default !== undefined) payload.is_default = Boolean(locData.is_default);
  payload.updated_by = locData.updated_by || null;
  payload.updated_at = new Date().toISOString();

  const result = await updateDoc(LOCATIONS_COLLECTION, docId, payload, options);
  if (payload.is_default === true) await clearOtherDefaults(docId, options);
  invalidateInventoryLocationsCache();
  return { ...existing, ...result };
}

export async function deactivateInventoryLocationFirestore(locationId, actor = null, options = {}) {
  return await updateInventoryLocationFirestore(locationId, { is_active: false, is_default: false, updated_by: actor }, options);
}
