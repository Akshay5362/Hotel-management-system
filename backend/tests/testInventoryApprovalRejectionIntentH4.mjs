/**
 * backend/tests/testInventoryApprovalRejectionIntentH4.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H4 — two-step rejection: begin, then complete with a reason CODE.
 *
 * PART A — no Firebase. Source invariants over the constants, the token
 *   repository and the approval service, with comments stripped before every
 *   "must not contain" assertion so documentation cannot trip it.
 *
 * PART B — DEV Firestore behind the four-layer guard. Synthetic staff document
 *   (never an Auth user), one authority, two purchase requests and a handful of
 *   tokens, all removed in a finally block by known id.
 *
 * Creates no WhatsApp credential, calls no external service, adds no route.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryApprovalRejectionIntentH4.mjs
 *       node backend/tests/testInventoryApprovalRejectionIntentH4.mjs     (Part A only)
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

const CONSTS = src('backend', 'utils', 'inventoryConstants.js');
const REPO = src('backend', 'repositories', 'firestore', 'inventoryApprovalActionsRepository.js');
const SVC = src('backend', 'services', 'purchaseRequestApprovalService.js');
const CODE = codeOnly(SVC);
const RULES = src('firestore.rules');
const ROUTES = src('backend', 'routes', 'inventoryRoutes.js');
const CTRL = src('backend', 'controllers', 'purchaseRequestController.js');

const beginStart = CODE.indexOf('async function beginTokenRejection');
const completeStart = CODE.indexOf('async function completeTokenRejection');
const BEGIN_FN = CODE.slice(beginStart, completeStart);
const COMPLETE_FN = CODE.slice(completeStart, CODE.indexOf('export const PurchaseRequestApprovalService'));

console.log('═══ PART A — source invariants (no Firebase) ═══');

console.log('\n  -- token purposes --');
ok('1. two purposes exist, DECISION and REASON_CAPTURE',
  /PR_TOKEN_PURPOSES = Object\.freeze\(\{\s*\n\s*DECISION: 'DECISION',\s*\n\s*REASON_CAPTURE: 'REASON_CAPTURE'\s*\n\}\)/.test(CONSTS));
ok('  a token with no purpose field reads as DECISION, so H2/H3 tokens still work',
  /return \(doc && doc\.purpose\) \|\| PR_TOKEN_PURPOSES\.DECISION;/.test(REPO));
ok('  the one-step decision path requires a DECISION token by default',
  /expected_purpose = PR_TOKEN_PURPOSES\.DECISION/.test(CODE));
ok('  purpose is enforced on the preflight read AND the in-transaction re-read',
  (CODE.match(/expectedPurpose: expected_purpose/g) || []).length === 2);

console.log('\n  -- the intent is bound to its parent --');
ok('2. an intent must carry parent_token_hash', /A reason-capture intent requires parent_token_hash/.test(REPO));
ok('  an intent may only carry REJECTED', /A reason-capture intent may only carry REJECTED/.test(REPO));
ok('  a decision token may not carry a parent hash', /Only a reason-capture intent may carry parent_token_hash/.test(REPO));
ok('  the parent is stored as a HASH, never as a raw token',
  /parent_token_hash: parentTokenHash/.test(REPO) && !/parent_raw_token|parent_token:/.test(REPO));
ok('  the intent inherits the request, approver and action from the decision token',
  /pr_id: requestDocId/.test(BEGIN_FN) && /approver_uid: approverUid/.test(BEGIN_FN) &&
  /action: PR_APPROVAL_ACTIONS\.REJECTED/.test(BEGIN_FN));
ok('  the intent is short-lived', /expires_at: new Date\(Date\.now\(\) \+ PR_REASON_CAPTURE_TTL_MS\)/.test(BEGIN_FN) &&
  /PR_REASON_CAPTURE_TTL_MS = 10 \* 60 \* 1000/.test(CONSTS));

console.log('\n  -- begin validates everything except the reason --');
ok('3. begin requires a server-side approver identity', /APPROVER_REQUIRED/.test(BEGIN_FN));
ok('  begin accepts only a DECISION token', /expectedPurpose: PR_TOKEN_PURPOSES\.DECISION/.test(BEGIN_FN));
ok('  begin accepts only a REJECT token',
  /assertTokenBinding\(pre\.action, \{[\s\S]{0,120}action: PR_APPROVAL_ACTIONS\.REJECTED/.test(BEGIN_FN));
ok('  begin checks the token verdict (existence, expiry, consumption)', /throwForTokenVerdict\(pre\)/.test(BEGIN_FN));
ok('  begin checks the request and approver bindings', /assertTokenBinding\(pre\.action/.test(BEGIN_FN));
ok('  begin checks staff and authority', /assertAuthorityActive\(authority\)/.test(BEGIN_FN) && /assertStaffEligible\(staff, approverUid\)/.test(BEGIN_FN));
ok('  begin runs the EXISTING authorization check', /await assertCanApprove\(request, actor\)/.test(BEGIN_FN));
ok('  begin requires the request to be pending', /request\.status !== PR_STATUS\.PENDING_APPROVAL/.test(BEGIN_FN));
ok('4. begin consumes NOTHING',
  !/markApprovalActionConsumedInTxn|consumeApprovalAction|consumed_at/.test(BEGIN_FN));
ok('  begin writes nothing but the intent',
  (BEGIN_FN.match(/createApprovalActionFirestore|updateDoc\(|\.set\(|txn\.update\(/g) || []).length === 1);
ok('  begin returns the intent token as its immediate output only', /raw_token: intent\.raw_token/.test(BEGIN_FN));

console.log('\n  -- complete owns the words, the caller owns only the code --');
ok('5. the reason vocabulary is server-owned and fixed',
  /PR_REJECTION_REASON_CODES = Object\.freeze\(\{/.test(CONSTS) &&
  ['BUDGET_UNAVAILABLE', 'ALREADY_IN_STOCK', 'QUANTITY_TOO_HIGH', 'SUPPLIER_OR_PRICE_WRONG', 'NOT_REQUIRED_NOW', 'DUPLICATE_REQUEST']
    .every(c => new RegExp(`${c}:\\s*'`).test(CONSTS)));
ok('  a missing code is refused', /REJECTION_REASON_CODE_REQUIRED/.test(CODE));
ok('  an unknown code is refused', /REJECTION_REASON_CODE_INVALID/.test(CODE));
ok('6. free text is refused, not silently ignored', /REJECTION_REASON_TEXT_NOT_ACCEPTED/.test(COMPLETE_FN));
ok('  the reason handed to the engine is the SERVER string, never caller input',
  /reason: text/.test(COMPLETE_FN) && /const \{ code, text \} = resolveRejectionReason\(reason_code\)/.test(COMPLETE_FN));
ok('  the identity comes from the intent, not from the caller',
  /const approverUid = String\(intent\.approver_uid \|\| ''\)\.trim\(\)/.test(COMPLETE_FN));
ok('  a supplied identity can only narrow the outcome', /decided_by_uid && String\(decided_by_uid\)\.trim\(\) !== approverUid/.test(COMPLETE_FN));
ok('  complete accepts only a REASON_CAPTURE intent', /expectedPurpose: PR_TOKEN_PURPOSES\.REASON_CAPTURE/.test(COMPLETE_FN));
ok('  complete verifies the parent relationship', /await assertIntentParent\(intent\)/.test(COMPLETE_FN) && /TOKEN_PARENT_MISMATCH/.test(CODE));
ok('  the parent must be a DECISION token for the same request, approver and action',
  /tokenPurpose\(parent\) !== PR_TOKEN_PURPOSES\.DECISION/.test(CODE) &&
  /String\(parent\.approver_uid\) !== String\(intent\.approver_uid\)/.test(CODE) &&
  /formatRequestDocId\(parent\.pr_id\) !== formatRequestDocId\(intent\.pr_id\)/.test(CODE) &&
  /parent\.action !== PR_APPROVAL_ACTIONS\.REJECTED/.test(CODE));

console.log('\n  -- one engine, one transaction --');
ok('7. complete delegates to the EXISTING token decision path',
  /return await decideWithApprovalActionToken\(\{/.test(COMPLETE_FN));
ok('  it records no decision of its own',
  !/txn\.update\(|updateDoc\(|\.set\(|status: PR_STATUS|runTransaction/.test(COMPLETE_FN));
ok('8. still exactly ONE db.runTransaction in the service', (CODE.match(/db\.runTransaction\(/g) || []).length === 1);
ok('  the standalone consume primitive is still unused', !/consumeApprovalActionFirestore/.test(CODE));
ok('  the existing engine is untouched: approve(), reject(), assertCanApprove',
  /async approve\(requestId, comment, actor\)/.test(CODE) &&
  /async reject\(requestId, reason, actor\)/.test(CODE) &&
  /export async function assertCanApprove/.test(CODE));
ok('  the one-step APPROVED path is unchanged', /decideWithApprovalActionToken\b/.test(CODE) &&
  /assertRejectionReason\(wanted, reason\)/.test(CODE));
ok('9. the reason reaches the request through the existing fields only',
  /updates\.rejection_reason = reason;/.test(CODE) && /comment: reason,/.test(CODE) &&
  /history\.push\(\{ status: targetStatus/.test(CODE));
ok('  the reason CODE is recorded in the audit, not on the request',
  /audit_extra: \{ rejection_reason_code: code \}/.test(COMPLETE_FN) && !/rejection_reason_code/.test(CODE.slice(CODE.indexOf('const updates = {'), CODE.indexOf('txn.update(ref, updates);'))));

console.log('\n  -- secrets --');
ok('10. no raw token is logged anywhere in the service',
  !/console\.[a-z]+\([^)]*raw_token/.test(CODE) && !/\$\{raw_token\}|\$\{rawToken\}/.test(CODE));
ok('  no raw token reaches an error message', !/fail\([^)]*raw_token/.test(CODE));
ok('  no raw token reaches the audit', !/audit_extra:[^}]*raw_token/.test(CODE));
ok('  the repository still never persists a raw token',
  !/\braw_token:/.test(REPO.slice(REPO.indexOf('const doc = {'), REPO.indexOf('await setDoc'))));

console.log('\n  -- scope --');
ok('11. no new collection: both kinds share inventory_approval_actions',
  (REPO.match(/APPROVAL_ACTIONS_COLLECTION = '[a-z_]+'/g) || []).length === 1 &&
  /APPROVAL_ACTIONS_COLLECTION = 'inventory_approval_actions'/.test(REPO));
ok('  Firestore rules still deny clients both collections',
  /match \/inventory_approval_actions\/\{actionId\} \{\s*\n\s*allow read, write: if false;/.test(RULES) &&
  /match \/inventory_approval_authorities\/\{authorityId\} \{\s*\n\s*allow read, write: if false;/.test(RULES));
ok('  purchase requests remain server-owned', /match \/purchase_requests\/\{requestId\} \{\s*\n\s*allow read: if isStaff\(\);\s*\n\s*allow write: if false;/.test(RULES));
ok('12. no HTTP route added for H4', !/beginTokenRejection|completeTokenRejection|reason-capture/.test(ROUTES));
ok('  no controller change for H4', !/beginTokenRejection|completeTokenRejection/.test(CTRL));
ok('13. no WhatsApp, Meta or webhook code introduced',
  !/graph\.facebook|createHmac|X-Hub|whatsapp|interactive|template/i.test(CODE) &&
  !/graph\.facebook|createHmac|X-Hub/i.test(REPO));
ok('  free-text rejection is deferred, not half-built',
  !/free_text|freeText|reason_text/.test(CODE));

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H4 REJECTION INTENT: ${pass} passed, ${fail} failed (Part A only) ═══`);
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
const { generateRawToken, hashToken } = await import('../utils/approvalActionToken.js');
const { PR_REJECTION_REASON_CODES, PR_TOKEN_PURPOSES } = await import('../utils/inventoryConstants.js');

// Every raw token this run ever sees, so the log sweep at the end is exhaustive.
const secrets = new Set();
const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { logged.push(a.map(String).join(' ')); orig(...a); };
}

// Transaction reads bypass the read monitor, so count them directly.
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
const UID = `h4test_approver_${TS}`;
const STAFF_DOC = `staff_${UID}`;
const PR1 = `pr_h4test_a_${TS}`;
const PR2 = `pr_h4test_b_${TS}`;
const AUDIT1 = `audit_inv_pr_inventory_pr_rejected_${PR1}`;
const ACTIONS_COLL = 'inventory_approval_actions';
const cleanup = { tokens: [], prs: [], audits: [AUDIT1], staff: false, authority: false };
let writes = 0, deletes = 0;
const r0 = readBudgetMonitor.estimatedReadsToday;
const iso = () => new Date().toISOString();
const svc = PurchaseRequestApprovalService;

/** Returns the thrown error code, and fails loudly if a secret leaked into it. */
const expectCode = async (fn) => {
  try { await fn(); return 'no throw'; } catch (e) {
    const blob = `${e.message || ''} ${e.code || ''} ${e.stack || ''}`;
    for (const s of secrets) if (s && blob.includes(s)) return `LEAKED_TOKEN_IN_ERROR`;
    return e.code || e.message;
  }
};
const tokenDoc = (h) => db.collection(ACTIONS_COLL).doc(h).get().then(s => s.data());
const prDoc = (id) => db.collection('purchase_requests').doc(id).get().then(s => s.data());
const setPrStatus = async (id, status) => { await db.collection('purchase_requests').doc(id).update({ status }); writes++; };

