/**
 * billOcrService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H2 — OCR extraction for stored supplier bills.
 *
 * THIS SERVICE IS COMPLETELY STOCK-NEUTRAL. It reads one already-validated
 * image off disk, runs the EXISTING OCR worker over it, and writes four fields
 * plus a status onto the bill document. It imports no stock, receipt or
 * purchase-order module, creates no bill lines, and matches nothing — parsing
 * and matching are H3.
 *
 * Lifecycle:  UPLOADED ──▶ EXTRACTING ──▶ EXTRACTED
 *                                    └──▶ EXTRACTION_FAILED
 *
 * A failed or empty extraction is NOT an error state for the operator. The bill
 * stays fully usable as a manual-entry document, which is the expected outcome
 * for handwritten bills — Tesseract does not read handwriting reliably.
 */

import fs from 'fs';
import path from 'path';
import { extractOCRData, OCR_TIMEOUT_MS } from './ocrService.js';
import { resolveBillPath } from '../middleware/billUploadMiddleware.js';
import {
  getInventoryBillByIdFirestore,
  updateInventoryBillFirestore
} from '../repositories/firestore/inventoryBillsRepository.js';
import { BILL_STATUS, BILL_OCR_TEXT_MAX } from '../utils/inventoryConstants.js';

/** Recorded on every bill so a later re-read knows what produced the text. */
export const OCR_ENGINE = 'tesseract.js@7 (eng)';

/**
 * Statuses from which extraction may be (re)started. EXTRACTING is included on
 * purpose: a server restart mid-extraction would otherwise strand a bill in
 * that state forever, and H2 deliberately introduces no background job system
 * to reap it. Re-running is safe because extraction only ever overwrites its
 * own four fields.
 */
export const OCR_STARTABLE_STATUSES = Object.freeze([
  BILL_STATUS.UPLOADED,
  BILL_STATUS.EXTRACTING,
  BILL_STATUS.EXTRACTED,
  BILL_STATUS.EXTRACTION_FAILED
]);

function fail(message, code, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

/**
 * The OCR worker writes its preprocessed copy as `<name>_prep<ext>` beside the
 * input. It unlinks that copy itself on the happy path, but a timeout kill
 * leaves it behind — inside the bills directory, where it would otherwise
 * accumulate and double storage. Swept here, never throwing.
 */
function sweepPreprocessedArtifact(absoluteBillPath) {
  try {
    const p = path.parse(absoluteBillPath);
    const prep = path.join(p.dir, `${p.name}_prep${p.ext}`);
    const root = path.resolve(path.dirname(absoluteBillPath));
    if (path.resolve(prep).startsWith(root) && fs.existsSync(prep)) {
      fs.unlinkSync(prep);
      return true;
    }
  } catch { /* best effort — never fails the extraction */ }
  return false;
}

/**
 * Runs OCR for one bill and persists the outcome.
 *
 * Resolves rather than rejecting for every OCR-side failure: the bill is moved
 * to EXTRACTION_FAILED and the caller carries on. It rejects only when the bill
 * itself cannot legitimately be extracted (missing, confirmed, discarded, file
 * gone), which is a caller error rather than an OCR outcome.
 *
 * @returns {Promise<{bill: object, outcome: 'EXTRACTED'|'EXTRACTION_FAILED', reason: string|null}>}
 */
export async function runBillOcr(billId) {
  const bill = await getInventoryBillByIdFirestore(billId);
  if (!bill) throw fail('Bill not found.', 'BILL_NOT_FOUND', 404);

  // A confirmed bill is evidence behind a stock movement; its extraction is
  // part of that record and must not be rewritten. A discarded bill is gone.
  if (!OCR_STARTABLE_STATUSES.includes(bill.status)) {
    throw fail(
      `A bill with status '${bill.status}' cannot be re-extracted.`,
      'BILL_NOT_EXTRACTABLE',
      409
    );
  }

  const absolute = resolveBillPath(bill.file_name);
  if (!absolute || !fs.existsSync(absolute)) {
    await updateInventoryBillFirestore(bill.id, {
      status: BILL_STATUS.EXTRACTION_FAILED,
      ocr_engine: OCR_ENGINE,
      ocr_confidence: null,
      ocr_raw_text: null,
      ocr_completed_at: new Date().toISOString()
    });
    throw fail('The stored bill file is no longer available.', 'BILL_FILE_MISSING', 409);
  }

  await updateInventoryBillFirestore(bill.id, { status: BILL_STATUS.EXTRACTING });

  let result = null;
  let reason = null;
  try {
    // extractOCRData never rejects — it resolves to empty text on any failure,
    // including the worker timeout. The try/catch guards only against the
    // module itself throwing.
    result = await extractOCRData(absolute, bill.mime_type);
  } catch (err) {
    reason = err.message || 'OCR worker threw';
  } finally {
    sweepPreprocessedArtifact(absolute);
  }

  // Prefer the preprocessed pass, which is what the worker reports confidence
  // for; fall back to the raw pass when preprocessing failed inside the worker.
  const text = String(result?.preprocessedText || result?.rawText || '').trim();
  const confidence = Number(result?.confidence);
  const hasText = text.length > 0;

  const now = new Date().toISOString();
  const patch = {
    status: hasText ? BILL_STATUS.EXTRACTED : BILL_STATUS.EXTRACTION_FAILED,
    ocr_engine: OCR_ENGINE,
    ocr_confidence: Number.isFinite(confidence) ? confidence : null,
    // The repository caps this again on write; capping here keeps the payload
    // small on the wire as well.
    ocr_raw_text: hasText ? text.slice(0, BILL_OCR_TEXT_MAX) : null,
    ocr_completed_at: now
  };
  if (!hasText && !reason) {
    reason = 'OCR produced no readable text (expected for handwritten or low-quality bills)';
  }

  const updated = await updateInventoryBillFirestore(bill.id, patch);
  return { bill: updated, outcome: patch.status, reason };
}

/**
 * Fire-and-forget wrapper used by the upload endpoint so the HTTP response is
 * not held for the full OCR duration.
 *
 * Deliberately NOT a job queue. The only durable state is the bill's own
 * status, and `runBillOcr` accepts EXTRACTING as a startable state so a bill
 * stranded by a restart can simply be extracted again through the explicit
 * endpoint. Nothing retries on its own.
 */
export function startBillOcrInBackground(billId) {
  setImmediate(() => {
    runBillOcr(billId)
      .then(({ outcome, reason }) => {
        console.log(`[BillOCR] ${billId} → ${outcome}${reason ? ` (${reason})` : ''}`);
      })
      .catch((err) => {
        console.warn(`[BillOCR] ${billId} extraction aborted: ${err.message}`);
      });
  });
}

export { OCR_TIMEOUT_MS };
