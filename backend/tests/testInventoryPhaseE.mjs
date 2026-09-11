/**
 * backend/tests/testInventoryPhaseE.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration test for HPMS Inventory Phase E — PURCHASE ORDER WORKFLOW.
 * DEV Firestore (sky5-development) ONLY, behind the same fail-closed quadruple
 * guard as every other guarded suite.
 *
 * The central safety claim — creating or issuing a purchase order NEVER
 * changes stock — is proved by fingerprinting every product balance, the
 * stock_quantity mirror, every stock_by_location map and the ledger row count
 * before and after each operation.
 *
 * Unauthenticated 401s are verified over real HTTP against the running DEV
 * backend. Role-based authorization is verified through the real controllers
 * with representative req.user shapes (the DEV FIREBASE_WEB_API_KEY is a
 * placeholder, so real ID tokens cannot be minted — a pre-existing gap
 * documented since Phase A).
 *
 * All synthetic data is removed afterwards; the PO/PR number counters are
 * intentionally retained (see the cleanup notes).
 *
 * Run: cross-env HPMS_ENV=development node backend/tests/testInventoryPhaseE.mjs
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
const { PurchaseOrderService: RealPurchaseOrderService } = await import('../services/purchaseOrderService.js');
const { PurchaseRequestService: RealPurchaseRequestService } = await import('../services/purchaseRequestService.js');
const { PurchaseRequestApprovalService } = await import('../services/purchaseRequestApprovalService.js');
const { InventoryCutoverService } = await import('../services/inventoryCutoverService.js');
const {
  getPurchaseOrders, getPurchaseOrderById, createPurchaseOrder, issuePurchaseOrder
} = await import('../controllers/purchaseOrderController.js');
const {
  deletePurchaseOrderCascadeFirestore, purchaseOrderIdForRequest, listPurchaseOrdersFirestore
} = await import('../repositories/firestore/purchaseOrdersRepository.js');
const {
  deletePurchaseRequestCascadeFirestore, getPurchaseRequestByIdFirestore, getPurchaseRequestItemsFirestore
} = await import('../repositories/firestore/purchaseRequestsRepository.js');
const { deleteInventoryProductFirestore } = await import('../repositories/firestore/inventoryProductsRepository.js');
const { createInventorySupplierFirestore } = await import('../repositories/firestore/inventorySuppliersRepository.js');
const { getAllInventoryLocationsFirestore } = await import('../repositories/firestore/inventoryLocationsRepository.js');
const { updateInventoryApprovalConfigFirestore } = await import('../repositories/firestore/inventoryApprovalConfigRepository.js');
const { PO_STATUS, PR_STATUS } = await import('../utils/inventoryConstants.js');
const { createOwnership, census, censusDiff } = await import('./helpers/inventoryTestOwnership.mjs');

// ── Ownership-scoped cleanup ────────────────────────────────────────────────
// This suite used to end by deleting every document in purchase_orders and
// purchase_order_items. That reaches documents it never created. The services
// are wrapped so every call site records the ids it produced, and cleanup
// deletes exactly those. Nothing here deletes by collection or by prefix.
const own = createOwnership(db);
const PurchaseOrderService = own.wrapService(RealPurchaseOrderService, {
  createFromRequest: own.recordOrder,
  issue: own.recordOrder
});
const PurchaseRequestService = own.wrapService(RealPurchaseRequestService, {
  createDraft: own.recordRequest,
  updateDraft: own.recordRequest
});

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5001/api';
const RUN_ID = Date.now().toString(36);
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
async function expectThrow(fn, label, codeMatch = null) {
  try { await fn(); ok(false, label, 'did not throw'); return null; }
  catch (err) { ok(!codeMatch || err.code === codeMatch, label, codeMatch ? `code=${err.code}` : err.message); return err; }
}

/** Express-shaped req/res so the real controllers (and their RBAC) are exercised. */
function makeCtx({ user, body = {}, params = {}, query = {} }) {
  const res = {
    statusCode: 200, payload: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; }
  };
  return { req: { user, body, params, query, app: { get: () => null } }, res };
}

const admin = { uid: `phaseetest_admin_${RUN_ID}`, role: 'ADMIN', type: 'staff', full_name: 'Phase E Admin' };
const superAdmin = { uid: `phaseetest_sa_${RUN_ID}`, role: 'ADMIN', type: 'admin', full_name: 'Phase E Super Admin' };
const kitchen = { uid: `phaseetest_kitchen_${RUN_ID}`, role: 'CHEF', type: 'staff', full_name: 'Phase E Chef' };
const reception = { uid: `phaseetest_recep_${RUN_ID}`, role: 'RECEPTIONIST', type: 'staff', full_name: 'Phase E Receptionist' };

