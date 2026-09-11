/**
 * testRbacAuthorizationMatrix.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Group 11 — RBAC authorization foundation.
 *
 * ZERO FIRESTORE. ZERO FIREBASE. ZERO NETWORK.
 *
 * backend/controllers/authController.js imports ../config/firebaseAdmin.js at
 * module scope, and that module calls initializeApp() + getFirestore() as a
 * side effect of being imported — with HPMS_ENV unset it resolves to the
 * PRODUCTION project. So this suite must never import the controller.
 *
 * Instead it lifts the real function bodies out of the source files at run time
 * and executes them against injected doubles. That keeps the test honest: it
 * measures the code that actually ships, not a copy of it, so restoring the old
 * `req.user.type === 'staff'` condition turns these red. §5 proves exactly that
 * with negative controls.
 *
 * Run:  node backend/tests/testRbacAuthorizationMatrix.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${detail ? '  ' + detail : ''}`); }
};

// ═════════════════════════════════════════════════════════════════════════════
// Source lifting
// ═════════════════════════════════════════════════════════════════════════════
const readSrc = (...p) => fs.readFileSync(path.join(BACKEND, ...p), 'utf8').replace(/\r\n/g, '\n');

/** Text between the `{` at or after `marker` and its matching `}`. */
function sliceBody(src, marker, label) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`extraction failed: ${label} — marker not found`);
  if (src.indexOf(marker, at + 1) >= 0) throw new Error(`extraction failed: ${label} — marker not unique`);
  const open = src.indexOf('{', at + marker.length - 1);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`extraction failed: ${label} — unbalanced braces`);
  return src.slice(open + 1, i);
}

const AUTH_SRC = readSrc('controllers', 'authController.js');
const HK_SRC = readSrc('controllers', 'housekeepingController.js');
const HKSVC_SRC = readSrc('services', 'housekeepingCutoverService.js');

const normalizeBody = sliceBody(AUTH_SRC, 'export function normalizeUserRole(user) {', 'normalizeUserRole');
const requireAdminBody = sliceBody(AUTH_SRC, 'export const requireAdmin = (req, res, next) => {', 'requireAdmin');
const isAssignedBody = sliceBody(AUTH_SRC, 'export function isRoomAssignedToUser(user, room) {', 'isRoomAssignedToUser');
const requireRoleInner = sliceBody(AUTH_SRC, '  return (req, res, next) => {', 'requireRole inner');

console.log('Lifted from source:');
console.log(`  normalizeUserRole     ${normalizeBody.split('\n').length} lines`);
console.log(`  requireAdmin          ${requireAdminBody.split('\n').length} lines`);
console.log(`  requireRole (inner)   ${requireRoleInner.split('\n').length} lines`);
console.log(`  isRoomAssignedToUser  ${isAssignedBody.split('\n').length} lines`);

// ═════════════════════════════════════════════════════════════════════════════
// Executable reconstructions
// ═════════════════════════════════════════════════════════════════════════════
const normalizeUserRole = new Function('user', normalizeBody);
const isRoomAssignedToUser = new Function('user', 'room', isAssignedBody);

/** Express double: records the outcome of one middleware invocation. */
function makeCtx(user) {
  const out = { status: null, body: null, nexted: false };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; }
  };
  return { req: { user }, res, next: () => { out.nexted = true; }, out };
}

const runRequireAdmin = new Function(
  'req', 'res', 'next', 'normalizeUserRole', requireAdminBody
);
const callRequireAdmin = (user) => {
  const c = makeCtx(user);
  runRequireAdmin(c.req, c.res, c.next, normalizeUserRole);
  return c.out;
};

const runRequireRole = new Function(
  'req', 'res', 'next', 'allowedRoles', 'normalizeUserRole', 'isStrictRbacEnabled',
  requireRoleInner
);
/** Mirrors featureFlags.js:13 exactly — the single source of truth for the flag. */
const isStrictRbacEnabled = () => process.env.ENABLE_STRICT_RBAC !== 'false';
const callRequireRole = (user, allowedRoles) => {
  const c = makeCtx(user);
  runRequireRole(c.req, c.res, c.next, allowedRoles, normalizeUserRole, isStrictRbacEnabled);
  return c.out;
};

