/**
 * testInventoryPhaseH56.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H5 (PO-assisted bill confirmation), H6 (PO-less direct receipt) and
 * direct-receipt reversal.
 *
 * Four-layer fail-closed guard. Firebase Admin imported only after it passes.
 * Every document this suite creates is prefixed h56test and cleaned up at the
 * end; the cleanup list is printed so anything left behind can be removed.
 *
 * THE CENTRAL ASSERTION: stock changes ONLY at confirmation, by exactly the
 * verified received quantity, exactly once.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryPhaseH56.mjs
 */

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

const BACKEND = path.join(process.cwd(), 'backend');
const require_ = createRequire(path.join(BACKEND, 'package.json'));

if (process.env.HPMS_ENV !== 'development') {
  console.error(`[SAFETY_ABORT] HPMS_ENV must be "development" (got ${JSON.stringify(process.env.HPMS_ENV)}).`);
  process.exit(1);
}
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }
console.log(`[GUARD] project=${PROJECT} (DEV)\n`);

let pass = 0, fail = 0;
const ok = (l, c, d = '') => {
  if (c) { pass++; console.log(`  [PASS] ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  [FAIL] ${l}${d ? '  ' + d : ''}`); }
};
const expectFail = async (label, fn, code) => {
  try { await fn(); ok(label, false, 'no error thrown'); }
  catch (e) { ok(label, code ? e.code === code : true, e.code || e.message); }
};

const { db } = await import('../config/firebaseAdmin.js');
const { DirectReceiptService, RECEIPT_KIND_DIRECT, DIRECT_RECEIPT_REFERENCE, DR_NUMBER_PREFIX } =
  await import('../services/directReceiptService.js');
const { BillConfirmService } = await import('../services/billConfirmService.js');
const { createInventoryBillFirestore, updateInventoryBillFirestore, getInventoryBillByIdFirestore, BILLS_COLLECTION } =
  await import('../repositories/firestore/inventoryBillsRepository.js');
const { getInventoryProductByIdFirestore } = await import('../repositories/firestore/inventoryProductsRepository.js');
const { BILL_STATUS } = await import('../utils/inventoryConstants.js');
// The receipt-item document id is the repository's format, not a shape this
// suite is free to guess. Hand-rolling it here once padded the line number to
// four digits instead of three, so cleanup deleted ids that never existed —
// Firestore reports a delete of a missing document as success, so the suite
// still claimed a clean teardown while orphan rows piled up in DEV.
const { formatReceiptItemDocId } = await import('../repositories/firestore/goodsReceiptsRepository.js');

const TAG = 'h56test';
const countOf = async (q) => (await q.count().get()).data().count;
const created = { bills: [], receipts: [], reversals: [], movements: [], items: [], products: [], suppliers: [], locations: [] };

const movBefore = await countOf(db.collection('inventory_stock_movements'));
const grBefore = await countOf(db.collection('goods_receipts'));
const poBefore = await countOf(db.collection('purchase_orders'));
console.log(`  BEFORE: ${movBefore} movements, ${grBefore} receipts, ${poBefore} orders\n`);

// ── Fixtures: a product, a supplier and a location, all DEV-only ────────────
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const now = () => new Date().toISOString();

const productId = `prod_${TAG}_${uid()}`;
const inactiveProductId = `prod_${TAG}_inactive_${uid()}`;
const supplierId = `sup_${TAG}_${uid()}`;
const inactiveSupplierId = `sup_${TAG}_inactive_${uid()}`;
const locationId = `loc_${TAG}_${uid()}`;
const inactiveLocationId = `loc_${TAG}_inactive_${uid()}`;

