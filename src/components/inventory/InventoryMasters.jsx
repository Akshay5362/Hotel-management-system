/**
 * InventoryMasters.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Categories / Units / Locations — three small master-data tables sharing one
 * list+create+deactivate skeleton (all MANAGE-role, admin/super_admin only —
 * enforced server-side by requireRole in backend/routes/inventoryRoutes.js).
 * "Delete" always deactivates; nothing referenced elsewhere is ever removed.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Power, RefreshCw, CheckCircle, XCircle } from 'lucide-react';
import { inventoryFetch } from './inventoryApi';

const SECTIONS = {
  categories: {
    title: 'Categories', listPath: '/inventory/categories', listKey: 'categories', createPath: '/inventory/categories',
    updatePath: id => `/inventory/categories/${id}`, deletePath: id => `/inventory/categories/${id}`,
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'department', label: 'Department' },
      { key: 'description', label: 'Description' }
    ],
    fields: [
      { name: 'name', label: 'Category Name', required: true },
      { name: 'department', label: 'Department', placeholder: 'e.g. Kitchen, Housekeeping' },
      { name: 'description', label: 'Description' }
    ]
  },
  units: {
    title: 'Units of Measure', listPath: '/inventory/units', listKey: 'units', createPath: '/inventory/units',
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
    title: 'Locations', listPath: '/inventory/locations', listKey: 'locations', createPath: '/inventory/locations',
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

export default function InventoryMasters({ token, section }) {
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
      setError(err.message);
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
      setFormError(err.message);
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
      alert(err.message);
    }
  };

  const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 6, background: '#020617', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' };

  return (
    <div style={{ padding: 24, color: '#fff', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 800 }}>{cfg.title}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={iconBtnStyle}><RefreshCw size={16} /></button>
          <button onClick={openForm} style={primaryBtnStyle}><Plus size={16} /> Add {cfg.title.replace(/s$/, '')}</button>
        </div>
      </div>

      {error && <div style={errorBoxStyle}>{error}</div>}

      {showForm && (
        <form onSubmit={submit} className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 20, border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {cfg.fields.map(f => (
            <div key={f.name}>
              {f.type === 'checkbox' ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}>
                  <input type="checkbox" checked={!!form[f.name]} onChange={e => setForm({ ...form, [f.name]: e.target.checked })} />
                  {f.label}
                </label>
              ) : (
                <>
                  <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>{f.label}{f.required ? ' *' : ''}</label>
                  <input
                    type="text" value={form[f.name] || ''} placeholder={f.placeholder || ''}
                    onChange={e => setForm({ ...form, [f.name]: e.target.value })}
                    style={inputStyle}
                  />
                </>
              )}
            </div>
          ))}
          {formError && <div style={{ color: '#ef4444', fontSize: '0.85rem' }}>{formError}</div>}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setShowForm(false)} style={secondaryBtnStyle}>Cancel</button>
            <button type="submit" disabled={submitting} style={primaryBtnStyle}>{submitting ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      )}

      <div className="glass" style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Nothing here yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  {cfg.columns.map(c => <th key={c.key} style={{ padding: '10px 16px' }}>{c.label}</th>)}
                  <th style={{ padding: '10px 16px' }}>Status</th>
                  <th style={{ padding: '10px 16px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', opacity: it.is_active === false ? 0.55 : 1 }}>
                    {cfg.columns.map(c => <td key={c.key} style={{ padding: '10px 16px' }}>{c.render ? c.render(it[c.key]) : (it[c.key] ?? '—')}</td>)}
                    <td style={{ padding: '10px 16px' }}>
                      {it.is_active === false
                        ? <span style={badgeStyle('#94a3b8', 'rgba(148,163,184,0.15)')}><XCircle size={12} /> Inactive</span>
                        : <span style={badgeStyle('#10b981', 'rgba(16,185,129,0.15)')}><CheckCircle size={12} /> Active</span>}
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                      {it.is_active !== false && (
                        <button onClick={() => deactivate(it)} title="Deactivate" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}>
                          <Power size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const iconBtnStyle = { padding: 9, borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#94a3b8', cursor: 'pointer' };
const primaryBtnStyle = { display: 'flex', alignItems: 'center', gap: 8, background: 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' };
const secondaryBtnStyle = { padding: '9px 16px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', fontWeight: 600, cursor: 'pointer' };
const errorBoxStyle = { background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', color: '#ef4444', padding: 12, borderRadius: 8, marginBottom: 16 };
function badgeStyle(fg, bg) { return { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 700, background: bg, color: fg }; }
