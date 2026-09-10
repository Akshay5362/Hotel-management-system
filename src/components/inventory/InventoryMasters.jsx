/**
 * InventoryMasters.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Categories / Units / Locations — three small master-data tables sharing one
 * list+create+deactivate skeleton (all MANAGE-role, admin/super_admin only —
 * enforced server-side by requireRole in backend/routes/inventoryRoutes.js).
 * "Delete" always deactivates; nothing referenced elsewhere is ever removed.
 *
 * Batch 5: presentation only. Same endpoints, same payloads, same rules.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Power, RefreshCw, Tags, Ruler, Warehouse } from 'lucide-react';
import { inventoryFetch } from './inventoryApi';
import { Alert, Button, Card, EmptyState, Field, LoadingRows, StatusBadge, Table, humanError, PageHeader, Toolbar } from './ui';

const SECTIONS = {
  categories: {
    title: 'Categories', singular: 'Category', icon: Tags, blurb: 'Group items by department for filtering and reporting.',
    listPath: '/inventory/categories', listKey: 'categories', createPath: '/inventory/categories',
    updatePath: id => `/inventory/categories/${id}`, deletePath: id => `/inventory/categories/${id}`,
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'department', label: 'Department' },
      { key: 'description', label: 'Description' }
    ],
    fields: [
      { name: 'name', label: 'Category name', required: true },
      { name: 'department', label: 'Department', placeholder: 'e.g. Kitchen, Housekeeping' },
      { name: 'description', label: 'Description' }
    ]
  },
  units: {
    title: 'Units of Measure', singular: 'Unit', icon: Ruler, blurb: 'Every item is counted in exactly one unit. There is no conversion between units.',
    listPath: '/inventory/units', listKey: 'units', createPath: '/inventory/units',
    updatePath: id => `/inventory/units/${id}`, deletePath: id => `/inventory/units/${id}`,
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'name', label: 'Name' },
      { key: 'allow_decimal', label: 'Decimals', render: v => (v ? 'Yes' : 'No') }
    ],
    fields: [
      { name: 'code', label: 'Code', placeholder: 'e.g. KG, LTR, PC', required: true },
      { name: 'name', label: 'Name', placeholder: 'e.g. Kilogram' },
      { name: 'allow_decimal', label: 'Allow decimal quantities', type: 'checkbox', default: true }
    ]
  },
  locations: {
    title: 'Locations', singular: 'Location', icon: Warehouse, blurb: 'Stores and rooms where stock is held. Stock is tracked per location.',
    listPath: '/inventory/locations', listKey: 'locations', createPath: '/inventory/locations',
    updatePath: id => `/inventory/locations/${id}`, deletePath: id => `/inventory/locations/${id}`,
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'name', label: 'Name' },
      { key: 'department', label: 'Department' },
      { key: 'is_default', label: 'Default', render: v => (v ? 'Yes' : '') }
    ],
    fields: [
      { name: 'code', label: 'Code', placeholder: 'e.g. MAIN, KITCHEN', required: true },
      { name: 'name', label: 'Name', required: true },
      { name: 'department', label: 'Department', placeholder: 'e.g. Kitchen, Housekeeping' },
      { name: 'is_default', label: 'Default location for opening stock', type: 'checkbox' }
    ]
  }
};

export default function InventoryMasters({ token, section, embedded = false }) {
  const cfg = SECTIONS[section];
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await inventoryFetch(`${cfg.listPath}?include_inactive=true`, { token });
      setItems(data[cfg.listKey] || []);
    } catch (err) {
      setError(humanError(err, `Unable to load ${cfg.title.toLowerCase()} right now. Please try again.`));
    } finally {
      setLoading(false);
    }
  }, [token, cfg]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setForm(Object.fromEntries(cfg.fields.map(f => [f.name, f.default !== undefined ? f.default : (f.type === 'checkbox' ? false : '')])));
    setShowForm(false);
    setFormError('');
  }, [section, cfg.fields]);

  const openForm = () => {
    setForm(Object.fromEntries(cfg.fields.map(f => [f.name, f.default !== undefined ? f.default : (f.type === 'checkbox' ? false : '')])));
    setFormError('');
    setShowForm(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setFormError('');
    for (const f of cfg.fields) {
      if (f.required && !String(form[f.name] || '').trim()) { setFormError(`${f.label} is required.`); return; }
    }
    setSubmitting(true);
    try {
      await inventoryFetch(cfg.createPath, { token, method: 'POST', body: form });
      setShowForm(false);
      load();
    } catch (err) {
      setFormError(humanError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const deactivate = async (item) => {
    if (!window.confirm(`Deactivate "${item.name}"? This does not remove any data already referencing it.`)) return;
    try {
      await inventoryFetch(cfg.deletePath(item.id), { token, method: 'DELETE' });
      load();
    } catch (err) {
      setError(humanError(err));
    }
  };

  const Icon = cfg.icon;
  const cols = [...cfg.columns.map(c => ({ key: c.key, label: c.label })), { key: 'st', label: 'Status' }, { key: 'a', label: '', className: 'action' }];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader
        icon={Icon}
        title={cfg.title}
        subtitle={cfg.blurb}
        actions={
          <>
            <Button variant="ghost" icon={RefreshCw} onClick={load} title="Refresh" aria-label="Refresh" />
            <Button variant="primary" icon={Plus} onClick={openForm}>Add {cfg.singular}</Button>
          </>
        }
      />

      {error ? <Alert tone="error" onRetry={load} onDismiss={() => setError('')}>{error}</Alert> : null}

      {showForm ? (
        <Card title={`New ${cfg.singular.toLowerCase()}`} padded>
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="inv-form-grid">
              {cfg.fields.map(f => (
                f.type === 'checkbox' ? (
                  <label key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.84rem', alignSelf: 'end', height: 34 }}>
                    <input type="checkbox" checked={!!form[f.name]} onChange={e => setForm({ ...form, [f.name]: e.target.checked })} />
                    {f.label}
                  </label>
                ) : (
                  <Field key={f.name} label={f.label} required={f.required}>
                    <input className="inv-input" type="text" value={form[f.name] || ''} placeholder={f.placeholder || ''}
                      onChange={e => setForm({ ...form, [f.name]: e.target.value })} />
                  </Field>
                )
              ))}
            </div>
            {formError ? <Alert tone="error">{formError}</Alert> : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button onClick={() => setShowForm(false)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={submitting} onClick={submit}>{submitting ? 'Saving…' : 'Save'}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card>
        <Table columns={cols}>
          {loading ? <LoadingRows columns={cols.length} rows={4} /> : null}
          {!loading && items.length === 0 ? (
            <tr><td colSpan={cols.length}>
              <EmptyState icon={Icon} title={`No ${cfg.title.toLowerCase()} have been configured`} text={cfg.blurb}
                action={<Button size="sm" variant="primary" icon={Plus} onClick={openForm}>Add {cfg.singular}</Button>} />
            </td></tr>
          ) : null}
          {!loading && items.map(it => (
            <tr key={it.id} style={{ opacity: it.is_active === false ? 0.6 : 1 }}>
              {cfg.columns.map(c => <td key={c.key} className={c.key === 'code' ? 'mono' : ''}>{c.render ? c.render(it[c.key]) : (it[c.key] ?? '—')}</td>)}
              <td>{it.is_active === false ? <StatusBadge label="Inactive" tone="neutral" /> : <StatusBadge label="Active" tone="ok" />}</td>
              <td className="action">
                {it.is_active !== false ? (
                  <Button size="sm" variant="ghost" icon={Power} onClick={() => deactivate(it)} title="Deactivate">Deactivate</Button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
