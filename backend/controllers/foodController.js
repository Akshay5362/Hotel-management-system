/**
 * foodController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express controller handlers for the Food / Restaurant POS Menu Master.
 *
 * Phase 1 Scope — Menu Master only:
 *   - Food Categories (CRUD + soft-deactivate)
 *   - Food Menu Items (CRUD + search + activate/deactivate)
 *   - Food Tax Configuration (read + admin-only update)
 *
 * Future phases (NOT implemented here):
 *   Orders, KDS, billing, MAP/AP entitlement, printing.
 *
 * Safety Contract:
 *   - Uses ONLY foodMenuRepository.js for data access.
 *   - Never calls any existing HPMS controller or modifies existing business logic.
 *   - No MySQL interaction.
 *   - No Firebase Auth mutations.
 *   - Audit log written to existing audit_logs collection (read-only import).
 */

import {
  getFoodCategoryByIdFirestore,
  getAllFoodCategoriesFirestore,
  createFoodCategoryFirestore,
  updateFoodCategoryFirestore,
  deactivateFoodCategoryFirestore,
  deleteFoodCategoryFirestore,
  countActiveItemsInCategoryFirestore,

  getFoodItemByIdFirestore,
  getAllFoodItemsFirestore,
  searchFoodItemsFirestore,
  createFoodItemFirestore,
  updateFoodItemFirestore,
  deactivateFoodItemFirestore,
  reactivateFoodItemFirestore,

  getFoodTaxConfigFirestore,
  upsertFoodTaxConfigFirestore,

  VALID_KOT_TYPES,
  VALID_TAX_TYPES
} from '../repositories/firestore/foodMenuRepository.js';

import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { RepositoryError } from '../repositories/firestore/firestoreUtils.js';

// ── Shared error handler ─────────────────────────────────────────────────────

function handleRepoError(res, err, context) {
  if (err instanceof RepositoryError) {
    const status = err.status || 500;
    console.warn(`[FoodController] ${context} — RepositoryError (${err.code}): ${err.message}`);
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error(`[FoodController] ${context} — Unexpected error:`, err);
  return res.status(500).json({ error: 'Internal Server Error' });
}

// ── Audit helper ─────────────────────────────────────────────────────────────

async function writeAuditLog(req, action, details) {
  try {
    await createAuditLogFirestore({
      action,
      details,
      user_id:       req.user?.uid   || req.user?.id   || 'unknown',
      business_date: new Date().toISOString().split('T')[0]
    });
  } catch (e) {
    // Non-fatal — never let audit log failure break the primary operation
    console.warn('[FoodController] Audit log write failed (non-fatal):', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOOD CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/food/categories
 * Returns all food categories. Supports ?active_only=true query param.
 * Accessible to all authenticated staff (read-only operation).
 */
export const getFoodCategories = async (req, res) => {
  try {
    const activeOnly = req.query.active_only === 'true';
    const categories = await getAllFoodCategoriesFirestore({ activeOnly });
    return res.json({
      categories,
      total: categories.length
    });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodCategories');
  }
};

/**
 * GET /api/food/categories/:id
 * Returns a single food category by ID.
 */
export const getFoodCategoryById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Category ID is required' });

    const category = await getFoodCategoryByIdFirestore(id);
    if (!category) return res.status(404).json({ error: 'Food category not found' });

    return res.json({ category });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodCategoryById');
  }
};

/**
 * POST /api/food/categories
 * Creates a new food category.
 * Requires: admin or receptionist role (enforced via middleware in routes).
 */
export const createFoodCategory = async (req, res) => {
  try {
    const { name, description, display_order, icon_emoji, is_active } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const category = await createFoodCategoryFirestore({
      name,
      description,
      display_order: display_order !== undefined ? Number(display_order) : 0,
      icon_emoji,
      is_active: is_active !== false
    });

    await writeAuditLog(req, 'food_category_created', {
      category_id: category.category_id,
      name: category.name
    });

    return res.status(201).json({
      message:  'Food category created successfully',
      category
    });
  } catch (err) {
    return handleRepoError(res, err, 'createFoodCategory');
  }
};

/**
 * PUT /api/food/categories/:id
 * Updates an existing food category.
 * Requires: admin or receptionist role.
 */
export const updateFoodCategory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Category ID is required' });

    const { name, description, display_order, icon_emoji, is_active } = req.body;

    const updatePayload = {};
    if (name          !== undefined) updatePayload.name          = name;
    if (description   !== undefined) updatePayload.description   = description;
    if (display_order !== undefined) updatePayload.display_order = Number(display_order);
    if (icon_emoji    !== undefined) updatePayload.icon_emoji    = icon_emoji;
    if (is_active     !== undefined) updatePayload.is_active     = Boolean(is_active);

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update' });
    }

    const category = await updateFoodCategoryFirestore(id, updatePayload);

    await writeAuditLog(req, 'food_category_updated', {
      category_id: id,
      changes: Object.keys(updatePayload)
    });

    return res.json({
      message:  'Food category updated successfully',
      category
    });
  } catch (err) {
    return handleRepoError(res, err, 'updateFoodCategory');
  }
};

