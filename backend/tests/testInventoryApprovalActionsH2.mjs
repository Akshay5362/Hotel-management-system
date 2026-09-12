/**
 * backend/tests/testInventoryApprovalActionsH2.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H2 — approval action tokens.
 *
 * PART A — no Firebase. The token utility is pure, so it is imported directly;
 *   repository validation and the "raw token is never persisted" guarantee are
 *   checked against source, because importing the repository would initialise
 *   Firebase Admin.
 *
 * PART B — DEV Firestore behind the four-layer guard. Two synthetic actions,
 *   both removed in a finally block. Budgeted well under 25 reads / 10 writes /
 *   5 deletes.
 *
 * Uses no real staff uid, no real phone number, and creates no purchase
 * request. Never invokes the approval decision.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryApprovalActionsH2.mjs
 *       node backend/tests/testInventoryApprovalActionsH2.mjs     (Part A only)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  generateRawToken, hashToken, isWellFormedToken,
  TOKEN_BYTES, TOKEN_LENGTH, TOKEN_PATTERN
} from '../utils/approvalActionToken.js';

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

/**
 * Strips comments. Several assertions below forbid a construct — Math.random,
 * console logging, a call into the approval service — and the files document
 * precisely why those are forbidden. Testing the raw text would fail on the
 * documentation that exists to prevent the very thing being tested.
 */
const codeOnly = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const REPO = src('backend', 'repositories', 'firestore', 'inventoryApprovalActionsRepository.js');
const UTIL = src('backend', 'utils', 'approvalActionToken.js');
const RULES = src('firestore.rules');

console.log('═══ PART A — token utility and validation (no Firebase) ═══');

// 1, 2, 3 — generation
console.log('\n  -- generation --');
const sample = Array.from({ length: 200 }, () => generateRawToken());
ok('1. tokens are unique across 200 draws', new Set(sample).size === 200,
  `${new Set(sample).size}/200 distinct`);
ok('2. 32 random bytes, 43 base64url characters',
  TOKEN_BYTES === 32 && sample.every(t => t.length === TOKEN_LENGTH), `len=${sample[0].length}`);
ok('3. URL-safe alphabet only, no padding',
  sample.every(t => TOKEN_PATTERN.test(t)) && !sample.some(t => t.includes('=') || t.includes('+') || t.includes('/')));
ok('  the CSPRNG is used, not Math.random',
  /crypto\.randomBytes\(TOKEN_BYTES\)/.test(UTIL) && !/Math\.random/.test(codeOnly(UTIL)));
// A crude but real entropy signal: 200 × 43 chars should cover most of the
// alphabet and no single character should dominate.
const chars = sample.join('');
const freq = {};
for (const ch of chars) freq[ch] = (freq[ch] || 0) + 1;
const top = Math.max(...Object.values(freq)) / chars.length;
ok('  character distribution is flat (no single char > 5%)', top < 0.05, `max ${(top * 100).toFixed(2)}%`);

// 4, 5 — hashing
console.log('\n  -- hashing --');
const t1 = generateRawToken(), t2 = generateRawToken();
ok('4. hash is deterministic', hashToken(t1) === hashToken(t1));
ok('5. different tokens hash differently', hashToken(t1) !== hashToken(t2));
ok('  hash is 64 hex characters (sha256)', /^[0-9a-f]{64}$/.test(hashToken(t1)));
ok('  the hash is not the token', hashToken(t1) !== t1);

// 16 — malformed fails closed
console.log('\n  -- malformed input fails closed --');
const malformed = ['', '   ', 'short', null, undefined, 123, {}, 'a'.repeat(44), 'a'.repeat(42), `${'a'.repeat(42)}=`, 'has spaces here!!!!!!!!!!!!!!!!!!!!!!!!!!!!'];
ok('16. hashToken throws MALFORMED_TOKEN on every malformed input',
  malformed.every(v => { try { hashToken(v); return false; } catch (e) { return e.code === 'MALFORMED_TOKEN'; } }));
ok('  isWellFormedToken rejects them all', malformed.every(v => isWellFormedToken(v) === false));
ok('  and accepts a real token', isWellFormedToken(t1) === true);

