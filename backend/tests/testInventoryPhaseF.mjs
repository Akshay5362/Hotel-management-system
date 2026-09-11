/**
 * backend/tests/testInventoryPhaseF.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration test for HPMS Inventory Phase F — GOODS RECEIVING + STOCK
 * POSTING. DEV Firestore (sky5-development) ONLY, behind the four-layer
 * fail-closed guard.
 *
 * ── CLEANUP STRATEGY (this phase legitimately changes stock) ─────────────────
 * The stock ledger is append-only by design, so "undoing" test movements with
 * compensating entries would be faking cleanup. Instead this suite operates
 * exclusively on ISOLATED SYNTHETIC PRODUCTS created for the run: every
 * movement it causes belongs to a product that is itself deleted at the end,
 * together with its ledger rows. Persistent seed products are never received
 * into and never mutated — their balances are snapshotted at the start and
 * asserted unchanged at the end, so any accidental contact would fail the run.
 *
 * Unauthenticated 401s are verified over real HTTP. Role authorization is
 * verified through the real route configuration and the shared requireRole
 * middleware (the DEV FIREBASE_WEB_API_KEY is still a placeholder).
 *
 * Run: cross-env HPMS_ENV=development node backend/tests/testInventoryPhaseF.mjs
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
const { GoodsReceiptService: RealGoodsReceiptService } = await import('../services/goodsReceiptService.js');
const { PurchaseOrderService: RealPurchaseOrderService } = await import('../services/purchaseOrderService.js');
const { PurchaseRequestService: RealPurchaseRequestService } = await import('../services/purchaseRequestService.js');
const { PurchaseRequestApprovalService } = await import('../services/purchaseRequestApprovalService.js');
const { InventoryCutoverService } = await import('../services/inventoryCutoverService.js');
const { createGoodsReceipt } = await import('../controllers/goodsReceiptController.js');
const {
  deleteGoodsReceiptCascadeFirestore, getGoodsReceiptsForOrderFirestore, receiptIdForKey
} = await import('../repositories/firestore/goodsReceiptsRepository.js');
const {
  deletePurchaseOrderCascadeFirestore, purchaseOrderIdForRequest,
  getPurchaseOrderByIdFirestore, getPurchaseOrderItemsFirestore
} = await import('../repositories/firestore/purchaseOrdersRepository.js');
const { deletePurchaseRequestCascadeFirestore } = await import('../repositories/firestore/purchaseRequestsRepository.js');
const { deleteInventoryProductFirestore } = await import('../repositories/firestore/inventoryProductsRepository.js');
const { createInventorySupplierFirestore } = await import('../repositories/firestore/inventorySuppliersRepository.js');
const { getAllInventoryLocationsFirestore, createInventoryLocationFirestore } = await import('../repositories/firestore/inventoryLocationsRepository.js');
const { updateInventoryApprovalConfigFirestore } = await import('../repositories/firestore/inventoryApprovalConfigRepository.js');
const { PO_STATUS, VARIANCE_TYPE, RECEIVING_ROLES } = await import('../utils/inventoryConstants.js');
const { createOwnership, census, censusDiff } = await import('./helpers/inventoryTestOwnership.mjs');

// ── Ownership-scoped cleanup ────────────────────────────────────────────────
// This suite used to end by deleting every document in goods_receipts,
// goods_receipt_items, purchase_orders, purchase_order_items,
// purchase_requests and purchase_request_items. That destroyed a purchase
// request a person had raised through the DEV application. The services are
// wrapped so every call site records the ids it produced, and cleanup deletes
// exactly those. Nothing here deletes by collection or by prefix.
const own = createOwnership(db);
const GoodsReceiptService = own.wrapService(RealGoodsReceiptService, {
  receive: own.recordReceipt
});
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

function makeCtx({ user, body = {}, params = {} }) {
  const res = {
    statusCode: 200, payload: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; }
  };
  return { req: { user, body, params, query: {}, app: { get: () => null } }, res };
}

const admin = { uid: `phaseftest_admin_${RUN_ID}`, role: 'ADMIN', type: 'staff', full_name: 'Phase F Admin' };
const receptionist = { uid: `phaseftest_recep_${RUN_ID}`, role: 'RECEPTIONIST', type: 'staff', full_name: 'Phase F Receptionist' };
const kitchen = { uid: `phaseftest_kitchen_${RUN_ID}`, role: 'CHEF', type: 'staff', full_name: 'Phase F Chef' };
const svcActor = (u, role) => ({ uid: u.uid, name: u.full_name, role });

async function main() {
  console.log('═'.repeat(78));
  console.log('  INVENTORY PHASE F — GOODS RECEIVING + STOCK POSTING  (DEV)');
  console.log(`  run id: ${RUN_ID}`);
  console.log('═'.repeat(78));

  const cleanup = [];
  await updateInventoryApprovalConfigFirestore({ enabled: true, allowed_roles: ['admin', 'super_admin'] });
  // Every watched collection, by document id, before anything is created.
  const censusBefore = await census(db);

  // Snapshot the PERSISTENT products — they must be untouched at the end.
  const persistentBefore = {};
  for (const d of (await db.collection('inventory_products').get()).docs) {
    const x = d.data();
    persistentBefore[d.id] = `${x.current_stock}|${x.stock_quantity}|${JSON.stringify(x.stock_by_location || {})}`;
  }
  const persistentMovementIds = new Set((await db.collection('inventory_stock_movements').get()).docs.map(d => d.id));

  // ── fixtures (isolated synthetic products only) ─────────────────────────
  console.log('\n── Fixtures ──────────────────────────────────────────────────────────────────');
  const { categories } = await InventoryCutoverService.getCategories();
  const locations = await getAllInventoryLocationsFirestore({ includeInactive: false });
  const location = locations.find(l => l.is_active !== false);

  const supplier = await createInventorySupplierFirestore({
    name: `PHASE_F_TEST Supplier ${RUN_ID}`, phone: '9000000033', created_by: admin.uid
  });
  cleanup.push(() => db.collection('inventory_suppliers').doc(supplier.id).delete());

  const testProductIds = [];
  async function makeProduct(suffix, cost = 20) {
    const sku = `PHASE-F-${suffix}-${RUN_ID}`;
    const { product } = await InventoryCutoverService.createProduct({
      sku, name: `PHASE_F_TEST ${suffix} ${RUN_ID}`, category_id: categories[0].id,
      unit_of_measure: 'KG', minimum_stock_level: 1, cost_price: cost,
      default_supplier_id: supplier.id, opening_stock: 5, opening_location_id: location.id
    }, { uid: admin.uid, name: admin.full_name });
    testProductIds.push(product.id);
    return product;
  }
  // Every test product (and all of its ledger rows) is removed at the end —
  // that is what keeps the append-only ledger honest.
  cleanup.push(async () => {
    for (const pid of testProductIds) {
      const movs = await db.collection('inventory_stock_movements').where('product_id', '==', pid).get();
      for (const d of movs.docs) await d.ref.delete();
      await deleteInventoryProductFirestore(pid).catch(() => {});
    }
  });

  async function issuedPO(lines) {
    const created = await PurchaseRequestService.createDraft({
      location_id: location.id, department: 'KITCHEN', reason: 'Phase F', items: lines
    }, svcActor(kitchen, 'kitchen'));
    cleanup.push(() => deletePurchaseRequestCascadeFirestore(created.request.id));
    await PurchaseRequestService.submit(created.request.id, svcActor(kitchen, 'kitchen'));
    await PurchaseRequestApprovalService.approve(created.request.id, 'ok', svcActor(admin, 'admin'));
    const po = await PurchaseOrderService.createFromRequest(created.request.id, svcActor(admin, 'admin'));
    cleanup.push(() => deletePurchaseOrderCascadeFirestore(po.order.id).catch(() => {}));
    await PurchaseOrderService.issue(po.order.id, svcActor(admin, 'admin'));
    return await PurchaseOrderService.getById(po.order.id);
  }

  /**
   * Collection/query size via Firestore's count() AGGREGATION.
   *
   * Billed as ~1 read regardless of how many documents match, instead of one
   * read per document. These helpers exist only to compare sizes before and
   * after an operation, so the aggregate is exactly as authoritative as the
   * old full scan was — it just does not download the documents to count them.
   */
  const countOf = async (q) => (await q.count().get()).data().count;

  const stockOf = async (pid) => (await InventoryCutoverService.getProductById(pid)).current_stock;
  const movementCount = () => countOf(db.collection('inventory_stock_movements'));

  const prodExact = await makeProduct('EXACT', 20);
  ok(await stockOf(prodExact.id) === 5, 'Isolated test product created with 5 KG opening stock');

  // ── 1/2. Authentication + authorization ─────────────────────────────────
  console.log('\n── Authentication / authorization ────────────────────────────────────────────');
  {
    const r = await fetch(`${API_BASE}/inventory/purchase-orders/po_x/receipts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'k', lines: [] })
    });
    ok(r.status === 401, '1. Unauthenticated receipt -> 401', `got ${r.status}`);
    const g = await fetch(`${API_BASE}/inventory/purchase-orders/po_x/receipts`);
    ok(g.status === 401, '1. Unauthenticated receipt history -> 401', `got ${g.status}`);

    ok(RECEIVING_ROLES.includes('admin') && RECEIVING_ROLES.includes('super_admin') && RECEIVING_ROLES.includes('receptionist'),
      '2. Receiving roles are admin, super_admin, receptionist', RECEIVING_ROLES.join(','));
    ok(!RECEIVING_ROLES.includes('kitchen') && !RECEIVING_ROLES.includes('housekeeper'),
      '2. Kitchen and housekeeper are NOT receiving roles');
    const routes = (await import('fs')).readFileSync(new URL('../routes/inventoryRoutes.js', import.meta.url), 'utf8');
    const receiptRoutes = routes.split('\n').filter(l => l.includes('/receipts'));
    // Phase G later added a reversal route on this same prefix. It is guarded
    // by REVERSE, NOT RECEIVE, on purpose: a receptionist may sign for a
    // delivery but may not undo one. The two RECEIVING routes are still
    // asserted exactly as before; the correction route is asserted separately
    // and proven to be strictly narrower.
    const receivingRoutes = receiptRoutes.filter(l => !l.includes('/reverse'));
    const correctionRoutes = receiptRoutes.filter(l => l.includes('/reverse'));
    ok(receivingRoutes.length === 2 && receivingRoutes.every(l => l.includes('RECEIVE')),
      '2. Both receipt routes are RECEIVE-guarded server-side', `${receivingRoutes.length} routes`);
    ok(correctionRoutes.every(l => l.includes('REVERSE')) && !correctionRoutes.some(l => l.includes('RECEIVE,')),
      '2. Any receipt-correction route is REVERSE-guarded, never RECEIVE-guarded', `${correctionRoutes.length} routes`);
    const { REVERSAL_ROLES: REV } = await import('../utils/inventoryConstants.js');
    ok(REV.every(r => RECEIVING_ROLES.includes(r)) && REV.length < RECEIVING_ROLES.length,
      '2. Reversal roles are a strict subset of receiving roles', `${REV.join(',')} vs ${RECEIVING_ROLES.join(',')}`);
  }

  // ── 3/4. PO state preconditions ─────────────────────────────────────────
  console.log('\n── Purchase order preconditions ──────────────────────────────────────────────');
  {
    const created = await PurchaseRequestService.createDraft({
      location_id: location.id, department: 'KITCHEN', reason: 'Phase F draft po',
      items: [{ product_id: prodExact.id, requested_quantity: 2 }]
    }, svcActor(kitchen, 'kitchen'));
    cleanup.push(() => deletePurchaseRequestCascadeFirestore(created.request.id));
    await PurchaseRequestService.submit(created.request.id, svcActor(kitchen, 'kitchen'));
    await PurchaseRequestApprovalService.approve(created.request.id, 'ok', svcActor(admin, 'admin'));
    const draftPo = await PurchaseOrderService.createFromRequest(created.request.id, svcActor(admin, 'admin'));
    cleanup.push(() => deletePurchaseOrderCascadeFirestore(draftPo.order.id).catch(() => {}));

    const items = await getPurchaseOrderItemsFirestore(draftPo.order.id);
    await expectThrow(() => GoodsReceiptService.receive(draftPo.order.id, {
      idempotency_key: `f_draft_${RUN_ID}`, lines: [{ po_item_id: items[0].id, received_quantity: 1 }]
    }, svcActor(admin, 'admin')), '3. A DRAFT purchase order cannot receive goods', 'PO_NOT_RECEIVABLE');
  }

  // ── 5/6/31. Exact receipt ───────────────────────────────────────────────
  console.log('\n── Exact receipt ─────────────────────────────────────────────────────────────');
  {
    const po = await issuedPO([{ product_id: prodExact.id, requested_quantity: 10 }]);
    const item = po.items[0];
    const before = await stockOf(prodExact.id);
    const movesBefore = await movementCount();

    const res = await GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_exact_${RUN_ID}`, remarks: 'full delivery',
      lines: [{ po_item_id: item.id, received_quantity: 10 }]
    }, svcActor(admin, 'admin'));

    ok(res.duplicate === false, '5. An ISSUED purchase order can receive goods');
    ok(res.order.status === PO_STATUS.RECEIVED, '6/31. An exact receipt closes the PO as RECEIVED', res.order.status);
    ok(await stockOf(prodExact.id) === before + 10, '19. Stock increased by exactly the received quantity (+10)',
      `${before} -> ${await stockOf(prodExact.id)}`);
    ok(await movementCount() === movesBefore + 1, '20. Exactly one stock movement created');

    const line = res.receipt.items[0];
    ok(line.variance_type === VARIANCE_TYPE.EXACT && line.variance_quantity === 0 && line.outstanding_quantity === 0,
      '6. Exact receipt records EXACT variance and zero outstanding');
    ok(/^GR-\d{8}-\d{6}$/.test(res.receipt.receipt_number || ''), '41. GR number matches GR-YYYYMMDD-000000', res.receipt.receipt_number);
    ok(String(res.receipt.receipt_number).includes(String(res.receipt.business_date).replace(/-/g, '')),
      '42. GR number uses the business date from BusinessDateService');

    // 20/21 movement shape
    const mov = (await db.collection('inventory_stock_movements').doc(line.stock_movement_id).get()).data();
    ok(mov.movement_type === 'RECEIPT', '20. Movement type is RECEIPT', mov.movement_type);
    ok(mov.reference_type === 'GOODS_RECEIPT' && mov.reference_id === res.receipt.receipt_id,
      '21. Movement references the goods receipt', `${mov.reference_type}/${mov.reference_id}`);
    ok(String(mov.reason).includes(po.po_number), '21. Movement reason names the purchase order');
    ok(mov.location_id === location.id, '44. Stock posted to the PO location');

    // 4. already-received PO cannot receive again
    await expectThrow(() => GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_exact_again_${RUN_ID}`, lines: [{ po_item_id: item.id, received_quantity: 1 }]
    }, svcActor(admin, 'admin')), '4. A fully RECEIVED purchase order cannot receive again', 'PO_NOT_RECEIVABLE');
  }

  // ── 7/8/9/13/32/33. Partial then closing receipt ────────────────────────
  console.log('\n── Partial receipts ──────────────────────────────────────────────────────────');
  {
    const prod = await makeProduct('PARTIAL', 10);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 10 }]);
    const item = po.items[0];
    const before = await stockOf(prod.id);

    const r1 = await GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_part1_${RUN_ID}`, lines: [{ po_item_id: item.id, received_quantity: 7 }]
    }, svcActor(receptionist, 'receptionist'));
    ok(r1.order.status === PO_STATUS.PARTIALLY_RECEIVED, '7/32. A short delivery leaves the PO PARTIALLY_RECEIVED', r1.order.status);
    ok(await stockOf(prod.id) === before + 7, '19. Stock increased by 7, not by the ordered 10', `${before} -> ${await stockOf(prod.id)}`);
    const l1 = r1.receipt.items[0];
    ok(l1.outstanding_quantity === 3 && l1.variance_type === VARIANCE_TYPE.SHORT,
      '13. Outstanding quantity is 3 and variance is SHORT', `outstanding=${l1.outstanding_quantity}`);
    ok(l1.variance_reason === null, '16. A short delivery does NOT require a variance reason');

    const r2 = await GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_part2_${RUN_ID}`, lines: [{ po_item_id: item.id, received_quantity: 3 }]
    }, svcActor(receptionist, 'receptionist'));
    ok(r2.order.status === PO_STATUS.RECEIVED, '8. The second receipt closes the PO as RECEIVED');
    ok(await stockOf(prod.id) === before + 10, '19. Cumulative stock increase is exactly +10', `${before} -> ${await stockOf(prod.id)}`);
    const l2 = r2.receipt.items[0];
    ok(l2.previously_received_quantity === 7 && l2.cumulative_received_quantity === 10 && l2.outstanding_quantity === 0,
      '8. The closing receipt records previous 7, cumulative 10, outstanding 0');

    const receipts = await getGoodsReceiptsForOrderFirestore(po.id);
    ok(receipts.length === 2, '9. Both receipts are preserved as separate records', `found ${receipts.length}`);
    ok(receipts[0].receipt_number !== receipts[1].receipt_number, '9. Each receipt has its own GR number');

    const poNow = await getPurchaseOrderByIdFirestore(po.id);
    const hist = poNow.status_history.map(h => h.status);
    ok(hist.includes('ISSUED') && hist.includes(PO_STATUS.PARTIALLY_RECEIVED) && hist.includes(PO_STATUS.RECEIVED),
      '33. PO status history records ISSUED → PARTIALLY_RECEIVED → RECEIVED', hist.join(' → '));
  }

  // ── 10/11/12. Over-receipt ──────────────────────────────────────────────
  console.log('\n── Over-receipt ──────────────────────────────────────────────────────────────');
  {
    const prod = await makeProduct('OVER', 15);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 10 }]);
    const item = po.items[0];
    const before = await stockOf(prod.id);

    await expectThrow(() => GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_over_noreason_${RUN_ID}`, lines: [{ po_item_id: item.id, received_quantity: 12 }]
    }, svcActor(admin, 'admin')), '11. An over-receipt without a reason is rejected', 'VARIANCE_REASON_REQUIRED');

    ok(await stockOf(prod.id) === before, '24. The rejected over-receipt posted NO stock', `${before} -> ${await stockOf(prod.id)}`);
    const rejectedReceipt = await db.collection('goods_receipts').doc(receiptIdForKey(`f_over_noreason_${RUN_ID}`)).get();
    ok(!rejectedReceipt.exists, '23. The failed transaction created no goods receipt');
    const poAfterFail = await getPurchaseOrderByIdFirestore(po.id);
    ok(poAfterFail.status === PO_STATUS.ISSUED, '25. The failed transaction did not alter the PO status');

    const res = await GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_over_${RUN_ID}`,
      lines: [{ po_item_id: item.id, received_quantity: 12, variance_reason: 'Supplier sent a full case' }]
    }, svcActor(admin, 'admin'));
    ok(res.order.status === PO_STATUS.RECEIVED, '10/17. An accepted over-receipt closes the PO as RECEIVED');
    ok(await stockOf(prod.id) === before + 12, '10/19. Stock increased by the ACCEPTED 12, not clamped to 10',
      `${before} -> ${await stockOf(prod.id)}`);
    const line = res.receipt.items[0];
    ok(line.variance_type === VARIANCE_TYPE.OVER && line.variance_quantity === 2,
      '12. Variance recorded as OVER +2', `${line.variance_type} ${line.variance_quantity}`);
    ok(line.variance_reason === 'Supplier sent a full case', '12. The variance reason is stored on the line');
    ok(line.outstanding_quantity === 0, '12. Outstanding is zero on an over-receipt');
  }

  // ── 14/15/16/17. Line validation ────────────────────────────────────────
  console.log('\n── Line validation ───────────────────────────────────────────────────────────');
  {
    const prodA = await makeProduct('VALA', 10);
    const prodB = await makeProduct('VALB', 10);
    const po = await issuedPO([
      { product_id: prodA.id, requested_quantity: 5 },
      { product_id: prodB.id, requested_quantity: 5 }
    ]);
    const [ia, ib] = po.items;
    const beforeA = await stockOf(prodA.id), beforeB = await stockOf(prodB.id);

    // 14. only submitted lines are received
    const res = await GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_onlyone_${RUN_ID}`, lines: [{ po_item_id: ia.id, received_quantity: 5 }]
    }, svcActor(admin, 'admin'));
    ok(res.receipt.items.length === 1, '14. Only the submitted line becomes a receipt line');
    ok(await stockOf(prodB.id) === beforeB, '14. The omitted item received no stock', `B stayed ${beforeB}`);
    ok(res.order.status === PO_STATUS.PARTIALLY_RECEIVED, '14. The PO stays open while another line is outstanding');
    ok(await stockOf(prodA.id) === beforeA + 5, '14. The submitted item received its stock');

    await expectThrow(() => GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_badline_${RUN_ID}`, lines: [{ po_item_id: 'po_item_that_does_not_exist', received_quantity: 1 }]
    }, svcActor(admin, 'admin')), '15. An unknown purchase-order line is rejected', 'PO_ITEM_NOT_FOUND');

    await expectThrow(() => GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_duplines_${RUN_ID}`,
      lines: [{ po_item_id: ib.id, received_quantity: 1 }, { po_item_id: ib.id, received_quantity: 2 }]
    }, svcActor(admin, 'admin')), '16. A duplicated purchase-order line is rejected', 'DUPLICATE_RECEIPT_LINE');

    await expectThrow(() => GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_zero_${RUN_ID}`, lines: [{ po_item_id: ib.id, received_quantity: 0 }]
    }, svcActor(admin, 'admin')), '17. A zero quantity is rejected (omit the line instead)', 'INVALID_QUANTITY');

    await expectThrow(() => GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_neg_${RUN_ID}`, lines: [{ po_item_id: ib.id, received_quantity: -3 }]
    }, svcActor(admin, 'admin')), '17. A negative quantity is rejected', 'INVALID_QUANTITY');

    await expectThrow(() => GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_unit_${RUN_ID}`, lines: [{ po_item_id: ib.id, received_quantity: 1, unit: 'LTR' }]
    }, svcActor(admin, 'admin')), 'A unit that differs from the ordered unit is rejected', 'UNIT_MISMATCH');

    await expectThrow(() => GoodsReceiptService.receive(po.id, {
      lines: [{ po_item_id: ib.id, received_quantity: 1 }]
    }, svcActor(admin, 'admin')), 'A receipt without an idempotency key is rejected', 'IDEMPOTENCY_KEY_REQUIRED');

    // 18. the client cannot redirect stock to another location
    const otherLoc = await createInventoryLocationFirestore({
      code: `PF-OTHER-${RUN_ID}`, name: `PHASE_F_TEST Other Location ${RUN_ID}`, created_by: admin.uid
    });
    cleanup.push(() => db.collection('inventory_locations').doc(otherLoc.id).delete());
    const sneaky = await GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_loc_${RUN_ID}`,
      // location_id is deliberately NOT part of the receipt contract
      location_id: otherLoc.id,
      lines: [{ po_item_id: ib.id, received_quantity: 5, location_id: otherLoc.id }]
    }, svcActor(admin, 'admin'));
    const movLoc = (await db.collection('inventory_stock_movements').doc(sneaky.receipt.items[0].stock_movement_id).get()).data();
    ok(movLoc.location_id === location.id && movLoc.location_id !== otherLoc.id,
      '18. A client-supplied location is ignored — stock posts to the PO location', movLoc.location_id);
    const bStock = await InventoryCutoverService.getProductById(prodB.id);
    ok((bStock.stock_by_location[otherLoc.id] || 0) === 0, '18. Nothing was posted to the client-supplied location');
  }

  // ── 22/26/27/28/43. Idempotency ─────────────────────────────────────────
  console.log('\n── Idempotency ───────────────────────────────────────────────────────────────');
  {
    const prod = await makeProduct('IDEM', 10);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 10 }]);
    const item = po.items[0];
    const before = await stockOf(prod.id);
    const movesBefore = await movementCount();
    const key = `f_idem_${RUN_ID}`;
    const payload = { idempotency_key: key, lines: [{ po_item_id: item.id, received_quantity: 4 }] };

    const first = await GoodsReceiptService.receive(po.id, payload, svcActor(admin, 'admin'));
    const second = await GoodsReceiptService.receive(po.id, payload, svcActor(admin, 'admin'));
    ok(first.duplicate === false && second.duplicate === true, '26. A retried receipt is an idempotent replay');
    ok(second.receipt.receipt_number === first.receipt.receipt_number,
      '43. The retry does not allocate a second GR number', `${first.receipt.receipt_number} / ${second.receipt.receipt_number}`);
    ok(await stockOf(prod.id) === before + 4, '26. Stock increased once, not twice', `${before} -> ${await stockOf(prod.id)}`);
    ok(await movementCount() === movesBefore + 1, '26. Exactly one stock movement exists for the retried receipt');
    const receiptsNow = await getGoodsReceiptsForOrderFirestore(po.id);
    ok(receiptsNow.length === 1, '26. Only one goods receipt document exists');

    // 28. same key, different payload
    await expectThrow(() => GoodsReceiptService.receive(po.id, {
      idempotency_key: key, lines: [{ po_item_id: item.id, received_quantity: 6 }]
    }, svcActor(admin, 'admin')), '28. Reusing the key with a different payload is refused', 'IDEMPOTENCY_KEY_REUSE_CONFLICT');
    ok(await stockOf(prod.id) === before + 4, '28. The refused reuse changed no stock');

    // 27. concurrent same key
    const prod2 = await makeProduct('IDEMCONC', 10);
    const po2 = await issuedPO([{ product_id: prod2.id, requested_quantity: 10 }]);
    const item2 = po2.items[0];
    const before2 = await stockOf(prod2.id);
    const movesBefore2 = await movementCount();
    const key2 = `f_idem_conc_${RUN_ID}`;
    const results = await Promise.allSettled([
      GoodsReceiptService.receive(po2.id, { idempotency_key: key2, lines: [{ po_item_id: item2.id, received_quantity: 6 }] }, svcActor(admin, 'admin')),
      GoodsReceiptService.receive(po2.id, { idempotency_key: key2, lines: [{ po_item_id: item2.id, received_quantity: 6 }] }, svcActor(receptionist, 'receptionist'))
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    ok(fulfilled.length === 2, '27. Both concurrent callers with the same key succeed');
    ok(await stockOf(prod2.id) === before2 + 6, '27. Concurrent same-key receipts posted stock ONCE (+6)',
      `${before2} -> ${await stockOf(prod2.id)}`);
    ok(await movementCount() === movesBefore2 + 1, '27. Exactly one movement from the concurrent same-key pair');
    ok((await getGoodsReceiptsForOrderFirestore(po2.id)).length === 1, '27. Exactly one receipt from the concurrent pair');
    const nums = new Set(fulfilled.map(r => r.value.receipt.receipt_number));
    ok(nums.size === 1, '27. Both callers received the same GR number', [...nums].join(','));
  }

  // ── 29/30. Concurrency with different keys ──────────────────────────────
  console.log('\n── Concurrent receiving ──────────────────────────────────────────────────────');
  {
    const prod = await makeProduct('CONC', 10);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 10 }]);
    const item = po.items[0];
    const before = await stockOf(prod.id);

    const [a, b] = await Promise.allSettled([
      GoodsReceiptService.receive(po.id, { idempotency_key: `f_conc_a_${RUN_ID}`, lines: [{ po_item_id: item.id, received_quantity: 7 }] }, svcActor(admin, 'admin')),
      GoodsReceiptService.receive(po.id, { idempotency_key: `f_conc_b_${RUN_ID}`, lines: [{ po_item_id: item.id, received_quantity: 3 }] }, svcActor(receptionist, 'receptionist'))
    ]);
    ok(a.status === 'fulfilled' && b.status === 'fulfilled', '29. Both concurrent partial receipts succeed');
    ok(await stockOf(prod.id) === before + 10, '29. Stock increased by exactly +10 with no lost update',
      `${before} -> ${await stockOf(prod.id)}`);
    const poNow = await getPurchaseOrderByIdFirestore(po.id);
    const itemNow = (await getPurchaseOrderItemsFirestore(po.id))[0];
    ok(itemNow.received_quantity === 10 && itemNow.outstanding_quantity === 0,
      '29. Cumulative received is exactly 10 with zero outstanding', `received=${itemNow.received_quantity}`);
    ok(poNow.status === PO_STATUS.RECEIVED, '29. The PO ends RECEIVED after the concurrent pair');

    // 30. concurrent over-receipts
    const prodO = await makeProduct('CONCOVER', 10);
    const poO = await issuedPO([{ product_id: prodO.id, requested_quantity: 10 }]);
    const itemO = poO.items[0];
    const beforeO = await stockOf(prodO.id);
    const [x, y] = await Promise.allSettled([
      GoodsReceiptService.receive(poO.id, { idempotency_key: `f_co_a_${RUN_ID}`, lines: [{ po_item_id: itemO.id, received_quantity: 8, variance_reason: 'bulk delivery A' }] }, svcActor(admin, 'admin')),
      GoodsReceiptService.receive(poO.id, { idempotency_key: `f_co_b_${RUN_ID}`, lines: [{ po_item_id: itemO.id, received_quantity: 8, variance_reason: 'bulk delivery B' }] }, svcActor(receptionist, 'receptionist'))
    ]);
    const okCount = [x, y].filter(r => r.status === 'fulfilled').length;
    const finalItem = (await getPurchaseOrderItemsFirestore(poO.id))[0];
    const finalStock = await stockOf(prodO.id);
    ok(okCount === 2, '30. Both concurrent over-receipts are accepted (over-receipt is permitted)');
    ok(finalStock === beforeO + 16, '30. Stock reflects both accepted deliveries (+16)', `${beforeO} -> ${finalStock}`);
    ok(finalItem.received_quantity === 16 && finalItem.variance_quantity === 6 && finalItem.variance_type === VARIANCE_TYPE.OVER,
      '30. Final cumulative is 16 with variance +6 — no stale read', `cum=${finalItem.received_quantity} var=${finalItem.variance_quantity}`);
  }

  // ── 34-39. Immutability and snapshots ───────────────────────────────────
  console.log('\n── Immutability and snapshots ────────────────────────────────────────────────');
  {
    const prod = await makeProduct('SNAP', 30);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 4 }]);
    const item = po.items[0];
    const res = await GoodsReceiptService.receive(po.id, {
      idempotency_key: `f_snap_${RUN_ID}`, lines: [{ po_item_id: item.id, received_quantity: 4 }]
    }, svcActor(admin, 'admin'));
    const line = res.receipt.items[0];
    ok(line.received_value === 4 * 30, '39. Receipt value uses the PO cost snapshot (4 x 30)', `${line.received_value}`);

    // 38/39 — later master-data changes must not rewrite history
    await InventoryCutoverService.updateProduct(prod.id, { name: `RENAMED ${RUN_ID}`, cost_price: 999 }, { uid: admin.uid, name: admin.full_name });
    const after = await GoodsReceiptService.getById(res.receipt.receipt_id);
    ok(after.items[0].product_name_snapshot === line.product_name_snapshot,
      '38. A later product rename does not alter the receipt');
    ok(after.items[0].estimated_unit_cost === 30 && after.items[0].received_value === 120,
      '39. A later cost change does not alter the receipt value');

    // 34. no update/delete path is exposed
    const svc = (await import('fs')).readFileSync(new URL('../services/goodsReceiptService.js', import.meta.url), 'utf8');
    ok(!/\bupdateReceipt\b|\breverseReceipt\b|\bundoReceipt\b|\bdeleteReceipt\b/.test(svc),
      '34. The service exposes no edit, delete, undo or reverse path');
    const routes = (await import('fs')).readFileSync(new URL('../routes/inventoryRoutes.js', import.meta.url), 'utf8');
    ok(!/\.(put|patch|delete)\(.*receipts/.test(routes), '34. No PUT/PATCH/DELETE route exists for receipts');

    // 35/36/37 — the PO and its source request are otherwise untouched
    const poNow = await getPurchaseOrderByIdFirestore(po.id);
    const itemNow = (await getPurchaseOrderItemsFirestore(po.id))[0];
    ok(poNow.supplier_name_snapshot === po.supplier_name_snapshot, '37. PO supplier snapshot unchanged by receiving');
    ok(itemNow.product_name_snapshot === item.product_name_snapshot && itemNow.ordered_quantity === item.ordered_quantity &&
       itemNow.estimated_unit_cost === item.estimated_unit_cost,
      '36. PO item snapshots unchanged by receiving');
    const pr = await db.collection('purchase_requests').doc(poNow.source_request_id).get();
    ok(pr.exists && pr.data().status === 'APPROVED', '35. The source purchase request remains APPROVED and unchanged');
  }

  // ── 40. Audit ───────────────────────────────────────────────────────────
  console.log('\n── Audit ─────────────────────────────────────────────────────────────────────');
  {
    const auditId = `audit_inv_gr_${receiptIdForKey(`f_exact_${RUN_ID}`)}`;
    const doc = await db.collection('audit_logs').doc(auditId).get();
    ok(doc.exists, '40. Deterministic audit entry written for the goods receipt', auditId);
    if (doc.exists) {
      const details = String(doc.data().details || '');
      ok(details.includes('receipt_number') && details.includes('po_number') && details.includes('supplier_id') &&
         details.includes('total_received_value'),
        '40. Audit records receipt number, PO, supplier and value');
    }
  }

  // ── 45/46/47/48. No unrelated writes ────────────────────────────────────
  console.log('\n── Scope containment ─────────────────────────────────────────────────────────');
  {
    const cols = (await db.listCollections()).map(c => c.id);
    ok(!cols.includes('payments') && !cols.includes('food_payments'), '45. No payment records created', cols.filter(c => /payment/i.test(c)).join(',') || 'none');
    ok(!cols.includes('invoices'), '46. No invoice records created');
    ok(!cols.includes('notifications'), '47. No notification collection created');
    const svc = (await import('fs')).readFileSync(new URL('../services/goodsReceiptService.js', import.meta.url), 'utf8');
    const badImports = svc.split('\n').filter(l => /^\s*import/.test(l) && /(payment|invoice|ledger|cash|food|housekeep|reservation|guest)/i.test(l));
    ok(badImports.length === 0, '48. The receiving service imports no payment/invoice/ledger/unrelated module', badImports.join(' | '));
    ok(svc.includes('stageMovementInTransaction'), 'Receiving reuses the shared ledger core (no second stock system)');
    ok(!/db\.runTransaction/.test(svc.split('async receive')[0]), 'Only the receive flow opens a transaction');
  }

  // ── persistent data untouched ───────────────────────────────────────────
  console.log('\n── Persistent data protection ────────────────────────────────────────────────');
  {
    let drift = 0;
    for (const d of (await db.collection('inventory_products').get()).docs) {
      if (!persistentBefore[d.id]) continue;    // a synthetic test product
      const x = d.data();
      const now = `${x.current_stock}|${x.stock_quantity}|${JSON.stringify(x.stock_by_location || {})}`;
      if (now !== persistentBefore[d.id]) { drift++; console.log(`    drift on ${d.id}`); }
    }
    ok(drift === 0, 'No pre-existing (seed) product balance was touched by this run');
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
  // `phaseftest_*` uids, so the range covers exactly the same documents the
  // filter below would have matched — the delete predicate is unchanged.
  const audits = await db.collection('audit_logs')
    .where('user_id', '>=', 'phaseftest_').where('user_id', '<', 'phaseftest_\uf8ff').get();
  for (const d of audits.docs) {
    const blob = String(d.data().user_id || '') + '|' + String(d.data().details || '');
    if (blob.includes('phaseftest_') || blob.includes(RUN_ID)) await d.ref.delete();
  }

  // Scoped to what THIS run created. Asserting the collections are globally
  // empty was the assertion that made a destructive sweep look necessary.
  {
    const left = await own.survivors();
    const of = (c) => left.filter(x => x.startsWith(c + '/')).length;
    ok(of('goods_receipts') === 0, 'Cleanup: no goods receipt this run created is left behind');
    ok(of('goods_receipt_items') === 0, 'Cleanup: no receipt item this run created is left behind');
    ok(of('purchase_orders') === 0, 'Cleanup: no purchase order this run created is left behind');
    ok(of('purchase_requests') === 0, 'Cleanup: no purchase request this run created is left behind');
    ok(left.length === 0, `Ownership: all ${own.size()} documents this run created are re-read and gone`,
      left.slice(0, 6).join(', '));
  }
  const strayProd = (await db.collection('inventory_products').get()).docs.filter(d => /^PHASE-F-/i.test(String(d.data().sku || '')));
  ok(strayProd.length === 0, 'Cleanup: no synthetic test products left behind', `found ${strayProd.length}`);

  // The ledger is append-only: the ONLY movements removed are those belonging
  // to this run's synthetic products, which were deleted with them.
  const movesNow = new Set((await db.collection('inventory_stock_movements').get()).docs.map(d => d.id));
  const leftoverTestMoves = own.list('inventory_stock_movements').filter(id => movesNow.has(id));
  ok(leftoverTestMoves.length === 0, 'Cleanup: every test stock movement removed with its synthetic product',
    `found ${leftoverTestMoves.length}`);
  // The ledger is append-only, so every row that existed before must still
  // exist. A row ADDED during the run by someone using DEV is not a failure.
  const lostLedger = [...persistentMovementIds].filter(id => !movesNow.has(id));
  ok(lostLedger.length === 0, 'Cleanup: every pre-existing ledger row is still present',
    lostLedger.slice(0, 4).join(', '));
  {
    const { removed, added } = censusDiff(censusBefore, await census(db));
    ok(removed.length === 0, 'Ownership: no pre-existing DEV document was deleted by this run',
      removed.slice(0, 6).join(', '));
    if (added.length) console.log(`  [note] ${added.length} document(s) appeared during the run and were left alone: ${added.slice(0, 4).join(', ')}`);
  }

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
