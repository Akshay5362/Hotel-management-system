/**
 * ItemDrawer.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Side drawer opened from a Stock row. Shows the item, where its stock is held,
 * and its recent ledger, without leaving the Stock screen. Two requests on
 * open — the product (GET /inventory/products/:id) and its last movements
 * (GET /inventory/products/:id/movements?limit=10) — and nothing on a timer.
 *
 * Stock actions inside the drawer post through the same StockMovementForm the
 * History screen uses, so this adds a place to act, not a second way to act.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeftRight, Package, PlusCircle, History } from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';
import { Alert, Button, StatusBadge, humanError, fmtDateTime, money } from './ui';
import { STOCK_STATUS, MOVEMENT_TYPE, statusOf } from './statusMaps';
import StockMovementForm from './StockMovementForm';

export default function ItemDrawer({ token, productId, open, onClose, canMove, locations, onChanged }) {
  const [product, setProduct] = useState(null);
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState(null); // null | 'adjust' | 'transfer'
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!productId) return;
    setLoading(true); setError('');
    try {
      const [p, m] = await Promise.all([
        inventoryFetch(`/inventory/products/${productId}`, { token }),
        inventoryFetch(`/inventory/products/${productId}/movements?limit=10`, { token }).catch(() => ({ movements: [] }))
      ]);
      setProduct(p.product || null);
      setMovements(m.movements || []);
    } catch (err) {
      setError(humanError(err, 'Unable to load this item right now.'));
    } finally {
      setLoading(false);
    }
  }, [token, productId]);

  useEffect(() => {
    if (open) { setAction(null); setNotice(''); load(); }
    else { setProduct(null); setMovements([]); }
  }, [open, load]);

  const st = product ? statusOf(STOCK_STATUS, product.stock_status) : null;
  const total = product ? Number(product.total_stock ?? product.current_stock) || 0 : 0;
  const minimum = product ? Number(product.minimum_stock_level) || 0 : 0;
  const byLoc = product?.stock_by_location || [];
  const maxLoc = byLoc.reduce((m, l) => Math.max(m, Number(l.quantity) || 0), 0);

  return (
    <DrawerShell open={open} onClose={onClose} product={product} loading={loading}>
        {error ? <Alert tone="error" onRetry={load}>{error}</Alert> : null}
        {notice ? <Alert tone="ok" onDismiss={() => setNotice('')}>{notice}</Alert> : null}

        {loading && !product ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[80, 60, 70, 50].map((w, i) => <span key={i} className="inv-skel" style={{ width: `${w}%` }} />)}
          </div>
        ) : null}

        {product ? (
          <>
            <div className="inv-kv">
              <div><span>Current stock</span><strong>{formatQty(total)} {product.unit_of_measure}</strong></div>
              <div><span>Minimum level</span><strong>{formatQty(minimum)} {product.unit_of_measure}</strong></div>
              <div><span>Status</span><strong><StatusBadge label={st.label} tone={st.tone} /></strong></div>
              <div><span>Category</span><strong style={{ fontSize: '0.85rem' }}>{product.category_name || '—'}</strong></div>
              {product.cost_price != null ? <div><span>Cost price</span><strong>{money(product.cost_price)}</strong></div> : null}
              {product.last_movement_at ? <div><span>Last movement</span><strong style={{ fontSize: '0.82rem' }}>{fmtDateTime(product.last_movement_at)}</strong></div> : null}
            </div>

            {canMove && !action ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="primary" icon={PlusCircle} onClick={() => setAction('adjust')}>Add stock</Button>
                <Button icon={ArrowLeftRight} onClick={() => setAction('transfer')}>Transfer</Button>
              </div>
            ) : null}

            {action ? (
              <div className="inv-card" style={{ padding: 14 }}>
                <div className="inv-section-title">{action === 'adjust' ? 'Adjust stock' : 'Transfer between locations'}</div>
                <StockMovementForm
                  token={token}
                  mode={action}
                  product={product}
                  locations={locations}
                  onCancel={() => setAction(null)}
                  onDone={(res) => {
                    setAction(null);
                    setNotice(res?.message || 'Movement recorded. Stock has been updated.');
                    load();
                    onChanged?.();
                  }}
                />
              </div>
            ) : null}

            <div>
              <div className="inv-section-title">Stock by location</div>
              {byLoc.length === 0 ? (
                <div className="inv-hint">No location breakdown is recorded for this item yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {byLoc.map(l => (
                    <div key={l.location_id}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: 3 }}>
                        <span>{l.location_name || l.location_id}</span>
                        <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatQty(l.quantity)} {product.unit_of_measure}</strong>
                      </div>
                      <div className="inv-bar"><div style={{ width: maxLoc > 0 ? `${Math.round((Number(l.quantity) || 0) / maxLoc * 100)}%` : 0 }} /></div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="inv-section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><History size={12} /> Recent stock history</div>
              {movements.length === 0 ? (
                <div className="inv-hint">No movements recorded for this item.</div>
              ) : (
                <div className="inv-card">
                  <table className="inv-table">
                    <tbody>
                      {movements.map(m => {
                        const t = statusOf(MOVEMENT_TYPE, m.movement_type);
                        const q = Number(m.quantity) || 0;
                        return (
                          <tr key={m.id}>
                            <td className="muted nowrap" style={{ fontSize: '0.76rem' }}>{fmtDateTime(m.created_at)}</td>
                            <td><StatusBadge label={t.label} tone={t.tone} /></td>
                            <td className="num strong" style={{ color: q < 0 ? 'var(--inv-bad)' : 'var(--inv-ok)' }}>{q > 0 ? '+' : ''}{formatQty(q)}</td>
                            <td className="muted" style={{ fontSize: '0.76rem' }}>{m.location_name || m.location_id || ''}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : null}
    </DrawerShell>
  );
}

/** The drawer chrome, using the application's own slide-over classes. */
function DrawerShell({ open, onClose, product, loading, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      <div className={`slide-over-overlay${open ? ' open' : ''}`} onClick={onClose} />
      <div className={`slide-over-drawer inv-drawer${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="drawer-header">
          <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Package size={18} color="var(--inv-accent)" />
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: '1.02rem', margin: 0, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {product?.name || (loading ? 'Loading…' : 'Item')}
              </h2>
              {product ? <div className="mono" style={{ color: 'var(--inv-accent)', fontSize: '0.74rem', fontFamily: 'ui-monospace, Menlo, monospace' }}>{product.sku}</div> : null}
            </div>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">✕</Button>
        </div>
        <div className="drawer-content">{open ? children : null}</div>
      </div>
    </>
  );
}
