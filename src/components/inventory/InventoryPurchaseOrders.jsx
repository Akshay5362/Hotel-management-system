/**
 * InventoryPurchaseOrders.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase E — Purchase Orders: list, detail and issuing.
 * Phase F — Goods receiving: record a delivery against an ISSUED or
 * PARTIALLY_RECEIVED order. Receiving is the ONLY action here that changes
 * stock, and it posts the quantity actually ACCEPTED (never the quantity
 * ordered).
 *
 * Phase G — Corrections: reverse a goods receipt that was recorded in error,
 * or close a partially received order short when the balance will never
 * arrive. A reversal never edits or deletes the original receipt — it posts a
 * compensating stock movement and records a separate reversal document. The
 * receipt stays in the delivery history exactly as it was written, shown as
 * REVERSED from the JOINED reversal record (`receipt.reversal`).
 *
 * Once ISSUED the order is read-only here, matching the server's state machine.
 * All controls are UX only; the server authorizes every call.
 *
 * Batch 5: presentation only. Every request, payload, confirmation dialog and
 * guard is the Phase E/F/G one. Additive props: `receivingOnly` (the Receiving
 * workspace shows only orders that can still take a delivery) and `embedded`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  FileText, Search, RefreshCw, ArrowLeft, Send, CheckCircle2, Building2,
  PackageCheck, AlertTriangle, Undo2, XCircle, Ban, ArrowRight
} from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';
import { Alert, Button, Card, EmptyState, Field, LoadingRows, Pager, StatusBadge, Table, Toolbar, humanError, money, fmtDateTime, PageHeader } from './ui';
import { PO_STATUS, PO_RECEIVABLE_STATUSES, statusOf } from './statusMaps';

const RECEIVABLE = PO_RECEIVABLE_STATUSES;

export default function InventoryPurchaseOrders({ token, openOrderId, onDeepLinkHandled, canCorrect = false, receivingOnly = false, embedded = false }) {
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
    ? <OrderDetail token={token} orderId={detailId} canCorrect={canCorrect} onBack={() => setView('list')} embedded={embedded} />
    : <OrderList token={token} receivingOnly={receivingOnly} embedded={embedded} onOpen={(id) => { setDetailId(id); setView('detail'); }} />;
}

/* ── List ─────────────────────────────────────────────────────────────────── */
const LIST_COLS = [
  { key: 'no', label: 'Order' },
  { key: 'sup', label: 'Supplier' },
  { key: 'loc', label: 'Department / location' },
  { key: 'items', label: 'Items', className: 'num' },
  { key: 'val', label: 'Estimated', className: 'num' },
  { key: 'date', label: 'Date' },
  { key: 'st', label: 'Status' },
  { key: 'a', label: '', className: 'action' }
];

