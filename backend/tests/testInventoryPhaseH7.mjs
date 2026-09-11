/**
 * testInventoryPhaseH7.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H7 — duplicate bill protection, audit hardening, immutability, discard
 * safety and bill/receipt traceability.
 *
 * Four-layer fail-closed guard. Firebase Admin is imported only after it passes.
 *
 * THE CENTRAL ASSERTIONS
 *   1. A duplicate signal never blocks silently and never passes silently. It
 *      withholds confirmation until the operator names the signal and says why.
 *   2. A refused confirmation moves no stock at all.
 *   3. An acknowledged confirmation moves stock exactly once.
 *   4. An invoice number is never fabricated.
 *
 * CLEANUP
 * Every document is recorded by id as it is created, deleted at the end, and
 * then RE-READ to prove it is gone. A delete call returning success is not
 * accepted as evidence: Firestore reports deleting a non-existent document as a
 * success, which is exactly how an earlier suite claimed a clean teardown while
 * leaving orphans behind. Nothing here deletes by collection sweep, so DEV data
 * created by a person is never at risk.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryPhaseH7.mjs
 */

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

const BACKEND = path.join(process.cwd(), 'backend');
const require_ = createRequire(path.join(BACKEND, 'package.json'));

// ── Guard 1 ──────────────────────────────────────────────────────────────────
if (process.env.HPMS_ENV !== 'development') {
  console.error(`[SAFETY_ABORT] HPMS_ENV must be "development" (got ${JSON.stringify(process.env.HPMS_ENV)}).`);
  process.exit(1);
}
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });

// ── Guard 2 ──────────────────────────────────────────────────────────────────
const { isProductionProject } = await import('../config/productionSafetyGuard.js');
if (isProductionProject()) {
  console.error('[SAFETY_ABORT] Resolved Firebase project looks like production.');
  process.exit(1);
}

// ── Guards 3 + 4 ─────────────────────────────────────────────────────────────
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }
console.log(`[GUARD] project=${PROJECT} (DEV) — safe to proceed\n`);

let pass = 0, fail = 0;
const failures = [];
const ok = (l, c, d = '') => {
  if (c) { pass++; console.log(`  [PASS] ${l}${d ? '  ' + d : ''}`); }
  else { fail++; failures.push(l); console.log(`  [FAIL] ${l}${d ? '  ' + d : ''}`); }
};
const expectFail = async (label, fn, code) => {
  try { await fn(); ok(label, false, 'no error was thrown'); }
  catch (e) { ok(label, code ? e.code === code : true, e.code || e.message); }
};

// ── Imports (after the guard) ────────────────────────────────────────────────
const { db } = await import('../config/firebaseAdmin.js');
const { DirectReceiptService, RECEIPT_KIND_DIRECT } = await import('../services/directReceiptService.js');
const { BillConfirmService } = await import('../services/billConfirmService.js');
const { detectBillDuplicates, assertDuplicatesAcknowledged, resolveBillIdentity } =
  await import('../services/billDuplicateService.js');
const {
  createInventoryBillFirestore, updateInventoryBillFirestore, getInventoryBillByIdFirestore,
  discardInventoryBillFirestore, replaceInventoryBillLinesFirestore, getInventoryBillLinesFirestore,
  formatBillLineDocId, BILLS_COLLECTION, BILL_LINES_COLLECTION
} = await import('../repositories/firestore/inventoryBillsRepository.js');
const { getInventoryProductByIdFirestore } = await import('../repositories/firestore/inventoryProductsRepository.js');
const { formatReceiptItemDocId, getGoodsReceiptItemsFirestore } =
  await import('../repositories/firestore/goodsReceiptsRepository.js');
const { BILL_STATUS, BILL_DUPLICATE_CODE } = await import('../utils/inventoryConstants.js');
const { PurchaseRequestService } = await import('../services/purchaseRequestService.js');
const { PurchaseRequestApprovalService } = await import('../services/purchaseRequestApprovalService.js');
const { PurchaseOrderService } = await import('../services/purchaseOrderService.js');
const { getInventoryApprovalConfigFirestore, updateInventoryApprovalConfigFirestore } =
  await import('../repositories/firestore/inventoryApprovalConfigRepository.js');
const { deletePurchaseRequestCascadeFirestore } =
  await import('../repositories/firestore/purchaseRequestsRepository.js');
const { deletePurchaseOrderCascadeFirestore } =
  await import('../repositories/firestore/purchaseOrdersRepository.js');

const TAG = 'h7test';
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const now = () => new Date().toISOString();
const countOf = async (q) => (await q.count().get()).data().count;

// Every id this suite writes, recorded as it is created.
const created = {
  bills: [], billLines: [], receipts: [], items: [], movements: [],
  reversals: [], products: [], suppliers: [], locations: [], audits: [],
  requests: [], orders: []
};

// ── Baseline ─────────────────────────────────────────────────────────────────
const baseline = {
  movements: await countOf(db.collection('inventory_stock_movements')),
  receipts: await countOf(db.collection('goods_receipts')),
  items: await countOf(db.collection('goods_receipt_items')),
  bills: await countOf(db.collection('inventory_bills')),
  billLines: await countOf(db.collection('inventory_bill_lines')),
  orders: await countOf(db.collection('purchase_orders')),
  audits: await countOf(db.collection('audit_logs'))
};
console.log(`  BASELINE  movements=${baseline.movements} receipts=${baseline.receipts} items=${baseline.items} ` +
            `bills=${baseline.bills} billLines=${baseline.billLines} orders=${baseline.orders}\n`);

// ── Fixtures ─────────────────────────────────────────────────────────────────
const productId = `prod_${TAG}_${uid()}`;
const supplierId = `sup_${TAG}_${uid()}`;
const supplierBId = `sup_${TAG}b_${uid()}`;
const locationId = `loc_${TAG}_${uid()}`;

