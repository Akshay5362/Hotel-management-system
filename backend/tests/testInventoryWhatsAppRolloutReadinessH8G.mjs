/**
 * backend/tests/testInventoryWhatsAppRolloutReadinessH8G.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-G — the final code-level rollout readiness gate.
 *
 * NO DATABASE, NO NETWORK, BY CONSTRUCTION
 * Readiness is configuration and pure logic, so this suite imports nothing that
 * reaches firebaseAdmin and opens no database. A counter proves global fetch is
 * never called, and every send runs through an injected recorder.
 *
 * Every credential-shaped value is an obvious fake whose only job is to be
 * searched for afterwards in readiness output and logs.
 *
 * Run:  node backend/tests/testInventoryWhatsAppRolloutReadinessH8G.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (l, c, d = '') => {
  if (c) { pass++; console.log(`  [PASS] ${l}${d ? '  ' + d : ''}`); }
  else { fail++; failures.push(l); console.log(`  [FAIL] ${l}${d ? '  ' + d : ''}`); }
};
const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g');
const src = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(CRLF, '\n');
const codeOnly = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const READY = codeOnly(src('backend', 'services', 'whatsappRolloutReadiness.js'));
const CLIENT = codeOnly(src('backend', 'services', 'whatsappOutboundClient.js'));

const FAKE_TOKEN = 'h8g_FAKE_ACCESS_TOKEN_NOT_A_CREDENTIAL';
const FAKE_APP_SECRET = 'h8g_FAKE_APP_SECRET_NOT_A_CREDENTIAL';
const FAKE_VERIFY_TOKEN = 'h8g_FAKE_VERIFY_TOKEN_NOT_A_CREDENTIAL';
const FAKE_VERIFICATION_SECRET = 'h8g_FAKE_VERIFICATION_SECRET_NOT_A_CREDENTIAL';
const FULL_NUMBER = '919876500022';

const KEYS = [
  'ENABLE_WHATSAPP_WEBHOOK', 'ENABLE_WHATSAPP_VERIFICATION', 'ENABLE_WHATSAPP_DECISIONS',
  'ENABLE_WHATSAPP_OUTBOUND', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_GRAPH_API_VERSION', 'WHATSAPP_GRAPH_BASE_URL', 'WHATSAPP_TEMPLATE_PR_REVIEW',
  'WHATSAPP_TEMPLATE_LANGUAGE', 'WHATSAPP_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_VERIFICATION_SECRET', 'HPMS_ENV'
];
const ORIGINAL = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
const restoreEnv = () => KEYS.forEach(k => {
  if (ORIGINAL[k] === undefined) delete process.env[k]; else process.env[k] = ORIGINAL[k];
});
const clearEnv = () => KEYS.forEach(k => delete process.env[k]);

/** Everything a real deployment needs, entirely synthetic. */
const fullConfig = () => {
  process.env.WHATSAPP_ACCESS_TOKEN = FAKE_TOKEN;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '100000000000002';
  process.env.WHATSAPP_GRAPH_API_VERSION = 'v23.0';
  process.env.WHATSAPP_GRAPH_BASE_URL = 'https://graph.facebook.com';
  process.env.WHATSAPP_TEMPLATE_PR_REVIEW = 'purchase_request_review';
  process.env.WHATSAPP_TEMPLATE_LANGUAGE = 'en';
  process.env.WHATSAPP_APP_SECRET = FAKE_APP_SECRET;
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = FAKE_VERIFY_TOKEN;
  process.env.WHATSAPP_VERIFICATION_SECRET = FAKE_VERIFICATION_SECRET;
};
const setStage = (webhook, verification, outbound, decisions) => {
  for (const [k, v] of [['ENABLE_WHATSAPP_WEBHOOK', webhook], ['ENABLE_WHATSAPP_VERIFICATION', verification],
    ['ENABLE_WHATSAPP_OUTBOUND', outbound], ['ENABLE_WHATSAPP_DECISIONS', decisions]]) {
    if (v) process.env[k] = 'true'; else delete process.env[k];
  }
};

