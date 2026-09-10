/**
 * directReceiptService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H6 — PO-less Direct Receipt, and its dedicated reversal.
 *
 * WHY THIS EXISTS
 *   The Phase F receive path is PO-bound: GoodsReceiptService.receive() takes a
 *   purchase order id and every line needs a po_item_id. Goods that arrive with
 *   a bill and no prior order therefore have nowhere to land. Phase G reversal
 *   is PO-bound too — it re-reads the order and rejects a mismatched po_id — so
 *   a direct receipt needs its own reversal.
 *
 * WHAT THIS IS NOT
 *   It is NOT a second stock engine. Every quantity change goes through
 *   stageMovementInTransaction, the same shared ledger core Phases A–G use,
 *   which keeps idempotency, unit checking and negative-stock protection. This
 *   service performs no stock arithmetic of its own and never writes
 *   current_stock, stock_quantity or stock_by_location directly.
 *
 * SHAPE
 *   Direct receipts live in the EXISTING goods_receipts collection, discriminated
 *   by receipt_kind: 'DIRECT' with po_id: null. Absent receipt_kind means a
 *   Phase F PO receipt, so no historical document is rewritten or migrated.
 *   Because po_id is null, Phase G's reverseReceipt rejects them automatically
 *   with RECEIPT_PO_MISMATCH — it fails closed rather than misbehaving.
 */

import crypto from 'crypto';
import { db } from '../config/firebaseAdmin.js';
import { stageMovementInTransaction } from './inventoryStockService.js';
import { reserveNumberInTransaction, resolveBusinessDate } from './inventoryNumberService.js';
import {
  receiptIdForKey, formatReceiptDocId, receiptRef, receiptItemRef,
  getGoodsReceiptByIdFirestore, getGoodsReceiptItemsFirestore
} from '../repositories/firestore/goodsReceiptsRepository.js';
import {
  reversalIdForKey, reversalRef, getReversalForReceiptFirestore
} from '../repositories/firestore/goodsReceiptReversalsRepository.js';
import { formatMovementDocId, movementRef } from '../repositories/firestore/inventoryStockMovementsRepository.js';
import { formatProductDocId } from '../repositories/firestore/firestoreUtils.js';
import { formatLocationDocId } from '../repositories/firestore/inventoryLocationsRepository.js';
import { getInventorySupplierByIdFirestore } from '../repositories/firestore/inventorySuppliersRepository.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { detectBillDuplicates, assertDuplicatesAcknowledged } from './billDuplicateService.js';
import {
  getInventoryBillByIdFirestore, billRef
} from '../repositories/firestore/inventoryBillsRepository.js';
import {
  roundQuantity, roundMoney, MAX_REQUEST_QUANTITY, BILL_STATUS, MIN_CORRECTION_REASON_LENGTH
} from '../utils/inventoryConstants.js';

const PRODUCTS = 'inventory_products';
const LOCATIONS = 'inventory_locations';

/** Direct receipt numbering series: DR-YYYYMMDD-NNNNNN. */
export const DR_NUMBER_PREFIX = 'DR';

/** The ledger reference that distinguishes a direct receipt movement. */
export const DIRECT_RECEIPT_REFERENCE = 'DIRECT_RECEIPT';

/** Discriminator written on the receipt document. Absent ⇒ Phase F PO receipt. */
export const RECEIPT_KIND_DIRECT = 'DIRECT';