await db.collection('inventory_products').doc(productId).set({
  name: `H7 Test Product ${uid()}`, sku: `H7-${uid()}`, unit_of_measure: 'KG', unit: 'KG',
  category_id: null, current_stock: 0, stock_quantity: 0, stock_by_location: {},
  // A purchase order can only be raised for a product that has a supplier.
  default_supplier_id: supplierId, cost_price: 10,
  is_active: true, status: 'Active', created_at: now(), updated_at: now()
});
created.products.push(productId);
for (const [sid, nm] of [[supplierId, 'H7 Supplier A'], [supplierBId, 'H7 Supplier B']]) {
  await db.collection('inventory_suppliers').doc(sid).set({
    name: `${nm} ${uid()}`, search_name: nm.toLowerCase(), is_active: true, created_at: now(), updated_at: now()
  });
  created.suppliers.push(sid);
}
await db.collection('inventory_locations').doc(locationId).set({
  code: `h7-${uid()}`, name: `H7 Store ${uid()}`, is_active: true, is_default: false,
  created_at: now(), updated_at: now()
});
created.locations.push(locationId);

const ACTOR = { uid: `${TAG}_actor`, name: 'H7 Tester', role: 'admin' };
const FIXED_DATE = '2026-09-10';

/**
 * Creates a bill. `sha` may be shared between bills on purpose to exercise the
 * identical-file signal. `invoice` set to null deliberately leaves the bill with
 * no invoice number, which is a signal in its own right and never fabricated.
 */
const mkBill = async ({ sha = null, invoice = `INV-${TAG}-${uid()}`, date = FIXED_DATE, supplier = supplierId, status = null } = {}) => {
  const id = `bill_${TAG}${uid()}`;
  const b = await createInventoryBillFirestore(id, {
    file: {
      fileName: `${id}.png`,
      sha256: sha || crypto.randomBytes(32).toString('hex'),
      size: 10, mimeType: 'image/png', width: 10, height: 10
    },
    actor: ACTOR, business_date: FIXED_DATE
  });
  created.bills.push(b.id);
  const patch = {};
  if (invoice !== null) patch.invoice_number = invoice;
  if (date !== null) patch.invoice_date = date;
  if (supplier !== null) patch.supplier_id = supplier;
  if (status) patch.status = status;
  if (Object.keys(patch).length) await updateInventoryBillFirestore(b.id, patch);
  return { ...b, ...patch };
};

const stockOf = async (pid) => {
  const p = await getInventoryProductByIdFirestore(pid);
  return Number(p?.current_stock) || 0;
};

const trackReceipt = (r) => {
  created.receipts.push(r.receipt.receipt_id);
  (r.items || []).forEach(i => {
    created.movements.push(i.stock_movement_id);
    created.items.push(formatReceiptItemDocId(r.receipt.receipt_id, i.line_no));
  });
  created.audits.push(`audit_inv_dr_${r.receipt.receipt_id}`, `audit_inv_dupovr_${r.receipt.receipt_id}`);
};

const LINES = [{ product_id: productId, quantity: 2, unit: 'KG', unit_cost: 10 }];
const ACK = (codes, reason = 'Verified with the storekeeper, this is a separate genuine delivery') =>
  ({ codes, reason });

// ═════════════════════════════════════════════════════════════════════════════
console.log('═══ 1. DUPLICATE DETECTION SIGNALS ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  // 4. Same file uploaded twice.
  const sha = crypto.createHash('sha256').update(`h7-shared-${uid()}`).digest('hex');
  const first = await mkBill({ sha });
  const second = await mkBill({ sha });
  const d = await detectBillDuplicates(second);
  const codes = d.warnings.map(w => w.code);
  ok('4. identical file raises FILE_DUPLICATE', codes.includes(BILL_DUPLICATE_CODE.FILE_DUPLICATE), codes.join(','));
  ok('  the warning names the earlier bill',
    d.warnings.find(w => w.code === BILL_DUPLICATE_CODE.FILE_DUPLICATE)?.bill_ids.includes(first.id));
  ok('  a bill never reports itself as its own duplicate',
    !d.warnings.some(w => (w.bill_ids || []).includes(second.id)));

  // A discarded bill is not evidence of anything.
  await discardInventoryBillFirestore(first.id, ACTOR);
  const d2 = await detectBillDuplicates(second);
  ok('  a DISCARDED bill no longer raises the signal',
    !d2.warnings.map(w => w.code).includes(BILL_DUPLICATE_CODE.FILE_DUPLICATE),
    d2.warnings.map(w => w.code).join(',') || 'none');
}

{
  // 5. Same supplier + invoice + date.
  const inv = `INV-${TAG}-DUP-${uid()}`;
  const a = await mkBill({ invoice: inv, date: FIXED_DATE, supplier: supplierId });
  const b = await mkBill({ invoice: inv, date: FIXED_DATE, supplier: supplierId });
  const codes = (await detectBillDuplicates(b)).warnings.map(w => w.code);
  ok('5. same supplier + invoice + date raises INVOICE_DUPLICATE',
    codes.includes(BILL_DUPLICATE_CODE.INVOICE_DUPLICATE), codes.join(','));
  ok('  and does NOT also raise INVOICE_NUMBER_REUSED',
    !codes.includes(BILL_DUPLICATE_CODE.INVOICE_NUMBER_REUSED));
  ok('  a matches b symmetrically',
    (await detectBillDuplicates(a)).warnings.map(w => w.code).includes(BILL_DUPLICATE_CODE.INVOICE_DUPLICATE));
}

