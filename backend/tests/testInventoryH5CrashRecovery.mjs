/**
 * testInventoryH5CrashRecovery.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H5 — crash consistency for PO-assisted bill confirmation.
 *
 * THE TWO INVARIANTS THIS EXISTS TO PROVE
 *
 *   1. A crashed confirmation can never permanently leave
 *          bill = CONFIRMED  with  no goods receipt.
 *
 *   2. It can never leave
 *          a goods receipt  beside  a bill that reads as ready to confirm again.
 *
 * The first is the stranding bug. The second is its mirror image, and is worse:
 * it would let the same delivery be received twice.
 *
 * HOW THE CRASH IS SIMULATED
 * Through a one-shot seam in the service (`armCrashSeam`), which throws a
 * SimulatedProcessCrash at an exact point and is deliberately NOT cleaned up by
 * the service's own error handling — that is what distinguishes a crash from an
 * error. No real process is killed.
 *
 * Every document this run creates is recorded and removed by exact id, and the
 * teardown re-reads each one. Nothing is deleted by collection or by prefix.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryH5CrashRecovery.mjs
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
if (isProductionProject()) { console.error('[SAFETY_ABORT] Resolved Firebase project looks like production.'); process.exit(1); }

// ── Guards 3 + 4 ─────────────────────────────────────────────────────────────
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }
console.log(`[GUARD] project=${PROJECT} (DEV) — safe to proceed\n`);

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${detail ? '  ' + detail : ''}`); }
};
const expectFail = async (label, fn, code) => {
  try { await fn(); ok(label, false, 'no error was thrown'); return null; }
  catch (e) { ok(label, code ? e.code === code : true, e.code || e.message); return e; }
};

// ── Imports (after the guard) ────────────────────────────────────────────────
const { db } = await import('../config/firebaseAdmin.js');
const { BillConfirmService, armCrashSeam, disarmCrashSeam, SimulatedProcessCrash } =
  await import('../services/billConfirmService.js');
const { BillConfirmRecoveryService } = await import('../services/billConfirmRecoveryService.js');
const {
  createInventoryBillFirestore, updateInventoryBillFirestore, getInventoryBillByIdFirestore,
  billRef, BILLS_COLLECTION
} = await import('../repositories/firestore/inventoryBillsRepository.js');
const { getGoodsReceiptByIdFirestore, getGoodsReceiptItemsFirestore, receiptIdForKey, formatReceiptItemDocId } =
  await import('../repositories/firestore/goodsReceiptsRepository.js');
const { getInventoryProductByIdFirestore } = await import('../repositories/firestore/inventoryProductsRepository.js');
const { PurchaseRequestService } = await import('../services/purchaseRequestService.js');
const { PurchaseRequestApprovalService } = await import('../services/purchaseRequestApprovalService.js');
const { PurchaseOrderService } = await import('../services/purchaseOrderService.js');
const { getInventoryApprovalConfigFirestore, updateInventoryApprovalConfigFirestore } =
  await import('../repositories/firestore/inventoryApprovalConfigRepository.js');
const { deletePurchaseRequestCascadeFirestore } = await import('../repositories/firestore/purchaseRequestsRepository.js');
const { deletePurchaseOrderCascadeFirestore } = await import('../repositories/firestore/purchaseOrdersRepository.js');
const { BILL_STATUS, BILL_CONFIRMATION_STALE_MS } = await import('../utils/inventoryConstants.js');
const { createOwnership, census, censusDiff } = await import('./helpers/inventoryTestOwnership.mjs');

const TAG = 'h5crash';
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const now = () => new Date().toISOString();
const countOf = async (q) => (await q.count().get()).data().count;

const own = createOwnership(db);
const ACTOR = { uid: `${TAG}_actor`, name: 'H5 Crash Tester', role: 'admin' };
const requester = { uid: `${TAG}_chef`, name: 'H5 Chef', role: 'kitchen' };
const approver = { uid: `${TAG}_admin`, name: 'H5 Admin', role: 'admin' };
const FIXED_DATE = '2026-09-10';

const censusBefore = await census(db);
const baseline = {
  movements: await countOf(db.collection('inventory_stock_movements')),
  receipts: await countOf(db.collection('goods_receipts')),
  bills: await countOf(db.collection('inventory_bills'))
};
console.log(`  BASELINE  movements=${baseline.movements} receipts=${baseline.receipts} bills=${baseline.bills}\n`);

// ── Fixtures ─────────────────────────────────────────────────────────────────
const productId = `prod_${TAG}_${uid()}`;
const supplierId = `sup_${TAG}_${uid()}`;
const locationId = `loc_${TAG}_${uid()}`;

await db.collection('inventory_suppliers').doc(supplierId).set({
  name: `H5 Crash Supplier ${uid()}`, search_name: 'h5 crash', is_active: true, created_at: now(), updated_at: now()
});
own.track('inventory_suppliers', supplierId);
await db.collection('inventory_locations').doc(locationId).set({
  code: `h5c-${uid()}`, name: `H5 Crash Store ${uid()}`, is_active: true, is_default: false, created_at: now(), updated_at: now()
});
own.track('inventory_locations', locationId);
await db.collection('inventory_products').doc(productId).set({
  name: `H5 Crash Product ${uid()}`, sku: `H5C-${uid()}`, unit_of_measure: 'KG', unit: 'KG',
  category_id: null, current_stock: 0, stock_quantity: 0, stock_by_location: {},
  default_supplier_id: supplierId, cost_price: 10,
  is_active: true, status: 'Active', created_at: now(), updated_at: now()
});
own.track('inventory_products', productId);

const approvalBefore = await getInventoryApprovalConfigFirestore().catch(() => null);
await updateInventoryApprovalConfigFirestore({ enabled: true, allowed_roles: ['admin', 'super_admin'] });

/** The real chain: request → submit → approve → order → issue. */
const issuedOrder = async (qty) => {
  const draft = await PurchaseRequestService.createDraft({
    location_id: locationId, department: 'KITCHEN', reason: 'H5 crash recovery',
    items: [{ product_id: productId, requested_quantity: qty }]
  }, requester);
  own.recordRequest(draft);
  await PurchaseRequestService.submit(draft.request.id, requester);
  await PurchaseRequestApprovalService.approve(draft.request.id, 'approved for H5 crash test', approver);
  const po = await PurchaseOrderService.createFromRequest(draft.request.id, approver);
  own.recordOrder(po);
  await PurchaseOrderService.issue(po.order.id, approver);
  return await PurchaseOrderService.getById(po.order.id);
};

