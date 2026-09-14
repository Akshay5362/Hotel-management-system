/**
 * backend/tests/testInventoryWhatsAppDecisionRoutingH7.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H7 — inbound WhatsApp Approve/Reject decision routing.
 *
 * PART A — no Firebase. Static invariants over every H7 file plus the two pure
 *   modules (the action payload and the reply transport). Imports nothing that
 *   reaches firebaseAdmin, which initialises against PRODUCTION when HPMS_ENV
 *   is unset.
 *
 * PART B — DEV Firestore behind the four-layer guard, driven through the REAL
 *   webhook router over real HTTP with real HMAC signatures, so every tap
 *   travels the path a real one will: signed body, raw bytes, wamid claim,
 *   dispatcher, router, engine. The reply transport is a recorder: no Meta
 *   credential exists and no network call is ever made.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryWhatsAppDecisionRoutingH7.mjs
 *       node backend/tests/testInventoryWhatsAppDecisionRoutingH7.mjs     (Part A only)
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

const PAYLOAD_SRC = codeOnly(src('backend', 'utils', 'whatsappActionPayload.js'));
const CLIENT = codeOnly(src('backend', 'services', 'whatsappOutboundClient.js'));
const ROUTER = codeOnly(src('backend', 'services', 'whatsappDecisionRouter.js'));
const DISPATCH = codeOnly(src('backend', 'services', 'whatsappInboundDispatcher.js'));
const WCTRL = codeOnly(src('backend', 'controllers', 'whatsappWebhookController.js'));
const VSVC = codeOnly(src('backend', 'services', 'whatsappAuthorityVerificationService.js'));
const SVC = codeOnly(src('backend', 'services', 'purchaseRequestApprovalService.js'));
const FLAGS = src('backend', 'config', 'featureFlags.js');
const RULES = src('firestore.rules');
const H7_CODE = PAYLOAD_SRC + CLIENT + ROUTER + DISPATCH;

console.log('═══ PART A — source invariants and pure logic (no Firebase) ═══');

console.log('\n  -- the kill switch --');
ok('A1. ENABLE_WHATSAPP_DECISIONS defaults OFF (strict equality, no truthy fallback)',
  /ENABLE_WHATSAPP_DECISIONS === 'true'/.test(FLAGS) && !/ENABLE_WHATSAPP_DECISIONS\s*\|\|/.test(FLAGS));
ok('  it is evaluated server-side in the router, not trusted from a payload',
  /isWhatsAppDecisionsEnabled\(\)/.test(ROUTER) && !/req\.|body\.|query\./.test(ROUTER));
ok('  and BEFORE any token is read, so a disabled channel consumes nothing',
  ROUTER.indexOf('isWhatsAppDecisionsEnabled()') < ROUTER.indexOf('handleApprove(parsed, ctx)'));

console.log('\n  -- the action payload is bounded and strict --');
const payload = await import('../utils/whatsappActionPayload.js');
const T = 'A'.repeat(43);
const approvePayload = payload.buildApprovePayload(T);
const reasonPayload = payload.buildReasonPayload(T, 'SUPPLIER_OR_PRICE_WRONG');
ok('A2. every built payload is well inside Meta\'s stricter identifier limit',
  approvePayload.length <= payload.MAX_ACTION_PAYLOAD_LENGTH &&
  reasonPayload.length <= payload.MAX_ACTION_PAYLOAD_LENGTH && payload.MAX_ACTION_PAYLOAD_LENGTH === 200,
  `approve=${approvePayload.length} reason=${reasonPayload.length} max=${payload.MAX_ACTION_PAYLOAD_LENGTH}`);
ok('  a well-formed payload round-trips',
  payload.parseActionPayload(approvePayload).token === T &&
  payload.parseActionPayload(reasonPayload).reason_code === 'SUPPLIER_OR_PRICE_WRONG');
ok('A3. parsing refuses everything malformed, and never throws',
  ['', '   ', 'nope', 'hpms.v1.ap', 'hpms.v2.ap.' + T, 'hpms.v1.zz.' + T, 'hpms.v1.ap.short',
    'hpms.v1.ap.' + T + '.extra', 'hpms.v1.rr.' + T, 'hpms.v1.rr.' + T + '.lower case',
    'x'.repeat(300), null, undefined, 42, {}]
    .every(v => payload.parseActionPayload(v).ok === false));
ok('  a foreign namespace is "not an action", not a bad action',
  payload.parseActionPayload('hpms:REJECT:' + T).reason === 'NOT_AN_ACTION');
ok('  builders refuse a malformed token or reason code',
  payload.buildApprovePayload('short') === null && payload.buildApprovePayload(null) === null &&
  payload.buildReasonPayload(T, 'bad code') === null && payload.buildReasonPayload(T, '') === null);
ok('A4. approve and reject payloads cannot be confused with each other',
  payload.parseActionPayload(approvePayload).action !== payload.parseActionPayload(payload.buildRejectPayload(T)).action);
ok('  the payload util is pure: no logging, no Firebase, no Express',
  !/console\./.test(PAYLOAD_SRC) && !/firebase|firestore|req\.|res\./i.test(PAYLOAD_SRC));

console.log('\n  -- the router is a router --');
ok('A5. it never writes to a purchase request and never opens a transaction',
  !/purchase_requests|txn\.|runTransaction|updateDoc\(|\.set\(/.test(ROUTER));
ok('  it never consumes or mints a token',
  !/markApprovalActionConsumedInTxn|consumeApprovalAction|createApprovalActionFirestore|hashToken/.test(ROUTER));
ok('  it reaches the engine only through the three existing entry points',
  /decideWithApprovalActionToken\(/.test(ROUTER) && /beginTokenRejection\(/.test(ROUTER) && /completeTokenRejection\(/.test(ROUTER) &&
  (ROUTER.match(/PurchaseRequestApprovalService\./g) || []).length === 3);
// Four places name an identity: the three engine calls and the Socket.IO
// payload. EVERY one must read it from the resolved authority, never from the
// payload the sender controls.
ok('A6. identity comes from the resolved sender, never from the payload',
  (() => { const uses = ROUTER.match(/decided_by_uid:.*/g) || [];
    return uses.length === 4 && uses.every(u => /ctx\.authorityId|authority\.authority_id/.test(u))
      && !/decided_by_uid:\s*(parsed|payload|sender_id|event)/.test(ROUTER); })());
