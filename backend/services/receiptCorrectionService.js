/**
 * receiptCorrectionService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase G — GOODS RECEIPT REVERSAL and PURCHASE ORDER SHORT CLOSE.
 *
 * Two corrective actions that Phase F deliberately left out:
 *
 *   1. REVERSAL — a delivery was recorded in error. The receipt is NOT edited
 *      or deleted; a compensating REVERSAL movement cancels its stock effect
 *      and the purchase order's receiving position is recomputed.
 *
 *   2. SHORT CLOSE — the outstanding balance will never arrive. A purchasing
 *      decision only: no stock moves, no receipt is fabricated, the shortfall
 *      is recorded with a reason.
 *
 * ── The goods receipt is IMMUTABLE ──────────────────────────────────────────
 * A reversal writes NOTHING to the receipt document or its line items. The
 * receipt records what was signed for, permanently. Whether it has since been
 * reversed is not a field on the receipt at all — it is the existence of a
 * record in `goods_receipt_reversals`, which is the single source of truth.
 *
 * ── The receiving position is DERIVED, never decremented ────────────────────
 * A reversal does not subtract from a cached counter. It re-reads EVERY
 * receipt line of the purchase order inside the transaction and re-sums the
 * ones with no reversal record. That is what makes multi-receipt cases
 * correct: reversing B out of A+B+C leaves A and C's quantities exactly as
 * they were, and the resulting status describes what is genuinely held.
 *
 * ── Atomicity ───────────────────────────────────────────────────────────────
 * One transaction per action. For a reversal it writes: the reversal record,
 * the compensating stock movements, the product balances, the recomputed PO
 * lines and the PO status/history. The receipt itself is never written —
 * whether a delivery has been reversed is determined solely by the existence
 * of a record in `goods_receipt_reversals`.
 *
 * ── Ledger reuse ────────────────────────────────────────────────────────────
 * Compensating movements go through stageMovementInTransaction — the same
 * shared core Phase A's applyMovement and Phase F's receiving both use. There
 * is exactly one implementation of the balance math in the system.
 */

import crypto from 'crypto';
import { db } from '../config/firebaseAdmin.js';
import { formatDocSnapshot, RepositoryError } from '../repositories/firestore/firestoreUtils.js';
import {
  orderRef, orderItemRef, formatOrderDocId,
  getPurchaseOrderByIdFirestore, getPurchaseOrderItemsFirestore
} from '../repositories/firestore/purchaseOrdersRepository.js';
import {
  receiptRef, formatReceiptDocId,
  getGoodsReceiptByIdFirestore, getGoodsReceiptItemsFirestore,
  RECEIPT_ITEMS_COLLECTION
} from '../repositories/firestore/goodsReceiptsRepository.js';
import {
  REVERSALS_COLLECTION, reversalIdForKey, reversalRef,
  getGoodsReceiptReversalByIdFirestore, getReversalForReceiptFirestore
} from '../repositories/firestore/goodsReceiptReversalsRepository.js';
import { productDocIdFor } from '../repositories/firestore/inventoryProductsRepository.js';
import { formatLocationDocId } from '../repositories/firestore/inventoryLocationsRepository.js';
import { movementRef, formatMovementDocId } from '../repositories/firestore/inventoryStockMovementsRepository.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { stageMovementInTransaction } from './inventoryStockService.js';
import { resolveBusinessDate } from './inventoryNumberService.js';
import {
  PO_STATUS, VARIANCE_TYPE, MIN_CORRECTION_REASON_LENGTH, roundQuantity, roundMoney
} from '../utils/inventoryConstants.js';

const PRODUCTS = 'inventory_products';
const LOCATIONS = 'inventory_locations';

function fail(message, code, status = 400) {
  return new RepositoryError(message, code, status);
}

function requireReason(raw, what) {
  const reason = raw === undefined || raw === null ? '' : String(raw).trim();
  if (reason.length < MIN_CORRECTION_REASON_LENGTH) {
    throw fail(
      `A reason of at least ${MIN_CORRECTION_REASON_LENGTH} characters is required to ${what}.`,
      'CORRECTION_REASON_REQUIRED'
    );
  }
  return reason.slice(0, 1000);
}

/** Stable fingerprint so a reused key with a different target is rejected. */
function reversalFingerprint(poDocId, receiptDocId) {
  return crypto.createHash('sha256').update(`${poDocId}::${receiptDocId}`).digest('hex').slice(0, 32);
}

