/**
 * seedOfficialMenu.mjs — runs from d:\projects\hotel
 */

import { createFoodCategoryFirestore, createFoodItemFirestore } from '../repositories/firestore/foodMenuRepository.js';

const NOW = new Date().toISOString();

const CATEGORIES = [
  { name: 'Breakfast Combos',              icon_emoji: '🍳', display_order: 10 },
  { name: 'Eggs',                          icon_emoji: '🥚', display_order: 20 },
  { name: 'All-day Snacks',               icon_emoji: '🍿', display_order: 30 },
  { name: 'Indo - Chinese',               icon_emoji: '🥡', display_order: 40 },
  { name: 'Rice Delights',                icon_emoji: '🍚', display_order: 50 },
  { name: 'Vegetarian Main Dishes',       icon_emoji: '🥗', display_order: 60 },
  { name: 'Non Vegetarian Main Dishes',   icon_emoji: '🍗', display_order: 70 },
  { name: "Chef's Combos",               icon_emoji: '👨‍🍳', display_order: 80 },
  { name: 'Breads',                       icon_emoji: '🫓', display_order: 90 },
  { name: 'Salads',                       icon_emoji: '🥙', display_order: 100 },
  { name: 'Beverages',                    icon_emoji: '🍵', display_order: 110 },
  { name: 'Desserts',                     icon_emoji: '🍮', display_order: 120 },
];

