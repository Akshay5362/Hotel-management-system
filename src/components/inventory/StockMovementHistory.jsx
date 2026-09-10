/**
 * StockMovementHistory.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * History › Stock Movements — the append-only ledger (VIEW role) plus, for
 * MOVE roles (admin, super_admin, kitchen, housekeeper), the two Phase A
 * actions that change stock: Adjustment and Transfer. Those now post through
 * the shared StockMovementForm, so this screen and the Stock screen send one
 * and the same request. Opening stock is entered from Masters › Items.
 *
 * Reads GET /api/inventory/movements with the same filters and cursor paging
 * as before. Nothing here is new to the backend.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, SlidersHorizontal, ArrowLeftRight, History } from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';
import { Alert, Button, Card, EmptyState, LoadingRows, Modal, Pager, StatusBadge, Table, Toolbar, humanError, fmtDateTime, PageHeader } from './ui';
import { MOVEMENT_TYPE, statusOf } from './statusMaps';
import StockMovementForm from './StockMovementForm';

const COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'item', label: 'Item' },
  { key: 'type', label: 'Type' },
  { key: 'qty', label: 'Quantity', className: 'num' },
  { key: 'bal', label: 'Before → after', className: 'num' },
  { key: 'loc', label: 'Location' },
  { key: 'user', label: 'User' },
  { key: 'ref', label: 'Reference' }
];

export default function StockMovementHistory({ token, canMove, embedded = false }) {
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
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [prodRes, locRes] = await Promise.all([
          inventoryFetch('/inventory/products?page_size=100', { token }),
          inventoryFetch('/inventory/locations', { token })
        ]);
        if (cancelled) return;
        setProducts(prodRes.products || []);
        setLocations((locRes.locations || []).filter(l => l.is_active !== false));
      } catch { /* dropdowns degrade to empty; the list below still works */ }
    })();
    return () => { cancelled = true; };
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
      setError(humanError(err, 'Unable to load stock movements right now. Please try again.'));
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

  const referenceOf = (m) => {
    if (m.reference_id) return `${m.reference_type ? m.reference_type.replace(/_/g, ' ').toLowerCase() + ' ' : ''}${m.reference_id}`;
    return m.reason || '—';
  };

  return (
    <div className={embedded ? '' : 'inv-page'} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {!embedded ? <PageHeader icon={History} title="Stock Movements" subtitle="Every change to stock, in the order it happened." /> : null}

      <Toolbar>
        <select className="inv-select" value={productId} onChange={e => setProductId(e.target.value)} aria-label="Item">
          <option value="">All items</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
        </select>
        <select className="inv-select" value={locationId} onChange={e => setLocationId(e.target.value)} aria-label="Location">
          <option value="">All locations</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select className="inv-select" value={movementType} onChange={e => setMovementType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {Object.entries(MOVEMENT_TYPE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <Button variant="ghost" icon={RefreshCw} onClick={() => load(cursor)} title="Refresh" aria-label="Refresh" />
        <div className="inv-spacer" />
        {canMove ? (
          <>
            <Button icon={ArrowLeftRight} onClick={() => { setSuccessMsg(''); setMode('transfer'); }}>Transfer</Button>
            <Button variant="primary" icon={SlidersHorizontal} onClick={() => { setSuccessMsg(''); setMode('adjust'); }}>Adjust Stock</Button>
          </>
        ) : null}
      </Toolbar>

      {successMsg ? <Alert tone="ok" onDismiss={() => setSuccessMsg('')}>{successMsg}</Alert> : null}
      {error ? <Alert tone="error" onRetry={() => load(cursor)}>{error}</Alert> : null}

      <Card>
        <Table columns={COLUMNS}>
          {loading ? <LoadingRows columns={COLUMNS.length} rows={8} /> : null}
          {!loading && movements.length === 0 ? (
            <tr><td colSpan={COLUMNS.length}>
              <EmptyState title="No stock movements" text={productId || locationId || movementType ? 'Nothing matches the current filters.' : 'Receipts, adjustments and transfers will be listed here as they happen.'} />
            </td></tr>
          ) : null}
          {!loading && movements.map(m => {
            const t = statusOf(MOVEMENT_TYPE, m.movement_type);
            const q = Number(m.quantity) || 0;
            return (
              <tr key={m.id}>
                <td className="muted nowrap">{fmtDateTime(m.created_at)}</td>
                <td><span className="strong">{m.product_name}</span><span className="inv-cell-sub">{m.sku}</span></td>
                <td><StatusBadge label={t.label} tone={t.tone} /></td>
                <td className="num strong" style={{ color: q < 0 ? 'var(--inv-bad)' : q > 0 ? 'var(--inv-ok)' : undefined }}>{q > 0 ? '+' : ''}{formatQty(q)} <span className="muted" style={{ fontWeight: 400 }}>{m.unit}</span></td>
                <td className="num muted">{formatQty(m.qty_before)} → {formatQty(m.qty_after)}</td>
                <td>{m.location_name || m.location_id}</td>
                <td className="muted">{m.actor_name || m.actor_uid || '—'}</td>
                <td className="muted" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.reason || ''}>{referenceOf(m)}</td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Pager canPrev={cursorStack.length > 0} canNext={Boolean(nextCursor)} onPrev={goPrev} onNext={goNext} />

      <Modal open={Boolean(mode)} title={mode === 'adjust' ? 'Adjust stock' : 'Transfer stock'} onClose={() => setMode(null)}>
        {mode ? (
          <StockMovementForm
            token={token}
            mode={mode}
            products={products}
            locations={locations}
            onCancel={() => setMode(null)}
            onDone={(result) => {
              setSuccessMsg(result?.message || 'Movement recorded.');
              setMode(null);
              load(cursor);
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
}
