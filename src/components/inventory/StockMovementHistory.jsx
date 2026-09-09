/**
 * StockMovementHistory.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * "Stock Movements" tab — the append-only ledger (VIEW role) plus, for MOVE
 * roles (admin, super_admin, kitchen, housekeeper), the two Phase A actions
 * that change stock here: Adjustment and Transfer. Opening stock is entered
 * from the Items tab (product create) or its "Add Opening Stock" action, not
 * here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Filter, RefreshCw, SlidersHorizontal, ArrowLeftRight } from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';

const MOVEMENT_LABELS = {
  OPENING: 'Opening Stock', ADJUSTMENT: 'Adjustment', TRANSFER_IN: 'Transfer In', TRANSFER_OUT: 'Transfer Out',
  RECEIPT: 'Receipt', CONSUMPTION: 'Consumption', WASTAGE: 'Wastage', RETURN: 'Return'
};

export default function StockMovementHistory({ token, canMove }) {
  const [movements, setMovements] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [cursorStack, setCursorStack] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [products, setProducts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [productId, setProductId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [movementType, setMovementType] = useState('');

  const [mode, setMode] = useState(null); // null | 'adjust' | 'transfer'
  const [form, setForm] = useState({ product_id: '', location_id: '', from_location_id: '', to_location_id: '', quantity: '', reason: '', remarks: '' });
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [prodRes, locRes] = await Promise.all([
          inventoryFetch('/inventory/products?page_size=100', { token }),
          inventoryFetch('/inventory/locations', { token })
        ]);
        setProducts(prodRes.products || []);
        setLocations((locRes.locations || []).filter(l => l.is_active !== false));
      } catch { /* dropdowns degrade to empty; the list below still works */ }
    })();
  }, [token]);

  const load = useCallback(async (cur = null) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (productId) params.set('product_id', productId);
      if (locationId) params.set('location_id', locationId);
      if (movementType) params.set('movement_type', movementType);
      if (cur) params.set('cursor', cur);
      const data = await inventoryFetch(`/inventory/movements?${params.toString()}`, { token });
      setMovements(data.movements || []);
      setNextCursor(data.next_cursor || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, productId, locationId, movementType]);

  useEffect(() => { setCursor(null); setCursorStack([]); load(null); }, [productId, locationId, movementType, load]);

  const goNext = () => { if (!nextCursor) return; setCursorStack(s => [...s, cursor]); setCursor(nextCursor); load(nextCursor); };
  const goPrev = () => {
    const stack = [...cursorStack];
    const prev = stack.pop() || null;
    setCursorStack(stack);
    setCursor(prev);
    load(prev);
  };

  const openAdjust = () => { setForm({ product_id: '', location_id: '', quantity: '', reason: '', remarks: '' }); setFormError(''); setSuccessMsg(''); setMode('adjust'); };
  const openTransfer = () => { setForm({ product_id: '', from_location_id: '', to_location_id: '', quantity: '', reason: '', remarks: '' }); setFormError(''); setSuccessMsg(''); setMode('transfer'); };

  const submit = async (e) => {
    e.preventDefault();
    setFormError('');
    if (!form.product_id) { setFormError('Select an item.'); return; }
    if (!form.quantity || Number.isNaN(Number(form.quantity)) || Number(form.quantity) === 0) { setFormError('Enter a non-zero quantity.'); return; }
    if (mode === 'adjust' && !form.location_id) { setFormError('Select a location.'); return; }
    if (mode === 'adjust' && !form.reason.trim()) { setFormError('A reason is required for an adjustment.'); return; }
    if (mode === 'transfer' && (!form.from_location_id || !form.to_location_id)) { setFormError('Select both source and destination locations.'); return; }
    if (mode === 'transfer' && form.from_location_id === form.to_location_id) { setFormError('Source and destination must differ.'); return; }
    if (mode === 'transfer' && Number(form.quantity) <= 0) { setFormError('Transfer quantity must be greater than zero.'); return; }

    setSubmitting(true);
    try {
      const body = mode === 'adjust'
        ? { movement_type: 'ADJUSTMENT', product_id: form.product_id, location_id: form.location_id, quantity: Number(form.quantity), reason: form.reason, remarks: form.remarks }
        : { movement_type: 'TRANSFER', product_id: form.product_id, from_location_id: form.from_location_id, to_location_id: form.to_location_id, quantity: Number(form.quantity), reason: form.reason, remarks: form.remarks };
      const result = await inventoryFetch('/inventory/movements', { token, method: 'POST', body });
      setSuccessMsg(result.message || 'Movement recorded.');
      setMode(null);
      load(cursor);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 6, background: '#020617', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' };
  const selectStyle = { padding: '9px 12px', borderRadius: 6, background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' };

  return (
    <div style={{ padding: 24, color: '#fff', maxWidth: 1300, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 800 }}>Stock Movements</h2>
        {canMove && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={openAdjust} style={primaryBtnStyle}><SlidersHorizontal size={15} /> Adjust Stock</button>
            <button onClick={openTransfer} style={primaryBtnStyle}><ArrowLeftRight size={15} /> Transfer Stock</button>
          </div>
        )}
      </div>

      {successMsg && <div style={{ background: 'rgba(16,185,129,0.15)', border: '1px solid #10b981', color: '#10b981', padding: 12, borderRadius: 8, marginBottom: 16 }}>{successMsg}</div>}
      {error && <div style={errorBoxStyle}>{error}</div>}

      {mode && (
        <form onSubmit={submit} className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 20, border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>{mode === 'adjust' ? 'Adjust Stock' : 'Transfer Stock'}</h3>
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>Item *</label>
            <select value={form.product_id} onChange={e => setForm({ ...form, product_id: e.target.value })} style={{ ...inputStyle }}>
              <option value="">Select item</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku}) — {formatQty(p.current_stock)} {p.unit_of_measure}</option>)}
            </select>
          </div>

          {mode === 'adjust' ? (
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>Location *</label>
              <select value={form.location_id} onChange={e => setForm({ ...form, location_id: e.target.value })} style={inputStyle}>
                <option value="">Select location</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>From *</label>
                <select value={form.from_location_id} onChange={e => setForm({ ...form, from_location_id: e.target.value })} style={inputStyle}>
                  <option value="">Source location</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>To *</label>
                <select value={form.to_location_id} onChange={e => setForm({ ...form, to_location_id: e.target.value })} style={inputStyle}>
                  <option value="">Destination location</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            </div>
          )}

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>
              Quantity {mode === 'adjust' ? '(positive to add, negative to remove) *' : '*'}
            </label>
            <input type="number" step="any" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} style={inputStyle} />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>Reason{mode === 'adjust' ? ' *' : ''}</label>
            <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder={mode === 'adjust' ? 'e.g. Physical count correction' : 'e.g. Rebalance between stores'} style={inputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>Remarks</label>
            <input value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} style={inputStyle} />
          </div>

          {formError && <div style={{ color: '#ef4444', fontSize: '0.85rem' }}>{formError}</div>}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setMode(null)} style={secondaryBtnStyle}>Cancel</button>
            <button type="submit" disabled={submitting} style={primaryBtnStyle}>{submitting ? 'Saving...' : 'Submit'}</button>
          </div>
        </form>
      )}

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', border: '1px solid rgba(255,255,255,0.08)' }}>
        <Filter size={15} color="#64748b" />
        <select value={productId} onChange={e => setProductId(e.target.value)} style={selectStyle}>
          <option value="">All Items</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
        </select>
        <select value={locationId} onChange={e => setLocationId(e.target.value)} style={selectStyle}>
          <option value="">All Locations</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select value={movementType} onChange={e => setMovementType(e.target.value)} style={selectStyle}>
          <option value="">All Movement Types</option>
          {Object.entries(MOVEMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button onClick={() => load(cursor)} style={iconBtnStyle}><RefreshCw size={16} /></button>
      </div>

      <div className="glass" style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading movement history...</div>
        ) : movements.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No movements match the current filters.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={{ padding: '10px 14px' }}>Date/Time</th>
                  <th style={{ padding: '10px 14px' }}>Item</th>
                  <th style={{ padding: '10px 14px' }}>Type</th>
                  <th style={{ padding: '10px 14px' }}>Qty</th>
                  <th style={{ padding: '10px 14px' }}>Before → After</th>
                  <th style={{ padding: '10px 14px' }}>Location</th>
                  <th style={{ padding: '10px 14px' }}>Reason</th>
                  <th style={{ padding: '10px 14px' }}>By</th>
                </tr>
              </thead>
              <tbody>
                {movements.map(m => (
                  <tr key={m.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '8px 14px', color: '#94a3b8', whiteSpace: 'nowrap' }}>{new Date(m.created_at).toLocaleString()}</td>
                    <td style={{ padding: '8px 14px', fontWeight: 600 }}>{m.product_name} <span style={{ color: '#64748b' }}>({m.sku})</span></td>
                    <td style={{ padding: '8px 14px' }}>{MOVEMENT_LABELS[m.movement_type] || m.movement_type}</td>
                    <td style={{ padding: '8px 14px', fontWeight: 700 }}>{formatQty(m.quantity)} {m.unit}</td>
                    <td style={{ padding: '8px 14px', color: '#94a3b8' }}>{formatQty(m.qty_before)} → {formatQty(m.qty_after)}</td>
                    <td style={{ padding: '8px 14px' }}>{m.location_name || m.location_id}</td>
                    <td style={{ padding: '8px 14px', color: '#94a3b8' }}>{m.reason || '—'}</td>
                    <td style={{ padding: '8px 14px', color: '#94a3b8' }}>{m.actor_name || m.actor_uid || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16, alignItems: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>
        <button disabled={cursorStack.length === 0} onClick={goPrev} style={pagerBtnStyle(cursorStack.length === 0)}>Previous</button>
        <button disabled={!nextCursor} onClick={goNext} style={pagerBtnStyle(!nextCursor)}>Next</button>
      </div>
    </div>
  );
}

function pagerBtnStyle(disabled) {
  return { padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)', background: disabled ? 'rgba(255,255,255,0.02)' : 'rgba(15,23,42,0.6)', color: disabled ? '#475569' : '#fff', cursor: disabled ? 'not-allowed' : 'pointer' };
}
const iconBtnStyle = { padding: 9, borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#94a3b8', cursor: 'pointer' };
const primaryBtnStyle = { display: 'flex', alignItems: 'center', gap: 8, background: 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' };
const secondaryBtnStyle = { padding: '9px 16px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', fontWeight: 600, cursor: 'pointer' };
const errorBoxStyle = { background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', color: '#ef4444', padding: 12, borderRadius: 8, marginBottom: 16 };
