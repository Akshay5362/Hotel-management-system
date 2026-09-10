/**
 * billConfirmService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H5 — PO-assisted bill confirmation.
 *
 * THIS SERVICE POSTS NO STOCK ITSELF. It validates the bill and its reviewed
 * lines, resolves every line to an authoritative purchase-order item read from
 * Firestore, and then calls GoodsReceiptService.receive() — the UNCHANGED Phase
 * F engine — which owns the transaction, the ledger posting, the variance
 * handling, the idempotency and the audit log.
 *
 * There is deliberately no second receiving implementation here. If this file
 * ever needs to compute a balance, that is a signal the design went wrong.
 *
 * WHAT IT DOES ADD
 *   • Bill-level gating: a confirmed or discarded bill can never be received.
 *   • Line resolution: matches each reviewed line to a real PO item by product,
 *     because the client is not trusted to supply po_item_id correctly.
 *   • Exception gating: an unmatched product, a unit exception or an invalid
 *     quantity blocks confirmation before the engine is ever called.
 *   • Bill linkage after the receipt commits.
 *
 * CRASH RECOVERY
 * The bill and the receipt cannot share one transaction, because the Phase F
 * engine owns its own and is untouched here. So the bill is claimed as
 * CONFIRMING — never CONFIRMED — and the claim records the exact receipt id the
 * engine is about to write. That id is deterministic from the idempotency key,
 * so a process that dies mid-flight leaves behind everything needed to decide
 * what happened: read that one receipt. If it exists the bill is finalised, and
 * if it does not the claim is released. See billConfirmRecoveryService.js.
 */

import crypto from 'crypto';
import { GoodsReceiptService } from './goodsReceiptService.js';
import { receiptIdForKey } from '../repositories/firestore/goodsReceiptsRepository.js';
import { BillConfirmRecoveryService } from './billConfirmRecoveryService.js';
import { getPurchaseOrderByIdFirestore, getPurchaseOrderItemsFirestore } from '../repositories/firestore/purchaseOrdersRepository.js';
import { getInventoryBillByIdFirestore, getInventoryBillLinesFirestore, billRef } from '../repositories/firestore/inventoryBillsRepository.js';
import { db } from '../config/firebaseAdmin.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { detectBillDuplicates, assertDuplicatesAcknowledged } from './billDuplicateService.js';
import { formatProductDocId } from '../repositories/firestore/firestoreUtils.js';
import { roundQuantity, MAX_REQUEST_QUANTITY, BILL_STATUS } from '../utils/inventoryConstants.js';

/**
 * TEST-ONLY SEAM. Lets a DEV test simulate the process dying at an exact point,
 * without killing a real process and without the service's own cleanup running
 * — which is precisely what makes a crash different from an error.
 *
 * Inert unless a test arms it, and it refuses to arm outside development, so it
 * cannot change behaviour in a running hotel.
 */
export class SimulatedProcessCrash extends Error {
  constructor(point) {
    super(`Simulated process crash at ${point}`);
    this.name = 'SimulatedProcessCrash';
    this.code = 'SIMULATED_PROCESS_CRASH';
    this.point = point;
  }
}
export const __crashSeam = { point: null };
export function armCrashSeam(point) {
  if (process.env.HPMS_ENV === 'production') {
    throw new Error('The crash seam cannot be armed in production.');
  }
  __crashSeam.point = point;
}
export function disarmCrashSeam() { __crashSeam.point = null; }
function crashIfArmed(point) {
  if (__crashSeam.point === point) {
    __crashSeam.point = null;               // one shot, so a test cannot leak it
    throw new SimulatedProcessCrash(point);
  }
}

