/**
 * purchaseOrderService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase E — PURCHASE ORDER workflow.
 *
 *   APPROVED purchase request ──create──▶ PO (DRAFT) ──issue──▶ PO (ISSUED)
 *
 * ARCHITECTURE RULES enforced by this file's contents, not just its comments:
 *
 *   ORDER ≠ RECEIPT ≠ STOCK ADDITION ≠ PAYMENT.
 *   Creating or issuing a purchase order NEVER changes a stock balance and
 *   never writes the movement ledger. This module deliberately does not import
 *   inventoryStockService or any stock-mutating helper, so that guarantee holds
 *   by construction. Goods receiving is Phase F.
 *
 *   ONE APPROVED REQUEST = ONE PURCHASE ORDER.
 *   Enforced structurally: the PO document id is derived from the source
 *   request id, so a second PO for the same request is the same document. A
 *   retry therefore returns the existing order instead of creating a duplicate.
 *
 *   THE SOURCE REQUEST IS NEVER MUTATED.
 *   Phase C made APPROVED terminal and immutable. Creating a PO writes nothing
 *   back to the request — not its status, lines, approvals or history. The
 *   link lives only on the PO (source_request_id), and the reverse lookup is a
 *   deterministic O(1) get.
 *
 *   HISTORICAL SNAPSHOTS.
 *   Product name, SKU, category, unit, cost and supplier details are copied
 *   onto the PO at creation. A later rename or price change never rewrites an
 *   existing purchase order.
 */

import { db } from '../config/firebaseAdmin.js';
import { formatDocSnapshot, RepositoryError } from '../repositories/firestore/firestoreUtils.js';
import {
  ORDERS_COLLECTION, ORDER_ITEMS_COLLECTION,
  purchaseOrderIdForRequest, formatOrderDocId, orderRef, orderItemRef,
  getPurchaseOrderByIdFirestore, getPurchaseOrderItemsFirestore,
  getPurchaseOrderForRequestFirestore, listPurchaseOrdersFirestore
} from '../repositories/firestore/purchaseOrdersRepository.js';
import {
  formatRequestDocId, requestRef, getPurchaseRequestItemsFirestore
} from '../repositories/firestore/purchaseRequestsRepository.js';
import { getInventoryProductByIdFirestore, normalizeProductDoc } from '../repositories/firestore/inventoryProductsRepository.js';
import { getInventorySupplierByIdFirestore } from '../repositories/firestore/inventorySuppliersRepository.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { reserveNumberInTransaction, resolveBusinessDate } from './inventoryNumberService.js';
import {
  PR_STATUS, PO_STATUS, PO_TRANSITIONS, PO_NUMBER_PREFIX, roundMoney, roundQuantity
} from '../utils/inventoryConstants.js';

function fail(message, code, status = 400) {
  return new RepositoryError(message, code, status);
}

function cleanText(v, max = 1000) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

async function withItems(orderDoc) {
  if (!orderDoc) return null;
  const items = await getPurchaseOrderItemsFirestore(orderDoc.id);
  return { ...orderDoc, items };
}

async function writeAudit(action, order, actor, extra = {}) {
  try {
    await createAuditLogFirestore({
      log_id: `inv_po_${action.toLowerCase()}_${order.id || order.po_id}`,
      action,
      details: {
        po_id: order.id || order.po_id,
        po_number: order.po_number || null,
        source_request_id: order.source_request_id,
        source_request_number: order.source_request_number || null,
        status: order.status,
        supplier_id: order.supplier_id,
        supplier_name: order.supplier_name_snapshot,
        item_count: order.item_count,
        total_estimated_value: order.total_estimated_value,
        actor_role: actor?.role || null,
        ...extra
      },
      user_id: actor?.uid || 'unknown',
      business_date: order.business_date
    });
  } catch (err) {
    // Audit is a secondary trail — the workflow transaction has already
    // committed and must not be undone because logging failed.
    console.warn(`[PurchaseOrder] audit log failed (${action}): ${err.message}`);
  }
}

/**
 * Resolves the ONE supplier for a request's lines from authoritative
 * server-side product data (each product's default_supplier_id), and builds
 * the PO line snapshots.
 *
 * Phase E is strictly one supplier per order: a request whose lines belong to
 * different suppliers is REJECTED rather than silently split or combined.
 */
