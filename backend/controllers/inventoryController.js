/**
 * inventoryController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Controller handlers for Inventory Categories and Product Master management.
 */

import pool from '../db.js';
import { BusinessDateService } from '../services/businessDateService.js';
import { VALID_UNITS, VALID_STATUSES } from '../utils/inventoryConstants.js';
import { removeOldProductPhoto } from '../middleware/inventoryUploadMiddleware.js';

/**
 * GET /api/inventory/categories
 * Retrieves all inventory categories.
 */
export const getCategories = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, department, created_at FROM inventory_categories ORDER BY name ASC'
    );
    return res.json({ categories: rows });
  } catch (error) {
    console.error('getCategories error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * GET /api/inventory/products
 * Retrieves product list with filters and calculates stock statuses & dashboard summary metrics.
 */
export const getProducts = async (req, res) => {
  try {
    const { search, category_id, status, low_stock } = req.query;

    let whereClause = ['1=1'];
    const params = [];

    if (search && search.trim()) {
      whereClause.push('(p.name LIKE ? OR p.sku LIKE ?)');
      const term = `%${search.trim()}%`;
      params.push(term, term);
    }

    if (category_id && !isNaN(parseInt(category_id, 10))) {
      whereClause.push('p.category_id = ?');
      params.push(parseInt(category_id, 10));
    }

    if (status && VALID_STATUSES.includes(status)) {
      whereClause.push('p.status = ?');
      params.push(status);
    }

    if (low_stock === 'true' || low_stock === '1') {
      whereClause.push('p.current_stock <= p.minimum_stock_level');
    }

    const query = `
      SELECT 
        p.id,
        p.sku,
        p.name,
        p.category_id,
        c.name AS category_name,
        c.department AS category_department,
        p.unit_of_measure,
        CAST(p.minimum_stock_level AS DOUBLE) AS minimum_stock_level,
        CAST(p.current_stock AS DOUBLE) AS current_stock,
        CAST(p.unit_price AS DOUBLE) AS unit_price,
        p.photo_url,
        p.status,
        p.created_at,
        p.updated_at
      FROM inventory_products p
      JOIN inventory_categories c ON p.category_id = c.id
      WHERE ${whereClause.join(' AND ')}
      ORDER BY p.name ASC
    `;

    const [rows] = await pool.query(query, params);

    // Compute stock_status for each product
    const products = rows.map(p => {
      let stock_status = 'In Stock';
      if (p.current_stock <= 0) {
        stock_status = 'Out of Stock';
      } else if (p.current_stock <= p.minimum_stock_level) {
        stock_status = 'Low Stock';
      }
      return { ...p, stock_status };
    });

    // Compute Overall Inventory Metrics Summary
    const [allProducts] = await pool.query(
      `SELECT 
        CAST(current_stock AS DOUBLE) AS current_stock, 
        CAST(minimum_stock_level AS DOUBLE) AS minimum_stock_level, 
        status 
       FROM inventory_products`
    );

    const metrics = {
      totalProducts: allProducts.length,
      activeProducts: allProducts.filter(p => p.status === 'Active').length,
      lowStockProducts: allProducts.filter(p => {
        const cur = parseFloat(p.current_stock);
        const min = parseFloat(p.minimum_stock_level);
        return p.status === 'Active' && cur > 0 && cur <= min;
      }).length,
      outOfStockProducts: allProducts.filter(p => {
        const cur = parseFloat(p.current_stock);
        return p.status === 'Active' && cur <= 0;
      }).length
    };


    return res.json({ products, metrics });
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
    const [rows] = await pool.query(
      `SELECT 
        p.*,
        c.name AS category_name,
        c.department AS category_department
       FROM inventory_products p
       JOIN inventory_categories c ON p.category_id = c.id
       WHERE p.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const p = rows[0];
    const cur = parseFloat(p.current_stock);
    const min = parseFloat(p.minimum_stock_level);
    let stock_status = 'In Stock';
    if (cur <= 0) {
      stock_status = 'Out of Stock';
    } else if (cur <= min) {
      stock_status = 'Low Stock';
    }


    return res.json({ product: { ...p, stock_status } });
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
  let connection;
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

    // Validation
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

    const prodStatus = status && VALID_STATUSES.includes(status) ? status : 'Active';

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed.', details: errors });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Verify SKU uniqueness
    const [existingSku] = await connection.query(
      'SELECT id FROM inventory_products WHERE sku = ?',
      [sku.trim()]
    );
    if (existingSku.length > 0) {
      await connection.rollback();
      return res.status(409).json({ error: `SKU '${sku.trim()}' is already in use. Please enter a unique SKU.` });
    }

    // Verify category existence
    const [existingCat] = await connection.query(
      'SELECT id FROM inventory_categories WHERE id = ?',
      [catIdNum]
    );
    if (existingCat.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Selected category does not exist.' });
    }

    // Photo URL
    const photo_url = req.file ? `/inventory-photos/${req.file.filename}` : null;

    // Insert Product
    const [result] = await connection.query(
      `INSERT INTO inventory_products 
        (sku, name, category_id, unit_of_measure, minimum_stock_level, current_stock, unit_price, photo_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sku.trim().toUpperCase(),
        name.trim(),
        catIdNum,
        unit_of_measure,
        minStockNum,
        currentStockNum,
        priceNum,
        photo_url,
        prodStatus
      ]
    );

    const productId = result.insertId;

    // Audit log
    const businessDate = await BusinessDateService.getBusinessDate(connection);
    const userId = req.user?.id || null;
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'INVENTORY_PRODUCT_CREATED', ?, ?)`,
      [userId, `Created inventory product: SKU=${sku.trim().toUpperCase()}, Name=${name.trim()}, InitialStock=${currentStockNum}`, businessDate]
    );

    await connection.commit();

    return res.status(201).json({
      message: 'Product created successfully.',
      productId
    });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) {}
    }
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'A product with this SKU already exists.' });
    }
    console.error('createProduct error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * PUT /api/inventory/products/:id
 * Updates product details.
 * CRITICAL ADJUSTMENT 3: Does NOT allow arbitrary editing of current_stock.
 * CRITICAL ADJUSTMENT 2: Manages photo replacement safely.
 */
export const updateProduct = async (req, res) => {
  const { id } = req.params;
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Check existing product
    const [existing] = await connection.query(
      'SELECT * FROM inventory_products WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Product not found.' });
    }

    const currentProduct = existing[0];
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

    if (category_id !== undefined) {
      const catIdNum = parseInt(category_id, 10);
      if (isNaN(catIdNum)) {
        errors.push('Valid Category ID is required.');
      } else {
        const [catCheck] = await connection.query('SELECT id FROM inventory_categories WHERE id = ?', [catIdNum]);
        if (catCheck.length === 0) errors.push('Selected category does not exist.');
      }
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
      await connection.rollback();
      return res.status(400).json({ error: 'Validation failed.', details: errors });
    }

    // Photo Replacement Lifecycle Handling
    let newPhotoUrl = currentProduct.photo_url;
    let oldPhotoToDelete = null;

    if (req.file) {
      newPhotoUrl = `/inventory-photos/${req.file.filename}`;
      oldPhotoToDelete = currentProduct.photo_url;
    }

    // Build updates (explicitly excluding current_stock to prevent silent stock corruption)
    const updates = {
      name: name !== undefined ? name.trim() : currentProduct.name,
      category_id: category_id !== undefined ? parseInt(category_id, 10) : currentProduct.category_id,
      unit_of_measure: unit_of_measure !== undefined ? unit_of_measure : currentProduct.unit_of_measure,
      minimum_stock_level: minimum_stock_level !== undefined ? parseFloat(minimum_stock_level) : currentProduct.minimum_stock_level,
      unit_price: unit_price !== undefined ? parseFloat(unit_price) : currentProduct.unit_price,
      photo_url: newPhotoUrl,
      status: status !== undefined ? status : currentProduct.status
    };

    await connection.query('UPDATE inventory_products SET ? WHERE id = ?', [updates, id]);

    // Audit log
    const businessDate = await BusinessDateService.getBusinessDate(connection);
    const userId = req.user?.id || null;
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'INVENTORY_PRODUCT_UPDATED', ?, ?)`,
      [userId, `Updated inventory product: SKU=${currentProduct.sku}, Name=${updates.name}`, businessDate]
    );

    await connection.commit();

    // Safely remove old photo if it was replaced (post-commit to ensure DB safety)
    if (oldPhotoToDelete) {
      removeOldProductPhoto(oldPhotoToDelete).catch(err => {
        console.warn('Old photo cleanup warning:', err);
      });
    }

    return res.json({ message: 'Product updated successfully.' });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) {}
    }
    console.error('updateProduct error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * DELETE /api/inventory/products/:id
 * Soft deactivates product (`status = 'Inactive'`).
 * Does NOT delete the photo.
 */
export const deleteProduct = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [existing] = await connection.query(
      'SELECT id, sku, name FROM inventory_products WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Product not found.' });
    }

    const product = existing[0];

    // Soft deactivation
    await connection.query(
      "UPDATE inventory_products SET status = 'Inactive' WHERE id = ?",
      [id]
    );

    // Audit log
    const businessDate = await BusinessDateService.getBusinessDate(connection);
    const userId = req.user?.id || null;
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'INVENTORY_PRODUCT_DEACTIVATED', ?, ?)`,
      [userId, `Deactivated inventory product: SKU=${product.sku}, Name=${product.name}`, businessDate]
    );

    await connection.commit();

    return res.json({ message: 'Product deactivated successfully.' });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (e) {}
    }
    console.error('deleteProduct error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};