// ═════════════════════════════════════════════════════════════════════════════
// Role fixtures — the six authoritative staff roles (staffController.js:54)
// ═════════════════════════════════════════════════════════════════════════════
const staff = (role, extra = {}) => ({
  uid: `staff_${role.toLowerCase()}`, id: 42, mysql_id: 42,
  role, type: 'staff', user_type: 'staff', isRootAdmin: false, ...extra
});
const ROOT_ADMIN = { uid: 'root', id: 1, role: 'ADMIN', type: 'admin', isRootAdmin: true };
const ROLES = {
  ADMIN: staff('ADMIN'),
  RECEPTIONIST: staff('RECEPTIONIST'),
  CHEF: staff('CHEF'),
  KITCHEN_HELPER: staff('KITCHEN_HELPER'),
  PANTRY_BOY: staff('PANTRY_BOY'),
  CLEANER: staff('CLEANER')
};

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 1. ROLE NORMALIZATION ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const EXPECTED_NORMAL = {
  ADMIN: 'admin', RECEPTIONIST: 'receptionist', CHEF: 'kitchen',
  KITCHEN_HELPER: 'kitchen', PANTRY_BOY: 'kitchen', CLEANER: 'housekeeper'
};
for (const [raw, expected] of Object.entries(EXPECTED_NORMAL)) {
  const got = normalizeUserRole(ROLES[raw]);
  ok(`${raw.padEnd(15)} normalizes to '${expected}'`, got === expected, `got '${got}'`);
}
ok('root admin normalizes to \'super_admin\'',
  normalizeUserRole(ROOT_ADMIN) === 'super_admin', `got '${normalizeUserRole(ROOT_ADMIN)}'`);
