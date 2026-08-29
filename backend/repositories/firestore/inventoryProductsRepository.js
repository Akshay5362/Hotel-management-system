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
import { FieldValue } from 'firebase-admin/firestore';

const COLLECTION = 'inventory_products';

/**
 * Checks whether an incoming payload is stale compared to the existing Firestore document.
 */
function isStaleUpdate(existingDoc, incomingData) {
  if (!existingDoc || !existingDoc.updated_at || !incomingData || !incomingData.updated_at) {
    return false;
  }
  const existingTime = new Date(existingDoc.updated_at).getTime();
  const incomingTime = new Date(incomingData.updated_at).getTime();
  return !isNaN(existingTime) && !isNaN(incomingTime) && existingTime > incomingTime;
}

export async function getInventoryProductByIdFirestore(productId, options = {}) {
  if (!productId) return null;
  const docId = String(productId).startsWith('prod_') ? String(productId) : formatProductDocId(productId);
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
    filters: [{ field: 'sku', op: '==', value: String(sku).trim() }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllInventoryProductsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'name', direction: 'asc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createInventoryProductFirestore(prodData, options = {}) {
  validateRequiredFields(prodData, ['name', 'sku'], 'InventoryProduct');
  const skuStr = String(prodData.sku).trim().toUpperCase();
  const docId = formatProductDocId(skuStr);

  const existing = await getDoc(COLLECTION, docId, options);

  const payload = {
    name: String(prodData.name).trim(),
    sku: skuStr,
    category_id: prodData.category_id ? String(prodData.category_id) : null,
    mysql_category_id: prodData.mysql_category_id || null,
    stock_quantity: Number(prodData.current_stock !== undefined ? prodData.current_stock : (prodData.stock_quantity || prodData.quantity || 0)),
    current_stock: Number(prodData.current_stock !== undefined ? prodData.current_stock : (prodData.stock_quantity || prodData.quantity || 0)),
    reorder_level: Number(prodData.minimum_stock_level !== undefined ? prodData.minimum_stock_level : (prodData.reorder_level || 5)),
    minimum_stock_level: Number(prodData.minimum_stock_level !== undefined ? prodData.minimum_stock_level : (prodData.reorder_level || 5)),
    unit_price: Number(prodData.unit_price || 0),
    unit: prodData.unit || prodData.unit_of_measure || 'pcs',
    unit_of_measure: prodData.unit_of_measure || prodData.unit || 'pcs',
    photo_url: prodData.photo_url || null,
    status: prodData.status || 'Active',
    mysql_product_id: prodData.mysql_product_id || prodData.id || null,
    created_at: prodData.created_at || new Date().toISOString(),
    updated_at: prodData.updated_at || new Date().toISOString()
  };

  if (existing) {
    if (isStaleUpdate(existing, payload)) {
      console.log(`[OutboxGuard] Ignored stale product create/upsert for ${docId}`);
      return existing;
    }
    return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
  }

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateInventoryProductFirestore(productId, prodData, options = {}) {
  if (!productId) throw new RepositoryError('Product ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(productId).startsWith('prod_') ? String(productId) : formatProductDocId(productId);

  const existing = await getDoc(COLLECTION, docId, options);

  const payload = typeof prodData === 'object' && prodData !== null ? { ...prodData } : {};
  payload.updated_at = payload.updated_at || new Date().toISOString();

  if (payload.current_stock !== undefined && payload.stock_quantity === undefined) {
    payload.stock_quantity = Number(payload.current_stock);
  }
  if (payload.minimum_stock_level !== undefined && payload.reorder_level === undefined) {
    payload.reorder_level = Number(payload.minimum_stock_level);
  }

  if (existing && isStaleUpdate(existing, payload)) {
    console.log(`[OutboxGuard] Ignored stale inventory product update for ${docId}`);
    return existing;
  }

  if (!existing) {
    if (!payload.name || !payload.sku) {
      throw new RepositoryError(`Inventory product '${productId}' not found`, 'NOT_FOUND', 404);
    }
    return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
  }

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateProductStockFirestore(productId, quantityDelta, options = {}) {
  if (!productId) throw new RepositoryError('Product ID is required for stock update', 'VALIDATION_ERROR', 400);
  const docId = String(productId).startsWith('prod_') ? String(productId) : formatProductDocId(productId);

  const delta = Number(quantityDelta);
  if (isNaN(delta)) throw new RepositoryError('Quantity delta must be a valid number', 'VALIDATION_ERROR', 400);

  const { transaction } = options;
  if (transaction) {
    const existing = await getDoc(COLLECTION, docId, { transaction });
    if (!existing) throw new RepositoryError(`Inventory product '${productId}' not found`, 'NOT_FOUND', 404);
    const newQty = (existing.stock_quantity !== undefined ? existing.stock_quantity : (existing.current_stock || 0)) + delta;
    if (newQty < 0) {
      throw new RepositoryError(`Insufficient stock quantity for product '${existing.name}'`, 'INSUFFICIENT_STOCK', 400);
    }
    return await updateDoc(COLLECTION, docId, { stock_quantity: newQty, current_stock: newQty, updated_at: new Date().toISOString() }, options);
  }

  const existing = await getDoc(COLLECTION, docId, options);
  if (!existing) throw new RepositoryError(`Inventory product '${productId}' not found`, 'NOT_FOUND', 404);
  const currentQty = existing.stock_quantity !== undefined ? existing.stock_quantity : (existing.current_stock || 0);
  const newQty = currentQty + delta;
  if (newQty < 0) {
    throw new RepositoryError(`Insufficient stock quantity for product '${existing.name}'`, 'INSUFFICIENT_STOCK', 400);
  }

  return await updateDoc(COLLECTION, docId, { stock_quantity: newQty, current_stock: newQty, updated_at: new Date().toISOString() }, options);
}

export async function deleteInventoryProductFirestore(productId, options = {}) {
  if (!productId) throw new RepositoryError('Product ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(productId).startsWith('prod_') ? String(productId) : formatProductDocId(productId);
  return await deleteDoc(COLLECTION, docId, options);
}
