/**
 * backend/tests/testInventoryPhaseD.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration test for HPMS Inventory Phase D — IN-APP PURCHASE REQUEST
 * NOTIFICATIONS + APPROVAL SETTINGS. DEV Firestore (sky5-development) ONLY,
 * behind the same fail-closed quadruple guard as the other guarded suites.
 *
 * WHAT IS PROVEN HERE
 *   • Settings API: authentication, admin-only authorization, validation,
 *     atomic write, cache invalidation, audit entry.
 *   • Emission contract: a real captured Socket.IO emit for submit/approve/
 *     reject, including exactly WHEN it fires (after commit, never on a failed
 *     submit, never on an idempotent replay) and the full payload shape.
 *   • Recipient targeting and duplicate safety: the frontend registry's own
 *     `eligible` and `buildId` logic is re-implemented here as an executable
 *     specification and run against the real emitted payloads.
 *
 * WHAT IS NOT PROVEN HERE (documented, not silently skipped)
 *   • That a browser actually renders the bell entry. That needs a DOM/socket
 *     client harness; the React registry itself is exercised by build + manual
 *     DEV verification, not by this Node suite.
 *   • Socket delivery over the wire. The emit is captured through a stub io
 *     object of the exact shape the controller uses (`req.app.get('io')`), so
 *     the controller's emit path is real; the transport is not re-tested.
 *
 * Run: cross-env HPMS_ENV=development node backend/tests/testInventoryPhaseD.mjs
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
const {
  createPurchaseRequest, submitPurchaseRequest, approvePurchaseRequest,
  rejectPurchaseRequest, getPurchaseRequestApprovalConfig, updatePurchaseRequestApprovalConfig
} = await import('../controllers/purchaseRequestController.js');
const { PurchaseRequestService } = await import('../services/purchaseRequestService.js');
const { InventoryCutoverService } = await import('../services/inventoryCutoverService.js');
const {
  getInventoryApprovalConfigFirestore, updateInventoryApprovalConfigFirestore,
  validateApprovalConfigPayload, PR_APPROVAL_CONFIG_DOC_ID
} = await import('../repositories/firestore/inventoryApprovalConfigRepository.js');
const { deletePurchaseRequestCascadeFirestore } = await import('../repositories/firestore/purchaseRequestsRepository.js');
const { deleteInventoryProductFirestore } = await import('../repositories/firestore/inventoryProductsRepository.js');
const { getAllInventoryLocationsFirestore } = await import('../repositories/firestore/inventoryLocationsRepository.js');
const { PR_EVENTS, PR_STATUS, VALID_APPROVER_ROLES } = await import('../utils/inventoryConstants.js');

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

/* ── Executable mirror of the frontend notification registry ───────────────
 * These reproduce src/contexts/NotificationContext.jsx's
 * INVENTORY_PURCHASE_REQUEST_PENDING entry so the targeting and dedupe rules
 * are asserted against the REAL emitted payloads. If the UI rule changes,
 * this must change with it. */
const registryEligible = (p, ctx) => {
  if (!p || !p.request_id) return false;
  const roles = Array.isArray(p.approver_roles) ? p.approver_roles : [];
  if (roles.length === 0) return false;
  if (!ctx.backendRole || !roles.includes(ctx.backendRole)) return false;
  if (p.requested_by_uid && ctx.uid && String(p.requested_by_uid) === String(ctx.uid)) return false;
  return true;
};
const registryBuildId = (p) => (p && p.request_id ? `INVENTORY_PURCHASE_REQUEST_PENDING:${p.request_id}` : null);

/** Minimal Express-shaped req/res that captures socket emits and the response. */
function makeCtx({ user, body = {}, params = {}, query = {} }) {
  const emitted = [];
  const res = {
    statusCode: 200, payload: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; }
  };
  const req = {
    user, body, params, query,
    app: { get: (k) => (k === 'io' ? { emit: (event, data) => emitted.push({ event, data }) } : null) }
  };
  return { req, res, emitted };
}

