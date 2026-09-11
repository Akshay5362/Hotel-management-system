/**
 * testInventoryCleanupSafety.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the one invariant that matters about the inventory test suites:
 *
 *     Running them must never delete pre-existing DEV data.
 *
 * WHY THIS EXISTS
 * Phases E, F and G used to finish by fetching whole collections and deleting
 * every document in them. That destroyed `pr_ui_1789025560656_irnm15`, a
 * purchase request a person had raised through the DEV application. Passing
 * tests said nothing about it, because the suites only ever asserted that
 * their own data was gone — never that anyone else's had survived.
 *
 * HOW IT PROVES IT
 * Sentinels are written straight into Firestore, shaped like documents the
 * application creates (a `pr_ui_…` purchase request, its item, a purchase
 * order and item, a goods receipt and item, a reversal, a bill, a bill line
 * and a stock movement). They are NOT created through any service, so no
 * suite can have recorded them as its own. Every field is snapshotted. Phases
 * E, F and G then run as real child processes, and every sentinel is re-read
 * and compared field by field.
 *
 * A sentinel that survives but was modified is also a failure. Existence
 * alone is not the claim; being untouched is.
 *
 * The sentinels are removed at the end by exact id and re-read to prove they
 * are gone, so DEV is left exactly as it was found.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryCleanupSafety.mjs
 */