function fail(message, code, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

/**
 * Resolves reviewed bill lines against the purchase order's real items.
 *
 * The client sends product ids and quantities. Everything else — which PO item
 * a product belongs to, what unit was ordered, how much was ordered — is read
 * from Firestore, so a tampered payload cannot widen what gets received.
 */
function resolveLines(submitted, poItems) {
  if (!Array.isArray(submitted) || submitted.length === 0) {
    throw fail('At least one line must be received.', 'NO_RECEIPT_LINES');
  }

  const byProduct = new Map();
  for (const item of poItems) byProduct.set(formatProductDocId(item.product_id), item);

  const seen = new Set();
  const out = [];

  for (const raw of submitted) {
    const productId = raw?.product_id ? String(raw.product_id).trim() : null;
    if (!productId) throw fail('Every receipt line needs a product_id.', 'PRODUCT_REQUIRED');

    const docId = formatProductDocId(productId);
    if (seen.has(docId)) {
      throw fail(`Product '${productId}' appears on more than one receipt line.`, 'DUPLICATE_RECEIPT_PRODUCT');
    }
    seen.add(docId);

    const poItem = byProduct.get(docId);
    if (!poItem) {
      throw fail(
        `Product '${productId}' is not on this purchase order and cannot be received against it.`,
        'PO_ITEM_NOT_FOUND', 404
      );
    }

    const qty = roundQuantity(raw.quantity);
    if (!Number.isFinite(qty)) throw fail(`Quantity for '${poItem.sku_snapshot}' must be a number.`, 'INVALID_QUANTITY');
    if (qty <= 0) throw fail(`Quantity for '${poItem.sku_snapshot}' must be greater than zero.`, 'INVALID_QUANTITY');
    if (qty > MAX_REQUEST_QUANTITY) {
      throw fail(`Quantity for '${poItem.sku_snapshot}' exceeds the maximum of ${MAX_REQUEST_QUANTITY}.`, 'QUANTITY_TOO_LARGE');
    }

    // Unit is compared against the ORDERED unit, read from Firestore. The Phase
    // F engine checks this again, and the ledger core checks it a third time
    // against the product. No conversion happens at any layer.
    if (raw.unit && String(raw.unit).trim().toUpperCase() !== String(poItem.unit_snapshot).toUpperCase()) {
      throw fail(
        `Unit '${raw.unit}' does not match the ordered unit '${poItem.unit_snapshot}' for '${poItem.sku_snapshot}'.`,
        'UNIT_MISMATCH'
      );
    }

    out.push({
      po_item_id: poItem.id,
      received_quantity: qty,
      variance_reason: raw.variance_reason ? String(raw.variance_reason).trim().slice(0, 500) : undefined
    });
  }
  return out;
}

export const BillConfirmService = {
  /**
   * Confirms a bill against an existing purchase order.
   *
   * Delegates the entire stock posting to GoodsReceiptService.receive(), which
   * is byte-identical to its Phase F form. Over-receipt still requires the
   * variance reason that engine already demands — nothing here weakens it.
   */
  async confirmAgainstPurchaseOrder(billId, { idempotency_key, po_id, lines = [], remarks, duplicate_ack = null } = {}, actor) {
    if (!idempotency_key || !String(idempotency_key).trim()) {
      throw fail('An idempotency_key is required so a retried confirmation cannot post stock twice.', 'IDEMPOTENCY_KEY_REQUIRED');
    }
    if (!po_id) throw fail('A purchase order is required.', 'PURCHASE_ORDER_REQUIRED');

    // The receipt document id is fully determined by the idempotency key, so it
    // is known before anything is written. That is what lets a crashed
    // confirmation be diagnosed later with a single document read.
    const expectedReceiptId = receiptIdForKey(String(idempotency_key));

    // Settle anything left over from an earlier attempt on this bill BEFORE
    // reading its state, so a stranded CONFIRMING bill is resolved rather than
    // blocking forever, and a receipt that exists is honoured rather than
    // duplicated. A fresh claim is left alone and refused below.
    try {
      await BillConfirmRecoveryService.settle(billId, { actor });
    } catch (err) {
      if (err.code === 'BILL_NOT_FOUND') throw err;
      console.warn(`[BillConfirm] pre-flight recovery check failed for ${billId}: ${err.message}`);
    }

    const bill = await getInventoryBillByIdFirestore(billId);
    if (!bill) throw fail('Bill not found.', 'BILL_NOT_FOUND', 404);
    if (bill.status === BILL_STATUS.CONFIRMING) {
      // Still held by a live attempt (a stale one would have been settled above).
      throw fail(
        'Another confirmation of this bill is already in progress.',
        'BILL_CONFIRMATION_IN_PROGRESS', 409
      );
    }
    if (bill.status === BILL_STATUS.CONFIRMED || bill.receipt_id) {
      throw fail('This bill has already been confirmed into a receipt.', 'BILL_ALREADY_CONFIRMED', 409);
    }
    if (bill.status === BILL_STATUS.DISCARDED) {
      throw fail('A discarded bill cannot be confirmed.', 'BILL_DISCARDED', 409);
    }

    // Unresolved review exceptions block confirmation before anything is posted.
    // Read from the stored lines, not from the request, so a client cannot hide
    // an exception by simply omitting it.
    // FAILS CLOSED. This read used to swallow its own errors and fall back to an
    // empty list, which meant a failing query reported "no unresolved
    // exceptions" and let the confirmation through. A gate that cannot read the
    // thing it is guarding must refuse, not wave the request past.
    let storedLines = [];
    try {
      storedLines = await getInventoryBillLinesFirestore(bill.id);
    } catch (err) {
      throw fail(
        `The reviewed lines for this bill could not be read, so the bill cannot be confirmed: ${err.message}`,
        'BILL_LINES_UNREADABLE', 503
      );
    }
    const openExceptions = storedLines.filter(l => !l.excluded && l.unit_exception);
    if (openExceptions.length) {
      throw fail(
        `${openExceptions.length} bill line(s) still have an unresolved unit exception.`,
        'UNRESOLVED_UNIT_EXCEPTION', 409
      );
    }

    const order = await getPurchaseOrderByIdFirestore(po_id);
    if (!order) throw fail('Purchase order not found.', 'PURCHASE_ORDER_NOT_FOUND', 404);
    const poItems = await getPurchaseOrderItemsFirestore(order.id);
    if (!poItems.length) throw fail('This purchase order has no lines.', 'PO_HAS_NO_ITEMS', 409);

    const resolved = resolveLines(lines, poItems);

    // ── H7 duplicate gate ────────────────────────────────────────────────────
    // Last check before the engine, so a malformed request is still rejected on
    // its own terms rather than being reported as a duplicate problem. A replay
    // of a confirmed bill never reaches here: the bill gate above returns
    // BILL_ALREADY_CONFIRMED first, which is the stronger guarantee.
    // The supplier comes from the purchase order, which is authoritative here.
    const dup = await detectBillDuplicates(bill, { supplier_id: order.supplier_id });
    const override = assertDuplicatesAcknowledged(dup.warnings, duplicate_ack);

    // ── Claim the bill atomically BEFORE the engine runs ─────────────────────
    //
    // Every check above reads the bill outside a transaction, so it only
    // reflects the state at read time. Two confirmations of one bill carrying
    // two DIFFERENT idempotency keys are two different receipt documents, which
    // receipt-level idempotency cannot merge — both would post stock, and the
    // bill would end up pointing at whichever wrote last while the other
    // receipt stayed live and invisible.
    //
    // Phase F's engine is deliberately untouched, so the claim cannot live
    // inside its transaction. The bill is therefore claimed as CONFIRMING, not
    // CONFIRMED: the difference is what makes a crash recoverable. The claim
    // carries the receipt id the engine will produce, which is deterministic
    // from the idempotency key, so recovery is one document read.
    const billDocRef = billRef(bill.id);
    const claimedAt = new Date().toISOString();
    const claim = {
      claim_id: crypto.randomUUID(),
      idempotency_key: String(idempotency_key),
      receipt_id: expectedReceiptId,
      po_id: order.id,
      mode: 'PO',
      location_id: order.location_id || bill.location_id || null,
      supplier_id: order.supplier_id || bill.supplier_id || null,
      prior_status: bill.status,
      claimed_at: claimedAt,
      claimed_by_uid: actor?.uid || null,
      claimed_by_name: actor?.name || null
    };

    await db.runTransaction(async (txn) => {
      const snap = await txn.get(billDocRef);
      if (!snap.exists) throw fail('Bill not found.', 'BILL_NOT_FOUND', 404);
      const live = snap.data();
      if (live.status === BILL_STATUS.CONFIRMED || live.receipt_id) {
        throw fail('This bill has already been confirmed into a receipt.', 'BILL_ALREADY_CONFIRMED', 409);
      }
      if (live.status === BILL_STATUS.DISCARDED) {
        throw fail('A discarded bill cannot be confirmed.', 'BILL_DISCARDED', 409);
      }
      // Another confirmation holds the bill. Refused rather than queued: the
      // caller can retry once that one finishes or its claim goes stale.
      if (live.status === BILL_STATUS.CONFIRMING) {
        throw fail(
          'Another confirmation of this bill is already in progress.',
          'BILL_CONFIRMATION_IN_PROGRESS', 409
        );
      }
      txn.update(billDocRef, {
        status: BILL_STATUS.CONFIRMING,
        mode: 'PO',
        po_id: order.id,
        confirmation_claim: claim,
        updated_at: claimedAt
      });
    });

    // The process dies here in a test: claimed, engine never called.
    crashIfArmed('AFTER_CLAIM');

    // Phase F owns the transaction: receipt, receipt items, PO cumulative,
    // stock movements, balances, variance handling and its own audit log.
    let result;
    try {
      result = await GoodsReceiptService.receive(order.id, {
        idempotency_key: String(idempotency_key),
        remarks: remarks || `Bill ${bill.invoice_number || bill.id}`,
        lines: resolved
      }, actor);
    } catch (err) {
      // A simulated crash must NOT clean up — that is the whole point of it.
      if (err instanceof SimulatedProcessCrash) throw err;
      // The engine refused, so no stock moved and the claim must not stand.
      // Released through the recovery service, which re-reads the receipt
      // inside its transaction before releasing, so an engine call that
      // committed after all is finalised instead of being discarded.
      try {
        await BillConfirmRecoveryService.settle(bill.id, { force: true, actor });
      } catch (releaseErr) {
        console.error(`[BillConfirm] bill ${bill.id} stayed claimed after a failed receipt: ${releaseErr.message}`);
      }
      throw err;
    }

    const receipt = result.receipt;

    // The process dies here in a test: receipt committed, bill still CONFIRMING.
    crashIfArmed('AFTER_RECEIPT');

    // ── Finalise: CONFIRMING → CONFIRMED, in one transaction ─────────────────
    // The claim is only converted once the receipt is known to exist, and the
    // transaction re-checks that this claim still owns the bill, so a recovery
    // running concurrently cannot be overwritten.
    const receiptDocId = receipt.receipt_id || receipt.id;
    await db.runTransaction(async (txn) => {
      const snap = await txn.get(billDocRef);
      if (!snap.exists) throw fail('Bill not found.', 'BILL_NOT_FOUND', 404);
      const live = snap.data();
      if (live.status === BILL_STATUS.CONFIRMED && live.receipt_id) return;   // recovery got there first
      if (live.status === BILL_STATUS.CONFIRMING &&
          live.confirmation_claim?.claim_id &&
          live.confirmation_claim.claim_id !== claim.claim_id) {
        return;                                                              // a newer claim owns it
      }
      txn.update(billDocRef, {
        status: BILL_STATUS.CONFIRMED,
        receipt_id: receiptDocId,
        location_id: order.location_id || bill.location_id || null,
        supplier_id: order.supplier_id || bill.supplier_id || null,
        confirmed_by_uid: actor?.uid || null,
        confirmed_by_name: actor?.name || null,
        confirmed_at: new Date().toISOString(),
        confirmation_claim: null,
        updated_at: new Date().toISOString()
      });
    });
    const updatedBill = await getInventoryBillByIdFirestore(bill.id);

    if (!result.duplicate) {
      try {
        await createAuditLogFirestore({
          log_id: `inv_billpo_${receipt.receipt_id || receipt.id}`,
          action: 'INVENTORY_BILL_CONFIRMED_AGAINST_PO',
          details: {
            bill_id: bill.id,
            po_id: order.id,
            po_number: order.po_number,
            receipt_id: receipt.receipt_id || receipt.id,
            receipt_number: receipt.receipt_number,
            supplier_id: order.supplier_id,
            location_id: order.location_id,
            total_received_items: receipt.total_received_items,
            total_received_quantity: receipt.total_received_quantity,
            variances: receipt.variance_summary || [],
            confirmed_by_uid: actor?.uid || null,
            actor_role: actor?.role || null,
            duplicate_warnings: dup.warnings.map(w => w.code),
            duplicate_override: override ? override.codes : null
          },
          user_id: actor?.uid || 'unknown',
          business_date: receipt.business_date
        });
      } catch (err) {
        console.warn(`[BillConfirm] audit log failed: ${err.message}`);
      }

      // An override is its own auditable event, not a field buried in the
      // receipt record. See the matching note in directReceiptService.js.
      if (override) {
        try {
          await createAuditLogFirestore({
            log_id: `inv_dupovr_${receipt.receipt_id || receipt.id}`,
            action: 'INVENTORY_BILL_DUPLICATE_OVERRIDE',
            details: {
              bill_id: bill.id,
              receipt_id: receipt.receipt_id || receipt.id,
              mode: 'PO',
              po_id: order.id,
              overridden_codes: override.codes,
              reason: override.reason,
              matched_bill_ids: dup.warnings.flatMap(w => w.bill_ids || []).slice(0, 20),
              supplier_id: order.supplier_id,
              overridden_by_uid: actor?.uid || null,
              actor_role: actor?.role || null
            },
            user_id: actor?.uid || 'unknown',
            business_date: receipt.business_date
          });
        } catch (err) {
          console.warn(`[BillConfirm] duplicate-override audit failed: ${err.message}`);
        }
      }
    }

    return { ...result, bill: updatedBill };
  }
};

export default BillConfirmService;
