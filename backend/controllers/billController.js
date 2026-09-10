/**
 * billController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H1 — HTTP surface for supplier bill upload, retrieval and discard.
 *
 * H1 IS COMPLETELY STOCK-NEUTRAL. Nothing in this file creates a goods receipt,
 * a direct receipt or a stock movement, and nothing calls the inventory stock
 * services. OCR (H2), parsing and matching (H3), the review screen (H4) and
 * both confirmation paths (H5, H6) are deliberately absent.
 *
 * The stored file is never exposed through express.static: a supplier bill
 * carries purchase pricing, so retrieval is an authenticated, role-gated stream
 * with a containment check, following the guest-document pattern rather than
 * the product-photo pattern.
 */

import crypto from 'crypto';
import fs from 'fs';
import { getActor, sendError, auditInventory } from './inventoryController.js';
import {
  createInventoryBillFirestore,
  getInventoryBillByIdFirestore,
  listInventoryBillsFirestore,
  findInventoryBillsByHashFirestore,
  discardInventoryBillFirestore,
  formatBillDocId
} from '../repositories/firestore/inventoryBillsRepository.js';
import { resolveBillPath, removeBillFile } from '../middleware/billUploadMiddleware.js';
import { startBillOcrInBackground, runBillOcr } from '../services/billOcrService.js';
import { interpretStoredBill, getBillWithLines } from '../services/billInterpretService.js';
import { BillConfirmService } from '../services/billConfirmService.js';
import { DirectReceiptService } from '../services/directReceiptService.js';
import { resolveBusinessDate } from '../services/inventoryNumberService.js';
import { detectBillDuplicates } from '../services/billDuplicateService.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ALL_BILL_STATUSES } from '../utils/inventoryConstants.js';

/** Content types this phase can serve back, keyed by what was verified on upload. */
const SERVEABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * POST /api/inventory/bills
 * Multipart field: `bill`. Runs behind billUpload + verifyUploadedBill, so by
 * the time this executes the file is verified, hashed and safely named.
 */
export const uploadBill = async (req, res) => {
  const file = req.billFile;
  try {
    const actor = getActor(req);
    const billId = formatBillDocId(crypto.randomUUID().replace(/-/g, ''));
    const businessDate = await resolveBusinessDate(null);

    const bill = await createInventoryBillFirestore(billId, {
      file,
      actor,
      business_date: businessDate
    });

    // H7 — the full duplicate check runs here so the operator sees the signal at
    // the moment of upload. It is informational at this point: nothing is
    // blocked, because nothing has moved stock. The binding check is repeated at
    // confirmation, against the values the operator finally submits.
    const dup = await detectBillDuplicates(bill);
    const duplicateOf = (await findInventoryBillsByHashFirestore(file.sha256).catch(() => []))
      .filter(b => b.id !== bill.id)
      .map(b => ({ bill_id: b.id, status: b.status, created_at: b.created_at }));

    await auditInventory(req, 'INVENTORY_BILL_UPLOADED', {
      bill_id: bill.id,
      file_name: bill.file_name,
      file_size: bill.file_size,
      mime_type: bill.mime_type,
      file_sha256: bill.file_sha256,
      duplicate_candidates: duplicateOf.length,
      duplicate_warnings: dup.warnings.map(w => w.code)
    }, `bill_${bill.id}`, businessDate);

    // A raised signal is recorded as its own action. If a duplicate is later
    // overridden, the warning and the override are then two separate, ordered
    // records rather than one field that only shows the final outcome.
    if (dup.warnings.length) {
      await auditInventory(req, 'INVENTORY_BILL_DUPLICATE_WARNED', {
        bill_id: bill.id,
        stage: 'UPLOAD',
        codes: dup.warnings.map(w => w.code),
        matched_bill_ids: dup.warnings.flatMap(w => w.bill_ids || []).slice(0, 20),
        file_sha256: bill.file_sha256
      }, `bill_dupwarn_${bill.id}`, businessDate);
    }

    // H2 — extraction starts AFTER the response is prepared and never blocks it.
    // The bill is already durable at this point, so a crash mid-extraction loses
    // nothing but the text, which can be re-requested through POST /bills/:id/extract.
    startBillOcrInBackground(bill.id);

    return res.status(201).json({
      bill: { ...bill, id: bill.id },
      duplicate_candidates: duplicateOf,
      duplicate_warnings: dup.warnings,
      ocr: { started: true, status_endpoint: `/api/inventory/bills/${bill.id}` }
    });
  } catch (error) {
    // The document write failed, so the orphaned file must not be left behind.
    if (file?.fileName) await removeBillFile(file.fileName);
    return sendError(res, error, 'Failed to store the supplier bill');
  }
};

