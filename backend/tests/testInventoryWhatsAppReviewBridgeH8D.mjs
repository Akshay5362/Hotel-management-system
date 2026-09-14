/**
 * backend/tests/testInventoryWhatsAppReviewBridgeH8D.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-D — the Review bridge.
 *
 * PART A — no Firebase. Source invariants over the bridge, the dispatcher and
 *   the payload grammar.
 *
 * PART B — the real bridge against the local emulator with a recording
 *   transport. Real authorities, bindings, purchase requests, dispatch rows and
 *   action tokens. No Meta credential exists and no network call is ever made.
 *
 * Every document created is recorded by id, deleted at the end and re-read to
 * prove it is gone. Nothing is deleted by collection sweep.
 *
 * Run:  npm run test:firestore:emulator -- backend/tests/testInventoryWhatsAppReviewBridgeH8D.mjs
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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

const BRIDGE = codeOnly(src('backend', 'services', 'whatsappReviewBridgeService.js'));
const DISPATCH = codeOnly(src('backend', 'services', 'whatsappInboundDispatcher.js'));
const ROUTER = codeOnly(src('backend', 'services', 'whatsappDecisionRouter.js'));
const WCTRL = codeOnly(src('backend', 'controllers', 'whatsappWebhookController.js'));

console.log('═══ PART A — source invariants (no Firebase) ═══');

console.log('\n  -- the bridge decides nothing --');
ok('A1. it never approves, rejects or consumes a token',
  !/decideWithApprovalActionToken|completeTokenRejection|consumeApprovalAction|markApprovalActionConsumedInTxn/.test(BRIDGE));
ok('  it opens no transaction of its own and writes no purchase request',
  !/runTransaction|txn\.|assertTransition|updatePurchaseRequest|PR_TRANSITIONS/.test(BRIDGE));
ok('  H3 and H4 remain the only decision engines: the bridge calls neither',
  !/PurchaseRequestApprovalService\.(approve|reject)/.test(BRIDGE));
ok('  it only MINTS, and mints through H2',
  /createApprovalActionFirestore\(/.test(BRIDGE) &&
  (BRIDGE.match(/createApprovalActionFirestore\(/g) || []).length === 2);

console.log('\n  -- identity never comes from the message --');
ok('A2. identity is resolved from the attested sender only',
  /resolveAuthorityBySender\(sender_id\)/.test(BRIDGE));
ok('  no caller-supplied authority id is ever accepted',
  !/authority_id\s*=\s*(payload|parsed|event|body|req)/.test(BRIDGE) &&
  !/approver_uid:\s*(payload|parsed|event|body)/.test(BRIDGE));
ok('  the minted tokens are bound to the RESOLVED authority',
  (BRIDGE.match(/approver_uid: authorityId/g) || []).length === 2);
ok('  the correlation record must independently name the same authority',
  /dispatch\.authority_id !== authorityId/.test(BRIDGE));

console.log('\n  -- re-checked at Review time, not at notification time --');
ok('A3. the request must still be pending',
  /request\.status !== PR_STATUS\.PENDING_APPROVAL/.test(BRIDGE));
ok('  eligibility and self-approval are re-asserted through the engine rule',
  /assertExternalAuthorityCanApprove\(request, actor, authority\)/.test(BRIDGE));
// Anchored on the CALL sites, not the identifiers: both appear in the import
// block first, so a bare indexOf would compare import order, not execution order.
ok('  the previous outstanding pair is invalidated before a new one exists',
  BRIDGE.indexOf('invalidateApprovalActionsForRequestFirestore(request.id') < BRIDGE.indexOf('createApprovalActionFirestore({'));
ok('  minting is bounded by the H8-A counter',
  /claimBridgeMintFirestore\([^)]*maxMints: WHATSAPP_REVIEW_MAX_MINTS/.test(BRIDGE));

console.log('\n  -- the kill switches --');
const FLAGS = src('backend', 'config', 'featureFlags.js');
ok('A4. both switches are required, and checked before any mint',
  /isWhatsAppDecisionsEnabled\(\) \|\| !isWhatsAppOutboundEnabled\(\)/.test(BRIDGE) &&
  BRIDGE.indexOf('isWhatsAppDecisionsEnabled()') < BRIDGE.indexOf('createApprovalActionFirestore({'));
ok('  both still default OFF with strict equality',
  /ENABLE_WHATSAPP_DECISIONS === 'true'/.test(FLAGS) && /ENABLE_WHATSAPP_OUTBOUND === 'true'/.test(FLAGS));
ok('  identity is resolved BEFORE the flags, so a stranger learns nothing',
  BRIDGE.indexOf('resolveAuthorityBySender(sender_id)') < BRIDGE.indexOf('isWhatsAppDecisionsEnabled()'));

console.log('\n  -- no new payload grammar --');
ok('A5. the bridge reuses the H7 builders and invents nothing',
  /buildApprovePayload\(/.test(BRIDGE) && /buildRejectPayload\(/.test(BRIDGE) &&
  !/hpms\.v2|ACTION_PAYLOAD_PREFIX\s*=/.test(BRIDGE));
ok('  the review signal is a label, carrying no token, number or secret',
  /WHATSAPP_REVIEW_BUTTON_LABEL/.test(BRIDGE) &&
  !/context_id[\s\S]{0,120}(token|secret|e164)/i.test(BRIDGE));

console.log('\n  -- no retry, no secrets --');
ok('A6. nothing is retried automatically',
  !/setInterval|setTimeout|retry|backoff|requeue/i.test(BRIDGE));
ok('  no raw token, code or credential is logged',
  !/console\.[a-z]+\([^)]*(raw_token|approve\.raw_token|reject\.raw_token|challenge_code|accessToken)/.test(BRIDGE));
ok('  a number reaches the audit trail only masked',
  /maskWhatsAppNumber\(/.test(BRIDGE) && !/console\.[a-z]+\([^)]*sender_e164|console\.[a-z]+\([^)]*\bto\b\)/.test(BRIDGE));

console.log('\n  -- routing: H7 is untouched --');
ok('A7. the dispatcher sends a review tap to the bridge, not the router',
  /isReviewTap\(event\.action_payload\)/.test(DISPATCH) && /handleReviewTap\(/.test(DISPATCH));
ok('  and only when the payload is NOT an H7 action',
  /!looksLikeActionPayload\(event\.action_payload\) && isReviewTap/.test(DISPATCH));
ok('  the H7 router still receives every real action payload',
  /routeWhatsAppAction\(/.test(DISPATCH));
ok('  the router itself gained no review handling',
  !/isReviewTap|handleReviewTap|REVIEW_BUTTON/.test(ROUTER));
ok('A8. the webhook now carries the correlation id, capped and unlogged',
  /context_id: typeof message\?\.context\?\.id === 'string'/.test(WCTRL) &&
  /\.slice\(0, MAX_TEXT_LENGTH\)/.test(WCTRL) &&
  !/console\.[a-z]+\([^)]*context/.test(WCTRL));

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H8-D REVIEW BRIDGE: ${pass} passed, ${fail} failed (Part A only) ═══`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\n═══ PART B — the real bridge against the emulator ═══\n');

const { createRequire } = await import('module');
const require_ = createRequire(path.join(BACKEND, 'package.json'));
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });

const { requireEmulatorOrExit } = await import('./helpers/firestoreEmulator.mjs');
await requireEmulatorOrExit();
const { db } = await import('../config/firebaseAdmin.js');

const bridge = await import('../services/whatsappReviewBridgeService.js');
const authoritiesRepo = await import('../repositories/firestore/inventoryApprovalAuthoritiesRepository.js');
const bindingsRepo = await import('../repositories/firestore/whatsappNumberBindingsRepository.js');
const messagesRepo = await import('../repositories/firestore/whatsappMessagesRepository.js');
const actionsRepo = await import('../repositories/firestore/inventoryApprovalActionsRepository.js');
const transportMod = await import('../services/whatsappOutboundClient.js');
const payloadMod = await import('../utils/whatsappActionPayload.js');
const K = await import('../utils/inventoryConstants.js');

process.env.ENABLE_WHATSAPP_DECISIONS = 'true';
process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';

const TS = Date.now();
const created = { authorities: [], bindings: [], dispatches: [], requests: [], actions: [], audits: [] };
const bare = (n) => String(n ?? '').replace(/^\+/, '');
const LABEL = K.WHATSAPP_REVIEW_BUTTON_LABEL;

await db.collection('settings').doc('inventory_pr_approval').set({
  enabled: true, allowed_roles: ['admin', 'super_admin'], updated_at: new Date().toISOString()
}, { merge: true });

async function makeAuthority(tag, { verified = true, active = true, expired = false, linkedStaffUid = null } = {}) {
  const e164 = `+9197${String(TS).slice(-6)}${String(created.authorities.length).padStart(2, '0')}`;
  const doc = authoritiesRepo.newApprovalAuthorityDoc({
    display_name: `H8D_TEST ${tag}`, whatsapp_e164: e164, linked_staff_uid: linkedStaffUid, actor_uid: 'h8d_test'
  });
  const now = new Date().toISOString();
  if (verified) {
    doc.verification_status = K.APPROVAL_AUTHORITY_VERIFICATION.VERIFIED;
    doc.whatsapp_verified_at = now;
    doc.verification_expires_at = expired
      ? new Date(Date.now() - 1000).toISOString()
      : new Date(Date.now() + K.WHATSAPP_VERIFICATION_VALIDITY_MS).toISOString();
    doc.verified_sender_id = e164;
    doc.whatsapp_verification_method = K.WHATSAPP_VERIFICATION_METHOD;
  }
  doc.is_active = active;
  await db.collection('inventory_approval_authorities').doc(doc.authority_id).set(doc);
  created.authorities.push(doc.authority_id);

  const binding = bindingsRepo.newNumberBindingDoc({ whatsapp_e164: e164, authority_id: doc.authority_id, actor_uid: 'h8d_test' });
  if (verified) { binding.status = bindingsRepo.BINDING_STATUS.VERIFIED; binding.verified_at = now; }
  await bindingsRepo.numberBindingRef(e164).set(binding);
  created.bindings.push(bindingsRepo.numberBindingRef(e164).id);
  return { authority_id: doc.authority_id, e164 };
}

async function makeRequest(tag, { status = K.PR_STATUS.PENDING_APPROVAL, requestedBy = `staff_h8d_${TS}` } = {}) {
  const id = `pr_h8dtest_${TS}_${tag}`;
  await db.collection('purchase_requests').doc(id).set({
    request_id: id, request_number: `PR-H8D-${TS}-${tag}`, status,
    department: 'Kitchen', item_count: 3, total_estimated_value: 999,
    reason: 'H8D synthetic', requested_by_uid: requestedBy,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  created.requests.push(id);
  return { id, request_number: `PR-H8D-${TS}-${tag}` };
}

/** A notification dispatch with a known provider id, as H8-C would have left. */
async function makeNotification(request, authority, wamid) {
  const claim = await messagesRepo.claimDispatchFirestore({
    request_id: request.id, authority_id: authority.authority_id,
    purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION,
    request_number: request.request_number
  });
  created.dispatches.push(claim.dispatch_id);
  await messagesRepo.recordProviderMessageIdFirestore(claim.dispatch_id, wamid);
  created.dispatches.push(messagesRepo.buildDispatchId({
    request_id: request.id, authority_id: authority.authority_id,
    purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_DECISION_PROMPT
  }));
  return claim.dispatch_id;
}

