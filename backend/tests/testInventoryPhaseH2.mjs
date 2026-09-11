/**
 * testInventoryPhaseH2.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Focused Phase H2 tests: OCR extraction over stored supplier bills.
 *
 * Four-layer fail-closed guard, identical to the A–G and H1 suites. Firebase
 * Admin is imported only after the guard passes.
 *
 * The suite asserts the H2 invariant directly: OCR reads a file and writes four
 * fields, and creates NO stock movement, goods receipt, direct receipt or bill
 * line.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryPhaseH2.mjs
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';

const BACKEND = path.join(process.cwd(), 'backend');
const require_ = createRequire(path.join(BACKEND, 'package.json'));

// ── Guard 1 ──
if (process.env.HPMS_ENV !== 'development') {
  console.error(`[SAFETY_ABORT] HPMS_ENV must be "development" (got ${JSON.stringify(process.env.HPMS_ENV)}).`);
  process.exit(1);
}
// ── Guard 2 — development env file ONLY ──
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });
// ── Guard 3 ──
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') {
  console.error(`[SAFETY_ABORT] project is "${PROJECT}", expected sky5-development.`);
  process.exit(1);
}
// ── Guard 4 ──
if (/hpms/i.test(String(PROJECT))) {
  console.error('[SAFETY_ABORT] project id contains "hpms".');
  process.exit(1);
}
console.log(`[GUARD] project=${PROJECT} (DEV)\n`);

let pass = 0, fail = 0;
const ok = (l, c, d = '') => {
  if (c) { pass++; console.log(`  [PASS] ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  [FAIL] ${l}${d ? '  ' + d : ''}`); }
};

const sharp = require_('sharp');
const mw = await import('../middleware/billUploadMiddleware.js');
const { inventoryBillsDir, resolveBillPath } = mw;
const ocr = await import('../services/billOcrService.js');
const { runBillOcr, OCR_ENGINE, OCR_STARTABLE_STATUSES } = ocr;
const { extractOCRData } = await import('../services/ocrService.js');
const repo = await import('../repositories/firestore/inventoryBillsRepository.js');
const {
  createInventoryBillFirestore, getInventoryBillByIdFirestore,
  updateInventoryBillFirestore, BILLS_COLLECTION, BILL_LINES_COLLECTION
} = repo;
const { BILL_STATUS, BILL_OCR_TEXT_MAX } = await import('../utils/inventoryConstants.js');
const { db } = await import('../config/firebaseAdmin.js');

const countOf = async (q) => (await q.count().get()).data().count;
const movBefore = await countOf(db.collection('inventory_stock_movements'));
const grBefore = await countOf(db.collection('goods_receipts'));
console.log(`  baseline: ${movBefore} movements, ${grBefore} receipts\n`);

const createdBills = [];
const createdFiles = [];

/** Renders a realistic PRINTED supplier bill so Tesseract has genuine text to read. */
async function makePrintedBill(fileName) {
  const svg = `<svg width="1000" height="620" xmlns="http://www.w3.org/2000/svg">
    <rect width="1000" height="620" fill="white"/>
    <text x="40" y="60"  font-family="DejaVu Sans, Arial" font-size="34" font-weight="bold" fill="black">SHARMA TRADERS</text>
    <text x="40" y="100" font-family="DejaVu Sans, Arial" font-size="22" fill="black">TAX INVOICE</text>
    <text x="40" y="140" font-family="DejaVu Sans, Arial" font-size="22" fill="black">Invoice No: INV-2291</text>
    <text x="40" y="175" font-family="DejaVu Sans, Arial" font-size="22" fill="black">Date: 08/09/2026</text>
    <line x1="40" y1="200" x2="960" y2="200" stroke="black" stroke-width="2"/>
    <text x="40"  y="240" font-family="DejaVu Sans, Arial" font-size="22" fill="black">ITEM</text>
    <text x="480" y="240" font-family="DejaVu Sans, Arial" font-size="22" fill="black">QTY</text>
    <text x="640" y="240" font-family="DejaVu Sans, Arial" font-size="22" fill="black">RATE</text>
    <text x="820" y="240" font-family="DejaVu Sans, Arial" font-size="22" fill="black">AMOUNT</text>
    <line x1="40" y1="255" x2="960" y2="255" stroke="black" stroke-width="1"/>
    <text x="40"  y="300" font-family="DejaVu Sans, Arial" font-size="22" fill="black">Fresh Tomatoes</text>
    <text x="480" y="300" font-family="DejaVu Sans, Arial" font-size="22" fill="black">10 KG</text>
    <text x="640" y="300" font-family="DejaVu Sans, Arial" font-size="22" fill="black">40.00</text>
    <text x="820" y="300" font-family="DejaVu Sans, Arial" font-size="22" fill="black">400.00</text>
    <text x="40"  y="345" font-family="DejaVu Sans, Arial" font-size="22" fill="black">Sunflower Oil</text>
    <text x="480" y="345" font-family="DejaVu Sans, Arial" font-size="22" fill="black">5 LTR</text>
    <text x="640" y="345" font-family="DejaVu Sans, Arial" font-size="22" fill="black">150.00</text>
    <text x="820" y="345" font-family="DejaVu Sans, Arial" font-size="22" fill="black">750.00</text>
    <line x1="40" y1="380" x2="960" y2="380" stroke="black" stroke-width="1"/>
    <text x="640" y="425" font-family="DejaVu Sans, Arial" font-size="24" font-weight="bold" fill="black">TOTAL</text>
    <text x="820" y="425" font-family="DejaVu Sans, Arial" font-size="24" font-weight="bold" fill="black">1150.00</text>
    <text x="40"  y="500" font-family="DejaVu Sans, Arial" font-size="18" fill="black">GSTIN: 27ABCDE1234F1Z5</text>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const p = path.join(inventoryBillsDir, fileName);
  fs.writeFileSync(p, buf);
  createdFiles.push(p);
  return { path: p, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

async function makeBillDoc(fileName, file, extra = {}) {
  const id = `bill_h2test${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const bill = await createInventoryBillFirestore(id, {
    file: { fileName, sha256: file.sha256, size: file.size, mimeType: 'image/png', width: 1000, height: 620 },
    actor: { uid: 'h2test_uid', name: 'H2 Test' },
    business_date: '2026-09-10',
    ...extra
  });
  createdBills.push(bill.id);
  return bill;
}

console.log('═══ OCR EXTRACTION ═══\n');

// 1–3. A clean printed bill produces text, confidence and engine.
let extractedBill = null;
{
  const fileName = `bill_h2_${crypto.randomUUID()}.png`;
  const file = await makePrintedBill(fileName);
  const bill = await makeBillDoc(fileName, file);
  ok('bill starts as UPLOADED', bill.status === BILL_STATUS.UPLOADED, bill.status);

  const t0 = Date.now();
  const { bill: after, outcome } = await runBillOcr(bill.id);
  const ms = Date.now() - t0;
  extractedBill = after;

  ok('printed bill extracts successfully', outcome === BILL_STATUS.EXTRACTED, `${outcome} in ${ms}ms`);
  ok('  status is EXTRACTED', after.status === BILL_STATUS.EXTRACTED, after.status);
  ok('  raw text is stored', typeof after.ocr_raw_text === 'string' && after.ocr_raw_text.length > 0,
    `${after.ocr_raw_text?.length || 0} chars`);
  ok('  confidence is stored', typeof after.ocr_confidence === 'number', String(after.ocr_confidence));
  ok('  engine is stored', after.ocr_engine === OCR_ENGINE, after.ocr_engine);
  ok('  completion timestamp stored', !!after.ocr_completed_at, after.ocr_completed_at);

  const text = (after.ocr_raw_text || '').toUpperCase();
  const found = ['SHARMA', 'INVOICE', 'TOMATOES', '2291'].filter(w => text.includes(w));
  ok('  recognisable content extracted', found.length >= 2, `matched: ${found.join(', ') || 'none'}`);

  // 8. The original file must be untouched by OCR.
  const abs = resolveBillPath(fileName);
  const nowHash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  ok('original bill file is byte-identical after OCR', nowHash === file.sha256);
  ok('  stored sha256 unchanged on the document', after.file_sha256 === file.sha256);

  // The worker's preprocessed copy must not be left behind in the bills directory.
  const prep = abs.replace(/\.png$/, '_prep.png');
  ok('  preprocessed artifact swept from the bills directory', !fs.existsSync(prep));
}

// 12. No bill lines were created by extraction.
{
  // Scoped to the bills THIS suite uploaded. Counting the whole collection made
  // the check fail whenever DEV happened to hold an unrelated reviewed bill —
  // a real bill uploaded through the UI, for instance — which says nothing
  // about whether extraction created lines. The security claim is unchanged:
  // extraction must leave every bill it touched with zero lines.
  let lines = 0;
  for (const id of createdBills) {
    lines += await countOf(db.collection(BILL_LINES_COLLECTION).where('bill_id', '==', id));
  }
  ok('OCR created NO bill lines', lines === 0, `${lines} lines`);
  ok('  no product match written', extractedBill.supplier_id === null && extractedBill.mode === null);
}

console.log('\n═══ FAILURE HANDLING ═══\n');

// 5 + 6. A file that is not a readable image → EXTRACTION_FAILED, bill survives.
{
  const fileName = `bill_h2bad_${crypto.randomUUID()}.png`;
  const p = path.join(inventoryBillsDir, fileName);
  fs.writeFileSync(p, Buffer.from('not an image at all, just text bytes'));
  createdFiles.push(p);
  const bill = await makeBillDoc(fileName, { size: 36, sha256: 'x'.repeat(64) });

  const { bill: after, outcome, reason } = await runBillOcr(bill.id);
  ok('unreadable file yields EXTRACTION_FAILED', outcome === BILL_STATUS.EXTRACTION_FAILED, outcome);
  ok('  a reason is recorded', !!reason, String(reason).slice(0, 60));
  ok('  bill document still exists and is usable', !!after && after.status === BILL_STATUS.EXTRACTION_FAILED);
  ok('  file identity preserved', after.file_name === fileName);
  ok('  engine still recorded on failure', after.ocr_engine === OCR_ENGINE);
  ok('  raw text is null, not garbage', after.ocr_raw_text === null);
}

// 7. The OCR failure contract: a missing input resolves rather than hanging.
{
  const t0 = Date.now();
  const res = await extractOCRData(path.join(inventoryBillsDir, 'does_not_exist_h2.png'), 'image/png');
  const ms = Date.now() - t0;
  ok('missing input resolves instead of hanging', res && typeof res === 'object', `${ms}ms`);
  ok('  resolves to empty text, zero confidence', res.preprocessedText === '' && res.confidence === 0);
  ok('  returned well before the 30s timeout', ms < 20000, `${ms}ms`);
}

// A bill whose stored file has vanished fails safely.
{
  const fileName = `bill_h2gone_${crypto.randomUUID()}.png`;
  const bill = await makeBillDoc(fileName, { size: 1, sha256: 'y'.repeat(64) });
  let threw = null;
  try { await runBillOcr(bill.id); } catch (e) { threw = e.code; }
  ok('missing stored file raises BILL_FILE_MISSING', threw === 'BILL_FILE_MISSING', String(threw));
  const after = await getInventoryBillByIdFirestore(bill.id);
  ok('  bill moved to EXTRACTION_FAILED, not left EXTRACTING', after.status === BILL_STATUS.EXTRACTION_FAILED, after.status);
}

console.log('\n═══ LIFECYCLE AND CAPS ═══\n');

// 4. The 20,000-character cap, enforced at the repository write.
{
  const fileName = `bill_h2cap_${crypto.randomUUID()}.png`;
  const file = await makePrintedBill(fileName);
  const bill = await makeBillDoc(fileName, file);
  const huge = 'A'.repeat(BILL_OCR_TEXT_MAX + 5000);
  const after = await updateInventoryBillFirestore(bill.id, { ocr_raw_text: huge });
  ok('ocr_raw_text capped at 20,000 characters', after.ocr_raw_text.length === BILL_OCR_TEXT_MAX,
    `${huge.length} → ${after.ocr_raw_text.length}`);
}

// A stranded EXTRACTING bill can be re-extracted (the manual reaper path).
{
  const fileName = `bill_h2stuck_${crypto.randomUUID()}.png`;
  const file = await makePrintedBill(fileName);
  const bill = await makeBillDoc(fileName, file);
  await updateInventoryBillFirestore(bill.id, { status: BILL_STATUS.EXTRACTING });
  ok('EXTRACTING is a startable status', OCR_STARTABLE_STATUSES.includes(BILL_STATUS.EXTRACTING));
  const { outcome } = await runBillOcr(bill.id);
  ok('  a stranded EXTRACTING bill can be re-extracted', outcome === BILL_STATUS.EXTRACTED, outcome);
}

// A CONFIRMED bill's extraction is part of the receipt record and is frozen.
{
  const fileName = `bill_h2conf_${crypto.randomUUID()}.png`;
  const file = await makePrintedBill(fileName);
  const bill = await makeBillDoc(fileName, file);
  await updateInventoryBillFirestore(bill.id, { status: BILL_STATUS.CONFIRMED, receipt_id: 'gr_fake_h2' });
  let threw = null;
  try { await runBillOcr(bill.id); } catch (e) { threw = e.code; }
  ok('CONFIRMED bill cannot be re-extracted', threw === 'BILL_NOT_EXTRACTABLE', String(threw));
  const after = await getInventoryBillByIdFirestore(bill.id);
  ok('  confirmed bill unchanged', after.status === BILL_STATUS.CONFIRMED);
}

console.log('\n═══ STOCK NEUTRALITY ═══\n');

// 9–11. The core H2 invariant.
{
  const movAfter = await countOf(db.collection('inventory_stock_movements'));
  const grAfter = await countOf(db.collection('goods_receipts'));
  ok('OCR created NO stock movement', movAfter === movBefore, `${movBefore} → ${movAfter}`);
  ok('OCR created NO goods receipt', grAfter === grBefore, `${grBefore} → ${grAfter}`);
  ok('OCR created NO direct receipt',
    (await countOf(db.collection('goods_receipts').where('receipt_kind', '==', 'DIRECT'))) === 0);
  ok('OCR created NO purchase order',
    (await countOf(db.collection('purchase_orders').where('supplier_id', '==', 'h2test_uid'))) === 0);

  // Static proof, not just runtime counting: the service imports nothing stock-related.
  const src = fs.readFileSync(path.join(BACKEND, 'services', 'billOcrService.js'), 'utf8');
  ok('billOcrService imports no stock/receipt/PO module',
    !/inventoryStockService|goodsReceiptService|purchaseOrderService|receiptCorrectionService|stageMovement/.test(src));
  ok('billOcrService writes no product or supplier fields',
    !/matched_product_id|resolved_quantity|resolved_unit|po_item_id/.test(src));
}

// ── Cleanup, scoped strictly to what this run created ───────────────────────
for (const id of createdBills) {
  try { await db.collection(BILLS_COLLECTION).doc(id).delete(); } catch { /* ignore */ }
}
for (const p of createdFiles) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  try { const q = p.replace(/(\.\w+)$/, '_prep$1'); if (fs.existsSync(q)) fs.unlinkSync(q); } catch { /* ignore */ }
}
console.log(`\n  cleaned ${createdBills.length} bill document(s) and ${createdFiles.length} file(s)`);

console.log(`\n═══ H2 RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
