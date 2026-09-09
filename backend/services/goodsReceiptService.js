/**
 * goodsReceiptService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase F — GOODS RECEIVING + STOCK POSTING.
 *
 *   PO ISSUED ──receive──▶ PARTIALLY_RECEIVED ──receive──▶ RECEIVED
 *   PO ISSUED ──receive (in full)──────────────────────────▶ RECEIVED
 *
 * This is the FIRST step in the purchasing chain permitted to change stock,
 * and the design answers to one rule above all others:
 *
 *   EVERYTHING COMMITS TOGETHER, OR NOTHING DOES.
 *
 * A single Firestore transaction writes: the goods receipt, its line items,
 * the purchase order's cumulative received quantities, the purchase order's
 * status and history, the stock ledger movements and the product balances.
 * There is no window in which a receipt exists without its stock, stock exists
 * without its receipt, or the PO status disagrees with what was received.
 *
 * ── Reusing the ledger, not duplicating it ──────────────────────────────────
 * Firestore has no nested transactions, so this service cannot call
 * inventoryStockService.applyMovement() (which opens its own). Instead it
 * calls stageMovementInTransaction() — the SAME ledger core applyMovement
 * itself uses — passing the snapshots it has already read. One implementation
 * of the balance math, the legacy-balance migration, the negative guard and
 * the legacy mirrors serves both paths.
 *
 * ── Source of truth ─────────────────────────────────────────────────────────
 *   • goods_receipt_items  — the immutable, append-only record of each
 *     individual delivery. Never edited, never overwritten.
 *   • purchase_order_items.received_quantity — the authoritative CUMULATIVE
 *     total, updated in the same transaction that appends the receipt lines.
 *     The two cannot drift because they are written together; the cumulative
 *     field exists so a receipt can be validated against it transactionally
 *     without re-aggregating history on every call.
 *   • inventory_stock_movements / product balances — Phase A's ledger,
 *     untouched in design and now fed by RECEIPT movements.
 *
 * ── Stock is posted at ACCEPTED quantity ────────────────────────────────────
 * Ordered 10, received 7 → stock +7 (not +10). A later 3 → +3. An accepted
 * over-receipt of 12 → +12, with the +2 variance recorded and a mandatory
 * reason. Quantities are never silently clamped.
 */

import crypto from 'crypto';
import { db } from '../config/firebaseAdmin.js';
import { formatDocSnapshot, RepositoryError } from '../repositories/firestore/firestoreUtils.js';
import {
  orderRef, orderItemRef, formatOrderDocId,
  getPurchaseOrderByIdFirestore, getPurchaseOrderItemsFirestore
} from '../repositories/firestore/purchaseOrdersRepository.js';
import {
  receiptIdForKey, receiptRef, receiptItemRef,
  getGoodsReceiptByIdFirestore, getGoodsReceiptItemsFirestore,
  getGoodsReceiptsForOrderFirestore
} from '../repositories/firestore/goodsReceiptsRepository.js';
import { productDocIdFor } from '../repositories/firestore/inventoryProductsRepository.js';
import { formatLocationDocId } from '../repositories/firestore/inventoryLocationsRepository.js';
import { movementRef, formatMovementDocId } from '../repositories/firestore/inventoryStockMovementsRepository.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { stageMovementInTransaction } from './inventoryStockService.js';
import { reserveNumberInTransaction, resolveBusinessDate } from './inventoryNumberService.js';
import { getReversalsForOrderFirestore } from '../repositories/firestore/goodsReceiptReversalsRepository.js';
import {
  PO_STATUS, PO_RECEIVABLE_STATUSES, GR_NUMBER_PREFIX, VARIANCE_TYPE,
  MAX_REQUEST_QUANTITY, roundQuantity, roundMoney
} from '../utils/inventoryConstants.js';

const PRODUCTS = 'inventory_products';
const LOCATIONS = 'inventory_locations';

function fail(message, code, status = 400) {
  return new RepositoryError(message, code, status);
}

function cleanText(v, max = 1000) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Stable fingerprint of what a receipt request is asking to do. Reusing an
 * idempotency key for a materially different delivery is a caller bug, not a
 * retry, and must be refused rather than silently accepted.
 */
