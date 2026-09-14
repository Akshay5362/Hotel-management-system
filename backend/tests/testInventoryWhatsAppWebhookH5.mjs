/**
 * backend/tests/testInventoryWhatsAppWebhookH5.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H5 — the secure WhatsApp webhook foundation.
 *
 * PART A — no Firebase, and deliberately narrow about what it imports.
 *   backend/config/firebaseAdmin.js initialises the Admin SDK AT IMPORT TIME,
 *   and with HPMS_ENV unset it loads backend/.env, which is PRODUCTION. So Part
 *   A imports only the two pure modules (the signature utility and the rate
 *   limiter) and reads everything else off disk as text. The controller, the
 *   router and the repository are imported ONLY in Part B, after the guard.
 *
 * PART B — DEV Firestore behind the four-layer guard, plus real HTTP. A genuine
 *   Express app is started on an ephemeral port with the REAL router mounted
 *   ahead of express.json(), so raw-byte capture and parser ordering are proven
 *   by observation rather than by reading the source.
 *
 * Creates no Meta credentials and calls no external service. The secrets used
 * below are synthetic values set in-process for the duration of the run.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryWhatsAppWebhookH5.mjs
 *       node backend/tests/testInventoryWhatsAppWebhookH5.mjs      (Part A only)
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

const SERVER = src('backend', 'server.js');
const ROUTES = src('backend', 'routes', 'whatsappRoutes.js');
const CTRL = src('backend', 'controllers', 'whatsappWebhookController.js');
const SIG = src('backend', 'utils', 'whatsappSignature.js');
const LIMIT = src('backend', 'middleware', 'whatsappWebhookRateLimit.js');
const REPO = src('backend', 'repositories', 'firestore', 'whatsappWebhookEventsRepository.js');
const FLAGS = src('backend', 'config', 'featureFlags.js');
const RULES = src('firestore.rules');
const SERVER_CODE = codeOnly(SERVER);
const CTRL_CODE = codeOnly(CTRL);

console.log('═══ PART A — source invariants and pure logic (no Firebase) ═══');

console.log('\n  -- parser ordering in the real server --');
const iWhats = SERVER_CODE.indexOf("app.use('/api/whatsapp', whatsappRoutes)");
const iJson = SERVER_CODE.indexOf('app.use(express.json())');
const iApi = SERVER_CODE.indexOf("app.use('/api', apiRouter)");
ok('1. the webhook router is mounted BEFORE express.json()', iWhats > -1 && iJson > -1 && iWhats < iJson, `whatsapp@${iWhats} json@${iJson}`);
ok('  the existing API router is still mounted AFTER express.json()', iJson < iApi, `json@${iJson} api@${iApi}`);
ok('  only one express.json() mount exists, so nothing else changed', (SERVER_CODE.match(/app\.use\(express\.json\(\)\)/g) || []).length === 1);
ok('  the webhook is the only thing mounted ahead of the parser',
  (SERVER_CODE.slice(0, iJson).match(/app\.use\(['"]\/api/g) || []).length === 1);

console.log('\n  -- the route brings its own raw parser, behind the limiter --');
// Comments stripped: the file's header legitimately explains its relationship
// to express.json(), and that prose must not read as a JSON parser being used.
ok('2. the POST route uses express.raw, not a JSON parser',
  /express\.raw\(/.test(codeOnly(ROUTES)) && !/express\.json/.test(codeOnly(ROUTES)));
ok('  the rate limiter runs BEFORE the raw body is buffered',
  /router\.post\('\/webhook', webhookRateLimit, rawBody, receiveWebhook\)/.test(ROUTES));
ok('  the GET handshake is rate limited too', /router\.get\('\/webhook', webhookRateLimit, verifyWebhookSubscription\)/.test(ROUTES));
ok('  the router applies no authenticate middleware (Meta cannot hold a Firebase token)',
  !/authenticate|requireRole|requireAdmin/.test(codeOnly(ROUTES)));
ok('  exactly two public paths are exposed', (codeOnly(ROUTES).match(/router\.(get|post|put|delete|patch)\(/g) || []).length === 2);

console.log('\n  -- the controller verifies before it parses --');
const iFlag = CTRL_CODE.indexOf('isWhatsAppWebhookEnabled()', CTRL_CODE.indexOf('export const receiveWebhook'));
const iVerify = CTRL_CODE.indexOf('verifyWebhookSignature(');
const iParse = CTRL_CODE.indexOf('JSON.parse(');
const iClaim = CTRL_CODE.indexOf('claimWebhookEventFirestore(');
const iDispatch = CTRL_CODE.indexOf('dispatchVerifiedWebhookEvents(claimed');
ok('3. the signature is verified BEFORE the body is parsed', iVerify > -1 && iParse > -1 && iVerify < iParse, `verify@${iVerify} parse@${iParse}`);
ok('  the feature flag is checked before the signature', iFlag > -1 && iFlag < iVerify);
ok('  events are claimed AFTER parsing and BEFORE dispatch', iParse < iClaim && iClaim < iDispatch);
ok('  a non-Buffer body is refused rather than coerced', /if \(!Buffer\.isBuffer\(rawBody\)\)/.test(CTRL_CODE));
ok('4. the dispatch seam exists', /async function dispatchVerifiedWebhookEvents/.test(CTRL_CODE));
ok('  it hands off to the inbound dispatcher and decides nothing itself',
  /dispatchInboundWhatsAppEvents\(claimedEvents, \{ io \}\)/.test(CTRL_CODE) &&
  !/decideWithApprovalActionToken|beginTokenRejection|completeTokenRejection/.test(CTRL_CODE));
ok('  it passes ONLY the Socket.IO handle downstream, never the request (H7)',
  /dispatchVerifiedWebhookEvents\(claimed, req\?\.app\?\.get\('io'\) \?\? null\)/.test(CTRL_CODE) &&
  /async function dispatchVerifiedWebhookEvents\(claimedEvents, io\)/.test(CTRL_CODE));
ok('  the sender it carries is the one Meta attested inside the signed body (H6)',
  /sender_id: message\.from \? String\(message\.from\) : null/.test(CTRL_CODE));
ok('  no approval logic leaked into H5',
  !/decideWithApprovalActionToken|beginTokenRejection|completeTokenRejection|createApprovalActionFirestore|PurchaseRequestApprovalService/.test(CTRL_CODE + codeOnly(ROUTES) + codeOnly(REPO)));
ok('  no outbound Meta client in H5', !/graph\.facebook|fetch\(|axios/.test(CTRL_CODE + codeOnly(ROUTES) + codeOnly(REPO)));

console.log('\n  -- secrets --');
const H5_CODE = CTRL_CODE + codeOnly(ROUTES) + codeOnly(SIG) + codeOnly(LIMIT) + codeOnly(REPO);
ok('5. the signature utility does not log at all', !/console\./.test(codeOnly(SIG)));
// A log line may SAY "signature"; what it must never do is carry the value.
// So the check is for a secret-bearing identifier reaching a console call,
// either interpolated or passed directly, rather than for the word appearing.
const SECRET_IDENTS = 'appSecret|expected|rawBody|headerValue|APP_SECRET|VERIFY_TOKEN|token';
ok('  no secret value is ever interpolated into a log',
  !new RegExp(`console\\.[a-z]+\\([^)]*\\$\\{[^}]*(${SECRET_IDENTS})`).test(H5_CODE));
ok('  no secret value is ever passed to a log as an argument',
  !new RegExp(`console\\.[a-z]+\\(\\s*(${SECRET_IDENTS})\\b`).test(H5_CODE));
ok('  no credential is hard-coded', !/EAA[A-Za-z0-9]{20,}|app_secret\s*=\s*['"][^'"]{8,}/.test(H5_CODE));
ok('  secrets come only from the environment', /process\.env\.WHATSAPP_APP_SECRET/.test(CTRL_CODE) && /process\.env\.WHATSAPP_WEBHOOK_VERIFY_TOKEN/.test(CTRL_CODE));
ok('  no Meta credential is written to Firestore', !/WHATSAPP_APP_SECRET|VERIFY_TOKEN/.test(codeOnly(REPO)));
ok('  the raw payload is never persisted, only a digest',
  /delivery_digest/.test(REPO) && !/payload:|body:|raw_body/.test(codeOnly(REPO)));

console.log('\n  -- timing-safe comparison, not the Razorpay pattern --');
ok('6. timingSafeEqual is used', /crypto\.timingSafeEqual\(/.test(codeOnly(SIG)));
ok('  both sides are hashed first so lengths always match', /createHash\('sha256'\)\.update\(a, 'utf8'\)/.test(codeOnly(SIG)));
ok('  no naive digest comparison anywhere in H5', !/digest !== |!== *razorpay|digest ===/.test(H5_CODE));
ok('  the verify token is compared the same safe way', /timingSafeCompare\(token, expected\)/.test(CTRL_CODE));

console.log('\n  -- fail closed --');
ok('7. the feature flag defaults to OFF', /ENABLE_WHATSAPP_WEBHOOK === 'true'/.test(FLAGS));
ok('  a disabled webhook answers 404', /function notFound\(res\)[\s\S]{0,120}status\(404\)/.test(CTRL_CODE));
ok('  both verbs check the flag first', (CTRL_CODE.match(/if \(!isWhatsAppWebhookEnabled\(\)\) return notFound\(res\)/g) || []).length === 2);
ok('  a missing app secret refuses the delivery', /if \(!appSecret\)[\s\S]{0,200}status\(403\)/.test(CTRL_CODE));
ok('  a missing verify token refuses the handshake', /if \(!expected\)[\s\S]{0,200}status\(403\)/.test(CTRL_CODE));
ok('  the signature helpers return false rather than throwing', !/throw /.test(codeOnly(SIG)));

console.log('\n  -- idempotency design --');
ok('8. the claim uses create(), which cannot overwrite an existing claim',
  /\.doc\(id\)\.create\(doc\)/.test(codeOnly(REPO)) && !/\.doc\(id\)\.set\(/.test(codeOnly(REPO)));
ok('  ALREADY_EXISTS is treated as a duplicate, not an error', /isAlreadyExists\(err\)\) return \{ claimed: false, duplicate: true/.test(codeOnly(REPO)));
ok('  a status receipt is keyed by id AND status, so read does not collide with delivered',
  /event_id: `status:\$\{status\.id\}:\$\{status\.status\}`/.test(CTRL_CODE));
ok('  a message is keyed by its own id', /event_id: `msg:\$\{message\.id\}`/.test(CTRL_CODE));
ok('  H5 never marks an event processed — that is H7\'s fact to write', !/markWebhookEventFirestore/.test(CTRL_CODE));

console.log('\n  -- firestore rules --');
ok('9. the new collection denies clients read and write',
  /match \/whatsapp_webhook_events\/\{eventId\} \{\s*\n\s*allow read, write: if false;/.test(RULES));
ok('  the existing approval rules are untouched',
  /match \/inventory_approval_actions\/\{actionId\} \{\s*\n\s*allow read, write: if false;/.test(RULES) &&
  /match \/inventory_approval_authorities\/\{authorityId\} \{\s*\n\s*allow read, write: if false;/.test(RULES));

// ── pure functional: signatures ──────────────────────────────────────────────
const { verifyWebhookSignature, computeSignatureHeader, timingSafeCompare, SIGNATURE_PREFIX } =
  await import('../utils/whatsappSignature.js');

console.log('\n  -- signature verification behaviour --');
const SECRET = 'h5_test_app_secret_value';
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }), 'utf8');
const goodSig = computeSignatureHeader(body, SECRET);
ok('10. a correct signature verifies', verifyWebhookSignature(body, goodSig, SECRET) === true);
ok('  a body altered by one byte fails', verifyWebhookSignature(Buffer.concat([body, Buffer.from(' ')]), goodSig, SECRET) === false);
ok('  a different secret fails', verifyWebhookSignature(body, goodSig, 'other_secret') === false);
ok('  a missing header fails', verifyWebhookSignature(body, undefined, SECRET) === false);
ok('  an empty header fails', verifyWebhookSignature(body, '', SECRET) === false);
ok('  a wrong algorithm prefix fails', verifyWebhookSignature(body, goodSig.replace(SIGNATURE_PREFIX, 'sha1='), SECRET) === false);
ok('  a truncated digest fails', verifyWebhookSignature(body, goodSig.slice(0, -2), SECRET) === false);
ok('  a non-hex digest fails', verifyWebhookSignature(body, `${SIGNATURE_PREFIX}${'z'.repeat(64)}`, SECRET) === false);
ok('  an uppercase digest fails (Meta sends lower-case)', verifyWebhookSignature(body, goodSig.toUpperCase(), SECRET) === false);
ok('  a parsed object instead of a Buffer fails', verifyWebhookSignature({ object: 'x' }, goodSig, SECRET) === false);
ok('  a string body fails', verifyWebhookSignature(body.toString('utf8'), goodSig, SECRET) === false);
ok('  a missing secret fails', verifyWebhookSignature(body, goodSig, '') === false);
ok('  the digest matches an independent HMAC computation',
  goodSig === `${SIGNATURE_PREFIX}${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`);
ok('  timingSafeCompare is correct for equal and unequal values',
  timingSafeCompare('abc', 'abc') === true && timingSafeCompare('abc', 'abd') === false &&
  timingSafeCompare('abc', 'abcd') === false && timingSafeCompare('abc', null) === false);

// ── pure functional: rate limiter ────────────────────────────────────────────
const { createWebhookRateLimiter, rateLimitSettingsFromEnv, DEFAULT_MAX_REQUESTS, DEFAULT_WINDOW_MS } =
  await import('../middleware/whatsappWebhookRateLimit.js');

console.log('\n  -- rate limiter behaviour --');
const fakeRes = () => {
  const r = { statusCode: null, headers: {}, payload: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.payload = p; return r; };
  return r;
};
const drive = (mw, n, ip = '10.0.0.1') => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const res = fakeRes();
    let nexted = false;
    mw({ ip, socket: {} }, res, () => { nexted = true; });
    out.push(nexted ? 200 : res.statusCode);
  }
  return out;
};
const limiter = createWebhookRateLimiter({ max: 3, windowMs: 50_000 });
const seq = drive(limiter, 5);
ok('11. the first `max` requests pass and the rest are refused',
  seq.join(',') === '200,200,200,429,429', seq.join(','));
const refused = fakeRes();
limiter({ ip: '10.0.0.1', socket: {} }, refused, () => {});
ok('  a refusal carries Retry-After', Number(refused.headers['retry-after']) > 0, String(refused.headers['retry-after']));
ok('  a refusal uses the RATE_LIMITED code', refused.payload?.code === 'RATE_LIMITED');
ok('  a different client has its own budget', drive(limiter, 1, '10.0.0.2')[0] === 200);
const shortWindow = createWebhookRateLimiter({ max: 1, windowMs: 1 });
drive(shortWindow, 1, '10.0.0.3');
await new Promise(r => setTimeout(r, 5));
ok('  the window resets once it elapses', drive(shortWindow, 1, '10.0.0.3')[0] === 200);
ok('  defaults are sane when the environment is empty',
  rateLimitSettingsFromEnv({}).max === DEFAULT_MAX_REQUESTS && rateLimitSettingsFromEnv({}).windowMs === DEFAULT_WINDOW_MS);
ok('  the environment overrides both settings',
  rateLimitSettingsFromEnv({ WHATSAPP_WEBHOOK_RATE_LIMIT_MAX: '7', WHATSAPP_WEBHOOK_RATE_LIMIT_WINDOW_MS: '900' }).max === 7);
ok('  a nonsense environment value falls back to the default',
  rateLimitSettingsFromEnv({ WHATSAPP_WEBHOOK_RATE_LIMIT_MAX: 'abc' }).max === DEFAULT_MAX_REQUESTS &&
  rateLimitSettingsFromEnv({ WHATSAPP_WEBHOOK_RATE_LIMIT_MAX: '-4' }).max === DEFAULT_MAX_REQUESTS);

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H5 WHATSAPP WEBHOOK: ${pass} passed, ${fail} failed (Part A only) ═══`);
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

// Synthetic secrets, set in-process only. No Meta credential is created.
const VERIFY_TOKEN = `h5_verify_${Date.now()}`;
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
process.env.ENABLE_WHATSAPP_WEBHOOK = 'false';
// Generous so the functional tests never trip it; the limiter is proven
// separately, both as a unit above and over HTTP below.
process.env.WHATSAPP_WEBHOOK_RATE_LIMIT_MAX = '500';

const express = (await import('express')).default;
const http = await import('http');
const whatsappRoutes = (await import('../routes/whatsappRoutes.js')).default;
const { receiveWebhook } = await import('../controllers/whatsappWebhookController.js');
const repo = await import('../repositories/firestore/whatsappWebhookEventsRepository.js');
const { readBudgetMonitor } = await import('../utils/firestoreReadBudget.js');

// A faithful miniature of server.js: webhook first, THEN express.json(), then
// an ordinary JSON route standing in for the existing API.
const app = express();
app.use('/api/whatsapp', whatsappRoutes);
app.use(express.json());
app.post('/api/echo', (req, res) => res.json({ got: req.body }));
const server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const post = (body, sig, url = `${BASE}/api/whatsapp/webhook`) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) },
  body
});
const signed = (raw) => computeSignatureHeader(Buffer.from(raw, 'utf8'), SECRET);

const created = [];
let writes = 0, deletes = 0;
const r0 = readBudgetMonitor.estimatedReadsToday;

try {
  console.log('  -- 12. the feature flag is a hard off switch --');
  let r = await fetch(`${BASE}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`);
  ok('12. the handshake is 404 while disabled', r.status === 404, `HTTP ${r.status}`);
  const disabledBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  r = await post(disabledBody, signed(disabledBody));
  ok('  a correctly signed delivery is 404 while disabled', r.status === 404, `HTTP ${r.status}`);

  process.env.ENABLE_WHATSAPP_WEBHOOK = 'true';

  console.log('\n  -- 13. the subscription handshake --');
  r = await fetch(`${BASE}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-42`);
  ok('13. a correct handshake returns the challenge verbatim', r.status === 200 && (await r.text()) === 'challenge-42');
  r = await fetch(`${BASE}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-42`);
  ok('  a wrong verify token is refused', r.status === 403, `HTTP ${r.status}`);
  r = await fetch(`${BASE}/api/whatsapp/webhook?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=c`);
  ok('  a wrong mode is refused', r.status === 403, `HTTP ${r.status}`);

  console.log('\n  -- 14. signature enforcement over real HTTP --');
  const empty = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  r = await post(empty, null);
  ok('14. an unsigned delivery is refused', r.status === 403, `HTTP ${r.status}`);
  r = await post(empty, `${SIGNATURE_PREFIX}${'a'.repeat(64)}`);
  ok('  a forged signature is refused', r.status === 403, `HTTP ${r.status}`);
  r = await post(empty, computeSignatureHeader(Buffer.from(empty, 'utf8'), 'wrong_secret'));
  ok('  a signature from the wrong secret is refused', r.status === 403, `HTTP ${r.status}`);
  r = await post(`${empty} `, signed(empty));
  ok('  a body tampered after signing is refused', r.status === 403, `HTTP ${r.status}`);
  r = await post(empty, signed(empty));
  ok('  a correctly signed delivery is accepted', r.status === 200, `HTTP ${r.status}`);

  console.log('\n  -- 15. RAW BYTES survive to the handler (the parser-order proof) --');
  // Awkward on purpose: key order and spacing that JSON.stringify would not
  // reproduce. If anything parsed and re-serialised this body, the HMAC over
  // the original bytes could not possibly match.
  const awkward = '{"object" :  "whatsapp_business_account",\n  "entry":[ ] ,  "zz":1,"aa":2}';
  r = await post(awkward, signed(awkward));
  ok('15. a body with unusual spacing and key order verifies byte-for-byte', r.status === 200, `HTTP ${r.status}`);
  ok('  which is only possible if express.json() never touched it', r.status === 200);

  console.log('\n  -- 16. existing JSON routes are unaffected --');
  r = await fetch(`${BASE}/api/echo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'world' })
  });
  const echoed = await r.json();
  ok('16. an ordinary JSON route still parses its body normally', r.status === 200 && echoed.got?.hello === 'world');

  console.log('\n  -- 17. malformed payloads --');
  const broken = '{"object":"whatsapp_business_account",';
  r = await post(broken, signed(broken));
  ok('17. a correctly signed but unparseable body is refused', r.status === 400, `HTTP ${r.status}`);
  const notObject = '"just a string"';
  r = await post(notObject, signed(notObject));
  ok('  a signed non-object payload is accepted and yields no events', r.status === 200 && (await r.json()).received === 0);
  const weird = JSON.stringify({ object: 'x', entry: [{ changes: [{ value: { messages: [{ no_id: 1 }], statuses: 'nope' } }] }] });
  r = await post(weird, signed(weird));
  ok('  a structurally odd payload extracts nothing and does not throw', r.status === 200 && (await r.json()).received === 0);

  console.log('\n  -- 18. duplicate delivery is claimed exactly once --');
  const wamid = `wamid.H5TEST${Date.now()}`;
  const delivery = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'h5-entry', changes: [{ field: 'messages', value: { messages: [{ id: wamid, type: 'text' }] } }] }]
  });
  created.push(`msg:${wamid}`);
  r = await post(delivery, signed(delivery));
  let json = await r.json();
  writes++;
  ok('18. the first delivery claims the event', r.status === 200 && json.claimed === 1 && json.duplicates === 0, JSON.stringify(json));
  r = await post(delivery, signed(delivery));
  json = await r.json();
  ok('  an identical re-delivery claims nothing and reports a duplicate', r.status === 200 && json.claimed === 0 && json.duplicates === 1, JSON.stringify(json));
  r = await post(delivery, signed(delivery));
  json = await r.json();
  ok('  a third re-delivery is still a duplicate', json.claimed === 0 && json.duplicates === 1);
  const stored = await repo.getWebhookEventFirestore(`msg:${wamid}`);
  ok('  the stored claim records the message id and when it was claimed', typeof stored?.claimed_at === 'string' && stored?.meta_message_id === wamid);
  ok('  it stores a delivery digest, not the payload',
    typeof stored?.delivery_digest === 'string' && stored.delivery_digest.length === 64 &&
    !JSON.stringify(stored).includes('whatsapp_business_account'));
  // H6: the dispatcher now marks every claimed event. This one has no sender,
  // so it was ignored — PROCESSED with no downstream effect and no error.
  ok('  the dispatcher marked it PROCESSED with no downstream effect (no sender → ignored)',
    stored?.status === 'PROCESSED' && typeof stored?.processed_at === 'string' && stored?.error_code === null);

  console.log('\n  -- 19. a status receipt does not collide with the message --');
  const statusDelivery = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'h5-entry', changes: [{ field: 'messages', value: { statuses: [
      { id: wamid, status: 'delivered' }, { id: wamid, status: 'read' }
    ] } }] }]
  });
  created.push(`status:${wamid}:delivered`, `status:${wamid}:read`);
  r = await post(statusDelivery, signed(statusDelivery));
  json = await r.json();
  writes += 2;
  ok('19. delivered and read are claimed separately, despite sharing a message id',
    json.received === 2 && json.claimed === 2 && json.duplicates === 0, JSON.stringify(json));
  r = await post(statusDelivery, signed(statusDelivery));
  json = await r.json();
  ok('  and both are duplicates on re-delivery', json.claimed === 0 && json.duplicates === 2);

  console.log('\n  -- 20. the claim primitive, directly --');
  const soloId = `msg:h5_solo_${Date.now()}`;
  created.push(soloId);
  const c1 = await repo.claimWebhookEventFirestore(soloId, { event_type: 'message', meta_message_id: 'solo' });
  writes++;
  ok('20. a first claim succeeds', c1.claimed === true && c1.duplicate === false);
  const c2 = await repo.claimWebhookEventFirestore(soloId, { event_type: 'message', meta_message_id: 'solo' });
  ok('  a second claim is refused as a duplicate, not an error', c2.claimed === false && c2.duplicate === true);
  const race = await Promise.all([
    repo.claimWebhookEventFirestore(`${soloId}_race`, {}),
    repo.claimWebhookEventFirestore(`${soloId}_race`, {}),
    repo.claimWebhookEventFirestore(`${soloId}_race`, {})
  ]);
  created.push(`${soloId}_race`); writes++;
  ok('  three concurrent claims yield exactly one winner',
    race.filter(x => x.claimed).length === 1 && race.filter(x => x.duplicate).length === 2);
  ok('  an empty event id is refused', await repo.claimWebhookEventFirestore('  ', {}).then(() => false).catch(e => e.code === 'VALIDATION_ERROR'));
  ok('  an id containing a slash is refused', await repo.claimWebhookEventFirestore('a/b', {}).then(() => false).catch(e => e.code === 'VALIDATION_ERROR'));

  console.log('\n  -- 21. crash safety: claimed but unprocessed stays unprocessable --');
  // Simulates a crash after the claim: the row exists as CLAIMED, nothing was
  // processed. A re-delivery must NOT be handed to downstream work again.
  const crashId = `msg:h5_crash_${Date.now()}`;
  created.push(crashId);
  await repo.claimWebhookEventFirestore(crashId, { event_type: 'message' }); writes++;
  const afterCrash = await repo.claimWebhookEventFirestore(crashId, { event_type: 'message' });
  ok('21. a re-delivery after a mid-processing crash is refused', afterCrash.duplicate === true);
  const crashRow = await repo.getWebhookEventFirestore(crashId);
  ok('  the row stays CLAIMED, so a stuck event is visible to an operator', crashRow?.status === 'CLAIMED');
  ok('  the failure direction is "not processed", never "processed twice"', crashRow?.processed_at === null);
  await repo.markWebhookEventFirestore(crashId, { status: 'PROCESSED' }); writes++;
  const done = await repo.getWebhookEventFirestore(crashId);
  ok('  H7 can later mark it processed', done?.status === 'PROCESSED' && typeof done?.processed_at === 'string');
  ok('  an unknown status is refused', await repo.markWebhookEventFirestore(crashId, { status: 'NONSENSE' }).then(() => false).catch(e => e.code === 'VALIDATION_ERROR'));

  console.log('\n  -- 22. rate limiting over real HTTP --');
  // A separate app wired with the REAL limiter and the REAL handler, at test
  // limits, so the production router keeps its generous configured budget.
  const rlApp = express();
  const rlLimiter = createWebhookRateLimiter({ max: 3, windowMs: 60_000 });
  rlApp.post('/api/whatsapp/webhook', rlLimiter, express.raw({ type: () => true }), receiveWebhook);
  const rlServer = http.createServer(rlApp);
  await new Promise(res => rlServer.listen(0, '127.0.0.1', res));
  const RL = `http://127.0.0.1:${rlServer.address().port}/api/whatsapp/webhook`;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await post(empty, null, RL)).status);
  await new Promise(res => rlServer.close(res));
  ok('22. the limiter refuses once the budget is spent', codes.join(',') === '403,403,403,429,429', codes.join(','));
  ok('  and it runs before the handler, so refusals cost no Firestore work', codes[3] === 429);
} finally {
  await new Promise(r => server.close(r));
  console.log('\n  -- cleanup: only this run\'s synthetic event rows --');
  for (const id of created) {
    await db.collection('whatsapp_webhook_events').doc(id).delete();
    deletes++;
  }
  console.log(`  deleted ${deletes} webhook event document(s)`);
}

const reads = readBudgetMonitor.estimatedReadsToday - r0;
console.log(`\n═══ H5 WHATSAPP WEBHOOK: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
console.log(`\n[DEV READS ~${reads}]  [DEV WRITES ~${writes}]  [DEV DELETES ${deletes}]`);
console.log('[PRODUCTION ACCESS] 0  [META CREDENTIALS CREATED] 0  [WHATSAPP CALLS] 0');
process.exit(fail === 0 ? 0 : 1);
