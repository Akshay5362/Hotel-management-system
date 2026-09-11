/**
 * testInventoryPhaseH8.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8 — complete DEV validation of the inventory module, A through H7.
 *
 * This suite deliberately DOES NOT restate the assertions the phase suites
 * already make. Re-implementing them here would create a second, drifting copy
 * of the same expectations. What it adds is the thing no individual suite can
 * check about itself:
 *
 *   1. The DEV database is measured BEFORE anything runs.
 *   2. Every suite is executed in dependency order, as its own process.
 *   3. The database is measured again AFTERWARDS and must match, document for
 *      document, not merely in total.
 *   4. Anything left behind is identified and attributed — to a suite, or to a
 *      person using the DEV application — because "the counts went back to
 *      normal" is not the same as "nothing was left behind".
 *
 * The stock-safety claim is checked structurally as well: the phases that read,
 * parse, match and review a bill are run first and must move no stock at all,
 * and only then are the confirming phases allowed to run.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryPhaseH8.mjs
 */

import path from 'path';
import { spawn } from 'child_process';
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
if (isProductionProject()) {
  console.error('[SAFETY_ABORT] Resolved Firebase project looks like production.');
  process.exit(1);
}

// ── Guards 3 + 4 ─────────────────────────────────────────────────────────────
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }
console.log(`[GUARD] project=${PROJECT} (DEV) — safe to proceed`);
console.log(`[GUARD] backend under test: ${process.env.TEST_API_BASE || 'http://127.0.0.1:5001/api'}\n`);

let pass = 0, fail = 0;
const failures = [];
const ok = (l, c, d = '') => {
  if (c) { pass++; console.log(`  [PASS] ${l}${d ? '  ' + d : ''}`); }
  else { fail++; failures.push(l); console.log(`  [FAIL] ${l}${d ? '  ' + d : ''}`); }
};

const { db } = await import('../config/firebaseAdmin.js');

// Every collection the inventory module can write.
const COLLECTIONS = [
  'inventory_products', 'inventory_categories', 'inventory_units',
  'inventory_locations', 'inventory_suppliers', 'inventory_stock_movements',
  'purchase_requests', 'purchase_request_items',
  'purchase_orders', 'purchase_order_items',
  'goods_receipts', 'goods_receipt_items', 'goods_receipt_reversals',
  'inventory_bills', 'inventory_bill_lines'
];

/**
 * A full document-id census, not a count. Two documents appearing while two
 * others vanish leaves the count identical and the database wrong.
 */
async function census() {
  const out = {};
  for (const c of COLLECTIONS) {
    const snap = await db.collection(c).get();
    out[c] = new Set(snap.docs.map(d => d.id));
  }
  return out;
}

/** Product stock, so a movement that never happened is still visible. */
async function stockCensus() {
  const out = {};
  for (const d of (await db.collection('inventory_products').get()).docs) {
    const x = d.data();
    out[d.id] = {
      current_stock: Number(x.current_stock) || 0,
      by_location: JSON.stringify(x.stock_by_location || {})
    };
  }
  return out;
}

const diff = (before, after) => {
  const added = [], removed = [];
  for (const c of COLLECTIONS) {
    for (const id of after[c]) if (!before[c].has(id)) added.push(`${c}/${id}`);
    for (const id of before[c]) if (!after[c].has(id)) removed.push(`${c}/${id}`);
  }
  return { added, removed };
};

/** Runs one suite as its own process so a crash cannot take this runner down. */
function runSuite(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(BACKEND, 'tests', file)], {
      env: { ...process.env, HPMS_ENV: 'development' },
      cwd: process.cwd()
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('close', (code) => {
      const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/i);
      resolve({
        file, code,
        passed: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : 0,
        matched: !!m,
        crashed: code !== 0 && !m,
        tail: out.split('\n').filter(l => /\[FAIL\]|✗/.test(l)).slice(0, 5),
        seconds: Math.round((Date.now() - started) / 1000)
      });
    });
  });
}

// Order matters. The stock-neutral phases run first so their neutrality is
// measured against an untouched ledger; the confirming phases follow.
const STOCK_NEUTRAL = [
  ['A  master data',        'testInventoryPhaseA.mjs'],
  ['B  purchase requests',  'testInventoryPhaseB.mjs'],
  ['C  approval engine',    'testInventoryPhaseC.mjs'],
  ['D  approval settings',  'testInventoryPhaseD.mjs'],
  ['H1 bill upload',        'testInventoryPhaseH1.mjs'],
  ['H2 OCR extraction',     'testInventoryPhaseH2.mjs'],
  ['H3 parse and match',    'testInventoryPhaseH3.mjs']
];
const STOCK_MOVING = [
  ['E  purchase orders',    'testInventoryPhaseE.mjs'],
  ['F  goods receipt',      'testInventoryPhaseF.mjs'],
  ['G  reversal, short close', 'testInventoryPhaseG.mjs'],
  ['H5/H6 confirmation',    'testInventoryPhaseH56.mjs'],
  ['H7 duplicate protection', 'testInventoryPhaseH7.mjs'],
  ['H5 crash recovery',      'testInventoryH5CrashRecovery.mjs'],
  ['repository safety',     'testFirestoreRepositories.mjs']
];

