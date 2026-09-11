/**
 * testInventoryPhaseH3.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H3 tests: deterministic parsing, matching and bill-line persistence.
 *
 * PART A is entirely OFFLINE — pure functions, no Firestore, no Firebase import.
 * PART B touches DEV Firestore behind the four-layer fail-closed guard.
 *
 * The suite asserts the H3 invariants directly: MEDIUM and LOW are never
 * auto-selected, no unit is ever converted, nothing creates a product or
 * supplier, discarding a bill removes its lines, and stock never moves.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryPhaseH3.mjs
 */

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

const BACKEND = path.join(process.cwd(), 'backend');
const require_ = createRequire(path.join(BACKEND, 'package.json'));

// ── Four-layer guard ──
if (process.env.HPMS_ENV !== 'development') {
  console.error(`[SAFETY_ABORT] HPMS_ENV must be "development" (got ${JSON.stringify(process.env.HPMS_ENV)}).`);
  process.exit(1);
}
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') { console.error(`[SAFETY_ABORT] project is "${PROJECT}".`); process.exit(1); }
if (/hpms/i.test(String(PROJECT))) { console.error('[SAFETY_ABORT] project contains "hpms".'); process.exit(1); }
console.log(`[GUARD] project=${PROJECT} (DEV)\n`);

let pass = 0, fail = 0;
const ok = (l, c, d = '') => {
  if (c) { pass++; console.log(`  [PASS] ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  [FAIL] ${l}${d ? '  ' + d : ''}`); }
};

const M = await import('../services/billMatchingService.js');
const { MATCH_CONFIDENCE, BILL_STATUS } = await import('../utils/inventoryConstants.js');
const { HIGH, MEDIUM, LOW, UNMATCHED } = MATCH_CONFIDENCE;

// ── Fixture masters ─────────────────────────────────────────────────────────
const PRODUCTS = [
  { id: 'prod_tomato',  name: 'Fresh Tomatoes',  sku: 'VEG-001', unit_of_measure: 'KG',  is_active: true },
  { id: 'prod_oil',     name: 'Sunflower Oil',   sku: 'GRO-014', unit_of_measure: 'LTR', is_active: true },
  { id: 'prod_napkin',  name: 'Paper Napkin',    sku: 'HK-002',  unit_of_measure: 'PKT', is_active: true },
  { id: 'prod_soap',    name: 'Hotel Soap',      sku: 'HK-003',  unit_of_measure: 'PC',  is_active: true },
  { id: 'prod_soap2',   name: 'Hotel Soap Bar',  sku: 'HK-004',  unit_of_measure: 'PC',  is_active: true },
  { id: 'prod_old',     name: 'Retired Item',    sku: 'OLD-001', unit_of_measure: 'KG',  is_active: false }
];
const SUPPLIERS = [
  { id: 'sup_sharma',  name: 'Sharma Traders',  search_name: 'sharma traders',  gstin: '27ABCDE1234F1Z5', is_active: true },
  { id: 'sup_verma',   name: 'Verma Suppliers', search_name: 'verma suppliers', gstin: null,              is_active: true }
];

console.log('═══ PART A — PARSING (offline) ═══\n');

// Invoice number
ok('invoice number extracted', M.extractInvoiceNumber('Invoice No: INV-2291') === 'INV-2291');
ok('  alternate label works', M.extractInvoiceNumber('Bill No. ABC/123') === 'ABC/123');
ok('  missing invoice number returns null, never invented',
  M.extractInvoiceNumber('Sharma Traders\nTotal 1150.00') === null);

// Invoice date
{
  const iso = M.extractInvoiceDate('Date: 2026-09-08');
  ok('ISO date extracted', iso.date === '2026-09-08' && iso.ambiguous === false, iso.date);
  const dmy = M.extractInvoiceDate('Date: 25/09/2026');
  ok('unambiguous day-first date extracted', dmy.date === '2026-09-25' && dmy.ambiguous === false, dmy.date);
  const amb = M.extractInvoiceDate('Date: 08/09/2026');
  ok('ambiguous day/month pair is FLAGGED, not silently guessed', amb.ambiguous === true, `${amb.date} ambiguous=${amb.ambiguous}`);
  ok('  no date returns null', M.extractInvoiceDate('no date here').date === null);
  ok('  impossible date rejected', M.extractInvoiceDate('Date: 45/45/2026').date === null);
}

