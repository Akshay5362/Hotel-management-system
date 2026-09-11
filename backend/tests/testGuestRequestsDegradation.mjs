/**
 * testGuestRequestsDegradation.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Guest-request endpoint behaviour when Firestore is unavailable.
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 *
 *     Firestore unavailable
 *       → MySQL fallback attempted
 *       → ER_MYSQL_DECOMMISSIONED guard throws
 *       → HTTP 500
 *       → the badge poller repeats it every 15 seconds
 *
 * and its quieter sibling: answering `{ requests: [], total: 0 }`, which tells
 * reception the hotel has nothing waiting when the truth is that nobody knows.
 *
 * USES NO FIRESTORE. The service is stubbed, so this costs no read quota and
 * runs while the DEV project is exhausted. `pool` is stubbed too, and any call
 * to it is recorded — that recording is the proof the fallback is not attempted.
 *
 * Run:  HPMS_ENV=development node backend/tests/testGuestRequestsDegradation.mjs
 */

import path from 'path';
import { createRequire } from 'module';

const BACKEND = path.join(process.cwd(), 'backend');
const require_ = createRequire(path.join(BACKEND, 'package.json'));

// ── Guard 1 ──────────────────────────────────────────────────────────────────
if (process.env.HPMS_ENV !== 'development') {
  console.error(`[SAFETY_ABORT] HPMS_ENV must be "development" (got ${JSON.stringify(process.env.HPMS_ENV)}).`);
  process.exit(1);
}
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });

// ── Guard 2 ──────────────────────────────────────────────────────────────────
const { isProductionProject } = await import('../config/productionSafetyGuard.js');
if (isProductionProject()) { console.error('[SAFETY_ABORT] Resolved Firebase project looks like production.'); process.exit(1); }