/**
 * DELETE /api/food/categories/:id
 * Prefers soft-deactivation when active items reference the category.
 * Hard-deletes only if the category has no active items.
 * Requires: admin role.
 */
export const deleteFoodCategory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Category ID is required' });

    const existing = await getFoodCategoryByIdFirestore(id);
    if (!existing) return res.status(404).json({ error: 'Food category not found' });

    const activeItemCount = await countActiveItemsInCategoryFirestore(id);

    if (activeItemCount > 0) {
      // Soft deactivate — category is referenced by active items
      await deactivateFoodCategoryFirestore(id);
      await writeAuditLog(req, 'food_category_deactivated', {
        category_id: id,
        reason: `Has ${activeItemCount} active item(s) — soft deactivated`
      });
      return res.json({
        message:   'Food category deactivated (has active items — soft delete applied)',
        action:    'DEACTIVATED',
        category_id: id,
        active_items_count: activeItemCount
      });
    }

    // Hard delete — no active items reference this category
    await deleteFoodCategoryFirestore(id);
    await writeAuditLog(req, 'food_category_deleted', { category_id: id });
    return res.json({
      message:     'Food category deleted permanently',
      action:      'DELETED',
      category_id: id
    });
  } catch (err) {
    return handleRepoError(res, err, 'deleteFoodCategory');
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOOD MENU ITEMS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/food/menu-items
 * Lists food menu items with optional filters:
 *   ?category_id=fcat_xxx
 *   ?active_only=true
 *   ?kot_type=KITCHEN
 *   ?veg_only=true
 *   ?limit=100
 */
export const getFoodMenuItems = async (req, res) => {
  try {
    const {
      category_id,
      active_only,
      kot_type,
      veg_only,
      limit
    } = req.query;

    const items = await getAllFoodItemsFirestore({
      categoryId: category_id || null,
      activeOnly:  active_only === 'true',
      kotType:     kot_type    || null,
      vegOnly:     veg_only    === 'true',
      limit:       limit ? Math.min(parseInt(limit, 10), 1000) : 500
    });

    return res.json({
      items,
      total: items.length
    });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodMenuItems');
  }
};

/**
 * GET /api/food/menu-items/search
 * Searches food items by name, description, or tags.
 *   ?q=dal&active_only=true
 */
export const searchFoodMenuItems = async (req, res) => {
  try {
    const { q, active_only } = req.query;

    if (!q || !String(q).trim()) {
      return res.status(400).json({ error: 'Search query "q" is required' });
    }

    const items = await searchFoodItemsFirestore(q, {
      activeOnly: active_only !== 'false' // default true for search
    });

    return res.json({
      items,
      total: items.length,
      query: q
    });
  } catch (err) {
    return handleRepoError(res, err, 'searchFoodMenuItems');
  }
};

/**
 * GET /api/food/menu-items/:id
 * Returns a single food menu item.
 */
export const getFoodMenuItemById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Item ID is required' });

    const item = await getFoodItemByIdFirestore(id);
    if (!item) return res.status(404).json({ error: 'Food menu item not found' });

    return res.json({ item });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodMenuItemById');
  }
};

/**
 * POST /api/food/menu-items
 * Creates a new food menu item.
 * Requires: admin or receptionist role.
 */
export const createFoodMenuItem = async (req, res) => {
  try {
    const {
      name, category_id, description,
      base_price, tax_rate, tax_type,
      is_veg, is_active, kot_type,
      preparation_time_mins, image_url, tags
    } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Item name is required' });
    }
    if (!category_id) {
      return res.status(400).json({ error: 'category_id is required' });
    }
    if (base_price === undefined || base_price === null || base_price === '') {
      return res.status(400).json({ error: 'base_price is required' });
    }

    const item = await createFoodItemFirestore({
      name,
      category_id,
      description,
      base_price,
      tax_rate:             tax_rate              ?? 5,
      tax_type:             tax_type              || 'GST_5',
      is_veg:               is_veg               === true || is_veg === 'true',
      is_active:            is_active             !== false,
      kot_type:             kot_type              || 'KITCHEN',
      preparation_time_mins: preparation_time_mins ?? 0,
      image_url:            image_url             || null,
      tags:                 Array.isArray(tags) ? tags : []
    });

    await writeAuditLog(req, 'food_item_created', {
      item_id:     item.item_id,
      name:        item.name,
      category_id: item.category_id
    });

    return res.status(201).json({
      message: 'Food menu item created successfully',
      item
    });
  } catch (err) {
    return handleRepoError(res, err, 'createFoodMenuItem');
  }
};

