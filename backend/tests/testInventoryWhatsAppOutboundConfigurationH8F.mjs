/**
 * backend/tests/testInventoryWhatsAppOutboundConfigurationH8F.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-F — outbound configuration and readiness hardening.
 *
 * NO DATABASE, NO NETWORK, BY CONSTRUCTION
 * Configuration is environment and pure logic, so this suite imports nothing
 * that reaches firebaseAdmin and opens no database. A counter proves global
 * fetch is never called, and every send runs through an injected recorder.
 *
 * All credential-shaped values here are obvious fakes whose only job is to be
 * searched for afterwards in logs and returned objects.
 *
 * Run:  node backend/tests/testInventoryWhatsAppOutboundConfigurationH8F.mjs
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
const CLIENT = codeOnly(src('backend', 'services', 'whatsappOutboundClient.js'));
const FLAGS = src('backend', 'config', 'featureFlags.js');

const FAKE_TOKEN = 'h8f_FAKE_ACCESS_TOKEN_NOT_A_CREDENTIAL';
const FAKE_APP_SECRET = 'h8f_FAKE_APP_SECRET_NOT_A_CREDENTIAL';
const FAKE_VERIFY_TOKEN = 'h8f_FAKE_VERIFY_TOKEN_NOT_A_CREDENTIAL';
const FULL_NUMBER = '919876500011';

const ENV_KEYS = [
  'ENABLE_WHATSAPP_OUTBOUND', 'ENABLE_WHATSAPP_DECISIONS', 'ENABLE_WHATSAPP_WEBHOOK',
  'ENABLE_WHATSAPP_VERIFICATION', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_GRAPH_API_VERSION', 'WHATSAPP_GRAPH_BASE_URL', 'WHATSAPP_TEMPLATE_PR_REVIEW',
  'WHATSAPP_TEMPLATE_LANGUAGE', 'HPMS_ENV'
];
const ORIGINAL = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const restoreEnv = () => ENV_KEYS.forEach(k => {
  if (ORIGINAL[k] === undefined) delete process.env[k]; else process.env[k] = ORIGINAL[k];
});
const clearEnv = () => ENV_KEYS.forEach(k => delete process.env[k]);
/** A complete, entirely synthetic configuration. No value is real. */
const fullConfig = () => {
  process.env.WHATSAPP_ACCESS_TOKEN = FAKE_TOKEN;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '100000000000001';
  process.env.WHATSAPP_GRAPH_API_VERSION = 'v23.0';
  process.env.WHATSAPP_GRAPH_BASE_URL = 'https://graph.facebook.com';
  process.env.WHATSAPP_TEMPLATE_PR_REVIEW = 'purchase_request_review';
  process.env.WHATSAPP_TEMPLATE_LANGUAGE = 'en';
};

process.env.WHATSAPP_APP_SECRET = FAKE_APP_SECRET;
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = FAKE_VERIFY_TOKEN;

const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { logged.push(a.map(String).join(' ')); orig(...a); };
}
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { fetchCalls++; return realFetch ? realFetch(...a) : undefined; };

const t = await import('../services/whatsappOutboundClient.js');
const flags = await import('../config/featureFlags.js');

function recorder(script = () => ({ ok: true, status: 200, json: { messages: [{ id: 'wamid.h8f.DETERMINISTIC' }] } })) {
  const sent = [];
  return { sent, fn: async (b) => { sent.push(b); return await script(b); } };
}

console.log('═══ H8-F — OUTBOUND CONFIGURATION (no database, no network) ═══');