const ITEMS = [
  // Breakfast Combos
  { name: 'Aloo Paratha',           categoryName: 'Breakfast Combos',            base_price: 120,  is_veg: true },
  { name: 'Poha Combo',             categoryName: 'Breakfast Combos',            base_price: 159,  is_veg: true },
  { name: 'Paneer Paratha Combo',   categoryName: 'Breakfast Combos',            base_price: 209,  is_veg: true },
  // Eggs
  { name: 'Egg Bhurji',             categoryName: 'Eggs',                        base_price: 120,  is_veg: false },
  { name: 'Scrambled Eggs',         categoryName: 'Eggs',                        base_price: 0,    is_veg: false, is_active: false,
    description: 'PRICE PENDING CONFIRMATION — not listed in official Sky_5_Menu_14_July_26.pdf. Activate after price is confirmed by hotel management.' },
  { name: 'Omelette Combo',         categoryName: 'Eggs',                        base_price: 159,  is_veg: false },
  { name: 'Veg Sandwich Combo',     categoryName: 'Eggs',                        base_price: 159,  is_veg: true },
  // All-day Snacks
  { name: 'French Fries',           categoryName: 'All-day Snacks',             base_price: 179,  is_veg: true },
  { name: 'Mix Pakora',             categoryName: 'All-day Snacks',             base_price: 199,  is_veg: true },
  { name: 'Chicken Pakora',         categoryName: 'All-day Snacks',             base_price: 249,  is_veg: false },
  { name: 'Masala Papad',           categoryName: 'All-day Snacks',             base_price: 100,  is_veg: true },
  { name: 'Plain Papad',            categoryName: 'All-day Snacks',             base_price: 80,   is_veg: true },
  { name: 'Masala Peanuts',         categoryName: 'All-day Snacks',             base_price: 149,  is_veg: true },
  // Indo - Chinese
  { name: 'Honey Chilli Potato',    categoryName: 'Indo - Chinese',             base_price: 229,  is_veg: true },
  { name: 'Chilli Potato',          categoryName: 'Indo - Chinese',             base_price: 199,  is_veg: true },
  { name: 'Veg Manchurian',         categoryName: 'Indo - Chinese',             base_price: 249,  is_veg: true },
  // Rice Delights
  { name: 'Jeera Rice',             categoryName: 'Rice Delights',              base_price: 179,  is_veg: true },
  { name: 'Plain Rice',             categoryName: 'Rice Delights',              base_price: 119,  is_veg: true },
  { name: 'Veg Fried Rice',         categoryName: 'Rice Delights',              base_price: 219,  is_veg: true },
  // Vegetarian Main Dishes
  { name: 'Dal Tadka',              categoryName: 'Vegetarian Main Dishes',     base_price: 199,  is_veg: true },
  { name: 'Dal Makhani',            categoryName: 'Vegetarian Main Dishes',     base_price: 229,  is_veg: true },
  { name: 'Chana Masala',           categoryName: 'Vegetarian Main Dishes',     base_price: 229,  is_veg: true },
  { name: 'Paneer Butter Masala',   categoryName: 'Vegetarian Main Dishes',     base_price: 289,  is_veg: true },
  // Non Vegetarian Main Dishes
  { name: 'Butter Chicken',         categoryName: 'Non Vegetarian Main Dishes', base_price: 599,  is_veg: false },
  { name: 'Chicken Curry',          categoryName: 'Non Vegetarian Main Dishes', base_price: 399,  is_veg: false },
  { name: 'Egg Curry',              categoryName: 'Non Vegetarian Main Dishes', base_price: 179,  is_veg: false },
  { name: 'Chili Chicken',          categoryName: 'Non Vegetarian Main Dishes', base_price: 289,  is_veg: false },
  // Chef's Combos (seeded ONCE)
  { name: 'Veg Combo',              categoryName: "Chef's Combos",             base_price: 299,  is_veg: true },
  { name: 'Non-Veg Combo',          categoryName: "Chef's Combos",             base_price: 449,  is_veg: false },
  // Breads
  { name: 'Tawa Roti',              categoryName: 'Breads',                     base_price: 25,   is_veg: true },
  { name: 'Tawa Butter Roti',       categoryName: 'Breads',                     base_price: 30,   is_veg: true },
  { name: 'Missi Roti',             categoryName: 'Breads',                     base_price: 40,   is_veg: true },
  { name: 'Malabar Paratha',        categoryName: 'Breads',                     base_price: 60,   is_veg: true },
  // Salads
  { name: 'Fresh Salad',            categoryName: 'Salads',                     base_price: 119,  is_veg: true },
  { name: 'Chickpea Salad',         categoryName: 'Salads',                     base_price: 169,  is_veg: true },
  // Beverages
  { name: 'Chai',                   categoryName: 'Beverages',                  base_price: 70,   is_veg: true },
  { name: 'Coffee',                 categoryName: 'Beverages',                  base_price: 70,   is_veg: true },
  { name: 'Black Tea',              categoryName: 'Beverages',                  base_price: 50,   is_veg: true },
  { name: 'Green Tea',              categoryName: 'Beverages',                  base_price: 50,   is_veg: true },
  { name: 'Salted Lassi',           categoryName: 'Beverages',                  base_price: 109,  is_veg: true },
  { name: 'Sweet Lassi',            categoryName: 'Beverages',                  base_price: 109,  is_veg: true },
  { name: 'Glass of Milk',          categoryName: 'Beverages',                  base_price: 70,   is_veg: true },
  { name: 'Mineral Water',          categoryName: 'Beverages',                  base_price: 50,   is_veg: true },
  { name: 'Soft Drinks',            categoryName: 'Beverages',                  base_price: 50,   is_veg: true,
    description: 'Coca-Cola / Limca / Seven Up — please specify choice when ordering.' },
  { name: 'Refreshers',             categoryName: 'Beverages',                  base_price: 70,   is_veg: true },
  // Desserts
  { name: 'Gulab Jamun',            categoryName: 'Desserts',                   base_price: 109,  is_veg: true },
  { name: 'Kulfi (Stick)',          categoryName: 'Desserts',                   base_price: 99,   is_veg: true },
  { name: 'Vanilla Ice Cream (One Scoop)',  categoryName: 'Desserts',           base_price: 99,   is_veg: true,
    description: 'One scoop of Vanilla Ice Cream.' },
  { name: 'Vanilla Ice Cream (Two Scoops)', categoryName: 'Desserts',          base_price: 169,  is_veg: true,
    description: 'Two scoops of Vanilla Ice Cream.' },
];

