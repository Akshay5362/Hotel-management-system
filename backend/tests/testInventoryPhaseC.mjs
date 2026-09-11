/**
 * backend/tests/testInventoryPhaseC.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration test for HPMS Inventory Phase C — PURCHASE REQUEST APPROVAL
 * ENGINE. DEV Firestore (sky5-development) ONLY, behind the same fail-closed
 * quadruple guard as the other guarded suites, checked BEFORE firebaseAdmin.js
 * is imported.
 *
 * Unauthenticated 401s are verified over real HTTP against the running DEV
 * backend. Role-based 403s are verified at the service layer (the DEV
 * FIREBASE_WEB_API_KEY is a placeholder, so real ID tokens cannot be minted —
 * a pre-existing environment gap documented since Phase A).
 *
 * The central safety claim — approving or rejecting NEVER touches stock — is
 * proved by fingerprinting every product balance, stock_by_location map,
 * stock_quantity mirror and the ledger row count before and after each
 * decision.
 *
 * All synthetic data is removed afterwards. The persistent request-number
 * counter is intentionally NOT deleted (see the cleanup notes).
 *
 * Run: cross-env HPMS_ENV=development node backend/tests/testInventoryPhaseC.mjs
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
const { PurchaseRequestService } = await import('../services/purchaseRequestService.js');
const { PurchaseRequestApprovalService } = await import('../services/purchaseRequestApprovalService.js');
const { InventoryCutoverService } = await import('../services/inventoryCutoverService.js');
const {
  deletePurchaseRequestCascadeFirestore, getPurchaseRequestItemsFirestore, getPurchaseRequestByIdFirestore
} = await import('../repositories/firestore/purchaseRequestsRepository.js');
const { deleteInventoryProductFirestore } = await import('../repositories/firestore/inventoryProductsRepository.js');
const { getAllInventoryLocationsFirestore } = await import('../repositories/firestore/inventoryLocationsRepository.js');
const { getInventoryApprovalConfigFirestore } = await import('../repositories/firestore/inventoryApprovalConfigRepository.js');
const { PR_STATUS } = await import('../utils/inventoryConstants.js');

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5001/api';
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

/** Everything an approval decision must never change. */
async function stockFingerprint() {
  const prods = await db.collection('inventory_products').get();
  const movs = await db.collection('inventory_stock_movements').get();
  const balances = {};
  prods.docs.forEach(d => {
    const x = d.data();
    balances[d.id] = `${x.current_stock}|${x.stock_quantity}|${JSON.stringify(x.stock_by_location || {})}`;
  });
  return { movementCount: movs.size, balances: JSON.stringify(balances) };
}

async function itemsFingerprint(requestId) {
  const items = await getPurchaseRequestItemsFirestore(requestId);
  return JSON.stringify(items.map(i => ({
    id: i.id, product_id: i.product_id, qty: i.requested_quantity,
    unit: i.unit, total: i.estimated_total, name: i.product_name_snapshot
  })));
}