function OrderList({ token, onOpen, receivingOnly, embedded }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // In receiving mode the default view is "everything that can still take a
  // delivery". The API filters by one status, so that view is two requests.
  const [status, setStatus] = useState(receivingOnly ? 'RECEIVABLE' : '');
  const [poNumber, setPoNumber] = useState('');
  const [cursor, setCursor] = useState(null);
  const [cursorStack, setCursorStack] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);

  const load = useCallback(async (cur = null) => {
    setLoading(true);
    setError('');
    try {
      const fetchStatus = async (st) => {
        const params = new URLSearchParams({ limit: '20' });
        if (st) params.set('status', st);
        if (poNumber.trim()) params.set('po_number', poNumber.trim());
        if (cur) params.set('cursor', cur);
        return inventoryFetch(`/inventory/purchase-orders?${params.toString()}`, { token });
      };
      if (status === 'RECEIVABLE') {
        const [a, b] = await Promise.all(RECEIVABLE.map(s => fetchStatus(s)));
        setOrders([...(a.orders || []), ...(b.orders || [])]);
        setNextCursor(null);
      } else {
        const data = await fetchStatus(status);
        setOrders(data.orders || []);
        setNextCursor(data.next_cursor || null);
      }
    } catch (err) {
      setError(humanError(err, 'Unable to load purchase orders right now. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, [token, status, poNumber]);

  useEffect(() => { setCursor(null); setCursorStack([]); load(null); }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {!embedded || receivingOnly ? (
        <PageHeader
          icon={receivingOnly ? PackageCheck : FileText}
          title={receivingOnly ? 'Receive Against Purchase Order' : 'Purchase Orders'}
          subtitle={receivingOnly
            ? 'Choose the order the delivery belongs to, then compare what was ordered with what arrived.'
            : 'Raised from an approved purchase request. Creating or issuing an order never changes stock.'}
        />
      ) : null}

      <Toolbar>
        <div className="inv-search" style={{ flex: '0 1 220px' }}>
          <Search size={14} />
          <input className="inv-input" value={poNumber} onChange={e => setPoNumber(e.target.value)} placeholder="Order number" aria-label="Order number" />
        </div>
        <select className="inv-select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          {receivingOnly ? <option value="RECEIVABLE">Awaiting delivery</option> : <option value="">Status</option>}
          <option value="DRAFT">Draft</option>
          <option value="ISSUED">Issued</option>
          <option value="PARTIALLY_RECEIVED">Partially received</option>
          <option value="RECEIVED">Received</option>
          <option value="CLOSED_SHORT">Closed short</option>
        </select>
        <div className="inv-spacer" />
        <Button variant="ghost" icon={RefreshCw} onClick={() => load(cursor)} title="Refresh" aria-label="Refresh" />
      </Toolbar>

      {error ? <Alert tone="error" onRetry={() => load(cursor)}>{error}</Alert> : null}

      <Card>
        <Table columns={LIST_COLS}>
          {loading ? <LoadingRows columns={LIST_COLS.length} rows={6} /> : null}
          {!loading && orders.length === 0 ? (
            <tr><td colSpan={LIST_COLS.length}>
              {receivingOnly && status === 'RECEIVABLE'
                ? <EmptyState icon={PackageCheck} title="No orders are awaiting delivery" text="Issued orders will appear here until they are fully received or closed." />
                : <EmptyState title="No purchase orders" text="Approve a purchase request, then raise its order from the request." />}
            </td></tr>
          ) : null}
          {!loading && orders.map(o => {
            const st = statusOf(PO_STATUS, o.status);
            return (
              <tr key={o.id} className="row-link" onClick={() => onOpen(o.id)}>
                <td className="mono">{o.po_number}{o.source_request_number ? <span className="inv-cell-sub" style={{ fontFamily: 'inherit', color: 'var(--inv-muted)' }}>from {o.source_request_number}</span> : null}</td>
                <td className="strong">{o.supplier_name_snapshot}</td>
                <td>{o.department || '—'}<span className="inv-cell-sub">{o.location_name_snapshot || o.location_id}</span></td>
                <td className="num">{o.item_count}</td>
                <td className="num strong">{money(o.total_estimated_value)}</td>
                <td className="muted nowrap">{o.business_date}</td>
                <td><StatusBadge label={st.label} tone={st.tone} /></td>
                <td className="action">
                  {receivingOnly && RECEIVABLE.includes(o.status)
                    ? <Button size="sm" variant="primary" icon={PackageCheck}>Receive</Button>
                    : <Button size="sm" variant="ghost" icon={ArrowRight}>Open</Button>}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>

      {status !== 'RECEIVABLE' ? (
        <Pager canPrev={cursorStack.length > 0} canNext={Boolean(nextCursor)}
          onPrev={() => { const stack = [...cursorStack]; const prev = stack.pop() || null; setCursorStack(stack); setCursor(prev); load(prev); }}
          onNext={() => { setCursorStack(s => [...s, cursor]); setCursor(nextCursor); load(nextCursor); }} />
      ) : null}
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
    } catch (err) { setError(humanError(err)); } finally { setLoading(false); }
  }, [token, orderId]);

  useEffect(() => { load(); }, [load]);

  const issue = async () => {
    if (!window.confirm('Issue this purchase order? Once issued it becomes a permanent, read-only document.')) return;
    setBusy(true); setError('');
    try {
      await inventoryFetch(`/inventory/purchase-orders/${orderId}/issue`, { token, method: 'POST', body: {} });
      await load();
    } catch (err) { setError(humanError(err)); } finally { setBusy(false); }
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
    } catch (err) { setError(humanError(err)); } finally { setBusy(false); }
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
    } catch (err) { setError(humanError(err)); } finally { setBusy(false); }
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
    } catch (err) { setError(humanError(err)); } finally { setBusy(false); }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 8 }}>
        {[40, 70, 55, 65].map((w, i) => <span key={i} className="inv-skel" style={{ width: `${w}%` }} />)}
      </div>
    );
  }
  if (!order) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div><Button variant="ghost" icon={ArrowLeft} onClick={onBack}>Back</Button></div>
      <Alert tone="error" onRetry={load}>{error || 'This purchase order could not be found.'}</Alert>
    </div>
  );

  const st = statusOf(PO_STATUS, order.status);
  const isDraft = order.status === 'DRAFT';
  const isClosedShort = order.status === 'CLOSED_SHORT';
  const canReceive = RECEIVABLE.includes(order.status) && !isClosedShort;
  // A short close is only meaningful while something is still outstanding, and
  // a closed order is final — the server enforces both, this only matches it.
  const canCloseShort = canCorrect && order.status === 'PARTIALLY_RECEIVED';
  const totalOutstanding = (order.items || []).reduce((sum, it) => sum + outstandingOf(it), 0);

  /** Line status in words: what a storekeeper needs to know at a glance. */
  const lineState = (it) => {
    const ordered = Number(it.ordered_quantity) || 0;
    const received = Number(it.received_quantity) || 0;
    if (received <= 0) return { label: 'Not received', tone: 'neutral' };
    if (received < ordered) return { label: 'Short', tone: 'warn' };
    if (received > ordered) return { label: 'Over', tone: 'bad' };
    return { label: 'Complete', tone: 'ok' };
  };

  const ITEM_COLS = [
    { key: 'p', label: 'Item' }, { key: 'o', label: 'Ordered', className: 'num' }, { key: 'r', label: 'Received', className: 'num' },
    { key: 'rem', label: 'Remaining', className: 'num' }, { key: 'u', label: 'Unit' }, { key: 's', label: 'Status' }, { key: 'v', label: 'Est. value', className: 'num' }
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader
        title={<><Button variant="ghost" icon={ArrowLeft} onClick={onBack} aria-label="Back" style={{ marginRight: 4 }} /><span style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--inv-accent)' }}>{order.po_number}</span> <StatusBadge label={st.label} tone={st.tone} /></>}
        subtitle={`${order.supplier_name_snapshot} · ${order.location_name_snapshot || order.location_id} · ${order.business_date} · from ${order.source_request_number || order.source_request_id}`}
        actions={
          <>
            {isDraft ? <Button variant="primary" icon={Send} disabled={busy} onClick={issue}>{busy ? 'Issuing…' : 'Issue purchase order'}</Button> : null}
            {canCloseShort && !receiving && !closingShort && !reversing ? (
              <Button icon={XCircle} onClick={() => { setCloseReason(''); setNotice(''); setClosingShort(true); }}>Close short ({formatQty(totalOutstanding)} outstanding)</Button>
            ) : null}
            {canReceive && !receiving && !closingShort && !reversing ? (
              <Button variant="primary" icon={PackageCheck} onClick={startReceiving}>Receive goods</Button>
            ) : null}
          </>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError('')}>{error}</Alert> : null}
      {notice ? <Alert tone="ok" onDismiss={() => setNotice('')}>{notice}</Alert> : null}

      {order.status === 'RECEIVED' ? <Alert tone="ok" title="Fully received">Stock has been posted for every ordered item.</Alert> : null}
      {isClosedShort ? (
        <Alert tone="warn" title="Closed short">
          The outstanding balance on this order was written off as never arriving. Nothing was received for it and no stock was added.
          {order.close_short_reason ? <div style={{ marginTop: 4 }}>Reason: {order.close_short_reason}</div> : null}
          <div className="inv-hint" style={{ color: 'inherit', opacity: 0.8 }}>
            {order.closed_short_by_name || order.closed_short_by_uid || ''}{order.closed_short_at ? ` · ${fmtDateTime(order.closed_short_at)}` : ''} · {formatQty(order.closed_short_outstanding_quantity || 0)} written off across {(order.closed_short_outstanding || []).length} item(s)
          </div>
        </Alert>
      ) : null}

      {receiving ? (
        <Card title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><PackageCheck size={14} color="var(--inv-accent)" /> Receive goods</span>} style={{ borderColor: 'rgba(56,189,248,0.4)' }}>
          <div className="inv-hint" style={{ padding: '10px 14px 0 14px' }}>
            Enter what actually arrived. Stock increases by the quantity you accept here. Leave an item blank if it did not arrive.
          </div>
          <Table columns={[
            { key: 'i', label: 'Item' }, { key: 'o', label: 'Ordered', className: 'num' }, { key: 'r', label: 'Received so far', className: 'num' },
            { key: 'rem', label: 'Remaining', className: 'num' }, { key: 'now', label: 'Receive now', className: 'num' }, { key: 'u', label: 'Unit' }, { key: 'v', label: 'Variance' }
          ]}>
            {(order.items || []).map(it => {
              const ordered = Number(it.ordered_quantity) || 0;
              const already = Number(it.received_quantity) || 0;
              const qty = Number(receiveQty[it.id]);
              const over = Number.isFinite(qty) && qty > 0 ? Math.round((already + qty - ordered) * 1000) / 1000 : 0;
              const short = Number.isFinite(qty) && qty > 0 && already + qty < ordered ? Math.round((ordered - already - qty) * 1000) / 1000 : 0;
              return (
                <tr key={it.id}>
                  <td className="strong">{it.product_name_snapshot}<span className="inv-cell-sub">{it.sku_snapshot}</span></td>
                  <td className="num">{formatQty(ordered)}</td>
                  <td className="num muted">{formatQty(already)}</td>
                  <td className="num" style={{ color: outstandingOf(it) > 0 ? 'var(--inv-warn)' : 'var(--inv-muted)' }}>{formatQty(outstandingOf(it))}</td>
                  <td className="num">
                    <input className="inv-input" type="number" step="any" min="0" value={receiveQty[it.id] ?? ''}
                      onChange={e => setReceiveQty(prev => ({ ...prev, [it.id]: e.target.value }))}
                      style={{ width: 96, height: 30, textAlign: 'right' }} aria-label={`Receive quantity for ${it.product_name_snapshot}`} />
                  </td>
                  <td className="muted">{it.unit_snapshot}</td>
                  <td>
                    {over > 0 ? (
                      <div>
                        <StatusBadge label={`Over by ${formatQty(over)}`} tone="bad" icon={AlertTriangle} />
                        <input className={`inv-input${!String(varianceReason[it.id] || '').trim() ? ' invalid' : ''}`}
                          value={varianceReason[it.id] || ''}
                          onChange={e => setVarianceReason(prev => ({ ...prev, [it.id]: e.target.value }))}
                          placeholder="Reason required"
                          style={{ marginTop: 5, width: 200, height: 28, fontSize: '0.78rem' }} aria-label="Over-receipt reason" />
                      </div>
                    ) : short > 0 ? (
                      <StatusBadge label={`Short by ${formatQty(short)}`} tone="warn" />
                    ) : Number.isFinite(qty) && qty > 0 ? (
                      <StatusBadge label="Exact" tone="ok" />
                    ) : <span className="muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </Table>
          <div className="inv-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Field label="Delivery remarks">
              <input className="inv-input" value={receiveRemarks} onChange={e => setReceiveRemarks(e.target.value)} placeholder="e.g. Delivered by supplier van, checked at gate" />
            </Field>
            {receivingLines.length > 0 ? (
              <div className="inv-card" style={{ padding: 12 }}>
                <div className="inv-section-title">Receiving now</div>
                {receivingLines.map(l => (
                  <div key={l.it.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem', padding: '3px 0' }}>
                    <span>{l.it.product_name_snapshot}</span>
                    <span><strong>{formatQty(l.qty)} {l.it.unit_snapshot}</strong> · {money(l.qty * (Number(l.it.estimated_unit_cost) || 0))}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--inv-line)', fontWeight: 800 }}>
                  <span>Total value</span><span style={{ color: 'var(--inv-accent)' }}>{money(receivingValue)}</span>
                </div>
                {overLines.length > 0 ? (
                  <div style={{ marginTop: 8, color: 'var(--inv-warn)', fontSize: '0.8rem' }}>
                    {overLines.length} item{overLines.length > 1 ? 's' : ''} exceed the ordered quantity — a reason is required for each.
                  </div>
                ) : null}
                <div className="inv-hint">Stock will increase by exactly these quantities. This records no invoice and no payment.</div>
              </div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={() => setReceiving(false)} disabled={busy}>Cancel</Button>
              <Button variant="primary" icon={PackageCheck} onClick={submitReceipt} disabled={busy || receivingLines.length === 0}>{busy ? 'Posting…' : 'Confirm delivery'}</Button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <Table columns={ITEM_COLS}>
          {(order.items || []).map(it => {
            const ls = lineState(it);
            return (
              <tr key={it.id}>
                <td><span className="strong">{it.product_name_snapshot}</span><span className="inv-cell-sub">{it.sku_snapshot}{it.category_snapshot ? ` · ${it.category_snapshot}` : ''}</span></td>
                <td className="num strong">{formatQty(it.ordered_quantity)}</td>
                <td className="num" style={{ color: (Number(it.received_quantity) || 0) > 0 ? 'var(--inv-ok)' : 'var(--inv-muted)' }}>{formatQty(it.received_quantity || 0)}</td>
                <td className="num" style={{ color: outstandingOf(it) > 0 ? 'var(--inv-warn)' : 'var(--inv-muted)' }}>{formatQty(outstandingOf(it))}</td>
                <td className="muted">{it.unit_snapshot}</td>
                <td><StatusBadge label={ls.label} tone={ls.tone} /></td>
                <td className="num muted">{money(it.estimated_line_total)}<span className="inv-cell-sub">@ {money(it.estimated_unit_cost)}</span></td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <div className="inv-two-col">
        <Card title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Building2 size={13} /> Supplier</span>} padded>
          <div className="inv-kv">
            <div><span>Name</span><strong style={{ fontSize: '0.88rem' }}>{order.supplier_name_snapshot}</strong></div>
            <div><span>Phone</span><strong style={{ fontSize: '0.88rem' }}>{order.supplier_phone_snapshot || '—'}</strong></div>
            <div><span>GSTIN</span><strong style={{ fontSize: '0.88rem' }}>{order.supplier_gstin_snapshot || '—'}</strong></div>
            <div><span>Address</span><strong style={{ fontSize: '0.86rem', fontWeight: 500 }}>{order.supplier_address_snapshot || '—'}</strong></div>
          </div>
          <div className="inv-hint" style={{ marginTop: 8 }}>Recorded when the order was created; later changes to the supplier master do not alter this document.</div>
        </Card>
        <Card title="Order" padded>
          <div className="inv-kv">
            <div><span>Requested by</span><strong style={{ fontSize: '0.88rem' }}>{order.requester_name_snapshot || '—'}</strong></div>
            <div><span>Department</span><strong style={{ fontSize: '0.88rem' }}>{order.department || '—'}</strong></div>
            <div><span>Priority</span><strong style={{ fontSize: '0.88rem' }}>{order.priority || '—'}</strong></div>
            <div><span>Created by</span><strong style={{ fontSize: '0.88rem' }}>{order.created_by_name || '—'}</strong></div>
            <div><span>Estimated total</span><strong>{money(order.total_estimated_value)}</strong></div>
          </div>
          {order.remarks ? <div className="inv-hint" style={{ marginTop: 8 }}>Remarks: {order.remarks}</div> : null}
        </Card>
      </div>

      {receipts.length > 0 ? (
        <Card title={`Deliveries (${receipts.length})`}>
          {receipts.map(r => {
            // The receipt document is immutable and says nothing about
            // reversal; `r.reversal` is joined from goods_receipt_reversals.
            const rev = r.reversal || null;
            const isReversed = Boolean(rev);
            return (
              <div key={r.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--inv-line)', opacity: isReversed ? 0.75 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontWeight: 700, color: isReversed ? 'var(--inv-muted)' : 'var(--inv-accent)', textDecoration: isReversed ? 'line-through' : 'none' }}>{r.receipt_number}</span>
                    {isReversed ? <StatusBadge label="Reversed" tone="bad" /> : <StatusBadge label="Received" tone="ok" />}
                  </span>
                  <span className="inv-hint" style={{ margin: 0 }}>{fmtDateTime(r.received_at)} · {r.received_by_name || r.received_by_uid} · {money(r.total_received_value)}</span>
                </div>
                {(r.items || []).map(li => (
                  <div key={li.id} style={{ fontSize: '0.8rem', color: 'var(--inv-muted)', paddingLeft: 4, marginTop: 2 }}>
                    {li.product_name_snapshot}: <strong style={{ color: isReversed ? 'var(--inv-muted)' : 'var(--inv-text)' }}>{formatQty(li.received_quantity)} {li.unit_snapshot}</strong>
                    {li.variance_type === 'OVER' ? <span style={{ color: 'var(--inv-warn)' }}> · +{formatQty(li.variance_quantity)} over ({li.variance_reason})</span> : null}
                    {!isReversed && li.outstanding_quantity > 0 ? <span> · {formatQty(li.outstanding_quantity)} still outstanding</span> : null}
                  </div>
                ))}
                {r.remarks ? <div className="inv-hint" style={{ paddingLeft: 4 }}>{r.remarks}</div> : null}
                {isReversed ? (
                  <div className="inv-alert error" style={{ marginTop: 8, padding: '8px 10px', fontSize: '0.78rem' }}>
                    <div>
                      <strong>Reversed</strong>{rev.reversed_by_name ? ` by ${rev.reversed_by_name}` : ''}{(rev.reversed_at || rev.created_at) ? ` on ${fmtDateTime(rev.reversed_at || rev.created_at)}` : ''}{rev.reason ? ` — ${rev.reason}` : ''}
                      <div style={{ opacity: 0.8, marginTop: 3 }}>The quantities above are kept for the record. Their stock effect has been cancelled.</div>
                    </div>
                  </div>
                ) : canCorrect && !isClosedShort ? (
                  <div style={{ marginTop: 8 }}>
                    <Button size="sm" variant="danger" icon={Undo2} onClick={() => startReversal(r)} disabled={busy}>Reverse this delivery</Button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {isClosedShort && receipts.some(r => !r.reversal) ? (
            <div className="inv-hint" style={{ padding: '8px 14px' }}>This order was closed short, which is a final purchasing decision — its deliveries can no longer be reversed.</div>
          ) : null}
        </Card>
      ) : null}

      {reversing ? (
        <Card title={<span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--inv-bad)' }}><Undo2 size={14} /> Reverse delivery {reversing.receipt_number}</span>} padded style={{ borderColor: 'rgba(248,113,113,0.5)' }}>
          <Alert tone="error">This removes the stock this delivery added and reopens the purchase order for those quantities. The receipt is never deleted — it stays in the history marked Reversed.</Alert>
          <div className="inv-kv" style={{ margin: '12px 0' }}>
            <div><span>Receipt</span><strong style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{reversing.receipt_number}</strong></div>
            <div><span>Supplier</span><strong style={{ fontSize: '0.88rem' }}>{order.supplier_name_snapshot}</strong></div>
            <div><span>Received on</span><strong style={{ fontSize: '0.88rem' }}>{fmtDateTime(reversing.received_at)}</strong></div>
            <div><span>Received by</span><strong style={{ fontSize: '0.88rem' }}>{reversing.received_by_name || reversing.received_by_uid || '—'}</strong></div>
          </div>
          <div className="inv-card" style={{ padding: 12, marginBottom: 12 }}>
            <div className="inv-section-title">Stock that will be removed</div>
            {(reversing.items || []).map(li => (
              <div key={li.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem', padding: '3px 0' }}>
                <span>{li.product_name_snapshot}</span>
                <span style={{ color: 'var(--inv-bad)', fontWeight: 700 }}>−{formatQty(li.received_quantity)} {li.unit_snapshot}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--inv-line)', fontWeight: 800 }}>
              <span>Value reversed</span><span style={{ color: 'var(--inv-bad)' }}>{money(reversing.total_received_value)}</span>
            </div>
          </div>
          <Field label="Reason for reversal" required>
            <input className="inv-input" value={reverseReason} onChange={e => setReverseReason(e.target.value)} placeholder="e.g. Wrong quantity entered / Duplicate receipt / Wrong supplier delivery" />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <Button onClick={() => { setReversing(null); setError(''); }} disabled={busy}>Cancel</Button>
            <Button variant="danger" icon={Undo2} onClick={submitReversal} disabled={busy || reverseReason.trim().length < 3}>{busy ? 'Reversing…' : 'Reverse delivery'}</Button>
          </div>
        </Card>
      ) : null}

      {closingShort ? (
        <Card title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><XCircle size={14} /> Close {order.po_number} short</span>} padded style={{ borderColor: 'rgba(203,213,225,0.4)' }}>
          <div className="inv-hint" style={{ marginBottom: 10 }}>
            Use this when the supplier will not deliver the rest. The outstanding balance is written off. No stock changes, no delivery is recorded, and nothing is received for the missing quantity.
          </div>
          <Table columns={[{ key: 'i', label: 'Item' }, { key: 'o', label: 'Ordered', className: 'num' }, { key: 'r', label: 'Received', className: 'num' }, { key: 'n', label: 'Never delivered', className: 'num' }, { key: 'u', label: 'Unit' }]}>
            {(order.items || []).filter(it => outstandingOf(it) > 0).map(it => (
              <tr key={it.id}>
                <td className="strong">{it.product_name_snapshot}</td>
                <td className="num">{formatQty(it.ordered_quantity)}</td>
                <td className="num" style={{ color: 'var(--inv-ok)' }}>{formatQty(it.received_quantity || 0)}</td>
                <td className="num strong">{formatQty(outstandingOf(it))}</td>
                <td className="muted">{it.unit_snapshot}</td>
              </tr>
            ))}
          </Table>
          <div style={{ marginTop: 12 }}>
            <Field label="Reason for closing short" required>
              <input className="inv-input" value={closeReason} onChange={e => setCloseReason(e.target.value)} placeholder="e.g. Supplier confirmed the remaining quantity is unavailable" />
            </Field>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <Button onClick={() => { setClosingShort(false); setError(''); }} disabled={busy}>Cancel</Button>
            <Button variant="primary" icon={XCircle} onClick={submitShortClose} disabled={busy || closeReason.trim().length < 3}>{busy ? 'Closing…' : 'Close short'}</Button>
          </div>
        </Card>
      ) : null}

      <Card title="History" padded>
        {(order.status_history || []).map((h, i) => (
          <div key={i} style={{ fontSize: '0.82rem', padding: '3px 0', color: 'var(--inv-muted)' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 130, color: 'var(--inv-text)', fontWeight: 600 }}>{statusOf(PO_STATUS, h.status).label}</span>
              <span>{fmtDateTime(h.at)}</span>
              <span>{h.by_name || h.by_uid || ''}</span>
              {h.receipt_number ? <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--inv-accent)' }}>{h.receipt_number}</span> : null}
              {h.reversed_receipt_number ? <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--inv-bad)' }}>{h.reversed_receipt_number} reversed</span> : null}
              {h.outstanding_quantity > 0 && h.status === 'CLOSED_SHORT' ? <span>{formatQty(h.outstanding_quantity)} written off</span> : null}
            </div>
            {h.reason ? <div className="inv-hint" style={{ paddingLeft: 142 }}>{h.reason}</div> : null}
          </div>
        ))}
        {order.status === 'ISSUED' ? (
          <div className="inv-hint" style={{ marginTop: 8 }}>
            {receipts.length > 0
              ? 'Every delivery recorded against this order has been reversed, so nothing is currently received and the full quantity is outstanding again.'
              : 'This order has been issued and its figures are now read-only. Record deliveries with Receive goods — that is what changes stock.'}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