/**
 * PUT /api/food/menu-items/:id
 * Updates an existing food menu item.
 * Supports partial updates (only provided fields are changed).
 * Requires: admin or receptionist role.
 */
export const updateFoodMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Item ID is required' });

    // Build partial update payload from provided body fields only
    const allowedFields = [
      'name', 'category_id', 'description', 'base_price',
      'tax_rate', 'tax_type', 'is_veg', 'is_active', 'kot_type',
      'preparation_time_mins', 'image_url', 'tags'
    ];

    const updatePayload = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updatePayload[field] = req.body[field];
      }
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update' });
    }

    // Validate category_id if it's being changed
    if (updatePayload.category_id) {
      const cat = await getFoodCategoryByIdFirestore(updatePayload.category_id);
      if (!cat) {
        return res.status(400).json({ error: `Food category "${updatePayload.category_id}" does not exist` });
      }
    }


    const item = await updateFoodItemFirestore(id, updatePayload);

    await writeAuditLog(req, 'food_item_updated', {
      item_id: id,
      changes: Object.keys(updatePayload)
    });

    return res.json({
      message: 'Food menu item updated successfully',
      item
    });
  } catch (err) {
    return handleRepoError(res, err, 'updateFoodMenuItem');
  }
};

/**
 * DELETE /api/food/menu-items/:id
 * Soft-deactivates a food menu item (is_active = false).
 * Never hard-deletes — future food orders must retain item references.
 * Requires: admin role.
 *
 * To reactivate, use PUT /api/food/menu-items/:id with { is_active: true }.
 */
export const deleteFoodMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Item ID is required' });

    const existing = await getFoodItemByIdFirestore(id);
    if (!existing) return res.status(404).json({ error: 'Food menu item not found' });

    await deactivateFoodItemFirestore(id);

    await writeAuditLog(req, 'food_item_deactivated', {
      item_id: id,
      name:    existing.name
    });

    return res.json({
      message: 'Food menu item deactivated (soft delete — item remains for historical order references)',
      item_id: id,
      action:  'DEACTIVATED'
    });
  } catch (err) {
    return handleRepoError(res, err, 'deleteFoodMenuItem');
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOOD TAX CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/food/tax-config
 * Returns the food tax configuration.
 * If not yet configured, returns default values (does NOT write to Firestore).
 */
export const getFoodTaxConfig = async (req, res) => {
  try {
    let config = await getFoodTaxConfigFirestore();

    if (!config) {
      // Return defaults without writing — first-run scenario
      config = {
        config_id: 'ftax_default',
        gst_5:     { cgst: 2.5, sgst: 2.5 },
        gst_12:    { cgst: 6.0, sgst: 6.0 },
        gst_18:    { cgst: 9.0, sgst: 9.0 },
        notes:     'Default GST rates — not yet saved',
        is_default: true
      };
    }

    return res.json({ tax_config: config });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodTaxConfig');
  }
};

/**
 * PUT /api/food/tax-config
 * Updates (or initializes) the food tax configuration.
 * Admin only — enforced via route middleware.
 *
 * Body example:
 * {
 *   "gst_5":  { "cgst": 2.5, "sgst": 2.5 },
 *   "gst_12": { "cgst": 6.0, "sgst": 6.0 },
 *   "gst_18": { "cgst": 9.0, "sgst": 9.0 },
 *   "notes":  "Updated 2026-08-27"
 * }
 */
export const updateFoodTaxConfig = async (req, res) => {
  try {
    const { gst_5, gst_12, gst_18, notes } = req.body;

    if (!gst_5 && !gst_12 && !gst_18) {
      return res.status(400).json({
        error: 'At least one tax bracket (gst_5, gst_12, or gst_18) must be provided'
      });
    }

    const config = await upsertFoodTaxConfigFirestore({ gst_5, gst_12, gst_18, notes });

    await writeAuditLog(req, 'food_tax_config_updated', {
      updated_brackets: Object.keys({ gst_5, gst_12, gst_18 }).filter(k =>
        ({ gst_5, gst_12, gst_18 })[k] !== undefined
      )
    });

    return res.json({
      message:    'Food tax configuration updated successfully',
      tax_config: config
    });
  } catch (err) {
    return handleRepoError(res, err, 'updateFoodTaxConfig');
  }
};

/**
 * GET /api/food/meta
 * Returns valid enum values for KOT types and tax types.
 * Useful for dropdown population in the frontend.
 */
export const getFoodMeta = async (req, res) => {
  return res.json({
    kot_types:  VALID_KOT_TYPES,
    tax_types:  VALID_TAX_TYPES,
    default_tax_config: {
      gst_5:  { cgst: 2.5, sgst: 2.5 },
      gst_12: { cgst: 6.0, sgst: 6.0 },
      gst_18: { cgst: 9.0, sgst: 9.0 }
    }
  });
};
