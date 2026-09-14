/**
 * backend/tests/testInventoryWhatsAppOutboundTransportH8.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-B — the WhatsApp outbound transport.
 *
 * NO DATABASE, BY CONSTRUCTION
 * There is no Part B here and that is the point. The transport reaches no
 * database at all, so this suite imports nothing that touches firebaseAdmin,
 * which initialises against PRODUCTION when HPMS_ENV is unset. A suite that
 * cannot open a database cannot write to the wrong one. The absence is asserted
 * rather than assumed, in C3 below.
 *
 * NO NETWORK
 * Every send runs through an injected recording transport. No credential is
 * present, no request is built against a real host, and a counter proves that
 * global fetch is never called.
 *
 * All credential-shaped values below are obvious fakes, used only to prove they
 * never escape into a log or a returned object.
 *
 * Run:  node backend/tests/testInventoryWhatsAppOutboundTransportH8.mjs
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

const CLIENT = codeOnly(src('backend', 'services', 'whatsappOutboundClient.js'));
const FLAGS = src('backend', 'config', 'featureFlags.js');

// Obvious fakes. Their only job is to be searched for in logs and results.
const FAKE_TOKEN = 'h8b_FAKE_ACCESS_TOKEN_NOT_A_CREDENTIAL';
const FAKE_APP_SECRET = 'h8b_FAKE_APP_SECRET_NOT_A_CREDENTIAL';
const FAKE_VERIFY_TOKEN = 'h8b_FAKE_VERIFY_TOKEN_NOT_A_CREDENTIAL';
const FULL_NUMBER = '919876543210';

process.env.WHATSAPP_APP_SECRET = FAKE_APP_SECRET;
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = FAKE_VERIFY_TOKEN;
delete process.env.ENABLE_WHATSAPP_OUTBOUND;

// Capture every log line so credential leakage is provable, not assumed.
const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { logged.push(a.map(String).join(' ')); orig(...a); };
}

// Prove no real network call is ever made.
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { fetchCalls++; return realFetch ? realFetch(...a) : undefined; };

const t = await import('../services/whatsappOutboundClient.js');
const flags = await import('../config/featureFlags.js');

/** A recording transport. Deterministic ids, and a scripted reply per call. */
function recorder(script = () => ({ ok: true, status: 200, json: { messages: [{ id: 'wamid.h8b.1' }] } })) {
  const sent = [];
  const fn = async (body) => { sent.push(body); return await script(body, sent.length); };
  return { sent, fn };
}
const clientWith = (transport, extra = {}) => t.createWhatsAppReplyClient({ transport, ...extra });

console.log('═══ H8-B — OUTBOUND TRANSPORT (no database, no network) ═══');

// ── C1 the flag ─────────────────────────────────────────────────────────────
console.log('\n  -- the outbound kill switch --');
ok('C1. ENABLE_WHATSAPP_OUTBOUND defaults OFF when unset',
  flags.isWhatsAppOutboundEnabled() === false);
ok('  only the exact string "true" enables it',
  ['TRUE', 'True', '1', 'yes', 'on', '', ' true'].every(v => {
    process.env.ENABLE_WHATSAPP_OUTBOUND = v; return flags.isWhatsAppOutboundEnabled() === false;
  }));
process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';
ok('  and "true" enables it', flags.isWhatsAppOutboundEnabled() === true);
ok('  it is a strict comparison with no truthy fallback',
  /ENABLE_WHATSAPP_OUTBOUND === 'true'/.test(FLAGS) && !/ENABLE_WHATSAPP_OUTBOUND\s*\|\|/.test(FLAGS));
ok('  the three existing WhatsApp flags are untouched',
  /ENABLE_WHATSAPP_WEBHOOK === 'true'/.test(FLAGS) &&
  /ENABLE_WHATSAPP_VERIFICATION === 'true'/.test(FLAGS) &&
  /ENABLE_WHATSAPP_DECISIONS === 'true'/.test(FLAGS));
ok('  the outbound flag does not gate the inbound webhook',
  !/isWhatsAppOutboundEnabled[\s\S]{0,200}ENABLE_WHATSAPP_WEBHOOK/.test(FLAGS));

