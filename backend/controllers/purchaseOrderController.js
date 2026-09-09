/**
 * purchaseOrderController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP layer for Phase E purchase orders, mounted under
 * /api/inventory/purchase-orders (see routes/inventoryRoutes.js).
 *
 * Authorization is the MANAGE role set (admin / super_admin) on every route.
 * That is intentionally narrower than the Phase B REQUEST set: a purchase
 * order carries supplier identity and pricing, and Phase A already restricted
 * supplier data to MANAGE roles — raising a request must not imply the right
 * to commit the hotel to a supplier.
 *
 * Nothing here touches stock. Receiving is Phase F.
 */

import { PurchaseOrderService } from '../services/purchaseOrderService.js';
import { getActor, sendError } from './inventoryController.js';
import { normalizeUserRole } from './authController.js';
import { ALL_PO_STATUSES, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../utils/inventoryConstants.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function orderActor(req) {
  const actor = getActor(req);
  return { ...actor, role: normalizeUserRole(req.user) };
}

/** GET /api/inventory/purchase-orders */
export const getPurchaseOrders = async (req, res) => {
  const q = req.query || {};
  const errors = [];
  if (q.status && !ALL_PO_STATUSES.includes(String(q.status).toUpperCase())) {
    errors.push(`status must be one of: ${ALL_PO_STATUSES.join(', ')}.`);
  }
  if (q.from && !ISO_DATE.test(String(q.from))) errors.push('from must be YYYY-MM-DD.');
  if (q.to && !ISO_DATE.test(String(q.to))) errors.push('to must be YYYY-MM-DD.');
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const limit = Math.min(Math.max(parseInt(q.limit || q.page_size, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const result = await PurchaseOrderService.list({
      status: q.status ? String(q.status).toUpperCase() : null,
      supplier_id: q.supplier_id || null,
      source_request_id: q.source_request_id || null,
      location_id: q.location_id || null,
      department: q.department || null,
      po_number: q.po_number || null,
      from: q.from || null,
      to: q.to || null,
      limit,
      cursor: q.cursor || null
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Failed to load purchase orders');
  }
};

/** GET /api/inventory/purchase-orders/:id */
export const getPurchaseOrderById = async (req, res) => {
  try {
    const order = await PurchaseOrderService.getById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Purchase order not found.' });
    return res.json({ order });
  } catch (error) {
    return sendError(res, error, 'Failed to load purchase order');
  }
};

/**
 * POST /api/inventory/purchase-orders   { source_request_id, remarks? }
 * Creates the single purchase order for an APPROVED request. Retry-safe: a
 * repeat call returns the existing order rather than creating a second one.
 */
export const createPurchaseOrder = async (req, res) => {
  const b = req.body || {};
  if (!b.source_request_id) {
    return res.status(400).json({ error: 'source_request_id is required.', code: 'SOURCE_REQUEST_REQUIRED' });
  }
  try {
    const result = await PurchaseOrderService.createFromRequest(b.source_request_id, orderActor(req), { remarks: b.remarks });
    return res.status(result.duplicate ? 200 : 201).json({
      message: result.duplicate
        ? `A purchase order already exists for this request (${result.order.po_number}).`
        : `Purchase order ${result.order.po_number} created.`,
      duplicate: result.duplicate,
      order: result.order
    });
  } catch (error) {
    return sendError(res, error, 'Failed to create purchase order');
  }
};

/** POST /api/inventory/purchase-orders/:id/issue */
export const issuePurchaseOrder = async (req, res) => {
  try {
    const result = await PurchaseOrderService.issue(req.params.id, orderActor(req), { remarks: (req.body || {}).remarks });
    return res.json({
      message: result.duplicate
        ? 'Purchase order was already issued.'
        : `Purchase order ${result.order.po_number} issued.`,
      duplicate: result.duplicate,
      order: result.order
    });
  } catch (error) {
    return sendError(res, error, 'Failed to issue purchase order');
  }
};
