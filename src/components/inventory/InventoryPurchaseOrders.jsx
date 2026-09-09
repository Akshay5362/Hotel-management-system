/**
 * InventoryPurchaseOrders.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase E — Purchase Orders: list, detail and issuing.
 * Phase F — Goods receiving: record a delivery against an ISSUED or
 * PARTIALLY_RECEIVED order. Receiving is the ONLY action here that changes
 * stock, and it posts the quantity actually ACCEPTED (never the quantity
 * ordered).
 *
 * A purchase order is the formal document sent to ONE supplier, created from
 * exactly ONE approved purchase request. Creating or issuing it does NOT
 * receive goods, does NOT change stock and does NOT pay anyone — the figures
 * shown are the estimates carried over from the approved request.
 *
 * Phase G — Corrections: reverse a goods receipt that was recorded in error,
 * or close a partially received order short when the balance will never
 * arrive. A reversal never edits or deletes the original receipt — it posts a
 * compensating stock movement and records a separate reversal document. The
 * receipt stays in the delivery history exactly as it was written, shown as
 * REVERSED from the JOINED reversal record (`receipt.reversal`, supplied by
 * the delivery-history endpoint), never from a field on the receipt itself.
 * A short close moves no stock at all.
 *
 * Once ISSUED the order is read-only here, matching the server's state machine.
 * All controls are UX only; the server authorizes every call.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  FileText, Search, RefreshCw, ArrowLeft, Send, CheckCircle2, Building2,
  PackageCheck, AlertTriangle, Undo2, XCircle, Ban
} from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';

const STATUS_STYLES = {
  DRAFT:              { bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8', label: 'Draft' },
  ISSUED:             { bg: 'rgba(56,189,248,0.15)',  fg: '#38bdf8', label: 'Issued' },
  PARTIALLY_RECEIVED: { bg: 'rgba(245,158,11,0.15)',  fg: '#f59e0b', label: 'Partially Received' },
  RECEIVED:           { bg: 'rgba(16,185,129,0.15)',  fg: '#10b981', label: 'Received' },
  CLOSED_SHORT:       { bg: 'rgba(148,163,184,0.15)', fg: '#cbd5e1', label: 'Closed Short' }
};
const RECEIVABLE = ['ISSUED', 'PARTIALLY_RECEIVED'];

const money = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function InventoryPurchaseOrders({ token, openOrderId, onDeepLinkHandled, canCorrect = false }) {
  const [view, setView] = useState('list');
  const [detailId, setDetailId] = useState(null);

  // Deep link after creating a PO from an approved request. Pure state — no
  // URL navigation, so it behaves identically under Electron's file:// origin.
  useEffect(() => {
    if (!openOrderId) return;
    setDetailId(openOrderId);
    setView('detail');
    if (onDeepLinkHandled) onDeepLinkHandled();
  }, [openOrderId, onDeepLinkHandled]);

  return view === 'detail'
    ? <OrderDetail token={token} orderId={detailId} canCorrect={canCorrect} onBack={() => setView('list')} />
    : <OrderList token={token} onOpen={(id) => { setDetailId(id); setView('detail'); }} />;
}

/* ── List ─────────────────────────────────────────────────────────────────── */
function OrderList({ token, onOpen }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [cursor, setCursor] = useState(null);
  const [cursorStack, setCursorStack] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);

  const load = useCallback(async (cur = null) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (status) params.set('status', status);
      if (poNumber.trim()) params.set('po_number', poNumber.trim());
      if (cur) params.set('cursor', cur);
      const data = await inventoryFetch(`/inventory/purchase-orders?${params.toString()}`, { token });
      setOrders(data.orders || []);
      setNextCursor(data.next_cursor || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, status, poNumber]);

  useEffect(() => { setCursor(null); setCursorStack([]); load(null); }, [load]);

  return (
    <div style={{ padding: 24, color: '#fff', maxWidth: 1300, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileText size={20} /> Purchase Orders
        </h2>
        <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
          Raised from an approved purchase request — creating or issuing one never changes stock.
        </div>
      </div>

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
          <input value={poNumber} onChange={e => setPoNumber(e.target.value)} placeholder="PO-20260908-000001"
            style={{ padding: '8px 12px 8px 32px', borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' }} />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value)} style={selectStyle}>
          <option value="">All Statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="ISSUED">Issued</option>
          <option value="PARTIALLY_RECEIVED">Partially Received</option>
          <option value="RECEIVED">Received</option>
          <option value="CLOSED_SHORT">Closed Short</option>
        </select>
        <button onClick={() => load(cursor)} style={iconBtn}><RefreshCw size={16} /></button>
      </div>

      {error && <div style={errorBox}>{error}</div>}

      <div className="glass" style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading purchase orders...</div>
        ) : orders.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            No purchase orders yet. Approve a purchase request, then raise its order from the request detail.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={th}>PO Number</th><th style={th}>Source Request</th><th style={th}>Supplier</th>
                  <th style={th}>Department</th><th style={th}>Location</th><th style={th}>Items</th>
                  <th style={th}>Est. Total</th><th style={th}>Created</th><th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => {
                  const st = STATUS_STYLES[o.status] || STATUS_STYLES.DRAFT;
                  return (
                    <tr key={o.id} onClick={() => onOpen(o.id)} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}>
                      <td style={{ ...td, fontFamily: 'monospace', color: '#38bdf8' }}>{o.po_number}</td>
                      <td style={{ ...td, fontFamily: 'monospace', color: '#94a3b8' }}>{o.source_request_number || '—'}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{o.supplier_name_snapshot}</td>
                      <td style={td}>{o.department || '—'}</td>
                      <td style={td}>{o.location_name_snapshot || o.location_id}</td>
                      <td style={td}>{o.item_count}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{money(o.total_estimated_value)}</td>
                      <td style={{ ...td, color: '#94a3b8' }}>{o.business_date}</td>
                      <td style={td}><span style={{ padding: '3px 9px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 700, background: st.bg, color: st.fg }}>{st.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <button disabled={cursorStack.length === 0} onClick={() => {
          const stack = [...cursorStack]; const prev = stack.pop() || null;
          setCursorStack(stack); setCursor(prev); load(prev);
        }} style={pagerBtn(cursorStack.length === 0)}>Previous</button>
        <button disabled={!nextCursor} onClick={() => {
          setCursorStack(s => [...s, cursor]); setCursor(nextCursor); load(nextCursor);
        }} style={pagerBtn(!nextCursor)}>Next</button>
      </div>
    </div>
  );
}

/* ── Detail ───────────────────────────────────────────────────────────────── */
function OrderDetail({ token, orderId, onBack, canCorrect = false }) {
  const [order, setOrder] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [receiveQty, setReceiveQty] = useState({});      // po_item_id -> qty string
  const [varianceReason, setVarianceReason] = useState({});
  const [receiveRemarks, setReceiveRemarks] = useState('');
  // One key per receiving session: a double-click replays the SAME delivery,
  // which the server treats as an idempotent retry instead of posting twice.
  const [idempotencyKey, setIdempotencyKey] = useState(null);

  // Phase G — corrections. `reversing` holds the receipt being reversed, so
  // the confirmation panel can show exactly what is about to be undone.
  const [reversing, setReversing] = useState(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseKey, setReverseKey] = useState(null);
  const [closingShort, setClosingShort] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await inventoryFetch(`/inventory/purchase-orders/${orderId}`, { token });
      setOrder(data.order);
      try {
        const r = await inventoryFetch(`/inventory/purchase-orders/${orderId}/receipts`, { token });
        setReceipts(r.receipts || []);
      } catch { setReceipts([]); }
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, [token, orderId]);

  useEffect(() => { load(); }, [load]);

  const issue = async () => {
    if (!window.confirm('Issue this purchase order? Once issued it becomes a permanent, read-only document.')) return;
    setBusy(true); setError('');
    try {
      await inventoryFetch(`/inventory/purchase-orders/${orderId}/issue`, { token, method: 'POST', body: {} });
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const outstandingOf = (it) => {
    const ordered = Number(it.ordered_quantity) || 0;
    const received = Number(it.received_quantity) || 0;
    return Math.max(Math.round((ordered - received) * 1000) / 1000, 0);
  };
  const receivingLines = (order?.items || [])
    .map(it => ({ it, qty: Number(receiveQty[it.id]) }))
    .filter(l => Number.isFinite(l.qty) && l.qty > 0);
  const overLines = receivingLines.filter(l => {
    const ordered = Number(l.it.ordered_quantity) || 0;
    const received = Number(l.it.received_quantity) || 0;
    return Math.round((received + l.qty - ordered) * 1000) / 1000 > 0;
  });
  const receivingValue = receivingLines.reduce((s2, l) => s2 + l.qty * (Number(l.it.estimated_unit_cost) || 0), 0);

  const startReceiving = () => {
    const seed = {};
    (order.items || []).forEach(it => { const o = outstandingOf(it); if (o > 0) seed[it.id] = String(o); });
    setReceiveQty(seed);
    setVarianceReason({});
    setReceiveRemarks('');
    setIdempotencyKey(`gr_ui_${orderId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    setReceiving(true);
  };

  const submitReceipt = async () => {
    setError('');
    if (receivingLines.length === 0) { setError('Enter a quantity for at least one item.'); return; }
    for (const l of overLines) {
      if (!String(varianceReason[l.it.id] || '').trim()) {
        setError(`An over-receipt reason is required for ${l.it.product_name_snapshot}.`);
        return;
      }
    }
    setBusy(true);
    try {
      await inventoryFetch(`/inventory/purchase-orders/${orderId}/receipts`, {
        token, method: 'POST',
        body: {
          idempotency_key: idempotencyKey,
          remarks: receiveRemarks || undefined,
          lines: receivingLines.map(l => ({
            po_item_id: l.it.id,
            received_quantity: l.qty,
            variance_reason: varianceReason[l.it.id] || undefined
          }))
        }
      });
      setReceiving(false);
      setNotice('Delivery recorded. Stock has been updated.');
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  /* ── Phase G — corrections ───────────────────────────────────────────── */

  const startReversal = (receipt) => {
    setError(''); setNotice('');
    setReverseReason('');
    // One key per reversal attempt: a double-click replays the SAME reversal,
    // which the server returns idempotently instead of reversing twice.
    setReverseKey(`grv_ui_${receipt.receipt_id || receipt.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    setReversing(receipt);
  };

  const submitReversal = async () => {
    setError('');
    const reason = reverseReason.trim();
    if (reason.length < 3) { setError('Enter a reason for this reversal.'); return; }
    const rid = reversing.receipt_id || reversing.id;
    if (!window.confirm(
      `Reverse ${reversing.receipt_number}?

` +
      `This removes ${formatQty(reversing.total_received_quantity)} of stock that this delivery added, ` +
      `and reopens the purchase order for the quantities it covered.

` +
      `The receipt itself is kept and will stay visible, marked REVERSED.`
    )) return;
    setBusy(true);
    try {
      const res = await inventoryFetch(`/inventory/purchase-orders/${orderId}/receipts/${rid}/reverse`, {
        token, method: 'POST', body: { idempotency_key: reverseKey, reason }
      });
      setReversing(null);
      setNotice(res.message || `${reversing.receipt_number} reversed.`);
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const submitShortClose = async () => {
    setError('');
    const reason = closeReason.trim();
    if (reason.length < 3) { setError('Enter a reason for closing this order short.'); return; }
    if (!window.confirm(
      `Close ${order.po_number} short?

` +
      `The outstanding balance will be written off as never arriving. ` +
      `No stock changes and no delivery is recorded — the quantities already received stand as they are.

` +
      `This cannot be undone.`
    )) return;
    setBusy(true);
    try {
      const res = await inventoryFetch(`/inventory/purchase-orders/${orderId}/close-short`, {
        token, method: 'POST', body: { reason }
      });
      setClosingShort(false);
      setCloseReason('');
      setNotice(res.message || 'Purchase order closed short.');
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading purchase order...</div>;
  if (!order) return (
    <div style={{ padding: 24 }}>
      <button onClick={onBack} style={iconBtn}><ArrowLeft size={16} /></button>
      <div style={errorBox}>{error || 'Purchase order not found.'}</div>
    </div>
  );

  const st = STATUS_STYLES[order.status] || STATUS_STYLES.DRAFT;
  const isDraft = order.status === 'DRAFT';
  const isClosedShort = order.status === 'CLOSED_SHORT';
  const canReceive = RECEIVABLE.includes(order.status) && !isClosedShort;
  // A short close is only meaningful while something is still outstanding, and
  // a closed order is final — the server enforces both, this only matches it.
  const canCloseShort = canCorrect && order.status === 'PARTIALLY_RECEIVED';
  const totalOutstanding = (order.items || []).reduce((sum, it) => sum + outstandingOf(it), 0);

  return (
    <div style={{ padding: 24, color: '#fff', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <button onClick={onBack} style={iconBtn}><ArrowLeft size={16} /></button>
        <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, fontFamily: 'monospace' }}>{order.po_number}</h2>
        <span style={{ padding: '4px 10px', borderRadius: 12, fontSize: '0.75rem', fontWeight: 700, background: st.bg, color: st.fg }}>{st.label}</span>
      </div>

      {error && <div style={errorBox}>{error}</div>}
      {notice && <div style={noticeBox}>{notice}</div>}

      {isClosedShort && (
        <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(203,213,225,0.35)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 8 }}>
            <Ban size={16} color="#cbd5e1" /> Closed Short
          </div>
          <div style={{ fontSize: '0.85rem', color: '#cbd5e1', marginBottom: 10 }}>
            The outstanding balance on this order was written off as never arriving.
            Nothing was received for it and no stock was added.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Field label="Reason" value={order.close_short_reason || '—'} />
            <Field label="Closed By" value={order.closed_short_by_name || order.closed_short_by_uid || '—'} />
            <Field label="Closed At" value={order.closed_short_at ? new Date(order.closed_short_at).toLocaleString() : '—'} />
            <Field label="Written Off" value={`${formatQty(order.closed_short_outstanding_quantity || 0)} across ${(order.closed_short_outstanding || []).length} item(s)`} />
          </div>
          {(order.closed_short_outstanding || []).length > 0 && (
            <div style={{ marginTop: 10, fontSize: '0.82rem', color: '#94a3b8' }}>
              {order.closed_short_outstanding.map(o => (
                <div key={o.po_item_id}>
                  {o.product_name}: ordered <strong style={{ color: '#fff' }}>{formatQty(o.ordered_quantity)}</strong>,
                  {' '}received <strong style={{ color: '#10b981' }}>{formatQty(o.received_quantity)}</strong>,
                  {' '}<strong style={{ color: '#cbd5e1' }}>{formatQty(o.outstanding_quantity)} {o.unit} never delivered</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(56,189,248,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontWeight: 700 }}>
          <Building2 size={16} color="#38bdf8" /> Supplier
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Field label="Name" value={order.supplier_name_snapshot} />
          <Field label="Phone" value={order.supplier_phone_snapshot || '—'} />
          <Field label="GSTIN" value={order.supplier_gstin_snapshot || '—'} />
          <Field label="Address" value={order.supplier_address_snapshot || '—'} />
        </div>
        <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: 8 }}>
          Supplier details recorded when this order was created. Later changes to the supplier master do not alter this document.
        </div>
      </div>

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(255,255,255,0.08)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Field label="Source Request" value={order.source_request_number || order.source_request_id} mono />
        <Field label="Department" value={order.department || '—'} />
        <Field label="Location" value={order.location_name_snapshot || order.location_id} />
        <Field label="Requested By" value={order.requester_name_snapshot || '—'} />
        <Field label="Priority" value={order.priority || '—'} />
        <Field label="Business Date" value={order.business_date} />
        <Field label="Created By" value={order.created_by_name || '—'} />
        <Field label="Estimated Total" value={money(order.total_estimated_value)} />
      </div>

      <div className="glass" style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <th style={th}>#</th><th style={th}>Product</th><th style={th}>Category</th>
              <th style={th}>Ordered</th><th style={th}>Received</th><th style={th}>Outstanding</th>
              <th style={th}>Unit</th><th style={th}>Est. Rate</th><th style={th}>Est. Line Total</th>
            </tr>
          </thead>
          <tbody>
            {(order.items || []).map(it => (
              <tr key={it.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <td style={{ ...td, color: '#64748b' }}>{it.line_no}</td>
                <td style={{ ...td, fontWeight: 600 }}>
                  {it.product_name_snapshot} <span style={{ color: '#64748b' }}>({it.sku_snapshot})</span>
                </td>
                <td style={td}>{it.category_snapshot || '—'}</td>
                <td style={{ ...td, fontWeight: 700 }}>{formatQty(it.ordered_quantity)}</td>
                <td style={{ ...td, color: (Number(it.received_quantity) || 0) > 0 ? '#10b981' : '#64748b' }}>
                  {formatQty(it.received_quantity || 0)}
                </td>
                <td style={{ ...td, color: outstandingOf(it) > 0 ? '#f59e0b' : '#64748b' }}>
                  {formatQty(outstandingOf(it))}
                </td>
                <td style={td}>{it.unit_snapshot}</td>
                <td style={td}>{money(it.estimated_unit_cost)}</td>
                <td style={{ ...td, fontWeight: 700 }}>{money(it.estimated_line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {order.remarks && (
        <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(255,255,255,0.08)' }}>
          <Field label="Remarks" value={order.remarks} />
        </div>
      )}

      {receiving && (
        <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(56,189,248,0.4)' }}>
          <h3 style={{ margin: '0 0 4px 0', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            <PackageCheck size={16} color="#38bdf8" /> Receive Goods
          </h3>
          <div style={{ fontSize: '0.78rem', color: '#64748b', marginBottom: 12 }}>
            Enter what actually arrived. Stock increases by the quantity you accept here — leave an item blank if it did not arrive.
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: 'rgba(15,23,42,0.6)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={th}>Item</th><th style={th}>Ordered</th><th style={th}>Received</th>
                  <th style={th}>Outstanding</th><th style={th}>Receive Now</th><th style={th}>Unit</th><th style={th}>Variance</th>
                </tr>
              </thead>
              <tbody>
                {(order.items || []).map(it => {
                  const ordered = Number(it.ordered_quantity) || 0;
                  const already = Number(it.received_quantity) || 0;
                  const qty = Number(receiveQty[it.id]);
                  const over = Number.isFinite(qty) && qty > 0
                    ? Math.round((already + qty - ordered) * 1000) / 1000
                    : 0;
                  return (
                    <tr key={it.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ ...td, fontWeight: 600 }}>{it.product_name_snapshot}</td>
                      <td style={td}>{formatQty(ordered)}</td>
                      <td style={td}>{formatQty(already)}</td>
                      <td style={{ ...td, color: '#f59e0b' }}>{formatQty(outstandingOf(it))}</td>
                      <td style={td}>
                        <input type="number" step="any" min="0" value={receiveQty[it.id] ?? ''}
                          onChange={e => setReceiveQty(prev => ({ ...prev, [it.id]: e.target.value }))}
                          style={{ width: 90, padding: '6px 8px', borderRadius: 6, background: '#020617', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' }} />
                      </td>
                      <td style={td}>{it.unit_snapshot}</td>
                      <td style={td}>
                        {over > 0 ? (
                          <div>
                            <div style={{ color: '#f59e0b', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <AlertTriangle size={13} /> +{formatQty(over)} over
                            </div>
                            <input
                              value={varianceReason[it.id] || ''}
                              onChange={e => setVarianceReason(prev => ({ ...prev, [it.id]: e.target.value }))}
                              placeholder="Reason required *"
                              style={{ marginTop: 4, width: 190, padding: '5px 8px', borderRadius: 6, background: '#020617', border: '1px solid rgba(245,158,11,0.6)', color: '#fff', fontSize: '0.8rem' }} />
                          </div>
                        ) : <span style={{ color: '#64748b' }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>Delivery remarks</label>
            <input value={receiveRemarks} onChange={e => setReceiveRemarks(e.target.value)}
              placeholder="e.g. Delivered by supplier van, checked at gate"
              style={{ width: '100%', padding: '8px 12px', borderRadius: 6, background: '#020617', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' }} />
          </div>

          {receivingLines.length > 0 && (
            <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: 'rgba(15,23,42,0.6)' }}>
              <div style={{ fontWeight: 700, marginBottom: 6, fontSize: '0.9rem' }}>Receiving now</div>
              {receivingLines.map(l => (
                <div key={l.it.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '3px 0' }}>
                  <span>{l.it.product_name_snapshot}</span>
                  <span><strong>{formatQty(l.qty)} {l.it.unit_snapshot}</strong> · {money(l.qty * (Number(l.it.estimated_unit_cost) || 0))}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)', fontWeight: 800 }}>
                <span>Total value</span><span style={{ color: '#38bdf8' }}>{money(receivingValue)}</span>
              </div>
              {overLines.length > 0 && (
                <div style={{ marginTop: 8, color: '#f59e0b', fontSize: '0.82rem' }}>
                  {overLines.length} item{overLines.length > 1 ? 's' : ''} exceed the ordered quantity — a reason is required for each.
                </div>
              )}
              <div style={{ marginTop: 6, fontSize: '0.72rem', color: '#64748b' }}>
                Stock will increase by exactly these quantities. This records no invoice and no payment.
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
            <button onClick={() => setReceiving(false)} disabled={busy} style={secondaryBtn}>Cancel</button>
            <button onClick={submitReceipt} disabled={busy || receivingLines.length === 0} style={primaryBtn}>
              <PackageCheck size={15} /> {busy ? 'Posting...' : 'Receive Goods'}
            </button>
          </div>
        </div>
      )}

      {receipts.length > 0 && (
        <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 style={{ margin: '0 0 10px 0', fontSize: '0.95rem' }}>Deliveries ({receipts.length})</h3>
          {receipts.map(r => {
            // The receipt document is immutable and says nothing about
            // reversal; `r.reversal` is joined from goods_receipt_reversals.
            const rev = r.reversal || null;
            const isReversed = Boolean(rev);
            return (
              <div key={r.id} style={{
                padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.05)',
                opacity: isReversed ? 0.75 : 1
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontFamily: 'monospace', fontWeight: 700,
                      color: isReversed ? '#94a3b8' : '#38bdf8',
                      textDecoration: isReversed ? 'line-through' : 'none'
                    }}>{r.receipt_number}</span>
                    {isReversed && (
                      <span style={{
                        padding: '2px 8px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 800,
                        background: 'rgba(239,68,68,0.15)', color: '#f87171', letterSpacing: '0.04em'
                      }}>REVERSED</span>
                    )}
                  </span>
                  <span style={{ color: '#94a3b8', fontSize: '0.82rem' }}>
                    {new Date(r.received_at).toLocaleString()} · {r.received_by_name || r.received_by_uid} · {money(r.total_received_value)}
                  </span>
                </div>
                {(r.items || []).map(li => (
                  <div key={li.id} style={{ fontSize: '0.82rem', color: '#94a3b8', paddingLeft: 4 }}>
                    {li.product_name_snapshot}: <strong style={{ color: isReversed ? '#94a3b8' : '#fff' }}>{formatQty(li.received_quantity)} {li.unit_snapshot}</strong>
                    {li.variance_type === 'OVER' && (
                      <span style={{ color: '#f59e0b' }}> · +{formatQty(li.variance_quantity)} over ({li.variance_reason})</span>
                    )}
                    {!isReversed && li.outstanding_quantity > 0 && (
                      <span style={{ color: '#64748b' }}> · {formatQty(li.outstanding_quantity)} still outstanding</span>
                    )}
                  </div>
                ))}
                {r.remarks && <div style={{ fontSize: '0.8rem', color: '#64748b', paddingLeft: 4 }}>{r.remarks}</div>}

                {isReversed ? (
                  <div style={{
                    marginTop: 8, padding: '8px 10px', borderRadius: 6,
                    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
                    fontSize: '0.8rem', color: '#fca5a5'
                  }}>
                    <strong>Reversed</strong>
                    {rev.reversed_by_name ? ` by ${rev.reversed_by_name}` : ''}
                    {(rev.reversed_at || rev.created_at)
                      ? ` on ${new Date(rev.reversed_at || rev.created_at).toLocaleString()}`
                      : ''}
                    {rev.reason ? ` — ${rev.reason}` : ''}
                    <div style={{ color: '#94a3b8', marginTop: 3 }}>
                      The quantities above are kept for the record. Their stock effect has been cancelled.
                    </div>
                  </div>
                ) : canCorrect && !isClosedShort && (
                  <div style={{ marginTop: 8 }}>
                    <button onClick={() => startReversal(r)} disabled={busy} style={dangerBtn}>
                      <Undo2 size={14} /> Reverse this delivery
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {isClosedShort && receipts.some(r => !r.reversal) && (
            <div style={{ marginTop: 10, fontSize: '0.78rem', color: '#64748b' }}>
              This order was closed short, which is a final purchasing decision — its deliveries can no longer be reversed.
            </div>
          )}
        </div>
      )}

      {reversing && (
        <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(239,68,68,0.5)' }}>
          <h3 style={{ margin: '0 0 4px 0', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: 8, color: '#f87171' }}>
            <Undo2 size={16} /> Reverse Delivery {reversing.receipt_number}
          </h3>
          <div style={{ fontSize: '0.8rem', color: '#fca5a5', marginBottom: 12, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              This removes the stock this delivery added and reopens the purchase order for those quantities.
              The receipt is never deleted — it stays in the history marked REVERSED.
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
            <Field label="Receipt" value={reversing.receipt_number} mono />
            <Field label="Supplier" value={order.supplier_name_snapshot} />
            <Field label="Received On" value={new Date(reversing.received_at).toLocaleString()} />
            <Field label="Received By" value={reversing.received_by_name || reversing.received_by_uid || '—'} />
          </div>

          <div style={{ padding: 12, borderRadius: 8, background: 'rgba(15,23,42,0.6)', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6, fontSize: '0.9rem' }}>Stock that will be removed</div>
            {(reversing.items || []).map(li => (
              <div key={li.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '3px 0' }}>
                <span>{li.product_name_snapshot}</span>
                <span style={{ color: '#f87171', fontWeight: 700 }}>−{formatQty(li.received_quantity)} {li.unit_snapshot}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)', fontWeight: 800 }}>
              <span>Value reversed</span><span style={{ color: '#f87171' }}>{money(reversing.total_received_value)}</span>
            </div>
          </div>

          <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>
            Reason for reversal <span style={{ color: '#f87171' }}>*</span>
          </label>
          <input value={reverseReason} onChange={e => setReverseReason(e.target.value)}
            placeholder="e.g. Wrong quantity entered / Duplicate receipt / Wrong supplier delivery"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, background: '#020617', border: '1px solid rgba(239,68,68,0.5)', color: '#fff' }} />

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
            <button onClick={() => { setReversing(null); setError(''); }} disabled={busy} style={secondaryBtn}>Cancel</button>
            <button onClick={submitReversal} disabled={busy || reverseReason.trim().length < 3} style={dangerPrimaryBtn}>
              <Undo2 size={15} /> {busy ? 'Reversing...' : 'Reverse Delivery'}
            </button>
          </div>
        </div>
      )}

      {closingShort && (
        <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(203,213,225,0.4)' }}>
          <h3 style={{ margin: '0 0 4px 0', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            <XCircle size={16} color="#cbd5e1" /> Close {order.po_number} Short
          </h3>
          <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: 12 }}>
            Use this when the supplier will not deliver the rest. The outstanding balance is written off.
            No stock changes, no delivery is recorded, and nothing is received for the missing quantity.
          </div>

          <div style={{ overflowX: 'auto', marginBottom: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: 'rgba(15,23,42,0.6)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={th}>Item</th><th style={th}>Ordered</th><th style={th}>Received</th>
                  <th style={th}>Never Delivered</th><th style={th}>Unit</th>
                </tr>
              </thead>
              <tbody>
                {(order.items || []).filter(it => outstandingOf(it) > 0).map(it => (
                  <tr key={it.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ ...td, fontWeight: 600 }}>{it.product_name_snapshot}</td>
                    <td style={td}>{formatQty(it.ordered_quantity)}</td>
                    <td style={{ ...td, color: '#10b981' }}>{formatQty(it.received_quantity || 0)}</td>
                    <td style={{ ...td, color: '#cbd5e1', fontWeight: 700 }}>{formatQty(outstandingOf(it))}</td>
                    <td style={td}>{it.unit_snapshot}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>
            Reason for closing short <span style={{ color: '#f87171' }}>*</span>
          </label>
          <input value={closeReason} onChange={e => setCloseReason(e.target.value)}
            placeholder="e.g. Supplier confirmed the remaining quantity is unavailable"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, background: '#020617', border: '1px solid rgba(255,255,255,0.2)', color: '#fff' }} />

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
            <button onClick={() => { setClosingShort(false); setError(''); }} disabled={busy} style={secondaryBtn}>Cancel</button>
            <button onClick={submitShortClose} disabled={busy || closeReason.trim().length < 3} style={primaryBtn}>
              <XCircle size={15} /> {busy ? 'Closing...' : 'Close Short'}
            </button>
          </div>
        </div>
      )}

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(255,255,255,0.08)' }}>
        <h3 style={{ margin: '0 0 10px 0', fontSize: '0.95rem' }}>History</h3>
        {(order.status_history || []).map((h, i) => (
          <div key={i} style={{ fontSize: '0.85rem', padding: '4px 0', color: '#94a3b8' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 90, color: '#fff', fontWeight: 600 }}>{STATUS_STYLES[h.status]?.label || h.status}</span>
              <span>{new Date(h.at).toLocaleString()}</span>
              <span>{h.by_name || h.by_uid || ''}</span>
              {h.receipt_number && <span style={{ fontFamily: 'monospace', color: '#38bdf8' }}>{h.receipt_number}</span>}
              {h.reversed_receipt_number && (
                <span style={{ fontFamily: 'monospace', color: '#f87171' }}>
                  {h.reversed_receipt_number} reversed
                </span>
              )}
              {h.outstanding_quantity > 0 && h.status === 'CLOSED_SHORT' && (
                <span style={{ color: '#cbd5e1' }}>{formatQty(h.outstanding_quantity)} written off</span>
              )}
            </div>
            {h.reason && (
              <div style={{ paddingLeft: 102, fontSize: '0.8rem', color: '#64748b' }}>{h.reason}</div>
            )}
          </div>
        ))}
        {order.status === 'ISSUED' && (
          <div style={{ marginTop: 10, fontSize: '0.78rem', color: '#64748b' }}>
            {receipts.length > 0
              ? 'Every delivery recorded against this order has been reversed, so nothing is currently received and the full quantity is outstanding again.'
              : 'This order has been issued and its figures are now read-only. Record deliveries with Receive Goods — that is what changes stock.'}
          </div>
        )}
      </div>

      {isDraft && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button disabled={busy} onClick={issue} style={primaryBtn}>
            <Send size={15} /> {busy ? 'Issuing...' : 'Issue Purchase Order'}
          </button>
        </div>
      )}
      {(canReceive || canCloseShort) && !receiving && !closingShort && !reversing && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          {canCloseShort && (
            <button onClick={() => { setCloseReason(''); setNotice(''); setClosingShort(true); }} style={secondaryBtn}>
              <XCircle size={15} /> Close Short ({formatQty(totalOutstanding)} outstanding)
            </button>
          )}
          {canReceive && (
            <button onClick={startReceiving} style={primaryBtn}>
              <PackageCheck size={15} /> Receive Goods
            </button>
          )}
        </div>
      )}
      {order.status === 'RECEIVED' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, color: '#10b981', fontWeight: 600, fontSize: '0.9rem' }}>
          <CheckCircle2 size={16} /> Fully received — stock has been posted for every ordered item.
        </div>
      )}
      {isClosedShort && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, color: '#cbd5e1', fontWeight: 600, fontSize: '0.9rem' }}>
          <Ban size={16} /> Closed short — no further deliveries or corrections are accepted for this order.
        </div>
      )}
    </div>
  );
}

function Field({ label: l, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: 3 }}>{l}</div>
      <div style={{ fontWeight: 600, fontFamily: mono ? 'monospace' : undefined }}>{value}</div>
    </div>
  );
}

const th = { padding: '10px 14px' };
const td = { padding: '9px 14px' };
const selectStyle = { padding: '9px 12px', borderRadius: 6, background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' };
const iconBtn = { padding: 9, borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#94a3b8', cursor: 'pointer' };
const primaryBtn = { display: 'flex', alignItems: 'center', gap: 8, background: 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' };
const secondaryBtn = { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', fontWeight: 600, cursor: 'pointer' };
const dangerBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', color: '#f87171', fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer' };
const dangerPrimaryBtn = { display: 'flex', alignItems: 'center', gap: 8, background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' };
const errorBox = { background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', color: '#ef4444', padding: 12, borderRadius: 8, marginBottom: 16 };
const noticeBox = { background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.5)', color: '#10b981', padding: 12, borderRadius: 8, marginBottom: 16 };
function pagerBtn(disabled) {
  return { padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)', background: disabled ? 'rgba(255,255,255,0.02)' : 'rgba(15,23,42,0.6)', color: disabled ? '#475569' : '#fff', cursor: disabled ? 'not-allowed' : 'pointer' };
}
