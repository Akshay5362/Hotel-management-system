/**
 * goodsReceiptController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP layer for Phase F goods receiving, mounted under
 * /api/inventory/purchase-orders/:id/receipts.
 *
 * Receiving is the only purchasing action that changes stock, so authorization
 * is enforced on the route (RECEIVING_ROLES) and the service re-validates the
 * purchase order's state inside the transaction. The frontend is never the
 * boundary.
 *
 * No invoice upload, no OCR, no payment and no ledger/invoice writes — a
 * receipt changes inventory stock, the purchase order's receiving state, the
 * goods-receipt records and the audit trail, and nothing else.
 */

import { GoodsReceiptService } from '../services/goodsReceiptService.js';
import { getActor, sendError } from './inventoryController.js';
import { normalizeUserRole } from './authController.js';

function receiptActor(req) {
  const actor = getActor(req);
  return { ...actor, role: normalizeUserRole(req.user) };
}

/**
 * POST /api/inventory/purchase-orders/:id/receipts
 * { idempotency_key, remarks?, lines: [{ po_item_id, received_quantity, variance_reason? }] }
 */
export const createGoodsReceipt = async (req, res) => {
  const b = req.body || {};
  const errors = [];
  if (!b.idempotency_key || !String(b.idempotency_key).trim()) {
    errors.push('idempotency_key is required so a retried delivery cannot post stock twice.');
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0) {
    errors.push('lines must be a non-empty array of items being received.');
  } else {
    b.lines.forEach((l, i) => {
      if (!l || typeof l !== 'object') { errors.push(`lines[${i}] must be an object.`); return; }
      if (!l.po_item_id) errors.push(`lines[${i}].po_item_id is required.`);
      const q = Number(l.received_quantity);
      if (l.received_quantity === undefined || l.received_quantity === null || l.received_quantity === '' || !Number.isFinite(q)) {
        errors.push(`lines[${i}].received_quantity must be a number.`);
      } else if (q <= 0) {
        errors.push(`lines[${i}].received_quantity must be greater than zero (omit lines not in this delivery).`);
      }
    });
  }
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const result = await GoodsReceiptService.receive(req.params.id, {
      idempotency_key: b.idempotency_key,
      remarks: b.remarks,
      lines: b.lines
    }, receiptActor(req));

    return res.status(result.duplicate ? 200 : 201).json({
      message: result.duplicate
        ? `This delivery was already recorded as ${result.receipt.receipt_number} — stock was not posted again.`
        : `Goods receipt ${result.receipt.receipt_number} posted. Purchase order is now ${result.order.status}.`,
      duplicate: result.duplicate,
      receipt: result.receipt,
      order: result.order
    });
  } catch (error) {
    return sendError(res, error, 'Failed to record goods receipt');
  }
};

/** GET /api/inventory/purchase-orders/:id/receipts — delivery history. */
export const getGoodsReceiptsForOrder = async (req, res) => {
  try {
    const result = await GoodsReceiptService.listForOrder(req.params.id);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Failed to load goods receipts');
  }
};
