/**
 * inventoryController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Controller handlers for Inventory Categories and the Product/Item master.
 * Units, locations and suppliers live in inventoryMastersController.js;
 * stock, movements and transfers in inventoryStockController.js.
 */

import { InventoryCutoverService } from '../services/inventoryCutoverService.js';
import { getInventoryCategoryByIdFirestore } from '../repositories/firestore/inventoryCategoriesRepository.js';
import { getInventoryUnitByCodeFirestore } from '../repositories/firestore/inventoryUnitsRepository.js';
import { getInventorySupplierByIdFirestore } from '../repositories/firestore/inventorySuppliersRepository.js';
import { getInventoryLocationByIdFirestore, getDefaultInventoryLocationFirestore } from '../repositories/firestore/inventoryLocationsRepository.js';
import { removeOldProductPhoto } from '../middleware/inventoryUploadMiddleware.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { roundQuantity } from '../utils/inventoryConstants.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Actor identity from the authenticated request (used for created_by / audit). */
export function getActor(req) {
  const u = req.user || {};
  return {
    uid: u.uid || (u.id !== undefined && u.id !== null ? String(u.id) : null) || u.username || null,
    name: u.full_name || u.name || u.username || u.email || null,
    // H7 — the role the request was authorized under. Several audit writers
    // already recorded `actor_role`, but this helper did not carry it, so every
    // one of them stored null. Additive: nothing reads the actor by shape.
    role: u.role || null
  };
}

export function sendError(res, error, fallback = 'Internal Server Error') {
  const status = error?.status || (error?.code === 'INSUFFICIENT_STOCK' ? 400 : null) || 500;
  if (status >= 500) {
    console.error(`[Inventory] ${fallback}:`, error);
    return res.status(500).json({ error: fallback });
  }
  return res.status(status).json({ error: error.message, code: error.code || undefined });
}