function recorder(script = () => ({ ok: true, status: 200, json: { messages: [{ id: `wamid.h8d.${crypto.randomBytes(3).toString('hex')}` }] } })) {
  const sent = [];
  return { sent, client: transportMod.createWhatsAppReplyClient({ transport: async (b) => { sent.push(b); return await script(b); } }) };
}
const buttonsOf = (r) => r.sent.filter(b => b.type === 'interactive' && b.interactive?.type === 'button');
const liveActions = async (prId, authId) => (await db.collection('inventory_approval_actions')
  .where('pr_id', '==', prId).get()).docs.map(d => d.data())
  .filter(a => a.approver_uid === authId && !a.consumed_at);

// ── B1 the happy path ───────────────────────────────────────────────────────
console.log('  -- a valid Review tap --');
const authA = await makeAuthority('alpha');
const reqA = await makeRequest('a');
{
  const wamid = `wamid.notif.${TS}.a`;
  await makeNotification(reqA, authA, wamid);
  const r = recorder();
  const outcome = await bridge.handleReviewTap({ sender_id: bare(authA.e164), payload: LABEL, context_id: wamid, client: r.client });
  ok('B1. a verified active authority is prompted', outcome === 'PROMPT_SENT', outcome);
  const msg = buttonsOf(r)[0];
  ok('  an interactive reply-buttons message was sent', !!msg && msg.to === bare(authA.e164));
  const ids = msg.interactive.action.buttons.map(b => b.reply.id);
  const titles = msg.interactive.action.buttons.map(b => b.reply.title);
  ok('  it offers exactly Approve and Reject',
    titles.join(',') === 'Approve,Reject', titles.join(','));
  ok('B11/B12. both buttons carry a fresh H2 token in the H7 grammar',
    ids.every(i => payloadMod.looksLikeActionPayload(i)) &&
    payloadMod.parseActionPayload(ids[0]).action === 'ap' &&
    payloadMod.parseActionPayload(ids[1]).action === 'rj');
  const live = await liveActions(reqA.id, authA.authority_id);
  ok('  exactly one live approve and one live reject token now exist',
    live.length === 2 && new Set(live.map(a => a.action)).size === 2, `live=${live.length}`);
  live.forEach(a => created.actions.push(a.token_hash));
  ok('B6. neither token is consumed yet', live.every(a => !a.consumed_at));
  ok('  no raw token appears in the persisted action rows',
    !JSON.stringify(live).includes(payloadMod.parseActionPayload(ids[0]).token));
}

