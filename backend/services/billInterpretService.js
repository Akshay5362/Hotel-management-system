/**
 * billInterpretService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H3 — turns a bill's OCR text into stored, reviewable lines.
 *
 * This is the thin, impure shell around the pure billMatchingService: it loads
 * the product and supplier masters, calls `interpretBill`, and persists the
 * result. All judgement lives in the pure module; all I/O lives here.
 *
 * STOCK-NEUTRAL. It imports no stock, receipt or purchase-order module, writes
 * only to `inventory_bills` and `inventory_bill_lines`, and leaves every
 * `resolved_quantity` null because nothing here is human-confirmed.
 */

import { interpretBill } from './billMatchingService.js';
import {
  getInventoryBillByIdFirestore,
  updateInventoryBillFirestore,
  replaceInventoryBillLinesFirestore,
  getInventoryBillLinesFirestore
} from '../repositories/firestore/inventoryBillsRepository.js';
import { getAllInventoryProductsFirestore } from '../repositories/firestore/inventoryProductsRepository.js';
import { getAllInventorySuppliersFirestore } from '../repositories/firestore/inventorySuppliersRepository.js';
import { BILL_STATUS, MATCH_CONFIDENCE } from '../utils/inventoryConstants.js';

function fail(message, code, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

/** Statuses whose lines may be (re)interpreted. A confirmed bill is frozen. */
export const INTERPRETABLE_STATUSES = Object.freeze([
  BILL_STATUS.EXTRACTED,
  BILL_STATUS.EXTRACTION_FAILED,
  BILL_STATUS.IN_REVIEW
]);

/**
 * Interprets one bill and replaces its lines.
 *
 * Moves the bill to IN_REVIEW: interpretation is the point at which a human is
 * expected to take over. A bill with no readable text still becomes IN_REVIEW
 * with zero lines, which is the manual-entry path.
 */
export async function interpretStoredBill(billId) {
  const bill = await getInventoryBillByIdFirestore(billId);
  if (!bill) throw fail('Bill not found.', 'BILL_NOT_FOUND', 404);

  if (!INTERPRETABLE_STATUSES.includes(bill.status)) {
    throw fail(
      `A bill with status '${bill.status}' cannot be interpreted.`,
      'BILL_NOT_INTERPRETABLE',
      409
    );
  }

  // Neither loader takes an includeInactive option: products accepts `filters`
  // and suppliers accepts only `transaction`. Inactive records are filtered
  // inside the matcher instead, which keeps that policy in one place.
  const [products, suppliers] = await Promise.all([
    getAllInventoryProductsFirestore(),
    getAllInventorySuppliersFirestore()
  ]);

  const proposal = interpretBill(bill.ocr_raw_text || '', { products, suppliers });

  const lines = await replaceInventoryBillLinesFirestore(bill.id, proposal.lines);

  // Only HIGH-confidence header values are written onto the bill. Anything
  // weaker stays a suggestion returned to the caller, never persisted as if the
  // operator had chosen it.
  const patch = { status: BILL_STATUS.IN_REVIEW };
  if (proposal.supplier_name_raw) patch.supplier_name_raw = proposal.supplier_name_raw;
  if (proposal.supplier_confidence) patch.supplier_confidence = proposal.supplier_confidence;
  if (proposal.supplier_confidence === MATCH_CONFIDENCE.HIGH && proposal.supplier_id) {
    patch.supplier_id = proposal.supplier_id;
  }
  if (proposal.invoice_number) patch.invoice_number = proposal.invoice_number;
  // An ambiguous day/month pair is NOT written; the operator must confirm it.
  if (proposal.invoice_date && !proposal.invoice_date_ambiguous) {
    patch.invoice_date = proposal.invoice_date;
  }

  const updated = await updateInventoryBillFirestore(bill.id, patch);

  return {
    bill: updated,
    lines,
    proposal: {
      suggested_supplier_id: proposal.suggested_supplier_id,
      supplier_confidence: proposal.supplier_confidence,
      supplier_candidates: proposal.supplier_candidates,
      gstin: proposal.gstin,
      invoice_number: proposal.invoice_number,
      invoice_date: proposal.invoice_date,
      invoice_date_ambiguous: proposal.invoice_date_ambiguous
    },
    stats: {
      lines: lines.length,
      high: lines.filter(l => l.match_confidence === MATCH_CONFIDENCE.HIGH).length,
      medium: lines.filter(l => l.match_confidence === MATCH_CONFIDENCE.MEDIUM).length,
      low: lines.filter(l => l.match_confidence === MATCH_CONFIDENCE.LOW).length,
      unmatched: lines.filter(l => l.match_confidence === MATCH_CONFIDENCE.UNMATCHED).length,
      unit_exceptions: lines.filter(l => l.unit_exception).length
    }
  };
}

/** Bill plus its lines, for the review screen. Read-only. */
export async function getBillWithLines(billId) {
  const bill = await getInventoryBillByIdFirestore(billId);
  if (!bill) throw fail('Bill not found.', 'BILL_NOT_FOUND', 404);
  const lines = await getInventoryBillLinesFirestore(bill.id);
  return { bill, lines };
}