async function buildOrderLines(requestItems) {
  if (!Array.isArray(requestItems) || requestItems.length === 0) {
    throw fail('The approved purchase request has no line items.', 'REQUEST_HAS_NO_ITEMS');
  }

  const supplierIds = new Set();
  const missingSupplier = [];
  const draft = [];

  for (const item of requestItems) {
    const productDoc = await getInventoryProductByIdFirestore(item.product_id);
    if (!productDoc) {
      throw fail(`Product '${item.product_id}' no longer exists and cannot be ordered.`, 'PRODUCT_NOT_FOUND', 404);
    }
    const product = normalizeProductDoc(productDoc);
    const supplierId = product.default_supplier_id || null;
    if (!supplierId) {
      missingSupplier.push(item.sku || product.sku || item.product_id);
    } else {
      supplierIds.add(String(supplierId));
    }
    draft.push({ item, product, supplierId });
  }

  if (missingSupplier.length > 0) {
    throw fail(
      `No default supplier is set for: ${missingSupplier.join(', ')}. ` +
      `Set a supplier on each item before raising a purchase order.`,
      'PRODUCT_SUPPLIER_MISSING'
    );
  }
  if (supplierIds.size > 1) {
    throw fail(
      `This request covers ${supplierIds.size} different suppliers. ` +
      `A purchase order covers exactly one supplier — raise one request per supplier.`,
      'MULTIPLE_SUPPLIERS_IN_REQUEST'
    );
  }

  const supplierId = [...supplierIds][0];
  const supplier = await getInventorySupplierByIdFirestore(supplierId);
  if (!supplier) {
    throw fail(`Supplier '${supplierId}' no longer exists.`, 'SUPPLIER_NOT_FOUND', 404);
  }
  if (supplier.is_active === false) {
    throw fail(`Supplier '${supplier.name}' is inactive and cannot receive a purchase order.`, 'SUPPLIER_INACTIVE');
  }

  const now = new Date().toISOString();
  const lines = draft.map(({ item, product }, index) => {
    // Ordered quantity equals the approved quantity — Phase E does not permit
    // altering what was approved.
    const orderedQty = roundQuantity(item.requested_quantity) || 0;
    const unitCost = roundMoney(item.estimated_unit_cost ?? product.cost_price ?? 0) || 0;
    return {
      line_no: index + 1,
      source_request_item_id: item.id || item.request_item_id || null,
      product_id: item.product_id,
      // Snapshots come from the APPROVED REQUEST line wherever the request
      // captured one, so the order reflects what was actually approved rather
      // than what the product master says today.
      sku_snapshot: item.sku || product.sku,
      product_name_snapshot: item.product_name_snapshot || product.name,
      category_snapshot: item.category_name_snapshot || null,
      unit_snapshot: item.unit || product.unit_of_measure,
      supplier_id: supplier.id,
      supplier_name_snapshot: supplier.name,
      requested_quantity: roundQuantity(item.requested_quantity) || 0,
      ordered_quantity: orderedQty,
      estimated_unit_cost: unitCost,
      estimated_line_total: roundMoney(orderedQty * unitCost),
      remarks: cleanText(item.remarks, 500),
      created_at: now
    };
  });

  const total = roundMoney(lines.reduce((s, l) => s + (Number(l.estimated_line_total) || 0), 0));
  return { supplier, lines, total_estimated_value: total };
}

