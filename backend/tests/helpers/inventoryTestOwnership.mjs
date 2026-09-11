/**
 * inventoryTestOwnership.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Ownership-scoped cleanup for the inventory test suites.
 *
 * WHY THIS EXISTS
 * Phases E, F and G used to end by fetching whole collections and deleting
 * every document in them:
 *
 *     for (const col of ['purchase_orders', 'purchase_requests', ...]) {
 *       const snap = await db.collection(col).get();
 *       for (const d of snap.docs) await d.ref.delete();
 *     }
 *
 * That deletes documents the suite never created. It destroyed a purchase
 * request a person had raised through the DEV application. A test may only
 * ever delete what that same run created, and it must be able to prove it.
 *
 * WHAT THIS PROVIDES
 *   • `track(collection, id)` — record an id at the moment it is created.
 *   • `recordX(result)` — record every document one service call produced,
 *     reading the ids the service returned rather than reconstructing them.
 *   • `sweep()` — delete exactly the recorded ids, children before parents.
 *   • `survivors()` — re-read every recorded id and report which still exist.
 *     A Firestore delete reports success for a document that was never there,
 *     so the delete call is not evidence; the re-read is.
 *   • `foreign(before)` — documents that appeared during the run and were NOT
 *     recorded. These are never deleted. They are reported, because they are
 *     either a person using DEV or a gap in the recording.
 *
 * NOTHING HERE DELETES BY QUERY, BY PREFIX, OR BY COLLECTION.
 */

/** Children before parents. A collection absent from this list sweeps last. */
export const SWEEP_ORDER = [
  'inventory_stock_movements',
  'goods_receipt_items',
  'goods_receipt_reversals',
  'goods_receipts',
  'purchase_order_items',
  'purchase_orders',
  'purchase_request_items',
  'purchase_requests',
  'inventory_bill_lines',
  'inventory_bills',
  'inventory_products',
  'inventory_suppliers',
  'inventory_locations',
  'inventory_units',
  'inventory_categories',
  'audit_logs'
];

/** Collections a suite is allowed to compare before and after. */
export const WATCHED_COLLECTIONS = [
  'inventory_products', 'inventory_categories', 'inventory_units',
  'inventory_locations', 'inventory_suppliers', 'inventory_stock_movements',
  'purchase_requests', 'purchase_request_items',
  'purchase_orders', 'purchase_order_items',
  'goods_receipts', 'goods_receipt_items', 'goods_receipt_reversals',
  'inventory_bills', 'inventory_bill_lines'
];

/**
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {object} [ids] repository id formatters, so a composite child id is
 *   never guessed. Only used as a fallback when a service did not return the
 *   child's own id.
 */