/** GET /api/inventory/bills — paged work queue, newest first. */
export const listBills = async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    if (status && !ALL_BILL_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Unknown bill status '${status}'.`, code: 'INVALID_BILL_STATUS' });
    }
    const limit = Math.min(Number(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const bills = await listInventoryBillsFirestore({
      status,
      supplier_id: req.query.supplier_id || null,
      limit
    });
    return res.json({ bills, count: bills.length });
  } catch (error) {
    return sendError(res, error, 'Failed to load supplier bills');
  }
};

/** GET /api/inventory/bills/:id — the document only, never the file bytes. */
export const getBill = async (req, res) => {
  try {
    const bill = await getInventoryBillByIdFirestore(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found.', code: 'BILL_NOT_FOUND' });
    return res.json({ bill });
  } catch (error) {
    return sendError(res, error, 'Failed to load the supplier bill');
  }
};

/**
 * GET /api/inventory/bills/:id/file — authenticated, role-gated stream.
 *
 * The filename is read from the stored document rather than from the request,
 * so a caller can never influence the path. resolveBillPath applies a second
 * containment check regardless.
 */
export const streamBillFile = async (req, res) => {
  try {
    const bill = await getInventoryBillByIdFirestore(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found.', code: 'BILL_NOT_FOUND' });

    const absolute = resolveBillPath(bill.file_name);
    if (!absolute) {
      console.warn(`[Bill] Blocked unsafe file reference on ${bill.id}: ${bill.file_name}`);
      return res.status(404).json({ error: 'Bill file not available.', code: 'BILL_FILE_UNAVAILABLE' });
    }
    if (!fs.existsSync(absolute)) {
      return res.status(404).json({ error: 'Bill file is no longer stored.', code: 'BILL_FILE_MISSING' });
    }

    const type = SERVEABLE_TYPES.has(bill.mime_type) ? bill.mime_type : 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `inline; filename="${bill.id}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return fs.createReadStream(absolute).pipe(res);
  } catch (error) {
    return sendError(res, error, 'Failed to stream the supplier bill');
  }
};

/**
 * POST /api/inventory/bills/:id/extract — re-run OCR for one bill.
 *
 * The minimum surface H2 needs beyond the upload trigger. It exists because
 * extraction is fire-and-forget: a server restart mid-extraction would strand a
 * bill in EXTRACTING, and H2 deliberately adds no background job system to reap
 * that. This endpoint is the manual reaper, and it is also how an operator
 * retries a bill that extracted poorly.
 *
 * Runs synchronously and returns the outcome, because the caller asked for it
 * and is willing to wait up to the OCR timeout.
 */
export const extractBill = async (req, res) => {
  try {
    const { bill, outcome, reason } = await runBillOcr(req.params.id);
    await auditInventory(req, 'INVENTORY_BILL_OCR_COMPLETED', {
      bill_id: bill.id,
      outcome,
      ocr_confidence: bill.ocr_confidence,
      ocr_text_length: bill.ocr_raw_text ? bill.ocr_raw_text.length : 0,
      reason: reason || null
    }, `bill_ocr_${bill.id}_${Date.now()}`);
    return res.json({ bill, outcome, reason: reason || null });
  } catch (error) {
    return sendError(res, error, 'Failed to extract the supplier bill');
  }
};

/**
 * POST /api/inventory/bills/:id/interpret — H3 parsing and matching.
 *
 * Reads the stored OCR text, proposes header fields and lines, and replaces
 * the bill's lines with the proposal. Moves the bill to IN_REVIEW.
 *
 * STOCK-NEUTRAL. Only HIGH-confidence matches are written as selections;
 * every quantity stays unresolved until a human confirms it in the review
 * screen. Nothing here creates a product, a supplier or a receipt.
 */
export const interpretBill = async (req, res) => {
  try {
    const result = await interpretStoredBill(req.params.id);
    await auditInventory(req, 'INVENTORY_BILL_INTERPRETED', {
      bill_id: result.bill.id,
      ...result.stats
    }, `bill_interpret_${result.bill.id}_${Date.now()}`);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Failed to interpret the supplier bill');
  }
};

/** GET /api/inventory/bills/:id/lines — the bill plus its parsed lines. */
export const getBillLines = async (req, res) => {
  try {
    const { bill, lines } = await getBillWithLines(req.params.id);
    return res.json({ bill, lines });
  } catch (error) {
    return sendError(res, error, 'Failed to load the bill lines');
  }
};

/**
 * DELETE /api/inventory/bills/:id — discard an UNCONFIRMED bill.
 *
 * A confirmed bill is the evidence behind a stock movement. The repository
 * refuses to discard one, and the stored file is removed only when it says the
 * file is removable, so the immutability rule lives in one place.
 */
export const discardBill = async (req, res) => {
  try {
    const actor = getActor(req);
    const result = await discardInventoryBillFirestore(req.params.id, actor);

    let fileRemoved = false;
    if (result.file_removable) {
      fileRemoved = await removeBillFile(result.file_name);
    }

    await auditInventory(req, 'INVENTORY_BILL_DISCARDED', {
      bill_id: result.id,
      previous_status: result.status,
      file_removed: fileRemoved
    }, `bill_discard_${result.id}`);

    const { file_removable, ...bill } = result;
    return res.json({ success: true, bill, file_removed: fileRemoved });
  } catch (error) {
    return sendError(res, error, 'Failed to discard the supplier bill');
  }
};