export async function auditInventory(req, action, details, explicitId = null, businessDate = null) {
  try {
    const actor = getActor(req);
    await createAuditLogFirestore({
      log_id: explicitId ? `inv_${explicitId}` : `inv_${action.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      action,
      details: { ...details, actor_name: actor.name, actor_role: actor.role },
      user_id: actor.uid || 'unknown',
      // Optional: the repository falls back to today's date when it is absent,
      // which is right for master-data edits but wrong for anything tied to a
      // trading day. Callers that know the business date now pass it.
      ...(businessDate ? { business_date: businessDate } : {})
    });
  } catch (err) {
    console.warn(`[Inventory] audit log failed (${action}): ${err.message}`);
  }
}

function parseNonNegative(value, label, errors, { required = false, decimals = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push(`${label} is required.`);
    return undefined;
  }
  const n = decimals ? roundQuantity(value) : Number(value);
  if (!Number.isFinite(n) || n < 0) errors.push(`${label} cannot be negative.`);
  return n;
}

// ── Categories ───────────────────────────────────────────────────────────────

/** GET /api/inventory/categories?include_inactive=true */
export const getCategories = async (req, res) => {
  try {
    const result = await InventoryCutoverService.getCategories({ includeInactive: req.query.include_inactive === 'true' });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Failed to load categories');
  }
};

/** POST /api/inventory/categories */
export const createCategory = async (req, res) => {
  const { name, department, description } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required.' });
  }
  try {
    const category = await InventoryCutoverService.createCategory({ name, department, description }, getActor(req).uid);
    await auditInventory(req, 'INVENTORY_CATEGORY_CREATED', { category_id: category.id, name: category.name });
    return res.status(201).json({ message: 'Category created successfully.', category });
  } catch (error) {
    return sendError(res, error, 'Failed to create category');
  }
};

/** PUT /api/inventory/categories/:id */
export const updateCategory = async (req, res) => {
  const { id } = req.params;
  const { name, department, description, is_active } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'Category name cannot be empty.' });
  }
  try {
    const category = await InventoryCutoverService.updateCategory(id, { name, department, description, is_active }, getActor(req).uid);
    await auditInventory(req, 'INVENTORY_CATEGORY_UPDATED', { category_id: category.id, name: category.name, is_active: category.is_active });
    return res.json({ message: 'Category updated successfully.', category });
  } catch (error) {
    return sendError(res, error, 'Failed to update category');
  }
};

/** DELETE /api/inventory/categories/:id → deactivate (never a hard delete). */
export const deleteCategory = async (req, res) => {
  try {
    const result = await InventoryCutoverService.deactivateCategory(req.params.id, getActor(req).uid);
    await auditInventory(req, 'INVENTORY_CATEGORY_DEACTIVATED', { category_id: result.category.id });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Failed to deactivate category');
  }
};

// ── Products ─────────────────────────────────────────────────────────────────

/** GET /api/inventory/products?search&category_id&status&stock_status&low_stock&page&page_size */
export const getProducts = async (req, res) => {
  try {
    const result = await InventoryCutoverService.getProducts(req.query);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Failed to load products');
  }
};

/** GET /api/inventory/products/:id */
export const getProductById = async (req, res) => {
  try {
    const product = await InventoryCutoverService.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    return res.json({ product });
  } catch (error) {
    return sendError(res, error, 'Failed to load product');
  }
};

/**
 * Validates the master-data part of a product payload against live reference
 * data. Returns { errors, resolved } where resolved carries canonical ids.
 */
export async function validateProductPayload(body, { partial = false } = {}) {
  const errors = [];
  const resolved = {};

  if (!partial || body.name !== undefined) {
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) errors.push('Product name is required.');
    else resolved.name = body.name.trim();
  }

  if (!partial || body.category_id !== undefined) {
    if (!body.category_id) errors.push('Category is required.');
    else {
      const cat = await getInventoryCategoryByIdFirestore(body.category_id);
      if (!cat) errors.push(`Category '${body.category_id}' does not exist.`);
      else if (cat.is_active === false) errors.push(`Category '${cat.name}' is inactive.`);
      else resolved.category_id = cat.id;
    }
  }

  if (!partial || body.unit_of_measure !== undefined) {
    if (!body.unit_of_measure) errors.push('Unit of measure is required.');
    else {
      const unit = await getInventoryUnitByCodeFirestore(body.unit_of_measure);
      if (!unit) errors.push(`Unit '${body.unit_of_measure}' does not exist. Create it under Inventory → Units first.`);
      else if (unit.is_active === false) errors.push(`Unit '${unit.code}' is inactive.`);
      else resolved.unit_of_measure = unit.code;
    }
  }

  const min = parseNonNegative(body.minimum_stock_level, 'Minimum stock level', errors);
  if (min !== undefined) resolved.minimum_stock_level = min;

  const cost = parseNonNegative(body.cost_price !== undefined ? body.cost_price : body.unit_price, 'Cost price', errors, { decimals: false });
  if (cost !== undefined) resolved.cost_price = cost;

  if (body.default_supplier_id !== undefined) {
    if (!body.default_supplier_id) resolved.default_supplier_id = null;
    else {
      const sup = await getInventorySupplierByIdFirestore(body.default_supplier_id);
      if (!sup) errors.push(`Supplier '${body.default_supplier_id}' does not exist.`);
      else resolved.default_supplier_id = sup.id;
    }
  }

  if (body.is_active !== undefined) resolved.is_active = String(body.is_active) === 'true' || body.is_active === true;
  else if (body.status !== undefined) {
    if (!['Active', 'Inactive'].includes(body.status)) errors.push('Status must be Active or Inactive.');
    else resolved.is_active = body.status === 'Active';
  }

  return { errors, resolved };
}

/** POST /api/inventory/products  (multipart; optional `photo`) */
export const createProduct = async (req, res) => {
  try {
    const body = req.body || {};
    const { errors, resolved } = await validateProductPayload(body);

    if (!body.sku || typeof body.sku !== 'string' || !body.sku.trim()) errors.push('SKU is required.');

    // Opening stock (alias: current_stock for the legacy form field)
    const openingRaw = body.opening_stock !== undefined ? body.opening_stock : body.current_stock;
    const openingStock = parseNonNegative(openingRaw, 'Opening stock', errors);
    let openingLocationId = null;
    if (openingStock > 0) {
      if (body.opening_location_id) {
        const loc = await getInventoryLocationByIdFirestore(body.opening_location_id);
        if (!loc) errors.push(`Location '${body.opening_location_id}' does not exist.`);
        else if (loc.is_active === false) errors.push(`Location '${loc.name}' is inactive.`);
        else openingLocationId = loc.id;
      } else {
        const def = await getDefaultInventoryLocationFirestore();
        if (!def) errors.push('Opening stock needs a location: pass opening_location_id or mark one location as default.');
        else openingLocationId = def.id;
      }
    }

    if (errors.length > 0) return res.status(400).json({ error: 'Validation failed.', details: errors });

    const photo_url = req.file ? `/inventory-photos/${req.file.filename}` : null;
    const actor = getActor(req);
    const result = await InventoryCutoverService.createProduct({
      sku: body.sku,
      ...resolved,
      photo_url,
      opening_stock: openingStock || 0,
      opening_location_id: openingLocationId
    }, actor);

    await auditInventory(req, 'INVENTORY_PRODUCT_CREATED', { product_id: result.product?.id, sku: result.product?.sku, opening_stock: openingStock || 0, opening_location_id: openingLocationId });
    return res.status(201).json({ message: 'Product created successfully.', ...result });
  } catch (error) {
    if (error.status === 409 || error.code === 'ER_DUP_ENTRY' || error.code === 'DUPLICATE_KEY') {
      return res.status(409).json({ error: `Product with SKU '${String(req.body?.sku || '').trim().toUpperCase()}' already exists.` });
    }
    return sendError(res, error, 'Failed to create product');
  }
};

/** PUT /api/inventory/products/:id  (multipart; optional `photo`). Stock fields are ignored. */
export const updateProduct = async (req, res) => {
  const { id } = req.params;
  try {
    const body = req.body || {};
    const { errors, resolved } = await validateProductPayload(body, { partial: true });
    if (errors.length > 0) return res.status(400).json({ error: 'Validation failed.', details: errors });

    const existing = await InventoryCutoverService.getProductById(id);
    if (!existing) return res.status(404).json({ error: 'Product not found.' });

    if (req.file) resolved.photo_url = `/inventory-photos/${req.file.filename}`;

    const result = await InventoryCutoverService.updateProduct(existing.id, resolved, getActor(req));
    if (req.file && existing.photo_url && existing.photo_url !== resolved.photo_url) {
      await removeOldProductPhoto(existing.photo_url);
    }
    await auditInventory(req, 'INVENTORY_PRODUCT_UPDATED', { product_id: existing.id, sku: existing.sku, fields: Object.keys(resolved) });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Failed to update product');
  }
};

/** DELETE /api/inventory/products/:id → soft deactivate. */
export const deleteProduct = async (req, res) => {
  try {
    const result = await InventoryCutoverService.deleteProduct(req.params.id, getActor(req));
    await auditInventory(req, 'INVENTORY_PRODUCT_DEACTIVATED', { product_id: req.params.id });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Failed to deactivate product');
  }
};