// ── C2 flag OFF is a hard stop ──────────────────────────────────────────────
console.log('\n  -- flag OFF sends nothing --');
delete process.env.ENABLE_WHATSAPP_OUTBOUND;
{
  const r = recorder();
  const c = clientWith(r.fn);
  const tpl = await c.sendTemplateMessage({ to: FULL_NUMBER, templateName: 'purchase_request_review', languageCode: 'en', parameters: ['PR-1'] });
  const btn = await c.sendInteractiveButtonsMessage({ to: FULL_NUMBER, bodyText: 'Decide', buttons: [{ id: 'hpms.v1.ap.' + 'A'.repeat(43), title: 'Approve' }] });
  ok('C2. a template send is refused while the flag is off',
    tpl.sent === false && tpl.reason === t.SEND_REASON.OUTBOUND_DISABLED);
  ok('  an interactive send is refused too',
    btn.sent === false && btn.reason === t.SEND_REASON.OUTBOUND_DISABLED);
  ok('  and the transport was never reached: zero attempted sends',
    r.sent.length === 0, `attempts=${r.sent.length}`);
  ok('  no global fetch call was made', fetchCalls === 0, `fetch=${fetchCalls}`);
}
process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';

// ── C3 no database, and no business logic ───────────────────────────────────
console.log('\n  -- scope: transport only --');
ok('C3. the transport reaches no database at all',
  !/firestore|firebaseAdmin|repositories\//i.test(CLIENT));
ok('  so flag OFF cannot produce a write: there is nothing to write with',
  !/\.set\(|\.create\(|\.update\(|runTransaction|collection\(/.test(CLIENT));
ok('  it mints, consumes and invalidates no token',
  !/createApprovalActionFirestore|consumeApprovalAction|markApprovalActionConsumed|hashToken|generateRawToken/.test(CLIENT));
ok('  it resolves no authority and selects no recipient',
  !/listApprovalAuthorities|isAuthorityDecisionEligible|resolveAuthorityBySender|fanOut/i.test(CLIENT));
ok('  it routes no inbound message and handles no delivery webhook',
  !/routeWhatsAppAction|dispatchInboundWhatsAppEvents|extractWebhookEvents|statuses/i.test(CLIENT));
ok('  it changes no purchase request',
  !/purchaseRequest|PR_STATUS|assertTransition|ApprovalService/i.test(CLIENT));
ok('  it does not read the action payload grammar, so it interprets no identifier',
  !/parseActionPayload|whatsappActionPayload|hpms\.v1/.test(CLIENT));

// ── C4 fail closed on missing configuration ─────────────────────────────────
console.log('\n  -- unconfigured fails closed --');
{
  const bare = t.createWhatsAppReplyClient({ apiVersion: '', phoneNumberId: '', accessToken: '' });
  const tpl = await bare.sendTemplateMessage({ to: FULL_NUMBER, templateName: 'purchase_request_review', languageCode: 'en' });
  const btn = await bare.sendInteractiveButtonsMessage({ to: FULL_NUMBER, bodyText: 'x', buttons: [{ id: 'a', title: 'A' }] });
  ok('C4. with no credentials a template send reports NOT_CONFIGURED and never throws',
    bare.configured === false && tpl.sent === false && tpl.reason === t.SEND_REASON.NOT_CONFIGURED);
  ok('  an interactive send does the same', btn.sent === false && btn.reason === t.SEND_REASON.NOT_CONFIGURED);
  ok('  no network call resulted', fetchCalls === 0);
  const noName = await clientWith(recorder().fn, { templateName: '', templateLanguage: '' })
    .sendTemplateMessage({ to: FULL_NUMBER });
  ok('  a missing template name or language is refused before any send',
    noName.sent === false && noName.reason === t.SEND_REASON.INVALID_INPUT);
}

// ── C5 template payload ─────────────────────────────────────────────────────
console.log('\n  -- the template payload is built, never forwarded --');
{
  const r = recorder();
  const c = clientWith(r.fn);
  const res = await c.sendTemplateMessage({
    to: '+' + FULL_NUMBER,
    templateName: 'purchase_request_review',
    languageCode: 'en',
    parameters: { request_number: 'PR-20260914-0007', department: 'Kitchen', item_count: 12 }
  });
  const body = r.sent[0];
  ok('C5. a valid template send reaches the transport once', r.sent.length === 1 && res.sent === true);
  ok('  the envelope is exactly the documented shape',
    body.messaging_product === 'whatsapp' && body.recipient_type === 'individual' &&
    body.type === 'template' && body.to === FULL_NUMBER);
  ok('  the leading plus is normalised away', body.to === FULL_NUMBER && !String(body.to).startsWith('+'));
  ok('  name and language are placed as given',
    body.template.name === 'purchase_request_review' && body.template.language.code === 'en');
  ok('  named parameters become one body component in order',
    body.template.components.length === 1 && body.template.components[0].type === 'body' &&
    body.template.components[0].parameters.length === 3 &&
    body.template.components[0].parameters[0].parameter_name === 'request_number' &&
    body.template.components[0].parameters[2].text === '12');
  const positional = t.buildTemplatePayload({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en_US', parameters: ['a', 'b'] });
  ok('  positional parameters are supported and carry no parameter_name',
    positional.ok && positional.body.template.components[0].parameters.every(p => p.type === 'text' && p.parameter_name === undefined));
  const none = t.buildTemplatePayload({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en' });
  ok('  a template with no parameters omits components entirely',
    none.ok && none.body.template.components === undefined);
}

// ── C6 interactive payload ──────────────────────────────────────────────────
console.log('\n  -- the interactive payload --');
const APPROVE_ID = 'hpms.v1.ap.' + 'A'.repeat(43);
const REJECT_ID = 'hpms.v1.rj.' + 'B'.repeat(43);
{
  const r = recorder();
  const c = clientWith(r.fn);
  const res = await c.sendInteractiveButtonsMessage({
    to: FULL_NUMBER, bodyText: 'Purchase request PR-1 needs a decision.',
    buttons: [{ id: APPROVE_ID, title: 'Approve' }, { id: REJECT_ID, title: 'Reject' }]
  });
  const body = r.sent[0];
  ok('C6. a valid interactive send reaches the transport once', r.sent.length === 1 && res.sent === true);
  ok('  the envelope is the documented reply-buttons shape',
    body.messaging_product === 'whatsapp' && body.type === 'interactive' && body.interactive.type === 'button');
  ok('  the body text is carried',
    body.interactive.body.text === 'Purchase request PR-1 needs a decision.');
  ok('  each button is a reply with the identifier placed VERBATIM',
    body.interactive.action.buttons.length === 2 &&
    body.interactive.action.buttons[0].type === 'reply' &&
    body.interactive.action.buttons[0].reply.id === APPROVE_ID &&
    body.interactive.action.buttons[1].reply.id === REJECT_ID);
  ok('  an H7 action payload survives untouched, character for character',
    body.interactive.action.buttons[0].reply.id.length === 54 &&
    body.interactive.action.buttons[0].reply.id === APPROVE_ID);
  ok('  header and footer are optional and absent by default',
    body.interactive.header === undefined && body.interactive.footer === undefined);
}

// ── C7/C8/C9 input validation ───────────────────────────────────────────────
console.log('\n  -- malformed input is refused --');
{
  const r = recorder();
  const c = clientWith(r.fn);
  const badNumbers = ['', '   ', 'abc', '0123456789', '12345', '+' , '9198765432101234567', '91987654321a', null, undefined, 42, '+91 98765 43210'];
  const results = [];
  for (const n of badNumbers) {
    results.push(await c.sendTemplateMessage({ to: n, templateName: 'x_y', languageCode: 'en' }));
  }
  ok('C7. every malformed recipient is refused as INVALID_INPUT',
    results.every(x => x.sent === false && x.reason === t.SEND_REASON.INVALID_INPUT));
  ok('  and none of them reached the transport', r.sent.length === 0, `attempts=${r.sent.length}`);

  const badTemplates = [
    { templateName: '', languageCode: 'en' },
    { templateName: 'Has Spaces', languageCode: 'en' },
    { templateName: 'UPPERCASE', languageCode: 'en' },
    { templateName: 'ok_name', languageCode: 'english' },
    { templateName: 'ok_name', languageCode: '' },
    { templateName: 'ok_name', languageCode: 'EN' }
  ];
  const tplResults = [];
  for (const b of badTemplates) tplResults.push(t.buildTemplatePayload({ to: FULL_NUMBER, ...b }));
  ok('C8. every malformed template name or language is refused',
    tplResults.every(x => x.ok === false));
  ok('  a parameter containing a newline or tab is refused, not stripped',
    ['a\nb', 'a\tb', 'a\r\nb'].every(v =>
      t.buildTemplatePayload({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en', parameters: [v] }).ok === false));
  ok('  a non-serializable parameter is refused',
    [{}, [], () => {}, null, undefined, ''].every(v =>
      t.buildTemplatePayload({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en', parameters: [v] }).ok === false));

  const badButtons = [
    [],
    null,
    [{ id: '', title: 'A' }],
    [{ id: 'a', title: '' }],
    [{ id: 'a', title: 'T'.repeat(21) }],
    [{ id: 'a b', title: 'A' }],
    [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }],
    [{ id: 'a', title: 'A' }, { id: 'b', title: 'A' }],
    [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }],
    ['not an object']
  ];
  ok('C9. every malformed button set is refused',
    badButtons.every(b => t.buildInteractiveButtonsPayload({ to: FULL_NUMBER, bodyText: 'x', buttons: b }).ok === false));
  ok('  an empty or oversized body is refused',
    t.buildInteractiveButtonsPayload({ to: FULL_NUMBER, bodyText: '', buttons: [{ id: 'a', title: 'A' }] }).ok === false &&
    t.buildInteractiveButtonsPayload({ to: FULL_NUMBER, bodyText: 'x'.repeat(1025), buttons: [{ id: 'a', title: 'A' }] }).ok === false);
}

// ── C10 the identifier boundary ─────────────────────────────────────────────
console.log('\n  -- the button identifier boundary --');
{
  const atLimit = 'i'.repeat(t.BUTTON_LIMITS.ID);
  const overLimit = 'i'.repeat(t.BUTTON_LIMITS.ID + 1);
  const okAt = t.buildInteractiveButtonsPayload({ to: FULL_NUMBER, bodyText: 'x', buttons: [{ id: atLimit, title: 'A' }] });
  const overRes = t.buildInteractiveButtonsPayload({ to: FULL_NUMBER, bodyText: 'x', buttons: [{ id: overLimit, title: 'A' }] });
  ok('C10. the documented ceiling is 256', t.BUTTON_LIMITS.ID === 256);
  ok('  an identifier exactly at the ceiling is accepted and unmodified',
    okAt.ok && okAt.body.interactive.action.buttons[0].reply.id === atLimit &&
    okAt.body.interactive.action.buttons[0].reply.id.length === 256);
  ok('  one character over is REFUSED, never silently truncated',
    overRes.ok === false);
  ok('  and no truncation helper is applied to a button id anywhere',
    !/reply:\s*\{\s*id:\s*clamp\(/.test(CLIENT) && !/id:\s*clamp\(/.test(CLIENT));
  ok('  H7\'s own payloads sit far inside the ceiling',
    APPROVE_ID.length < t.BUTTON_LIMITS.ID && APPROVE_ID.length === 54);
}

// ── C11-C15 provider outcomes ───────────────────────────────────────────────
console.log('\n  -- provider outcomes are normalized --');
{
  const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const cases = [
    ['timeout', async () => { throw timeoutErr; }, t.SEND_REASON.SEND_TIMEOUT, 'UNKNOWN'],
    ['connection failure', async () => { throw new Error('ECONNREFUSED'); }, t.SEND_REASON.SEND_ERROR, 'FAILED'],
    ['HTTP 400', async () => ({ ok: false, status: 400, json: { error: { code: 131009, message: 'bad param' } } }), t.SEND_REASON.SEND_FAILED, 'FAILED'],
    ['HTTP 401', async () => ({ ok: false, status: 401, json: { error: { code: 190, message: 'bad token' } } }), t.SEND_REASON.SEND_FAILED, 'FAILED'],
    ['HTTP 500', async () => ({ ok: false, status: 500, json: null }), t.SEND_REASON.SEND_FAILED, 'FAILED'],
    ['malformed 200', async () => ({ ok: true, status: 200, json: { nothing: true } }), t.SEND_REASON.MALFORMED_RESPONSE, 'UNKNOWN'],
    ['unparseable 200', async () => ({ ok: true, status: 200, json: null }), t.SEND_REASON.MALFORMED_RESPONSE, 'UNKNOWN']
  ];
  for (const [label, script, expectedReason, expectedOutcome] of cases) {
    const c = clientWith(recorder(script).fn);
    const res = await c.sendTemplateMessage({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en' });
    ok(`C11-14. ${label} normalizes to ${expectedReason} / ${expectedOutcome}`,
      res.sent === false && res.reason === expectedReason && res.outcome === expectedOutcome,
      `got ${res.reason}/${res.outcome}`);
  }
  ok('  a timeout is never reported as a definite failure',
    (await clientWith(recorder(async () => { throw timeoutErr; }).fn)
      .sendTemplateMessage({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en' })).outcome === 'UNKNOWN');
  ok('  a provider error code is surfaced where it is safe to do so',
    (await clientWith(recorder(async () => ({ ok: false, status: 400, json: { error: { code: 131009 } } })).fn)
      .sendTemplateMessage({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en' })).provider_code === 131009);

  const good = clientWith(recorder(async () => ({ ok: true, status: 200, json: { messages: [{ id: 'wamid.DETERMINISTIC.1' }] } })).fn);
  const res = await good.sendTemplateMessage({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en' });
  ok('C15. a successful send returns the provider message id and outcome SENT',
    res.sent === true && res.message_id === 'wamid.DETERMINISTIC.1' && res.outcome === 'SENT');
  ok('  the raw provider response is not handed back to the application',
    res.json === undefined && res.body === undefined && res.response === undefined);
}

// ── C16-C20 secrets never escape ────────────────────────────────────────────
console.log('\n  -- secrets never escape --');
{
  const c = t.createWhatsAppReplyClient({
    transport: recorder(async () => ({ ok: false, status: 401, json: { error: { code: 190, message: 'Invalid OAuth access token' } } })).fn,
    accessToken: FAKE_TOKEN
  });
  const err = await c.sendTemplateMessage({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en' });
  const serialized = JSON.stringify(err);
  ok('C16. the access token never appears in a returned error', !serialized.includes(FAKE_TOKEN));
  ok('  nor does the app secret or the verify token',
    !serialized.includes(FAKE_APP_SECRET) && !serialized.includes(FAKE_VERIFY_TOKEN));
  ok('  nor does the full recipient number', !serialized.includes(FULL_NUMBER));

  const allLogs = logged.join('\n');
  ok('C17. the access token never appears in any captured log line', !allLogs.includes(FAKE_TOKEN));
  ok('C18. the app secret never appears in any log or result', !allLogs.includes(FAKE_APP_SECRET));
  ok('C19. the verify token never appears in any log or result', !allLogs.includes(FAKE_VERIFY_TOKEN));
  ok('C20. the full recipient number is never logged', !allLogs.includes(FULL_NUMBER));
  ok('  the source never interpolates a credential into a log call',
    !/console\.[a-z]+\([^)]*(accessToken|appSecret|apiKey|verifyToken)/.test(CLIENT));
  ok('  the token is read from the backend environment and nowhere else',
    /process\.env\.WHATSAPP_ACCESS_TOKEN/.test(CLIENT) &&
    (CLIENT.match(/accessToken/g) || []).length > 0);
  ok('  the authorization header is built at the call site and never logged',
    /authorization: `Bearer \$\{accessToken\}`/.test(CLIENT) &&
    !/console\.[a-z]+\([^)]*authorization/i.test(CLIENT));
  ok('  the masking helper keeps only the first and last two digits',
    t.maskNumber(FULL_NUMBER) === '91***10' && !t.maskNumber(FULL_NUMBER).includes(FULL_NUMBER));
}

// ── C21 the base URL is configuration, never input ──────────────────────────
console.log('\n  -- the Graph host cannot be chosen by a caller --');
{
  const hostile = [
    'http://graph.facebook.com', 'https://evil.example.com', 'https://graph.facebook.com.evil.example',
    'https://user:pass@graph.facebook.com', 'https://graph.facebook.com/redirect?to=x',
    'https://127.0.0.1', 'https://localhost', 'file:///etc/passwd', 'https://169.254.169.254', ''
  ];
  ok('C21. every unsafe base URL is rejected by the validator',
    hostile.every(u => t.safeGraphBaseUrl(u) === null));
  ok('  the documented host is accepted',
    t.safeGraphBaseUrl('https://graph.facebook.com') === 'https://graph.facebook.com');
  const poisoned = t.createWhatsAppReplyClient({
    graphBaseUrl: 'https://evil.example.com', apiVersion: 'v23.0',
    phoneNumberId: '123', accessToken: FAKE_TOKEN
  });
  ok('  a client configured with an unsafe host is NOT credentialed, and does not fall back to the default',
    poisoned.credentialed === false);
  const res = await poisoned.sendTemplateMessage({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en' });
  ok('  so it sends nothing at all', res.sent === false && res.reason === t.SEND_REASON.NOT_CONFIGURED);

  const r = recorder();
  const c = clientWith(r.fn);
  await c.sendTemplateMessage({
    to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en',
    graphBaseUrl: 'https://evil.example.com', url: 'https://evil.example.com', baseUrl: 'https://evil.example.com'
  });
  ok('  a URL supplied through the MESSAGE input is ignored entirely',
    r.sent.length === 1 && r.sent[0].graphBaseUrl === undefined &&
    r.sent[0].url === undefined && r.sent[0].baseUrl === undefined);
  ok('  the request URL is assembled only from validated configuration',
    /const url = `\$\{graphBaseUrl\}\/\$\{apiVersion\}\/\$\{phoneNumberId\}\/messages`/.test(CLIENT));
}

// ── C22 no arbitrary message type ───────────────────────────────────────────
console.log('\n  -- no arbitrary message type can be injected --');
{
  const r = recorder();
  const c = clientWith(r.fn);
  await c.sendTemplateMessage({
    to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en',
    type: 'audio', messaging_product: 'sms', audio: { link: 'https://evil.example.com/x.mp3' }
  });
  await c.sendInteractiveButtonsMessage({
    to: FULL_NUMBER, bodyText: 'x', buttons: [{ id: 'a', title: 'A' }],
    type: 'document', interactive: { type: 'product' }
  });
  ok('C22. a caller-supplied type is discarded: template stays "template"',
    r.sent[0].type === 'template' && r.sent[0].messaging_product === 'whatsapp' && r.sent[0].audio === undefined);
  ok('  and interactive stays an interactive reply-button message',
    r.sent[1].type === 'interactive' && r.sent[1].interactive.type === 'button');
  ok('  no builder spreads caller input into the envelope',
    !/\.\.\.\s*(data|input|options|payload|rest)\b/.test(CLIENT));
}

// ── C23/C24 the test seam ───────────────────────────────────────────────────
console.log('\n  -- the injected transport --');
{
  const r = recorder(async (_b, n) => ({ ok: true, status: 200, json: { messages: [{ id: `wamid.SEQ.${n}` }] } }));
  const c = clientWith(r.fn);
  const a = await c.sendTemplateMessage({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en' });
  const b = await c.sendTemplateMessage({ to: FULL_NUMBER, templateName: 'x_y', languageCode: 'en' });
  ok('C23. the recording transport captures every attempt in order',
    r.sent.length === 2 && a.message_id === 'wamid.SEQ.1' && b.message_id === 'wamid.SEQ.2');
  ok('  and ids are deterministic across runs', a.message_id === 'wamid.SEQ.1');

  ok('C24. no environment variable can install a fake transport',
    !/process\.env\.[A-Z_]*(MOCK|FAKE|STUB|TEST|SIMULAT)[A-Z_]*/i.test(CLIENT));
  ok('  the transport seam is a constructor argument only',
    /createWhatsAppReplyClient\(\{\s*\n?\s*transport = null/.test(CLIENT) || /transport = null,/.test(CLIENT));
  ok('  the process-wide client is built with no injected transport',
    /export let whatsappReplyClient = createWhatsAppReplyClient\(\);/.test(CLIENT));
  ok('  production code never calls the setter',
    (() => {
      const dirs = ['services', 'controllers', 'routes', 'repositories', 'utils', 'config'];
      for (const d of dirs) {
        const base = path.join(BACKEND, d);
        if (!fs.existsSync(base)) continue;
        const stack = [base];
        while (stack.length) {
          const cur = stack.pop();
          for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            if (!e.name.endsWith('.js')) continue;
            if (e.name === 'whatsappOutboundClient.js') continue;
            if (/setWhatsAppReplyClient\s*\(/.test(fs.readFileSync(p, 'utf8'))) return false;
          }
        }
      }
      return true;
    })());
  ok('  a real transport is used when credentials and a safe host exist',
    t.createWhatsAppReplyClient({ apiVersion: 'v23.0', phoneNumberId: '123', accessToken: FAKE_TOKEN }).credentialed === true);
}

// ── C25 H7 behaviour is intact ──────────────────────────────────────────────
console.log('\n  -- H7 reply behaviour is unchanged --');
{
  const unconfigured = t.createWhatsAppReplyClient({ apiVersion: '', phoneNumberId: '', accessToken: '' });
  const unconfiguredResult = await unconfigured.sendText('919999999999', 'hello');
  ok('C25. with no credentials sendText is a no-op and never throws',
    unconfigured.configured === false && unconfiguredResult.sent === false &&
    unconfiguredResult.reason === 'NOT_CONFIGURED');

  const r = recorder();
  const c = clientWith(r.fn);
  await c.sendText('919999999999', 'approved');
  await c.sendReasonList('919999999999', { body: 'why?', buttonLabel: 'Choose a reason', rows: [{ id: 'hpms.v1.rr.x', title: 'Budget unavailable', description: 'x' }] });
  ok('  an injected transport still receives a text and a list',
    r.sent.length === 2 && r.sent[0].type === 'text' && r.sent[1].interactive.type === 'list');
  ok('  a failing transport is still reported, not thrown',
    (await clientWith(async () => { throw new Error('network down'); }).sendText('x', 'y')).sent === false);

  const clamped = recorder();
  const cc = clientWith(clamped.fn);
  await cc.sendReasonList('919999999999', { body: 'b', rows: Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, title: 'T'.repeat(50) })) });
  const rows = clamped.sent[0].interactive.action.sections[0].rows;
  ok('  list rows are still clamped to the documented ceilings',
    rows.length === t.LIST_LIMITS.MAX_ROWS && rows[0].title.length === t.LIST_LIMITS.ROW_TITLE);

  delete process.env.ENABLE_WHATSAPP_OUTBOUND;
  const replyWhileOff = recorder();
  const off = clientWith(replyWhileOff.fn);
  const stillReplies = await off.sendText('919999999999', 'already decided');
  ok('  a REPLY still goes out while the outbound flag is off, by design',
    stillReplies.sent === true && replyWhileOff.sent.length === 1);
  process.env.ENABLE_WHATSAPP_OUTBOUND = 'true';
}

// ── final network assertion ─────────────────────────────────────────────────
console.log('\n  -- nothing left the process --');
globalThis.fetch = realFetch;
ok('FINAL. not one global fetch call was made by this suite', fetchCalls === 0, `fetch=${fetchCalls}`);

console.log(`\n═══ H8-B OUTBOUND TRANSPORT: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