async function seed() {
  console.log('\n' + '='.repeat(62));
  console.log(' Hotel Sky-5 — Official Menu Seeder');
  console.log(' Source: Sky_5_Menu_14_July_26.pdf');
  console.log('='.repeat(62));

  const categoryIdMap = {};
  let catsCreated = 0, catsSkipped = 0;
  let itemsCreated = 0, itemsSkipped = 0, itemsError = 0;
  const pendingConfirmation = [];

  console.log('\n── PHASE 1: CATEGORIES ─────────────────────────────────────');
  for (const cat of CATEGORIES) {
    try {
      const doc = await createFoodCategoryFirestore({
        name: cat.name, icon_emoji: cat.icon_emoji,
        display_order: cat.display_order, is_active: true,
        created_at: NOW, updated_at: NOW
      });
      categoryIdMap[cat.name] = doc.category_id;
      console.log(`  ✅ CREATED   [${doc.category_id}] "${cat.name}"`);
      catsCreated++;
    } catch (e) {
      if (e.code === 'DUPLICATE_KEY' || (e.message && e.message.includes('already exists'))) {
        const slug = cat.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        categoryIdMap[cat.name] = `fcat_${slug}`;
        console.log(`  ⏭  SKIPPED   "${cat.name}" — already exists (using fcat_${slug})`);
        catsSkipped++;
      } else {
        console.error(`  ❌ ERROR     "${cat.name}" — ${e.message}`);
      }
    }
  }

  console.log('\n── PHASE 2: MENU ITEMS ─────────────────────────────────────');
  for (const item of ITEMS) {
    const category_id = categoryIdMap[item.categoryName];
    if (!category_id) {
      console.error(`  ❌ NO CATEGORY for "${item.name}" (cat: "${item.categoryName}")`);
      itemsError++;
      continue;
    }
    try {
      const doc = await createFoodItemFirestore({
        name: item.name, category_id,
        base_price: item.base_price,
        is_veg: item.is_veg,
        is_active: item.is_active !== undefined ? item.is_active : true,
        kot_type: 'KITCHEN', tax_type: 'GST_5', tax_rate: 5,
        description: item.description || '',
        preparation_time_mins: 0, tags: [],
        created_at: NOW, updated_at: NOW
      });
      if (item.is_active === false) {
        pendingConfirmation.push(item.name);
        console.log(`  ⚠️  CREATED   [${doc.item_id}] "${item.name}" ₹${item.base_price} [INACTIVE — PRICE PENDING]`);
      } else {
        console.log(`  ✅ CREATED   [${doc.item_id}] "${item.name}" ₹${item.base_price} | veg=${item.is_veg}`);
      }
      itemsCreated++;
    } catch (e) {
      if (e.code === 'DUPLICATE_KEY' || (e.message && e.message.includes('already exists'))) {
        console.log(`  ⏭  SKIPPED   "${item.name}" — already exists`);
        itemsSkipped++;
      } else {
        console.error(`  ❌ ERROR     "${item.name}" — ${e.message}`);
        itemsError++;
      }
    }
  }

  console.log('\n' + '='.repeat(62));
  console.log(' SEEDING COMPLETE');
  console.log(`   Categories — Created: ${catsCreated}  Skipped: ${catsSkipped}`);
  console.log(`   Items      — Created: ${itemsCreated}  Skipped: ${itemsSkipped}  Errors: ${itemsError}`);
  console.log('='.repeat(62));
  if (pendingConfirmation.length) {
    console.log('\n⚠️  ITEMS REQUIRING MANUAL CONFIRMATION:');
    pendingConfirmation.forEach(n => console.log(`   • ${n}`));
  }
  console.log('\n📋 SCHEMA LIMITATIONS REPORTED:');
  console.log('   • Soft Drinks — stored as 1 item (Coca-Cola/Limca/Seven Up in description)');
  console.log('     Reason: food_menu_items schema has no variants/modifiers array field.');
  console.log('   • Vanilla Ice Cream — stored as 2 separate items (One Scoop / Two Scoops)');
  console.log('     Reason: schema has no size-variant sub-array field.');
  console.log('   • Scrambled Eggs — is_active=false, base_price=0 (price not in PDF)');
  console.log('     Action: Update price and activate via Food Menu Master UI when confirmed.\n');
}

seed().catch(e => { console.error('FATAL SEED ERROR:', e); process.exit(1); });