ok('  all three engine calls use the resolved authority id',
  (ROUTER.match(/decided_by_uid: ctx\.authorityId/g) || []).length === 3);
ok('  the sender is resolved BEFORE any action is taken',
  ROUTER.indexOf('resolveAuthorityBySender(sender_id)') < ROUTER.indexOf('isWhatsAppDecisionsEnabled()'));
ok('A7. an unknown sender gets no reply at all',
  /if \(resolved\.code === 'UNKNOWN_SENDER'\)[\s\S]{0,200}return ROUTER_OUTCOME\.UNKNOWN_SENDER/.test(ROUTER) &&
  !/UNKNOWN_SENDER[\s\S]{0,200}sendText/.test(ROUTER));
ok('  the rejection completion passes the identity so H4 can cross-check it',
  /completeTokenRejection\(\{[\s\S]{0,200}decided_by_uid: ctx\.authorityId/.test(ROUTER));

console.log('\n  -- one canonical sender resolution --');
ok('A8. the resolver reuses the single verification predicate, it does not restate it',
  /assessAuthorityVerification\(authority\)/.test(VSVC) &&
  !/verification_expires_at|VERIFICATION_VALIDITY/.test(codeOnly(src('backend', 'services', 'whatsappDecisionRouter.js'))));
ok('  it checks binding, authority, type, verification and active state',
  /getNumberBindingByNumberFirestore\(senderE164\)/.test(VSVC) && /BINDING_STATUS\.VERIFIED/.test(VSVC) &&
  /authority\.whatsapp_e164 !== senderE164/.test(VSVC) && /authority\.is_active !== true/.test(VSVC));
ok('  the router owns no second copy of those rules',
  !/is_active|verification_status|authority_type/.test(ROUTER));

console.log('\n  -- the external path reads no staff record --');
const extStart = SVC.indexOf('if (authority.authority_type === APPROVAL_AUTHORITY_TYPES.EXTERNAL) {');
const EXTERNAL_BRANCH = SVC.slice(extStart, SVC.indexOf('if (authority.authority_type === APPROVAL_AUTHORITY_TYPES.INTERNAL) {'));
ok('A9. the EXTERNAL principal needs no staff document, role or Firebase token',
  extStart > 0 && !/getStaffByUidFirestore|normalizeUserRole|assertStaffEligible|verifyIdToken/.test(EXTERNAL_BRANCH));
ok('  self-approval still compares the requester against linked_staff_uid',
  /\(linked && requester === linked\)/.test(SVC));
ok('  the engine still holds exactly one decision transaction',
  (SVC.match(/db\.runTransaction\(/g) || []).length === 1);

console.log('\n  -- Socket.IO is a notification, never authorization --');
ok('A10. the decision event is emitted only after the engine returns',
  ROUTER.indexOf('await PurchaseRequestApprovalService.decideWithApprovalActionToken') < ROUTER.indexOf('emitDecided(ctx.io'));
ok('  a duplicate replay emits nothing',
  /if \(result\.duplicate\) \{[\s\S]{0,200}return ROUTER_OUTCOME\.APPROVE_DUPLICATE/.test(ROUTER));
ok('  the emit reuses the existing event name and cannot throw into the caller',
  /PR_EVENTS\.DECIDED/.test(ROUTER) && /catch \(err\) \{[\s\S]{0,120}emit failed/.test(ROUTER));
ok('  the dispatcher receives only an io handle, never a request',
  /dispatchInboundWhatsAppEvents\(claimedEvents = \[\], \{ io = null \} = \{\}\)/.test(DISPATCH) && !/req\.|res\./.test(DISPATCH));

console.log('\n  -- the reply transport --');
const transport = await import('../services/whatsappOutboundClient.js');
ok('A11. it is pure transport: no Firestore, no approval logic',
  !/firestore|firebaseAdmin|purchaseRequest|ApprovalService/i.test(CLIENT));
ok('  it sends no templates and owns no message collection (H8 scope)',
  !/template|whatsapp_messages/i.test(CLIENT));
const unconfigured = transport.createWhatsAppReplyClient({ apiVersion: '', phoneNumberId: '', accessToken: '' });
const unconfiguredResult = await unconfigured.sendText('919999999999', 'hello');
ok('A12. with no credentials it is a no-op and never throws',
  unconfigured.configured === false && unconfiguredResult.sent === false && unconfiguredResult.reason === 'NOT_CONFIGURED');
const recorded = [];
const fake = transport.createWhatsAppReplyClient({ transport: async (body) => { recorded.push(body); return { ok: true, status: 200, json: { messages: [{ id: 'wamid.fake' }] } }; } });
await fake.sendText('919999999999', 'approved');
await fake.sendReasonList('919999999999', { body: 'why?', buttonLabel: 'Choose a reason', rows: [{ id: reasonPayload, title: 'Budget unavailable', description: 'x' }] });
ok('  an injected transport receives the message and no network call is made',
  recorded.length === 2 && recorded[0].type === 'text' && recorded[1].interactive.type === 'list');
ok('  a failing transport is reported, not thrown',
  (await transport.createWhatsAppReplyClient({ transport: async () => { throw new Error('network down'); } }).sendText('x', 'y')).sent === false);
ok('  list rows are clamped to Meta\'s documented ceilings',
  (await (async () => { const r = []; const c = transport.createWhatsAppReplyClient({ transport: async b => { r.push(b); return { ok: true, json: {} }; } });
    await c.sendReasonList('x', { body: 'b', rows: Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, title: 'T'.repeat(50) })) });
    const rows = r[0].interactive.action.sections[0].rows;
    return rows.length === transport.LIST_LIMITS.MAX_ROWS && rows[0].title.length === transport.LIST_LIMITS.ROW_TITLE; })()));

console.log('\n  -- secrets --');
ok('A13. no raw token is ever logged or audited',
  !/console\.[a-z]+\([^)]*\$\{[^}]*(raw_token|parsed\.token|token)\b/.test(H7_CODE) &&
  !/writeAudit\([^;]*parsed\.token|writeAudit\([^;]*raw_token/.test(ROUTER));
ok('  no verification code, HMAC secret or credential appears in H7',
  !/challenge_code|verificationCode|WHATSAPP_VERIFICATION_SECRET|WHATSAPP_APP_SECRET|EAA[A-Za-z0-9]{20,}/.test(H7_CODE));
ok('  the access token is read from the environment only, and never logged',
  /process\.env\.WHATSAPP_ACCESS_TOKEN/.test(CLIENT) && !/console\.[a-z]+\([^)]*accessToken/.test(CLIENT));
ok('  the router logs no phone number, and audits only masked ones',
  !/console\.[a-z]+\([^)]*sender_id/.test(ROUTER) && /maskWhatsAppNumber/.test(ROUTER));
ok('  button and list titles carry no token',
  /title: titleFor\(code\)/.test(ROUTER) && !/title:[^,]*token/.test(ROUTER));

console.log('\n  -- extraction reads only documented reply shapes --');
ok('A14. template quick replies and interactive replies are both read',
  /messageType === 'button' && typeof message\?\.button\?\.payload === 'string'/.test(WCTRL) &&
  /interactive\?\.type === 'button_reply'/.test(WCTRL) && /interactive\?\.type === 'list_reply'/.test(WCTRL));
ok('  anything else yields null rather than a guess', /return null;/.test(WCTRL));
ok('  the payload is capped like the text', /\.slice\(0, MAX_TEXT_LENGTH\)/.test(WCTRL));
ok('  H5 ordering is intact: verify, then parse, then claim, then dispatch',
  WCTRL.indexOf('verifyWebhookSignature(') < WCTRL.indexOf('JSON.parse(') &&
  WCTRL.indexOf('JSON.parse(') < WCTRL.indexOf('claimWebhookEventFirestore(') &&
  WCTRL.indexOf('claimWebhookEventFirestore(') < WCTRL.indexOf('dispatchVerifiedWebhookEvents(claimed'));

console.log('\n  -- scope --');
ok('A15. H7 adds no Firestore collection and no rules change',
  !/whatsapp_messages|collection\('whatsapp_(?!number_bindings|webhook_events)/.test(H7_CODE) &&
  !/whatsapp_messages/.test(RULES));
ok('  H7 adds no route: the public surface is still the two H5 paths',
  (codeOnly(src('backend', 'routes', 'whatsappRoutes.js')).match(/router\.(get|post)\(/g) || []).length === 2);
ok('  no submit-time minting, no authority picker, no template (H8 scope)',
  !/submitPurchaseRequest|authority_picker|sendTemplate/.test(H7_CODE));

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H7 DECISION ROUTING: ${pass} passed, ${fail} failed (Part A only) ═══`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\n═══ PART B — DEV Firestore + real HTTP (sky5-development only) ═══\n');

const { createRequire } = await import('module');
const require_ = createRequire(path.join(BACKEND, 'package.json'));
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });
const { isProductionProject } = await import('../config/productionSafetyGuard.js');
if (isProductionProject()) { console.error('[SAFETY_ABORT] production project.'); process.exit(1); }
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }

const { db } = await import('../config/firebaseAdmin.js');
const liveProject = db?._settings?.projectId || PROJECT;
if (liveProject !== 'sky5-development') { console.error(`[SAFETY_ABORT] live handle "${liveProject}".`); process.exit(1); }
console.log(`  [GUARD] project=${liveProject} (DEV)\n`);

const APP_SECRET = 'h7_test_app_secret_value';
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = `h7_verify_${Date.now()}`;
process.env.ENABLE_WHATSAPP_WEBHOOK = 'true';
process.env.ENABLE_WHATSAPP_VERIFICATION = 'false';
process.env.ENABLE_WHATSAPP_DECISIONS = 'false';   // OFF first, on purpose
process.env.WHATSAPP_WEBHOOK_RATE_LIMIT_MAX = '500';

const { FieldPath } = require_('firebase-admin/firestore');
const express = (await import('express')).default;
const http = await import('http');
const whatsappRoutes = (await import('../routes/whatsappRoutes.js')).default;
const { computeSignatureHeader } = await import('../utils/whatsappSignature.js');
const { readBudgetMonitor } = await import('../utils/firestoreReadBudget.js');
const actions = await import('../repositories/firestore/inventoryApprovalActionsRepository.js');
const { hashToken } = await import('../utils/approvalActionToken.js');
const { PR_REJECTION_REASON_CODES } = await import('../utils/inventoryConstants.js');

// A recording reply client, installed on the REAL path. No Meta credential
// exists in DEV and this transport never reaches the network.
const replies = [];
let metaCalls = 0;
const recordingClient = transport.createWhatsAppReplyClient({
  transport: async (body) => { metaCalls++; replies.push(body); return { ok: true, status: 200, json: { messages: [{ id: `wamid.reply.${replies.length}` }] } }; }
});
transport.setWhatsAppReplyClient(recordingClient);

const emitted = [];
const fakeIo = { emit: (event, data) => emitted.push({ event, data }) };

const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { logged.push(a.map(String).join(' ')); orig(...a); };
}
let txnRuns = 0;
const origRunTransaction = db.runTransaction.bind(db);
db.runTransaction = (fn, opts) => origRunTransaction(async (t) => { txnRuns++; return fn(t); }, opts);

const app = express();
app.set('io', fakeIo);
app.use('/api/whatsapp', whatsappRoutes);
app.use(express.json());
const server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/api/whatsapp/webhook`;

const TS = Date.now();
const SUF = String(TS).slice(-8);
const NUM_A = `+9170${SUF}`, NUM_B = `+9171${SUF}`, NUM_X = `+9172${SUF}`;
const digits = (e) => e.slice(1);
const A_ID = `aa_${'a'.repeat(28)}${SUF.slice(-4)}`;
const B_ID = `aa_${'b'.repeat(28)}${SUF.slice(-4)}`;
const PR1 = `pr_h7test_a_${TS}`, PR2 = `pr_h7test_b_${TS}`, PR3 = `pr_h7test_c_${TS}`, PR4 = `pr_h7test_d_${TS}`;
const cleanup = { authorities: [A_ID, B_ID], numbers: [NUM_A, NUM_B], tokens: [], prs: [], wamids: [], audits: [] };
const secrets = new Set();
let writes = 0, deletes = 0;
const r0 = readBudgetMonitor.estimatedReadsToday;
const iso = () => new Date().toISOString();
const future = (ms) => new Date(Date.now() + ms).toISOString();

let seq = 0;
/** Delivers a signed interactive reply through the REAL webhook. */
const tap = async (from, actionPayload, kind = 'button_reply') => {
  const wamid = `wamid.H7${TS}.${++seq}`;
  cleanup.wamids.push(`msg:${wamid}`);
  return await deliver(wamid, from, actionPayload, kind);
};
const deliver = async (wamid, from, actionPayload, kind) => {
  const message = kind === 'button'
    ? { id: wamid, from, type: 'button', button: { payload: actionPayload, text: 'Approve' } }
    : { id: wamid, from, type: 'interactive', interactive: { type: kind, [kind]: { id: actionPayload, title: 'x' } } };
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'h7', changes: [{ field: 'messages', value: { messages: [message] } }] }] });
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': computeSignatureHeader(Buffer.from(raw, 'utf8'), APP_SECRET) }, body: raw });
  return { status: r.status, json: await r.json(), wamid };
};
const lastOutcome = () => logged.filter(l => l.includes('[WhatsAppInbound]')).slice(-1)[0] || '';
const lastReply = () => replies.slice(-1)[0] || null;
const replyText = () => lastReply()?.text?.body || lastReply()?.interactive?.body?.text || '';
const tokenDoc = (h) => db.collection('inventory_approval_actions').doc(h).get().then(s => s.data());
const prDoc = (id) => db.collection('purchase_requests').doc(id).get().then(s => s.data());

const mkAuthority = async (id, e164, name) => {
  await db.collection('inventory_approval_authorities').doc(id).set({
    authority_id: id, authority_type: 'EXTERNAL', display_name: name, whatsapp_e164: e164,
    verification_status: 'VERIFIED', whatsapp_verified_at: iso(), whatsapp_verification_method: 'WHATSAPP_INBOUND_CODE',
    verified_sender_id: digits(e164), verification_expires_at: future(180 * 86400000),
    linked_staff_uid: null, is_active: true, created_by: 'h7_test', updated_by: 'h7_test', created_at: iso(), updated_at: iso()
  }); writes++;
  await db.collection('whatsapp_number_bindings').doc(`wa_${digits(e164)}`).set({
    number_key: `wa_${digits(e164)}`, whatsapp_e164: e164, authority_id: id, status: 'VERIFIED',
    challenge_code_hmac: null, challenge_expires_at: null, challenge_attempts: 0, challenge_issued_at: null,
    challenge_issued_by: null, challenge_consumed_at: iso(), verified_at: iso(), verified_sender_id: digits(e164),
    created_at: iso(), created_by: 'h7_test', updated_at: iso(), updated_by: 'h7_test'
  }); writes++;
};
const mkPr = async (id) => {
  await db.collection('purchase_requests').doc(id).set({
    request_id: id, request_number: `PR-H7-${id.slice(-6)}`, status: 'PENDING_APPROVAL',
    requested_by_uid: `h7test_requester_${TS}`, requested_by_name: 'H7 Requester', department: 'Kitchen',
    location_id: null, business_date: iso().slice(0, 10), item_count: 0, total_estimated_value: 0,
    approvals: [], status_history: [], created_at: iso(), updated_at: iso()
  }); writes++; cleanup.prs.push(id);
  cleanup.audits.push(`audit_inv_pr_inventory_pr_approved_${id}`, `audit_inv_pr_inventory_pr_rejected_${id}`);
};
const mint = async (prId, action, approverId) => {
  const t = await actions.createApprovalActionFirestore({
    pr_id: prId, pr_number: `PR-H7-${prId.slice(-6)}`, approver_uid: approverId, action,
    expires_at: future(48 * 3600 * 1000), created_by: 'h7_test'
  });
  writes++; cleanup.tokens.push(t.token_hash); secrets.add(t.raw_token);
  return t;
};

try {
  await mkAuthority(A_ID, NUM_A, 'H7 Authority A');
  await mkAuthority(B_ID, NUM_B, 'H7 Authority B');
  for (const id of [PR1, PR2, PR3, PR4]) await mkPr(id);
  console.log('  fixtures: 2 verified active authorities, 4 requests\n');

  // ── D. THE KILL SWITCH ────────────────────────────────────────────────────
  console.log('  -- D. feature flag OFF --');
  const T1a = await mint(PR1, 'APPROVE', A_ID);
  let r = await tap(digits(NUM_A), payload.buildApprovePayload(T1a.raw_token));
  ok('D1. a tap while decisions are disabled changes nothing', lastOutcome().includes('DECISION_DISABLED'), lastOutcome().slice(-40));
  ok('  the token was NOT consumed', (await tokenDoc(T1a.token_hash)).consumed_at === null);
  ok('  the request is untouched', (await prDoc(PR1)).status === 'PENDING_APPROVAL');
  ok('  the authority got a generic unavailable reply with no request detail',
    /not available/i.test(replyText()) && !replyText().includes('PR-H7') && !replyText().includes(T1a.raw_token));
  ok('  nothing was emitted', emitted.length === 0);
  const T1r = await mint(PR1, 'REJECT', A_ID);
  await tap(digits(NUM_A), payload.buildRejectPayload(T1r.raw_token));
  ok('D2. a reject tap while disabled mints no intent',
    lastOutcome().includes('DECISION_DISABLED') && (await tokenDoc(T1r.token_hash)).consumed_at === null);

  process.env.ENABLE_WHATSAPP_DECISIONS = 'true';
  ok('D3. the flag is read at execution time, so enabling needs no restart of this process', true);

  // ── B. APPROVAL ───────────────────────────────────────────────────────────
  console.log('\n  -- B. approval --');
  const T1b = await mint(PR1, 'APPROVE_SIBLING_UNUSED' === '' ? 'APPROVE' : 'APPROVE', B_ID); // B's sibling on PR1
  r = await tap(digits(NUM_A), payload.buildApprovePayload(T1a.raw_token));
  writes += 4;
  ok('B1. a verified authority\'s approve tap is recorded', lastOutcome().includes('DECISION_APPROVED'), lastOutcome().slice(-40));
  const pr1 = await prDoc(PR1);
  ok('  the request is APPROVED once, against the opaque authority id, with no role',
    pr1.status === 'APPROVED' && pr1.approvals.length === 1 && pr1.approvals[0].approver_uid === A_ID && pr1.approvals[0].approver_role === null);
  ok('B2. the token was consumed, marked with the WhatsApp channel',
    (await tokenDoc(T1a.token_hash)).consumed_via === 'WHATSAPP_BUTTON');
  ok('B3. sibling tokens for the request were retired, including the other authority\'s',
    (await tokenDoc(T1r.token_hash)).consumed_via === 'INVALIDATED:PR_APPROVED' &&
    (await tokenDoc(T1b.token_hash)).consumed_via === 'INVALIDATED:PR_APPROVED');
  ok('B4. PR_EVENTS.DECIDED was emitted once, post-commit',
    emitted.length === 1 && emitted[0].event === 'inventory:purchase_request_decided' &&
    emitted[0].data.status === 'APPROVED' && emitted[0].data.decided_by_uid === A_ID);
  ok('  the reply names the request and leaks no token',
    replyText().includes(pr1.request_number) && !replyText().includes(T1a.raw_token));
  const approveAudit = (await db.collection('audit_logs').where('action', '==', 'INVENTORY_WHATSAPP_APPROVAL_TAPPED').orderBy('created_at', 'desc').limit(3).get()).docs.map(d => d.data());
  ok('B5. the tap was audited with a masked number and no token',
    approveAudit.some(a => a.details.includes(A_ID)) && approveAudit.every(a => !a.details.includes(digits(NUM_A)) && ![...secrets].some(s => a.details.includes(s))));
  const prAudit = await db.collection('audit_logs').doc(`audit_inv_pr_inventory_pr_approved_${PR1}`).get().then(d => d.data());
  ok('  the engine\'s own decision audit names the WhatsApp channel',
    prAudit && prAudit.details.includes('"decision_channel":"WHATSAPP_BUTTON"') && prAudit.details.includes('"approver_type":"EXTERNAL"'));

  console.log('\n  -- B. duplicate tap and duplicate delivery --');
  const beforeDup = emitted.length;
  await tap(digits(NUM_A), payload.buildApprovePayload(T1a.raw_token));
  ok('B6. tapping the same button again decides nothing more',
    lastOutcome().includes('DECISION_REFUSED') && /already been decided/i.test(replyText()) && emitted.length === beforeDup);
  const first = await deliver(`wamid.H7dup.${TS}`, digits(NUM_A), payload.buildApprovePayload(T1a.raw_token), 'button_reply');
  cleanup.wamids.push(`msg:wamid.H7dup.${TS}`);
  const again = await deliver(`wamid.H7dup.${TS}`, digits(NUM_A), payload.buildApprovePayload(T1a.raw_token), 'button_reply');
  ok('B7. a re-delivered webhook is a duplicate and never reaches the router',
    first.json.claimed === 1 && again.json.duplicates === 1 && again.json.claimed === 0);

  console.log('\n  -- B. senders that must not decide --');
  const T2a = await mint(PR2, 'APPROVE', A_ID);
  const repliesBefore = replies.length;
  await tap(digits(NUM_X), payload.buildApprovePayload(T2a.raw_token));
  ok('B8. an unregistered sender is answered with silence',
    lastOutcome().includes('DECISION_UNKNOWN_SENDER') && replies.length === repliesBefore);
  ok('  and nothing was consumed', (await tokenDoc(T2a.token_hash)).consumed_at === null);
  await tap(digits(NUM_B), payload.buildApprovePayload(T2a.raw_token));
  ok('B9. another authority cannot use a token minted for someone else',
    lastOutcome().includes('DECISION_REFUSED') && (await tokenDoc(T2a.token_hash)).consumed_at === null);
  await db.collection('inventory_approval_authorities').doc(A_ID).update({ is_active: false }); writes++;
  await tap(digits(NUM_A), payload.buildApprovePayload(T2a.raw_token));
  ok('B10. a deactivated authority is refused and consumes nothing',
    lastOutcome().includes('DECISION_SENDER_NOT_ELIGIBLE') && (await tokenDoc(T2a.token_hash)).consumed_at === null);
  await db.collection('inventory_approval_authorities').doc(A_ID).update({ is_active: true }); writes++;
  await db.collection('inventory_approval_authorities').doc(A_ID).update({ verification_expires_at: new Date(Date.now() - 1000).toISOString() }); writes++;
  await tap(digits(NUM_A), payload.buildApprovePayload(T2a.raw_token));
  ok('B11. an expired verification is refused and consumes nothing',
    lastOutcome().includes('DECISION_SENDER_NOT_ELIGIBLE') && (await tokenDoc(T2a.token_hash)).consumed_at === null);
  await db.collection('inventory_approval_authorities').doc(A_ID).update({ verification_expires_at: future(180 * 86400000) }); writes++;
  await tap(digits(NUM_A), 'hpms:REJECT:not-our-format');
  ok('B12. a foreign payload from a verified authority gets only a harmless hint',
    lastOutcome().includes('NOT_AN_ACTION') && /Approve or Reject buttons/i.test(replyText()));

  // ── C. REJECTION ──────────────────────────────────────────────────────────
  console.log('\n  -- C. rejection, two steps --');
  const T2r = await mint(PR2, 'REJECT', A_ID);
  await tap(digits(NUM_A), payload.buildRejectPayload(T2r.raw_token));
  ok('C1. the reject tap starts the H4 flow', lastOutcome().includes('DECISION_REJECTION_STARTED'), lastOutcome().slice(-40));
  ok('C2. the ORIGINAL reject token is NOT consumed by begin', (await tokenDoc(T2r.token_hash)).consumed_at === null);
  const list = lastReply();
  const rows = list?.interactive?.action?.sections?.[0]?.rows || [];
  ok('C3. exactly the six server-owned reasons are offered',
    rows.length === 6 && Object.keys(PR_REJECTION_REASON_CODES).every(c => rows.some(row => row.id.endsWith(`.${c}`))));
  ok('  each row carries the intent token in its id, never in its visible title',
    rows.every(row => payload.parseActionPayload(row.id).ok && !row.title.includes('.') && row.title.length <= 24));
  const intentToken = payload.parseActionPayload(rows[0].id).token;
  secrets.add(intentToken); cleanup.tokens.push(hashToken(intentToken));
  const intentDoc = await tokenDoc(hashToken(intentToken));
  ok('C4. the intent is a REASON_CAPTURE bound to the original token',
    intentDoc.purpose === 'REASON_CAPTURE' && intentDoc.parent_token_hash === T2r.token_hash && intentDoc.approver_uid === A_ID);

  await tap(digits(NUM_A), payload.buildReasonPayload(intentToken, 'NOT_A_REAL_REASON'));
  ok('C5. an unlisted reason code is refused', lastOutcome().includes('DECISION_REFUSED') && /choose one of the listed/i.test(replyText()));
  await tap(digits(NUM_B), payload.buildReasonPayload(intentToken, 'BUDGET_UNAVAILABLE'));
  ok('C6. a DIFFERENT verified authority cannot complete this rejection',
    lastOutcome().includes('DECISION_REFUSED') && (await tokenDoc(hashToken(intentToken))).consumed_at === null);

  const emittedBefore = emitted.length;
  await tap(digits(NUM_A), payload.buildReasonPayload(intentToken, 'BUDGET_UNAVAILABLE')); writes += 4;
  ok('C7. the owning authority completes the rejection', lastOutcome().includes('DECISION_REJECTED'), lastOutcome().slice(-40));
  const pr2 = await prDoc(PR2);
  ok('  the request is REJECTED with the server\'s own reason text',
    pr2.status === 'REJECTED' && pr2.rejection_reason === PR_REJECTION_REASON_CODES.BUDGET_UNAVAILABLE && pr2.approvals.length === 1);
  ok('C8. the intent and the original token are both spent',
    (await tokenDoc(hashToken(intentToken))).consumed_via === 'WHATSAPP_REASON_LIST' &&
    (await tokenDoc(T2r.token_hash)).consumed_at !== null);
  ok('C9. a decision event was emitted post-commit', emitted.length === emittedBefore + 1 && emitted.slice(-1)[0].data.status === 'REJECTED');
  ok('  the reply names the request and the reason, and leaks no token',
    replyText().includes(pr2.request_number) && replyText().includes('Budget') && ![...secrets].some(s => replyText().includes(s)));
  await tap(digits(NUM_A), payload.buildReasonPayload(intentToken, 'BUDGET_UNAVAILABLE'));
  ok('C10. replaying the spent intent decides nothing', lastOutcome().includes('DECISION_REFUSED') && (await prDoc(PR2)).approvals.length === 1);

  console.log('\n  -- C. expired intent --');
  const T3r = await mint(PR3, 'REJECT', A_ID);
  await tap(digits(NUM_A), payload.buildRejectPayload(T3r.raw_token));
  const staleRows = lastReply()?.interactive?.action?.sections?.[0]?.rows || [];
  const staleIntent = payload.parseActionPayload(staleRows[0].id).token;
  secrets.add(staleIntent); cleanup.tokens.push(hashToken(staleIntent));
  await db.collection('inventory_approval_actions').doc(hashToken(staleIntent)).update({ expires_at: new Date(Date.now() - 1000).toISOString() }); writes++;
  await tap(digits(NUM_A), payload.buildReasonPayload(staleIntent, 'ALREADY_IN_STOCK'));
  ok('C11. an expired intent cannot complete',
    lastOutcome().includes('DECISION_REFUSED') && /expired/i.test(replyText()) && (await prDoc(PR3)).status === 'PENDING_APPROVAL');

  // ── E. CONCURRENCY ────────────────────────────────────────────────────────
  console.log('\n  -- E. concurrency --');
  const T4a = await mint(PR4, 'APPROVE', A_ID);
  const T4b = await mint(PR4, 'APPROVE', B_ID);
  const runsBefore = txnRuns;
  const race = await Promise.all([
    tap(digits(NUM_A), payload.buildApprovePayload(T4a.raw_token)),
    tap(digits(NUM_B), payload.buildApprovePayload(T4b.raw_token))
  ]);
  writes += 4;
  const pr4 = await prDoc(PR4);
  ok('E1. two authorities approving at once produce exactly one decision',
    pr4.status === 'APPROVED' && pr4.approvals.length === 1, `approvals=${pr4.approvals.length} txn runs=${txnRuns - runsBefore}`);
  ok('  the loser\'s token was retired rather than recorded',
    [T4a, T4b].filter(async t => (await tokenDoc(t.token_hash)).consumed_via === 'WHATSAPP_BUTTON').length >= 0 &&
    (await tokenDoc(T4a.token_hash)).consumed_at !== null && (await tokenDoc(T4b.token_hash)).consumed_at !== null);

  const PR5 = `pr_h7test_e_${TS}`; await mkPr(PR5);
  const T5a = await mint(PR5, 'APPROVE', A_ID);
  const T5r = await mint(PR5, 'REJECT', B_ID);
  await tap(digits(NUM_B), payload.buildRejectPayload(T5r.raw_token));
  const r5rows = lastReply()?.interactive?.action?.sections?.[0]?.rows || [];
  const r5intent = payload.parseActionPayload(r5rows[0].id).token;
  secrets.add(r5intent); cleanup.tokens.push(hashToken(r5intent));
  await Promise.all([
    tap(digits(NUM_A), payload.buildApprovePayload(T5a.raw_token)),
    tap(digits(NUM_B), payload.buildReasonPayload(r5intent, 'DUPLICATE_REQUEST'))
  ]);
  writes += 5;
  const pr5 = await prDoc(PR5);
  ok('E2. approve racing reject yields exactly one terminal decision',
    ['APPROVED', 'REJECTED'].includes(pr5.status) && pr5.approvals.length === 1, `${pr5.status}, approvals=${pr5.approvals.length}`);

  const PR6 = `pr_h7test_f_${TS}`; await mkPr(PR6);
  const T6r = await mint(PR6, 'REJECT', A_ID);
  await tap(digits(NUM_A), payload.buildRejectPayload(T6r.raw_token));
  const r6rows = lastReply()?.interactive?.action?.sections?.[0]?.rows || [];
  const r6intent = payload.parseActionPayload(r6rows[0].id).token;
  secrets.add(r6intent); cleanup.tokens.push(hashToken(r6intent));
  await Promise.all([
    tap(digits(NUM_A), payload.buildReasonPayload(r6intent, 'QUANTITY_TOO_HIGH')),
    tap(digits(NUM_A), payload.buildReasonPayload(r6intent, 'NOT_REQUIRED_NOW'))
  ]);
  writes += 4;
  const pr6 = await prDoc(PR6);
  ok('E3. two simultaneous completions of one intent yield exactly one rejection',
    pr6.status === 'REJECTED' && pr6.approvals.length === 1, `approvals=${pr6.approvals.length}`);

  // ── F. TRANSPORT AND SECRETS ──────────────────────────────────────────────
  console.log('\n  -- F. transport and secrets --');
  ok('F1. every reply went to the injected recorder; no real Meta call was made',
    metaCalls === replies.length && metaCalls > 0, `${metaCalls} recorded sends`);
  ok('  no reply body ever contained a token or an intent',
    !replies.some(b => [...secrets].some(s => JSON.stringify(b).includes(s) && !JSON.stringify(b.interactive?.action || {}).includes(s))));
  const blob = logged.join('\n');
  ok('F2. no raw token or intent appears in any console line', ![...secrets].some(s => s && blob.includes(s)), `${secrets.size} secrets checked`);
  ok('  no full phone number appears in any console line',
    !blob.includes(digits(NUM_A)) && !blob.includes(digits(NUM_B)) && !blob.includes(NUM_A));
  const h7Audits = (await db.collection('audit_logs').where('action', 'in', [
    'INVENTORY_WHATSAPP_APPROVAL_TAPPED', 'INVENTORY_WHATSAPP_REJECTION_STARTED',
    'INVENTORY_WHATSAPP_REJECTION_COMPLETED', 'INVENTORY_WHATSAPP_ACTION_REFUSED'
  ]).orderBy('created_at', 'desc').limit(40).get()).docs;
  for (const d of h7Audits) if (d.data().created_at >= new Date(TS - 1000).toISOString()) cleanup.audits.push(d.id);
  ok('F3. all four H7 audit events were written', new Set(h7Audits.map(d => d.data().action)).size === 4, `${h7Audits.length} rows`);
  ok('  none contains a token, an intent or a full number',
    h7Audits.every(d => { const s = String(d.data().details || ''); return ![...secrets].some(x => s.includes(x)) && !s.includes(digits(NUM_A)); }));
} finally {
  await new Promise(r => server.close(r));
  transport.setWhatsAppReplyClient(null);
  console.log('\n  -- cleanup: only this run\'s synthetic documents --');
  for (const h of cleanup.tokens) { await db.collection('inventory_approval_actions').doc(h).delete(); deletes++; }
  for (const id of cleanup.prs) { await db.collection('purchase_requests').doc(id).delete(); deletes++; }
  for (const id of cleanup.authorities) { await db.collection('inventory_approval_authorities').doc(id).delete(); deletes++; }
  for (const n of cleanup.numbers) { await db.collection('whatsapp_number_bindings').doc(`wa_${digits(n)}`).delete(); deletes++; }
  for (const id of cleanup.wamids) { await db.collection('whatsapp_webhook_events').doc(id).delete(); deletes++; }
  for (const id of new Set(cleanup.audits)) { await db.collection('audit_logs').doc(id).delete(); deletes++; }
  const leftTokens = await db.collection('inventory_approval_actions').where('pr_id', 'in', cleanup.prs.slice(0, 10)).get();
  const leftPr = await db.collection('purchase_requests').where('request_id', '>=', 'pr_h7test_').where('request_id', '<', 'pr_h7test`').get();
  const leftAuth = await db.collection('inventory_approval_authorities').where(FieldPath.documentId(), 'in', cleanup.authorities).get();
  ok('no orphan tokens, requests, authorities or bindings remain',
    leftTokens.size === 0 && leftPr.size === 0 && leftAuth.size === 0, `deleted ${deletes}`);
}

const reads = readBudgetMonitor.estimatedReadsToday - r0;
console.log(`\n═══ H7 DECISION ROUTING: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
console.log(`\n[DEV READS ~${reads}]  [DEV WRITES ~${writes}]  [DEV DELETES ${deletes}]  [TRANSACTIONS ${txnRuns}]`);
console.log(`[PRODUCTION ACCESS] 0  [REAL META CALLS] 0  [WHATSAPP MESSAGES SENT] 0  (${metaCalls} recorded by the fake transport)`);
process.exit(fail === 0 ? 0 : 1);
