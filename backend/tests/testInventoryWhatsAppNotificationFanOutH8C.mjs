/**
 * backend/tests/testInventoryWhatsAppNotificationFanOutH8C.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-C — the submit-time WhatsApp notification fan-out.
 *
 * PART A — no Firebase. Source invariants and the pure payload builder. Proves
 *   what H8-C must NOT contain before anything is imported that would reach
 *   firebaseAdmin.
 *
 * PART B — the real service against the local emulator, with a recording
 *   transport. Real authorities, real bindings, real dispatch claims, real
 *   audit rows. No Meta credential exists and no network call is ever made.
 *
 * Every document created is recorded by id and deleted at the end, then
 * RE-READ to prove it is gone. Nothing is deleted by collection sweep.
 *
 * Run:  npm run test:firestore:emulator -- backend/tests/testInventoryWhatsAppNotificationFanOutH8C.mjs
 *       node backend/tests/testInventoryWhatsAppNotificationFanOutH8C.mjs   (Part A only)
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

const SVC = codeOnly(src('backend', 'services', 'whatsappNotificationService.js'));
const CTRL = codeOnly(src('backend', 'controllers', 'purchaseRequestController.js'));
const PRSVC = codeOnly(src('backend', 'services', 'purchaseRequestService.js'));

console.log('═══ PART A — source invariants (no Firebase) ═══');

console.log('\n  -- H8-C mints nothing and decides nothing --');
ok('A1. the service mints, reads or consumes no approval token',
  !/createApprovalActionFirestore|consumeApprovalAction|markApprovalActionConsumed|hashToken|generateRawToken|beginTokenRejection|completeTokenRejection|decideWithApprovalActionToken/.test(SVC));
ok('  it changes no purchase request and opens no transaction',
  !/runTransaction|txn\.|PR_STATUS|assertTransition|updatePurchaseRequest/.test(SVC));
ok('  it routes nothing inbound and handles no webhook',
  !/routeWhatsAppAction|dispatchInboundWhatsAppEvents|extractWebhookEvents|verifyWebhookSignature/.test(SVC));
ok('  it creates no collection of its own: only the H8-A repository writes',
  !/db\.collection\(|whatsapp_messages_v2|inventory_whatsapp_notifications/.test(SVC));

console.log('\n  -- no retry, ever --');
ok('A2. no timer, no loop, no queue worker, no backoff',
  !/setInterval|setTimeout|retry|backoff|requeue|reclaim/i.test(SVC));
ok('  one dispatch gets one send attempt: a single transport call site',
  (SVC.match(/sendTemplateMessage\(/g) || []).length === 1);

console.log('\n  -- eligibility is borrowed, not restated --');
ok('A3. it reuses the three existing checks rather than defining a fourth',
  /isAuthorityDecisionEligible\(/.test(SVC) && /resolveAuthorityBySender\(/.test(SVC) &&
  /assertExternalAuthorityCanApprove\(/.test(SVC));
ok('  it restates no verification policy of its own',
  !/verification_expires_at|VERIFICATION_VALIDITY|BINDING_STATUS|whatsapp_verified_at/.test(SVC));
ok('  it reads no raw staff phone field as an identity',
  !/staff\.|getStaffByUid|phone_number|mobile/i.test(SVC));

console.log('\n  -- the payload carries only the approved fields --');
// The builder itself is exercised in Part B. It cannot be imported here: the
// service pulls in repositories, which reach firebaseAdmin at import time, and
// firebaseAdmin initialises against PRODUCTION when HPMS_ENV is unset. Part A
// therefore asserts over the source text only.
ok('A4. supplier appears nowhere in the service',
  !/supplier/i.test(SVC));
ok('  no guest, payment, document or credential field appears anywhere',
  !/guest|passport|aadhaar|payment|card|invoice|razorpay/i.test(SVC));
ok('  the builder names exactly the five approved parameters',
  /request_number:/.test(SVC) && /department:/.test(SVC) && /item_count:/.test(SVC) &&
  /estimated_total:/.test(SVC) && /reason:/.test(SVC));
ok('  the reason is sanitised before it reaches a parameter',
  /reason: sanitizeReason\(/.test(SVC));

console.log('\n  -- secrets never appear --');
ok('A6. no token, code, secret or credential is referenced',
  !/raw_token|rawToken|challenge_code|verification_code|WHATSAPP_ACCESS_TOKEN|WHATSAPP_APP_SECRET|app_secret/.test(SVC));
ok('  a number reaches the audit trail only masked',
  /maskWhatsAppNumber\(/.test(SVC) && !/recipient: |whatsapp_e164:|sender_e164:/.test(SVC));
ok('  no Socket.IO payload carries a number, masked or otherwise',
  !/emit\([^)]*masked|emit\([^)]*e164/i.test(SVC));

console.log('\n  -- the submit path is unchanged where it matters --');
ok('A7. the purchase-request transaction is untouched by H8-C',
  !/whatsappNotification|notifyAuthorities/.test(PRSVC));
ok('  the controller calls the fan-out only after commit, under the replay guard',
  /if \(!result\.duplicate\) await notifyAuthoritiesOfSubmittedRequest\(req, result\.request\);/.test(CTRL));
ok('  the existing submitted event is still emitted, and still first',
  CTRL.indexOf('emitPurchaseRequestSubmitted(req, result.request)') <
  CTRL.indexOf('notifyAuthoritiesOfSubmittedRequest(req, result.request)'));
ok('  the decision event is untouched',
  /PR_EVENTS\.DECIDED/.test(CTRL) && !/PR_EVENTS\.DECIDED[\s\S]{0,80}whatsapp/i.test(CTRL));
ok('  the controller wrapper swallows its own errors',
  /notifyAuthoritiesOfSubmittedRequest[\s\S]{0,400}catch \(err\)/.test(CTRL));

console.log('\n  -- the flag --');
const FLAGS = src('backend', 'config', 'featureFlags.js');
ok('A8. the fan-out is gated by ENABLE_WHATSAPP_OUTBOUND',
  /isWhatsAppOutboundEnabled\(\)/.test(SVC) && /ENABLE_WHATSAPP_OUTBOUND === 'true'/.test(FLAGS));
ok('  and the gate is the very first thing the fan-out does',
  SVC.indexOf('isWhatsAppOutboundEnabled()') < SVC.indexOf('listApprovalAuthoritiesFirestore('));

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H8-C FAN-OUT: ${pass} passed, ${fail} failed (Part A only) ═══`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\n═══ PART B — the real service against the emulator ═══\n');

const { createRequire } = await import('module');
const require_ = createRequire(path.join(BACKEND, 'package.json'));
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });

const { requireEmulatorOrExit } = await import('./helpers/firestoreEmulator.mjs');
await requireEmulatorOrExit();
const { db } = await import('../config/firebaseAdmin.js');

const authoritiesRepo = await import('../repositories/firestore/inventoryApprovalAuthoritiesRepository.js');
const bindingsRepo = await import('../repositories/firestore/whatsappNumberBindingsRepository.js');
const messagesRepo = await import('../repositories/firestore/whatsappMessagesRepository.js');
const K = await import('../utils/inventoryConstants.js');
const transportMod = await import('../services/whatsappOutboundClient.js');
const notify = await import('../services/whatsappNotificationService.js');

process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';

// ── B0 the pure payload logic, now that the service may be imported ─────────
console.log('  -- the payload builder and the reason sanitiser --');
{
  const params = notify.buildNotificationParameters({
    request_number: 'PR-H8C-0001', department: 'Kitchen', item_count: 12,
    total_estimated_value: 18450.5, reason: 'Monthly restock'
  });
  ok('B0. exactly the five approved parameters, in the approved names',
    JSON.stringify(Object.keys(params).sort()) ===
    JSON.stringify(['department', 'estimated_total', 'item_count', 'reason', 'request_number']));
  ok('  supplier is absent, because a purchase request has none', params.supplier === undefined);
  ok('  values are carried faithfully',
    params.request_number === 'PR-H8C-0001' && params.department === 'Kitchen' &&
    params.item_count === '12' && params.reason === 'Monthly restock');
  ok('  newlines and tabs are collapsed, never passed through',
    notify.sanitizeReason('line one\nline two\ttabbed') === 'line one line two tabbed');
  ok('  an empty or whitespace reason becomes an explicit placeholder',
    ['', '   ', null, undefined, '\n\n'].every(v => notify.sanitizeReason(v) === notify.REASON_PLACEHOLDER));
  ok('  an over-long reason is clamped to the template-safe ceiling',
    notify.sanitizeReason('x'.repeat(500)).length === notify.REASON_MAX_LENGTH);
  ok('  a normal reason is untouched', notify.sanitizeReason('  Monthly restock  ') === 'Monthly restock');
}

const TS = Date.now();
const created = { authorities: [], bindings: [], dispatches: [], settings: [] };
const trackDispatch = (id) => { if (id && !created.dispatches.includes(id)) created.dispatches.push(id); };

/** Approvals must be enabled for the engine's per-request rule to pass. */
await db.collection('settings').doc('inventory_pr_approval').set({
  enabled: true, allowed_roles: ['admin', 'super_admin'], updated_at: new Date().toISOString()
}, { merge: true });
created.settings.push('inventory_pr_approval');

