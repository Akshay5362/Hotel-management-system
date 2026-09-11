/**
 * scripts/guestRequestLoopCheck.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Proof for the guest-request rapid-request loop fix (Fixes A–D).
 *
 * These are BEHAVIOURAL tests, not source greps. The bodies of the real
 * functions are lifted verbatim out of src/App.jsx and
 * src/components/GuestRequestsModal.jsx at run time and executed against
 * injected doubles for React refs, timers, fetch and socket.io.
 *
 * §6 disables each real guard in turn, in a copy of the lifted body, and
 * asserts the matching test then goes red — so nothing here is decorative.
 * It also records that Fix A's two guards are redundant with each other:
 * either one alone still prevents the orphan timer.
 *
 * src/config/apiConfig.js is imported for real (bundled with a stub for
 * firebaseClient, so no Firebase SDK loads and no credentials are needed).
 *
 * No network. No Firestore. No quota. Nothing is written anywhere.
 *
 * Run:  node scripts/guestRequestLoopCheck.mjs
 */
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { pathToFileURL, fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require_ = createRequire(path.join(ROOT, 'package.json'));
const esbuild = require_('esbuild');

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${detail ? '  ' + detail : ''}`); }
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ═════════════════════════════════════════════════════════════════════════════
// Source extraction
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Lifts a function body out of a source file by brace matching.
 *
 * @param {string} src file text
 * @param {string} marker unique text identifying the function
 * @param {string} label used in the error when the marker is gone
 * @param {boolean} fromStart true when the opening `{` is the first one at or
 *   after the marker (an arrow effect); false when the marker itself ends on
 *   the opening `{` (a callback with a destructured parameter before it)
 * @returns {{body: string, close: number}} body text, and the index of `}`
 */
function sliceBody(src, marker, label, fromStart) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`extraction failed: ${label} — marker not found:\n${marker}`);
  if (src.indexOf(marker, at + 1) >= 0) throw new Error(`extraction failed: ${label} — marker is not unique`);
  const open = fromStart ? src.indexOf('{', at) : src.indexOf('{', at + marker.length - 1);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`extraction failed: ${label} — unbalanced braces`);
  return { body: src.slice(open + 1, i), close: i };
}

// Normalised to LF: these files are checked out CRLF on Windows, and the
// multi-line markers below are written with LF.
const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g');
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(CRLF, '\n');
const APP_SRC = readSrc('src', 'App.jsx');
const MODAL_SRC = readSrc('src', 'components', 'GuestRequestsModal.jsx');

const SOCKET_EFFECT_MARKER = `useEffect(() => {
    if (!hasAdminSession) return;
    fetchRequestCountRef.current();`;
const FETCH_COUNT_MARKER = `const fetchRequestCount = useCallback(async ({ fromPoll = false } = {}) => {`;
const TAB_EFFECT_MARKER = `useEffect(() => {
    if (!hasAdminSession) return;
    if (!isRequestCountVisible(adminTab)) return;`;
const MODAL_FETCH_MARKER = `const fetchRequests = useCallback(async (silent = false, { fromPoll = false } = {}) => {`;
const MODAL_EFFECT_MARKER = `useEffect(() => {
    if (!isOpen) return undefined;`;

const socketEffect = sliceBody(APP_SRC, SOCKET_EFFECT_MARKER, 'App socket effect', true);
const fetchCount = sliceBody(APP_SRC, FETCH_COUNT_MARKER, 'App fetchRequestCount', false);
const tabEffect = sliceBody(APP_SRC, TAB_EFFECT_MARKER, 'App tab-change effect', true);
const modalFetch = sliceBody(MODAL_SRC, MODAL_FETCH_MARKER, 'Modal fetchRequests', false);
const modalEffect = sliceBody(MODAL_SRC, MODAL_EFFECT_MARKER, 'Modal poll effect', true);

/** The `[dep, dep]` array that follows a lifted body. */
const depsAfter = (src, sliced) => {
  const m = src.slice(sliced.close).match(/^\}\s*,\s*\[([^\]]*)\]/);
  return m ? m[1].trim() : null;
};

console.log('Lifted from source (line counts prove a body was found, not an empty match):');
console.log(`  App.jsx socket effect        ${socketEffect.body.split('\n').length} lines`);
console.log(`  App.jsx fetchRequestCount    ${fetchCount.body.split('\n').length} lines`);
console.log(`  App.jsx tab-change effect    ${tabEffect.body.split('\n').length} lines`);
console.log(`  Modal fetchRequests          ${modalFetch.body.split('\n').length} lines`);
console.log(`  Modal poll effect            ${modalEffect.body.split('\n').length} lines`);

// ═════════════════════════════════════════════════════════════════════════════
// Doubles
// ═════════════════════════════════════════════════════════════════════════════
function makeTimers() {
  const live = new Map();
  let next = 1;
  return {
    setInterval(fn, ms) { const id = next++; live.set(id, { fn, ms }); return id; },
    clearInterval(id) { if (id != null) live.delete(id); },
    /** Fire every timer still alive, once. Orphans fire too — that is the bug. */
    tick() { [...live.values()].forEach(t => t.fn()); },
    count() { return live.size; },
    periods() { return [...live.values()].map(t => t.ms); }
  };
}

/**
 * socket.io-client 4.8.3 semantics, reduced to what matters:
 * disconnect() -> destroy(), then onclose() -> emitReserved('disconnect'), and
 * the reserved emit runs local listeners SYNCHRONOUSLY — but only when the
 * socket had actually connected. That asymmetry is the orphan-timer mechanism.
 */
function makeSocket() {
  const handlers = {};
  return {
    connected: false,
    disconnectCalls: 0,
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    events() { return Object.keys(handlers).sort(); },
    emit(ev, ...a) { (handlers[ev] || []).forEach(f => f(...a)); },
    __connect() { this.connected = true; (handlers.connect || []).forEach(f => f()); },
    __drop() { if (this.connected) { this.connected = false; (handlers.disconnect || []).forEach(f => f('transport close')); } },
    disconnect() {
      this.disconnectCalls++;
      const was = this.connected;
      this.connected = false;
      if (was) (handlers.disconnect || []).forEach(f => f('io client disconnect'));
    }
  };
}

const QUIET = { log() {}, warn() {}, error() {} };

const runSocketEffect = new Function(
  'hasAdminSession', 'io', 'SOCKET_URL', 'fetchRequestCountRef', 'REQUEST_COUNT_POLL_MS',
  'setInterval', 'clearInterval', 'console', 'document', 'CustomEvent',
  socketEffect.body
);

/** Mounts the real socket effect. Returns { socket, cleanup }. */
function mountSocketEffect(timers, fetcher, hasAdminSession = true) {
  let socket = null;
  const cleanup = runSocketEffect(
    hasAdminSession,
    () => { socket = makeSocket(); return socket; },
    'http://localhost:5001',
    { current: fetcher },
    15000,
    timers.setInterval, timers.clearInterval, QUIET,
    { dispatchEvent() {} },
    class { constructor(n) { this.type = n; } }
  );
  return { socket, cleanup };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 1. FIX A — SOCKET CLEANUP AND THE FALLBACK TIMER ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const t = makeTimers();
  const { socket, cleanup } = mountSocketEffect(t, () => {});
  socket.__connect();
  ok('T1  a connected socket runs with no fallback timer', t.count() === 0, `${t.count()} live`);
  cleanup();
  ok('T1  tearing down a CONNECTED socket leaves ZERO orphan timers', t.count() === 0, `${t.count()} live`);
  ok('T1    and the socket really was disconnected', socket.disconnectCalls === 1);
}
{
  const t = makeTimers();
  const { socket, cleanup } = mountSocketEffect(t, () => {});
  cleanup();
  ok('T2  tearing down a socket that never connected leaves zero timers',
    t.count() === 0 && socket.disconnectCalls === 1, `${t.count()} live`);
}
{
  // Five effect re-runs — the shape a burst of token refreshes used to produce.
  const t = makeTimers();
  let peak = 0;
  for (let i = 0; i < 5; i++) {
    const { socket, cleanup } = mountSocketEffect(t, () => {});
    socket.__connect();
    peak = Math.max(peak, t.count());
    cleanup();
    peak = Math.max(peak, t.count());
  }
  ok('T3  5 mount/teardown cycles never exceed 1 live fallback timer', peak <= 1, `peak ${peak}`);
  ok('T3    and leave zero behind', t.count() === 0, `${t.count()} live`);
}
{
  // React StrictMode: mount, cleanup, mount. The first socket never connects.
  const t = makeTimers();
  const a = mountSocketEffect(t, () => {});
  a.cleanup();
  const b = mountSocketEffect(t, () => {});
  b.socket.__connect();
  ok('T4  StrictMode double-invoke leaves one live socket and zero timers', t.count() === 0, `${t.count()} live`);
  b.cleanup();
  ok('T4    and then tears down clean', t.count() === 0);
}
{
  const t = makeTimers();
  const { socket, cleanup } = mountSocketEffect(t, () => {});
  socket.__connect();
  socket.__drop();
  ok('T5  a network drop starts exactly 1 fallback timer', t.count() === 1, `${t.count()} live`);
  ok('T5    beating at the intended 15s', t.periods().join() === '15000', t.periods().join());
  socket.__drop();
  socket.__drop();
  ok('T5    further drops do not stack timers', t.count() === 1, `${t.count()} live`);
  socket.__connect();
  ok('T5    reconnecting cancels the fallback', t.count() === 0, `${t.count()} live`);
  for (let i = 0; i < 10; i++) { socket.__drop(); socket.__connect(); }
  ok('T6  10 drop/reconnect cycles leave zero timers', t.count() === 0, `${t.count()} live`);
  socket.__drop();
  cleanup();
  ok('T6    tearing down mid-outage clears the running fallback', t.count() === 0, `${t.count()} live`);
}
{
  const t = makeTimers();
  const { socket, cleanup } = mountSocketEffect(t, () => {}, false);
  ok('T7  with no admin session no socket is opened at all', socket === null && cleanup === undefined);
  ok('T7    and no timer is created', t.count() === 0);
}
{
  // Negative control: the pre-fix ordering, to show these assertions can fail.
  const t = makeTimers();
  const s = makeSocket();
  let interval = null;
  s.on('connect', () => { if (interval) { t.clearInterval(interval); interval = null; } });
  s.on('disconnect', () => { if (!interval) interval = t.setInterval(() => {}, 15000); });
  s.__connect();
  if (interval) t.clearInterval(interval);   // pre-fix cleanup: clear, THEN disconnect
  s.disconnect();
  ok('T8  NEGATIVE CONTROL — the pre-fix ordering DOES orphan a timer',
    t.count() === 1, `${t.count()} orphan(s), so T1–T6 would catch a regression`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. FIX B — 401 REFRESH/RETRY BOUNDARY (real apiConfig.js) ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const outDir = path.join(ROOT, 'node_modules', '.cache', 'guest-request-loop');
fs.mkdirSync(outDir, { recursive: true });

/** Replaces firebaseClient with a live getter, so no Firebase SDK is loaded. */
const stubFirebase = {
  name: 'stub-firebase',
  setup(b) {
    b.onResolve({ filter: /firebaseClient$/ }, () => ({ path: 'fb', namespace: 'fbstub' }));
    b.onLoad({ filter: /.*/, namespace: 'fbstub' }, () => ({
      contents: 'export const auth = { get currentUser() { return globalThis.__TEST_USER__ || null; } };',
      loader: 'js'
    }));
  }
};

const apiOut = path.join(outDir, 'apiConfig.test.mjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'config', 'apiConfig.js')],
  bundle: true, format: 'esm', platform: 'neutral', outfile: apiOut,
  plugins: [stubFirebase], logLevel: 'silent'
});
const api = await import(pathToFileURL(apiOut).href);
ok('the real apiConfig.js bundles and exposes its refresh-counting seam',
  typeof api.authenticatedFetch === 'function' && typeof api._resetTokenRefreshDiagnostics === 'function');

/** A fetch double driven by a list of statuses, one per call. */
function installFetch(statuses) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)];
    calls.push({ url, auth: (opts.headers || {}).Authorization || null });
    return { status, ok: status >= 200 && status < 300, json: async () => ({ total: 1 }) };
  };
  return calls;
}

{
  api._resetTokenRefreshDiagnostics();
  let refreshes = 0;
  globalThis.__TEST_USER__ = { getIdToken: async (force) => { if (force) refreshes++; return 'fresh-token'; } };
  const calls = installFetch([401, 200]);
  const res = await api.authenticatedFetch('http://x/api/admin/guest-requests', {}, 'stale-token');
  ok('T9  a 401 forces exactly ONE token refresh', refreshes === 1, `${refreshes}`);
  ok('T9    and exactly ONE retry — 2 requests total, never a loop', calls.length === 2, `${calls.length} requests`);
  ok('T9    the retry carries the refreshed token', calls[1].auth === 'Bearer fresh-token', String(calls[1].auth));
  ok('T9    and the caller receives the retried response', res.status === 200);
}
{
  api._resetTokenRefreshDiagnostics();
  let refreshes = 0;
  globalThis.__TEST_USER__ = { getIdToken: async () => { refreshes++; return 'fresh-token'; } };
  const calls = installFetch([401, 401]);
  let thrown = null;
  try { await api.authenticatedFetch('http://x/api/admin/guest-requests', {}, 'stale'); }
  catch (e) { thrown = e; }
  ok('T10 a second 401 TERMINATES instead of refreshing again', refreshes === 1, `${refreshes} refresh(es)`);
  ok('T10   with no third request', calls.length === 2, `${calls.length} requests`);
  ok('T10   and an AuthenticationError the caller can tell apart from a server error',
    thrown instanceof api.AuthenticationError, thrown && thrown.name);
}
{
  api._resetTokenRefreshDiagnostics();
  globalThis.__TEST_USER__ = null;                  // signed out
  const calls = installFetch([401]);
  let thrown = null;
  try { await api.authenticatedFetch('http://x/api/admin/guest-requests', {}, 'stale'); }
  catch (e) { thrown = e; }
  ok('T11 with no signed-in user a 401 fails immediately, no retry',
    thrown instanceof api.AuthenticationError && calls.length === 1, `${calls.length} request(s)`);
}
{
  // The read-amplification case: several callers 401 at the same moment.
  api._resetTokenRefreshDiagnostics();
  let refreshes = 0, release;
  const gate = new Promise(r => { release = r; });
  globalThis.__TEST_USER__ = { getIdToken: async () => { refreshes++; await gate; return 'fresh-token'; } };
  installFetch([401, 401, 401, 401, 401, 200, 200, 200, 200, 200]);
  const flight = Promise.all(Array.from({ length: 5 }, () =>
    api.authenticatedFetch('http://x/api/admin/guest-requests', {}, 'stale')));
  await new Promise(r => setTimeout(r, 5));
  release();
  const results = await flight;
  ok('T12 5 concurrent 401s force exactly ONE token refresh', refreshes === 1, `${refreshes} refresh(es)`);
  ok('T12   confirmed independently by the diagnostic seam',
    api._tokenRefreshDiagnostics.forcedRefreshes === 1, `${api._tokenRefreshDiagnostics.forcedRefreshes}`);
  ok('T12   and all 5 callers still get their answer', results.every(r => r.status === 200));
}
{
  // Deliberately not a cache: a later 401 must get a genuinely fresh token.
  api._resetTokenRefreshDiagnostics();
  let refreshes = 0;
  globalThis.__TEST_USER__ = { getIdToken: async () => { refreshes++; return `t${refreshes}`; } };
  installFetch([401, 200]);
  await api.authenticatedFetch('http://x/a', {}, 'stale');
  const second = installFetch([401, 200]);
  await api.authenticatedFetch('http://x/a', {}, 'stale');
  ok('T13 the shared refresh is in-flight only — a later 401 refreshes again',
    refreshes === 2, `${refreshes} refresh(es)`);
  ok('T13   with a genuinely different token', second[1].auth === 'Bearer t2', String(second[1].auth));
}
{
  api._resetTokenRefreshDiagnostics();
  let refreshes = 0;
  globalThis.__TEST_USER__ = { getIdToken: async () => { refreshes++; return 'x'; } };
  const good = installFetch([200]);
  const res = await api.authenticatedFetch('http://x/a', {}, 'good-token');
  ok('T14 a healthy 200 makes one request and forces no refresh',
    good.length === 1 && refreshes === 0 && res.status === 200);
  const degraded = installFetch([503]);
  const r503 = await api.authenticatedFetch('http://x/a', {}, 'good-token');
  ok('T14   a 503 is handed back to the caller, not retried and not thrown',
    degraded.length === 1 && r503.status === 503);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. FIX C — THE BADGE COUNT FETCHER ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const runFetchCount = new AsyncFunction(
  'adminToken', 'requestCountInFlightRef', 'isRequestCountVisible', 'adminTabRef',
  'requestCountBackoffRef', 'authenticatedFetch', 'API_URL', 'setRequestCount',
  'scheduleRequestCountBackoff', 'AuthenticationError', 'console', '__opts',
  `const { fromPoll = false } = __opts || {}; ${fetchCount.body}`
);

/** Runs the real fetchRequestCount body against injected state. */
function makeCountFetcher({ token = 'tok', tab = 'rooms', statuses = [200], total = 4 } = {}) {
  const state = {
    count: undefined, setterCalls: [], fetches: [], backoffScheduled: 0,
    inFlight: { current: false },
    backoff: { current: { failures: 0, nextAllowedAt: 0 } },
    tabRef: { current: tab }
  };
  let i = 0;
  const authenticatedFetch = async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    state.fetches.push(status);
    if (status === 'throw-auth') throw new api.AuthenticationError();
    if (status === 'throw-net') throw new Error('network down');
    return { ok: status === 200, status, json: async () => ({ total }) };
  };
  const call = (opts) => runFetchCount(
    token, state.inFlight, (t) => !['food', 'inventory'].includes(t), state.tabRef,
    state.backoff, authenticatedFetch, 'http://localhost:5001/api',
    (v) => { state.count = v; state.setterCalls.push(v); },
    () => {
      state.backoffScheduled++;
      const failures = state.backoff.current.failures + 1;
      state.backoff.current = { failures, nextAllowedAt: Date.now() + [30000, 60000][Math.min(failures - 1, 1)] };
    },
    api.AuthenticationError, QUIET, opts
  );
  return { state, call };
}

{
  const { state, call } = makeCountFetcher({ statuses: [200], total: 7 });
  await call();
  ok('T15 a healthy read sets the count', state.count === 7, String(state.count));
  ok('T15   and clears any backoff', state.backoff.current.nextAllowedAt === 0);
}
{
  const { state, call } = makeCountFetcher({ statuses: [503] });
  await call();
  ok('T16 a 503 NEVER sets the count to 0', state.setterCalls.length === 0, `${state.setterCalls.length} setter call(s)`);
  ok('T16   the badge keeps saying "unknown", not "no requests"', state.count === undefined);
  ok('T16   and a backoff window opens',
    state.backoffScheduled === 1 && state.backoff.current.nextAllowedAt > Date.now());
}
{
  for (const s of [500, 502, 429, 'throw-net', 'throw-auth']) {
    const { state, call } = makeCountFetcher({ statuses: [s] });
    await call();
    ok(`T17 ${String(s).padEnd(10)} leaves the count untouched and backs off`,
      state.setterCalls.length === 0 && state.backoffScheduled === 1);
  }
}
{
  // A poll storm during an outage: the interval keeps its 15s beat, the fetcher
  // declines to act. 20 ticks must not become 20 requests.
  const { state, call } = makeCountFetcher({ statuses: [503] });
  for (let i = 0; i < 20; i++) await call({ fromPoll: true });
  ok('T18 20 poll ticks during an outage make 1 request, not 20',
    state.fetches.length === 1, `${state.fetches.length} request(s) in the 30s window`);
}
{
  const { state, call } = makeCountFetcher({ statuses: [200] });
  state.inFlight.current = true;
  await call();
  ok('T19 the in-flight guard blocks a concurrent call', state.fetches.length === 0);
}
{
  for (const tab of ['food', 'inventory']) {
    const { state, call } = makeCountFetcher({ tab, statuses: [200] });
    await call({ fromPoll: true });
    ok(`T20 a poll on the "${tab}" tab makes no request`, state.fetches.length === 0);
    await call();
    ok(`T20   but an explicit fetch on "${tab}" still works`, state.fetches.length === 1);
  }
  const { state, call } = makeCountFetcher({ tab: 'rooms', statuses: [200] });
  await call({ fromPoll: true });
  ok('T20   and a poll on a visible tab is not suppressed', state.fetches.length === 1);
}
{
  const { state, call } = makeCountFetcher({ token: '', statuses: [200] });
  await call();
  ok('T21 no token means no request at all', state.fetches.length === 0);
}
{
  // The backoff must not wedge the poller permanently.
  const { state, call } = makeCountFetcher({ statuses: [503, 200, 200] });
  await call();
  state.backoff.current = { failures: 1, nextAllowedAt: 0 };   // the window elapses
  await call({ fromPoll: true });
  ok('T22 once the window elapses the poller recovers', state.count === 4, String(state.count));
  ok('T22   and the backoff resets to zero', state.backoff.current.failures === 0);
}
console.log('');
{
  // Fix C's actual subject: the effects must key off booleans, not the callback
  // identity, or every token refresh re-runs them.
  const socketDeps = depsAfter(APP_SRC, socketEffect);
  ok('T23 the socket effect depends only on hasAdminSession',
    socketDeps === 'hasAdminSession', String(socketDeps));
  ok('T23   so a token refresh cannot tear down a live socket',
    socketDeps !== null && !/adminToken|fetchRequestCount/.test(socketDeps));
  const tabDeps = depsAfter(APP_SRC, tabEffect);
  ok('T24 the tab effect depends only on the tab and the session boolean',
    tabDeps === 'adminTab, hasAdminSession', String(tabDeps));
  ok('T25 hasAdminSession is a boolean, so refreshing a token cannot change it',
    /const hasAdminSession = Boolean\(/.test(APP_SRC));
  ok('T26 the effects call through a ref, so they can never hold a stale fetcher',
    /const fetchRequestCountRef = useRef\(fetchRequestCount\)/.test(APP_SRC) &&
    /fetchRequestCountRef\.current = fetchRequestCount/.test(APP_SRC));
  ok('T26   and no effect calls the callback directly any more',
    !/fetchRequestCount\(/.test(socketEffect.body + tabEffect.body));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. FIX D — THE GUEST REQUESTS MODAL ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const runModalFetch = new AsyncFunction(
  'token', 'inFlightRef', 'backoffRef', 'setLoading', 'authenticatedFetch', 'API_URL',
  'setRequests', 'setLastUpdated', 'setDegraded', 'MODAL_BACKOFF_MS',
  'AuthenticationError', 'console', 'silent', '__opts',
  `const { fromPoll = false } = __opts || {}; ${modalFetch.body}`
);

function makeModal({ token = 'tok', statuses = [200], requests = [{ id: 'r1' }] } = {}) {
  const state = {
    requests: null, loading: false, lastUpdated: null, degraded: null,
    fetches: [], setRequestsCalls: [],
    inFlight: { current: false },
    backoff: { current: { failures: 0, nextAllowedAt: 0 } }
  };
  let i = 0;
  const authenticatedFetch = async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    state.fetches.push(status);
    if (status === 'throw-auth') throw new api.AuthenticationError();
    if (status === 'throw-net') throw new Error('offline');
    return { ok: status === 200, status, json: async () => ({ requests }) };
  };
  const fetchRequests = (silent = false, opts) => runModalFetch(
    token, state.inFlight, state.backoff, (v) => { state.loading = v; },
    authenticatedFetch, 'http://localhost:5001/api',
    (v) => { state.requests = v; state.setRequestsCalls.push(v); },
    (v) => { state.lastUpdated = v; }, (v) => { state.degraded = v; },
    [30000, 60000], api.AuthenticationError, QUIET, silent, opts
  );
  return { state, fetchRequests };
}

{
  const { state, fetchRequests } = makeModal({ statuses: [200], requests: [{ id: 'a' }, { id: 'b' }] });
  await fetchRequests(false);
  ok('T27 a healthy open loads the full request list', state.requests.length === 2, `${state.requests.length} request(s)`);
  ok('T27   marks the feed live and stamps the time',
    state.degraded === false && state.lastUpdated instanceof Date);
  ok('T27   and clears the loading flag', state.loading === false);
}
{
  const { state, fetchRequests } = makeModal({ statuses: [200, 503], requests: [{ id: 'a' }, { id: 'b' }] });
  await fetchRequests(false);
  const known = state.requests;
  await fetchRequests(true, { fromPoll: true });
  ok('T28 a 503 does NOT replace the list with an empty one',
    state.requests === known && state.requests.length === 2, `${state.requests.length} still shown`);
  ok('T28   setRequests was never called a second time', state.setRequestsCalls.length === 1);
  ok('T28   and the modal marks itself stale rather than still claiming LIVE', state.degraded === true);
}
{
  // The loop the user reported: modal open, backend degraded.
  const { state, fetchRequests } = makeModal({ statuses: [503] });
  for (let i = 0; i < 20; i++) await fetchRequests(true, { fromPoll: true });
  ok('T29 20 poll ticks with the backend down make 1 request, not 20',
    state.fetches.length === 1, `${state.fetches.length} request(s)`);
}
{
  const { state, fetchRequests } = makeModal({ statuses: [200] });
  state.inFlight.current = true;
  await fetchRequests(true);
  ok('T30 the modal enforces one in-flight request at a time', state.fetches.length === 0);
}
{
  const { state, fetchRequests } = makeModal({ statuses: ['throw-auth', 'throw-auth'] });
  await fetchRequests(false);
  ok('T31 an expired session does not throw out of the modal', state.fetches.length === 1);
  ok('T31   the list on screen is left alone', state.setRequestsCalls.length === 0);
  ok('T31   the in-flight flag is released by the finally block', state.inFlight.current === false);
  ok('T31   and loading is cleared, so the modal cannot hang on a spinner', state.loading === false);
  await fetchRequests(true, { fromPoll: true });
  ok('T32 a failed auth backs the poller off instead of retrying at once',
    state.fetches.length === 1, `${state.fetches.length} request(s)`);
}
{
  const { state, fetchRequests } = makeModal({ token: '', statuses: [200] });
  await fetchRequests(false);
  ok('T33 no token means the modal makes no request', state.fetches.length === 0);
}
{
  // The modal's poll effect: one timer, cleaned up, backoff reset on open.
  const t = makeTimers();
  let fetchCalls = [];
  const listeners = [];
  const doc = {
    addEventListener: (ev, fn) => listeners.push([ev, fn]),
    removeEventListener: (ev, fn) => {
      const i = listeners.findIndex(l => l[0] === ev && l[1] === fn);
      if (i >= 0) listeners.splice(i, 1);
    }
  };
  const backoffRef = { current: { failures: 3, nextAllowedAt: Date.now() + 60000 } };
  const runModalEffect = new Function(
    'isOpen', 'backoffRef', 'fetchRequests', 'document',
    'setInterval', 'clearInterval', 'MODAL_POLL_MS',
    modalEffect.body
  );
  const mount = (isOpen = true) => runModalEffect(
    isOpen, backoffRef, (...a) => { fetchCalls.push(a); }, doc,
    t.setInterval, t.clearInterval, 15000
  );

  const cleanup = mount();
  ok('T34 opening the modal resets a stale backoff window',
    backoffRef.current.failures === 0 && backoffRef.current.nextAllowedAt === 0);
  ok('T34   and fetches once, visibly', fetchCalls.length === 1 && fetchCalls[0][0] === false);
  ok('T35 exactly one poll timer is installed', t.count() === 1, `${t.count()}`);
  ok('T35   at the same 15s cadence as the badge', t.periods().join() === '15000', t.periods().join());
  ok('T35   and one refresh listener is registered', listeners.length === 1);
  t.tick(); t.tick();
  ok('T35   ticks are silent polls, so the list never flashes a spinner',
    fetchCalls.slice(1).every(c => c[0] === true && c[1] && c[1].fromPoll === true),
    JSON.stringify(fetchCalls[1]));
  cleanup();
  ok('T36 closing the modal clears the timer', t.count() === 0, `${t.count()} live`);
  ok('T36   and removes the listener', listeners.length === 0, `${listeners.length} left`);
  const before = fetchCalls.length;
  t.tick();
  ok('T36   so nothing fires after close', fetchCalls.length === before);

  fetchCalls = [];
  let peak = 0;
  for (let i = 0; i < 8; i++) { const c = mount(); peak = Math.max(peak, t.count()); c(); }
  ok('T37 8 open/close cycles never exceed 1 timer and leave none',
    peak === 1 && t.count() === 0 && listeners.length === 0, `peak ${peak}, ${t.count()} left`);

  fetchCalls = [];
  const closed = mount(false);
  ok('T38 a closed modal installs no timer and makes no request',
    t.count() === 0 && fetchCalls.length === 0 && closed === undefined);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 5. NOTHING HEALTHY WAS BROKEN ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
{
  const t = makeTimers();
  const calls = [];
  const { socket, cleanup } = mountSocketEffect(t, (o) => calls.push(o));
  ok('T39 Socket.IO is intact — still created, still wiring all three events',
    socket !== null && socket.events().join(',') === 'connect,disconnect,new_guest_request',
    socket && socket.events().join(','));
  ok('T40 mounting fetches the count once', calls.length === 1);
  socket.__connect();
  socket.emit('new_guest_request');
  ok('T41 a real-time event still refreshes the badge immediately', calls.length === 2);
  ok('T41   as a direct fetch, not a throttled poll', calls[1] === undefined);
  cleanup();
}
{
  const guards = (APP_SRC.match(/adminTab !== 'food' && adminTab !== 'inventory'/g) || []).length;
  ok('T42 the Inventory room-dashboard isolation guards are intact', guards === 2, `${guards} guard(s)`);
  ok('T43 the resolve callback still refreshes the badge', /onRequestResolved=\{fetchRequestCount\}/.test(APP_SRC));
  ok('T44 the room-grid poll is untouched at 20s', /setInterval\(\(\) => poll\(\), 20000\)/.test(APP_SRC));
  ok('T45 no WhatsApp anything was introduced',
    !/whatsapp/i.test(APP_SRC) && !/whatsapp/i.test(MODAL_SRC));
  const iv = (APP_SRC.match(/setInterval/g) || []).length;
  const cv = (APP_SRC.match(/clearInterval/g) || []).length;
  ok('T46 every interval in App.jsx has a matching clear', cv >= iv, `${iv} setInterval, ${cv} clearInterval`);
}
{
  // The STALE badge must actually render. Dead state would be a lie that also
  // costs a re-render on every failure.
  const modalOut = path.join(outDir, 'modal.cjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'components', 'GuestRequestsModal.jsx')],
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile: modalOut,
    external: ['react', 'react-dom'], loader: { '.css': 'empty' },
    plugins: [stubFirebase], logLevel: 'silent'
  });
  const React = require_('react');
  const { renderToString } = require_('react-dom/server');
  const Modal = require_(modalOut).default;
  const html = renderToString(React.createElement(Modal, { isOpen: true, onClose() {}, token: 't' }));
  ok('T47 the modal renders, and a fresh open reads as LIVE',
    html.includes('LIVE') && !html.includes('STALE'));
  ok('T47   the degraded state is genuinely rendered, not dead code',
    /\{degraded \?/.test(MODAL_SRC) && MODAL_SRC.includes('STALE'));
  ok('T47   and the header stops promising a 15s refresh while degraded',
    /degraded \? 'Server unreachable/.test(MODAL_SRC));
  ok('T48 a closed modal renders nothing at all',
    renderToString(React.createElement(Modal, { isOpen: false, onClose() {}, token: 't' })) === '');
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 6. MUTATION CONTROL — THESE TESTS ARE LOAD-BEARING ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
// Each guard is disabled in a COPY of the real body (nothing on disk changes)
// and the matching assertion is re-run. Every one must now fail. If a guard
// could be deleted without a red test, the test above was decorative.
/** @returns {string} the body with `find` removed, asserting it was present. */
const without = (body, find, label) => {
  if (!body.includes(find)) throw new Error(`mutation control: ${label} — guard text not found: ${find}`);
  return body.replace(find, '');
};
{
  // Fix A is defended twice over: the `disposed` latch refuses to schedule
  // during teardown, AND disconnecting before stopFallback() means anything
  // scheduled synchronously is still cleared. Each covers the other, so the
  // honest control removes them one at a time and then together.
  const LATCH = 'if (disposed) return;';
  const ORDER = `socket.disconnect();             // may fire 'disconnect' synchronously
      stopFallback();                  // clears whatever exists, in either order`;
  const REVERSED = `stopFallback();
      socket.disconnect();`;

  /** @returns {number} orphan timers left after connecting and tearing down. */
  const orphansWith = (body) => {
    const mutated = new Function(
      'hasAdminSession', 'io', 'SOCKET_URL', 'fetchRequestCountRef', 'REQUEST_COUNT_POLL_MS',
      'setInterval', 'clearInterval', 'console', 'document', 'CustomEvent', body
    );
    const t = makeTimers();
    let socket = null;
    const cleanup = mutated(true, () => { socket = makeSocket(); return socket; }, '', { current() {} },
      15000, t.setInterval, t.clearInterval, QUIET, { dispatchEvent() {} }, class {});
    socket.__connect();
    cleanup();
    return t.count();
  };
  const swapOrder = (body, label) => {
    if (!body.includes(ORDER)) throw new Error(`mutation control: ${label} — cleanup order text not found`);
    return body.replace(ORDER, REVERSED);
  };

  const noLatch = orphansWith(without(socketEffect.body, LATCH, 'Fix A teardown latch'));
  ok('M1  the latch alone is not load-bearing — the cleanup order also covers it',
    noLatch === 0, `${noLatch} orphan(s) with the latch removed`);

  const noOrder = orphansWith(swapOrder(socketEffect.body, 'Fix A cleanup order'));
  ok('M2  the order alone is not load-bearing either — the latch also covers it',
    noOrder === 0, `${noOrder} orphan(s) with the order reverted`);

  const neither = orphansWith(swapOrder(without(socketEffect.body, LATCH, 'latch'), 'order'));
  ok('M3  removing BOTH restores the orphan-timer bug',
    neither === 1, `${neither} orphan(s) — T1/T3/T6 would go red`);
}
{
  const mutated = new AsyncFunction(
    'adminToken', 'requestCountInFlightRef', 'isRequestCountVisible', 'adminTabRef',
    'requestCountBackoffRef', 'authenticatedFetch', 'API_URL', 'setRequestCount',
    'scheduleRequestCountBackoff', 'AuthenticationError', 'console', '__opts',
    `const { fromPoll = false } = __opts || {}; ${
      without(fetchCount.body, 'if (requestCountInFlightRef.current) return;', 'badge in-flight guard')}`
  );
  const fetches = [];
  await mutated('tok', { current: true }, () => true, { current: 'rooms' },
    { current: { failures: 0, nextAllowedAt: 0 } },
    async () => { fetches.push(1); return { ok: true, status: 200, json: async () => ({ total: 1 }) }; },
    '', () => {}, () => {}, api.AuthenticationError, QUIET, undefined);
  ok('M4  removing the badge in-flight guard DOES let a concurrent call through',
    fetches.length === 1, `${fetches.length} request(s) — T19 would go red`);
}
{
  const mutated = new AsyncFunction(
    'token', 'inFlightRef', 'backoffRef', 'setLoading', 'authenticatedFetch', 'API_URL',
    'setRequests', 'setLastUpdated', 'setDegraded', 'MODAL_BACKOFF_MS',
    'AuthenticationError', 'console', 'silent', '__opts',
    `const { fromPoll = false } = __opts || {}; ${without(modalFetch.body,
      'if (fromPoll && Date.now() < backoffRef.current.nextAllowedAt) return;', 'modal backoff window')}`
  );
  const fetches = [];
  const inFlightRef = { current: false };
  const backoffRef = { current: { failures: 0, nextAllowedAt: 0 } };
  for (let i = 0; i < 20; i++) {
    await mutated('tok', inFlightRef, backoffRef, () => {},
      async () => { fetches.push(1); return { ok: false, status: 503, json: async () => ({}) }; },
      '', () => {}, () => {}, () => {}, [30000, 60000], api.AuthenticationError, QUIET, true, { fromPoll: true });
  }
  ok('M5  removing the modal backoff DOES restore the 20-requests-per-outage loop',
    fetches.length === 20, `${fetches.length} request(s) — T29 would go red`);
}
{
  // And the reverse: with every guard in place, the same 20 ticks stay at 1.
  const { state, fetchRequests } = makeModal({ statuses: [503] });
  for (let i = 0; i < 20; i++) await fetchRequests(true, { fromPoll: true });
  ok('M6  with the real code the identical scenario stays at 1 request',
    state.fetches.length === 1, `${state.fetches.length} request(s)`);
}

console.log(`\n═══ GUEST REQUEST LOOP CHECK: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed checks:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail === 0 ? 0 : 1);