ok('no staff role normalizes to \'manager\' (the role does not exist)',
  !Object.keys(ROLES).some(r => normalizeUserRole(ROLES[r]) === 'manager'));

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. 11-A — requireAdmin SIX-ROLE MATRIX ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const ADMIN_ALLOWED = ['ADMIN'];
for (const raw of Object.keys(ROLES)) {
  const r = callRequireAdmin(ROLES[raw]);
  const shouldPass = ADMIN_ALLOWED.includes(raw);
  ok(`${raw.padEnd(15)} requireAdmin -> ${shouldPass ? 'PASS' : 'DENY'}`,
    shouldPass ? r.nexted === true : (r.nexted === false && r.status === 403),
    shouldPass ? '' : `status ${r.status}`);
}
{
  const r = callRequireAdmin(ROOT_ADMIN);
  ok('SUPER_ADMIN     requireAdmin -> PASS', r.nexted === true);
}
{
  const r = callRequireAdmin(staff('ADMIN', { isRootAdmin: false }));
  ok('a normalized \'admin\' value also passes',
    callRequireAdmin({ ...staff('ADMIN'), role: 'admin' }).nexted === true && r.nexted === true);
}
{
  const r = callRequireAdmin(null);
  ok('unauthenticated -> 401, not 403', r.nexted === false && r.status === 401, `status ${r.status}`);
}
{
  const r = callRequireAdmin(staff('SOME_FUTURE_ROLE'));
  ok('an unknown staff role is DENIED (fails closed)',
    r.nexted === false && r.status === 403, `status ${r.status}`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. 11-C — requireRole STRICT-MODE BEHAVIOUR ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const withFlag = (value, fn) => {
  const prev = process.env.ENABLE_STRICT_RBAC;
  if (value === undefined) delete process.env.ENABLE_STRICT_RBAC;
  else process.env.ENABLE_STRICT_RBAC = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.ENABLE_STRICT_RBAC;
    else process.env.ENABLE_STRICT_RBAC = prev;
  }
};

// A cleaner hitting an admin/receptionist-only gate is the canonical case.
const CLEANER_ON_ADMIN_GATE = () => callRequireRole(ROLES.CLEANER, ['admin', 'receptionist']);

{
  const r = withFlag('true', CLEANER_ON_ADMIN_GATE);
  ok('ENABLE_STRICT_RBAC=true     -> unauthorized role DENIED',
    r.nexted === false && r.status === 403, `status ${r.status}`);
}
{
  const r = withFlag(undefined, CLEANER_ON_ADMIN_GATE);
  ok('ENABLE_STRICT_RBAC missing  -> unauthorized role DENIED (fails CLOSED)',
    r.nexted === false && r.status === 403, `status ${r.status}`);
}
{
  const r = withFlag('', CLEANER_ON_ADMIN_GATE);
  ok('ENABLE_STRICT_RBAC=""       -> unauthorized role DENIED',
    r.nexted === false && r.status === 403, `status ${r.status}`);
}
{
  const r = withFlag('TRUE', CLEANER_ON_ADMIN_GATE);
  ok('ENABLE_STRICT_RBAC="TRUE"   -> DENIED (old `=== \'true\'` would have opened this)',
    r.nexted === false && r.status === 403, `status ${r.status}`);
}
{
  // The explicitly-requested opt-out is preserved, unchanged.
  const r = withFlag('false', CLEANER_ON_ADMIN_GATE);
  ok('ENABLE_STRICT_RBAC=false    -> non-strict behaviour PRESERVED (staff admitted)',
    r.nexted === true, 'documented opt-out still works');
}
{
  const r = withFlag('true', () => callRequireRole(ROLES.RECEPTIONIST, ['admin', 'receptionist']));
  ok('strict mode still ADMITS a legitimately allowed role', r.nexted === true);
}
{
  const r = withFlag('true', () => callRequireRole(ROOT_ADMIN, ['admin']));
  ok('strict mode admits super_admin on an admin gate', r.nexted === true);
}
{
  const r = withFlag('true', () => callRequireRole(ROLES.CHEF, ['admin', 'receptionist', 'kitchen', 'chef']));
  ok('CHEF still reaches kitchen routes (normalizes to \'kitchen\')', r.nexted === true);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. 11-B — HOUSEKEEPING OWNERSHIP ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
// The service guard, verbatim from housekeepingCutoverService.js.
const GUARD = `caller?.role === 'housekeeper' && !isRoomAssignedToUser(caller, room)`;
ok('the service ownership guard is still present and unmodified',
  HKSVC_SRC.includes(GUARD), 'housekeepingCutoverService.js');

// The controller handoff, verbatim from housekeepingController.js.
const HANDOFF = `caller: { ...req.user, role: normalizeUserRole(req.user) }`;
ok('the controller now normalizes the caller role before handing off',
  HK_SRC.includes(HANDOFF), 'housekeepingController.js');

/** Replays the service's real guard expression against a caller and a room. */
const guardDenies = (caller, room) =>
  new Function('caller', 'room', 'isRoomAssignedToUser', `return ${GUARD};`)(
    caller, room, isRoomAssignedToUser);

/** What the controller actually hands the service now. */
const handoff = (user) => ({ ...user, role: normalizeUserRole(user) });

const ASSIGNED_ROOM = { id: 7, number: '101', housekeeping_assigned_to: 'staff_cleaner' };
const OTHER_ROOM = { id: 8, number: '102', housekeeping_assigned_to: 'staff_someone_else' };
const UNASSIGNED_ROOM = { id: 9, number: '103', housekeeping_assigned_to: null };

ok('CLEANER + assigned room    -> ALLOWED',
  guardDenies(handoff(ROLES.CLEANER), ASSIGNED_ROOM) === false);
ok('CLEANER + another\'s room   -> DENIED',
  guardDenies(handoff(ROLES.CLEANER), OTHER_ROOM) === true);
ok('CLEANER + unassigned room  -> DENIED',
  guardDenies(handoff(ROLES.CLEANER), UNASSIGNED_ROOM) === true);
ok('ADMIN unrestricted on any room',
  guardDenies(handoff(ROLES.ADMIN), OTHER_ROOM) === false);
ok('RECEPTIONIST unrestricted on any room',
  guardDenies(handoff(ROLES.RECEPTIONIST), OTHER_ROOM) === false);
ok('matching by uid, id or mysql_id all identify the assignee',
  isRoomAssignedToUser({ uid: 'x', id: 42 }, { housekeeping_assigned_to: 42 }) === true &&
  isRoomAssignedToUser({ uid: 'staff_9' }, { housekeeping_assigned_to: 'staff_9' }) === true);
ok('the read path (getHousekeepingRooms) still normalizes too',
  HK_SRC.includes('role: normalizeUserRole(req.user)'), 'unchanged, still correct');

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 5. NEGATIVE CONTROLS — these tests can actually fail ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  // Restore the pre-Group-11 requireAdmin condition and re-run the matrix.
  const OLD = `if (req.user.role === 'admin' || req.user.type === 'staff') return next();`;
  const oldRun = new Function('req', 'res', 'next', `
    if (!req.user) return res.status(401).json({ error: 'Authorization token required' });
    ${OLD}
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  `);
  const oldCall = (user) => { const c = makeCtx(user); oldRun(c.req, c.res, c.next); return c.out; };
  const leaked = ['RECEPTIONIST', 'CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY', 'CLEANER']
    .filter(r => oldCall(ROLES[r]).nexted === true);
  ok('N1  the OLD requireAdmin admitted every non-admin staff role',
    leaked.length === 5, `${leaked.join(', ')} — §2 would go red if restored`);
  ok('N1b and the CURRENT one admits none of them',
    ['RECEPTIONIST', 'CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY', 'CLEANER']
      .every(r => callRequireAdmin(ROLES[r]).nexted === false));
}
{
  // Revert the controller handoff: pass req.user raw, as before.
  const rawCaller = ROLES.CLEANER;  // role === 'CLEANER', not normalized
  ok('N2  reverting caller normalization makes the ownership guard silently pass',
    guardDenies(rawCaller, OTHER_ROOM) === false,
    'a cleaner could edit another cleaner\'s room — §4 would go red');
}
{
  // Restore the fail-open flag read.
  const oldStrict = () => process.env.ENABLE_STRICT_RBAC === 'true';
  const oldCall = withFlag(undefined, () => {
    const c = makeCtx(ROLES.CLEANER);
    runRequireRole(c.req, c.res, c.next, ['admin', 'receptionist'], normalizeUserRole, oldStrict);
    return c.out;
  });
  ok('N3  the OLD fail-open read admitted a cleaner when the flag was missing',
    oldCall.nexted === true, '§3 missing-variable test would go red');
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 6. AFFECTED ROUTES STILL GATED BY requireAdmin ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const routeFile = (f) => fs.readFileSync(path.join(BACKEND, 'routes', f), 'utf8');
ok('all 11 /api/reports routes sit behind one requireAdmin mount',
  /router\.use\(authenticate,\s*requireAdmin\)/.test(routeFile('reportsRoutes.js')) &&
  (routeFile('reportsRoutes.js').match(/^router\.get\(/gm) || []).length === 11,
  `${(routeFile('reportsRoutes.js').match(/^router\.get\(/gm) || []).length} report routes`);
ok('POST /settings/hotel-config still requires admin',
  /hotel-config',\s*authenticate,\s*requireAdmin/.test(routeFile('api.js')));
ok('POST /invoices/generate/:bookingId still requires admin',
  /generate\/:bookingId',\s*authenticate,\s*requireAdmin/.test(routeFile('invoiceRoutes.js')));
ok('PUT /payments/.../confirm-cash still requires admin',
  /confirm-cash',\s*authenticate,\s*requireAdmin/.test(routeFile('paymentRoutes.js')));
ok('inventory routes still avoid requireAdmin entirely',
  !/requireAdmin\s*,/.test(routeFile('inventoryRoutes.js')));
ok('requireSuperAdmin gates are untouched',
  /requireSuperAdmin/.test(routeFile('factoryResetRoutes.js')) &&
  /dayend\/undo',\s*authenticate,\s*requireSuperAdmin/.test(routeFile('api.js')));

console.log(`\n═══ RBAC AUTHORIZATION MATRIX: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail === 0 ? 0 : 1);
