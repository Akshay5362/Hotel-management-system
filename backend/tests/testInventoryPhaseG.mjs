/**
 * backend/tests/testInventoryPhaseG.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration test for HPMS Inventory Phase G — GOODS RECEIPT REVERSAL and
 * PURCHASE ORDER SHORT CLOSE. DEV Firestore (sky5-development) ONLY, behind
 * the same four-layer fail-closed guard used by Phases A–F.
 *
 * ── CLEANUP STRATEGY ────────────────────────────────────────────────────────
 * Identical to Phase F, and for the same reason: the stock ledger is
 * append-only, so "undoing" test movements with compensating entries would be
 * faking cleanup — and in THIS phase a compensating entry is the very thing
 * under test, which would make the cleanup indistinguishable from the feature.
 * Instead the suite works exclusively on ISOLATED SYNTHETIC PRODUCTS created
 * for the run; every movement it causes belongs to a product deleted at the
 * end together with its ledger rows. Persistent seed products are snapshotted
 * at the start and asserted byte-identical at the end.
 *
 * Role authorization is exercised through the REAL requireRole middleware with
 * strict RBAC forced on, so a 403 here is the same 403 the route returns.
 * Unauthenticated 401s are verified over real HTTP.
 *
 * Run: cross-env HPMS_ENV=development node backend/tests/testInventoryPhaseG.mjs
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
const { ReceiptCorrectionService } = await import('../services/receiptCorrectionService.js');
const { GoodsReceiptService } = await import('../services/goodsReceiptService.js');
const { PurchaseOrderService } = await import('../services/purchaseOrderService.js');
const { PurchaseRequestService } = await import('../services/purchaseRequestService.js');
const { PurchaseRequestApprovalService } = await import('../services/purchaseRequestApprovalService.js');
const { InventoryCutoverService } = await import('../services/inventoryCutoverService.js');
const InventoryStockService = (await import('../services/inventoryStockService.js')).default;
const { reverseGoodsReceipt, closePurchaseOrderShort } = await import('../controllers/receiptCorrectionController.js');
const { requireRole } = await import('../controllers/authController.js');
const {
  getGoodsReceiptsForOrderFirestore, getGoodsReceiptByIdFirestore, getGoodsReceiptItemsFirestore
} = await import('../repositories/firestore/goodsReceiptsRepository.js');
const {
  REVERSALS_COLLECTION, reversalIdForKey,
  getGoodsReceiptReversalByIdFirestore, getReversalForReceiptFirestore, getReversalsForOrderFirestore
} = await import('../repositories/firestore/goodsReceiptReversalsRepository.js');
const {
  deletePurchaseOrderCascadeFirestore, getPurchaseOrderByIdFirestore, getPurchaseOrderItemsFirestore
} = await import('../repositories/firestore/purchaseOrdersRepository.js');
const { deletePurchaseRequestCascadeFirestore } = await import('../repositories/firestore/purchaseRequestsRepository.js');
const { deleteInventoryProductFirestore } = await import('../repositories/firestore/inventoryProductsRepository.js');
const { createInventorySupplierFirestore } = await import('../repositories/firestore/inventorySuppliersRepository.js');
const { getAllInventoryLocationsFirestore } = await import('../repositories/firestore/inventoryLocationsRepository.js');
const { updateInventoryApprovalConfigFirestore } = await import('../repositories/firestore/inventoryApprovalConfigRepository.js');
const {
  PO_STATUS, PO_TRANSITIONS, REVERSAL_ROLES, SHORT_CLOSE_ROLES, RECEIVING_ROLES,
  MOVEMENT_TYPES, VARIANCE_TYPE
} = await import('../utils/inventoryConstants.js');

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

/** Runs the REAL requireRole middleware and reports what it decided. */
function runGuard(roles, user) {
  const { req, res } = makeCtx({ user });
  let passed = false;
  requireRole(...roles)(req, res, () => { passed = true; });
  return { allowed: passed, status: passed ? 200 : res.statusCode, code: res.payload?.code || null };
}

const admin        = { uid: `phasegtest_admin_${RUN_ID}`,   role: 'ADMIN',        type: 'staff', full_name: 'Phase G Admin', email: 'phaseg.admin@dev.local' };
const superAdmin   = { uid: `phasegtest_super_${RUN_ID}`,   role: 'SUPER_ADMIN',  type: 'staff', full_name: 'Phase G Super Admin' };
const receptionist = { uid: `phasegtest_recep_${RUN_ID}`,   role: 'RECEPTIONIST', type: 'staff', full_name: 'Phase G Receptionist' };
const kitchen      = { uid: `phasegtest_kitchen_${RUN_ID}`, role: 'CHEF',         type: 'staff', full_name: 'Phase G Chef' };
const svcActor = (u, role) => ({ uid: u.uid, name: u.full_name, role, email: u.email || null });

