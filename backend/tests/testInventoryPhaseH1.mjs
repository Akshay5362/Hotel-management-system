/**
 * testInventoryPhaseH1.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Focused Phase H1 tests: secure supplier-bill upload and storage.
 *
 * PART A runs entirely offline — no Firestore, no network, no Firebase import.
 *        It exercises the security surface of billUploadMiddleware directly.
 * PART B touches DEV Firestore (sky5-development ONLY) behind the same
 *        four-layer fail-closed guard used by the Inventory A–G suites.
 *
 * This suite creates NO stock movements, NO goods receipts and NO direct
 * receipts, and asserts that fact explicitly at the end.
 *
 * Run:  HPMS_ENV=development node backend/tests/testInventoryPhaseH1.mjs
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';

const BACKEND = path.join(process.cwd(), 'backend');
const require_ = createRequire(path.join(BACKEND, 'package.json'));

// ── Guard 1 — explicit development intent ───────────────────────────────────
if (process.env.HPMS_ENV !== 'development') {
  console.error(`[SAFETY_ABORT] HPMS_ENV must be "development" (got ${JSON.stringify(process.env.HPMS_ENV)}).`);
  process.exit(1);
}
// ── Guard 2 — development env file ONLY ─────────────────────────────────────
require_('dotenv').config({ path: path.join(BACKEND, '.env.development') });
// ── Guard 3 — the resolved project must be the development one ──────────────
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (PROJECT !== 'sky5-development') {
  console.error(`[SAFETY_ABORT] project is "${PROJECT}", expected sky5-development.`);
  process.exit(1);
}
// ── Guard 4 — never a project that looks like production ────────────────────
if (/hpms/i.test(String(PROJECT))) {
  console.error('[SAFETY_ABORT] project id contains "hpms".');
  process.exit(1);
}
console.log(`[GUARD] project=${PROJECT} (DEV)\n`);

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? '  ' + detail : ''}`); }
};

// Firebase Admin must be imported AFTER the guard, so the guard cannot be
// bypassed by module hoisting.
const mw = await import('../middleware/billUploadMiddleware.js');
const {
  verifyUploadedBill, resolveBillPath, removeBillFile,
  inventoryBillsDir, MAX_BILL_BYTES, MAX_BILL_DIMENSION, MAX_BILL_PIXELS
} = mw;

const TMP = path.join(inventoryBillsDir, '__h1tests');
fs.mkdirSync(TMP, { recursive: true });
const madeFiles = [];
const tmpFile = (name, buf) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, buf);
  madeFiles.push(p);
  return p;
};

/** Minimal express-ish req/res doubles for middleware testing. */
function fakeRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const runMw = async (file) => {
  const req = { file };
  const res = fakeRes();
  let nexted = false;
  await verifyUploadedBill(req, res, () => { nexted = true; });
  return { req, res, nexted };
};

// Real encoded images, so sharp can genuinely read their dimensions.
const sharp = require_('sharp');
const makeImage = async (fmt, w, h) => {
  const img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 200, b: 200 } } });
  if (fmt === 'jpeg') return await img.jpeg().toBuffer();
  if (fmt === 'png') return await img.png().toBuffer();
  return await img.webp().toBuffer();
};

console.log('═══ PART A — upload security (offline, no Firestore) ═══\n');

