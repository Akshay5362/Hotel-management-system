/**
 * billDuplicateService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H7 — duplicate bill detection.
 *
 * THIS SERVICE POSTS NO STOCK AND WRITES NOTHING. It reads bills and returns
 * signals. Every decision about what to do with a signal is taken by the
 * confirmation services, which is also the only place a signal can block
 * anything, because confirmation is the only place stock moves.
 *
 * WHY WARNINGS RATHER THAN BLOCKS
 * A hotel receives a corrected reprint of an invoice, a supplier reuses an
 * invoice number by mistake, a delivery arrives with the same goods on the same
 * day from the same supplier. Every one of those is a legitimate second
 * document that looks like a duplicate. Refusing them outright would push the
 * operator into working around the system, which is worse than the duplicate.
 *
 * So a signal withholds confirmation rather than refusing it, and the operator
 * clears it by naming the specific signal being overridden and saying why. A
 * blanket "yes, proceed" flag is deliberately not accepted: the acknowledgement
 * has to list the codes, so a signal that appears between review and
 * confirmation is never silently covered by an approval the operator gave for a
 * different reason.
 *
 * WHAT IS NEVER DONE HERE
 * An invoice number is never invented. Not from the upload timestamp, not from
 * the file name, not from a counter. A bill with no invoice number stays a bill
 * with no invoice number, and receiving against one is an explicit, audited
 * decision.
 */

import {
  findInventoryBillsByHashFirestore,
  findInventoryBillsByInvoiceFirestore
} from '../repositories/firestore/inventoryBillsRepository.js';
import {
  BILL_DUPLICATE_CODE,
  ALL_BILL_DUPLICATE_CODES,
  BILL_DUPLICATE_IGNORED_STATUSES,
  MIN_DUPLICATE_OVERRIDE_REASON
} from '../utils/inventoryConstants.js';

function fail(message, code, status = 400, extra = {}) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  Object.assign(e, extra);
  return e;
}

/** A discarded bill is not evidence of anything and never raises a signal. */
function isLive(bill) {
  return !BILL_DUPLICATE_IGNORED_STATUSES.includes(String(bill?.status || ''));
}

function trimOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * The supplier, invoice number and invoice date a confirmation is actually
 * about. The request wins over what OCR stored on the bill, because the
 * operator has reviewed the request values and may have corrected them.
 */
export function resolveBillIdentity(bill, overrides = {}) {
  return {
    supplier_id: trimOrNull(overrides.supplier_id ?? bill?.supplier_id),
    invoice_number: trimOrNull(overrides.invoice_number ?? bill?.invoice_number),
    invoice_date: trimOrNull(overrides.invoice_date ?? bill?.invoice_date)
  };
}

/**
 * Reads every duplicate signal for a bill.
 *
 * Never throws on a lookup failure: a duplicate check that errors must not be
 * able to stop a legitimate receipt. A failed lookup is reported as a signal of
 * its own so the operator sees that the check did not run, rather than being
 * told there are no duplicates when nothing was actually checked.
 */