async function main() {
  console.log('═'.repeat(78));
  console.log('  INVENTORY PHASE G — RECEIPT REVERSAL + PO SHORT CLOSE  (DEV)');
  console.log(`  run id: ${RUN_ID}`);
  console.log('═'.repeat(78));

  const cleanup = [];
  await updateInventoryApprovalConfigFirestore({ enabled: true, allowed_roles: ['admin', 'super_admin'] });

  // Snapshot the PERSISTENT products — they must be untouched at the end.
  const persistentBefore = {};
  for (const d of (await db.collection('inventory_products').get()).docs) {
    const x = d.data();
    persistentBefore[d.id] = `${x.current_stock}|${x.stock_quantity}|${JSON.stringify(x.stock_by_location || {})}`;
  }
  const persistentMovementIds = new Set((await db.collection('inventory_stock_movements').get()).docs.map(d => d.id));

  // ── fixtures ────────────────────────────────────────────────────────────
  console.log('\n── Fixtures ──────────────────────────────────────────────────────────────────');
  const { categories } = await InventoryCutoverService.getCategories();
  const locations = await getAllInventoryLocationsFirestore({ includeInactive: false });
  const location = locations.find(l => l.is_active !== false);

  const supplier = await createInventorySupplierFirestore({
    name: `PHASE_G_TEST Supplier ${RUN_ID}`, phone: '9000000044', created_by: admin.uid
  });
  cleanup.push(() => db.collection('inventory_suppliers').doc(supplier.id).delete());

  const testProductIds = [];
  async function makeProduct(suffix, cost = 20) {
    const sku = `PHASE-G-${suffix}-${RUN_ID}`;
    const { product } = await InventoryCutoverService.createProduct({
      sku, name: `PHASE_G_TEST ${suffix} ${RUN_ID}`, category_id: categories[0].id,
      unit_of_measure: 'KG', minimum_stock_level: 1, cost_price: cost,
      default_supplier_id: supplier.id, opening_stock: 5, opening_location_id: location.id
    }, { uid: admin.uid, name: admin.full_name });
    testProductIds.push(product.id);
    return product;
  }
  cleanup.push(async () => {
    for (const pid of testProductIds) {
      const movs = await db.collection('inventory_stock_movements').where('product_id', '==', pid).get();
      for (const d of movs.docs) await d.ref.delete();
      await deleteInventoryProductFirestore(pid).catch(() => {});
    }
  });

  async function issuedPO(lines) {
    const created = await PurchaseRequestService.createDraft({
      location_id: location.id, department: 'KITCHEN', reason: 'Phase G', items: lines
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
  const reversalCount = () => countOf(db.collection(REVERSALS_COLLECTION));
  const reversalMovementCount = () =>
    countOf(db.collection('inventory_stock_movements').where('movement_type', '==', 'REVERSAL'));

  // ── Byte-level immutability helpers ──────────────────────────────────────
  // Serialising the raw document data (keys sorted) turns "unchanged" into an
  // exact string comparison: a single added field, or a rewritten timestamp,
  // fails. This is what proves the receipt is untouched rather than merely
  // "quantities untouched".
  const stable = (obj) => JSON.stringify(obj, Object.keys(obj || {}).sort());
  const snapshotReceipt = async (receiptId) => {
    const doc = await db.collection('goods_receipts').doc(receiptId).get();
    const items = await db.collection('goods_receipt_items').where('receipt_id', '==', receiptId).orderBy('line_no').get();
    return {
      header: doc.exists ? stable(doc.data()) : null,
      items: items.docs.map(d => stable(d.data())).join('|')
    };
  };
  const snapshotMovement = async (movementId) => {
    const d = await db.collection('inventory_stock_movements').doc(movementId).get();
    return d.exists ? stable(d.data()) : null;
  };
  /** Authoritative "was this receipt reversed?" — the RECORD, never a flag. */
  const reversalOf = (receiptId) => getReversalForReceiptFirestore(receiptId);
  const receiptCount = () => countOf(db.collection('goods_receipts'));
  const receive = (poId, key, lines, actor = svcActor(admin, 'admin')) =>
    GoodsReceiptService.receive(poId, { idempotency_key: key, lines }, actor);

  ok(!!location && !!categories.length, 'Fixtures resolved (persistent DEV master data reused, never modified)');

  // ══════════════════════════════════════════════════════════════════════════
  // 17/18/19/25/26/27 — AUTHORIZATION
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Authorization ─────────────────────────────────────────────────────────────');
  {
    const r = await fetch(`${API_BASE}/inventory/purchase-orders/po_x/receipts/gr_x/reverse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'k', reason: 'test' })
    });
    ok(r.status === 401, 'Unauthenticated reversal -> 401', `got ${r.status}`);
    const c = await fetch(`${API_BASE}/inventory/purchase-orders/po_x/close-short`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test' })
    });
    ok(c.status === 401, 'Unauthenticated short close -> 401', `got ${c.status}`);

    ok(REVERSAL_ROLES.includes('admin') && REVERSAL_ROLES.includes('super_admin'),
      'Reversal roles are admin and super_admin', REVERSAL_ROLES.join(','));
    ok(!REVERSAL_ROLES.includes('receptionist'),
      '17. receptionist is NOT a reversal role, even though they may receive');
    ok(RECEIVING_ROLES.includes('receptionist'),
      '17. …and receiving still admits receptionist (Phase F unchanged)');
    ok(!SHORT_CLOSE_ROLES.includes('receptionist'), '25. receptionist is NOT a short-close role');
    ok(!REVERSAL_ROLES.includes('kitchen') && !REVERSAL_ROLES.includes('housekeeper'),
      'Kitchen and housekeeper cannot reverse');

    // The REAL middleware, with strict RBAC forced on.
    const prevStrict = process.env.ENABLE_STRICT_RBAC;
    process.env.ENABLE_STRICT_RBAC = 'true';
    const gRecep = runGuard(REVERSAL_ROLES, receptionist);
    ok(!gRecep.allowed && gRecep.status === 403 && gRecep.code === 'INSUFFICIENT_ROLE_PRIVILEGES',
      '17. requireRole returns a real 403 for a receptionist reversal', `status=${gRecep.status}`);
    ok(runGuard(REVERSAL_ROLES, admin).allowed, '18. requireRole admits an admin reversal');
    ok(runGuard(REVERSAL_ROLES, superAdmin).allowed, '19. requireRole admits a super-admin reversal');
    const sRecep = runGuard(SHORT_CLOSE_ROLES, receptionist);
    ok(!sRecep.allowed && sRecep.status === 403,
      '25. requireRole returns a real 403 for a receptionist short close', `status=${sRecep.status}`);
    ok(runGuard(SHORT_CLOSE_ROLES, admin).allowed, '26. requireRole admits an admin short close');
    ok(runGuard(SHORT_CLOSE_ROLES, superAdmin).allowed, '27. requireRole admits a super-admin short close');
    ok(!runGuard(REVERSAL_ROLES, kitchen).allowed, 'requireRole refuses a kitchen reversal');
    if (prevStrict === undefined) delete process.env.ENABLE_STRICT_RBAC;
    else process.env.ENABLE_STRICT_RBAC = prevStrict;

    const routes = (await import('fs')).readFileSync(new URL('../routes/inventoryRoutes.js', import.meta.url), 'utf8');
    const revLine = routes.split('\n').filter(l => l.includes('/reverse'));
    const csLine = routes.split('\n').filter(l => l.includes('/close-short'));
    ok(revLine.length === 1 && revLine[0].includes('REVERSE'),
      'The reverse route is REVERSE-guarded, not RECEIVE-guarded', revLine[0]?.trim());
    ok(csLine.length === 1 && csLine[0].includes('SHORT_CLOSE'),
      'The close-short route is SHORT_CLOSE-guarded', csLine[0]?.trim());
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1–6 — FULL RECEIPT REVERSAL
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Full receipt reversal ─────────────────────────────────────────────────────');
  let reversedOnce = null;
  {
    const prod = await makeProduct('FULL', 20);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 10 }]);
    const item = po.items[0];
    const stockBefore = await stockOf(prod.id);

    const rec = await receive(po.id, `g_full_${RUN_ID}`, [{ po_item_id: item.id, received_quantity: 10 }]);
    ok(rec.order.status === PO_STATUS.RECEIVED, 'Setup: an exact receipt makes the PO RECEIVED', rec.order.status);
    ok(await stockOf(prod.id) === stockBefore + 10, 'Setup: stock rose by 10');
    const movesAfterReceipt = await movementCount();

    // Byte-exact snapshots taken BEFORE the reversal.
    const beforeReceipt = await snapshotReceipt(rec.receipt.receipt_id);
    const originalMovementId = (await getGoodsReceiptItemsFirestore(rec.receipt.receipt_id))[0].stock_movement_id;
    const beforeMovement = await snapshotMovement(originalMovementId);

    const rev = await ReceiptCorrectionService.reverseReceipt(po.id, rec.receipt.receipt_id, {
      idempotency_key: `g_rev_full_${RUN_ID}`, reason: 'Wrong quantity entered'
    }, svcActor(admin, 'admin'));
    reversedOnce = { po, prod, receipt: rec.receipt, reversal: rev.reversal };

    ok(rev.duplicate === false, '1. A full receipt can be reversed');
    ok(rev.reversal.status === 'POSTED' && rev.reversal.receipt_id === rec.receipt.receipt_id,
      '1. The reversal record names the receipt it cancelled', rev.reversal.receipt_id);
    ok(await stockOf(prod.id) === stockBefore,
      '5. Stock returned to exactly its pre-receipt level', `${stockBefore} -> ${await stockOf(prod.id)}`);
    ok(rev.order.status === PO_STATUS.ISSUED,
      '6. The PO reopened to ISSUED because nothing is effectively received', rev.order.status);

    // ── 2 / R1 / R2 / R3. TRUE immutability, compared byte-for-byte ──────
    const afterReceipt = await snapshotReceipt(rec.receipt.receipt_id);
    ok(afterReceipt.header === beforeReceipt.header,
      'R1. The goods_receipts document is BYTE-IDENTICAL before and after the reversal');
    ok(afterReceipt.items === beforeReceipt.items,
      'R2. Every goods_receipt_items document is BYTE-IDENTICAL before and after');
    ok(await snapshotMovement(originalMovementId) === beforeMovement,
      'R3. The original RECEIPT stock movement is BYTE-IDENTICAL before and after');

    const receiptNow = await getGoodsReceiptByIdFirestore(rec.receipt.receipt_id);
    const linesNow = await getGoodsReceiptItemsFirestore(rec.receipt.receipt_id);
    ok(receiptNow.total_received_quantity === 10 && linesNow[0].received_quantity === 10,
      '2. The original receipt still records the 10 that were signed for',
      `total=${receiptNow.total_received_quantity}, line=${linesNow[0].received_quantity}`);
    ok(receiptNow.receipt_number === rec.receipt.receipt_number && receiptNow.receipt_status === 'POSTED',
      '2. Its GR number and posted status are unchanged');
    // The receipt must carry NO reversal information whatsoever.
    ok(receiptNow.reversed === undefined && receiptNow.reversed_at === undefined &&
       receiptNow.reversed_by_uid === undefined && receiptNow.reversed_by_name === undefined &&
       receiptNow.reversal_id === undefined && receiptNow.reversal_reason === undefined,
      'R1. No reversal marker of any kind was written onto the receipt',
      Object.keys(receiptNow).filter(k => /revers/i.test(k)).join(',') || 'none');

    // ── R4. The reversal RECORD is the single source of truth ────────────
    const recordFor = await reversalOf(rec.receipt.receipt_id);
    ok(!!recordFor, 'R4. A reversal record exists and is found BY receipt_id');
    ok(recordFor.reversal_id === rev.reversal.reversal_id, 'R4. It is the record this call created');
    ok(recordFor.reason === 'Wrong quantity entered' && !!recordFor.reversed_by_name &&
       (!!recordFor.reversed_at || !!recordFor.created_at),
      'Q. Reason, actor and timestamp live on the RECORD, not the receipt',
      `by=${recordFor.reversed_by_name}`);
    ok(recordFor.receipt_number === rec.receipt.receipt_number && !!recordFor.purchase_order_number,
      'Q. The record carries the receipt and PO numbers needed to render history');

    // ── R6. Delivery history derives REVERSED from the record ────────────
    const history1 = await GoodsReceiptService.listForOrder(po.id);
    const shown = history1.receipts.find(r => r.id === rec.receipt.receipt_id);
    ok(shown && shown.is_reversed === true && shown.reversal &&
       shown.reversal.reason === 'Wrong quantity entered',
      'R6. The delivery-history view joins the reversal record onto the receipt');
    ok(shown && shown.total_received_quantity === 10,
      'R6. …while still showing the quantity the receipt actually recorded');

    // 3/4. Compensating movement
    ok(await movementCount() === movesAfterReceipt + 1, '3. Exactly ONE compensating movement was created');
    ok(rev.reversal.stock_movement_ids.length === 1, '3. The reversal names its compensating movement');
    const mov = (await db.collection('inventory_stock_movements').doc(rev.reversal.stock_movement_ids[0]).get()).data();
    ok(mov.movement_type === 'REVERSAL', '3. Movement type is REVERSAL', mov.movement_type);
    ok(MOVEMENT_TYPES.REVERSAL.sign === -1 && mov.qty_after === mov.qty_before - 10,
      '3. The compensating movement subtracts exactly the received quantity',
      `${mov.qty_before} -> ${mov.qty_after}`);
    ok(mov.reference_type === 'GOODS_RECEIPT' && mov.reference_id === rec.receipt.receipt_id,
      '4. The movement links back to the original goods receipt', `${mov.reference_type}/${mov.reference_id}`);
    ok(String(mov.reason).includes(rec.receipt.receipt_number), '4. The movement reason names the reversed GR number');

    // G. Original RECEIPT movement untouched (append-only ledger)
    const origMovId = linesNow[0].stock_movement_id;
    const origMov = await db.collection('inventory_stock_movements').doc(origMovId).get();
    ok(origMov.exists && origMov.data().movement_type === 'RECEIPT' && origMov.data().quantity === 10,
      'G. The original RECEIPT movement is neither deleted nor edited');

    // PO lines recomputed
    const poItems = await getPurchaseOrderItemsFirestore(po.id);
    ok(poItems[0].received_quantity === 0 && poItems[0].outstanding_quantity === 10,
      '6. The PO line shows 0 received and the full 10 outstanding again',
      `received=${poItems[0].received_quantity}`);
    const hist = (await getPurchaseOrderByIdFirestore(po.id)).status_history.map(h => h.status);
    ok(hist.includes(PO_STATUS.RECEIVED) && hist[hist.length - 1] === PO_STATUS.ISSUED,
      '6. Status history keeps RECEIVED and records the reopen', hist.join(' → '));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7/8/33/34 — MULTIPLE RECEIPTS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Multiple receipts ─────────────────────────────────────────────────────────');
  {
    const prod = await makeProduct('MULTI', 15);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 10 }]);
    const item = po.items[0];
    const base = await stockOf(prod.id);

    const a = await receive(po.id, `g_m_a_${RUN_ID}`, [{ po_item_id: item.id, received_quantity: 3 }]);
    const b = await receive(po.id, `g_m_b_${RUN_ID}`, [{ po_item_id: item.id, received_quantity: 4 }]);
    const c = await receive(po.id, `g_m_c_${RUN_ID}`, [{ po_item_id: item.id, received_quantity: 3 }]);
    ok(c.order.status === PO_STATUS.RECEIVED && await stockOf(prod.id) === base + 10,
      'Setup: three receipts (3+4+3) fully satisfy the order');

    // 7/33. Reverse the MIDDLE receipt
    const revB = await ReceiptCorrectionService.reverseReceipt(po.id, b.receipt.receipt_id, {
      idempotency_key: `g_rev_b_${RUN_ID}`, reason: 'Duplicate receipt'
    }, svcActor(admin, 'admin'));
    ok(revB.order.status === PO_STATUS.PARTIALLY_RECEIVED,
      '7/33. Reversing one of three receipts leaves the PO PARTIALLY_RECEIVED', revB.order.status);
    ok(await stockOf(prod.id) === base + 6, '7. Stock is 3 + 3 = 6, not 10', `${base} -> ${await stockOf(prod.id)}`);
    const items1 = await getPurchaseOrderItemsFirestore(po.id);
    ok(items1[0].received_quantity === 6 && items1[0].outstanding_quantity === 4,
      '33. Effective received is derived as 6 with 4 outstanding', `received=${items1[0].received_quantity}`);

    // 33. Surviving receipts untouched
    const aNow = await getGoodsReceiptByIdFirestore(a.receipt.receipt_id);
    const cNow = await getGoodsReceiptByIdFirestore(c.receipt.receipt_id);
    ok(!(await reversalOf(a.receipt.receipt_id)) && !(await reversalOf(c.receipt.receipt_id)),
      '33/R7. Receipts A and C have NO reversal record, so they still count');
    ok(aNow.total_received_quantity === 3 && cNow.total_received_quantity === 3,
      '33. Receipts A and C keep their original quantities untouched');
    const aLines = await getGoodsReceiptItemsFirestore(a.receipt.receipt_id);
    ok(aLines[0].received_quantity === 3, '33. Receipt A line quantity is unchanged');

    // 34. Reverse the remaining two → effective 0 → ISSUED
    await ReceiptCorrectionService.reverseReceipt(po.id, a.receipt.receipt_id, {
      idempotency_key: `g_rev_a_${RUN_ID}`, reason: 'Wrong supplier delivery'
    }, svcActor(superAdmin, 'super_admin'));
    const revC = await ReceiptCorrectionService.reverseReceipt(po.id, c.receipt.receipt_id, {
      idempotency_key: `g_rev_c_${RUN_ID}`, reason: 'Wrong item received'
    }, svcActor(superAdmin, 'super_admin'));
    ok(revC.order.status === PO_STATUS.ISSUED,
      '8/34. Reversing the final surviving receipt reopens the PO as ISSUED', revC.order.status);
    ok(await stockOf(prod.id) === base, '8/34. Stock is back to the pre-delivery level',
      `${base} -> ${await stockOf(prod.id)}`);
    const items2 = await getPurchaseOrderItemsFirestore(po.id);
    ok(items2[0].received_quantity === 0 && items2[0].outstanding_quantity === 10,
      '34. Effective received falls to 0 and the whole order is outstanding again');
    ok(items2[0].received_quantity >= 0, 'B. Effective received quantity never goes negative');

    const allReceipts = await getGoodsReceiptsForOrderFirestore(po.id);
    ok(allReceipts.length === 3, 'Q. All three receipts remain in the delivery history', `${allReceipts.length}`);
    const shownAll = (await GoodsReceiptService.listForOrder(po.id)).receipts;
    ok(shownAll.length === 3 && shownAll.every(r => r.is_reversed === true && r.reversal),
      'Q/R6. Each is shown REVERSED purely from its joined reversal record');
    ok(allReceipts.every(r => r.reversed === undefined),
      'R1. …and not one of the three receipt documents was ever written to');
    const revs = await getReversalsForOrderFirestore(po.id);
    ok(revs.length === 3, 'Three reversal records exist, one per receipt', `${revs.length}`);

    // 19. super_admin reversal actually recorded as such
    ok(revs.some(r => r.reversed_by_uid === superAdmin.uid),
      '19. A super-admin reversal is recorded with the super-admin actor');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // OVER-RECEIPT REVERSAL — a RECEIVED order that stays RECEIVED
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Over-receipt reversal ─────────────────────────────────────────────────────');
  {
    const prod = await makeProduct('OVER', 18);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 10 }]);
    const item = po.items[0];
    const base = await stockOf(prod.id);

    // A = 5 of 10 → partial. B = 12 → cumulative 17, an OVER receipt that
    // Phase F accepts only with a variance reason.
    const a = await receive(po.id, `g_o_a_${RUN_ID}`, [{ po_item_id: item.id, received_quantity: 5 }]);
    ok(a.order.status === PO_STATUS.PARTIALLY_RECEIVED, 'O1. 5 of 10 leaves the order PARTIALLY_RECEIVED', a.order.status);

    await expectThrow(() => receive(po.id, `g_o_noreason_${RUN_ID}`, [{ po_item_id: item.id, received_quantity: 12 }]),
      'O2. An over-receipt without a variance reason is still refused (Phase F unchanged)', 'VARIANCE_REASON_REQUIRED');

    const b = await GoodsReceiptService.receive(po.id, {
      idempotency_key: `g_o_b_${RUN_ID}`,
      lines: [{ po_item_id: item.id, received_quantity: 12, variance_reason: 'Supplier shipped a full crate' }]
    }, svcActor(admin, 'admin'));
    ok(b.order.status === PO_STATUS.RECEIVED, 'O3. Cumulative 17 of 10 makes the order RECEIVED', b.order.status);
    ok(b.receipt.items[0].variance_type === VARIANCE_TYPE.OVER,
      'O3. The second receipt is recorded as an OVER variance', b.receipt.items[0].variance_type);
    ok(await stockOf(prod.id) === base + 17, 'O3. Stock rose by the full 17 accepted', `${base} -> ${await stockOf(prod.id)}`);

    const beforeB = await snapshotReceipt(b.receipt.receipt_id);
    const movesBefore = await movementCount();

    // Reverse A. B alone (12) still satisfies the ordered 10.
    const rev = await ReceiptCorrectionService.reverseReceipt(po.id, a.receipt.receipt_id, {
      idempotency_key: `g_o_rev_${RUN_ID}`, reason: 'Receipt A was entered against the wrong order'
    }, svcActor(admin, 'admin'));

    ok(rev.order.status === PO_STATUS.RECEIVED,
      'O4. The order REMAINS RECEIVED — the surviving over-receipt still satisfies it', rev.order.status);
    ok(await movementCount() === movesBefore + 1, 'O5. Exactly one compensating movement was created');
    ok(await stockOf(prod.id) === base + 12,
      'O6. Stock fell by exactly the 5 that A recorded, not by 17', `${base + 17} -> ${await stockOf(prod.id)}`);

    const itemsNow = await getPurchaseOrderItemsFirestore(po.id);
    ok(itemsNow[0].received_quantity === 12,
      'O7. Effective received is 12 — receipt B is still fully counted', `${itemsNow[0].received_quantity}`);
    ok(itemsNow[0].outstanding_quantity === 0 && itemsNow[0].variance_type === VARIANCE_TYPE.OVER,
      'O7. Nothing is outstanding and the surviving over-delivery is still an OVER variance',
      `${itemsNow[0].variance_type}`);

    ok((await snapshotReceipt(b.receipt.receipt_id)).header === beforeB.header,
      'O8. Receipt B is BYTE-IDENTICAL — reversing A did not touch it');
    ok((await snapshotReceipt(b.receipt.receipt_id)).items === beforeB.items,
      'O8. Receipt B line items are BYTE-IDENTICAL too');
    ok(!(await reversalOf(b.receipt.receipt_id)) && !!(await reversalOf(a.receipt.receipt_id)),
      'O9. Only receipt A has a reversal record');

    // The status must equal what the effective quantities imply — asserted
    // against the quantities themselves, not against a transition table.
    const ordered = Number(itemsNow[0].ordered_quantity);
    const effective = Number(itemsNow[0].received_quantity);
    ok(rev.order.status === (effective >= ordered ? PO_STATUS.RECEIVED
        : effective > 0 ? PO_STATUS.PARTIALLY_RECEIVED : PO_STATUS.ISSUED),
      'O10. The resulting status equals what the effective quantities imply',
      `ordered=${ordered} effective=${effective} status=${rev.order.status}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9/10/11/12 — IDEMPOTENCY
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Idempotency ───────────────────────────────────────────────────────────────');
  {
    const prod = await makeProduct('IDEM', 12);
    // Ordered 10, delivered in two parts, so BOTH receipts exist and the order
    // stays receivable — the second one is what proves a reused key is caught.
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 10 }]);
    const item = po.items[0];
    const rec = await receive(po.id, `g_i_r_${RUN_ID}`, [{ po_item_id: item.id, received_quantity: 6 }]);
    const rec2 = await receive(po.id, `g_i_r2_${RUN_ID}`, [{ po_item_id: item.id, received_quantity: 1 }]);
    ok(rec2.order.status === PO_STATUS.PARTIALLY_RECEIVED, 'Setup: two receipts (6 + 1 of 10) leave the order partial');

    const key = `g_i_rev_${RUN_ID}`;
    const first = await ReceiptCorrectionService.reverseReceipt(po.id, rec.receipt.receipt_id, {
      idempotency_key: key, reason: 'Data entry correction'
    }, svcActor(admin, 'admin'));
    const stockAfterFirst = await stockOf(prod.id);
    const movesAfterFirst = await movementCount();
    const revsAfterFirst = await reversalCount();
    const statusAfterFirst = first.order.status;

    // 10. Same key + same payload
    const second = await ReceiptCorrectionService.reverseReceipt(po.id, rec.receipt.receipt_id, {
      idempotency_key: key, reason: 'Data entry correction'
    }, svcActor(admin, 'admin'));
    ok(second.duplicate === true, '10. Same idempotency key + same payload returns the existing reversal');
    ok(second.reversal.reversal_id === first.reversal.reversal_id, '10. …with the same reversal id');
    ok(await stockOf(prod.id) === stockAfterFirst, '10. Stock was NOT reversed twice',
      `${stockAfterFirst} -> ${await stockOf(prod.id)}`);
    ok(await movementCount() === movesAfterFirst, '10. No second compensating movement');
    ok(await reversalCount() === revsAfterFirst, '10. No second reversal record');

    // 11. Same key + different payload (different receipt)
    await expectThrow(() => ReceiptCorrectionService.reverseReceipt(po.id, rec2.receipt.receipt_id, {
      idempotency_key: key, reason: 'Data entry correction'
    }, svcActor(admin, 'admin')), '11. Same key + a different receipt is rejected', 'IDEMPOTENCY_KEY_REUSE_CONFLICT');
    ok(await movementCount() === movesAfterFirst, '11. The rejected reuse created no movement');
    ok(!(await reversalOf(rec2.receipt.receipt_id)),
      '11. The other receipt gained no reversal record from the rejected reuse');

    // 9. Duplicate reversal of the same receipt under a NEW key
    await expectThrow(() => ReceiptCorrectionService.reverseReceipt(po.id, rec.receipt.receipt_id, {
      idempotency_key: `g_i_rev2_${RUN_ID}`, reason: 'Trying again'
    }, svcActor(admin, 'admin')), '9. A receipt can only be reversed once', 'RECEIPT_ALREADY_REVERSED');
    ok(await movementCount() === movesAfterFirst, '9. The duplicate reversal created no stock movement');
    ok(await reversalCount() === revsAfterFirst, '9. The duplicate reversal created no reversal record');
    ok((await getPurchaseOrderByIdFirestore(po.id)).status === statusAfterFirst,
      '9. The duplicate reversal did not change the PO', statusAfterFirst);
    ok(!(await getGoodsReceiptReversalByIdFirestore(reversalIdForKey(`g_i_rev2_${RUN_ID}`))),
      '9. No reversal document exists for the rejected key');

    // 12. Concurrent identical reversals
    const prodC = await makeProduct('CONC', 12);
    const poC = await issuedPO([{ product_id: prodC.id, requested_quantity: 4 }]);
    const recC = await receive(poC.id, `g_c_r_${RUN_ID}`, [{ po_item_id: poC.items[0].id, received_quantity: 4 }]);
    const stockBeforeC = await stockOf(prodC.id);
    const movesBeforeC = await movementCount();
    const ckey = `g_c_rev_${RUN_ID}`;
    const settled = await Promise.allSettled([
      ReceiptCorrectionService.reverseReceipt(poC.id, recC.receipt.receipt_id, { idempotency_key: ckey, reason: 'Concurrent A' }, svcActor(admin, 'admin')),
      ReceiptCorrectionService.reverseReceipt(poC.id, recC.receipt.receipt_id, { idempotency_key: ckey, reason: 'Concurrent B' }, svcActor(admin, 'admin')),
      ReceiptCorrectionService.reverseReceipt(poC.id, recC.receipt.receipt_id, { idempotency_key: ckey, reason: 'Concurrent C' }, svcActor(admin, 'admin'))
    ]);
    const fulfilled = settled.filter(s => s.status === 'fulfilled');
    ok(fulfilled.length >= 1, '12. At least one concurrent reversal succeeded', `${fulfilled.length}/3 fulfilled`);
    ok(fulfilled.filter(s => s.value.duplicate === false).length === 1,
      '12. Exactly ONE concurrent call actually performed the reversal',
      `${fulfilled.filter(s => s.value.duplicate === false).length} non-duplicate`);
    ok(await movementCount() === movesBeforeC + 1, '12. Exactly one compensating movement across all three calls');
    ok(await stockOf(prodC.id) === stockBeforeC - 4, '12. Stock was reversed exactly once',
      `${stockBeforeC} -> ${await stockOf(prodC.id)}`);
    const cRevs = await getReversalsForOrderFirestore(poC.id);
    ok(cRevs.length === 1, '12. Exactly one reversal record exists', `${cRevs.length}`);
    ok((await getPurchaseOrderByIdFirestore(poC.id)).status === PO_STATUS.ISSUED,
      '12. Exactly one PO recalculation — the order reopened once');

    // 12b. Concurrent reversal under THREE DIFFERENT keys. This is the race the
    // removal of the receipt flag actually affects: "already reversed" is now a
    // query, not a field. Exactly one must win.
    const prodD = await makeProduct('RACE', 12);
    const poD = await issuedPO([{ product_id: prodD.id, requested_quantity: 4 }]);
    const recD = await receive(poD.id, `g_race_r_${RUN_ID}`, [{ po_item_id: poD.items[0].id, received_quantity: 4 }]);
    const stockBeforeD = await stockOf(prodD.id);
    const movesBeforeD = await movementCount();
    const beforeD = await snapshotReceipt(recD.receipt.receipt_id);

    const raced = await Promise.allSettled([
      ReceiptCorrectionService.reverseReceipt(poD.id, recD.receipt.receipt_id, { idempotency_key: `g_race_k1_${RUN_ID}`, reason: 'Race key one' }, svcActor(admin, 'admin')),
      ReceiptCorrectionService.reverseReceipt(poD.id, recD.receipt.receipt_id, { idempotency_key: `g_race_k2_${RUN_ID}`, reason: 'Race key two' }, svcActor(superAdmin, 'super_admin')),
      ReceiptCorrectionService.reverseReceipt(poD.id, recD.receipt.receipt_id, { idempotency_key: `g_race_k3_${RUN_ID}`, reason: 'Race key three' }, svcActor(admin, 'admin'))
    ]);
    const won = raced.filter(r => r.status === 'fulfilled' && r.value.duplicate === false);
    const lost = raced.filter(r => r.status === 'rejected');
    ok(won.length === 1,
      '12b. Under three DIFFERENT keys, exactly ONE concurrent reversal succeeded', `${won.length} won`);
    ok(lost.length === 2 && lost.every(r => ['RECEIPT_ALREADY_REVERSED', 'REVERSAL_STATE_INCONSISTENT'].includes(r.reason?.code)),
      '12b. The losers were rejected deterministically, not silently accepted',
      lost.map(r => r.reason?.code).join(','));
    ok((await getReversalsForOrderFirestore(poD.id)).length === 1,
      '12b. Exactly one reversal record was written');
    ok(await movementCount() === movesBeforeD + 1,
      '12b. Exactly one compensating movement — stock was not reversed three times');
    ok(await stockOf(prodD.id) === stockBeforeD - 4,
      '12b. Stock fell by 4 exactly once', `${stockBeforeD} -> ${await stockOf(prodD.id)}`);
    const afterD = await snapshotReceipt(recD.receipt.receipt_id);
    ok(afterD.header === beforeD.header && afterD.items === beforeD.items,
      '12b/R1. The contended receipt is still BYTE-IDENTICAL');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 13/14/15/16 — VALIDATION
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Reversal validation ───────────────────────────────────────────────────────');
  {
    const prod = await makeProduct('VALID', 11);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 5 }]);
    const rec = await receive(po.id, `g_v_r_${RUN_ID}`, [{ po_item_id: po.items[0].id, received_quantity: 5 }]);
    // The second order exists only to prove a receipt cannot be reversed
    // against the wrong PO. It is created BEFORE the baseline because creating
    // a product posts its own OPENING movement, which has nothing to do with
    // any rejected reversal.
    const prod2 = await makeProduct('VALID2', 11);
    const po2 = await issuedPO([{ product_id: prod2.id, requested_quantity: 5 }]);

    const movesBefore = await movementCount();
    const revMovesBefore = await reversalMovementCount();
    const revsBefore = await reversalCount();

    // 13. Missing receipt
    const e13 = await expectThrow(() => ReceiptCorrectionService.reverseReceipt(po.id, `gr_missing_${RUN_ID}`, {
      idempotency_key: `g_v_missing_${RUN_ID}`, reason: 'Wrong quantity entered'
    }, svcActor(admin, 'admin')), '13. Reversing a receipt that does not exist is rejected', 'GOODS_RECEIPT_NOT_FOUND');
    ok(e13?.status === 404, '13. …with a 404', `status=${e13?.status}`);

    // 13b. Missing PO
    const e13b = await expectThrow(() => ReceiptCorrectionService.reverseReceipt(`po_missing_${RUN_ID}`, rec.receipt.receipt_id, {
      idempotency_key: `g_v_nopo_${RUN_ID}`, reason: 'Wrong quantity entered'
    }, svcActor(admin, 'admin')), '13. Reversing against a purchase order that does not exist is rejected', 'PURCHASE_ORDER_NOT_FOUND');
    ok(e13b?.status === 404, '13. …also a 404');

    // 14. Receipt that belongs to a DIFFERENT purchase order
    await expectThrow(() => ReceiptCorrectionService.reverseReceipt(po2.id, rec.receipt.receipt_id, {
      idempotency_key: `g_v_mismatch_${RUN_ID}`, reason: 'Wrong quantity entered'
    }, svcActor(admin, 'admin')), '14. A receipt cannot be reversed against another purchase order', 'RECEIPT_PO_MISMATCH');

    // 15/16. Reason
    await expectThrow(() => ReceiptCorrectionService.reverseReceipt(po.id, rec.receipt.receipt_id, {
      idempotency_key: `g_v_noreason_${RUN_ID}`
    }, svcActor(admin, 'admin')), '15. A reversal without a reason is rejected', 'CORRECTION_REASON_REQUIRED');
    await expectThrow(() => ReceiptCorrectionService.reverseReceipt(po.id, rec.receipt.receipt_id, {
      idempotency_key: `g_v_wsreason_${RUN_ID}`, reason: '      '
    }, svcActor(admin, 'admin')), '16. A whitespace-only reason is rejected', 'CORRECTION_REASON_REQUIRED');
    await expectThrow(() => ReceiptCorrectionService.reverseReceipt(po.id, rec.receipt.receipt_id, {
      idempotency_key: `g_v_shortreason_${RUN_ID}`, reason: 'x'
    }, svcActor(admin, 'admin')), '16. A one-character reason is rejected as meaningless', 'CORRECTION_REASON_REQUIRED');

    // Missing idempotency key
    await expectThrow(() => ReceiptCorrectionService.reverseReceipt(po.id, rec.receipt.receipt_id, {
      reason: 'Wrong quantity entered'
    }, svcActor(admin, 'admin')), 'M. A reversal without an idempotency key is rejected', 'IDEMPOTENCY_KEY_REQUIRED');

    // 35. Nothing was written by ANY of the rejected calls
    ok(await movementCount() === movesBefore, '35. No rejected reversal created a stock movement',
      `${movesBefore} -> ${await movementCount()}`);
    ok(await reversalMovementCount() === revMovesBefore, '35. No REVERSAL movement was posted by any rejected call');
    ok(await reversalCount() === revsBefore, '35. No rejected reversal created a reversal record');
    ok(!(await reversalOf(rec.receipt.receipt_id)),
      '35. No rejected reversal produced a reversal record for the receipt');
    ok((await getPurchaseOrderByIdFirestore(po.id)).status === PO_STATUS.RECEIVED,
      '35. No rejected reversal changed the purchase order status');
    ok(!(await getReversalForReceiptFirestore(rec.receipt.receipt_id)),
      '35. No orphan reversal record exists for the receipt');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 35 (hard case) — a reversal that fails MID-TRANSACTION leaves nothing
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Atomicity under a mid-transaction failure ─────────────────────────────────');
  {
    const prod = await makeProduct('DRAINED', 9);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 8 }]);
    const rec = await receive(po.id, `g_d_r_${RUN_ID}`, [{ po_item_id: po.items[0].id, received_quantity: 8 }]);

    // Consume everything, so reversing the receipt would drive stock negative.
    const all = await stockOf(prod.id);
    await InventoryStockService.applyMovement({
      product_id: prod.id, location_id: location.id, movement_type: 'CONSUMPTION',
      quantity: all, reason: 'Phase G atomicity fixture',
      actor_uid: admin.uid, actor_name: admin.full_name, idempotency_key: `g_d_drain_${RUN_ID}`
    });
    ok(await stockOf(prod.id) === 0, 'Setup: the product has been consumed down to zero');

    const movesBefore = await movementCount();
    const revsBefore = await reversalCount();
    await expectThrow(() => ReceiptCorrectionService.reverseReceipt(po.id, rec.receipt.receipt_id, {
      idempotency_key: `g_d_rev_${RUN_ID}`, reason: 'Wrong quantity entered'
    }, svcActor(admin, 'admin')), 'D. A reversal that would drive stock negative is rejected', 'INSUFFICIENT_STOCK');

    ok(await movementCount() === movesBefore, '35. The failed reversal left NO stock movement behind');
    ok(await reversalCount() === revsBefore, '35. The failed reversal left NO reversal record behind');
    ok(!(await reversalOf(rec.receipt.receipt_id)),
      '35. The failed reversal left NO reversal record for the receipt');
    ok((await getPurchaseOrderByIdFirestore(po.id)).status === PO_STATUS.RECEIVED,
      '35. The failed reversal did NOT recalculate the purchase order');
    const itemsNow = await getPurchaseOrderItemsFirestore(po.id);
    ok(itemsNow[0].received_quantity === 8,
      '35. The failed reversal did NOT rewrite the PO line', `received=${itemsNow[0].received_quantity}`);
    ok(await stockOf(prod.id) === 0, '35. Stock is unchanged after the failed reversal');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 20–24, 26–31 — SHORT CLOSE
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Short close ───────────────────────────────────────────────────────────────');
  let closedShort = null;
  {
    const prod = await makeProduct('SHORT', 25);
    const po = await issuedPO([{ product_id: prod.id, requested_quantity: 10 }]);
    const rec = await receive(po.id, `g_s_r_${RUN_ID}`, [{ po_item_id: po.items[0].id, received_quantity: 7 }]);
    ok(rec.order.status === PO_STATUS.PARTIALLY_RECEIVED, 'Setup: 7 of 10 received leaves the PO PARTIALLY_RECEIVED');

    const stockBefore = await stockOf(prod.id);
    const movesBefore = await movementCount();
    const receiptsBefore = await receiptCount();

    // 21. Reason required
    await expectThrow(() => ReceiptCorrectionService.closeShort(po.id, {}, svcActor(admin, 'admin')),
      '21. A short close without a reason is rejected', 'CORRECTION_REASON_REQUIRED');
    await expectThrow(() => ReceiptCorrectionService.closeShort(po.id, { reason: '   ' }, svcActor(admin, 'admin')),
      '21. A whitespace-only short-close reason is rejected', 'CORRECTION_REASON_REQUIRED');
    ok((await getPurchaseOrderByIdFirestore(po.id)).status === PO_STATUS.PARTIALLY_RECEIVED,
      '35. The rejected short close did not change the PO status');

    // 20/26. Admin short close
    const reason = 'Supplier confirmed remaining 3 KG unavailable';
    const res = await ReceiptCorrectionService.closeShort(po.id, { reason }, svcActor(admin, 'admin'));
    closedShort = { po, prod, receipt: rec.receipt };
    ok(res.duplicate === false && res.order.status === PO_STATUS.CLOSED_SHORT,
      '20/26. An admin can close a PARTIALLY_RECEIVED order short', res.order.status);
    ok(res.order.closed_short_outstanding_quantity === 3,
      '20. The written-off outstanding quantity is 3', `${res.order.closed_short_outstanding_quantity}`);
    ok(res.order.close_short_reason === reason, '21. The reason is stored on the order');
    ok(Array.isArray(res.order.closed_short_outstanding) && res.order.closed_short_outstanding[0].ordered_quantity === 10 &&
       res.order.closed_short_outstanding[0].received_quantity === 7,
      'J. The close snapshots ordered 10 / received 7 / outstanding 3');

    // 22/23. No stock, no receipt, no fabricated quantity
    ok(await stockOf(prod.id) === stockBefore, '22. Short close changed NO stock',
      `${stockBefore} -> ${await stockOf(prod.id)}`);
    ok(await movementCount() === movesBefore, '22. Short close created NO stock movement');
    ok(await receiptCount() === receiptsBefore, '23. Short close created NO goods receipt');
    const itemsNow = await getPurchaseOrderItemsFirestore(po.id);
    ok(itemsNow[0].received_quantity === 7 && itemsNow[0].outstanding_quantity === 3,
      'H. Received stays 7 and outstanding stays 3 — no quantity was fabricated');

    // J. Immutable status-history entry
    const poNow = await getPurchaseOrderByIdFirestore(po.id);
    const last = poNow.status_history[poNow.status_history.length - 1];
    ok(last.status === PO_STATUS.CLOSED_SHORT && last.reason === reason && last.by_uid === admin.uid && !!last.at,
      'J. Status history records the action, reason, actor and timestamp');
    ok(last.outstanding_quantity === 3, 'J. …and the outstanding quantity at the moment of closing');

    // 30. Duplicate short close
    const again = await ReceiptCorrectionService.closeShort(po.id, { reason: 'again' }, svcActor(admin, 'admin'));
    ok(again.duplicate === true, '30. A repeated short close is idempotent, not an error');
    const poAfter = await getPurchaseOrderByIdFirestore(po.id);
    ok(poAfter.status_history.filter(h => h.status === PO_STATUS.CLOSED_SHORT).length === 1,
      '30. Only ONE close entry exists in the status history');
    ok(poAfter.close_short_reason === reason, '30. The original reason was not overwritten by the retry');

    // 24. Audit
    const audits = await db.collection('audit_logs').where('action', '==', 'INVENTORY_PURCHASE_ORDER_CLOSED_SHORT').get();
    const mine = audits.docs.map(d => d.data()).filter(a => String(a.details || '').includes(po.po_number));
    ok(mine.length === 1, '24. Exactly one short-close audit entry was written', `${mine.length}`);
    if (mine.length) {
      const d = String(mine[0].details);
      ok(d.includes(reason) && d.includes('outstanding_quantity') && d.includes('supplier_id'),
        '24. The audit entry carries the reason, outstanding quantity and supplier');
      ok(mine[0].user_id === admin.uid, '24. The audit entry names the actor', mine[0].user_id);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 28/29 — INVALID SHORT-CLOSE TRANSITIONS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Invalid short-close transitions ───────────────────────────────────────────');
  {
    // 28. ISSUED (nothing received)
    const prodI = await makeProduct('ISSUED', 8);
    const poI = await issuedPO([{ product_id: prodI.id, requested_quantity: 5 }]);
    await expectThrow(() => ReceiptCorrectionService.closeShort(poI.id, { reason: 'nothing arrived at all' },
      svcActor(admin, 'admin')), '28. An ISSUED order cannot be closed short', 'PO_NOT_SHORT_CLOSEABLE');
    ok((await getPurchaseOrderByIdFirestore(poI.id)).status === PO_STATUS.ISSUED,
      '35. The rejected close left the ISSUED order untouched');

    // 29. RECEIVED (nothing outstanding)
    const prodR = await makeProduct('RECVD', 8);
    const poR = await issuedPO([{ product_id: prodR.id, requested_quantity: 5 }]);
    await receive(poR.id, `g_x_r_${RUN_ID}`, [{ po_item_id: poR.items[0].id, received_quantity: 5 }]);
    await expectThrow(() => ReceiptCorrectionService.closeShort(poR.id, { reason: 'nothing is outstanding' },
      svcActor(admin, 'admin')), '29. A fully RECEIVED order cannot be closed short', 'PO_NOT_SHORT_CLOSEABLE');
    ok((await getPurchaseOrderByIdFirestore(poR.id)).status === PO_STATUS.RECEIVED,
      '35. The rejected close left the RECEIVED order untouched');

    // 31. Concurrent short close
    const prodC = await makeProduct('SCONC', 8);
    const poC = await issuedPO([{ product_id: prodC.id, requested_quantity: 10 }]);
    await receive(poC.id, `g_sc_r_${RUN_ID}`, [{ po_item_id: poC.items[0].id, received_quantity: 4 }]);
    const movesBefore = await movementCount();
    const settled = await Promise.allSettled([
      ReceiptCorrectionService.closeShort(poC.id, { reason: 'concurrent close A' }, svcActor(admin, 'admin')),
      ReceiptCorrectionService.closeShort(poC.id, { reason: 'concurrent close B' }, svcActor(superAdmin, 'super_admin')),
      ReceiptCorrectionService.closeShort(poC.id, { reason: 'concurrent close C' }, svcActor(admin, 'admin'))
    ]);
    const done = settled.filter(s => s.status === 'fulfilled');
    ok(done.filter(s => s.value.duplicate === false).length === 1,
      '31. Exactly ONE concurrent short close took effect',
      `${done.filter(s => s.value.duplicate === false).length} effective, ${settled.length - done.length} rejected`);
    const poCNow = await getPurchaseOrderByIdFirestore(poC.id);
    ok(poCNow.status === PO_STATUS.CLOSED_SHORT, '31. The order ends CLOSED_SHORT', poCNow.status);
    ok(poCNow.status_history.filter(h => h.status === PO_STATUS.CLOSED_SHORT).length === 1,
      '31. Only one close entry in the status history');
    ok(await movementCount() === movesBefore, '31. Concurrent short closes created no stock movement');

    // 27. super_admin can short close (proven by the concurrent set or directly)
    const prodS = await makeProduct('SASHORT', 8);
    const poS = await issuedPO([{ product_id: prodS.id, requested_quantity: 6 }]);
    await receive(poS.id, `g_sa_r_${RUN_ID}`, [{ po_item_id: poS.items[0].id, received_quantity: 2 }]);
    const sres = await ReceiptCorrectionService.closeShort(poS.id, { reason: 'super admin closes the balance' },
      svcActor(superAdmin, 'super_admin'));
    ok(sres.order.status === PO_STATUS.CLOSED_SHORT && sres.order.closed_short_by_uid === superAdmin.uid,
      '27. A super-admin can close an order short and is recorded as the actor');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 32 — REVERSAL BLOCKED ON A CLOSED_SHORT ORDER
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── CLOSED_SHORT is final ─────────────────────────────────────────────────────');
  {
    const { po, prod, receipt } = closedShort;
    const stockBefore = await stockOf(prod.id);
    const movesBefore = await movementCount();
    const revsBefore = await reversalCount();

    const e = await expectThrow(() => ReceiptCorrectionService.reverseReceipt(po.id, receipt.receipt_id, {
      idempotency_key: `g_cs_rev_${RUN_ID}`, reason: 'trying to reverse a closed order'
    }, svcActor(admin, 'admin')), '32. A receipt on a CLOSED_SHORT order cannot be reversed', 'PURCHASE_ORDER_CLOSED_SHORT');
    ok(e?.status === 409, '32. …rejected as a 409 business conflict', `status=${e?.status}`);
    ok(String(e?.message || '').toLowerCase().includes('closed short'),
      '32. The error explains that the order was closed short', e?.message);

    ok(await stockOf(prod.id) === stockBefore, '32. The blocked reversal changed no stock');
    ok(await movementCount() === movesBefore, '32. The blocked reversal created no movement');
    ok(await reversalCount() === revsBefore, '32. The blocked reversal created no reversal record');
    ok(!(await reversalOf(receipt.receipt_id)),
      '32. The blocked reversal produced no reversal record');
    ok((await getPurchaseOrderByIdFirestore(po.id)).status === PO_STATUS.CLOSED_SHORT,
      '32. CLOSED_SHORT was not silently reopened');
    ok((PO_TRANSITIONS.CLOSED_SHORT || []).length === 0,
      'K. CLOSED_SHORT is terminal in the state machine — reopening is not implemented');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Reversal record completeness (spec section E) + reopened PO is receivable
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Reversal record & reopened order ──────────────────────────────────────────');
  {
    const r = await getGoodsReceiptReversalByIdFirestore(reversedOnce.reversal.reversal_id);
    ok(!!r, 'E. The reversal record is persisted');
    ok(!!r.reversed_by_uid && !!r.reversed_by_name, 'E. It proves WHO reversed', `${r.reversed_by_name}`);
    ok(r.receipt_id === reversedOnce.receipt.receipt_id && !!r.receipt_number, 'E. …WHAT receipt was reversed');
    ok(r.reason === 'Wrong quantity entered', 'E. …WHY it was reversed');
    ok(!!r.created_at && !!r.business_date, 'E. …WHEN it was reversed');
    ok(Array.isArray(r.stock_movement_ids) && r.stock_movement_ids.length === 1,
      'E. …and WHICH stock movement compensated it');
    ok(r.reversed_by_email === admin.email, 'E. The actor email is recorded when available', String(r.reversed_by_email));
    ok(r.purchase_order_id === reversedOnce.po.id && !!r.purchase_order_number, 'E. It names the purchase order');
    ok(r.payload_fingerprint && r.idempotency_key, 'M. It stores the idempotency key and payload fingerprint');

    // A reopened PO must be receivable again — Phase F is unchanged by Phase G.
    const items = await getPurchaseOrderItemsFirestore(reversedOnce.po.id);
    const stockBefore = await stockOf(reversedOnce.prod.id);
    const redo = await receive(reversedOnce.po.id, `g_redo_${RUN_ID}`, [{ po_item_id: items[0].id, received_quantity: 10 }]);
    ok(redo.order.status === PO_STATUS.RECEIVED,
      'B. A reopened purchase order can be received again and closes as RECEIVED', redo.order.status);
    ok(await stockOf(reversedOnce.prod.id) === stockBefore + 10,
      'B. The corrected delivery posts stock normally', `${stockBefore} -> ${await stockOf(reversedOnce.prod.id)}`);
    ok(redo.receipt.receipt_id !== reversedOnce.receipt.receipt_id,
      'B. The corrected delivery is a NEW receipt, not an edit of the reversed one');
    const history = await getGoodsReceiptsForOrderFirestore(reversedOnce.po.id);
    ok(history.length === 2, 'Q. Both the reversed receipt and its replacement appear in the history', `${history.length}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Controller layer
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Controller contract ───────────────────────────────────────────────────────');
  {
    const { req, res } = makeCtx({ user: admin, params: { id: 'po_x', receiptId: 'gr_x' }, body: { reason: 'no key given' } });
    await reverseGoodsReceipt(req, res);
    ok(res.statusCode === 400 && /idempotency_key/.test(JSON.stringify(res.payload)),
      'O. The reverse endpoint rejects a missing idempotency_key with 400');

    const c2 = makeCtx({ user: admin, params: { id: 'po_x', receiptId: 'gr_x' }, body: { idempotency_key: 'k' } });
    await reverseGoodsReceipt(c2.req, c2.res);
    ok(c2.res.statusCode === 400 && /reason/.test(JSON.stringify(c2.res.payload)),
      'F. The reverse endpoint rejects a missing reason with 400');

    const c3 = makeCtx({
      user: admin, params: { id: 'po_x', receiptId: 'gr_x' },
      body: { idempotency_key: 'k', reason: 'valid reason', lines: [{ po_item_id: 'x', quantity: 1 }] }
    });
    await reverseGoodsReceipt(c3.req, c3.res);
    ok(c3.res.statusCode === 400 && /Per-line/.test(JSON.stringify(c3.res.payload)),
      'A. Per-line reversal is explicitly refused — Phase G reverses whole receipts only');

    const c4 = makeCtx({ user: admin, params: { id: 'po_x' }, body: {} });
    await closePurchaseOrderShort(c4.req, c4.res);
    ok(c4.res.statusCode === 400 && c4.res.payload?.code === 'CORRECTION_REASON_REQUIRED',
      'O. The close-short endpoint rejects a missing reason with 400');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scope containment
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Scope containment ─────────────────────────────────────────────────────────');
  {
    const fs = await import('fs');
    const svc = fs.readFileSync(new URL('../services/receiptCorrectionService.js', import.meta.url), 'utf8');
    const badImports = svc.split('\n').filter(l => /^\s*import/.test(l) && /(payment|invoice|ledger|cash|food|housekeep|reservation|guest|whatsapp)/i.test(l));
    ok(badImports.length === 0, 'W. The correction service imports no payment/invoice/food/unrelated module', badImports.join(' | '));
    ok(svc.includes('stageMovementInTransaction'),
      'G. Reversal reuses the shared Phase F ledger core — no second stock system');
    ok(!/\.delete\(\)/.test(svc), 'A. The correction service never deletes a document');
    ok(!/received_quantity:\s*0[^.]/.test(svc.split('Rewrite each PO line')[0] || ''),
      'A. It never zeroes a receipt line quantity');

    const cols = (await db.listCollections()).map(c => c.id);
    ok(!cols.includes('payments') && !cols.includes('invoices'), 'W. No payment or invoice records were created');
    ok(!cols.includes('notifications'), 'W. No notification collection was created');

    const stock = fs.readFileSync(new URL('../services/inventoryStockService.js', import.meta.url), 'utf8');
    ok((stock.match(/db\.runTransaction/g) || []).length <= 2,
      'G. Phase G added no new transaction to the stock service');

    // Reversal stages ONE movement per receipt line from a product snapshot
    // taken before the write phase. That is sound only because a receipt can
    // never hold two lines for the same product: Phase F rejects it outright,
    // and a purchase request merges duplicate product lines long before a PO
    // exists. Pin the guarantee here so relaxing it fails loudly instead of
    // silently dropping a balance write inside the reversal transaction.
    const receiptSvc = fs.readFileSync(new URL('../services/goodsReceiptService.js', import.meta.url), 'utf8');
    ok(receiptSvc.includes('DUPLICATE_RECEIPT_PRODUCT'),
      'G. A receipt still cannot hold two lines for the same product — the reversal loop depends on it');
    const prSvc = fs.readFileSync(new URL('../services/purchaseRequestService.js', import.meta.url), 'utf8');
    ok(prSvc.includes('Deterministic merge of duplicate product lines'),
      'G. Purchase requests still merge duplicate product lines, so a PO line is unique per product');
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
  for (const col of [REVERSALS_COLLECTION, 'goods_receipts', 'goods_receipt_items']) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) await d.ref.delete();
  }
  for (const fn of cleanup) {
    try { await fn(); } catch (err) { console.warn(`  [cleanup warning] ${err.message}`); }
  }
  for (const col of ['purchase_orders', 'purchase_order_items', 'purchase_requests', 'purchase_request_items']) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) await d.ref.delete();
  }
  // Scoped by actor-uid prefix instead of scanning the whole audit_logs
  // collection. Every audit this suite writes carries one of its synthetic
  // `phasegtest_*` uids, so the range covers exactly the same documents the
  // filter below would have matched — the delete predicate is unchanged.
  const audits = await db.collection('audit_logs')
    .where('user_id', '>=', 'phasegtest_').where('user_id', '<', 'phasegtest_\uf8ff').get();
  for (const d of audits.docs) {
    const blob = String(d.data().user_id || '') + '|' + String(d.data().details || '');
    if (blob.includes('phasegtest_') || blob.includes(RUN_ID)) await d.ref.delete();
  }

  ok(await countOf(db.collection(REVERSALS_COLLECTION)) === 0, 'Cleanup: no reversal records left behind');
  ok(await countOf(db.collection('goods_receipts')) === 0, 'Cleanup: no goods receipts left behind');
  ok(await countOf(db.collection('goods_receipt_items')) === 0, 'Cleanup: no orphan receipt items left behind');
  ok(await countOf(db.collection('purchase_orders')) === 0, 'Cleanup: no purchase orders left behind');
  const strayProd = (await db.collection('inventory_products').get()).docs.filter(d => /^PHASE-G-/i.test(String(d.data().sku || '')));
  ok(strayProd.length === 0, 'Cleanup: no synthetic test products left behind', `found ${strayProd.length}`);

  const movesNow = (await db.collection('inventory_stock_movements').get()).docs;
  const leftoverTestMoves = movesNow.filter(d => !persistentMovementIds.has(d.id));
  ok(leftoverTestMoves.length === 0, 'Cleanup: every test stock movement removed with its synthetic product',
    `found ${leftoverTestMoves.length}`);
  ok(movesNow.length === persistentMovementIds.size, 'Cleanup: the persistent ledger is exactly as it was before the run',
    `${persistentMovementIds.size} -> ${movesNow.length}`);

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
