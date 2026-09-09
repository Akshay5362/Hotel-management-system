/**
 * purchaseRequestService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase B — PURCHASE REQUEST workflow.
 *
 * ARCHITECTURE RULE (enforced by this file's contents, not just by comment):
 *   REQUEST ≠ ORDER ≠ RECEIPT ≠ STOCK ADDITION ≠ PAYMENT
 *   A purchase request records that a department is ASKING to buy something.
 *   It therefore NEVER touches a stock balance, the movement ledger, the
 *   guest ledger, payments or invoices. This module deliberately does not
 *   import inventoryStockService — creating, editing, submitting or
 *   cancelling a request cannot change inventory by construction.
 *
 * Estimated costs are snapshots of the product's cost_price for human review
 * only. They are not a financial posting; the Purchase Order / Receiving
 * phases determine real amounts.
 *
 * State machine (Phase B):
 *   DRAFT ──submit──▶ PENDING_APPROVAL   (terminal for Phase B)
 *   DRAFT ──cancel──▶ CANCELLED
 *   PENDING_APPROVAL is IMMUTABLE here — no edit, no cancel. Approval and
 *   rejection belong to Phase C and have no endpoint yet.
 */

import crypto from 'crypto';
import { db } from '../config/firebaseAdmin.js';
import { formatDocSnapshot, RepositoryError } from '../repositories/firestore/firestoreUtils.js';
import {
  REQUESTS_COLLECTION,
  formatRequestDocId,
  requestRef,
  getPurchaseRequestByIdFirestore,
  getPurchaseRequestItemsFirestore,
  listPurchaseRequestsFirestore,
  replacePurchaseRequestItemsFirestore
} from '../repositories/firestore/purchaseRequestsRepository.js';
import { getInventoryProductByIdFirestore, normalizeProductDoc } from '../repositories/firestore/inventoryProductsRepository.js';
import { getInventoryLocationByIdFirestore } from '../repositories/firestore/inventoryLocationsRepository.js';
import { getAllInventoryCategoriesFirestore } from '../repositories/firestore/inventoryCategoriesRepository.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { reserveNumberInTransaction, resolveBusinessDate } from './inventoryNumberService.js';
import {
  PR_STATUS, PR_TRANSITIONS, PR_PRIORITIES, DEFAULT_PR_PRIORITY,
  MAX_REQUEST_QUANTITY, MAX_REQUEST_LINES,
  roundQuantity, roundMoney
} from '../utils/inventoryConstants.js';

const PR_NUMBER_PREFIX = 'PR';

function fail(message, code, status = 400) {
  return new RepositoryError(message, code, status);
}

function cleanText(v, max = 1000) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function newRequestKey(idempotencyKey) {
  if (idempotencyKey) return formatRequestDocId(idempotencyKey);
  return formatRequestDocId(`${Date.now()}_${crypto.randomUUID().slice(0, 8)}`);
}

/** DRAFT may be edited/cancelled only by its creator, or by an admin. */
function assertCanMutate(request, actor) {
  const isOwner = request.requested_by_uid && String(request.requested_by_uid) === String(actor.uid);
  const isAdmin = actor.role === 'admin' || actor.role === 'super_admin';
  if (!isOwner && !isAdmin) {
    throw fail('You can only modify purchase requests that you created.', 'NOT_REQUEST_OWNER', 403);
  }
}

function assertTransition(from, to) {
  const allowed = PR_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw fail(
      `A ${from} purchase request cannot become ${to}.` +
      (from === PR_STATUS.PENDING_APPROVAL ? ' Submitted requests are immutable until the approval phase.' : ''),
      'INVALID_STATUS_TRANSITION',
      409
    );
  }
}

/**
 * Validates and normalizes the requested line items against live master data,
 * snapshotting product/category/unit/stock so a later rename or price change
 * never rewrites history.
 *
 * Duplicate product lines are MERGED deterministically: quantities are summed,
 * the first line's remarks win, and the merged result is returned to the
 * caller (and shown in the UI) rather than silently discarded.
 */
