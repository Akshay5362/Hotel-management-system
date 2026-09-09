/**
 * inventoryMastersController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Units, locations and suppliers (Phase A master data).
 * "DELETE" always means deactivate — nothing referenced by products or by the
 * stock ledger is ever removed.
 */

import {
  getAllInventoryUnitsFirestore,
  createInventoryUnitFirestore,
  updateInventoryUnitFirestore,
  deactivateInventoryUnitFirestore,
  getInventoryUnitByCodeFirestore
} from '../repositories/firestore/inventoryUnitsRepository.js';
import {
  getAllInventoryLocationsFirestore,
  createInventoryLocationFirestore,
  updateInventoryLocationFirestore,
  deactivateInventoryLocationFirestore
} from '../repositories/firestore/inventoryLocationsRepository.js';
import {
  getAllInventorySuppliersFirestore,
  createInventorySupplierFirestore,
  updateInventorySupplierFirestore,
  deactivateInventorySupplierFirestore,
  getInventorySupplierByIdFirestore
} from '../repositories/firestore/inventorySuppliersRepository.js';
import { getActor, sendError, auditInventory } from './inventoryController.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../utils/inventoryConstants.js';

const truthy = (v) => v === true || String(v) === 'true';

// ── Units ────────────────────────────────────────────────────────────────────

export const getUnits = async (req, res) => {
  try {
    const units = await getAllInventoryUnitsFirestore({ includeInactive: req.query.include_inactive === 'true' });
    return res.json({ units });
  } catch (error) {
    return sendError(res, error, 'Failed to load units');
  }
};

export const createUnit = async (req, res) => {
  const b = req.body || {};
  const errors = [];
  if (!b.code || !String(b.code).trim()) errors.push('Unit code is required.');
  if (String(b.code || '').trim().length > 12) errors.push('Unit code must be 12 characters or fewer.');
  if (b.factor !== undefined && b.factor !== '' && !(Number(b.factor) > 0)) errors.push('Factor must be a positive number.');
  if (b.base_unit) {
    const base = await getInventoryUnitByCodeFirestore(b.base_unit);
    if (!base) errors.push(`Base unit '${b.base_unit}' does not exist.`);
  }
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });
  try {
    const unit = await createInventoryUnitFirestore({ ...b, allow_decimal: b.allow_decimal === undefined ? true : truthy(b.allow_decimal), created_by: getActor(req).uid });
    await auditInventory(req, 'INVENTORY_UNIT_CREATED', { unit_id: unit.id, code: unit.code });
    return res.status(201).json({ message: 'Unit created.', unit });
  } catch (error) {
    return sendError(res, error, 'Failed to create unit');
  }
};

export const updateUnit = async (req, res) => {
  const b = req.body || {};
  if (b.factor !== undefined && !(Number(b.factor) > 0)) return res.status(400).json({ error: 'Factor must be a positive number.' });
  if (b.name !== undefined && !String(b.name).trim()) return res.status(400).json({ error: 'Unit name cannot be empty.' });
  try {
    const payload = { ...b, updated_by: getActor(req).uid };
    if (b.allow_decimal !== undefined) payload.allow_decimal = truthy(b.allow_decimal);
    if (b.is_active !== undefined) payload.is_active = truthy(b.is_active);
    delete payload.code; // codes are immutable (they are the document id)
    const unit = await updateInventoryUnitFirestore(req.params.id, payload);
    await auditInventory(req, 'INVENTORY_UNIT_UPDATED', { unit_id: unit.id, fields: Object.keys(b) });
    return res.json({ message: 'Unit updated.', unit });
  } catch (error) {
    return sendError(res, error, 'Failed to update unit');
  }
};

export const deleteUnit = async (req, res) => {
  try {
    const unit = await deactivateInventoryUnitFirestore(req.params.id, getActor(req).uid);
    await auditInventory(req, 'INVENTORY_UNIT_DEACTIVATED', { unit_id: unit.id });
    return res.json({ success: true, message: 'Unit deactivated.', unit });
  } catch (error) {
    return sendError(res, error, 'Failed to deactivate unit');
  }
};

// ── Locations ────────────────────────────────────────────────────────────────

export const getLocations = async (req, res) => {
  try {
    const locations = await getAllInventoryLocationsFirestore({ includeInactive: req.query.include_inactive === 'true' });
    return res.json({ locations });
  } catch (error) {
    return sendError(res, error, 'Failed to load locations');
  }
};

export const createLocation = async (req, res) => {
  const b = req.body || {};
  const errors = [];
  if (!b.code || !String(b.code).trim()) errors.push('Location code is required.');
  if (!b.name || !String(b.name).trim()) errors.push('Location name is required.');
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });
  try {
    const location = await createInventoryLocationFirestore({ ...b, is_default: truthy(b.is_default), created_by: getActor(req).uid });
    await auditInventory(req, 'INVENTORY_LOCATION_CREATED', { location_id: location.id, code: location.code });
    return res.status(201).json({ message: 'Location created.', location });
  } catch (error) {
    return sendError(res, error, 'Failed to create location');
  }
};

