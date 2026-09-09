/**
 * inventoryStockService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONLY place that changes inventory stock balances (Phase A).
 *
 * Source of truth
 *   1. inventory_stock_movements  — append-only ledger (authoritative history)
 *   2. inventory_products.stock_by_location { <location_id>: qty }
 *                                 — per-location balance, derived from (1)
 *   3. inventory_products.current_stock
 *                                 — cached total = Σ stock_by_location
 * (2) and (3) are rewritten inside the SAME Firestore transaction that
 * appends (1); a failure anywhere rolls the whole thing back.
 *
 * Idempotency
 *   The movement document id is derived from `idempotency_key`
 *   (mov_<key>). Re-sending the same key returns the stored movement with
 *   `duplicate: true` and applies NOTHING. Transfers use two deterministic ids
 *   (mov_<key>_out / mov_<key>_in) written atomically.
 *
 * Legacy balances
 *   A product created before Phase A may carry `current_stock` without any
 *   `stock_by_location`. On its first movement that unattributed balance is
 *   migrated into the target location by an explicit OPENING ledger entry
 *   (reason "Legacy balance migrated") inside the same transaction, so the
 *   ledger never disagrees with the balance.
 */

import crypto from 'crypto';
import { db } from '../config/firebaseAdmin.js';
import { formatDocSnapshot, RepositoryError } from '../repositories/firestore/firestoreUtils.js';
import { productDocIdFor, normalizeProductDoc } from '../repositories/firestore/inventoryProductsRepository.js';
import { formatLocationDocId, getDefaultInventoryLocationFirestore } from '../repositories/firestore/inventoryLocationsRepository.js';
import { movementRef, formatMovementDocId } from '../repositories/firestore/inventoryStockMovementsRepository.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import BusinessDateService from './businessDateService.js';
import { MOVEMENT_TYPES, REFERENCE_TYPES, roundQuantity } from '../utils/inventoryConstants.js';

const PRODUCTS = 'inventory_products';
const LOCATIONS = 'inventory_locations';

function fail(message, code, status = 400) {
  return new RepositoryError(message, code, status);
}

function cleanText(v, max = 500) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function sumBalances(map) {
  return roundQuantity(Object.values(map || {}).reduce((acc, v) => acc + (Number(v) || 0), 0)) || 0;
}

async function resolveBusinessDate(explicit) {
  if (explicit && /^\d{4}-\d{2}-\d{2}$/.test(String(explicit))) return String(explicit);
  try {
    const bd = await BusinessDateService.getBusinessDate();
    if (bd && /^\d{4}-\d{2}-\d{2}$/.test(String(bd))) return String(bd);
  } catch { /* fall through */ }
  return new Date().toISOString().split('T')[0];
}

function newMovementId(idempotencyKey) {
  if (idempotencyKey) return formatMovementDocId(idempotencyKey);
  return formatMovementDocId(`${Date.now()}_${crypto.randomUUID().slice(0, 8)}`);
}

function validateReference(reference_type, reference_id) {
  const type = reference_type ? String(reference_type).toUpperCase() : 'MANUAL';
  if (!REFERENCE_TYPES.includes(type)) throw fail(`Invalid reference_type '${reference_type}'`, 'INVALID_REFERENCE_TYPE');
  const id = cleanText(reference_id, 200);
  if (type !== 'MANUAL' && type !== 'TRANSFER' && !id) {
    throw fail(`reference_id is required when reference_type is ${type}`, 'INVALID_REFERENCE_ID');
  }
  return { reference_type: type, reference_id: id };
}

function validateQuantity(movementType, quantity) {
  const q = roundQuantity(quantity);
  if (!Number.isFinite(q)) throw fail('Quantity must be a number', 'INVALID_QUANTITY');
  if (movementType === 'ADJUSTMENT') {
    if (q === 0) throw fail('Adjustment quantity cannot be zero (use a positive or negative decimal)', 'INVALID_QUANTITY');
    return q;
  }
  if (q <= 0) throw fail('Quantity must be greater than zero', 'INVALID_QUANTITY');
  return q;
}

/** Reads + validates product & location inside a transaction. */
function readProduct(snap, productId) {
  if (!snap.exists) throw fail(`Product '${productId}' not found`, 'PRODUCT_NOT_FOUND', 404);
  const product = normalizeProductDoc(formatDocSnapshot(snap));
  if (!product.is_active) throw fail(`Product '${product.sku}' is inactive and cannot receive stock movements`, 'PRODUCT_INACTIVE');
  return product;
}
function readLocation(snap, locationId) {
  if (!snap.exists) throw fail(`Location '${locationId}' not found`, 'LOCATION_NOT_FOUND', 404);
  const location = formatDocSnapshot(snap);
  if (location.is_active === false) throw fail(`Location '${location.name || locationId}' is inactive`, 'LOCATION_INACTIVE');
  return location;
}

