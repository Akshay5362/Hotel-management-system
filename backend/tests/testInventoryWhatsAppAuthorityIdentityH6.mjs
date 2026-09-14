/**
 * backend/tests/testInventoryWhatsAppAuthorityIdentityH6.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H6 — external WhatsApp approval authorities and proof-of-possession
 * verification.
 *
 * PART A — no Firebase. Static invariants over every H6 file plus the pure
 *   crypto utility, and the four-layer guard exercised in child processes that
 *   never import Firebase. Imports only the two pure modules.
 *
 * PART B — DEV Firestore behind the four-layer guard, plus real HTTP through
 *   the REAL webhook router, so a verification code travels the same path a
 *   real one will: signed body → raw bytes → claim → dispatcher → redemption.
 *   Synthetic numbers, synthetic authorities, one synthetic staff DOCUMENT
 *   (never an Auth user). Everything is removed in a finally block.
 *
 * No Meta credential exists, no message is sent, no production project is
 * ever initialised.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryWhatsAppAuthorityIdentityH6.mjs
 *       node backend/tests/testInventoryWhatsAppAuthorityIdentityH6.mjs      (Part A only)
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

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
const UTIL = codeOnly(src('backend', 'utils', 'whatsappVerificationCode.js'));
const AREPO = src('backend', 'repositories', 'firestore', 'inventoryApprovalAuthoritiesRepository.js');
const AREPO_CODE = codeOnly(AREPO);
const BREPO = codeOnly(src('backend', 'repositories', 'firestore', 'whatsappNumberBindingsRepository.js'));
const VSVC = codeOnly(src('backend', 'services', 'whatsappAuthorityVerificationService.js'));
const DISPATCH = codeOnly(src('backend', 'services', 'whatsappInboundDispatcher.js'));
const WCTRL = codeOnly(src('backend', 'controllers', 'whatsappWebhookController.js'));
const ACTRL = codeOnly(src('backend', 'controllers', 'inventoryApprovalAuthoritiesController.js'));
const ROUTES = src('backend', 'routes', 'inventoryRoutes.js');
const WROUTES = codeOnly(src('backend', 'routes', 'whatsappRoutes.js'));
const SVC = codeOnly(src('backend', 'services', 'purchaseRequestApprovalService.js'));
const STAFF_CTRL = src('backend', 'controllers', 'staffController.js');
const AUTH_CTRL = codeOnly(src('backend', 'controllers', 'authController.js'));
const RULES = src('firestore.rules');
const FLAGS = src('backend', 'config', 'featureFlags.js');
const SERVER = codeOnly(src('backend', 'server.js'));
const H6_CODE = UTIL + BREPO + AREPO_CODE + VSVC + DISPATCH + WCTRL + ACTRL;

const extStart = SVC.indexOf('if (authority.authority_type === APPROVAL_AUTHORITY_TYPES.EXTERNAL) {');
const intStart = SVC.indexOf('if (authority.authority_type === APPROVAL_AUTHORITY_TYPES.INTERNAL) {');
const EXTERNAL_BRANCH = SVC.slice(extStart, intStart);
const verifiedWrite = VSVC.slice(VSVC.indexOf('const verificationExpiresAt = new Date(nowMs + WHATSAPP_VERIFICATION_VALIDITY_MS)'), VSVC.indexOf('return { outcome: REDEEM_OUTCOME.VERIFIED'));

console.log('═══ PART A — source invariants, pure logic, guard behaviour (no Firebase) ═══');

console.log('\n  -- IDENTITY --');
ok('1. authority_id is server generated from the CSPRNG',
  /export function generateAuthorityId\(\) \{\s*\n\s*return `aa_\$\{crypto\.randomBytes\(16\)\.toString\('hex'\)\}`;/.test(AREPO) &&
  /authority_id: generateAuthorityId\(\)/.test(AREPO_CODE));
ok('2. authority identity is not a Firebase uid: no user_uid, no uid parameter, no Auth import',
  !/user_uid/.test(AREPO_CODE) && !/req\.params\.uid\b/.test(ACTRL) && !/firebase-admin\/auth|verifyIdToken/.test(AREPO_CODE + VSVC + ACTRL));
ok('3. authority_type is EXTERNAL at creation and no write path ever changes it',
  /authority_type: APPROVAL_AUTHORITY_TYPES\.EXTERNAL/.test(AREPO_CODE) &&
  (AREPO_CODE.match(/authority_type:/g) || []).length === 1 && !/authority_type:/.test(VSVC));
ok('4. external authority is never a staff role',
  !/whatsapp_authority|external_approver|whatsapp_admin|WHATSAPP_AUTHORITY|EXTERNAL_APPROVER/.test(CONSTS + STAFF_CTRL + AUTH_CTRL + SVC) &&
  /VALID_ROLES = \['ADMIN', 'RECEPTIONIST', 'CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY', 'CLEANER'\]/.test(STAFF_CTRL) &&
  /VALID_APPROVER_ROLES = Object\.freeze\(\['admin', 'super_admin', 'receptionist', 'kitchen', 'housekeeper'\]\)/.test(CONSTS));
ok('  the engine branches on the STORED type, twice, and fails closed otherwise',
  (SVC.match(/authority\.authority_type === APPROVAL_AUTHORITY_TYPES\.(EXTERNAL|INTERNAL)/g) || []).length === 2 && /AUTHORITY_TYPE_INVALID/.test(SVC));
ok('  the EXTERNAL branch reads no staff record and derives no role',
  extStart > 0 && intStart > extStart && !/getStaffByUidFirestore|normalizeUserRole|assertStaffEligible|staffRef|roleCanApprove/.test(EXTERNAL_BRANCH));
ok('5. linked_staff_uid is optional and defaults to null',
  /linked_staff_uid = null/.test(AREPO_CODE) && /linked_staff_uid: cleanString\(linked_staff_uid, 128\)/.test(AREPO_CODE));

console.log('\n  -- NUMBER (pure) --');
const util = await import('../utils/whatsappVerificationCode.js');
ok('6. E.164 normalisation is consistent for Meta digits and human punctuation',
  util.normalizeSenderToE164('919876543210') === '+919876543210' &&
  util.normalizeSenderToE164('+91 98765-43210') === '+919876543210' &&
  util.normalizeSenderToE164('abc') === null && util.normalizeSenderToE164('+0123') === null);
ok('  the binding key is deterministic and digit-only', util.bindingKeyForNumber('+91 98765 43210') === 'wa_919876543210');
ok('7/8. uniqueness is transactional: an in-transaction read plus create() on the binding',
  /readNumberBindingInTxn\(txn, e164\)/.test(VSVC) && /txn\.create\(bindingRef, binding\)/.test(VSVC) && /NUMBER_ALREADY_BOUND/.test(VSVC));
ok('9. the binding id is the number, so one number cannot bind twice', /\.doc\(bindingKeyForNumber\(assertE164\(e164\)\)\)/.test(BREPO));
ok('10/11. a number change releases the old binding, creates the new one, and clears verification',
  /txn\.delete\(oldRef\)/.test(VSVC) && /txn\.create\(newRef, newNumberBindingDoc/.test(VSVC) &&
  /whatsapp_e164: e164, \.\.\.unverifiedAuthorityFields\(now, actor\.uid\)/.test(VSVC));

console.log('\n  -- VERIFICATION (pure) --');
ok('12. a new authority starts PENDING_VERIFICATION and inactive',
  /verification_status: APPROVAL_AUTHORITY_VERIFICATION\.PENDING_VERIFICATION/.test(AREPO_CODE) && /is_active: false/.test(AREPO_CODE));
ok('13. the code is drawn digit by digit from crypto.randomInt', /crypto\.randomInt\(0, 10\)/.test(UTIL));
const code = util.generateVerificationCode();
ok('  a generated code is exactly 8 digits', /^[0-9]{8}$/.test(code));
ok('14. the plaintext code is never written: only challenge_code_hmac reaches a document',
  !/txn\.(update|create|set)\([\s\S]{0,600}?\bcode\b[\s\S]{0,200}?\)/.test(VSVC.replace(/challenge_code_hmac/g, 'X')) && /challenge_code_hmac: hmac/.test(VSVC));
// A log line may SAY "code"; it must never carry the value — interpolated or
// passed as an argument. Same discipline as the H5 secret-logging check.
ok('15. the plaintext code is never logged',
  !/console\.[a-z]+\([^)]*\$\{[^}]*\bcode\b/.test(VSVC + DISPATCH + ACTRL) &&
  !/console\.[a-z]+\(\s*code\b/.test(VSVC + DISPATCH + ACTRL) && !/console\.[a-z]+\([^)]*,\s*code\b/.test(VSVC + DISPATCH + ACTRL) &&
  !/console\./.test(UTIL));
ok('16. a keyed HMAC is used, and the code is never fed to a plain hash',
  /createHmac\('sha256', secret\)/.test(UTIL) && !/createHash\([^)]*\)\.update\(code/.test(UTIL) && !/createHash\([^)]*\)\.update\(`[^`]*code/.test(UTIL));
const SECRET = 'h6_test_secret_value_that_is_long_enough';
const hm = util.verificationCodeHmac(code, SECRET, 'wa_1');
ok('  the HMAC is bound to its context', util.verificationCodeMatches(code, hm, SECRET, 'wa_1') && !util.verificationCodeMatches(code, hm, SECRET, 'wa_2'));
ok('  a wrong code, wrong secret, or malformed digest never matches',
  !util.verificationCodeMatches('00000000', hm, SECRET, 'wa_1') && !util.verificationCodeMatches(code, hm, 'other_secret_long_enough_xx', 'wa_1') &&
  !util.verificationCodeMatches(code, 'zz', SECRET, 'wa_1') && !util.verificationCodeMatches(code, null, SECRET, 'wa_1'));
ok('  a missing secret refuses to issue, without leaking it',
  (() => { try { util.verificationCodeHmac(code, '', 'x'); return false; } catch (e) { return e.code === 'WHATSAPP_VERIFICATION_NOT_CONFIGURED' && !/secret_value/.test(e.message); } })());
ok('  extraction is strict: exactly one 8-digit run and nothing else',
  util.extractVerificationCode('Code: 1234-5678') === '12345678' && util.extractVerificationCode('12 then 12345678') === null &&
  util.extractVerificationCode('1234567') === null && util.extractVerificationCode('APPROVE') === null);
ok('  challenge state: none / active / consumed / expired / exhausted',
  util.challengeState(null) === 'NONE' &&
  util.challengeState({ challenge_code_hmac: hm, challenge_expires_at: new Date(Date.now() + 60000).toISOString(), challenge_attempts: 0 }) === 'ACTIVE' &&
  util.challengeState({ challenge_code_hmac: hm, challenge_consumed_at: 'x', challenge_expires_at: new Date(Date.now() + 60000).toISOString() }) === 'CONSUMED' &&
  util.challengeState({ challenge_code_hmac: null, challenge_consumed_at: 'x' }) === 'CONSUMED' &&
  util.challengeState({ challenge_code_hmac: null, challenge_consumed_at: null, challenge_attempts: 5 }) === 'NONE' &&
  util.challengeState({ challenge_code_hmac: hm, challenge_expires_at: new Date(Date.now() - 1).toISOString() }) === 'EXPIRED' &&
  util.challengeState({ challenge_code_hmac: hm, challenge_expires_at: new Date(Date.now() + 60000).toISOString(), challenge_attempts: 5 }) === 'EXHAUSTED');
ok('  TTL 15 min, 5 attempts, 8 digits, 180-day validity',
  /WHATSAPP_VERIFICATION_CHALLENGE_TTL_MS = 15 \* 60 \* 1000/.test(CONSTS) && /WHATSAPP_VERIFICATION_MAX_ATTEMPTS = 5/.test(CONSTS) &&
  /WHATSAPP_VERIFICATION_CODE_LENGTH = 8/.test(CONSTS) && /WHATSAPP_VERIFICATION_VALIDITY_MS = 180 \* 24 \* 60 \* 60 \* 1000/.test(CONSTS));
ok('22. issuing a challenge replaces the previous one', /\.\.\.clearedChallengeFields\(now\),\s*\n\s*challenge_code_hmac: hmac/.test(VSVC));
ok('23/24. redemption looks the binding up BY THE SENDER, so a wrong sender cannot touch another number\'s challenge',
  /readNumberBindingInTxn\(txn, senderE164\)/.test(VSVC) && /UNKNOWN_SENDER/.test(VSVC));
ok('25. verification updates binding and authority in ONE transaction', /txn\.update\(bRef, \{\s*\n\s*status: BINDING_STATUS\.VERIFIED/.test(VSVC) && /txn\.update\(aRef, \{\s*\n\s*verification_status: APPROVAL_AUTHORITY_VERIFICATION\.VERIFIED/.test(VSVC));
ok('26. verification expiry is issued at +180 days', /nowMs \+ WHATSAPP_VERIFICATION_VALIDITY_MS/.test(VSVC));
ok('27. verification does NOT activate the authority', verifiedWrite.length > 0 && !/is_active/.test(verifiedWrite));
ok('  reads precede writes in every transaction (Firestore rule)',
  (() => { const txns = VSVC.split('db.runTransaction(').slice(1); return txns.every(t => { const w = t.search(/txn\.(update|create|delete|set)\(/); const r = t.lastIndexOf('await read', w < 0 ? undefined : w); const laterRead = t.slice(w).search(/await txn\.get|await read[A-Za-z]+InTxn/); return w > 0 && r >= 0 && (laterRead < 0 || laterRead > t.slice(w).indexOf('});')); }); })());

console.log('\n  -- ACTIVATION --');
ok('28-30. activation is refused unless the verification is current', /if \(isActive\) \{\s*\n\s*const verdict = assessAuthorityVerification\(existing\);\s*\n\s*if \(!verdict\.ok\) throw/.test(AREPO_CODE));
ok('  revoked, unverified and expired each have a distinct code, defined once with the document',
  /AUTHORITY_REVOKED/.test(AREPO_CODE) && /AUTHORITY_NOT_VERIFIED/.test(AREPO_CODE) && /AUTHORITY_VERIFICATION_EXPIRED/.test(AREPO_CODE) &&
  (AREPO_CODE.match(/export function assessAuthorityVerification/g) || []).length === 1 && !/assessAuthorityVerification/.test(UTIL));
ok('  deactivation has no precondition',
  (() => { const fn = AREPO_CODE.slice(AREPO_CODE.indexOf('export async function setApprovalAuthorityActiveFirestore'), AREPO_CODE.indexOf('return { ...existing, ...result };', AREPO_CODE.indexOf('export async function setApprovalAuthorityActiveFirestore')));
    return (fn.match(/assessAuthorityVerification\(/g) || []).length === 1 && /if \(isActive\) \{[\s\S]{0,120}assessAuthorityVerification\(existing\)/.test(fn); })());

console.log('\n  -- H3 / H4 --');
ok('33-36. the external principal needs no staff, no Auth, no password, no portal',
  !/password|verifyIdToken|firebaseUser|staffLogin/.test(SVC) && !/getStaffByUidFirestore/.test(EXTERNAL_BRANCH));
ok('37. the token still binds to the opaque approver id, unchanged', /String\(tokenDoc\.approver_uid\) !== String\(approverUid\)/.test(SVC));
ok('40. self-approval is blocked through linked_staff_uid', /\(linked && requester === linked\)/.test(SVC));
ok('41. the external authority is re-read inside the transaction', /const snap = await txn\.get\(authorityRef\);[\s\S]{0,200}assertExternalAuthorityCanApprove\(current, actor, live\)/.test(SVC));
ok('  the approval engine imports nothing WhatsApp-named (transport stays out of the engine)',
  !/whatsapp/i.test(SVC.match(/^import[\s\S]*?from '[^']+';/gm)?.join('\n') || ''));
ok('  H2 token repository and H4 reason model untouched by H6',
  /export function tokenPurpose/.test(src('backend', 'repositories', 'firestore', 'inventoryApprovalActionsRepository.js')) &&
  /REJECTION_REASON_TEXT_NOT_ACCEPTED/.test(SVC) && /TOKEN_PARENT_MISMATCH/.test(SVC));
ok('  still exactly one decision transaction in the approval service', (SVC.match(/db\.runTransaction\(/g) || []).length === 1);

console.log('\n  -- WEBHOOK --');
ok('51. the sender comes from the signed Meta payload only', /sender_id: message\.from \? String\(message\.from\) : null/.test(WCTRL));
ok('52. nothing on the inbound path reads a caller-supplied sender', !/req\.|res\.|body\.sender|query\./.test(DISPATCH) && !/\bsender\b[^_]/.test(WCTRL.replace(/sender_id/g, '')));
// H7 gave the dispatcher a second specialist. What must stay true is that the
// dispatcher itself still decides nothing: it delegates and records an outcome.
ok('53/54. the dispatcher never decides; it delegates and owns no approval logic',
  !/decideWithApprovalActionToken|beginTokenRejection|completeTokenRejection|inventoryApprovalActionsRepository|purchaseRequestApprovalService|purchase_requests|txn\./.test(DISPATCH));
ok('55. unknown messages are ignored, not errors', /IGNORED_NOT_A_MESSAGE/.test(DISPATCH) && /IGNORED_NOT_TEXT/.test(DISPATCH) && /IGNORED_NO_SENDER/.test(DISPATCH));
ok('  the dispatcher never logs a sender or a body', !/console\.[a-z]+\([^)]*(sender|text|body)/.test(DISPATCH));
ok('  H5 preserved: verify before parse, raw body, claim before dispatch',
  WCTRL.indexOf('verifyWebhookSignature(') < WCTRL.indexOf('JSON.parse(') && /Buffer\.isBuffer\(rawBody\)/.test(WCTRL) &&
  WCTRL.indexOf('claimWebhookEventFirestore(') < WCTRL.indexOf('dispatchVerifiedWebhookEvents(claimed'));
ok('  H5 preserved: router unchanged, mount order unchanged',
  /router\.post\('\/webhook', webhookRateLimit, rawBody, receiveWebhook\)/.test(WROUTES) && SERVER.indexOf("app.use('/api/whatsapp', whatsappRoutes)") < SERVER.indexOf('app.use(express.json())'));
ok('  no outbound Meta client, no token minting, no templates in H6', !/graph\.facebook|fetch\(|axios|createApprovalActionFirestore|template/i.test(H6_CODE));

console.log('\n  -- RULES / FLAGS / SECRETS --');
ok('56. client write to number bindings denied', /match \/whatsapp_number_bindings\/\{numberKey\} \{\s*\n\s*allow read, write: if false;/.test(RULES));
ok('57. client write to authority verification state denied', /match \/inventory_approval_authorities\/\{authorityId\} \{\s*\n\s*allow read, write: if false;/.test(RULES));
ok('58. client write to webhook events denied', /match \/whatsapp_webhook_events\/\{eventId\} \{\s*\n\s*allow read, write: if false;/.test(RULES));
ok('  ENABLE_WHATSAPP_VERIFICATION defaults OFF', /ENABLE_WHATSAPP_VERIFICATION === 'true'/.test(FLAGS));
ok('  the HMAC secret comes only from the environment and is never logged',
  /env\.WHATSAPP_VERIFICATION_SECRET/.test(UTIL) && !/console\.[a-z]+\([^)]*(secret|SECRET)/.test(H6_CODE) && !/WHATSAPP_VERIFICATION_SECRET\s*=\s*['"]/.test(H6_CODE));
ok('  numbers reach audit masked', /whatsapp_masked: maskWhatsAppNumber/.test(VSVC) && /sender_masked: senderMasked/.test(VSVC) && !/whatsapp_e164: e164[^,]*\}, actor\)/.test(VSVC));
const mgmt = ROUTES.split('\n').filter(l => l.includes("'/approval-authorities"));
ok('  every management route is MANAGE and there is no self-service route', mgmt.length === 9 && mgmt.every(l => /,\s*MANAGE,/.test(l)) && !/approval-authorities\/me|self-verify/.test(ROUTES));

console.log('\n  -- SAFETY GUARD, in child processes that never import Firebase --');
const GUARD = `import('${pathToFileURL(path.join(BACKEND, 'config', 'productionSafetyGuard.js')).href}').then(({ isProductionProject }) => {
  if (process.env.HPMS_ENV !== 'development') process.exit(10);
  if (isProductionProject()) process.exit(11);
  const p = process.env.FIREBASE_PROJECT_ID;
  if (p !== 'sky5-development') process.exit(12);
  if (/hpms/i.test(String(p))) process.exit(13);
  process.exit(0);
});`;
const guard = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', GUARD], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).status;
ok('59/60. missing HPMS_ENV fails closed', guard({ FIREBASE_PROJECT_ID: 'sky5-development' }) === 10);
ok('61. the production project fails closed even with HPMS_ENV=development', guard({ HPMS_ENV: 'development', FIREBASE_PROJECT_ID: 'hpms-sky5' }) === 11);
ok('62. a staging or unknown project fails closed', guard({ HPMS_ENV: 'development', FIREBASE_PROJECT_ID: 'sky5-staging' }) === 12 && guard({ HPMS_ENV: 'development', FIREBASE_PROJECT_ID: 'hpms-other' }) === 12);
ok('63. the DEV project passes', guard({ HPMS_ENV: 'development', FIREBASE_PROJECT_ID: 'sky5-development' }) === 0);

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H6 AUTHORITY IDENTITY: ${pass} passed, ${fail} failed (Part A only) ═══`);
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

// Synthetic secrets, in-process only. No Meta credential exists anywhere.
const APP_SECRET = 'h6_test_app_secret_value';
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = `h6_verify_${Date.now()}`;
process.env.WHATSAPP_VERIFICATION_SECRET = SECRET;
process.env.ENABLE_WHATSAPP_WEBHOOK = 'true';
process.env.ENABLE_WHATSAPP_VERIFICATION = 'true';
process.env.WHATSAPP_WEBHOOK_RATE_LIMIT_MAX = '500';

const { FieldPath } = await import('firebase-admin/firestore');
const express = (await import('express')).default;
const http = await import('http');
const whatsappRoutes = (await import('../routes/whatsappRoutes.js')).default;
const { computeSignatureHeader, SIGNATURE_PREFIX } = await import('../utils/whatsappSignature.js');
const { readBudgetMonitor } = await import('../utils/firestoreReadBudget.js');
const vsvc = await import('../services/whatsappAuthorityVerificationService.js');
const arepo = await import('../repositories/firestore/inventoryApprovalAuthoritiesRepository.js');
const brepo = await import('../repositories/firestore/whatsappNumberBindingsRepository.js');
const { getStaffByUidFirestore } = await import('../repositories/firestore/staffRepository.js');
const { PurchaseRequestApprovalService } = await import('../services/purchaseRequestApprovalService.js');
const actions = await import('../repositories/firestore/inventoryApprovalActionsRepository.js');
const { generateRawToken, hashToken } = await import('../utils/approvalActionToken.js');

// Capture every console line, so the plaintext-code sweep at the end is exhaustive.
const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { logged.push(a.map(String).join(' ')); orig(...a); };
}
let txnRuns = 0, txnGets = 0;
const origRunTransaction = db.runTransaction.bind(db);
db.runTransaction = (fn, opts) => origRunTransaction(async (t) => {
  txnRuns++;
  const g = t.get.bind(t), ga = t.getAll.bind(t);
  t.get = (...a) => { txnGets++; return g(...a); };
  t.getAll = (...a) => { txnGets += a.filter(x => x && typeof x.path === 'string').length; return ga(...a); };
  return fn(t);
}, opts);

// A faithful miniature of server.js.
const app = express();
app.use('/api/whatsapp', whatsappRoutes);
app.use(express.json());
const server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/api/whatsapp/webhook`;

const TS = Date.now();
const START_ISO = new Date(TS - 1000).toISOString();
const SUF = String(TS).slice(-8);
const NUM_A = `+9190${SUF}`;   // the authority under test
const NUM_C = `+9192${SUF}`;   // a stranger who is never registered
const NUM_D = `+9193${SUF}`;   // registered concurrently by two callers
const NUM_E = `+9194${SUF}`;   // A's replacement number
const digits = (e164) => e164.slice(1);
const ADMIN = { uid: `h6test_admin_${TS}`, name: 'H6 Admin', role: 'admin' };
const REQUESTER_UID = `h6test_requester_${TS}`;
const STAFF_DOC = `staff_${REQUESTER_UID}`;
const PR1 = `pr_h6test_a_${TS}`;
const PR2 = `pr_h6test_b_${TS}`;
const cleanup = { authorities: new Set(), numbers: new Set([NUM_A, NUM_D, NUM_E]), tokens: [], prs: [], wamids: [], staff: false, audits: [] };
const secrets = new Set();
let writes = 0, deletes = 0;
const r0 = readBudgetMonitor.estimatedReadsToday;
const iso = () => new Date().toISOString();
const expectCode = async (fn) => { try { await fn(); return 'no throw'; } catch (e) { return e.code || e.message; } };
const authority = (id) => arepo.getApprovalAuthorityByIdFirestore(id);
const binding = (e164) => brepo.getNumberBindingByNumberFirestore(e164);
const tokenDoc = (h) => db.collection('inventory_approval_actions').doc(h).get().then(s => s.data());
const prDoc = (id) => db.collection('purchase_requests').doc(id).get().then(s => s.data());
const auditRow = (id) => db.collection('audit_logs').doc(id).get().then(s => s.data());

let wamidSeq = 0;
/** A signed inbound text message from `from` (Meta digits), through the REAL router. */
const sendMessage = async (from, message, extraValue = {}) => {
  const wamid = `wamid.H6TEST${TS}.${++wamidSeq}`;
  cleanup.wamids.push(`msg:${wamid}`);
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'h6-entry', changes: [{ field: 'messages', value: { ...extraValue, messages: [{ id: wamid, from, ...message }] } }] }]
  });
  const r = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': computeSignatureHeader(Buffer.from(raw, 'utf8'), APP_SECRET) }, body: raw });
  return { status: r.status, json: await r.json(), wamid };
};
const sendText = (from, body, extraValue) => sendMessage(from, { type: 'text', text: { body } }, extraValue);
const lastOutcome = () => logged.filter(l => l.includes('[WhatsAppInbound]')).slice(-1)[0] || '';
const mint = async (prId, action, approverId) => {
  const t = await actions.createApprovalActionFirestore({
    pr_id: prId, pr_number: `PR-H6-${TS}`, approver_uid: approverId, action,
    expires_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(), created_by: 'h6_test'
  });
  writes++; cleanup.tokens.push(t.token_hash); secrets.add(t.raw_token);
  return t;
};
const plantIntent = async (prId, approverId, parentHash) => {
  const raw = generateRawToken(); const hash = hashToken(raw); secrets.add(raw);
  await db.collection('inventory_approval_actions').doc(hash).set({
    pr_id: prId, pr_number: `PR-H6-${TS}`, approver_uid: approverId, action: 'REJECTED', purpose: 'REASON_CAPTURE',
    parent_token_hash: parentHash, token_hash: hash, consumed_at: null, consumed_via: null, meta_message_id: null,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(), created_at: iso(), created_by: 'h6_test'
  }); writes++; cleanup.tokens.push(hash);
  return { raw, hash };
};
const svc = PurchaseRequestApprovalService;

