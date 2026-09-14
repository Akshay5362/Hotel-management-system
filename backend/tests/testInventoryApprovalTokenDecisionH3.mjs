/**
 * backend/tests/testInventoryApprovalTokenDecisionH3.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H3 — a purchase-request decision authorised by an approval-action token.
 *
 * PART A — no Firebase. Source-level invariants over the approval service, with
 *   comments stripped before every "must not contain" assertion so that
 *   documentation naming a forbidden thing cannot trip it.
 *
 * PART B — DEV Firestore behind the four-layer guard. One synthetic staff
 *   DOCUMENT (never an Auth user), one authority, one purchase request, two
 *   tokens. Everything is removed in a finally block, by known id.
 *   Budget: about 40 reads / 13 writes / 6 deletes.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryApprovalTokenDecisionH3.mjs
 *       node backend/tests/testInventoryApprovalTokenDecisionH3.mjs     (Part A only)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, '..');
const ROOT = path.join(BACKEND, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (l, c, d = '') => {
  if (c) { pass++; console.log(`  [PASS] ${l}${d ? '  ' + d : ''}`); }
  else { fail++; failures.push(l); console.log(`  [FAIL] ${l}${d ? '  ' + d : ''}`); }
};
const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g');
const src = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(CRLF, '\n');
const codeOnly = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SVC = src('backend', 'services', 'purchaseRequestApprovalService.js');
const CODE = codeOnly(SVC);
const CTRL = src('backend', 'controllers', 'purchaseRequestController.js');
const ROUTES = src('backend', 'routes', 'inventoryRoutes.js');

// The ONE transaction body, and the token entry point, as code-only slices.
const txnStart = CODE.indexOf('db.runTransaction(async (txn) => {');
const txnEnd = CODE.indexOf('});', CODE.indexOf('approvalRecord };', txnStart)) + 3;
const TXN = CODE.slice(txnStart, txnEnd);
const tokenFnStart = CODE.indexOf('async function decideWithApprovalActionToken');
// End at the H4 two-step rejection when it exists, so this slice stays exactly
// the one-step decision entry point these assertions were written against.
const tokenFnEnd = [CODE.indexOf('async function beginTokenRejection'), CODE.indexOf('export const PurchaseRequestApprovalService')]
  .filter(i => i > tokenFnStart).sort((a, b) => a - b)[0];
const TOKEN_FN = CODE.slice(tokenFnStart, tokenFnEnd);

console.log('═══ PART A — source invariants (no Firebase) ═══');

console.log('\n  -- the existing engine is intact --');
ok('1. approve() still exists and calls decide()', /async approve\(requestId, comment, actor\) \{\s*return await decide\(requestId, PR_APPROVAL_ACTIONS\.APPROVED/.test(CODE));
ok('2. reject() still exists and calls decide()', /async reject\(requestId, reason, actor\) \{\s*return await decide\(requestId, PR_APPROVAL_ACTIONS\.REJECTED/.test(CODE));
ok('3. assertCanApprove is still the preflight authorization', /const preflight = await getPurchaseRequestByIdFirestore\(docId\);[\s\S]{0,300}await assertCanApprove\(preflight, actor\);/.test(CODE));
ok('  a principal may bring its own authorization, and the in-app path passes none (H6)',
  /if \(hooks\?\.authorize\) await hooks\.authorize\(preflight, actor\);\s*\n\s*else await assertCanApprove\(preflight, actor\);/.test(CODE));
ok('4. exactly ONE db.runTransaction in the service — no second decision transaction', (CODE.match(/db\.runTransaction\(/g) || []).length === 1);
ok('  the transaction still re-reads the request first', /const snap = await txn\.get\(ref\);/.test(TXN) && TXN.indexOf('txn.get(ref)') < TXN.indexOf('hooks.afterRead('));
ok('  first-valid-decision-wins guard still present', /current\.status !== PR_STATUS\.PENDING_APPROVAL/.test(TXN));
ok('  idempotent replay branch still present', /alreadyMine/.test(TXN));
ok('  in-transaction self-approval re-check still present', /PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN/.test(TXN));
ok('  already-acted guard still present', /APPROVER_ALREADY_ACTED/.test(TXN));
ok('  transition table still consulted', /PR_TRANSITIONS\[current\.status\]/.test(TXN));
ok('  the in-app path passes no hooks (unchanged behaviour)',
  /decide\(requestId, PR_APPROVAL_ACTIONS\.APPROVED, \{ comment, actor \}\)/.test(CODE) &&
  /decide\(requestId, PR_APPROVAL_ACTIONS\.REJECTED, \{ comment: reason, actor \}\)/.test(CODE));

console.log('\n  -- the token path reuses, never duplicates --');
ok('5. token path uses the H2 repository', /from '\.\.\/repositories\/firestore\/inventoryApprovalActionsRepository\.js'/.test(SVC));
ok('  and resolves the principal from the authority record, by id (H6)',
  /resolveTokenPrincipal\(approverUid\)/.test(TOKEN_FN) && /getApprovalAuthorityByIdFirestore\(approverUid\)/.test(CODE));
ok('  token path delegates to decide() with hooks', /return await decide\(requestDocId, wanted, \{[\s\S]{0,200}hooks: \{/.test(TOKEN_FN));
ok('8. no token-only shortcut: the token path performs no request write of its own', !/txn\.update\(ref|txn\.update\(requestRef|updateDoc\(|\.set\(/.test(TOKEN_FN));
ok('  it never sets a purchase-request status itself', !/status:\s*(targetStatus|PR_STATUS)/.test(TOKEN_FN));

console.log('\n  -- inside the one transaction --');
ok('6. token is re-read inside the transaction', /readApprovalActionInTxn\(txn, pre\.token_hash/.test(TOKEN_FN));
ok('  and the re-read enforces the expected token purpose (H4)',
  /readApprovalActionInTxn\(txn, pre\.token_hash, \{ expectedPurpose: expected_purpose \}\)/.test(TOKEN_FN));
ok('  afterRead runs right after the request read and BEFORE the status check',
  TXN.indexOf('hooks.afterRead(') > TXN.indexOf('const current = formatDocSnapshot(snap);') &&
  TXN.indexOf('hooks.afterRead(') < TXN.indexOf('current.status !== PR_STATUS.PENDING_APPROVAL'));
ok('7. token consumption happens in the SAME transaction, after the request update',
  TXN.indexOf('hooks.beforeCommit(') > TXN.indexOf('txn.update(ref, updates);') &&
  TXN.indexOf('hooks.beforeCommit(') < TXN.indexOf('return { duplicate: false'));
ok('  consumption uses the txn-scoped write primitive', /markApprovalActionConsumedInTxn\(txn, pre\.token_hash/.test(TOKEN_FN));
ok('  the standalone consume primitive is NOT used (no separate consume transaction)', !/consumeApprovalActionFirestore/.test(CODE));
ok('  the preflight token read is re-verified in the transaction', /findApprovalActionByTokenFirestore\(raw_token/.test(TOKEN_FN) && /throwForTokenVerdict\(verdict\)/.test(TOKEN_FN));
ok('  the preflight also enforces the expected purpose (H4)',
  /findApprovalActionByTokenFirestore\(raw_token, \{ expectedPurpose: expected_purpose \}\)/.test(TOKEN_FN));
ok('  the one-step path defaults to a DECISION token, never an intent (H4)',
  /expected_purpose = PR_TOKEN_PURPOSES\.DECISION/.test(TOKEN_FN));

console.log('\n  -- bindings --');
ok('10/11. action binding: token.action must equal the requested action', /tokenDoc\.action !== action/.test(CODE) && /TOKEN_ACTION_MISMATCH/.test(CODE));
ok('12. request binding checked', /TOKEN_PR_MISMATCH/.test(CODE) && /formatRequestDocId\(tokenDoc\.pr_id\) !== formatRequestDocId\(requestDocId\)/.test(CODE));
ok('13. approver binding checked', /String\(tokenDoc\.approver_uid\) !== String\(approverUid\)/.test(CODE) && /TOKEN_APPROVER_MISMATCH/.test(CODE));
ok('  bindings are re-checked inside the transaction against the freshly read request',
  (TOKEN_FN.match(/assertTokenBinding\(/g) || []).length === 2 && /assertTokenBinding\(verdict\.action, \{ approverUid, action: wanted, requestDocId: current\.id \}\)/.test(TOKEN_FN));
ok('  only the canonical PR_APPROVAL_ACTIONS vocabulary is compared', /normalizeApprovalActionToken\(action\)/.test(TOKEN_FN) && !/'APPROVE'\s*===|'REJECT'\s*===/.test(CODE));

console.log('\n  -- authority revalidated at decision time --');
ok('14. the principal is re-asserted inside the transaction (H6)', /await principal\.reassert\(txn, current\)/.test(TOKEN_FN));
ok('  INTERNAL path: staff AND authority are re-read inside the transaction',
  /txn\.getAll\(staffRef, authorityRef\)/.test(CODE) &&
  /db\.collection\('staff'\)\.doc\(staff\.id\)/.test(CODE) &&
  /db\.collection\(APPROVAL_AUTHORITIES_COLLECTION\)\.doc\(approverUid\)/.test(CODE));
ok('  INTERNAL path: decision-time role overrides the send-time role', /actor\.role = assertStaffEligible\(staffSnap\.exists \? formatDocSnapshot\(staffSnap\) : null, approverUid\);/.test(CODE));
ok('  INTERNAL path: the EXISTING assertCanApprove runs inside the transaction with that role', /await assertCanApprove\(current, actor\);/.test(CODE));
ok('  EXTERNAL path: the authority is re-read inside the transaction and re-authorised (H6)',
  /const snap = await txn\.get\(authorityRef\);[\s\S]{0,200}await assertExternalAuthorityCanApprove\(current, actor, live\)/.test(CODE));
ok('  the path is chosen by the STORED authority_type and fails closed on anything else (H6)',
  (CODE.match(/authority\.authority_type === APPROVAL_AUTHORITY_TYPES\.(EXTERNAL|INTERNAL)/g) || []).length === 2 && /AUTHORITY_TYPE_INVALID/.test(CODE));
ok('  inactive staff refused', /STAFF_INACTIVE/.test(CODE) && /STAFF_NOT_FOUND/.test(CODE));
ok('  missing/inactive authority refused', /AUTHORITY_NOT_FOUND/.test(CODE) && /AUTHORITY_INACTIVE/.test(CODE));
ok('  a phone number or verification state is never consulted as authorization', !/whatsapp_verified_at|whatsapp_e164/.test(CODE));
ok('  the identity is a required server-side argument, never derived from the token alone',
  /APPROVER_REQUIRED/.test(TOKEN_FN) && !/decided_by_uid\s*=\s*pre|approverUid\s*=\s*pre\.action/.test(TOKEN_FN));

console.log('\n  -- existing rules preserved --');
ok('15. rejection reason rule is shared and enforced before any read',
  /function assertRejectionReason\(action, comment\)/.test(CODE) &&
  TOKEN_FN.indexOf('assertRejectionReason(wanted, reason)') < TOKEN_FN.indexOf('findApprovalActionByTokenFirestore'));
ok('  and decide() itself still enforces it', /const reason = assertRejectionReason\(action, comment\);/.test(CODE));
ok('9. raw token never appears in a thrown message or a log', !/fail\([^)]*raw_token/.test(CODE) && !/console\.[a-z]+\([^)]*raw_token/.test(CODE) && !/\$\{raw_token\}|\$\{rawToken\}/.test(CODE));
ok('  malformed and unknown tokens collapse to one code (no oracle)', /default:\s*throw fail\('This approval link is not valid\.', 'TOKEN_INVALID'/.test(CODE));
ok('  consumed / expired are deterministic codes', /'TOKEN_CONSUMED', 409/.test(CODE) && /'TOKEN_EXPIRED', 403/.test(CODE));

console.log('\n  -- post-commit behaviour --');
ok('16. no Socket.IO emit inside the transaction', !/\.emit\(/.test(TXN) && !/\bio\b/.test(TXN));
ok('  PR_EVENTS.DECIDED is still emitted by the controller AFTER the service resolves', /if \(!result\.duplicate\) emitPurchaseRequestDecided\(req, result\.request, actor\);/.test(CTRL));
ok('  the service itself never emits', !/\.emit\(/.test(CODE));
ok('17. the same audit events are written post-commit', /'INVENTORY_PR_APPROVED' : 'INVENTORY_PR_REJECTED'/.test(CODE) && CODE.indexOf('await writeAudit(') > CODE.indexOf('const result = await db.runTransaction'));
ok('  token path records the channel in the audit details', /audit_extra: \{ decision_channel: consumed_via/.test(TOKEN_FN));
ok('  no token hash or raw token reaches the audit', !/writeAudit\([^;]*token_hash/.test(CODE) && !/writeAudit\([^;]*raw_token/.test(CODE));
ok('  sibling tokens retired post-commit, best-effort, outside the transaction',
  CODE.indexOf('await retireOutstandingActions(') > CODE.indexOf('const result = await db.runTransaction') && /try \{[\s\S]{0,80}invalidateApprovalActionsForRequestFirestore/.test(CODE));
ok('  no external side effect inside the transaction', !/fetch\(|axios|whatsapp|https?:/i.test(TXN));

console.log('\n  -- scope --');
ok('18. no WhatsApp / webhook / Meta code introduced', !/graph\.facebook|createHmac|webhook|X-Hub|WHATSAPP/i.test(CODE));
ok('  no route added for H3', !/decideWithApprovalActionToken|approval-actions|approvalActionToken/.test(ROUTES));
ok('  no controller change for H3', !/decideWithApprovalActionToken/.test(CTRL));
ok('  service-to-controller import has precedent and no cycle',
  /import \{ normalizeUserRole \} from '\.\.\/controllers\/authController\.js'/.test(SVC) &&
  /from '\.\.\/controllers\/authController\.js'/.test(src('backend', 'services', 'housekeepingCutoverService.js')));

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H3 TOKEN DECISION: ${pass} passed, ${fail} failed (Part A only) ═══`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\n═══ PART B — DEV Firestore (sky5-development only) ═══\n');

const { createRequire } = await import('module');
const require_ = createRequire(path.join(BACKEND, 'package.json'));
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });
const { isProductionProject } = await import('../config/productionSafetyGuard.js');
if (isProductionProject()) { console.error('[SAFETY_ABORT] production project.'); process.exit(1); }
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }

const { db } = await import('../config/firebaseAdmin.js');
const live = db?._settings?.projectId || PROJECT;
if (live !== 'sky5-development') { console.error(`[SAFETY_ABORT] live handle "${live}".`); process.exit(1); }
console.log(`  [GUARD] project=${live} (DEV)\n`);

const { readBudgetMonitor } = await import('../utils/firestoreReadBudget.js');
const { PurchaseRequestApprovalService } = await import('../services/purchaseRequestApprovalService.js');
const actions = await import('../repositories/firestore/inventoryApprovalActionsRepository.js');

// Transaction reads bypass readBudgetMonitor, so count them here: every
// callback execution and every document fetched through txn.get / txn.getAll.
let txnRuns = 0, txnGets = 0;
const origRunTransaction = db.runTransaction.bind(db);
db.runTransaction = (fn, opts) => origRunTransaction(async (t) => {
  txnRuns++;
  const g = t.get.bind(t), ga = t.getAll.bind(t);
  t.get = (...a) => { txnGets++; return g(...a); };
  t.getAll = (...a) => { txnGets += a.filter(x => x && typeof x.path === 'string').length; return ga(...a); };
  return fn(t);
}, opts);

const TS = Date.now();
const UID = `h3test_approver_${TS}`;
const STAFF_DOC = `staff_${UID}`;
const PR_DOC = `pr_h3test_${TS}`;
const AUDIT_DOC = `audit_inv_pr_inventory_pr_approved_${PR_DOC}`;
const created = { staff: false, authority: false, pr: false, tokens: [] };
let writes = 0, deletes = 0;
const r0 = readBudgetMonitor.estimatedReadsToday;
const expectCode = async (fn) => { try { await fn(); return 'no throw'; } catch (e) { return e.code || e.message; } };
const tokenDoc = (h) => db.collection('inventory_approval_actions').doc(h).get().then(s => s.data());
const prDoc = () => db.collection('purchase_requests').doc(PR_DOC).get().then(s => s.data());
const iso = () => new Date().toISOString();

try {
  // ── fixtures: direct writes, zero reads. A staff DOCUMENT only; no Auth user. ─
  await db.collection('staff').doc(STAFF_DOC).set({
    staff_id: STAFF_DOC, user_uid: UID, username: `h3test_${TS}`, full_name: 'H3 Test Approver',
    email: `h3test_${TS}@example.invalid`, role: 'admin', department: 'Administration',
    status: 'Active', is_active: true, created_at: iso(), updated_at: iso()
  }); writes++; created.staff = true;
  // An INTERNAL (staff-keyed) authority: this suite proves the pre-H6 staff
  // path still works byte-for-byte. The EXTERNAL path is proven by the H6 suite.
  await db.collection('inventory_approval_authorities').doc(UID).set({
    authority_id: UID, authority_type: 'INTERNAL',
    user_uid: UID, display_name: 'H3 Test Approver', whatsapp_e164: null,
    whatsapp_verified_at: null, whatsapp_verification_method: null, is_active: true,
    created_at: iso(), created_by: 'h3_test', updated_at: iso(), updated_by: 'h3_test'
  }); writes++; created.authority = true;
  await db.collection('purchase_requests').doc(PR_DOC).set({
    request_id: PR_DOC, request_number: `PR-H3-${TS}`, status: 'PENDING_APPROVAL',
    requested_by_uid: `h3test_requester_${TS}`, requested_by_name: 'H3 Requester',
    department: 'Kitchen', location_id: null, business_date: iso().slice(0, 10),
    item_count: 0, total_estimated_value: 0, approvals: [], status_history: [],
    created_at: iso(), updated_at: iso()
  }); writes++; created.pr = true;

  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const T1 = await actions.createApprovalActionFirestore({ pr_id: PR_DOC, pr_number: `PR-H3-${TS}`, approver_uid: UID, action: 'APPROVE', expires_at: future, created_by: 'h3_test' });
  writes++; created.tokens.push(T1.token_hash);
  const T5 = await actions.createApprovalActionFirestore({ pr_id: PR_DOC, pr_number: `PR-H3-${TS}`, approver_uid: UID, action: 'REJECT', expires_at: future, created_by: 'h3_test' });
  writes++; created.tokens.push(T5.token_hash);
  console.log('  fixtures: 1 staff doc, 1 authority, 1 request, 2 tokens (T1=APPROVED, T5=REJECTED)\n');

  const run = (p) => PurchaseRequestApprovalService.decideWithApprovalActionToken(p);

  console.log('  -- bindings and rules: each refused BEFORE the transaction --');
  const runs0 = txnRuns;
  ok('C. APPROVED token cannot reject', await expectCode(() => run({ raw_token: T1.raw_token, decided_by_uid: UID, action: 'REJECTED', reason: 'a valid reason here' })) === 'TOKEN_ACTION_MISMATCH');
  ok('D. wrong request refused', await expectCode(() => run({ raw_token: T1.raw_token, decided_by_uid: UID, action: 'APPROVED', request_id: 'pr_h3test_other' })) === 'TOKEN_PR_MISMATCH');
  ok('E. wrong approver refused', await expectCode(() => run({ raw_token: T1.raw_token, decided_by_uid: 'h3test_someone_else', action: 'APPROVED' })) === 'TOKEN_APPROVER_MISMATCH');
  ok('  malformed token refused with the non-oracle code', await expectCode(() => run({ raw_token: 'nope', decided_by_uid: UID, action: 'APPROVED' })) === 'TOKEN_INVALID');
  ok('  unknown-but-well-formed token refused with the SAME code (no oracle)', await expectCode(() => run({ raw_token: 'A'.repeat(43), decided_by_uid: UID, action: 'APPROVED' })) === 'TOKEN_INVALID');
  ok('  missing identity refused', await expectCode(() => run({ raw_token: T1.raw_token, decided_by_uid: '', action: 'APPROVED' })) === 'APPROVER_REQUIRED');
  ok('  REJECTED token with an empty reason refused before any read', await expectCode(() => run({ raw_token: T5.raw_token, decided_by_uid: UID, action: 'REJECTED', reason: '' })) === 'REJECTION_REASON_REQUIRED');
  ok('  none of those reached the transaction', txnRuns === runs0, `txn runs=${txnRuns - runs0}`);

  console.log('\n  -- G. inactive authority --');
  await db.collection('inventory_approval_authorities').doc(UID).update({ is_active: false }); writes++;
  ok('G. inactive authority refused', await expectCode(() => run({ raw_token: T1.raw_token, decided_by_uid: UID, action: 'APPROVED' })) === 'AUTHORITY_INACTIVE');
  await db.collection('inventory_approval_authorities').doc(UID).update({ is_active: true }); writes++;
  ok('  still before the transaction', txnRuns === runs0);

  console.log('\n  -- H. a decision that fails INSIDE the transaction consumes nothing --');
  await db.collection('purchase_requests').doc(PR_DOC).update({ status: 'REJECTED' }); writes++;
  const hCode = await expectCode(() => run({ raw_token: T1.raw_token, decided_by_uid: UID, action: 'APPROVED' }));
  ok('H. terminal request refused by the existing in-transaction status guard', hCode === 'INVALID_STATUS_TRANSITION' && txnRuns === runs0 + 1, `${hCode}, txn runs=${txnRuns - runs0}`);
  await db.collection('purchase_requests').doc(PR_DOC).update({ status: 'PENDING_APPROVAL' }); writes++;
  // Proof that H consumed nothing: the SAME token must succeed below.

  console.log('\n  -- A + I + concurrency: two simultaneous attempts with the same token --');
  const runsAtRace = txnRuns;
  const settled = await Promise.allSettled([
    run({ raw_token: T1.raw_token, decided_by_uid: UID, action: 'APPROVED', reason: 'race 1' }),
    run({ raw_token: T1.raw_token, decided_by_uid: UID, action: 'APPROVED', reason: 'race 2' })
  ]);
  const wins = settled.filter(s => s.status === 'fulfilled' && s.value?.duplicate === false);
  const losers = settled.filter(s => s.status === 'rejected').map(s => s.reason?.code);
  const dupes = settled.filter(s => s.status === 'fulfilled' && s.value?.duplicate === true);
  writes += 2 + 1 + 1; // request update + token consume (one transaction), audit log, sibling retirement
  ok('A. exactly one attempt recorded the decision (the token that H failed with is still usable)', wins.length === 1, `wins=${wins.length}`);
  ok('  the other was refused deterministically as TOKEN_CONSUMED', losers.length === 1 && losers[0] === 'TOKEN_CONSUMED' && dupes.length === 0, `loser=${losers[0] ?? 'none'} dupes=${dupes.length}`);
  ok('  both attempts really ran transactions', txnRuns - runsAtRace >= 2, `${txnRuns - runsAtRace} runs`);
  const prAfter = await prDoc();
  ok('  request is APPROVED exactly once', prAfter.status === 'APPROVED' && prAfter.approvals.length === 1, `approvals=${prAfter.approvals.length}`);
  ok('  approved_by is the token approver, recorded with the decision-time role', prAfter.approved_by_uid === UID && prAfter.approvals[0]?.approver_role === 'admin');
  ok('  winner returned the standard service shape', wins[0]?.value.request?.status === 'APPROVED' && Array.isArray(wins[0]?.value.request?.items));
  const t1After = await tokenDoc(T1.token_hash);
  ok('I. token consumed in the same commit as the decision', !!t1After.consumed_at && t1After.consumed_via === 'APPROVAL_ACTION_TOKEN', String(t1After.consumed_via));
  const t5After = await tokenDoc(T5.token_hash);
  ok('  the unused REJECT sibling was retired when the request went terminal', t5After.consumed_via === 'INVALIDATED:PR_APPROVED', String(t5After.consumed_via));
  const audit = await db.collection('audit_logs').doc(AUDIT_DOC).get().then(s => s.data());
  ok('  audit record written post-commit with the channel marker', !!audit && String(audit.details).includes('"decision_channel":"APPROVAL_ACTION_TOKEN"'));
  ok('  audit record carries neither the raw token nor its hash', !!audit && !String(audit.details).includes(T1.raw_token) && !String(audit.details).includes(T1.token_hash));

  console.log('\n  -- B. replay --');
  ok('B. replaying the consumed token is refused', await expectCode(() => run({ raw_token: T1.raw_token, decided_by_uid: UID, action: 'APPROVED' })) === 'TOKEN_CONSUMED');
  ok('  the retired sibling is refused the same way', await expectCode(() => run({ raw_token: T5.raw_token, decided_by_uid: UID, action: 'REJECTED', reason: 'too late' })) === 'TOKEN_CONSUMED');
} finally {
  console.log('\n  -- J. cleanup: only this run\'s synthetic documents, by known id --');
  for (const h of created.tokens) { await db.collection('inventory_approval_actions').doc(h).delete(); deletes++; }
  if (created.pr) { await db.collection('purchase_requests').doc(PR_DOC).delete(); deletes++; }
  if (created.authority) { await db.collection('inventory_approval_authorities').doc(UID).delete(); deletes++; }
  if (created.staff) { await db.collection('staff').doc(STAFF_DOC).delete(); deletes++; }
  await db.collection('audit_logs').doc(AUDIT_DOC).delete(); deletes++;
  console.log(`  deleted: ${created.tokens.length} tokens, ${PR_DOC}, ${UID} (authority), ${STAFF_DOC}, ${AUDIT_DOC}`);
}

const monitorReads = readBudgetMonitor.estimatedReadsToday - r0;
console.log(`\n═══ H3 TOKEN DECISION: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
console.log(`\n[DEV READS ~${monitorReads + txnGets}]  (repository reads ${monitorReads} + transaction reads ${txnGets} across ${txnRuns} transaction runs)`);
console.log(`[DEV WRITES ~${writes}]  [DEV DELETES ${deletes}]  [PRODUCTION ACCESS] 0  [WHATSAPP CALLS] 0`);
process.exit(fail === 0 ? 0 : 1);
