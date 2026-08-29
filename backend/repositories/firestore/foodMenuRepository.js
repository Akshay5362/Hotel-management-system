/**
 * foodMenuRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore data-access layer for the Food / Restaurant POS Menu Master.
 *
 * Collections managed (ALL new — zero overlap with existing HPMS collections):
 *   food_menu_categories  — category master
 *   food_menu_items       — menu item master
 *   food_tax_config       — isolated food tax configuration
 *
 * Safety Contract:
 *   - Reads/writes ONLY from the three collections listed above.
 *   - Never imports from or modifies any other HPMS repository.
 *   - No MySQL interaction. Food is Firestore-native.
 *   - Uses existing firestoreUtils.js utilities (read-only import).
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

// ── Collection Constants ──────────────────────────────────────────────────────
const FOOD_CATEGORIES_COLLECTION = 'food_menu_categories';
const FOOD_ITEMS_COLLECTION      = 'food_menu_items';
const FOOD_TAX_CONFIG_COLLECTION = 'food_tax_config';

// ── Valid Enum Values ─────────────────────────────────────────────────────────
export const VALID_KOT_TYPES   = ['KITCHEN', 'PANTRY', 'BAR', 'BAKERY'];
export const VALID_TAX_TYPES   = ['GST_5', 'GST_12', 'GST_18', 'EXEMPT', 'CUSTOM'];

// ── ID Formatters ─────────────────────────────────────────────────────────────

/**
 * Generates a deterministic Firestore document ID for a food category.
 * Input: any string (name or existing id).
 * Output: "fcat_{slug}" where slug is lowercase alphanumeric+underscores.
 */
export function formatFoodCategoryId(nameOrId) {
  if (!nameOrId) throw new RepositoryError('formatFoodCategoryId requires a non-empty value', 'INVALID_ID', 400);
  const str = String(nameOrId).trim();
  if (str.startsWith('fcat_')) return str;
  const slug = str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) throw new RepositoryError(`Cannot derive a valid slug from "${nameOrId}"`, 'INVALID_ID', 400);
  return `fcat_${slug}`;
}

/**
 * Generates a deterministic Firestore document ID for a food menu item.
 * Input: any string (name or existing id).
 * Output: "fitem_{slug}".
 */
export function formatFoodItemId(nameOrId) {
  if (!nameOrId) throw new RepositoryError('formatFoodItemId requires a non-empty value', 'INVALID_ID', 400);
  const str = String(nameOrId).trim();
  if (str.startsWith('fitem_')) return str;
  const slug = str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) throw new RepositoryError(`Cannot derive a valid slug from "${nameOrId}"`, 'INVALID_ID', 400);
  return `fitem_${slug}`;
}

// ── Stale-Update Guard (same pattern as existing repos) ──────────────────────

