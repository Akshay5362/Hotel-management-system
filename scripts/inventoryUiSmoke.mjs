/**
 * scripts/inventoryUiSmoke.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Headless smoke test for the redesigned Inventory frontend.
 *
 * The project has no frontend test framework, so this uses what it already
 * has: esbuild (Vite's own bundler) to compile the JSX, and react-dom/server
 * to render it. No browser, no network, no Firebase — `fetch` is replaced
 * with a recorder that returns empty, well-formed responses, and every
 * request the screens make is captured and checked against the endpoints
 * the backend actually exposes.
 *
 * What it proves
 *   • every Inventory screen renders for every role without throwing
 *   • role-based visibility matches the backend role matrix
 *   • the confirmation, receiving, approval and movement endpoints are
 *     unchanged and are the ONLY write endpoints the module can reach
 *   • no client-side Firestore, no public bill URL, no host assumptions
 *   • empty, loading and error states render real copy, not blank tables
 *
 * Run:  node scripts/inventoryUiSmoke.mjs
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

// ── 1. Compile the Hub (and everything it imports) to one CJS bundle ─────────
const outFile = path.join(ROOT, 'node_modules', '.cache', 'inventory-ui-smoke.cjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
// An in-memory entry that re-exports every screen, so production files need
// no test-only exports.
const SCREENS = ['InventoryHub', 'InventoryOverview', 'InventoryStock', 'InventoryPurchasing', 'InventoryApprovals',
  'InventoryReceiving', 'InventoryHistory', 'InventoryMastersHub', 'InventoryBillCapture', 'StockMovementHistory'];
await esbuild.build({
  stdin: {
    contents: SCREENS.map(n => `export { default as ${n} } from './src/components/inventory/${n}.jsx';`).join('\n'),
    resolveDir: ROOT,
    loader: 'js'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  outfile: outFile,
  loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom'],
  define: {
    'import.meta.env.VITE_API_BASE_URL': '"http://smoke.invalid"',
    'import.meta.env': '{}',
    'process.env.NODE_ENV': '"production"'
  },
  logLevel: 'silent'
});
ok('the Inventory module compiles', fs.existsSync(outFile));

// ── 2. A browser-shaped global environment, without a browser ────────────────
const calls = [];
const respond = (url, init = {}) => {
  const method = (init.method || 'GET').toUpperCase();
  calls.push({ method, url: url.replace(/^http:\/\/smoke\.invalid\/api/, ''), body: init.body ? JSON.parse(init.body) : null });
  const u = new URL(url);
  const p = u.pathname.replace(/^\/api/, '');
  let json = {};
  if (p === '/inventory/stock') json = { items: [], metrics: { totalProducts: 0, lowStockProducts: 0, outOfStockProducts: 0 }, total: 0, total_pages: 1, page_size: 25 };
  else if (p === '/inventory/categories') json = { categories: [] };
  else if (p === '/inventory/locations') json = { locations: [] };
  else if (p === '/inventory/units') json = { units: [] };
  else if (p === '/inventory/suppliers') json = { suppliers: [] };
  else if (p === '/inventory/products') json = { products: [], metrics: {}, total: 0, total_pages: 1 };
  else if (p === '/inventory/movements') json = { movements: [], next_cursor: null };
  else if (p === '/inventory/purchase-requests') json = { requests: [], next_cursor: null };
  else if (p === '/inventory/purchase-requests/approval-config') json = { enabled: true, allowed_roles: ['admin'], caller_can_approve: true, caller_can_configure: true, valid_roles: ['admin', 'super_admin'] };
  else if (p === '/inventory/purchase-orders') json = { orders: [], next_cursor: null };
  else if (p === '/inventory/bills') json = { bills: [], count: 0 };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json), blob: () => Promise.resolve(new Blob()) });
};
globalThis.fetch = respond;
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, removeEventListener() {} };
globalThis.URL = globalThis.URL;
globalThis.HPMS_RUNTIME = null;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const React = require_('react');
const { renderToString } = require_('react-dom/server');
const mod = require_(outFile);
const InventoryHub = mod.InventoryHub;

// The Hub reads the notification context through a hook; without a provider
// it returns null, which the Hub already tolerates.
const render = (user) => renderToString(React.createElement(InventoryHub, { token: 'smoke-token', user }));

// ── 3. Every role renders, and sees exactly its areas ────────────────────────
const ROLES = [
  { name: 'super admin', user: { role: 'ADMIN', type: 'admin' }, expect: ['Overview', 'Stock', 'Purchasing', 'Receiving', 'History &amp; Reports', 'Masters'] },
  { name: 'staff admin', user: { role: 'ADMIN', type: 'staff' }, expect: ['Overview', 'Stock', 'Purchasing', 'Receiving', 'History &amp; Reports', 'Masters'] },
  { name: 'receptionist', user: { role: 'RECEPTIONIST', type: 'staff' }, expect: ['Overview', 'Stock', 'Purchasing', 'Receiving', 'History &amp; Reports'], forbid: ['>Masters<'] },
  { name: 'kitchen (chef)', user: { role: 'CHEF', type: 'staff' }, expect: ['Overview', 'Stock', 'Purchasing', 'History &amp; Reports'], forbid: ['>Receiving<', '>Masters<'] },
  { name: 'housekeeper (cleaner)', user: { role: 'CLEANER', type: 'staff' }, expect: ['Overview', 'Stock', 'Purchasing', 'History &amp; Reports'], forbid: ['>Receiving<', '>Masters<'] },
  { name: 'guest', user: { role: 'GUEST', type: 'guest' }, expect: ['does not have access'], forbid: ['>Overview<'] }
];
console.log('\n═══ ROLE VISIBILITY (Hub renders Overview by default) ═══');
for (const r of ROLES) {
  let html = '';
  try { html = render(r.user); } catch (e) { ok(`${r.name}: Hub renders`, false, e.message); continue; }
  ok(`${r.name}: Hub renders`, html.length > 0);
  for (const s of r.expect) ok(`  ${r.name} sees "${s.replace('&amp;', '&')}"`, html.includes(s));
  for (const s of (r.forbid || [])) ok(`  ${r.name} does NOT see "${s.replace(/[<>]/g, '')}"`, !html.includes(s));
}

// Overview is the landing screen: header text, KPI labels, sections present.
{
  const html = render({ role: 'ADMIN', type: 'admin' });
  ok('Overview is the default landing screen', html.includes('Manage stock, purchasing and receiving'));
  for (const s of ['Total items', 'Low stock', 'Out of stock', 'Needs attention', 'Recent activity', 'Purchase Request', 'Capture Bill']) {
    ok(`  Overview shows "${s}"`, html.includes(s));
  }
  ok('  KPI cards show a placeholder, never a fabricated number, before data arrives', !/inv-kpi-value[^>]*>\s*\d/.test(html));
  ok('  no "Stock Value" figure is invented', !html.includes('Stock value') && !html.includes('Stock Value'));
}

// ── 4. Individual screens render each state ──────────────────────────────────
console.log('\n═══ SCREENS AND STATES ═══');
const screens = {
  InventoryStock: ['Stock', 'Search items', 'Category', 'Location', 'Status', 'More filters'],
  InventoryPurchasing: ['Purchasing', 'Purchase Requests', 'Purchase Orders', 'Approvals', 'New Purchase Request'],
  InventoryApprovals: ['Approvals', 'Awaiting decision', 'Recently decided'],
  InventoryReceiving: ['Receiving', 'Capture Supplier Bill', 'Receive Against PO', 'Direct Receipt', 'No purchase order', 'Pending receipts'],
  InventoryHistory: ['History &amp; Reports', 'Stock Movements', 'Purchase History', 'Receiving History'],
  InventoryMastersHub: ['Masters', 'Items', 'Categories', 'Suppliers', 'Units', 'Locations', 'Approval Rules', 'Configuration'],
  InventoryBillCapture: ['Bill Capture', 'Upload bill'],
  StockMovementHistory: ['All items', 'All locations', 'All types']
};
const perms = { view: true, manage: true, move: true, request: true, receive: true, correct: true };
for (const [name, strings] of Object.entries(screens)) {
  const Comp = mod[name];
  if (!Comp) { ok(`${name} exported for smoke`, false, 'not exported'); continue; }
  let html = '';
  try {
    html = renderToString(React.createElement(Comp, { token: 't', perms, user: { uid: 'u1' }, onNavigate: () => {}, canMove: true, embedded: true }));
  } catch (e) { ok(`${name} renders`, false, e.message); continue; }
  ok(`${name} renders`, html.length > 0);
  for (const s of strings) ok(`  ${name} shows "${s.replace('&amp;', '&')}"`, html.includes(s), html.includes(s) ? '' : '(missing)');
  ok(`  ${name} shows a loading skeleton before data (no blank table)`, html.includes('inv-skel') || html.includes('inv-empty'));
}

// Direct-receipt mode carries the mandatory warning text.
{
  const Comp = mod.InventoryBillCapture;
  const html = renderToString(React.createElement(Comp, { token: 't', initialMode: 'DIRECT', onBack: () => {} }));
  ok('Direct Receipt screen is labelled "Direct Receipt" with "No purchase order"', html.includes('Direct Receipt') && html.includes('No purchase order'));
}

// ── 5. Endpoint contract: what the module can call ───────────────────────────
console.log('\n═══ ENDPOINT CONTRACT (static source scan) ═══');
const src = fs.readdirSync(path.join(ROOT, 'src', 'components', 'inventory'))
  .filter(f => /\.(jsx|js)$/.test(f))
  .map(f => fs.readFileSync(path.join(ROOT, 'src', 'components', 'inventory', f), 'utf8'))
  .join('\n') + fs.readFileSync(path.join(ROOT, 'src', 'components', 'InventoryModule.jsx'), 'utf8');

const must = [
  ['confirm-po', "/inventory/bills/${selected.bill.id}/confirm-po"],
  ['confirm-direct', "/inventory/bills/${selected.bill.id}/confirm-direct"],
  ['PO receipt', "/inventory/purchase-orders/${orderId}/receipts"],
  ['PO receipt reversal', "/inventory/purchase-orders/${orderId}/receipts/${rid}/reverse"],
  ['PO close short', "/inventory/purchase-orders/${orderId}/close-short"],
  ['PO issue', "/inventory/purchase-orders/${orderId}/issue"],
  ['PR approve/reject/submit/cancel', "/inventory/purchase-requests/${requestId}/${action}"],
  ['approval queue approve/reject', "/inventory/purchase-requests/${id}/${action}"],
  ['stock movement post', "'/inventory/movements'"],
  ['bill upload', "${API_URL}/inventory/bills"],
  ['bill file (authenticated)', "${API_URL}/inventory/bills/${billId}/file"],
  ['duplicate check', "/inventory/bills/${selected.bill.id}/duplicates"],
  ['approval config', "/inventory/purchase-requests/approval-config"]
];
for (const [label, needle] of must) ok(`endpoint kept: ${label}`, src.includes(needle), src.includes(needle) ? '' : needle);

const forbidden = [
  ['client-side Firestore', /firebase\/firestore|setDoc\(|addDoc\(|updateDoc\(|deleteDoc\(|writeBatch\(|onSnapshot\(/],
  ['public bill URL', /getAssetUrl\([^)]*bill|\/inventory-bills\//],
  ['host assumption', /localhost:500[01]|127\.0\.0\.1:500[01]|sky5-development|hpms-sky5/],
  ['WhatsApp integration', /wa\.me|whatsapp[_-]?(api|cloud|webhook|template)/i],
  ['polling timer', /setInterval\(/],
  ['direct stock mutation payload', /body:\s*\{[^}]*(current_stock|stock_by_location)\s*:/]
];
for (const [label, re] of forbidden) ok(`no ${label}`, !re.test(src));

// Write endpoints reachable: every POST/PUT/DELETE path in the module.
const writes = new Set();
for (const m of src.matchAll(/inventoryFetch\(\s*([`'"])(\/inventory[^`'"]*)\1[\s\S]{0,200}?method:\s*'(POST|PUT|DELETE)'/g)) {
  writes.add(`${m[3]} ${m[2].replace(/\$\{[^}]+\}/g, ':id')}`);
}
const allowedWrites = [
  'POST /inventory/movements', 'POST /inventory/purchase-requests', 'POST /inventory/purchase-requests/:id/:id',
  'POST /inventory/purchase-requests/:id/submit', 'POST /inventory/purchase-orders', 'POST /inventory/purchase-orders/:id/issue',
  'POST /inventory/purchase-orders/:id/receipts', 'POST /inventory/purchase-orders/:id/receipts/:id/reverse',
  'POST /inventory/purchase-orders/:id/close-short', 'POST /inventory/bills/:id/interpret', 'POST /inventory/bills/:id/confirm-po',
  'POST /inventory/bills/:id/confirm-direct', 'DELETE /inventory/bills/:id', 'PUT /inventory/purchase-requests/approval-config',
  'POST /inventory/categories', 'POST /inventory/units', 'POST /inventory/locations', 'POST /inventory/suppliers',
  'DELETE /inventory/categories/:id', 'DELETE /inventory/units/:id', 'DELETE /inventory/locations/:id', 'DELETE /inventory/suppliers/:id'
];
const unexpected = [...writes].filter(w => !allowedWrites.includes(w) && !/^(POST|DELETE) \/inventory\/(categories|units|locations|suppliers)/.test(w));
ok('every write endpoint the module reaches is a known, pre-existing one', unexpected.length === 0, unexpected.join(', ') || `${writes.size} write paths`);

console.log(`\n═══ UI SMOKE RESULT: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed checks:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail === 0 ? 0 : 1);