// 1–3. Valid JPEG / PNG / WebP are accepted and get the correct extension.
for (const [fmt, mime, ext] of [['jpeg', 'image/jpeg', '.jpg'], ['png', 'image/png', '.png'], ['webp', 'image/webp', '.webp']]) {
  const buf = await makeImage(fmt, 120, 80);
  const p = tmpFile(`good_${fmt}.part`, buf);
  const { req, res, nexted } = await runMw({ path: p, mimetype: mime, originalname: `bill.${fmt}` });
  ok(`valid ${fmt.toUpperCase()} accepted`, nexted && res.statusCode === 200, nexted ? `→ ${req.billFile?.fileName}` : `HTTP ${res.statusCode}`);
  ok(`  ${fmt.toUpperCase()} extension derived from verified bytes`, req.billFile?.ext === ext, `got ${req.billFile?.ext}`);
  ok(`  ${fmt.toUpperCase()} sha256 recorded`, /^[0-9a-f]{64}$/.test(req.billFile?.sha256 || ''));
  ok(`  ${fmt.toUpperCase()} dimensions recorded`, req.billFile?.width === 120 && req.billFile?.height === 80,
    `${req.billFile?.width}x${req.billFile?.height}`);
  if (req.billFile) madeFiles.push(req.billFile.filePath);
}

// 4. Renamed executable — declares image/jpeg, is actually a PE binary.
{
  const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(512)]);
  const p = tmpFile('evil.part', exe);
  const { res, nexted } = await runMw({ path: p, mimetype: 'image/jpeg', originalname: 'invoice.jpg' });
  ok('renamed executable rejected', !nexted && res.statusCode === 400 && res.body?.code === 'INVALID_FILE_SIGNATURE', res.body?.code);
  ok('  rejected executable was deleted from disk', !fs.existsSync(p));
}

// 5. Invalid magic bytes — plain text claiming to be a PNG.
{
  const p = tmpFile('notanimage.part', Buffer.from('this is definitely not an image at all'));
  const { res, nexted } = await runMw({ path: p, mimetype: 'image/png', originalname: 'bill.png' });
  ok('invalid magic bytes rejected', !nexted && res.body?.code === 'INVALID_FILE_SIGNATURE', res.body?.code);
  ok('  rejected file was deleted from disk', !fs.existsSync(p));
}

// 6. MIME spoofing — a real PNG declared as JPEG.
{
  const buf = await makeImage('png', 60, 60);
  const p = tmpFile('spoof.part', buf);
  const { res, nexted } = await runMw({ path: p, mimetype: 'image/jpeg', originalname: 'bill.jpg' });
  ok('MIME spoof (real PNG declared JPEG) rejected', !nexted && res.body?.code === 'MIME_TYPE_MISMATCH', res.body?.code);
  ok('  spoofed file was deleted from disk', !fs.existsSync(p));
}

// 7. Absurd dimensions — exceeds the per-side ceiling.
{
  const buf = await makeImage('png', MAX_BILL_DIMENSION + 200, 10);
  const p = tmpFile('wide.part', buf);
  const { res, nexted } = await runMw({ path: p, mimetype: 'image/png', originalname: 'wide.png' });
  ok('over-wide image rejected', !nexted && res.body?.code === 'IMAGE_DIMENSIONS_TOO_LARGE', res.body?.code);
  ok('  over-wide file was deleted from disk', !fs.existsSync(p));
}

// 8. Megapixel ceiling, while staying under the per-side limit.
{
  const side = 8000; // 64 MP > 50 MP, and 8000 < 12000
  ok('megapixel test case is meaningful',
    side <= MAX_BILL_DIMENSION && side * side > MAX_BILL_PIXELS, `${side}x${side} = ${side * side}px`);
  const buf = await makeImage('png', side, side);
  const p = tmpFile('bomb.part', buf);
  const { res, nexted } = await runMw({ path: p, mimetype: 'image/png', originalname: 'bomb.png' });
  ok('decompression-bomb dimensions rejected', !nexted && res.body?.code === 'IMAGE_PIXELS_TOO_LARGE', res.body?.code);
  ok('  bomb file was deleted from disk', !fs.existsSync(p));
}

// 9. Missing file.
{
  const res = fakeRes();
  let nexted = false;
  await verifyUploadedBill({}, res, () => { nexted = true; });
  ok('missing upload rejected', !nexted && res.body?.code === 'BILL_FILE_REQUIRED', res.body?.code);
}