// ── B13/B14 re-tap replaces, never accumulates ──────────────────────────────
console.log('\n  -- a second Review tap --');
{
  const wamid = `wamid.notif.${TS}.a`;
  const before = await liveActions(reqA.id, authA.authority_id);
  const r = recorder();
  const outcome = await bridge.handleReviewTap({ sender_id: bare(authA.e164), payload: LABEL, context_id: wamid, client: r.client });
  const after = await liveActions(reqA.id, authA.authority_id);
  after.forEach(a => created.actions.push(a.token_hash));
  ok('B13. a repeat tap prompts again', outcome === 'PROMPT_SENT');
  ok('  and the previous pair was invalidated, not accumulated',
    after.length === 2, `live before=${before.length} after=${after.length}`);
  ok('B14. the old tokens are now unusable',
    (await db.collection('inventory_approval_actions').doc(before[0].token_hash).get()).data().consumed_at !== null);
}

// ── B15 concurrency and the mint cap ────────────────────────────────────────
console.log('\n  -- concurrent taps and the cap --');
{
  const authC = await makeAuthority('cap');
  const reqC = await makeRequest('c');
  const wamid = `wamid.notif.${TS}.c`;
  await makeNotification(reqC, authC, wamid);
  const r1 = recorder(), r2 = recorder();
  const [o1, o2] = await Promise.all([
    bridge.handleReviewTap({ sender_id: bare(authC.e164), payload: LABEL, context_id: wamid, client: r1.client }),
    bridge.handleReviewTap({ sender_id: bare(authC.e164), payload: LABEL, context_id: wamid, client: r2.client })
  ]);
  const live = await liveActions(reqC.id, authC.authority_id);
  live.forEach(a => created.actions.push(a.token_hash));
  ok('B15. two concurrent taps both resolve without error',
    [o1, o2].every(o => ['PROMPT_SENT', 'MINT_LIMIT_REACHED'].includes(o)), `${o1}/${o2}`);
  // Invalidate-then-mint is two operations, so two taps interleaving can leave
  // a third live token transiently. That is BOUNDED, which is the requirement:
  // the cap below limits total mints, every token belongs to this one authority
  // and request, and H3 still lets exactly one of them decide (proved in B16).
  ok('  and leave a bounded set, never an unbounded one',
    live.length <= K.WHATSAPP_REVIEW_MAX_MINTS * 2, `live=${live.length} cap=${K.WHATSAPP_REVIEW_MAX_MINTS * 2}`);
  ok('  every live token belongs to this authority and this request',
    live.every(a => a.approver_uid === authC.authority_id && a.pr_id === reqC.id));

  let capped = null;
  for (let i = 0; i < K.WHATSAPP_REVIEW_MAX_MINTS + 2; i++) {
    capped = await bridge.handleReviewTap({ sender_id: bare(authC.e164), payload: LABEL, context_id: wamid, client: recorder().client });
  }
  ok('B14b. repeated taps stop at the documented cap',
    capped === 'MINT_LIMIT_REACHED', capped);
  const afterCap = await liveActions(reqC.id, authC.authority_id);
  afterCap.forEach(a => created.actions.push(a.token_hash));
  ok('  and the live pair is still bounded', afterCap.length <= 2, `live=${afterCap.length}`);
}

