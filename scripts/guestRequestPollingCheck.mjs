/**
 * scripts/guestRequestPollingCheck.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Frontend half of the guest-request polling fix.
 *
 * Two kinds of check, and the report is explicit about which is which:
 *
 *   BEHAVIOURAL — the Toolbar is rendered for real with react-dom/server, so
 *     "an unknown count must not display as 0" is proved, not asserted about.
 *
 *   STRUCTURAL — the polling logic lives inside App.jsx, a component with a
 *     socket, Firebase and dozens of children; rendering it headlessly would
 *     test the harness more than the code. Those properties are checked
 *     against the source with assertions specific enough to fail if the
 *     behaviour were removed.
 *
 * No network, no Firestore, no quota.
 *
 * Run:  node scripts/guestRequestPollingCheck.mjs
 */
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

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

// ═════════════════════════════════════════════════════════════════════════════
console.log('═══ 1. BEHAVIOURAL — THE BADGE NEVER CLAIMS "0" IT DOES NOT KNOW ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const outFile = path.join(ROOT, 'node_modules', '.cache', 'toolbar-check.cjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'components', 'Toolbar.jsx')],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  outfile: outFile, external: ['react', 'react-dom'],
  loader: { '.css': 'empty' }, logLevel: 'silent'
});

const React = require_('react');
const { renderToString } = require_('react-dom/server');
const Toolbar = (require_(outFile)).default;

const render = (requestCount) => renderToString(React.createElement(Toolbar, {
  onActionClick: () => {}, activeFilter: 'all', setFilter: () => {},
  // Deliberately non-zero: the filter chips render their own counts, so a "0"
  // anywhere in the markup can then only have come from the request badge.
  roomCounts: { all: 17, vacant: 5, occupied: 7, dirty: 3, booked: 1, inactive: 1 },
  searchQuery: '', setSearchQuery: () => {}, requestCount, activeModal: null
}));

/** The badge is the only place the count is rendered; find its text. */
const badgeText = (html) => {
  const m = html.match(/animation:pulse[^>]*>([^<]*)</) || html.match(/z-index:10[^>]*>([^<]*)</);
  return m ? m[1].trim() : null;
};

{
  const unknown = render(null);
  ok('an unknown count (null) renders NO badge at all', badgeText(unknown) === null);
  ok('  and no "0" appears anywhere in the rendered toolbar',
    !/>\s*0\s*</.test(unknown), 'the only numbers rendered are the real room counts');

  const zero = render(0);
  ok('a genuine zero also renders no badge, exactly as before', badgeText(zero) === null);

  const three = render(3);
  ok('a real count renders the badge', badgeText(three) === '3', badgeText(three));

  const many = render(150);
  ok('  and is capped at 99+', badgeText(many) === '99+', badgeText(many));

  ok('null and 0 are visually identical, so a degraded read shows no false news',
    badgeText(unknown) === badgeText(zero));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. STRUCTURAL — THE POLLER IN App.jsx ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const app = fs.readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = stripComments(app);

// The count starts unknown.
ok('the count starts as null, not 0', /useState\(null\)[\s\S]{0,40}requestCount|const \[requestCount, setRequestCount\] = useState\(null\)/.test(code));

// setRequestCount is only ever called from the success branch.
const setterCalls = [...code.matchAll(/setRequestCount\(([^)]*)\)/g)].map(m => m[1].trim());
ok('setRequestCount is called exactly once in the whole file', setterCalls.length === 1, setterCalls.join(' | '));
ok('  and never with a bare 0', !setterCalls.includes('0'), setterCalls.join(' | '));
ok('  it is fed from the parsed response total', /setRequestCount\(Number\(data\.total\) \|\| 0\)/.test(code));

// The success branch returns before any failure handling can run.
const fnStart = code.indexOf('const fetchRequestCount');
const fnEnd = code.indexOf('}, [adminToken, scheduleRequestCountBackoff]);', fnStart);
ok('fetchRequestCount is present with its dependency array', fnStart >= 0 && fnEnd > fnStart);
const body = code.slice(fnStart, fnEnd);
ok('  the setter sits inside the res.ok branch', /if \(res\.ok\)[\s\S]*setRequestCount/.test(body));
ok('  and that branch returns before the failure handling', /setRequestCount[\s\S]{0,120}return;/.test(body));

// In-flight guard.
ok('an in-flight ref exists', /const requestCountInFlightRef = useRef\(false\)/.test(code));
ok('  the function returns early while a call is outstanding',
  /if \(requestCountInFlightRef\.current\) return;/.test(body));