const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { logged.push(a.map(String).join(' ')); orig(...a); };
}
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { fetchCalls++; return realFetch ? realFetch(...a) : undefined; };

const R = await import('../services/whatsappRolloutReadiness.js');
const t = await import('../services/whatsappOutboundClient.js');

const recorder = (script = () => ({ ok: true, status: 200, json: { messages: [{ id: 'wamid.h8g.DET' }] } })) => {
  const sent = [];
  return { sent, fn: async (b) => { sent.push(b); return await script(b); } };
};

console.log('═══ H8-G — ROLLOUT READINESS (no database, no network) ═══');

// ── 1 all flags off ─────────────────────────────────────────────────────────
console.log('\n  -- stage 0: completely inert --');
{
  clearEnv();
  const r = R.getWhatsAppRolloutReadiness();
  ok('G1. all flags off reports stage INERT and not ready',
    r.stage === R.ROLLOUT_STAGE.INERT && r.stage_name === 'INERT' && r.code_ready === false && r.production_ready === false);
  ok('  and it is a SAFE combination, not an unsafe one', r.safe_flag_combination === true);
  ok('  every capability reports the flag as the blocker',
    Object.values(r.capabilities).every(c => c.enabled === false && c.ready === false));
}

// ── the designed stages ─────────────────────────────────────────────────────
console.log('\n  -- the designed progression --');
{
  clearEnv(); fullConfig();
  const stages = [
    ['Stage 1 WEBHOOK_ONLY', [true, false, false, false], R.ROLLOUT_STAGE.WEBHOOK_ONLY],
    ['Stage 2 VERIFICATION', [true, true, false, false], R.ROLLOUT_STAGE.VERIFICATION],
    ['Stage 3 OUTBOUND', [true, true, true, false], R.ROLLOUT_STAGE.OUTBOUND],
    ['Stage 4 FULL', [true, true, true, true], R.ROLLOUT_STAGE.FULL]
  ];
  for (const [label, flags, expected] of stages) {
    setStage(...flags);
    const r = R.getWhatsAppRolloutReadiness();
    ok(`  ${label} is recognised and safe`, r.stage === expected && r.safe_flag_combination === true, r.stage_name);
  }
  setStage(true, true, true, true);
  ok('G13/G14. even at Stage 4 with full configuration, production_ready is FALSE',
    R.getWhatsAppRolloutReadiness().production_ready === false);
  ok('  because external prerequisites remain pending',
    R.getWhatsAppRolloutReadiness().blocked_reasons.includes(R.BLOCKED_REASON.EXTERNAL_PREREQUISITE_PENDING));
}

// ── unsafe combinations ─────────────────────────────────────────────────────
console.log('\n  -- an out-of-order combination is reported unsafe --');
{
  clearEnv(); fullConfig();
  const unsafe = [
    ['decisions before the webhook', [false, false, false, true]],
    ['outbound before the webhook', [false, false, true, false]],
    ['verification before the webhook', [false, true, false, false]],
    ['decisions before outbound', [true, true, false, true]],
    ['outbound before verification', [true, false, true, false]]
  ];
  for (const [label, flags] of unsafe) {
    setStage(...flags);
    const r = R.getWhatsAppRolloutReadiness();
    ok(`  ${label} is unsafe and not ready`,
      r.safe_flag_combination === false && r.code_ready === false && r.production_ready === false);
  }
}