// ── 1..5 flag parsing ───────────────────────────────────────────────────────
console.log('\n  -- only the exact string enables a flag --');
clearEnv();
ok('F1. an absent outbound flag is disabled', flags.isWhatsAppOutboundEnabled() === false);
for (const [label, value] of [['F2. "false"', 'false'], ['F4. "TRUE"', 'TRUE'], ['F5. "1"', '1'],
  ['  "True"', 'True'], ['  "yes"', 'yes'], ['  " true"', ' true'], ['  empty', '']]) {
  process.env.ENABLE_WHATSAPP_OUTBOUND = value;
  ok(`${label} does not enable outbound`, flags.isWhatsAppOutboundEnabled() === false);
}
process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';
ok('F3. "true" enables outbound', flags.isWhatsAppOutboundEnabled() === true);
ok('  the same rule holds for all four WhatsApp flags',
  ['ENABLE_WHATSAPP_WEBHOOK', 'ENABLE_WHATSAPP_VERIFICATION', 'ENABLE_WHATSAPP_DECISIONS', 'ENABLE_WHATSAPP_OUTBOUND']
    .every(k => new RegExp(`${k} === 'true'`).test(FLAGS) && !new RegExp(`${k}\\s*\\|\\|`).test(FLAGS)));
clearEnv();
ok('  decisions also default OFF', flags.isWhatsAppDecisionsEnabled() === false);

// ── the inert combination ───────────────────────────────────────────────────
console.log('\n  -- outbound OFF and decisions OFF is completely inert --');
{
  clearEnv();
  fullConfig();
  const r = recorder();
  const c = t.createWhatsAppReplyClient({ transport: r.fn, templateName: 'purchase_request_review', templateLanguage: 'en' });
  const tpl = await c.sendTemplateMessage({ to: FULL_NUMBER, parameters: ['x'] });
  const btn = await c.sendInteractiveButtonsMessage({ to: FULL_NUMBER, bodyText: 'x', buttons: [{ id: 'a', title: 'A' }] });
  ok('F20. with outbound off, both business-initiated sends are refused',
    tpl.reason === t.SEND_REASON.OUTBOUND_DISABLED && btn.reason === t.SEND_REASON.OUTBOUND_DISABLED);
  ok('  and the transport was never reached', r.sent.length === 0);
  ok('  no network call was made', fetchCalls === 0);
  ok('  the status helper reports not ready',
    t.getWhatsAppOutboundStatus().outbound_enabled === false && t.getWhatsAppOutboundStatus().ready === false);
}

// ── 6..11 configuration completeness ────────────────────────────────────────
console.log('\n  -- incomplete configuration fails closed --');
const REQUIRED = [
  ['F6. access token', 'WHATSAPP_ACCESS_TOKEN'],
  ['F7. phone number id', 'WHATSAPP_PHONE_NUMBER_ID'],
  ['F8. Graph API version', 'WHATSAPP_GRAPH_API_VERSION'],
  ['F9. template name', 'WHATSAPP_TEMPLATE_PR_REVIEW'],
  ['  template language', 'WHATSAPP_TEMPLATE_LANGUAGE']
];
for (const [label, key] of REQUIRED) {
  clearEnv();
  fullConfig();
  process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';
  delete process.env[key];
  const status = t.getWhatsAppOutboundStatus();
  ok(`${label} missing reports not ready`, status.ready === false, status.missing.join(','));
  ok(`  and names the missing key, never a value`,
    status.missing.includes(key) && !JSON.stringify(status).includes(FAKE_TOKEN));
}
{
  clearEnv();
  fullConfig();
  process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';
  process.env.WHATSAPP_GRAPH_BASE_URL = 'https://evil.example.com';
  const status = t.getWhatsAppOutboundStatus();
  ok('F10. an unsafe Graph host reports not ready and is named',
    status.ready === false && status.graph_configured === false && status.missing.includes('WHATSAPP_GRAPH_BASE_URL'));
}
{
  clearEnv();
  fullConfig();
  process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';
  const status = t.getWhatsAppOutboundStatus();
  ok('F11. a complete synthetic configuration validates structurally',
    status.ready === true && status.graph_configured && status.credentials_configured && status.template_configured);
  ok('  and it did so without any network call', fetchCalls === 0);
  ok('  the status object exposes booleans and key names only',
    Object.keys(status).sort().join(',') ===
    'credentials_configured,graph_configured,missing,outbound_enabled,ready,template_configured');
}