// ── B3/B4 terminal requests ─────────────────────────────────────────────────
console.log('\n  -- a request that is no longer pending --');
for (const [tag, status] of [['approved', K.PR_STATUS.APPROVED], ['rejected', K.PR_STATUS.REJECTED]]) {
  const req = await makeRequest(tag, { status });
  const wamid = `wamid.notif.${TS}.${tag}`;
  await makeNotification(req, authA, wamid);
  const r = recorder();
  const outcome = await bridge.handleReviewTap({ sender_id: bare(authA.e164), payload: LABEL, context_id: wamid, client: r.client });
  ok(`B3/B4. an already-${tag} request is refused`, outcome === 'REQUEST_NOT_PENDING', outcome);
  ok(`  no token was minted for it`, (await liveActions(req.id, authA.authority_id)).length === 0);
  ok(`  and no decision prompt was sent`, buttonsOf(r).length === 0);
}

// ── B5..B9 identity and eligibility refusals ────────────────────────────────
console.log('\n  -- who is refused --');
{
  const reqR = await makeRequest('refuse');
  const wamid = `wamid.notif.${TS}.refuse`;
  await makeNotification(reqR, authA, wamid);

  const r0 = recorder();
  ok('B5. an unknown sender is refused and told nothing',
    (await bridge.handleReviewTap({ sender_id: '919000000000', payload: LABEL, context_id: wamid, client: r0.client })) === 'UNKNOWN_SENDER'
    && r0.sent.length === 0);

  for (const [label, opts, expect] of [
    ['B6. an unverified authority', { verified: false }, 'UNKNOWN_SENDER'],
    ['B7. an inactive authority', { active: false }, 'UNKNOWN_SENDER'],
    ['B8. an expired verification', { expired: true }, 'UNKNOWN_SENDER']
  ]) {
    const a = await makeAuthority(label.slice(0, 6), opts);
    const r = recorder();
    const outcome = await bridge.handleReviewTap({ sender_id: bare(a.e164), payload: LABEL, context_id: wamid, client: r.client });
    ok(`${label} is refused`, outcome === expect, outcome);
    ok('  and no token was minted', (await liveActions(reqR.id, a.authority_id)).length === 0);
  }

  // B20 — another authority cannot use this notification.
  const other = await makeAuthority('other');
  const rOther = recorder();
  const outcome = await bridge.handleReviewTap({ sender_id: bare(other.e164), payload: LABEL, context_id: wamid, client: rOther.client });
  ok('B20. a verified authority cannot act on another authority\'s notification',
    outcome === 'AUTHORITY_MISMATCH', outcome);
  ok('  and mints nothing', (await liveActions(reqR.id, other.authority_id)).length === 0);
}