export const PurchaseOrderService = {

  /**
   * Creates the purchase order for an APPROVED request.
   *
   * Everything that must be consistent happens in ONE transaction: the
   * duplicate check, the source-request status check, the PO number
   * reservation and the writes. Firestore requires all reads before all
   * writes, and the existence check runs FIRST — so a retry (or a concurrent
   * second caller) returns the existing order without reserving a number.
   *
   * @returns {{ duplicate: boolean, order: object }}
   */
  async createFromRequest(sourceRequestId, actor, options = {}) {
    if (!sourceRequestId) throw fail('source_request_id is required.', 'SOURCE_REQUEST_REQUIRED');

    const requestDocId = formatRequestDocId(sourceRequestId);
    const orderDocId = purchaseOrderIdForRequest(requestDocId);
    const poRef = orderRef(orderDocId);
    const prRef = requestRef(requestDocId);

    // Fast path: an order already exists → return it, touch nothing.
    const existing = await getPurchaseOrderByIdFirestore(orderDocId);
    if (existing) return { duplicate: true, order: await withItems(existing) };

    // Validate the request and resolve supplier/lines BEFORE the transaction:
    // these are reads of other documents and would otherwise bloat it.
    const prSnap = await prRef.get();
    if (!prSnap.exists) throw fail('Purchase request not found.', 'REQUEST_NOT_FOUND', 404);
    const request = formatDocSnapshot(prSnap);
    if (request.status !== PR_STATUS.APPROVED) {
      throw fail(
        `Only an APPROVED purchase request can become a purchase order (this one is ${request.status}).`,
        'REQUEST_NOT_APPROVED', 409
      );
    }

    const requestItems = await getPurchaseRequestItemsFirestore(requestDocId);
    const { supplier, lines, total_estimated_value } = await buildOrderLines(requestItems);
    const businessDate = await resolveBusinessDate(request.business_date);
    const now = new Date().toISOString();

    const result = await db.runTransaction(async (txn) => {
      // ── all reads first ──
      const poSnap = await txn.get(poRef);
      if (poSnap.exists) {
        // A concurrent caller won the race; return theirs, reserve nothing.
        return { duplicate: true, order: formatDocSnapshot(poSnap) };
      }
      const prNow = await txn.get(prRef);
      if (!prNow.exists) throw fail('Purchase request not found.', 'REQUEST_NOT_FOUND', 404);
      const requestNow = formatDocSnapshot(prNow);
      if (requestNow.status !== PR_STATUS.APPROVED) {
        throw fail(
          `Only an APPROVED purchase request can become a purchase order (this one is ${requestNow.status}).`,
          'REQUEST_NOT_APPROVED', 409
        );
      }
      // Reserves the next PO sequence (reads the counter, then writes it).
      const { number } = await reserveNumberInTransaction(txn, PO_NUMBER_PREFIX, businessDate);

      // ── writes ──
      const order = {
        po_id: orderDocId,
        po_number: number,
        source_request_id: requestDocId,
        source_request_number: requestNow.request_number || null,
        status: PO_STATUS.DRAFT,
        supplier_id: supplier.id,
        supplier_name_snapshot: supplier.name,
        supplier_phone_snapshot: supplier.phone || null,
        supplier_address_snapshot: supplier.address || null,
        supplier_gstin_snapshot: supplier.gstin || null,
        location_id: requestNow.location_id,
        location_name_snapshot: requestNow.location_name_snapshot || null,
        department: requestNow.department || null,
        requester_uid: requestNow.requested_by_uid || null,
        requester_name_snapshot: requestNow.requested_by_name || null,
        priority: requestNow.priority || null,
        business_date: businessDate,
        remarks: cleanText(options.remarks, 2000) || null,
        total_estimated_value,
        item_count: lines.length,
        created_by_uid: actor?.uid || null,
        created_by_name: actor?.name || null,
        created_at: now,
        issued_by_uid: null,
        issued_by_name: null,
        issued_at: null,
        updated_at: now,
        status_history: [{ status: PO_STATUS.DRAFT, at: now, by_uid: actor?.uid || null, by_name: actor?.name || null }]
      };
      txn.set(poRef, order);

      for (const line of lines) {
        const itemId = orderItemRef(orderDocId, line.line_no).id;
        txn.set(orderItemRef(orderDocId, line.line_no), { ...line, po_item_id: itemId, po_id: orderDocId });
      }

      return { duplicate: false, order: { ...order, id: orderDocId } };
    });

    if (!result.duplicate) await writeAudit('INVENTORY_PO_CREATED', result.order, actor);
    return { duplicate: result.duplicate, order: await withItems(result.order) };
  },

  /**
   * DRAFT → ISSUED. After this the purchase order is an immutable purchasing
   * document: no edits, no supplier change, no quantity change, no deletion.
   * Re-issuing an already-issued order is an idempotent no-op rather than an
   * error, so a retried request cannot corrupt the record.
   */
  async issue(orderId, actor, options = {}) {
    const docId = formatOrderDocId(orderId);
    const ref = orderRef(docId);
    const now = new Date().toISOString();

    const result = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw fail('Purchase order not found.', 'PURCHASE_ORDER_NOT_FOUND', 404);
      const current = formatDocSnapshot(snap);

      if (current.status === PO_STATUS.ISSUED) {
        return { duplicate: true, order: current };
      }
      if (!(PO_TRANSITIONS[current.status] || []).includes(PO_STATUS.ISSUED)) {
        throw fail(`A ${current.status} purchase order cannot be issued.`, 'INVALID_STATUS_TRANSITION', 409);
      }

      const history = Array.isArray(current.status_history) ? [...current.status_history] : [];
      history.push({ status: PO_STATUS.ISSUED, at: now, by_uid: actor?.uid || null, by_name: actor?.name || null });

      const updates = {
        status: PO_STATUS.ISSUED,
        issued_by_uid: actor?.uid || null,
        issued_by_name: actor?.name || null,
        issued_at: now,
        updated_at: now,
        status_history: history
      };
      if (options.remarks !== undefined) updates.issue_remarks = cleanText(options.remarks, 1000);

      txn.update(ref, updates);
      return { duplicate: false, order: { ...current, ...updates } };
    });

    if (!result.duplicate) await writeAudit('INVENTORY_PO_ISSUED', result.order, actor);
    return { duplicate: result.duplicate, order: await withItems(result.order) };
  },

  async getById(orderId) {
    const doc = await getPurchaseOrderByIdFirestore(orderId);
    if (!doc) return null;
    return await withItems(doc);
  },

  /** The purchase order raised from a given request, or null. O(1). */
  async getForRequest(requestId) {
    const doc = await getPurchaseOrderForRequestFirestore(requestId);
    if (!doc) return null;
    return await withItems(doc);
  },

  /** Paginated list. Line items are not joined — the detail view loads them. */
  async list(query = {}) {
    const result = await listPurchaseOrdersFirestore({
      status: query.status || null,
      supplier_id: query.supplier_id || null,
      source_request_id: query.source_request_id || null,
      location_id: query.location_id || null,
      department: query.department || null,
      po_number: query.po_number || null,
      from: query.from || null,
      to: query.to || null,
      limit: query.limit || query.page_size,
      cursor: query.cursor || null
    });
    return { orders: result.items, next_cursor: result.next_cursor, limit: result.limit };
  }
};

export default PurchaseOrderService;