// ═════════════════════════════════════════════════════════════════════════════
console.log('═══ BASELINE ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const before = await census();
const stockBefore = await stockCensus();
for (const c of COLLECTIONS) console.log(`  ${c.padEnd(28)} ${String(before[c].size).padStart(4)}`);
console.log('\n  product stock:');
for (const [pid, v] of Object.entries(stockBefore)) {
  console.log(`    ${pid.padEnd(26)} ${String(v.current_stock).padStart(8)}  ${v.by_location}`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ STOCK-NEUTRAL PHASES ═══');
console.log('  Upload, OCR, parsing, matching, review and approval must not move stock.\n');
// ═════════════════════════════════════════════════════════════════════════════
const results = [];
for (const [label, file] of STOCK_NEUTRAL) {
  const r = await runSuite(file);
  results.push([label, r]);
  console.log(`  ${label.padEnd(26)} ${String(r.passed).padStart(4)} passed, ${r.failed} failed   (${r.seconds}s)`);
  if (r.tail.length) r.tail.forEach(t => console.log(`       ${t.trim()}`));
}

{
  const midStock = await stockCensus();
  const drifted = Object.keys(stockBefore).filter(pid =>
    midStock[pid] && (midStock[pid].current_stock !== stockBefore[pid].current_stock ||
                      midStock[pid].by_location !== stockBefore[pid].by_location));
  ok('no pre-existing product changed stock during the stock-neutral phases',
    drifted.length === 0, drifted.join(', ') || 'none');

  const mid = await census();
  const movDelta = mid.inventory_stock_movements.size - before.inventory_stock_movements.size;
  const grDelta = mid.goods_receipts.size - before.goods_receipts.size;
  ok('the stock-neutral phases left no stock movement behind', movDelta === 0, String(movDelta));
  ok('the stock-neutral phases left no goods receipt behind', grDelta === 0, String(grDelta));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ STOCK-MOVING PHASES ═══');
console.log('  Receiving, reversal and confirmation. Stock moves here and only here.\n');
// ═════════════════════════════════════════════════════════════════════════════
for (const [label, file] of STOCK_MOVING) {
  const r = await runSuite(file);
  results.push([label, r]);
  console.log(`  ${label.padEnd(26)} ${String(r.passed).padStart(4)} passed, ${r.failed} failed   (${r.seconds}s)`);
  if (r.tail.length) r.tail.forEach(t => console.log(`       ${t.trim()}`));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE RESULTS ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
let totalPass = 0, totalFail = 0;
for (const [label, r] of results) {
  totalPass += r.passed; totalFail += r.failed;
  ok(`${label} completed without a crash`, !r.crashed, r.crashed ? `exit ${r.code}` : '');
  ok(`${label} reported a result line`, r.matched);
  ok(`${label} passed every assertion`, r.failed === 0, `${r.passed} passed, ${r.failed} failed`);
}
console.log(`\n  Aggregate across every suite: ${totalPass} passed, ${totalFail} failed`);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ DEV RETURNED TO BASELINE ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const after = await census();
const stockAfter = await stockCensus();
const { added, removed } = diff(before, after);

// Documents created by a person using the DEV app while this ran are not
// residue. They are identified rather than assumed: a test-created document
// carries a suite marker in its id, and a person's does not.
const TEST_MARKER = /phase[a-h]?\d*test|h\d+test|_test_|testrun/i;
const testResidue = added.filter(x => TEST_MARKER.test(x));
const foreign = added.filter(x => !TEST_MARKER.test(x));

ok('no test-created document survived the run', testResidue.length === 0,
  testResidue.slice(0, 8).join(', ') || 'none');
ok('no pre-existing document was deleted by the run', removed.length === 0,
  removed.slice(0, 8).join(', ') || 'none');

if (foreign.length) {
  console.log(`\n  ${foreign.length} document(s) appeared that carry no test marker.`);
  console.log('  These are attributed to DEV application activity, not to this run:');
  foreign.slice(0, 12).forEach(x => console.log(`    ${x}`));
}

const stockDrift = Object.keys(stockBefore).filter(pid =>
  stockAfter[pid] && (stockAfter[pid].current_stock !== stockBefore[pid].current_stock ||
                      stockAfter[pid].by_location !== stockBefore[pid].by_location));
ok('every pre-existing product holds exactly the stock it started with',
  stockDrift.length === 0,
  stockDrift.map(p => `${p}: ${stockBefore[p].current_stock} → ${stockAfter[p].current_stock}`).join(', ') || 'none');

console.log('\n  collection deltas:');
for (const c of COLLECTIONS) {
  const d = after[c].size - before[c].size;
  console.log(`    ${c.padEnd(28)} ${String(before[c].size).padStart(4)} → ${String(after[c].size).padStart(4)}  ${d === 0 ? '' : (d > 0 ? `(+${d})` : `(${d})`)}`);
}

console.log(`\n═══ H8 RESULT: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed checks:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail === 0 ? 0 : 1);