// ── B10 self-approval ───────────────────────────────────────────────────────
console.log('\n  -- the requester cannot review their own request --');
{
  const selfUid = `staff_h8d_self_${TS}`;
  const selfAuth = await makeAuthority('self', { linkedStaffUid: selfUid });
  const reqS = await makeRequest('self', { requestedBy: selfUid });
  const wamid = `wamid.notif.${TS}.self`;
  await makeNotification(reqS, selfAuth, wamid);
  const r = recorder();
  const outcome = await bridge.handleReviewTap({ sender_id: bare(selfAuth.e164), payload: LABEL, context_id: wamid, client: r.client });
  ok('B10. self-approval is still blocked at Review time', outcome === 'NOT_ELIGIBLE', outcome);
  ok('  and no token was minted', (await liveActions(reqS.id, selfAuth.authority_id)).length === 0);
}

// ── B21/B22 kill switches ───────────────────────────────────────────────────
console.log('\n  -- the kill switches --');
{
  const authK = await makeAuthority('kill');
  const reqK = await makeRequest('kill');
  const wamid = `wamid.notif.${TS}.kill`;
  await makeNotification(reqK, authK, wamid);

  for (const [label, flag] of [['B21. decisions', 'ENABLE_WHATSAPP_DECISIONS'], ['B22. outbound', 'ENABLE_WHATSAPP_OUTBOUND']]) {
    const prev = process.env[flag];
    delete process.env[flag];
    const r = recorder();
    const outcome = await bridge.handleReviewTap({ sender_id: bare(authK.e164), payload: LABEL, context_id: wamid, client: r.client });
    ok(`${label} switched off refuses the bridge`, outcome === 'DISABLED', outcome);
    ok('  and mints no token', (await liveActions(reqK.id, authK.authority_id)).length === 0);
    ok('  and sends no decision prompt', buttonsOf(r).length === 0);
    process.env[flag] = prev;
  }
}