function buildMovementDoc({ movementId, product, location, movement_type, quantity, qty_before, qty_after, counterpart_location_id = null, reference_type, reference_id, reason, remarks, business_date, actor, idempotency_key, created_at }) {
  return {
    movement_id: movementId,
    product_id: product.id,
    sku: product.sku,
    product_name: product.name,
    movement_type,
    quantity,
    unit: product.unit_of_measure,
    qty_before,
    qty_after,
    location_id: location.id,
    location_name: location.name || null,
    counterpart_location_id,
    reference_type,
    reference_id,
    reason: reason || null,
    remarks: remarks || null,
    business_date,
    actor_uid: actor.uid,
    actor_name: actor.name,
    idempotency_key: idempotency_key || null,
    created_at
  };
}

/**
 * If a legacy product has a total balance but no per-location map, migrate it
 * into `location` via an explicit OPENING ledger entry. Returns the map to
 * continue from and the extra movement doc (or null).
 */
function migrateLegacyBalance(txn, productRef, product, location, actor, business_date, now) {
  const map = { ...(product.stock_by_location || {}) };
  if (Object.keys(map).length > 0 || !(product.current_stock > 0)) return { map, legacyMovement: null };

  const legacyId = formatMovementDocId(`legacy_${product.id}`);
  const legacyRef = movementRef(legacyId);
  const legacyMovement = buildMovementDoc({
    movementId: legacyId, product, location,
    movement_type: 'OPENING', quantity: product.current_stock, qty_before: 0, qty_after: product.current_stock,
    reference_type: 'MANUAL', reference_id: null,
    reason: 'Legacy balance migrated', remarks: 'Pre-Phase-A balance attributed to this location on first movement',
    business_date, actor, idempotency_key: `legacy_${product.id}`, created_at: now
  });
  txn.set(legacyRef, legacyMovement);
  map[location.id] = product.current_stock;
  return { map, legacyMovement };
}

export async function writeAudit(action, movement, actor) {
  try {
    await createAuditLogFirestore({
      log_id: `inv_${movement.movement_id}`,
      action,
      details: {
        movement_id: movement.movement_id,
        product_id: movement.product_id,
        sku: movement.sku,
        movement_type: movement.movement_type,
        quantity: movement.quantity,
        unit: movement.unit,
        qty_before: movement.qty_before,
        qty_after: movement.qty_after,
        location_id: movement.location_id,
        counterpart_location_id: movement.counterpart_location_id,
        reference_type: movement.reference_type,
        reference_id: movement.reference_id,
        reason: movement.reason
      },
      user_id: actor.uid || 'unknown',
      business_date: movement.business_date
    });
  } catch (err) {
    console.warn(`[Inventory] audit log failed for ${movement.movement_id}: ${err.message}`);
  }
}

function normalizeActor(actor_uid, actor_name) {
  return { uid: cleanText(actor_uid, 128), name: cleanText(actor_name, 200) };
}

/**
 * THE shared in-transaction ledger core.
 *
 * Every stock mutation in the system funnels through this one function, so
 * there is exactly one implementation of the balance math, the legacy-balance
 * migration, the negative-stock guard and the legacy field mirrors.
 *
 * It performs only WRITES: the caller must have already fetched `movSnap`,
 * `prodSnap` and `locSnap` inside the same transaction, because Firestore
 * requires every read to precede every write. That split is what lets a caller
 * combine a stock movement with other documents — a goods receipt, its lines
 * and the purchase-order state — in ONE atomic transaction, instead of opening
 * a second (impossible) nested transaction.
 *
 * @returns {{ duplicate: boolean, movement: object, product: object }}
 */