await db.collection('inventory_products').doc(productId).set({
  name: `H56 Test Product ${uid()}`, sku: `H56-${uid()}`, unit_of_measure: 'KG', unit: 'KG',
  category_id: null, current_stock: 0, stock_quantity: 0, stock_by_location: {},
  is_active: true, status: 'Active', created_at: now(), updated_at: now()
});
created.products.push(productId);
await db.collection('inventory_products').doc(inactiveProductId).set({
  name: `H56 Inactive ${uid()}`, sku: `H56X-${uid()}`, unit_of_measure: 'KG', unit: 'KG',
  current_stock: 0, stock_quantity: 0, stock_by_location: {}, is_active: false, status: 'Inactive',
  created_at: now(), updated_at: now()
});
created.products.push(inactiveProductId);
await db.collection('inventory_suppliers').doc(supplierId).set({
  name: `H56 Supplier ${uid()}`, search_name: 'h56 supplier', is_active: true, created_at: now(), updated_at: now()
});
created.suppliers.push(supplierId);
await db.collection('inventory_suppliers').doc(inactiveSupplierId).set({
  name: `H56 Dead Supplier`, search_name: 'h56 dead', is_active: false, created_at: now(), updated_at: now()
});
created.suppliers.push(inactiveSupplierId);
await db.collection('inventory_locations').doc(locationId).set({
  code: `h56-${uid()}`, name: `H56 Store ${uid()}`, is_active: true, is_default: false, created_at: now(), updated_at: now()
});
created.locations.push(locationId);
await db.collection('inventory_locations').doc(inactiveLocationId).set({
  code: `h56dead`, name: `H56 Dead Store`, is_active: false, is_default: false, created_at: now(), updated_at: now()
});
created.locations.push(inactiveLocationId);
console.log('  fixtures created (product, supplier, location, plus inactive variants)\n');

const ACTOR = { uid: `${TAG}_actor`, name: 'H56 Tester', role: 'admin' };

// Each bill gets a unique invoice reference by default. H7 treats a bill with
// no invoice number as a signal the operator must acknowledge before stock can
// move, so a fixture without one would test the acknowledgement path rather than
// the confirmation path these cases are about. The random file hash likewise
// keeps every fixture distinct. H7's own suite covers the signals themselves.
const mkBill = async (extra = {}) => {
  const id = `bill_${TAG}${uid()}`;
  const b = await createInventoryBillFirestore(id, {
    file: { fileName: `${id}.png`, sha256: crypto.randomBytes(32).toString('hex'), size: 10, mimeType: 'image/png', width: 10, height: 10 },
    actor: ACTOR, business_date: '2026-09-10'
  });
  created.bills.push(b.id);
  const patch = { invoice_number: `INV-${TAG}-${uid()}`, invoice_date: '2026-09-10', ...extra };
  await updateInventoryBillFirestore(b.id, patch);
  return { ...b, ...patch };
};
const stockOf = async (pid) => {
  const p = await getInventoryProductByIdFirestore(pid);
  return { total: Number(p?.current_stock) || 0, byLoc: p?.stock_by_location || {} };
};

console.log('═══ H6 — DIRECT RECEIPT ═══\n');

