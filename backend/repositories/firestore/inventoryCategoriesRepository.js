import { db } from '../../config/firebaseAdmin.js';

export async function getAllInventoryCategoriesFirestore() {
  const snap = await db.collection('inventory_categories').get();
  const categories = [];
  snap.forEach(doc => {
    const d = doc.data();
    categories.push({
      id: d.mysql_category_id || Number(doc.id.replace('category_', '')),
      name: d.name,
      department: d.department,
      created_at: d.created_at
    });
  });
  return categories.sort((a, b) => a.id - b.id);
}