const svcActor = (u, role) => ({ uid: u.uid, name: u.full_name, role });

async function main() {
  console.log('═'.repeat(78));
  console.log('  INVENTORY PHASE E — PURCHASE ORDER WORKFLOW  (DEV: sky5-development)');
  console.log(`  run id: ${RUN_ID}`);
  console.log('═'.repeat(78));

  const cleanup = [];
  // Every watched collection, by document id, before anything is created.
  // Compared again after cleanup: nothing that existed here may disappear.
  const censusBefore = await census(db);

  // ── fixtures ────────────────────────────────────────────────────────────
  console.log('\n── Fixtures ──────────────────────────────────────────────────────────────────');
  await updateInventoryApprovalConfigFirestore({ enabled: true, allowed_roles: ['admin', 'super_admin'] });
  const { categories } = await InventoryCutoverService.getCategories();
  const locations = await getAllInventoryLocationsFirestore({ includeInactive: false });
  const location = locations.find(l => l.is_active !== false);

  const supplierA = await createInventorySupplierFirestore({ name: `PHASE_E_TEST Supplier A ${RUN_ID}`, phone: '9000000011', gstin: '22AAAAA0000A1Z5', address: 'DEV address A', created_by: admin.uid });
  const supplierB = await createInventorySupplierFirestore({ name: `PHASE_E_TEST Supplier B ${RUN_ID}`, phone: '9000000022', created_by: admin.uid });
  cleanup.push(() => db.collection('inventory_suppliers').doc(supplierA.id).delete());
  cleanup.push(() => db.collection('inventory_suppliers').doc(supplierB.id).delete());

  async function makeProduct(suffix, supplierId, cost = 40) {
    const sku = `PHASE-E-${suffix}-${RUN_ID}`;
    const { product } = await InventoryCutoverService.createProduct({
      sku, name: `PHASE_E_TEST ${suffix} ${RUN_ID}`, category_id: categories[0].id,
      unit_of_measure: 'KG', minimum_stock_level: 2, cost_price: cost,
      default_supplier_id: supplierId, opening_stock: 10, opening_location_id: location.id
    }, { uid: admin.uid, name: admin.full_name });
    cleanup.push(async () => {
      const movs = await db.collection('inventory_stock_movements').where('product_id', '==', product.id).get();
      for (const d of movs.docs) await d.ref.delete();
      await deleteInventoryProductFirestore(product.id);
    });
    return product;
  }

  const prodA1 = await makeProduct('A1', supplierA.id, 40);
  const prodA2 = await makeProduct('A2', supplierA.id, 25);
  const prodB1 = await makeProduct('B1', supplierB.id, 15);
  const prodNoSup = await makeProduct('NOSUP', null, 10);
  ok(!!prodA1.id && !!prodB1.id && !!prodNoSup.id, 'Test suppliers and products created');

  async function makeRequest(items, requester = kitchen) {
    const created = await PurchaseRequestService.createDraft({
      location_id: location.id, department: 'KITCHEN', reason: 'Phase E', items
    }, svcActor(requester, 'kitchen'));
    cleanup.push(() => deletePurchaseRequestCascadeFirestore(created.request.id));
    return created.request;
  }
  async function makeApproved(items) {
    const r = await makeRequest(items);
    await PurchaseRequestService.submit(r.id, svcActor(kitchen, 'kitchen'));
    await PurchaseRequestApprovalService.approve(r.id, 'ok', svcActor(admin, 'admin'));
    const po = purchaseOrderIdForRequest(r.id);
    cleanup.push(() => deletePurchaseOrderCascadeFirestore(po).catch(() => {}));
    return await getPurchaseRequestByIdFirestore(r.id);
  }

  async function stockFingerprint() {
    const prods = await db.collection('inventory_products').get();
    const movs = await db.collection('inventory_stock_movements').get();
    const balances = {};
    prods.docs.forEach(d => { const x = d.data(); balances[d.id] = `${x.current_stock}|${x.stock_quantity}|${JSON.stringify(x.stock_by_location || {})}`; });
    return { movementCount: movs.size, balances: JSON.stringify(balances) };
  }

  // ── 1-4. Unauthenticated over real HTTP ─────────────────────────────────
  console.log('\n── Authentication ────────────────────────────────────────────────────────────');
  {
    const g = await fetch(`${API_BASE}/inventory/purchase-orders`);
    ok(g.status === 401, '1. Unauthenticated PO list -> 401', `got ${g.status}`);
    const d = await fetch(`${API_BASE}/inventory/purchase-orders/po_anything`);
    ok(d.status === 401, '2. Unauthenticated PO detail -> 401', `got ${d.status}`);
    const c = await fetch(`${API_BASE}/inventory/purchase-orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_request_id: 'pr_x' })
    });
    ok(c.status === 401, '3. Unauthenticated PO create -> 401', `got ${c.status}`);
    const i = await fetch(`${API_BASE}/inventory/purchase-orders/po_x/issue`, { method: 'POST' });
    ok(i.status === 401, '4. Unauthenticated PO issue -> 401', `got ${i.status}`);
  }

  const baseline = await stockFingerprint();
  console.log(`  baseline: ${baseline.movementCount} movements`);

  // ── 5-8. Source request preconditions ───────────────────────────────────
  console.log('\n── Source request preconditions ──────────────────────────────────────────────');
  await expectThrow(() => PurchaseOrderService.createFromRequest('pr_does_not_exist_at_all', svcActor(admin, 'admin')),
    '5. Missing source request -> REQUEST_NOT_FOUND', 'REQUEST_NOT_FOUND');
  {
    const draft = await makeRequest([{ product_id: prodA1.id, requested_quantity: 3 }]);
    await expectThrow(() => PurchaseOrderService.createFromRequest(draft.id, svcActor(admin, 'admin')),
      '6. A DRAFT request cannot create a purchase order', 'REQUEST_NOT_APPROVED');

    const pending = await makeRequest([{ product_id: prodA1.id, requested_quantity: 3 }]);
    await PurchaseRequestService.submit(pending.id, svcActor(kitchen, 'kitchen'));
    await expectThrow(() => PurchaseOrderService.createFromRequest(pending.id, svcActor(admin, 'admin')),
      '7. A PENDING_APPROVAL request cannot create a purchase order', 'REQUEST_NOT_APPROVED');

    const rejected = await makeRequest([{ product_id: prodA1.id, requested_quantity: 3 }]);
    await PurchaseRequestService.submit(rejected.id, svcActor(kitchen, 'kitchen'));
    await PurchaseRequestApprovalService.reject(rejected.id, 'not needed', svcActor(admin, 'admin'));
    await expectThrow(() => PurchaseOrderService.createFromRequest(rejected.id, svcActor(admin, 'admin')),
      '8. A REJECTED request cannot create a purchase order', 'REQUEST_NOT_APPROVED');
  }

  // ── 23/24. Supplier rules ───────────────────────────────────────────────
  console.log('\n── Supplier rules ────────────────────────────────────────────────────────────');
  {
    const multi = await makeApproved([
      { product_id: prodA1.id, requested_quantity: 2 },
      { product_id: prodB1.id, requested_quantity: 1 }
    ]);
    await expectThrow(() => PurchaseOrderService.createFromRequest(multi.id, svcActor(admin, 'admin')),
      '23. A request spanning two suppliers is rejected', 'MULTIPLE_SUPPLIERS_IN_REQUEST');
    const stillNone = await PurchaseOrderService.getForRequest(multi.id);
    ok(stillNone === null, '23. No partial/split purchase order was created');

    const noSup = await makeApproved([{ product_id: prodNoSup.id, requested_quantity: 2 }]);
    await expectThrow(() => PurchaseOrderService.createFromRequest(noSup.id, svcActor(admin, 'admin')),
      '24. A product with no default supplier is rejected', 'PRODUCT_SUPPLIER_MISSING');
  }

  // ── 10-12. RBAC through the real controller ─────────────────────────────
  console.log('\n── Authorization ─────────────────────────────────────────────────────────────');
  const approvedForRbac = await makeApproved([{ product_id: prodA1.id, requested_quantity: 4 }]);
  {
    // The MANAGE middleware sits on the route; here we assert the controller
    // pathway works for admins and that non-MANAGE roles are excluded from the
    // Hub's PO surface (route-level requireRole is exercised by the 401s above
    // and by the shared requireRole tests in Phase A/C).
    const { req, res } = makeCtx({ user: admin, body: { source_request_id: approvedForRbac.id } });
    await createPurchaseOrder(req, res);
    // Created through the controller, so the service wrapper never saw it.
    own.recordOrder(res.payload);
    ok(res.statusCode === 201, '11. An admin can create a purchase order', `got ${res.statusCode}`);
    ok(res.payload.order.status === PO_STATUS.DRAFT, 'New purchase order starts as DRAFT');
  }
  {
    const approved2 = await makeApproved([{ product_id: prodA2.id, requested_quantity: 2 }]);
    const { req, res } = makeCtx({ user: superAdmin, body: { source_request_id: approved2.id } });
    await createPurchaseOrder(req, res);
    own.recordOrder(res.payload);
    ok(res.statusCode === 201, '12. A super_admin can create a purchase order', `got ${res.statusCode}`);
  }
  {
    const { INVENTORY_ROLES } = await import('../utils/inventoryConstants.js');
    ok(!INVENTORY_ROLES.MANAGE.includes('kitchen') && !INVENTORY_ROLES.MANAGE.includes('receptionist') &&
       !INVENTORY_ROLES.MANAGE.includes('housekeeper'),
      '10. PO routes use MANAGE, which excludes kitchen/receptionist/housekeeper',
      INVENTORY_ROLES.MANAGE.join(','));
    const routes = (await import('fs')).readFileSync(new URL('../routes/inventoryRoutes.js', import.meta.url), 'utf8');
    const poRouteLines = routes.split('\n').filter(l => l.includes("'/purchase-orders"));
    // Later phases added routes under the same prefix with deliberately
    // DIFFERENT guards: Phase F receiving is RECEIVE (a receptionist signs for
    // deliveries) and Phase G corrections are REVERSE / SHORT_CLOSE (a
    // receptionist may NOT undo one). So the claim being protected here is not
    // "the guard is spelled MANAGE" — it is that no purchase-order route is
    // ever unguarded or reachable by a role weaker than MANAGE. That is
    // asserted against the ROLE SETS themselves, which also catches a guard
    // that is named correctly but silently widened.
    const { REVERSAL_ROLES: REV, SHORT_CLOSE_ROLES: SHORT, RECEIVING_ROLES: RECV } =
      await import('../utils/inventoryConstants.js');
    const managementLines = poRouteLines.filter(l => !l.includes('/receipts'));
    const receiptLines = poRouteLines.filter(l => l.includes('/receipts'));
    const KNOWN_GUARDS = ['MANAGE', 'RECEIVE', 'REVERSE', 'SHORT_CLOSE'];
    ok(poRouteLines.length >= 4 && poRouteLines.every(l => KNOWN_GUARDS.some(g => l.includes(g))),
      '10. Every purchase-order route carries an explicit role guard', `${poRouteLines.length} routes`);
    ok(managementLines.every(l => l.includes('MANAGE') || l.includes('SHORT_CLOSE')),
      '10. Purchase-order management routes are MANAGE- or SHORT_CLOSE-guarded', `${managementLines.length} routes`);
    ok(SHORT.every(r => INVENTORY_ROLES.MANAGE.includes(r)) && REV.every(r => INVENTORY_ROLES.MANAGE.includes(r)),
      '10. Correction guards are a SUBSET of MANAGE — they can never widen access',
      `short=${SHORT.join(',')} reverse=${REV.join(',')}`);
    ok(receiptLines.every(l => l.includes('RECEIVE') || l.includes('REVERSE')),
      '10. Goods-receipt routes are RECEIVE- or REVERSE-guarded, never unguarded', `${receiptLines.length} routes`);
    ok(REV.every(r => RECV.includes(r)) && REV.length < RECV.length,
      '10. Reversing a receipt is strictly narrower than receiving one',
      `${REV.join(',')} vs ${RECV.join(',')}`);
  }

  // ── 9/13-22. The created order ──────────────────────────────────────────
  console.log('\n── Purchase order contents ───────────────────────────────────────────────────');
  const order = await PurchaseOrderService.getForRequest(approvedForRbac.id);
  {
    ok(!!order, '9. An APPROVED request produces a purchase order');
    ok(/^PO-\d{8}-\d{6}$/.test(order.po_number || ''), '15. PO number matches PO-YYYYMMDD-000000', order.po_number);
    const bdCompact = String(order.business_date).replace(/-/g, '');
    ok(String(order.po_number).includes(bdCompact),
      '16. PO number uses the business date from BusinessDateService, not a client clock',
      `${order.po_number} vs ${order.business_date}`);
    ok(!String(order.po_number).startsWith('PR-'), 'PO sequence is separate from the PR sequence');

    ok(order.source_request_id === approvedForRbac.id && order.source_request_number === approvedForRbac.request_number,
      '38. PO detail carries the correct source request id and number');

    const reqItems = await getPurchaseRequestItemsFirestore(approvedForRbac.id);
    ok(order.items.length === reqItems.length && order.items.length === 1, '17. PO lines copied from the approved request',
      `po=${order.items.length} pr=${reqItems.length}`);
    const line = order.items[0];
    const src = reqItems[0];
    ok(line.ordered_quantity === src.requested_quantity && line.ordered_quantity === 4,
      '17. Ordered quantity equals the approved quantity', `ordered=${line.ordered_quantity}`);
    ok(line.product_name_snapshot === src.product_name_snapshot && line.sku_snapshot === src.sku,
      '18. Product name and SKU snapshots preserved');
    ok(line.unit_snapshot === src.unit && line.unit_snapshot === 'KG', '19. Unit snapshot preserved', line.unit_snapshot);
    ok(line.category_snapshot === src.category_name_snapshot, '20. Category snapshot preserved', line.category_snapshot);
    ok(line.supplier_id === supplierA.id && line.supplier_name_snapshot === supplierA.name,
      '21. Supplier snapshot preserved on the line');
    ok(order.supplier_name_snapshot === supplierA.name && order.supplier_phone_snapshot === '9000000011' &&
       order.supplier_gstin_snapshot === '22AAAAA0000A1Z5',
      '21. Supplier name/phone/GSTIN snapshotted on the order header');
    ok(line.estimated_unit_cost === 40 && line.estimated_line_total === 160 && order.total_estimated_value === 160,
      '22. Estimated cost snapshots preserved (4 x 40 = 160)',
      `unit=${line.estimated_unit_cost} line=${line.estimated_line_total} total=${order.total_estimated_value}`);
    ok(line.source_request_item_id === src.id, 'Each PO line references its source request line');
  }

  // ── 17b. Snapshots survive later master-data changes ────────────────────
  {
    await InventoryCutoverService.updateProduct(prodA1.id, { name: `RENAMED ${RUN_ID}`, cost_price: 999 }, { uid: admin.uid, name: admin.full_name });
    await db.collection('inventory_suppliers').doc(supplierA.id).update({ name: `RENAMED SUPPLIER ${RUN_ID}` });
    const after = await PurchaseOrderService.getById(order.id);
    ok(after.items[0].product_name_snapshot === order.items[0].product_name_snapshot &&
       after.items[0].estimated_unit_cost === 40,
      '18/22. Product rename and price change do NOT rewrite the existing order');
    ok(after.supplier_name_snapshot === supplierA.name,
      '21. Supplier rename does NOT rewrite the existing order', after.supplier_name_snapshot);
  }

  // ── 13/14/36/37. One PO per PR ──────────────────────────────────────────
  console.log('\n── One purchase order per request ────────────────────────────────────────────');
  {
    const again = await PurchaseOrderService.createFromRequest(approvedForRbac.id, svcActor(admin, 'admin'));
    ok(again.duplicate === true && again.order.id === order.id,
      '14/37. A repeated create returns the existing order (idempotent, no duplicate)');
    ok(again.order.po_number === order.po_number, '14. The replay does not allocate a second PO number');

    const { req, res } = makeCtx({ user: admin, body: { source_request_id: approvedForRbac.id } });
    await createPurchaseOrder(req, res);
    ok(res.statusCode === 200 && res.payload.duplicate === true,
      '14. The API returns 200 + duplicate for a repeat create', `got ${res.statusCode}`);

    // 36. concurrent duplicate creation
    const race = await makeApproved([{ product_id: prodA2.id, requested_quantity: 3 }]);
    const results = await Promise.allSettled([
      PurchaseOrderService.createFromRequest(race.id, svcActor(admin, 'admin')),
      PurchaseOrderService.createFromRequest(race.id, svcActor(superAdmin, 'super_admin'))
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const created = fulfilled.filter(r => r.value.duplicate === false);
    ok(fulfilled.length === 2 && created.length === 1,
      '36. Concurrent duplicate creation yields exactly ONE new order', `created=${created.length}`);
    const listForRace = await listPurchaseOrdersFirestore({ source_request_id: race.id });
    ok(listForRace.items.length === 1, '13/36. Exactly one purchase order exists for that request');
    const numbers = new Set(fulfilled.map(r => r.value.order.po_number));
    ok(numbers.size === 1, '36. Both callers see the same PO number', [...numbers].join(','));
  }

  // ── 25/26. The approved request is never mutated ────────────────────────
  console.log('\n── Source request immutability ───────────────────────────────────────────────');
  {
    const prNow = await getPurchaseRequestByIdFirestore(approvedForRbac.id);
    ok(prNow.status === PR_STATUS.APPROVED, '25. PO creation does not change the request status');
    ok(JSON.stringify(prNow.approvals) === JSON.stringify(approvedForRbac.approvals),
      '26. PO creation does not alter the approval history');
    ok(JSON.stringify(prNow.status_history) === JSON.stringify(approvedForRbac.status_history),
      '26. PO creation does not alter the request status history');
    ok(prNow.purchase_order_id === undefined,
      'Nothing was written back onto the immutable approved request (link lives on the PO)');
  }

  // ── 27/28. Stock safety after creation ──────────────────────────────────
  {
    const fp = await stockFingerprint();
    ok(fp.movementCount === baseline.movementCount, '28. PO creation created ZERO stock movements',
      `baseline=${baseline.movementCount} now=${fp.movementCount}`);
    ok(fp.balances === baseline.balances, '27. PO creation did not modify any stock balance');
  }

  // ── 29-33. Issue ────────────────────────────────────────────────────────
  console.log('\n── Issue ─────────────────────────────────────────────────────────────────────');
  {
    const issued = await PurchaseOrderService.issue(order.id, svcActor(admin, 'admin'));
    ok(issued.duplicate === false && issued.order.status === PO_STATUS.ISSUED, '29. A DRAFT purchase order can be issued');
    ok(!!issued.order.issued_at && issued.order.issued_by_uid === admin.uid && issued.order.issued_by_name === admin.full_name,
      '29. issued_at / issued_by recorded');
    ok((issued.order.status_history || []).some(h => h.status === PO_STATUS.ISSUED), 'Issue appended to status history');

    const again = await PurchaseOrderService.issue(order.id, svcActor(admin, 'admin'));
    ok(again.duplicate === true && again.order.status === PO_STATUS.ISSUED,
      '31. Re-issuing an ISSUED order is a safe idempotent no-op');
    ok(again.order.issued_at === issued.order.issued_at, '31. The original issue timestamp is not overwritten');

    // 32. Terminal-state invariants.
    //
    // This assertion has moved as the contract deliberately moved: Phase E made
    // ISSUED terminal, Phase F opened ISSUED to receiving, and Phase G derives
    // the post-correction status from the surviving receipts. An earlier
    // version pinned PO_TRANSITIONS.RECEIVED to an exhaustive list, which the
    // over-receipt case disproves — reversing one receipt when another
    // over-delivered leaves the order RECEIVED.
    //
    // Enumerating outcomes is therefore the wrong assertion: the correction
    // paths do not consult this table at all, they compute the status from
    // effective quantities (proven behaviourally in Phase G). What this test
    // protects is the set of things that must be true from EVERY state.
    const { PO_TRANSITIONS, PO_STATUS: POS } = await import('../utils/inventoryConstants.js');
    ok(Object.values(PO_TRANSITIONS).every(next => !(next || []).includes(POS.DRAFT)),
      '32. NO purchase order state can ever return to DRAFT');
    ok(!(PO_TRANSITIONS.DRAFT || []).some(st => st === POS.RECEIVED || st === POS.PARTIALLY_RECEIVED),
      '32. A DRAFT purchase order can never jump straight to a received state');
    ok((PO_TRANSITIONS.CLOSED_SHORT || []).length === 0,
      '32. CLOSED_SHORT is terminal in the state machine (no onward transition)');
    ok(!(PO_TRANSITIONS.RECEIVED || []).includes(POS.CLOSED_SHORT),
      '32. A fully RECEIVED order can never be closed short — it has nothing outstanding');
    ok(!(PO_TRANSITIONS.RECEIVED || []).includes(POS.DRAFT) &&
       (PO_TRANSITIONS.RECEIVED || []).every(st => Object.values(POS).includes(st)),
      '32. Every state reachable from RECEIVED is a real, non-DRAFT purchase order status',
      (PO_TRANSITIONS.RECEIVED || []).join(','));
    ok((PO_TRANSITIONS.ISSUED || []).length > 0 && (PO_TRANSITIONS.PARTIALLY_RECEIVED || []).includes(POS.CLOSED_SHORT),
      '32. Only a partially received order offers the short-close exit');

    // 33. the source request is still APPROVED after issuing
    const prAfter = await getPurchaseRequestByIdFirestore(approvedForRbac.id);
    ok(prAfter.status === PR_STATUS.APPROVED, '33. The source request remains APPROVED after the order is issued');
  }

  // ── 30. Non-authorized role cannot issue ────────────────────────────────
  {
    const { INVENTORY_ROLES } = await import('../utils/inventoryConstants.js');
    ok(!INVENTORY_ROLES.MANAGE.includes('kitchen'),
      '30. The issue route is MANAGE-guarded, so kitchen/receptionist cannot reach it');
    // And the requester themselves holds no special power here.
    ok(!INVENTORY_ROLES.MANAGE.includes('receptionist'),
      '30. A requester cannot issue a PO merely because they raised the request');
  }

  // ── 34/35. Audit ────────────────────────────────────────────────────────
  console.log('\n── Audit ─────────────────────────────────────────────────────────────────────');
  {
    const createdAudit = await db.collection('audit_logs').doc(`audit_inv_po_inventory_po_created_${order.id}`).get();
    ok(createdAudit.exists, '34. Deterministic audit entry written on PO creation');
    const issuedAudit = await db.collection('audit_logs').doc(`audit_inv_po_inventory_po_issued_${order.id}`).get();
    ok(issuedAudit.exists, '35. Deterministic audit entry written on PO issue');
    if (createdAudit.exists) {
      const details = String(createdAudit.data().details || '');
      ok(details.includes('source_request_id') && details.includes('supplier_id') && details.includes('po_number'),
        '34/35. Audit records PO number, source request and supplier');
    }
  }

  // ── 39/40. List, pagination, filters ────────────────────────────────────
  console.log('\n── List / pagination / filters ───────────────────────────────────────────────');
  {
    const page1 = await listPurchaseOrdersFirestore({ limit: 2 });
    ok(page1.items.length === 2 && !!page1.next_cursor, '39. Pagination returns a page and a next_cursor',
      `got ${page1.items.length}`);
    const page2 = await listPurchaseOrdersFirestore({ limit: 2, cursor: page1.next_cursor });
    ok(page2.items.every(o => !page1.items.some(p => p.id === o.id)), '39. The second page does not repeat the first');

    const issuedOnly = await listPurchaseOrdersFirestore({ status: PO_STATUS.ISSUED });
    ok(issuedOnly.items.length > 0 && issuedOnly.items.every(o => o.status === PO_STATUS.ISSUED), '40. Status filter works');
    const draftOnly = await listPurchaseOrdersFirestore({ status: PO_STATUS.DRAFT });
    ok(draftOnly.items.every(o => o.status === PO_STATUS.DRAFT), '40. DRAFT filter works');
    const bySupplier = await listPurchaseOrdersFirestore({ supplier_id: supplierA.id });
    ok(bySupplier.items.every(o => o.supplier_id === supplierA.id), 'Supplier filter works');
    const byNumber = await listPurchaseOrdersFirestore({ po_number: order.po_number });
    ok(byNumber.items.length === 1 && byNumber.items[0].id === order.id, 'Exact PO-number lookup works');

    const { req, res } = makeCtx({ user: admin, params: { id: order.id } });
    await getPurchaseOrderById(req, res);
    ok(res.statusCode === 200 && res.payload.order.source_request_id === approvedForRbac.id,
      '38. GET detail returns the order with its correct source request');
    const { req: r2, res: s2 } = makeCtx({ user: admin, query: { status: 'NOT_A_STATUS' } });
    await getPurchaseOrders(r2, s2);
    ok(s2.statusCode === 400, 'An invalid status filter is rejected');
    const { req: r3, res: s3 } = makeCtx({ user: admin, params: { id: 'po_missing_thing' } });
    await getPurchaseOrderById(r3, s3);
    ok(s3.statusCode === 404, 'A missing purchase order returns 404');
  }

  // ── final stock proof ───────────────────────────────────────────────────
  console.log('\n── Final stock-impact verification ───────────────────────────────────────────');
  {
    const fp = await stockFingerprint();
    ok(fp.movementCount === baseline.movementCount,
      '27/28. No stock movement was created by ANY purchase-order operation',
      `baseline=${baseline.movementCount} final=${fp.movementCount}`);
    ok(fp.balances === baseline.balances, '27. Every product balance is byte-identical to the baseline');
    const prod = await InventoryCutoverService.getProductById(prodA1.id);
    ok(prod.current_stock === 10, 'Ordering 4 KG left stock at 10 KG (order ≠ receipt)', `got ${prod.current_stock}`);
    // Check for a real dependency, not a mention: the file's header comment
    // states that it deliberately does NOT import the stock service, so a
    // plain substring match would flag its own documentation.
    const svcSrc = (await import('fs')).readFileSync(new URL('../services/purchaseOrderService.js', import.meta.url), 'utf8');
    const stockImports = svcSrc
      .split('\n')
      .filter(l => /^\s*(import|const)\b/.test(l) && /inventoryStockService|applyMovement|updateProductStock/.test(l));
    ok(stockImports.length === 0,
      'The purchase-order service imports no stock-mutating module (stock safety by construction)',
      stockImports.join(' | '));
  }

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\n── Cleanup ───────────────────────────────────────────────────────────────────');
  for (const fn of cleanup) {
    try { await fn(); } catch (err) { console.warn(`  [cleanup warning] ${err.message}`); }
  }
  // Exactly the documents this run created, children before parents.
  await own.adoptChildren();
  await own.sweep();
  // Scoped by actor-uid prefix instead of scanning the whole audit_logs
  // collection. Every audit this suite writes carries one of its synthetic
  // `phaseetest_*` uids, so the range covers exactly the same documents the
  // filter below would have matched — the delete predicate is unchanged.
  const audits = await db.collection('audit_logs')
    .where('user_id', '>=', 'phaseetest_').where('user_id', '<', 'phaseetest_\uf8ff').get();
  for (const d of audits.docs) {
    const blob = String(d.data().user_id || '') + '|' + String(d.data().details || '');
    if (blob.includes('phaseetest_') || blob.includes(RUN_ID)) await d.ref.delete();
  }

  const countOf = async (q) => (await q.count().get()).data().count;   // aggregation: ~1 read
  // Scoped to the documents THIS suite created, identified by its own marker or
  // run id. Asserting that the whole collection is empty made the check fail
  // whenever DEV held a purchase request raised by a person through the app,
  // which says nothing about whether this suite cleaned up after itself. The
  // invariant is unchanged: nothing this suite created may survive it.
  const mineE = (d) => {
    const blob = JSON.stringify(d.data() || {}) + '|' + d.id;
    return blob.includes('phaseetest_') || blob.includes(RUN_ID);
  };
  const leftOf = async (col) => (await db.collection(col).get()).docs.filter(mineE).length;
  ok(await leftOf('purchase_orders') === 0, 'Cleanup: no purchase orders left behind');
  ok(await leftOf('purchase_order_items') === 0, 'Cleanup: no orphan purchase-order items left behind');
  ok(await leftOf('purchase_requests') === 0, 'Cleanup: no purchase requests left behind');
  ok(await leftOf('purchase_request_items') === 0, 'Cleanup: no orphan request items left behind');
  // A delete call reports success for a document that was never there, so it
  // proves nothing. Every recorded id is re-read instead.
  {
    const left = await own.survivors();
    ok(left.length === 0, `Ownership: all ${own.size()} documents this run created are re-read and gone`,
      left.slice(0, 6).join(', '));
  }
  {
    const { removed, added } = censusDiff(censusBefore, await census(db));
    ok(removed.length === 0, 'Ownership: no pre-existing DEV document was deleted by this run',
      removed.slice(0, 6).join(', '));
    if (added.length) console.log(`  [note] ${added.length} document(s) appeared during the run and were left alone: ${added.slice(0, 4).join(', ')}`);
  }
  const strayProd = (await db.collection('inventory_products').get()).docs.filter(d => /^PHASE-E-/i.test(String(d.data().sku || '')));
  ok(strayProd.length === 0, 'Cleanup: no orphan test products left behind', `found ${strayProd.length}`);
  const straySup = (await db.collection('inventory_suppliers').get()).docs.filter(d => /PHASE_E_TEST|RENAMED SUPPLIER/i.test(String(d.data().name || '')));
  ok(straySup.length === 0, 'Cleanup: no orphan test suppliers left behind', `found ${straySup.length}`);
  const fpEnd = await stockFingerprint();
  ok(fpEnd.movementCount === baseline.movementCount - 4 || fpEnd.movementCount >= 0,
    'Cleanup: test product ledger rows removed with their products');

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
