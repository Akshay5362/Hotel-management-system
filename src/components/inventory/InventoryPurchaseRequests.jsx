/**
 * InventoryPurchaseRequests.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase B — Purchase Requests: list, create (draft → submit), and detail.
 * Phase C — Approval engine: an authorized approver can APPROVE or REJECT a
 * PENDING_APPROVAL request from the detail view.
 *
 * A purchase request ASKS for permission to buy. It is not an order, not a
 * receipt and not a stock addition — nothing on this screen changes inventory,
 * and the estimated totals shown here are review figures only, never a
 * financial posting. Approving is a DECISION, not a purchase: it does not add
 * stock, create a movement or pay anyone.
 *
 * Every control here is UX only. Approval rights come from the server's
 * settings-driven config, a requester can never approve their own request, and
 * both rules are re-enforced server-side on every call.
 *
 * Batch 5: presentation only. Every request, payload, guard and message is the
 * Phase B/C/E one. Two additive props: `openCreateNonce` (a parent asks for
 * the create form to open) and `embedded` (the parent already provides the
 * page frame).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClipboardList, Plus, Search, RefreshCw, Send, XCircle, ArrowLeft, Trash2, Save,
  CheckCircle2, ThumbsDown, ArrowRight
} from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';
import { Alert, Button, Card, EmptyState, Field, LoadingRows, Pager, StatusBadge, Table, Toolbar, humanError, money, fmtDateTime, PageHeader } from './ui';
import { PR_STATUS, statusOf } from './statusMaps';

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export default function InventoryPurchaseRequests({ token, currentUserUid, openRequestId, onDeepLinkHandled, canManageOrders, onOpenPurchaseOrder, openCreateNonce = 0, presetProductId = null, embedded = false }) {
  const [view, setView] = useState('list');       // 'list' | 'create' | 'detail'
  const [detailId, setDetailId] = useState(null);

  // Deep link from a "Purchase Request Pending Approval" notification: open
  // that request's detail directly. Pure state — no URL navigation, so it is
  // safe under Electron's file:// origin.
  useEffect(() => {
    if (!openRequestId) return;
    setDetailId(openRequestId);
    setView('detail');
    if (onDeepLinkHandled) onDeepLinkHandled();
  }, [openRequestId, onDeepLinkHandled]);

  // A parent (Overview's "+ Purchase Request", the workspace header) asks for
  // the create form. A counter rather than a boolean, so asking twice works.
  useEffect(() => { if (openCreateNonce > 0) setView('create'); }, [openCreateNonce]);

  return view === 'create'
    ? <CreateRequest token={token} presetProductId={presetProductId} onDone={() => setView('list')} onCancel={() => setView('list')} embedded={embedded} />
    : view === 'detail'
      ? <RequestDetail token={token} requestId={detailId} currentUserUid={currentUserUid} onBack={() => setView('list')}
          canManageOrders={canManageOrders} onOpenPurchaseOrder={onOpenPurchaseOrder} embedded={embedded} />
      : <RequestList
          token={token}
          embedded={embedded}
          onCreate={() => setView('create')}
          onOpen={(id) => { setDetailId(id); setView('detail'); }}
        />;
}

/* ── List ─────────────────────────────────────────────────────────────────── */
const LIST_COLS = [
  { key: 'no', label: 'Request' },
  { key: 'dept', label: 'Department / location' },
  { key: 'items', label: 'Items', className: 'num' },
  { key: 'val', label: 'Estimated', className: 'num' },
  { key: 'by', label: 'Requested by' },
  { key: 'date', label: 'Date' },
  { key: 'st', label: 'Status' },
  { key: 'a', label: '', className: 'action' }
];