/**
 * Recomputes each PO line's effective received quantity from the receipt lines
 * whose receipt has NO reversal record. This is the authoritative derivation —
 * the stored cumulative is a cache of exactly this calculation.
 *
 * The exclusion set comes from `goods_receipt_reversals`, never from a flag on
 * the receipt: the receipt is immutable, so the only way to know a delivery
 * was cancelled is that a reversal record names it.
 *
 * @param {object[]} allReceiptItems every goods_receipt_item of the order
 * @param {Set<string>} reversedReceiptIds receipt ids named by a reversal record
 * @returns {Map<string, number>} po_item_id → effective received quantity
 */
function deriveEffectiveReceived(allReceiptItems, reversedReceiptIds) {
  const byPoItem = new Map();
  for (const item of allReceiptItems) {
    if (reversedReceiptIds.has(String(item.receipt_id))) continue;   // cancelled delivery
    const key = String(item.po_item_id);
    const prev = byPoItem.get(key) || 0;
    byPoItem.set(key, roundQuantity(prev + (Number(item.received_quantity) || 0)));
  }
  return byPoItem;
}

/** Derives the purchase order status from the effective receiving position. */
function deriveOrderStatus(poItems, effectiveByPoItem) {
  let anyReceived = false;
  let allSatisfied = true;
  for (const poItem of poItems) {
    const ordered = roundQuantity(poItem.ordered_quantity) || 0;
    const effective = roundQuantity(effectiveByPoItem.get(String(poItem.id)) || 0);
    if (effective > 0) anyReceived = true;
    if (effective < ordered) allSatisfied = false;
  }
  if (allSatisfied) return PO_STATUS.RECEIVED;
  return anyReceived ? PO_STATUS.PARTIALLY_RECEIVED : PO_STATUS.ISSUED;
}

function varianceFor(ordered, effective) {
  if (effective > ordered) return { variance_type: VARIANCE_TYPE.OVER, variance_quantity: roundQuantity(effective - ordered) };
  if (effective === ordered) return { variance_type: VARIANCE_TYPE.EXACT, variance_quantity: 0 };
  return { variance_type: VARIANCE_TYPE.SHORT, variance_quantity: roundQuantity(effective - ordered) };
}

async function writeAudit(action, details, actor, logId, businessDate) {
  try {
    await createAuditLogFirestore({
      log_id: logId,
      action,
      details: { ...details, actor_role: actor?.role || null },
      user_id: actor?.uid || 'unknown',
      business_date: businessDate
    });
  } catch (err) {
    // The correction has already committed; a failed audit write must not undo it.
    console.warn(`[ReceiptCorrection] audit log failed (${action}): ${err.message}`);
  }
}