export const updateLocation = async (req, res) => {
  const b = req.body || {};
  try {
    const payload = { ...b, updated_by: getActor(req).uid };
    if (b.is_default !== undefined) payload.is_default = truthy(b.is_default);
    if (b.is_active !== undefined) payload.is_active = truthy(b.is_active);
    delete payload.code;
    const location = await updateInventoryLocationFirestore(req.params.id, payload);
    await auditInventory(req, 'INVENTORY_LOCATION_UPDATED', { location_id: location.id, fields: Object.keys(b) });
    return res.json({ message: 'Location updated.', location });
  } catch (error) {
    return sendError(res, error, 'Failed to update location');
  }
};

export const deleteLocation = async (req, res) => {
  try {
    const location = await deactivateInventoryLocationFirestore(req.params.id, getActor(req).uid);
    await auditInventory(req, 'INVENTORY_LOCATION_DEACTIVATED', { location_id: location.id });
    return res.json({ success: true, message: 'Location deactivated. Existing stock at this location stays in the ledger.', location });
  } catch (error) {
    return sendError(res, error, 'Failed to deactivate location');
  }
};

// ── Suppliers ────────────────────────────────────────────────────────────────

/** GET /api/inventory/suppliers?search&include_inactive&page&page_size */
export const getSuppliers = async (req, res) => {
  try {
    let list = await getAllInventorySuppliersFirestore();
    if (req.query.include_inactive !== 'true') list = list.filter(s => s.is_active !== false);
    if (req.query.search && String(req.query.search).trim()) {
      const q = String(req.query.search).trim().toLowerCase();
      list = list.filter(s =>
        (s.search_name || s.name || '').toLowerCase().includes(q) ||
        (s.contact_person || '').toLowerCase().includes(q) ||
        (s.phone || '').includes(q) ||
        (s.gstin || '').toLowerCase().includes(q)
      );
    }
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.page_size, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const total = list.length;
    const total_pages = Math.max(Math.ceil(total / pageSize), 1);
    const safePage = Math.min(page, total_pages);
    const start = (safePage - 1) * pageSize;
    return res.json({ suppliers: list.slice(start, start + pageSize), page: safePage, page_size: pageSize, total, total_pages });
  } catch (error) {
    return sendError(res, error, 'Failed to load suppliers');
  }
};

export const getSupplierById = async (req, res) => {
  try {
    const supplier = await getInventorySupplierByIdFirestore(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found.' });
    return res.json({ supplier });
  } catch (error) {
    return sendError(res, error, 'Failed to load supplier');
  }
};

function validateSupplier(b, partial = false) {
  const errors = [];
  if (!partial || b.name !== undefined) {
    if (!b.name || !String(b.name).trim()) errors.push('Supplier name is required.');
  }
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim())) errors.push('Email address is not valid.');
  if (b.phone && !/^[0-9+\-\s()]{6,20}$/.test(String(b.phone).trim())) errors.push('Phone number is not valid.');
  if (b.whatsapp && !/^[0-9+\-\s()]{6,20}$/.test(String(b.whatsapp).trim())) errors.push('WhatsApp number is not valid.');
  if (b.gstin && !/^[0-9A-Z]{15}$/i.test(String(b.gstin).trim())) errors.push('GSTIN must be 15 characters.');
  return errors;
}

export const createSupplier = async (req, res) => {
  const b = req.body || {};
  const errors = validateSupplier(b);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });
  try {
    const supplier = await createInventorySupplierFirestore({ ...b, created_by: getActor(req).uid });
    await auditInventory(req, 'INVENTORY_SUPPLIER_CREATED', { supplier_id: supplier.id, name: supplier.name });
    return res.status(201).json({ message: 'Supplier created.', supplier });
  } catch (error) {
    return sendError(res, error, 'Failed to create supplier');
  }
};

export const updateSupplier = async (req, res) => {
  const b = req.body || {};
  const errors = validateSupplier(b, true);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });
  try {
    const payload = { ...b, updated_by: getActor(req).uid };
    if (b.is_active !== undefined) payload.is_active = truthy(b.is_active);
    const supplier = await updateInventorySupplierFirestore(req.params.id, payload);
    await auditInventory(req, 'INVENTORY_SUPPLIER_UPDATED', { supplier_id: supplier.id, fields: Object.keys(b) });
    return res.json({ message: 'Supplier updated.', supplier });
  } catch (error) {
    return sendError(res, error, 'Failed to update supplier');
  }
};

export const deleteSupplier = async (req, res) => {
  try {
    const supplier = await deactivateInventorySupplierFirestore(req.params.id, getActor(req).uid);
    await auditInventory(req, 'INVENTORY_SUPPLIER_DEACTIVATED', { supplier_id: supplier.id });
    return res.json({ success: true, message: 'Supplier deactivated.', supplier });
  } catch (error) {
    return sendError(res, error, 'Failed to deactivate supplier');
  }
};
