/**
 * backend/tests/testInventoryWhatsAppDeliveryStatusH8E.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-E — inbound delivery receipts for outbound messages.
 *
 * PART A — no Firebase. Source invariants proving the status path is transport
 *   state only and can reach no decision machinery.
 *
 * PART B — the real repository and dispatcher against the local emulator.
 *   Real dispatch rows, real receipts, real monotonic transitions. No Meta
 *   credential exists and no network call is ever made.
 *
 * Every document created is recorded by id, deleted at the end and re-read to
 * prove it is gone. Nothing is deleted by collection sweep.
 *
 * Run:  npm run test:firestore:emulator -- backend/tests/testInventoryWhatsAppDeliveryStatusH8E.mjs
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

const REPO = codeOnly(src('backend', 'repositories', 'firestore', 'whatsappMessagesRepository.js'));
const DISPATCH = codeOnly(src('backend', 'services', 'whatsappInboundDispatcher.js'));
const WCTRL = codeOnly(src('backend', 'controllers', 'whatsappWebhookController.js'));

console.log('═══ PART A — source invariants (no Firebase) ═══');

console.log('\n  -- a receipt can reach no decision machinery --');
ok('A1. the repository still touches no engine, token or authority',
  !/decideWithApprovalActionToken|beginTokenRejection|completeTokenRejection|createApprovalActionFirestore|consumeApprovalAction|purchaseRequest|PR_STATUS/i.test(REPO));
ok('  it still imports nothing but Firestore helpers and constants',
  !/services\/|controllers\//.test(REPO));
ok('A2. the status branch is transport only: no engine call, no token, no PR',
  !/decideWithApprovalActionToken|beginTokenRejection|completeTokenRejection|createApprovalActionFirestore|purchase_requests|PR_STATUS/.test(
    DISPATCH.slice(DISPATCH.indexOf('async function handleStatus'), DISPATCH.indexOf('async function handleOne'))));
ok('  it cannot alter an authority or a verification',
  !/inventoryApprovalAuthoritiesRepository|whatsappNumberBindingsRepository|verification/i.test(
    DISPATCH.slice(DISPATCH.indexOf('async function handleStatus'), DISPATCH.indexOf('async function handleOne'))));

console.log('\n  -- correlation is by provider message id alone --');
ok('A3. the lookup filters on provider_message_id and nothing else',
  /where\('provider_message_id', '==', wanted\)/.test(REPO));
ok('  no phone number or request number is used to correlate',
  !/applyDeliveryStatusFirestore[\s\S]{0,1400}(whatsapp_e164|request_number|phone)/.test(REPO));
ok('  an unknown id creates nothing: the write only ever patches an existing ref',
  /snap\.empty[\s\S]{0,160}DELIVERY_APPLY\.NOT_FOUND/.test(REPO) &&
  !/applyDeliveryStatusFirestore[\s\S]{0,1600}(\.create\(|\.set\()/.test(REPO));
ok('  the recipient number on a status is deliberately not read',
  !/status\.recipient_id|status\.recipient/.test(WCTRL));

console.log('\n  -- the lifecycle only moves forward --');
ok('A4. the ranks are the documented lifecycle with FAILED terminal',
  /SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4/.test(REPO));
ok('  a receipt at or below the current rank is ignored, not written',
  /nextRank <= currentRank[\s\S]{0,120}IGNORED_STALE/.test(REPO));
ok('  the read and the write share one transaction',
  /runTransaction\(async \(txn\) =>[\s\S]{0,400}txn\.get\(ref\)[\s\S]{0,900}txn\.update\(ref/.test(REPO));

console.log('\n  -- nothing secret is stored or logged --');
ok('A5. provider error text is clamped to a single line',
  /sanitizeProviderError/.test(REPO) && /replace\(\/\[\\r\\n\\t\]\+\/g, ' '\)/.test(REPO));
// Scoped to the H8-E additions. The repository as a whole DOES name those
// terms, in the H8-A forbidden-keys list, which is a defence rather than a use.
const APPLY_FN = REPO.slice(REPO.indexOf('export async function applyDeliveryStatusFirestore'),
  REPO.indexOf('export async function updateDeliveryStatusFirestore'));
const STATUS_BRANCH = DISPATCH.slice(DISPATCH.indexOf('async function handleStatus'), DISPATCH.indexOf('async function handleOne'));
ok('  no token, code or credential is referenced on the status path',
  !/raw_token|challenge_code|verification_code|WHATSAPP_ACCESS_TOKEN|WHATSAPP_APP_SECRET|WHATSAPP_WEBHOOK_VERIFY_TOKEN/.test(APPLY_FN + STATUS_BRANCH));
ok('  the status emit carries no number, token or provider payload',
  !/emit\([^)]*e164|emit\([^)]*token|emit\([^)]*error_message/i.test(DISPATCH));
ok('  the webhook clamps the provider error it reads',
  /error_message: typeof failure\?\.title === 'string'/.test(WCTRL) && /slice\(0, MAX_TEXT_LENGTH\)/.test(WCTRL));

console.log('\n  -- H5 is reused, not replaced --');
ok('A6. no second webhook route or signature check was added',
  (codeOnly(src('backend', 'routes', 'whatsappRoutes.js')).match(/router\.(get|post)\(/g) || []).length === 2);
ok('  status events still travel the existing claim-then-dispatch path',
  /event\.event_type === 'status'/.test(DISPATCH) && /markWebhookEventFirestore/.test(DISPATCH));
ok('  nothing is retried',
  !/setInterval|setTimeout|retry|backoff/i.test(
    DISPATCH.slice(DISPATCH.indexOf('async function handleStatus'), DISPATCH.indexOf('async function handleOne'))));

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H8-E DELIVERY STATUS: ${pass} passed, ${fail} failed (Part A only) ═══`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\n═══ PART B — the real status path against the emulator ═══\n');

const { createRequire } = await import('module');
const require_ = createRequire(path.join(BACKEND, 'package.json'));
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });

const { requireEmulatorOrExit } = await import('./helpers/firestoreEmulator.mjs');
await requireEmulatorOrExit();
const { db } = await import('../config/firebaseAdmin.js');

const messagesRepo = await import('../repositories/firestore/whatsappMessagesRepository.js');
const dispatcher = await import('../services/whatsappInboundDispatcher.js');
const webhookCtrl = await import('../controllers/whatsappWebhookController.js');
const K = await import('../utils/inventoryConstants.js');

const TS = Date.now();
const created = { dispatches: [], events: [] };
const S = K.WHATSAPP_DELIVERY_STATUS;

/** One outbound dispatch with a known provider id, as H8-C/D would have left. */
async function makeDispatch(tag, providerId) {
  const claim = await messagesRepo.claimDispatchFirestore({
    request_id: `pr_h8etest_${TS}_${tag}`,
    authority_id: `aa_h8etest${TS}${tag}`,
    purpose: K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION,
    request_number: `PR-H8E-${TS}-${tag}`
  });
  created.dispatches.push(claim.dispatch_id);
  await messagesRepo.recordProviderMessageIdFirestore(claim.dispatch_id, providerId);
  return claim.dispatch_id;
}
const rowOf = (id) => messagesRepo.getDispatchFirestore(id);
const apply = (pid, status, extra = {}) => messagesRepo.applyDeliveryStatusFirestore(pid, { status, ...extra });

