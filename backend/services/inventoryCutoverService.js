/**
 * inventoryCutoverService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Inventory master-data service (categories, products, stock overview).
 *
 * Phase A note: this file used to carry a MySQL branch for every method. Both
 * environments run with USE_FIRESTORE_INVENTORY=true and
 * DISABLE_MYSQL_CUTOVER_FALLBACKS=true, which made those branches unreachable
 * (and db.js throws a decommission guard if they were). They referenced
 * helpers that were never imported, so they could not have worked anyway.
 * The service is now Firestore-only; the class/method names are unchanged so
 * existing callers (inventoryController.js, tests) keep working.
 *
 * Stock balances are NEVER written here — see inventoryStockService.js.
 */

import {
  getAllInventoryCategoriesFirestore,
  getInventoryCategoryByIdFirestore,
  createInventoryCategoryFirestore,
  updateInventoryCategoryFirestore,
  deactivateInventoryCategoryFirestore
} from '../repositories/firestore/inventoryCategoriesRepository.js';
import {
  getAllInventoryProductsFirestore,
  getInventoryProductByIdFirestore,
  getInventoryProductBySkuFirestore,
  createInventoryProductFirestore,
  updateInventoryProductFirestore,
  deleteInventoryProductFirestore,
  normalizeProductDoc
} from '../repositories/firestore/inventoryProductsRepository.js';
import { getAllInventoryLocationsFirestore } from '../repositories/firestore/inventoryLocationsRepository.js';
import { InventoryStockService } from './inventoryStockService.js';
import { computeStockStatus, STOCK_STATUS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, roundQuantity } from '../utils/inventoryConstants.js';

function httpError(message, status, code = null) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function parsePage(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.page_size || query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  return { page, pageSize };
}

function paginate(items, page, pageSize) {
  const total = items.length;
  const total_pages = Math.max(Math.ceil(total / pageSize), 1);
  const safePage = Math.min(page, total_pages);
  const start = (safePage - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page: safePage, page_size: pageSize, total, total_pages };
}

function categoryLookup(categories) {
  const byId = new Map();
  for (const c of categories) {
    byId.set(String(c.id), c);
    if (c.mysql_category_id !== undefined && c.mysql_category_id !== null) byId.set(String(c.mysql_category_id), c);
  }
  return byId;
}

function toCategoryView(c) {
  return {
    id: c.id,
    name: c.name || '',
    department: c.department || 'General',
    description: c.description || '',
    is_active: c.is_active !== false,
    created_by: c.created_by || null,
    updated_by: c.updated_by || null,
    created_at: c.created_at || null,
    updated_at: c.updated_at || null
  };
}

export class InventoryCutoverService {

  // ── Categories ──────────────────────────────────────────────────────────────

  static async getCategories({ includeInactive = false } = {}) {
    const docs = await getAllInventoryCategoriesFirestore({ includeInactive });
    const categories = docs.map(toCategoryView).sort((a, b) => a.name.localeCompare(b.name));
    return { categories };
  }

  static async createCategory({ name, department, description }, actor = null) {
    const catName = String(name).trim();
    const catDept = (department && typeof department === 'string' && department.trim()) ? department.trim() : 'General';
    try {
      const created = await createInventoryCategoryFirestore({
        name: catName,
        department: catDept,
        description: description ? String(description).trim() : '',
        created_by: actor
      });
      return toCategoryView(created);
    } catch (err) {
      if (err.code === 'DUPLICATE_KEY' || err.status === 409) throw httpError(`Category '${catName}' already exists.`, 409, 'ER_DUP_ENTRY');
      throw err;
    }
  }

  static async updateCategory(id, { name, department, description, is_active }, actor = null) {
    const existing = await getInventoryCategoryByIdFirestore(id);
    if (!existing) throw httpError('Category not found.', 404);
    const payload = { updated_by: actor };
    if (name !== undefined) payload.name = String(name).trim();
    if (department !== undefined) payload.department = (department && String(department).trim()) || 'General';
    if (description !== undefined) payload.description = String(description || '').trim();
    if (is_active !== undefined) payload.is_active = Boolean(is_active);
    const updated = await updateInventoryCategoryFirestore(existing.id, payload);
    return toCategoryView(updated);
  }