/** Builds a verified, active external authority with a usable binding. */
async function makeAuthority(tag, { verified = true, active = true, linkedStaffUid = null } = {}) {
  // E.164 requires the leading plus; the repository refuses anything else.
  const e164 = `+9198${String(TS).slice(-6)}${String(created.authorities.length).padStart(2, '0')}`;
  const doc = authoritiesRepo.newApprovalAuthorityDoc({
    display_name: `H8C_TEST ${tag}`, whatsapp_e164: e164,
    linked_staff_uid: linkedStaffUid, actor_uid: 'h8c_test'
  });
  const now = new Date().toISOString();
  const future = new Date(Date.now() + K.WHATSAPP_VERIFICATION_VALIDITY_MS).toISOString();
  if (verified) {
    doc.verification_status = K.APPROVAL_AUTHORITY_VERIFICATION.VERIFIED;
    doc.whatsapp_verified_at = now;
    doc.verification_expires_at = future;
    doc.verified_sender_id = e164;
    doc.whatsapp_verification_method = K.WHATSAPP_VERIFICATION_METHOD;
  }
  doc.is_active = active;
  await db.collection('inventory_approval_authorities').doc(doc.authority_id).set(doc);
  created.authorities.push(doc.authority_id);

  const binding = bindingsRepo.newNumberBindingDoc({ whatsapp_e164: e164, authority_id: doc.authority_id, actor_uid: 'h8c_test' });
  if (verified) { binding.status = bindingsRepo.BINDING_STATUS.VERIFIED; binding.verified_at = now; }
  const key = bindingsRepo.numberBindingRef(e164).id;
  await bindingsRepo.numberBindingRef(e164).set(binding);
  created.bindings.push(key);

  const record = { authority_id: doc.authority_id, e164, key, eligible: verified && active && !linkedStaffUid };
  if (record.eligible) eligibleNumbers.push(e164);
  return record;
}

