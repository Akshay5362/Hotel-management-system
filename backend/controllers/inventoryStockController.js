/**
 * inventoryStockController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Current stock, stock movements (ledger) and Phase A movement entry points:
 *   GET  /stock                        – paginated balances with status
 *   GET  /movements                    – ledger with filters + cursor paging
 *   GET  /products/:id/movements       – ledger for one product
 *   POST /products/:id/opening-stock   – OPENING movement (MANAGE roles)
 *   POST /movements                    – ADJUSTMENT or TRANSFER (MOVE roles)
 *
 * All balance changes go through inventoryStockService (transactional).
 */

import { InventoryCutoverService } from '../services/inventoryCutoverService.js';
import { InventoryStockService } from '../services/inventoryStockService.js';
import { listInventoryMovementsFirestore } from '../repositories/firestore/inventoryStockMovementsRepository.js';
import { getInventoryProductByIdFirestore } from '../repositories/firestore/inventoryProductsRepository.js';
import { getActor, sendError } from './inventoryController.js';
import { PHASE_A_MOVEMENT_TYPES, ALL_MOVEMENT_TYPES } from '../utils/inventoryConstants.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/** GET /api/inventory/stock */
export const getStock = async (req, res) => {
  try {
    const result = await InventoryCutoverService.getStock(req.query);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Failed to load stock');
  }
};

function movementFilters(query, productId = null) {
  const errors = [];
  const f = {
    product_id: productId || query.product_id || null,
    location_id: query.location_id || null,
    movement_type: query.movement_type ? String(query.movement_type).toUpperCase() : null,
    from: query.from || null,
    to: query.to || null,
    limit: query.limit || query.page_size,
    cursor: query.cursor || null
  };
  if (f.movement_type && !ALL_MOVEMENT_TYPES.includes(f.movement_type)) errors.push(`Invalid movement_type '${query.movement_type}'.`);
  if (f.from && !ISO_DATE.test(String(f.from))) errors.push('from must be YYYY-MM-DD.');
  if (f.to && !ISO_DATE.test(String(f.to))) errors.push('to must be YYYY-MM-DD.');
  return { errors, filters: f };
}

/** GET /api/inventory/movements */
export const getMovements = async (req, res) => {
  const { errors, filters } = movementFilters(req.query);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });
  try {
    if (filters.product_id) {
      const product = await getInventoryProductByIdFirestore(filters.product_id);
      if (!product) return res.status(404).json({ error: 'Product not found.' });
      filters.product_id = product.id;
    }
    const result = await listInventoryMovementsFirestore(filters);
    return res.json({ movements: result.items, next_cursor: result.next_cursor, limit: result.limit });
  } catch (error) {
    return sendError(res, error, 'Failed to load stock movements');
  }
};

/** GET /api/inventory/products/:id/movements */
export const getProductMovements = async (req, res) => {
  const { errors, filters } = movementFilters(req.query, req.params.id);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });
  try {
    const product = await getInventoryProductByIdFirestore(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    filters.product_id = product.id;
    const result = await listInventoryMovementsFirestore(filters);
    return res.json({ product_id: product.id, movements: result.items, next_cursor: result.next_cursor, limit: result.limit });
  } catch (error) {
    return sendError(res, error, 'Failed to load product movements');
  }
};

/** POST /api/inventory/products/:id/opening-stock  { location_id, quantity, remarks, idempotency_key } */
export const postOpeningStock = async (req, res) => {
  const b = req.body || {};
  const errors = [];
  if (!(Number(b.quantity) > 0)) errors.push('Quantity must be greater than zero.');
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });
  try {
    const actor = getActor(req);
    const result = await InventoryStockService.applyMovement({
      product_id: req.params.id,
      location_id: b.location_id || null,
      movement_type: 'OPENING',
      quantity: b.quantity,
      unit: b.unit || null,
      reference_type: 'MANUAL',
      reason: b.reason || 'Opening stock',
      remarks: b.remarks || null,
      actor_uid: actor.uid,
      actor_name: actor.name,
      idempotency_key: b.idempotency_key || null,
      business_date: b.business_date || null
    });
    return res.status(result.duplicate ? 200 : 201).json({
      message: result.duplicate ? 'Movement already recorded (idempotent replay).' : 'Opening stock recorded.',
      duplicate: result.duplicate,
      movement: result.movement,
      product: result.product
    });
  } catch (error) {
    return sendError(res, error, 'Failed to record opening stock');
  }
};