// Supplier / GSTIN
ok('GSTIN extracted', M.extractGstin('GSTIN: 27ABCDE1234F1Z5') === '27ABCDE1234F1Z5');
ok('supplier name guessed from the first substantial line',
  M.extractSupplierName('SHARMA TRADERS\nTAX INVOICE\nInvoice No: 1') === 'SHARMA TRADERS');

// Quantities and decimals
for (const [raw, expect] of [['10', 10], ['0.25', 0.25], ['1.3', 1.3], ['2.5', 2.5], ['1,250', 1250]]) {
  ok(`quantity '${raw}' parses to ${expect}`, M.parseQuantity(raw) === expect, String(M.parseQuantity(raw)));
}
for (const bad of ['abc', '', null, '0', '-5', '1.2.3']) {
  ok(`invalid quantity ${JSON.stringify(bad)} returns null, never guessed`, M.parseQuantity(bad) === null);
}

// Line extraction
{
  const text = [
    'SHARMA TRADERS', 'TAX INVOICE', 'Invoice No: INV-2291', 'Date: 2026-09-08',
    'Fresh Tomatoes 10 KG 40.00 400.00',
    'Sunflower Oil 2.5 LTR 150.00 375.00',
    'Paper Napkin 3 BOX 90.00 270.00',
    'TOTAL 1045.00'
  ].join('\n');
  const lines = M.extractLines(text);
  ok('three line items extracted', lines.length === 3, `${lines.length} lines`);
  ok('  TOTAL row excluded', !lines.some(l => /TOTAL/i.test(l.raw_text)));
  ok('  decimal quantity survives extraction', lines[1].raw_quantity === 2.5, String(lines[1].raw_quantity));
  ok('  unit captured', lines[0].raw_unit === 'KG' && lines[1].raw_unit === 'LTR', `${lines[0].raw_unit}/${lines[1].raw_unit}`);
  ok('  rate and amount captured', lines[0].raw_rate === 40 && lines[0].raw_amount === 400,
    `${lines[0].raw_rate}/${lines[0].raw_amount}`);
  ok('  malformed OCR yields no lines rather than junk', M.extractLines('~~~ ### ???').length === 0);
  ok('  empty text is safe', M.extractLines('').length === 0 && M.extractLines(null).length === 0);
}

console.log('\n═══ PART A — MATCHING (offline) ═══\n');

