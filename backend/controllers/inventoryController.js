/**
 * inventoryController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Controller handlers for Inventory Categories and Product Master management.
 */

import pool from '../db.js';
import { db } from '../config/firebaseAdmin.js';
import { InventoryCutoverService } from '../services/inventoryCutoverService.js';
import { VALID_UNITS, VALID_STATUSES } from '../utils/inventoryConstants.js';
import { removeOldProductPhoto } from '../middleware/inventoryUploadMiddleware.js';
import { isInventoryCategoriesReadCanaryEnabled, isInventoryProductsReadCanaryEnabled } from '../config/featureFlags.js';

/**
 * GET /api/inventory/categories
 * Retrieves all inventory categories.
 */
export const getCategories = async (req, res) => {
  try {
    const result = await InventoryCutoverService.getCategories();
    return res.json(result);
  } catch (error) {
    console.error('getCategories error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * POST /api/inventory/categories
 * Creates a new inventory category.
 */
export const createCategory = async (req, res) => {
  const { name, department } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required.' });
  }

  try {
    const category = await InventoryCutoverService.createCategory({ name, department });
    return res.status(201).json({ message: 'Category created successfully.', category });
  } catch (error) {
    if (error.status === 409 || error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `Category '${name.trim()}' already exists.` });
    }
    console.error('createCategory error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * PUT /api/inventory/categories/:id
 * Updates an inventory category.
 */
export const updateCategory = async (req, res) => {
  const { id } = req.params;
  const { name, department } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required.' });
  }

  try {
    const category = await InventoryCutoverService.updateCategory(id, { name, department });
    return res.json({ message: 'Category updated successfully.', category });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Category not found.' });
    if (error.status === 409 || error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `Category name '${name}' is already taken.` });
    }
    console.error('updateCategory error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * DELETE /api/inventory/categories/:id
 * Deletes an inventory category.
 */
export const deleteCategory = async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Category ID is required.' });

  try {
    const result = await InventoryCutoverService.deleteCategory(id);
    return res.json(result);
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Category not found.' });
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('deleteCategory error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * GET /api/inventory/products
 * Retrieves product list with filters and calculates stock statuses & dashboard summary metrics.
 */
export const getProducts = async (req, res) => {
  try {
    const result = await InventoryCutoverService.getProducts(req.query);
    return res.json(result);
  } catch (error) {
    console.error('getProducts error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * GET /api/inventory/products/:id
 * Retrieves details for a specific product.
 */
export const getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await InventoryCutoverService.getProductById(id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    return res.json({ product });
  } catch (error) {
    console.error('getProductById error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * POST /api/inventory/products
 * Creates a new product with initial opening stock and optional photo upload.
 */
export const createProduct = async (req, res) => {
  try {
    const {
      sku,
      name,
      category_id,
      unit_of_measure,
      minimum_stock_level,
      current_stock,
      unit_price,
      status
    } = req.body;

    const errors = [];
    if (!sku || typeof sku !== 'string' || !sku.trim()) errors.push('SKU is required.');
    if (!name || typeof name !== 'string' || !name.trim()) errors.push('Product name is required.');
    
    const catIdNum = parseInt(category_id, 10);
    if (isNaN(catIdNum)) errors.push('Valid Category ID is required.');

    if (!unit_of_measure || !VALID_UNITS.includes(unit_of_measure)) {
      errors.push(`Unit of measure must be one of: ${VALID_UNITS.join(', ')}.`);
    }

    const minStockNum = parseFloat(minimum_stock_level ?? 0);
    if (isNaN(minStockNum) || minStockNum < 0) errors.push('Minimum stock level cannot be negative.');

    const currentStockNum = parseFloat(current_stock ?? 0);
    if (isNaN(currentStockNum) || currentStockNum < 0) errors.push('Initial stock level cannot be negative.');

    const priceNum = parseFloat(unit_price ?? 0);
    if (isNaN(priceNum) || priceNum < 0) errors.push('Unit price cannot be negative.');

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed.', details: errors });
    }

    let photo_url = null;
    if (req.file) {
      photo_url = `/inventory-photos/${req.file.filename}`;
    }

    const product = await InventoryCutoverService.createProduct({
      sku,
      name,
      category_id,
      unit_of_measure,
      minimum_stock_level,
      current_stock,
      unit_price,
      status,
      photo_url
    });

    return res.status(201).json({ message: 'Product created successfully.', product });
  } catch (error) {
    if (error.status === 409 || error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `Product with SKU '${req.body.sku}' already exists.` });
    }
    console.error('createProduct error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * PUT /api/inventory/products/:id
 * Updates product details.
 */
export const updateProduct = async (req, res) => {
  const { id } = req.params;

  try {
    const {
      name,
      category_id,
      unit_of_measure,
      minimum_stock_level,
      unit_price,
      status
    } = req.body;

    const errors = [];
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      errors.push('Product name cannot be empty.');
    }
    if (unit_of_measure !== undefined && !VALID_UNITS.includes(unit_of_measure)) {
      errors.push(`Unit of measure must be one of: ${VALID_UNITS.join(', ')}.`);
    }
    if (minimum_stock_level !== undefined) {
      const minStockNum = parseFloat(minimum_stock_level);
      if (isNaN(minStockNum) || minStockNum < 0) errors.push('Minimum stock level cannot be negative.');
    }
    if (unit_price !== undefined) {
      const priceNum = parseFloat(unit_price);
      if (isNaN(priceNum) || priceNum < 0) errors.push('Unit price cannot be negative.');
    }
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      errors.push(`Status must be one of: ${VALID_STATUSES.join(', ')}.`);
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed.', details: errors });
    }

    let newPhotoUrl = undefined;
    if (req.file) {
      newPhotoUrl = `/inventory-photos/${req.file.filename}`;
    }

    const payload = {
      name,
      category_id,
      unit_of_measure,
      minimum_stock_level,
      unit_price,
      status
    };
    if (newPhotoUrl) payload.photo_url = newPhotoUrl;

    const result = await InventoryCutoverService.updateProduct(id, payload, req.user);
    return res.json(result);
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Product not found.' });
    console.error('updateProduct error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * DELETE /api/inventory/products/:id
 * Soft deactivates product (`status = 'Inactive'`).
 */
export const deleteProduct = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await InventoryCutoverService.deleteProduct(id);
    return res.json(result);
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Product not found.' });
    console.error('deleteProduct error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
