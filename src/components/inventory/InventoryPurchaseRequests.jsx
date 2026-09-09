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
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClipboardList, Plus, Search, RefreshCw, Send, XCircle, ArrowLeft, Trash2, Save,
  CheckCircle2, ThumbsDown
} from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';

const STATUS_STYLES = {
  DRAFT: { bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8', label: 'Draft' },
  PENDING_APPROVAL: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', label: 'Pending Approval' },
  CANCELLED: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', label: 'Cancelled' },
  APPROVED: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'Approved' },
  REJECTED: { bg: 'rgba(239,68,68,0.2)', fg: '#f87171', label: 'Rejected' }
};
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

const money = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function InventoryPurchaseRequests({ token, currentUserUid, openRequestId, onDeepLinkHandled, canManageOrders, onOpenPurchaseOrder }) {
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

  return view === 'create'
    ? <CreateRequest token={token} onDone={() => setView('list')} onCancel={() => setView('list')} />
    : view === 'detail'
      ? <RequestDetail token={token} requestId={detailId} currentUserUid={currentUserUid} onBack={() => setView('list')}
          canManageOrders={canManageOrders} onOpenPurchaseOrder={onOpenPurchaseOrder} />
      : <RequestList
          token={token}
          onCreate={() => setView('create')}
          onOpen={(id) => { setDetailId(id); setView('detail'); }}
        />;
}