function fail(message, code, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function cleanText(v, max = 1000) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** Stable fingerprint so a replayed key carrying different lines is detectable. */
function payloadFingerprint(billDocId, lines) {
  const canonical = lines
    .map(l => `${l.product_id}:${roundQuantity(l.quantity)}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(`${billDocId}::${canonical}`).digest('hex').slice(0, 32);
}

/**
 * Validates the submitted lines in isolation. Product existence and activity are
 * re-checked INSIDE the transaction against Firestore — nothing the client sends
 * about a product, a unit or a quantity is trusted here.
 */
function planLines(submitted) {
  if (!Array.isArray(submitted) || submitted.length === 0) {
    throw fail('At least one line must be received.', 'NO_RECEIPT_LINES');
  }
  const seen = new Set();
  const plan = [];
  for (const raw of submitted) {
    const productId = raw?.product_id ? String(raw.product_id).trim() : null;
    if (!productId) throw fail('Every receipt line needs a product_id.', 'PRODUCT_REQUIRED');

    // One product per line: two balance writes to the same product inside one
    // transaction would race, exactly as Phase F guards against.
    const docId = formatProductDocId(productId);
    if (seen.has(docId)) {
      throw fail(`Product '${productId}' appears on more than one receipt line.`, 'DUPLICATE_RECEIPT_PRODUCT');
    }
    seen.add(docId);

    const qty = roundQuantity(raw.quantity);
    if (!Number.isFinite(qty)) throw fail(`Quantity for '${productId}' must be a number.`, 'INVALID_QUANTITY');
    if (qty <= 0) throw fail(`Quantity for '${productId}' must be greater than zero.`, 'INVALID_QUANTITY');
    if (qty > MAX_REQUEST_QUANTITY) {
      throw fail(`Quantity for '${productId}' exceeds the maximum of ${MAX_REQUEST_QUANTITY}.`, 'QUANTITY_TOO_LARGE');
    }

    plan.push({
      productDocId: docId,
      product_id: productId,
      quantity: qty,
      unit: raw.unit ? String(raw.unit).trim() : null,
      unit_cost: roundMoney(raw.unit_cost) || 0,
      remarks: cleanText(raw.remarks, 500)
    });
  }
  return plan;
}

async function writeAudit(action, details, actor, businessDate, logId) {
  try {
    await createAuditLogFirestore({
      log_id: logId,
      action,
      details: { ...details, actor_role: actor?.role || null },
      user_id: actor?.uid || 'unknown',
      business_date: businessDate
    });
  } catch (err) {
    // Stock has already committed; a failed audit write must never undo it.
    console.warn(`[DirectReceipt] audit log failed (${action}): ${err.message}`);
  }
}

export const DirectReceiptService = {
  /**
   * Confirms a bill as a PO-less direct receipt.
   *
   * Everything authoritative is read from Firestore inside the transaction:
   * the bill, the supplier, the location and every product. The client supplies
   * only ids and quantities, and no stock total it sends is ever used.
   */
  async confirmFromBill(billId, { idempotency_key, supplier_id, location_id, invoice_number, invoice_date, remarks, lines = [], duplicate_ack = null } = {}, actor) {
    if (!idempotency_key || !String(idempotency_key).trim()) {
      throw fail('An idempotency_key is required so a retried confirmation cannot post stock twice.', 'IDEMPOTENCY_KEY_REQUIRED');
    }
    if (!location_id) throw fail('A destination location is required.', 'LOCATION_REQUIRED');
    if (!supplier_id) throw fail('A supplier is required for a direct receipt.', 'SUPPLIER_REQUIRED');

    const bill = await getInventoryBillByIdFirestore(billId);
    if (!bill) throw fail('Bill not found.', 'BILL_NOT_FOUND', 404);
    if (bill.status === BILL_STATUS.CONFIRMED || bill.receipt_id) {
      throw fail('This bill has already been confirmed into a receipt.', 'BILL_ALREADY_CONFIRMED', 409);
    }
    if (bill.status === BILL_STATUS.DISCARDED) {
      throw fail('A discarded bill cannot be confirmed.', 'BILL_DISCARDED', 409);
    }

    // Supplier is validated before the transaction so the failure is cheap and
    // the message is specific; it is not re-read inside because a supplier
    // record cannot invalidate a stock posting mid-flight.
    const supplier = await getInventorySupplierByIdFirestore(supplier_id);
    if (!supplier) throw fail(`Supplier '${supplier_id}' does not exist.`, 'SUPPLIER_NOT_FOUND', 404);
    if (supplier.is_active === false) throw fail(`Supplier '${supplier.name}' is inactive.`, 'SUPPLIER_INACTIVE');

    const plan = planLines(lines);
    const businessDate = await resolveBusinessDate(null);
    const receiptDocId = receiptIdForKey(idempotency_key);
    const grRef = receiptRef(receiptDocId);
    const billDocRef = billRef(bill.id);
    const locationDocId = formatLocationDocId(location_id);
    const locationRef = db.collection(LOCATIONS).doc(locationDocId);
    const fingerprint = payloadFingerprint(bill.id, plan.map(p => ({ product_id: p.productDocId, quantity: p.quantity })));

    // A completed receipt under this key: return it rather than posting again.
    const existing = await getGoodsReceiptByIdFirestore(receiptDocId);
    if (existing) {
      if (existing.payload_fingerprint && existing.payload_fingerprint !== fingerprint) {
        throw fail(
          'This idempotency key was already used for a different set of lines.',
          'IDEMPOTENCY_KEY_CONFLICT', 409
        );
      }
      return { duplicate: true, receipt: existing, items: await getGoodsReceiptItemsFirestore(receiptDocId), bill };
    }

    // ── H7 duplicate gate ────────────────────────────────────────────────────
    // Deliberately AFTER the idempotent-replay short circuit above. A retried
    // request must return the receipt it already created without ever being
    // asked to acknowledge anything, otherwise a network retry would turn into
    // a prompt the operator has no way to answer.
    const dup = await detectBillDuplicates(bill, { supplier_id, invoice_number, invoice_date });
    const override = assertDuplicatesAcknowledged(dup.warnings, duplicate_ack);

    const lineRefs = plan.map((p, i) => {
      const lineNo = i + 1;
      const movementId = formatMovementDocId(`${receiptDocId}_${lineNo}`);
      return {
        ...p,
        lineNo,
        movementId,
        movRef: movementRef(movementId),
        productRef: db.collection(PRODUCTS).doc(p.productDocId)
      };
    });

    const result = await db.runTransaction(async (txn) => {
      // ══ READ PHASE — every read precedes every write ══
      const [grSnap, locSnap, billSnap] = await Promise.all([
        txn.get(grRef), txn.get(locationRef), txn.get(billDocRef)
      ]);

      // A concurrent attempt with the same key already won.
      if (grSnap.exists) {
        return { duplicate: true, receipt: { id: receiptDocId, ...grSnap.data() } };
      }

      // THE BILL IS CLAIMED INSIDE THIS TRANSACTION.
      //
      // The identical check runs before the transaction too, but a check made
      // there only reflects the state at read time. Three requests carrying
      // three DIFFERENT idempotency keys all read the same unconfirmed bill,
      // all passed that check, and all committed a receipt of their own —
      // multiplying stock by three while the bill's receipt_id ended up
      // pointing at whichever write landed last. Receipt-level idempotency
      // cannot catch it, because a different key is a genuinely different
      // receipt document.
      //
      // Reading the bill here and writing it below puts it in this
      // transaction's read-write set, so Firestore's optimistic concurrency
      // serializes the claim: the first commit wins and the others retry, see
      // a confirmed bill, and refuse.
      if (!billSnap.exists) throw fail('Bill not found.', 'BILL_NOT_FOUND', 404);
      const liveBill = billSnap.data();
      if (liveBill.status === BILL_STATUS.CONFIRMED || liveBill.receipt_id) {
        throw fail('This bill has already been confirmed into a receipt.', 'BILL_ALREADY_CONFIRMED', 409);
      }
      if (liveBill.status === BILL_STATUS.DISCARDED) {
        throw fail('A discarded bill cannot be confirmed.', 'BILL_DISCARDED', 409);
      }
      if (!locSnap.exists) throw fail(`Location '${location_id}' does not exist.`, 'LOCATION_NOT_FOUND', 404);
      if (locSnap.data().is_active === false) {
        throw fail(`Location '${locSnap.data().name}' is inactive — goods cannot be received into it.`, 'LOCATION_INACTIVE');
      }

      const productSnaps = await Promise.all(lineRefs.map(l => txn.get(l.productRef)));
      const movSnaps = await Promise.all(lineRefs.map(l => txn.get(l.movRef)));

      // Last read: reserves the DR sequence transactionally.
      const { number: receiptNumber } = await reserveNumberInTransaction(txn, DR_NUMBER_PREFIX, businessDate);

      // ══ WRITE PHASE ══
      const now = new Date().toISOString();
      // The claim itself. Paired with the read above, this is what makes two
      // concurrent confirmations of one bill impossible rather than merely
      // unlikely.
      txn.update(billDocRef, {
        status: BILL_STATUS.CONFIRMED,
        mode: 'DIRECT',
        receipt_id: receiptDocId,
        supplier_id: supplier.id,
        location_id: locationDocId,
        confirmed_by_uid: actor?.uid || null,
        confirmed_by_name: actor?.name || null,
        confirmed_at: now,
        updated_at: now
      });
      const receiptLines = [];
      let totalQty = 0;
      let totalValue = 0;

      for (let i = 0; i < lineRefs.length; i++) {
        const line = lineRefs[i];
        const prodSnap = productSnaps[i];
        if (!prodSnap.exists) throw fail(`Product '${line.product_id}' does not exist.`, 'PRODUCT_NOT_FOUND', 404);
        const product = prodSnap.data();
        const isActive = product.is_active !== undefined
          ? Boolean(product.is_active)
          : String(product.status || 'Active') !== 'Inactive';
        if (!isActive) throw fail(`Product '${product.name || line.product_id}' is inactive.`, 'PRODUCT_INACTIVE');

        // Stock posting through the SHARED ledger core. It enforces the unit
        // match (no conversion), negative-stock protection and per-movement
        // idempotency; this service adds no arithmetic of its own.
        const staged = stageMovementInTransaction(txn, {
          movementId: line.movementId,
          movRef: line.movRef,
          movSnap: movSnaps[i],
          productRef: line.productRef,
          prodSnap,
          locSnap,
          productId: line.product_id,
          locationId: locationDocId,
          movementType: 'RECEIPT',
          quantity: line.quantity,
          unit: line.unit,
          reference_type: DIRECT_RECEIPT_REFERENCE,
          reference_id: receiptDocId,
          reason: `Direct receipt ${receiptNumber}`,
          remarks: line.remarks,
          businessDate,
          actor: { uid: actor?.uid || null, name: actor?.name || null },
          idempotency_key: `${receiptDocId}_${line.lineNo}`,
          now
        });

        if (staged.duplicate) {
          throw fail(
            'A stock movement for this direct receipt line already exists without its receipt. Aborting rather than posting an inconsistent receipt.',
            'MOVEMENT_RECEIPT_DIVERGED', 409
          );
        }

        const receivedValue = roundMoney(line.quantity * line.unit_cost);
        const receiptLine = {
          receipt_id: receiptDocId,
          line_no: line.lineNo,
          product_id: line.product_id,
          sku_snapshot: staged.product?.sku || product.sku || null,
          product_name_snapshot: staged.product?.name || product.name || null,
          category_snapshot: product.category_id || null,
          unit_snapshot: staged.movement.unit || line.unit || null,
          // No order exists, so there is nothing ordered to compare against.
          // These stay null rather than being faked to zero.
          ordered_quantity: null,
          previously_received_quantity: null,
          received_quantity: line.quantity,
          cumulative_received_quantity: null,
          outstanding_quantity: null,
          variance_quantity: null,
          variance_type: null,
          variance_reason: null,
          estimated_unit_cost: line.unit_cost,
          received_value: receivedValue,
          stock_movement_id: staged.movement.movement_id,
          qty_before: staged.movement.qty_before,
          qty_after: staged.movement.qty_after,
          created_at: now
        };
        txn.set(receiptItemRef(receiptDocId, line.lineNo), receiptLine);
        receiptLines.push(receiptLine);
        totalQty = roundQuantity(totalQty + line.quantity);
        totalValue = roundMoney(totalValue + receivedValue);
      }

      const receipt = {
        receipt_id: receiptDocId,
        receipt_number: receiptNumber,
        // The discriminator. Absent on every Phase F receipt, so nothing
        // historical is rewritten and listForOrder still excludes these.
        receipt_kind: RECEIPT_KIND_DIRECT,
        po_id: null,
        po_number: null,
        bill_id: bill.id,
        receipt_status: 'POSTED',
        po_status_after: null,
        received_at: now,
        received_by_uid: actor?.uid || null,
        received_by_name: actor?.name || null,
        location_id: locationDocId,
        location_name_snapshot: locSnap.data().name || null,
        supplier_id: supplier.id,
        supplier_name_snapshot: supplier.name || null,
        invoice_number: cleanText(invoice_number, 60),
        invoice_date: cleanText(invoice_date, 10),
        total_received_items: receiptLines.length,
        total_received_quantity: totalQty,
        total_received_value: totalValue,
        variance_summary: [],
        remarks: cleanText(remarks, 2000),
        idempotency_key: String(idempotency_key),
        payload_fingerprint: fingerprint,
        business_date: businessDate,
        created_at: now,
        updated_at: now
      };
      txn.set(grRef, receipt);

      return { duplicate: false, receipt: { ...receipt, id: receiptDocId }, items: receiptLines };
    });

    if (result.duplicate) {
      return { duplicate: true, receipt: result.receipt, items: await getGoodsReceiptItemsFirestore(receiptDocId), bill };
    }

    // Bill linkage is written AFTER the stock transaction commits. If this
    // patch fails the stock is still correct and the receipt still carries
    // bill_id, so the relationship is recoverable from the receipt side.
    // The bill was already confirmed inside the transaction above, atomically
    // with the receipt. This is a read-back for the response, not a second
    // write — writing it again here would reintroduce the window that let two
    // confirmations through.
    const updatedBill = await getInventoryBillByIdFirestore(bill.id);

    await writeAudit('INVENTORY_DIRECT_RECEIPT_CREATED', {
      bill_id: bill.id,
      receipt_id: receiptDocId,
      receipt_number: result.receipt.receipt_number,
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      location_id: locationDocId,
      invoice_number: result.receipt.invoice_number,
      total_received_items: result.receipt.total_received_items,
      total_received_quantity: result.receipt.total_received_quantity,
      total_received_value: result.receipt.total_received_value,
      received_by_uid: actor?.uid || null,
      duplicate_warnings: dup.warnings.map(w => w.code),
      duplicate_override: override ? override.codes : null
    }, actor, businessDate, `inv_dr_${receiptDocId}`);

    // A separate record, not merely a field on the one above. An override is
    // the moment a human overruled a safety signal, and it has to be findable
    // as its own action rather than by parsing every receipt audit.
    if (override) {
      await writeAudit('INVENTORY_BILL_DUPLICATE_OVERRIDE', {
        bill_id: bill.id,
        receipt_id: receiptDocId,
        mode: 'DIRECT',
        overridden_codes: override.codes,
        reason: override.reason,
        matched_bill_ids: dup.warnings.flatMap(w => w.bill_ids || []).slice(0, 20),
        supplier_id: supplier.id,
        invoice_number: result.receipt.invoice_number,
        overridden_by_uid: actor?.uid || null
      }, actor, businessDate, `inv_dupovr_${receiptDocId}`);
    }

    return { duplicate: false, receipt: result.receipt, items: result.items, bill: updatedBill };
  },

  /**
   * Reverses a DIRECT receipt.
   *
   * Phase G's reverseReceipt cannot be used: it reads the purchase order and
   * rejects a receipt whose po_id does not match, which a direct receipt's null
   * po_id never can. This mirrors Phase G's shape — the original receipt is
   * never edited, a reversal record is the authoritative marker, and
   * compensating REVERSAL movements run through the same ledger core.
   */
  async reverseDirect(receiptId, { idempotency_key, reason } = {}, actor) {
    if (!idempotency_key || !String(idempotency_key).trim()) {
      throw fail('An idempotency_key is required so a retried reversal cannot subtract stock twice.', 'IDEMPOTENCY_KEY_REQUIRED');
    }
    const cleanReason = cleanText(reason, 500);
    if (!cleanReason || cleanReason.length < MIN_CORRECTION_REASON_LENGTH) {
      throw fail(`A reversal reason of at least ${MIN_CORRECTION_REASON_LENGTH} characters is required.`, 'REVERSAL_REASON_REQUIRED');
    }

    const receiptDocId = formatReceiptDocId(receiptId);
    const receipt = await getGoodsReceiptByIdFirestore(receiptDocId);
    if (!receipt) throw fail('Goods receipt not found.', 'GOODS_RECEIPT_NOT_FOUND', 404);
    if (receipt.receipt_kind !== RECEIPT_KIND_DIRECT) {
      throw fail(
        'This receipt is not a direct receipt. Use the purchase-order reversal path instead.',
        'NOT_A_DIRECT_RECEIPT', 409
      );
    }

    const alreadyReversed = await getReversalForReceiptFirestore(receiptDocId);
    if (alreadyReversed) {
      return { duplicate: true, reversal: alreadyReversed, receipt };
    }

    const items = await getGoodsReceiptItemsFirestore(receiptDocId);
    if (!items.length) throw fail('This receipt has no lines to reverse.', 'NO_RECEIPT_LINES', 409);

    const businessDate = await resolveBusinessDate(null);
    const reversalDocId = reversalIdForKey(idempotency_key);
    const grvRef = reversalRef(reversalDocId);
    const locationDocId = formatLocationDocId(receipt.location_id);
    const locationRef = db.collection(LOCATIONS).doc(locationDocId);

    const lineRefs = items.map(item => {
      const movementId = formatMovementDocId(`${reversalDocId}_${item.line_no}`);
      return {
        item,
        movementId,
        movRef: movementRef(movementId),
        productRef: db.collection(PRODUCTS).doc(formatProductDocId(item.product_id))
      };
    });

    const result = await db.runTransaction(async (txn) => {
      const [grvSnap, locSnap] = await Promise.all([txn.get(grvRef), txn.get(locationRef)]);
      if (grvSnap.exists) return { duplicate: true, reversal: { id: reversalDocId, ...grvSnap.data() } };
      if (!locSnap.exists) throw fail('The receipt location no longer exists.', 'LOCATION_NOT_FOUND', 404);

      const productSnaps = await Promise.all(lineRefs.map(l => txn.get(l.productRef)));
      const movSnaps = await Promise.all(lineRefs.map(l => txn.get(l.movRef)));

      const now = new Date().toISOString();
      const movementIds = [];
      let totalReversedQty = 0;
      let totalReversedValue = 0;

      for (let i = 0; i < lineRefs.length; i++) {
        const { item, movementId, movRef, productRef } = lineRefs[i];
        const qty = roundQuantity(item.received_quantity) || 0;

        // REVERSAL has sign -1 in the shared core, so this subtracts exactly
        // what the receipt added. Insufficient stock is caught there, not here.
        const staged = stageMovementInTransaction(txn, {
          movementId, movRef, movSnap: movSnaps[i],
          productRef, prodSnap: productSnaps[i], locSnap,
          productId: item.product_id,
          locationId: locationDocId,
          movementType: 'REVERSAL',
          quantity: qty,
          unit: item.unit_snapshot,
          reference_type: DIRECT_RECEIPT_REFERENCE,
          reference_id: receiptDocId,
          reason: `Reversal of ${receipt.receipt_number}: ${cleanReason}`,
          remarks: cleanReason,
          businessDate,
          actor: { uid: actor?.uid || null, name: actor?.name || null },
          idempotency_key: movementId,
          now
        });

        if (staged.duplicate) {
          throw fail(
            'A compensating movement for this line already exists without its reversal record. Aborting rather than recording a reversal for stock that was never moved.',
            'MOVEMENT_REVERSAL_DIVERGED', 409
          );
        }

        movementIds.push(staged.movement.movement_id);
        totalReversedQty = roundQuantity(totalReversedQty + qty);
        totalReversedValue = roundMoney(totalReversedValue + (roundMoney(item.received_value) || 0));
      }

      // The original receipt is NEVER written. That a direct receipt was
      // reversed is recorded solely by the existence of this record.
      const reversal = {
        reversal_id: reversalDocId,
        receipt_id: receiptDocId,
        receipt_number: receipt.receipt_number,
        receipt_kind: RECEIPT_KIND_DIRECT,
        purchase_order_id: null,
        purchase_order_number: null,
        bill_id: receipt.bill_id || null,
        supplier_id: receipt.supplier_id || null,
        supplier_name_snapshot: receipt.supplier_name_snapshot || null,
        location_id: locationDocId,
        reversed_by_uid: actor?.uid || null,
        reversed_by_name: actor?.name || null,
        reversed_by_role: actor?.role || null,
        reason: cleanReason,
        stock_movement_ids: movementIds,
        reversed_quantity: totalReversedQty,
        reversed_value: totalReversedValue,
        line_count: lineRefs.length,
        po_status_after: null,
        status: 'POSTED',
        idempotency_key: String(idempotency_key),
        business_date: businessDate,
        reversed_at: now,
        created_at: now
      };
      txn.set(grvRef, reversal);

      return { duplicate: false, reversal: { ...reversal, id: reversalDocId } };
    });

    if (!result.duplicate) {
      await writeAudit('INVENTORY_DIRECT_RECEIPT_REVERSED', {
        receipt_id: receiptDocId,
        receipt_number: receipt.receipt_number,
        reversal_id: reversalDocId,
        bill_id: receipt.bill_id || null,
        stock_movement_ids: result.reversal.stock_movement_ids,
        reversed_quantity: result.reversal.reversed_quantity,
        reason: cleanReason,
        reversed_by_uid: actor?.uid || null
      }, actor, businessDate, `inv_drrev_${reversalDocId}`);
    }

    return { ...result, receipt };
  }
};

export default DirectReceiptService;