// ── Guards 3 + 4 ─────────────────────────────────────────────────────────────
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }
console.log(`[GUARD] project=${PROJECT} (DEV) — no Firestore read is performed by this suite\n`);

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${detail ? '  ' + detail : ''}`); }
};

// ── Stubs ────────────────────────────────────────────────────────────────────
const { GuestRequestsService } = await import('../services/guestRequestsService.js');
const pool = (await import('../db.js')).default;
const {
  getGuestRequests, _resetGuestRequestsDegradedState, _getGuestRequestsUnavailableUntil
} = await import('../controllers/auditController.js');

const realGetGuestRequests = GuestRequestsService.getGuestRequests;
const realQuery = pool.query;

/** Records every MySQL call. A non-empty list is the bug reappearing. */
let mysqlCalls = [];
pool.query = async (...args) => {
  mysqlCalls.push(String(args[0]).slice(0, 60).replace(/\s+/g, ' '));
  return realQuery.apply(pool, args);          // still hits the real guard
};

const quotaError = () => {
  const e = new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.');
  e.code = 8;
  e.details = 'Quota exceeded.';
  return e;
};

/** Minimal express-shaped res that records what the controller produced. */
const makeRes = () => {
  const res = {
    statusCode: 200, payload: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; },
    set(k, v) { this.headers[k] = v; return this; }
  };
  return res;
};
const call = async () => {
  const res = makeRes();
  await getGuestRequests({ user: { id: 'admin', role: 'admin' } }, res);
  return res;
};

const SUCCESS_PAYLOAD = {
  requests: [
    { id: 'svc_1', desc: 'Extra towels', request_type: 'service', status: 'Pending', room_number: '101' },
    { id: 'mnt_2', desc: 'AC not cooling', request_type: 'maintenance', status: 'Pending', room_number: '102' }
  ],
  total: 2
};

console.log(`  DISABLE_MYSQL_CUTOVER_FALLBACKS = ${process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS}\n`);

// ═════════════════════════════════════════════════════════════════════════════
console.log('═══ 1. FIRESTORE HEALTHY — THE EXISTING CONTRACT IS UNCHANGED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  _resetGuestRequestsDegradedState();
  mysqlCalls = [];
  GuestRequestsService.getGuestRequests = async () => SUCCESS_PAYLOAD;

  const res = await call();
  ok('1. a healthy read answers 200', res.statusCode === 200, String(res.statusCode));
  ok('  the response shape is exactly what the service returned',
    JSON.stringify(res.payload) === JSON.stringify(SUCCESS_PAYLOAD));
  ok('  it carries the requests array', Array.isArray(res.payload.requests) && res.payload.requests.length === 2);
  ok('  it carries the total', res.payload.total === 2);
  ok('  no MySQL query was made on the healthy path', mysqlCalls.length === 0, mysqlCalls.join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. FIRESTORE FAILS — 503, AND NO MySQL FALLBACK ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  _resetGuestRequestsDegradedState();
  mysqlCalls = [];
  GuestRequestsService.getGuestRequests = async () => { throw quotaError(); };

  const res = await call();
  ok('2. a Firestore failure answers 503, not 500', res.statusCode === 503, String(res.statusCode));
  ok('3. the MySQL fallback was NOT attempted', mysqlCalls.length === 0,
    mysqlCalls.length ? `pool.query called ${mysqlCalls.length}×: ${mysqlCalls[0]}` : 'zero MySQL calls');
  ok('  so the ER_MYSQL_DECOMMISSIONED guard was never reached',
    !JSON.stringify(res.payload).includes('MYSQL_DECOMMISSIONED'));

  // 4. no fake zero.
  ok('4. the response contains NO total', res.payload.total === undefined, JSON.stringify(res.payload.total));
  ok('4. the response contains NO requests array', res.payload.requests === undefined);
  ok('  it is explicitly marked degraded', res.payload.degraded === true && res.payload.firestore_degraded === true);
  ok('  it names the reason as a quota exhaustion', res.payload.code === 'FIRESTORE_RESOURCE_EXHAUSTED', res.payload.code);
  ok('  it tells the caller when to retry',
    Number(res.payload.retry_after_seconds) > 0 && Number(res.headers['Retry-After']) > 0,
    `body=${res.payload.retry_after_seconds}s header=${res.headers['Retry-After']}`);

  // No internals leaked.
  const blob = JSON.stringify(res.payload);
  ok('  no stack trace is exposed', !/\bat \w|\.js:\d+/.test(blob));
  ok('  no Firebase or gRPC internals are exposed', !/grpc|firestore\.googleapis|serviceAccount|credential/i.test(blob));
  ok('  no raw error message is echoed back', !blob.includes('RESOURCE_EXHAUSTED: Quota exceeded'));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. THE OUTAGE DOES NOT KEEP SPENDING QUOTA ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  _resetGuestRequestsDegradedState();
  let serviceCalls = 0;
  GuestRequestsService.getGuestRequests = async () => { serviceCalls++; throw quotaError(); };

  const first = await call();
  ok('the first failing call reaches the service once', serviceCalls === 1, String(serviceCalls));
  ok('  and opens a negative-cache window', _getGuestRequestsUnavailableUntil() > Date.now());

  const second = await call();
  const third = await call();
  ok('subsequent calls inside the window do NOT touch Firestore again', serviceCalls === 1, `${serviceCalls} service call(s)`);
  ok('  and still answer 503', second.statusCode === 503 && third.statusCode === 503);
  ok('  and still never report zero', second.payload.total === undefined && third.payload.total === undefined);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. RECOVERY — A GOOD READ CLEARS THE DEGRADED STATE ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  _resetGuestRequestsDegradedState();
  GuestRequestsService.getGuestRequests = async () => { throw quotaError(); };
  await call();
  ok('the endpoint is in its degraded window', _getGuestRequestsUnavailableUntil() > Date.now());

  // Firestore comes back. Clear the window as the real elapsed time would.
  _resetGuestRequestsDegradedState();
  GuestRequestsService.getGuestRequests = async () => SUCCESS_PAYLOAD;
  const res = await call();
  ok('a successful read answers 200 again', res.statusCode === 200);
  ok('  with the real total', res.payload.total === 2);
  ok('  and the degraded window is cleared', _getGuestRequestsUnavailableUntil() === 0);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 5. AN UNEXPECTED PAYLOAD IS NOT TREATED AS EMPTY ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  _resetGuestRequestsDegradedState();
  mysqlCalls = [];
  GuestRequestsService.getGuestRequests = async () => ({ unexpected: true });   // no requests array
  const res = await call();
  ok('a malformed service payload answers 503, not an empty list', res.statusCode === 503, String(res.statusCode));
  ok('  and reports no total', res.payload.total === undefined);
  ok('  and still attempts no MySQL fallback', mysqlCalls.length === 0);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 6. WHEN THE FALLBACK IS ENABLED, IT IS STILL USED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  // The general fallback mechanism must not be removed globally — only skipped
  // while the runtime is Firestore-only.
  const savedFlag = process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS;
  process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS = 'false';
  _resetGuestRequestsDegradedState();
  mysqlCalls = [];
  GuestRequestsService.getGuestRequests = async () => { throw new Error('firestore down'); };

  const res = await call();
  ok('6. with fallbacks enabled the MySQL path IS attempted', mysqlCalls.length > 0,
    `${mysqlCalls.length} MySQL call(s)`);
  ok('  and the endpoint does not answer 503 in that mode', res.statusCode !== 503, String(res.statusCode));

  process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS = savedFlag;
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 7. THE STORM ITSELF — 20 POLLS DURING AN OUTAGE ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  _resetGuestRequestsDegradedState();
  mysqlCalls = [];
  let serviceCalls = 0, fiveHundreds = 0, fakeZeros = 0;
  GuestRequestsService.getGuestRequests = async () => { serviceCalls++; throw quotaError(); };

  for (let i = 0; i < 20; i++) {
    const res = await call();
    if (res.statusCode === 500) fiveHundreds++;
    if (res.payload && res.payload.total === 0) fakeZeros++;
  }
  ok('20 polls during an outage produce ZERO HTTP 500 responses', fiveHundreds === 0, `${fiveHundreds} × 500`);
  ok('  produce ZERO MySQL fallback attempts', mysqlCalls.length === 0, `${mysqlCalls.length} MySQL call(s)`);
  ok('  produce ZERO false "0 requests" answers', fakeZeros === 0, `${fakeZeros} fake zeros`);
  ok('  and reach Firestore only once, not twenty times', serviceCalls === 1, `${serviceCalls} service call(s)`);
}

// ── Restore ──────────────────────────────────────────────────────────────────
GuestRequestsService.getGuestRequests = realGetGuestRequests;
pool.query = realQuery;
_resetGuestRequestsDegradedState();

console.log(`\n═══ GUEST REQUESTS DEGRADATION RESULT: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed checks:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail === 0 ? 0 : 1);