export function stageMovementInTransaction(txn, {
  movementId, movRef, movSnap, productRef, prodSnap, locSnap,
  productId, locationId, movementType, quantity, unit = null,
  reference_type = 'MANUAL', reference_id = null, reason = null, remarks = null,
  businessDate, actor, idempotency_key = null, now
}) {
  // Idempotent replay: this exact movement id was already committed.
  if (movSnap.exists) {
    return {
      duplicate: true,
      movement: formatDocSnapshot(movSnap),
      product: prodSnap.exists ? normalizeProductDoc(formatDocSnapshot(prodSnap)) : null
    };
  }

  const product = readProduct(prodSnap, productId);
  const location = readLocation(locSnap, locationId);
  if (unit && String(unit).trim().toUpperCase() !== product.unit_of_measure) {
    throw fail(`Unit '${unit}' does not match product unit '${product.unit_of_measure}' (unit conversion is not supported yet)`, 'UNIT_MISMATCH');
  }

  const { map } = migrateLegacyBalance(txn, productRef, product, location, actor, businessDate, now);
  const before = roundQuantity(map[location.id] || 0) || 0;
  const delta = MOVEMENT_TYPES[movementType].sign === 0 ? quantity : MOVEMENT_TYPES[movementType].sign * Math.abs(quantity);
  const after = roundQuantity(before + delta);
  if (after < 0) {
    throw fail(
      `Insufficient stock for '${product.sku}' at ${location.name}: available ${before} ${product.unit_of_measure}, requested ${Math.abs(delta)}`,
      'INSUFFICIENT_STOCK'
    );
  }

  const newMap = { ...map, [location.id]: after };
  const total = sumBalances(newMap);
  const movement = buildMovementDoc({
    movementId, product, location, movement_type: movementType, quantity,
    qty_before: before, qty_after: after,
    reference_type, reference_id,
    reason: cleanText(reason, 200), remarks: cleanText(remarks, 1000),
    business_date: businessDate, actor, idempotency_key, created_at: now
  });

  txn.set(movRef, movement);
  txn.update(productRef, {
    stock_by_location: newMap, current_stock: total, stock_quantity: total,
    last_movement_at: now, updated_at: now
  });

  return { duplicate: false, movement, product: { ...product, stock_by_location: newMap, current_stock: total, last_movement_at: now } };
}