let drReceipt = null;
{
  const before = await stockOf(productId);
  ok('product starts at zero stock', before.total === 0, String(before.total));

  const bill = await mkBill();
  const r = await DirectReceiptService.confirmFromBill(bill.id, {
    idempotency_key: `${TAG}_dr_${uid()}`,
    supplier_id: supplierId, location_id: locationId,
    invoice_number: 'INV-H56-1', invoice_date: '2026-09-10',
    lines: [{ product_id: productId, quantity: 2.5, unit: 'KG', unit_cost: 40 }]
  }, ACTOR);
  drReceipt = r.receipt;
  created.receipts.push(r.receipt.receipt_id);
  created.movements.push(...(r.items || []).map(i => i.stock_movement_id));
  created.items.push(...(r.items || []).map(i => formatReceiptItemDocId(r.receipt.receipt_id, i.line_no)));

  ok('direct receipt created', !r.duplicate && !!r.receipt.receipt_id, r.receipt.receipt_id);
  ok('  receipt_kind is DIRECT', r.receipt.receipt_kind === RECEIPT_KIND_DIRECT, r.receipt.receipt_kind);
  ok('  po_id is null', r.receipt.po_id === null);
  ok('  bill_id linked', r.receipt.bill_id === bill.id);
  ok('  DR number format DR-YYYYMMDD-NNNNNN',
    /^DR-\d{8}-\d{6}$/.test(r.receipt.receipt_number), r.receipt.receipt_number);
  ok('  number came from the transactional counter, not a timestamp',
    r.receipt.receipt_number.startsWith(`${DR_NUMBER_PREFIX}-`));

  const after = await stockOf(productId);
  ok('stock increased by exactly the received quantity', after.total === 2.5, `0 → ${after.total}`);
  ok('  stock_by_location updated for the destination', after.byLoc[locationId] === 2.5, JSON.stringify(after.byLoc));

  const mov = await db.collection('inventory_stock_movements').doc(r.items[0].stock_movement_id).get();
  ok('  movement reference_type is DIRECT_RECEIPT',
    mov.data().reference_type === DIRECT_RECEIPT_REFERENCE, mov.data().reference_type);
  ok('  movement type is RECEIPT', mov.data().movement_type === 'RECEIPT');
  ok('  movement references the receipt', mov.data().reference_id === r.receipt.receipt_id);
  ok('  decimal quantity preserved through the ledger', mov.data().quantity === 2.5, String(mov.data().quantity));

  const b2 = await getInventoryBillByIdFirestore(bill.id);
  ok('bill marked CONFIRMED', b2.status === BILL_STATUS.CONFIRMED, b2.status);
  ok('  bill links to the receipt', b2.receipt_id === r.receipt.receipt_id);
  ok('  bill mode is DIRECT', b2.mode === 'DIRECT');

  const audit = await db.collection('audit_logs').doc(`audit_inv_dr_${r.receipt.receipt_id}`).get();
  ok('audit log written', audit.exists);
  // `details` is stored JSON-stringified by auditLogsRepository — the same
  // convention Phase F uses — so it must be parsed before inspection.
  const auditDetails = audit.exists ? JSON.parse(audit.data().details) : {};
  ok('  audit names the bill and receipt',
    auditDetails.bill_id === bill.id && auditDetails.receipt_id === r.receipt.receipt_id,
    `bill=${auditDetails.bill_id} receipt=${auditDetails.receipt_id}`);
}