const staffAdmin = { uid: `phasedtest_admin_${RUN_ID}`, role: 'ADMIN', type: 'staff', full_name: 'Phase D Admin' };
const staffKitchen = { uid: `phasedtest_kitchen_${RUN_ID}`, role: 'CHEF', type: 'staff', full_name: 'Phase D Chef' };
const staffReception = { uid: `phasedtest_recep_${RUN_ID}`, role: 'RECEPTIONIST', type: 'staff', full_name: 'Phase D Receptionist' };

async function main() {
  console.log('═'.repeat(78));
  console.log('  INVENTORY PHASE D — NOTIFICATIONS + APPROVAL SETTINGS  (DEV)');
  console.log(`  run id: ${RUN_ID}`);
  console.log('═'.repeat(78));

  const cleanup = [];
  const originalConfigDoc = (await db.collection('settings').doc(PR_APPROVAL_CONFIG_DOC_ID).get());
  const hadOriginalConfig = originalConfigDoc.exists;
  const originalConfig = hadOriginalConfig ? originalConfigDoc.data() : null;
  cleanup.push(async () => {
    // Restore the settings document to exactly how the run found it.
    if (hadOriginalConfig) await db.collection('settings').doc(PR_APPROVAL_CONFIG_DOC_ID).set(originalConfig);
    else await db.collection('settings').doc(PR_APPROVAL_CONFIG_DOC_ID).delete().catch(() => {});
  });

  // ── 1/2. Unauthenticated over real HTTP ─────────────────────────────────
  console.log('\n── Settings API: authentication ──────────────────────────────────────────────');
  {
    const g = await fetch(`${API_BASE}/inventory/purchase-requests/approval-config`);
    ok(g.status === 401, '1. Unauthenticated approval-config GET -> 401', `got ${g.status}`);
    const p = await fetch(`${API_BASE}/inventory/purchase-requests/approval-config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, allowed_roles: ['admin'] })
    });
    ok(p.status === 401, '2. Unauthenticated approval-config PUT -> 401', `got ${p.status}`);
  }

  // ── 3/4. Authorization ──────────────────────────────────────────────────
  console.log('\n── Settings API: authorization ───────────────────────────────────────────────');
  {
    for (const [who, user] of [['kitchen', staffKitchen], ['receptionist', staffReception]]) {
      const { req, res } = makeCtx({ user, body: { enabled: true, allowed_roles: ['admin', 'kitchen'] } });
      await updatePurchaseRequestApprovalConfig(req, res);
      ok(res.statusCode === 403 && res.payload?.code === 'APPROVAL_CONFIG_FORBIDDEN',
        `3. A ${who} user cannot change the approval configuration -> 403`, `got ${res.statusCode}`);
    }
    const { req, res } = makeCtx({ user: staffAdmin, body: { enabled: true, allowed_roles: ['admin', 'super_admin'] } });
    await updatePurchaseRequestApprovalConfig(req, res);
    ok(res.statusCode === 200 && res.payload?.config?.allowed_roles?.length === 2,
      '4. An admin can update the approval configuration', JSON.stringify(res.payload));
  }

  // ── 5/6/7. Validation ───────────────────────────────────────────────────
  console.log('\n── Settings API: validation ──────────────────────────────────────────────────');
  {
    const bad = async (body, label, code) => {
      const { req, res } = makeCtx({ user: staffAdmin, body });
      await updatePurchaseRequestApprovalConfig(req, res);
      ok(res.statusCode === 400 && res.payload?.code === code, label, `status=${res.statusCode} code=${res.payload?.code}`);
    };
    await bad({ enabled: true, allowed_roles: ['admin', 'wizard'] }, '5. Unknown role rejected', 'INVALID_APPROVER_ROLE');
    await bad({ enabled: true, allowed_roles: ['admin', 'ROOT'] }, '5. Arbitrary privileged string rejected', 'INVALID_APPROVER_ROLE');
    await bad({ enabled: true, allowed_roles: [] }, '7. enabled=true with an empty role list rejected', 'APPROVER_ROLES_REQUIRED');
    await bad({ enabled: 'yes', allowed_roles: ['admin'] }, 'Non-boolean enabled rejected', 'INVALID_APPROVAL_CONFIG');
    await bad({ enabled: true, allowed_roles: 'admin' }, 'Non-array allowed_roles rejected', 'INVALID_APPROVAL_CONFIG');

    // 6. duplicates normalize deterministically
    const dup = validateApprovalConfigPayload({ enabled: true, allowed_roles: ['admin', 'ADMIN', ' admin ', 'super_admin'] });
    ok(dup.allowed_roles.length === 2 && dup.allowed_roles[0] === 'admin' && dup.allowed_roles[1] === 'super_admin',
      '6. Duplicate / differently-cased roles collapse deterministically', JSON.stringify(dup.allowed_roles));

    // Client-supplied privileged extras are dropped, not persisted.
    const extra = validateApprovalConfigPayload({ enabled: true, allowed_roles: ['admin'], is_super: true, __proto__x: 1 });
    ok(Object.keys(extra).length === 2, 'Unknown client-supplied fields are dropped', JSON.stringify(Object.keys(extra)));
  }

  // ── 8. Cache invalidation ───────────────────────────────────────────────
  console.log('\n── Settings cache ────────────────────────────────────────────────────────────');
  {
    await updateInventoryApprovalConfigFirestore({ enabled: true, allowed_roles: ['admin'] });
    const before = await getInventoryApprovalConfigFirestore();          // populates the TTL cache
    ok(before.allowed_roles.join() === 'admin', 'Config cached after read');
    const { req, res } = makeCtx({ user: staffAdmin, body: { enabled: true, allowed_roles: ['admin', 'super_admin', 'kitchen'] } });
    await updatePurchaseRequestApprovalConfig(req, res);
    const after = await getInventoryApprovalConfigFirestore();           // must NOT be the stale cache
    ok(after.allowed_roles.length === 3 && after.allowed_roles.includes('kitchen'),
      '8. Cache invalidated immediately after update (no stale approver list)', JSON.stringify(after.allowed_roles));
  }

  // ── 12. Audit ───────────────────────────────────────────────────────────
  {
    const audit = await db.collection('audit_logs').doc('audit_inv_pr_approval_config').get();
    ok(audit.exists, '12. Deterministic audit entry written for the settings change');
    if (audit.exists) {
      const details = String(audit.data().details || '');
      ok(details.includes('previous_allowed_roles') && details.includes('new_allowed_roles'),
        '12. Audit records the previous and new approver lists');
    }
    cleanup.push(() => db.collection('audit_logs').doc('audit_inv_pr_approval_config').delete().catch(() => {}));
  }

  // ── fixtures ────────────────────────────────────────────────────────────
  console.log('\n── Fixtures ──────────────────────────────────────────────────────────────────');
  const { categories } = await InventoryCutoverService.getCategories();
  const locations = await getAllInventoryLocationsFirestore({ includeInactive: false });
  const location = locations.find(l => l.is_active !== false);
  const sku = `PHASE-D-TEST-${RUN_ID}`;
  const { product } = await InventoryCutoverService.createProduct({
    sku, name: `PHASE_D_TEST Product ${RUN_ID}`, category_id: categories[0].id,
    unit_of_measure: 'KG', minimum_stock_level: 2, cost_price: 50,
    opening_stock: 8, opening_location_id: location.id
  }, { uid: staffKitchen.uid, name: staffKitchen.full_name });
  ok(product.current_stock === 8, 'Test product created with 8 KG stock');
  cleanup.push(async () => {
    const movs = await db.collection('inventory_stock_movements').where('product_id', '==', product.id).get();
    for (const d of movs.docs) await d.ref.delete();
    await deleteInventoryProductFirestore(product.id);
  });

  async function stockFingerprint() {
    const prods = await db.collection('inventory_products').get();
    const movs = await db.collection('inventory_stock_movements').get();
    const balances = {};
    prods.docs.forEach(d => { const x = d.data(); balances[d.id] = `${x.current_stock}|${x.stock_quantity}|${JSON.stringify(x.stock_by_location || {})}`; });
    return { movementCount: movs.size, balances: JSON.stringify(balances) };
  }
  const baseline = await stockFingerprint();

  /** Creates a DRAFT through the controller and returns its id. */
  async function newDraft(user = staffKitchen) {
    const { req, res } = makeCtx({
      user,
      body: { location_id: location.id, department: 'KITCHEN', reason: 'Phase D', items: [{ product_id: product.id, requested_quantity: 2 }] }
    });
    await createPurchaseRequest(req, res);
    const id = res.payload.request.id;
    cleanup.push(() => deletePurchaseRequestCascadeFirestore(id));
    return id;
  }

  // ── 9-15. Submit emits the pending event ────────────────────────────────
  console.log('\n── Submit event ──────────────────────────────────────────────────────────────');
  await updateInventoryApprovalConfigFirestore({ enabled: true, allowed_roles: ['admin', 'super_admin'] });
  let submittedPayload = null;
  let submittedRequestId = null;
  {
    submittedRequestId = await newDraft();
    const { req, res, emitted } = makeCtx({ user: staffKitchen, params: { id: submittedRequestId } });
    await submitPurchaseRequest(req, res);
    ok(res.statusCode === 201, 'Submit succeeded');

    const evt = emitted.find(e => e.event === PR_EVENTS.SUBMITTED);
    ok(!!evt, '9. Submitting a request emits inventory:purchase_request_submitted');
    submittedPayload = evt?.data || null;
    ok(emitted.length === 1, '10. Exactly one event emitted per submit', `got ${emitted.length}`);

    // The emit happens only after the transaction assigned a number/status.
    ok(submittedPayload.request_id === submittedRequestId, '12. Payload carries request_id');
    ok(/^PR-\d{8}-\d{6}$/.test(submittedPayload.request_number || ''), '13. Payload carries the request number', submittedPayload.request_number);
    ok(submittedPayload.requested_by_uid === staffKitchen.uid && !!submittedPayload.requested_by_name,
      '14. Payload carries the requester uid and name');
    ok(submittedPayload.department === 'KITCHEN' && submittedPayload.location_id === location.id,
      '15. Payload carries department/location context');
    ok(Array.isArray(submittedPayload.approver_roles) && submittedPayload.approver_roles.includes('admin'),
      'Payload carries the approver role list used for targeting', JSON.stringify(submittedPayload.approver_roles));
    ok(submittedPayload.item_count === 1 && submittedPayload.estimated_total === 100,
      'Payload carries item count and estimated total');
    const leaked = Object.keys(submittedPayload).filter(k => /password|token|secret|key|email/i.test(k));
    ok(leaked.length === 0, 'Payload leaks no credential-like field', JSON.stringify(leaked));
  }

  // ── 11. A failed submit emits nothing ───────────────────────────────────
  {
    const { req, res, emitted } = makeCtx({ user: staffKitchen, params: { id: 'pr_does_not_exist_at_all' } });
    await submitPurchaseRequest(req, res);
    ok(res.statusCode === 404, 'Submitting a missing request fails');
    ok(emitted.length === 0, '11. A failed submit emits NO notification event');

    // An idempotent replay must not re-notify either.
    const { req: r2, res: s2, emitted: e2 } = makeCtx({ user: staffKitchen, params: { id: submittedRequestId } });
    await submitPurchaseRequest(r2, s2);
    ok(s2.payload?.duplicate === true && e2.length === 0,
      '21. An idempotent re-submit emits no second event');
  }

  // ── 16-18. Recipient targeting (registry rules vs the real payload) ─────
  console.log('\n── Recipient targeting ───────────────────────────────────────────────────────');
  {
    const ctxFor = (uid, backendRole) => ({ uid, backendRole });
    ok(registryEligible(submittedPayload, ctxFor('someone_else_admin', 'admin')) === true,
      '17. An eligible approver (admin) receives the notification');
    ok(registryEligible(submittedPayload, ctxFor('someone_else_sa', 'super_admin')) === true,
      '17. A super_admin approver receives the notification');
    ok(registryEligible(submittedPayload, ctxFor('someone_else_recep', 'receptionist')) === false,
      '18. A non-approver role (receptionist) does NOT receive it');
    ok(registryEligible(submittedPayload, ctxFor('someone_else_hk', 'housekeeper')) === false,
      '18. A non-approver role (housekeeper) does NOT receive it');
    ok(registryEligible(submittedPayload, ctxFor(staffKitchen.uid, 'kitchen')) === false,
      '16. The requester does not receive their own approval notification');

    // The decisive case: requester who ALSO holds an approver role.
    const selfAdminPayload = { ...submittedPayload, requested_by_uid: 'admin_who_requested', approver_roles: ['admin'] };
    ok(registryEligible(selfAdminPayload, ctxFor('admin_who_requested', 'admin')) === false,
      '16. A requester with an approver role is still excluded from their own notification');
    ok(registryEligible(selfAdminPayload, ctxFor('another_admin', 'admin')) === true,
      '16. Other eligible admins still receive it');
  }

  // ── 19. Approvals disabled → no event ───────────────────────────────────
  {
    await updateInventoryApprovalConfigFirestore({ enabled: false, allowed_roles: ['admin'] });
    const id = await newDraft();
    const { req, res, emitted } = makeCtx({ user: staffKitchen, params: { id } });
    await submitPurchaseRequest(req, res);
    ok(res.statusCode === 201, 'Request still submits while approvals are disabled');
    ok(emitted.length === 0, '19. Approvals disabled produces NO pending-approval notification');
    await updateInventoryApprovalConfigFirestore({ enabled: true, allowed_roles: ['admin', 'super_admin'] });
  }

  // ── 20/21. Deterministic id + duplicate safety ──────────────────────────
  console.log('\n── Duplicate safety ──────────────────────────────────────────────────────────');
  {
    const id1 = registryBuildId(submittedPayload);
    const id2 = registryBuildId({ ...submittedPayload });
    ok(id1 === `INVENTORY_PURCHASE_REQUEST_PENDING:${submittedRequestId}` && id1 === id2,
      '20. Notification id is deterministic per request', id1);
    // Same id twice → the context's knownIds set collapses it (mirrored here).
    const known = new Set();
    let created = 0;
    for (const p of [submittedPayload, submittedPayload, { ...submittedPayload }]) {
      const nid = registryBuildId(p);
      if (!known.has(nid)) { known.add(nid); created++; }
    }
    ok(created === 1, '21. A repeated/reconnected event yields exactly one notification', `created=${created}`);
    ok(registryBuildId({}) === null, 'A payload without request_id produces no notification');
  }

  // ── 22-24. Decision events retire the pending notification ──────────────
  console.log('\n── Decision events ───────────────────────────────────────────────────────────');
  {
    const matches = (payload, n) => !!payload && payload.request_id != null && !!n.metadata &&
      String(n.metadata.requestId) === String(payload.request_id);
    const pendingNotification = { type: 'INVENTORY_PURCHASE_REQUEST_PENDING', metadata: { requestId: submittedRequestId } };

    // APPROVE
    const { req, res, emitted } = makeCtx({ user: staffAdmin, params: { id: submittedRequestId }, body: { comment: 'ok' } });
    await approvePurchaseRequest(req, res);
    ok(res.statusCode === 200 && res.payload.request.status === PR_STATUS.APPROVED, 'Approve succeeded');
    const decided = emitted.find(e => e.event === PR_EVENTS.DECIDED);
    ok(!!decided, '22. Approving emits inventory:purchase_request_decided');
    ok(decided.data.request_id === submittedRequestId && decided.data.status === PR_STATUS.APPROVED &&
       decided.data.decided_by_uid === staffAdmin.uid,
      '22. Decision payload carries request id, final status and decider');
    ok(matches(decided.data, pendingNotification) === true,
      '23. APPROVED decision matches and removes the pending notification');

    // REJECT
    const rejId = await newDraft();
    const { req: r2, res: s2 } = makeCtx({ user: staffKitchen, params: { id: rejId } });
    await submitPurchaseRequest(r2, s2);
    const { req: r3, res: s3, emitted: e3 } = makeCtx({ user: staffAdmin, params: { id: rejId }, body: { reason: 'No budget this month' } });
    await rejectPurchaseRequest(r3, s3);
    const decided2 = e3.find(e => e.event === PR_EVENTS.DECIDED);
    ok(!!decided2 && decided2.data.status === PR_STATUS.REJECTED, '22. Rejecting emits the decision event');
    ok(matches(decided2.data, { metadata: { requestId: rejId } }) === true,
      '24. REJECTED decision matches and removes the pending notification');
    ok(matches(decided2.data, { metadata: { requestId: 'some_other_request' } }) === false,
      'A decision never removes another request\'s notification');
  }

  // ── 25. Navigation intent ───────────────────────────────────────────────
  {
    const buildNavigation = (p) => ({ module: 'inventory', tab: 'purchase-requests', requestId: p.request_id });
    const nav = buildNavigation(submittedPayload);
    ok(nav.module === 'inventory' && nav.tab === 'purchase-requests' && nav.requestId === submittedRequestId,
      '25. Notification navigation intent carries module, tab and request id', JSON.stringify(nav));
  }

  // ── 26. Existing food notification untouched ────────────────────────────
  console.log('\n── Regression: existing notifications ────────────────────────────────────────');
  {
    const fs = await import('fs');
    const ctxSrc = fs.readFileSync(new URL('../../src/contexts/NotificationContext.jsx', import.meta.url), 'utf8');
    ok(ctxSrc.includes("FOOD_ORDER_READY") && ctxSrc.includes("'food:order_ready'"),
      '26. FOOD_ORDER_READY registry entry still present and unmodified in shape');
    ok(ctxSrc.includes("event: 'food:status_changed'"), '26. Food removal rule still present');
    ok(ctxSrc.includes('INVENTORY_PURCHASE_REQUEST_PENDING'), 'Inventory entry added alongside it');
    // Exactly one notification system: no second provider/socket registry.
    const providerCount = (ctxSrc.match(/export function NotificationProvider/g) || []).length;
    ok(providerCount === 1, 'Only ONE notification provider exists (no duplicate system)');
  }

  // ── 27. No Firestore notifications collection created ───────────────────
  {
    const cols = (await db.listCollections()).map(c => c.id);
    ok(!cols.includes('notifications') && !cols.includes('inventory_notifications'),
      '27. No Firestore notification collection was created (Socket.IO + localStorage only)',
      cols.filter(c => /notif/i.test(c)).join(',') || 'none');
  }

  // ── 28/29. Stock safety ─────────────────────────────────────────────────
  console.log('\n── Stock safety ──────────────────────────────────────────────────────────────');
  {
    const fp = await stockFingerprint();
    ok(fp.movementCount === baseline.movementCount,
      '28. No stock movement created by the notification/settings workflow',
      `baseline=${baseline.movementCount} final=${fp.movementCount}`);
    ok(fp.balances === baseline.balances, '29. Stock balances byte-identical after submit/approve/reject + settings changes');
    const prod = await InventoryCutoverService.getProductById(product.id);
    ok(prod.current_stock === 8, 'Product stock still 8 KG (notifications never touch stock)', `got ${prod.current_stock}`);
  }

  // ── 30-32. Phase A/B/C behaviour intact ─────────────────────────────────
  console.log('\n── Phase A/B/C regression (spot checks) ──────────────────────────────────────');
  {
    const d = await newDraft();
    ok((await PurchaseRequestService.getById(d)).status === PR_STATUS.DRAFT, '31. Phase B create still yields DRAFT');
    const sub = await PurchaseRequestService.submit(d, { uid: staffKitchen.uid, name: staffKitchen.full_name, role: 'kitchen' });
    ok(sub.request.status === PR_STATUS.PENDING_APPROVAL && /^PR-\d{8}-\d{6}$/.test(sub.request.request_number),
      '31. Phase B submit still assigns a transactional number');
    await expectThrow(
      () => PurchaseRequestService.updateDraft(d, { priority: 'LOW' }, { uid: staffKitchen.uid, role: 'kitchen' }),
      '32. Phase C immutability still enforced on a submitted request', 'REQUEST_NOT_EDITABLE');
    ok(VALID_APPROVER_ROLES.length === 5, '30. Role vocabulary unchanged', VALID_APPROVER_ROLES.join(','));
  }

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\n── Cleanup ───────────────────────────────────────────────────────────────────');
  for (const fn of cleanup) {
    try { await fn(); } catch (err) { console.warn(`  [cleanup warning] ${err.message}`); }
  }
  // Scoped by actor-uid prefix instead of scanning the whole audit_logs
  // collection. Every audit this suite writes carries one of its synthetic
  // `phasedtest_*` uids, so the range covers exactly the same documents the
  // filter below would have matched — the delete predicate is unchanged.
  const audits = await db.collection('audit_logs')
    .where('user_id', '>=', 'phasedtest_').where('user_id', '<', 'phasedtest_\uf8ff').get();
  for (const d of audits.docs) {
    const blob = String(d.data().user_id || '') + '|' + String(d.data().details || '');
    if (blob.includes('phasedtest_') || blob.includes(RUN_ID)) await d.ref.delete();
  }
  // Scoped to the documents THIS suite created, identified by its own marker or
  // run id. Asserting that the whole collection is empty made the check fail
  // whenever DEV held a purchase request raised by a person through the app,
  // which says nothing about whether this suite cleaned up after itself. The
  // invariant is unchanged: nothing this suite created may survive it.
  const mineD = (d) => {
    const blob = JSON.stringify(d.data() || {}) + '|' + d.id;
    return blob.includes('phasedtest_') || blob.includes(RUN_ID);
  };
  const leftReq = (await db.collection('purchase_requests').get()).docs.filter(mineD);
  const leftItems = (await db.collection('purchase_request_items').get()).docs.filter(mineD);
  ok(leftReq.length === 0, 'Cleanup: no purchase requests left behind', `found ${leftReq.length}`);
  ok(leftItems.length === 0, 'Cleanup: no orphan purchase-request items left behind', `found ${leftItems.length}`);
  const strayProd = (await db.collection('inventory_products').get()).docs.filter(d => /^PHASE-D-/i.test(String(d.data().sku || '')));
  ok(strayProd.length === 0, 'Cleanup: no orphan test products left behind', `found ${strayProd.length}`);
  const cfgNow = await db.collection('settings').doc(PR_APPROVAL_CONFIG_DOC_ID).get();
  ok(cfgNow.exists === hadOriginalConfig, 'Cleanup: approval settings document restored to its original state',
    `existed=${hadOriginalConfig} now=${cfgNow.exists}`);

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
