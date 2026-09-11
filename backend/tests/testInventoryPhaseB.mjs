/**
 * backend/tests/testInventoryPhaseB.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration test for HPMS Inventory Phase B — PURCHASE REQUEST WORKFLOW.
 * Runs against the real repositories/services on DEV Firestore
 * (sky5-development) ONLY, behind the same quadruple guard as
 * seedDevInventory.mjs and testInventoryPhaseA.mjs, checked BEFORE
 * firebaseAdmin.js is imported.
 *
 * RBAC is verified by calling the actual `requireRole` middleware from
 * authController.js with representative req.user shapes (the DEV
 * FIREBASE_WEB_API_KEY is a placeholder, so real ID tokens cannot be minted —
 * a pre-existing environment gap, see testInventoryPhaseA.mjs).
 *
 * The single most important assertion here: a purchase request NEVER changes
 * stock. Balances and the movement ledger are snapshotted before and compared
 * after every create / update / submit / cancel.
 *
 * All synthetic data (requests, request items, the test product) is removed at
 * the end — no orphan purchase-request items, no orphan test products.
 *
 * Run: cross-env HPMS_ENV=development node backend/tests/testInventoryPhaseB.mjs
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

// ── Guard 2 ───────────────────────────────────────────────────────────────
const { isProductionProject } = await import('../config/productionSafetyGuard.js');
if (isProductionProject()) {
  console.error('[SAFETY_ABORT] Resolved Firebase project looks like production. Refusing to run.');
  process.exit(1);
}

// ── Guards 3 + 4 ──────────────────────────────────────────────────────────
const resolvedProjectId = process.env.FIREBASE_PROJECT_ID;
if (resolvedProjectId !== 'sky5-development') {
  console.error(`[SAFETY_ABORT] Resolved Firebase project is "${resolvedProjectId}", expected exactly "sky5-development". Refusing to run.`);
  process.exit(1);
}
if (/hpms/i.test(String(resolvedProjectId))) {
  console.error(`[SAFETY_ABORT] Resolved Firebase project id "${resolvedProjectId}" contains "hpms" — refusing unconditionally.`);
  process.exit(1);
}
console.log(`[GUARD] Resolved Firebase project: ${resolvedProjectId} (DEV) — safe to proceed.\n`);

// ── Imports only after the guard ──────────────────────────────────────────
const { db } = await import('../config/firebaseAdmin.js');
const { requireRole } = await import('../controllers/authController.js');
const { PurchaseRequestService } = await import('../services/purchaseRequestService.js');
const { InventoryCutoverService } = await import('../services/inventoryCutoverService.js');
const {
  getPurchaseRequestItemsFirestore, deletePurchaseRequestCascadeFirestore, listPurchaseRequestsFirestore
} = await import('../repositories/firestore/purchaseRequestsRepository.js');
const { deleteInventoryProductFirestore } = await import('../repositories/firestore/inventoryProductsRepository.js');
const { createInventoryLocationFirestore } = await import('../repositories/firestore/inventoryLocationsRepository.js');
const { INVENTORY_ROLES, PR_STATUS } = await import('../utils/inventoryConstants.js');

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
    return null;
  } catch (err) {
    ok(!codeMatch || err.code === codeMatch, label, codeMatch ? `code=${err.code}` : err.message);
    return err;
  }
}

function callMiddleware(mw, user) {
  let statusCode = null, nextCalled = false;
  const res = { status(c) { statusCode = c; return this; }, json() { return this; } };
  mw({ user }, res, () => { nextCalled = true; });
  return { nextCalled, statusCode };
}

/** Snapshot of everything a purchase request must never change. */
async function stockFingerprint() {
  const prods = await db.collection('inventory_products').get();
  const movs = await db.collection('inventory_stock_movements').get();
  const balances = {};
  prods.docs.forEach(d => {
    const x = d.data();
    balances[d.id] = `${x.current_stock}|${JSON.stringify(x.stock_by_location || {})}`;
  });
  return { movementCount: movs.size, balances: JSON.stringify(balances) };
}

