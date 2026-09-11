/**
 * backend/scripts/seedDevInventory.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Seeds a SMALL, clearly-synthetic Inventory dataset (Phase A: units,
 * locations, categories, a few products with decimal quantities via a real
 * OPENING movement, and a couple of suppliers) into the ISOLATED DEV Firebase
 * project (sky5-development) ONLY.
 *
 * SAFETY — quadruple guard, checked in this order, before any write:
 *   1. HPMS_ENV must literally be "development" (else: throw, exit 1).
 *   2. Firebase Admin is initialized from backend/.env.development only.
 *   3. The resolved Firestore project id must be exactly "sky5-development".
 *   4. Any resolved project id containing "hpms" (case-insensitive) is
 *      rejected outright, regardless of #3, as defense in depth.
 * The resolved project id is printed before any write is attempted.
 *
 * Dry-run by default. Pass --execute to actually write. Units/locations/
 * categories/suppliers are idempotent upserts on a fixed document id.
 * Products + their opening stock are created at most ONCE (guarded by SKU
 * existence) — re-running with --execute never double-books opening stock.
 *
 * Data is 100% synthetic ("(DEV)" suffix on every name). Nothing here is
 * read from or copied out of any production system, and none of it resembles
 * the real Hotel Sky-5 purchase ledger beyond category/unit vocabulary.
 *
 * Run:
 *   node backend/scripts/seedDevInventory.mjs               (dry-run)
 *   node backend/scripts/seedDevInventory.mjs --execute      (writes)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.join(__dirname, '..');

// ── Guard 1 ───────────────────────────────────────────────────────────────
const HPMS_ENV = process.env.HPMS_ENV;
if (HPMS_ENV !== 'development') {
  console.error(
    `[SAFETY_ABORT] HPMS_ENV must be exactly "development" (got: ${JSON.stringify(HPMS_ENV)}). ` +
    `This script only ever seeds sky5-development. Refusing to proceed. ` +
    `Run via: cross-env HPMS_ENV=development node backend/scripts/seedDevInventory.mjs`
  );
  process.exit(1);
}

// Load ONLY backend/.env.development — never backend/.env (production).
dotenv.config({ path: path.join(BACKEND_ROOT, '.env.development') });

const { initializeApp, cert, getApps, getApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
const { isProductionProject } = await import('../config/productionSafetyGuard.js');

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
const privateKey = rawPrivateKey ? rawPrivateKey.replace(/\\n/g, '\n') : undefined;

// ── Guard 2 (fail-closed, mirrors firebaseAdmin.js) ─────────────────────────
if (isProductionProject()) {
  console.error(
    `[SAFETY_ABORT] FIREBASE_PROJECT_ID resolved to the PRODUCTION project ("${projectId}"). ` +
    `Refusing to initialize. Fix backend/.env.development and retry.`
  );
  process.exit(1);
}

if (!projectId || !clientEmail || !privateKey ||
    String(clientEmail).startsWith('REPLACE_WITH_') || String(rawPrivateKey).startsWith('REPLACE_WITH_')) {
  console.error('[FATAL] Missing or placeholder Firebase Admin credentials in backend/.env.development — nothing was contacted, nothing was written.');
  process.exit(1);
}

const firebaseApp = !getApps().length
  ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
  : getApp();

const resolvedProjectId = firebaseApp?.options?.projectId || firebaseApp?.options?.credential?.projectId || projectId;

// ── Guard 3 + 4 ───────────────────────────────────────────────────────────
if (resolvedProjectId !== 'sky5-development') {
  console.error(`[SAFETY_ABORT] Resolved Firebase project is "${resolvedProjectId}", expected exactly "sky5-development". Refusing to write.`);
  process.exit(1);
}
if (/hpms/i.test(resolvedProjectId)) {
  console.error(`[SAFETY_ABORT] Resolved Firebase project id "${resolvedProjectId}" contains "hpms" — refusing unconditionally, regardless of the exact-match check above.`);
  process.exit(1);
}

console.log('═'.repeat(78));
console.log('  DEV INVENTORY SEEDER — backend/scripts/seedDevInventory.mjs');
console.log('═'.repeat(78));
console.log(`  Resolved Firebase project : ${resolvedProjectId}`);
console.log(`  HPMS_ENV                  : ${HPMS_ENV}`);
console.log(`  Mode                      : ${DRY_RUN ? 'DRY-RUN (no writes)' : 'EXECUTE (writing)'}`);
console.log('═'.repeat(78) + '\n');

const db = getFirestore(firebaseApp);
const NOW = new Date().toISOString();
const ACTOR = { uid: 'dev_seed_script', name: 'DEV Seed Script' };
const BUSINESS_DATE = NOW.split('T')[0];

const summary = { collections: 0, docs: 0, movements: 0 };

async function upsert(collection, docId, payload) {
  summary.docs++;
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] would upsert ${collection}/${docId}`);
    return;
  }
  await db.collection(collection).doc(docId).set(payload, { merge: true });
  console.log(`  [WRITE]   upserted ${collection}/${docId}`);
}

function slugify(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ═══════════════════════════════════════════════════════════════════════════
// UNITS
// ═══════════════════════════════════════════════════════════════════════════
async function seedUnits() {
  console.log('\n── inventory_units ─────────────────────────────────────────');
  summary.collections++;
  const units = [
    { code: 'KG', name: 'Kilogram' },
    { code: 'LTR', name: 'Litre' },
    { code: 'PC', name: 'Piece' },
    { code: 'PKT', name: 'Packet' },
    { code: 'BOX', name: 'Box' },
    { code: 'BTL', name: 'Bottle' },
    { code: 'NOS', name: 'Numbers' },
    { code: 'REAM', name: 'Ream' }
  ];
  for (const u of units) {
    await upsert('inventory_units', `unit_${slugify(u.code)}`, {
      code: u.code,
      name: u.name,
      base_unit: null,
      factor: 1,
      allow_decimal: true,
      is_active: true,
      created_by: ACTOR.uid,
      updated_by: ACTOR.uid,
      created_at: NOW,
      updated_at: NOW
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOCATIONS
// ═══════════════════════════════════════════════════════════════════════════
async function seedLocations() {
  console.log('\n── inventory_locations ─────────────────────────────────────');
  summary.collections++;
  const locations = [
    { code: 'DEV-MAIN', name: 'DEV Main Store', department: 'General', is_default: true },
    { code: 'DEV-KITCHEN', name: 'DEV Kitchen', department: 'Kitchen', is_default: false }
  ];
  for (const l of locations) {
    await upsert('inventory_locations', `loc_${slugify(l.code)}`, {
      code: l.code,
      name: l.name,
      department: l.department,
      is_active: true,
      is_default: l.is_default,
      created_by: ACTOR.uid,
      updated_by: ACTOR.uid,
      created_at: NOW,
      updated_at: NOW
    });
  }
  return { mainId: `loc_${slugify('DEV-MAIN')}`, kitchenId: `loc_${slugify('DEV-KITCHEN')}` };
}

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════
async function seedCategories() {
  console.log('\n── inventory_categories ─────────────────────────────────────');
  summary.collections++;
  const categories = [
    { name: 'DEV Grocery', department: 'Kitchen' },
    { name: 'DEV Housekeeping', department: 'Housekeeping' },
    { name: 'DEV Beverages', department: 'Kitchen' }
  ];
  const ids = {};
  for (const c of categories) {
    const docId = `cat_${slugify(c.name)}`;
    ids[c.name] = docId;
    await upsert('inventory_categories', docId, {
      name: c.name,
      department: c.department,
      description: 'Synthetic DEV category — not real master data.',
      is_active: true,
      mysql_category_id: null,
      created_by: ACTOR.uid,
      updated_by: ACTOR.uid,
      created_at: NOW,
      updated_at: NOW
    });
  }
  return ids;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPPLIERS
// ═══════════════════════════════════════════════════════════════════════════
async function seedSuppliers() {
  console.log('\n── inventory_suppliers ──────────────────────────────────────');
  summary.collections++;
  const suppliers = [
    { name: 'DEV Kiryana Supplier', contact_person: 'DEV Contact', phone: '9000000001', gstin: null, payment_terms: 'Net 7' },
    { name: 'DEV Chemicals Supplier', contact_person: 'DEV Contact', phone: '9000000002', gstin: null, payment_terms: 'Net 15' }
  ];
  for (const s of suppliers) {
    await upsert('inventory_suppliers', `sup_${slugify(s.name)}`, {
      name: s.name,
      search_name: s.name.toLowerCase(),
      contact_person: s.contact_person,
      phone: s.phone,
      whatsapp: null,
      email: null,
      address: 'DEV synthetic address — not a real location.',
      gstin: s.gstin,
      payment_terms: s.payment_terms,
      notes: 'Synthetic DEV supplier.',
      is_active: true,
      created_by: ACTOR.uid,
      updated_by: ACTOR.uid,
      created_at: NOW,
      updated_at: NOW
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTS + OPENING STOCK (decimal quantities, created at most once)
// ═══════════════════════════════════════════════════════════════════════════
async function seedProducts(categoryIds, mainLocationId) {
  console.log('\n── inventory_products (+ OPENING movement) ──────────────────');
  summary.collections++;
  const products = [
    { sku: 'DEV-RICE-01', name: 'DEV Rice', category: 'DEV Grocery', unit: 'KG', min: 5, opening: 25 },
    { sku: 'DEV-ATTA-01', name: 'DEV Atta', category: 'DEV Grocery', unit: 'KG', min: 5, opening: 12.5 },
    { sku: 'DEV-WATER-01', name: 'DEV Mineral Water 1 LTR', category: 'DEV Beverages', unit: 'BTL', min: 12, opening: 48 },
    { sku: 'DEV-PHENYL-01', name: 'DEV Phenyl', category: 'DEV Housekeeping', unit: 'LTR', min: 2, opening: 1.3 }
  ];

  for (const p of products) {
    const docId = `prod_${slugify(p.sku)}`;
    const productPayload = {
      name: p.name,
      sku: p.sku,
      category_id: categoryIds[p.category] || null,
      mysql_category_id: null,
      unit_of_measure: p.unit,
      current_stock: 0,
      stock_by_location: {},
      minimum_stock_level: p.min,
      cost_price: 0,
      unit_price: 0,
      default_supplier_id: null,
      photo_url: null,
      is_active: true,
      status: 'Active',
      mysql_product_id: null,
      created_by: ACTOR.uid,
      updated_by: ACTOR.uid,
      created_at: NOW,
      updated_at: NOW,
      last_movement_at: null
    };

    if (DRY_RUN) {
      summary.docs++;
      console.log(`  [DRY-RUN] would create inventory_products/${docId} (if absent)`);
      console.log(`  [DRY-RUN] would apply OPENING movement for ${docId}: +${p.opening} ${p.unit} @ ${mainLocationId}`);
      summary.movements++;
      continue;
    }

    const existing = await db.collection('inventory_products').doc(docId).get();
    if (existing.exists) {
      console.log(`  [SKIP]    inventory_products/${docId} already exists — leaving stock untouched`);
      continue;
    }

    summary.docs++;
    await db.collection('inventory_products').doc(docId).set(productPayload);
    console.log(`  [WRITE]   created inventory_products/${docId}`);

    // Opening stock via the real stock service so the ledger and balance
    // agree from the very first document — never a raw current_stock write.
    const { InventoryStockService } = await import('../services/inventoryStockService.js');
    const result = await InventoryStockService.applyMovement({
      product_id: docId,
      location_id: mainLocationId,
      movement_type: 'OPENING',
      quantity: p.opening,
      reference_type: 'MANUAL',
      reason: 'DEV seed opening stock',
      remarks: 'Synthetic DEV data',
      actor_uid: ACTOR.uid,
      actor_name: ACTOR.name,
      idempotency_key: `devseed_${docId}`,
      business_date: BUSINESS_DATE
    });
    summary.movements++;
    console.log(`  [WRITE]   OPENING movement ${result.movement.movement_id}: +${p.opening} ${p.unit} → total ${result.product.current_stock} ${p.unit}`);
  }
}

async function main() {
  await seedUnits();
  const { mainId } = await seedLocations();
  const categoryIds = await seedCategories();
  await seedSuppliers();
  await seedProducts(categoryIds, mainId);

  console.log('\n' + '═'.repeat(78));
  console.log(`  ${DRY_RUN ? 'DRY-RUN COMPLETE — zero writes performed' : 'SEED COMPLETE'}`);
  console.log(`  Collections touched : ${summary.collections}`);
  console.log(`  Documents ${DRY_RUN ? 'that would be written' : 'written'} : ${summary.docs}`);
  console.log(`  Stock movements ${DRY_RUN ? 'that would be applied' : 'applied'} : ${summary.movements}`);
  console.log('═'.repeat(78));
  if (DRY_RUN) {
    console.log('\n  Re-run with --execute to actually write this data.');
  }
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