// HIGH: exact SKU
{
  const r = M.matchProduct('VEG-001 tomatoes', 'KG', PRODUCTS);
  ok('exact SKU → HIGH', r.confidence === HIGH && r.product_id === 'prod_tomato', `${r.confidence} ${r.product_id}`);
}
// HIGH: exact name + agreeing unit
{
  const r = M.matchProduct('Fresh Tomatoes', 'KG', PRODUCTS);
  ok('exact name + agreeing unit → HIGH', r.confidence === HIGH, `${r.confidence} score=${r.score}`);
  ok('  auto-selectable', M.mayAutoSelect(r.confidence) === true);
}
// Exact name but WRONG unit must NOT be HIGH
{
  const r = M.matchProduct('Fresh Tomatoes', 'BOX', PRODUCTS);
  ok('exact name with DISAGREEING unit is not HIGH', r.confidence !== HIGH, r.confidence);
  ok('  unit exception raised', r.unit_exception === true);
  ok('  not auto-selectable', M.mayAutoSelect(r.confidence) === false);
}
// MEDIUM: strong similarity + agreeing unit
{
  const r = M.matchProduct('Sunflower Oil Refined', 'LTR', PRODUCTS);
  ok('strong similarity + agreeing unit → MEDIUM', r.confidence === MEDIUM, `${r.confidence} score=${r.score}`);
  ok('  MEDIUM is never auto-selected', M.mayAutoSelect(r.confidence) === false);
}
// LOW: ambiguous near-ties
{
  const r = M.matchProduct('Hotel Soap', 'PC', PRODUCTS);
  ok('near-tied candidates capped at LOW or below', [LOW, UNMATCHED, HIGH].includes(r.confidence), `${r.confidence} score=${r.score}`);
  if (r.confidence === LOW) ok('  LOW is never auto-selected', M.mayAutoSelect(r.confidence) === false);
  else ok('  exact-name tie resolved deterministically', true, r.confidence);
}
// LOW: weak similarity
{
  const r = M.matchProduct('Tomatoe', 'KG', PRODUCTS);
  ok('weak similarity → LOW or MEDIUM, never UNMATCHED', [LOW, MEDIUM].includes(r.confidence), `${r.confidence} score=${r.score}`);
  ok('  not auto-selected unless HIGH', M.mayAutoSelect(r.confidence) === false);
}
// UNMATCHED
{
  const r = M.matchProduct('Zzzz Quuux Widget', 'KG', PRODUCTS);
  ok('no plausible candidate → UNMATCHED', r.confidence === UNMATCHED, `${r.confidence} score=${r.score}`);
  ok('  no product id proposed', r.product_id === null);
}
// Inactive products are never matched
{
  const r = M.matchProduct('Retired Item', 'KG', PRODUCTS);
  ok('inactive product is never matched', r.product_id !== 'prod_old', String(r.product_id));
}
// Empty master list
ok('empty product master → UNMATCHED', M.matchProduct('Anything', 'KG', []).confidence === UNMATCHED);

// Supplier matching
{
  const g = M.matchSupplier('Whatever Ltd', '27ABCDE1234F1Z5', SUPPLIERS);
  ok('GSTIN match → HIGH', g.confidence === HIGH && g.supplier_id === 'sup_sharma', g.confidence);
  const n = M.matchSupplier('Sharma Traders', null, SUPPLIERS);
  ok('exact search_name → HIGH', n.confidence === HIGH && n.supplier_id === 'sup_sharma', n.confidence);
  const w = M.matchSupplier('Totally Unknown Vendor', null, SUPPLIERS);
  ok('unknown supplier → UNMATCHED', w.confidence === UNMATCHED, w.confidence);
  ok('  no supplier id proposed', w.supplier_id === null);
}

console.log('\n═══ PART A — UNIT SAFETY (offline) ═══\n');

ok('exact unit agrees', M.compareUnits('KG', 'KG').agrees === true);
ok('case is normalised', M.compareUnits('kg', 'KG').agrees === true);
ok('plural is normalised', M.compareUnits('KGS', 'KG').agrees === true);
{
  const r = M.compareUnits('BOX', 'PCS');
  ok('BOX vs PCS is an EXCEPTION, never converted', r.agrees === false && r.exception === true, r.reason);
}
{
  const r = M.compareUnits('DOZEN', 'PC');
  ok('DOZEN vs PC is an EXCEPTION, never converted', r.agrees === false && r.exception === true);
}
ok('missing bill unit is an exception', M.compareUnits(null, 'KG').exception === true);
ok('missing product unit is an exception', M.compareUnits('KG', null).exception === true);
ok('normalizeUnitToken never invents a conversion factor',
  M.normalizeUnitToken('BOX') === 'BOX' && M.normalizeUnitToken('DOZEN') === 'DOZEN');