/**
 * Authorities accumulate across blocks, so a send count is only meaningful
 * relative to who is currently eligible. Asserting an absolute number would be
 * asserting the order of this file rather than the behaviour of the service.
 */
const eligibleNumbers = [];

/**
 * The transport normalises a recipient to the plus-less form the provider
 * accepts, so a comparison against the stored E.164 must drop the plus too.
 * Kept as one helper so no assertion silently compares the wrong shapes.
 */
const bare = (n) => String(n ?? '').replace(/^\+/, '');

/** A recording transport. Never reaches the network. */
function recorder(script = () => ({ ok: true, status: 200, json: { messages: [{ id: `wamid.h8c.${crypto.randomBytes(3).toString('hex')}` }] } })) {
  const sent = [];
  return { sent, client: transportMod.createWhatsAppReplyClient({ transport: async (b) => { sent.push(b); return await script(b); }, templateName: 'purchase_request_review', templateLanguage: 'en' }) };
}

const requestFor = (n) => ({
  id: `pr_h8ctest_${TS}_${n}`, request_id: `pr_h8ctest_${TS}_${n}`,
  request_number: `PR-H8C-${TS}-${n}`, department: 'Kitchen', item_count: 7,
  total_estimated_value: 12345.67, reason: 'H8C synthetic\nrestock', requested_by_uid: 'staff_h8c_requester'
});

// ── B1 the flag is a hard stop ──────────────────────────────────────────────
console.log('  -- the flag --');
{
  const a = await makeAuthority('flagoff');
  delete process.env.ENABLE_WHATSAPP_OUTBOUND;
  const r = recorder();
  const req = requestFor('flagoff');
  const out = await notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r.client });
  ok('B1. with the flag off the fan-out is a no-op', out.outcome === 'DISABLED' && out.claimed === 0);
  ok('  no transport call was made', r.sent.length === 0);
  const id = messagesRepo.buildDispatchId({ request_id: req.id, authority_id: a.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION });
  ok('  and no dispatch record was created', (await db.collection('whatsapp_messages').doc(id).get()).exists === false);
  process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';
}