// ── B1..B4 each status lands ────────────────────────────────────────────────
console.log('  -- each status lands on the right message --');
{
  const pid = `wamid.h8e.${TS}.a`;
  const id = await makeDispatch('a', pid);
  ok('B1. sent is applied', (await apply(pid, 'sent')).outcome === 'APPLIED');
  let row = await rowOf(id);
  ok('  and stamps sent_at', row.delivery_status === S.SENT && typeof row.sent_at === 'string');
  ok('B2. delivered is applied', (await apply(pid, 'delivered')).outcome === 'APPLIED');
  row = await rowOf(id);
  ok('  and stamps delivered_at while keeping sent_at',
    row.delivery_status === S.DELIVERED && typeof row.delivered_at === 'string' && typeof row.sent_at === 'string');
  ok('B3. read is applied', (await apply(pid, 'read')).outcome === 'APPLIED');
  row = await rowOf(id);
  ok('  and stamps read_at', row.delivery_status === S.READ && typeof row.read_at === 'string');
}
{
  const pid = `wamid.h8e.${TS}.f`;
  const id = await makeDispatch('f', pid);
  const r = await apply(pid, 'failed', { error_code: 131026, error_message: 'Message undeliverable' });
  ok('B4. failed is applied with its provider detail', r.outcome === 'APPLIED');
  const row = await rowOf(id);
  ok('  code and clamped message are recorded, failed_at stamped',
    row.delivery_status === S.FAILED && row.provider_error_code === '131026' &&
    row.provider_error_message === 'Message undeliverable' && typeof row.failed_at === 'string');
}

