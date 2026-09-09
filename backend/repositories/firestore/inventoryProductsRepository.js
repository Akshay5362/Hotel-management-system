/**
 * inventoryProductsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore access for `inventory_products`.
 *
 * Document id: prod_<sku-slug> (unchanged — existing documents keep working).
 *
 * ── Stock model (Phase A) ────────────────────────────────────────────────────
 *   • `inventory_stock_movements` is the LEDGER — the authoritative history.
 *   • `stock_by_location` { <location_id>: qty } is the per-location BALANCE,
 *     derived from the ledger and updated ONLY inside
 *     inventoryStockService transactions.
 *   • `current_stock` is the CACHED TOTAL across all locations (sum of
 *     stock_by_location), also written only by the stock service.
 *   Nothing else may write current_stock / stock_by_location / last_movement_at.
 *
 * ── Authoritative vs legacy fields ───────────────────────────────────────────
 *   authoritative            legacy alias (read-only fallback, never written)
 *   current_stock            stock_quantity, quantity
 *   minimum_stock_level      reorder_level
 *   unit_of_measure          unit
 *   cost_price               unit_price   (unit_price is still MIRRORED on write
 *                                          because the existing UI displays it)
 *   is_active                status ('Active'|'Inactive', mirrored on write)
 * `normalizeProductDoc()` resolves the authoritative value with the legacy
 * fallback so documents created before Phase A still read correctly.
 */

import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  formatProductDocId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';
import { MASTER_LIST_FETCH_CAP, roundQuantity } from '../../utils/inventoryConstants.js';

const COLLECTION = 'inventory_products';

/** Fields only the stock service may write. */
export const STOCK_MANAGED_FIELDS = Object.freeze(['current_stock', 'stock_by_location', 'last_movement_at', 'stock_quantity', 'quantity']);

/**
 * Resolves authoritative fields from a raw Firestore document (legacy-aware).
 * Returns a NEW object; never mutates the input.
 */
export function normalizeProductDoc(doc) {
  if (!doc) return null;
  const currentStock = doc.current_stock !== undefined ? doc.current_stock : (doc.stock_quantity !== undefined ? doc.stock_quantity : (doc.quantity || 0));
  const minLevel = doc.minimum_stock_level !== undefined ? doc.minimum_stock_level : (doc.reorder_level || 0);
  const isActive = doc.is_active !== undefined ? Boolean(doc.is_active) : String(doc.status || 'Active') !== 'Inactive';
  const costPrice = doc.cost_price !== undefined ? doc.cost_price : (doc.unit_price || 0);
  return {
    ...doc,
    id: doc.id,
    sku: doc.sku || '',
    name: doc.name || '',
    category_id: doc.category_id !== undefined && doc.category_id !== null ? String(doc.category_id) : (doc.mysql_category_id ? String(doc.mysql_category_id) : null),
    unit_of_measure: doc.unit_of_measure || doc.unit || 'PC',
    current_stock: roundQuantity(currentStock) || 0,
    stock_by_location: doc.stock_by_location && typeof doc.stock_by_location === 'object' ? { ...doc.stock_by_location } : {},
    minimum_stock_level: roundQuantity(minLevel) || 0,
    cost_price: Number(costPrice) || 0,
    unit_price: Number(doc.unit_price !== undefined ? doc.unit_price : costPrice) || 0,
    default_supplier_id: doc.default_supplier_id || null,
    photo_url: doc.photo_url || null,
    is_active: isActive,
    status: isActive ? 'Active' : 'Inactive',
    created_by: doc.created_by || null,
    updated_by: doc.updated_by || null,
    created_at: doc.created_at || null,
    updated_at: doc.updated_at || null,
    last_movement_at: doc.last_movement_at || null
  };
}

export function productDocIdFor(productIdOrSku) {
  return String(productIdOrSku).startsWith('prod_') ? String(productIdOrSku).toLowerCase() : formatProductDocId(productIdOrSku);
}

export async function getInventoryProductByIdFirestore(productId, options = {}) {
  if (!productId) return null;
  const docId = productDocIdFor(productId);
  const direct = await getDoc(COLLECTION, docId, options);
  if (direct) return direct;

  if (!isNaN(Number(productId))) {
    const byMySqlId = await listDocs(COLLECTION, {
      filters: [{ field: 'mysql_product_id', op: '==', value: Number(productId) }],
      limit: 1,
      transaction: options.transaction
    });
    if (byMySqlId[0]) return byMySqlId[0];
  }
  return null;
}

export async function getInventoryProductBySkuFirestore(sku, options = {}) {
  if (!sku) return null;
  const docId = formatProductDocId(sku);
  const byDoc = await getDoc(COLLECTION, docId, options);
  if (byDoc) return byDoc;

  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'sku', op: '==', value: String(sku).trim().toUpperCase() }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

/**
 * Bounded fetch (MASTER_LIST_FETCH_CAP, ordered by name). Callers filter and
 * paginate in memory — see InventoryCutoverService.getProducts / getStock.
 */
export async function getAllInventoryProductsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'name', direction: 'asc' }], limit = MASTER_LIST_FETCH_CAP, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

/**
 * Creates a product with ZERO stock. Opening stock is applied afterwards by
 * inventoryStockService.applyMovement({ movement_type: 'OPENING' }) so the
 * ledger and the balance never disagree.
 */