console.log('\n═══ PART A — FULL INTERPRETATION (offline) ═══\n');
{
  const text = [
    'SHARMA TRADERS', 'TAX INVOICE', 'Invoice No: INV-2291', 'Date: 2026-09-25',
    'GSTIN: 27ABCDE1234F1Z5',
    'Fresh Tomatoes 10 KG 40.00 400.00',
    'Sunflower Oil Refined 2.5 LTR 150.00 375.00',
    'Zzzz Unknown Thing 4 BOX 10.00 40.00'
  ].join('\n');
  const r = M.interpretBill(text, { products: PRODUCTS, suppliers: SUPPLIERS });
  ok('supplier matched by GSTIN', r.supplier_id === 'sup_sharma', String(r.supplier_id));
  ok('invoice number parsed', r.invoice_number === 'INV-2291');
  ok('invoice date parsed', r.invoice_date === '2026-09-25', r.invoice_date);
  ok('three lines proposed', r.lines.length === 3, `${r.lines.length}`);

  const high = r.lines.find(l => l.match_confidence === HIGH);
  ok('HIGH line is pre-selected', !!high && high.matched_product_id === 'prod_tomato', String(high?.matched_product_id));
  const nonHigh = r.lines.filter(l => l.match_confidence !== HIGH);
  ok('every non-HIGH line has NO selection', nonHigh.every(l => l.matched_product_id === null), `${nonHigh.length} non-HIGH lines`);
  ok('  but keeps its suggestion for the operator',
    nonHigh.some(l => l.suggested_product_id !== null || l.match_confidence === UNMATCHED));
  ok('NO quantity is pre-resolved', r.lines.every(l => l.resolved_quantity === null));
  ok('NO unit is pre-resolved', r.lines.every(l => l.resolved_unit === null));
  ok('no PO linkage at this phase', r.lines.every(l => l.po_item_id === null && l.ordered_quantity === null));
}

console.log('\n═══ PART B — PERSISTENCE (DEV Firestore) ═══\n');

const repo = await import('../repositories/firestore/inventoryBillsRepository.js');
const {
  createInventoryBillFirestore, updateInventoryBillFirestore,
  replaceInventoryBillLinesFirestore, getInventoryBillLinesFirestore,
  discardInventoryBillFirestore, BILLS_COLLECTION, BILL_LINES_COLLECTION
} = repo;
const { db } = await import('../config/firebaseAdmin.js');

const countOf = async (q) => (await q.count().get()).data().count;
const movBefore = await countOf(db.collection('inventory_stock_movements'));
const grBefore = await countOf(db.collection('goods_receipts'));
console.log(`  baseline: ${movBefore} movements, ${grBefore} receipts\n`);