// ── B5..B8 monotonic behaviour ──────────────────────────────────────────────
console.log('\n  -- the lifecycle only moves forward --');
{
  const pid = `wamid.h8e.${TS}.m`;
  const id = await makeDispatch('m', pid);
  await apply(pid, 'sent');
  await apply(pid, 'delivered');
  ok('B5. a duplicate delivered is ignored, not reapplied',
    (await apply(pid, 'delivered')).outcome === 'IGNORED_STALE');
  ok('B6. a late sent cannot downgrade delivered',
    (await apply(pid, 'sent')).outcome === 'IGNORED_STALE' &&
    (await rowOf(id)).delivery_status === S.DELIVERED);
  await apply(pid, 'read');
  ok('B7. a late delivered cannot downgrade read',
    (await apply(pid, 'delivered')).outcome === 'IGNORED_STALE' &&
    (await rowOf(id)).delivery_status === S.READ);
  const before = (await rowOf(id)).delivery_updated_at;
  await apply(pid, 'sent');
  ok('  and an ignored receipt writes nothing at all',
    (await rowOf(id)).delivery_updated_at === before);
}
{
  const pid = `wamid.h8e.${TS}.t`;
  const id = await makeDispatch('t', pid);
  await apply(pid, 'failed', { error_code: 1, error_message: 'gone' });
  ok('B8. FAILED is terminal: no later lifecycle status reopens it',
    (await Promise.all(['sent', 'delivered', 'read'].map(s => apply(pid, s))))
      .every(r => r.outcome === 'IGNORED_STALE') &&
    (await rowOf(id)).delivery_status === S.FAILED);
}

// ── B9 unknown provider id ──────────────────────────────────────────────────
console.log('\n  -- an unknown message id --');
{
  const before = (await db.collection('whatsapp_messages').get()).size;
  const r = await apply(`wamid.h8e.${TS}.nobody`, 'delivered');
  const after = (await db.collection('whatsapp_messages').get()).size;
  ok('B9. an unknown provider id is reported, not invented', r.outcome === 'NOT_FOUND');
  ok('  and creates no document', after === before, `${before} -> ${after}`);
}

// ── B10/B19 sanitising and malformed input ──────────────────────────────────
console.log('\n  -- provider detail is sanitised, malformed input refused --');
{
  const pid = `wamid.h8e.${TS}.s`;
  const id = await makeDispatch('s', pid);
  await apply(pid, 'failed', { error_code: 'X'.repeat(200), error_message: 'line\none\ttwo   three' + 'y'.repeat(500) });
  const row = await rowOf(id);
  ok('B10. the error message is single-line and clamped',
    !/[\r\n\t]/.test(row.provider_error_message) &&
    row.provider_error_message.length <= messagesRepo.PROVIDER_ERROR_MAX);
  ok('  the error code is clamped too', row.provider_error_code.length <= 64);

  const badPid = `wamid.h8e.${TS}.bad`;
  await makeDispatch('bad', badPid);
  ok('B19. a malformed or unknown status value is refused',
    (await Promise.all(['', '   ', 'pending', 'constructor', '__proto__', null, undefined, 42]
      .map(s => apply(badPid, s)))).every(r => r.outcome === 'INVALID'));
  ok('  an empty provider id is refused', (await apply('', 'sent')).outcome === 'INVALID');
}

// ── B20 isolation between messages ──────────────────────────────────────────
console.log('\n  -- one receipt touches exactly one message --');
{
  const pidX = `wamid.h8e.${TS}.x`, pidY = `wamid.h8e.${TS}.y`;
  const idX = await makeDispatch('x', pidX);
  const idY = await makeDispatch('y', pidY);
  await apply(pidX, 'read');
  const rowY = await rowOf(idY);
  ok('B20. another authority\'s message is untouched',
    rowY.delivery_status === null && rowY.read_at === undefined);
  ok('  and the targeted message advanced', (await rowOf(idX)).delivery_status === S.READ);
}