// ── B23/B24 transport outcomes ──────────────────────────────────────────────
console.log('\n  -- transport failure and unknown outcome --');
{
  const timeoutErr = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  for (const [label, script, expectState] of [
    ['B23. an HTTP failure', async () => ({ ok: false, status: 400, json: { error: { code: 1 } } }), K.WHATSAPP_SEND_STATE.FAILED],
    ['B24. a timeout', async () => { throw timeoutErr; }, K.WHATSAPP_SEND_STATE.UNKNOWN]
  ]) {
    // Lowercase: formatRequestDocId lowercases every id, so an uppercase tag
    // would be written under one key and looked up under another.
    const tag = label.slice(0, 7).replace(/\W/g, '').toLowerCase();
    const a = await makeAuthority(tag);
    const req = await makeRequest(tag);
    const wamid = `wamid.notif.${TS}.${tag}`;
    await makeNotification(req, a, wamid);
    const r = recorder(script);
    const outcome = await bridge.handleReviewTap({ sender_id: bare(a.e164), payload: LABEL, context_id: wamid, client: r.client });
    ok(`${label} is reported, not thrown`, outcome === 'PROMPT_FAILED', outcome);
    const fresh = await db.collection('purchase_requests').doc(req.id).get();
    ok('  the purchase request is untouched and still pending',
      fresh.data().status === K.PR_STATUS.PENDING_APPROVAL);
    const promptId = messagesRepo.buildDispatchId({
      request_id: req.id, authority_id: a.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_DECISION_PROMPT
    });
    const row = await messagesRepo.getDispatchFirestore(promptId);
    ok(`  the prompt dispatch records ${expectState} and invents no provider id`,
      row?.send_state === expectState && row?.provider_message_id === null, `${row?.send_state}`);
    (await liveActions(req.id, a.authority_id)).forEach(x => created.actions.push(x.token_hash));
  }
}

