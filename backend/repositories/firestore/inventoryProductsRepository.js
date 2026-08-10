import { db } from '../../config/firebaseAdmin.js';

export async function getAllInventoryProductsFirestore() {
  const snap = await db.collection('inventory_products').get();
  const products = [];
  snap.forEach(doc => {
    const d = doc.data();
    products.push({
      id: d.mysql_product_id || Number(doc.id.replace('product_', '')),
      sku: d.sku,
      name: d.name,
      category_id: d.mysql_category_id,
      unit_of_measure: d.unit_of_measure,
      minimum_stock_level: d.minimum_stock_level,
      current_stock: d.current_stock,
      unit_price: d.unit_price,
      photo_url: d.photo_url,
      status: d.status,
      created_at: d.created_at,
      updated_at: d.updated_at
    });
  });
  return products.sort((a, b) => a.id - b.id);
}