import path from 'path';
import crypto from 'crypto';
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
console.log(`[GUARD] project=${PROJECT} (DEV) — safe to proceed\n`);

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${detail ? '  ' + detail : ''}`); }
};

const { db } = await import('../config/firebaseAdmin.js');
const { census, censusDiff } = await import('./helpers/inventoryTestOwnership.mjs');

const TAG = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const now = () => new Date().toISOString();
const BD = '2026-09-10';

/**
 * The purchase request destroyed by the old cleanup. Reported, never recreated:
 * fabricating it would hide the loss rather than record it.
 */
const LOST_REQUEST_ID = 'pr_ui_1789025560656_irnm15';

// ═════════════════════════════════════════════════════════════════════════════
console.log('═══ 1. THE DOCUMENT THAT WAS DESTROYED ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const lostBefore = (await db.collection('purchase_requests').doc(LOST_REQUEST_ID).get()).exists;
console.log(`  ${LOST_REQUEST_ID}: ${lostBefore ? 'still present' : 'ABSENT — destroyed by the old cleanup, not recreated here'}`);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. SENTINELS — WRITTEN AS IF BY A PERSON USING DEV ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Ids deliberately mimic what the application produces (`pr_ui_…`, `po_…`,
 * `gr_…`), so nothing about their shape marks them as test data. Written with
 * the raw Firestore client: no service call touches them, so no suite's
 * ownership ledger can contain them.
 */
const sentinels = [
  ['purchase_requests', `pr_ui_${Date.now()}_${TAG}`, {
    request_number: `PR-SENTINEL-${TAG}`, status: 'PENDING_APPROVAL', department: 'General',
    requested_by_uid: 'sentinel_user', requested_by_name: 'ADMINISTRATOR',
    location_id: 'loc_dev_main', business_date: BD, priority: 'NORMAL',
    item_count: 1, total_estimated_value: 500, created_at: now(), updated_at: now()
  }],
  ['purchase_requests', `pr_ui_${Date.now()}_${TAG}b`, {
    request_number: `PR-SENTINEL-${TAG}-B`, status: 'APPROVED', department: 'Kitchen',
    requested_by_uid: 'sentinel_user', business_date: BD, item_count: 1,
    total_estimated_value: 250, created_at: now(), updated_at: now()
  }],
  ['purchase_orders', `po_sentinel_${TAG}`, {
    po_number: `PO-SENTINEL-${TAG}`, status: 'ISSUED', supplier_id: 'sup_sentinel',
    supplier_name_snapshot: 'Sentinel Supplier', source_request_id: `pr_ui_sentinel_${TAG}`,
    location_id: 'loc_dev_main', business_date: BD, item_count: 1,
    total_estimated_value: 500, created_at: now(), updated_at: now()
  }],
  ['goods_receipts', `gr_sentinel_${TAG}`, {
    receipt_number: `GR-SENTINEL-${TAG}`, po_id: `po_sentinel_${TAG}`,
    supplier_id: 'sup_sentinel', location_id: 'loc_dev_main', business_date: BD,
    total_received_items: 1, total_received_quantity: 5, total_received_value: 500,
    received_by_uid: 'sentinel_user', received_at: now(), created_at: now()
  }],
  ['goods_receipt_reversals', `grv_sentinel_${TAG}`, {
    reversal_id: `grv_sentinel_${TAG}`, receipt_id: `gr_sentinel_${TAG}`,
    purchase_order_id: `po_sentinel_${TAG}`, reason: 'Sentinel reversal record',
    reversed_quantity: 5, reversed_value: 500, created_at: now()
  }],
  ['inventory_bills', `bill_sentinel_${TAG}`, {
    status: 'IN_REVIEW', file_name: `bill_sentinel_${TAG}.jpg`,
    file_sha256: crypto.randomBytes(32).toString('hex'), file_size: 2048,
    mime_type: 'image/jpeg', uploaded_by_uid: 'sentinel_user',
    uploaded_by_name: 'ADMINISTRATOR', business_date: BD, created_at: now(), updated_at: now()
  }],
  ['inventory_stock_movements', `mov_sentinel_${TAG}`, {
    product_id: 'prod_dev_rice_01', location_id: 'loc_dev_main', movement_type: 'ADJUSTMENT',
    quantity: 1, qty_before: 25, qty_after: 26, unit: 'KG', reference_type: 'MANUAL',
    reason: 'Sentinel movement', actor_uid: 'sentinel_user', business_date: BD, created_at: now()
  }]
];
// Children, added once their parent ids are known.
sentinels.push(
  ['purchase_request_items', `${sentinels[0][1]}_001`, {
    request_id: sentinels[0][1], request_item_id: `${sentinels[0][1]}_001`, line_no: 1,
    product_id: 'prod_dev_rice_01', sku: 'DEV-RICE-01', product_name_snapshot: 'Rice',
    requested_quantity: 10, unit: 'KG', estimated_unit_cost: 50, estimated_total: 500, created_at: now()
  }],
  ['purchase_order_items', `po_sentinel_${TAG}_001`, {
    po_id: `po_sentinel_${TAG}`, line_no: 1, product_id: 'prod_dev_rice_01',
    sku_snapshot: 'DEV-RICE-01', product_name_snapshot: 'Rice', ordered_quantity: 10,
    received_quantity: 5, unit_snapshot: 'KG', estimated_unit_cost: 50,
    estimated_line_total: 500, created_at: now()
  }],
  ['goods_receipt_items', `gr_sentinel_${TAG}_001`, {
    receipt_id: `gr_sentinel_${TAG}`, line_no: 1, po_item_id: `po_sentinel_${TAG}_001`,
    product_id: 'prod_dev_rice_01', product_name_snapshot: 'Rice', sku_snapshot: 'DEV-RICE-01',
    received_quantity: 5, unit_snapshot: 'KG', stock_movement_id: `mov_sentinel_${TAG}`, created_at: now()
  }],
  ['inventory_bill_lines', `bill_sentinel_${TAG}_0001`, {
    bill_id: `bill_sentinel_${TAG}`, line_no: 1, description: 'Sentinel line',
    raw_text: 'Rice 10 KG', raw_quantity: 10, raw_unit: 'KG', excluded: false, created_at: now()
  }]
);

for (const [col, id, data] of sentinels) {
  await db.collection(col).doc(id).set(data);
}
console.log(`  ${sentinels.length} sentinel document(s) written across ${new Set(sentinels.map(s => s[0])).size} collections`);
for (const [col, id] of sentinels) console.log(`    ${col}/${id}`);

/** Full field snapshot: survival alone is not the claim, being untouched is. */
const snapshotOf = async () => {
  const out = {};
  for (const [col, id] of sentinels) {
    const snap = await db.collection(col).doc(id).get();
    out[`${col}/${id}`] = snap.exists ? JSON.stringify(snap.data()) : null;
  }
  return out;
};
const sentinelBefore = await snapshotOf();
ok('every sentinel is readable before the suites run',
  Object.values(sentinelBefore).every(v => v !== null));

const censusBefore = await census(db);
console.log('\n  DEV baseline (document counts):');
for (const c of Object.keys(censusBefore)) console.log(`    ${c.padEnd(26)} ${censusBefore[c].size}`);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. RUNNING PHASES E, F AND G AGAINST THE SENTINELS ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
function runSuite(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(BACKEND, 'tests', file)], {
      env: { ...process.env, HPMS_ENV: 'development' }, cwd: process.cwd()
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
        fails: out.split('\n').filter(l => /✗|\[FAIL\]/.test(l)).slice(0, 6),
        seconds: Math.round((Date.now() - started) / 1000)
      });
    });
  });
}

const RUNS = Number(process.env.SAFETY_RUNS || 1);
const results = [];
for (let r = 1; r <= RUNS; r++) {
  for (const [label, file] of [['E', 'testInventoryPhaseE.mjs'], ['F', 'testInventoryPhaseF.mjs'], ['G', 'testInventoryPhaseG.mjs']]) {
    const res = await runSuite(file);
    results.push([`${label} (run ${r})`, res]);
    console.log(`  Phase ${label} run ${r}: ${res.passed} passed, ${res.failed} failed  (${res.seconds}s)`);
    res.fails.forEach(f => console.log(`       ${f.trim()}`));
  }
}
for (const [label, res] of results) {
  ok(`Phase ${label} completed without a crash`, !(res.code !== 0 && !res.matched), res.code !== 0 && !res.matched ? `exit ${res.code}` : '');
  ok(`Phase ${label} passed every assertion`, res.failed === 0, `${res.passed} passed, ${res.failed} failed`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. SENTINEL PRESERVATION ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
const sentinelAfter = await snapshotOf();
const gone = [], changed = [];
for (const key of Object.keys(sentinelBefore)) {
  if (sentinelAfter[key] === null) gone.push(key);
  else if (sentinelAfter[key] !== sentinelBefore[key]) changed.push(key);
}
for (const [col, id] of sentinels) {
  const key = `${col}/${id}`;
  ok(`sentinel survived untouched: ${key}`,
    sentinelAfter[key] !== null && sentinelAfter[key] === sentinelBefore[key],
    sentinelAfter[key] === null ? 'DELETED' : (sentinelAfter[key] !== sentinelBefore[key] ? 'MODIFIED' : ''));
}
ok('NO sentinel was deleted by the inventory suites', gone.length === 0, gone.join(', '));
ok('NO sentinel was modified by the inventory suites', changed.length === 0, changed.join(', '));

const { removed, added } = censusDiff(censusBefore, await census(db));
const foreignRemoved = removed.filter(r => !sentinels.some(([c, i]) => r === `${c}/${i}`));
ok('no pre-existing DEV document disappeared during the runs', foreignRemoved.length === 0,
  foreignRemoved.slice(0, 8).join(', '));
if (added.length) {
  console.log(`\n  ${added.length} document(s) appeared during the runs and were left alone:`);
  added.slice(0, 8).forEach(a => console.log(`    ${a}`));
}

const lostAfter = (await db.collection('purchase_requests').doc(LOST_REQUEST_ID).get()).exists;
ok(`${LOST_REQUEST_ID} was not affected by these runs`, lostBefore === lostAfter,
  `before=${lostBefore ? 'present' : 'absent'} after=${lostAfter ? 'present' : 'absent'}`);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 5. REMOVING THE SENTINELS ═══\n');
// ═════════════════════════════════════════════════════════════════════════════
// By exact id, children before parents, then re-read to prove each is gone.
const order = ['inventory_bill_lines', 'goods_receipt_items', 'purchase_order_items', 'purchase_request_items',
  'inventory_stock_movements', 'goods_receipt_reversals', 'goods_receipts', 'inventory_bills',
  'purchase_orders', 'purchase_requests'];
for (const col of order) {
  for (const [c, id] of sentinels) if (c === col) await db.collection(c).doc(id).delete();
}
const stillThere = [];
for (const [col, id] of sentinels) {
  if ((await db.collection(col).doc(id).get()).exists) stillThere.push(`${col}/${id}`);
}
ok('every sentinel is re-read and confirmed removed', stillThere.length === 0, stillThere.join(', '));

const censusEnd = await census(db);
const endDiff = censusDiff(censusBefore, censusEnd);
const endRemoved = endDiff.removed.filter(r => !sentinels.some(([c, i]) => r === `${c}/${i}`));
ok('DEV is left exactly as it was found', endRemoved.length === 0, endRemoved.slice(0, 8).join(', '));
console.log('\n  DEV after (document counts):');
for (const c of Object.keys(censusEnd)) {
  const d = censusEnd[c].size - censusBefore[c].size;
  console.log(`    ${c.padEnd(26)} ${censusBefore[c].size} → ${censusEnd[c].size}${d === 0 ? '' : `  (${d > 0 ? '+' : ''}${d})`}`);
}

console.log(`\n═══ CLEANUP SAFETY RESULT: ${pass} passed, ${fail} failed ═══`);
if (failures.length) { console.log('\nFailed checks:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail === 0 ? 0 : 1);