// ── 21 enabled but not credentialed still refuses to send ───────────────────
console.log('\n  -- enabled but missing credentials --');
{
  clearEnv();
  process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';
  const bare = t.createWhatsAppReplyClient({ apiVersion: '', phoneNumberId: '', accessToken: '' });
  const tpl = await bare.sendTemplateMessage({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en' });
  ok('F21. outbound ON with no credentials fails closed, and never throws',
    bare.credentialed === false && tpl.sent === false && tpl.reason === t.SEND_REASON.NOT_CONFIGURED);
  ok('  no network call resulted', fetchCalls === 0);
  const noTemplate = t.createWhatsAppReplyClient({
    transport: recorder().fn, templateName: '', templateLanguage: ''
  });
  ok('  a client with no template configuration refuses before sending',
    (await noTemplate.sendTemplateMessage({ to: FULL_NUMBER })).reason === t.SEND_REASON.INVALID_INPUT);
}

// ── 12..15 nothing secret escapes ───────────────────────────────────────────
console.log('\n  -- no secret in any error or log --');
{
  clearEnv();
  fullConfig();
  process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';
  const c = t.createWhatsAppReplyClient({
    transport: recorder(async () => ({ ok: false, status: 401, json: { error: { code: 190, message: 'Invalid OAuth access token' } } })).fn,
    accessToken: FAKE_TOKEN, templateName: 'purchase_request_review', templateLanguage: 'en'
  });
  const err = await c.sendTemplateMessage({ to: FULL_NUMBER, parameters: ['x'] });
  const serialized = JSON.stringify(err) + JSON.stringify(t.getWhatsAppOutboundStatus());
  ok('F12. the access token never appears in a returned error or status', !serialized.includes(FAKE_TOKEN));
  ok('F13. nor does the app secret', !serialized.includes(FAKE_APP_SECRET));
  ok('  nor the webhook verify token', !serialized.includes(FAKE_VERIFY_TOKEN));
  ok('F15. nor the full recipient number', !serialized.includes(FULL_NUMBER));

  const all = logged.join('\n');
  ok('  none of them appears in any captured log line',
    !all.includes(FAKE_TOKEN) && !all.includes(FAKE_APP_SECRET) &&
    !all.includes(FAKE_VERIFY_TOKEN) && !all.includes(FULL_NUMBER));
  ok('F14. no authorization header is ever logged',
    !/console\.[a-z]+\([^)]*authorization/i.test(CLIENT) && !/Bearer /i.test(all));
  ok('  the status helper reads the token only to test presence',
    /hasAccessToken = Boolean\(/.test(CLIENT) && !/access_token:/.test(CLIENT));
}

// ── 16..19, 22 the recording transport ──────────────────────────────────────
console.log('\n  -- the development recording transport --');
{
  clearEnv();
  process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';
  const r = recorder();
  const c = t.createWhatsAppReplyClient({ transport: r.fn, templateName: 'purchase_request_review', templateLanguage: 'en' });
  const a = await c.sendTemplateMessage({ to: FULL_NUMBER, parameters: ['one'] });
  const b = await c.sendTemplateMessage({ to: FULL_NUMBER, parameters: ['two'] });
  ok('F16/F22. an explicitly injected recorder works and records every attempt', r.sent.length === 2);
  ok('F17. its provider ids are deterministic across calls',
    a.message_id === 'wamid.h8f.DETERMINISTIC' && b.message_id === a.message_id);
  ok('F18. it made zero network calls', fetchCalls === 0, `fetch=${fetchCalls}`);

  ok('F19. the process-wide client is built with no injected transport',
    /export let whatsappReplyClient = createWhatsAppReplyClient\(\);/.test(CLIENT));
  ok('  and no environment variable can select a recorder',
    !/process\.env\.[A-Z_]*(MOCK|FAKE|STUB|RECORD|SIMULAT)[A-Z_]*/i.test(CLIENT));

  // The seam itself is now environment-gated.
  delete process.env.HPMS_ENV;
  let refusedWhenUnset = false;
  try { t.setWhatsAppReplyClient(c); } catch { refusedWhenUnset = true; }
  ok('  the test seam refuses when HPMS_ENV is unset, which defaults to production',
    refusedWhenUnset);
  process.env.HPMS_ENV = 'production';
  let refusedInProd = false;
  try { t.setWhatsAppReplyClient(c); } catch { refusedInProd = true; }
  ok('  and refuses outright in production', refusedInProd);
  process.env.HPMS_ENV = 'development';
  const previous = t.setWhatsAppReplyClient(c);
  ok('  but works in a declared development process', t.whatsappReplyClient === c);
  t.setWhatsAppReplyClient(previous);
  ok('  and restores cleanly', t.whatsappReplyClient !== c);
}

// ── decisions must not bypass the outbound gate ─────────────────────────────
console.log('\n  -- decisions ON does not bypass outbound --');
{
  clearEnv();
  fullConfig();
  process.env.ENABLE_WHATSAPP_DECISIONS = 'true';
  const r = recorder();
  const c = t.createWhatsAppReplyClient({ transport: r.fn, templateName: 'purchase_request_review', templateLanguage: 'en' });
  const tpl = await c.sendTemplateMessage({ to: FULL_NUMBER, parameters: ['x'] });
  ok('F23. decisions enabled alone still cannot send a business-initiated message',
    tpl.reason === t.SEND_REASON.OUTBOUND_DISABLED && r.sent.length === 0);
  // A reply is not business-initiated and deliberately stays available.
  const reply = await c.sendText(FULL_NUMBER, 'already decided');
  ok('  while an in-window reply remains available, as H8-B documents',
    reply.sent === true && r.sent.length === 1);
}

// ── Graph security is unchanged ─────────────────────────────────────────────
console.log('\n  -- the H8-B Graph protections still hold --');
{
  ok('F24. only HTTPS on the allowlisted host is accepted',
    ['http://graph.facebook.com', 'https://evil.example.com', 'https://graph.facebook.com.evil.example',
     'https://user:pass@graph.facebook.com', 'https://127.0.0.1', 'https://169.254.169.254']
      .every(u => t.safeGraphBaseUrl(u) === null) &&
    t.safeGraphBaseUrl('https://graph.facebook.com') === 'https://graph.facebook.com');
  ok('  a URL supplied through message input is still ignored',
    t.buildTemplatePayload({
      to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en', graphBaseUrl: 'https://evil.example.com'
    }).body.graphBaseUrl === undefined);
  ok('  identifiers are still refused rather than truncated',
    t.buildInteractiveButtonsPayload({
      to: FULL_NUMBER, bodyText: 'x', buttons: [{ id: 'i'.repeat(t.BUTTON_LIMITS.ID + 1), title: 'A' }]
    }).ok === false);
  ok('  the request URL is still assembled only from validated configuration',
    /const url = `\$\{graphBaseUrl\}\/\$\{apiVersion\}\/\$\{phoneNumberId\}\/messages`/.test(CLIENT));
  ok('  a caller-supplied message type is still discarded',
    t.buildTemplatePayload({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en', type: 'audio' }).body.type === 'template');
}

// ── the status helper adds no reachability ──────────────────────────────────
console.log('\n  -- the diagnostics helper is inert --');
ok('F25. it performs no send and opens no connection',
  !/getWhatsAppOutboundStatus[\s\S]{0,1400}(fetch\(|dispatch\(|send\()/.test(CLIENT));
ok('  the client still reaches no database', !/firestore|firebaseAdmin|repositories\//i.test(CLIENT));

restoreEnv();
globalThis.fetch = realFetch;
ok('FINAL. not one global fetch call was made by this suite', fetchCalls === 0, `fetch=${fetchCalls}`);

console.log(`\n═══ H8-F OUTBOUND CONFIGURATION: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
