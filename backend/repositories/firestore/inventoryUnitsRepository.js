/**
 * inventoryUnitsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore access for `inventory_units` (Phase A).
 *
 * Document id: unit_<code-slug>   e.g. unit_kg, unit_ltr, unit_btl
 * Fields:
 *   code          UPPERCASE short code shown to users (KG, LTR, PC, PKT, BOX, BTL, NOS, REAM)
 *   name          human name
 *   base_unit     code of the unit this converts to (null = itself). Reserved
 *                 for a later conversion phase — no automatic conversion happens yet.
 *   factor        multiplier to base_unit (1 when base_unit is null)
 *   allow_decimal decimal quantities permitted (default true)
 *   is_active, created_by, updated_by, created_at, updated_at
 */

import { getDoc, listDocs, setDoc, updateDoc, RepositoryError } from './firestoreUtils.js';
import { globalTtlCache } from '../../utils/ttlCache.js';

export const UNITS_COLLECTION = 'inventory_units';
const CACHE_KEY = 'inventory_units_all';

export function formatUnitDocId(code) {
  const s = String(code || '').trim().toLowerCase();
  if (s.startsWith('unit_')) return s;
  return `unit_${s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

export function normalizeUnitCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\.+$/, '');
}

export function invalidateInventoryUnitsCache() {
  globalTtlCache.deleteByPrefix('inventory_units');
}

export async function getInventoryUnitByIdFirestore(unitId, options = {}) {
  if (!unitId) return null;
  return await getDoc(UNITS_COLLECTION, formatUnitDocId(unitId), options);
}

export async function getInventoryUnitByCodeFirestore(code, options = {}) {
  if (!code) return null;
  return await getDoc(UNITS_COLLECTION, formatUnitDocId(normalizeUnitCode(code)), options);
}

/** Lists units ordered by code. Cached for 10 minutes unless `skipCache`/`transaction`. */
export async function getAllInventoryUnitsFirestore(options = {}) {
  const { transaction = null, skipCache = false, includeInactive = true } = options;
  const load = () => listDocs(UNITS_COLLECTION, { orderBy: [{ field: 'code', direction: 'asc' }], limit: 500, transaction });
  const docs = (transaction || skipCache)
    ? await load()
    : await globalTtlCache.getOrSet(CACHE_KEY, load, 600000);
  return includeInactive ? docs : docs.filter(u => u.is_active !== false);
}

export async function createInventoryUnitFirestore(unitData, options = {}) {
  const code = normalizeUnitCode(unitData.code);
  if (!code) throw new RepositoryError('Unit code is required', 'VALIDATION_ERROR', 400);
  const docId = formatUnitDocId(code);
  const existing = await getDoc(UNITS_COLLECTION, docId, options);
  if (existing) throw new RepositoryError(`Unit '${code}' already exists`, 'DUPLICATE_KEY', 409);

  const now = new Date().toISOString();
  const payload = {
    code,
    name: String(unitData.name || code).trim(),
    base_unit: unitData.base_unit ? normalizeUnitCode(unitData.base_unit) : null,
    factor: Number.isFinite(Number(unitData.factor)) && Number(unitData.factor) > 0 ? Number(unitData.factor) : 1,
    allow_decimal: unitData.allow_decimal === undefined ? true : Boolean(unitData.allow_decimal),
    is_active: unitData.is_active === undefined ? true : Boolean(unitData.is_active),
    created_by: unitData.created_by || null,
    updated_by: unitData.updated_by || unitData.created_by || null,
    created_at: now,
    updated_at: now
  };
  const result = await setDoc(UNITS_COLLECTION, docId, payload, { ...options, merge: false });
  invalidateInventoryUnitsCache();
  return result;
}

export async function updateInventoryUnitFirestore(unitId, unitData, options = {}) {
  const docId = formatUnitDocId(unitId);
  const existing = await getDoc(UNITS_COLLECTION, docId, options);
  if (!existing) throw new RepositoryError(`Unit '${unitId}' not found`, 'NOT_FOUND', 404);

  const payload = {};
  if (unitData.name !== undefined) payload.name = String(unitData.name).trim();
  if (unitData.base_unit !== undefined) payload.base_unit = unitData.base_unit ? normalizeUnitCode(unitData.base_unit) : null;
  if (unitData.factor !== undefined) payload.factor = Number(unitData.factor);
  if (unitData.allow_decimal !== undefined) payload.allow_decimal = Boolean(unitData.allow_decimal);
  if (unitData.is_active !== undefined) payload.is_active = Boolean(unitData.is_active);
  payload.updated_by = unitData.updated_by || null;
  payload.updated_at = new Date().toISOString();

  const result = await updateDoc(UNITS_COLLECTION, docId, payload, options);
  invalidateInventoryUnitsCache();
  return { ...existing, ...result };
}

export async function deactivateInventoryUnitFirestore(unitId, actor = null, options = {}) {
  return await updateInventoryUnitFirestore(unitId, { is_active: false, updated_by: actor }, options);
}