export async function detectBillDuplicates(bill, overrides = {}) {
  if (!bill) return { warnings: [], checked: false };

  const identity = resolveBillIdentity(bill, overrides);
  const warnings = [];
  let checked = true;

  // ── 1. Identical stored file ───────────────────────────────────────────────
  if (bill.file_sha256) {
    try {
      const sameFile = (await findInventoryBillsByHashFirestore(bill.file_sha256))
        .filter(b => b.id !== bill.id && isLive(b));
      if (sameFile.length) {
        warnings.push({
          code: BILL_DUPLICATE_CODE.FILE_DUPLICATE,
          message: `The same file has already been uploaded on ${sameFile.length} other bill(s).`,
          bill_ids: sameFile.map(b => b.id).slice(0, 10)
        });
      }
    } catch (err) {
      checked = false;
      console.warn(`[BillDuplicate] file-hash lookup failed: ${err.message}`);
    }
  }

  // ── 2. Supplier + invoice number (+ date) ──────────────────────────────────
  if (identity.supplier_id && identity.invoice_number) {
    try {
      const sameInvoice = (await findInventoryBillsByInvoiceFirestore(
        identity.supplier_id, identity.invoice_number, null
      )).filter(b => b.id !== bill.id && isLive(b));

      const sameDate = identity.invoice_date
        ? sameInvoice.filter(b => trimOrNull(b.invoice_date) === identity.invoice_date)
        : sameInvoice;
      const otherDate = sameInvoice.filter(b => !sameDate.includes(b));

      if (sameDate.length) {
        warnings.push({
          code: BILL_DUPLICATE_CODE.INVOICE_DUPLICATE,
          message: `Invoice '${identity.invoice_number}' from this supplier${identity.invoice_date ? ` dated ${identity.invoice_date}` : ''} already exists on ${sameDate.length} other bill(s).`,
          bill_ids: sameDate.map(b => b.id).slice(0, 10)
        });
      }
      if (otherDate.length) {
        warnings.push({
          code: BILL_DUPLICATE_CODE.INVOICE_NUMBER_REUSED,
          message: `This supplier has used invoice number '${identity.invoice_number}' on ${otherDate.length} bill(s) with a different date.`,
          bill_ids: otherDate.map(b => b.id).slice(0, 10)
        });
      }
    } catch (err) {
      checked = false;
      console.warn(`[BillDuplicate] invoice lookup failed: ${err.message}`);
    }
  }

  // ── 3. No invoice number at all ────────────────────────────────────────────
  // Not a duplicate as such, but the same class of decision: receiving against
  // a document that cannot later be matched back to a supplier reference.
  if (!identity.invoice_number) {
    warnings.push({
      code: BILL_DUPLICATE_CODE.MISSING_INVOICE_NUMBER,
      message: 'This bill has no invoice number, so a future duplicate cannot be detected by invoice reference.',
      bill_ids: []
    });
  }

  return { warnings, checked, identity };
}

/**
 * Validates the operator's acknowledgement against the signals actually raised.
 *
 * Returns null when there was nothing to acknowledge. Throws when an
 * acknowledgement is required and missing, incomplete, or unexplained.
 *
 * The acknowledgement must name every raised code. Accepting a bare boolean
 * would mean an operator who cleared a missing-invoice-number warning during
 * review would also, without seeing it, clear a file-duplicate warning that
 * appeared afterwards.
 */
export function assertDuplicatesAcknowledged(warnings, ack) {
  const required = [...new Set((warnings || []).map(w => w.code))];
  if (!required.length) return null;

  if (!ack || typeof ack !== 'object') {
    throw fail(
      `This bill raised ${required.length} duplicate warning(s) that must be acknowledged before stock can be received.`,
      'DUPLICATE_ACK_REQUIRED', 409,
      { required_acknowledgements: required, warnings }
    );
  }

  const given = Array.isArray(ack.codes) ? ack.codes.map(c => String(c).trim().toUpperCase()) : [];

  const unknown = given.filter(c => !ALL_BILL_DUPLICATE_CODES.includes(c));
  if (unknown.length) {
    throw fail(
      `Unknown duplicate acknowledgement code(s): ${unknown.join(', ')}.`,
      'INVALID_DUPLICATE_ACK', 400
    );
  }

  const missing = required.filter(c => !given.includes(c));
  if (missing.length) {
    throw fail(
      `These duplicate warning(s) have not been acknowledged: ${missing.join(', ')}.`,
      'DUPLICATE_ACK_REQUIRED', 409,
      { required_acknowledgements: required, missing_acknowledgements: missing, warnings }
    );
  }

  const reason = trimOrNull(ack.reason);
  if (!reason || reason.length < MIN_DUPLICATE_OVERRIDE_REASON) {
    throw fail(
      `Overriding a duplicate warning needs a reason of at least ${MIN_DUPLICATE_OVERRIDE_REASON} characters.`,
      'DUPLICATE_OVERRIDE_REASON_REQUIRED', 400,
      { required_acknowledgements: required }
    );
  }

  // Codes the operator listed that were not actually raised are dropped rather
  // than rejected: a stale review screen is an everyday occurrence, and the
  // record of what was really overridden is what matters for the audit.
  return {
    codes: required,
    reason: reason.slice(0, 500),
    offered_codes: given
  };
}

export default { detectBillDuplicates, assertDuplicatesAcknowledged, resolveBillIdentity };