async function main() {
  console.log('═'.repeat(78));
  console.log('  INVENTORY PHASE C — APPROVAL ENGINE  (DEV: sky5-development)');
  console.log(`  run id: ${RUN_ID}`);
  console.log('═'.repeat(78));

  const cleanup = [];
  const requester = { uid: `phasectest_req_${RUN_ID}`, name: 'Phase C Requester', role: 'kitchen' };
  const approverA = { uid: `phasectest_apprA_${RUN_ID}`, name: 'Phase C Approver A', role: 'admin' };
  const approverB = { uid: `phasectest_apprB_${RUN_ID}`, name: 'Phase C Approver B', role: 'super_admin' };
  const unauthorized = { uid: `phasectest_unauth_${RUN_ID}`, name: 'Phase C Receptionist', role: 'receptionist' };
  // A requester who ALSO holds an approver role — proves self-approval is
  // blocked by identity, not merely by role.
  const requesterWhoIsAdmin = { uid: `phasectest_reqadmin_${RUN_ID}`, name: 'Phase C Requesting Admin', role: 'admin' };

  // ── approval configuration ──────────────────────────────────────────────
  console.log('\n── Approval configuration ────────────────────────────────────────────────────');
  const config = await getInventoryApprovalConfigFirestore({ skipCache: true });
  ok(config.enabled === true, 'Approval config resolves and is enabled');
  ok(Array.isArray(config.allowed_roles) && config.allowed_roles.includes('admin'),
    'Approver roles come from settings (default: administrators only)', JSON.stringify(config.allowed_roles));
  ok(!config.allowed_roles.includes('kitchen') && !config.allowed_roles.includes('receptionist'),
    'Approver set is NOT the Phase B REQUEST role set — raising ≠ approving');

  // ── fixtures ────────────────────────────────────────────────────────────
  console.log('\n── Fixtures ──────────────────────────────────────────────────────────────────');
  const { categories } = await InventoryCutoverService.getCategories();
  const category = categories[0];
  const locations = await getAllInventoryLocationsFirestore({ includeInactive: false });
  const location = locations.find(l => l.is_active !== false);
  ok(!!category && !!location, 'DEV master data available');

  const sku = `PHASE-C-TEST-${RUN_ID}`;
  const { product } = await InventoryCutoverService.createProduct({
    sku, name: `PHASE_C_TEST Product ${RUN_ID}`, category_id: category.id,
    unit_of_measure: 'KG', minimum_stock_level: 5, cost_price: 30,
    opening_stock: 12, opening_location_id: location.id
  }, { uid: requester.uid, name: requester.name });
  ok(product.current_stock === 12, 'Test product created with 12 KG stock');
  cleanup.push(async () => {
    const movs = await db.collection('inventory_stock_movements').where('product_id', '==', product.id).get();
    for (const d of movs.docs) await d.ref.delete();
    await deleteInventoryProductFirestore(product.id);
  });

  const baseReq = { location_id: location.id, department: 'KITCHEN', reason: 'Phase C test' };
  const newPending = async (who = requester) => {
    const created = await PurchaseRequestService.createDraft(
      { ...baseReq, items: [{ product_id: product.id, requested_quantity: 3 }] }, who);
    cleanup.push(() => deletePurchaseRequestCascadeFirestore(created.request.id));
    const submitted = await PurchaseRequestService.submit(created.request.id, who);
    return submitted.request;
  };

  const baseline = await stockFingerprint();
  console.log(`  baseline: ${baseline.movementCount} movements`);

  // ── 1/2. Unauthenticated over real HTTP ─────────────────────────────────
  console.log('\n── Unauthenticated (real HTTP) ───────────────────────────────────────────────');
  {
    const post = async (p) => (await fetch(`${API_BASE}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' })
    })).status;
    ok(await post('/inventory/purchase-requests/anything/approve') === 401, '1. Unauthenticated approve -> 401');
    ok(await post('/inventory/purchase-requests/anything/reject') === 401, '2. Unauthenticated reject -> 401');
  }

  // ── 3. Missing request ──────────────────────────────────────────────────
  console.log('\n── Authorization & preconditions ─────────────────────────────────────────────');
  await expectThrow(() => PurchaseRequestApprovalService.approve('pr_does_not_exist_at_all', null, approverA),
    '3. Approving a missing request -> REQUEST_NOT_FOUND', 'REQUEST_NOT_FOUND');
  await expectThrow(() => PurchaseRequestApprovalService.reject('pr_does_not_exist_at_all', 'because', approverA),
    '3. Rejecting a missing request -> REQUEST_NOT_FOUND', 'REQUEST_NOT_FOUND');

  // ── 4/5. DRAFT (non-PENDING) cannot be decided ──────────────────────────
  {
    const draft = await PurchaseRequestService.createDraft(
      { ...baseReq, items: [{ product_id: product.id, requested_quantity: 1 }] }, requester);
    cleanup.push(() => deletePurchaseRequestCascadeFirestore(draft.request.id));
    await expectThrow(() => PurchaseRequestApprovalService.approve(draft.request.id, null, approverA),
      '4. A DRAFT request cannot be approved', 'INVALID_STATUS_TRANSITION');
    // Use a VALID-length reason so this asserts the status guard rather than
    // the reason-length guard (payload validation runs first, before any read).
    await expectThrow(() => PurchaseRequestApprovalService.reject(draft.request.id, 'not ready yet', approverA),
      '5. A DRAFT request cannot be rejected', 'INVALID_STATUS_TRANSITION');
  }

  // ── 8/9. Self-approval ──────────────────────────────────────────────────
  {
    const own = await newPending(requesterWhoIsAdmin);   // requester holds an approver role
    await expectThrow(() => PurchaseRequestApprovalService.approve(own.id, null, requesterWhoIsAdmin),
      '8. Requester cannot approve their OWN request (even with an approver role)', 'PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN');
    await expectThrow(() => PurchaseRequestApprovalService.reject(own.id, 'mine', requesterWhoIsAdmin),
      '9. Requester cannot reject their own request', 'PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN');
    const still = await getPurchaseRequestByIdFirestore(own.id);
    ok(still.status === PR_STATUS.PENDING_APPROVAL, 'Self-approval attempts leave the request PENDING_APPROVAL');
  }

  // ── 10/11. Unauthorized role ────────────────────────────────────────────
  {
    const req = await newPending();
    await expectThrow(() => PurchaseRequestApprovalService.approve(req.id, null, unauthorized),
      '10. A receptionist (not an approver role) cannot approve', 'PURCHASE_REQUEST_APPROVAL_FORBIDDEN');
    await expectThrow(() => PurchaseRequestApprovalService.reject(req.id, 'nope', unauthorized),
      '11. A receptionist cannot reject', 'PURCHASE_REQUEST_APPROVAL_FORBIDDEN');
    await expectThrow(() => PurchaseRequestApprovalService.approve(req.id, null, { ...requester, role: 'kitchen' }),
      '10. The Phase B REQUEST role (kitchen) alone cannot approve', 'PURCHASE_REQUEST_APPROVAL_FORBIDDEN');
  }

  // ── 6/13/22/24/25/27/29/34/35. Approve ──────────────────────────────────
  console.log('\n── Approve ───────────────────────────────────────────────────────────────────');
  const approvedReq = await newPending();
  const itemsBeforeApprove = await itemsFingerprint(approvedReq.id);
  const numberBeforeApprove = approvedReq.request_number;
  {
    const res = await PurchaseRequestApprovalService.approve(approvedReq.id, 'Budget available', approverA);
    ok(res.duplicate === false, '6. An authorized approver can approve');
    ok(res.request.status === PR_STATUS.APPROVED, '13. PENDING_APPROVAL -> APPROVED');
    ok(!!res.request.approved_at && res.request.approved_by_uid === approverA.uid, 'approved_at / approved_by recorded');

    const rec = (res.request.approvals || []).find(a => a.approver_uid === approverA.uid);
    ok(!!rec && rec.action === 'APPROVED', '22. Approval record persisted in approvals[]');
    ok(rec.approver_name === approverA.name && rec.approver_role === 'admin' && rec.comment === 'Budget available',
      '22. Approval record snapshots approver name, role and comment');
    ok(rec.status_at_action === PR_STATUS.PENDING_APPROVAL, '22. Approval record captures the status at action time');

    const hist = res.request.status_history || [];
    ok(hist.some(h => h.status === PR_STATUS.APPROVED) && hist.some(h => h.status === PR_STATUS.PENDING_APPROVAL) && hist.some(h => h.status === PR_STATUS.DRAFT),
      '24. status_history preserved and appended (DRAFT → PENDING_APPROVAL → APPROVED)');

    ok(res.request.request_number === numberBeforeApprove,
      '34/35. Request number unchanged by approval — no new number allocated', `${numberBeforeApprove} -> ${res.request.request_number}`);

    const fp = await stockFingerprint();
    ok(fp.movementCount === baseline.movementCount && fp.balances === baseline.balances,
      '26/27. Stock balances, mirrors and ledger unchanged after approval');
    ok(await itemsFingerprint(approvedReq.id) === itemsBeforeApprove, '29. Line items unchanged after approval');
  }

  // ── 25. Audit log ───────────────────────────────────────────────────────
  {
    const auditDoc = await db.collection('audit_logs').doc(`audit_inv_pr_inventory_pr_approved_${approvedReq.id}`).get();
    ok(auditDoc.exists, '25. Deterministic audit log created for the approval', `id=audit_inv_pr_inventory_pr_approved_${approvedReq.id}`);
  }

  // ── 12/19. Idempotency + terminal protection on an APPROVED request ─────
  {
    const replay = await PurchaseRequestApprovalService.approve(approvedReq.id, 'again', approverA);
    ok(replay.duplicate === true && replay.request.status === PR_STATUS.APPROVED,
      '12. The same approver re-approving is a safe idempotent replay');
    ok((replay.request.approvals || []).length === 1, '12. Replay does not append a duplicate approval record',
      `count=${(replay.request.approvals || []).length}`);

    await expectThrow(() => PurchaseRequestApprovalService.reject(approvedReq.id, 'changed my mind', approverA),
      '19. An APPROVED request cannot then be rejected', 'INVALID_STATUS_TRANSITION');
    await expectThrow(() => PurchaseRequestApprovalService.approve(approvedReq.id, null, approverB),
      '32. A second approver cannot act on an already-terminal request', 'INVALID_STATUS_TRANSITION');
  }

  // ── 15/17. APPROVED is immutable ────────────────────────────────────────
  await expectThrow(() => PurchaseRequestService.updateDraft(approvedReq.id, { priority: 'LOW' }, requester),
    '15. An APPROVED request cannot be edited', 'REQUEST_NOT_EDITABLE');
  await expectThrow(() => PurchaseRequestService.cancel(approvedReq.id, 'no', approverA),
    '17. An APPROVED request cannot be cancelled', 'INVALID_STATUS_TRANSITION');

  // ── 7/14/21/23/28/30. Reject ────────────────────────────────────────────
  console.log('\n── Reject ────────────────────────────────────────────────────────────────────');
  const rejectedReq = await newPending();
  const itemsBeforeReject = await itemsFingerprint(rejectedReq.id);
  {
    await expectThrow(() => PurchaseRequestApprovalService.reject(rejectedReq.id, '', approverA),
      '21. Rejection without a reason is refused', 'REJECTION_REASON_REQUIRED');
    await expectThrow(() => PurchaseRequestApprovalService.reject(rejectedReq.id, '  x ', approverA),
      '21. A too-short rejection reason is refused', 'REJECTION_REASON_REQUIRED');

    const res = await PurchaseRequestApprovalService.reject(rejectedReq.id, 'Budget not available this month', approverA);
    ok(res.duplicate === false && res.request.status === PR_STATUS.REJECTED, '7/14. PENDING_APPROVAL -> REJECTED');
    ok(res.request.rejection_reason === 'Budget not available this month' && res.request.rejected_by_uid === approverA.uid,
      'rejection_reason / rejected_by recorded immutably');
    const rec = (res.request.approvals || []).find(a => a.approver_uid === approverA.uid);
    ok(!!rec && rec.action === 'REJECTED' && rec.comment === 'Budget not available this month',
      '23. Rejection record persisted in approvals[]');
    ok((res.request.status_history || []).some(h => h.status === PR_STATUS.REJECTED), '24. status_history appended for rejection');

    const auditDoc = await db.collection('audit_logs').doc(`audit_inv_pr_inventory_pr_rejected_${rejectedReq.id}`).get();
    ok(auditDoc.exists, '25. Deterministic audit log created for the rejection');

    const fp = await stockFingerprint();
    ok(fp.movementCount === baseline.movementCount && fp.balances === baseline.balances,
      '26/28. Stock balances, mirrors and ledger unchanged after rejection');
    ok(await itemsFingerprint(rejectedReq.id) === itemsBeforeReject, '30. Line items unchanged after rejection');
  }

  // ── 16/18/20. REJECTED is terminal and immutable ────────────────────────
  await expectThrow(() => PurchaseRequestService.updateDraft(rejectedReq.id, { priority: 'LOW' }, requester),
    '16. A REJECTED request cannot be edited', 'REQUEST_NOT_EDITABLE');
  await expectThrow(() => PurchaseRequestService.cancel(rejectedReq.id, 'no', approverA),
    '18. A REJECTED request cannot be cancelled', 'INVALID_STATUS_TRANSITION');
  await expectThrow(() => PurchaseRequestApprovalService.approve(rejectedReq.id, null, approverB),
    '20. A REJECTED request cannot then be approved', 'INVALID_STATUS_TRANSITION');
  await expectThrow(() => PurchaseRequestService.submit(rejectedReq.id, requester),
    'A REJECTED request cannot be re-submitted (rejection is terminal)', 'INVALID_STATUS_TRANSITION');

  // ── 31. Concurrency: simultaneous approve + reject ──────────────────────
  console.log('\n── Concurrency ───────────────────────────────────────────────────────────────');
  {
    let oneWinner = true, consistent = true, historyClean = true;
    for (let round = 0; round < 3; round++) {
      const race = await newPending();
      const [a, b] = await Promise.allSettled([
        PurchaseRequestApprovalService.approve(race.id, 'concurrent approve', approverA),
        PurchaseRequestApprovalService.reject(race.id, 'concurrent reject reason', approverB)
      ]);
      const winners = [a, b].filter(r => r.status === 'fulfilled' && r.value?.duplicate === false);
      if (winners.length !== 1) oneWinner = false;

      const finalDoc = await getPurchaseRequestByIdFirestore(race.id);
      const terminal = finalDoc.status === PR_STATUS.APPROVED || finalDoc.status === PR_STATUS.REJECTED;
      const approvals = finalDoc.approvals || [];
      // Exactly one committed decision, and it must match the final status.
      if (!terminal || approvals.length !== 1 || approvals[0].action !== finalDoc.status) consistent = false;
      // The history must never contain the contradictory outcome.
      const other = finalDoc.status === PR_STATUS.APPROVED ? PR_STATUS.REJECTED : PR_STATUS.APPROVED;
      if ((finalDoc.status_history || []).some(h => h.status === other)) historyClean = false;
    }
    ok(oneWinner, '31. Concurrent approve+reject: exactly one transaction wins (3 rounds)');
    ok(consistent, '31. Final state is terminal and approvals[] holds only the committed decision');
    ok(historyClean, '31. No contradictory transition ever appears in status_history');
  }

  // ── 33. Phase B behaviour still intact ──────────────────────────────────
  console.log('\n── Phase B regression ────────────────────────────────────────────────────────');
  {
    const draft = await PurchaseRequestService.createDraft(
      { ...baseReq, items: [{ product_id: product.id, requested_quantity: 2.5 }] }, requester);
    cleanup.push(() => deletePurchaseRequestCascadeFirestore(draft.request.id));
    ok(draft.request.status === PR_STATUS.DRAFT && draft.request.request_number === null,
      '33. Phase B create still yields a DRAFT with no number');

    const upd = await PurchaseRequestService.updateDraft(draft.request.id, { priority: 'HIGH' }, requester);
    ok(upd.request.priority === 'HIGH', '33. Phase B draft editing still works');

    const sub = await PurchaseRequestService.submit(draft.request.id, requester);
    ok(sub.request.status === PR_STATUS.PENDING_APPROVAL && /^PR-\d{8}-\d{6}$/.test(sub.request.request_number),
      '33. Phase B submit still assigns a PR-YYYYMMDD-NNNNNN number');

    const cancelDraft = await PurchaseRequestService.createDraft(
      { ...baseReq, items: [{ product_id: product.id, requested_quantity: 1 }] }, requester);
    cleanup.push(() => deletePurchaseRequestCascadeFirestore(cancelDraft.request.id));
    const cancelled = await PurchaseRequestService.cancel(cancelDraft.request.id, 'not needed', requester);
    ok(cancelled.request.status === PR_STATUS.CANCELLED, '33. Phase B draft cancellation still works');
  }

  // ── final stock proof ───────────────────────────────────────────────────
  console.log('\n── Final stock-impact verification ───────────────────────────────────────────');
  {
    const fp = await stockFingerprint();
    ok(fp.movementCount === baseline.movementCount,
      '26. No stock movement was created by ANY approval-engine operation',
      `baseline=${baseline.movementCount} final=${fp.movementCount}`);
    ok(fp.balances === baseline.balances, '27/28. Every product balance is byte-identical to the baseline');
    const prod = await InventoryCutoverService.getProductById(product.id);
    ok(prod.current_stock === 12, 'Approving a request for 3 KG left stock at 12 KG (approval ≠ stock receipt)',
      `got ${prod.current_stock}`);
  }

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\n── Cleanup ───────────────────────────────────────────────────────────────────');
  for (const fn of cleanup) {
    try { await fn(); } catch (err) { console.warn(`  [cleanup warning] ${err.message}`); }
  }
  // Audit entries written by this run (deterministic ids) are test artifacts.
  const auditIds = [
    `audit_inv_pr_inventory_pr_approved_${approvedReq.id}`,
    `audit_inv_pr_inventory_pr_rejected_${rejectedReq.id}`
  ];
  for (const id of auditIds) {
    try { await db.collection('audit_logs').doc(id).delete(); } catch { /* best effort */ }
  }
  // Scoped by actor-uid prefix instead of scanning the whole audit_logs
  // collection. Every audit this suite writes carries one of its synthetic
  // `phasectest_*` uids, so the range covers exactly the same documents the
  // filter below would have matched — the delete predicate is unchanged.
  const auditSnap = await db.collection('audit_logs')
    .where('user_id', '>=', 'phasectest_').where('user_id', '<', 'phasectest_\uf8ff').get();
  for (const d of auditSnap.docs) {
    const details = String(d.data().details || '');
    if (details.includes(`phasectest_`) || details.includes(RUN_ID)) { await d.ref.delete(); }
  }

  // Scoped to the documents THIS suite created, identified by its own marker or
  // run id. Asserting that the whole collection is empty made the check fail
  // whenever DEV held a purchase request raised by a person through the app,
  // which says nothing about whether this suite cleaned up after itself. The
  // invariant is unchanged: nothing this suite created may survive it.
  const mineC = (d) => {
    const blob = JSON.stringify(d.data() || {}) + '|' + d.id;
    return blob.includes('phasectest_') || blob.includes(RUN_ID);
  };
  const leftReq = (await db.collection('purchase_requests').get()).docs.filter(mineC);
  const leftItems = (await db.collection('purchase_request_items').get()).docs.filter(mineC);
  ok(leftReq.length === 0, 'Cleanup: no purchase requests left behind', `found ${leftReq.length}`);
  ok(leftItems.length === 0, 'Cleanup: no orphan purchase-request items left behind', `found ${leftItems.length}`);
  const strayProd = (await db.collection('inventory_products').get()).docs.filter(d => /^PHASE-C-/i.test(String(d.data().sku || '')));
  ok(strayProd.length === 0, 'Cleanup: no orphan test products left behind', `found ${strayProd.length}`);

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