function payloadFingerprint(poDocId, lines) {
  const canonical = lines
    .map(l => `${l.po_item_id}:${roundQuantity(l.received_quantity)}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(`${poDocId}::${canonical}`).digest('hex').slice(0, 32);
}

async function writeAudit(receipt, actor, extra = {}) {
  try {
    await createAuditLogFirestore({
      log_id: `inv_gr_${receipt.receipt_id}`,
      action: 'INVENTORY_GOODS_RECEIPT_CREATED',
      details: {
        receipt_id: receipt.receipt_id,
        receipt_number: receipt.receipt_number,
        po_id: receipt.po_id,
        po_number: receipt.po_number,
        supplier_id: receipt.supplier_id,
        supplier_name: receipt.supplier_name_snapshot,
        location_id: receipt.location_id,
        received_by_uid: receipt.received_by_uid,
        received_by_name: receipt.received_by_name,
        total_received_items: receipt.total_received_items,
        total_received_quantity: receipt.total_received_quantity,
        total_received_value: receipt.total_received_value,
        po_status_after: receipt.po_status_after,
        variances: receipt.variance_summary || [],
        actor_role: actor?.role || null,
        ...extra
      },
      user_id: actor?.uid || 'unknown',
      business_date: receipt.business_date
    });
  } catch (err) {
    // The receipt and its stock have already committed; a failed audit write
    // must never undo them.
    console.warn(`[GoodsReceipt] audit log failed: ${err.message}`);
  }
}

async function withItems(receiptDoc) {
  if (!receiptDoc) return null;
  const items = await getGoodsReceiptItemsFirestore(receiptDoc.id);
  return { ...receiptDoc, items };
}

/** Validates the submitted lines against the PO's own lines (no writes). */
function planLines(submittedLines, poItems) {
  if (!Array.isArray(submittedLines) || submittedLines.length === 0) {
    throw fail('At least one line must be received.', 'NO_RECEIPT_LINES');
  }

  const byPoItemId = new Map(poItems.map(i => [i.id, i]));
  const seenItems = new Set();
  const seenProducts = new Set();
  const plan = [];

  for (const raw of submittedLines) {
    const poItemId = raw?.po_item_id;
    if (!poItemId) throw fail('Every receipt line needs a po_item_id.', 'PO_ITEM_REQUIRED');
    if (seenItems.has(poItemId)) {
      throw fail(`Purchase order line '${poItemId}' appears more than once in this receipt.`, 'DUPLICATE_RECEIPT_LINE');
    }
    seenItems.add(poItemId);

    const poItem = byPoItemId.get(poItemId);
    if (!poItem) throw fail(`Purchase order line '${poItemId}' does not belong to this purchase order.`, 'PO_ITEM_NOT_FOUND', 404);

    // One product may appear on only one line — otherwise two balance writes
    // would race within a single transaction.
    if (seenProducts.has(poItem.product_id)) {
      throw fail(`Product '${poItem.sku_snapshot}' appears on more than one receipt line.`, 'DUPLICATE_RECEIPT_PRODUCT');
    }
    seenProducts.add(poItem.product_id);

    const qty = roundQuantity(raw.received_quantity);
    if (!Number.isFinite(qty)) throw fail(`Received quantity for '${poItem.sku_snapshot}' must be a number.`, 'INVALID_QUANTITY');
    // Zero-quantity lines are simply not part of this delivery and must be
    // omitted by the caller rather than sent as noise.
    if (qty <= 0) throw fail(`Received quantity for '${poItem.sku_snapshot}' must be greater than zero.`, 'INVALID_QUANTITY');
    if (qty > MAX_REQUEST_QUANTITY) throw fail(`Received quantity for '${poItem.sku_snapshot}' exceeds the maximum of ${MAX_REQUEST_QUANTITY}.`, 'QUANTITY_TOO_LARGE');

    if (raw.unit && String(raw.unit).trim().toUpperCase() !== String(poItem.unit_snapshot).toUpperCase()) {
      throw fail(
        `Unit '${raw.unit}' does not match the ordered unit '${poItem.unit_snapshot}' for '${poItem.sku_snapshot}'.`,
        'UNIT_MISMATCH'
      );
    }

    plan.push({ poItem, received_quantity: qty, variance_reason: cleanText(raw.variance_reason, 500) });
  }

  return plan;
}

export const GoodsReceiptService = {

  /**
   * Records one delivery against a purchase order and posts the accepted
   * quantities to stock — atomically.
   *
   * @returns {{ duplicate: boolean, receipt: object, order: object }}
   */
  async receive(poId, { idempotency_key, remarks = null, lines = [] } = {}, actor) {
    if (!idempotency_key || !String(idempotency_key).trim()) {
      throw fail('An idempotency_key is required so a retried delivery cannot post stock twice.', 'IDEMPOTENCY_KEY_REQUIRED');
    }

    const poDocId = formatOrderDocId(poId);
    const receiptDocId = receiptIdForKey(idempotency_key);

    // ── Pre-transaction reads: cheap rejection before touching anything ──────
    const existingReceipt = await getGoodsReceiptByIdFirestore(receiptDocId);
    const order = await getPurchaseOrderByIdFirestore(poDocId);
    if (!order) throw fail('Purchase order not found.', 'PURCHASE_ORDER_NOT_FOUND', 404);

    const poItems = await getPurchaseOrderItemsFirestore(poDocId);
    if (poItems.length === 0) throw fail('This purchase order has no line items.', 'PO_HAS_NO_ITEMS');

    const plan = planLines(lines, poItems);
    const fingerprint = payloadFingerprint(poDocId, plan.map(p => ({ po_item_id: p.poItem.id, received_quantity: p.received_quantity })));

    if (existingReceipt) {
      // A genuine retry replays the identical delivery; anything else is a
      // key collision and must not be silently accepted.
      if (existingReceipt.payload_fingerprint && existingReceipt.payload_fingerprint !== fingerprint) {
        throw fail(
          'This idempotency key was already used for a different delivery. Use a new key.',
          'IDEMPOTENCY_KEY_REUSE_CONFLICT', 409
        );
      }
      if (String(existingReceipt.po_id) !== poDocId) {
        throw fail(
          'This idempotency key was already used against a different purchase order. Use a new key.',
          'IDEMPOTENCY_KEY_REUSE_CONFLICT', 409
        );
      }
      return {
        duplicate: true,
        receipt: await withItems(existingReceipt),
        order: await getPurchaseOrderByIdFirestore(poDocId)
      };
    }

    if (!PO_RECEIVABLE_STATUSES.includes(order.status)) {
      throw fail(
        order.status === PO_STATUS.RECEIVED
          ? 'This purchase order has already been fully received.'
          : `A ${order.status} purchase order cannot receive goods — it must be ISSUED first.`,
        'PO_NOT_RECEIVABLE', 409
      );
    }

    // Stock is always posted to the PO's own location; the client cannot
    // redirect a delivery somewhere else.
    const locationDocId = formatLocationDocId(order.location_id);
    const businessDate = await resolveBusinessDate(order.business_date);
    const now = new Date().toISOString();

    const poRef = orderRef(poDocId);
    const grRef = receiptRef(receiptDocId);
    const locationRef = db.collection(LOCATIONS).doc(locationDocId);

    // Per-line refs, resolved before the transaction so the read phase is a
    // single parallel batch.
    const lineRefs = plan.map((p, i) => {
      const lineNo = i + 1;
      const movementId = formatMovementDocId(`${receiptDocId}_${lineNo}`);
      return {
        ...p,
        lineNo,
        movementId,
        movRef: movementRef(movementId),
        productRef: db.collection(PRODUCTS).doc(productDocIdFor(p.poItem.product_id)),
        poItemRef: orderItemRef(poDocId, p.poItem.line_no)
      };
    });

    const result = await db.runTransaction(async (txn) => {
      // ══ READ PHASE — every read must precede every write ══
      const [grSnap, poSnap, locSnap] = await Promise.all([
        txn.get(grRef), txn.get(poRef), txn.get(locationRef)
      ]);

      // Concurrent retry of the same key: the other transaction won.
      if (grSnap.exists) {
        return { duplicate: true, receipt: formatDocSnapshot(grSnap), order: formatDocSnapshot(poSnap) };
      }
      if (!poSnap.exists) throw fail('Purchase order not found.', 'PURCHASE_ORDER_NOT_FOUND', 404);

      const currentOrder = formatDocSnapshot(poSnap);
      if (!PO_RECEIVABLE_STATUSES.includes(currentOrder.status)) {
        throw fail(
          currentOrder.status === PO_STATUS.RECEIVED
            ? 'This purchase order has already been fully received.'
            : `A ${currentOrder.status} purchase order cannot receive goods.`,
          'PO_NOT_RECEIVABLE', 409
        );
      }
      if (!locSnap.exists) throw fail(`Location '${locationDocId}' no longer exists.`, 'LOCATION_NOT_FOUND', 404);
      if (locSnap.data().is_active === false) {
        throw fail(`Location '${locSnap.data().name}' is inactive — goods cannot be received into it.`, 'LOCATION_INACTIVE');
      }

      // Fresh PO line + product + movement snapshots. Re-reading the PO lines
      // INSIDE the transaction is what makes concurrent deliveries correct: a
      // contending receipt forces a retry and this sees the updated cumulative.
      const poItemSnaps = await Promise.all(lineRefs.map(l => txn.get(l.poItemRef)));
      const productSnaps = await Promise.all(lineRefs.map(l => txn.get(l.productRef)));
      const movSnaps = await Promise.all(lineRefs.map(l => txn.get(l.movRef)));

      // Last read: reserves the GR sequence (reads the counter, then writes it).
      const { number: receiptNumber } = await reserveNumberInTransaction(txn, GR_NUMBER_PREFIX, businessDate);

      // ══ WRITE PHASE ══
      const receiptLines = [];
      const varianceSummary = [];
      let totalQty = 0;
      let totalValue = 0;
      const cumulativeByItemId = new Map();

      for (let i = 0; i < lineRefs.length; i++) {
        const line = lineRefs[i];
        const poItemSnap = poItemSnaps[i];
        if (!poItemSnap.exists) throw fail(`Purchase order line '${line.poItem.id}' no longer exists.`, 'PO_ITEM_NOT_FOUND', 404);
        const poItem = formatDocSnapshot(poItemSnap);

        const ordered = roundQuantity(poItem.ordered_quantity) || 0;
        const previously = roundQuantity(poItem.received_quantity || 0) || 0;
        const receivedNow = line.received_quantity;
        const cumulative = roundQuantity(previously + receivedNow);
        const outstanding = roundQuantity(Math.max(ordered - cumulative, 0));

        // Variance is measured on the CUMULATIVE position against the order.
        let varianceType = VARIANCE_TYPE.SHORT;
        let varianceQty = 0;
        if (cumulative > ordered) {
          varianceType = VARIANCE_TYPE.OVER;
          varianceQty = roundQuantity(cumulative - ordered);
        } else if (cumulative === ordered) {
          varianceType = VARIANCE_TYPE.EXACT;
        } else {
          varianceQty = roundQuantity(cumulative - ordered); // negative = still outstanding
        }

        // An over-receipt is accepted, but never silently: the reason is
        // mandatory and is stored on the line.
        if (varianceType === VARIANCE_TYPE.OVER && !line.variance_reason) {
          throw fail(
            `Receiving ${receivedNow} ${poItem.unit_snapshot} of '${poItem.sku_snapshot}' exceeds the ordered ${ordered} by ${varianceQty}. ` +
            `A variance reason is required to accept an over-receipt.`,
            'VARIANCE_REASON_REQUIRED'
          );
        }

        const unitCost = roundMoney(poItem.estimated_unit_cost || 0) || 0;
        const receivedValue = roundMoney(receivedNow * unitCost);

        // ── Stock posting through the SHARED ledger core ──
        const staged = stageMovementInTransaction(txn, {
          movementId: line.movementId,
          movRef: line.movRef,
          movSnap: movSnaps[i],
          productRef: line.productRef,
          prodSnap: productSnaps[i],
          locSnap,
          productId: poItem.product_id,
          locationId: locationDocId,
          movementType: 'RECEIPT',
          quantity: receivedNow,
          unit: poItem.unit_snapshot,
          reference_type: 'GOODS_RECEIPT',
          reference_id: receiptDocId,
          reason: `Goods receipt ${receiptNumber} against ${currentOrder.po_number}`,
          remarks: line.variance_reason || null,
          businessDate,
          actor: { uid: actor?.uid || null, name: actor?.name || null },
          idempotency_key: `${receiptDocId}_${line.lineNo}`,
          now
        });

        const receiptLine = {
          receipt_item_id: receiptItemRef(receiptDocId, line.lineNo).id,
          receipt_id: receiptDocId,
          po_id: poDocId,
          po_item_id: poItem.id,
          line_no: line.lineNo,
          product_id: poItem.product_id,
          // Snapshots come from the PURCHASE ORDER, so a later product rename
          // or price change never rewrites this historical receipt.
          sku_snapshot: poItem.sku_snapshot,
          product_name_snapshot: poItem.product_name_snapshot,
          category_snapshot: poItem.category_snapshot || null,
          unit_snapshot: poItem.unit_snapshot,
          ordered_quantity: ordered,
          previously_received_quantity: previously,
          received_quantity: receivedNow,
          cumulative_received_quantity: cumulative,
          outstanding_quantity: outstanding,
          variance_quantity: varianceQty,
          variance_type: varianceType,
          variance_reason: line.variance_reason || null,
          estimated_unit_cost: unitCost,
          received_value: receivedValue,
          stock_movement_id: staged.movement.movement_id,
          qty_before: staged.movement.qty_before,
          qty_after: staged.movement.qty_after,
          created_at: now
        };

        txn.set(receiptItemRef(receiptDocId, line.lineNo), receiptLine);
        // Cumulative on the PO line — the authoritative running total.
        txn.update(line.poItemRef, {
          received_quantity: cumulative,
          outstanding_quantity: outstanding,
          variance_quantity: varianceQty,
          variance_type: varianceType,
          last_received_at: now
        });

        receiptLines.push(receiptLine);
        cumulativeByItemId.set(poItem.id, cumulative);
        totalQty = roundQuantity(totalQty + receivedNow);
        totalValue = roundMoney(totalValue + receivedValue);
        if (varianceType === VARIANCE_TYPE.OVER) {
          varianceSummary.push({ sku: poItem.sku_snapshot, variance_quantity: varianceQty, variance_type: varianceType, reason: line.variance_reason });
        }
      }

      // ── PO status from the cumulative position of EVERY line ──
      let allSatisfied = true;
      for (const poItem of poItems) {
        const ordered = roundQuantity(poItem.ordered_quantity) || 0;
        const cumulative = cumulativeByItemId.has(poItem.id)
          ? cumulativeByItemId.get(poItem.id)
          : roundQuantity(poItem.received_quantity || 0) || 0;
        if (cumulative < ordered) { allSatisfied = false; break; }
      }
      const nextStatus = allSatisfied ? PO_STATUS.RECEIVED : PO_STATUS.PARTIALLY_RECEIVED;

      const history = Array.isArray(currentOrder.status_history) ? [...currentOrder.status_history] : [];
      history.push({ status: nextStatus, at: now, by_uid: actor?.uid || null, by_name: actor?.name || null, receipt_number: receiptNumber });

      txn.update(poRef, {
        status: nextStatus,
        status_history: history,
        last_received_at: now,
        receipt_count: (Number(currentOrder.receipt_count) || 0) + 1,
        updated_at: now
      });

      const receipt = {
        receipt_id: receiptDocId,
        receipt_number: receiptNumber,
        po_id: poDocId,
        po_number: currentOrder.po_number,
        receipt_status: 'POSTED',
        po_status_after: nextStatus,
        received_at: now,
        received_by_uid: actor?.uid || null,
        received_by_name: actor?.name || null,
        location_id: currentOrder.location_id,
        location_name_snapshot: currentOrder.location_name_snapshot || null,
        supplier_id: currentOrder.supplier_id,
        supplier_name_snapshot: currentOrder.supplier_name_snapshot,
        total_received_items: receiptLines.length,
        total_received_quantity: totalQty,
        total_received_value: totalValue,
        variance_summary: varianceSummary,
        remarks: cleanText(remarks, 2000),
        idempotency_key: String(idempotency_key),
        payload_fingerprint: fingerprint,
        business_date: businessDate,
        created_at: now,
        updated_at: now
      };
      txn.set(grRef, receipt);

      return {
        duplicate: false,
        receipt: { ...receipt, id: receiptDocId },
        order: { ...currentOrder, status: nextStatus, status_history: history }
      };
    });

    if (!result.duplicate) await writeAudit(result.receipt, actor);
    return {
      duplicate: result.duplicate,
      receipt: await withItems(result.receipt),
      order: await getPurchaseOrderByIdFirestore(poDocId)
    };
  },

  /** Delivery history for one purchase order, oldest first. */
  /**
   * Delivery history for one purchase order.
   *
   * A goods receipt is immutable, so it carries no indication that it was
   * later reversed. That fact lives in `goods_receipt_reversals`, and is
   * JOINED here as a derived `reversal` field on each receipt — present only
   * in this view, never written back to the receipt document.
   */
  async listForOrder(poId) {
    const poDocId = formatOrderDocId(poId);
    const [receipts, reversals] = await Promise.all([
      getGoodsReceiptsForOrderFirestore(poDocId),
      getReversalsForOrderFirestore(poDocId)
    ]);
    const byReceiptId = new Map(reversals.map(r => [String(r.receipt_id), r]));

    const withLines = [];
    for (const r of receipts) {
      const view = await withItems(r);
      const reversal = byReceiptId.get(String(r.id)) || null;
      withLines.push({ ...view, reversal, is_reversed: Boolean(reversal) });
    }
    return { receipts: withLines };
  },

  async getById(receiptId) {
    const doc = await getGoodsReceiptByIdFirestore(receiptId);
    if (!doc) return null;
    return await withItems(doc);
  }
};

export default GoodsReceiptService;
