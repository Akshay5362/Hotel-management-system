/**
 * inventoryCutoverService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cutover Service for Inventory Categories & Products Master Data.
 * Routes operations to Firestore when USE_FIRESTORE_INVENTORY=true.
 * Provides safe MySQL fallback for infrastructure failures while returning
 * validation errors directly without fallback.
 */

import pool from '../db.js';
import { isFirestoreInventoryEnabled } from '../config/featureFlags.js';
import {
  getAllInventoryCategoriesFirestore,
  getInventoryCategoryByIdFirestore,
  createInventoryCategoryFirestore,
  updateInventoryCategoryFirestore,
  deleteInventoryCategoryFirestore
} from '../repositories/firestore/inventoryCategoriesRepository.js';
import {
  getAllInventoryProductsFirestore,
  getInventoryProductByIdFirestore,
  getInventoryProductBySkuFirestore,
  createInventoryProductFirestore,
  updateInventoryProductFirestore,
  updateProductStockFirestore,
  deleteInventoryProductFirestore
} from '../repositories/firestore/inventoryProductsRepository.js';

export class InventoryCutoverService {

  // ── Categories ──────────────────────────────────────────────────────────────

  static async getCategories() {
    if (isFirestoreInventoryEnabled()) {
      try {
        const docs = await getAllInventoryCategoriesFirestore();
        if (Array.isArray(docs)) {
          const categories = docs.map(d => ({
            id: d.id || d.mysql_category_id || d.docId,
            name: d.name || '',
            department: d.department || 'General',
            created_at: d.created_at || null
          }));
          categories.sort((a, b) => String(a.name).localeCompare(String(b.name)));
          return { categories };
        }
      } catch (err) {
        console.error('[FAIL_CLOSED:INVENTORY] Firestore getCategories failed:', err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    const [rows] = await pool.query(
      'SELECT id, name, department, created_at FROM inventory_categories ORDER BY name ASC'
    );
    return { categories: rows };
  }

  static async createCategory({ name, department }) {
    const catName = name.trim();
    const catDept = (department && typeof department === 'string' && department.trim()) ? department.trim() : 'General';

    if (isFirestoreInventoryEnabled()) {
      try {
        const created = await createInventoryCategoryFirestore({
          name: catName,
          department: catDept
        });

        return {
          id: created.docId || `cat_${catName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
          name: catName,
          department: catDept
        };
      } catch (err) {
        if (err.code === 'DUPLICATE_KEY' || err.status === 409) {
          const dupErr = new Error(`Category '${catName}' already exists.`);
          dupErr.code = 'ER_DUP_ENTRY';
          dupErr.status = 409;
          throw dupErr;
        }
        console.error('[FAIL_CLOSED:INVENTORY] Firestore createCategory failed:', err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [result] = await connection.query(
        'INSERT INTO inventory_categories (name, department) VALUES (?, ?)',
        [catName, catDept]
      );

      const catId = result.insertId;

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'INVENTORY_CATEGORY_CREATED',
          aggregate_type: 'INVENTORY_CATEGORY',
          aggregate_id: catName,
          payload: {
            name: catName,
            department: catDept,
            mysql_category_id: catId,
            updated_at: new Date().toISOString()
          }
        });
      }

      await connection.commit();
      return { id: catId, name: catName, department: catDept };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async updateCategory(id, { name, department }) {
    const catName = name.trim();
    const catDept = (department && typeof department === 'string' && department.trim()) ? department.trim() : 'General';

    if (isFirestoreInventoryEnabled()) {
      try {
        const existing = await getInventoryCategoryByIdFirestore(id);
        if (!existing) {
          const notFoundErr = new Error('Category not found.');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        await updateInventoryCategoryFirestore(existing.docId || id, {
          name: catName,
          department: catDept
        });

        return { id: existing.mysql_category_id || existing.id || Number(id), name: catName, department: catDept };
      } catch (err) {
        if (err.status === 404 || err.status === 409 || err.status === 400) throw err;
        console.error(`[FAIL_CLOSED:INVENTORY] Firestore updateCategory failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [existing] = await connection.query('SELECT * FROM inventory_categories WHERE id = ? OR name = ? FOR UPDATE', [id, id]);
      if (existing.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Category not found.');
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      const catRecord = existing[0];
      await connection.query(
        'UPDATE inventory_categories SET name = ?, department = ? WHERE id = ?',
        [catName, catDept, catRecord.id]
      );

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'INVENTORY_CATEGORY_UPDATED',
          aggregate_type: 'INVENTORY_CATEGORY',
          aggregate_id: catName,
          payload: {
            name: catName,
            department: catDept,
            mysql_category_id: catRecord.id,
            updated_at: new Date().toISOString()
          }
        });
      }

      await connection.commit();
      return { id: catRecord.id, name: catName, department: catDept };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async deleteCategory(id) {
    if (isFirestoreInventoryEnabled()) {
      try {
        const existing = await getInventoryCategoryByIdFirestore(id);
        if (!existing) {
          const notFoundErr = new Error('Category not found.');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        // Check if products exist in category
        const allProds = await getAllInventoryProductsFirestore();
        const hasProds = allProds.some(p => String(p.category_id) === String(id) || String(p.mysql_category_id) === String(id));
        if (hasProds) {
          const inUseErr = new Error('Cannot delete category that contains inventory products.');
          inUseErr.status = 400;
          throw inUseErr;
        }

        await deleteInventoryCategoryFirestore(existing.docId || id);
        return { success: true, message: 'Category deleted successfully.' };
      } catch (err) {
        if (err.status === 400 || err.status === 404) throw err;
        console.error(`[FAIL_CLOSED:INVENTORY] Firestore deleteCategory failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [existing] = await connection.query('SELECT * FROM inventory_categories WHERE id = ? OR name = ? FOR UPDATE', [id, id]);
      if (existing.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Category not found.');
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      const catRecord = existing[0];
      const [prods] = await connection.query('SELECT COUNT(*) as count FROM inventory_products WHERE category_id = ?', [catRecord.id]);
      if (prods[0].count > 0) {
        await connection.rollback();
        const inUseErr = new Error('Cannot delete category that contains inventory products.');
        inUseErr.status = 400;
        throw inUseErr;
      }

      await connection.query('DELETE FROM inventory_categories WHERE id = ?', [catRecord.id]);

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'INVENTORY_CATEGORY_DELETED',
          aggregate_type: 'INVENTORY_CATEGORY',
          aggregate_id: catRecord.name,
          payload: {
            name: catRecord.name,
            docId: `cat_${catRecord.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
            mysql_category_id: catRecord.id
          }
        });
      }

      await connection.commit();
      return { success: true, message: 'Category deleted successfully.' };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  // ── Products ───────────────────────────────────────────────────────────────

  static async getProducts(query = {}) {
    if (isFirestoreInventoryEnabled()) {
      try {
        const { search, category_id, status, low_stock } = query;
        let docs = await getAllInventoryProductsFirestore();

        if (category_id) {
          docs = docs.filter(p => String(p.category_id) === String(category_id) || String(p.mysql_category_id) === String(category_id));
        }
        if (status) {
          docs = docs.filter(p => String(p.status).toLowerCase() === String(status).toLowerCase());
        }
        if (low_stock === 'true' || low_stock === '1') {
          docs = docs.filter(p => Number(p.current_stock || p.stock_quantity || 0) <= Number(p.minimum_stock_level || p.reorder_level || 0));
        }
        if (search && search.trim()) {
          const q = search.trim().toLowerCase();
          docs = docs.filter(p =>
            (p.name && p.name.toLowerCase().includes(q)) ||
            (p.sku && p.sku.toLowerCase().includes(q))
          );
        }

        const products = docs.map(p => {
          const cur = parseFloat(p.current_stock !== undefined ? p.current_stock : (p.stock_quantity || 0));
          const min = parseFloat(p.minimum_stock_level !== undefined ? p.minimum_stock_level : (p.reorder_level || 0));
          let stock_status = 'In Stock';
          if (cur <= 0) stock_status = 'Out of Stock';
          else if (cur <= min) stock_status = 'Low Stock';

          return {
            id: p.id || p.mysql_product_id || p.docId,
            sku: p.sku || '',
            name: p.name || '',
            category_id: p.category_id || p.mysql_category_id || 1,
            category_name: p.category_name || 'General',
            category_department: p.category_department || 'General',
            unit_of_measure: p.unit_of_measure || p.unit || 'pcs',
            minimum_stock_level: min,
            current_stock: cur,
            unit_price: parseFloat(p.unit_price || 0),
            photo_url: p.photo_url || null,
            status: p.status || 'Active',
            created_at: p.created_at || null,
            updated_at: p.updated_at || null,
            stock_status
          };
        });

        products.sort((a, b) => String(a.name).localeCompare(String(b.name)));

        const metrics = {
          totalProducts: products.length,
          activeProducts: products.filter(p => p.status === 'Active').length,
          lowStockProducts: products.filter(p => p.status === 'Active' && p.current_stock > 0 && p.current_stock <= p.minimum_stock_level).length,
          outOfStockProducts: products.filter(p => p.status === 'Active' && p.current_stock <= 0).length
        };

        return { products, metrics };
      } catch (err) {
        console.error('[FAIL_CLOSED:INVENTORY] Firestore getProducts failed:', err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    const { search, category_id, status, low_stock } = query;
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
    if (status) {
      whereClause.push('p.status = ?');
      params.push(status);
    }
    if (low_stock === 'true' || low_stock === '1') {
      whereClause.push('p.current_stock <= p.minimum_stock_level');
    }

    const [rows] = await pool.query(`
      SELECT 
        p.id, p.sku, p.name, p.category_id,
        c.name AS category_name, c.department AS category_department,
        p.unit_of_measure,
        CAST(p.minimum_stock_level AS DOUBLE) AS minimum_stock_level,
        CAST(p.current_stock AS DOUBLE) AS current_stock,
        CAST(p.unit_price AS DOUBLE) AS unit_price,
        p.photo_url, p.status, p.created_at, p.updated_at
      FROM inventory_products p
      JOIN inventory_categories c ON p.category_id = c.id
      WHERE ${whereClause.join(' AND ')}
      ORDER BY p.name ASC
    `, params);

    const products = rows.map(p => {
      let stock_status = 'In Stock';
      if (p.current_stock <= 0) stock_status = 'Out of Stock';
      else if (p.current_stock <= p.minimum_stock_level) stock_status = 'Low Stock';
      return { ...p, stock_status };
    });

    const [allProducts] = await pool.query(
      'SELECT CAST(current_stock AS DOUBLE) AS current_stock, CAST(minimum_stock_level AS DOUBLE) AS minimum_stock_level, status FROM inventory_products'
    );

    const metrics = {
      totalProducts: allProducts.length,
      activeProducts: allProducts.filter(p => p.status === 'Active').length,
      lowStockProducts: allProducts.filter(p => p.status === 'Active' && parseFloat(p.current_stock) > 0 && parseFloat(p.current_stock) <= parseFloat(p.minimum_stock_level)).length,
      outOfStockProducts: allProducts.filter(p => p.status === 'Active' && parseFloat(p.current_stock) <= 0).length
    };

    return { products, metrics };
  }

  static async getProductById(id) {
    if (isFirestoreInventoryEnabled()) {
      try {
        const doc = await getInventoryProductByIdFirestore(id);
        if (doc) {
          const cur = parseFloat(doc.current_stock !== undefined ? doc.current_stock : (doc.stock_quantity || 0));
          const min = parseFloat(doc.minimum_stock_level !== undefined ? doc.minimum_stock_level : (doc.reorder_level || 0));
          let stock_status = 'In Stock';
          if (cur <= 0) stock_status = 'Out of Stock';
          else if (cur <= min) stock_status = 'Low Stock';

          return {
            id: doc.id || doc.mysql_product_id || id,
            sku: doc.sku,
            name: doc.name,
            category_id: doc.category_id || doc.mysql_category_id || 1,
            category_name: doc.category_name || 'General',
            category_department: doc.category_department || 'General',
            unit_of_measure: doc.unit_of_measure || doc.unit || 'pcs',
            minimum_stock_level: min,
            current_stock: cur,
            unit_price: parseFloat(doc.unit_price || 0),
            photo_url: doc.photo_url || null,
            status: doc.status || 'Active',
            created_at: doc.created_at,
            updated_at: doc.updated_at,
            stock_status
          };
        }
        return null;
      } catch (err) {
        console.error(`[FAIL_CLOSED:INVENTORY] Firestore getProductById failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    const [rows] = await pool.query(`
      SELECT 
        p.*, c.name AS category_name, c.department AS category_department
      FROM inventory_products p
      LEFT JOIN inventory_categories c ON p.category_id = c.id
      WHERE p.id = ? OR p.sku = ?
    `, [id, id]);

    if (rows.length === 0) return null;
    const p = rows[0];
    const cur = parseFloat(p.current_stock || 0);
    const min = parseFloat(p.minimum_stock_level || 0);
    let stock_status = 'In Stock';
    if (cur <= 0) stock_status = 'Out of Stock';
    else if (cur <= min) stock_status = 'Low Stock';
    return {
      ...p,
      current_stock: cur,
      minimum_stock_level: min,
      unit_price: parseFloat(p.unit_price || 0),
      stock_status
    };
  }

  static async createProduct(payload) {
    const { sku, name, category_id, unit_of_measure, minimum_stock_level, current_stock, unit_price, status, photo_url } = payload;
    const cleanSku = String(sku).trim().toUpperCase();

    if (isFirestoreInventoryEnabled()) {
      try {
        const existing = await getInventoryProductBySkuFirestore(cleanSku);
        if (existing) {
          const dupErr = new Error(`Product with SKU '${cleanSku}' already exists.`);
          dupErr.code = 'ER_DUP_ENTRY';
          dupErr.status = 409;
          throw dupErr;
        }

        const created = await createInventoryProductFirestore({
          sku: cleanSku,
          name: name.trim(),
          category_id: String(category_id),
          unit_of_measure: unit_of_measure || 'pcs',
          minimum_stock_level: parseFloat(minimum_stock_level || 0),
          current_stock: parseFloat(current_stock || 0),
          unit_price: parseFloat(unit_price || 0),
          status: status || 'Active',
          photo_url: photo_url || null
        });

        return {
          id: created.docId || `prod_${cleanSku}`,
          sku: cleanSku,
          name: name.trim(),
          category_id: parseInt(category_id, 10),
          unit_of_measure,
          minimum_stock_level: parseFloat(minimum_stock_level || 0),
          current_stock: parseFloat(current_stock || 0),
          unit_price: parseFloat(unit_price || 0),
          photo_url: photo_url || null,
          status: status || 'Active'
        };
      } catch (err) {
        if (err.status === 409 || err.code === 'DUPLICATE_KEY' || err.status === 400) throw err;
        console.error('[FAIL_CLOSED:INVENTORY] Firestore createProduct failed:', err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [result] = await connection.query(
        `INSERT INTO inventory_products (
          sku, name, category_id, unit_of_measure,
          minimum_stock_level, current_stock, unit_price, photo_url, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cleanSku,
          name.trim(),
          parseInt(category_id, 10) || 1,
          unit_of_measure || 'pcs',
          parseFloat(minimum_stock_level || 0),
          parseFloat(current_stock || 0),
          parseFloat(unit_price || 0),
          photo_url || null,
          status || 'Active'
        ]
      );

      const productId = result.insertId;

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'INVENTORY_PRODUCT_CREATED',
          aggregate_type: 'INVENTORY_PRODUCT',
          aggregate_id: cleanSku,
          payload: {
            id: productId,
            sku: cleanSku,
            name: name.trim(),
            category_id: parseInt(category_id, 10) || 1,
            unit_of_measure: unit_of_measure || 'pcs',
            minimum_stock_level: parseFloat(minimum_stock_level || 0),
            current_stock: parseFloat(current_stock || 0),
            unit_price: parseFloat(unit_price || 0),
            photo_url: photo_url || null,
            status: status || 'Active',
            mysql_product_id: productId,
            updated_at: new Date().toISOString()
          }
        });
      }

      await connection.commit();
      return { id: productId, sku: cleanSku, name: name.trim(), category_id: parseInt(category_id, 10) || 1, current_stock: parseFloat(current_stock || 0) };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async updateProduct(id, payload, reqUser = null) {
    if (isFirestoreInventoryEnabled()) {
      try {
        const existing = await getInventoryProductByIdFirestore(id);
        if (!existing) {
          const notFoundErr = new Error('Product not found.');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        const updates = { ...payload };
        delete updates.current_stock; // Disallow arbitrary current_stock mutation

        await updateInventoryProductFirestore(existing.docId || id, updates);

        return { success: true, message: 'Product updated successfully.' };
      } catch (err) {
        if (err.status === 404 || err.status === 409 || err.status === 400) throw err;
        console.error(`[FAIL_CLOSED:INVENTORY] Firestore updateProduct failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [existing] = await connection.query('SELECT * FROM inventory_products WHERE id = ? OR sku = ? FOR UPDATE', [id, id]);
      if (existing.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Product not found.');
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      const currentProduct = existing[0];
      const updates = {
        name: payload.name !== undefined ? payload.name.trim() : currentProduct.name,
        category_id: payload.category_id !== undefined ? parseInt(payload.category_id, 10) : currentProduct.category_id,
        unit_of_measure: payload.unit_of_measure !== undefined ? payload.unit_of_measure : currentProduct.unit_of_measure,
        minimum_stock_level: payload.minimum_stock_level !== undefined ? parseFloat(payload.minimum_stock_level) : currentProduct.minimum_stock_level,
        unit_price: payload.unit_price !== undefined ? parseFloat(payload.unit_price) : currentProduct.unit_price,
        photo_url: payload.photo_url !== undefined ? payload.photo_url : currentProduct.photo_url,
        status: payload.status !== undefined ? payload.status : currentProduct.status
      };

      await connection.query('UPDATE inventory_products SET ? WHERE id = ?', [updates, currentProduct.id]);

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'INVENTORY_PRODUCT_UPDATED',
          aggregate_type: 'INVENTORY_PRODUCT',
          aggregate_id: currentProduct.sku,
          payload: {
            sku: currentProduct.sku,
            ...updates,
            mysql_product_id: currentProduct.id,
            updated_at: new Date().toISOString()
          }
        });
      }

      await connection.commit();
      return { success: true, message: 'Product updated successfully.' };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async updateStock(productId, quantityDelta, options = {}) {
    const delta = Number(quantityDelta);
    if (isNaN(delta)) throw new Error('Quantity delta must be a number');

    if (isFirestoreInventoryEnabled()) {
      try {
        await updateProductStockFirestore(productId, delta, options);
        return { success: true, delta };
      } catch (err) {
        if (err.code === 'INSUFFICIENT_STOCK' || err.status === 400 || err.status === 404) throw err;
        console.error(`[FAIL_CLOSED:INVENTORY] Firestore updateStock failed for ${productId}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [existing] = await connection.query('SELECT id, current_stock, minimum_stock_level FROM inventory_products WHERE id = ? OR sku = ? FOR UPDATE', [productId, productId]);
      if (existing.length === 0) {
        await connection.rollback();
        throw new Error('Product not found');
      }

      const current = existing[0];
      const newStock = Number(current.current_stock) + delta;
      if (newStock < 0) {
        await connection.rollback();
        const err = new Error('Insufficient stock quantity');
        err.code = 'INSUFFICIENT_STOCK';
        throw err;
      }

      await connection.query('UPDATE inventory_products SET current_stock = ? WHERE id = ?', [newStock, current.id]);
      await connection.commit();
      return { success: true, current_stock: newStock };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async deleteProduct(id) {
    if (isFirestoreInventoryEnabled()) {
      try {
        const existing = await getInventoryProductByIdFirestore(id);
        if (!existing) {
          const notFoundErr = new Error('Product not found.');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        await updateInventoryProductFirestore(existing.docId || id, {
          status: 'Inactive',
          updated_at: new Date().toISOString()
        });

        return { success: true, message: 'Product deactivated successfully.' };
      } catch (err) {
        if (err.status === 404 || err.status === 400) throw err;
        console.error(`[FAIL_CLOSED:INVENTORY] Firestore deleteProduct failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [existing] = await connection.query('SELECT id, sku, name FROM inventory_products WHERE id = ? OR sku = ? FOR UPDATE', [id, id]);
      if (existing.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Product not found.');
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      const product = existing[0];
      await connection.query("UPDATE inventory_products SET status = 'Inactive' WHERE id = ?", [product.id]);

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'INVENTORY_PRODUCT_DEACTIVATED',
          aggregate_type: 'INVENTORY_PRODUCT',
          aggregate_id: product.sku,
          payload: {
            sku: product.sku,
            name: product.name,
            status: 'Inactive',
            mysql_product_id: product.id,
            updated_at: new Date().toISOString()
          }
        });
      }

      await connection.commit();
      return { success: true, message: 'Product deactivated successfully.' };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }
}