/* ── List ─────────────────────────────────────────────────────────────────── */
function RequestList({ token, onCreate, onOpen }) {
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
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, status, locationId, requestNumber, from, to]);

  useEffect(() => { setCursor(null); setCursorStack([]); load(null); }, [load]);

  return (
    <div style={{ padding: 24, color: '#fff', maxWidth: 1300, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
          <ClipboardList size={20} /> Purchase Requests
        </h2>
        <button onClick={onCreate} style={primaryBtn}><Plus size={16} /> New Request</button>
      </div>

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
          <input value={requestNumber} onChange={e => setRequestNumber(e.target.value)} placeholder="PR-20260908-000001"
            style={{ padding: '8px 12px 8px 32px', borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' }} />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value)} style={selectStyle}>
          <option value="">All Statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="PENDING_APPROVAL">Pending Approval</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <select value={locationId} onChange={e => setLocationId(e.target.value)} style={selectStyle}>
          <option value="">All Locations</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={selectStyle} title="From business date" />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={selectStyle} title="To business date" />
        <button onClick={() => load(cursor)} style={iconBtn}><RefreshCw size={16} /></button>
      </div>

      {error && <div style={errorBox}>{error}</div>}

      <div className="glass" style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading purchase requests...</div>
        ) : requests.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No purchase requests match these filters.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={th}>Request No.</th><th style={th}>Date</th><th style={th}>Requested By</th>
                  <th style={th}>Department</th><th style={th}>Location</th><th style={th}>Items</th>
                  <th style={th}>Est. Value</th><th style={th}>Priority</th><th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(r => {
                  const st = STATUS_STYLES[r.status] || STATUS_STYLES.DRAFT;
                  return (
                    <tr key={r.id} onClick={() => onOpen(r.id)} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}>
                      <td style={{ ...td, fontFamily: 'monospace', color: '#38bdf8' }}>{r.request_number || '—'}</td>
                      <td style={td}>{r.business_date}</td>
                      <td style={td}>{r.requested_by_name || r.requested_by_uid || '—'}</td>
                      <td style={td}>{r.department}</td>
                      <td style={td}>{r.location_name_snapshot || r.location_id}</td>
                      <td style={td}>{r.item_count}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{money(r.total_estimated_value)}</td>
                      <td style={td}>{r.priority}</td>
                      <td style={td}><span style={{ padding: '3px 9px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 700, background: st.bg, color: st.fg }}>{st.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16, alignItems: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>
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

/* ── Create ───────────────────────────────────────────────────────────────── */
function CreateRequest({ token, onDone, onCancel }) {
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
        setProducts(p.products || []);
        setCategories(c.categories || []);
        const locs = (l.locations || []).filter(x => x.is_active !== false);
        setLocations(locs);
        const def = locs.find(x => x.is_default) || locs[0];
        if (def) { setLocationId(def.id); setDepartment(def.department || ''); }
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [token]);

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
    } catch (err) { setError(err.message); } finally { setBusy(false); }
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
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: 24, color: '#fff', maxWidth: 1300, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button onClick={onCancel} style={iconBtn}><ArrowLeft size={16} /></button>
        <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 800 }}>Create Purchase Request</h2>
      </div>

      {error && <div style={errorBox}>{error}</div>}
      {notice && <div style={{ background: 'rgba(16,185,129,0.15)', border: '1px solid #10b981', color: '#10b981', padding: 12, borderRadius: 8, marginBottom: 16 }}>{notice}</div>}

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(255,255,255,0.08)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <div>
          <label style={label}>Destination Location *</label>
          <select value={locationId} onChange={e => {
            setLocationId(e.target.value);
            const loc = locations.find(l => l.id === e.target.value);
            if (loc && !department) setDepartment(loc.department || '');
          }} style={input}>
            <option value="">Select location</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div>
          <label style={label}>Department</label>
          <input value={department} onChange={e => setDepartment(e.target.value)} placeholder="e.g. KITCHEN" style={input} />
        </div>
        <div>
          <label style={label}>Priority</label>
          <select value={priority} onChange={e => setPriority(e.target.value)} style={input}>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ flex: '1 1 220px', position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search items by name or SKU..."
            style={{ width: '100%', padding: '9px 12px 9px 36px', borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' }} />
        </div>
        <select value={categoryId} onChange={e => setCategoryId(e.target.value)} style={selectStyle}>
          <option value="">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <div className="glass" style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 16 }}>
        <div style={{ overflowX: 'auto', maxHeight: 380, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'rgba(15,23,42,0.9)', borderBottom: '1px solid rgba(255,255,255,0.1)', position: 'sticky', top: 0 }}>
                <th style={th}>Item</th><th style={th}>SKU</th><th style={th}>Category</th>
                <th style={th}>Current Stock</th><th style={th}>Min Level</th><th style={th}>Unit</th>
                <th style={th}>Est. Unit Cost</th><th style={th}>Request Qty</th><th style={th}>Est. Total</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>No items match.</td></tr>
              ) : visible.map(p => {
                const qty = lines[p.id] || '';
                const lineTotal = (Number(qty) || 0) * (Number(p.cost_price) || 0);
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: Number(qty) > 0 ? 'rgba(56,189,248,0.06)' : 'transparent' }}>
                    <td style={{ ...td, fontWeight: 600 }}>{p.name}</td>
                    <td style={{ ...td, fontFamily: 'monospace', color: '#38bdf8' }}>{p.sku}</td>
                    <td style={td}>{p.category_name}</td>
                    <td style={td}>{formatQty(p.current_stock)} {p.unit_of_measure}</td>
                    <td style={{ ...td, color: '#94a3b8' }}>{formatQty(p.minimum_stock_level)}</td>
                    <td style={td}>{p.unit_of_measure}</td>
                    <td style={td}>{money(p.cost_price)}</td>
                    <td style={td}>
                      <input type="number" step="any" min="0" value={qty}
                        onChange={e => setLines(prev => ({ ...prev, [p.id]: e.target.value }))}
                        style={{ width: 90, padding: '6px 8px', borderRadius: 6, background: '#020617', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' }} />
                    </td>
                    <td style={{ ...td, fontWeight: 700 }}>{lineTotal > 0 ? money(lineTotal) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(56,189,248,0.3)' }}>
          <h3 style={{ margin: '0 0 10px 0', fontSize: '0.95rem' }}>Review — {selected.length} item{selected.length > 1 ? 's' : ''}</h3>
          {selected.map(l => (
            <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: '0.85rem' }}>
              <span>{l.name} <span style={{ color: '#64748b' }}>({l.sku})</span></span>
              <span>
                <span style={{ color: '#94a3b8', marginRight: 12 }}>stock {formatQty(l.current_stock)} {l.unit_of_measure}</span>
                <strong>{formatQty(l.requested_quantity)} {l.unit_of_measure}</strong>
                <span style={{ marginLeft: 12 }}>{money(l.estimated_total)}</span>
                <button onClick={() => setLines(prev => { const n = { ...prev }; delete n[l.id]; return n; })}
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', marginLeft: 10 }}><Trash2 size={14} /></button>
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10, fontSize: '1rem', fontWeight: 800 }}>
            Estimated Total:&nbsp;<span style={{ color: '#38bdf8' }}>{money(estimatedTotal)}</span>
          </div>
          <div style={{ fontSize: '0.72rem', color: '#64748b', textAlign: 'right', marginTop: 4 }}>
            Estimate only — not a purchase, not a payment, and it does not change stock.
          </div>
        </div>
      )}

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(255,255,255,0.08)', display: 'grid', gap: 12 }}>
        <div>
          <label style={label}>Reason</label>
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Kitchen stock replenishment" style={input} />
        </div>
        <div>
          <label style={label}>Remarks</label>
          <input value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="e.g. Required for upcoming occupancy" style={input} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={secondaryBtn}>Cancel</button>
        <button onClick={saveDraft} disabled={busy} style={secondaryBtn}><Save size={15} /> Save Draft</button>
        <button onClick={submitRequest} disabled={busy} style={primaryBtn}><Send size={15} /> {busy ? 'Working...' : 'Submit Request'}</button>
      </div>
    </div>
  );
}

/* ── Detail ───────────────────────────────────────────────────────────────── */
function RequestDetail({ token, requestId, currentUserUid, onBack, canManageOrders, onOpenPurchaseOrder }) {
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
    } catch (err) { setError(err.message); } finally { setLoading(false); }
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
      setError(err.message);
    } finally {
      setOrderBusy(false);
    }
  };

  const act = async (action, body = {}) => {
    setBusy(true); setError('');
    try {
      await inventoryFetch(`/inventory/purchase-requests/${requestId}/${action}`, { token, method: 'POST', body });
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading request...</div>;
  if (!request) return <div style={{ padding: 24 }}><button onClick={onBack} style={iconBtn}><ArrowLeft size={16} /></button><div style={errorBox}>{error || 'Request not found.'}</div></div>;

  const st = STATUS_STYLES[request.status] || STATUS_STYLES.DRAFT;
  const isDraft = request.status === 'DRAFT';
  const isOwner = request.requested_by_uid && currentUserUid && String(request.requested_by_uid) === String(currentUserUid);
  const isPending = request.status === 'PENDING_APPROVAL';
  // A requester can never approve their own request — the server enforces this
  // with PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN; this just avoids showing a
  // button that would always fail.
  const canDecide = isPending && approvalCtx.caller_can_approve && !isOwner;

  return (
    <div style={{ padding: 24, color: '#fff', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={iconBtn}><ArrowLeft size={16} /></button>
        <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, fontFamily: 'monospace' }}>{request.request_number || 'DRAFT (not submitted)'}</h2>
        <span style={{ padding: '4px 10px', borderRadius: 12, fontSize: '0.75rem', fontWeight: 700, background: st.bg, color: st.fg }}>{st.label}</span>
      </div>

      {error && <div style={errorBox}>{error}</div>}

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(255,255,255,0.08)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Field label="Requested By" value={request.requested_by_name || request.requested_by_uid} />
        <Field label="Department" value={request.department} />
        <Field label="Location" value={request.location_name_snapshot || request.location_id} />
        <Field label="Priority" value={request.priority} />
        <Field label="Business Date" value={request.business_date} />
        <Field label="Estimated Value" value={money(request.total_estimated_value)} />
      </div>

      <div className="glass" style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <th style={th}>Product</th><th style={th}>Category</th><th style={th}>Quantity</th>
              <th style={th}>Unit</th><th style={th}>Stock at Request</th><th style={th}>Est. Unit Cost</th><th style={th}>Est. Total</th>
            </tr>
          </thead>
          <tbody>
            {(request.items || []).map(it => (
              <tr key={it.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <td style={{ ...td, fontWeight: 600 }}>{it.product_name_snapshot} <span style={{ color: '#64748b' }}>({it.sku})</span></td>
                <td style={td}>{it.category_name_snapshot}</td>
                <td style={{ ...td, fontWeight: 700 }}>{formatQty(it.requested_quantity)}</td>
                <td style={td}>{it.unit}</td>
                <td style={{ ...td, color: '#94a3b8' }}>{formatQty(it.current_stock_snapshot)} (min {formatQty(it.minimum_stock_snapshot)})</td>
                <td style={td}>{money(it.estimated_unit_cost)}</td>
                <td style={{ ...td, fontWeight: 700 }}>{money(it.estimated_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(255,255,255,0.08)' }}>
        <Field label="Reason" value={request.reason || '—'} />
        <div style={{ height: 10 }} />
        <Field label="Remarks" value={request.remarks || '—'} />
      </div>

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(255,255,255,0.08)' }}>
        <h3 style={{ margin: '0 0 10px 0', fontSize: '0.95rem' }}>Timeline</h3>
        {(request.status_history || []).map((h, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, fontSize: '0.85rem', padding: '4px 0', color: '#94a3b8' }}>
            <span style={{ minWidth: 150, color: '#fff', fontWeight: 600 }}>{STATUS_STYLES[h.status]?.label || h.status}</span>
            <span>{new Date(h.at).toLocaleString()}</span>
            <span>{h.by_name || h.by_uid || ''}</span>
          </div>
        ))}
        {request.status === 'PENDING_APPROVAL' && (
          <div style={{ marginTop: 10, fontSize: '0.78rem', color: '#64748b' }}>
            Awaiting an approval decision. A submitted request can no longer be edited or cancelled — approving or rejecting it is the only way forward.
          </div>
        )}
      </div>

      {request.status === 'APPROVED' && canManageOrders && (
        <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(56,189,248,0.3)' }}>
          <h3 style={{ margin: '0 0 10px 0', fontSize: '0.95rem' }}>Purchase Order</h3>
          {purchaseOrder ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#38bdf8' }}>{purchaseOrder.po_number}</div>
                <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                  {purchaseOrder.supplier_name_snapshot} · {purchaseOrder.status === 'ISSUED' ? 'Issued' : 'Draft'}
                </div>
              </div>
              <button onClick={() => onOpenPurchaseOrder && onOpenPurchaseOrder(purchaseOrder.id)} style={primaryBtn}>
                View Purchase Order
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: '0.82rem', color: '#94a3b8' }}>
                No purchase order raised yet. Creating one does not change stock — it produces the document for the supplier.
              </div>
              <button onClick={createPurchaseOrder} disabled={orderBusy} style={primaryBtn}>
                {orderBusy ? 'Creating...' : 'Create Purchase Order'}
              </button>
            </div>
          )}
        </div>
      )}

      {(request.approvals || []).length > 0 && (
        <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 style={{ margin: '0 0 10px 0', fontSize: '0.95rem' }}>Approval History</h3>
          {(request.approvals || []).map(a => {
            const approved = a.action === 'APPROVED';
            return (
              <div key={a.approval_id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: '0.85rem' }}>
                {approved ? <CheckCircle2 size={16} color="#10b981" /> : <ThumbsDown size={16} color="#f87171" />}
                <div>
                  <div style={{ fontWeight: 700, color: approved ? '#10b981' : '#f87171' }}>
                    {approved ? 'Approved' : 'Rejected'} by {a.approver_name || a.approver_uid}
                    {a.approver_role ? <span style={{ color: '#64748b', fontWeight: 400 }}> ({a.approver_role})</span> : null}
                  </div>
                  <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>{new Date(a.created_at).toLocaleString()}</div>
                  {a.comment && <div style={{ marginTop: 4 }}>{approved ? 'Comment' : 'Reason'}: {a.comment}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {canDecide && !rejecting && (
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginBottom: 12 }}>
          <button disabled={busy} onClick={() => { setRejectReason(''); setRejecting(true); }} style={secondaryBtn}>
            <ThumbsDown size={15} /> Reject
          </button>
          <button disabled={busy} onClick={() => act('approve', {})} style={primaryBtn}>
            <CheckCircle2 size={15} /> {busy ? 'Working...' : 'Approve'}
          </button>
        </div>
      )}

      {canDecide && rejecting && (
        <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, border: '1px solid rgba(248,113,113,0.4)' }}>
          <label style={label}>Rejection reason * (recorded permanently on the request)</label>
          <input value={rejectReason} onChange={e => setRejectReason(e.target.value)} autoFocus
            placeholder="e.g. Budget not available this month" style={input} />
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => setRejecting(false)} style={secondaryBtn}>Cancel</button>
            <button
              disabled={busy || rejectReason.trim().length < 3}
              onClick={async () => { await act('reject', { reason: rejectReason.trim() }); setRejecting(false); }}
              style={primaryBtn}
            >
              <ThumbsDown size={15} /> {busy ? 'Rejecting...' : 'Confirm Rejection'}
            </button>
          </div>
        </div>
      )}

      {isPending && isOwner && (
        <div style={{ textAlign: 'right', fontSize: '0.78rem', color: '#64748b', marginBottom: 12 }}>
          You raised this request, so you cannot approve or reject it yourself.
        </div>
      )}
      {isPending && !isOwner && !approvalCtx.caller_can_approve && (
        <div style={{ textAlign: 'right', fontSize: '0.78rem', color: '#64748b', marginBottom: 12 }}>
          Awaiting a decision from an authorized approver.
        </div>
      )}

      {isDraft && (
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button
            disabled={busy}
            onClick={() => { if (window.confirm('Cancel this draft purchase request?')) act('cancel', { reason: 'Cancelled by requester' }); }}
            style={secondaryBtn}
          >
            <XCircle size={15} /> Cancel Request
          </button>
          <button disabled={busy} onClick={() => act('submit')} style={primaryBtn}>
            <Send size={15} /> {busy ? 'Submitting...' : 'Submit for Approval'}
          </button>
        </div>
      )}
      {isDraft && !isOwner && (
        <div style={{ textAlign: 'right', fontSize: '0.75rem', color: '#64748b', marginTop: 8 }}>
          Only the requester or an administrator can submit or cancel this draft; the server enforces this.
        </div>
      )}
    </div>
  );
}

function Field({ label: l, value }) {
  return (
    <div>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: 3 }}>{l}</div>
      <div style={{ fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const th = { padding: '10px 14px' };
const td = { padding: '9px 14px' };
const label = { display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 };
const input = { width: '100%', padding: '8px 12px', borderRadius: 6, background: '#020617', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' };
const selectStyle = { padding: '9px 12px', borderRadius: 6, background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' };
const iconBtn = { padding: 9, borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#94a3b8', cursor: 'pointer' };
const primaryBtn = { display: 'flex', alignItems: 'center', gap: 8, background: 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' };
const secondaryBtn = { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', fontWeight: 600, cursor: 'pointer' };
const errorBox = { background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', color: '#ef4444', padding: 12, borderRadius: 8, marginBottom: 16 };
function pagerBtn(disabled) {
  return { padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)', background: disabled ? 'rgba(255,255,255,0.02)' : 'rgba(15,23,42,0.6)', color: disabled ? '#475569' : '#fff', cursor: disabled ? 'not-allowed' : 'pointer' };
}
