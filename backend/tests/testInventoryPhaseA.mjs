/**
 * backend/tests/testInventoryPhaseA.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration test for HPMS Inventory Phase A, run DIRECTLY against the real
 * repositories/services (not over HTTP). DEV Firestore (sky5-development)
 * ONLY — guarded with the same quadruple safety check as
 * backend/scripts/seedDevFirestore.mjs / seedDevInventory.mjs, checked BEFORE
 * firebaseAdmin.js is ever imported.
 *
 * Why not HTTP + real Firebase ID tokens (as other backend/tests/*.mjs do via
 * firebaseTestTokenHelper.mjs): backend/.env.development's
 * FIREBASE_WEB_API_KEY is a placeholder
 * ("REPLACE_WITH_SKY5_DEVELOPMENT_WEB_API_KEY"), so the Identity Toolkit
 * custom-token exchange that helper needs fails with API_KEY_INVALID. That is
 * a pre-existing gap in the DEV environment, unrelated to Inventory, and
 * provisioning a real key is a credentials change outside this phase's scope
 * — so RBAC is verified instead by calling the actual, imported
 * `requireRole` middleware from authController.js with representative
 * `req.user` shapes (exactly what a verified Firebase token resolves to),
 * which is the real authorization logic that runs in production; only the
 * token minting step is skipped. All business logic (movements, transfers,
 * idempotency, pagination) runs through the real inventoryStockService /
 * inventoryCutoverService against live DEV Firestore.
 *
 * Run: cross-env HPMS_ENV=development node backend/tests/testInventoryPhaseA.mjs
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.join(__dirname, '..');

// ── Guard 1 ───────────────────────────────────────────────────────────────
if (process.env.HPMS_ENV !== 'development') {
  console.error(`[SAFETY_ABORT] HPMS_ENV must be exactly "development" (got: ${JSON.stringify(process.env.HPMS_ENV)}). Refusing to run.`);
  process.exit(1);
}
dotenv.config({ path: path.join(BACKEND_ROOT, '.env.development') });

const { isProductionProject } = await import('../config/productionSafetyGuard.js');
if (isProductionProject()) {
  console.error('[SAFETY_ABORT] Resolved Firebase project looks like production. Refusing to run.');
  process.exit(1);
}

const { db } = await import('../config/firebaseAdmin.js');
const app = (await import('../config/firebaseAdmin.js')).default;
const resolvedProjectId = app?.options?.projectId || process.env.FIREBASE_PROJECT_ID;
if (resolvedProjectId !== 'sky5-development' || /hpms/i.test(String(resolvedProjectId))) {
  console.error(`[SAFETY_ABORT] Resolved Firebase project is "${resolvedProjectId}", expected exactly "sky5-development". Refusing to run.`);
  process.exit(1);
}
console.log(`[GUARD] Resolved Firebase project: ${resolvedProjectId} (DEV) — safe to proceed.\n`);

// ── Everything below only imports once the guard has passed ────────────────
const { requireRole } = await import('../controllers/authController.js');
const { validateProductPayload } = await import('../controllers/inventoryController.js');
const { InventoryCutoverService } = await import('../services/inventoryCutoverService.js');
const { InventoryStockService } = await import('../services/inventoryStockService.js');
const {
  createInventoryUnitFirestore, deactivateInventoryUnitFirestore
} = await import('../repositories/firestore/inventoryUnitsRepository.js');
const {
  createInventoryLocationFirestore, deactivateInventoryLocationFirestore, updateInventoryLocationFirestore
} = await import('../repositories/firestore/inventoryLocationsRepository.js');
const {
  createInventorySupplierFirestore, deactivateInventorySupplierFirestore
} = await import('../repositories/firestore/inventorySuppliersRepository.js');
const {
  deleteInventoryCategoryFirestore
} = await import('../repositories/firestore/inventoryCategoriesRepository.js');
const {
  deleteInventoryProductFirestore
} = await import('../repositories/firestore/inventoryProductsRepository.js');
const { listInventoryMovementsFirestore } = await import('../repositories/firestore/inventoryStockMovementsRepository.js');
const { INVENTORY_ROLES } = await import('../utils/inventoryConstants.js');

const RUN_ID = Date.now().toString(36);
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
async function expectThrow(fn, label, codeMatch = null) {
  try {
    await fn();
    ok(false, label, 'did not throw');
  } catch (err) {
    ok(!codeMatch || err.code === codeMatch, label, codeMatch ? `code=${err.code} message=${err.message}` : err.message);
  }
}

// ── RBAC: exercise the REAL requireRole middleware, no HTTP / no tokens ────
function callMiddleware(mw, user) {
  let statusCode = null, jsonBody = null, nextCalled = false;
  const req = { user };
  const res = { status(c) { statusCode = c; return this; }, json(b) { jsonBody = b; return this; } };
  mw(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode, jsonBody };
}

function testRbac() {
  console.log('── RBAC (real requireRole middleware, synthetic req.user) ───────────────');
  const VIEW = requireRole(...INVENTORY_ROLES.VIEW);
  const MANAGE = requireRole(...INVENTORY_ROLES.MANAGE);
  const MOVE = requireRole(...INVENTORY_ROLES.MOVE);

  const admin = { role: 'ADMIN', type: 'staff' };
  const receptionist = { role: 'RECEPTIONIST', type: 'staff' };
  const cleaner = { role: 'CLEANER', type: 'staff' };      // normalizes to 'housekeeper'
  const chef = { role: 'CHEF', type: 'staff' };            // normalizes to 'kitchen'
  const rootAdmin = { role: 'ADMIN', type: 'admin' };      // normalizes to 'super_admin'
  const guest = { role: 'guest', type: 'guest' };

  ok(callMiddleware(VIEW, receptionist).nextCalled, '18. VIEW allows receptionist');
  ok(callMiddleware(VIEW, cleaner).nextCalled, '18. VIEW allows housekeeper (CLEANER)');
  ok(callMiddleware(VIEW, chef).nextCalled, '18. VIEW allows kitchen (CHEF)');
  ok(callMiddleware(VIEW, rootAdmin).nextCalled, '18. VIEW allows super_admin');
  ok(!callMiddleware(VIEW, guest).nextCalled && callMiddleware(VIEW, guest).statusCode === 403, '18. VIEW rejects guest -> 403');

  ok(callMiddleware(MANAGE, admin).nextCalled, '18. MANAGE allows admin');
  ok(!callMiddleware(MANAGE, receptionist).nextCalled && callMiddleware(MANAGE, receptionist).statusCode === 403, '18. MANAGE rejects receptionist -> 403');
  ok(!callMiddleware(MANAGE, cleaner).nextCalled, '18. MANAGE rejects housekeeper');
  ok(!callMiddleware(MANAGE, chef).nextCalled, '18. MANAGE rejects kitchen');

  ok(callMiddleware(MOVE, admin).nextCalled, '18. MOVE allows admin');
  ok(callMiddleware(MOVE, cleaner).nextCalled, '18. MOVE allows housekeeper');
  ok(callMiddleware(MOVE, chef).nextCalled, '18. MOVE allows kitchen');
  ok(!callMiddleware(MOVE, receptionist).nextCalled && callMiddleware(MOVE, receptionist).statusCode === 403, '18. MOVE rejects receptionist -> 403');

  const noUser = callMiddleware(VIEW, null);
  ok(!noUser.nextCalled && noUser.statusCode === 401, '18. Missing req.user -> 401 (no token at all)');
}

async function main() {
  console.log('═'.repeat(78));
  console.log('  INVENTORY PHASE A — INTEGRATION TEST  (DEV: sky5-development)');
  console.log(`  run id: ${RUN_ID}`);
  console.log('═'.repeat(78) + '\n');

  testRbac();

  const actor = { uid: `phaseatest_${RUN_ID}`, name: 'Phase A Test' };
  const cleanup = [];

  // ── 1. Category CRUD ────────────────────────────────────────────────────
  console.log('\n── Category CRUD ───────────────────────────────────────────');
  const category = await InventoryCutoverService.createCategory({ name: `PHASE_A_TEST Category ${RUN_ID}`, department: 'General' }, actor.uid);
  ok(!!category.id, 'Create category');
  cleanup.push(() => deleteInventoryCategoryFirestore(category.id));

  await expectThrow(() => InventoryCutoverService.createCategory({ name: `PHASE_A_TEST Category ${RUN_ID}` }, actor.uid), 'Duplicate category name rejected', undefined);

  const renamed = await InventoryCutoverService.updateCategory(category.id, { name: `${category.name} Renamed` }, actor.uid);
  ok(renamed.name.endsWith('Renamed'), 'Update category name');

  const { categories: activeList } = await InventoryCutoverService.getCategories();
  ok(activeList.some(c => c.id === category.id), 'List includes new (active) category');

  const deactivated = await InventoryCutoverService.deactivateCategory(category.id, actor.uid);
  ok(deactivated.category.is_active === false, 'Deactivate category (soft, not hard delete)');
  const { categories: afterDeactivate } = await InventoryCutoverService.getCategories();
  ok(!afterDeactivate.some(c => c.id === category.id), 'Deactivated category excluded from default active-only list');
  await InventoryCutoverService.updateCategory(category.id, { is_active: true }, actor.uid); // reactivate for downstream tests

  // ── 2. Unit CRUD ────────────────────────────────────────────────────────
  console.log('\n── Unit CRUD ──────────────────────────────────────────────────');
  const unitCode = `TU${RUN_ID}`.toUpperCase().slice(0, 10);
  const unit = await createInventoryUnitFirestore({ code: unitCode, name: 'Phase A Test Unit', allow_decimal: true, created_by: actor.uid });
  ok(unit.code === unitCode, 'Create unit');
  cleanup.push(() => db.collection('inventory_units').doc(unit.id).delete());
  await expectThrow(() => createInventoryUnitFirestore({ code: unitCode }), 'Duplicate unit code rejected', 'DUPLICATE_KEY');

  // ── 3. Location CRUD ────────────────────────────────────────────────────
  console.log('\n── Location CRUD ───────────────────────────────────────────────');
  const locA = await createInventoryLocationFirestore({ code: `TL-A-${RUN_ID}`, name: `PHASE_A_TEST Location A ${RUN_ID}`, created_by: actor.uid });
  const locB = await createInventoryLocationFirestore({ code: `TL-B-${RUN_ID}`, name: `PHASE_A_TEST Location B ${RUN_ID}`, created_by: actor.uid });
  ok(!!locA.id && !!locB.id, 'Create two locations');
  cleanup.push(() => db.collection('inventory_locations').doc(locA.id).delete(), () => db.collection('inventory_locations').doc(locB.id).delete());
  const locAUpdated = await updateInventoryLocationFirestore(locA.id, { department: 'Kitchen' }, actor.uid);
  ok(locAUpdated.department === 'Kitchen', 'Update location department');

  // ── 4/5/6/14. Product creation, update, decimal opening stock ───────────
  console.log('\n── Product creation / update ─────────────────────────────────');
  const sku = `PHASE-A-TEST-${RUN_ID}`;
  // NOTE: category/unit/supplier existence is validated in
  // inventoryController.validateProductPayload (the HTTP layer), not in
  // InventoryCutoverService.createProduct itself — this test calls the
  // service directly, so that check is out of scope here and is instead
  // covered by reading the controller source below.
  const { errors: unknownCategoryErrors } = await validateProductPayload({ name: 'X', category_id: 'does_not_exist_category', unit_of_measure: unitCode });
  ok(unknownCategoryErrors.some(e => /does not exist/.test(e)), 'Controller-level validation rejects an unknown category_id', JSON.stringify(unknownCategoryErrors));

  const { product, opening_movement } = await InventoryCutoverService.createProduct({
    sku, name: `PHASE_A_TEST Product ${RUN_ID}`, category_id: category.id, unit_of_measure: unitCode,
    minimum_stock_level: 10, cost_price: 25.5, opening_stock: 1.3, opening_location_id: locA.id
  }, actor);
  ok(!!product?.id, 'Create product');
  // The test hard-deletes its synthetic product, so it must also remove that
  // product's ledger rows — otherwise every run leaves orphan movements
  // pointing at a product document that no longer exists. This deletion is
  // ONLY ever applied to this test's own synthetic product id; real business
  // history is append-only and is never touched (the API exposes no path that
  // deletes a movement).
  cleanup.push(async () => {
    const snap = await db.collection('inventory_stock_movements').where('product_id', '==', product.id).get();
    for (const d of snap.docs) await d.ref.delete();
    await deleteInventoryProductFirestore(product.id);
  });
  ok(product.current_stock === 1.3, '14. Decimal opening quantity stored exactly (1.3)', `got ${product.current_stock}`);
  ok(!!opening_movement && opening_movement.movement_type === 'OPENING', 'Opening stock produced an OPENING ledger entry');

  await expectThrow(() => InventoryCutoverService.createProduct({ sku, name: 'dup', category_id: category.id, unit_of_measure: unitCode }, actor), 'Duplicate SKU rejected', 'ER_DUP_ENTRY');

  const updateResult = await InventoryCutoverService.updateProduct(product.id, { minimum_stock_level: 8, current_stock: 999 }, actor);
  ok(updateResult.product.minimum_stock_level === 8, '5. Update product master field (minimum_stock_level)');
  ok(updateResult.product.current_stock === 1.3, '6. current_stock in the update payload is IGNORED (stays 1.3, not 999)', `got ${updateResult.product.current_stock}`);

  // ── 7. Supplier CRUD ────────────────────────────────────────────────────
  console.log('\n── Supplier CRUD ───────────────────────────────────────────────');
  const supplier = await createInventorySupplierFirestore({ name: `PHASE_A_TEST Supplier ${RUN_ID}`, phone: '9876543210', gstin: '22AAAAA0000A1Z5', created_by: actor.uid });
  ok(!!supplier.id, 'Create supplier');
  cleanup.push(() => db.collection('inventory_suppliers').doc(supplier.id).delete());
  const deactivatedSupplier = await deactivateInventorySupplierFirestore(supplier.id, actor.uid);
  ok(deactivatedSupplier.is_active === false, 'Deactivate supplier');

  // ── 8/13. Opening stock at a second location + idempotency ─────────────
  console.log('\n── Opening stock + idempotency ────────────────────────────────');
  const openKey = `phaseatest_open_${RUN_ID}`;
  const open2 = await InventoryStockService.applyMovement({ product_id: product.id, location_id: locB.id, movement_type: 'OPENING', quantity: 0.25, actor_uid: actor.uid, actor_name: actor.name, idempotency_key: openKey });
  ok(open2.product.current_stock === 1.55, '8. Balance recalculated across locations (1.3 + 0.25 = 1.55)', `got ${open2.product.current_stock}`);
  const open2Replay = await InventoryStockService.applyMovement({ product_id: product.id, location_id: locB.id, movement_type: 'OPENING', quantity: 0.25, actor_uid: actor.uid, actor_name: actor.name, idempotency_key: openKey });
  ok(open2Replay.duplicate === true && open2Replay.product.current_stock === 1.55, '13. Duplicate idempotency key -> replay, no double-apply');

  // ── 9. Adjustment ───────────────────────────────────────────────────────
  console.log('\n── Adjustment ──────────────────────────────────────────────────');
  await expectThrow(() => InventoryStockService.applyMovement({ product_id: product.id, location_id: locA.id, movement_type: 'ADJUSTMENT', quantity: 0 }), 'Zero-quantity adjustment rejected', 'INVALID_QUANTITY');
  const adj = await InventoryStockService.applyMovement({ product_id: product.id, location_id: locA.id, movement_type: 'ADJUSTMENT', quantity: -0.3, reason: 'Physical count correction', actor_uid: actor.uid, actor_name: actor.name });
  ok(adj.movement.qty_before === 1.3 && adj.movement.qty_after === 1.0, '9. Adjustment before/after recorded correctly', JSON.stringify(adj.movement));

  // ── 10/11/12. Transfer, insufficient stock rejection, atomic rollback ──
  console.log('\n── Transfer ────────────────────────────────────────────────────────');
  const totalBefore = (await InventoryCutoverService.getProductById(product.id)).current_stock;
  await expectThrow(() => InventoryStockService.transfer({ product_id: product.id, from_location_id: locA.id, to_location_id: locB.id, quantity: 999 }), '11. Transfer exceeding source stock rejected', 'INSUFFICIENT_STOCK');
  const totalAfterFailed = (await InventoryCutoverService.getProductById(product.id)).current_stock;
  ok(totalAfterFailed === totalBefore, '12. Failed transfer leaves total balance unchanged (atomic rollback)', `before=${totalBefore} after=${totalAfterFailed}`);
  await expectThrow(() => InventoryStockService.transfer({ product_id: product.id, from_location_id: locA.id, to_location_id: locA.id, quantity: 0.1 }), 'Transfer to the same location rejected', 'SAME_LOCATION');

  const transfer1 = await InventoryStockService.transfer({ product_id: product.id, from_location_id: locA.id, to_location_id: locB.id, quantity: 0.2, reason: 'Rebalance', actor_uid: actor.uid, actor_name: actor.name });
  ok(!!transfer1.out_movement && !!transfer1.in_movement, '10. Valid transfer records both TRANSFER_OUT and TRANSFER_IN');
  const totalAfterOk = (await InventoryCutoverService.getProductById(product.id)).current_stock;
  ok(totalAfterOk === totalBefore, 'Successful transfer leaves TOTAL balance unchanged (moved between locations)', `before=${totalBefore} after=${totalAfterOk}`);

  const transferKey = `phaseatest_transfer_${RUN_ID}`;
  const tOnce = await InventoryStockService.transfer({ product_id: product.id, from_location_id: locA.id, to_location_id: locB.id, quantity: 0.1, idempotency_key: transferKey, actor_uid: actor.uid, actor_name: actor.name });
  const tTwice = await InventoryStockService.transfer({ product_id: product.id, from_location_id: locA.id, to_location_id: locB.id, quantity: 0.1, idempotency_key: transferKey, actor_uid: actor.uid, actor_name: actor.name });
  ok(tOnce.duplicate === false && tTwice.duplicate === true, '13. Duplicate transfer idempotency key -> second call is a no-op replay');

  // ── 15/16/17. Movement history, pagination, search/filter ──────────────
  console.log('\n── Movement history / pagination / search ────────────────────────────────────');
  const hist = await listInventoryMovementsFirestore({ product_id: product.id });
  ok(hist.items.length >= 5, '15. Movement history returns multiple entries', `count=${hist.items.length}`);
  const sortedDesc = hist.items.every((m, i, arr) => i === 0 || new Date(arr[i - 1].created_at) >= new Date(m.created_at));
  ok(sortedDesc, 'Movement history is ordered newest-first');

  const page1 = await listInventoryMovementsFirestore({ product_id: product.id, limit: 2 });
  ok(page1.items.length === 2 && !!page1.next_cursor, '16. Movement pagination returns a next_cursor when more rows exist');
  const page2 = await listInventoryMovementsFirestore({ product_id: product.id, limit: 2, cursor: page1.next_cursor });
  ok(page2.items.every(m => !page1.items.some(m1 => m1.id === m.id)), 'Second movement page does not repeat the first page\'s rows');

  const byType = await listInventoryMovementsFirestore({ product_id: product.id, movement_type: 'ADJUSTMENT' });
  ok(byType.items.length > 0 && byType.items.every(m => m.movement_type === 'ADJUSTMENT'), 'Movement filter by type returns only that type');

  const searchResult = await InventoryCutoverService.getProducts({ search: 'PHASE_A_TEST Product', page_size: 5 });
  ok(searchResult.products.some(p => p.id === product.id), '17. Product search finds the created product');
  ok(typeof searchResult.total === 'number' && typeof searchResult.total_pages === 'number', '17. Products response carries pagination metadata');

  const stockByLoc = await InventoryCutoverService.getStock({ location_id: locB.id });
  ok(stockByLoc.location_id === locB.id, 'Stock filter by location returns the requested location scope');

  // ── 19/20. Inactive item + inactive location handling ──────────────────
  console.log('\n── Inactive item / inactive location handling ──────────────────────────────');
  await InventoryCutoverService.deleteProduct(product.id, actor);
  await expectThrow(() => InventoryStockService.applyMovement({ product_id: product.id, location_id: locA.id, movement_type: 'ADJUSTMENT', quantity: 0.1, reason: 'should fail', actor_uid: actor.uid, actor_name: actor.name }), '19. Movement on inactive product rejected', 'PRODUCT_INACTIVE');
  await InventoryCutoverService.updateProduct(product.id, { is_active: true }, actor); // reactivate for the location check
  await deactivateInventoryLocationFirestore(locA.id, actor.uid);
  await expectThrow(() => InventoryStockService.applyMovement({ product_id: product.id, location_id: locA.id, movement_type: 'ADJUSTMENT', quantity: 0.1, reason: 'should fail', actor_uid: actor.uid, actor_name: actor.name }), '20. Movement at inactive location rejected', 'LOCATION_INACTIVE');

  // ── Opus review regressions (bugs found and fixed during the Phase A gate) ─
  console.log('\n── Review regressions ─────────────────────────────────────────────────────────');
  {
    // R1: legacy stock_quantity mirror must track current_stock, or any
    // pre-Phase-A reader sees a stale balance on a legacy document.
    const legacyId = 'prod_zz_review_legacy_regression';
    await db.collection('inventory_products').doc(legacyId).set({
      name: 'ZZ Review Legacy Regression', sku: 'ZZ-REVIEW-LEGACY-REGRESSION',
      category_id: category.id, unit_of_measure: unitCode, unit: unitCode,
      current_stock: 10, stock_quantity: 10, minimum_stock_level: 2, reorder_level: 2,
      unit_price: 5, status: 'Active',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    await InventoryStockService.applyMovement({
      product_id: legacyId, location_id: locB.id, movement_type: 'ADJUSTMENT',
      quantity: -4, reason: 'legacy mirror regression', actor_uid: actor.uid, actor_name: actor.name,
      idempotency_key: `legacy_mirror_${RUN_ID}`
    });
    const legacyAfter = (await db.collection('inventory_products').doc(legacyId).get()).data();
    ok(legacyAfter.current_stock === 6 && legacyAfter.stock_quantity === 6,
      'R1. Legacy stock_quantity mirror stays in sync with current_stock after a movement',
      `current_stock=${legacyAfter.current_stock} stock_quantity=${legacyAfter.stock_quantity}`);
    ok(Object.keys(legacyAfter.stock_by_location || {}).length > 0,
      'R1. Legacy unattributed balance was migrated into a location by the ledger');
    // remove this probe and its ledger rows (synthetic, this test's own)
    const legacyMovs = await db.collection('inventory_stock_movements').where('product_id', '==', legacyId).get();
    for (const d of legacyMovs.docs) await d.ref.delete();
    await db.collection('inventory_products').doc(legacyId).delete();

    // R2: the Items master must show inactive products when no status filter
    // is applied (the UI's "All Statuses"), not silently hide them.
    await InventoryCutoverService.deleteProduct(product.id, actor);   // deactivate
    const allStatuses = await InventoryCutoverService.getProducts({});
    ok(allStatuses.products.some(p => p.id === product.id),
      'R2. "All Statuses" (no status filter) includes deactivated products');
    const activeOnly = await InventoryCutoverService.getProducts({ status: 'Active' });
    ok(!activeOnly.products.some(p => p.id === product.id),
      'R2. status=Active still excludes deactivated products');
    await InventoryCutoverService.updateProduct(product.id, { is_active: true }, actor);

    // R3: a failed opening-stock movement must not leave a half-created product.
    const rollbackSku = `PHASE-A-ROLLBACK-${RUN_ID}`;
    let rollbackThrew = false;
    try {
      await InventoryCutoverService.createProduct({
        sku: rollbackSku, name: `PHASE_A_TEST Rollback ${RUN_ID}`, category_id: category.id,
        unit_of_measure: unitCode, minimum_stock_level: 1,
        opening_stock: 5, opening_location_id: 'loc_does_not_exist_at_all'
      }, actor);
    } catch { rollbackThrew = true; }
    ok(rollbackThrew, 'R3. Opening stock at a non-existent location fails the create');
    const rollbackDoc = await db.collection('inventory_products').doc(`prod_${rollbackSku.toLowerCase().replace(/[^a-z0-9]/g, '_')}`).get();
    ok(!rollbackDoc.exists, 'R3. Failed create is rolled back — no half-created product left behind');

    // R4: the pre-Phase-A deleteCategory API surface still resolves.
    ok(typeof InventoryCutoverService.deleteCategory === 'function',
      'R4. Backwards-compatible InventoryCutoverService.deleteCategory still exists');
  }

  // ── cleanup (best-effort; movement ledger entries are intentionally kept) ─
  console.log('\n── Cleanup (deactivate/remove test-only master data) ──────────────────────────');
  for (const fn of cleanup) {
    try { await fn(); } catch (err) { console.warn(`  [cleanup warning] ${err.message}`); }
  }
  console.log('  Cleanup attempted for all test-created categories/units/locations/products/suppliers.');
  console.log('  This test also removes the ledger rows of the synthetic product it hard-deletes, so no');
  console.log('  orphan movements accumulate. Real business history is append-only — the API exposes no');
  console.log('  path that deletes a movement, and nothing outside this test\'s own product ids is touched.');

  console.log('\n' + '═'.repeat(78));
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log('═'.repeat(78));
  if (failures.length) {
    console.log('\nFailed checks:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
