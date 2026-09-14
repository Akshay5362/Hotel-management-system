/**
 * backend/tests/testInventoryApprovalAuthoritiesH1.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H1 — inventory_approval_authorities — re-keyed in Phase H6.
 *
 * An approval authority is now an EXTERNAL identity: a server-generated
 * authority_id, a WhatsApp number proven by possession, no login of any kind.
 * This suite keeps every H1 invariant that still holds (masking, deny-all
 * rules, no role stored, MANAGE-only management, the approval engine's own
 * rules) and replaces the ones the model changed (uid keying, the staff
 * requirement) with their H6 counterparts. Verification itself is proven by
 * the H6 suite.
 *
 * PART A — STATIC / LOGIC. Touches no Firestore and imports no Firebase module.
 *   Pure functions are LIFTED OUT OF SOURCE at run time and executed against
 *   doubles, so a regression in the real file still turns this red.
 *
 * PART B — DEV Firestore, behind the four-layer guard. Registers one
 *   throwaway authority through the service, exercises the activation invariant
 *   and the list, and removes everything it made.
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
const codeOnly = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
const REPO_CODE = codeOnly(REPO);
const CTRL = src('backend', 'controllers', 'inventoryApprovalAuthoritiesController.js');
const CTRL_CODE = codeOnly(CTRL);
const ROUTES = src('backend', 'routes', 'inventoryRoutes.js');
const RULES = src('firestore.rules');
const CONFIG_REPO = src('backend', 'repositories', 'firestore', 'inventoryApprovalConfigRepository.js');
const SERVICE = codeOnly(src('backend', 'services', 'whatsappAuthorityVerificationService.js'));

// A stand-in for the RepositoryError the lifted code throws.
const PRELUDE = `class RepositoryError extends Error {
  constructor(m, c, s) { super(m); this.code = c; this.status = s; }
}
const E164 = ${String(REPO.match(/const E164 = (\/.+\/);/)[1])};`;

console.log('═══ PART A — static / logic (no Firestore) ═══');

// ── identity ────────────────────────────────────────────────────────────────
console.log('\n  -- identity is a server-generated authority_id (H6) --');
const assertUsableAuthorityId = lift(REPO, 'assertUsableAuthorityId', PRELUDE);
ok('10. the document id is the authority_id, trimmed, never rewritten', assertUsableAuthorityId('  aa_abc123  ') === 'aa_abc123');
ok('  an id containing "/" is refused (would forge a Firestore path)',
  (() => { try { assertUsableAuthorityId('a/b'); return false; } catch (e) { return e.code === 'VALIDATION_ERROR'; } })());
ok('  an empty id is refused', (() => { try { assertUsableAuthorityId('   '); return false; } catch (e) { return e.code === 'VALIDATION_ERROR'; } })());
ok('  "." and ".." are refused', ['.', '..'].every(v => { try { assertUsableAuthorityId(v); return false; } catch { return true; } }));
ok('  the id is minted from the CSPRNG, never taken from a login', /crypto\.randomBytes\(16\)/.test(REPO_CODE) && !/user_uid|firebaseUser|verifyIdToken/.test(REPO_CODE));
ok('12. one record per identity is structural — the id IS the document', /txn\.create\(authorityRef\(authority\.authority_id\), authority\)/.test(SERVICE) && !/upsert/i.test(REPO_CODE));
ok('  the authority type is fixed at creation and never rewritten',
  /authority_type: APPROVAL_AUTHORITY_TYPES\.EXTERNAL/.test(REPO_CODE) && (REPO_CODE.match(/authority_type:/g) || []).length === 1);

// ── a stored number is not a verified number ────────────────────────────────
console.log('\n  -- a stored number is not a verified number --');
const normalizeWhatsAppNumber = lift(REPO, 'normalizeWhatsAppNumber', PRELUDE);
ok('11. the repository never writes VERIFIED — only the verification service may',
  !/verification_status: APPROVAL_AUTHORITY_VERIFICATION\.VERIFIED/.test(REPO_CODE) &&
  /verification_status: APPROVAL_AUTHORITY_VERIFICATION\.PENDING_VERIFICATION/.test(REPO_CODE) &&
  /whatsapp_verified_at: null/.test(REPO_CODE) && /whatsapp_verification_method: null/.test(REPO_CODE));
ok('  a new authority is inactive until an administrator activates a VERIFIED one', /is_active: false/.test(REPO_CODE));
ok('  activation is refused unless verification is current', /if \(isActive\) \{\s*\n\s*const verdict = assessAuthorityVerification\(existing\);/.test(REPO_CODE));
ok('  E.164 accepted', normalizeWhatsAppNumber('+919876543210') === '+919876543210');
ok('  human punctuation tolerated', normalizeWhatsAppNumber('+91 98765-43210') === '+919876543210');
ok('  a bare national number is refused, not given a country code',
  (() => { try { normalizeWhatsAppNumber('9876543210'); return false; } catch (e) { return e.code === 'VALIDATION_ERROR'; } })());
ok('  a leading +0 is refused', (() => { try { normalizeWhatsAppNumber('+0123456789'); return false; } catch { return true; } })());
ok('  null stays null', normalizeWhatsAppNumber(null) === null);
const maskWhatsAppNumber = lift(REPO, 'maskWhatsAppNumber', PRELUDE);
ok('  masking hides the middle', maskWhatsAppNumber('+919876543210') === '+9198****3210');

// ── no role, no staff, no login ─────────────────────────────────────────────
console.log('\n  -- an authority is not a staff member and has no role --');
ok('8. the controller no longer requires a staff record or an approver role',
  !/getStaffByUidFirestore|resolveEligibleStaff|roleCanApprove|normalizeUserRole|STAFF_NOT_FOUND|ROLE_NOT_APPROVER/.test(CTRL_CODE));
ok('5(a). no role is ever stored on the document', !/\brole:/.test(REPO_CODE.slice(REPO_CODE.indexOf('authority_id: generateAuthorityId()'), REPO_CODE.indexOf('created_by: actor_uid'))));
ok('  the live approval config still decides staff eligibility for the in-app path',
  (() => { const roleCanApprove = lift(CONFIG_REPO, 'roleCanApprove'); const cfg = { enabled: true, allowed_roles: ['admin', 'super_admin'] };
    return ['receptionist', 'kitchen', 'housekeeper'].every(r => roleCanApprove(cfg, r) === false) && roleCanApprove(cfg, 'admin') && roleCanApprove({ ...cfg, enabled: false }, 'admin') === false; })());
ok('  linked_staff_uid is optional and grants nothing (only the self-approval guard reads it)',
  /linked_staff_uid = null/.test(REPO_CODE) && !/linked_staff_uid[\s\S]{0,80}(role|permission|login)/.test(REPO_CODE));

// ── RBAC ────────────────────────────────────────────────────────────────────
console.log('\n  -- only administrators may manage authorities --');
const authorityRoutes = ROUTES.split('\n').filter(l => l.includes("'/approval-authorities"));
ok('9. all 9 management routes exist', authorityRoutes.length === 9, `${authorityRoutes.length} route(s)`);
ok('  every one is gated by MANAGE', authorityRoutes.every(l => /,\s*MANAGE,/.test(l)));
ok('  MANAGE is admin + super_admin only', /MANAGE:\s*Object\.freeze\(\['admin', 'super_admin'\]\)/.test(src('backend', 'utils', 'inventoryConstants.js')));
ok('  so receptionist / kitchen / housekeeper cannot reach any of them', !authorityRoutes.some(l => /VIEW|REQUEST|MOVE|RECEIVE/.test(l)));
ok('7(b). there is no self-service route — the authority never logs in', !/approval-authorities\/me|self-register|self-verify/.test(ROUTES));

// ── Firestore rules ─────────────────────────────────────────────────────────
console.log('\n  -- the collection is server-only --');
const ruleBlock = RULES.slice(RULES.indexOf('match /inventory_approval_authorities/'));
ok('rules deny BOTH read and write to clients', /match \/inventory_approval_authorities\/\{authorityId\} \{\s*\n\s*allow read, write: if false;/.test(ruleBlock));
ok('  no existing inventory rule was widened', (RULES.match(/allow write: if false;/g) || []).length >= 16);

// ── the approval engine's own rules ─────────────────────────────────────────
console.log('\n  -- the existing approval engine keeps its rules --');
const APPROVAL = src('backend', 'services', 'purchaseRequestApprovalService.js');
// Three guards: the preflight, the in-transaction re-check, and H6's external
// guard that also compares the linked staff uid.
ok('13. self-approval is blocked in the preflight, in the transaction, and for external authorities',
  (APPROVAL.match(/PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN/g) || []).length === 3);
ok('  the decision is still one Firestore transaction', /await db\.runTransaction\(async \(txn\) => \{/.test(APPROVAL));
ok('  first-valid-decision-wins still enforced', /current\.status !== PR_STATUS\.PENDING_APPROVAL/.test(APPROVAL));
ok('  idempotent replay for the same approver still present', /alreadyMine/.test(APPROVAL));
ok('  a second approver is still refused', /APPROVER_ALREADY_ACTED/.test(APPROVAL));
ok('  the rejection-reason rule still stands', /MIN_REJECTION_REASON_LENGTH/.test(APPROVAL));
ok('  the approval service never consults a WhatsApp number or verification timestamp',
  !/whatsapp_e164|whatsapp_verified_at|whatsapp_verification_method|WhatsAppNumber/.test(codeOnly(APPROVAL)));
ok('  nor does the approval config repository', !/whatsapp/i.test(CONFIG_REPO));
ok('  nor the purchase request controller', !/approval_authorities|whatsapp/i.test(src('backend', 'controllers', 'purchaseRequestController.js')));

// ── no Meta ─────────────────────────────────────────────────────────────────
console.log('\n  -- no outbound WhatsApp integration --');
for (const [label, body] of [['repository', REPO_CODE], ['controller', CTRL_CODE], ['verification service', SERVICE]]) {
  ok(`  ${label} calls no Meta/WhatsApp API`, !/graph\.facebook|fetch\(|axios|Bearer |access_token/i.test(body));
}
ok('  no webhook route lives in the inventory router', !/webhook/i.test(ROUTES));

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
const service = await import('../services/whatsappAuthorityVerificationService.js');
const { db } = await import('../config/firebaseAdmin.js');
const { FieldPath } = await import('firebase-admin/firestore');

const TS = Date.now();
const NUMBER = `+9195${String(TS).slice(-8)}`;
const ACTOR = { uid: `h1test_admin_${TS}`, name: 'H1 Admin', role: 'admin' };
let authorityId = null;
try {
  const { authority: a } = await service.registerApprovalAuthority({ display_name: 'H1 Test Authority', whatsapp_e164: NUMBER, actor: ACTOR });
  authorityId = a.authority_id;
  ok('1. authority created with a server-generated id', /^aa_[0-9a-f]{32}$/.test(a.authority_id));
  ok('10. stored under that id', (await repo.getApprovalAuthorityByIdFirestore(a.authority_id))?.authority_id === a.authority_id);
  ok('11. stored but NOT verified, and inactive', a.whatsapp_e164 === NUMBER && a.verification_status === 'PENDING_VERIFICATION' && a.whatsapp_verified_at === null && a.is_active === false);
  ok('2. registering the same number again is refused, not duplicated',
    await service.registerApprovalAuthority({ display_name: 'Dup', whatsapp_e164: NUMBER, actor: ACTOR }).then(() => false).catch(e => e.code === 'NUMBER_ALREADY_BOUND'));
  const { authority: c } = await service.updateApprovalAuthorityDisplay({ authority_id: authorityId, display_name: 'H1 Renamed', actor: ACTOR });
  ok('3. display metadata updated in place', c.display_name === 'H1 Renamed' && c.created_at === a.created_at);
  ok('4. an unverified authority cannot be activated',
    await service.activateApprovalAuthority({ authority_id: authorityId, actor: ACTOR }).then(() => false).catch(e => e.code === 'AUTHORITY_NOT_VERIFIED'));
  const activeList = await repo.listApprovalAuthoritiesFirestore();
  ok('5. an inactive authority is excluded from the active list', !activeList.some(x => x.authority_id === authorityId));
  const allList = await repo.listApprovalAuthoritiesFirestore({ includeInactive: true });
  ok('  but present when inactive are included', allList.some(x => x.authority_id === authorityId));
  ok('12. exactly one document for this identity', allList.filter(x => x.authority_id === authorityId).length === 1);
} finally {
  if (authorityId) {
    await db.collection('inventory_approval_authorities').doc(authorityId).delete();
    await db.collection('whatsapp_number_bindings').doc(`wa_${NUMBER.slice(1)}`).delete();
    const rows = await db.collection('audit_logs').where(FieldPath.documentId(), '>=', `audit_inv_wa_${authorityId}_`).where(FieldPath.documentId(), '<', `audit_inv_wa_${authorityId}_`).get();
    for (const d of rows.docs) await d.ref.delete();
    console.log(`\n  [CLEANUP] removed the throwaway authority, its binding and ${rows.size} audit row(s)`);
  }
}

console.log(`\n═══ H1 AUTHORITIES: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
console.log('\n[PRODUCTION ACCESS] 0  [WHATSAPP CALLS] 0');
process.exit(fail === 0 ? 0 : 1);