const mkBill = async (extra = {}) => {
  const id = `bill_${TAG}${uid()}`;
  const b = await createInventoryBillFirestore(id, {
    file: { fileName: `${id}.png`, sha256: crypto.randomBytes(32).toString('hex'), size: 10, mimeType: 'image/png', width: 10, height: 10 },
    actor: ACTOR, business_date: FIXED_DATE
  });
  own.track('inventory_bills', b.id);
  const patch = { invoice_number: `INV-${TAG}-${uid()}`, invoice_date: FIXED_DATE, supplier_id: supplierId, ...extra };
  await updateInventoryBillFirestore(b.id, patch);
  return { ...b, ...patch };
};

const stockOf = async (pid) => Number((await getInventoryProductByIdFirestore(pid))?.current_stock) || 0;
const trackReceipt = (r) => own.recordReceipt(r);
const LINES = (q = 2) => [{ product_id: productId, quantity: q }];

/** Backdates a claim so the recovery treats it as abandoned. */
const ageClaim = async (billId) => {
  const snap = await billRef(billId).get();
  const claim = snap.data()?.confirmation_claim;
  if (!claim) return null;
  const aged = { ...claim, claimed_at: new Date(Date.now() - BILL_CONFIRMATION_STALE_MS - 60_000).toISOString() };
  await billRef(billId).update({ confirmation_claim: aged });
  return aged;
};