/**
 * POST /api/inventory/movements
 *   { movement_type: 'ADJUSTMENT', product_id, location_id, quantity (signed), reason, remarks, idempotency_key }
 *   { movement_type: 'TRANSFER',   product_id, from_location_id, to_location_id, quantity, reason, remarks, idempotency_key }
 * OPENING must use /products/:id/opening-stock (MANAGE roles only).
 * RECEIPT / CONSUMPTION / WASTAGE / RETURN are reserved for later phases.
 */
export const postMovement = async (req, res) => {
  const b = req.body || {};
  const type = String(b.movement_type || '').toUpperCase();
  const errors = [];

  if (!type) errors.push('movement_type is required.');
  else if (type === 'TRANSFER_IN' || type === 'TRANSFER_OUT') errors.push("Use movement_type 'TRANSFER' with from_location_id/to_location_id; both sides are written atomically.");
  else if (type === 'OPENING') errors.push('Opening stock must be posted to /products/:id/opening-stock.');
  else if (type !== 'TRANSFER' && !PHASE_A_MOVEMENT_TYPES.includes(type)) {
    errors.push(ALL_MOVEMENT_TYPES.includes(type)
      ? `movement_type '${type}' is reserved for a later phase and cannot be posted manually yet.`
      : `Invalid movement_type '${b.movement_type}'.`);
  }
  if (!b.product_id) errors.push('product_id is required.');
  if (b.quantity === undefined || b.quantity === null || b.quantity === '' || !Number.isFinite(Number(b.quantity))) errors.push('quantity must be a number.');
  if (type === 'TRANSFER') {
    if (!b.from_location_id || !b.to_location_id) errors.push('from_location_id and to_location_id are required for a transfer.');
    if (b.from_location_id && b.to_location_id && String(b.from_location_id) === String(b.to_location_id)) errors.push('Source and destination locations must differ.');
    if (!(Number(b.quantity) > 0)) errors.push('Transfer quantity must be greater than zero.');
  }
  if (type === 'ADJUSTMENT') {
    if (Number(b.quantity) === 0) errors.push('Adjustment quantity cannot be zero.');
    if (!b.location_id) errors.push('location_id is required for an adjustment.');
    if (!b.reason || !String(b.reason).trim()) errors.push('A reason is required for an adjustment.');
  }
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const actor = getActor(req);
    if (type === 'TRANSFER') {
      const result = await InventoryStockService.transfer({
        product_id: b.product_id,
        from_location_id: b.from_location_id,
        to_location_id: b.to_location_id,
        quantity: b.quantity,
        reason: b.reason || null,
        remarks: b.remarks || null,
        reference_id: b.reference_id || null,
        actor_uid: actor.uid,
        actor_name: actor.name,
        idempotency_key: b.idempotency_key || null,
        business_date: b.business_date || null
      });
      return res.status(result.duplicate ? 200 : 201).json({
        message: result.duplicate ? 'Transfer already recorded (idempotent replay).' : 'Transfer recorded.',
        duplicate: result.duplicate,
        movements: [result.out_movement, result.in_movement],
        product: result.product
      });
    }

    const result = await InventoryStockService.applyMovement({
      product_id: b.product_id,
      location_id: b.location_id,
      movement_type: type,
      quantity: b.quantity,
      unit: b.unit || null,
      reference_type: b.reference_type || 'MANUAL',
      reference_id: b.reference_id || null,
      reason: b.reason || null,
      remarks: b.remarks || null,
      actor_uid: actor.uid,
      actor_name: actor.name,
      idempotency_key: b.idempotency_key || null,
      business_date: b.business_date || null
    });
    return res.status(result.duplicate ? 200 : 201).json({
      message: result.duplicate ? 'Movement already recorded (idempotent replay).' : 'Movement recorded.',
      duplicate: result.duplicate,
      movement: result.movement,
      product: result.product
    });
  } catch (error) {
    return sendError(res, error, 'Failed to record movement');
  }
};