{
  // Same supplier + invoice, DIFFERENT date — a correction, not a re-entry.
  const inv = `INV-${TAG}-REUSE-${uid()}`;
  await mkBill({ invoice: inv, date: '2026-09-01', supplier: supplierId });
  const b = await mkBill({ invoice: inv, date: '2026-09-08', supplier: supplierId });
  const codes = (await detectBillDuplicates(b)).warnings.map(w => w.code);
  ok('same invoice on a different date raises INVOICE_NUMBER_REUSED',
    codes.includes(BILL_DUPLICATE_CODE.INVOICE_NUMBER_REUSED), codes.join(','));
  ok('  it is NOT reported as an exact INVOICE_DUPLICATE',
    !codes.includes(BILL_DUPLICATE_CODE.INVOICE_DUPLICATE));
}

{
  // 6. Same supplier and date, DIFFERENT invoice number — two real deliveries.
  await mkBill({ invoice: `INV-${TAG}-X1-${uid()}`, date: FIXED_DATE, supplier: supplierId });
  const b = await mkBill({ invoice: `INV-${TAG}-X2-${uid()}`, date: FIXED_DATE, supplier: supplierId });
  const codes = (await detectBillDuplicates(b)).warnings.map(w => w.code);
  ok('6. same supplier and date but a different invoice raises NO duplicate signal',
    codes.length === 0, codes.join(',') || 'none');
}

{
  // 7. Same invoice number, DIFFERENT supplier — unrelated documents.
  const inv = `INV-${TAG}-CROSS-${uid()}`;
  await mkBill({ invoice: inv, date: FIXED_DATE, supplier: supplierId });
  const b = await mkBill({ invoice: inv, date: FIXED_DATE, supplier: supplierBId });
  const codes = (await detectBillDuplicates(b)).warnings.map(w => w.code);
  ok('7. the same invoice number from a DIFFERENT supplier raises no signal',
    codes.length === 0, codes.join(',') || 'none');
}