async function buildLines(rawItems, { unitMustMatch = true } = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw fail('A purchase request needs at least one item.', 'NO_ITEMS');
  }
  if (rawItems.length > MAX_REQUEST_LINES) {
    throw fail(`A purchase request cannot exceed ${MAX_REQUEST_LINES} lines.`, 'TOO_MANY_LINES');
  }

  const categories = await getAllInventoryCategoriesFirestore({ includeInactive: true });
  const catMap = new Map();
  for (const c of categories) {
    catMap.set(String(c.id), c);
    if (c.mysql_category_id !== undefined && c.mysql_category_id !== null) catMap.set(String(c.mysql_category_id), c);
  }

  const merged = new Map();   // product doc id → line
  const now = new Date().toISOString();

  for (const raw of rawItems) {
    const productId = raw?.product_id;
    if (!productId) throw fail('Every request line needs a product_id.', 'PRODUCT_REQUIRED');

    const qty = roundQuantity(raw.requested_quantity);
    if (!Number.isFinite(qty)) throw fail(`Requested quantity for '${productId}' must be a number.`, 'INVALID_QUANTITY');
    if (qty <= 0) throw fail(`Requested quantity for '${productId}' must be greater than zero.`, 'INVALID_QUANTITY');
    if (qty > MAX_REQUEST_QUANTITY) throw fail(`Requested quantity for '${productId}' exceeds the maximum of ${MAX_REQUEST_QUANTITY}.`, 'QUANTITY_TOO_LARGE');

    const doc = await getInventoryProductByIdFirestore(productId);
    if (!doc) throw fail(`Product '${productId}' does not exist.`, 'PRODUCT_NOT_FOUND', 404);
    const product = normalizeProductDoc(doc);
    if (!product.is_active) throw fail(`Product '${product.sku}' is inactive and cannot be requested.`, 'PRODUCT_INACTIVE');

    if (unitMustMatch && raw.unit) {
      const supplied = String(raw.unit).trim().toUpperCase();
      if (supplied !== product.unit_of_measure) {
        throw fail(`Unit '${raw.unit}' does not match the configured unit '${product.unit_of_measure}' for '${product.sku}'.`, 'UNIT_MISMATCH');
      }
    }

    const cat = product.category_id ? catMap.get(String(product.category_id)) : null;
    const unitCost = roundMoney(product.cost_price || 0) || 0;

    const existing = merged.get(product.id);
    if (existing) {
      // Deterministic merge of duplicate product lines.
      existing.requested_quantity = roundQuantity(existing.requested_quantity + qty);
      existing.estimated_total = roundMoney(existing.requested_quantity * existing.estimated_unit_cost);
      existing.merged_line_count = (existing.merged_line_count || 1) + 1;
      if (!existing.remarks) existing.remarks = cleanText(raw.remarks, 500);
      continue;
    }

    merged.set(product.id, {
      product_id: product.id,
      sku: product.sku,
      product_name_snapshot: product.name,
      category_id: cat ? cat.id : (product.category_id || null),
      category_name_snapshot: cat ? cat.name : 'Uncategorised',
      unit: product.unit_of_measure,
      current_stock_snapshot: roundQuantity(product.current_stock) || 0,
      minimum_stock_snapshot: roundQuantity(product.minimum_stock_level) || 0,
      requested_quantity: qty,
      estimated_unit_cost: unitCost,
      estimated_total: roundMoney(qty * unitCost),
      remarks: cleanText(raw.remarks, 500),
      created_at: now
    });
  }

  const lines = [...merged.values()];
  const total_estimated_value = roundMoney(lines.reduce((sum, l) => sum + (Number(l.estimated_total) || 0), 0));
  return { lines, total_estimated_value };
}

async function validateLocation(locationId) {
  if (!locationId) throw fail('A destination location is required.', 'LOCATION_REQUIRED');
  const loc = await getInventoryLocationByIdFirestore(locationId);
  if (!loc) throw fail(`Location '${locationId}' does not exist.`, 'LOCATION_NOT_FOUND', 404);
  if (loc.is_active === false) throw fail(`Location '${loc.name || locationId}' is inactive.`, 'LOCATION_INACTIVE');
  return loc;
}

function validatePriority(priority) {
  if (priority === undefined || priority === null || priority === '') return DEFAULT_PR_PRIORITY;
  const p = String(priority).trim().toUpperCase();
  if (!PR_PRIORITIES.includes(p)) throw fail(`Priority must be one of: ${PR_PRIORITIES.join(', ')}.`, 'INVALID_PRIORITY');
  return p;
}

async function writeAudit(action, request, actor, extra = {}) {
  try {
    await createAuditLogFirestore({
      log_id: `inv_pr_${action.toLowerCase()}_${request.id || request.request_id}`,
      action,
      details: {
        request_id: request.id || request.request_id,
        request_number: request.request_number || null,
        status: request.status,
        department: request.department,
        location_id: request.location_id,
        item_count: request.item_count,
        total_estimated_value: request.total_estimated_value,
        ...extra
      },
      user_id: actor.uid || 'unknown',
      business_date: request.business_date
    });
  } catch (err) {
    // Audit is a secondary trail — never let it break the request workflow.
    console.warn(`[PurchaseRequest] audit log failed (${action}): ${err.message}`);
  }
}