// ── 6..8 missing configuration fails closed ─────────────────────────────────
console.log('\n  -- missing configuration fails closed --');
{
  clearEnv(); fullConfig(); setStage(true, true, true, true);
  for (const [label, key, capability] of [
    ['G6. outbound without an access token', 'WHATSAPP_ACCESS_TOKEN', 'outbound'],
    ['G7. webhook without an app secret', 'WHATSAPP_APP_SECRET', 'webhook'],
    ['  webhook without a verify token', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'webhook'],
    ['  verification without its secret', 'WHATSAPP_VERIFICATION_SECRET', 'verification'],
    ['G12. outbound without a template', 'WHATSAPP_TEMPLATE_PR_REVIEW', 'outbound']
  ]) {
    clearEnv(); fullConfig(); setStage(true, true, true, true);
    delete process.env[key];
    const r = R.getWhatsAppRolloutReadiness();
    const cap = r.capabilities[capability];
    ok(`${label} is not ready`, cap.ready === false && r.code_ready === false);
    ok(`  and names ${key} without its value`,
      cap.missing.includes(key) && !JSON.stringify(r).includes(FAKE_TOKEN));
    // `configured` is reported separately from `ready`, so it needs its own
    // assertion: a capability missing a key must report BOTH as false.
    ok(`  and reports the capability as not configured, not merely not ready`,
      cap.configured === false);
  }
}

// Outbound readiness is a conjunction, and each part needs pinning on its own.
console.log('\n  -- outbound readiness is configured AND enabled --');
{
  clearEnv(); fullConfig(); setStage(true, true, true, true);
  delete process.env.WHATSAPP_TEMPLATE_PR_REVIEW;
  const cap = R.getWhatsAppRolloutReadiness().capabilities.outbound;
  ok('G12b. a missing template makes outbound not configured',
    cap.configured === false && cap.ready === false && cap.missing.includes('WHATSAPP_TEMPLATE_PR_REVIEW'));

  clearEnv(); fullConfig(); setStage(true, true, false, false);
  const off = R.getWhatsAppRolloutReadiness().capabilities.outbound;
  ok('  a complete configuration with the flag off is configured but NOT ready',
    off.configured === true && off.ready === false &&
    off.blocked_reasons.includes(R.BLOCKED_REASON.FLAG_DISABLED));

  // Decisions require outbound, so outbound can never be the only failure.
  // This pins the dependency that makes that true.
  clearEnv(); fullConfig(); setStage(true, true, false, false);
  const r = R.getWhatsAppRolloutReadiness();
  ok('  decisions are never ready while outbound is not',
    r.capabilities.outbound.ready === false && r.capabilities.decisions.ready === false);
  ok('  and overall code readiness is false whenever outbound is not ready',
    r.code_ready === false);
}

// ── 8 decisions depend on prerequisites ─────────────────────────────────────
console.log('\n  -- decisions need their prerequisites --');
{
  clearEnv(); fullConfig(); setStage(true, true, true, true);
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  const r = R.getWhatsAppRolloutReadiness();
  ok('G8. decisions are not ready while outbound is not ready',
    r.capabilities.decisions.ready === false &&
    r.capabilities.decisions.blocked_reasons.includes(R.BLOCKED_REASON.PREREQUISITE_NOT_READY));

  clearEnv(); fullConfig(); setStage(true, true, true, true);
  delete process.env.WHATSAPP_APP_SECRET;
  const r2 = R.getWhatsAppRolloutReadiness();
  ok('  verification is not ready while the webhook is not ready',
    r2.capabilities.verification.ready === false &&
    r2.capabilities.verification.blocked_reasons.includes(R.BLOCKED_REASON.PREREQUISITE_NOT_READY));
}

// ── 9..12 structural validity ───────────────────────────────────────────────
console.log('\n  -- structural validation with synthetic values --');
{
  clearEnv(); fullConfig(); setStage(true, true, true, true);
  const r = R.getWhatsAppRolloutReadiness();
  ok('G9. a complete synthetic configuration is structurally code-ready',
    r.code_ready === true && Object.values(r.capabilities).every(c => c.ready === true));
  ok('  and it made no network call', fetchCalls === 0);

  process.env.WHATSAPP_GRAPH_BASE_URL = 'https://evil.example.com';
  ok('G10. an unlisted Graph host breaks outbound readiness',
    R.getWhatsAppRolloutReadiness().capabilities.outbound.ready === false);
  process.env.WHATSAPP_GRAPH_BASE_URL = 'http://graph.facebook.com';
  ok('G11. plain HTTP breaks outbound readiness too',
    R.getWhatsAppRolloutReadiness().capabilities.outbound.ready === false);
  process.env.WHATSAPP_GRAPH_BASE_URL = 'https://graph.facebook.com';
  ok('  and the documented host restores it',
    R.getWhatsAppRolloutReadiness().capabilities.outbound.ready === true);
}