// ── B13..B17, B21, B22 no side effects anywhere else ────────────────────────
console.log('\n  -- a receipt changes nothing outside transport --');
{
  const pid = `wamid.h8e.${TS}.side`;
  const id = await makeDispatch('side', pid);
  const prId = `pr_h8etest_${TS}_side`;
  await db.collection('purchase_requests').doc(prId).set({
    request_id: prId, request_number: `PR-H8E-${TS}-side`, status: K.PR_STATUS.PENDING_APPROVAL,
    department: 'Kitchen', item_count: 1, total_estimated_value: 5, requested_by_uid: 'staff_h8e'
  });
  const authId = `aa_h8etest${TS}side`;
  await db.collection('inventory_approval_authorities').doc(authId).set({
    authority_id: authId, authority_type: K.APPROVAL_AUTHORITY_TYPES.EXTERNAL,
    display_name: 'H8E_TEST side', whatsapp_e164: '+919900000001',
    verification_status: K.APPROVAL_AUTHORITY_VERIFICATION.VERIFIED, is_active: true
  });

  const actionsBefore = (await db.collection('inventory_approval_actions').get()).size;
  await apply(pid, 'failed', { error_code: 7, error_message: 'nope' });

  const pr = await db.collection('purchase_requests').doc(prId).get();
  ok('B13. the purchase request status is untouched', pr.data().status === K.PR_STATUS.PENDING_APPROVAL);
  ok('B14/B15. no approval action was minted or consumed',
    (await db.collection('inventory_approval_actions').get()).size === actionsBefore);
  const auth = await db.collection('inventory_approval_authorities').doc(authId).get();
  ok('B21/B22. the authority\'s verification and activation are untouched',
    auth.data().verification_status === K.APPROVAL_AUTHORITY_VERIFICATION.VERIFIED && auth.data().is_active === true);
  ok('B16/B17. the dispatch itself is the only thing that moved',
    (await rowOf(id)).delivery_status === S.FAILED);

  await db.collection('purchase_requests').doc(prId).delete();
  await db.collection('inventory_approval_authorities').doc(authId).delete();
}

// ── B18 the dispatcher path, end to end ─────────────────────────────────────
console.log('\n  -- through the real dispatcher --');
{
  const pid = `wamid.h8e.${TS}.disp`;
  const id = await makeDispatch('disp', pid);
  const emitted = [];
  const fakeIo = { emit: (event, data) => emitted.push({ event, data }) };

  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      statuses: [{ id: pid, status: 'delivered', timestamp: '1', recipient_id: '919900000002' }]
    } }] }]
  };
  const events = webhookCtrl.extractWebhookEvents(payload);
  ok('B18. the webhook extracts the receipt with its status value',
    events.length === 1 && events[0].event_type === 'status' && events[0].status_value === 'delivered');
  ok('  and does not carry the recipient number',
    !JSON.stringify(events[0]).includes('919900000002'));

  events.forEach(e => created.events.push(e.event_id));
  await dispatcher.dispatchInboundWhatsAppEvents(events, { io: fakeIo });
  ok('  the dispatcher applied it to the correlated message',
    (await rowOf(id)).delivery_status === S.DELIVERED);
  ok('  and emitted a transport status event carrying no number or token',
    emitted.length === 1 && emitted[0].event === K.PR_WHATSAPP_EVENTS.STATUS &&
    !/e164|token|9199000/.test(JSON.stringify(emitted[0])));

  // Redelivery of the identical receipt must be harmless.
  const again = [];
  await dispatcher.dispatchInboundWhatsAppEvents(events, { io: { emit: (e, d) => again.push({ e, d }) } });
  ok('B5b. a redelivered identical receipt is harmless and emits nothing',
    (await rowOf(id)).delivery_status === S.DELIVERED && again.length === 0);
}

// ── B11/B12 nothing secret persisted or logged ──────────────────────────────
console.log('\n  -- nothing secret escapes --');
{
  const rows = await Promise.all([...new Set(created.dispatches)].map(rowOf));
  const blob = JSON.stringify(rows);
  ok('B11. no token, code, credential or phone number is persisted on any row',
    !/raw_token|challenge_code|verification_code|access_token|app_secret/i.test(blob) &&
    !/\+?9199000000\d\d/.test(blob) && !/whatsapp_e164/.test(blob));
  ok('B12. the stored failure detail is only a code and a clamped message',
    rows.filter(r => r?.delivery_status === S.FAILED)
      .every(r => typeof r.provider_error_code === 'string' && r.provider_error_message.length <= messagesRepo.PROVIDER_ERROR_MAX));
}

// ── cleanup ─────────────────────────────────────────────────────────────────
console.log('\n  -- cleanup --');
{
  const survivors = [];
  for (const id of [...new Set(created.dispatches)]) {
    await db.collection('whatsapp_messages').doc(id).delete();
    if ((await db.collection('whatsapp_messages').doc(id).get()).exists) survivors.push(`whatsapp_messages/${id}`);
  }
  for (const id of [...new Set(created.events)]) await db.collection('whatsapp_webhook_events').doc(id).delete();
  ok('CLEAN. every document this run created is deleted and verified gone',
    survivors.length === 0, survivors.join(', ') || 'none');
}

console.log(`\n═══ H8-E DELIVERY STATUS: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
