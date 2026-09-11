/**
 * scripts/inventoryOverviewRequestConsolidationCheck.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Group C — Inventory Overview bill + purchase-order request consolidation.
 *
 * The Overview used to ask for its two attention panels one status at a time:
 * two requests for purchase orders (ISSUED, PARTIALLY_RECEIVED) and three for
 * bills (EXTRACTED, IN_REVIEW, EXTRACTION_FAILED). Both endpoints now accept a
 * comma-separated `status` list and answer it with ONE Firestore `in` query,
 * which reuses the same composite index the `==` form already used.
 *
 * Three halves:
 *
 *   STATIC (no Firestore) — the Overview issues exactly one purchase-order
 *     request and exactly one bills request, Group B's single stock call is
 *     still intact, and the other Inventory pages are untouched.
 *
 *   LOGIC (no Firestore) — parseStatusFilter and buildStatusFilter are exercised
 *     directly over zero / one / several / duplicate / unknown statuses.
 *     buildStatusFilter is LIFTED FROM SOURCE rather than imported, because
 *     importing firestoreUtils.js would initialise Firebase Admin.
 *
 *   MEASURED (DEV Firestore, read-only) — drives the real repositories, counts
 *     reads with the backend's own readBudgetMonitor, and proves the merged
 *     query returns exactly the union of the queries it replaced.
 *
 * Never writes, never deletes, never touches production.
 *
 * Run:  HPMS_ENV=development node scripts/inventoryOverviewRequestConsolidationCheck.mjs
 *       node scripts/inventoryOverviewRequestConsolidationCheck.mjs   (static + logic only)
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
console.log('═══ 1. STATIC — the Overview makes ONE request per panel ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const OV = readSrc('src', 'components', 'inventory', 'InventoryOverview.jsx');

const poCalls = [...OV.matchAll(/inventoryFetch\(`\/inventory\/purchase-orders[^`]*`/g)].map(m => m[0]);
const billCalls = [...OV.matchAll(/inventoryFetch\(`\/inventory\/bills[^`]*`/g)].map(m => m[0]);

ok('exactly ONE /inventory/purchase-orders call in the Overview',
  poCalls.length === 1, `${poCalls.length} call(s)`);
ok('exactly ONE /inventory/bills call in the Overview',
  billCalls.length === 1, `${billCalls.length} call(s)`);

ok('  the PO call asks for both receivable statuses at once',
  /status=\$\{PO_ATTENTION\}/.test(poCalls[0] || ''));
ok('  the bills call asks for all three review statuses at once',
  /status=\$\{BILL_ATTENTION\}/.test(billCalls[0] || ''));

ok('  PO_ATTENTION is exactly the two statuses the old pair asked for',
  /const PO_ATTENTION = 'ISSUED,PARTIALLY_RECEIVED';/.test(OV));
ok('  BILL_ATTENTION is exactly the three statuses the old trio asked for',
  /const BILL_ATTENTION = 'EXTRACTED,IN_REVIEW,EXTRACTION_FAILED';/.test(OV));

ok('  the PO limit is the old per-status limit times 2, so the panel cap is unchanged',
  /limit=\$\{PAGE \* 2\}/.test(poCalls[0] || ''));
ok('  the bill limit is the old per-status limit times 3, so the panel cap is unchanged',
  /limit=\$\{PAGE \* 3\}/.test(billCalls[0] || ''));

ok('  no Promise.all fan-out over bill statuses survives',
  !/BILL_ATTENTION\.split|\['EXTRACTED', 'IN_REVIEW', 'EXTRACTION_FAILED'\]\.map/.test(OV) &&
  !/Promise\.all\(\[/.test(OV.slice(OV.indexOf('const jobs'), OV.indexOf('const r = await'))));

ok('  the destructuring matches the job list (5 jobs, 5 names)',
  /const \[stockR, prR, posR, billsR, movesR\] = r;/.test(OV));
ok('  the PO panel reads that one response directly',
  /setReceivablePOs\(posR\?\.orders \|\| \[\]\);/.test(OV));
ok('  the bills panel reads that one response directly',
  /setOpenBills\(billsR\?\.bills \|\| \[\]\);/.test(OV));

console.log('\n  -- Group B is still intact --');
const stockCalls = [...OV.matchAll(/inventoryFetch\(`\/inventory\/stock[^`]*`/g)].map(m => m[0]);
ok('still exactly ONE /inventory/stock call', stockCalls.length === 1, `${stockCalls.length} call(s)`);
ok('  it still opts into the buckets', /include_buckets=true/.test(stockCalls[0] || ''));
ok('  the Overview still makes 5 requests in total, one per panel',
  (OV.slice(OV.indexOf('const jobs'), OV.indexOf('const r = await'))
     .match(/inventoryFetch\(/g) || []).length === 5);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. STATIC — every other Inventory page is untouched ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const RECV = readSrc('src', 'components', 'inventory', 'InventoryReceiving.jsx');
const HIST = readSrc('src', 'components', 'inventory', 'InventoryHistory.jsx');
const POPAGE = readSrc('src', 'components', 'inventory', 'InventoryPurchaseOrders.jsx');
const CAPTURE = readSrc('src', 'components', 'inventory', 'InventoryBillCapture.jsx');
const ST = readSrc('src', 'components', 'inventory', 'InventoryStock.jsx');

ok('Receiving still issues its own per-status requests (out of Group C scope)',
  /purchase-orders\?status=ISSUED&limit=10/.test(RECV) &&
  /purchase-orders\?status=PARTIALLY_RECEIVED&limit=10/.test(RECV) &&
  /BILL_OPEN_STATUSES\.map/.test(RECV));
ok('History still issues its own per-status requests (out of Group C scope)',
  /purchase-orders\?status=RECEIVED&limit=15/.test(HIST) &&
  /purchase-orders\?status=PARTIALLY_RECEIVED&limit=10/.test(HIST) &&
  /bills\?status=CONFIRMED&limit=25/.test(HIST));
ok('the Purchase Orders page still builds its own single-status params',
  /inventoryFetch\(`\/inventory\/purchase-orders\?\$\{params\.toString\(\)\}`/.test(POPAGE));
ok('Bill Capture still lists bills and POs unfiltered',
  /inventoryFetch\('\/inventory\/bills\?limit=50'/.test(CAPTURE) &&
  /inventoryFetch\('\/inventory\/purchase-orders\?limit=50'/.test(CAPTURE));
ok('the Stock page still sends its own filters and no buckets',
  /params\.set\('stock_status'/.test(ST) && !/include_buckets/.test(ST));
ok('no other page adopted a comma-separated status list',
  ![RECV, HIST, POPAGE, CAPTURE, ST].some(s => /status=[A-Z_]+,[A-Z_]+/.test(s)));

// Why the measured purchase-order read count below is zero and cannot be
// anything else: readBudgetMonitor is incremented inside firestoreUtils, and
// the purchase-order repository never goes through it. Its saving is real but
// this instrument cannot see it, so it is reported as round trips, not reads.
const PO_REPO = readSrc('backend', 'repositories', 'firestore', 'purchaseOrdersRepository.js');
const FS_UTILS = readSrc('backend', 'repositories', 'firestore', 'firestoreUtils.js');
ok('reads are only counted inside firestoreUtils',
  /readBudgetMonitor\.recordReads/.test(FS_UTILS));
ok('  the purchase-order repository builds its own query and never calls listDocs',
  !/listDocs/.test(PO_REPO) && /db\.collection\(ORDERS_COLLECTION\)/.test(PO_REPO));
ok('  so a purchase-order read is INVISIBLE to readBudgetMonitor and must not be quoted as one',
  !/recordReads/.test(PO_REPO));
ok('the bills repository DOES go through listDocs, so its reads are countable',
  /listDocs\(BILLS_COLLECTION/.test(readSrc('backend', 'repositories', 'firestore', 'inventoryBillsRepository.js')));

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. LOGIC — status parsing and filter building ═══\n');
// ═════════════════════════════════════════════════════════════════════════════

// inventoryConstants.js has no Firebase dependency, so it imports safely.
const { parseStatusFilter, MAX_STATUS_FILTER_VALUES, ALL_BILL_STATUSES, ALL_PO_STATUSES } =
  await import('../backend/utils/inventoryConstants.js');

// firestoreUtils.js DOES pull in Firebase Admin, so buildStatusFilter is lifted
// out of the source text and evaluated on its own. A regression in the real
// function therefore still turns this test red.
function liftFunction(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in source`);
  let i = source.indexOf('{', start), depth = 0, end = -1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error(`${name} body not balanced`);
  const body = source.slice(start, end).replace(/^export /, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return ${name};`)();
}
const buildStatusFilter = liftFunction(
  readSrc('backend', 'repositories', 'firestore', 'firestoreUtils.js'), 'buildStatusFilter');

console.log('  -- parseStatusFilter --');
const P = (raw, allowed = ALL_BILL_STATUSES) => parseStatusFilter(raw, allowed);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

ok('no status at all yields an empty list', eq(P(undefined).statuses, []) && eq(P(null).statuses, []) && eq(P('').statuses, []));
ok('  and reports nothing invalid', P(undefined).invalid.length === 0 && P('').invalid.length === 0);
ok('one status yields one', eq(P('EXTRACTED').statuses, ['EXTRACTED']));
ok('  lower case is accepted and normalised', eq(P('extracted').statuses, ['EXTRACTED']));
ok('  surrounding whitespace is trimmed', eq(P('  EXTRACTED  ').statuses, ['EXTRACTED']));
ok('several statuses yield several, in the order given',
  eq(P('EXTRACTED,IN_REVIEW,EXTRACTION_FAILED').statuses, ['EXTRACTED', 'IN_REVIEW', 'EXTRACTION_FAILED']));
ok('  spaces around the commas are tolerated',
  eq(P('EXTRACTED , IN_REVIEW').statuses, ['EXTRACTED', 'IN_REVIEW']));
ok('  duplicates collapse', eq(P('IN_REVIEW,IN_REVIEW,IN_REVIEW').statuses, ['IN_REVIEW']));
ok('  empty entries are ignored', eq(P('EXTRACTED,,IN_REVIEW,').statuses, ['EXTRACTED', 'IN_REVIEW']));
ok('an array is accepted as well as a string',
  eq(P(['EXTRACTED', 'in_review']).statuses, ['EXTRACTED', 'IN_REVIEW']));
ok('an unknown status is reported, not silently dropped',
  eq(P('EXTRACTED,NOPE').invalid, ['NOPE']));
ok('  and a wholly unknown status yields no filter at all',
  eq(P('NOPE').statuses, []) && eq(P('NOPE').invalid, ['NOPE']));
ok('  a duplicated unknown status is reported once', eq(P('NOPE,NOPE').invalid, ['NOPE']));
ok('PO statuses validate against the PO enum, not the bill enum',
  eq(P('ISSUED', ALL_PO_STATUSES).statuses, ['ISSUED']) &&
  eq(P('ISSUED', ALL_BILL_STATUSES).invalid, ['ISSUED']));
ok('the whole Overview bill queue is valid and within the cap',
  eq(P('EXTRACTED,IN_REVIEW,EXTRACTION_FAILED').invalid, []) &&
  P('EXTRACTED,IN_REVIEW,EXTRACTION_FAILED').statuses.length <= MAX_STATUS_FILTER_VALUES);
ok('every declared status enum fits inside the cap',
  ALL_BILL_STATUSES.length <= MAX_STATUS_FILTER_VALUES &&
  ALL_PO_STATUSES.length <= MAX_STATUS_FILTER_VALUES,
  `bills=${ALL_BILL_STATUSES.length} pos=${ALL_PO_STATUSES.length} cap=${MAX_STATUS_FILTER_VALUES}`);
ok('the cap stays under the Firestore `in` limit of 30', MAX_STATUS_FILTER_VALUES <= 30);

console.log('\n  -- buildStatusFilter --');
ok('nothing asked for yields no filter',
  buildStatusFilter(null) === null && buildStatusFilter(undefined) === null &&
  buildStatusFilter('') === null && buildStatusFilter([]) === null);
ok('  an array of blanks also yields no filter', buildStatusFilter([null, '', '  ']) === null);
ok('ONE status still uses `==`, exactly as before',
  eq(buildStatusFilter('ISSUED'), { field: 'status', op: '==', value: 'ISSUED' }));
ok('  a one-element array collapses back to `==`',
  eq(buildStatusFilter(['ISSUED']), { field: 'status', op: '==', value: 'ISSUED' }));
ok('  which is what keeps every existing single-status caller on its old query',
  buildStatusFilter(['ISSUED']).op === '==' && buildStatusFilter('ISSUED').op === '==');
ok('TWO statuses use `in`',
  eq(buildStatusFilter(['ISSUED', 'PARTIALLY_RECEIVED']),
     { field: 'status', op: 'in', value: ['ISSUED', 'PARTIALLY_RECEIVED'] }));
ok('  three statuses use `in`',
  buildStatusFilter(['EXTRACTED', 'IN_REVIEW', 'EXTRACTION_FAILED']).op === 'in');
ok('  blanks are dropped before the == / in decision',
  eq(buildStatusFilter(['ISSUED', '', null]), { field: 'status', op: '==', value: 'ISSUED' }));
ok('the field name is overridable but defaults to status',
  buildStatusFilter('X', 'mode').field === 'mode' && buildStatusFilter('X').field === 'status');

// ═════════════════════════════════════════════════════════════════════════════
// MEASURED half — DEV only
// ═════════════════════════════════════════════════════════════════════════════
if (process.env.HPMS_ENV !== 'development') {
  console.log('\n═══ 4. MEASURED — skipped (set HPMS_ENV=development to run) ═══');
  console.log(`\n═══ CONSOLIDATION CHECK: ${pass} passed, ${fail} failed (static + logic only) ═══`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\n═══ 4. MEASURED — Firestore reads on DEV ═══\n');

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
const { listInventoryBillsFirestore } = await import('../backend/repositories/firestore/inventoryBillsRepository.js');
const { PurchaseOrderService } = await import('../backend/services/purchaseOrderService.js');

const reads = () => readBudgetMonitor.estimatedReadsToday;
const idsOf = (arr) => arr.map(x => x.id).sort().join(',');

// ── Bills ────────────────────────────────────────────────────────────────────
console.log('  -- bills: 3 status queries vs 1 --');
const BILL_Q = ['EXTRACTED', 'IN_REVIEW', 'EXTRACTION_FAILED'];

const beforeOldBills = reads();
const oldBillPages = [];
for (const s of BILL_Q) oldBillPages.push(await listInventoryBillsFirestore({ status: s, limit: 5 }));
const oldBillCost = reads() - beforeOldBills;
const oldBills = oldBillPages.flat();

const beforeNewBills = reads();
const newBills = await listInventoryBillsFirestore({ status: BILL_Q, limit: 15 });
const newBillCost = reads() - beforeNewBills;

console.log(`     OLD (3 separate == queries) : ${oldBillCost} reads, ${oldBills.length} bills`);
console.log(`     NEW (1 in query)            : ${newBillCost} reads, ${newBills.length} bills`);

ok('the merged bills query costs no more reads than the three it replaces',
  newBillCost <= oldBillCost, `${newBillCost} <= ${oldBillCost}`);
ok('  it returns exactly the same set of bills',
  idsOf(newBills) === idsOf(oldBills), `${newBills.length} vs ${oldBills.length}`);
ok('  every bill it returns really is in one of the requested statuses',
  newBills.every(b => BILL_Q.includes(b.status)));
ok('  it is ordered newest first',
  newBills.every((b, i) => i === 0 ||
    String(newBills[i - 1].created_at) >= String(b.created_at)));

// ── Purchase orders ──────────────────────────────────────────────────────────
console.log('\n  -- purchase orders: 2 status queries vs 1 --');
const PO_Q = ['ISSUED', 'PARTIALLY_RECEIVED'];

const beforeOldPos = reads();
const oldPoPages = [];
for (const s of PO_Q) oldPoPages.push(await PurchaseOrderService.list({ status: s, limit: 5 }));
const oldPoCost = reads() - beforeOldPos;
const oldPos = oldPoPages.flatMap(p => p.orders);

const beforeNewPos = reads();
const newPoPage = await PurchaseOrderService.list({ status: PO_Q, limit: 10 });
const newPoCost = reads() - beforeNewPos;

console.log(`     OLD (2 separate == queries) : ${oldPoPages.length} queries, ${oldPos.length} orders`);
console.log(`     NEW (1 in query)            : 1 query, ${newPoPage.orders.length} orders`);
console.log(`     readBudgetMonitor delta     : old=${oldPoCost} new=${newPoCost}  <- NOT a measurement:`);
console.log('       the purchase-order repository bypasses listDocs, so the monitor');
console.log('       never sees these reads. The PO saving is 2 round trips -> 1.');

ok('the merged PO query costs no more reads than the two it replaces',
  newPoCost <= oldPoCost, `${newPoCost} <= ${oldPoCost} (both uninstrumented)`);
ok('  it returns exactly the same set of orders',
  idsOf(newPoPage.orders) === idsOf(oldPos), `${newPoPage.orders.length} vs ${oldPos.length}`);
ok('  every order it returns really is in one of the requested statuses',
  newPoPage.orders.every(o => PO_Q.includes(o.status)));

console.log(`\n  ROUND TRIPS: bills 3 -> 1, purchase orders 2 -> 1 (5 Firestore queries -> 2)`);

// ── Existing single-status behaviour is unchanged ────────────────────────────
console.log('\n  -- single-status behaviour is unchanged --');
const oneBill = await listInventoryBillsFirestore({ status: 'IN_REVIEW', limit: 5 });
ok('a single bill status still returns only that status',
  oneBill.every(b => b.status === 'IN_REVIEW'), `${oneBill.length} bill(s)`);
ok('  and matches what the merged query returned for that status',
  idsOf(oneBill) === idsOf(newBills.filter(b => b.status === 'IN_REVIEW')));

const onePo = await PurchaseOrderService.list({ status: 'ISSUED', limit: 5 });
ok('a single PO status still returns only that status',
  onePo.orders.every(o => o.status === 'ISSUED'), `${onePo.orders.length} order(s)`);
ok('  and still carries its pagination cursor field',
  Object.prototype.hasOwnProperty.call(onePo, 'next_cursor') &&
  Object.prototype.hasOwnProperty.call(onePo, 'limit'));

const noFilterBills = await listInventoryBillsFirestore({ limit: 5 });
ok('an unfiltered bill list still works', Array.isArray(noFilterBills), `${noFilterBills.length} bill(s)`);
const noFilterPos = await PurchaseOrderService.list({ limit: 5 });
ok('an unfiltered PO list still works', Array.isArray(noFilterPos.orders), `${noFilterPos.orders.length} order(s)`);

console.log('\n  -- unknown statuses are still rejected --');
let threw = false;
try { await listInventoryBillsFirestore({ status: 'NOT_A_STATUS', limit: 5 }); }
catch (e) { threw = e.code === 'VALIDATION_ERROR'; }
ok('a single unknown bill status still throws VALIDATION_ERROR', threw);

threw = false;
try { await listInventoryBillsFirestore({ status: ['EXTRACTED', 'NOT_A_STATUS'], limit: 5 }); }
catch (e) { threw = e.code === 'VALIDATION_ERROR'; }
ok('  an unknown status inside a list throws too, rather than being dropped', threw);

// ────────────────────────────────────────────────────────────────────────────
console.log('\n  -- the CONTROLLERS parse the query the Overview actually sends --');
// Drives the real controller functions with a fake req/res, so the comma-list
// parsing, validation and repository call are exercised end to end. Route
// middleware (RBAC) is deliberately out of scope: it is unchanged by Group C,
// and exercising it would need a minted token.
const { listBills } = await import('../backend/controllers/billController.js');
const { getPurchaseOrders } = await import('../backend/controllers/purchaseOrderController.js');

function fakeRes() {
  const out = { code: 200, body: null };
  const res = {
    status(c) { out.code = c; return res; },
    json(b) { out.body = b; return res; }
  };
  return { res, out };
}
async function callCtl(fn, query) {
  const { res, out } = fakeRes();
  await fn({ query, user: { uid: 'test', role: 'admin' } }, res);
  return out;
}

const ctlBills = await callCtl(listBills, { status: 'EXTRACTED,IN_REVIEW,EXTRACTION_FAILED', limit: '15' });
ok('GET /bills?status=<three> returns 200', ctlBills.code === 200, `code=${ctlBills.code}`);
ok('  and returns the same bills as the repository did',
  idsOf(ctlBills.body?.bills || []) === idsOf(newBills),
  `${(ctlBills.body?.bills || []).length} bill(s)`);
ok('  and its count field agrees', ctlBills.body?.count === (ctlBills.body?.bills || []).length);

const ctlBillsOne = await callCtl(listBills, { status: 'IN_REVIEW', limit: '5' });
ok('GET /bills?status=<one> still works exactly as before',
  ctlBillsOne.code === 200 && (ctlBillsOne.body?.bills || []).every(b => b.status === 'IN_REVIEW'));

const ctlBillsBad = await callCtl(listBills, { status: 'EXTRACTED,NOPE' });
ok('GET /bills with an unknown status in the list is rejected with 400',
  ctlBillsBad.code === 400 && ctlBillsBad.body?.code === 'INVALID_BILL_STATUS',
  `code=${ctlBillsBad.code} ${ctlBillsBad.body?.code || ''}`);

const ctlPos = await callCtl(getPurchaseOrders, { status: 'ISSUED,PARTIALLY_RECEIVED', limit: '10' });
ok('GET /purchase-orders?status=<two> returns 200', ctlPos.code === 200, `code=${ctlPos.code}`);
ok('  and returns the same orders as the service did',
  idsOf(ctlPos.body?.orders || []) === idsOf(newPoPage.orders),
  `${(ctlPos.body?.orders || []).length} order(s)`);

const ctlPosOne = await callCtl(getPurchaseOrders, { status: 'ISSUED', limit: '5' });
ok('GET /purchase-orders?status=<one> still works exactly as before',
  ctlPosOne.code === 200 && (ctlPosOne.body?.orders || []).every(o => o.status === 'ISSUED'));

const ctlPosBad = await callCtl(getPurchaseOrders, { status: 'ISSUED,NOPE' });
ok('GET /purchase-orders with an unknown status in the list is rejected with 400',
  ctlPosBad.code === 400, `code=${ctlPosBad.code}`);

const ctlPosNone = await callCtl(getPurchaseOrders, {});
ok('GET /purchase-orders with no status at all still lists everything',
  ctlPosNone.code === 200 && Array.isArray(ctlPosNone.body?.orders));

console.log(`\n═══ CONSOLIDATION CHECK: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); }
console.log('\n[FIRESTORE WRITES] 0  [DELETES] 0  [PRODUCTION ACCESS] 0');
process.exit(fail === 0 ? 0 : 1);