/** Writes a synthetic action document directly, at the hash of a token we mint. */
const plantToken = async (fields) => {
  const raw = generateRawToken();
  const hash = hashToken(raw);
  secrets.add(raw);
  await db.collection(ACTIONS_COLL).doc(hash).set({
    pr_id: PR1, pr_number: `PR-H4-${TS}`, approver_uid: UID,
    action: 'REJECTED', purpose: PR_TOKEN_PURPOSES.REASON_CAPTURE, parent_token_hash: null,
    token_hash: hash, consumed_at: null, consumed_via: null, meta_message_id: null,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(), created_at: iso(), created_by: 'h4_test',
    ...fields
  });
  writes++; cleanup.tokens.push(hash);
  return { raw, hash };
};

const mint = async (prId, action) => {
  const t = await actions.createApprovalActionFirestore({
    pr_id: prId, pr_number: `PR-H4-${TS}`, approver_uid: UID, action,
    expires_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(), created_by: 'h4_test'
  });
  writes++; cleanup.tokens.push(t.token_hash); secrets.add(t.raw_token);
  return t;
};

try {
  // ── fixtures: direct writes only, zero reads ──────────────────────────────
  await db.collection('staff').doc(STAFF_DOC).set({
    staff_id: STAFF_DOC, user_uid: UID, username: `h4test_${TS}`, full_name: 'H4 Test Approver',
    email: `h4test_${TS}@example.invalid`, role: 'admin', department: 'Administration',
    status: 'Active', is_active: true, created_at: iso(), updated_at: iso()
  }); writes++; cleanup.staff = true;
  await db.collection('inventory_approval_authorities').doc(UID).set({
    user_uid: UID, display_name: 'H4 Test Approver', whatsapp_e164: null,
    whatsapp_verified_at: null, whatsapp_verification_method: null, is_active: true,
    created_at: iso(), created_by: 'h4_test', updated_at: iso(), updated_by: 'h4_test'
  }); writes++; cleanup.authority = true;
  for (const id of [PR1, PR2]) {
    await db.collection('purchase_requests').doc(id).set({
      request_id: id, request_number: `PR-H4-${id.endsWith(`a_${TS}`) ? 'A' : 'B'}-${TS}`, status: 'PENDING_APPROVAL',
      requested_by_uid: `h4test_requester_${TS}`, requested_by_name: 'H4 Requester',
      department: 'Kitchen', location_id: null, business_date: iso().slice(0, 10),
      item_count: 0, total_estimated_value: 0, approvals: [], status_history: [],
      created_at: iso(), updated_at: iso()
    }); writes++; cleanup.prs.push(id);
  }
  const D1 = await mint(PR1, 'REJECT');    // the approver's REJECT decision token
  const D2 = await mint(PR1, 'APPROVE');   // sibling, must be retired on rejection
  const D3 = await mint(PR2, 'REJECT');
  const D4 = await mint(PR2, 'APPROVE');
  console.log('  fixtures: 1 staff doc, 1 authority, 2 requests, 4 decision tokens\n');

  // ── 1. valid begin ────────────────────────────────────────────────────────
  console.log('  -- 1. begin rejection --');
  const I1 = await svc.beginTokenRejection({ raw_token: D1.raw_token, decided_by_uid: UID });
  writes++; cleanup.tokens.push(hashToken(I1.raw_token)); secrets.add(I1.raw_token);
  ok('1. begin returns a fresh intent token', typeof I1.raw_token === 'string' && I1.raw_token.length === 43);
  ok('  it is a different token from the decision token', I1.raw_token !== D1.raw_token);
  ok('  it names the request and the action', I1.request_id === PR1 && I1.action === 'REJECTED');
  ok('  it offers the server-owned reason codes', Array.isArray(I1.reason_codes) && I1.reason_codes.includes('BUDGET_UNAVAILABLE'));
  ok('  it expires within the short window', Date.parse(I1.expires_at) - Date.now() <= 10 * 60 * 1000 + 5000);
  const intentDoc = await tokenDoc(hashToken(I1.raw_token));
  ok('  stored with purpose REASON_CAPTURE and the parent hash',
    intentDoc.purpose === 'REASON_CAPTURE' && intentDoc.parent_token_hash === D1.token_hash);
  ok('  the stored intent holds no raw token', !Object.values(intentDoc).some(v => typeof v === 'string' && secrets.has(v)));

  // ── 17. abandoning begin costs the approver nothing ───────────────────────
  ok('17. begin did NOT consume the original decision token', (await tokenDoc(D1.token_hash)).consumed_at === null);
  ok('  nor the approve sibling', (await tokenDoc(D2.token_hash)).consumed_at === null);

  // ── 3, 4, 5. the reason is validated before anything is read ──────────────
  console.log('\n  -- 3/4/5. reason validation, before any Firestore read --');
  const runsBeforeReason = txnRuns;
  ok('3. a missing reason code is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token })) === 'REJECTION_REASON_CODE_REQUIRED');
  ok('  an empty reason code is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, reason_code: '   ' })) === 'REJECTION_REASON_CODE_REQUIRED');
  ok('4. an unknown reason code is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, reason_code: 'NOT_A_REAL_REASON' })) === 'REJECTION_REASON_CODE_INVALID');
  ok('5. free text alongside a valid code is REFUSED, not ignored',
    await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, reason_code: 'BUDGET_UNAVAILABLE', reason: 'because I said so' })) === 'REJECTION_REASON_TEXT_NOT_ACCEPTED');
  ok('  a free-text comment is refused the same way',
    await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, reason_code: 'BUDGET_UNAVAILABLE', comment: 'off the books' })) === 'REJECTION_REASON_TEXT_NOT_ACCEPTED');
  ok('  none of those reached a transaction', txnRuns === runsBeforeReason);

  // ── 7, 21. token shape and purpose ────────────────────────────────────────
  console.log('\n  -- 7/21. token shape and purpose --');
  const good = { reason_code: 'BUDGET_UNAVAILABLE' };
  ok('7. a malformed intent is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: 'nope', ...good })) === 'TOKEN_INVALID');
  ok('  an unknown but well-formed intent is refused identically (no oracle)',
    await expectCode(() => svc.completeTokenRejection({ raw_token: generateRawToken(), ...good })) === 'TOKEN_INVALID');
  ok('21. a DECISION token cannot be used to complete a rejection',
    await expectCode(() => svc.completeTokenRejection({ raw_token: D1.raw_token, ...good })) === 'TOKEN_PURPOSE_MISMATCH');
  ok('  a REASON_CAPTURE intent cannot be used on the one-step decision path',
    await expectCode(() => svc.decideWithApprovalActionToken({ raw_token: I1.raw_token, decided_by_uid: UID, action: 'REJECTED', reason: 'x'.repeat(5) })) === 'TOKEN_PURPOSE_MISMATCH');
  ok('  an APPROVE decision token cannot begin a rejection',
    await expectCode(() => svc.beginTokenRejection({ raw_token: D2.raw_token, decided_by_uid: UID })) === 'TOKEN_ACTION_MISMATCH');
  ok('  begin refuses an intent presented as a decision token',
    await expectCode(() => svc.beginTokenRejection({ raw_token: I1.raw_token, decided_by_uid: UID })) === 'TOKEN_PURPOSE_MISMATCH');

  // ── 8, 11. bindings ───────────────────────────────────────────────────────
  console.log('\n  -- 8/11. bindings --');
  ok('8. a different approver is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, decided_by_uid: 'h4test_someone_else', ...good })) === 'TOKEN_APPROVER_MISMATCH');
  ok('11. a different request is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, request_id: PR2, ...good })) === 'TOKEN_PR_MISMATCH');
  ok('  begin refuses a mismatched request too', await expectCode(() => svc.beginTokenRejection({ raw_token: D1.raw_token, decided_by_uid: UID, request_id: PR2 })) === 'TOKEN_PR_MISMATCH');
  ok('  a missing identity is refused at begin', await expectCode(() => svc.beginTokenRejection({ raw_token: D1.raw_token, decided_by_uid: '' })) === 'APPROVER_REQUIRED');

  // ── 22. parent relationship ───────────────────────────────────────────────
  console.log('\n  -- 22. parent-token binding --');
  const orphan = await plantToken({ parent_token_hash: null });
  ok('22. an intent with no parent is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: orphan.raw, ...good })) === 'TOKEN_PARENT_MISMATCH');
  const wrongParent = await plantToken({ parent_token_hash: D3.token_hash });   // D3 belongs to PR2
  ok('  an intent whose parent belongs to another request is refused',
    await expectCode(() => svc.completeTokenRejection({ raw_token: wrongParent.raw, ...good })) === 'TOKEN_PARENT_MISMATCH');
  const approveParent = await plantToken({ parent_token_hash: D2.token_hash }); // D2 is an APPROVE token
  ok('  an intent whose parent is an APPROVE token is refused',
    await expectCode(() => svc.completeTokenRejection({ raw_token: approveParent.raw, ...good })) === 'TOKEN_PARENT_MISMATCH');

  // ── 6. expiry ─────────────────────────────────────────────────────────────
  console.log('\n  -- 6. expiry --');
  const stale = await plantToken({ parent_token_hash: D1.token_hash, expires_at: new Date(Date.now() - 1000).toISOString() });
  ok('6. an expired intent is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: stale.raw, ...good })) === 'TOKEN_EXPIRED');

  // ── 9, 10. eligibility revalidated at decision time ───────────────────────
  console.log('\n  -- 9/10. staff and authority revalidated --');
  await db.collection('inventory_approval_authorities').doc(UID).update({ is_active: false }); writes++;
  ok('9. an inactive authority is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, ...good })) === 'AUTHORITY_INACTIVE');
  await db.collection('inventory_approval_authorities').doc(UID).update({ is_active: true }); writes++;
  await db.collection('staff').doc(STAFF_DOC).update({ is_active: false, status: 'Inactive' }); writes++;
  ok('10. inactive staff is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, ...good })) === 'STAFF_INACTIVE');
  await db.collection('staff').doc(STAFF_DOC).update({ is_active: true, status: 'Active' }); writes++;
  ok('  the intent survived every refusal unconsumed', (await tokenDoc(hashToken(I1.raw_token))).consumed_at === null);

  // ── 12, 13, 19. terminal requests, checked inside the transaction ─────────
  console.log('\n  -- 12/13/19. a terminal request refuses, and consumes nothing --');
  await setPrStatus(PR1, 'APPROVED');
  const runsBeforeTerminal = txnRuns;
  ok('12. an already-APPROVED request refuses the rejection',
    await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, ...good })) === 'INVALID_STATUS_TRANSITION');
  ok('  and it was the existing in-transaction guard that refused it', txnRuns > runsBeforeTerminal);
  ok('  begin also refuses on a terminal request', await expectCode(() => svc.beginTokenRejection({ raw_token: D1.raw_token, decided_by_uid: UID })) === 'INVALID_STATUS_TRANSITION');
  await setPrStatus(PR1, 'REJECTED');
  ok('13. an already-REJECTED request refuses the rejection',
    await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, ...good })) === 'INVALID_STATUS_TRANSITION');
  ok('19. a failed completion left the intent unconsumed', (await tokenDoc(hashToken(I1.raw_token))).consumed_at === null);
  ok('  and left the request untouched', (await prDoc(PR1)).approvals.length === 0);
  await setPrStatus(PR1, 'PENDING_APPROVAL');

  // ── 2, 15, 18. concurrent completion ──────────────────────────────────────
  console.log('\n  -- 2/15/18. concurrent completion of one intent --');
  const runsAtRace = txnRuns;
  const settled = await Promise.allSettled([
    svc.completeTokenRejection({ raw_token: I1.raw_token, reason_code: 'BUDGET_UNAVAILABLE' }),
    svc.completeTokenRejection({ raw_token: I1.raw_token, reason_code: 'DUPLICATE_REQUEST' })
  ]);
  writes += 4; // request update + intent consume (one transaction), audit, sibling retirement
  const wins = settled.filter(s => s.status === 'fulfilled' && s.value?.duplicate === false);
  const losers = settled.filter(s => s.status === 'rejected').map(s => s.reason?.code);
  ok('2. exactly one completion recorded the rejection', wins.length === 1, `wins=${wins.length}`);
  ok('15. the other was refused as TOKEN_CONSUMED', losers.length === 1 && losers[0] === 'TOKEN_CONSUMED', `loser=${losers[0] ?? 'none'}`);
  ok('  both attempts really ran transactions', txnRuns - runsAtRace >= 2, `${txnRuns - runsAtRace} runs`);
  const pr1After = await prDoc(PR1);
  ok('  the request is REJECTED exactly once', pr1After.status === 'REJECTED' && pr1After.approvals.length === 1, `approvals=${pr1After.approvals.length}`);
  ok('  rejection_reason holds the SERVER text for the chosen code',
    Object.values(PR_REJECTION_REASON_CODES).includes(pr1After.rejection_reason), String(pr1After.rejection_reason));
  ok('  the approval record carries the same reason and the decision-time role',
    pr1After.approvals[0].comment === pr1After.rejection_reason && pr1After.approvals[0].approver_role === 'admin');
  ok('  status history records the transition', (pr1After.status_history || []).some(h => h.status === 'REJECTED' && h.by_uid === UID));
  ok('  rejected_by is the token approver', pr1After.rejected_by_uid === UID);
  ok('18. the intent was consumed in the same commit',
    (await tokenDoc(hashToken(I1.raw_token))).consumed_via === 'REASON_CAPTURE_INTENT');
  ok('  the original REJECT decision token was retired afterwards',
    (await tokenDoc(D1.token_hash)).consumed_via === 'INVALIDATED:PR_REJECTED');
  ok('  so was the unused APPROVE sibling', (await tokenDoc(D2.token_hash)).consumed_via === 'INVALIDATED:PR_REJECTED');

  // ── 14. replay ────────────────────────────────────────────────────────────
  console.log('\n  -- 14. replay --');
  ok('14. replaying the spent intent is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: I1.raw_token, ...good })) === 'TOKEN_CONSUMED');
  ok('  the retired decision token is refused too', await expectCode(() => svc.beginTokenRejection({ raw_token: D1.raw_token, decided_by_uid: UID })) === 'TOKEN_CONSUMED');
  ok('  and the request did not change again', (await prDoc(PR1)).approvals.length === 1);

  // ── 20. the audit ─────────────────────────────────────────────────────────
  console.log('\n  -- 20. audit --');
  const audit = await db.collection('audit_logs').doc(AUDIT1).get().then(s => s.data());
  const details = String(audit?.details || '');
  ok('20. a rejection audit record was written', !!audit && audit.action === 'INVENTORY_PR_REJECTED');
  ok('  it carries the reason text', Object.values(PR_REJECTION_REASON_CODES).some(t => details.includes(t)));
  ok('  it carries the structured reason code', /"rejection_reason_code":"[A-Z_]+"/.test(details));
  ok('  it names the channel', details.includes('"decision_channel":"REASON_CAPTURE_INTENT"'));
  ok('  it contains NO raw token and NO token hash',
    ![...secrets].some(s => details.includes(s)) && !details.includes(D1.token_hash) && !details.includes(hashToken(I1.raw_token)));

  // ── 16. concurrent approve versus rejection, on a second request ──────────
  console.log('\n  -- 16. concurrent approve vs reject, one request --');
  const I2 = await svc.beginTokenRejection({ raw_token: D3.raw_token, decided_by_uid: UID });
  writes++; cleanup.tokens.push(hashToken(I2.raw_token)); secrets.add(I2.raw_token);
  const settled2 = await Promise.allSettled([
    svc.completeTokenRejection({ raw_token: I2.raw_token, reason_code: 'NOT_REQUIRED_NOW' }),
    svc.decideWithApprovalActionToken({ raw_token: D4.raw_token, decided_by_uid: UID, action: 'APPROVED' })
  ]);
  writes += 4;
  const decided = settled2.filter(s => s.status === 'fulfilled' && s.value?.duplicate === false);
  ok('16. exactly one of approve and reject was recorded', decided.length === 1, `${decided.length} decisions`);
  const pr2After = await prDoc(PR2);
  ok('  the request landed in exactly one terminal state',
    ['APPROVED', 'REJECTED'].includes(pr2After.status) && pr2After.approvals.length === 1, `${pr2After.status}, approvals=${pr2After.approvals.length}`);
  ok('  the loser was refused deterministically',
    settled2.filter(s => s.status === 'rejected').every(s => ['TOKEN_CONSUMED', 'INVALID_STATUS_TRANSITION', 'APPROVER_ALREADY_ACTED'].includes(s.reason?.code)),
    settled2.filter(s => s.status === 'rejected').map(s => s.reason?.code).join(',') || 'none');
  cleanup.audits.push(`audit_inv_pr_inventory_pr_${pr2After.status.toLowerCase()}_${PR2}`);

  // ── 20 (logs). no secret was ever printed ─────────────────────────────────
  console.log('\n  -- 20. secrets never printed --');
  const blob = logged.join('\n');
  ok('no raw token appears anywhere in this run\'s console output',
    ![...secrets].some(s => s && blob.includes(s)), `${secrets.size} secrets checked`);
} finally {
  console.log('\n  -- cleanup: only this run\'s synthetic documents, by known id --');
  for (const h of cleanup.tokens) { await db.collection(ACTIONS_COLL).doc(h).delete(); deletes++; }
  for (const id of cleanup.prs) { await db.collection('purchase_requests').doc(id).delete(); deletes++; }
  for (const id of cleanup.audits) { await db.collection('audit_logs').doc(id).delete(); deletes++; }
  if (cleanup.authority) { await db.collection('inventory_approval_authorities').doc(UID).delete(); deletes++; }
  if (cleanup.staff) { await db.collection('staff').doc(STAFF_DOC).delete(); deletes++; }
  console.log(`  deleted ${deletes} documents (${cleanup.tokens.length} tokens, ${cleanup.prs.length} requests, ${cleanup.audits.length} audits, 1 authority, 1 staff)`);
}

const monitorReads = readBudgetMonitor.estimatedReadsToday - r0;
console.log(`\n═══ H4 REJECTION INTENT: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
console.log(`\n[DEV READS ~${monitorReads + txnGets}]  (repository ${monitorReads} + transaction ${txnGets} across ${txnRuns} runs)`);
console.log(`[DEV WRITES ~${writes}]  [DEV DELETES ${deletes}]  [PRODUCTION ACCESS] 0  [WHATSAPP CALLS] 0`);
process.exit(fail === 0 ? 0 : 1);