function isStaleUpdate(existingDoc, incomingData) {
  if (!existingDoc || !existingDoc.updated_at || !incomingData || !incomingData.updated_at) {
    return false;
  }
  const existingTime = new Date(existingDoc.updated_at).getTime();
  const incomingTime = new Date(incomingData.updated_at).getTime();
  return !isNaN(existingTime) && !isNaN(incomingTime) && existingTime > incomingTime;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOOD MENU CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Retrieve a single food category by its document ID.
 * Accepts "fcat_xxx" or a raw name slug.
 */
export async function getFoodCategoryByIdFirestore(categoryId, options = {}) {
  if (!categoryId) return null;
  const docId = String(categoryId).startsWith('fcat_')
    ? String(categoryId)
    : formatFoodCategoryId(categoryId);
  return await getDoc(FOOD_CATEGORIES_COLLECTION, docId, options);
}

/**
 * List all food categories, optionally filtered to active-only.
 * Returns sorted by display_order ASC, then name ASC.
 */
export async function getAllFoodCategoriesFirestore(options = {}) {
  const { activeOnly = false, transaction = null } = options;

  const filters = activeOnly
    ? [{ field: 'is_active', op: '==', value: true }]
    : [];

  const docs = await listDocs(FOOD_CATEGORIES_COLLECTION, {
    filters,
    orderBy: [{ field: 'display_order', direction: 'asc' }],
    limit: 200,
    transaction
  });

  // Secondary sort by name in-memory (Firestore can only orderBy one field
  // without composite index when using where filters)
  return docs.sort((a, b) => {
    const orderDiff = (a.display_order || 0) - (b.display_order || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/**
 * Create a new food menu category.
 * Prevents duplicate active category names (case-insensitive).
 */
export async function createFoodCategoryFirestore(categoryData, options = {}) {
  validateRequiredFields(categoryData, ['name'], 'FoodCategory');

  const cleanName = String(categoryData.name).trim();
  if (!cleanName) throw new RepositoryError('Category name cannot be blank', 'VALIDATION_ERROR', 400);

  const docId = formatFoodCategoryId(cleanName);

  // Duplicate guard — prevent re-creating an active category with the same name
  const existing = await getDoc(FOOD_CATEGORIES_COLLECTION, docId, options);
  if (existing && existing.is_active !== false) {
    throw new RepositoryError(
      `Food category "${cleanName}" already exists`,
      'DUPLICATE_KEY',
      409
    );
  }

  const nowIso = new Date().toISOString();

  const payload = {
    category_id:   docId,
    name:          cleanName,
    description:   categoryData.description   ? String(categoryData.description).trim()   : '',
    display_order: typeof categoryData.display_order === 'number' && !isNaN(categoryData.display_order)
      ? Math.max(0, Math.round(categoryData.display_order))
      : 0,
    is_active:     categoryData.is_active !== false, // default true
    icon_emoji:    categoryData.icon_emoji    ? String(categoryData.icon_emoji).trim()     : '🍽️',
    created_at:    categoryData.created_at    || nowIso,
    updated_at:    categoryData.updated_at    || nowIso
  };

  return await setDoc(FOOD_CATEGORIES_COLLECTION, docId, payload, { ...options, merge: true });
}

/**
 * Update an existing food menu category.
 * Does NOT allow renaming in a way that would collide with another category.
 */
export async function updateFoodCategoryFirestore(categoryId, updateData, options = {}) {
  if (!categoryId) throw new RepositoryError('Category ID is required for update', 'VALIDATION_ERROR', 400);

  const docId = String(categoryId).startsWith('fcat_')
    ? String(categoryId)
    : formatFoodCategoryId(categoryId);

  const existing = await getDoc(FOOD_CATEGORIES_COLLECTION, docId, options);
  if (!existing) {
    throw new RepositoryError(`Food category "${categoryId}" not found`, 'NOT_FOUND', 404);
  }

  if (isStaleUpdate(existing, updateData)) {
    console.log(`[FoodMenuRepo] Ignored stale category update for ${docId}`);
    return existing;
  }

  // If name is being changed, check for collision against a DIFFERENT document
  if (updateData.name && String(updateData.name).trim() !== existing.name) {
    const newName    = String(updateData.name).trim();
    const newDocId   = formatFoodCategoryId(newName);
    if (newDocId !== docId) {
      const collision = await getDoc(FOOD_CATEGORIES_COLLECTION, newDocId, options);
      if (collision && collision.is_active !== false) {
        throw new RepositoryError(
          `Food category "${newName}" already exists`,
          'DUPLICATE_KEY',
          409
        );
      }
    }
  }

  const payload = {
    ...updateData,
    updated_at: updateData.updated_at || new Date().toISOString()
  };

  // Sanitize: ensure display_order is a clean integer if provided
  if (payload.display_order !== undefined) {
    payload.display_order = Math.max(0, Math.round(Number(payload.display_order) || 0));
  }

  // Never let an update wipe category_id
  payload.category_id = docId;

  return await updateDoc(FOOD_CATEGORIES_COLLECTION, docId, payload, options);
}

/**
 * Soft-deactivate a food category (sets is_active = false).
 * Does NOT physically delete — items that reference this category remain intact.
 * Physical deletion is prevented because future food orders may reference items
 * in this category.
 */
export async function deactivateFoodCategoryFirestore(categoryId, options = {}) {
  if (!categoryId) throw new RepositoryError('Category ID is required', 'VALIDATION_ERROR', 400);

  const docId = String(categoryId).startsWith('fcat_')
    ? String(categoryId)
    : formatFoodCategoryId(categoryId);

  const existing = await getDoc(FOOD_CATEGORIES_COLLECTION, docId, options);
  if (!existing) {
    throw new RepositoryError(`Food category "${categoryId}" not found`, 'NOT_FOUND', 404);
  }

  return await updateDoc(FOOD_CATEGORIES_COLLECTION, docId, {
    is_active:  false,
    updated_at: new Date().toISOString()
  }, options);
}

/**
 * Hard-delete a food category — ONLY allowed if no active items reference it.
 * Caller is responsible for checking item references before calling this.
 */
export async function deleteFoodCategoryFirestore(categoryId, options = {}) {
  if (!categoryId) throw new RepositoryError('Category ID is required', 'VALIDATION_ERROR', 400);

  const docId = String(categoryId).startsWith('fcat_')
    ? String(categoryId)
    : formatFoodCategoryId(categoryId);

  return await deleteDoc(FOOD_CATEGORIES_COLLECTION, docId, options);
}

/**
 * Count how many active items belong to a category.
 * Used by the controller before deciding soft vs hard delete.
 */
export async function countActiveItemsInCategoryFirestore(categoryId, options = {}) {
  if (!categoryId) return 0;
  const docId = String(categoryId).startsWith('fcat_') ? String(categoryId) : formatFoodCategoryId(categoryId);

  const items = await listDocs(FOOD_ITEMS_COLLECTION, {
    filters: [
      { field: 'category_id', op: '==', value: docId },
      { field: 'is_active',   op: '==', value: true }
    ],
    limit: 1, // We only need to know if any exist
    transaction: options.transaction
  });

  return items.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOOD MENU ITEMS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Retrieve a single food menu item by document ID or name slug.
 */
export async function getFoodItemByIdFirestore(itemId, options = {}) {
  if (!itemId) return null;
  const docId = String(itemId).startsWith('fitem_') ? String(itemId) : formatFoodItemId(itemId);
  return await getDoc(FOOD_ITEMS_COLLECTION, docId, options);
}

/**
 * List food menu items with flexible filtering.
 * @param {Object} options
 * @param {string}  [options.categoryId]  — filter by category_id
 * @param {boolean} [options.activeOnly]  — filter to is_active === true
 * @param {string}  [options.kotType]     — filter by kot_type
 * @param {boolean} [options.vegOnly]     — filter to is_veg === true
 * @param {number}  [options.limit]       — max records
 */
export async function getAllFoodItemsFirestore(options = {}) {
  const {
    categoryId = null,
    activeOnly  = false,
    kotType     = null,
    vegOnly     = false,
    limit       = 500,
    transaction = null
  } = options;

  const filters = [];
  if (categoryId) filters.push({ field: 'category_id', op: '==', value: String(categoryId) });
  if (activeOnly)  filters.push({ field: 'is_active',   op: '==', value: true });
  if (kotType)     filters.push({ field: 'kot_type',    op: '==', value: String(kotType).toUpperCase() });
  if (vegOnly)     filters.push({ field: 'is_veg',      op: '==', value: true });

  const docs = await listDocs(FOOD_ITEMS_COLLECTION, {
    filters,
    orderBy: [{ field: 'name', direction: 'asc' }],
    limit,
    transaction
  });

  return docs;
}

/**
 * Search food items by name (case-insensitive prefix match via in-memory filter).
 * Firestore doesn't natively support case-insensitive search; we fetch and filter.
 * For large menus (>500 items), consider adding a search_name field.
 */
export async function searchFoodItemsFirestore(searchTerm, options = {}) {
  if (!searchTerm || !String(searchTerm).trim()) return [];

  const { activeOnly = true, limit = 500, transaction = null } = options;

  const filters = activeOnly ? [{ field: 'is_active', op: '==', value: true }] : [];

  const allDocs = await listDocs(FOOD_ITEMS_COLLECTION, {
    filters,
    limit,
    transaction
  });

  const term = String(searchTerm).trim().toLowerCase();
  return allDocs.filter(item => {
    if (!item) return false;
    const nameMatch        = String(item.name        || '').toLowerCase().includes(term);
    const descMatch        = String(item.description || '').toLowerCase().includes(term);
    const tagMatch         = Array.isArray(item.tags) && item.tags.some(t => String(t).toLowerCase().includes(term));
    return nameMatch || descMatch || tagMatch;
  });
}

/**
 * Create a new food menu item.
 * Validates: required fields, price >= 0, tax >= 0, valid KOT type,
 * valid category reference, no duplicate active item name in same category.
 */
export async function createFoodItemFirestore(itemData, options = {}) {
  validateRequiredFields(itemData, ['name', 'category_id'], 'FoodMenuItem');

  const cleanName       = String(itemData.name).trim();
  const cleanCategoryId = String(itemData.category_id).trim();

  if (!cleanName) throw new RepositoryError('Item name cannot be blank', 'VALIDATION_ERROR', 400);
  if (!cleanCategoryId) throw new RepositoryError('category_id is required', 'VALIDATION_ERROR', 400);

  // Validate category exists
  const categoryDoc = await getDoc(FOOD_CATEGORIES_COLLECTION, cleanCategoryId, options);
  if (!categoryDoc) {
    throw new RepositoryError(
      `Food category "${cleanCategoryId}" does not exist`,
      'FOREIGN_KEY_VIOLATION',
      400
    );
  }

  // Price validation
  const basePrice = parseFloat(itemData.base_price);
  if (isNaN(basePrice) || basePrice < 0) {
    throw new RepositoryError('base_price must be a non-negative number', 'VALIDATION_ERROR', 400);
  }

  // Tax validation
  const taxRate = parseFloat(itemData.tax_rate ?? 0);
  if (isNaN(taxRate) || taxRate < 0 || taxRate > 100) {
    throw new RepositoryError('tax_rate must be between 0 and 100', 'VALIDATION_ERROR', 400);
  }

  // KOT type validation
  const kotType = itemData.kot_type ? String(itemData.kot_type).toUpperCase() : 'KITCHEN';
  if (!VALID_KOT_TYPES.includes(kotType)) {
    throw new RepositoryError(
      `Invalid kot_type "${kotType}". Must be one of: ${VALID_KOT_TYPES.join(', ')}`,
      'VALIDATION_ERROR',
      400
    );
  }

  // Tax type validation
  const taxType = itemData.tax_type ? String(itemData.tax_type).toUpperCase() : 'GST_5';
  if (!VALID_TAX_TYPES.includes(taxType)) {
    throw new RepositoryError(
      `Invalid tax_type "${taxType}". Must be one of: ${VALID_TAX_TYPES.join(', ')}`,
      'VALIDATION_ERROR',
      400
    );
  }

  // Preparation time
  const prepTime = parseInt(itemData.preparation_time_mins ?? 0, 10);
  if (isNaN(prepTime) || prepTime < 0) {
    throw new RepositoryError('preparation_time_mins must be a non-negative integer', 'VALIDATION_ERROR', 400);
  }

  // Derive document ID from item name (globally unique across all categories)
  const docId = formatFoodItemId(cleanName);

  // Duplicate guard: if a document already exists and is active, reject
  const existing = await getDoc(FOOD_ITEMS_COLLECTION, docId, options);
  if (existing && existing.is_active !== false) {
    throw new RepositoryError(
      `Food menu item "${cleanName}" already exists`,
      'DUPLICATE_KEY',
      409
    );
  }

  const nowIso = new Date().toISOString();

  // Sanitize tags
  const tags = Array.isArray(itemData.tags)
    ? itemData.tags.map(t => String(t).trim()).filter(Boolean)
    : [];

  const payload = {
    item_id:                  docId,
    category_id:              cleanCategoryId,
    name:                     cleanName,
    // search_name stored lowercase for future full-text search support
    search_name:              cleanName.toLowerCase(),
    description:              itemData.description ? String(itemData.description).trim() : '',
    base_price:               parseFloat(basePrice.toFixed(2)),
    tax_rate:                 parseFloat(taxRate.toFixed(4)),
    tax_type:                 taxType,
    is_veg:                   itemData.is_veg === true || itemData.is_veg === 'true',
    is_active:                itemData.is_active !== false, // default true
    kot_type:                 kotType,
    preparation_time_mins:    prepTime,
    image_url:                itemData.image_url ? String(itemData.image_url).trim() : null,
    tags,
    created_at:               itemData.created_at || nowIso,
    updated_at:               itemData.updated_at || nowIso
  };

  return await setDoc(FOOD_ITEMS_COLLECTION, docId, payload, { ...options, merge: true });
}

/**
 * Update an existing food menu item.
 * Partial updates are supported — only provided fields are overwritten.
 * Immutable fields: item_id, created_at.
 */
export async function updateFoodItemFirestore(itemId, updateData, options = {}) {
  if (!itemId) throw new RepositoryError('Item ID is required for update', 'VALIDATION_ERROR', 400);

  const docId = String(itemId).startsWith('fitem_') ? String(itemId) : formatFoodItemId(itemId);

  const existing = await getDoc(FOOD_ITEMS_COLLECTION, docId, options);
  if (!existing) {
    throw new RepositoryError(`Food menu item "${itemId}" not found`, 'NOT_FOUND', 404);
  }

  if (isStaleUpdate(existing, updateData)) {
    console.log(`[FoodMenuRepo] Ignored stale item update for ${docId}`);
    return existing;
  }

  // Validate updated numeric fields if provided
  if (updateData.base_price !== undefined) {
    const p = parseFloat(updateData.base_price);
    if (isNaN(p) || p < 0) throw new RepositoryError('base_price must be a non-negative number', 'VALIDATION_ERROR', 400);
    updateData.base_price = parseFloat(p.toFixed(2));
  }

  if (updateData.tax_rate !== undefined) {
    const t = parseFloat(updateData.tax_rate);
    if (isNaN(t) || t < 0 || t > 100) throw new RepositoryError('tax_rate must be between 0 and 100', 'VALIDATION_ERROR', 400);
    updateData.tax_rate = parseFloat(t.toFixed(4));
  }

  if (updateData.kot_type !== undefined) {
    const k = String(updateData.kot_type).toUpperCase();
    if (!VALID_KOT_TYPES.includes(k)) throw new RepositoryError(`Invalid kot_type "${k}"`, 'VALIDATION_ERROR', 400);
    updateData.kot_type = k;
  }

  if (updateData.tax_type !== undefined) {
    const tt = String(updateData.tax_type).toUpperCase();
    if (!VALID_TAX_TYPES.includes(tt)) throw new RepositoryError(`Invalid tax_type "${tt}"`, 'VALIDATION_ERROR', 400);
    updateData.tax_type = tt;
  }

  if (updateData.preparation_time_mins !== undefined) {
    const pt = parseInt(updateData.preparation_time_mins, 10);
    if (isNaN(pt) || pt < 0) throw new RepositoryError('preparation_time_mins must be non-negative', 'VALIDATION_ERROR', 400);
    updateData.preparation_time_mins = pt;
  }

  // Update search_name if name is changing
  if (updateData.name) {
    updateData.name        = String(updateData.name).trim();
    updateData.search_name = updateData.name.toLowerCase();
  }

  // Sanitize tags if provided
  if (updateData.tags !== undefined) {
    updateData.tags = Array.isArray(updateData.tags)
      ? updateData.tags.map(t => String(t).trim()).filter(Boolean)
      : [];
  }

  const payload = {
    ...updateData,
    item_id:    docId,           // immutable — always enforce
    updated_at: updateData.updated_at || new Date().toISOString()
  };

  // Prevent overwriting created_at
  delete payload.created_at;

  return await updateDoc(FOOD_ITEMS_COLLECTION, docId, payload, options);
}

/**
 * Soft-deactivate a food menu item (is_active = false).
 * Preferred over deletion — historical orders must not lose item references.
 */
export async function deactivateFoodItemFirestore(itemId, options = {}) {
  return await updateFoodItemFirestore(itemId, { is_active: false }, options);
}

/**
 * Re-activate a previously deactivated food menu item.
 */
export async function reactivateFoodItemFirestore(itemId, options = {}) {
  return await updateFoodItemFirestore(itemId, { is_active: true }, options);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOOD TAX CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const TAX_CONFIG_DOC_ID = 'ftax_default';

/**
 * Retrieve the food tax configuration document.
 * Returns null if not yet seeded (first-run scenario).
 */
export async function getFoodTaxConfigFirestore(options = {}) {
  return await getDoc(FOOD_TAX_CONFIG_COLLECTION, TAX_CONFIG_DOC_ID, options);
}

/**
 * Upsert the food tax configuration.
 * Only admin-authorized callers should reach this (enforced at controller/route level).
 *
 * Default structure if creating fresh:
 *   gst_5:  { cgst: 2.5,  sgst: 2.5  }
 *   gst_12: { cgst: 6.0,  sgst: 6.0  }
 *   gst_18: { cgst: 9.0,  sgst: 9.0  }
 */
export async function upsertFoodTaxConfigFirestore(configData, options = {}) {
  if (!configData || typeof configData !== 'object') {
    throw new RepositoryError('Tax config data must be a non-null object', 'VALIDATION_ERROR', 400);
  }

  // Validate each provided rate bracket
  const validateRate = (label, obj) => {
    if (obj === undefined) return; // Optional — not all brackets must be updated at once
    if (typeof obj !== 'object' || obj === null) {
      throw new RepositoryError(`${label} must be an object`, 'VALIDATION_ERROR', 400);
    }
    const cgst = parseFloat(obj.cgst);
    const sgst = parseFloat(obj.sgst);
    if (isNaN(cgst) || cgst < 0 || cgst > 50) throw new RepositoryError(`${label}.cgst must be 0-50`, 'VALIDATION_ERROR', 400);
    if (isNaN(sgst) || sgst < 0 || sgst > 50) throw new RepositoryError(`${label}.sgst must be 0-50`, 'VALIDATION_ERROR', 400);
  };

  validateRate('gst_5',  configData.gst_5);
  validateRate('gst_12', configData.gst_12);
  validateRate('gst_18', configData.gst_18);

  const existing = await getDoc(FOOD_TAX_CONFIG_COLLECTION, TAX_CONFIG_DOC_ID, options);

  const defaultConfig = {
    gst_5:  { cgst: 2.5, sgst: 2.5 },
    gst_12: { cgst: 6.0, sgst: 6.0 },
    gst_18: { cgst: 9.0, sgst: 9.0 }
  };

  const nowIso = new Date().toISOString();

  const payload = {
    config_id:  TAX_CONFIG_DOC_ID,
    gst_5:      configData.gst_5  ?? existing?.gst_5  ?? defaultConfig.gst_5,
    gst_12:     configData.gst_12 ?? existing?.gst_12 ?? defaultConfig.gst_12,
    gst_18:     configData.gst_18 ?? existing?.gst_18 ?? defaultConfig.gst_18,
    notes:      configData.notes  ?? existing?.notes  ?? '',
    updated_at: nowIso,
    created_at: existing?.created_at || nowIso
  };

  // Coerce to 4-decimal floats for precision
  ['gst_5', 'gst_12', 'gst_18'].forEach(key => {
    if (payload[key]) {
      payload[key] = {
        cgst: parseFloat(parseFloat(payload[key].cgst).toFixed(4)),
        sgst: parseFloat(parseFloat(payload[key].sgst).toFixed(4))
      };
    }
  });

  return await setDoc(FOOD_TAX_CONFIG_COLLECTION, TAX_CONFIG_DOC_ID, payload, { ...options, merge: true });
}