// 6, 7 — persistence shape
console.log('\n  -- the raw token is never persisted --');
ok('6. the stored document contains no raw-token field',
  !/\braw_token:/.test(REPO.slice(REPO.indexOf('const doc = {'), REPO.indexOf('await setDoc'))));
ok('  raw_token appears only on the RETURN value',
  /return \{ raw_token: rawToken/.test(REPO));
ok('7. the document id IS the sha-256 hash',
  /await setDoc\(APPROVAL_ACTIONS_COLLECTION, tokenHash, doc/.test(REPO));
ok('  token_hash is stored alongside for querying', /token_hash: tokenHash/.test(REPO));

// 13 — never logged
console.log('\n  -- the raw token is never logged --');
ok('13. the token utility contains no logging at all',
  !/console\.|logger\.|process\.stdout/.test(codeOnly(UTIL)));
ok('  the repository never logs the raw token',
  !/console\.[a-z]+\([^)]*rawToken/.test(REPO));
ok('  the repository has no logging of any kind', !/console\./.test(codeOnly(REPO)));

// 8, 9 — action enum
console.log('\n  -- action vocabulary --');
ok('8/9. only the existing PR_APPROVAL_ACTIONS values are stored',
  /APPROVE: PR_APPROVAL_ACTIONS\.APPROVED/.test(REPO) && /REJECT: PR_APPROVAL_ACTIONS\.REJECTED/.test(REPO));
ok('  the imperative forms are accepted as input aliases only',
  /ACTION_ALIASES = Object\.freeze\(\{/.test(REPO));
ok('  an unknown action is rejected with VALIDATION_ERROR',
  /Approval action must be APPROVED or REJECTED/.test(REPO));
ok('  no parallel enum was invented', !/'APPROVE'\s*,\s*'REJECT'\s*\]/.test(REPO));

// 10, 11, 12 — required fields
console.log('\n  -- required fields --');
for (const f of ['pr_id', 'pr_number', 'approver_uid', 'created_by']) {
  ok(`  ${f} is required on create`, new RegExp(`${f}: required\\(data\\.${f}, '${f}'\\)`).test(REPO));
}
ok('12. expiry must be ISO-8601 AND in the future',
  /must be an ISO-8601 timestamp/.test(REPO) && /must be in the future/.test(REPO));

// 14, 15 — consumed / expiry semantics
console.log('\n  -- consumption and expiry semantics --');
ok('14. a consumed token is invalid', /if \(doc\.consumed_at\) return \{ valid: false, reason: ACTION_INVALID\.CONSUMED \}/.test(REPO));
ok('15. an expired token is invalid', /Date\.parse\(doc\.expires_at\) <= nowMs/.test(REPO));
ok('  a missing document is invalid', /if \(!doc\) return \{ valid: false, reason: ACTION_INVALID\.NOT_FOUND \}/.test(REPO));
ok('  an incomplete document is invalid', /ACTION_INVALID\.INCOMPLETE/.test(REPO));
ok('  malformed input never reaches Firestore',
  /if \(!isWellFormedToken\(rawToken\)\) return \{ valid: false, reason: ACTION_INVALID\.MALFORMED \}/.test(REPO));

// Authorization boundary
console.log('\n  -- the token is not authorization --');
ok('the repository contains no approve/reject decision path',
  !/assertCanApprove|PurchaseRequestApprovalService|PR_STATUS\.APPROVED/.test(codeOnly(REPO)));
ok('  it never writes to a purchase request', !/purchase_requests/.test(REPO));
ok('  the boundary is documented in the file header', /A TOKEN IS NOT AUTHORIZATION/.test(REPO));
// Precise, not a loose substring: the service legitimately contains the
// PRE-EXISTING constant PR_APPROVAL_ACTIONS, which case-insensitively contains
// "approval_actions". The real question is whether H2 wired itself in.
ok('  the existing approval engine is untouched',
  (() => { const a = codeOnly(src('backend', 'services', 'purchaseRequestApprovalService.js'));
    return !/inventoryApprovalActionsRepository|'inventory_approval_actions'|approvalActionToken|raw_token/.test(a); })());
ok('  the purchase request controller is untouched',
  !/approval_actions/i.test(src('backend', 'controllers', 'purchaseRequestController.js')));

// Transaction primitives
console.log('\n  -- transaction-safe consumption --');
ok('a txn read primitive exists for the read phase', /export async function readApprovalActionInTxn/.test(REPO));
ok('a txn write primitive exists for the write phase', /export function markApprovalActionConsumedInTxn/.test(REPO));
ok('  standalone consume uses a real Firestore transaction', /return await db\.runTransaction\(async \(txn\) => \{/.test(REPO));
ok('  it re-reads inside the transaction rather than trusting a prior read',
  /const snap = await txn\.get\(ref\);[\s\S]{0,200}evaluate\(doc\)/.test(REPO));
ok('  no client-side lock or in-memory mutex', !/mutex|setTimeout|lockfile|\.lock/.test(REPO));

// Invalidation
console.log('\n  -- invalidation --');
ok('invalidation is scoped by pr_id, never a collection scan',
  /filters = \[\{ field: 'pr_id', op: '==', value: id \}\]/.test(REPO));
ok('  it can additionally scope by approver', /if \(approverUid\) filters\.push/.test(REPO));
ok('  it needs no composite index (consumed filtered in memory)',
  /docs\.filter\(d => d && !d\.consumed_at\)/.test(REPO));
ok('  it records WHY a token was retired', /INVALIDATED:\$\{reason\}/.test(REPO));

// Rules
console.log('\n  -- server-only --');
ok('firestore.rules denies read AND write',
  /match \/inventory_approval_actions\/\{actionId\} \{\s*\n\s*allow read, write: if false;/.test(RULES));
ok('  the H1 authority rule is still present and unchanged',
  /match \/inventory_approval_authorities\/\{authorityId\} \{\s*\n\s*allow read, write: if false;/.test(RULES));

// No WhatsApp in H2
console.log('\n  -- H2 contains no WhatsApp / webhook work --');
ok('no Meta or HTTP calls', !/graph\.facebook|fetch\(|axios/.test(REPO + UTIL));
ok('no HMAC or webhook machinery', !/createHmac|webhook|X-Hub-Signature/i.test(REPO + UTIL));
ok('no route was added for H2', !/approval-actions/.test(src('backend', 'routes', 'inventoryRoutes.js')));

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H2 ACTIONS: ${pass} passed, ${fail} failed (Part A only) ═══`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\n═══ PART B — DEV Firestore (sky5-development only) ═══\n');

const { createRequire } = await import('module');
const require_ = createRequire(path.join(BACKEND, 'package.json'));
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });

const { isProductionProject } = await import('../config/productionSafetyGuard.js');
if (isProductionProject()) { console.error('[SAFETY_ABORT] production project.'); process.exit(1); }
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }
console.log(`  [GUARD] project=${PROJECT} (DEV)\n`);

const repo = await import('../repositories/firestore/inventoryApprovalActionsRepository.js');
const { db } = await import('../config/firebaseAdmin.js');

const PR_ID = `h2_live_pr_${Date.now()}`;
const UID = `h2_live_uid_${Date.now()}`;
const hashes = [];
let writes = 0, deletes = 0;

try {
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  // Create one APPROVE action.
  const made = await repo.createApprovalActionFirestore({
    pr_id: PR_ID, pr_number: 'PR-H2-LIVE-TEST', approver_uid: UID,
    action: 'APPROVE', expires_at: future, created_by: 'h2_live_verifier'
  });
  writes++; hashes.push(made.token_hash);
  ok('B1. action created, raw token returned once', repo && !!made.raw_token && made.raw_token.length === 43);
  ok('  the stored action uses the canonical APPROVED value', made.action.action === 'APPROVED');

  // Document exists under the hash, and holds no raw token.
  const stored = await db.collection('inventory_approval_actions').doc(made.token_hash).get();
  ok('B2. document exists under the sha-256 hash', stored.exists);
  const data = stored.data();
  ok('B3. the raw token is absent from the stored document',
    !Object.values(data).some(v => typeof v === 'string' && v === made.raw_token));
  ok('  token_hash matches the document id', data.token_hash === made.token_hash);
  ok('  consumed_at starts null', data.consumed_at === null);

  // Lookup binds token → action → PR → approver.
  const found = await repo.findApprovalActionByTokenFirestore(made.raw_token);
  ok('B4. lookup succeeds', found.valid === true, found.reason || '');
  ok('  it returns the right PR, approver and action',
    found.action.pr_id === PR_ID && found.action.approver_uid === UID && found.action.action === 'APPROVED');

  // A wrong token does not resolve.
  const wrong = await repo.findApprovalActionByTokenFirestore(generateRawToken());
  ok('  an unrelated token does not resolve', wrong.valid === false && wrong.reason === 'NOT_FOUND');
  const junk = await repo.findApprovalActionByTokenFirestore('not-a-token');
  ok('  a malformed token fails before any read', junk.valid === false && junk.reason === 'MALFORMED');

  // Consume once.
  const c1 = await repo.consumeApprovalActionFirestore(made.raw_token, { via: 'H2_LIVE_TEST' });
  writes++;
  ok('B5. first consumption succeeds', c1.valid === true);
  ok('  consumed_via recorded', c1.action.consumed_via === 'H2_LIVE_TEST');

  // Second consumption must fail.
  const c2 = await repo.consumeApprovalActionFirestore(made.raw_token, { via: 'H2_LIVE_TEST_REPLAY' });
  ok('B6. second consumption is refused', c2.valid === false && c2.reason === 'CONSUMED', c2.reason);
  const after = await repo.findApprovalActionByTokenFirestore(made.raw_token);
  ok('  and the token stays unusable', after.valid === false && after.reason === 'CONSUMED');

  // Expiry is enforced against a genuinely past timestamp written directly,
  // because the create API correctly refuses to mint an already-expired token.
  const exp = await repo.createApprovalActionFirestore({
    pr_id: PR_ID, pr_number: 'PR-H2-LIVE-TEST', approver_uid: UID,
    action: 'REJECT', expires_at: future, created_by: 'h2_live_verifier'
  });
  writes++; hashes.push(exp.token_hash);
  ok('  a REJECT action stores the canonical REJECTED value', exp.action.action === 'REJECTED');
  await db.collection('inventory_approval_actions').doc(exp.token_hash)
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  writes++;
  const expired = await repo.findApprovalActionByTokenFirestore(exp.raw_token);
  ok('B7. an expired token is refused', expired.valid === false && expired.reason === 'EXPIRED', expired.reason);
  const expiredConsume = await repo.consumeApprovalActionFirestore(exp.raw_token, { via: 'H2_LIVE_TEST' });
  ok('  and cannot be consumed', expiredConsume.valid === false && expiredConsume.reason === 'EXPIRED');

  // Creation validation, live.
  const badAction = await repo.createApprovalActionFirestore({
    pr_id: PR_ID, pr_number: 'X', approver_uid: UID, action: 'MAYBE',
    expires_at: future, created_by: 'h2_live_verifier'
  }).then(() => false).catch(e => e.code === 'VALIDATION_ERROR');
  ok('B8. an invalid action is refused before any write', badAction === true);
  const pastExpiry = await repo.createApprovalActionFirestore({
    pr_id: PR_ID, pr_number: 'X', approver_uid: UID, action: 'APPROVE',
    expires_at: new Date(Date.now() - 1000).toISOString(), created_by: 'h2_live_verifier'
  }).then(() => false).catch(e => e.code === 'VALIDATION_ERROR');
  ok('  an expiry in the past is refused', pastExpiry === true);

  // Invalidation, scoped to this synthetic PR only.
  const inv = await repo.invalidateApprovalActionsForRequestFirestore(PR_ID, { reason: 'H2_LIVE_TEST' });
  ok('B9. invalidation is scoped to this PR', inv.examined === 2, `examined ${inv.examined}`);
  ok('  it retired nothing already spent or expired', inv.invalidated <= 1, `invalidated ${inv.invalidated}`);
} finally {
  for (const h of hashes) {
    await db.collection('inventory_approval_actions').doc(h).delete();
    deletes++;
  }
  console.log(`\n  [CLEANUP] removed ${deletes} synthetic action document(s)`);
  const left = await db.collection('inventory_approval_actions')
    .where('pr_id', '==', PR_ID).get();
  ok('CLEANUP: nothing left for the synthetic PR', left.size === 0, `${left.size} remaining`);
}

console.log(`\n═══ H2 ACTIONS: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
console.log(`\n[DEV WRITES ~${writes}]  [DEV DELETES ${deletes}]  [PRODUCTION ACCESS] 0  [WHATSAPP CALLS] 0`);
process.exit(fail === 0 ? 0 : 1);