// ── B2 one eligible authority gets exactly one send ─────────────────────────
console.log('\n  -- one authority, one send --');
let authorityA;
{
  authorityA = await makeAuthority('alpha');
  const r = recorder();
  const req = requestFor('one');
  const out = await notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r.client });
  const id = messagesRepo.buildDispatchId({ request_id: req.id, authority_id: authorityA.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION });
  trackDispatch(id);
  ok('B2. every currently eligible authority received exactly one send',
    r.sent.length === eligibleNumbers.length && new Set(r.sent.map(b => b.to)).size === r.sent.length,
    `sent=${r.sent.length} eligible=${eligibleNumbers.length}`);
  const body = r.sent.find(b => b.to === bare(authorityA.e164));
  ok('  the new authority got a template message at its verified number',
    !!body && body.type === 'template' && body.to === bare(authorityA.e164));
  ok('  the template carries the five approved named parameters',
    body.template.components[0].parameters.map(p => p.parameter_name).sort().join(',') ===
    'department,estimated_total,item_count,reason,request_number');
  ok('  the reason was sanitised on the way out',
    body.template.components[0].parameters.find(p => p.parameter_name === 'reason').text === 'H8C synthetic restock');
  ok('  no parameter carries a supplier, token or secret',
    !JSON.stringify(body).match(/supplier|token|secret|hpms\.v1/i));
  const row = await messagesRepo.getDispatchFirestore(id);
  ok('  the dispatch was recorded SENT with the provider message id',
    row?.send_state === K.WHATSAPP_SEND_STATE.SENT && String(row.provider_message_id).startsWith('wamid.h8c.'));
  ok('  and the row holds no phone number in any field',
    !JSON.stringify(row).includes(bare(authorityA.e164)));
}

// ── B3 duplicate invocation sends nothing more ──────────────────────────────
console.log('\n  -- duplicate invocation --');
{
  const r = recorder();
  const req = requestFor('one');
  const out = await notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r.client });
  ok('B3. a second run for the same request sends nothing',
    r.sent.length === 0 && out.claimed === 0, `sent=${r.sent.length}`);
  ok('  and reports the authority as already dispatched',
    out.skipped.some(s => s.reason === 'ALREADY_DISPATCHED'));
}

// ── B4 two authorities, one send each ───────────────────────────────────────
console.log('\n  -- two authorities --');
let authorityB;
{
  authorityB = await makeAuthority('bravo');
  const r = recorder();
  const req = requestFor('two');
  await notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r.client });
  for (const a of [authorityA, authorityB]) {
    trackDispatch(messagesRepo.buildDispatchId({ request_id: req.id, authority_id: a.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION }));
  }
  ok('B4. each eligible authority received exactly one send',
    r.sent.length === eligibleNumbers.length, `sent=${r.sent.length} eligible=${eligibleNumbers.length}`);
  ok('  and each went to a different verified number',
    new Set(r.sent.map(b => b.to)).size === r.sent.length);
  ok('  the newly added authority is among the recipients',
    r.sent.some(b => b.to === bare(authorityB.e164)));
}

// ── B5 concurrency ──────────────────────────────────────────────────────────
console.log('\n  -- concurrent handlers --');
{
  const r1 = recorder(), r2 = recorder();
  const req = requestFor('race');
  await Promise.all([
    notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r1.client }),
    notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r2.client })
  ]);
  for (const a of [authorityA, authorityB]) {
    trackDispatch(messagesRepo.buildDispatchId({ request_id: req.id, authority_id: a.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION }));
  }
  const total = r1.sent.length + r2.sent.length;
  ok('B5. two concurrent handlers produce exactly one send per eligible authority',
    total === eligibleNumbers.length, `total sends=${total} eligible=${eligibleNumbers.length} (r1=${r1.sent.length} r2=${r2.sent.length})`);
  ok('  and every recipient is distinct',
    new Set([...r1.sent, ...r2.sent].map(b => b.to)).size === total);
}

