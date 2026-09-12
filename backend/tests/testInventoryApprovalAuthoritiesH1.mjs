/**
 * backend/tests/testInventoryApprovalAuthoritiesH1.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H1 — inventory_approval_authorities.
 *
 * PART A — STATIC / LOGIC. Touches no Firestore and imports no Firebase module.
 *   Pure functions are LIFTED OUT OF SOURCE at run time and executed against
 *   doubles, so a regression in the real file still turns this red while the
 *   test itself stays runnable when the DEV quota is gone.
 *
 * PART B — DEV Firestore, behind the same four-layer guard every inventory test
 *   uses. Creates at most one throwaway authority record and removes it again.
 *   Skipped unless HPMS_ENV=development, and it aborts rather than degrades if
 *   the resolved project is anything but sky5-development.
 *
 * Never writes production. Never calls Meta. Never sends a message.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryApprovalAuthoritiesH1.mjs
 *       node backend/tests/testInventoryApprovalAuthoritiesH1.mjs     (Part A only)
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

/** Lifts a named function body out of source and evaluates it standalone. */
function lift(source, name, extraPrelude = '') {
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = source.indexOf('{', start), depth = 0, end = -1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const body = source.slice(start, end).replace(/^export /, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${extraPrelude}\n${body}\nreturn ${name};`)();
}

const REPO = src('backend', 'repositories', 'firestore', 'inventoryApprovalAuthoritiesRepository.js');
const CTRL = src('backend', 'controllers', 'inventoryApprovalAuthoritiesController.js');
const ROUTES = src('backend', 'routes', 'inventoryRoutes.js');
const RULES = src('firestore.rules');
const CONFIG_REPO = src('backend', 'repositories', 'firestore', 'inventoryApprovalConfigRepository.js');

// A stand-in for the RepositoryError the lifted code throws.
const PRELUDE = `class RepositoryError extends Error {
  constructor(m, c, s) { super(m); this.code = c; this.status = s; }
}
const E164 = ${String(REPO.match(/const E164 = (\/.+\/);/)[1])};`;

console.log('═══ PART A — static / logic (no Firestore) ═══');

// ── 10. keyed by user_uid ───────────────────────────────────────────────────
console.log('\n  -- identity is the staff uid --');
const assertUsableUid = lift(REPO, 'assertUsableUid', PRELUDE);
ok('10. document id is the raw user_uid, no prefix rewriting',
  assertUsableUid('  abc123  ') === 'abc123');
ok('  a uid containing "/" is refused (would forge a Firestore path)',
  (() => { try { assertUsableUid('a/b'); return false; } catch (e) { return e.code === 'VALIDATION_ERROR'; } })());
ok('  an empty uid is refused',
  (() => { try { assertUsableUid('   '); return false; } catch (e) { return e.code === 'VALIDATION_ERROR'; } })());
ok('  "." and ".." are refused',
  ['.', '..'].every(v => { try { assertUsableUid(v); return false; } catch { return true; } }));
ok('12. one record per uid is structural — the id IS the uid',
  /setDoc\(APPROVAL_AUTHORITIES_COLLECTION, docId/.test(REPO) &&
  /const docId = assertUsableUid\(data\.user_uid\)/.test(REPO));

// ── 11. an unverified number is never treated as verified ──────────────────
console.log('\n  -- a stored number is not a verified number --');
const normalizeWhatsAppNumber = lift(REPO, 'normalizeWhatsAppNumber', PRELUDE);
ok('11. H1 never writes whatsapp_verified_at',
  !/whatsapp_verified_at:\s*(now|new Date)/.test(REPO) &&
  /whatsapp_verified_at: numberChanged \? null :/.test(REPO));
ok('  nor whatsapp_verification_method',
  !/whatsapp_verification_method:\s*'/.test(REPO) &&
  /whatsapp_verification_method: numberChanged \? null :/.test(REPO));
ok('  changing the number clears any verification it carried',
  /const numberChanged = !!existing && existing\.whatsapp_e164 !== whatsapp;/.test(REPO));
ok('  E.164 accepted', normalizeWhatsAppNumber('+919876543210') === '+919876543210');
ok('  human punctuation tolerated', normalizeWhatsAppNumber('+91 98765-43210') === '+919876543210');
ok('  a bare national number is refused, not given a country code',
  (() => { try { normalizeWhatsAppNumber('9876543210'); return false; } catch (e) { return e.code === 'VALIDATION_ERROR'; } })());
ok('  a leading +0 is refused', (() => { try { normalizeWhatsAppNumber('+0123456789'); return false; } catch { return true; } })());
ok('  null stays null (a number is optional in H1)', normalizeWhatsAppNumber(null) === null);
const maskWhatsAppNumber = lift(REPO, 'maskWhatsAppNumber', PRELUDE);
ok('  masking hides the middle', maskWhatsAppNumber('+919876543210') === '+9198****3210');

// ── 8. role gate, using the REAL roleCanApprove ────────────────────────────
console.log('\n  -- role eligibility uses the live approval config --');
const roleCanApprove = lift(CONFIG_REPO, 'roleCanApprove');
const cfg = { enabled: true, allowed_roles: ['admin', 'super_admin'] };
ok('8. a non-approver role cannot become an authority',
  ['receptionist', 'kitchen', 'housekeeper'].every(r => roleCanApprove(cfg, r) === false));
ok('  an approver role can', roleCanApprove(cfg, 'admin') && roleCanApprove(cfg, 'super_admin'));
ok('  approvals disabled blocks everyone', roleCanApprove({ ...cfg, enabled: false }, 'admin') === false);
ok('  the controller calls roleCanApprove rather than storing the role',
  /roleCanApprove\(config, role\)/.test(CTRL));
ok('5(a). the role is deliberately NOT copied into the document',
  !/\brole:/.test(REPO.slice(REPO.indexOf('const payload = {'), REPO.indexOf('await setDoc'))));

// ── 7. inactive staff ──────────────────────────────────────────────────────
console.log('\n  -- staff eligibility --');
const isStaffActiveSrc = CTRL.slice(CTRL.indexOf('function isStaffActive'));
const isStaffActive = new Function(`${isStaffActiveSrc.slice(0, isStaffActiveSrc.indexOf('\n}') + 2)}\nreturn isStaffActive;`)();
ok('7. inactive staff rejected (is_active false)', isStaffActive({ is_active: false }) === false);
ok('  soft-deleted staff rejected', isStaffActive({ deleted: true }) === false);
ok('  status Inactive/Disabled/Deleted rejected',
  ['Inactive', 'Disabled', 'Deleted'].every(s => isStaffActive({ status: s }) === false));
ok('  an active staff record passes', isStaffActive({ is_active: true, status: 'Active' }) === true);
ok('6. a missing staff record is refused', /STAFF_NOT_FOUND/.test(CTRL));
ok('  staff without a linked user_uid is refused', /STAFF_UID_MISSING/.test(CTRL));

// ── 9. RBAC: normal staff cannot manage authorities ────────────────────────
console.log('\n  -- only administrators may manage authorities --');
const authorityRoutes = ROUTES.split('\n').filter(l => l.includes("'/approval-authorities"));
ok('9. all 5 authority routes exist', authorityRoutes.length === 5, `${authorityRoutes.length} route(s)`);
ok('  every one is gated by MANAGE', authorityRoutes.every(l => /,\s*MANAGE,/.test(l)));
ok('  MANAGE is admin + super_admin only',
  /MANAGE:\s*Object\.freeze\(\['admin', 'super_admin'\]\)/.test(src('backend', 'utils', 'inventoryConstants.js')));
ok('  so receptionist / kitchen / housekeeper cannot reach any of them',
  !authorityRoutes.some(l => /VIEW|REQUEST|MOVE|RECEIVE/.test(l)));
ok('7(b). there is no self-registration route', !/approval-authorities\/me|self-register/.test(ROUTES));

// ── Firestore rules ────────────────────────────────────────────────────────
console.log('\n  -- the collection is server-only --');
const ruleBlock = RULES.slice(RULES.indexOf('match /inventory_approval_authorities/'));
ok('rules deny BOTH read and write to clients',
  /match \/inventory_approval_authorities\/\{authorityId\} \{\s*\n\s*allow read, write: if false;/.test(ruleBlock));
ok('  no existing inventory rule was widened',
  (RULES.match(/allow write: if false;/g) || []).length >= 16);

// ── 13. the approval engine is untouched ───────────────────────────────────
console.log('\n  -- the existing approval engine is unchanged --');
const APPROVAL = src('backend', 'services', 'purchaseRequestApprovalService.js');
ok('13. self-approval block still present, twice',
  (APPROVAL.match(/PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN/g) || []).length === 2);
ok('  the decision is still one Firestore transaction',
  /await db\.runTransaction\(async \(txn\) => \{/.test(APPROVAL));
ok('  first-valid-decision-wins still enforced',
  /current\.status !== PR_STATUS\.PENDING_APPROVAL/.test(APPROVAL));
ok('  idempotent replay for the same approver still present', /alreadyMine/.test(APPROVAL));
ok('  a second approver is still refused', /APPROVER_ALREADY_ACTED/.test(APPROVAL));
ok('  the rejection-reason rule still stands', /MIN_REJECTION_REASON_LENGTH/.test(APPROVAL));
// H3 wires the authority record into the engine, so "no reference at all" is
// no longer the invariant. What must stay true: the engine never treats a
// WhatsApp number or its verification state as authorization. Comments are
// stripped first so documentation naming WhatsApp cannot trip this.
ok('  the approval service never consults a WhatsApp number or verification state',
  !/whatsapp_e164|whatsapp_verified_at|whatsapp_verification_method|WhatsAppNumber/.test(
    APPROVAL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
ok('  nor to the approval config repository', !/whatsapp/i.test(CONFIG_REPO));
ok('  nor to the purchase request controller',
  !/approval_authorities|whatsapp/i.test(src('backend', 'controllers', 'purchaseRequestController.js')));

// ── No WhatsApp yet ────────────────────────────────────────────────────────
console.log('\n  -- H1 contains no WhatsApp integration --');
for (const [label, body] of [['repository', REPO], ['controller', CTRL]]) {
  ok(`  ${label} calls no Meta/WhatsApp API`,
    !/graph\.facebook|fetch\(|axios|Bearer |access_token/i.test(body));
}
ok('  no webhook route was added', !/webhook/i.test(ROUTES));
ok('  no token/HMAC machinery was added', !/hmac|createHmac|sha256/i.test(REPO + CTRL));

// ═══════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ PART B — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ H1 AUTHORITIES: ${pass} passed, ${fail} failed (Part A only) ═══`);
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

const repo = await import('../repositories/firestore/inventoryApprovalAuthoritiesRepository.js');
const { db } = await import('../config/firebaseAdmin.js');

const TEST_UID = `h1test_${Date.now()}`;
let created = false;
try {
  // 1 + 10
  const a = await repo.upsertApprovalAuthorityFirestore({
    user_uid: TEST_UID, display_name: 'H1 Test Authority',
    whatsapp_e164: '+919876543210', actor_uid: 'h1_test'
  });
  created = true;
  ok('1. authority created', a.created === true);
  ok('10. stored under the raw uid', a.authority.user_uid === TEST_UID);
  ok('11. stored but NOT verified',
    a.authority.whatsapp_e164 === '+919876543210' &&
    a.authority.whatsapp_verified_at === null &&
    a.authority.whatsapp_verification_method === null);

  // 2 + 12
  const b = await repo.upsertApprovalAuthorityFirestore({
    user_uid: TEST_UID, display_name: 'H1 Test Authority', actor_uid: 'h1_test'
  });
  ok('2. repeat upsert is idempotent, not a second record', b.created === false);
  ok('  created_at was preserved', b.authority.created_at === a.authority.created_at);
  ok('  omitting the number left it alone', b.authority.whatsapp_e164 === '+919876543210');

  // 3
  const c = await repo.upsertApprovalAuthorityFirestore({
    user_uid: TEST_UID, display_name: 'H1 Renamed', actor_uid: 'h1_test'
  });
  ok('3. authority updated in place', c.authority.display_name === 'H1 Renamed' && c.created === false);

  // 4 + 5
  await repo.setApprovalAuthorityActiveFirestore(TEST_UID, false, 'h1_test');
  const after = await repo.getApprovalAuthorityByUidFirestore(TEST_UID);
  ok('4. authority deactivated', after.is_active === false);
  ok('  the record still exists (soft, not deleted)', !!after);
  const activeList = await repo.listApprovalAuthoritiesFirestore();
  ok('5. inactive authority excluded from the active list',
    !activeList.some(x => x.user_uid === TEST_UID));
  const allList = await repo.listApprovalAuthoritiesFirestore({ includeInactive: true });
  ok('  but present when inactive are included',
    allList.some(x => x.user_uid === TEST_UID));

  // 12
  ok('12. exactly one document for this uid',
    allList.filter(x => x.user_uid === TEST_UID).length === 1);
} finally {
  if (created) {
    await db.collection('inventory_approval_authorities').doc(TEST_UID).delete();
    console.log(`\n  [CLEANUP] removed the single throwaway record ${TEST_UID}`);
  }
}

console.log(`\n═══ H1 AUTHORITIES: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
console.log('\n[PRODUCTION ACCESS] 0  [WHATSAPP CALLS] 0');
process.exit(fail === 0 ? 0 : 1);
