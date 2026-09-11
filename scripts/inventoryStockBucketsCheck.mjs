/**
 * scripts/inventoryStockBucketsCheck.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Group B — Inventory Overview single stock call.
 *
 * Two halves:
 *
 *   MEASURED (DEV Firestore, read-only) — drives the real
 *     InventoryCutoverService.getStock and counts Firestore reads with the
 *     backend's own readBudgetMonitor, which listDocs increments. Proves the
 *     old two-call pattern scans products twice and the new one-call pattern
 *     scans once. Requires HPMS_ENV=development; aborts otherwise.
 *
 *   STATIC (no Firestore) — asserts the Overview issues exactly one stock
 *     request and that the Stock page's own call is unchanged.
 *
 * Never writes, never deletes, never touches production.
 *
 * Run:  HPMS_ENV=development node scripts/inventoryStockBucketsCheck.mjs
 *       node scripts/inventoryStockBucketsCheck.mjs        (static half only)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${detail ? '  ' + detail : ''}`); }
};

const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g');
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(CRLF, '\n');

// ═════════════════════════════════════════════════════════════════════════════
console.log('═══ 1. STATIC — the Overview makes ONE stock request ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const OV = readSrc('src', 'components', 'inventory', 'InventoryOverview.jsx');
const stockCalls = [...OV.matchAll(/inventoryFetch\(`\/inventory\/stock[^`]*`/g)].map(m => m[0]);

ok('exactly ONE /inventory/stock call in the Overview',
  stockCalls.length === 1, `${stockCalls.length} call(s)`);
ok('  it opts into the buckets', /include_buckets=true/.test(stockCalls[0] || ''));
ok('  it no longer filters by stock_status',
  !stockCalls.some(c => /stock_status=/.test(c)));
ok('  it consumes metrics, lowStock and outOfStock from that one response',
  /setMetrics\(stockR\.metrics/.test(OV) &&
  /setLow\(stockR\.lowStock \|\| \[\]\)/.test(OV) &&
  /setOut\(stockR\.outOfStock \|\| \[\]\)/.test(OV));
ok('  the destructuring matches the job list (6 jobs, 6 names)',
  /const \[stockR, prR, issuedR, partialR, billsR, movesR\] = r;/.test(OV));

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. STATIC — the Stock page is untouched ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const ST = readSrc('src', 'components', 'inventory', 'InventoryStock.jsx');
ok('Stock page still calls /inventory/stock with its own params',
  /inventoryFetch\(`\/inventory\/stock\?\$\{params\.toString\(\)\}`/.test(ST));
ok('  it still sends category_id / location_id / stock_status',
  /params\.set\('category_id'/.test(ST) &&
  /params\.set\('location_id'/.test(ST) &&
  /params\.set\('stock_status'/.test(ST));
ok('  it does NOT opt into buckets', !/include_buckets/.test(ST));
ok('  it still reads data.items and pagination',
  /setItems\(data\.items \|\| \[\]\)/.test(ST) && /total_pages/.test(ST));

const SVC = readSrc('backend', 'services', 'inventoryCutoverService.js');
ok('buckets are strictly opt-in on the server',
  /if \(String\(query\.include_buckets\) === 'true'\)/.test(SVC));
ok('  the default response shape is unchanged',
  /const response = \{ items: paged\.items, metrics, location_id: locationId, page: paged\.page, page_size: paged\.page_size, total: paged\.total, total_pages: paged\.total_pages \};/.test(SVC));
ok('  buckets are cut from the pre-filter set, so search/category cannot narrow them',
  /response\.lowStock = all\.filter/.test(SVC) && /response\.outOfStock = all\.filter/.test(SVC));
ok('  only ONE buildProductViews call remains in getStock',
  (SVC.slice(SVC.indexOf('static async getStock'),
             SVC.indexOf('static async getProductById')).match(/buildProductViews/g) || []).length === 1);

// ═════════════════════════════════════════════════════════════════════════════
// MEASURED half — DEV only
// ═════════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ 3. MEASURED — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ STOCK BUCKETS CHECK: ${pass} passed, ${fail} failed (static only) ═══`);
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\n═══ 3. MEASURED — Firestore reads on DEV ═══\n');

const { createRequire } = await import('module');
const require_ = createRequire(path.join(ROOT, 'backend', 'package.json'));
require_('dotenv').config({ path: path.join(ROOT, 'backend', '.env.development') });

const { isProductionProject } = await import('../backend/config/productionSafetyGuard.js');
if (isProductionProject()) { console.error('[SAFETY_ABORT] production project.'); process.exit(1); }
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }
console.log(`  [GUARD] project=${PROJECT} (DEV) — read-only\n`);

const { readBudgetMonitor } = await import('../backend/utils/firestoreReadBudget.js');
const { InventoryCutoverService } = await import('../backend/services/inventoryCutoverService.js');

const reads = () => readBudgetMonitor.estimatedReadsToday;

// Warm the TTL caches for categories/locations so the comparison isolates the
// product scan, which is the only uncached collection in this path.
await InventoryCutoverService.getStock({ page_size: 5 });

const beforeOld = reads();
await InventoryCutoverService.getStock({ page_size: 5, stock_status: 'LOW_STOCK' });
await InventoryCutoverService.getStock({ page_size: 5, stock_status: 'OUT_OF_STOCK' });
const oldCost = reads() - beforeOld;

const beforeNew = reads();
const one = await InventoryCutoverService.getStock({ page_size: 5, include_buckets: 'true' });
const newCost = reads() - beforeNew;

console.log(`  OLD pattern (two calls: LOW_STOCK + OUT_OF_STOCK) : ${oldCost} reads`);
console.log(`  NEW pattern (one call: include_buckets=true)      : ${newCost} reads`);
console.log(`  products in DEV                                   : ${one.metrics.totalProducts}`);
console.log('');

ok('the new pattern costs strictly fewer reads than the old',
  newCost < oldCost, `${newCost} < ${oldCost}`);
ok('  the old pattern scanned products twice, the new one once',
  oldCost === newCost * 2, `old=${oldCost}, new=${newCost}`);

console.log('\n  -- response correctness --');
ok('one response carries metrics', one.metrics && typeof one.metrics.totalProducts === 'number',
  JSON.stringify(one.metrics));
ok('one response carries lowStock', Array.isArray(one.lowStock));
ok('one response carries outOfStock', Array.isArray(one.outOfStock));
ok('  lowStock length matches the metric (within the page cap)',
  one.lowStock.length === Math.min(one.metrics.lowStockProducts, one.page_size),
  `${one.lowStock.length} vs metric ${one.metrics.lowStockProducts}`);
ok('  outOfStock length matches the metric (within the page cap)',
  one.outOfStock.length === Math.min(one.metrics.outOfStockProducts, one.page_size),
  `${one.outOfStock.length} vs metric ${one.metrics.outOfStockProducts}`);
ok('  every lowStock row really is LOW_STOCK',
  one.lowStock.every(p => p.stock_status === 'LOW_STOCK'));
ok('  every outOfStock row really is OUT_OF_STOCK',
  one.outOfStock.every(p => p.stock_status === 'OUT_OF_STOCK'));

console.log('\n  -- the buckets equal what the old two calls returned --');
const oldLow = await InventoryCutoverService.getStock({ page_size: 5, stock_status: 'LOW_STOCK' });
const oldOut = await InventoryCutoverService.getStock({ page_size: 5, stock_status: 'OUT_OF_STOCK' });
const ids = (a) => a.map(p => p.id).sort().join(',');
ok('lowStock identical to the old LOW_STOCK list',
  ids(one.lowStock) === ids(oldLow.items), `${one.lowStock.length} vs ${oldLow.items.length}`);
ok('outOfStock identical to the old OUT_OF_STOCK list',
  ids(one.outOfStock) === ids(oldOut.items), `${one.outOfStock.length} vs ${oldOut.items.length}`);

console.log('\n  -- Stock page semantics preserved --');
const plain = await InventoryCutoverService.getStock({ page_size: 5 });
ok('a request without the flag returns NO buckets',
  plain.lowStock === undefined && plain.outOfStock === undefined);
ok('  and still returns items, metrics and pagination',
  Array.isArray(plain.items) && plain.metrics && typeof plain.total_pages === 'number',
  `items=${plain.items.length} total=${plain.total} pages=${plain.total_pages}`);
const filtered = await InventoryCutoverService.getStock({ page_size: 5, stock_status: 'LOW_STOCK' });
ok('  stock_status filtering still narrows items',
  filtered.items.every(p => p.stock_status === 'LOW_STOCK'));
const withBoth = await InventoryCutoverService.getStock({ page_size: 5, include_buckets: 'true', stock_status: 'OUT_OF_STOCK' });
ok('  a filter narrows items but NOT the attention buckets',
  withBoth.items.every(p => p.stock_status === 'OUT_OF_STOCK') &&
  withBoth.lowStock.length === one.lowStock.length,
  `items=${withBoth.items.length} lowStock=${withBoth.lowStock.length}`);

console.log(`\n═══ STOCK BUCKETS CHECK: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
console.log('\n[FIRESTORE WRITES] 0  [DELETES] 0  [PRODUCTION ACCESS] 0');
process.exit(fail === 0 ? 0 : 1);