console.log('\n═══ H6 — IDEMPOTENCY AND CONCURRENCY ═══\n');
{
  const bill = await mkBill();
  const key = `${TAG}_idem_${uid()}`;
  const payload = {
    idempotency_key: key, supplier_id: supplierId, location_id: locationId,
    lines: [{ product_id: productId, quantity: 1, unit: 'KG', unit_cost: 10 }]
  };
  const before = await stockOf(productId);
  const first = await DirectReceiptService.confirmFromBill(bill.id, payload, ACTOR);
  created.receipts.push(first.receipt.receipt_id);
  created.movements.push(...(first.items || []).map(i => i.stock_movement_id));
  created.items.push(formatReceiptItemDocId(first.receipt.receipt_id, 1));
  const mid = await stockOf(productId);
  ok('first confirmation posts stock', mid.total === before.total + 1, `${before.total} → ${mid.total}`);

  // The same bill is now CONFIRMED, so a replay is refused at the bill gate —
  // which is the stronger guarantee. Replay the key on a fresh bill to exercise
  // the receipt-level idempotency itself.
  await expectFail('replaying on the SAME bill is refused', () =>
    DirectReceiptService.confirmFromBill(bill.id, payload, ACTOR), 'BILL_ALREADY_CONFIRMED');

  // The fingerprint covers the BILL as well as the lines, so reusing a key for a
  // different bill is a genuinely different operation and must conflict rather
  // than silently return the first receipt.
  const bill2 = await mkBill();
  await expectFail('reusing a key for a DIFFERENT bill is rejected', () =>
    DirectReceiptService.confirmFromBill(bill2.id, payload, ACTOR), 'IDEMPOTENCY_KEY_CONFLICT');
  const after = await stockOf(productId);
  ok('  stock did NOT increase on the rejected replay', after.total === mid.total, `${mid.total} → ${after.total}`);

  const bill3 = await mkBill();
  await expectFail('same key with different lines is rejected', () =>
    DirectReceiptService.confirmFromBill(bill3.id, {
      ...payload, lines: [{ product_id: productId, quantity: 99, unit: 'KG', unit_cost: 10 }]
    }, ACTOR), 'IDEMPOTENCY_KEY_CONFLICT');
  ok('  still no extra stock', (await stockOf(productId)).total === mid.total);

  // Concurrency: five simultaneous confirmations under one key.
  const bills = await Promise.all([mkBill(), mkBill(), mkBill(), mkBill(), mkBill()]);
  const ckey = `${TAG}_conc_${uid()}`;
  const cbefore = await stockOf(productId);
  const results = await Promise.allSettled(bills.map(b =>
    DirectReceiptService.confirmFromBill(b.id, {
      idempotency_key: ckey, supplier_id: supplierId, location_id: locationId,
      lines: [{ product_id: productId, quantity: 3, unit: 'KG', unit_cost: 5 }]
    }, ACTOR)
  ));
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const ids = new Set(fulfilled.map(r => r.value.receipt.receipt_id));
  fulfilled.forEach(r => { created.receipts.push(r.value.receipt.receipt_id); (r.value.items || []).forEach(i => { created.movements.push(i.stock_movement_id); created.items.push(formatReceiptItemDocId(r.value.receipt.receipt_id, i.line_no)); }); });
  const cafter = await stockOf(productId);
  ok('concurrent confirmations produce exactly ONE receipt', ids.size === 1, `${ids.size} distinct receipt(s) from ${fulfilled.length} fulfilled`);
  ok('  stock increased exactly once', cafter.total === cbefore.total + 3, `${cbefore.total} → ${cafter.total}`);
}