export const ReceiptCorrectionService = {

  /**
   * Reverses ONE goods receipt in full.
   *
   * @returns {{ duplicate: boolean, reversal: object, order: object }}
   */
  async reverseReceipt(poId, receiptId, { idempotency_key, reason } = {}, actor) {
    if (!idempotency_key || !String(idempotency_key).trim()) {
      throw fail('An idempotency_key is required so a retried reversal cannot post stock twice.', 'IDEMPOTENCY_KEY_REQUIRED');
    }
    const cleanReason = requireReason(reason, 'reverse a goods receipt');

    const poDocId = formatOrderDocId(poId);
    const receiptDocId = formatReceiptDocId(receiptId);
    const reversalDocId = reversalIdForKey(idempotency_key);
    const fingerprint = reversalFingerprint(poDocId, receiptDocId);

    // ── Pre-transaction validation (cheap rejection, no writes) ─────────────
    const existingReversal = await getGoodsReceiptReversalByIdFirestore(reversalDocId);
    if (existingReversal) {
      if (existingReversal.payload_fingerprint && existingReversal.payload_fingerprint !== fingerprint) {
        throw fail(
          'This idempotency key was already used to reverse a different receipt. Use a new key.',
          'IDEMPOTENCY_KEY_REUSE_CONFLICT', 409
        );
      }
      return {
        duplicate: true,
        reversal: existingReversal,
        order: await getPurchaseOrderByIdFirestore(poDocId)
      };
    }

    const order = await getPurchaseOrderByIdFirestore(poDocId);
    if (!order) throw fail('Purchase order not found.', 'PURCHASE_ORDER_NOT_FOUND', 404);
    const receipt = await getGoodsReceiptByIdFirestore(receiptDocId);
    if (!receipt) throw fail('Goods receipt not found.', 'GOODS_RECEIPT_NOT_FOUND', 404);
    if (String(receipt.po_id) !== poDocId) {
      throw fail('That goods receipt does not belong to this purchase order.', 'RECEIPT_PO_MISMATCH', 409);
    }
    // A short close is an explicit, final purchasing decision — Phase G does
    // not silently reopen one.
    if (order.status === PO_STATUS.CLOSED_SHORT) {
      throw fail(
        'This purchase order was closed short. Reversing a receipt on a closed order is not permitted.',
        'PURCHASE_ORDER_CLOSED_SHORT', 409
      );
    }
    // "Already reversed" is the existence of a reversal record naming this
    // receipt — the receipt document itself carries no such flag.
    const priorReversal = await getReversalForReceiptFirestore(receiptDocId);
    if (priorReversal) {
      throw fail(
        `This goods receipt was already reversed (${priorReversal.reversal_id}).`,
        'RECEIPT_ALREADY_REVERSED', 409
      );
    }

    const receiptItems = await getGoodsReceiptItemsFirestore(receiptDocId);
    if (receiptItems.length === 0) throw fail('This goods receipt has no line items.', 'RECEIPT_HAS_NO_ITEMS');

    const poItems = await getPurchaseOrderItemsFirestore(poDocId);
    if (poItems.length === 0) throw fail('This purchase order has no line items.', 'PO_HAS_NO_ITEMS');
    // Line numbers are immutable once a purchase order is issued, so the refs
    // can be resolved here; the VALUES behind them are re-read in the
    // transaction so a concurrent delivery forces a retry and is seen.
    const poItemRefs = poItems.map(i => orderItemRef(poDocId, i.line_no));

    const locationDocId = formatLocationDocId(order.location_id);
    const businessDate = await resolveBusinessDate(order.business_date);
    const now = new Date().toISOString();

    // Movement ids derive from the RECEIPT, not the idempotency key, so the
    // same receipt can never be compensated twice even with a different key.
    const lineRefs = receiptItems.map(item => {
      const movementId = formatMovementDocId(`rev_${receiptDocId}_${item.line_no}`);
      return {
        item,
        movementId,
        movRef: movementRef(movementId),
        productRef: db.collection(PRODUCTS).doc(productDocIdFor(item.product_id))
      };
    });

    const grvRef = reversalRef(reversalDocId);
    const poRef = orderRef(poDocId);
    const gRef = receiptRef(receiptDocId);
    const locationRef = db.collection(LOCATIONS).doc(locationDocId);
    const allReceiptItemsQuery = db.collection(RECEIPT_ITEMS_COLLECTION).where('po_id', '==', poDocId);
    // Read INSIDE the transaction: this is what decides which deliveries still
    // count, so a concurrent reversal must be seen (or force a retry).
    const allReversalsQuery = db.collection(REVERSALS_COLLECTION).where('purchase_order_id', '==', poDocId);

    const result = await db.runTransaction(async (txn) => {
      // ══ READ PHASE — all reads precede all writes ══
      const [grvSnap, poSnap, receiptSnap, locSnap, allReversalsSnap, allItemsSnap] = await Promise.all([
        txn.get(grvRef), txn.get(poRef), txn.get(gRef), txn.get(locationRef),
        txn.get(allReversalsQuery), txn.get(allReceiptItemsQuery)
      ]);

      // Concurrent retry of the same key: the other transaction won.
      if (grvSnap.exists) {
        return { duplicate: true, reversal: formatDocSnapshot(grvSnap), order: formatDocSnapshot(poSnap) };
      }
      if (!poSnap.exists) throw fail('Purchase order not found.', 'PURCHASE_ORDER_NOT_FOUND', 404);
      if (!receiptSnap.exists) throw fail('Goods receipt not found.', 'GOODS_RECEIPT_NOT_FOUND', 404);

      const currentOrder = formatDocSnapshot(poSnap);
      const currentReceipt = formatDocSnapshot(receiptSnap);
      if (currentOrder.status === PO_STATUS.CLOSED_SHORT) {
        throw fail(
          'This purchase order was closed short. Reversing a receipt on a closed order is not permitted.',
          'PURCHASE_ORDER_CLOSED_SHORT', 409
        );
      }
      // Every reversal already recorded against this order, read in-transaction.
      const existingReversals = allReversalsSnap.docs.map(formatDocSnapshot);
      // Re-checked inside the transaction: a concurrent reversal under a
      // DIFFERENT key may have won the race for this same receipt.
      const alreadyReversed = existingReversals.find(r => String(r.receipt_id) === receiptDocId);
      if (alreadyReversed) {
        throw fail(
          `This goods receipt was already reversed (${alreadyReversed.reversal_id}).`,
          'RECEIPT_ALREADY_REVERSED', 409
        );
      }
      if (!locSnap.exists) throw fail(`Location '${locationDocId}' no longer exists.`, 'LOCATION_NOT_FOUND', 404);

      const productSnaps = await Promise.all(lineRefs.map(l => txn.get(l.productRef)));
      const movSnaps = await Promise.all(lineRefs.map(l => txn.get(l.movRef)));
      const poItemSnaps = await Promise.all(poItemRefs.map(r => txn.get(r)));

      // Fresh PO lines: ordered quantities and line numbers as they stand now.
      const freshPoItems = [];
      for (let i = 0; i < poItemSnaps.length; i++) {
        if (!poItemSnaps[i].exists) throw fail(`Purchase order line '${poItems[i].id}' no longer exists.`, 'PO_ITEM_NOT_FOUND', 404);
        freshPoItems.push(formatDocSnapshot(poItemSnaps[i]));
      }

      // ── Derive the surviving receiving position ──
      const reversedReceiptIds = new Set(existingReversals.map(r => String(r.receipt_id)));
      // The reversal being performed right now counts as effective for this
      // recalculation, even though its record is written later in this same
      // transaction.
      reversedReceiptIds.add(receiptDocId);
      const allReceiptItems = allItemsSnap.docs.map(formatDocSnapshot);
      const effectiveByPoItem = deriveEffectiveReceived(allReceiptItems, reversedReceiptIds);

      // Effective received can never go negative — the derivation sums only
      // non-negative surviving quantities, but assert it rather than assume.
      for (const [poItemId, qty] of effectiveByPoItem.entries()) {
        if (qty < 0) throw fail(`Reversal would make the received quantity of '${poItemId}' negative.`, 'NEGATIVE_RECEIVED_QUANTITY');
      }

      // ══ WRITE PHASE ══
      const movementIds = [];
      let totalReversedQty = 0;
      let totalReversedValue = 0;

      for (let i = 0; i < lineRefs.length; i++) {
        const { item, movementId, movRef, productRef } = lineRefs[i];
        const qty = roundQuantity(item.received_quantity) || 0;

        // Compensating movement through the SHARED ledger core. REVERSAL has
        // sign -1, so this subtracts exactly what the receipt added. The
        // original RECEIPT movement is left untouched.
        const staged = stageMovementInTransaction(txn, {
          movementId,
          movRef,
          movSnap: movSnaps[i],
          productRef,
          prodSnap: productSnaps[i],
          locSnap,
          productId: item.product_id,
          locationId: locationDocId,
          movementType: 'REVERSAL',
          quantity: qty,
          unit: item.unit_snapshot,
          reference_type: 'GOODS_RECEIPT',
          reference_id: receiptDocId,
          reason: `Reversal of ${currentReceipt.receipt_number}: ${cleanReason}`,
          remarks: cleanReason,
          businessDate,
          actor: { uid: actor?.uid || null, name: actor?.name || null },
          idempotency_key: movementId,
          now
        });
        // The compensating movement id is derived from this receipt line, and
        // the marker that says "already reversed" is written in the SAME
        // transaction as that movement — so seeing the movement already
        // present while the receipt is NOT marked reversed means the two have
        // diverged. Abort rather than record a reversal for stock that was
        // never moved.
        if (staged.duplicate) {
          throw fail(
            `A compensating movement already exists for ${currentReceipt.receipt_number} line ${item.line_no}, ` +
            'but the receipt is not marked reversed. Refusing to record a second reversal.',
            'REVERSAL_STATE_INCONSISTENT', 409
          );
        }
        movementIds.push(staged.movement.movement_id);
        totalReversedQty = roundQuantity(totalReversedQty + qty);
        totalReversedValue = roundMoney(totalReversedValue + (Number(item.received_value) || 0));
      }

      // ── Rewrite each PO line from the derived position ──
      for (const poItem of freshPoItems) {
        const ordered = roundQuantity(poItem.ordered_quantity) || 0;
        const effective = roundQuantity(effectiveByPoItem.get(String(poItem.id)) || 0);
        const outstanding = roundQuantity(Math.max(ordered - effective, 0));
        const { variance_type, variance_quantity } = varianceFor(ordered, effective);
        txn.update(orderItemRef(poDocId, poItem.line_no), {
          received_quantity: effective,
          outstanding_quantity: outstanding,
          variance_type,
          variance_quantity,
          last_reversed_at: now
        });
      }

      const nextStatus = deriveOrderStatus(freshPoItems, effectiveByPoItem);
      const history = Array.isArray(currentOrder.status_history) ? [...currentOrder.status_history] : [];
      history.push({
        status: nextStatus, at: now,
        by_uid: actor?.uid || null, by_name: actor?.name || null,
        reversed_receipt_number: currentReceipt.receipt_number, reason: cleanReason
      });

      txn.update(poRef, {
        status: nextStatus,
        status_history: history,
        last_reversal_at: now,
        reversal_count: (Number(currentOrder.reversal_count) || 0) + 1,
        updated_at: now
      });

      // NOTHING is written to the goods receipt or its line items. The receipt
      // is immutable once posted; that a delivery was cancelled is recorded
      // ONLY by the reversal document written below.
      const reversal = {
        reversal_id: reversalDocId,
        receipt_id: receiptDocId,
        receipt_number: currentReceipt.receipt_number,
        purchase_order_id: poDocId,
        purchase_order_number: currentOrder.po_number,
        supplier_id: currentOrder.supplier_id,
        supplier_name_snapshot: currentOrder.supplier_name_snapshot,
        location_id: currentOrder.location_id,
        reversed_by_uid: actor?.uid || null,
        reversed_by_name: actor?.name || null,
        reversed_by_email: actor?.email || null,
        reversed_by_role: actor?.role || null,
        reason: cleanReason,
        stock_movement_ids: movementIds,
        reversed_quantity: totalReversedQty,
        reversed_value: totalReversedValue,
        line_count: lineRefs.length,
        po_status_after: nextStatus,
        status: 'POSTED',
        idempotency_key: String(idempotency_key),
        payload_fingerprint: fingerprint,
        business_date: businessDate,
        reversed_at: now,
        created_at: now
      };
      txn.set(grvRef, reversal);

      return {
        duplicate: false,
        reversal: { ...reversal, id: reversalDocId },
        order: { ...currentOrder, status: nextStatus, status_history: history }
      };
    });

    if (!result.duplicate) {
      await writeAudit('INVENTORY_GOODS_RECEIPT_REVERSED', {
        reversal_id: result.reversal.reversal_id,
        receipt_id: result.reversal.receipt_id,
        receipt_number: result.reversal.receipt_number,
        purchase_order_id: result.reversal.purchase_order_id,
        purchase_order_number: result.reversal.purchase_order_number,
        supplier_id: result.reversal.supplier_id,
        reason: result.reversal.reason,
        reversed_quantity: result.reversal.reversed_quantity,
        reversed_value: result.reversal.reversed_value,
        stock_movement_ids: result.reversal.stock_movement_ids,
        po_status_after: result.reversal.po_status_after
      }, actor, `inv_grv_${result.reversal.reversal_id}`, businessDate);
    }

    return {
      duplicate: result.duplicate,
      reversal: result.reversal,
      order: await getPurchaseOrderByIdFirestore(poDocId)
    };
  },

  /**
   * Closes a partially received purchase order short: the outstanding balance
   * is written off as never arriving.
   *
   * This changes NO stock, creates NO receipt and fabricates NO quantity — it
   * records a purchasing decision plus the shortfall it accepts.
   *
   * @returns {{ duplicate: boolean, order: object }}
   */
  async closeShort(poId, { reason } = {}, actor) {
    const cleanReason = requireReason(reason, 'close a purchase order short');
    const poDocId = formatOrderDocId(poId);
    const poRef = orderRef(poDocId);
    const now = new Date().toISOString();

    const order = await getPurchaseOrderByIdFirestore(poDocId);
    if (!order) throw fail('Purchase order not found.', 'PURCHASE_ORDER_NOT_FOUND', 404);
    const poItems = await getPurchaseOrderItemsFirestore(poDocId);
    if (poItems.length === 0) throw fail('This purchase order has no line items.', 'PO_HAS_NO_ITEMS');
    const poItemRefs = poItems.map(i => orderItemRef(poDocId, i.line_no));
    const businessDate = await resolveBusinessDate(order.business_date);

    const result = await db.runTransaction(async (txn) => {
      // The order AND its lines are re-read here, so a delivery landing at the
      // same moment forces a retry and the shortfall written off is the one
      // that genuinely remains.
      const [snap, itemSnaps] = await Promise.all([
        txn.get(poRef),
        Promise.all(poItemRefs.map(r => txn.get(r)))
      ]);
      if (!snap.exists) throw fail('Purchase order not found.', 'PURCHASE_ORDER_NOT_FOUND', 404);
      const current = formatDocSnapshot(snap);
      const freshPoItems = [];
      for (let i = 0; i < itemSnaps.length; i++) {
        if (!itemSnaps[i].exists) throw fail(`Purchase order line '${poItems[i].id}' no longer exists.`, 'PO_ITEM_NOT_FOUND', 404);
        freshPoItems.push(formatDocSnapshot(itemSnaps[i]));
      }

      // Idempotent: already closed short → return it unchanged.
      if (current.status === PO_STATUS.CLOSED_SHORT) {
        return { duplicate: true, order: current };
      }
      if (current.status !== PO_STATUS.PARTIALLY_RECEIVED) {
        throw fail(
          `Only a PARTIALLY_RECEIVED purchase order can be closed short (this one is ${current.status}).` +
          (current.status === PO_STATUS.RECEIVED ? ' A fully received order has nothing outstanding.' : ''),
          'PO_NOT_SHORT_CLOSEABLE', 409
        );
      }

      // Snapshot exactly what is being written off.
      const outstanding = [];
      let totalOutstanding = 0;
      for (const poItem of freshPoItems) {
        const ordered = roundQuantity(poItem.ordered_quantity) || 0;
        const received = roundQuantity(poItem.received_quantity || 0) || 0;
        const remaining = roundQuantity(Math.max(ordered - received, 0));
        if (remaining > 0) {
          outstanding.push({
            po_item_id: poItem.id,
            sku: poItem.sku_snapshot,
            product_name: poItem.product_name_snapshot,
            unit: poItem.unit_snapshot,
            ordered_quantity: ordered,
            received_quantity: received,
            outstanding_quantity: remaining
          });
          totalOutstanding = roundQuantity(totalOutstanding + remaining);
        }
      }
      if (totalOutstanding <= 0) {
        throw fail('There is nothing outstanding on this purchase order to close short.', 'NOTHING_OUTSTANDING', 409);
      }

      const history = Array.isArray(current.status_history) ? [...current.status_history] : [];
      history.push({
        status: PO_STATUS.CLOSED_SHORT, at: now,
        by_uid: actor?.uid || null, by_name: actor?.name || null,
        reason: cleanReason, outstanding_quantity: totalOutstanding
      });

      const updates = {
        status: PO_STATUS.CLOSED_SHORT,
        status_history: history,
        closed_short_at: now,
        closed_short_by_uid: actor?.uid || null,
        closed_short_by_name: actor?.name || null,
        closed_short_by_email: actor?.email || null,
        close_short_reason: cleanReason,
        closed_short_outstanding: outstanding,
        closed_short_outstanding_quantity: totalOutstanding,
        updated_at: now
      };
      txn.update(poRef, updates);
      return { duplicate: false, order: { ...current, ...updates } };
    });

    if (!result.duplicate) {
      await writeAudit('INVENTORY_PURCHASE_ORDER_CLOSED_SHORT', {
        purchase_order_id: poDocId,
        purchase_order_number: result.order.po_number,
        supplier_id: result.order.supplier_id,
        supplier_name: result.order.supplier_name_snapshot,
        reason: cleanReason,
        outstanding_quantity: result.order.closed_short_outstanding_quantity,
        outstanding_lines: result.order.closed_short_outstanding,
        previous_status: PO_STATUS.PARTIALLY_RECEIVED
      }, actor, `inv_po_closed_short_${poDocId}`, businessDate);
    }

    return { duplicate: result.duplicate, order: await getPurchaseOrderByIdFirestore(poDocId) };
  }
};

export default ReceiptCorrectionService;