/**
 * GET /api/inventory/bills/:id/duplicates
 *
 * H7 — the duplicate signals for a bill, evaluated against either its stored
 * values or the ones supplied as query parameters. Read-only, so the review
 * screen can show what will have to be acknowledged BEFORE the operator commits
 * to receiving. Confirmation re-runs this check itself and never trusts that
 * this endpoint was called.
 */
export const getBillDuplicates = async (req, res) => {
  try {
    const bill = await getInventoryBillByIdFirestore(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found.', code: 'BILL_NOT_FOUND' });
    const result = await detectBillDuplicates(bill, {
      supplier_id: req.query.supplier_id,
      invoice_number: req.query.invoice_number,
      invoice_date: req.query.invoice_date
    });
    return res.json({
      bill_id: bill.id,
      checked: result.checked,
      identity: result.identity,
      warnings: result.warnings,
      requires_acknowledgement: result.warnings.map(w => w.code)
    });
  } catch (error) {
    return sendError(res, error, 'Failed to check the bill for duplicates');
  }
};

/**
 * H7 — a refused confirmation is recorded.
 *
 * A rejected attempt to move stock is exactly the event an audit trail exists
 * for. Only genuine refusals are stored: a 5xx is a fault in the system rather
 * than a decision about the bill, and storing those would bury the refusals.
 * The audit id carries a timestamp because repeated attempts are the signal.
 */
async function auditConfirmationFailure(req, mode, error) {
  const status = error?.status || 500;
  if (status >= 500) return;
  await auditInventory(req, 'INVENTORY_BILL_CONFIRMATION_REFUSED', {
    bill_id: req.params.id,
    mode,
    code: error?.code || null,
    reason: String(error?.message || '').slice(0, 300),
    required_acknowledgements: error?.required_acknowledgements || null,
    po_id: req.body?.po_id || null
  }, `bill_confail_${req.params.id}_${Date.now()}`);
}

// ── Phase H5 / H6 — confirmation. The ONLY stock-affecting endpoints here. ────

/**
 * POST /api/inventory/bills/:id/confirm-po
 *
 * Confirms a reviewed bill against an existing purchase order. Stock is posted
 * by the UNCHANGED Phase F engine; this controller only carries the request.
 */
export const confirmBillAgainstPO = async (req, res) => {
  try {
    const b = req.body || {};
    const result = await BillConfirmService.confirmAgainstPurchaseOrder(req.params.id, {
      idempotency_key: b.idempotency_key,
      po_id: b.po_id,
      lines: b.lines,
      remarks: b.remarks,
      duplicate_ack: b.duplicate_ack
    }, getActor(req));
    return res.status(result.duplicate ? 200 : 201).json({
      duplicate: Boolean(result.duplicate),
      receipt: result.receipt,
      order: result.order,
      bill: result.bill
    });
  } catch (error) {
    await auditConfirmationFailure(req, 'PO', error);
    return sendError(res, error, 'Failed to confirm the bill against the purchase order');
  }
};

/**
 * POST /api/inventory/bills/:id/confirm-direct
 *
 * Confirms a reviewed bill as a PO-less direct receipt. Stock is posted through
 * the same shared ledger core Phases A–G use.
 */
export const confirmBillDirect = async (req, res) => {
  try {
    const b = req.body || {};
    const result = await DirectReceiptService.confirmFromBill(req.params.id, {
      idempotency_key: b.idempotency_key,
      supplier_id: b.supplier_id,
      location_id: b.location_id,
      invoice_number: b.invoice_number,
      invoice_date: b.invoice_date,
      remarks: b.remarks,
      lines: b.lines,
      duplicate_ack: b.duplicate_ack
    }, getActor(req));
    return res.status(result.duplicate ? 200 : 201).json({
      duplicate: Boolean(result.duplicate),
      receipt: result.receipt,
      items: result.items,
      bill: result.bill
    });
  } catch (error) {
    await auditConfirmationFailure(req, 'DIRECT', error);
    return sendError(res, error, 'Failed to confirm the direct receipt');
  }
};

/**
 * POST /api/inventory/receipts/:id/reverse-direct
 *
 * Reverses a DIRECT receipt. Phase G's reversal is purchase-order bound and
 * rejects a receipt whose po_id is null, so direct receipts need this path.
 * Narrower authorization than receiving, matching the Phase G rule.
 */
export const reverseDirectReceipt = async (req, res) => {
  try {
    const b = req.body || {};
    const result = await DirectReceiptService.reverseDirect(req.params.id, {
      idempotency_key: b.idempotency_key,
      reason: b.reason
    }, getActor(req));
    return res.status(result.duplicate ? 200 : 201).json({
      duplicate: Boolean(result.duplicate),
      reversal: result.reversal,
      receipt: result.receipt
    });
  } catch (error) {
    return sendError(res, error, 'Failed to reverse the direct receipt');
  }
};