{
  // 8. Missing invoice number.
  const b = await mkBill({ invoice: null });
  const d = await detectBillDuplicates(b);
  const codes = d.warnings.map(w => w.code);
  ok('8. a bill with no invoice number raises MISSING_INVOICE_NUMBER',
    codes.includes(BILL_DUPLICATE_CODE.MISSING_INVOICE_NUMBER), codes.join(','));

  const stored = await getInventoryBillByIdFirestore(b.id);
  ok('  the invoice number is NOT fabricated from a timestamp or file name',
    stored.invoice_number === null || stored.invoice_number === undefined, String(stored.invoice_number));
  ok('  nor does detection invent one',
    resolveBillIdentity(stored).invoice_number === null);

  // The request may supply one the operator typed in during review.
  const withInv = await detectBillDuplicates(b, { invoice_number: 'TYPED-BY-OPERATOR' });
  ok('  supplying one at confirmation clears the signal',
    !withInv.warnings.map(w => w.code).includes(BILL_DUPLICATE_CODE.MISSING_INVOICE_NUMBER));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. ACKNOWLEDGEMENT GATE (pure) ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const warnings = [
    { code: BILL_DUPLICATE_CODE.FILE_DUPLICATE, message: 'x', bill_ids: [] },
    { code: BILL_DUPLICATE_CODE.MISSING_INVOICE_NUMBER, message: 'y', bill_ids: [] }
  ];
  ok('no warnings needs no acknowledgement', assertDuplicatesAcknowledged([], null) === null);

  try { assertDuplicatesAcknowledged(warnings, null); ok('missing ack is refused', false); }
  catch (e) {
    ok('missing ack is refused', e.code === 'DUPLICATE_ACK_REQUIRED', e.code);
    ok('  the error lists what must be acknowledged',
      Array.isArray(e.required_acknowledgements) && e.required_acknowledgements.length === 2,
      (e.required_acknowledgements || []).join(','));
  }

  await expectFail('a partial ack is refused',
    async () => assertDuplicatesAcknowledged(warnings, ACK([BILL_DUPLICATE_CODE.FILE_DUPLICATE])),
    'DUPLICATE_ACK_REQUIRED');
  await expectFail('an unknown ack code is refused',
    async () => assertDuplicatesAcknowledged(warnings, ACK(['NOT_A_REAL_CODE'])),
    'INVALID_DUPLICATE_ACK');
  await expectFail('a short reason is refused',
    async () => assertDuplicatesAcknowledged(warnings, { codes: warnings.map(w => w.code), reason: 'ok' }),
    'DUPLICATE_OVERRIDE_REASON_REQUIRED');
  await expectFail('an empty reason is refused',
    async () => assertDuplicatesAcknowledged(warnings, { codes: warnings.map(w => w.code), reason: '   ' }),
    'DUPLICATE_OVERRIDE_REASON_REQUIRED');
  await expectFail('a bare boolean is not an acknowledgement',
    async () => assertDuplicatesAcknowledged(warnings, true),
    'DUPLICATE_ACK_REQUIRED');

  const good = assertDuplicatesAcknowledged(warnings, ACK(warnings.map(w => w.code)));
  ok('a complete, explained ack is accepted', good !== null && good.codes.length === 2);
  ok('  the recorded codes are the ones RAISED, not the ones offered',
    JSON.stringify(good.codes.slice().sort()) ===
    JSON.stringify(warnings.map(w => w.code).slice().sort()));

  const extra = assertDuplicatesAcknowledged(
    [warnings[0]],
    ACK([BILL_DUPLICATE_CODE.FILE_DUPLICATE, BILL_DUPLICATE_CODE.INVOICE_DUPLICATE]));
  ok('  a stale extra code is dropped, not rejected',
    extra.codes.length === 1 && extra.codes[0] === BILL_DUPLICATE_CODE.FILE_DUPLICATE);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. CONFIRMATION IS GATED — AND MOVES NO STOCK WHEN REFUSED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
let ackedReceipt = null;
{
  const sha = crypto.createHash('sha256').update(`h7-gate-${uid()}`).digest('hex');
  await mkBill({ sha });                 // the earlier bill carrying the same file
  const bill = await mkBill({ sha });

  const before = await stockOf(productId);
  const movBefore = await countOf(db.collection('inventory_stock_movements'));

  await expectFail('confirming a duplicate WITHOUT an acknowledgement is refused',
    () => DirectReceiptService.confirmFromBill(bill.id, {
      idempotency_key: `${TAG}_gate_${uid()}`, supplier_id: supplierId, location_id: locationId,
      invoice_number: bill.invoice_number, invoice_date: FIXED_DATE, lines: LINES
    }, ACTOR), 'DUPLICATE_ACK_REQUIRED');

  ok('  the refused confirmation changed NO stock', await stockOf(productId) === before,
    `${before} → ${await stockOf(productId)}`);
  ok('  and created NO stock movement',
    await countOf(db.collection('inventory_stock_movements')) === movBefore);
  ok('  and created NO receipt',
    await countOf(db.collection('goods_receipts')) === baseline.receipts);

  await expectFail('  an unexplained acknowledgement is refused',
    () => DirectReceiptService.confirmFromBill(bill.id, {
      idempotency_key: `${TAG}_gate2_${uid()}`, supplier_id: supplierId, location_id: locationId,
      invoice_number: bill.invoice_number, invoice_date: FIXED_DATE, lines: LINES,
      duplicate_ack: { codes: [BILL_DUPLICATE_CODE.FILE_DUPLICATE], reason: 'yes' }
    }, ACTOR), 'DUPLICATE_OVERRIDE_REASON_REQUIRED');
  ok('  still no stock after the second refusal', await stockOf(productId) === before);

  // Now acknowledge properly.
  const r = await DirectReceiptService.confirmFromBill(bill.id, {
    idempotency_key: `${TAG}_ack_${uid()}`, supplier_id: supplierId, location_id: locationId,
    invoice_number: bill.invoice_number, invoice_date: FIXED_DATE, lines: LINES,
    duplicate_ack: ACK([BILL_DUPLICATE_CODE.FILE_DUPLICATE])
  }, ACTOR);
  trackReceipt(r);
  ackedReceipt = r.receipt;

  ok('an acknowledged confirmation posts stock exactly once',
    await stockOf(productId) === before + 2, `${before} → ${await stockOf(productId)}`);
  ok('  exactly one movement was created',
    await countOf(db.collection('inventory_stock_movements')) === movBefore + 1);
  ok('  the receipt is a DIRECT receipt', r.receipt.receipt_kind === RECEIPT_KIND_DIRECT);
  ok('  the bill is now CONFIRMED and carries the receipt id',
    r.bill.status === BILL_STATUS.CONFIRMED && r.bill.receipt_id === r.receipt.receipt_id);
}

{
  // A missing invoice number blocks confirmation until acknowledged, and is
  // still never invented by the system.
  const bill = await mkBill({ invoice: null });
  const before = await stockOf(productId);

  await expectFail('receiving against a bill with no invoice number needs an acknowledgement',
    () => DirectReceiptService.confirmFromBill(bill.id, {
      idempotency_key: `${TAG}_noinv_${uid()}`, supplier_id: supplierId, location_id: locationId,
      lines: LINES
    }, ACTOR), 'DUPLICATE_ACK_REQUIRED');
  ok('  no stock moved', await stockOf(productId) === before);

  const r = await DirectReceiptService.confirmFromBill(bill.id, {
    idempotency_key: `${TAG}_noinvack_${uid()}`, supplier_id: supplierId, location_id: locationId,
    lines: LINES, duplicate_ack: ACK([BILL_DUPLICATE_CODE.MISSING_INVOICE_NUMBER],
      'Cash purchase from the market, no printed invoice was issued')
  }, ACTOR);
  trackReceipt(r);
  ok('  once acknowledged the receipt is created', !r.duplicate && !!r.receipt.receipt_id);
  ok('  and the invoice number is still empty, not invented',
    !r.receipt.invoice_number, String(r.receipt.invoice_number));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. REQUEST IDEMPOTENCY IS UNCHANGED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const bill = await mkBill();
  const key = `${TAG}_idem_${uid()}`;
  const payload = {
    idempotency_key: key, supplier_id: supplierId, location_id: locationId,
    invoice_number: bill.invoice_number, invoice_date: FIXED_DATE, lines: LINES
  };
  const before = await stockOf(productId);
  const first = await DirectReceiptService.confirmFromBill(bill.id, payload, ACTOR);
  trackReceipt(first);
  const mid = await stockOf(productId);
  ok('1. first confirmation posts stock', mid === before + 2, `${before} → ${mid}`);

  // 1. Same bill, same key.
  await expectFail('1. same bill + same idempotency key is refused at the bill gate',
    () => DirectReceiptService.confirmFromBill(bill.id, payload, ACTOR), 'BILL_ALREADY_CONFIRMED');
  ok('  stock unchanged', await stockOf(productId) === mid, `${mid} → ${await stockOf(productId)}`);

  // 2. Same bill, DIFFERENT key — the dangerous case, and still refused.
  await expectFail('2. same bill + a DIFFERENT idempotency key is also refused',
    () => DirectReceiptService.confirmFromBill(bill.id, { ...payload, idempotency_key: `${TAG}_other_${uid()}` }, ACTOR),
    'BILL_ALREADY_CONFIRMED');
  ok('  stock still unchanged', await stockOf(productId) === mid);
  ok('  exactly one receipt exists for this bill',
    (await db.collection('goods_receipts').where('bill_id', '==', bill.id).count().get()).data().count === 1);

  // A key replayed against a DIFFERENT bill is a different operation.
  const bill2 = await mkBill();
  await expectFail('reusing the key on a different bill conflicts rather than returning the first receipt',
    () => DirectReceiptService.confirmFromBill(bill2.id, payload, ACTOR), 'IDEMPOTENCY_KEY_CONFLICT');
  ok('  stock unchanged after the conflict', await stockOf(productId) === mid);
}

{
  // 3. Two concurrent confirmations of the same bill.
  const bill = await mkBill();
  const before = await stockOf(productId);
  const movBefore = await countOf(db.collection('inventory_stock_movements'));
  const mk = () => DirectReceiptService.confirmFromBill(bill.id, {
    idempotency_key: `${TAG}_conc_${uid()}`, supplier_id: supplierId, location_id: locationId,
    invoice_number: bill.invoice_number, invoice_date: FIXED_DATE, lines: LINES
  }, ACTOR);

  const settled = await Promise.allSettled([mk(), mk(), mk()]);
  const winners = settled.filter(r => r.status === 'fulfilled' && r.value?.duplicate === false);
  winners.forEach(w => trackReceipt(w.value));

  ok('3. exactly one of three concurrent confirmations wins',
    winners.length === 1, `${winners.length} winner(s)`);
  ok('  stock rose by exactly ONE receipt', await stockOf(productId) === before + 2,
    `${before} → ${await stockOf(productId)}`);
  ok('  exactly one movement was created',
    await countOf(db.collection('inventory_stock_movements')) === movBefore + 1);
  ok('  every loser failed with a real refusal, not silently',
    settled.filter(r => r.status === 'rejected').every(r => !!r.reason?.code),
    settled.filter(r => r.status === 'rejected').map(r => r.reason?.code).join(','));

  const numbers = new Set(winners.map(w => w.value.receipt.receipt_number));
  ok('  no receipt-number collision', numbers.size === winners.length);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 5. AUDIT HARDENING ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const dr = await db.collection('audit_logs').doc(`audit_inv_dr_${ackedReceipt.receipt_id}`).get();
  ok('a direct receipt writes an audit record', dr.exists);

  const d = dr.data() || {};
  ok('  details are JSON-stringified, following the repository convention',
    typeof d.details === 'string', typeof d.details);

  let parsed = {};
  try { parsed = JSON.parse(d.details); } catch { /* asserted below */ }
  ok('  the stored details parse back to an object', parsed && typeof parsed === 'object');
  ok('  it identifies the bill', !!parsed.bill_id);
  ok('  it identifies the receipt', !!parsed.receipt_id);
  ok('  it identifies the user', !!d.user_id && d.user_id !== 'unknown', d.user_id);
  ok('  it records the actor role', parsed.actor_role === 'admin', String(parsed.actor_role));
  ok('  it records the business date', !!d.business_date, d.business_date);
  ok('  it records a timestamp', !!d.created_at);
  ok('  it records the duplicate warnings that were raised',
    Array.isArray(parsed.duplicate_warnings), JSON.stringify(parsed.duplicate_warnings));

  // No bill image bytes, no raw OCR text, no secrets.
  const raw = JSON.stringify(d);
  ok('  it stores no image bytes', !/data:image|base64,/i.test(raw));
  ok('  it stores no raw OCR text', !('ocr_raw_text' in parsed));
  ok('  it stores no credential-shaped field',
    !/password|secret|private_key|api_key/i.test(raw));

  const ovr = await db.collection('audit_logs').doc(`audit_inv_dupovr_${ackedReceipt.receipt_id}`).get();
  ok('a duplicate override is audited as its OWN action', ovr.exists);
  if (ovr.exists) {
    const od = JSON.parse(ovr.data().details || '{}');
    ok('  it records which codes were overridden',
      Array.isArray(od.overridden_codes) && od.overridden_codes.includes(BILL_DUPLICATE_CODE.FILE_DUPLICATE),
      JSON.stringify(od.overridden_codes));
    ok('  it records the operator\'s reason', typeof od.reason === 'string' && od.reason.length >= 10);
    ok('  it names the bills it matched', Array.isArray(od.matched_bill_ids));
    ok('  the action name is the override action',
      ovr.data().action === 'INVENTORY_BILL_DUPLICATE_OVERRIDE', ovr.data().action);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 6. IMMUTABILITY / STATE PROTECTION ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const confirmedBillId = (await db.collection('goods_receipts').doc(ackedReceipt.receipt_id).get()).data()?.bill_id;
  ok('the receipt points back at its bill', !!confirmedBillId, String(confirmedBillId));

  await expectFail('a CONFIRMED bill cannot be discarded',
    () => discardInventoryBillFirestore(confirmedBillId, ACTOR), 'BILL_ALREADY_CONFIRMED');

  await expectFail('a CONFIRMED bill cannot be re-confirmed as a direct receipt',
    () => DirectReceiptService.confirmFromBill(confirmedBillId, {
      idempotency_key: `${TAG}_re_${uid()}`, supplier_id: supplierId, location_id: locationId, lines: LINES
    }, ACTOR), 'BILL_ALREADY_CONFIRMED');

  await expectFail('a CONFIRMED bill cannot be confirmed against a purchase order either',
    () => BillConfirmService.confirmAgainstPurchaseOrder(confirmedBillId, {
      idempotency_key: `${TAG}_repo_${uid()}`, po_id: 'po_anything', lines: LINES
    }, ACTOR), 'BILL_ALREADY_CONFIRMED');

  // The receipt and its movements are immutable: reversal compensates.
  const recBefore = (await db.collection('goods_receipts').doc(ackedReceipt.receipt_id).get()).data();
  const movsBefore = await getGoodsReceiptItemsFirestore(ackedReceipt.receipt_id);
  const stockBefore = await stockOf(productId);

  const rev = await DirectReceiptService.reverseDirect(ackedReceipt.receipt_id, {
    idempotency_key: `${TAG}_rev_${uid()}`, reason: 'Goods returned to the supplier the same evening'
  }, ACTOR);
  created.reversals.push(rev.reversal.reversal_id);
  created.movements.push(...(rev.reversal.stock_movement_ids || []));
  created.audits.push(`audit_inv_drrev_${ackedReceipt.receipt_id}`);

  const recAfter = (await db.collection('goods_receipts').doc(ackedReceipt.receipt_id).get()).data();
  ok('reversal does NOT edit the original receipt\'s quantities',
    recAfter.total_received_quantity === recBefore.total_received_quantity,
    `${recBefore.total_received_quantity} → ${recAfter.total_received_quantity}`);
  ok('  nor its receipt number', recAfter.receipt_number === recBefore.receipt_number);

  const movsAfter = await getGoodsReceiptItemsFirestore(ackedReceipt.receipt_id);
  ok('  the original receipt items are unchanged',
    JSON.stringify(movsAfter.map(m => m.received_quantity)) ===
    JSON.stringify(movsBefore.map(m => m.received_quantity)));

  ok('  stock is compensated back down', await stockOf(productId) === stockBefore - 2,
    `${stockBefore} → ${await stockOf(productId)}`);

  const compensating = rev.reversal.stock_movement_ids || [];
  ok('  the reversal created NEW compensating movements', compensating.length > 0, String(compensating.length));
  const cm = await db.collection('inventory_stock_movements').doc(compensating[0]).get();
  ok('  the compensating movement is typed REVERSAL', cm.data()?.movement_type === 'REVERSAL', cm.data()?.movement_type);

  // The original movement document is untouched.
  const origMov = created.movements[0];
  const om = await db.collection('inventory_stock_movements').doc(origMov).get();
  ok('  the ORIGINAL movement still exists and is not rewritten',
    om.exists && om.data().movement_type === 'RECEIPT', om.data()?.movement_type);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 7. DISCARD SAFETY ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const bill = await mkBill();
  await replaceInventoryBillLinesFirestore(bill.id, [
    { line_no: 1, description: 'Tomatoes', quantity: 3, unit: 'KG', raw_text: 'Tomatoes 3 KG' },
    { line_no: 2, description: 'Rice', quantity: 1, unit: 'KG', raw_text: 'Rice 1 KG' }
  ]);
  const lineIds = [formatBillLineDocId(bill.id, 1), formatBillLineDocId(bill.id, 2)];
  created.billLines.push(...lineIds);

  ok('a draft bill can carry lines', (await getInventoryBillLinesFirestore(bill.id)).length === 2);

  const stockBefore = await stockOf(productId);
  const movBefore = await countOf(db.collection('inventory_stock_movements'));
  const grBefore = await countOf(db.collection('goods_receipts'));
  const poBefore = await countOf(db.collection('purchase_orders'));

  const res = await discardInventoryBillFirestore(bill.id, ACTOR);
  ok('an unconfirmed bill can be discarded', res.status === BILL_STATUS.DISCARDED, res.status);
  ok('  its lines are removed', (await getInventoryBillLinesFirestore(bill.id)).length === 0);
  for (const lid of lineIds) {
    const g = await db.collection(BILL_LINES_COLLECTION).doc(lid).get();
    ok(`  line ${lid.slice(-4)} is really gone from Firestore`, !g.exists);
  }
  ok('  discard touched NO stock', await stockOf(productId) === stockBefore);
  ok('  discard created NO stock movement',
    await countOf(db.collection('inventory_stock_movements')) === movBefore);
  ok('  discard touched NO goods receipt',
    await countOf(db.collection('goods_receipts')) === grBefore);
  ok('  discard touched NO purchase order',
    await countOf(db.collection('purchase_orders')) === poBefore);
  ok('  the bill document itself survives as a record',
    !!(await getInventoryBillByIdFirestore(bill.id)));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 8. BILL → RECEIPT TRACEABILITY ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const bill = await mkBill();
  const r = await DirectReceiptService.confirmFromBill(bill.id, {
    idempotency_key: `${TAG}_trace_${uid()}`, supplier_id: supplierId, location_id: locationId,
    invoice_number: bill.invoice_number, invoice_date: FIXED_DATE, lines: LINES
  }, ACTOR);
  trackReceipt(r);

  const receiptDoc = (await db.collection('goods_receipts').doc(r.receipt.receipt_id).get()).data();
  const billDoc = await getInventoryBillByIdFirestore(bill.id);

  ok('bill → receipt: the bill points at a receipt that exists',
    billDoc.receipt_id === r.receipt.receipt_id);
  ok('receipt → bill: the receipt points back at the bill', receiptDoc.bill_id === bill.id);
  ok('  a direct receipt has no purchase order', receiptDoc.po_id === null, String(receiptDoc.po_id));

  const items = await getGoodsReceiptItemsFirestore(r.receipt.receipt_id);
  ok('receipt → items: every item points at its receipt',
    items.length > 0 && items.every(i => i.receipt_id === r.receipt.receipt_id), String(items.length));

  for (const i of r.items || []) {
    const m = await db.collection('inventory_stock_movements').doc(i.stock_movement_id).get();
    ok('  item → movement: the movement exists', m.exists, i.stock_movement_id);
    ok('    and references the receipt',
      String(m.data()?.reference_id) === String(r.receipt.receipt_id), String(m.data()?.reference_id));
    ok('    and is typed RECEIPT', m.data()?.movement_type === 'RECEIPT');
  }

  // No orphans among what this suite made.
  const orphanItems = [];
  for (const id of created.items) {
    const it = await db.collection('goods_receipt_items').doc(id).get();
    if (!it.exists) continue;
    const parent = await db.collection('goods_receipts').doc(it.data().receipt_id).get();
    if (!parent.exists) orphanItems.push(id);
  }
  ok('no orphan receipt items exist for this suite', orphanItems.length === 0, orphanItems.join(','));

  const orphanMovs = [];
  for (const id of created.movements) {
    const m = await db.collection('inventory_stock_movements').doc(id).get();
    if (!m.exists) continue;
    const ref = m.data().reference_id;
    if (!ref) continue;
    const parent = await db.collection('goods_receipts').doc(String(ref)).get();
    if (!parent.exists) orphanMovs.push(id);
  }
  ok('no orphan stock movements exist for this suite', orphanMovs.length === 0, orphanMovs.join(','));
}

// ═════════════════════════════════════════════════════════════════════════════
// =============================================================================
console.log('\n\u2550\u2550\u2550 9. PURCHASE-ORDER PATH \u2014 SAME PROTECTION, REAL ORDER \u2550\u2550\u2550\n');
// =============================================================================
const approvalConfigBefore = await getInventoryApprovalConfigFirestore().catch(() => null);
{
  const requester = { uid: `${TAG}_chef`, name: 'H7 Chef', role: 'kitchen' };
  const approver = { uid: `${TAG}_admin`, name: 'H7 Admin', role: 'admin' };
  await updateInventoryApprovalConfigFirestore({ enabled: true, allowed_roles: ['admin', 'super_admin'] });

  /** The real chain: request -> submit -> approve -> order -> issue. */
  const issuedOrder = async (qty) => {
    const draft = await PurchaseRequestService.createDraft({
      location_id: locationId, department: 'KITCHEN', reason: 'H7 purchase-order path',
      items: [{ product_id: productId, requested_quantity: qty }]
    }, requester);
    created.requests.push(draft.request.id);
    await PurchaseRequestService.submit(draft.request.id, requester);
    await PurchaseRequestApprovalService.approve(draft.request.id, 'approved for H7', approver);
    const po = await PurchaseOrderService.createFromRequest(draft.request.id, approver);
    created.orders.push(po.order.id);
    await PurchaseOrderService.issue(po.order.id, approver);
    return await PurchaseOrderService.getById(po.order.id);
  };

  // A. The full traceability chain.
  {
    const order = await issuedOrder(5);
    ok('a real purchase order was issued through the approval chain', !!order.id, order.po_number);

    const bill = await mkBill();
    const before = await stockOf(productId);
    const r = await BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: `${TAG}_po_${uid()}`, po_id: order.id,
      lines: [{ product_id: productId, quantity: 5 }]
    }, ACTOR);
    created.receipts.push(r.receipt.receipt_id);
    created.audits.push(`audit_inv_billpo_${r.receipt.receipt_id}`, `audit_inv_dupovr_${r.receipt.receipt_id}`);
    for (const it of await getGoodsReceiptItemsFirestore(r.receipt.receipt_id)) {
      created.items.push(it.id);
      if (it.stock_movement_id) created.movements.push(it.stock_movement_id);
    }

    ok('PO confirmation posts stock', await stockOf(productId) === before + 5,
      `${before} -> ${await stockOf(productId)}`);

    const billDoc = await getInventoryBillByIdFirestore(bill.id);
    ok('  the bill is CONFIRMED in PO mode', billDoc.status === BILL_STATUS.CONFIRMED && billDoc.mode === 'PO');
    ok('  the bill points at the receipt', billDoc.receipt_id === (r.receipt.receipt_id || r.receipt.id));
    ok('  the bill points at the order', billDoc.po_id === order.id);

    const receiptDoc = (await db.collection('goods_receipts').doc(r.receipt.receipt_id).get()).data();
    ok('request -> order -> bill -> receipt: the receipt names the order',
      receiptDoc.po_id === order.id, String(receiptDoc.po_id));

    const items = await getGoodsReceiptItemsFirestore(r.receipt.receipt_id);
    ok('receipt -> items: items exist and name the receipt',
      items.length > 0 && items.every(i => i.receipt_id === r.receipt.receipt_id), String(items.length));
    for (const it of items) {
      const m = await db.collection('inventory_stock_movements').doc(it.stock_movement_id).get();
      ok('  item -> movement: the movement exists', m.exists, it.stock_movement_id);
      ok('    and is typed RECEIPT', m.data()?.movement_type === 'RECEIPT');
    }

    const orderAfter = await PurchaseOrderService.getById(order.id);
    ok('order -> cumulative received quantity was updated',
      Number(orderAfter.items?.[0]?.received_quantity) === 5,
      String(orderAfter.items?.[0]?.received_quantity));
  }

  // B. Concurrent PO confirmations of ONE bill.
  {
    const order = await issuedOrder(9);
    const bill = await mkBill();
    const before = await stockOf(productId);
    const movBefore = await countOf(db.collection('inventory_stock_movements'));

    const mk = () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: `${TAG}_poconc_${uid()}`, po_id: order.id,
      lines: [{ product_id: productId, quantity: 3 }]
    }, ACTOR);

    const settled = await Promise.allSettled([mk(), mk(), mk()]);
    const winners = settled.filter(x => x.status === 'fulfilled' && x.value?.duplicate === false);
    for (const w of winners) {
      created.receipts.push(w.value.receipt.receipt_id);
      created.audits.push(`audit_inv_billpo_${w.value.receipt.receipt_id}`);
      for (const it of await getGoodsReceiptItemsFirestore(w.value.receipt.receipt_id)) {
        created.items.push(it.id);
        if (it.stock_movement_id) created.movements.push(it.stock_movement_id);
      }
    }

    ok('3. exactly one of three concurrent PO confirmations wins',
      winners.length === 1, `${winners.length} winner(s)`);
    ok('  stock rose by exactly ONE receipt', await stockOf(productId) === before + 3,
      `${before} -> ${await stockOf(productId)}`);
    ok('  exactly one movement was created',
      await countOf(db.collection('inventory_stock_movements')) === movBefore + 1);
    ok('  the losers were refused, not silently dropped',
      settled.filter(x => x.status === 'rejected').every(x => x.reason?.code === 'BILL_ALREADY_CONFIRMED'),
      settled.filter(x => x.status === 'rejected').map(x => x.reason?.code).join(','));
  }

  // C. A refused engine call must release the claim.
  {
    const order = await issuedOrder(4);
    const bill = await mkBill();
    const statusBefore = (await getInventoryBillByIdFirestore(bill.id)).status;
    const stockBefore = await stockOf(productId);

    // Over-receipt without a variance reason is refused by the Phase F engine,
    // which runs AFTER the claim has been taken.
    await expectFail('an engine refusal does not leave the bill confirmed',
      () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
        idempotency_key: `${TAG}_porel_${uid()}`, po_id: order.id,
        lines: [{ product_id: productId, quantity: 400 }]
      }, ACTOR));

    const after = await getInventoryBillByIdFirestore(bill.id);
    ok('  the claim was released and the bill is receivable again',
      after.status === statusBefore && !after.receipt_id, `${statusBefore} -> ${after.status}`);
    ok('  no stock moved', await stockOf(productId) === stockBefore);

    const r = await BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: `${TAG}_poretry_${uid()}`, po_id: order.id,
      lines: [{ product_id: productId, quantity: 4 }]
    }, ACTOR);
    created.receipts.push(r.receipt.receipt_id);
    created.audits.push(`audit_inv_billpo_${r.receipt.receipt_id}`);
    for (const it of await getGoodsReceiptItemsFirestore(r.receipt.receipt_id)) {
      created.items.push(it.id);
      if (it.stock_movement_id) created.movements.push(it.stock_movement_id);
    }
    ok('  the released bill can then be received normally', !r.duplicate && !!r.receipt.receipt_id);
  }

  // D. The duplicate gate applies on the PO path too.
  {
    const order = await issuedOrder(2);
    const bill = await mkBill({ invoice: null });
    const stockBefore = await stockOf(productId);
    await expectFail('a PO confirmation is gated by the same duplicate signals',
      () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
        idempotency_key: `${TAG}_podup_${uid()}`, po_id: order.id,
        lines: [{ product_id: productId, quantity: 2 }]
      }, ACTOR), 'DUPLICATE_ACK_REQUIRED');
    ok('  the refused PO confirmation moved no stock', await stockOf(productId) === stockBefore);
    ok('  and left the bill unconfirmed',
      (await getInventoryBillByIdFirestore(bill.id)).status !== BILL_STATUS.CONFIRMED);
  }
}