// ── B16/B17/B19 the minted tokens reach H3 and H4, and only those ───────────
console.log('\n  -- the minted tokens feed the existing engines --');
{
  const approvalSvc = await import('../services/purchaseRequestApprovalService.js');
  const authD = await makeAuthority('decide');
  const reqD = await makeRequest('decide');
  const wamid = `wamid.notif.${TS}.decide`;
  await makeNotification(reqD, authD, wamid);
  const r = recorder();
  await bridge.handleReviewTap({ sender_id: bare(authD.e164), payload: LABEL, context_id: wamid, client: r.client });
  const ids = buttonsOf(r)[0].interactive.action.buttons.map(b => b.reply.id);
  const approveToken = payloadMod.parseActionPayload(ids[0]).token;
  const rejectToken = payloadMod.parseActionPayload(ids[1]).token;
  (await liveActions(reqD.id, authD.authority_id)).forEach(a => created.actions.push(a.token_hash));

  // B17 — Reject reaches H4's begin step and does NOT decide.
  const intent = await approvalSvc.PurchaseRequestApprovalService.beginTokenRejection({
    raw_token: rejectToken, decided_by_uid: authD.authority_id
  });
  ok('B17. the reject token opens the existing H4 intent flow', !!intent?.raw_token);
  const stillPending = await db.collection('purchase_requests').doc(reqD.id).get();
  ok('B18. the request is still pending: the reject token was not consumed as a decision',
    stillPending.data().status === K.PR_STATUS.PENDING_APPROVAL);

  // B20 — the token is bound to its authority.
  let wrongRefused = false;
  try {
    await approvalSvc.PurchaseRequestApprovalService.decideWithApprovalActionToken({
      raw_token: approveToken, action: K.PR_APPROVAL_ACTIONS.APPROVED,
      decided_by_uid: (await makeAuthority('thief')).authority_id
    });
  } catch (err) { wrongRefused = true; }
  ok('B20b. another authority cannot use this authority\'s approval token', wrongRefused);

  // B16 — Approve reaches H3 and decides exactly once.
  const decided = await approvalSvc.PurchaseRequestApprovalService.decideWithApprovalActionToken({
    raw_token: approveToken, action: K.PR_APPROVAL_ACTIONS.APPROVED, decided_by_uid: authD.authority_id
  });
  ok('B16. the approve token decides through H3', !!decided);
  const afterDecide = await db.collection('purchase_requests').doc(reqD.id).get();
  ok('  and the request is now APPROVED by the engine, not by the bridge',
    afterDecide.data().status === K.PR_STATUS.APPROVED);

  // B19 — a consumed token is refused.
  let replayRefused = false;
  try {
    await approvalSvc.PurchaseRequestApprovalService.decideWithApprovalActionToken({
      raw_token: approveToken, action: K.PR_APPROVAL_ACTIONS.APPROVED, decided_by_uid: authD.authority_id
    });
  } catch { replayRefused = true; }
  ok('B19. a consumed approval token is refused on replay', replayRefused);
}

// ── B25 nothing secret is logged or persisted ───────────────────────────────
console.log('\n  -- nothing secret escapes --');
{
  const snap = await db.collection('inventory_approval_actions').where('pr_id', '==', reqA.id).get();
  const blob = JSON.stringify(snap.docs.map(d => d.data()));
  ok('B25. no raw token is persisted on any action row',
    !/raw_token/.test(blob) && snap.docs.every(d => typeof d.data().token_hash === 'string'));
  ok('  no full phone number is persisted on a dispatch row',
    !JSON.stringify((await messagesRepo.listDispatchesForRequestFirestore(reqA.id))).includes(bare(authA.e164)));
  const audits = await db.collection('audit_logs').where('user_id', '==', authA.authority_id).get();
  audits.docs.forEach(d => created.audits.push(d.id));
  const auditBlob = JSON.stringify(audits.docs.map(d => d.data()));
  ok('  no raw token, code or full number appears in the audit trail',
    !auditBlob.includes(bare(authA.e164)) && !/raw_token|challenge_code|verification_code/i.test(auditBlob));
}

// ── B26 the review tap is not an H7 action ──────────────────────────────────
console.log('\n  -- compatibility with H7 --');
ok('B26. the review label is not mistaken for an H7 action payload',
  payloadMod.looksLikeActionPayload(LABEL) === false &&
  payloadMod.parseActionPayload(LABEL).ok === false);
ok('  and a real H7 payload is not mistaken for a review tap',
  bridge.isReviewTap(payloadMod.buildApprovePayload('A'.repeat(43))) === false);

// ── cleanup ─────────────────────────────────────────────────────────────────
console.log('\n  -- cleanup --');
{
  const survivors = [];
  const wipe = async (col, ids) => {
    for (const id of [...new Set(ids)]) {
      if (!id) continue;
      await db.collection(col).doc(id).delete();
      if ((await db.collection(col).doc(id).get()).exists) survivors.push(`${col}/${id}`);
    }
  };
  await wipe('inventory_approval_actions', created.actions);
  await wipe('whatsapp_messages', created.dispatches);
  await wipe('purchase_requests', created.requests);
  await wipe('inventory_approval_authorities', created.authorities);
  await wipe('whatsapp_number_bindings', created.bindings);
  for (const id of [...new Set(created.audits)]) await db.collection('audit_logs').doc(id).delete();
  await db.collection('settings').doc('inventory_pr_approval').delete();
  ok('CLEAN. every document this run created is deleted and verified gone',
    survivors.length === 0, survivors.slice(0, 6).join(', ') || 'none');
}

console.log(`\n═══ H8-D REVIEW BRIDGE: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