export async function createInventoryProductFirestore(prodData, options = {}) {
  validateRequiredFields(prodData, ['name', 'sku'], 'InventoryProduct');
  const skuStr = String(prodData.sku).trim().toUpperCase();
  const docId = formatProductDocId(skuStr);

  const existing = await getDoc(COLLECTION, docId, options);
  if (existing) {
    throw new RepositoryError(`Product with SKU '${skuStr}' already exists`, 'DUPLICATE_KEY', 409);
  }

  const now = new Date().toISOString();
  const isActive = prodData.is_active === undefined
    ? String(prodData.status || 'Active') !== 'Inactive'
    : Boolean(prodData.is_active);
  const costPrice = Number(prodData.cost_price !== undefined ? prodData.cost_price : (prodData.unit_price || 0)) || 0;

  const payload = {
    name: String(prodData.name).trim(),
    sku: skuStr,
    category_id: prodData.category_id ? String(prodData.category_id) : null,
    mysql_category_id: prodData.mysql_category_id || null,
    unit_of_measure: String(prodData.unit_of_measure || 'PC').trim().toUpperCase(),
    unit: String(prodData.unit_of_measure || 'PC').trim().toUpperCase(), // legacy mirror
    current_stock: 0,
    stock_quantity: 0,                   // legacy mirror of current_stock
    stock_by_location: {},
    minimum_stock_level: roundQuantity(prodData.minimum_stock_level !== undefined ? prodData.minimum_stock_level : 0) || 0,
    reorder_level: roundQuantity(prodData.minimum_stock_level !== undefined ? prodData.minimum_stock_level : 0) || 0, // legacy mirror
    cost_price: costPrice,
    unit_price: costPrice,               // legacy mirror (display only)
    default_supplier_id: prodData.default_supplier_id || null,
    photo_url: prodData.photo_url || null,
    is_active: isActive,
    status: isActive ? 'Active' : 'Inactive', // legacy mirror
    mysql_product_id: prodData.mysql_product_id || null,
    created_by: prodData.created_by || null,
    updated_by: prodData.updated_by || prodData.created_by || null,
    created_at: now,
    updated_at: now,
    last_movement_at: null
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: false });
}

/**
 * Updates master-data fields only. Stock-managed fields are stripped here as a
 * hard guarantee, whatever the caller passed.
 */
export async function updateInventoryProductFirestore(productId, prodData, options = {}) {
  if (!productId) throw new RepositoryError('Product ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = productDocIdFor(productId);

  const existing = await getDoc(COLLECTION, docId, options);
  if (!existing) throw new RepositoryError(`Inventory product '${productId}' not found`, 'NOT_FOUND', 404);

  const payload = {};
  const src = typeof prodData === 'object' && prodData !== null ? prodData : {};
  if (src.name !== undefined) payload.name = String(src.name).trim();
  if (src.category_id !== undefined) payload.category_id = src.category_id ? String(src.category_id) : null;
  if (src.unit_of_measure !== undefined) {
    payload.unit_of_measure = String(src.unit_of_measure).trim().toUpperCase();
    payload.unit = payload.unit_of_measure; // legacy mirror
  }
  if (src.minimum_stock_level !== undefined) {
    payload.minimum_stock_level = roundQuantity(src.minimum_stock_level) || 0;
    payload.reorder_level = payload.minimum_stock_level; // legacy mirror
  }
  if (src.cost_price !== undefined || src.unit_price !== undefined) {
    const cp = Number(src.cost_price !== undefined ? src.cost_price : src.unit_price) || 0;
    payload.cost_price = cp;
    payload.unit_price = cp;
  }
  if (src.default_supplier_id !== undefined) payload.default_supplier_id = src.default_supplier_id || null;
  if (src.photo_url !== undefined) payload.photo_url = src.photo_url || null;
  if (src.is_active !== undefined || src.status !== undefined) {
    const isActive = src.is_active !== undefined ? Boolean(src.is_active) : String(src.status) !== 'Inactive';
    payload.is_active = isActive;
    payload.status = isActive ? 'Active' : 'Inactive';
  }
  payload.updated_by = src.updated_by || null;
  payload.updated_at = new Date().toISOString();

  for (const f of STOCK_MANAGED_FIELDS) delete payload[f];

  const result = await updateDoc(COLLECTION, docId, payload, options);
  return { ...existing, ...result };
}

/**
 * @deprecated Phase A — stock changes MUST go through
 * inventoryStockService.applyMovement so a ledger entry is always written.
 * Kept only for backwards compatibility of the import; it now refuses to run.
 */
export async function updateProductStockFirestore() {
  throw new RepositoryError(
    'updateProductStockFirestore is disabled. Use inventoryStockService.applyMovement so every stock change is recorded in inventory_stock_movements.',
    'STOCK_WRITE_FORBIDDEN',
    400
  );
}

/** Hard delete — tooling only, never routed (the API deactivates instead). */
export async function deleteInventoryProductFirestore(productId, options = {}) {
  if (!productId) throw new RepositoryError('Product ID is required for deletion', 'VALIDATION_ERROR', 400);
  return await deleteDoc(COLLECTION, productDocIdFor(productId), options);
}