console.log('\n═══ 9. CLEANUP — AND PROOF IT WORKED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  // Bill lines for every bill, in case a test created some without recording them.
  for (const bid of [...new Set(created.bills)]) {
    const lines = await getInventoryBillLinesFirestore(bid).catch(() => []);
    created.billLines.push(...lines.map(l => l.id));
  }

  const del = async (col, ids) => {
    for (const id of [...new Set(ids)]) {
      try { await db.collection(col).doc(id).delete(); } catch { /* proven below */ }
    }
  };
  await del('inventory_stock_movements', created.movements);
  await del('goods_receipt_items', created.items);
  await del('goods_receipt_reversals', created.reversals);
  await del('goods_receipts', created.receipts);
  await del(BILL_LINES_COLLECTION, created.billLines);
  await del(BILLS_COLLECTION, created.bills);
  await del('inventory_products', created.products);
  await del('inventory_suppliers', created.suppliers);
  await del('inventory_locations', created.locations);
  await del('audit_logs', created.audits);
  for (const id of [...new Set(created.orders)]) {
    await deletePurchaseOrderCascadeFirestore(id).catch(() => {});
  }
  for (const id of [...new Set(created.requests)]) {
    await deletePurchaseRequestCascadeFirestore(id).catch(() => {});
  }
  // The approval configuration is shared DEV state, not this suite's to keep.
  if (approvalConfigBefore) {
    await updateInventoryApprovalConfigFirestore({
      enabled: approvalConfigBefore.enabled,
      allowed_roles: approvalConfigBefore.allowed_roles
    }).catch(() => {});
  }

  // Audit records this suite wrote through the controller helper carry a
  // timestamped id, so they are found by actor rather than by a known id.
  const byActor = await db.collection('audit_logs').where('user_id', '==', ACTOR.uid).get();
  for (const d of byActor.docs) await d.ref.delete();

  // ── The proof. Every recorded id is re-read. ─────────────────────────────
  const stillThere = [];
  const check = async (col, ids) => {
    for (const id of [...new Set(ids)]) {
      const d = await db.collection(col).doc(id).get();
      if (d.exists) stillThere.push(`${col}/${id}`);
    }
  };
  await check('inventory_stock_movements', created.movements);
  await check('goods_receipt_items', created.items);
  await check('goods_receipt_reversals', created.reversals);
  await check('goods_receipts', created.receipts);
  await check(BILL_LINES_COLLECTION, created.billLines);
  await check(BILLS_COLLECTION, created.bills);
  await check('inventory_products', created.products);
  await check('inventory_suppliers', created.suppliers);
  await check('inventory_locations', created.locations);
  await check('purchase_orders', created.orders);
  await check('purchase_requests', created.requests);

  ok('every document this suite created is re-read and confirmed gone',
    stillThere.length === 0, stillThere.slice(0, 6).join(', ') || 'none');

  const after = {
    movements: await countOf(db.collection('inventory_stock_movements')),
    receipts: await countOf(db.collection('goods_receipts')),
    items: await countOf(db.collection('goods_receipt_items')),
    bills: await countOf(db.collection('inventory_bills')),
    billLines: await countOf(db.collection('inventory_bill_lines')),
    orders: await countOf(db.collection('purchase_orders'))
  };
  console.log(`\n  AFTER  movements=${after.movements} receipts=${after.receipts} items=${after.items} ` +
              `bills=${after.bills} billLines=${after.billLines} orders=${after.orders}`);
  for (const k of Object.keys(after)) {
    ok(`DEV ${k} returned to baseline`, after[k] === baseline[k], `${baseline[k]} → ${after[k]}`);
  }

  const finalStock = await stockOf(productId);
  ok('the test product is gone, so it holds no stock', finalStock === 0, String(finalStock));
}

console.log(`\n═══ H7 RESULT: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed checks:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail === 0 ? 0 : 1);
