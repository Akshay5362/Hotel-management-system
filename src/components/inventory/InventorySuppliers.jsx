/**
 * InventorySuppliers.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Supplier directory — MANAGE role only (admin/super_admin), matching the
 * spec's "do not expose supplier information to unauthorized roles." The
 * backend enforces this independently (GET/POST/PUT/DELETE /inventory/suppliers
 * all require MANAGE — see backend/routes/inventoryRoutes.js).
 *
 * Batch 5: presentation only. Same endpoints, same payloads, same rules.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Power, RefreshCw, Search, Truck } from 'lucide-react';
import { inventoryFetch } from './inventoryApi';
import { Alert, Button, Card, EmptyState, Field, LoadingRows, StatusBadge, Table, Toolbar, humanError, PageHeader } from './ui';

const EMPTY = { name: '', contact_person: '', phone: '', whatsapp: '', email: '', address: '', gstin: '', payment_terms: '' };

const COLS = [
  { key: 'name', label: 'Supplier' }, { key: 'contact', label: 'Contact' }, { key: 'phone', label: 'Phone' },
  { key: 'gstin', label: 'GSTIN' }, { key: 'terms', label: 'Payment terms' }, { key: 'st', label: 'Status' }, { key: 'a', label: '', className: 'action' }
];

export default function InventorySuppliers({ token, embedded = false }) {
  const [suppliers, setSuppliers] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ include_inactive: 'true' });
      if (search) params.set('search', search);
      const data = await inventoryFetch(`/inventory/suppliers?${params.toString()}`, { token });
      setSuppliers(data.suppliers || []);
    } catch (err) {
      setError(humanError(err, 'Unable to load suppliers right now. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, [token, search]);

  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setFormError('Supplier name is required.'); return; }
    setSubmitting(true);
    setFormError('');
    try {
      await inventoryFetch('/inventory/suppliers', { token, method: 'POST', body: form });
      setShowForm(false);
      setForm(EMPTY);
      load();
    } catch (err) {
      setFormError(humanError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const deactivate = async (s) => {
    if (!window.confirm(`Deactivate supplier "${s.name}"?`)) return;
    try {
      await inventoryFetch(`/inventory/suppliers/${s.id}`, { token, method: 'DELETE' });
      load();
    } catch (err) {
      setError(humanError(err));
    }
  };

  const fieldSets = [
    ['name', 'Supplier name', true], ['contact_person', 'Contact person'],
    ['phone', 'Phone'], ['whatsapp', 'WhatsApp number'],
    ['email', 'Email'], ['gstin', 'GSTIN'],
    ['payment_terms', 'Payment terms'], ['address', 'Address']
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader
        icon={Truck}
        title="Suppliers"
        subtitle="Vendor directory. Supplier details are copied onto each purchase order when it is created."
        actions={
          <>
            <Button variant="ghost" icon={RefreshCw} onClick={load} title="Refresh" aria-label="Refresh" />
            <Button variant="primary" icon={Plus} onClick={() => { setForm(EMPTY); setFormError(''); setShowForm(true); }}>Add Supplier</Button>
          </>
        }
      />

      <Toolbar>
        <div className="inv-search">
          <Search size={14} />
          <input className="inv-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search suppliers…" aria-label="Search suppliers" />
        </div>
      </Toolbar>

      {error ? <Alert tone="error" onRetry={load} onDismiss={() => setError('')}>{error}</Alert> : null}

      {showForm ? (
        <Card title="New supplier" padded>
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="inv-form-grid">
              {fieldSets.map(([key, label, required]) => (
                <div key={key} style={key === 'address' ? { gridColumn: '1 / -1' } : undefined}>
                  <Field label={label} required={required}>
                    <input className="inv-input" value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />
                  </Field>
                </div>
              ))}
            </div>
            {formError ? <Alert tone="error">{formError}</Alert> : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button onClick={() => setShowForm(false)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={submitting} onClick={submit}>{submitting ? 'Saving…' : 'Save supplier'}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card>
        <Table columns={COLS}>
          {loading ? <LoadingRows columns={COLS.length} rows={4} /> : null}
          {!loading && suppliers.length === 0 ? (
            <tr><td colSpan={COLS.length}>
              {search
                ? <EmptyState title="No suppliers match" text="Try a different search." />
                : <EmptyState icon={Truck} title="No suppliers have been configured" text="Add the vendors the hotel buys from. Each item can name a default supplier for purchase orders."
                    action={<Button size="sm" variant="primary" icon={Plus} onClick={() => { setForm(EMPTY); setFormError(''); setShowForm(true); }}>Add Supplier</Button>} />}
            </td></tr>
          ) : null}
          {!loading && suppliers.map(s => (
            <tr key={s.id} style={{ opacity: s.is_active === false ? 0.6 : 1 }}>
              <td><span className="strong">{s.name}</span>{s.email ? <span className="inv-cell-sub">{s.email}</span> : null}</td>
              <td>{s.contact_person || '—'}</td>
              <td className="nowrap">{s.phone || '—'}{s.whatsapp && s.whatsapp !== s.phone ? <span className="inv-cell-sub">WhatsApp {s.whatsapp}</span> : null}</td>
              <td className="mono" style={{ color: 'var(--inv-text-2)' }}>{s.gstin || '—'}</td>
              <td className="muted">{s.payment_terms || '—'}</td>
              <td>{s.is_active === false ? <StatusBadge label="Inactive" tone="neutral" /> : <StatusBadge label="Active" tone="ok" />}</td>
              <td className="action">
                {s.is_active !== false ? <Button size="sm" variant="ghost" icon={Power} onClick={() => deactivate(s)} title="Deactivate">Deactivate</Button> : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