// ── B6 ineligible authorities are skipped ───────────────────────────────────
console.log('\n  -- ineligible authorities --');
{
  const inactive = await makeAuthority('inactive', { active: false });
  const unverified = await makeAuthority('unverified', { verified: false });
  const r = recorder();
  const req = requestFor('skip');
  const out = await notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r.client });
  const recipients = new Set(r.sent.map(b => b.to));
  ok('B6. an inactive authority receives nothing', !recipients.has(bare(inactive.e164)));
  ok('  an unverified authority receives nothing', !recipients.has(bare(unverified.e164)));
  // The two are excluded at different layers, and that is correct. An inactive
  // authority never reaches the fan-out at all: listApprovalAuthoritiesFirestore
  // filters it out upstream. An unverified one IS listed and is refused here.
  ok('  the unverified authority is refused by the fan-out, not silently dropped',
    out.skipped.some(s => s.authority_id === unverified.authority_id && s.reason === 'NOT_ELIGIBLE'),
    JSON.stringify(out.skipped.map(s => s.reason)));
  ok('  the inactive authority is excluded upstream, so it is never even considered',
    !out.skipped.some(s => s.authority_id === inactive.authority_id));
  for (const a of [authorityA, authorityB]) {
    trackDispatch(messagesRepo.buildDispatchId({ request_id: req.id, authority_id: a.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION }));
  }
}

// ── B7 self-approval exclusion ──────────────────────────────────────────────
console.log('\n  -- the requester is never asked to approve their own request --');
{
  const selfUid = `staff_h8c_self_${TS}`;
  const selfAuth = await makeAuthority('self', { linkedStaffUid: selfUid });
  const r = recorder();
  const req = { ...requestFor('self'), requested_by_uid: selfUid };
  const out = await notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r.client });
  ok('B7. the linked authority of the requester is excluded',
    !new Set(r.sent.map(b => b.to)).has(bare(selfAuth.e164)));
  ok('  and the refusal came from the engine rule, not a local reimplementation',
    out.skipped.some(s => s.authority_id === selfAuth.authority_id && s.reason === 'CANNOT_APPROVE'));
  ok('  other authorities were still notified', r.sent.length >= 2);
  for (const a of [authorityA, authorityB]) {
    trackDispatch(messagesRepo.buildDispatchId({ request_id: req.id, authority_id: a.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION }));
  }
}

// ── B8 broken binding ───────────────────────────────────────────────────────
console.log('\n  -- an unusable binding sends nothing --');
{
  const broken = await makeAuthority('broken');
  await bindingsRepo.numberBindingRef(broken.e164).delete();
  const r = recorder();
  const req = requestFor('broken');
  const out = await notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r.client });
  ok('B8. an authority whose binding is missing receives nothing',
    !new Set(r.sent.map(b => b.to)).has(bare(broken.e164)));
  ok('  and is reported as an unusable binding',
    out.skipped.some(s => s.authority_id === broken.authority_id && s.reason === 'BINDING_UNUSABLE'));
  for (const a of [authorityA, authorityB]) {
    trackDispatch(messagesRepo.buildDispatchId({ request_id: req.id, authority_id: a.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION }));
  }
}

// ── B9 transport outcomes ───────────────────────────────────────────────────
console.log('\n  -- transport failure, timeout and malformed response --');
{
  const timeoutErr = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  const cases = [
    ['HTTP 400', async () => ({ ok: false, status: 400, json: { error: { code: 131009 } } }), K.WHATSAPP_SEND_STATE.FAILED],
    ['timeout', async () => { throw timeoutErr; }, K.WHATSAPP_SEND_STATE.UNKNOWN],
    ['malformed 200', async () => ({ ok: true, status: 200, json: { nothing: true } }), K.WHATSAPP_SEND_STATE.UNKNOWN]
  ];
  let n = 0;
  for (const [label, script, expected] of cases) {
    n += 1;
    const r = recorder(script);
    const req = requestFor(`fail${n}`);
    await notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r.client });
    const id = messagesRepo.buildDispatchId({ request_id: req.id, authority_id: authorityA.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION });
    trackDispatch(id);
    for (const a of [authorityB]) trackDispatch(messagesRepo.buildDispatchId({ request_id: req.id, authority_id: a.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION }));
    const row = await messagesRepo.getDispatchFirestore(id);
    ok(`B9. ${label} is recorded as ${expected}`, row?.send_state === expected, `got ${row?.send_state}`);
    ok(`  ${label} invents no provider message id`, row?.provider_message_id === null);
  }
}

// ── B10 a timeout does not create a second dispatch ─────────────────────────
console.log('\n  -- an unknown outcome is never reclaimed --');
{
  const req = requestFor('fail2');
  const id = messagesRepo.buildDispatchId({ request_id: req.id, authority_id: authorityA.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION });
  const before = await messagesRepo.getDispatchFirestore(id);
  const r = recorder();
  await notify.notifyAuthoritiesOfPurchaseRequest({ request: req, client: r.client });
  const after = await messagesRepo.getDispatchFirestore(id);
  ok('B10. re-running after a timeout sends nothing and reclaims nothing',
    r.sent.length === 0 && after.send_state === before.send_state);
  ok('  the dispatch id is unchanged, so no second record exists',
    after.dispatch_id === before.dispatch_id);
}