// 10. Path traversal containment.
for (const evil of ['../../.env', '..\\..\\.env', '/etc/passwd', 'sub/dir/x.jpg', '', null]) {
  ok(`path traversal blocked: ${JSON.stringify(evil)}`, resolveBillPath(evil) === null);
}
ok('legitimate basename resolves inside the bills directory',
  (resolveBillPath('bill_abc.jpg') || '').startsWith(path.resolve(inventoryBillsDir)));

// 11. removeBillFile refuses to escape the directory.
{
  const outside = path.join(inventoryBillsDir, '..', '__h1_should_not_be_deleted.txt');
  fs.writeFileSync(outside, 'keep me');
  const removed = await removeBillFile('../__h1_should_not_be_deleted.txt');
  ok('removeBillFile refuses to delete outside the directory', removed === false && fs.existsSync(outside));
  fs.unlinkSync(outside);
}

// 12. Size ceiling is the documented one (multer enforces it before this point).
ok('upload size ceiling is 10 MB', MAX_BILL_BYTES === 10 * 1024 * 1024, `${MAX_BILL_BYTES} bytes`);

console.log('\n═══ PART B — repository against DEV Firestore ═══\n');

const repo = await import('../repositories/firestore/inventoryBillsRepository.js');
const { db } = await import('../config/firebaseAdmin.js');
const {
  createInventoryBillFirestore, getInventoryBillByIdFirestore,
  listInventoryBillsFirestore, findInventoryBillsByHashFirestore,
  discardInventoryBillFirestore, updateInventoryBillFirestore,
  BILLS_COLLECTION
} = repo;
const { BILL_STATUS } = await import('../utils/inventoryConstants.js');

const countOf = async (q) => (await q.count().get()).data().count;
const movementsBefore = await countOf(db.collection('inventory_stock_movements'));
const receiptsBefore  = await countOf(db.collection('goods_receipts'));
console.log(`  baseline: ${movementsBefore} stock movements, ${receiptsBefore} goods receipts\n`);

const TEST_PREFIX = 'h1test';
const createdBills = [];
const mkBill = async (suffix, extra = {}) => {
  const id = `bill_${TEST_PREFIX}${suffix}${Date.now().toString(36)}`;
  const bill = await createInventoryBillFirestore(id, {
    file: {
      fileName: `bill_${TEST_PREFIX}${suffix}.jpg`,
      sha256: crypto.createHash('sha256').update(`${TEST_PREFIX}${suffix}`).digest('hex'),
      size: 1234, mimeType: 'image/jpeg', width: 100, height: 200
    },
    actor: { uid: `${TEST_PREFIX}_uid`, name: 'H1 Test' },
    business_date: '2026-09-10',
    ...extra
  });
  createdBills.push(bill.id);
  return bill;
};

// 13. Create and read back.
const b1 = await mkBill('_a');
ok('bill created with status UPLOADED', b1.status === BILL_STATUS.UPLOADED, b1.status);
ok('  no receipt linked on creation', b1.receipt_id === null);
ok('  no stock fields exist on a bill', !('current_stock' in b1) && !('stock_by_location' in b1));
const fetched = await getInventoryBillByIdFirestore(b1.id);
ok('bill reads back by id', fetched?.id === b1.id);
ok('  stored file name is a basename only', !String(fetched.file_name).includes('/') && !String(fetched.file_name).includes('\\'));

// 14. Hash lookup (the H7 signal, persisted in H1).
const byHash = await findInventoryBillsByHashFirestore(b1.file_sha256);
ok('bill is findable by file hash', byHash.some(b => b.id === b1.id), `${byHash.length} match(es)`);

