/**
 * receiptCorrectionController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP layer for Phase G corrections:
 *
 *   POST /api/inventory/purchase-orders/:id/receipts/:receiptId/reverse
 *   POST /api/inventory/purchase-orders/:id/close-short
 *
 * Both are narrower than receiving. A receptionist may sign for a delivery
 * (Phase F, RECEIVING_ROLES) but may not undo one or abandon the remainder of
 * an order — those decisions carry lasting inventory and purchasing
 * consequences, so the route guard is REVERSE / SHORT_CLOSE (admin,
 * super_admin) and the server returns 403 regardless of what the UI shows.
 *
 * No stock arithmetic lives here. The service owns the transaction; this layer
 * validates the request shape and maps the result onto HTTP.
 */

import { ReceiptCorrectionService } from '../services/receiptCorrectionService.js';
import { getActor, sendError } from './inventoryController.js';
import { normalizeUserRole } from './authController.js';

function correctionActor(req) {
  const actor = getActor(req);
  return {
    ...actor,
    role: normalizeUserRole(req.user),
    email: (req.user || {}).email || null
  };
}

/**
 * POST /api/inventory/purchase-orders/:id/receipts/:receiptId/reverse
 * { idempotency_key, reason }
 *
 * Reverses the WHOLE receipt. Phase G has no per-line reversal, so the body
 * carries no quantities — accepting some would imply a partial reversal the
 * service cannot honour.
 */
export const reverseGoodsReceipt = async (req, res) => {
  const b = req.body || {};
  const errors = [];
  if (!b.idempotency_key || !String(b.idempotency_key).trim()) {
    errors.push('idempotency_key is required so a retried reversal cannot reverse stock twice.');
  }
  if (!b.reason || !String(b.reason).trim()) {
    errors.push('reason is required — a reversal must record why the receipt was undone.');
  }
  if (Array.isArray(b.lines) && b.lines.length > 0) {
    errors.push('Per-line reversal is not supported. A reversal cancels the entire receipt.');
  }
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const result = await ReceiptCorrectionService.reverseReceipt(
      req.params.id,
      req.params.receiptId,
      { idempotency_key: b.idempotency_key, reason: b.reason },
      correctionActor(req)
    );

    return res.status(result.duplicate ? 200 : 201).json({
      message: result.duplicate
        ? `This reversal was already applied to ${result.reversal.receipt_number} — stock was not reversed again.`
        : `Goods receipt ${result.reversal.receipt_number} reversed. Purchase order is now ${result.order.status}.`,
      duplicate: result.duplicate,
      reversal: result.reversal,
      order: result.order
    });
  } catch (error) {
    return sendError(res, error, 'Failed to reverse goods receipt');
  }
};

/**
 * POST /api/inventory/purchase-orders/:id/close-short   { reason }
 *
 * Writes off the outstanding balance of a partially received order. No stock
 * moves and no receipt is created — the quantities already received stand
 * exactly as they are.
 */
export const closePurchaseOrderShort = async (req, res) => {
  const b = req.body || {};
  if (!b.reason || !String(b.reason).trim()) {
    return res.status(400).json({
      error: 'reason is required — closing an order short must record why the balance will not arrive.',
      code: 'CORRECTION_REASON_REQUIRED'
    });
  }

  try {
    const result = await ReceiptCorrectionService.closeShort(req.params.id, { reason: b.reason }, correctionActor(req));
    return res.json({
      message: result.duplicate
        ? `Purchase order ${result.order.po_number} was already closed short.`
        : `Purchase order ${result.order.po_number} closed short. ` +
          `${result.order.closed_short_outstanding_quantity} outstanding written off.`,
      duplicate: result.duplicate,
      order: result.order
    });
  } catch (error) {
    return sendError(res, error, 'Failed to close purchase order short');
  }
};