  /** "Delete" = deactivate. Categories referenced by products are never removed. */
  static async deactivateCategory(id, actor = null) {
    const existing = await getInventoryCategoryByIdFirestore(id);
    if (!existing) throw httpError('Category not found.', 404);
    const updated = await deactivateInventoryCategoryFirestore(existing.id, actor);
    return { success: true, message: 'Category deactivated.', category: toCategoryView(updated) };
  }

  /**
   * Backwards-compatible alias kept for pre-Phase-A callers
   * (backend/tests/testPhase3Step7*.mjs). Phase A never hard-deletes a
   * category — this deactivates, and returns the same { success: true } shape
   * the old method did.
   */
  static async deleteCategory(id, actor = null) {
    return await InventoryCutoverService.deactivateCategory(id, actor);
  }

  // ── Products ───────────────────────────────────────────────────────────────

  /** Projects one normalized product doc into the API view shape. */
  static toProductView(p, catMap, locMap, locationId = null) {
    const cat = p.category_id ? catMap.get(String(p.category_id)) : null;
    const hasMap = Object.keys(p.stock_by_location).length > 0;
    // Displayed quantity: per-location when filtering by location, otherwise
    // the cached total (legacy docs without a map fall back to current_stock).
    const qty = locationId
      ? roundQuantity(p.stock_by_location[locationId] || 0) || 0
      : (hasMap ? roundQuantity(Object.values(p.stock_by_location).reduce((a, v) => a + (Number(v) || 0), 0)) || 0 : p.current_stock);
    const stock_by_location = Object.entries(p.stock_by_location).map(([id, quantity]) => ({
      location_id: id,
      location_name: locMap.get(id)?.name || id,
      quantity: roundQuantity(quantity) || 0
    }));
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      category_id: cat ? cat.id : p.category_id,
      category_name: cat ? cat.name : 'Uncategorised',
      category_department: cat ? (cat.department || 'General') : 'General',
      unit_of_measure: p.unit_of_measure,
      minimum_stock_level: p.minimum_stock_level,
      current_stock: qty,
      total_stock: p.current_stock,
      stock_by_location,
      cost_price: p.cost_price,
      unit_price: p.unit_price,
      default_supplier_id: p.default_supplier_id,
      photo_url: p.photo_url,
      is_active: p.is_active,
      status: p.status,
      stock_status: computeStockStatus(qty, p.minimum_stock_level),
      last_movement_at: p.last_movement_at,
      created_at: p.created_at,
      updated_at: p.updated_at
    };
  }

  /**
   * Builds the joined product view list (bounded fetch + in-memory filter).
   * Shared by getProducts (Items tab) and getStock (Stock tab).
   */
  static async buildProductViews({ includeInactive = false, locationId = null } = {}) {
    const [docs, categories, locations] = await Promise.all([
      getAllInventoryProductsFirestore(),
      getAllInventoryCategoriesFirestore({ includeInactive: true }),
      getAllInventoryLocationsFirestore({ includeInactive: true })
    ]);
    const catMap = categoryLookup(categories);
    const locMap = new Map(locations.map(l => [l.id, l]));

    const views = [];
    for (const raw of docs) {
      const p = normalizeProductDoc(raw);
      if (!includeInactive && !p.is_active) continue;
      views.push(InventoryCutoverService.toProductView(p, catMap, locMap, locationId));
    }
    views.sort((a, b) => a.name.localeCompare(b.name));
    return views;
  }


  static applyCommonFilters(views, { search, category_id, stock_status }) {
    let out = views;
    if (category_id) out = out.filter(p => String(p.category_id) === String(category_id));
    if (stock_status) {
      const wanted = String(stock_status).toUpperCase();
      const map = { LOW: STOCK_STATUS.LOW, LOW_STOCK: STOCK_STATUS.LOW, OUT: STOCK_STATUS.OUT, OUT_OF_STOCK: STOCK_STATUS.OUT, NORMAL: STOCK_STATUS.NORMAL };
      if (map[wanted]) out = out.filter(p => p.stock_status === map[wanted]);
    }
    if (search && String(search).trim()) {
      const q = String(search).trim().toLowerCase();
      out = out.filter(p => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    }
    return out;
  }

  /** Items tab: paginated product master (active + inactive). */
  static async getProducts(query = {}) {
    const { page, pageSize } = parsePage(query);
    const status = query.status ? String(query.status).toLowerCase() : '';
    // The Items master shows ACTIVE + INACTIVE by default (the table has a
    // Status column and the UI's "All Statuses" option relies on it) — the
    // explicit Active/Inactive filters narrow it. This matches pre-Phase-A
    // behaviour; defaulting to active-only silently hid deactivated items.
    const all = await InventoryCutoverService.buildProductViews({ includeInactive: true });
    let views = all;
    if (status === 'active') views = views.filter(p => p.is_active);
    else if (status === 'inactive') views = views.filter(p => !p.is_active);
    if (query.low_stock === 'true' || query.low_stock === '1') views = views.filter(p => p.stock_status !== STOCK_STATUS.NORMAL);
    views = InventoryCutoverService.applyCommonFilters(views, query);

    // Dashboard cards are global KPIs — computed over every product, not the
    // current filter (this also keeps them consistent with the Stock tab).
    const metrics = {
      totalProducts: all.length,
      activeProducts: all.filter(p => p.is_active).length,
      lowStockProducts: all.filter(p => p.is_active && p.stock_status === STOCK_STATUS.LOW).length,
      outOfStockProducts: all.filter(p => p.is_active && p.stock_status === STOCK_STATUS.OUT).length
    };
    const paged = paginate(views, page, pageSize);
    return { products: paged.items, metrics, page: paged.page, page_size: paged.page_size, total: paged.total, total_pages: paged.total_pages };
  }

  /**
   * Stock tab: active products, optional per-location view, paginated.
   *
   * `include_buckets=true` additionally returns the low-stock and out-of-stock
   * lists, cut from the SAME in-memory scan that already produced `metrics`.
   *
   * The Inventory Overview needs the counts and both attention lists at once.
   * It used to ask for them with two requests — `stock_status=LOW_STOCK` and
   * `stock_status=OUT_OF_STOCK` — and because this method reads the whole
   * product collection before filtering in memory (page_size only slices the
   * result), that meant every product document was read TWICE per Overview
   * mount, for two responses carrying identical `metrics`.
   *
   * The flag is opt-in and purely additive: without it the response is byte-for
   * byte what it always was, so the Stock page, its filters and its pagination
   * are untouched. The buckets are cut from `all` — before applyCommonFilters —
   * so a search or category filter narrows `items` only, never the attention
   * lists, and `pageSize` caps each bucket the same way it caps a page.
   */
  static async getStock(query = {}) {
    const { page, pageSize } = parsePage(query);
    const locationId = query.location_id ? String(query.location_id) : null;
    const all = await InventoryCutoverService.buildProductViews({ includeInactive: query.include_inactive === 'true', locationId });
    const metrics = {
      totalProducts: all.length,
      lowStockProducts: all.filter(p => p.stock_status === STOCK_STATUS.LOW).length,
      outOfStockProducts: all.filter(p => p.stock_status === STOCK_STATUS.OUT).length
    };
    const filtered = InventoryCutoverService.applyCommonFilters(all, query);
    const paged = paginate(filtered, page, pageSize);
    const response = { items: paged.items, metrics, location_id: locationId, page: paged.page, page_size: paged.page_size, total: paged.total, total_pages: paged.total_pages };

    if (String(query.include_buckets) === 'true') {
      response.lowStock = all.filter(p => p.stock_status === STOCK_STATUS.LOW).slice(0, pageSize);
      response.outOfStock = all.filter(p => p.stock_status === STOCK_STATUS.OUT).slice(0, pageSize);
    }

    return response;
  }

  /**
   * Single-product fetch. Reads ONLY that product plus the (TTL-cached)
   * category and location lists — it must never scan the whole product
   * collection, which would burn the Firestore read budget on every
   * create/update round-trip.
   */
  static async getProductById(id) {
    const doc = await getInventoryProductByIdFirestore(id);
    if (!doc) return null;
    const [categories, locations] = await Promise.all([
      getAllInventoryCategoriesFirestore({ includeInactive: true }),
      getAllInventoryLocationsFirestore({ includeInactive: true })
    ]);
    const catMap = categoryLookup(categories);
    const locMap = new Map(locations.map(l => [l.id, l]));
    return InventoryCutoverService.toProductView(normalizeProductDoc(doc), catMap, locMap);
  }

  /**
   * Creates the product (zero stock) and, when opening stock is supplied,
   * records an OPENING movement through the stock service.
   */
  static async createProduct(payload, actor = { uid: null, name: null }) {
    const cleanSku = String(payload.sku).trim().toUpperCase();
    const existing = await getInventoryProductBySkuFirestore(cleanSku);
    if (existing) throw httpError(`Product with SKU '${cleanSku}' already exists.`, 409, 'ER_DUP_ENTRY');

    const created = await createInventoryProductFirestore({
      sku: cleanSku,
      name: String(payload.name).trim(),
      category_id: payload.category_id,
      unit_of_measure: payload.unit_of_measure,
      minimum_stock_level: payload.minimum_stock_level,
      cost_price: payload.cost_price,
      default_supplier_id: payload.default_supplier_id || null,
      photo_url: payload.photo_url || null,
      is_active: payload.is_active,
      created_by: actor.uid || null
    });

    let opening = null;
    if (payload.opening_stock > 0) {
      try {
        const res = await InventoryStockService.applyMovement({
          product_id: created.id,
          location_id: payload.opening_location_id || null,
          movement_type: 'OPENING',
          quantity: payload.opening_stock,
          reference_type: 'MANUAL',
          reason: 'Opening stock (item created)',
          actor_uid: actor.uid,
          actor_name: actor.name,
          idempotency_key: `open_${created.id}_${payload.opening_location_id || 'default'}_${Date.now()}`
        });
        opening = res.movement;
      } catch (err) {
        // Product creation and its opening stock are two separate writes (the
        // ledger transaction can only run once the product exists). If the
        // opening movement fails, compensate by removing the just-created
        // product so the caller can safely retry the same SKU instead of
        // hitting "SKU already exists" on a half-created item.
        try {
          await deleteInventoryProductFirestore(created.id);
        } catch (rollbackErr) {
          console.error(`[Inventory] createProduct rollback failed for ${created.id}: ${rollbackErr.message}`);
        }
        throw err;
      }
    }

    const product = await InventoryCutoverService.getProductById(created.id);
    return { product, opening_movement: opening };
  }

  static async updateProduct(id, payload, actor = { uid: null, name: null }) {
    const existing = await getInventoryProductByIdFirestore(id);
    if (!existing) throw httpError('Product not found.', 404);
    const updates = { ...payload, updated_by: actor.uid || null };
    delete updates.current_stock;
    delete updates.stock_by_location;
    delete updates.opening_stock;
    await updateInventoryProductFirestore(existing.id, updates);
    const product = await InventoryCutoverService.getProductById(existing.id);
    return { success: true, message: 'Product updated successfully.', product };
  }

  /** Soft delete. Stock history is retained; the item simply stops receiving movements. */
  static async deleteProduct(id, actor = { uid: null, name: null }) {
    const existing = await getInventoryProductByIdFirestore(id);
    if (!existing) throw httpError('Product not found.', 404);
    await updateInventoryProductFirestore(existing.id, { is_active: false, updated_by: actor.uid || null });
    return { success: true, message: 'Product deactivated successfully.' };
  }

  /** Kept for API compatibility: routes an ad-hoc delta through the ledger as an ADJUSTMENT. */
  static async updateStock(productId, quantityDelta, options = {}) {
    const res = await InventoryStockService.applyMovement({
      product_id: productId,
      location_id: options.location_id || null,
      movement_type: 'ADJUSTMENT',
      quantity: quantityDelta,
      reason: options.reason || 'Adjustment',
      actor_uid: options.actor_uid || null,
      actor_name: options.actor_name || null,
      idempotency_key: options.idempotency_key || null
    });
    return { success: true, delta: Number(quantityDelta), current_stock: res.product?.current_stock, duplicate: res.duplicate };
  }
}

export default InventoryCutoverService;