// 15. Listing. Requires the composite index declared in firestore.indexes.json,
//     which H1 deliberately does NOT deploy. A FAILED_PRECONDITION here is the
//     expected result until that index is deployed, and it positively confirms
//     the index declaration is genuinely required rather than speculative.
let indexPending = false;
try {
  const listed = await listInventoryBillsFirestore({ status: BILL_STATUS.UPLOADED, limit: 50 });
  ok('bill appears in the UPLOADED work queue', listed.some(b => b.id === b1.id), `${listed.length} listed`);
} catch (e) {
  if (e.code === 9 || /requires an index/i.test(e.message || '')) {
    indexPending = true;
    console.log('  [PEND] status work queue awaits the declared composite index (not deployed by H1) — expected');
  } else {
    ok('bill appears in the UPLOADED work queue', false, e.message);
  }
}

// 16. Discard of an unconfirmed bill.
const discarded = await discardInventoryBillFirestore(b1.id, { uid: `${TEST_PREFIX}_uid`, name: 'H1 Test' });
ok('unconfirmed bill can be discarded', discarded.status === BILL_STATUS.DISCARDED, discarded.status);
ok('  discard reports the file as removable', discarded.file_removable === true);
ok('  discard records who and when', !!discarded.discarded_by_uid && !!discarded.discarded_at);

// 17. A CONFIRMED bill can never be discarded (immutability).
const b2 = await mkBill('_b');
await updateInventoryBillFirestore(b2.id, { status: BILL_STATUS.CONFIRMED, receipt_id: 'gr_fake_for_test' });
let immutabilityHeld = false, immErr = null;
try {
  await discardInventoryBillFirestore(b2.id, { uid: 'x', name: 'x' });
} catch (e) { immutabilityHeld = true; immErr = e.code || e.message; }
ok('CONFIRMED bill cannot be discarded', immutabilityHeld, immErr || '');
const stillThere = await getInventoryBillByIdFirestore(b2.id);
ok('  confirmed bill remains CONFIRMED after the refused discard', stillThere.status === BILL_STATUS.CONFIRMED);

// 18. Unknown status is rejected.
let badStatusRejected = false;
try { await updateInventoryBillFirestore(b2.id, { status: 'NONSENSE' }); }
catch { badStatusRejected = true; }
ok('unknown bill status rejected on patch', badStatusRejected);

// 19. Immutable identity fields cannot be patched.
await updateInventoryBillFirestore(b2.id, { file_name: 'hijacked.jpg', file_sha256: 'deadbeef', created_at: '1999-01-01' });
const afterPatch = await getInventoryBillByIdFirestore(b2.id);
ok('file identity is not patchable', afterPatch.file_name === b2.file_name && afterPatch.file_sha256 === b2.file_sha256);
ok('created_at is not patchable', afterPatch.created_at === b2.created_at);

// 20. THE CORE ASSERTION — H1 is stock-neutral.
const movementsAfter = await countOf(db.collection('inventory_stock_movements'));
const receiptsAfter  = await countOf(db.collection('goods_receipts'));
ok('NO stock movement was created by H1', movementsAfter === movementsBefore, `${movementsBefore} → ${movementsAfter}`);
ok('NO goods receipt was created by H1', receiptsAfter === receiptsBefore, `${receiptsBefore} → ${receiptsAfter}`);
ok('NO direct receipt exists (receipt_kind DIRECT)',
  (await countOf(db.collection('goods_receipts').where('receipt_kind', '==', 'DIRECT'))) === 0);

// ── Cleanup — scoped strictly to documents this run created ─────────────────
for (const id of createdBills) {
  try { await db.collection(BILLS_COLLECTION).doc(id).delete(); } catch { /* ignore */ }
}
for (const p of madeFiles) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ } }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n  cleaned up ${createdBills.length} test bill document(s) and ${madeFiles.length} temp file(s)`);

if (indexPending) {
  console.log('\n  NOTE: 1 check pending — the inventory_bills composite index is declared');
  console.log('        in firestore.indexes.json but not deployed, per H1 scope.');
}
console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed${indexPending ? ', 1 pending index deployment' : ''} ═══`);
process.exit(fail === 0 ? 0 : 1);