/** Joins a request document with its line items for API responses. */
async function withItems(requestDoc) {
  if (!requestDoc) return null;
  const items = await getPurchaseRequestItemsFirestore(requestDoc.id);
  return { ...requestDoc, items };
}

export const PurchaseRequestService = {

  /**
   * Creates a DRAFT purchase request. No number is assigned yet — the number
   * is reserved transactionally at submit time, so abandoned drafts never
   * consume one.
   *
   * `idempotency_key` makes the doc id deterministic: a retried create returns
   * the existing request with `duplicate: true` instead of a second draft.
   */
  async createDraft(payload, actor) {
    const location = await validateLocation(payload.location_id);
    const priority = validatePriority(payload.priority);
    const { lines, total_estimated_value } = await buildLines(payload.items);
    const businessDate = await resolveBusinessDate(payload.business_date);

    const docId = newRequestKey(payload.idempotency_key);
    const existing = await getPurchaseRequestByIdFirestore(docId);
    if (existing) return { duplicate: true, request: await withItems(existing) };

    const now = new Date().toISOString();
    const request = {
      request_id: docId,
      request_number: null,
      status: PR_STATUS.DRAFT,
      requested_by_uid: actor.uid || null,
      requested_by_name: actor.name || null,
      requested_by_role: actor.role || null,
      department: cleanText(payload.department, 120) || location.department || 'General',
      location_id: location.id,
      location_name_snapshot: location.name || null,
      priority,
      reason: cleanText(payload.reason, 1000),
      remarks: cleanText(payload.remarks, 2000),
      total_estimated_value,
      item_count: lines.length,
      business_date: businessDate,
      created_at: now,
      updated_at: now,
      submitted_at: null,
      cancelled_at: null,
      cancelled_by_uid: null,
      cancel_reason: null,
      idempotency_key: payload.idempotency_key || null,
      status_history: [{ status: PR_STATUS.DRAFT, at: now, by_uid: actor.uid || null, by_name: actor.name || null }]
    };

    await db.collection(REQUESTS_COLLECTION).doc(docId).set(request);
    await replacePurchaseRequestItemsFirestore(docId, lines);

    await writeAudit('INVENTORY_PR_CREATED', { ...request, id: docId }, actor);
    return { duplicate: false, request: await withItems({ ...request, id: docId }) };
  },

  /** Edits a DRAFT. Submitted requests are immutable in Phase B. */
  async updateDraft(requestId, payload, actor) {
    const existing = await getPurchaseRequestByIdFirestore(requestId);
    if (!existing) throw fail('Purchase request not found.', 'REQUEST_NOT_FOUND', 404);
    if (existing.status !== PR_STATUS.DRAFT) {
      throw fail(
        `Only DRAFT purchase requests can be edited (this one is ${existing.status}).` +
        (existing.status === PR_STATUS.PENDING_APPROVAL ? ' Submitted requests are immutable until the approval phase.' : ''),
        'REQUEST_NOT_EDITABLE',
        409
      );
    }
    assertCanMutate(existing, actor);

    const updates = { updated_at: new Date().toISOString() };
    if (payload.location_id !== undefined) {
      const location = await validateLocation(payload.location_id);
      updates.location_id = location.id;
      updates.location_name_snapshot = location.name || null;
    }
    if (payload.priority !== undefined) updates.priority = validatePriority(payload.priority);
    if (payload.department !== undefined) updates.department = cleanText(payload.department, 120) || 'General';
    if (payload.reason !== undefined) updates.reason = cleanText(payload.reason, 1000);
    if (payload.remarks !== undefined) updates.remarks = cleanText(payload.remarks, 2000);

    if (payload.items !== undefined) {
      const { lines, total_estimated_value } = await buildLines(payload.items);
      await replacePurchaseRequestItemsFirestore(existing.id, lines);
      updates.item_count = lines.length;
      updates.total_estimated_value = total_estimated_value;
    }

    await requestRef(existing.id).update(updates);
    const updated = await getPurchaseRequestByIdFirestore(existing.id);
    await writeAudit('INVENTORY_PR_UPDATED', updated, actor, { fields: Object.keys(updates) });
    return { request: await withItems(updated) };
  },

  /**
   * DRAFT → PENDING_APPROVAL.
   *
   * One Firestore transaction reserves the request number AND flips the
   * status, so a rolled-back submit never burns a number and a retried submit
   * never produces a second one. Re-submitting an already-submitted request
   * returns it unchanged with `duplicate: true` rather than erroring or
   * assigning a new number.
   */
  async submit(requestId, actor) {
    const docId = formatRequestDocId(requestId);
    const ref = requestRef(docId);
    const now = new Date().toISOString();

    const preflight = await getPurchaseRequestByIdFirestore(docId);
    if (!preflight) throw fail('Purchase request not found.', 'REQUEST_NOT_FOUND', 404);
    if (preflight.status === PR_STATUS.DRAFT) assertCanMutate(preflight, actor);

    // Items must already be persisted — a request never becomes
    // PENDING_APPROVAL on empty or missing line data.
    const items = await getPurchaseRequestItemsFirestore(docId);
    if (preflight.status === PR_STATUS.DRAFT && items.length === 0) {
      throw fail('Cannot submit a purchase request with no items.', 'NO_ITEMS');
    }

    const businessDate = await resolveBusinessDate(preflight.business_date);

    const result = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw fail('Purchase request not found.', 'REQUEST_NOT_FOUND', 404);
      const current = formatDocSnapshot(snap);

      // Idempotent replay: already submitted → return as-is, no new number.
      if (current.status === PR_STATUS.PENDING_APPROVAL) {
        return { duplicate: true, request: current };
      }
      assertTransition(current.status, PR_STATUS.PENDING_APPROVAL);

      // Read (counter) before any write, per Firestore transaction rules.
      const { number } = await reserveNumberInTransaction(txn, PR_NUMBER_PREFIX, businessDate);

      const history = Array.isArray(current.status_history) ? [...current.status_history] : [];
      history.push({ status: PR_STATUS.PENDING_APPROVAL, at: now, by_uid: actor.uid || null, by_name: actor.name || null });

      const updates = {
        status: PR_STATUS.PENDING_APPROVAL,
        request_number: number,
        submitted_at: now,
        updated_at: now,
        business_date: businessDate,
        status_history: history
      };
      txn.update(ref, updates);
      return { duplicate: false, request: { ...current, ...updates } };
    });

    if (!result.duplicate) await writeAudit('INVENTORY_PR_SUBMITTED', result.request, actor);
    return { duplicate: result.duplicate, request: await withItems(result.request) };
  },

  /** DRAFT → CANCELLED. Submitted requests cannot be cancelled in Phase B. */
  async cancel(requestId, reason, actor) {
    const existing = await getPurchaseRequestByIdFirestore(requestId);
    if (!existing) throw fail('Purchase request not found.', 'REQUEST_NOT_FOUND', 404);
    if (existing.status === PR_STATUS.CANCELLED) {
      return { duplicate: true, request: await withItems(existing) };
    }
    assertTransition(existing.status, PR_STATUS.CANCELLED);
    assertCanMutate(existing, actor);

    const now = new Date().toISOString();
    const history = Array.isArray(existing.status_history) ? [...existing.status_history] : [];
    history.push({ status: PR_STATUS.CANCELLED, at: now, by_uid: actor.uid || null, by_name: actor.name || null });

    const updates = {
      status: PR_STATUS.CANCELLED,
      cancelled_at: now,
      cancelled_by_uid: actor.uid || null,
      cancel_reason: cleanText(reason, 500),
      updated_at: now,
      status_history: history
    };
    await requestRef(existing.id).update(updates);
    const updated = { ...existing, ...updates };
    await writeAudit('INVENTORY_PR_CANCELLED', updated, actor, { cancel_reason: updates.cancel_reason });
    return { duplicate: false, request: await withItems(updated) };
  },

  async getById(requestId) {
    const doc = await getPurchaseRequestByIdFirestore(requestId);
    if (!doc) return null;
    return await withItems(doc);
  },

  /** Paginated list. Items are NOT joined here — the detail view loads them. */
  async list(query = {}) {
    const result = await listPurchaseRequestsFirestore({
      status: query.status || null,
      requested_by_uid: query.requested_by_uid || null,
      department: query.department || null,
      location_id: query.location_id || null,
      request_number: query.request_number || null,
      from: query.from || null,
      to: query.to || null,
      limit: query.limit || query.page_size,
      cursor: query.cursor || null
    });
    return { requests: result.items, next_cursor: result.next_cursor, limit: result.limit };
  }
};

export default PurchaseRequestService;