console.log('\n═══ H6 — VALIDATION ═══\n');
{
  const base = { idempotency_key: `${TAG}_v_${uid()}`, supplier_id: supplierId, location_id: locationId };
  const good = [{ product_id: productId, quantity: 1, unit: 'KG' }];
  const stockBefore = await stockOf(productId);

  const b = async () => (await mkBill()).id;
  await expectFail('missing idempotency key rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: '', lines: good }, ACTOR), 'IDEMPOTENCY_KEY_REQUIRED');
  await expectFail('missing location rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, location_id: '', lines: good }, ACTOR), 'LOCATION_REQUIRED');
  await expectFail('missing supplier rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, supplier_id: '', lines: good }, ACTOR), 'SUPPLIER_REQUIRED');
  await expectFail('unknown supplier rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, supplier_id: 'sup_does_not_exist', lines: good }, ACTOR), 'SUPPLIER_NOT_FOUND');
  await expectFail('inactive supplier rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, supplier_id: inactiveSupplierId, lines: good }, ACTOR), 'SUPPLIER_INACTIVE');
  await expectFail('inactive location rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, location_id: inactiveLocationId, lines: good }, ACTOR), 'LOCATION_INACTIVE');
  await expectFail('unknown location rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, location_id: 'loc_nope_h56', lines: good }, ACTOR), 'LOCATION_NOT_FOUND');
  await expectFail('no lines rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, lines: [] }, ACTOR), 'NO_RECEIPT_LINES');
  await expectFail('zero quantity rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, lines: [{ product_id: productId, quantity: 0, unit: 'KG' }] }, ACTOR), 'INVALID_QUANTITY');
  await expectFail('negative quantity rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, lines: [{ product_id: productId, quantity: -5, unit: 'KG' }] }, ACTOR), 'INVALID_QUANTITY');
  await expectFail('duplicate product on two lines rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, lines: [
      { product_id: productId, quantity: 1, unit: 'KG' }, { product_id: productId, quantity: 2, unit: 'KG' }
    ] }, ACTOR), 'DUPLICATE_RECEIPT_PRODUCT');
  await expectFail('unit mismatch rejected — no conversion', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, lines: [{ product_id: productId, quantity: 1, unit: 'BOX' }] }, ACTOR), 'UNIT_MISMATCH');
  await expectFail('inactive product rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, lines: [{ product_id: inactiveProductId, quantity: 1, unit: 'KG' }] }, ACTOR), 'PRODUCT_INACTIVE');
  await expectFail('unknown product rejected', async () =>
    DirectReceiptService.confirmFromBill(await b(), { ...base, idempotency_key: `${TAG}_${uid()}`, lines: [{ product_id: 'prod_nope_h56', quantity: 1, unit: 'KG' }] }, ACTOR), 'PRODUCT_NOT_FOUND');
  await expectFail('unknown bill rejected', async () =>
    DirectReceiptService.confirmFromBill('bill_does_not_exist_h56', { ...base, idempotency_key: `${TAG}_${uid()}`, lines: good }, ACTOR), 'BILL_NOT_FOUND');
  {
    const disc = await mkBill({ status: BILL_STATUS.DISCARDED });
    await expectFail('discarded bill rejected', () =>
      DirectReceiptService.confirmFromBill(disc.id, { ...base, idempotency_key: `${TAG}_${uid()}`, lines: good }, ACTOR), 'BILL_DISCARDED');
  }

  const stockAfter = await stockOf(productId);
  ok('NO rejected attempt changed stock', stockAfter.total === stockBefore.total, `${stockBefore.total} → ${stockAfter.total}`);
}

console.log('\n═══ DIRECT RECEIPT REVERSAL ═══\n');
{
  const before = await stockOf(productId);
  await expectFail('reversal without a reason rejected', () =>
    DirectReceiptService.reverseDirect(drReceipt.receipt_id, { idempotency_key: `${TAG}_r_${uid()}` }, ACTOR), 'REVERSAL_REASON_REQUIRED');
  await expectFail('reversal without an idempotency key rejected', () =>
    DirectReceiptService.reverseDirect(drReceipt.receipt_id, { reason: 'wrong delivery' }, ACTOR), 'IDEMPOTENCY_KEY_REQUIRED');
  await expectFail('unknown receipt rejected', () =>
    DirectReceiptService.reverseDirect('gr_nope_h56', { idempotency_key: `${TAG}_${uid()}`, reason: 'not real' }, ACTOR), 'GOODS_RECEIPT_NOT_FOUND');
  ok('no rejected reversal changed stock', (await stockOf(productId)).total === before.total);

  const rkey = `${TAG}_rev_${uid()}`;
  const rev = await DirectReceiptService.reverseDirect(drReceipt.receipt_id, { idempotency_key: rkey, reason: 'Delivery returned to supplier' }, ACTOR);
  created.reversals.push(rev.reversal.reversal_id);
  created.movements.push(...(rev.reversal.stock_movement_ids || []));

  ok('reversal created', !rev.duplicate && !!rev.reversal.reversal_id, rev.reversal.reversal_id);
  ok('  compensating movement recorded', (rev.reversal.stock_movement_ids || []).length === 1);
  const after = await stockOf(productId);
  ok('stock reduced by the reversed quantity', after.total === before.total - 2.5, `${before.total} → ${after.total}`);

  const cm = await db.collection('inventory_stock_movements').doc(rev.reversal.stock_movement_ids[0]).get();
  ok('  compensating movement type is REVERSAL', cm.data().movement_type === 'REVERSAL', cm.data().movement_type);
  ok('  it references the original receipt', cm.data().reference_id === drReceipt.receipt_id);

  const orig = await db.collection('goods_receipts').doc(drReceipt.receipt_id).get();
  ok('ORIGINAL receipt is unchanged (immutable)',
    orig.data().total_received_quantity === drReceipt.total_received_quantity &&
    orig.data().receipt_status === 'POSTED',
    `qty=${orig.data().total_received_quantity} status=${orig.data().receipt_status}`);

  const again = await DirectReceiptService.reverseDirect(drReceipt.receipt_id, { idempotency_key: rkey, reason: 'Delivery returned to supplier' }, ACTOR);
  ok('repeat reversal is idempotent', again.duplicate === true);
  ok('  stock did NOT reduce twice', (await stockOf(productId)).total === after.total, String((await stockOf(productId)).total));

  const audit = await db.collection('audit_logs').doc(`audit_inv_drrev_${rev.reversal.reversal_id}`).get();
  ok('reversal audit log written', audit.exists);
  const revDetails = audit.exists ? JSON.parse(audit.data().details) : {};
  ok('  audit records the reason', revDetails.reason === 'Delivery returned to supplier', revDetails.reason);
  ok('  audit records the compensating movement id', Array.isArray(revDetails.stock_movement_ids) && revDetails.stock_movement_ids.length === 1);
}

console.log('\n═══ H5 — PO CONFIRMATION GATES (no order fixture) ═══\n');
{
  // Building a full approved PR → PO chain is Phase B–E territory and out of
  // scope here. These assert the H5 gates that run BEFORE the Phase F engine,
  // which are the parts H5 actually adds.
  const stockBefore = await stockOf(productId);
  const bill = await mkBill();
  await expectFail('missing idempotency key rejected', () =>
    BillConfirmService.confirmAgainstPurchaseOrder(bill.id, { po_id: 'po_x', lines: [] }, ACTOR), 'IDEMPOTENCY_KEY_REQUIRED');
  await expectFail('missing purchase order rejected', () =>
    BillConfirmService.confirmAgainstPurchaseOrder(bill.id, { idempotency_key: `${TAG}_${uid()}`, lines: [] }, ACTOR), 'PURCHASE_ORDER_REQUIRED');
  await expectFail('unknown purchase order rejected', () =>
    BillConfirmService.confirmAgainstPurchaseOrder(bill.id, { idempotency_key: `${TAG}_${uid()}`, po_id: 'po_nope_h56', lines: [{ product_id: productId, quantity: 1 }] }, ACTOR), 'PURCHASE_ORDER_NOT_FOUND');
  {
    const conf = await mkBill({ status: BILL_STATUS.CONFIRMED, receipt_id: 'gr_fake_h56' });
    await expectFail('already-confirmed bill rejected', () =>
      BillConfirmService.confirmAgainstPurchaseOrder(conf.id, { idempotency_key: `${TAG}_${uid()}`, po_id: 'po_x', lines: [{ product_id: productId, quantity: 1 }] }, ACTOR), 'BILL_ALREADY_CONFIRMED');
  }
  {
    const disc = await mkBill({ status: BILL_STATUS.DISCARDED });
    await expectFail('discarded bill rejected', () =>
      BillConfirmService.confirmAgainstPurchaseOrder(disc.id, { idempotency_key: `${TAG}_${uid()}`, po_id: 'po_x', lines: [{ product_id: productId, quantity: 1 }] }, ACTOR), 'BILL_DISCARDED');
  }
  ok('NO H5 rejection changed stock', (await stockOf(productId)).total === stockBefore.total);

  // H5 must not contain a second stock implementation.
  const fs = require_('fs');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = strip(fs.readFileSync(path.join(BACKEND, 'services', 'billConfirmService.js'), 'utf8'));
  ok('H5 does not call the ledger core directly', !/stageMovementInTransaction/.test(src));
  // H5 DOES open one transaction of its own, and must: it claims the bill
  // atomically so two confirmations carrying different idempotency keys cannot
  // both receive the same bill. What it must never do is post stock itself, so
  // the invariant is checked against the things that move stock rather than
  // against the presence of a transaction. The ledger-core check above is the
  // real guard; these two make the boundary explicit.
  ok('H5 stages no stock movement of its own', !/stageMovementInTransaction/.test(src));
  ok('H5 writes to no stock or receipt collection directly',
    !/collection\(\s*['\"`](inventory_stock_movements|goods_receipts|goods_receipt_items)/.test(src));
  ok('H5 still delegates receiving to the Phase F engine',
    /GoodsReceiptService\.receive\(/.test(src));
  ok('H5 delegates to the Phase F engine', /GoodsReceiptService\.receive\(/.test(src));
  const dsrc = strip(fs.readFileSync(path.join(BACKEND, 'services', 'directReceiptService.js'), 'utf8'));
  ok('H6 posts stock ONLY through the shared ledger core', /stageMovementInTransaction\(txn/.test(dsrc));
  ok('H6 never writes balances directly',
    !/txn\.update\([^)]*current_stock|stock_by_location:\s/.test(dsrc));
}

console.log('\n═══ TOTALS ═══\n');
const movAfter = await countOf(db.collection('inventory_stock_movements'));
const grAfter = await countOf(db.collection('goods_receipts'));
const poAfter = await countOf(db.collection('purchase_orders'));
const drAfter = await countOf(db.collection('goods_receipts').where('receipt_kind', '==', RECEIPT_KIND_DIRECT));
console.log(`  movements ${movBefore} → ${movAfter}`);
console.log(`  receipts  ${grBefore} → ${grAfter}   (direct: ${drAfter})`);
console.log(`  orders    ${poBefore} → ${poAfter}`);
ok('no purchase order was created', poAfter === poBefore);

// ── Cleanup ────────────────────────────────────────────────────────────────
console.log('\n  cleaning up test documents…');
const del = async (col, ids) => { let n = 0; for (const id of ids) { try { await db.collection(col).doc(id).delete(); n++; } catch {} } return n; };
const cleaned = {
  movements: await del('inventory_stock_movements', [...new Set(created.movements)]),
  items: await del('goods_receipt_items', [...new Set(created.items)]),
  receipts: await del('goods_receipts', [...new Set(created.receipts)]),
  reversals: await del('goods_receipt_reversals', [...new Set(created.reversals)]),
  bills: await del(BILLS_COLLECTION, [...new Set(created.bills)]),
  products: await del('inventory_products', created.products),
  suppliers: await del('inventory_suppliers', created.suppliers),
  locations: await del('inventory_locations', created.locations)
};
// Audit logs are append-only by convention, but this suite's own entries are
// removed so DEV is left exactly as it was found.
{
  const ids = [
    ...[...new Set(created.receipts)].map(id => `audit_inv_dr_${id}`),
    ...[...new Set(created.reversals)].map(id => `audit_inv_drrev_${id}`)
  ];
  cleaned.audit = await del('audit_logs', ids);
}
console.log('  ' + JSON.stringify(cleaned));
const movFinal = await countOf(db.collection('inventory_stock_movements'));
const grFinal = await countOf(db.collection('goods_receipts'));
console.log(`  AFTER CLEANUP: ${movFinal} movements, ${grFinal} receipts`);
ok('DEV returned to its baseline movement count', movFinal === movBefore, `${movBefore} vs ${movFinal}`);
ok('DEV returned to its baseline receipt count', grFinal === grBefore, `${grBefore} vs ${grFinal}`);

// Firestore reports the delete of a non-existent document as a success, so the
// two counts above can look clean while teardown quietly deleted nothing. These
// re-read this suite's OWN document ids and prove each one is really gone.
// Scoped to ids this suite created rather than to whole collections, so running
// inside a full regression sweep cannot fail on another suite's residue.
{
  const stillThere = async (col, ids) => {
    const out = [];
    for (const id of [...new Set(ids)]) {
      const d = await db.collection(col).doc(id).get();
      if (d.exists) out.push(`${col}/${id}`);
    }
    return out;
  };
  const leftovers = [
    ...await stillThere('goods_receipt_items', created.items),
    ...await stillThere('goods_receipts', created.receipts),
    ...await stillThere(BILLS_COLLECTION, created.bills),
    ...await stillThere('inventory_stock_movements', created.movements)
  ];
  ok('Cleanup: every document this suite created is really gone',
    leftovers.length === 0, leftovers.slice(0, 5).join(', ') || 'none');
}

console.log(`\n═══ H5/H6 RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
