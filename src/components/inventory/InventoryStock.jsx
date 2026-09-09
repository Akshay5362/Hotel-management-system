/**
 * InventoryStock.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * "Stock" tab — current quantities, search/filter, pagination.
 * GET /api/inventory/stock (VIEW role: admin, super_admin, receptionist,
 * kitchen, housekeeper). No stock is changed from this screen — that lives
 * in the "Stock Movements" tab (adjust/transfer) and "Items" (opening stock).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Search, AlertTriangle, XCircle, CheckCircle, RefreshCw } from 'lucide-react';
import { inventoryFetch, STOCK_STATUS_COLORS, formatQty } from './inventoryApi';

export default function InventoryStock({ token }) {
  const [items, setItems] = useState([]);
  const [metrics, setMetrics] = useState({ totalProducts: 0, lowStockProducts: 0, outOfStockProducts: 0 });
  const [categories, setCategories] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [stockStatus, setStockStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState({ total: 0, total_pages: 1, page_size: 25 });

  useEffect(() => {
    (async () => {
      try {
        const [cats, locs] = await Promise.all([
          inventoryFetch('/inventory/categories', { token }),
          inventoryFetch('/inventory/locations', { token })
        ]);
        setCategories(cats.categories || []);
        setLocations(locs.locations || []);
      } catch { /* filters degrade gracefully to "All" if this fails */ }
    })();
  }, [token]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), page_size: '25' });
      if (search) params.set('search', search);
      if (categoryId) params.set('category_id', categoryId);
      if (locationId) params.set('location_id', locationId);
      if (stockStatus) params.set('stock_status', stockStatus);
      const data = await inventoryFetch(`/inventory/stock?${params.toString()}`, { token });
      setItems(data.items || []);
      setMetrics(data.metrics || {});
      setPageInfo({ total: data.total || 0, total_pages: data.total_pages || 1, page_size: data.page_size || 25 });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, search, categoryId, locationId, stockStatus, page]);

  useEffect(() => { setPage(1); }, [search, categoryId, locationId, stockStatus]);
  useEffect(() => { load(); }, [load]);

  const selectStyle = { padding: '9px 12px', borderRadius: 6, background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', outline: 'none' };

  return (
    <div style={{ padding: 24, color: '#fff', maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 }}>
        <MetricCard label="Items" value={metrics.totalProducts ?? pageInfo.total} icon={CheckCircle} color="#38bdf8" />
        <MetricCard label="Low Stock" value={metrics.lowStockProducts ?? 0} icon={AlertTriangle} color="#f59e0b" />
        <MetricCard label="Out of Stock" value={metrics.outOfStockProducts ?? 0} icon={XCircle} color="#ef4444" />
      </div>

      <div className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ flex: '1 1 220px', position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
          <input
            type="text" placeholder="Search by name or SKU..." value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', padding: '9px 12px 9px 36px', borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', outline: 'none' }}
          />
        </div>
        <select value={categoryId} onChange={e => setCategoryId(e.target.value)} style={selectStyle}>
          <option value="">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={locationId} onChange={e => setLocationId(e.target.value)} style={selectStyle}>
          <option value="">All Locations (total)</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select value={stockStatus} onChange={e => setStockStatus(e.target.value)} style={selectStyle}>
          <option value="">All Statuses</option>
          <option value="LOW_STOCK">Low Stock</option>
          <option value="OUT_OF_STOCK">Out of Stock</option>
          <option value="NORMAL">Normal</option>
        </select>
        <button onClick={load} title="Refresh" style={{ padding: 9, borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#94a3b8', cursor: 'pointer' }}>
          <RefreshCw size={16} />
        </button>
      </div>

      {error && <div style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', color: '#ef4444', padding: 12, borderRadius: 8, marginBottom: 16 }}>{error}</div>}

      <div className="glass" style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading stock...</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No items match the current filters.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={{ padding: '12px 16px' }}>Item</th>
                  <th style={{ padding: '12px 16px' }}>SKU</th>
                  <th style={{ padding: '12px 16px' }}>Category</th>
                  <th style={{ padding: '12px 16px' }}>Quantity</th>
                  <th style={{ padding: '12px 16px' }}>Unit</th>
                  <th style={{ padding: '12px 16px' }}>Min Level</th>
                  <th style={{ padding: '12px 16px' }}>Status</th>
                  <th style={{ padding: '12px 16px' }}>Last Movement</th>
                </tr>
              </thead>
              <tbody>
                {items.map(p => {
                  const st = STOCK_STATUS_COLORS[p.stock_status] || STOCK_STATUS_COLORS.NORMAL;
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '10px 16px', fontWeight: 700 }}>{p.name}</td>
                      <td style={{ padding: '10px 16px', fontFamily: 'monospace', color: '#38bdf8' }}>{p.sku}</td>
                      <td style={{ padding: '10px 16px' }}>{p.category_name}</td>
                      <td style={{ padding: '10px 16px', fontWeight: 700 }}>{formatQty(p.current_stock)}</td>
                      <td style={{ padding: '10px 16px', color: '#94a3b8' }}>{p.unit_of_measure}</td>
                      <td style={{ padding: '10px 16px', color: '#94a3b8' }}>{formatQty(p.minimum_stock_level)}</td>
                      <td style={{ padding: '10px 16px' }}>
                        <span style={{ padding: '4px 10px', borderRadius: 12, fontSize: '0.75rem', fontWeight: 700, background: st.bg, color: st.fg }}>{st.label}</span>
                      </td>
                      <td style={{ padding: '10px 16px', color: '#64748b', fontSize: '0.8rem' }}>{p.last_movement_at ? new Date(p.last_movement_at).toLocaleString() : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pageInfo.total_pages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16, alignItems: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={pagerBtnStyle(page <= 1)}>Previous</button>
          <span>Page {page} of {pageInfo.total_pages} ({pageInfo.total} items)</span>
          <button disabled={page >= pageInfo.total_pages} onClick={() => setPage(p => p + 1)} style={pagerBtnStyle(page >= pageInfo.total_pages)}>Next</button>
        </div>
      )}
    </div>
  );
}

function pagerBtnStyle(disabled) {
  return { padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)', background: disabled ? 'rgba(255,255,255,0.02)' : 'rgba(15,23,42,0.6)', color: disabled ? '#475569' : '#fff', cursor: disabled ? 'not-allowed' : 'pointer' };
}

function MetricCard({ label, value, icon: Icon, color }) {
  return (
    <div className="glass" style={{ padding: '16px 20px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontWeight: 600 }}>{label}</span>
        <Icon size={20} color={color} />
      </div>
      <div style={{ fontSize: '1.8rem', fontWeight: 800, marginTop: 8, color }}>{value}</div>
    </div>
  );
}