ok('  it is set before the request', /requestCountInFlightRef\.current = true;[\s\S]{0,80}try \{/.test(body));
ok('  and cleared in a finally block, so a throw cannot wedge it',
  /finally \{[\s\S]{0,120}requestCountInFlightRef\.current = false;/.test(body));

// Backoff.
ok('a backoff ref exists', /const requestCountBackoffRef = useRef\(\{ failures: 0, nextAllowedAt: 0 \}\)/.test(code));
ok('  the schedule is 30s then 60s', /REQUEST_COUNT_BACKOFF_MS = \[30000, 60000\]/.test(code));
ok('  a poll declines to act inside the backoff window',
  /if \(Date\.now\(\) < requestCountBackoffRef\.current\.nextAllowedAt\) return;/.test(body));
ok('  5xx, 503 and 429 all trigger backoff',
  /res\.status === 503 \|\| res\.status === 429 \|\| res\.status >= 500[\s\S]{0,80}scheduleRequestCountBackoff\(\)/.test(body));
ok('  a network throw also triggers backoff', /catch \(e\)[\s\S]*scheduleRequestCountBackoff\(\)/.test(body));
ok('  a success resets the backoff',
  /setRequestCount[\s\S]{0,90}requestCountBackoffRef\.current = \{ failures: 0, nextAllowedAt: 0 \}/.test(body));

// No runaway timer.
ok('the poller uses a fixed interval, not a recursive timeout',
  /setInterval\(\(\) => fetchRequestCountRef\.current\(\{ fromPoll: true \}\), REQUEST_COUNT_POLL_MS\)/.test(code));
ok('  the base cadence is still 15s', /REQUEST_COUNT_POLL_MS = 15000/.test(code));
ok('  every interval in the file is cleared on cleanup',
  (code.match(/clearInterval/g) || []).length >= (code.match(/setInterval/g) || []).length,
  `${(code.match(/setInterval/g) || []).length} setInterval, ${(code.match(/clearInterval/g) || []).length} clearInterval`);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. TAB SUPPRESSION ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
ok('the hidden-toolbar tabs are named in one place',
  /const TOOLBAR_HIDDEN_TABS = \['food', 'inventory'\]/.test(code));
ok('  a poll skips a tab where the badge is off screen',
  /if \(!isRequestCountVisible\(adminTabRef\.current\)\) return;/.test(body));
ok('  the tab is read from a ref, so switching tabs does not rebuild the socket',
  /const adminTabRef = useRef\(adminTab\)/.test(code) && /adminTabRef\.current = adminTab/.test(code));
ok('  returning to a visible tab refreshes the count once',
  /if \(!isRequestCountVisible\(adminTab\)\) return;[\s\S]{0,60}fetchRequestCountRef\.current\(\);/.test(code));

// The suppression list must match the render guards, or one will drift.
const guards = (app.match(/adminTab !== 'food' && adminTab !== 'inventory'/g) || []).length;
ok('the Toolbar and MetricsBar are still hidden on both tabs', guards === 2, `${guards} guard(s)`);
ok('  the Inventory room-dashboard isolation is intact', /adminTab !== 'food' && adminTab !== 'inventory'/.test(app));

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. SOCKET.IO IS PRESERVED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
ok('the socket is still created', /const socket = io\(SOCKET_URL\)/.test(code));
ok('  connect still cancels the fallback polling', /socket\.on\('connect'[\s\S]{0,200}stopFallback\(\);/.test(code));
ok('  disconnect still starts it', /socket\.on\('disconnect'[\s\S]{0,300}setInterval/.test(code));
ok('  new_guest_request still refreshes immediately', /socket\.on\('new_guest_request'[\s\S]{0,160}fetchRequestCountRef\.current\(\)/.test(code));
ok('  a real event fetches even from a hidden tab, so the badge is right on return',
  /socket\.on\('new_guest_request'[\s\S]{0,200}fetchRequestCountRef\.current\(\);/.test(code) &&
  !/socket\.on\('new_guest_request'[\s\S]{0,200}fromPoll/.test(code));
ok('  the socket is still disconnected on cleanup', /socket\.disconnect\(\)/.test(code));
ok('polling remains the fallback, not a competitor to the socket',
  /fallbackInterval = setInterval/.test(code) &&
  /const stopFallback = \(\) => \{[\s\S]{0,140}clearInterval\(fallbackInterval\)/.test(code));

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 5. NOTHING UNRELATED MOVED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
ok('the other poller keeps its own in-flight guard', /const pollInFlightRef = useRef\(false\)/.test(code));
ok('the status fetch keeps its own in-flight guard', /const statusFetchInFlightRef = useRef\(false\)/.test(code));
ok('the room-grid poll is untouched at 20s', /setInterval\(\(\) => poll\(\), 20000\)/.test(code));
ok('the resolve callback still refreshes the count', /onRequestResolved=\{fetchRequestCount\}/.test(app));

console.log(`\n═══ GUEST REQUEST POLLING CHECK: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed checks:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail === 0 ? 0 : 1);
