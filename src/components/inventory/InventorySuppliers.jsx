/**
 * InventorySuppliers.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Supplier directory — MANAGE role only (admin/super_admin), matching the
 * spec's "do not expose supplier information to unauthorized roles." The
 * backend enforces this independently (GET/POST/PUT/DELETE /inventory/suppliers
 * all require MANAGE — see backend/routes/inventoryRoutes.js).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Power, RefreshCw, Search, CheckCircle, XCircle } from 'lucide-react';
import { inventoryFetch } from './inventoryApi';

const EMPTY = { name: '', contact_person: '', phone: '', whatsapp: '', email: '', address: '', gstin: '', payment_terms: '' };

export default function InventorySuppliers({ token }) {
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
      setError(err.message);
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
      setFormError(err.message);
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
      alert(err.message);
    }
  };

  const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 6, background: '#020617', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' };
  const fieldSets = [
    ['name', 'Supplier Name *'], ['contact_person', 'Contact Person'],
    ['phone', 'Phone'], ['whatsapp', 'WhatsApp Number'],
    ['email', 'Email'], ['gstin', 'GSTIN'],
    ['payment_terms', 'Payment Terms'], ['address', 'Address']
  ];

  return (
    <div style={{ padding: 24, color: '#fff', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 800 }}>Suppliers</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search suppliers..." style={{ padding: '8px 12px 8px 32px', borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' }} />
          </div>
          <button onClick={load} style={iconBtnStyle}><RefreshCw size={16} /></button>
          <button onClick={() => { setForm(EMPTY); setFormError(''); setShowForm(true); }} style={primaryBtnStyle}><Plus size={16} /> Add Supplier</button>
        </div>
      </div>

      {error && <div style={errorBoxStyle}>{error}</div>}

      {showForm && (
        <form onSubmit={submit} className="glass" style={{ padding: 16, borderRadius: 12, marginBottom: 20, border: '1px solid rgba(255,255,255,0.08)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {fieldSets.map(([key, label]) => (
            <div key={key} style={key === 'address' ? { gridColumn: '1 / -1' } : undefined}>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 4 }}>{label}</label>
              <input value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} style={inputStyle} />
            </div>
          ))}
          {formError && <div style={{ gridColumn: '1 / -1', color: '#ef4444', fontSize: '0.85rem' }}>{formError}</div>}
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setShowForm(false)} style={secondaryBtnStyle}>Cancel</button>
            <button type="submit" disabled={submitting} style={primaryBtnStyle}>{submitting ? 'Saving...' : 'Save Supplier'}</button>
          </div>
        </form>
      )}

      <div className="glass" style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
        ) : suppliers.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No suppliers yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={{ padding: '10px 16px' }}>Name</th>
                  <th style={{ padding: '10px 16px' }}>Contact</th>
                  <th style={{ padding: '10px 16px' }}>Phone</th>
                  <th style={{ padding: '10px 16px' }}>Payment Terms</th>
                  <th style={{ padding: '10px 16px' }}>Status</th>
                  <th style={{ padding: '10px 16px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map(s => (
                  <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', opacity: s.is_active === false ? 0.55 : 1 }}>
                    <td style={{ padding: '10px 16px', fontWeight: 700 }}>{s.name}</td>
                    <td style={{ padding: '10px 16px' }}>{s.contact_person || '—'}</td>
                    <td style={{ padding: '10px 16px' }}>{s.phone || '—'}</td>
                    <td style={{ padding: '10px 16px', color: '#94a3b8' }}>{s.payment_terms || '—'}</td>
                    <td style={{ padding: '10px 16px' }}>
                      {s.is_active === false
                        ? <span style={badgeStyle('#94a3b8', 'rgba(148,163,184,0.15)')}><XCircle size={12} /> Inactive</span>
                        : <span style={badgeStyle('#10b981', 'rgba(16,185,129,0.15)')}><CheckCircle size={12} /> Active</span>}
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                      {s.is_active !== false && (
                        <button onClick={() => deactivate(s)} title="Deactivate" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}>
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