export const InventoryStockService = {

  /**
   * Apply ONE stock movement (OPENING, ADJUSTMENT, RECEIPT, RETURN,
   * CONSUMPTION, WASTAGE). Transfers must use transfer().
   *
   * @returns {{ duplicate: boolean, movement: object, product: object }}
   */
  async applyMovement({
    product_id, location_id = null, movement_type, quantity, unit = null,
    reference_type = 'MANUAL', reference_id = null, reason = null, remarks = null,
    actor_uid = null, actor_name = null, idempotency_key = null, business_date = null
  } = {}) {
    const type = String(movement_type || '').toUpperCase();
    if (!MOVEMENT_TYPES[type]) throw fail(`Invalid movement_type '${movement_type}'`, 'INVALID_MOVEMENT_TYPE');
    if (type === 'TRANSFER_IN' || type === 'TRANSFER_OUT') throw fail('Use transfer() for transfers so both sides are written atomically', 'USE_TRANSFER');
    if (!product_id) throw fail('product_id is required', 'PRODUCT_REQUIRED');

    const qty = validateQuantity(type, quantity);
    const ref = validateReference(reference_type, reference_id);
    const actor = normalizeActor(actor_uid, actor_name);
    const bdate = await resolveBusinessDate(business_date);

    let locId = location_id ? formatLocationDocId(location_id) : null;
    if (!locId) {
      const def = await getDefaultInventoryLocationFirestore();
      if (!def) throw fail('location_id is required (no default inventory location is configured)', 'LOCATION_REQUIRED');
      locId = def.id;
    }

    const movementId = newMovementId(idempotency_key);
    const productRef = db.collection(PRODUCTS).doc(productDocIdFor(product_id));
    const locationRef = db.collection(LOCATIONS).doc(locId);
    const movRef = movementRef(movementId);
    const now = new Date().toISOString();

    const result = await db.runTransaction(async (txn) => {
      const [movSnap, prodSnap, locSnap] = await Promise.all([txn.get(movRef), txn.get(productRef), txn.get(locationRef)]);
      return stageMovementInTransaction(txn, {
        movementId, movRef, movSnap, productRef, prodSnap, locSnap,
        productId: product_id, locationId: locId, movementType: type, quantity: qty, unit,
        reference_type: ref.reference_type, reference_id: ref.reference_id,
        reason, remarks, businessDate: bdate, actor, idempotency_key, now
      });
    });

    if (!result.duplicate) await writeAudit(`INVENTORY_${type}`, result.movement, actor);
    return result;
  },

  /**
   * Atomic transfer between two locations: TRANSFER_OUT at source and
   * TRANSFER_IN at destination in one transaction. Never partial.
   */
  async transfer({
    product_id, from_location_id, to_location_id, quantity,
    reason = null, remarks = null, actor_uid = null, actor_name = null,
    idempotency_key = null, business_date = null, reference_id = null
  } = {}) {
    if (!product_id) throw fail('product_id is required', 'PRODUCT_REQUIRED');
    if (!from_location_id || !to_location_id) throw fail('from_location_id and to_location_id are required', 'LOCATION_REQUIRED');
    const fromId = formatLocationDocId(from_location_id);
    const toId = formatLocationDocId(to_location_id);
    if (fromId === toId) throw fail('Source and destination locations must differ', 'SAME_LOCATION');

    const qty = validateQuantity('TRANSFER_OUT', quantity);
    const actor = normalizeActor(actor_uid, actor_name);
    const bdate = await resolveBusinessDate(business_date);
    const key = idempotency_key || `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const outId = formatMovementDocId(`${key}_out`);
    const inId = formatMovementDocId(`${key}_in`);

    const productRef = db.collection(PRODUCTS).doc(productDocIdFor(product_id));
    const fromRef = db.collection(LOCATIONS).doc(fromId);
    const toRef = db.collection(LOCATIONS).doc(toId);
    const outRef = movementRef(outId);
    const inRef = movementRef(inId);
    const now = new Date().toISOString();

    const result = await db.runTransaction(async (txn) => {
      const [outSnap, inSnap, prodSnap, fromSnap, toSnap] = await Promise.all([
        txn.get(outRef), txn.get(inRef), txn.get(productRef), txn.get(fromRef), txn.get(toRef)
      ]);
      if (outSnap.exists && inSnap.exists) {
        return { duplicate: true, out_movement: formatDocSnapshot(outSnap), in_movement: formatDocSnapshot(inSnap), product: prodSnap.exists ? normalizeProductDoc(formatDocSnapshot(prodSnap)) : null };
      }
      if (outSnap.exists !== inSnap.exists) {
        throw fail(`Transfer '${key}' is in an inconsistent state (one side recorded). Use a new idempotency key.`, 'TRANSFER_INCONSISTENT', 409);
      }
      const product = readProduct(prodSnap, product_id);
      const fromLoc = readLocation(fromSnap, fromId);
      const toLoc = readLocation(toSnap, toId);

      const { map } = migrateLegacyBalance(txn, productRef, product, fromLoc, actor, bdate, now);
      const beforeFrom = roundQuantity(map[fromLoc.id] || 0) || 0;
      const afterFrom = roundQuantity(beforeFrom - qty);
      if (afterFrom < 0) throw fail(`Insufficient stock for '${product.sku}' at ${fromLoc.name}: available ${beforeFrom} ${product.unit_of_measure}, requested ${qty}`, 'INSUFFICIENT_STOCK');
      const beforeTo = roundQuantity(map[toLoc.id] || 0) || 0;
      const afterTo = roundQuantity(beforeTo + qty);

      const newMap = { ...map, [fromLoc.id]: afterFrom, [toLoc.id]: afterTo };
      const total = sumBalances(newMap);
      const common = {
        product, reference_type: 'TRANSFER', reference_id: cleanText(reference_id, 200) || key,
        reason: cleanText(reason, 200), remarks: cleanText(remarks, 1000), business_date: bdate, actor, created_at: now
      };
      const outMovement = buildMovementDoc({ ...common, movementId: outId, location: fromLoc, movement_type: 'TRANSFER_OUT', quantity: qty, qty_before: beforeFrom, qty_after: afterFrom, counterpart_location_id: toLoc.id, idempotency_key: `${key}_out` });
      const inMovement = buildMovementDoc({ ...common, movementId: inId, location: toLoc, movement_type: 'TRANSFER_IN', quantity: qty, qty_before: beforeTo, qty_after: afterTo, counterpart_location_id: fromLoc.id, idempotency_key: `${key}_in` });

      txn.set(outRef, outMovement);
      txn.set(inRef, inMovement);
      txn.update(productRef, { stock_by_location: newMap, current_stock: total, stock_quantity: total, last_movement_at: now, updated_at: now });
      return { duplicate: false, out_movement: outMovement, in_movement: inMovement, product: { ...product, stock_by_location: newMap, current_stock: total, last_movement_at: now } };
    });

    if (!result.duplicate) {
      await writeAudit('INVENTORY_TRANSFER_OUT', result.out_movement, actor);
      await writeAudit('INVENTORY_TRANSFER_IN', result.in_movement, actor);
    }
    return result;
  }
};

export default InventoryStockService;