async function main() {
  console.log('═'.repeat(78));
  console.log('  INVENTORY PHASE B — PURCHASE REQUEST WORKFLOW  (DEV: sky5-development)');
  console.log(`  run id: ${RUN_ID}`);
  console.log('═'.repeat(78));

  const cleanup = [];
  const requester = { uid: `phasebtest_req_${RUN_ID}`, name: 'Phase B Requester', role: 'kitchen' };
  const otherUser = { uid: `phasebtest_other_${RUN_ID}`, name: 'Phase B Other', role: 'receptionist' };
  const adminUser = { uid: `phasebtest_admin_${RUN_ID}`, name: 'Phase B Admin', role: 'admin' };

  // ── 19/21. RBAC ─────────────────────────────────────────────────────────
  console.log('\n── RBAC (real requireRole middleware) ────────────────────────────────────────');
  {
    const REQUEST = requireRole(...INVENTORY_ROLES.REQUEST);
    ok(callMiddleware(REQUEST, { role: 'ADMIN', type: 'staff' }).nextCalled, '19. REQUEST allows admin');
    ok(callMiddleware(REQUEST, { role: 'ADMIN', type: 'admin' }).nextCalled, '19. REQUEST allows super_admin');
    ok(callMiddleware(REQUEST, { role: 'RECEPTIONIST', type: 'staff' }).nextCalled, '19. REQUEST allows receptionist');
    ok(callMiddleware(REQUEST, { role: 'CHEF', type: 'staff' }).nextCalled, '19. REQUEST allows kitchen');
    ok(callMiddleware(REQUEST, { role: 'CLEANER', type: 'staff' }).nextCalled, '19. REQUEST allows housekeeper');
    const guest = callMiddleware(REQUEST, { role: 'guest', type: 'guest' });
    ok(!guest.nextCalled && guest.statusCode === 403, '21. Unauthorized role (guest) -> 403');
    const anon = callMiddleware(REQUEST, null);
    ok(!anon.nextCalled && anon.statusCode === 401, '20. Unauthenticated request -> 401');
  }

  // ── fixtures ────────────────────────────────────────────────────────────
  console.log('\n── Fixtures ──────────────────────────────────────────────────────────────────');
  const { categories } = await InventoryCutoverService.getCategories();
  const category = categories[0];
  ok(!!category, 'DEV category available for the test product');

  const locations = await (await import('../repositories/firestore/inventoryLocationsRepository.js')).getAllInventoryLocationsFirestore({ includeInactive: false });
  const activeLocation = locations.find(l => l.is_active !== false);
  ok(!!activeLocation, 'DEV active location available');

  const inactiveLoc = await createInventoryLocationFirestore({
    code: `PB-INACTIVE-${RUN_ID}`, name: `PHASE_B_TEST Inactive Location ${RUN_ID}`, created_by: requester.uid
  });
  await db.collection('inventory_locations').doc(inactiveLoc.id).update({ is_active: false });
  cleanup.push(() => db.collection('inventory_locations').doc(inactiveLoc.id).delete());

  const sku = `PHASE-B-TEST-${RUN_ID}`;
  const { product } = await InventoryCutoverService.createProduct({
    sku, name: `PHASE_B_TEST Product ${RUN_ID}`, category_id: category.id,
    unit_of_measure: 'KG', minimum_stock_level: 5, cost_price: 40,
    opening_stock: 10, opening_location_id: activeLocation.id
  }, { uid: requester.uid, name: requester.name });
  ok(product.current_stock === 10, 'Test product created with 10 KG opening stock');
  cleanup.push(async () => {
    const movs = await db.collection('inventory_stock_movements').where('product_id', '==', product.id).get();
    for (const d of movs.docs) await d.ref.delete();
    await deleteInventoryProductFirestore(product.id);
  });

  const inactiveProduct = await InventoryCutoverService.createProduct({
    sku: `PHASE-B-INACTIVE-${RUN_ID}`, name: `PHASE_B_TEST Inactive ${RUN_ID}`, category_id: category.id,
    unit_of_measure: 'KG', minimum_stock_level: 1, cost_price: 10
  }, { uid: requester.uid, name: requester.name });
  await InventoryCutoverService.deleteProduct(inactiveProduct.product.id, { uid: requester.uid, name: requester.name });
  cleanup.push(() => deleteInventoryProductFirestore(inactiveProduct.product.id));

  const baseline = await stockFingerprint();
  console.log(`  baseline: ${baseline.movementCount} movements`);

  // ── 10-17. Validation ───────────────────────────────────────────────────
  console.log('\n── Validation ────────────────────────────────────────────────────────────────');
  const baseReq = { location_id: activeLocation.id, department: 'KITCHEN', reason: 'Phase B test' };

  await expectThrow(() => PurchaseRequestService.createDraft(
    { ...baseReq, items: [{ product_id: 'prod_does_not_exist_at_all', requested_quantity: 5 }] }, requester),
    '10. Invalid product rejected', 'PRODUCT_NOT_FOUND');

  await expectThrow(() => PurchaseRequestService.createDraft(
    { ...baseReq, items: [{ product_id: inactiveProduct.product.id, requested_quantity: 5 }] }, requester),
    '11. Inactive product rejected', 'PRODUCT_INACTIVE');

  await expectThrow(() => PurchaseRequestService.createDraft(
    { ...baseReq, location_id: 'loc_does_not_exist_at_all', items: [{ product_id: product.id, requested_quantity: 5 }] }, requester),
    '12. Invalid location rejected', 'LOCATION_NOT_FOUND');

  await expectThrow(() => PurchaseRequestService.createDraft(
    { ...baseReq, location_id: inactiveLoc.id, items: [{ product_id: product.id, requested_quantity: 5 }] }, requester),
    '13. Inactive location rejected', 'LOCATION_INACTIVE');

  await expectThrow(() => PurchaseRequestService.createDraft(
    { ...baseReq, items: [{ product_id: product.id, requested_quantity: 0 }] }, requester),
    '14. Zero quantity rejected', 'INVALID_QUANTITY');

  await expectThrow(() => PurchaseRequestService.createDraft(
    { ...baseReq, items: [{ product_id: product.id, requested_quantity: -5 }] }, requester),
    '15. Negative quantity rejected', 'INVALID_QUANTITY');

  await expectThrow(() => PurchaseRequestService.createDraft(
    { ...baseReq, items: [{ product_id: product.id, requested_quantity: 5, unit: 'LTR' }] }, requester),
    'Unit mismatch rejected', 'UNIT_MISMATCH');

  await expectThrow(() => PurchaseRequestService.createDraft({ ...baseReq, items: [] }, requester),
    'Empty item list rejected', 'NO_ITEMS');

  // ── 1. Create draft (decimal quantity + duplicate line merge) ───────────
  console.log('\n── Create draft ──────────────────────────────────────────────────────────────');
  const created = await PurchaseRequestService.createDraft({
    ...baseReq,
    priority: 'HIGH',
    remarks: 'Required for upcoming occupancy',
    items: [
      { product_id: product.id, requested_quantity: 2.5, remarks: 'first line' },
      { product_id: product.id, requested_quantity: 0.25 }   // duplicate product line
    ]
  }, requester);
  const draftId = created.request.id;
  cleanup.push(() => deletePurchaseRequestCascadeFirestore(draftId));

  ok(created.request.status === PR_STATUS.DRAFT, '1. Draft created with status DRAFT');
  ok(created.request.request_number === null, '1. Draft has no request number until submitted');
  ok(created.request.items.length === 1, '17. Duplicate product lines merged into one line', `got ${created.request.items.length}`);
  ok(created.request.items[0].requested_quantity === 2.75, '16/17. Decimal quantities summed exactly (2.5 + 0.25 = 2.75)', `got ${created.request.items[0].requested_quantity}`);
  ok(created.request.items[0].estimated_unit_cost === 40 && created.request.items[0].estimated_total === 110,
    '27. Estimated total = qty x unit cost (2.75 x 40 = 110)', `unit=${created.request.items[0].estimated_unit_cost} total=${created.request.items[0].estimated_total}`);
  ok(created.request.total_estimated_value === 110, '27. Request total_estimated_value aggregated', `got ${created.request.total_estimated_value}`);

  // ── 18. Snapshots ───────────────────────────────────────────────────────
  const line = created.request.items[0];
  // SKUs are normalised to upper case on create, so compare against that form.
  ok(line.product_name_snapshot === `PHASE_B_TEST Product ${RUN_ID}` && line.sku === sku.toUpperCase(),
    '18. Product name/SKU snapshotted on the line',
    `name=${line.product_name_snapshot} sku=${line.sku}`);
  ok(line.unit === 'KG' && line.category_name_snapshot === category.name,
    '18. Unit and category name snapshotted', `unit=${line.unit} cat=${line.category_name_snapshot}`);
  ok(line.current_stock_snapshot === 10 && line.minimum_stock_snapshot === 5,
    '18. Stock and minimum level snapshotted at request time', `stock=${line.current_stock_snapshot} min=${line.minimum_stock_snapshot}`);

  // Snapshot survives a later product rename
  await InventoryCutoverService.updateProduct(product.id, { name: `RENAMED ${RUN_ID}` }, { uid: adminUser.uid, name: adminUser.name });
  const afterRename = await PurchaseRequestService.getById(draftId);
  ok(afterRename.items[0].product_name_snapshot === `PHASE_B_TEST Product ${RUN_ID}`,
    '18. Snapshot survives a later product rename (history is not rewritten)');

  // ── 24. Stock unchanged after creation ──────────────────────────────────
  const afterCreate = await stockFingerprint();
  ok(afterCreate.movementCount === baseline.movementCount && afterCreate.balances === baseline.balances,
    '24/26. Stock and ledger unchanged after request creation');

  // ── 2. Read ─────────────────────────────────────────────────────────────
  console.log('\n── Read / update ─────────────────────────────────────────────────────────────');
  const fetched = await PurchaseRequestService.getById(draftId);
  ok(fetched && fetched.id === draftId && fetched.items.length === 1, '2. Draft readable with its items');

  // ── 3. Update draft ─────────────────────────────────────────────────────
  const updated = await PurchaseRequestService.updateDraft(draftId, {
    priority: 'URGENT',
    reason: 'Kitchen stock replenishment',
    items: [{ product_id: product.id, requested_quantity: 20 }]
  }, requester);
  ok(updated.request.priority === 'URGENT' && updated.request.reason === 'Kitchen stock replenishment', '3. Draft updated');
  ok(updated.request.items.length === 1 && updated.request.items[0].requested_quantity === 20, '3. Draft line items replaced');
  ok(updated.request.total_estimated_value === 800, '27. Estimated total recalculated on update (20 x 40)', `got ${updated.request.total_estimated_value}`);
  const itemsAfterUpdate = await getPurchaseRequestItemsFirestore(draftId);
  ok(itemsAfterUpdate.length === 1, '3. No orphan line items left after replacing lines', `got ${itemsAfterUpdate.length}`);

  // Ownership: another non-admin user cannot edit someone else's draft
  await expectThrow(() => PurchaseRequestService.updateDraft(draftId, { priority: 'LOW' }, otherUser),
    '19. A different non-admin user cannot edit another user\'s draft', 'NOT_REQUEST_OWNER');

  const afterUpdate = await stockFingerprint();
  ok(afterUpdate.movementCount === baseline.movementCount && afterUpdate.balances === baseline.balances,
    '26. Stock and ledger unchanged after request update');

  // ── 4/5. Submit + request number format ─────────────────────────────────
  console.log('\n── Submit ────────────────────────────────────────────────────────────────────');
  const submitted = await PurchaseRequestService.submit(draftId, requester);
  ok(submitted.request.status === PR_STATUS.PENDING_APPROVAL, '4. Draft submitted -> PENDING_APPROVAL');
  ok(!!submitted.request.submitted_at, '4. submitted_at recorded');
  ok(/^PR-\d{8}-\d{6}$/.test(submitted.request.request_number || ''),
    '5. Request number matches PR-YYYYMMDD-000000 format', `got ${submitted.request.request_number}`);
  const businessDateCompact = String(submitted.request.business_date).replace(/-/g, '');
  ok(String(submitted.request.request_number).includes(businessDateCompact),
    '5. Request number uses the business date, not a client clock', `number=${submitted.request.request_number} bd=${submitted.request.business_date}`);

  // ── 6/28. Duplicate submission / number idempotency ─────────────────────
  const resubmit = await PurchaseRequestService.submit(draftId, requester);
  ok(resubmit.duplicate === true, '6. Duplicate submission is an idempotent replay');
  ok(resubmit.request.request_number === submitted.request.request_number,
    '28. Replayed submission keeps the SAME request number (no second number burned)');

  // ── 25. Stock unchanged after submission ────────────────────────────────
  const afterSubmit = await stockFingerprint();
  ok(afterSubmit.movementCount === baseline.movementCount && afterSubmit.balances === baseline.balances,
    '25/26. Stock and ledger unchanged after submission');

  // ── 8/9. Submitted request is immutable ─────────────────────────────────
  console.log('\n── Submitted request immutability ────────────────────────────────────────────');
  await expectThrow(() => PurchaseRequestService.updateDraft(draftId, { priority: 'LOW' }, requester),
    '8. Cannot edit a submitted request', 'REQUEST_NOT_EDITABLE');
  await expectThrow(() => PurchaseRequestService.cancel(draftId, 'nope', requester),
    '9. Cannot cancel a submitted request', 'INVALID_STATUS_TRANSITION');
  await expectThrow(() => PurchaseRequestService.cancel(draftId, 'nope', adminUser),
    '9. Not even an admin can cancel a submitted request in Phase B', 'INVALID_STATUS_TRANSITION');

  // ── request-number sequence increments ──────────────────────────────────
  const second = await PurchaseRequestService.createDraft({
    ...baseReq, items: [{ product_id: product.id, requested_quantity: 1 }]
  }, requester);
  cleanup.push(() => deletePurchaseRequestCascadeFirestore(second.request.id));
  const secondSubmitted = await PurchaseRequestService.submit(second.request.id, requester);
  const seq1 = parseInt(String(submitted.request.request_number).split('-')[2], 10);
  const seq2 = parseInt(String(secondSubmitted.request.request_number).split('-')[2], 10);
  ok(seq2 === seq1 + 1, '28. Request numbers increment transactionally', `${submitted.request.request_number} -> ${secondSubmitted.request.request_number}`);

  // ── idempotent create ───────────────────────────────────────────────────
  const idemKey = `phaseb_create_${RUN_ID}`;
  const c1 = await PurchaseRequestService.createDraft({ ...baseReq, idempotency_key: idemKey, items: [{ product_id: product.id, requested_quantity: 3 }] }, requester);
  const c2 = await PurchaseRequestService.createDraft({ ...baseReq, idempotency_key: idemKey, items: [{ product_id: product.id, requested_quantity: 3 }] }, requester);
  cleanup.push(() => deletePurchaseRequestCascadeFirestore(c1.request.id));
  ok(c1.duplicate === false && c2.duplicate === true && c1.request.id === c2.request.id,
    '28. Repeated create with the same idempotency key returns the same draft');

  // ── 7. Cancel draft ─────────────────────────────────────────────────────
  console.log('\n── Cancel ────────────────────────────────────────────────────────────────────');
  const toCancel = await PurchaseRequestService.createDraft({ ...baseReq, items: [{ product_id: product.id, requested_quantity: 4 }] }, requester);
  cleanup.push(() => deletePurchaseRequestCascadeFirestore(toCancel.request.id));
  const cancelled = await PurchaseRequestService.cancel(toCancel.request.id, 'No longer needed', requester);
  ok(cancelled.request.status === PR_STATUS.CANCELLED, '7. Draft cancelled');
  ok(cancelled.request.cancel_reason === 'No longer needed' && !!cancelled.request.cancelled_at, '7. Cancellation reason and timestamp recorded');
  await expectThrow(() => PurchaseRequestService.submit(toCancel.request.id, requester),
    'A cancelled request cannot be submitted', 'INVALID_STATUS_TRANSITION');

  const afterCancel = await stockFingerprint();
  ok(afterCancel.movementCount === baseline.movementCount && afterCancel.balances === baseline.balances,
    '26. Stock and ledger unchanged after cancellation');

  // ── 22/23. Pagination + filters ─────────────────────────────────────────
  console.log('\n── Pagination / filters ──────────────────────────────────────────────────────');
  const page1 = await listPurchaseRequestsFirestore({ requested_by_uid: requester.uid, limit: 2 });
  ok(page1.items.length === 2 && !!page1.next_cursor, '22. Pagination returns a page plus a next_cursor', `got ${page1.items.length}`);
  const page2 = await listPurchaseRequestsFirestore({ requested_by_uid: requester.uid, limit: 2, cursor: page1.next_cursor });
  ok(page2.items.every(r => !page1.items.some(p => p.id === r.id)), '22. Second page does not repeat the first page');

  const byStatus = await listPurchaseRequestsFirestore({ status: PR_STATUS.CANCELLED, requested_by_uid: requester.uid });
  ok(byStatus.items.length > 0 && byStatus.items.every(r => r.status === PR_STATUS.CANCELLED), '23. Filter by status');

  const byRequester = await listPurchaseRequestsFirestore({ requested_by_uid: requester.uid });
  ok(byRequester.items.length >= 4 && byRequester.items.every(r => r.requested_by_uid === requester.uid), '23. Filter by requester');

  const byLocation = await listPurchaseRequestsFirestore({ location_id: activeLocation.id, requested_by_uid: requester.uid });
  ok(byLocation.items.every(r => r.location_id === activeLocation.id), '23. Filter by location');

  const byDept = await listPurchaseRequestsFirestore({ department: 'KITCHEN', requested_by_uid: requester.uid });
  ok(byDept.items.every(r => r.department === 'KITCHEN'), '23. Filter by department');

  const byNumber = await listPurchaseRequestsFirestore({ request_number: submitted.request.request_number });
  ok(byNumber.items.length === 1 && byNumber.items[0].id === draftId, '23. Filter by exact request number');

  const bd = submitted.request.business_date;
  const byDate = await listPurchaseRequestsFirestore({ from: bd, to: bd });
  ok(byDate.items.length > 0 && byDate.items.every(r => r.business_date === bd), '23. Filter by business-date range');

  // ── final stock verification ────────────────────────────────────────────
  console.log('\n── Final stock-impact verification ───────────────────────────────────────────');
  const finalFp = await stockFingerprint();
  ok(finalFp.movementCount === baseline.movementCount,
    '26. No inventory movement was created by ANY purchase-request operation',
    `baseline=${baseline.movementCount} final=${finalFp.movementCount}`);
  ok(finalFp.balances === baseline.balances, '24/25. Every product balance is byte-identical to the baseline');
  const productNow = await InventoryCutoverService.getProductById(product.id);
  ok(productNow.current_stock === 10, 'Requesting 20 KG left stock at 10 KG (request ≠ stock addition)', `got ${productNow.current_stock}`);

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\n── Cleanup ───────────────────────────────────────────────────────────────────');
  for (const fn of cleanup) {
    try { await fn(); } catch (err) { console.warn(`  [cleanup warning] ${err.message}`); }
  }
  const leftoverRequests = await db.collection('purchase_requests').where('requested_by_uid', '==', requester.uid).get();
  const leftoverItems = await db.collection('purchase_request_items').where('request_id', 'in', [draftId, second.request.id, c1.request.id, toCancel.request.id]).get();
  ok(leftoverRequests.empty, 'Cleanup: no synthetic purchase requests left behind', `found ${leftoverRequests.size}`);
  ok(leftoverItems.empty, 'Cleanup: no orphan purchase-request items left behind', `found ${leftoverItems.size}`);

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
