/**
 * inventoryBillsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore access for `inventory_bills` and `inventory_bill_lines` (Phase H1).
 *
 * Document id: bill_<uuid-without-dashes>   e.g. bill_9f2c41ab...
 * Line id:     <bill_id>_<line_no padded>   e.g. bill_9f2c41ab_0001
 *
 * Line storage follows the existing inventory convention: a SEPARATE top-level
 * collection with a composite document id, exactly as `goods_receipt_items`,
 * `purchase_order_items` and `purchase_request_items` do — not a Firestore
 * sub-collection. Keeping the shape identical means the existing query,
 * pagination and cleanup patterns apply unchanged.
 *
 * H1 SCOPE: this repository stores and retrieves the bill envelope and its
 * stored-file metadata. It performs NO stock work, creates NO receipts and
 * writes NO lines — line writing is declared here so H3 has a stable surface,
 * but nothing in H1 calls it.
 *
 * Every write goes through the Admin SDK from the backend. Firestore rules deny
 * all client writes to both collections.
 */

import { getDoc, listDocs, setDoc, updateDoc, RepositoryError, buildStatusFilter } from './firestoreUtils.js';
import { db } from '../../config/firebaseAdmin.js';
import { FieldPath } from 'firebase-admin/firestore';
import {
  BILL_STATUS,
  ALL_BILL_STATUSES,
  BILL_DISCARDABLE_STATUSES,
  BILL_OCR_TEXT_MAX
} from '../../utils/inventoryConstants.js';

export const BILLS_COLLECTION = 'inventory_bills';
export const BILL_LINES_COLLECTION = 'inventory_bill_lines';

// ── Id helpers ───────────────────────────────────────────────────────────────

export function formatBillDocId(val) {
  const s = String(val || '').trim();
  if (!s) throw new RepositoryError('A bill id is required', 'VALIDATION_ERROR', 400);
  return s.startsWith('bill_') ? s : `bill_${s.replace(/[^a-zA-Z0-9]/g, '')}`;
}

export function formatBillLineDocId(billId, lineNo) {
  const n = Number(lineNo);
  if (!Number.isInteger(n) || n < 1) {
    throw new RepositoryError('A bill line number must be a positive integer', 'VALIDATION_ERROR', 400);
  }
  return `${formatBillDocId(billId)}_${String(n).padStart(4, '0')}`;
}

export function billRef(billId) {
  return db.collection(BILLS_COLLECTION).doc(formatBillDocId(billId));
}

export function billLineRef(billId, lineNo) {
  return db.collection(BILL_LINES_COLLECTION).doc(formatBillLineDocId(billId, lineNo));
}

// ── Normalisation ────────────────────────────────────────────────────────────