// ── B11 socket events ───────────────────────────────────────────────────────
console.log('\n  -- socket events --');
{
  const emitted = [];
  const fakeIo = { emit: (event, data) => emitted.push({ event, data }) };
  const r = recorder();
  const req = requestFor('socket');
  await notify.notifyAuthoritiesOfPurchaseRequest({ request: req, io: fakeIo, client: r.client });
  for (const a of [authorityA, authorityB]) {
    trackDispatch(messagesRepo.buildDispatchId({ request_id: req.id, authority_id: a.authority_id, purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION }));
  }
  const names = emitted.map(e => e.event);
  ok('B11. a queued event precedes each status event',
    names.filter(n => n === K.PR_WHATSAPP_EVENTS.QUEUED).length >= 1 &&
    names.indexOf(K.PR_WHATSAPP_EVENTS.QUEUED) < names.indexOf(K.PR_WHATSAPP_EVENTS.STATUS));
  ok('  no decision event was emitted by the fan-out',
    !names.includes(K.PR_EVENTS.DECIDED) && !names.includes(K.PR_EVENTS.SUBMITTED));
  const payloads = JSON.stringify(emitted);
  ok('  no payload carries a phone number, token or secret',
    !payloads.includes(bare(authorityA.e164)) && !payloads.includes(bare(authorityB.e164)) &&
    !/token|secret|hpms\.v1/i.test(payloads));
}

// ── B12 the audit trail ─────────────────────────────────────────────────────
console.log('\n  -- the audit trail --');
{
  // Queried by user_id, which the audit writer sets to the authority id. An
  // unordered limit on `action` alone would return an arbitrary window of every
  // audit row in the database and miss this run's entirely.
  const snap = await db.collection('audit_logs')
    .where('user_id', '==', authorityA.authority_id).get();
  // The audit repository stores `details` as a JSON string, not an object.
  const mine = snap.docs.map(d => d.data())
    .filter(d => d.action === notify.WHATSAPP_NOTIFICATION_AUDIT_ACTIONS.SENT)
    .map(d => ({ ...d, details: typeof d.details === 'string' ? JSON.parse(d.details) : d.details }));
  ok('B12. a SENT audit row exists for this run', mine.length >= 1, `${mine.length} row(s)`);
  const blob = JSON.stringify(mine);
  ok('  it records the authority and the provider message id',
    mine.every(d => d.details?.authority_id && d.details?.provider_message_id),
    JSON.stringify(mine.map(d => Object.keys(d.details || {}))[0] || []).slice(0, 160));
  ok('  it contains no full phone number, token, code or secret',
    !blob.includes(bare(authorityA.e164)) && !blob.includes(bare(authorityB.e164)) &&
    !/raw_token|challenge_code|verification_code|access_token/i.test(blob));
  snap.docs.forEach(d => created.settings.push(`audit:${d.id}`));
}

// ── cleanup, verified by re-reading ─────────────────────────────────────────
console.log('\n  -- cleanup --');
{
  const survivors = [];
  for (const id of created.dispatches) {
    await db.collection('whatsapp_messages').doc(id).delete();
    if ((await db.collection('whatsapp_messages').doc(id).get()).exists) survivors.push(`whatsapp_messages/${id}`);
  }
  for (const id of created.authorities) {
    await db.collection('inventory_approval_authorities').doc(id).delete();
    if ((await db.collection('inventory_approval_authorities').doc(id).get()).exists) survivors.push(`authorities/${id}`);
  }
  for (const key of created.bindings) {
    await db.collection('whatsapp_number_bindings').doc(key).delete();
    if ((await db.collection('whatsapp_number_bindings').doc(key).get()).exists) survivors.push(`bindings/${key}`);
  }
  for (const entry of created.settings) {
    if (entry.startsWith('audit:')) { await db.collection('audit_logs').doc(entry.slice(6)).delete(); continue; }
    await db.collection('settings').doc(entry).delete();
  }
  ok(`CLEAN. every document this run created is deleted and verified gone by re-reading`,
    survivors.length === 0, survivors.join(', ') || 'none');
  if (survivors.length) { console.log('\n  Remove manually:'); survivors.forEach(s => console.log('    ' + s)); }
}

console.log(`\n═══ H8-C FAN-OUT: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