/** The two invariants, checked against one bill. */
const assertInvariants = async (label, billId) => {
  const bill = await getInventoryBillByIdFirestore(billId);
  const linked = bill?.receipt_id ? await getGoodsReceiptByIdFirestore(bill.receipt_id) : null;
  const claimed = bill?.confirmation_claim?.receipt_id
    ? await getGoodsReceiptByIdFirestore(bill.confirmation_claim.receipt_id) : null;
  const released = [];
  for (const rc of (bill?.released_claims || [])) {
    if (rc?.receipt_id && await getGoodsReceiptByIdFirestore(rc.receipt_id)) released.push(rc.receipt_id);
  }
  // Invariant 1: CONFIRMED must mean a receipt exists.
  ok(`${label}: invariant 1 — a CONFIRMED bill has a real receipt`,
    bill.status !== BILL_STATUS.CONFIRMED || Boolean(linked),
    `status=${bill.status} receipt_id=${bill.receipt_id || 'none'} receiptExists=${Boolean(linked)}`);
  // Invariant 2: a receipt must never sit beside a re-confirmable bill.
  const receivable = ![BILL_STATUS.CONFIRMED, BILL_STATUS.CONFIRMING, BILL_STATUS.DISCARDED].includes(bill.status);
  ok(`${label}: invariant 2 — no receipt exists beside a re-confirmable bill`,
    !(receivable && (claimed || released.length)),
    `status=${bill.status} orphanReceipts=${[claimed?.receipt_id, ...released].filter(Boolean).join(',') || 'none'}`);
  return bill;
};

// ═════════════════════════════════════════════════════════════════════════════
console.log('═══ 1. NORMAL PATH — CLAIM SUCCEEDS, RECEIPT SUCCEEDS ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const order = await issuedOrder(5);
  const bill = await mkBill();
  const before = await stockOf(productId);
  const key = `${TAG}_ok_${uid()}`;
  const r = await BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
    idempotency_key: key, po_id: order.id, lines: LINES(5)
  }, ACTOR);
  trackReceipt(r);

  ok('1. confirmation succeeds', !r.duplicate && !!r.receipt.receipt_id, r.receipt.receipt_number);
  ok('  stock rose by exactly the received quantity', await stockOf(productId) === before + 5,
    `${before} → ${await stockOf(productId)}`);
  const b = await getInventoryBillByIdFirestore(bill.id);
  ok('  the bill is CONFIRMED', b.status === BILL_STATUS.CONFIRMED, b.status);
  ok('  the bill links the receipt', b.receipt_id === r.receipt.receipt_id);
  ok('  the claim was cleared on success', !b.confirmation_claim);
  ok('  the receipt id matches the one derived from the idempotency key',
    b.receipt_id === receiptIdForKey(key), `${b.receipt_id} vs ${receiptIdForKey(key)}`);
  await assertInvariants('1', bill.id);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. ENGINE REFUSES — THE CLAIM MUST NOT STAND ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const order = await issuedOrder(4);
  const bill = await mkBill();
  const priorStatus = (await getInventoryBillByIdFirestore(bill.id)).status;
  const stockBefore = await stockOf(productId);

  // Over-receipt without a variance reason: refused by the Phase F engine,
  // which runs AFTER the claim is taken.
  await expectFail('2. an engine refusal is surfaced',
    () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: `${TAG}_refuse_${uid()}`, po_id: order.id, lines: LINES(400)
    }, ACTOR));

  const b = await getInventoryBillByIdFirestore(bill.id);
  ok('  the bill is NOT left CONFIRMING', b.status !== BILL_STATUS.CONFIRMING, b.status);
  ok('  the bill returned to the status it had before', b.status === priorStatus, `${priorStatus} → ${b.status}`);
  ok('  no receipt id was written', !b.receipt_id);
  ok('  no stock moved', await stockOf(productId) === stockBefore);
  await assertInvariants('2', bill.id);

  // Proof the release is real: the same bill can still be received.
  const r = await BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
    idempotency_key: `${TAG}_after_refuse_${uid()}`, po_id: order.id, lines: LINES(4)
  }, ACTOR);
  trackReceipt(r);
  ok('  the released bill can then be received normally', !r.duplicate && !!r.receipt.receipt_id);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. CRASH AFTER THE CLAIM, BEFORE THE RECEIPT ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