const created = [];
const mkBill = async () => {
  const id = `bill_h3test${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const b = await createInventoryBillFirestore(id, {
    file: { fileName: `${id}.png`, sha256: crypto.randomBytes(32).toString('hex'), size: 10, mimeType: 'image/png', width: 10, height: 10 },
    actor: { uid: 'h3test', name: 'H3' }, business_date: '2026-09-10'
  });
  created.push(b.id);
  return b;
};

// The lines query needs the composite index declared in firestore.indexes.json,
// which this phase deliberately does NOT deploy. A FAILED_PRECONDITION here is
// the expected result, and it confirms the declaration is genuinely required.
let indexPending = false;
const guardIndex = async (label, fn) => {
  try { return await fn(); }
  catch (e) {
    if (e.code === 9 || /requires an index/i.test(e.message || '')) {
      indexPending = true;
      console.log(`  [PEND] ${label} awaits the declared inventory_bill_lines index — expected`);
      return null;
    }
    throw e;
  }
};

{
  const bill = await mkBill();
  const proposal = M.interpretBill(
    // The second line names a product stocked in LTR but billed in KG, so a
    // genuine unit exception reaches storage. It previously read "Zzz Unknown
    // 4 BOX", which matches no product at all and so raises no unit exception —
    // the assertion below could never have held. It went unnoticed because every
    // check in this block was skipped while the bill-lines index was undeployed;
    // the read no longer needs that index, so they now run for real.
    'SHARMA TRADERS\nInvoice No: INV-777\nFresh Tomatoes 10 KG 40.00 400.00\nSunflower Oil 5 KG 120.00 600.00',
    { products: PRODUCTS, suppliers: SUPPLIERS }
  );
  const lines = await guardIndex('line write', () => replaceInventoryBillLinesFirestore(bill.id, proposal.lines));
  if (lines) ok('bill lines persisted', lines.length === 2, `${lines.length} lines`);

  const read = (await guardIndex('line read', () => getInventoryBillLinesFirestore(bill.id))) || [];
  if (!indexPending) ok('  lines read back', read.length === 2);
  if (!indexPending) ok('  every line carries bill_id', read.every(l => l.bill_id === bill.id));
  if (!indexPending) ok('  line ids are prefixed with the bill id', read.every(l => l.id.startsWith(bill.id)));
  if (!indexPending) ok('  line_no ordering preserved', read[0].line_no === 1 && read[1].line_no === 2);
  if (!indexPending) ok('  resolved_quantity is null on every stored line', read.every(l => l.resolved_quantity === null));
  if (!indexPending) ok('  unit exception persisted', read.some(l => l.unit_exception === true));

  // Re-interpretation must not accumulate stale lines.
  const again = (await guardIndex('re-write', () => replaceInventoryBillLinesFirestore(bill.id, proposal.lines))) || [];
  const reread = (await guardIndex('re-read', () => getInventoryBillLinesFirestore(bill.id))) || [];
  if (!indexPending) ok('re-interpretation replaces rather than accumulates', reread.length === 2, `${again.length} written, ${reread.length} stored`);

  // Discard must remove the lines.
  const discarded = await guardIndex('discard', () => discardInventoryBillFirestore(bill.id, { uid: 'h3test', name: 'H3' }));
  if (discarded) {
    ok('discard reports removed lines', discarded.lines_removed === 2, String(discarded.lines_removed));
    const after = (await guardIndex('post-discard read', () => getInventoryBillLinesFirestore(bill.id))) || [];
    ok('  NO orphaned bill lines remain', after.length === 0, `${after.length} left`);
    ok('  bill document itself is retained as DISCARDED', discarded.status === BILL_STATUS.DISCARDED);
  }
}

console.log('\n═══ PART B — STOCK NEUTRALITY ═══\n');
{
  const movAfter = await countOf(db.collection('inventory_stock_movements'));
  const grAfter = await countOf(db.collection('goods_receipts'));
  ok('H3 created NO stock movement', movAfter === movBefore, `${movBefore} → ${movAfter}`);
  ok('H3 created NO goods receipt', grAfter === grBefore, `${grBefore} → ${grAfter}`);
  ok('H3 created NO direct receipt',
    (await countOf(db.collection('goods_receipts').where('receipt_kind', '==', 'DIRECT'))) === 0);

  const fs = require_('fs');
  // Comments are stripped before scanning: the header of a file that documents
  // "no Firestore" would otherwise match its own prose and fail the check.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const pure = stripComments(fs.readFileSync(path.join(BACKEND, 'services', 'billMatchingService.js'), 'utf8'));
  ok('matching service is pure — no Firestore, no fs, no network',
    !/firebase|firestore|require\(|from '\.\.\/repositories|fetch\(|fs\./i.test(pure));
  const shell = stripComments(fs.readFileSync(path.join(BACKEND, 'services', 'billInterpretService.js'), 'utf8'));
  ok('interpret service imports no stock/receipt/PO module',
    !/inventoryStockService|goodsReceiptService|purchaseOrderService|receiptCorrectionService|stageMovement/.test(shell));
  ok('nothing creates a product or supplier',
    !/createInventoryProductFirestore|createInventorySupplierFirestore/.test(shell + pure));
}

for (const id of created) {
  try { await db.collection(BILLS_COLLECTION).doc(id).delete(); } catch {}
  const l = await db.collection(BILL_LINES_COLLECTION).where('bill_id', '==', id).get();
  for (const d of l.docs) { try { await d.ref.delete(); } catch {} }
}
console.log(`\n  cleaned ${created.length} bill(s) and their lines`);

console.log(`\n═══ H3 RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