export function createOwnership(db, ids = {}) {
  /** @type {Map<string, Set<string>>} collection -> ids this run created */
  const owned = new Map();

  const track = (collection, ...docIds) => {
    if (!collection) return;
    if (!owned.has(collection)) owned.set(collection, new Set());
    const set = owned.get(collection);
    for (const id of docIds.flat()) {
      if (id === undefined || id === null || id === '') continue;
      set.add(String(id));
    }
  };

  const list = (collection) => [...(owned.get(collection) || [])];
  const size = () => [...owned.values()].reduce((n, s) => n + s.size, 0);
  const collections = () => [...owned.keys()];

  // ── Recorders: read the ids the service actually returned ────────────────

  /** PurchaseRequestService.createDraft / update → { request: {...items} } */
  const recordRequest = (result) => {
    const r = result?.request || result;
    if (!r?.id) return result;
    track('purchase_requests', r.id);
    for (const [i, it] of (r.items || []).entries()) {
      track('purchase_request_items', it.id || ids.formatRequestItemDocId?.(r.id, it.line_no ?? i + 1));
    }
    return result;
  };

  /** PurchaseOrderService.createFromRequest / issue → { order: {...items} } */
  const recordOrder = (result) => {
    const o = result?.order || result;
    if (!o?.id) return result;
    track('purchase_orders', o.id);
    for (const [i, it] of (o.items || []).entries()) {
      track('purchase_order_items', it.id || ids.formatOrderItemDocId?.(o.id, it.line_no ?? i + 1));
    }
    return result;
  };

  /** GoodsReceiptService.receive → { receipt: {...items}, order } */
  const recordReceipt = (result) => {
    const rec = result?.receipt;
    if (rec) {
      const receiptId = rec.receipt_id || rec.id;
      track('goods_receipts', receiptId);
      for (const [i, it] of (rec.items || result?.items || []).entries()) {
        track('goods_receipt_items', it.id || ids.formatReceiptItemDocId?.(receiptId, it.line_no ?? i + 1));
        track('inventory_stock_movements', it.stock_movement_id);
      }
    }
    if (result?.order) recordOrder({ order: result.order });
    return result;
  };

  /** ReceiptCorrectionService.reverseReceipt → { reversal, order } */
  const recordReversal = (result) => {
    const rev = result?.reversal;
    if (rev) {
      track('goods_receipt_reversals', rev.reversal_id || rev.id);
      track('inventory_stock_movements', rev.stock_movement_ids || []);
    }
    if (result?.order) recordOrder({ order: result.order });
    return result;
  };

  /** InventoryCutoverService.createProduct → { product } */
  const recordProduct = (result) => {
    const p = result?.product || result;
    if (p?.id) track('inventory_products', p.id);
    return result;
  };

  /** Any movement-posting result carrying a movement id. */
  const recordMovement = (result) => {
    const m = result?.movement || result;
    if (m?.id) track('inventory_stock_movements', m.id);
    if (Array.isArray(result?.stock_movement_ids)) track('inventory_stock_movements', result.stock_movement_ids);
    return result;
  };

  /**
   * Wraps a service so EVERY call site records what it created, including the
   * ones a person forgets to update later. Returns a new object; the real
   * service is untouched, and the wrapper only reads the result.
   *
   * @param {object} service
   * @param {Record<string, (result:any)=>any>} recorders  method name -> recorder
   */
  const wrapService = (service, recorders) => {
    const wrapped = Object.create(Object.getPrototypeOf(service));
    for (const key of Reflect.ownKeys(service)) {
      const value = service[key];
      const recorder = recorders[key];
      if (typeof value !== 'function' || !recorder) {
        wrapped[key] = value;
        continue;
      }
      wrapped[key] = async (...args) => {
        const result = await value.apply(service, args);
        try { recorder(result); } catch { /* recording must never fail a test */ }
        return result;
      };
    }
    return wrapped;
  };

  /**
   * The parent → child links in the procurement chain. A child document is
   * owned when its parent is: a purchase-order item can only exist because
   * this run created that order.
   */
  const CHILD_LINKS = [
    { child: 'purchase_request_items', field: 'request_id', parent: 'purchase_requests' },
    { child: 'purchase_order_items', field: 'po_id', parent: 'purchase_orders' },
    { child: 'goods_receipt_items', field: 'receipt_id', parent: 'goods_receipts' },
    { child: 'goods_receipt_reversals', field: 'receipt_id', parent: 'goods_receipts' },
    { child: 'inventory_stock_movements', field: 'reference_id', parent: 'goods_receipts' },
    { child: 'inventory_bill_lines', field: 'bill_id', parent: 'inventory_bills' }
  ];

  /**
   * Records the children of every parent this run created, so a child whose id
   * the service did not return is still owned — and still cleaned up.
   *
   * This queries by parent id, never by prefix and never by collection. The
   * predicate is an id this run generated, so it cannot reach anyone else's
   * document. Call it immediately before `sweep()`.
   */
  const adoptChildren = async (links = CHILD_LINKS) => {
    for (const { child, field, parent } of links) {
      for (const parentId of list(parent)) {
        try {
          const snap = await db.collection(child).where(field, '==', parentId).get();
          for (const d of snap.docs) track(child, d.id);
        } catch (err) {
          console.warn(`  [adopt warning] ${child}.${field}=${parentId}: ${err.message}`);
        }
      }
    }
  };

  // ── Sweep + proof ─────────────────────────────────────────────────────────

  /**
   * Deletes exactly the recorded ids, children before parents. Returns a
   * per-collection count of delete calls issued — NOT a proof of deletion.
   * `survivors()` is the proof.
   */
  const sweep = async () => {
    const counts = {};
    const order = [...SWEEP_ORDER, ...collections().filter(c => !SWEEP_ORDER.includes(c))];
    for (const collection of order) {
      const set = owned.get(collection);
      if (!set || set.size === 0) continue;
      let n = 0;
      for (const id of set) {
        try { await db.collection(collection).doc(id).delete(); n++; }
        catch (err) { console.warn(`  [sweep warning] ${collection}/${id}: ${err.message}`); }
      }
      counts[collection] = n;
    }
    return counts;
  };

  /** Re-reads every recorded id. Anything still present is a cleanup failure. */
  const survivors = async () => {
    const left = [];
    for (const [collection, set] of owned) {
      for (const id of set) {
        const snap = await db.collection(collection).doc(id).get();
        if (snap.exists) left.push(`${collection}/${id}`);
      }
    }
    return left;
  };

  return {
    track, list, size, collections,
    recordRequest, recordOrder, recordReceipt, recordReversal, recordProduct, recordMovement,
    wrapService, adoptChildren, sweep, survivors,
    /** Everything recorded, for a report. */
    dump: () => Object.fromEntries([...owned].map(([c, s]) => [c, [...s]]))
  };
}

/**
 * A document-id census of the watched collections. Used to prove, after a
 * run, that nothing the suite did not create disappeared.
 */
export async function census(db, collections = WATCHED_COLLECTIONS) {
  const out = {};
  for (const c of collections) {
    const snap = await db.collection(c).get();
    out[c] = new Set(snap.docs.map(d => d.id));
  }
  return out;
}

/**
 * @returns {{ removed: string[], added: string[] }} `removed` is the list that
 *   matters: any pre-existing document that vanished. `added` is reported so a
 *   gap in ownership recording is visible rather than silently tolerated.
 */
export function censusDiff(before, after) {
  const removed = [], added = [];
  for (const c of Object.keys(before)) {
    for (const id of before[c]) if (!after[c]?.has(id)) removed.push(`${c}/${id}`);
    for (const id of after[c] || []) if (!before[c].has(id)) added.push(`${c}/${id}`);
  }
  return { removed, added };
}