function cleanString(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * Builds the stored bill document. Only fields H1 can legitimately know are
 * populated; every downstream field is written as null so the document shape is
 * stable from the first write and later phases only ever patch.
 */
function buildBillDoc(data, now) {
  const file = data.file || {};
  if (!file.fileName) throw new RepositoryError('A stored file name is required', 'VALIDATION_ERROR', 400);
  if (!file.sha256) throw new RepositoryError('A file content hash is required', 'VALIDATION_ERROR', 400);

  return {
    status: BILL_STATUS.UPLOADED,
    mode: null,                          // H4 — PO | DIRECT

    // Supplier / invoice header — H3 extracts, H4 confirms.
    supplier_id: null,
    supplier_name_raw: null,
    supplier_confidence: null,
    invoice_number: null,
    invoice_date: null,

    // Workflow linkage — H5 / H6.
    po_id: null,
    receipt_id: null,
    location_id: null,

    // Stored file. `file_name` is a basename only; the absolute path is never
    // persisted so a moved storage directory cannot break retrieval.
    file_name: file.fileName,
    file_sha256: file.sha256,
    file_size: Number(file.size) || 0,
    mime_type: file.mimeType,
    image_width: Number(file.width) || null,
    image_height: Number(file.height) || null,

    // OCR — H2.
    ocr_engine: null,
    ocr_confidence: null,
    ocr_raw_text: null,
    ocr_completed_at: null,

    // Actors and dates.
    uploaded_by_uid: data.actor?.uid || null,
    uploaded_by_name: data.actor?.name || null,
    confirmed_by_uid: null,
    confirmed_by_name: null,
    confirmed_at: null,
    discarded_by_uid: null,
    discarded_by_name: null,
    discarded_at: null,

    business_date: cleanString(data.business_date, 10),
    created_at: now,
    updated_at: now
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getInventoryBillByIdFirestore(billId, options = {}) {
  if (!billId) return null;
  return await getDoc(BILLS_COLLECTION, formatBillDocId(billId), options);
}

/**
 * Paged bill list, newest first. `status` may be a single status string or a
 * list of them, in which case one `in` query replaces several `==` queries.
 * Deliberately not cached: a bill's status changes throughout its short life
 * and a stale work queue would be worse than an extra read.
 */
export async function listInventoryBillsFirestore(query = {}, options = {}) {
  const { status = null, supplier_id = null, limit = 25, startAfterDoc = null } = query;
  const filters = [];
  if (status) {
    const wanted = Array.isArray(status) ? status : [status];
    for (const s of wanted) {
      if (!ALL_BILL_STATUSES.includes(s)) {
        throw new RepositoryError(`Unknown bill status '${s}'`, 'VALIDATION_ERROR', 400);
      }
    }
    const statusFilter = buildStatusFilter(wanted);
    if (statusFilter) filters.push(statusFilter);
  }
  if (supplier_id) filters.push({ field: 'supplier_id', op: '==', value: String(supplier_id) });

  return await listDocs(BILLS_COLLECTION, {
    filters,
    orderBy: [{ field: 'created_at', direction: 'desc' }],
    limit,
    startAfterDoc,
    transaction: options.transaction || null
  });
}

/**
 * Bills sharing a file content hash. The identical photograph uploaded twice is
 * a near-certain duplicate; H7 decides what to do about it, H1 only records the
 * hash and exposes this lookup.
 */
export async function findInventoryBillsByHashFirestore(sha256, options = {}) {
  if (!sha256) return [];
  return await listDocs(BILLS_COLLECTION, {
    filters: [{ field: 'file_sha256', op: '==', value: String(sha256) }],
    limit: 10,
    transaction: options.transaction || null
  });
}

/**
 * H7 — bills carrying the same supplier invoice reference.
 *
 * Deliberately EQUALITY-ONLY and deliberately without an orderBy. Firestore
 * serves a query made up purely of equality filters from the automatic
 * single-field indexes, so duplicate detection can never be defeated by a
 * composite index that has not been deployed yet. The result set is a handful
 * of documents, so ordering happens in memory at the call site.
 *
 * `invoiceDate` is optional: omitting it widens the search to every bill with
 * this supplier and invoice number, which is how a reused number on a
 * different date is spotted.
 */
export async function findInventoryBillsByInvoiceFirestore(supplierId, invoiceNumber, invoiceDate = null, options = {}) {
  if (!supplierId || !invoiceNumber) return [];
  const filters = [
    { field: 'supplier_id', op: '==', value: String(supplierId) },
    { field: 'invoice_number', op: '==', value: String(invoiceNumber) }
  ];
  if (invoiceDate) filters.push({ field: 'invoice_date', op: '==', value: String(invoiceDate) });
  return await listDocs(BILLS_COLLECTION, {
    filters,
    limit: 25,
    transaction: options.transaction || null
  });
}

export async function getInventoryBillLinesFirestore(billId, options = {}) {
  if (!billId) return [];
  const prefix = formatBillDocId(billId);

  // Selected by DOCUMENT ID range, matching deleteInventoryBillLinesFirestore
  // below and for the same reason. The previous form filtered on `bill_id` and
  // ordered by `line_no`, which is an equality plus an order on a different
  // field and therefore needs a composite index. That index is declared but not
  // deployed, so reading a bill's lines failed outright in an environment where
  // the build had not run — and the confirmation service treated that failure as
  // "this bill has no unresolved exceptions", opening a safety gate that should
  // have stayed shut.
  //
  // Line ids are `<bill_id>_<0001>` with the number zero-padded to a fixed
  // width, so ordering by document id gives exactly line-number order while
  // using only the automatic single-field index.
  const snap = await db.collection(BILL_LINES_COLLECTION)
    .orderBy(FieldPath.documentId())
    .startAt(`${prefix}_`)
    .endAt(`${prefix}_`)
    .limit(500)
    .get();
  if (options.transaction) {
    // Kept for signature compatibility; a range read inside a transaction is
    // not used by any caller and would change the transaction's read set.
  }
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Writes (Admin SDK only; client writes are denied by rules) ───────────────

export async function createInventoryBillFirestore(billId, data, options = {}) {
  const docId = formatBillDocId(billId);
  const now = new Date().toISOString();
  const payload = buildBillDoc(data, now);
  await setDoc(BILLS_COLLECTION, docId, payload, options);
  return { id: docId, ...payload };
}

/**
 * Patches a bill. Only whitelisted fields may be written, so a later phase
 * cannot accidentally rewrite the stored-file identity or the created_at stamp.
 */
const PATCHABLE_FIELDS = Object.freeze([
  'status', 'mode',
  'supplier_id', 'supplier_name_raw', 'supplier_confidence',
  'invoice_number', 'invoice_date',
  'po_id', 'receipt_id', 'location_id',
  'ocr_engine', 'ocr_confidence', 'ocr_raw_text', 'ocr_completed_at',
  'confirmed_by_uid', 'confirmed_by_name', 'confirmed_at',
  'discarded_by_uid', 'discarded_by_name', 'discarded_at',
  // H5 crash recovery. `confirmation_claim` holds the outstanding claim (or
  // null once settled); `released_claims` remembers the receipt ids of claims
  // that were released, so a receipt that commits after a release is still
  // found rather than duplicated.
  'confirmation_claim', 'released_claims'
]);

export async function updateInventoryBillFirestore(billId, patch = {}, options = {}) {
  const docId = formatBillDocId(billId);
  const payload = {};
  for (const key of PATCHABLE_FIELDS) {
    if (patch[key] !== undefined) payload[key] = patch[key];
  }
  if (payload.status !== undefined && !ALL_BILL_STATUSES.includes(payload.status)) {
    throw new RepositoryError(`Unknown bill status '${payload.status}'`, 'VALIDATION_ERROR', 400);
  }
  if (typeof payload.ocr_raw_text === 'string') {
    payload.ocr_raw_text = payload.ocr_raw_text.slice(0, BILL_OCR_TEXT_MAX);
  }
  if (Object.keys(payload).length === 0) {
    return await getInventoryBillByIdFirestore(docId, options);
  }
  payload.updated_at = new Date().toISOString();
  await updateDoc(BILLS_COLLECTION, docId, payload, options);
  return await getInventoryBillByIdFirestore(docId, options);
}

/**
 * Marks a bill discarded. Refuses once a receipt exists — a confirmed bill is
 * the evidence behind a stock movement and must remain intact, mirroring the
 * receipt immutability rule in Phase G.
 *
 * Returns the updated bill. The caller removes the stored file only when
 * `file_removable` is true.
 */
export async function discardInventoryBillFirestore(billId, actor = {}, options = {}) {
  const docId = formatBillDocId(billId);
  const existing = await getInventoryBillByIdFirestore(docId, options);
  if (!existing) throw new RepositoryError('Bill not found.', 'BILL_NOT_FOUND', 404);

  if (existing.status === BILL_STATUS.CONFIRMED || existing.receipt_id) {
    throw new RepositoryError(
      'This bill has been confirmed into a goods receipt and can no longer be discarded.',
      'BILL_ALREADY_CONFIRMED',
      409
    );
  }
  if (!BILL_DISCARDABLE_STATUSES.includes(existing.status)) {
    throw new RepositoryError(
      `A bill with status '${existing.status}' cannot be discarded.`,
      'BILL_NOT_DISCARDABLE',
      409
    );
  }
  if (existing.status === BILL_STATUS.DISCARDED) {
    return { ...existing, file_removable: false };  // idempotent repeat
  }

  const now = new Date().toISOString();
  await updateDoc(BILLS_COLLECTION, docId, {
    status: BILL_STATUS.DISCARDED,
    discarded_by_uid: actor.uid || null,
    discarded_by_name: actor.name || null,
    discarded_at: now,
    updated_at: now
  }, options);

  // Phase H3 — a discarded bill must not leave its parsed lines behind. Lines
  // are pure interpretation data: they hold no stock, no movement and no
  // receipt reference, so deleting them cannot affect the ledger. The bill
  // document itself is never hard-deleted; only its lines are.
  const linesRemoved = await deleteInventoryBillLinesFirestore(docId, options);

  const updated = await getInventoryBillByIdFirestore(docId, options);
  return { ...updated, file_removable: true, lines_removed: linesRemoved };
}

/**
 * Deletes every line belonging to one bill. Returns how many were removed.
 *
 * Batched in chunks well under Firestore's 500-write limit. Touches ONLY the
 * lines collection — no product, movement, receipt or order document is read
 * or written here.
 */
export async function deleteInventoryBillLinesFirestore(billId, options = {}) {
  const prefix = formatBillDocId(billId);

  // Selected by DOCUMENT ID range rather than by the bill_id field. Line ids are
  // `<bill_id>_<0001>`, so a range on __name__ selects exactly this bill's lines
  // using only the automatic single-field index. That matters: cleanup on
  // discard must never depend on a composite index being deployed, or a bill
  // could not be discarded until an index build finished.
  const snap = await db.collection(BILL_LINES_COLLECTION)
    .orderBy(FieldPath.documentId())
    .startAt(`${prefix}_`)
    .endAt(`${prefix}_`)
    .get();
  if (snap.empty) return 0;

  const docs = snap.docs;
  const CHUNK = 400;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + CHUNK)) batch.delete(d.ref);
    await batch.commit();
  }
  return docs.length;
}

/**
 * Replaces a bill's lines wholesale with a freshly interpreted set (H3).
 *
 * Delete-then-write rather than merge, so a re-parse can never leave a stale
 * line from a previous interpretation attached to the bill. Writes nothing
 * outside the lines collection.
 */
export async function replaceInventoryBillLinesFirestore(billId, lines = [], options = {}) {
  const billDocId = formatBillDocId(billId);
  await deleteInventoryBillLinesFirestore(billDocId, options);
  const written = [];
  for (let i = 0; i < lines.length; i++) {
    written.push(await setInventoryBillLineFirestore(billDocId, i + 1, lines[i], options));
  }
  return written;
}

/**
 * Declared for H3. Writes one parsed/reviewed line. Nothing in H1 calls this.
 */
export async function setInventoryBillLineFirestore(billId, lineNo, lineData = {}, options = {}) {
  const billDocId = formatBillDocId(billId);
  const docId = formatBillLineDocId(billDocId, lineNo);
  const now = new Date().toISOString();
  const payload = {
    bill_id: billDocId,
    line_no: Number(lineNo),
    raw_text: cleanString(lineData.raw_text, 500),
    raw_quantity: lineData.raw_quantity ?? null,
    raw_unit: cleanString(lineData.raw_unit, 40),
    raw_rate: lineData.raw_rate ?? null,
    raw_amount: lineData.raw_amount ?? null,
    // `matched_product_id` is the SELECTED product and is set only when the
    // match was HIGH (auto-select) or a human chose it. `suggested_product_id`
    // is what the matcher proposed at any confidence — keeping them separate is
    // what stops a MEDIUM/LOW suggestion from being mistaken for a selection.
    matched_product_id: lineData.matched_product_id || null,
    suggested_product_id: lineData.suggested_product_id || null,
    match_confidence: lineData.match_confidence || null,
    match_score: lineData.match_score ?? null,
    candidates: Array.isArray(lineData.candidates) ? lineData.candidates.slice(0, 5) : [],
    unit_reason: cleanString(lineData.unit_reason, 300),
    po_item_id: lineData.po_item_id || null,
    ordered_quantity: lineData.ordered_quantity ?? null,
    resolved_quantity: lineData.resolved_quantity ?? null,
    resolved_unit: cleanString(lineData.resolved_unit, 40),
    unit_exception: Boolean(lineData.unit_exception),
    excluded: Boolean(lineData.excluded),
    created_at: lineData.created_at || now,
    updated_at: now
  };
  await setDoc(BILL_LINES_COLLECTION, docId, payload, options);
  return { id: docId, ...payload };
}