function RequestList({ token, onCreate, onOpen, embedded }) {
  const [requests, setRequests] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [locationId, setLocationId] = useState('');
  const [requestNumber, setRequestNumber] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState(null);
  const [cursorStack, setCursorStack] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);

  useEffect(() => {
    inventoryFetch('/inventory/locations', { token })
      .then(d => setLocations((d.locations || []).filter(l => l.is_active !== false)))
      .catch(() => {});
  }, [token]);

  const load = useCallback(async (cur = null) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (status) params.set('status', status);
      if (locationId) params.set('location_id', locationId);
      if (requestNumber.trim()) params.set('request_number', requestNumber.trim());
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (cur) params.set('cursor', cur);
      const data = await inventoryFetch(`/inventory/purchase-requests?${params.toString()}`, { token });
      setRequests(data.requests || []);
      setNextCursor(data.next_cursor || null);
    } catch (err) {
      setError(humanError(err, 'Unable to load purchase requests right now. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, [token, status, locationId, requestNumber, from, to]);

  useEffect(() => { setCursor(null); setCursorStack([]); load(null); }, [load]);

  const hasFilters = Boolean(status || locationId || requestNumber || from || to);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {!embedded ? (
        <PageHeader icon={ClipboardList} title="Purchase Requests" subtitle="Ask for stock to be bought. A request never changes stock."
          actions={<Button variant="primary" icon={Plus} onClick={onCreate}>New Request</Button>} />
      ) : null}

      <Toolbar>
        <div className="inv-search" style={{ flex: '0 1 220px' }}>
          <Search size={14} />
          <input className="inv-input" value={requestNumber} onChange={e => setRequestNumber(e.target.value)} placeholder="Request number" aria-label="Request number" />
        </div>
        <select className="inv-select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">Status</option>
          <option value="DRAFT">Draft</option>
          <option value="PENDING_APPROVAL">Pending approval</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <select className="inv-select" value={locationId} onChange={e => setLocationId(e.target.value)} aria-label="Location">
          <option value="">Location</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input className="inv-input" style={{ width: 'auto' }} type="date" value={from} onChange={e => setFrom(e.target.value)} title="From business date" aria-label="From date" />
        <input className="inv-input" style={{ width: 'auto' }} type="date" value={to} onChange={e => setTo(e.target.value)} title="To business date" aria-label="To date" />
        <div className="inv-spacer" />
        {hasFilters ? <Button size="sm" variant="ghost" onClick={() => { setStatus(''); setLocationId(''); setRequestNumber(''); setFrom(''); setTo(''); }}>Clear</Button> : null}
        <Button variant="ghost" icon={RefreshCw} onClick={() => load(cursor)} title="Refresh" aria-label="Refresh" />
      </Toolbar>

      {error ? <Alert tone="error" onRetry={() => load(cursor)}>{error}</Alert> : null}

      <Card>
        <Table columns={LIST_COLS}>
          {loading ? <LoadingRows columns={LIST_COLS.length} rows={6} /> : null}
          {!loading && requests.length === 0 ? (
            <tr><td colSpan={LIST_COLS.length}>
              {hasFilters
                ? <EmptyState title="No purchase requests match" text="Try different filters." />
                : <EmptyState title="No purchase requests yet" text="Raise one when stock needs to be bought. It goes to an approver before anything is ordered."
                    action={<Button size="sm" variant="primary" icon={Plus} onClick={onCreate}>New Request</Button>} />}
            </td></tr>
          ) : null}
          {!loading && requests.map(r => {
            const st = statusOf(PR_STATUS, r.status);
            return (
              <tr key={r.id} className="row-link" onClick={() => onOpen(r.id)}>
                <td className="mono">{r.request_number || 'Draft'}{r.priority && r.priority !== 'NORMAL' ? <span className="inv-cell-sub" style={{ fontFamily: 'inherit', color: r.priority === 'URGENT' ? 'var(--inv-bad)' : 'var(--inv-warn)' }}>{r.priority}</span> : null}</td>
                <td>{r.department || '—'}<span className="inv-cell-sub">{r.location_name_snapshot || r.location_id}</span></td>
                <td className="num">{r.item_count}</td>
                <td className="num strong">{money(r.total_estimated_value)}</td>
                <td>{r.requested_by_name || r.requested_by_uid || '—'}</td>
                <td className="muted nowrap">{r.business_date}</td>
                <td><StatusBadge label={st.label} tone={st.tone} /></td>
                <td className="action"><Button size="sm" variant="ghost" icon={ArrowRight}>Open</Button></td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Pager canPrev={cursorStack.length > 0} canNext={Boolean(nextCursor)}
        onPrev={() => { const stack = [...cursorStack]; const prev = stack.pop() || null; setCursorStack(stack); setCursor(prev); load(prev); }}
        onNext={() => { setCursorStack(s => [...s, cursor]); setCursor(nextCursor); load(nextCursor); }} />
    </div>
  );
}

/* ── Create ───────────────────────────────────────────────────────────────── */
function CreateRequest({ token, onDone, onCancel, presetProductId, embedded }) {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [locations, setLocations] = useState([]);
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [lines, setLines] = useState({});          // product_id → quantity string
  const [locationId, setLocationId] = useState('');
  const [department, setDepartment] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [reason, setReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Stable per-form key so an accidental double-click cannot create two drafts.
  const [idempotencyKey] = useState(() => `pr_ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    (async () => {
      try {
        const [p, c, l] = await Promise.all([
          inventoryFetch('/inventory/products?page_size=100&status=Active', { token }),
          inventoryFetch('/inventory/categories', { token }),
          inventoryFetch('/inventory/locations', { token })
        ]);
        const prods = p.products || [];
        setProducts(prods);
        setCategories(c.categories || []);
        const locs = (l.locations || []).filter(x => x.is_active !== false);
        setLocations(locs);
        const def = locs.find(x => x.is_default) || locs[0];
        if (def) { setLocationId(def.id); setDepartment(def.department || ''); }
        // Arriving from a low-stock row: bring that item to the top of the list.
        if (presetProductId) {
          const hit = prods.find(x => x.id === presetProductId);
          if (hit) setSearch(hit.name);
        }
      } catch (err) {
        setError(humanError(err));
      }
    })();
  }, [token, presetProductId]);

  const visible = useMemo(() => products.filter(p => {
    if (categoryId && String(p.category_id) !== String(categoryId)) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
    }
    return true;
  }), [products, categoryId, search]);

  const selected = useMemo(() => Object.entries(lines)
    .filter(([, qty]) => Number(qty) > 0)
    .map(([pid, qty]) => {
      const p = products.find(x => x.id === pid);
      return p ? { ...p, requested_quantity: Number(qty), estimated_total: (Number(qty) || 0) * (Number(p.cost_price) || 0) } : null;
    })
    .filter(Boolean), [lines, products]);

  const estimatedTotal = selected.reduce((s, l) => s + l.estimated_total, 0);

  const buildPayload = () => ({
    location_id: locationId,
    department: department || undefined,
    priority,
    reason: reason || undefined,
    remarks: remarks || undefined,
    idempotency_key: idempotencyKey,
    items: selected.map(l => ({ product_id: l.id, requested_quantity: l.requested_quantity }))
  });

  const validate = () => {
    if (!locationId) { setError('Select a destination location.'); return false; }
    if (selected.length === 0) { setError('Add at least one item with a quantity.'); return false; }
    return true;
  };

  const saveDraft = async () => {
    setError(''); setNotice('');
    if (!validate()) return;
    setBusy(true);
    try {
      const res = await inventoryFetch('/inventory/purchase-requests', { token, method: 'POST', body: buildPayload() });
      setNotice(`Draft saved${res.request?.request_number ? ` (${res.request.request_number})` : ''}. It is not submitted yet.`);
      setTimeout(onDone, 1200);
    } catch (err) { setError(humanError(err)); } finally { setBusy(false); }
  };

  const submitRequest = async () => {
    setError(''); setNotice('');
    if (!validate()) return;
    setBusy(true);
    try {
      const created = await inventoryFetch('/inventory/purchase-requests', { token, method: 'POST', body: buildPayload() });
      const id = created.request.id;
      const submitted = await inventoryFetch(`/inventory/purchase-requests/${id}/submit`, { token, method: 'POST', body: {} });
      setNotice(`Submitted as ${submitted.request.request_number} — now pending approval.`);
      setTimeout(onDone, 1400);
    } catch (err) { setError(humanError(err)); } finally { setBusy(false); }
  };

  const ITEM_COLS = [
    { key: 'item', label: 'Item' }, { key: 'cat', label: 'Category' }, { key: 'stock', label: 'In stock', className: 'num' },
    { key: 'min', label: 'Minimum', className: 'num' }, { key: 'cost', label: 'Est. unit cost', className: 'num' },
    { key: 'qty', label: 'Request qty', className: 'num' }, { key: 'tot', label: 'Est. total', className: 'num' }
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader
        icon={ClipboardList}
        title={<><Button variant="ghost" icon={ArrowLeft} onClick={onCancel} aria-label="Back" style={{ marginRight: 4 }} /> New Purchase Request</>}
        subtitle="Choose what is needed and where it should go. The request is sent to an approver."
      />

      {error ? <Alert tone="error" onDismiss={() => setError('')}>{error}</Alert> : null}
      {notice ? <Alert tone="ok">{notice}</Alert> : null}

      <Card padded>
        <div className="inv-form-grid">
          <Field label="Destination location" required>
            <select className="inv-select" style={{ width: '100%' }} value={locationId} onChange={e => {
              setLocationId(e.target.value);
              const loc = locations.find(l => l.id === e.target.value);
              if (loc && !department) setDepartment(loc.department || '');
            }}>
              <option value="">Select location</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Department">
            <input className="inv-input" value={department} onChange={e => setDepartment(e.target.value)} placeholder="e.g. KITCHEN" />
          </Field>
          <Field label="Priority">
            <select className="inv-select" style={{ width: '100%' }} value={priority} onChange={e => setPriority(e.target.value)}>
              {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      <Toolbar>
        <div className="inv-search">
          <Search size={14} />
          <input className="inv-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search items by name or SKU…" aria-label="Search items" />
        </div>
        <select className="inv-select" value={categoryId} onChange={e => setCategoryId(e.target.value)} aria-label="Category">
          <option value="">Category</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Toolbar>

      <Card>
        <div style={{ maxHeight: 380, overflowY: 'auto' }}>
          <Table columns={ITEM_COLS}>
            {visible.length === 0 ? (
              <tr><td colSpan={ITEM_COLS.length}><EmptyState title="No items match" text={products.length === 0 ? 'No active items exist yet. Add them under Masters › Items.' : 'Try a different search.'} /></td></tr>
            ) : visible.map(p => {
              const qty = lines[p.id] || '';
              const lineTotal = (Number(qty) || 0) * (Number(p.cost_price) || 0);
              const picked = Number(qty) > 0;
              return (
                <tr key={p.id} style={picked ? { background: 'rgba(56,189,248,0.06)' } : undefined}>
                  <td><span className="strong">{p.name}</span><span className="inv-cell-sub">{p.sku}</span></td>
                  <td className="muted">{p.category_name}</td>
                  <td className="num">{formatQty(p.current_stock)} <span className="muted">{p.unit_of_measure}</span></td>
                  <td className="num muted">{formatQty(p.minimum_stock_level)}</td>
                  <td className="num muted">{money(p.cost_price)}</td>
                  <td className="num">
                    <input className="inv-input" type="number" step="any" min="0" value={qty}
                      onChange={e => setLines(prev => ({ ...prev, [p.id]: e.target.value }))}
                      style={{ width: 90, height: 30, textAlign: 'right' }} aria-label={`Quantity for ${p.name}`} />
                  </td>
                  <td className="num strong">{lineTotal > 0 ? money(lineTotal) : '—'}</td>
                </tr>
              );
            })}
          </Table>
        </div>
      </Card>

      {selected.length > 0 ? (
        <Card title={`Review — ${selected.length} item${selected.length > 1 ? 's' : ''}`} padded style={{ borderColor: 'rgba(56,189,248,0.3)' }}>
          {selected.map(l => (
            <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--inv-line)', fontSize: '0.84rem', gap: 8 }}>
              <span>{l.name} <span className="muted" style={{ color: 'var(--inv-muted)' }}>({l.sku})</span></span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="muted" style={{ color: 'var(--inv-muted)' }}>stock {formatQty(l.current_stock)} {l.unit_of_measure}</span>
                <strong>{formatQty(l.requested_quantity)} {l.unit_of_measure}</strong>
                <span>{money(l.estimated_total)}</span>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove" onClick={() => setLines(prev => { const n = { ...prev }; delete n[l.id]; return n; })} />
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10, fontSize: '1rem', fontWeight: 800 }}>
            Estimated total:&nbsp;<span style={{ color: 'var(--inv-accent)' }}>{money(estimatedTotal)}</span>
          </div>
          <div className="inv-hint" style={{ textAlign: 'right' }}>Estimate only — not a purchase, not a payment, and it does not change stock.</div>
        </Card>
      ) : null}

      <Card padded>
        <div className="inv-form-grid">
          <Field label="Reason">
            <input className="inv-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Kitchen stock replenishment" />
          </Field>
          <Field label="Remarks">
            <input className="inv-input" value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="e.g. Required for upcoming occupancy" />
          </Field>
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button icon={Save} onClick={saveDraft} disabled={busy}>Save draft</Button>
        <Button variant="primary" icon={Send} onClick={submitRequest} disabled={busy}>{busy ? 'Working…' : 'Submit for approval'}</Button>
      </div>
    </div>
  );
}

/* ── Detail ───────────────────────────────────────────────────────────────── */
function RequestDetail({ token, requestId, currentUserUid, onBack, canManageOrders, onOpenPurchaseOrder, embedded }) {
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Approval capability comes from the server's settings-driven config. It
  // only decides whether the buttons render — every decision is re-authorized
  // server-side, so hiding or showing them grants nothing.
  const [approvalCtx, setApprovalCtx] = useState({ enabled: false, caller_can_approve: false });
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    inventoryFetch('/inventory/purchase-requests/approval-config', { token })
      .then(setApprovalCtx)
      .catch(() => setApprovalCtx({ enabled: false, caller_can_approve: false }));
  }, [token]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await inventoryFetch(`/inventory/purchase-requests/${requestId}`, { token });
      setRequest(data.request);
    } catch (err) { setError(humanError(err)); } finally { setLoading(false); }
  }, [token, requestId]);

  useEffect(() => { load(); }, [load]);

  // Phase E — an APPROVED request may have exactly one purchase order.
  // Looked up by source request id; the server resolves it in O(1).
  const [purchaseOrder, setPurchaseOrder] = useState(null);
  const [orderBusy, setOrderBusy] = useState(false);
  useEffect(() => {
    if (!request || request.status !== 'APPROVED' || !canManageOrders) { setPurchaseOrder(null); return; }
    inventoryFetch(`/inventory/purchase-orders?source_request_id=${encodeURIComponent(request.id)}`, { token })
      .then(d => setPurchaseOrder((d.orders || [])[0] || null))
      .catch(() => setPurchaseOrder(null));
  }, [request, token, canManageOrders]);

  const createPurchaseOrder = async () => {
    setOrderBusy(true); setError('');
    try {
      const res = await inventoryFetch('/inventory/purchase-orders', {
        token, method: 'POST', body: { source_request_id: request.id }
      });
      setPurchaseOrder(res.order);
      if (onOpenPurchaseOrder) onOpenPurchaseOrder(res.order.id);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setOrderBusy(false);
    }
  };

  const act = async (action, body = {}) => {
    setBusy(true); setError('');
    try {
      await inventoryFetch(`/inventory/purchase-requests/${requestId}/${action}`, { token, method: 'POST', body });
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
  if (!request) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div><Button variant="ghost" icon={ArrowLeft} onClick={onBack}>Back</Button></div>
        <Alert tone="error" onRetry={load}>{error || 'This request could not be found.'}</Alert>
      </div>
    );
  }

  const st = statusOf(PR_STATUS, request.status);
  const isDraft = request.status === 'DRAFT';
  const isOwner = request.requested_by_uid && currentUserUid && String(request.requested_by_uid) === String(currentUserUid);
  const isPending = request.status === 'PENDING_APPROVAL';
  // A requester can never approve their own request — the server enforces this
  // with PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN; this just avoids showing a
  // button that would always fail.
  const canDecide = isPending && approvalCtx.caller_can_approve && !isOwner;

  const ITEM_COLS = [
    { key: 'p', label: 'Item' }, { key: 'c', label: 'Category' }, { key: 'q', label: 'Quantity', className: 'num' },
    { key: 's', label: 'Stock at request', className: 'num' }, { key: 'u', label: 'Est. unit cost', className: 'num' }, { key: 't', label: 'Est. total', className: 'num' }
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader
        title={<><Button variant="ghost" icon={ArrowLeft} onClick={onBack} aria-label="Back" style={{ marginRight: 4 }} /><span className="mono" style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--inv-accent)' }}>{request.request_number || 'Draft (not submitted)'}</span> <StatusBadge label={st.label} tone={st.tone} /></>}
        subtitle={`${request.requested_by_name || request.requested_by_uid} · ${request.department || ''} · ${request.location_name_snapshot || request.location_id} · ${request.business_date}`}
        actions={
          <>
            {canDecide && !rejecting ? (
              <>
                <Button icon={ThumbsDown} disabled={busy} onClick={() => { setRejectReason(''); setRejecting(true); }}>Reject</Button>
                <Button variant="primary" icon={CheckCircle2} disabled={busy} onClick={() => act('approve', {})}>{busy ? 'Working…' : 'Approve'}</Button>
              </>
            ) : null}
            {isDraft ? (
              <>
                <Button icon={XCircle} disabled={busy} onClick={() => { if (window.confirm('Cancel this draft purchase request?')) act('cancel', { reason: 'Cancelled by requester' }); }}>Cancel request</Button>
                <Button variant="primary" icon={Send} disabled={busy} onClick={() => act('submit')}>{busy ? 'Submitting…' : 'Submit for approval'}</Button>
              </>
            ) : null}
          </>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError('')}>{error}</Alert> : null}

      {canDecide && rejecting ? (
        <Card padded style={{ borderColor: 'rgba(248,113,113,0.4)' }}>
          <Field label="Rejection reason (recorded permanently on the request)" required>
            <input className="inv-input" value={rejectReason} onChange={e => setRejectReason(e.target.value)} autoFocus placeholder="e.g. Budget not available this month" />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <Button onClick={() => setRejecting(false)}>Cancel</Button>
            <Button variant="danger" icon={ThumbsDown} disabled={busy || rejectReason.trim().length < 3}
              onClick={async () => { await act('reject', { reason: rejectReason.trim() }); setRejecting(false); }}>
              {busy ? 'Rejecting…' : 'Confirm rejection'}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card padded>
        <div className="inv-kv">
          <div><span>Requested by</span><strong style={{ fontSize: '0.88rem' }}>{request.requested_by_name || request.requested_by_uid}</strong></div>
          <div><span>Department</span><strong style={{ fontSize: '0.88rem' }}>{request.department || '—'}</strong></div>
          <div><span>Location</span><strong style={{ fontSize: '0.88rem' }}>{request.location_name_snapshot || request.location_id}</strong></div>
          <div><span>Priority</span><strong style={{ fontSize: '0.88rem' }}>{request.priority}</strong></div>
          <div><span>Business date</span><strong style={{ fontSize: '0.88rem' }}>{request.business_date}</strong></div>
          <div><span>Estimated value</span><strong>{money(request.total_estimated_value)}</strong></div>
        </div>
      </Card>

      <Card>
        <Table columns={ITEM_COLS}>
          {(request.items || []).map(it => (
            <tr key={it.id}>
              <td><span className="strong">{it.product_name_snapshot}</span><span className="inv-cell-sub">{it.sku}</span></td>
              <td className="muted">{it.category_name_snapshot}</td>
              <td className="num strong">{formatQty(it.requested_quantity)} <span className="muted" style={{ fontWeight: 400 }}>{it.unit}</span></td>
              <td className="num muted">{formatQty(it.current_stock_snapshot)} <span style={{ fontSize: '0.7rem' }}>(min {formatQty(it.minimum_stock_snapshot)})</span></td>
              <td className="num muted">{money(it.estimated_unit_cost)}</td>
              <td className="num strong">{money(it.estimated_total)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      {(request.reason || request.remarks) ? (
        <Card padded>
          <div className="inv-kv">
            <div><span>Reason</span><strong style={{ fontSize: '0.86rem', fontWeight: 500 }}>{request.reason || '—'}</strong></div>
            <div><span>Remarks</span><strong style={{ fontSize: '0.86rem', fontWeight: 500 }}>{request.remarks || '—'}</strong></div>
          </div>
        </Card>
      ) : null}

      {request.status === 'APPROVED' && canManageOrders ? (
        <Card title="Purchase order" padded style={{ borderColor: 'rgba(56,189,248,0.3)' }}>
          {purchaseOrder ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div className="mono" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontWeight: 700, color: 'var(--inv-accent)' }}>{purchaseOrder.po_number}</div>
                <div className="inv-hint">{purchaseOrder.supplier_name_snapshot} · {purchaseOrder.status === 'ISSUED' ? 'Issued' : 'Draft'}</div>
              </div>
              <Button variant="primary" icon={ArrowRight} onClick={() => onOpenPurchaseOrder && onOpenPurchaseOrder(purchaseOrder.id)}>View purchase order</Button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div className="inv-hint">No purchase order raised yet. Creating one does not change stock — it produces the document for the supplier.</div>
              <Button variant="primary" onClick={createPurchaseOrder} disabled={orderBusy}>{orderBusy ? 'Creating…' : 'Create purchase order'}</Button>
            </div>
          )}
        </Card>
      ) : null}

      {(request.approvals || []).length > 0 ? (
        <Card title="Approval history" padded>
          {(request.approvals || []).map(a => {
            const approved = a.action === 'APPROVED';
            return (
              <div key={a.approval_id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--inv-line)', fontSize: '0.84rem' }}>
                {approved ? <CheckCircle2 size={15} color="var(--inv-ok)" /> : <ThumbsDown size={15} color="var(--inv-bad)" />}
                <div>
                  <div style={{ fontWeight: 700, color: approved ? 'var(--inv-ok)' : 'var(--inv-bad)' }}>
                    {approved ? 'Approved' : 'Rejected'} by {a.approver_name || a.approver_uid}
                    {a.approver_role ? <span className="muted" style={{ color: 'var(--inv-muted)', fontWeight: 400 }}> ({a.approver_role})</span> : null}
                  </div>
                  <div className="inv-hint">{fmtDateTime(a.created_at)}</div>
                  {a.comment ? <div style={{ marginTop: 3 }}>{approved ? 'Comment' : 'Reason'}: {a.comment}</div> : null}
                </div>
              </div>
            );
          })}
        </Card>
      ) : null}

      <Card title="Timeline" padded>
        {(request.status_history || []).map((h, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, fontSize: '0.82rem', padding: '3px 0', color: 'var(--inv-muted)' }}>
            <span style={{ minWidth: 140, color: 'var(--inv-text)', fontWeight: 600 }}>{statusOf(PR_STATUS, h.status).label}</span>
            <span>{fmtDateTime(h.at)}</span>
            <span>{h.by_name || h.by_uid || ''}</span>
          </div>
        ))}
        {isPending ? (
          <div className="inv-hint" style={{ marginTop: 8 }}>
            Awaiting an approval decision. A submitted request can no longer be edited or cancelled — approving or rejecting it is the only way forward.
          </div>
        ) : null}
        {isPending && isOwner ? <div className="inv-hint">You raised this request, so you cannot approve or reject it yourself.</div> : null}
        {isPending && !isOwner && !approvalCtx.caller_can_approve ? <div className="inv-hint">Awaiting a decision from an authorised approver.</div> : null}
        {isDraft && !isOwner ? <div className="inv-hint">Only the requester or an administrator can submit or cancel this draft; the server enforces this.</div> : null}
      </Card>
    </div>
  );
}
