/**
 * InventoryStock.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Stock — the operational workspace. One compact toolbar, one dense table, one
 * primary action, and a side drawer for the item so nobody navigates away to
 * see where something is kept.
 *
 * Reads GET /api/inventory/stock exactly as before (VIEW role). The only write
 * reachable from here is the shared StockMovementForm, which posts the same
 * POST /api/inventory/movements request the History screen always has. This
 * screen never changes stock by itself.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, PlusCircle, SlidersHorizontal, Boxes, PackageSearch } from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';
import { Button, Card, EmptyState, LoadingRows, Modal, Pager, StatusBadge, Table, Toolbar, Alert, humanError, PageHeader } from './ui';
import { STOCK_STATUS, statusOf } from './statusMaps';
import ItemDrawer from './ItemDrawer';
import StockMovementForm from './StockMovementForm';

const COLUMNS = [
  { key: 'item', label: 'Item' },
  { key: 'category', label: 'Category' },
  { key: 'location', label: 'Location' },
  { key: 'stock', label: 'Stock', className: 'num' },
  { key: 'unit', label: 'Unit' },
  { key: 'min', label: 'Minimum', className: 'num' },
  { key: 'status', label: 'Status' },
  { key: 'action', label: '', className: 'action' }
];

export default function InventoryStock({ token, canMove = false, initialStatus = '', onRequestStock }) {
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [stockStatus, setStockStatus] = useState(initialStatus || '');
  const [moreFilters, setMoreFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState({ total: 0, total_pages: 1, page_size: 25 });

  const [drawerId, setDrawerId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [notice, setNotice] = useState('');

  // Master data for the filters: once per mount, and shared with the drawer.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, l] = await Promise.all([
          inventoryFetch('/inventory/categories', { token }),
          inventoryFetch('/inventory/locations', { token })
        ]);
        if (cancelled) return;
        setCategories(c.categories || []);
        setLocations((l.locations || []).filter(x => x.is_active !== false));
      } catch { /* filters simply offer "All" */ }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), page_size: '25' });
      if (debounced) params.set('search', debounced);
      if (categoryId) params.set('category_id', categoryId);
      if (locationId) params.set('location_id', locationId);
      if (stockStatus) params.set('stock_status', stockStatus);
      const data = await inventoryFetch(`/inventory/stock?${params.toString()}`, { token });
      setItems(data.items || []);
      setPageInfo({ total: data.total || 0, total_pages: data.total_pages || 1, page_size: data.page_size || 25 });
    } catch (err) {
      setError(humanError(err, 'Unable to load stock right now. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, [token, debounced, categoryId, locationId, stockStatus, page]);

  useEffect(() => { setPage(1); }, [debounced, categoryId, locationId, stockStatus]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (initialStatus !== undefined) setStockStatus(initialStatus || ''); }, [initialStatus]);

  const locationLabel = useMemo(() => {
    if (!locationId) return null;
    return locations.find(l => l.id === locationId)?.name || locationId;
  }, [locationId, locations]);

  const clearFilters = () => { setSearch(''); setCategoryId(''); setLocationId(''); setStockStatus(''); };
  const hasFilters = Boolean(debounced || categoryId || locationId || stockStatus);

  return (
    <div className="inv-page">
      <PageHeader
        icon={Boxes}
        title="Stock"
        subtitle={locationLabel ? `Quantities held at ${locationLabel}` : 'Current quantities across every location'}
        actions={canMove ? (
          <Button variant="primary" icon={PlusCircle} onClick={() => setAddOpen(true)}>Add Stock</Button>
        ) : null}
      />

      <Toolbar>
        <div className="inv-search">
          <Search size={14} />
          <input className="inv-input" placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search items" />
        </div>
        <select className="inv-select" value={categoryId} onChange={e => setCategoryId(e.target.value)} aria-label="Category">
          <option value="">Category</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="inv-select" value={locationId} onChange={e => setLocationId(e.target.value)} aria-label="Location">
          <option value="">Location</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select className="inv-select" value={stockStatus} onChange={e => setStockStatus(e.target.value)} aria-label="Status">
          <option value="">Status</option>
          <option value="LOW_STOCK">Low</option>
          <option value="OUT_OF_STOCK">Out of stock</option>
          <option value="NORMAL">In stock</option>
        </select>
        <Button variant={moreFilters ? '' : 'ghost'} icon={SlidersHorizontal} onClick={() => setMoreFilters(v => !v)}>More filters</Button>
        <div className="inv-spacer" />
        {hasFilters ? <Button variant="ghost" size="sm" onClick={clearFilters}>Clear</Button> : null}
        <Button variant="ghost" icon={RefreshCw} onClick={() => load({ silent: true })} title="Refresh" aria-label="Refresh" />
      </Toolbar>

      {moreFilters ? (
        <div className="inv-card" style={{ padding: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--inv-muted)' }}>
          <span>Showing {pageInfo.total} item{pageInfo.total === 1 ? '' : 's'}{hasFilters ? ' matching the current filters' : ''}.</span>
          <span>Choose a location to see the quantity held there rather than the total.</span>
        </div>
      ) : null}

      {error ? <Alert tone="error" onRetry={() => load()}>{error}</Alert> : null}
      {notice ? <Alert tone="ok" onDismiss={() => setNotice('')}>{notice}</Alert> : null}

      <Card>
        <Table columns={COLUMNS}>
          {loading ? <LoadingRows columns={COLUMNS.length} rows={8} /> : null}
          {!loading && items.length === 0 ? (
            <tr><td colSpan={COLUMNS.length}>
              {hasFilters ? (
                <EmptyState icon={PackageSearch} title="No items match" text="Try a different search or clear the filters."
                  action={<Button size="sm" onClick={clearFilters}>Clear filters</Button>} />
              ) : stockStatus === 'LOW_STOCK' || stockStatus === 'OUT_OF_STOCK' ? (
                <EmptyState title="All stock levels are healthy." text="Nothing is below its minimum level right now." />
              ) : (
                <EmptyState title="No stock items yet" text="Add items under Masters › Items to start tracking stock." />
              )}
            </td></tr>
          ) : null}
          {!loading && items.map(p => {
            const st = statusOf(STOCK_STATUS, p.stock_status);
            return (
              <tr key={p.id} className="row-link" onClick={() => setDrawerId(p.id)}>
                <td>
                  <span className="strong">{p.name}</span>
                  <span className="inv-cell-sub mono" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{p.sku}</span>
                </td>
                <td className="muted">{p.category_name || '—'}</td>
                <td className="muted">
                  {locationId
                    ? (locationLabel || '—')
                    : (p.stock_by_location?.length
                        ? (p.stock_by_location.length === 1 ? p.stock_by_location[0].location_name : `${p.stock_by_location.length} locations`)
                        : '—')}
                </td>
                <td className="num strong">{formatQty(p.current_stock)}</td>
                <td className="muted">{p.unit_of_measure}</td>
                <td className="num muted">{formatQty(p.minimum_stock_level)}</td>
                <td><StatusBadge label={st.label} tone={st.tone} /></td>
                <td className="action" onClick={e => e.stopPropagation()}>
                  {p.stock_status !== 'NORMAL' && onRequestStock ? (
                    <Button size="sm" onClick={() => onRequestStock(p)}>Request stock</Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setDrawerId(p.id)}>Details</Button>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>

      {pageInfo.total_pages > 1 ? (
        <Pager
          canPrev={page > 1} canNext={page < pageInfo.total_pages}
          onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)}
          label={`Page ${page} of ${pageInfo.total_pages} · ${pageInfo.total} items`}
        />
      ) : null}

      <ItemDrawer
        token={token}
        productId={drawerId}
        open={Boolean(drawerId)}
        onClose={() => setDrawerId(null)}
        canMove={canMove}
        locations={locations}
        onChanged={() => load({ silent: true })}
      />

      <Modal open={addOpen} title="Add stock" onClose={() => setAddOpen(false)}>
        <div className="inv-hint" style={{ marginBottom: 4 }}>
          Records an adjustment in the stock ledger. To move stock between locations, open the item and choose Transfer.
        </div>
        <StockMovementForm
          token={token}
          mode="adjust"
          locations={locations}
          onCancel={() => setAddOpen(false)}
          onDone={(res) => { setAddOpen(false); setNotice(res?.message || 'Stock recorded.'); load({ silent: true }); }}
        />
      </Modal>
    </div>
  );
}
