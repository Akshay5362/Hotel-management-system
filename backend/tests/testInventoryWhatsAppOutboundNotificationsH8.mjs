/**
 * backend/tests/testInventoryWhatsAppOutboundNotificationsH8.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-A — the outbound dispatch correlation model.
 *
 * NOTE ON THE NAME: this is the WhatsApp approval series (H1..H8), which is
 * named by feature. It is NOT testInventoryPhaseH8.mjs — that name belongs to
 * the inventory module's own A..H8 series, where it is the module-wide
 * validation runner. The two series are unrelated and must not collide.
 *
 * PART A — no Firebase. Source invariants plus pure constants. Imports nothing
 *   that reaches firebaseAdmin, which initialises against PRODUCTION when
 *   HPMS_ENV is unset. The repository itself therefore cannot be imported here.
 *
 * PART B — DEV Firestore behind the four-layer guard. Exercises the real
 *   repository against real documents: the deterministic claim, the duplicate
 *   collision, the send outcome, the delivery receipt, the provider-id lookup
 *   and the compare-and-increment mint counter.
 *
 * WHAT H8-A IS NOT: there is no fan-out, no Meta client, no template, no token
 * minting and no inbound routing in this phase. Part A asserts their absence,
 * so a later phase cannot quietly land early.
 *
 * CLEANUP
 * Every document is recorded by id as it is created, deleted at the end, and
 * then RE-READ to prove it is gone. A delete call returning success is not
 * accepted as evidence: Firestore reports deleting a non-existent document as
 * a success. Nothing here deletes by collection sweep, so DEV data created by
 * a person is never at risk.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryWhatsAppOutboundNotificationsH8.mjs
 *       node backend/tests/testInventoryWhatsAppOutboundNotificationsH8.mjs   (Part A only)
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

const REPO_RAW = src('backend', 'repositories', 'firestore', 'whatsappMessagesRepository.js');
const REPO = codeOnly(REPO_RAW);
const CONSTS = codeOnly(src('backend', 'utils', 'inventoryConstants.js'));
const RULES = src('firestore.rules');
const INDEXES = src('firestore.indexes.json');

console.log('═══ PART A — source invariants and constants (no Firebase) ═══');

// ── the collection is server-owned ──────────────────────────────────────────
console.log('\n  -- rules --');
const blocks = RULES.match(/match \/whatsapp_[A-Za-z_]+\/\{[^}]*\}\s*\{[^}]*\}/g) || [];
const messagesBlock = blocks.filter(b => /whatsapp_messages/.test(b));
ok('A1. firestore.rules declares whatsapp_messages exactly once',
  messagesBlock.length === 1, `found ${messagesBlock.length}`);
ok('  and that single block is deny-all',
  /allow read,\s*write:\s*if false;/.test(messagesBlock[0] || ''));
ok('  it grants nothing else: no allow beyond the deny-all line',
  ((messagesBlock[0] || '').match(/allow /g) || []).length === 1);
ok('  every whatsapp_* collection remains deny-all',
  blocks.length >= 3 && blocks.every(b => /allow read,\s*write:\s*if false;/.test(b)),
  `${blocks.length} blocks`);
// Mutation control: the assertion must fail on a granting rule, or it proves nothing.
ok('  (control) the deny-all check rejects a rule that grants read',
  !/allow read,\s*write:\s*if false;/.test('match /whatsapp_messages/{id} {\n allow read: if true;\n}'));

console.log('\n  -- indexes --');
ok('A2. H8-A declares no composite index',
  !/whatsapp_messages/.test(INDEXES));

// ── the deterministic id ────────────────────────────────────────────────────
console.log('\n  -- the deterministic dispatch id --');
ok('A3. the id is derived from purpose, request and authority only',
  /\[validPurpose, requestId, authorityId\]\.join\('\\u0000'\)/.test(REPO));
ok('  the components are NUL-joined, so ("ab","c") cannot collide with ("a","bc")',
  /join\('\\u0000'\)/.test(REPO));
ok('  the provider message id is NOT the document id',
  !/doc\(\s*providerMessageId|doc\(\s*provider_message_id/.test(REPO));
ok('  no phone number and no secret is fed into the id',
  !/buildDispatchId[\s\S]{0,600}?(whatsapp_e164|phone|token|secret|code)/i.test(REPO));

// ── nothing secret is persisted ─────────────────────────────────────────────
console.log('\n  -- what may never be stored --');
for (const forbidden of ['raw_token', 'access_token', 'app_secret', 'whatsapp_e164', 'verification_code']) {
  ok(`A4. '${forbidden}' is named in the refusal list`,
    new RegExp(`'${forbidden}'`).test(REPO));
}
ok('  a forbidden key is REFUSED, not silently dropped',
  /FORBIDDEN_FIELD/.test(REPO) && /assertNoForbiddenKeys\(data\)/.test(REPO));
ok('  the stored document is built from an explicit shape, never a spread of caller data',
  !/const doc = \{\s*\.\.\.data/.test(REPO) && /dispatch_id: dispatchId,/.test(REPO));

// ── enum handling ───────────────────────────────────────────────────────────
console.log('\n  -- enum safety --');
ok('A5. enum membership uses hasOwnProperty, not a prototype-reachable lookup',
  /Object\.prototype\.hasOwnProperty\.call\(enumObject, value\)/.test(REPO));
ok('  Meta\'s lower-case delivery vocabulary is normalized in one place',
  /toUpperCase\(\)/.test(REPO) && /normalizeDeliveryStatus/.test(REPO));

// ── the repository is persistence only ──────────────────────────────────────
console.log('\n  -- scope: persistence only --');
ok('A6. the repository makes no network call of any kind',
  !/fetch\(|axios|https?:\/\/|graph\.facebook|XMLHttpRequest|node-fetch/.test(REPO));
ok('  it imports no transport and no service',
  !/whatsappOutboundClient|whatsappDecisionRouter|services\//.test(REPO));
ok('  it mints, reads and consumes no approval token',
  !/createApprovalActionFirestore|consumeApprovalAction|markApprovalActionConsumed|hashToken|generateRawToken/.test(REPO));
ok('  it retries nothing',
  !/setTimeout|setInterval|retry|backoff/i.test(REPO));
ok('  it reads no purchase request and decides nothing',
  !/purchaseRequestsRepository|PurchaseRequestService|PR_STATUS|assertTransition/.test(REPO));
ok('  it touches only its own collection',
  (REPO.match(/db\.collection\(/g) || []).every(() => true) &&
  !/db\.collection\((?!WHATSAPP_MESSAGES_COLLECTION)/.test(REPO));

console.log('\n  -- H8-A stops where it should --');
ok('A7. no fan-out, no template send, no bridge, no inbound routing in H8-A',
  !/sendTemplate|fanOut|fan_out|routeWhatsAppAction|dispatchInboundWhatsAppEvents/.test(REPO));
const CTRL = codeOnly(src('backend', 'controllers', 'purchaseRequestController.js'));
ok('  the submit controller is untouched by H8-A',
  !/whatsappMessages|claimDispatch|whatsapp_messages/i.test(CTRL));
// NARROWED in H8-B, not dropped. This used to require that the SHARED transport
// had no template capability, which held only until H8-B legitimately gave it
// one. That was never H8-A's boundary to police. H8-A's own boundary is
// asserted directly instead, and more strictly than the original: the
// correlation repository is persistence, and carries no transport whatsoever —
// no send method, no HTTP, no provider envelope, no credential header, and no
// import of the client that owns those things.
ok('  the correlation repository implements no transport and sends nothing',
  !/sendTemplateMessage|sendInteractiveButtonsMessage|sendText|sendReasonList/.test(REPO) &&
  !/fetch\(|axios|graph\.facebook|messaging_product|authorization|Bearer/i.test(REPO) &&
  !/whatsappOutboundClient|createWhatsAppReplyClient/.test(REPO));
// The assertion that ENABLE_WHATSAPP_OUTBOUND must not exist was removed here:
// H8-B introduced that flag legitimately, and its default-off behaviour is
// asserted by the H8-B transport suite, which owns it.

// ── constants ───────────────────────────────────────────────────────────────
console.log('\n  -- constants --');
const K = await import('../utils/inventoryConstants.js');
ok('A8. the four state vocabularies exist and are frozen',
  Object.isFrozen(K.WHATSAPP_DISPATCH_DIRECTION) && Object.isFrozen(K.WHATSAPP_DISPATCH_PURPOSE) &&
  Object.isFrozen(K.WHATSAPP_SEND_STATE) && Object.isFrozen(K.WHATSAPP_DELIVERY_STATUS));
ok('  send_state is exactly CLAIMED, SENT, FAILED, UNKNOWN',
  JSON.stringify(Object.keys(K.WHATSAPP_SEND_STATE)) === JSON.stringify(['CLAIMED', 'SENT', 'FAILED', 'UNKNOWN']));
ok('  delivery_status is exactly SENT, DELIVERED, READ, FAILED',
  JSON.stringify(Object.keys(K.WHATSAPP_DELIVERY_STATUS)) === JSON.stringify(['SENT', 'DELIVERED', 'READ', 'FAILED']));
ok('  every value matches its key, so no casing drift is possible',
  [K.WHATSAPP_SEND_STATE, K.WHATSAPP_DELIVERY_STATUS, K.WHATSAPP_DISPATCH_PURPOSE, K.WHATSAPP_DISPATCH_DIRECTION]
    .every(e => Object.entries(e).every(([k, v]) => k === v)));
ok('  the project\'s upper-case convention is preserved',
  Object.values(K.WHATSAPP_SEND_STATE).every(v => v === v.toUpperCase()));
ok('  two purposes exist, so a notification and a prompt are distinct dispatches',
  Object.keys(K.WHATSAPP_DISPATCH_PURPOSE).length === 2);

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H8-A CORRELATION MODEL: ${pass} passed, ${fail} failed (Part A only) ═══`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\n═══ PART B — DEV Firestore (sky5-development only) ═══\n');

// ── four-layer fail-closed guard, then the live-handle assertion ────────────
const { createRequire } = await import('module');
const require_ = createRequire(path.join(BACKEND, 'package.json'));
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });
const { isProductionProject } = await import('../config/productionSafetyGuard.js');
if (isProductionProject()) { console.error('[SAFETY_ABORT] production project.'); process.exit(1); }
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }

// Phase 1B — a Firestore-backed suite runs against the local emulator only.
// Placed before the FIRST import that can reach firebaseAdmin.js, which
// initialises the Admin SDK at import time. This ADDS to the guard above;
// every existing check still runs and none is relaxed.
const { requireEmulatorOrExit } = await import('./helpers/firestoreEmulator.mjs');
await requireEmulatorOrExit();
const { db } = await import('../config/firebaseAdmin.js');
const liveProject = db?._settings?.projectId || PROJECT;
if (liveProject !== 'sky5-development') { console.error(`[SAFETY_ABORT] live handle "${liveProject}".`); process.exit(1); }
console.log(`  [GUARD] project=${liveProject} (DEV)\n`);

const repo = await import('../repositories/firestore/whatsappMessagesRepository.js');

// Every id this suite creates, for the cleanup that is verified by re-reading.
const created = new Set();
const TS = Date.now();
const REQ_A = `pr_h8atest_${TS}_a`;
const REQ_B = `pr_h8atest_${TS}_b`;
const AUTH_A = `aa_h8atest${TS}a`;
const AUTH_B = `aa_h8atest${TS}b`;
const P_NOTIFY = K.WHATSAPP_DISPATCH_PURPOSE.PR_REVIEW_NOTIFICATION;
const P_PROMPT = K.WHATSAPP_DISPATCH_PURPOSE.PR_DECISION_PROMPT;

const claim = async (o) => {
  const r = await repo.claimDispatchFirestore(o);
  created.add(r.dispatch_id);
  return r;
};

// ── B1 determinism ──────────────────────────────────────────────────────────
console.log('  -- determinism --');
const id1 = repo.buildDispatchId({ request_id: REQ_A, authority_id: AUTH_A, purpose: P_NOTIFY });
const id2 = repo.buildDispatchId({ request_id: REQ_A, authority_id: AUTH_A, purpose: P_NOTIFY });
ok('B1. the same request, authority and purpose always give the same id', id1 === id2);
ok('  and the id is shaped as documented', /^wmd_[0-9a-f]{64}$/.test(id1));

// Independent recomputation: proves the id is what the specification says it
// is, not merely self-consistent with whatever the implementation happens to do.
const expected = 'wmd_' + crypto.createHash('sha256')
  .update([P_NOTIFY, REQ_A, AUTH_A].join('\u0000'), 'utf8').digest('hex');
ok('  it matches an independently computed SHA-256 over the NUL-joined parts', id1 === expected);

ok('B2. a different request gives a different id',
  repo.buildDispatchId({ request_id: REQ_B, authority_id: AUTH_A, purpose: P_NOTIFY }) !== id1);
ok('B3. a different authority gives a different id',
  repo.buildDispatchId({ request_id: REQ_A, authority_id: AUTH_B, purpose: P_NOTIFY }) !== id1);
ok('B4. a different purpose gives a different id',
  repo.buildDispatchId({ request_id: REQ_A, authority_id: AUTH_A, purpose: P_PROMPT }) !== id1);
ok('  the NUL separator prevents a boundary collision',
  repo.buildDispatchId({ request_id: 'ab', authority_id: 'c', purpose: P_NOTIFY }) !==
  repo.buildDispatchId({ request_id: 'a', authority_id: 'bc', purpose: P_NOTIFY }));
ok('  an unknown purpose is refused, including a prototype-reachable name',
  ['NOPE', 'constructor', 'toString', '__proto__', '', null, undefined, 42]
    .every(p => { try { repo.buildDispatchId({ request_id: REQ_A, authority_id: AUTH_A, purpose: p }); return false; } catch { return true; } }));
ok('  a missing request or authority is refused',
  [{ authority_id: AUTH_A, purpose: P_NOTIFY }, { request_id: REQ_A, purpose: P_NOTIFY }, {}]
    .every(o => { try { repo.buildDispatchId(o); return false; } catch { return true; } }));

// ── B5/B6 the claim ─────────────────────────────────────────────────────────
console.log('\n  -- the claim --');
const first = await claim({
  request_id: REQ_A, authority_id: AUTH_A, purpose: P_NOTIFY,
  request_number: 'PR-H8A-0001', template_name: 'purchase_request_review'
});
ok('B5. the first claim wins', first.claimed === true && first.duplicate === false);
ok('  and it used the deterministic id', first.dispatch_id === id1);

const second = await claim({
  request_id: REQ_A, authority_id: AUTH_A, purpose: P_NOTIFY,
  request_number: 'PR-H8A-0001', template_name: 'purchase_request_review'
});
ok('B6. the second claim is recognised as a duplicate and does not throw',
  second.claimed === false && second.duplicate === true && second.dispatch_id === id1);

const stored = await repo.getDispatchFirestore(id1);
// Read the RAW snapshot, not the formatted one: formatDocSnapshot adds `id` and
// `doc_id` at read time, so asserting over the formatted object would describe
// the reader rather than the document. This checks what is actually persisted.
const rawStored = Object.keys((await db.collection('whatsapp_messages').doc(id1).get()).data()).sort();
ok('  the stored row has exactly the intended fields, and no others',
  JSON.stringify(rawStored) === JSON.stringify([
    'authority_id', 'bridge_consumed_at', 'bridge_mint_count', 'created_at',
    'delivery_status', 'delivery_updated_at', 'direction', 'dispatch_id',
    'provider_message_id', 'purpose', 'request_id', 'request_number',
    'send_state', 'template_name', 'updated_at'
  ]), rawStored.join(','));
ok('  it opens in CLAIMED with no provider id and no delivery status',
  stored.send_state === K.WHATSAPP_SEND_STATE.CLAIMED &&
  stored.provider_message_id === null && stored.delivery_status === null);
ok('  the counters start empty',
  stored.bridge_mint_count === 0 && stored.bridge_consumed_at === null);
ok('  direction is OUTBOUND',
  stored.direction === K.WHATSAPP_DISPATCH_DIRECTION.OUTBOUND);

// A prompt for the same pair is a separate dispatch, not a collision.
const promptClaim = await claim({ request_id: REQ_A, authority_id: AUTH_A, purpose: P_PROMPT });
ok('  a decision prompt for the same pair claims independently',
  promptClaim.claimed === true && promptClaim.dispatch_id !== id1);

// ── B7 secrets are refused ──────────────────────────────────────────────────
console.log('\n  -- secrets are refused, not dropped --');
for (const [key, value] of [
  ['raw_token', 'A'.repeat(43)], ['access_token', 'EAAJBsecret'], ['app_secret', 'shhh'],
  ['whatsapp_e164', '+919999999999'], ['verification_code', '12345678'], ['sender_id', '919999999999']
]) {
  let refused = false;
  try {
    await repo.claimDispatchFirestore({
      request_id: `${REQ_B}_x`, authority_id: AUTH_B, purpose: P_NOTIFY, [key]: value
    });
  } catch (e) { refused = e.code === 'FORBIDDEN_FIELD'; }
  ok(`B7. '${key}' is refused with FORBIDDEN_FIELD`, refused);
}
const leaked = await repo.getDispatchFirestore(
  repo.buildDispatchId({ request_id: `${REQ_B}_x`, authority_id: AUTH_B, purpose: P_NOTIFY })
).catch(() => null);
ok('  and the refusal wrote nothing at all', leaked === null);

// An unknown-but-harmless key is dropped rather than written.
const extra = await claim({
  request_id: REQ_B, authority_id: AUTH_A, purpose: P_NOTIFY, colour: 'blue', bridge_mint_count: 99
});
const extraDoc = await repo.getDispatchFirestore(extra.dispatch_id);
ok('  an unrecognised key is not persisted, and a counter cannot be seeded',
  extraDoc.colour === undefined && extraDoc.bridge_mint_count === 0);

// ── B8 send state ───────────────────────────────────────────────────────────
console.log('\n  -- send outcome --');
await repo.recordProviderMessageIdFirestore(id1, `wamid.h8a.${TS}`);
let d = await repo.getDispatchFirestore(id1);
ok('B8. recording the provider id moves the row to SENT',
  d.provider_message_id === `wamid.h8a.${TS}` && d.send_state === K.WHATSAPP_SEND_STATE.SENT);

await repo.markDispatchSendStateFirestore(promptClaim.dispatch_id, K.WHATSAPP_SEND_STATE.UNKNOWN);
ok('  UNKNOWN persists, which is how a timed-out send stays visible',
  (await repo.getDispatchFirestore(promptClaim.dispatch_id)).send_state === K.WHATSAPP_SEND_STATE.UNKNOWN);
await repo.markDispatchSendStateFirestore(promptClaim.dispatch_id, K.WHATSAPP_SEND_STATE.FAILED);
ok('  FAILED persists',
  (await repo.getDispatchFirestore(promptClaim.dispatch_id)).send_state === K.WHATSAPP_SEND_STATE.FAILED);
ok('  an unknown send state is refused, prototype names included',
  (await Promise.all(['NOPE', 'constructor', 'toString', '__proto__', 'sent', null]
    .map(async s => { try { await repo.markDispatchSendStateFirestore(id1, s); return false; } catch { return true; } })))
    .every(Boolean));
ok('  and the refused writes left the row on SENT',
  (await repo.getDispatchFirestore(id1)).send_state === K.WHATSAPP_SEND_STATE.SENT);

// ── B9 delivery status ──────────────────────────────────────────────────────
console.log('\n  -- delivery, as Meta reports it --');
await repo.updateDeliveryStatusFirestore(id1, 'sent');
d = await repo.getDispatchFirestore(id1);
ok('B9. Meta\'s lower-case "sent" is normalized to SENT',
  d.delivery_status === K.WHATSAPP_DELIVERY_STATUS.SENT && typeof d.delivery_updated_at === 'string');
const firstDeliveryAt = d.delivery_updated_at;
await repo.updateDeliveryStatusFirestore(id1, 'delivered');
await repo.updateDeliveryStatusFirestore(id1, 'READ');
d = await repo.getDispatchFirestore(id1);
ok('  it advances through DELIVERED to READ, in either casing',
  d.delivery_status === K.WHATSAPP_DELIVERY_STATUS.READ);
ok('  and the timestamp moved',
  d.delivery_updated_at !== firstDeliveryAt);
ok('  an unrecognised delivery status is refused',
  (await Promise.all(['pending', 'constructor', '__proto__', '', null]
    .map(async s => { try { await repo.updateDeliveryStatusFirestore(id1, s); return false; } catch { return true; } })))
    .every(Boolean));
ok('  a delivery receipt changed only transport fields',
  d.send_state === K.WHATSAPP_SEND_STATE.SENT && d.request_id === REQ_A &&
  d.bridge_mint_count === 0 && d.bridge_consumed_at === null);

// ── B10 lookup by provider message id ───────────────────────────────────────
console.log('\n  -- resolving an inbound tap --');
const found = await repo.findDispatchByProviderMessageIdFirestore(`wamid.h8a.${TS}`);
ok('B10. the provider id resolves to the right dispatch',
  found && found.dispatch_id === id1 && found.request_id === REQ_A && found.authority_id === AUTH_A);
ok('  an unknown provider id resolves to null, not an error',
  (await repo.findDispatchByProviderMessageIdFirestore(`wamid.nope.${TS}`)) === null);
ok('  the lookup carries no phone number back',
  found.whatsapp_e164 === undefined && found.sender_id === undefined && found.to === undefined);

// ── B11 the mint counter ────────────────────────────────────────────────────
console.log('\n  -- the bridge counter --');
const g1 = await repo.claimBridgeMintFirestore(id1, { maxMints: 2 });
ok('B11. the first mint is granted and the counter moves',
  g1.granted === true && g1.count === 1);
d = await repo.getDispatchFirestore(id1);
const consumedAt = d.bridge_consumed_at;
ok('  the first honoured tap is stamped', typeof consumedAt === 'string');

const g2 = await repo.claimBridgeMintFirestore(id1, { maxMints: 2 });
ok('  the second is granted', g2.granted === true && g2.count === 2);
const g3 = await repo.claimBridgeMintFirestore(id1, { maxMints: 2 });
ok('  the third is refused at the ceiling',
  g3.granted === false && g3.reason === 'MINT_LIMIT_REACHED' && g3.count === 2);
d = await repo.getDispatchFirestore(id1);
ok('  the refusal did not advance the counter', d.bridge_mint_count === 2);
ok('  and the first-tap stamp was never overwritten', d.bridge_consumed_at === consumedAt);
ok('  a missing dispatch is reported, not thrown',
  (await repo.claimBridgeMintFirestore(
    repo.buildDispatchId({ request_id: 'pr_absent', authority_id: 'aa_absent', purpose: P_NOTIFY }),
    { maxMints: 2 })).reason === 'NOT_FOUND');
ok('  a missing or invalid ceiling is refused',
  (await Promise.all([undefined, 0, -1, 'two', 1.5]
    .map(async m => { try { await repo.claimBridgeMintFirestore(id1, { maxMints: m }); return false; } catch { return true; } })))
    .every(Boolean));

// Concurrency: two simultaneous taps against a ceiling of one must not both win.
const raceId = (await claim({ request_id: REQ_B, authority_id: AUTH_B, purpose: P_PROMPT })).dispatch_id;
const raced = await Promise.all([
  repo.claimBridgeMintFirestore(raceId, { maxMints: 1 }),
  repo.claimBridgeMintFirestore(raceId, { maxMints: 1 })
]);
ok('  two concurrent taps against a ceiling of one grant exactly once',
  raced.filter(r => r.granted).length === 1,
  raced.map(r => r.granted).join('/'));

// ── B12 listing ─────────────────────────────────────────────────────────────
console.log('\n  -- listing for reconciliation --');
const forA = await repo.listDispatchesForRequestFirestore(REQ_A);
ok('B12. every dispatch for one request is listed',
  forA.length === 2 && forA.every(r => r.request_id === REQ_A));
ok('  and a request with none returns empty',
  (await repo.listDispatchesForRequestFirestore('pr_none_at_all')).length === 0);

// ── B13 no network ──────────────────────────────────────────────────────────
console.log('\n  -- no network --');
let netCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { netCalls++; return realFetch ? realFetch(...a) : undefined; };
await repo.claimDispatchFirestore({ request_id: REQ_A, authority_id: AUTH_A, purpose: P_NOTIFY });
await repo.getDispatchFirestore(id1);
await repo.findDispatchByProviderMessageIdFirestore(`wamid.h8a.${TS}`);
await repo.updateDeliveryStatusFirestore(id1, 'delivered');
globalThis.fetch = realFetch;
ok('B13. no repository operation made an outbound HTTP call', netCalls === 0, `fetch calls=${netCalls}`);

// ── cleanup, verified by re-reading ─────────────────────────────────────────
console.log('\n  -- cleanup --');
const ids = [...created];
for (const id of ids) await db.collection('whatsapp_messages').doc(id).delete();
const survivors = [];
for (const id of ids) {
  const snap = await db.collection('whatsapp_messages').doc(id).get();
  if (snap.exists) survivors.push(id);
}
ok(`CLEAN. all ${ids.length} documents deleted and verified gone by re-reading`,
  survivors.length === 0, survivors.length ? `survivors: ${survivors.join(', ')}` : '');
if (survivors.length) { console.log('\n  Remove manually:'); survivors.forEach(s => console.log('    ' + s)); }

console.log(`\n═══ H8-A CORRELATION MODEL: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
