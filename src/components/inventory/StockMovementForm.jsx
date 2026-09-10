/**
 * StockMovementForm.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The Adjust / Transfer form, lifted out of StockMovementHistory.jsx so the
 * Stock screen's "+ Add Stock" action and the History screen share ONE form
 * and ONE request. The payloads posted to POST /api/inventory/movements are
 * byte-for-byte the ones the Phase A screen already sent — this component
 * changes where the form appears, not what it does.
 *
 * MOVE role only (admin, super_admin, kitchen, housekeeper). The server
 * enforces that independently; this form merely is not offered to others.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, SlidersHorizontal } from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';
import { Alert, Button, Field, humanError } from './ui';

const EMPTY = { product_id: '', location_id: '', from_location_id: '', to_location_id: '', quantity: '', reason: '', remarks: '' };

/**
 * @param {'adjust'|'transfer'} mode
 * @param {object} [product]     preselects and locks the item (from the drawer)
 * @param {Array}  [products]    already-loaded product list; fetched if absent
 * @param {Array}  [locations]   already-loaded locations; fetched if absent
 */
export default function StockMovementForm({ token, mode = 'adjust', product = null, products: productsProp, locations: locationsProp, onDone, onCancel }) {
  const [products, setProducts] = useState(productsProp || []);
  const [locations, setLocations] = useState(locationsProp || []);
  const [form, setForm] = useState({ ...EMPTY, product_id: product?.id || '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Master data is only fetched when the caller did not already have it, so
  // opening this form from a screen that loaded products costs no request.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!productsProp && !product) {
          const p = await inventoryFetch('/inventory/products?page_size=100&status=Active', { token });
          if (!cancelled) setProducts(p.products || []);
        }
        if (!locationsProp) {
          const l = await inventoryFetch('/inventory/locations', { token });
          if (!cancelled) setLocations((l.locations || []).filter(x => x.is_active !== false));
        }
      } catch { /* the selects degrade to empty; the error surfaces on submit */ }
    })();
    return () => { cancelled = true; };
  }, [token, productsProp, locationsProp, product]);

  const selectedProduct = useMemo(
    () => product || products.find(p => p.id === form.product_id) || null,
    [product, products, form.product_id]
  );

  const set = (patch) => setForm(f => ({ ...f, ...patch }));

  const submit = async (e) => {
    e?.preventDefault?.();
    setError('');
    const qty = Number(form.quantity);
    if (!form.product_id) return setError('Select an item.');
    if (!form.quantity || Number.isNaN(qty) || qty === 0) return setError('Enter a non-zero quantity.');
    if (mode === 'adjust' && !form.location_id) return setError('Select a location.');
    if (mode === 'adjust' && !form.reason.trim()) return setError('A reason is required for an adjustment.');
    if (mode === 'transfer' && (!form.from_location_id || !form.to_location_id)) return setError('Select both the source and the destination.');
    if (mode === 'transfer' && form.from_location_id === form.to_location_id) return setError('Source and destination must be different.');
    if (mode === 'transfer' && qty <= 0) return setError('Transfer quantity must be greater than zero.');

    setSubmitting(true);
    try {
      const body = mode === 'adjust'
        ? { movement_type: 'ADJUSTMENT', product_id: form.product_id, location_id: form.location_id, quantity: qty, reason: form.reason, remarks: form.remarks }
        : { movement_type: 'TRANSFER', product_id: form.product_id, from_location_id: form.from_location_id, to_location_id: form.to_location_id, quantity: qty, reason: form.reason, remarks: form.remarks };
      const result = await inventoryFetch('/inventory/movements', { token, method: 'POST', body });
      onDone?.(result);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const Icon = mode === 'adjust' ? SlidersHorizontal : ArrowLeftRight;
  const unit = selectedProduct?.unit_of_measure || '';

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error ? <Alert tone="error" onDismiss={() => setError('')}>{error}</Alert> : null}

      <Field label="Item" required>
        {product ? (
          <div className="inv-input" style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.03)' }}>
            <strong>{product.name}</strong>
            <span className="inv-hint" style={{ margin: 0 }}>{product.sku} · {formatQty(product.current_stock ?? product.total_stock)} {unit}</span>
          </div>
        ) : (
          <select className="inv-select" style={{ width: '100%' }} value={form.product_id} onChange={e => set({ product_id: e.target.value })}>
            <option value="">Select item</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku}) — {formatQty(p.current_stock)} {p.unit_of_measure}</option>)}
          </select>
        )}
      </Field>

      {mode === 'adjust' ? (
        <Field label="Location" required>
          <select className="inv-select" style={{ width: '100%' }} value={form.location_id} onChange={e => set({ location_id: e.target.value })}>
            <option value="">Select location</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
      ) : (
        <div className="inv-form-grid">
          <Field label="From" required>
            <select className="inv-select" style={{ width: '100%' }} value={form.from_location_id} onChange={e => set({ from_location_id: e.target.value })}>
              <option value="">Source location</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="To" required>
            <select className="inv-select" style={{ width: '100%' }} value={form.to_location_id} onChange={e => set({ to_location_id: e.target.value })}>
              <option value="">Destination location</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        </div>
      )}

      <Field
        label={mode === 'adjust' ? `Quantity${unit ? ` (${unit})` : ''}` : `Quantity to move${unit ? ` (${unit})` : ''}`}
        required
        hint={mode === 'adjust' ? 'Positive adds stock, negative removes it.' : undefined}
      >
        <input className="inv-input" type="number" step="any" value={form.quantity} onChange={e => set({ quantity: e.target.value })} autoFocus={Boolean(product)} />
      </Field>

      <Field label="Reason" required={mode === 'adjust'}>
        <input className="inv-input" value={form.reason} onChange={e => set({ reason: e.target.value })}
          placeholder={mode === 'adjust' ? 'e.g. Physical count correction' : 'e.g. Rebalance between stores'} />
      </Field>
      <Field label="Remarks">
        <input className="inv-input" value={form.remarks} onChange={e => set({ remarks: e.target.value })} />
      </Field>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        {onCancel ? <Button onClick={onCancel} disabled={submitting}>Cancel</Button> : null}
        <Button variant="primary" icon={Icon} type="submit" disabled={submitting} onClick={submit}>
          {submitting ? 'Saving…' : mode === 'adjust' ? 'Record adjustment' : 'Transfer stock'}
        </Button>
      </div>
    </form>
  );
}