// ── 13/14 external prerequisites stay pending ───────────────────────────────
console.log('\n  -- external prerequisites are named, never claimed --');
{
  clearEnv(); fullConfig(); setStage(true, true, true, true);
  const r = R.getWhatsAppRolloutReadiness();
  const keys = r.external_prerequisites.map(p => p.key).sort();
  ok('G13/G14. all three external prerequisites are listed',
    keys.join(',') === 'META_CREDENTIAL_PROVISIONING,META_TEMPLATE_APPROVAL,PUBLIC_WEBHOOK_INGRESS');
  ok('  every one is PENDING, none is ever satisfied by code',
    r.external_prerequisites.every(p => p.status === 'PENDING'));
  ok('  template approval is never reported complete',
    !/approved\s*[:=]\s*true|template_approved|meta_approved/i.test(READY));
  ok('  public ingress is described as external, and no ingress is configured here',
    /PUBLIC_WEBHOOK_INGRESS/.test(READY) &&
    !/nginx|cloudflare|ngrok|tunnel|listen\(|createServer|firewall/i.test(READY));
  ok('  no environment variable can mark an external prerequisite satisfied',
    !/process\.env\.[A-Z_]*(APPROVED|INGRESS|READY|ROLLOUT)[A-Z_]*/.test(READY));
}

// ── 15..17 nothing secret escapes ───────────────────────────────────────────
console.log('\n  -- readiness output carries no secret --');
{
  clearEnv(); fullConfig(); setStage(true, true, true, true);
  const serialized = JSON.stringify(R.getWhatsAppRolloutReadiness());
  ok('G15. no access token, app secret, verify token or verification secret appears',
    ![FAKE_TOKEN, FAKE_APP_SECRET, FAKE_VERIFY_TOKEN, FAKE_VERIFICATION_SECRET].some(v => serialized.includes(v)));
  ok('G16. no phone number appears, full or partial',
    !serialized.includes('100000000000002') && !serialized.includes(FULL_NUMBER));
  ok('G17. only key NAMES and reason CODES are exposed',
    (() => {
      clearEnv(); setStage(true, true, true, true);
      const r = R.getWhatsAppRolloutReadiness();
      const names = Object.values(r.capabilities).flatMap(c => c.missing);
      return names.length > 0 && names.every(n => /^WHATSAPP_[A-Z_]+$/.test(n));
    })());
  ok('  the module reads configuration only to test presence',
    /Boolean\(String\(process\.env\[name\] \?\? ''\)\.trim\(\)\)/.test(READY));
  ok('  and it never logs anything at all',
    !/console\./.test(READY));
  const all = logged.join('\n');
  ok('  no fake credential reached any captured log line',
    ![FAKE_TOKEN, FAKE_APP_SECRET, FAKE_VERIFY_TOKEN, FAKE_VERIFICATION_SECRET].some(v => all.includes(v)));
}

// ── 2/3/20/21/22 kill switches ──────────────────────────────────────────────
console.log('\n  -- the kill switches --');
{
  clearEnv(); fullConfig(); setStage(true, true, false, true);
  const r1 = recorder();
  const c1 = t.createWhatsAppReplyClient({ transport: r1.fn, templateName: 'purchase_request_review', templateLanguage: 'en' });
  const tpl = await c1.sendTemplateMessage({ to: FULL_NUMBER, parameters: ['x'] });
  ok('G2. outbound off blocks a business-initiated notification',
    tpl.reason === t.SEND_REASON.OUTBOUND_DISABLED && r1.sent.length === 0);
  ok('G22. and decisions being on does not bypass it',
    R.getWhatsAppRolloutReadiness().capabilities.decisions.ready === false);

  clearEnv(); fullConfig(); setStage(true, true, true, false);
  ok('G3. decisions off leaves decisions not ready while outbound stays ready',
    R.getWhatsAppRolloutReadiness().capabilities.decisions.ready === false &&
    R.getWhatsAppRolloutReadiness().capabilities.outbound.ready === true);

  clearEnv(); fullConfig(); setStage(false, false, false, false);
  const r2 = R.getWhatsAppRolloutReadiness();
  ok('G4. webhook off leaves inbound unavailable', r2.capabilities.webhook.ready === false);
  ok('G5. verification off leaves verification unavailable', r2.capabilities.verification.ready === false);
}

// ── 18/19 the fake transport stays development-only ─────────────────────────
console.log('\n  -- the recording transport cannot reach production --');
{
  clearEnv();
  const r = recorder();
  const c = t.createWhatsAppReplyClient({ transport: r.fn });
  delete process.env.HPMS_ENV;
  let refusedUnset = false;
  try { t.setWhatsAppReplyClient(c); } catch { refusedUnset = true; }
  process.env.HPMS_ENV = 'production';
  let refusedProd = false;
  try { t.setWhatsAppReplyClient(c); } catch { refusedProd = true; }
  ok('G19. the seam refuses when HPMS_ENV is unset or production', refusedUnset && refusedProd);
  process.env.HPMS_ENV = 'development';
  const previous = t.setWhatsAppReplyClient(c);
  ok('G18. and works in a declared development process', t.whatsappReplyClient === c);
  t.setWhatsAppReplyClient(previous);
  ok('  restoring cleanly afterwards', t.whatsappReplyClient !== c);
  ok('  no environment variable can select a recorder',
    !/process\.env\.[A-Z_]*(MOCK|FAKE|STUB|RECORD|SIMULAT)[A-Z_]*/i.test(CLIENT));
}

// ── 20/21 the readiness layer cannot touch the request workflow ─────────────
console.log('\n  -- readiness is inert with respect to purchase requests --');
{
  ok('G20/G21. the module reaches no database, service or controller',
    !/firestore|firebaseAdmin|repositories\/|controllers\/|purchaseRequest/i.test(READY));
  ok('  it mints, consumes and decides nothing',
    !/createApprovalActionFirestore|decideWithApprovalActionToken|beginTokenRejection|completeTokenRejection|consumeApprovalAction/.test(READY));
  ok('  it sends nothing and opens no connection',
    !/fetch\(|sendTemplateMessage|sendInteractiveButtonsMessage|sendText/.test(READY));
  ok('  it imports only the flags and the H8-F status helper',
    /from '\.\.\/config\/featureFlags\.js'/.test(READY) &&
    /from '\.\/whatsappOutboundClient\.js'/.test(READY) &&
    (READY.match(/^import /gm) || []).length === 2);
}

// ── 23/24 earlier phases remain intact ──────────────────────────────────────
console.log('\n  -- H8-E and H8-F behaviour is unchanged --');
{
  clearEnv(); fullConfig(); setStage(true, true, true, true);
  const s = t.getWhatsAppOutboundStatus();
  ok('G24. the H8-F status helper still reports ready on a complete configuration',
    s.ready === true && s.missing.length === 0);
  ok('  and readiness composes it rather than restating its keys',
    /getWhatsAppOutboundStatus\(\)/.test(READY) && !/WHATSAPP_ACCESS_TOKEN/.test(READY));
  const repo = codeOnly(src('backend', 'repositories', 'firestore', 'whatsappMessagesRepository.js'));
  ok('G23. the H8-E delivery lifecycle is untouched',
    /SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4/.test(repo) && /nextRank <= currentRank/.test(repo));
}

restoreEnv();
globalThis.fetch = realFetch;
ok('FINAL. not one global fetch call was made by this suite', fetchCalls === 0, `fetch=${fetchCalls}`);

console.log(`\n═══ H8-G ROLLOUT READINESS: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
