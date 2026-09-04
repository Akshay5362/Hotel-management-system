/**
 * src/components/food/FoodKOTModification.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * KOT Modification (F2) — modify items/quantities/remarks on an already-placed
 * food order. This never creates a new order: order_id and order_number are
 * always preserved. Backend recalculates every price/tax line from the
 * authoritative menu master and records a structured, append-only
 * modification_history[] entry plus a status_history[] note — the existing
 * Order History screen surfaces the change automatically.
 *
 * Reuses: GET /food/orders/history (search-by-order-number, already built for
 * Order History), GET /food/orders/:id, GET /food/menu-items (already built
 * for New Order), and PUT /food/orders/:id/modify (new, minimal, this phase).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Search, Plus, Minus, X, AlertTriangle, CheckCircle,
  Loader, ClipboardEdit, ArrowRight
} from 'lucide-react';
import { API_URL, getApiHeaders } from '../../config/apiConfig';

const FOOD_BASE = `${API_URL}/food`;

const NOT_MODIFIABLE_STATUSES = ['DELIVERED', 'COMPLETED', 'CANCELLED'];

function fmtMoney(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return '—';
  }
}

function destinationLabel(order) {
  if (!order) return '';
  if (order.destination_type === 'ROOM')  return `Room ${order.room_number}`;
  if (order.destination_type === 'TABLE') return `Table: ${order.table_name}`;
  if (order.destination_type === 'STAFF') return `Staff: ${order.staff_name}`;
  if (order.destination_type === 'OWNER') return `VIP: ${order.owner_name}`;
  return order.destination_type || '';
}

// Diffs the original order items against the working (edited) items list.
// Mirrors the same classification the backend computes authoritatively —
// this copy is for live preview only, never sent to the server.
function diffItems(originalItems, editedItems) {
  const originalById = new Map((originalItems || []).map(it => [it.item_id, it]));
  const editedById   = new Map((editedItems || []).map(it => [it.item_id, it]));
  const changes = [];

  for (const [itemId, orig] of originalById) {
    const edited = editedById.get(itemId);
    if (!edited) {
      changes.push({ type: 'REMOVED', item_id: itemId, item_name: orig.item_name, prev_qty: orig.quantity, new_qty: 0 });
    } else if (edited.quantity !== orig.quantity) {
      changes.push({ type: 'QTY_CHANGED', item_id: itemId, item_name: orig.item_name, prev_qty: orig.quantity, new_qty: edited.quantity });
    }
  }
  for (const [itemId, edited] of editedById) {
    if (!originalById.has(itemId)) {
      changes.push({ type: 'ADDED', item_id: itemId, item_name: edited.item_name, prev_qty: 0, new_qty: edited.quantity });
    }
  }
  return changes;
}

export default function FoodKOTModification({ token, user }) {
  const getHeaders = useCallback((extra = {}) => getApiHeaders(token, extra), [token]);

  // Search
  const [query, setQuery]           = useState('');
  const [results, setResults]       = useState([]);
  const [searching, setSearching]   = useState(false);
  const [searchError, setSearchError] = useState('');

  // Selected order
  const [order, setOrder]           = useState(null);
  const [loadingOrder, setLoadingOrder] = useState(false);
  const [orderError, setOrderError] = useState('');

  // Working edit state
  const [editedItems, setEditedItems] = useState([]);

  // Add-item picker
  const [showPicker, setShowPicker] = useState(false);
  const [menuItems, setMenuItems]   = useState([]);
  const [pickerSearch, setPickerSearch] = useState('');
  const [loadingMenu, setLoadingMenu] = useState(false);

  // Save flow
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const searchTimer = useRef(null);

  // ── Search KOT by order number ──────────────────────────────────────────
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      setSearchError('');
      try {
        const res = await fetch(`${FOOD_BASE}/orders/history?order_number=${encodeURIComponent(term)}&page_size=25`, {
          headers: getHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Search failed');
        setResults(data.orders || []);
      } catch (err) {
        setSearchError(err.message);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, getHeaders]);

  // ── Load a specific KOT ──────────────────────────────────────────────────
  const loadOrder = useCallback(async (orderId) => {
    setLoadingOrder(true);
    setOrderError('');
    setSuccessMsg('');
    setSaveError('');
    try {
      const res = await fetch(`${FOOD_BASE}/orders/${orderId}`, { headers: getHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load KOT');
      const loaded = data.order;
      setOrder(loaded);
      setEditedItems((loaded.items || []).map(it => ({ ...it })));
      setResults([]);
      setQuery('');
    } catch (err) {
      setOrderError(err.message);
    } finally {
      setLoadingOrder(false);
    }
  }, [getHeaders]);

  // ── Load active menu items (for Add Item picker) ────────────────────────
  const loadMenuItems = useCallback(async () => {
    if (menuItems.length > 0) return;
    setLoadingMenu(true);
    try {
      const res = await fetch(`${FOOD_BASE}/menu-items?active_only=true`, { headers: getHeaders() });
      const data = await res.json();
      setMenuItems(data.items || []);
    } catch (err) {
      console.error('[KOT Modification] menu items error:', err);
    } finally {
      setLoadingMenu(false);
    }
  }, [getHeaders, menuItems.length]);

  const canModify = order
    && !NOT_MODIFIABLE_STATUSES.includes(order.order_status)
    && order.payment_status === 'PENDING';

  const blockReason = order && !canModify
    ? (NOT_MODIFIABLE_STATUSES.includes(order.order_status)
        ? `This KOT is already ${order.order_status} and can no longer be modified.`
        : `This KOT is already billed (${order.payment_status}). Settle/void it through Payments before modifying.`)
    : '';

  // ── Item qty controls ────────────────────────────────────────────────────
  const changeQty = (itemId, delta) => {
    setEditedItems(prev => prev
      .map(it => it.item_id === itemId ? { ...it, quantity: it.quantity + delta } : it)
      .filter(it => it.quantity > 0)
    );
  };

  const addMenuItem = (menuItem) => {
    setEditedItems(prev => {
      if (prev.some(it => it.item_id === menuItem.item_id)) return prev; // already in the order
      return [...prev, {
        item_id:    menuItem.item_id,
        item_name:  menuItem.name,
        quantity:   1,
        unit_price: Number(menuItem.base_price || 0),
        tax_rate:   Number(menuItem.tax_rate || 0),
        line_total: Number(menuItem.base_price || 0) * (1 + Number(menuItem.tax_rate || 0) / 100)
      }];
    });
    setShowPicker(false);
    setPickerSearch('');
  };

  const changes = order ? diffItems(order.items, editedItems) : [];
  const oldTotal = order ? Number(order.grand_total) : 0;
  const newTotalEstimate = editedItems.reduce((sum, it) => {
    const unitPrice = Number(it.unit_price || 0);
    const taxRate   = Number(it.tax_rate || 0);
    const line = unitPrice * it.quantity * (1 + taxRate / 100);
    return sum + line;
  }, 0);

  const filteredMenu = menuItems.filter(mi =>
    !editedItems.some(it => it.item_id === mi.item_id) &&
    (pickerSearch.trim() === '' || mi.name.toLowerCase().includes(pickerSearch.trim().toLowerCase()))
  );

  // ── Save ─────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch(`${FOOD_BASE}/orders/${order.order_id}/modify`, {
        method: 'PUT',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          items: editedItems.map(it => ({
            item_id:      it.item_id,
            quantity:     it.quantity,
            item_remarks: it.item_remarks ?? undefined
          }))
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save modification');

      setSuccessMsg(`KOT ${data.order_number} updated — ${fmtMoney(data.old_grand_total)} → ${fmtMoney(data.new_grand_total)}`);
      setShowConfirm(false);
      await loadOrder(order.order_id);
    } catch (err) {
      setSaveError(err.message);
      setShowConfirm(false);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '10px 12px', background: 'rgba(0,0,0,0.3)',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px',
    color: '#fff', fontSize: '0.88rem', boxSizing: 'border-box'
  };
  const sectionLabel = {
    fontSize: '0.72rem', fontWeight: '700', letterSpacing: '0.06em',
    textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', marginBottom: '12px'
  };

  return (
    <div style={{ color: '#f1f5f9', fontFamily: 'var(--font-body, Inter, sans-serif)', maxWidth: '760px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <div style={{
          width: '40px', height: '40px', borderRadius: '10px',
          background: 'linear-gradient(135deg, rgba(167,139,250,0.25), rgba(99,102,241,0.25))',
          border: '1px solid rgba(167,139,250,0.4)', display: 'flex',
          alignItems: 'center', justifyContent: 'center'
        }}>
          <ClipboardEdit size={19} color="#a78bfa" />
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.2rem', fontWeight: '800' }}>KOT Modification</h1>
          <p style={{ margin: '2px 0 0', fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)' }}>
            Change items or quantities on an existing KOT — never creates a new order
          </p>
        </div>
      </div>

      {/* ── Search ─────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: '24px' }}>
        <div style={sectionLabel}>Search KOT / Order No.</div>
        <div style={{ position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.35)' }} />
          <input
            style={{ ...inputStyle, paddingLeft: '36px' }}
            placeholder="e.g. FO-20260831-000123"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        {searching && <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.4)', marginTop: '8px' }}>Searching…</div>}
        {searchError && <div style={{ fontSize: '0.78rem', color: '#f87171', marginTop: '8px' }}>{searchError}</div>}

        {results.length > 0 && (
          <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {results.map(r => (
              <button
                key={r.order_id}
                onClick={() => loadOrder(r.order_id)}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px',
                  color: '#fff', cursor: 'pointer', textAlign: 'left'
                }}
              >
                <span>
                  <strong style={{ color: '#38bdf8' }}>{r.order_number}</strong>
                  <span style={{ color: 'rgba(255,255,255,0.5)', marginLeft: '10px', fontSize: '0.8rem' }}>{destinationLabel(r)}</span>
                </span>
                <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)' }}>{r.order_status} · {fmtMoney(r.grand_total)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {loadingOrder && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'rgba(255,255,255,0.5)', padding: '20px 0' }}>
          <Loader size={16} className="animate-spin" /> Loading KOT…
        </div>
      )}
      {orderError && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', padding: '10px 14px', borderRadius: '8px', marginBottom: '16px', fontSize: '0.85rem' }}>
          {orderError}
        </div>
      )}
      {successMsg && (
        <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#4ade80', padding: '10px 14px', borderRadius: '8px', marginBottom: '16px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <CheckCircle size={15} /> {successMsg}
        </div>
      )}

      {order && (
        <>
          {/* ── Selected KOT ─────────────────────────────────────────────── */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '18px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '10px' }}>
              <div>
                <div style={{ fontSize: '1.15rem', fontWeight: '900', color: '#38bdf8' }}>{order.order_number}</div>
                <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>{fmtDateTime(order.created_at)}</div>
              </div>
              <span style={{
                fontSize: '0.72rem', fontWeight: '800', padding: '4px 10px', borderRadius: '100px',
                background: 'rgba(56,189,248,0.12)', color: '#38bdf8', textTransform: 'uppercase'
              }}>
                {order.order_status}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginTop: '14px', fontSize: '0.82rem' }}>
              <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Destination</span><br /><strong>{destinationLabel(order)}</strong></div>
              {order.guest_name && <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Guest</span><br /><strong>{order.guest_name}</strong></div>}
              <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Waiter</span><br /><strong>{order.waiter_name || '—'}</strong></div>
              <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Payment</span><br /><strong>{order.payment_status}</strong></div>
            </div>

            {!canModify && (
              <div style={{ marginTop: '14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', padding: '10px 14px', borderRadius: '8px', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={15} /> {blockReason}
              </div>
            )}
          </div>

          {canModify && (
            <>
              {/* ── Modify Order ───────────────────────────────────────────── */}
              <div style={{ marginBottom: '22px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div style={sectionLabel}>Modify Order</div>
                  <button
                    onClick={() => { setShowPicker(v => !v); loadMenuItems(); }}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      padding: '6px 12px', background: 'rgba(167,139,250,0.15)',
                      border: '1px solid #a78bfa', borderRadius: '6px', color: '#a78bfa',
                      fontWeight: '700', fontSize: '0.78rem', cursor: 'pointer'
                    }}
                  >
                    <Plus size={13} /> Add Item
                  </button>
                </div>

                {showPicker && (
                  <div style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '12px', marginBottom: '14px' }}>
                    <input
                      style={{ ...inputStyle, marginBottom: '10px' }}
                      placeholder="Search menu items…"
                      value={pickerSearch}
                      onChange={e => setPickerSearch(e.target.value)}
                      autoFocus
                    />
                    {loadingMenu ? (
                      <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)' }}>Loading menu…</div>
                    ) : (
                      <div style={{ maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {filteredMenu.length === 0 && (
                          <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.35)', padding: '8px 0' }}>No matching items</div>
                        )}
                        {filteredMenu.map(mi => (
                          <button
                            key={mi.item_id}
                            onClick={() => addMenuItem(mi)}
                            style={{
                              display: 'flex', justifyContent: 'space-between', padding: '8px 10px',
                              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
                              borderRadius: '6px', color: '#fff', cursor: 'pointer', textAlign: 'left', fontSize: '0.84rem'
                            }}
                          >
                            <span>{mi.name}</span>
                            <span style={{ color: 'rgba(255,255,255,0.5)' }}>{fmtMoney(mi.base_price)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {editedItems.length === 0 && (
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.35)', padding: '12px 0' }}>
                      No items remain — add at least one item before saving.
                    </div>
                  )}
                  {editedItems.map(it => (
                    <div key={it.item_id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 12px', background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.07)', borderRadius: '8px'
                    }}>
                      <div>
                        <div style={{ fontWeight: '700', fontSize: '0.88rem' }}>{it.item_name}</div>
                        <div style={{ fontSize: '0.74rem', color: 'rgba(255,255,255,0.45)' }}>{fmtMoney(it.unit_price)} each</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <button onClick={() => changeQty(it.item_id, -1)} style={qtyBtnStyle}><Minus size={13} /></button>
                        <span style={{ minWidth: '20px', textAlign: 'center', fontWeight: '800' }}>{it.quantity}</span>
                        <button onClick={() => changeQty(it.item_id, 1)} style={qtyBtnStyle}><Plus size={13} /></button>
                        <button
                          onClick={() => setEditedItems(prev => prev.filter(x => x.item_id !== it.item_id))}
                          title="Remove item"
                          style={{ ...qtyBtnStyle, color: '#f87171', borderColor: 'rgba(248,113,113,0.35)', marginLeft: '4px' }}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Change Summary ─────────────────────────────────────────── */}
              <div style={{ marginBottom: '22px' }}>
                <div style={sectionLabel}>Change Summary</div>
                {changes.length === 0 ? (
                  <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.35)' }}>No changes yet.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {changes.map((c, idx) => (
                      <div key={idx} style={{
                        fontSize: '0.85rem', fontWeight: '700',
                        color: c.type === 'ADDED' ? '#4ade80' : c.type === 'REMOVED' ? '#f87171' : '#fbbf24'
                      }}>
                        {c.type === 'ADDED' && `+ ${c.item_name} × ${c.new_qty}`}
                        {c.type === 'REMOVED' && `− ${c.item_name} × ${c.prev_qty}`}
                        {c.type === 'QTY_CHANGED' && `${c.item_name}: ${c.prev_qty} → ${c.new_qty}`}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Totals & Actions ───────────────────────────────────────── */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '16px 18px', background: 'rgba(0,0,0,0.25)', borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.08)', marginBottom: '18px', flexWrap: 'wrap', gap: '12px'
              }}>
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)' }}>
                    Old Total: <span style={{ textDecoration: changes.length ? 'line-through' : 'none' }}>{fmtMoney(oldTotal)}</span>
                  </div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '900', color: '#fff' }}>
                    New Total: {fmtMoney(newTotalEstimate)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    onClick={() => { setEditedItems((order.items || []).map(it => ({ ...it }))); setSaveError(''); }}
                    style={{ padding: '10px 18px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', cursor: 'pointer', fontWeight: '600' }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => setShowConfirm(true)}
                    disabled={changes.length === 0 || editedItems.length === 0}
                    style={{
                      padding: '10px 20px',
                      background: (changes.length === 0 || editedItems.length === 0) ? 'rgba(167,139,250,0.15)' : 'linear-gradient(135deg, #8b5cf6, #7c3aed)',
                      border: 'none', borderRadius: '8px', color: '#fff', fontWeight: '800',
                      cursor: (changes.length === 0 || editedItems.length === 0) ? 'not-allowed' : 'pointer',
                      display: 'inline-flex', alignItems: 'center', gap: '6px'
                    }}
                  >
                    Save Modification <ArrowRight size={14} />
                  </button>
                </div>
              </div>

              {saveError && (
                <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', padding: '10px 14px', borderRadius: '8px', fontSize: '0.85rem' }}>
                  {saveError}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Confirm Modal ────────────────────────────────────────────────── */}
      {showConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '20px' }}>
          <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '14px', width: '100%', maxWidth: '420px', padding: '24px', color: '#fff' }}>
            <h3 style={{ margin: '0 0 10px', fontSize: '1.05rem', fontWeight: '800' }}>Confirm KOT Modification</h3>
            <p style={{ margin: '0 0 4px', fontSize: '0.9rem', color: 'rgba(255,255,255,0.6)' }}>KOT: <strong style={{ color: '#38bdf8' }}>{order?.order_number}</strong></p>
            <p style={{ margin: '0 0 18px', fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)' }}>{changes.length} change{changes.length === 1 ? '' : 's'} will be applied.</p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowConfirm(false)} disabled={saving} style={{ padding: '9px 16px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving} style={{ padding: '9px 20px', background: '#8b5cf6', border: 'none', borderRadius: '8px', color: '#fff', fontWeight: '700', cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving ? 'Saving…' : 'Confirm Modification'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const qtyBtnStyle = {
  width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: '6px', color: '#fff', cursor: 'pointer'
};