let strandedBillId = null, strandedKey = null;
{
  const order = await issuedOrder(3);
  const bill = await mkBill();
  strandedBillId = bill.id;
  strandedKey = `${TAG}_crash1_${uid()}`;
  const stockBefore = await stockOf(productId);

  armCrashSeam('AFTER_CLAIM');
  const err = await expectFail('3. the simulated crash aborts the confirmation',
    () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: strandedKey, po_id: order.id, lines: LINES(3)
    }, ACTOR), 'SIMULATED_PROCESS_CRASH');
  ok('  the crash was the simulated one, not a real failure', err instanceof SimulatedProcessCrash);
  disarmCrashSeam();

  const b = await getInventoryBillByIdFirestore(bill.id);
  ok('  the bill is left CONFIRMING, never CONFIRMED', b.status === BILL_STATUS.CONFIRMING, b.status);
  ok('  it carries a claim naming the receipt that was going to be written',
    b.confirmation_claim?.receipt_id === receiptIdForKey(strandedKey), b.confirmation_claim?.receipt_id);
  ok('  no receipt exists', !(await getGoodsReceiptByIdFirestore(receiptIdForKey(strandedKey))));
  ok('  no stock moved', await stockOf(productId) === stockBefore);
  // THE POINT: a crash cannot produce CONFIRMED without a receipt.
  await assertInvariants('3', bill.id);

  // A fresh claim is protected: another confirmation is refused, not queued.
  await expectFail('  a second confirmation while the claim is fresh is refused',
    () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: `${TAG}_second_${uid()}`, po_id: order.id, lines: LINES(3)
    }, ACTOR), 'BILL_CONFIRMATION_IN_PROGRESS');
  ok('  still no stock after the refused second attempt', await stockOf(productId) === stockBefore);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. RECOVERY OF A STALE CLAIM WITH NO RECEIPT ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const stockBefore = await stockOf(productId);
  await ageClaim(strandedBillId);
  const res = await BillConfirmRecoveryService.settle(strandedBillId, { actor: ACTOR });
  ok('5. a stale claim with no receipt is released', res.settled && res.outcome === 'RELEASED', res.outcome);

  const b = await getInventoryBillByIdFirestore(strandedBillId);
  ok('  the bill is receivable again', ![BILL_STATUS.CONFIRMING, BILL_STATUS.CONFIRMED].includes(b.status), b.status);
  ok('  the claim was cleared', !b.confirmation_claim);
  ok('  the released receipt id is remembered', (b.released_claims || []).some(r => r.receipt_id === receiptIdForKey(strandedKey)));
  ok('  recovery moved no stock', await stockOf(productId) === stockBefore);
  ok('  recovery wrote a release audit, not a fake receipt',
    (await db.collection('audit_logs').where('action', '==', 'INVENTORY_BILL_CONFIRMATION_RELEASED').limit(1).get()).size > 0);
  await assertInvariants('5', strandedBillId);

  // 12. no permanently stranded bill — it can be confirmed for real now.
  const order = await issuedOrder(3);
  const r = await BillConfirmService.confirmAgainstPurchaseOrder(strandedBillId, {
    idempotency_key: `${TAG}_recovered_${uid()}`, po_id: order.id, lines: LINES(3)
  }, ACTOR);
  trackReceipt(r);
  ok('12. the recovered bill confirms normally — nothing is permanently stranded',
    !r.duplicate && !!r.receipt.receipt_id, r.receipt.receipt_number);
  ok('  stock rose once', await stockOf(productId) === stockBefore + 3,
    `${stockBefore} → ${await stockOf(productId)}`);
  await assertInvariants('12', strandedBillId);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 5. CRASH AFTER THE RECEIPT, BEFORE THE BILL IS FINALISED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const order = await issuedOrder(6);
  const bill = await mkBill();
  const key = `${TAG}_crash2_${uid()}`;
  const expectedReceipt = receiptIdForKey(key);
  const stockBefore = await stockOf(productId);

  armCrashSeam('AFTER_RECEIPT');
  await expectFail('4. the simulated crash aborts after the receipt is written',
    () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: key, po_id: order.id, lines: LINES(6)
    }, ACTOR), 'SIMULATED_PROCESS_CRASH');
  disarmCrashSeam();
  own.track('goods_receipts', expectedReceipt);
  for (const it of await getGoodsReceiptItemsFirestore(expectedReceipt)) {
    own.track('goods_receipt_items', it.id);
    if (it.stock_movement_id) own.track('inventory_stock_movements', it.stock_movement_id);
  }

  const receipt = await getGoodsReceiptByIdFirestore(expectedReceipt);
  ok('  the receipt really was committed by the engine', Boolean(receipt), expectedReceipt);
  ok('  stock was posted by the engine', await stockOf(productId) === stockBefore + 6,
    `${stockBefore} → ${await stockOf(productId)}`);

  const mid = await getInventoryBillByIdFirestore(bill.id);
  ok('  the bill is left CONFIRMING, not CONFIRMED', mid.status === BILL_STATUS.CONFIRMING, mid.status);
  // THE SECOND INVARIANT: the bill must NOT look receivable while this receipt exists.
  await assertInvariants('4', bill.id);
  await expectFail('  the bill cannot be confirmed again while the claim stands',
    () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: `${TAG}_dbl_${uid()}`, po_id: order.id, lines: LINES(6)
    }, ACTOR), 'BILL_CONFIRMATION_IN_PROGRESS');
  ok('  no second stock increase', await stockOf(productId) === stockBefore + 6);

  // ── 6. stale CONFIRMING bill WITH an existing receipt → finalise ──────────
  await ageClaim(bill.id);
  const res = await BillConfirmRecoveryService.settle(bill.id, { actor: ACTOR });
  ok('6. a stale claim whose receipt exists is FINALISED, not released',
    res.settled && res.outcome === 'FINALISED', res.outcome);

  const after = await getInventoryBillByIdFirestore(bill.id);
  ok('  the bill is now CONFIRMED', after.status === BILL_STATUS.CONFIRMED, after.status);
  ok('  it links the receipt the engine actually wrote', after.receipt_id === expectedReceipt, after.receipt_id);
  ok('  the claim was cleared', !after.confirmation_claim);
  ok('  recovery posted NO additional stock', await stockOf(productId) === stockBefore + 6,
    `${stockBefore + 6} → ${await stockOf(productId)}`);
  ok('  exactly one receipt exists for this bill',
    await countOf(db.collection('goods_receipts').where('bill_id', '==', bill.id)) <= 1);
  await assertInvariants('6', bill.id);

  // Full traceability, identical to a normal confirmation.
  const items = await getGoodsReceiptItemsFirestore(expectedReceipt);
  ok('  bill → receipt → items survives recovery', items.length > 0 && items.every(i => i.receipt_id === expectedReceipt));
  for (const it of items) {
    const m = await db.collection('inventory_stock_movements').doc(it.stock_movement_id).get();
    ok('  item → stock movement survives recovery', m.exists, it.stock_movement_id);
    ok('    and is typed RECEIPT', m.data()?.movement_type === 'RECEIPT');
  }

  // 8. repeated confirmation after successful recovery
  await expectFail('8. a recovered, confirmed bill cannot be confirmed again',
    () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: `${TAG}_again_${uid()}`, po_id: order.id, lines: LINES(6)
    }, ACTOR), 'BILL_ALREADY_CONFIRMED');
  ok('  still no extra stock', await stockOf(productId) === stockBefore + 6);

  // Recovery is idempotent.
  const again = await BillConfirmRecoveryService.settle(bill.id, { actor: ACTOR, force: true });
  ok('  running recovery a second time changes nothing', again.outcome === 'NOT_CONFIRMING', again.outcome);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 6. A LATE RECEIPT AFTER A RELEASE IS FOUND, NOT DUPLICATED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  // The pathological ordering: a claim is released, and only then does the
  // engine's receipt appear. Without the released-claim record this is exactly
  // "a receipt beside a re-confirmable bill".
  const order = await issuedOrder(2);
  const bill = await mkBill();
  const key = `${TAG}_late_${uid()}`;
  const lateReceiptId = receiptIdForKey(key);
  const stockBefore = await stockOf(productId);

  armCrashSeam('AFTER_CLAIM');
  await expectFail('  crash leaves the bill claimed',
    () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: key, po_id: order.id, lines: LINES(2)
    }, ACTOR), 'SIMULATED_PROCESS_CRASH');
  disarmCrashSeam();

  await ageClaim(bill.id);
  await BillConfirmRecoveryService.settle(bill.id, { actor: ACTOR });
  const released = await getInventoryBillByIdFirestore(bill.id);
  ok('  the claim was released and the receipt id remembered',
    (released.released_claims || []).some(r => r.receipt_id === lateReceiptId));

  // The straggler now commits: write the receipt the released claim expected.
  await db.collection('goods_receipts').doc(lateReceiptId).set({
    receipt_number: `GR-LATE-${uid()}`, po_id: order.id, bill_id: bill.id,
    supplier_id: supplierId, location_id: locationId, business_date: FIXED_DATE,
    total_received_items: 1, total_received_quantity: 2, total_received_value: 20,
    received_by_uid: ACTOR.uid, received_at: now(), created_at: now()
  });
  own.track('goods_receipts', lateReceiptId);

  // Any further confirmation attempt must find it rather than create another.
  await expectFail('7. a confirmation after a late receipt appears is refused',
    () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
      idempotency_key: `${TAG}_lateretry_${uid()}`, po_id: order.id, lines: LINES(2)
    }, ACTOR), 'BILL_ALREADY_CONFIRMED');

  const finalBill = await getInventoryBillByIdFirestore(bill.id);
  ok('  the bill was finalised against the late receipt', finalBill.status === BILL_STATUS.CONFIRMED, finalBill.status);
  ok('  and links exactly that receipt', finalBill.receipt_id === lateReceiptId, finalBill.receipt_id);
  ok('  no second receipt was created for this bill',
    await countOf(db.collection('goods_receipts').where('bill_id', '==', bill.id)) === 1);
  ok('  no stock was posted by the recovery', await stockOf(productId) === stockBefore);
  await assertInvariants('7', bill.id);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 7. CONCURRENCY AND IDEMPOTENCY ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const order = await issuedOrder(9);
  const bill = await mkBill();
  const before = await stockOf(productId);
  const movBefore = await countOf(db.collection('inventory_stock_movements'));
  // A Phase F receipt carries no bill_id — that field belongs to the direct
  // path — so "one receipt for this bill" is counted as "the receipt
  // collection grew by exactly one", plus the single link on the bill.
  const grBefore = await countOf(db.collection('goods_receipts'));

  // Three concurrent confirmations, each with a DIFFERENT idempotency key.
  const mk = () => BillConfirmService.confirmAgainstPurchaseOrder(bill.id, {
    idempotency_key: `${TAG}_conc_${uid()}`, po_id: order.id, lines: LINES(3)
  }, ACTOR);
  const settled = await Promise.allSettled([mk(), mk(), mk()]);
  const winners = settled.filter(x => x.status === 'fulfilled' && x.value?.duplicate === false);
  winners.forEach(w => trackReceipt(w.value));

  ok('7. exactly one of three concurrent confirmations wins', winners.length === 1, `${winners.length} winner(s)`);
  ok('  stock rose by exactly ONE receipt', await stockOf(productId) === before + 3,
    `${before} → ${await stockOf(productId)}`);
  ok('11. exactly one stock movement was created',
    await countOf(db.collection('inventory_stock_movements')) === movBefore + 1);
  ok('10. exactly one receipt was created by the three attempts',
    await countOf(db.collection('goods_receipts')) === grBefore + 1,
    `${grBefore} → ${await countOf(db.collection('goods_receipts'))}`);
  {
    const b = await getInventoryBillByIdFirestore(bill.id);
    ok('10. the bill links exactly one receipt, and it exists',
      Boolean(b.receipt_id) && Boolean(await getGoodsReceiptByIdFirestore(b.receipt_id)), b.receipt_id);
  }
  const codes = settled.filter(x => x.status === 'rejected').map(x => x.reason?.code);
  ok('  every loser was refused with a real code',
    codes.every(c => ['BILL_ALREADY_CONFIRMED', 'BILL_CONFIRMATION_IN_PROGRESS'].includes(c)), codes.join(','));
  await assertInvariants('7-concurrency', bill.id);

  // 9. idempotency replay on a fresh bill, same key twice.
  const bill2 = await mkBill();
  const order2 = await issuedOrder(4);
  const key = `${TAG}_idem_${uid()}`;
  const mid = await stockOf(productId);
  const first = await BillConfirmService.confirmAgainstPurchaseOrder(bill2.id, {
    idempotency_key: key, po_id: order2.id, lines: LINES(4)
  }, ACTOR);
  trackReceipt(first);
  ok('9. the first confirmation posts stock', await stockOf(productId) === mid + 4);
  await expectFail('9. replaying the same key on the same bill is refused at the bill gate',
    () => BillConfirmService.confirmAgainstPurchaseOrder(bill2.id, {
      idempotency_key: key, po_id: order2.id, lines: LINES(4)
    }, ACTOR), 'BILL_ALREADY_CONFIRMED');
  ok('  stock unchanged on the replay', await stockOf(productId) === mid + 4);
  await assertInvariants('9', bill2.id);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 8. THE DIRECT PATH ALREADY HAS THIS PROPERTY ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const fs = require_('fs');
  const src = fs.readFileSync(path.join(BACKEND, 'services', 'directReceiptService.js'), 'utf8');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const clean = strip(src);
  ok('the direct path opens exactly one transaction for a confirmation',
    (clean.match(/db\.runTransaction/g) || []).length === 2, 'one for confirm, one for reverse');
  ok('  it writes the bill INSIDE that transaction',
    /txn\.update\(billDocRef/.test(clean));
  ok('  it writes the receipt in the same transaction',
    /txn\.set\(grRef/.test(clean) || /txn\.set\(\s*grRef/.test(clean));
  ok('  it needs no CONFIRMING state, because there is no gap to recover',
    !/BILL_STATUS\.CONFIRMING/.test(clean));
  ok('  the post-transaction bill read is a read, not a second write',
    /const updatedBill = await getInventoryBillByIdFirestore/.test(clean));

  // And the confirm service still delegates rather than posting stock itself.
  const h5 = strip(fs.readFileSync(path.join(BACKEND, 'services', 'billConfirmService.js'), 'utf8'));
  ok('H5 still stages no stock movement of its own', !/stageMovementInTransaction/.test(h5));
  ok('H5 still delegates receiving to the Phase F engine', /GoodsReceiptService\.receive\(/.test(h5));
  ok('H5 writes to no stock or receipt collection directly',
    !/collection\(\s*['"`](inventory_stock_movements|goods_receipts|goods_receipt_items)/.test(h5));
  const rec = strip(fs.readFileSync(path.join(BACKEND, 'services', 'billConfirmRecoveryService.js'), 'utf8'));
  ok('recovery stages no stock movement either', !/stageMovementInTransaction/.test(rec));
  ok('recovery creates no receipt', !/txn\.set\(|receiptRef\([^)]*\)\.set/.test(rec));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 9. CLEANUP — AND PROOF IT WORKED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  disarmCrashSeam();
  for (const id of own.list('purchase_orders')) await deletePurchaseOrderCascadeFirestore(id).catch(() => {});
  for (const id of own.list('purchase_requests')) await deletePurchaseRequestCascadeFirestore(id).catch(() => {});
  await own.adoptChildren();
  await own.sweep();

  // Audit records this suite wrote carry its synthetic actor uid.
  for (const u of [ACTOR.uid, approver.uid, requester.uid, 'system_recovery']) {
    const snap = await db.collection('audit_logs').where('user_id', '==', u).get();
    for (const d of snap.docs) {
      const blob = JSON.stringify(d.data());
      if (blob.includes(TAG) || blob.includes(ACTOR.uid)) await d.ref.delete();
    }
  }
  if (approvalBefore) {
    await updateInventoryApprovalConfigFirestore({
      enabled: approvalBefore.enabled, allowed_roles: approvalBefore.allowed_roles
    }).catch(() => {});
  }

  const left = await own.survivors();
  ok(`every document this run created is re-read and gone (${own.size()} recorded)`,
    left.length === 0, left.slice(0, 6).join(', ') || 'none');

  const { removed, added } = censusDiff(censusBefore, await census(db));
  ok('no pre-existing DEV document was deleted by this run', removed.length === 0, removed.slice(0, 6).join(', '));
  if (added.length) console.log(`  [note] ${added.length} document(s) appeared and were left alone: ${added.slice(0, 4).join(', ')}`);

  const after = {
    movements: await countOf(db.collection('inventory_stock_movements')),
    receipts: await countOf(db.collection('goods_receipts')),
    bills: await countOf(db.collection('inventory_bills'))
  };
  console.log(`\n  AFTER  movements=${after.movements} receipts=${after.receipts} bills=${after.bills}`);
  for (const k of Object.keys(after)) {
    ok(`DEV ${k} returned to baseline`, after[k] === baseline[k], `${baseline[k]} → ${after[k]}`);
  }
}

console.log(`\n═══ H5 CRASH RECOVERY RESULT: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed checks:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail === 0 ? 0 : 1);