try {
  // ── REGISTRATION ──────────────────────────────────────────────────────────
  console.log('  -- registration: 1/2/3/5/12 --');
  const reg = await vsvc.registerApprovalAuthority({ display_name: 'H6 Authority A', whatsapp_e164: `+91 90${SUF.slice(0, 4)}-${SUF.slice(4)}`, actor: ADMIN });
  writes += 3; const A = reg.authority; cleanup.authorities.add(A.authority_id);
  ok('1. authority_id is server generated', /^aa_[0-9a-f]{32}$/.test(A.authority_id), A.authority_id.slice(0, 12) + '…');
  ok('2. it is not a Firebase uid and no login exists for it', !/^[A-Za-z0-9]{28}$/.test(A.authority_id) && (await getStaffByUidFirestore(A.authority_id)) === null);
  ok('3. authority_type is EXTERNAL', A.authority_type === 'EXTERNAL');
  ok('5. linked_staff_uid is null when not supplied', A.linked_staff_uid === null);
  ok('6. the number was normalised to E.164', A.whatsapp_e164 === NUM_A);
  ok('12. it starts PENDING_VERIFICATION and inactive', A.verification_status === 'PENDING_VERIFICATION' && A.is_active === false && A.whatsapp_verified_at === null);
  const b0 = await binding(NUM_A);
  ok('  the number is bound to this authority, with no challenge yet', b0?.authority_id === A.authority_id && b0?.status === 'PENDING' && b0?.challenge_code_hmac === null);
  ok('  a stored authority never carries a role', !('role' in A));

  console.log('\n  -- number uniqueness: 7/8/9 --');
  ok('8. the same number cannot be registered again', await expectCode(() => vsvc.registerApprovalAuthority({ display_name: 'Impostor', whatsapp_e164: NUM_A, actor: ADMIN })) === 'NUMBER_ALREADY_BOUND');
  const race = await Promise.allSettled([
    vsvc.registerApprovalAuthority({ display_name: 'H6 D one', whatsapp_e164: NUM_D, actor: ADMIN }),
    vsvc.registerApprovalAuthority({ display_name: 'H6 D two', whatsapp_e164: NUM_D, actor: ADMIN })
  ]);
  const dWins = race.filter(x => x.status === 'fulfilled');
  const dLoss = race.filter(x => x.status === 'rejected').map(x => x.reason?.code);
  writes += 3;
  ok('7. two concurrent registrations of one number yield exactly one authority', dWins.length === 1 && dLoss.length === 1 && dLoss[0] === 'NUMBER_ALREADY_BOUND', `loser=${dLoss[0]}`);
  const D = dWins[0].value.authority; cleanup.authorities.add(D.authority_id);
  ok('  and the binding names the winner', (await binding(NUM_D))?.authority_id === D.authority_id);

  console.log('\n  -- unverified: 28 + cannot decide --');
  ok('28. an unverified authority cannot be activated', await expectCode(() => vsvc.activateApprovalAuthority({ authority_id: A.authority_id, actor: ADMIN })) === 'AUTHORITY_NOT_VERIFIED');
  await db.collection('purchase_requests').doc(PR1).set({
    request_id: PR1, request_number: `PR-H6-A-${TS}`, status: 'PENDING_APPROVAL', requested_by_uid: REQUESTER_UID,
    requested_by_name: 'H6 Requester', department: 'Kitchen', location_id: null, business_date: iso().slice(0, 10),
    item_count: 0, total_estimated_value: 0, approvals: [], status_history: [], created_at: iso(), updated_at: iso()
  }); writes++; cleanup.prs.push(PR1);
  const T_app1 = await mint(PR1, 'APPROVE', A.authority_id);
  ok('  an unverified authority cannot decide, even holding a valid token',
    await expectCode(() => svc.decideWithApprovalActionToken({ raw_token: T_app1.raw_token, decided_by_uid: A.authority_id, action: 'APPROVED' })) === 'AUTHORITY_NOT_VERIFIED');

  // ── VERIFICATION ──────────────────────────────────────────────────────────
  console.log('\n  -- challenge: 13/14/15/16 --');
  let ch = await vsvc.issueVerificationChallenge({ authority_id: A.authority_id, actor: ADMIN }); writes += 2; secrets.add(ch.code);
  ok('13. a challenge is issued with an 8-digit code and a 15-minute expiry', /^[0-9]{8}$/.test(ch.code) && Date.parse(ch.expires_at) - Date.now() <= 15 * 60 * 1000 + 5000);
  const b1 = await binding(NUM_A);
  ok('14. the binding stores a 64-hex HMAC, not the code', /^[0-9a-f]{64}$/.test(b1.challenge_code_hmac) && !JSON.stringify(b1).includes(ch.code));
  ok('  the authority document holds no code either', !JSON.stringify(await authority(A.authority_id)).includes(ch.code));
  ok('  the number is masked in the challenge response', ch.whatsapp_masked === `+9190****${SUF.slice(-4)}`);

  console.log('\n  -- wrong code, wrong sender, override attempt: 18/23/24/52 --');
  let wrong = ch.code === '00000000' ? '11111111' : '00000000';
  let r = await sendText(digits(NUM_A), `my code is ${wrong}`); writes += 2;
  ok('18. a wrong code from the right sender is refused', r.status === 200 && lastOutcome().includes('VERIFICATION_WRONG_CODE'));
  ok('  and counted', (await binding(NUM_A)).challenge_attempts === 1);
  r = await sendText(digits(NUM_C), ch.code); writes += 2;
  ok('23. the correct code from the WRONG sender is refused', lastOutcome().includes('VERIFICATION_UNKNOWN_SENDER'));
  const b2 = await binding(NUM_A);
  ok('24. and the real challenge was neither consumed nor charged', b2.challenge_code_hmac === b1.challenge_code_hmac && b2.challenge_consumed_at === null && b2.challenge_attempts === 1);
  ok('  the wrong sender learns nothing from the response', JSON.stringify(r.json) === JSON.stringify({ received: 1, claimed: 1, duplicates: 0 }));
  r = await sendText(digits(NUM_C), ch.code, { contacts: [{ wa_id: digits(NUM_A) }], metadata: { sender: digits(NUM_A) }, sender: digits(NUM_A) }); writes += 2;
  ok('52. extra payload fields claiming the right sender cannot override the attested one', lastOutcome().includes('VERIFICATION_UNKNOWN_SENDER'));
  ok('  the authority is still unverified', (await authority(A.authority_id)).verification_status === 'PENDING_VERIFICATION');

  console.log('\n  -- expiry and replacement: 19/22 --');
  await db.collection('whatsapp_number_bindings').doc(brepo.numberBindingRef(NUM_A).id).update({ challenge_expires_at: new Date(Date.now() - 1000).toISOString() }); writes++;
  r = await sendText(digits(NUM_A), ch.code); writes++;
  ok('19. an expired code is refused', lastOutcome().includes('VERIFICATION_EXPIRED'));
  const oldCode = ch.code;
  ch = await vsvc.issueVerificationChallenge({ authority_id: A.authority_id, actor: ADMIN }); writes += 2; secrets.add(ch.code);
  ok('22. a new challenge replaces the old one', (await binding(NUM_A)).challenge_code_hmac !== b1.challenge_code_hmac && (await binding(NUM_A)).challenge_attempts === 0);
  r = await sendText(digits(NUM_A), oldCode); writes += 2;
  ok('  and the old code no longer works', oldCode === ch.code || lastOutcome().includes('VERIFICATION_WRONG_CODE'));

  console.log('\n  -- attempt limit: 20 --');
  let outcomes = [];
  for (let i = 0; i < 4; i++) { wrong = String(22222222 + i).padStart(8, '0'); if (wrong === ch.code) wrong = '33333333'; await sendText(digits(NUM_A), wrong); writes += 2; outcomes.push(lastOutcome()); }
  ok('20. the fifth wrong guess exhausts and destroys the challenge', outcomes[3].includes('VERIFICATION_EXHAUSTED') && (await binding(NUM_A)).challenge_code_hmac === null);
  await sendText(digits(NUM_A), ch.code); writes++;
  ok('  even the correct code is now refused', lastOutcome().includes('VERIFICATION_NO_CHALLENGE'));

  console.log('\n  -- success: 17/21/25/26/27/48/50 --');
  ch = await vsvc.issueVerificationChallenge({ authority_id: A.authority_id, actor: ADMIN }); writes += 2; secrets.add(ch.code);
  r = await sendText(digits(NUM_A), `Verification: ${ch.code}`); writes += 3;
  const verifiedWamid = r.wamid;
  ok('17/48. the correct code from the registered number, through the signed webhook, verifies', lastOutcome().includes('VERIFICATION_VERIFIED'));
  let a1 = await authority(A.authority_id);
  const bv = await binding(NUM_A);
  ok('25. authority and binding moved together', a1.verification_status === 'VERIFIED' && bv.status === 'VERIFIED' && bv.challenge_code_hmac === null && typeof bv.challenge_consumed_at === 'string');
  ok('  the attested sender is recorded on both', a1.verified_sender_id === digits(NUM_A) && bv.verified_sender_id === digits(NUM_A) && a1.whatsapp_verification_method === 'WHATSAPP_INBOUND_CODE');
  const days = (Date.parse(a1.verification_expires_at) - Date.parse(a1.whatsapp_verified_at)) / 86400000;
  ok('26. verification expires 180 days after verification', Math.abs(days - 180) < 0.01, `${days.toFixed(3)} days`);
  ok('27. verification did NOT activate the authority', a1.is_active === false);
  await sendText(digits(NUM_A), ch.code); writes++;
  ok('21. replaying the consumed code is refused', lastOutcome().includes('VERIFICATION_REPLAY'));
  const dupRaw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'h6-entry', changes: [{ field: 'messages', value: { messages: [{ id: verifiedWamid, from: digits(NUM_A), type: 'text', text: { body: ch.code } }] } }] }] });
  const dup = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': computeSignatureHeader(Buffer.from(dupRaw, 'utf8'), APP_SECRET) }, body: dupRaw });
  ok('50. a re-delivered webhook event is a duplicate and is not dispatched', (await dup.json()).duplicates === 1);
  const bad = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `${SIGNATURE_PREFIX}${'a'.repeat(64)}` }, body: dupRaw });
  ok('49. an invalid signature is refused before anything is read', bad.status === 403);
  const vAudit = (await db.collection('audit_logs').where(FieldPath.documentId(), '>=', `audit_inv_wa_${A.authority_id}_`).where(FieldPath.documentId(), '<', `audit_inv_wa_${A.authority_id}_`).get()).docs.map(d => d.data());
  ok('  audit trail: created, challenge issued ×3, verified, failures — with masked numbers and no code',
    vAudit.some(x => x.action === 'INVENTORY_APPROVAL_AUTHORITY_VERIFIED') && vAudit.filter(x => x.action === 'INVENTORY_APPROVAL_AUTHORITY_CHALLENGE_ISSUED').length === 3 &&
    vAudit.every(x => !x.details.includes(NUM_A) && ![...secrets].some(s => x.details.includes(s))), `${vAudit.length} rows`);

  // ── ACTIVATION ────────────────────────────────────────────────────────────
  console.log('\n  -- activation: 29/30/31 --');
  a1 = await vsvc.activateApprovalAuthority({ authority_id: A.authority_id, actor: ADMIN }); writes += 2;
  ok('31. a verified authority can be activated', a1.is_active === true);
  await db.collection('inventory_approval_authorities').doc(A.authority_id).update({ verification_expires_at: new Date(Date.now() - 1000).toISOString() }); writes++;
  ok('29. an expired verification cannot be activated', await expectCode(() => vsvc.activateApprovalAuthority({ authority_id: A.authority_id, actor: ADMIN })) === 'AUTHORITY_VERIFICATION_EXPIRED');
  ok('  and cannot decide, even while still flagged active',
    await expectCode(() => svc.decideWithApprovalActionToken({ raw_token: T_app1.raw_token, decided_by_uid: A.authority_id, action: 'APPROVED' })) === 'AUTHORITY_VERIFICATION_EXPIRED');
  await db.collection('inventory_approval_authorities').doc(A.authority_id).update({ verification_expires_at: new Date(Date.now() + 179 * 86400000).toISOString() }); writes++;
  await vsvc.revokeApprovalAuthorityVerification({ authority_id: A.authority_id, actor: ADMIN }); writes += 3;
  let a2 = await authority(A.authority_id);
  ok('  revocation clears verification and deactivates', a2.verification_status === 'REVOKED' && a2.is_active === false && a2.verified_sender_id === null);
  ok('30. a revoked authority cannot be activated', await expectCode(() => vsvc.activateApprovalAuthority({ authority_id: A.authority_id, actor: ADMIN })) === 'AUTHORITY_REVOKED');
  ch = await vsvc.issueVerificationChallenge({ authority_id: A.authority_id, actor: ADMIN }); writes += 2; secrets.add(ch.code);
  await sendText(digits(NUM_A), ch.code); writes += 3;
  a2 = await authority(A.authority_id);
  ok('  re-verification restores VERIFIED but does NOT reactivate', a2.verification_status === 'VERIFIED' && a2.is_active === false);
  await vsvc.activateApprovalAuthority({ authority_id: A.authority_id, actor: ADMIN }); writes += 2;

  // ── H3 ────────────────────────────────────────────────────────────────────
  console.log('\n  -- H3: 32/33/37/38/39/40/42 --');
  await db.collection('staff').doc(STAFF_DOC).set({ staff_id: STAFF_DOC, user_uid: REQUESTER_UID, username: `h6req_${TS}`, full_name: 'H6 Requester', role: 'admin', phone: '9111111111', status: 'Active', is_active: true, created_at: iso(), updated_at: iso() }); writes++; cleanup.staff = true;
  ok('33. no staff record exists for the authority, and none is needed', (await getStaffByUidFirestore(A.authority_id)) === null);
  const T_other = await mint(PR1, 'APPROVE', D.authority_id);
  ok('38. a token issued to another authority is refused', await expectCode(() => svc.decideWithApprovalActionToken({ raw_token: T_other.raw_token, decided_by_uid: A.authority_id, action: 'APPROVED' })) === 'TOKEN_APPROVER_MISMATCH');
  await db.collection('purchase_requests').doc(PR2).set({ request_id: PR2, request_number: `PR-H6-B-${TS}`, status: 'PENDING_APPROVAL', requested_by_uid: `h6test_other_requester_${TS}`, requested_by_name: 'H6 Requester 2', department: 'Kitchen', location_id: null, business_date: iso().slice(0, 10), item_count: 0, total_estimated_value: 0, approvals: [], status_history: [], created_at: iso(), updated_at: iso() }); writes++; cleanup.prs.push(PR2);
  const T_app2 = await mint(PR2, 'APPROVE', A.authority_id);
  ok('39. a token for another request is refused', await expectCode(() => svc.decideWithApprovalActionToken({ raw_token: T_app2.raw_token, decided_by_uid: A.authority_id, action: 'APPROVED', request_id: PR1 })) === 'TOKEN_PR_MISMATCH');
  const upd = await vsvc.updateApprovalAuthorityDisplay({ authority_id: A.authority_id, linked_staff_uid: REQUESTER_UID, actor: ADMIN }); writes += 2;
  ok('  linking a staff member with a different phone on file raises an advisory warning only', upd.warnings.includes('LINKED_STAFF_PHONE_MISMATCH') && upd.authority.linked_staff_uid === REQUESTER_UID);
  ok('40. self-approval is blocked through linked_staff_uid', await expectCode(() => svc.decideWithApprovalActionToken({ raw_token: T_app1.raw_token, decided_by_uid: A.authority_id, action: 'APPROVED' })) === 'PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN');
  await vsvc.updateApprovalAuthorityDisplay({ authority_id: A.authority_id, linked_staff_uid: null, actor: ADMIN }); writes += 2;
  await vsvc.deactivateApprovalAuthority({ authority_id: A.authority_id, actor: ADMIN }); writes += 2;
  ok('32. a deactivated authority cannot decide', await expectCode(() => svc.decideWithApprovalActionToken({ raw_token: T_app1.raw_token, decided_by_uid: A.authority_id, action: 'APPROVED' })) === 'AUTHORITY_INACTIVE');
  await vsvc.activateApprovalAuthority({ authority_id: A.authority_id, actor: ADMIN }); writes += 2;
  ok('  none of those refusals consumed the token', (await tokenDoc(T_app1.token_hash)).consumed_at === null);
  const runsAtRace = txnRuns;
  const settled = await Promise.allSettled([
    svc.decideWithApprovalActionToken({ raw_token: T_app1.raw_token, decided_by_uid: A.authority_id, action: 'APPROVED' }),
    svc.decideWithApprovalActionToken({ raw_token: T_app1.raw_token, decided_by_uid: A.authority_id, action: 'APPROVED' })
  ]);
  writes += 4; cleanup.audits.push(`audit_inv_pr_inventory_pr_approved_${PR1}`);
  const wins = settled.filter(s => s.status === 'fulfilled' && s.value?.duplicate === false);
  ok('42. two concurrent taps yield exactly one decision', wins.length === 1 && settled.some(s => s.status === 'rejected' && s.reason?.code === 'TOKEN_CONSUMED'), `runs=${txnRuns - runsAtRace}`);
  const pr1 = await prDoc(PR1);
  ok('37. the decision is recorded against the opaque authority id, with no role', pr1.status === 'APPROVED' && pr1.approvals.length === 1 && pr1.approvals[0].approver_uid === A.authority_id && pr1.approvals[0].approver_role === null);
  const prAudit = await auditRow(`audit_inv_pr_inventory_pr_approved_${PR1}`);
  ok('  the decision audit names the channel and the principal type', prAudit && prAudit.details.includes('"approver_type":"EXTERNAL"') && prAudit.details.includes('"decision_channel":"APPROVAL_ACTION_TOKEN"'));
  ok('  the other authority\'s sibling token was retired', (await tokenDoc(T_other.token_hash)).consumed_via === 'INVALIDATED:PR_APPROVED');

  // ── H4 ────────────────────────────────────────────────────────────────────
  console.log('\n  -- H4: 43/44/45/46/47 and not-routed 53/54 --');
  const T_rej2 = await mint(PR2, 'REJECT', A.authority_id);
  await sendText(digits(NUM_A), 'APPROVE'); writes++;
  ok('53. an "APPROVE" text from a verified authority is not routed anywhere', lastOutcome().includes('IGNORED_NOT_A_CODE'));
  // A control whose payload is not an H7 action: recognised as not-an-action,
  // and critically it consumes nothing, so the token below is still usable.
  await sendMessage(digits(NUM_A), { type: 'button', button: { payload: `hpms:REJECT:${T_rej2.raw_token}`, text: 'Reject' } }); writes++;
  ok('54. a control carrying a foreign payload decides nothing', lastOutcome().includes('NOT_AN_ACTION'));
  ok('  and no token was consumed by either', (await tokenDoc(T_rej2.token_hash)).consumed_at === null && (await tokenDoc(T_app2.token_hash)).consumed_at === null);
  const intent = await svc.beginTokenRejection({ raw_token: T_rej2.raw_token, decided_by_uid: A.authority_id }); writes++; cleanup.tokens.push(hashToken(intent.raw_token)); secrets.add(intent.raw_token);
  ok('43. an external authority can begin an H4 rejection', /^[A-Za-z0-9_-]{43}$/.test(intent.raw_token) && intent.reason_codes.includes('BUDGET_UNAVAILABLE'));
  ok('45. an unknown reason code is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: intent.raw_token, reason_code: 'NOT_A_REASON' })) === 'REJECTION_REASON_CODE_INVALID');
  ok('46. free text is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: intent.raw_token, reason_code: 'BUDGET_UNAVAILABLE', reason: 'because' })) === 'REJECTION_REASON_TEXT_NOT_ACCEPTED');
  const badParent = await plantIntent(PR2, A.authority_id, T_app2.token_hash);
  ok('44. an intent whose parent is an APPROVE token is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: badParent.raw, reason_code: 'BUDGET_UNAVAILABLE' })) === 'TOKEN_PARENT_MISMATCH');
  const rej = await svc.completeTokenRejection({ raw_token: intent.raw_token, reason_code: 'BUDGET_UNAVAILABLE' }); writes += 4; cleanup.audits.push(`audit_inv_pr_inventory_pr_rejected_${PR2}`);
  ok('  the external authority completed the rejection through the existing engine', rej.duplicate === false && rej.request.status === 'REJECTED' && rej.request.rejection_reason === 'Budget is not available for this request.');
  ok('47. replaying the intent is refused', await expectCode(() => svc.completeTokenRejection({ raw_token: intent.raw_token, reason_code: 'BUDGET_UNAVAILABLE' })) === 'TOKEN_CONSUMED');

  // ── NUMBER CHANGE ─────────────────────────────────────────────────────────
  console.log('\n  -- number change: 9/10/11 --');
  const a3 = await vsvc.changeApprovalAuthorityNumber({ authority_id: A.authority_id, whatsapp_e164: NUM_E, actor: ADMIN }); writes += 4;
  ok('10. changing the number invalidates the old verification and deactivates', a3.whatsapp_e164 === NUM_E && a3.verification_status === 'PENDING_VERIFICATION' && a3.is_active === false && a3.verified_sender_id === null);
  ok('9. the old binding is released and the new one is pending', (await binding(NUM_A)) === null && (await binding(NUM_E))?.status === 'PENDING');
  await sendText(digits(NUM_A), '12345678'); writes++;
  ok('  the old number is now a stranger', lastOutcome().includes('VERIFICATION_UNKNOWN_SENDER'));
  ch = await vsvc.issueVerificationChallenge({ authority_id: A.authority_id, actor: ADMIN }); writes += 2; secrets.add(ch.code);
  await sendText(digits(NUM_E), ch.code); writes += 3;
  ok('11. the new number verifies afresh, from the new number', lastOutcome().includes('VERIFICATION_VERIFIED') && (await authority(A.authority_id)).verified_sender_id === digits(NUM_E));

  console.log('\n  -- 15. nothing secret was ever printed --');
  const blob = logged.join('\n');
  const leakedKind = [...secrets].some(s => s && s.length === 8 && blob.includes(s)) ? 'code'
    : [...secrets].some(s => s && s.length === 43 && blob.includes(s)) ? 'token'
      : (blob.includes(NUM_A) || blob.includes(digits(NUM_A)) || blob.includes(NUM_E) || blob.includes(digits(NUM_E))) ? 'number' : null;
  ok('no verification code, token or number appears in any console line', leakedKind === null, leakedKind ? `LEAKED: ${leakedKind}` : `${secrets.size} secrets checked`);
} finally {
  await new Promise(r => server.close(r));
  console.log('\n  -- cleanup: only this run\'s synthetic documents --');
  for (const id of cleanup.authorities) { await db.collection('inventory_approval_authorities').doc(id).delete(); deletes++; }
  for (const n of cleanup.numbers) { await db.collection('whatsapp_number_bindings').doc(`wa_${n.slice(1)}`).delete(); deletes++; }
  for (const h of cleanup.tokens) { await db.collection('inventory_approval_actions').doc(h).delete(); deletes++; }
  for (const id of cleanup.prs) { await db.collection('purchase_requests').doc(id).delete(); deletes++; }
  for (const id of cleanup.wamids) { await db.collection('whatsapp_webhook_events').doc(id).delete(); deletes++; }
  for (const id of cleanup.audits) { await db.collection('audit_logs').doc(id).delete(); deletes++; }
  if (cleanup.staff) { await db.collection('staff').doc(STAFF_DOC).delete(); deletes++; }
  for (const id of [...cleanup.authorities, 'unknown']) {
    const rows = await db.collection('audit_logs').where(FieldPath.documentId(), '>=', `audit_inv_wa_${id}_`).where(FieldPath.documentId(), '<', `audit_inv_wa_${id}_`).get();
    for (const d of rows.docs) { if (id !== 'unknown' || d.data().created_at >= START_ISO) { await d.ref.delete(); deletes++; } }
  }
  const leftA = await db.collection('inventory_approval_authorities').where('authority_id', 'in', [...cleanup.authorities]).get();
  const leftB = await db.collection('whatsapp_number_bindings').where('authority_id', 'in', [...cleanup.authorities]).get();
  ok('no orphan authorities, bindings or challenges remain', leftA.size === 0 && leftB.size === 0, `deleted ${deletes}`);
}

const reads = readBudgetMonitor.estimatedReadsToday - r0 + txnGets;
console.log(`\n═══ H6 AUTHORITY IDENTITY: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
console.log(`\n[DEV READS ~${reads}]  (repository ${readBudgetMonitor.estimatedReadsToday - r0} + transaction ${txnGets} across ${txnRuns} runs)`);
console.log(`[DEV WRITES ~${writes}]  [DEV DELETES ${deletes}]  [PRODUCTION ACCESS] 0  [META CALLS] 0  [WHATSAPP MESSAGES SENT] 0`);
process.exit(fail === 0 ? 0 : 1);
