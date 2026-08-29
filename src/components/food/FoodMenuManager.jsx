/**
 * FoodMenuManager.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Full Admin UI for Food Menu Master management.
 *
 * Manages:
 *   - Food Categories (create / edit / soft-delete / reorder)
 *   - Food Menu Items (create / edit / activate / deactivate / search / filter)
 *   - Food Tax Configuration (view / edit)
 *
 * Phase 1 — Menu Master ONLY. No order, KDS, billing, or printing.
 *
 * Props:
 *   token   — admin JWT/Firebase token
 *   user    — admin user object
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, Edit, Power, RefreshCw, Settings,
  ChevronDown, ChevronUp, Save, X, AlertTriangle,
  CheckCircle, Layers, Percent, UtensilsCrossed
} from 'lucide-react';
import { API_URL, getApiHeaders } from '../../config/apiConfig';
import FoodCategoryBar from './FoodCategoryBar';
import FoodItemCard from './FoodItemCard';

// ── Constants ────────────────────────────────────────────────────────────────
const KOT_TYPES  = ['KITCHEN', 'PANTRY', 'BAR', 'BAKERY'];
const TAX_TYPES  = ['GST_5', 'GST_12', 'GST_18', 'EXEMPT', 'CUSTOM'];
const TAX_LABELS = {
  GST_5:   '5% GST (CGST 2.5% + SGST 2.5%)',
  GST_12:  '12% GST (CGST 6% + SGST 6%)',
  GST_18:  '18% GST (CGST 9% + SGST 9%)',
  EXEMPT:  'Tax Exempt',
  CUSTOM:  'Custom Tax Rate'
};

const FOOD_BASE = `${API_URL}/food`;

// ── Shared Styles ─────────────────────────────────────────────────────────────
const glass = {
  background: 'rgba(255,255,255,0.03)',
  border:     '1px solid rgba(255,255,255,0.08)',
  borderRadius: '12px'
};

const inputStyle = {
  width:        '100%',
  padding:      '10px 14px',
  background:   'rgba(0,0,0,0.3)',
  border:       '1px solid rgba(255,255,255,0.1)',
  borderRadius: '8px',
  color:        '#f1f5f9',
  fontSize:     '0.88rem',
  outline:      'none',
  transition:   'border-color 0.15s ease',
  fontFamily:   'var(--font-body, Inter, sans-serif)',
  boxSizing:    'border-box'
};

const labelStyle = {
  display:    'block',
  fontSize:   '0.75rem',
  fontWeight: '600',
  color:      'rgba(255,255,255,0.55)',
  marginBottom: '5px',
  letterSpacing: '0.3px',
  textTransform: 'uppercase'
};

const btnPrimary = {
  display:      'inline-flex',
  alignItems:   'center',
  gap:          '6px',
  padding:      '9px 18px',
  background:   'linear-gradient(135deg, rgba(56,189,248,0.25), rgba(99,102,241,0.25))',
  border:       '1px solid rgba(56,189,248,0.4)',
  borderRadius: '8px',
  color:        '#38bdf8',
  cursor:       'pointer',
  fontSize:     '0.84rem',
  fontWeight:   '600',
  transition:   'all 0.18s ease',
  fontFamily:   'var(--font-body, Inter, sans-serif)'
};

const btnSecondary = {
  ...btnPrimary,
  background: 'rgba(255,255,255,0.05)',
  border:     '1px solid rgba(255,255,255,0.12)',
  color:      'rgba(255,255,255,0.7)'
};

const btnDanger = {
  ...btnPrimary,
  background: 'rgba(239,68,68,0.1)',
  border:     '1px solid rgba(239,68,68,0.3)',
  color:      '#f87171'
};

// ── Toast Component ──────────────────────────────────────────────────────────

function Toast({ toast }) {
  if (!toast.show) return null;
  const colors = {
    success: { bg: 'rgba(74,222,128,0.15)', border: 'rgba(74,222,128,0.35)', color: '#4ade80' },
    error:   { bg: 'rgba(239,68,68,0.15)',  border: 'rgba(239,68,68,0.35)',  color: '#f87171' },
    info:    { bg: 'rgba(56,189,248,0.15)', border: 'rgba(56,189,248,0.35)', color: '#38bdf8' }
  };
  const c = colors[toast.type] || colors.info;
  return (
    <div style={{
      position:     'fixed',
      bottom:       '24px',
      right:        '24px',
      zIndex:       9999,
      padding:      '12px 20px',
      borderRadius: '10px',
      background:   c.bg,
      border:       `1px solid ${c.border}`,
      color:        c.color,
      fontSize:     '0.86rem',
      fontWeight:   '500',
      maxWidth:     '380px',
      boxShadow:    '0 8px 24px rgba(0,0,0,0.4)',
      display:      'flex',
      alignItems:   'center',
      gap:          '8px',
      animation:    'slideInRight 0.25s ease'
    }}>
      {toast.type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
      {toast.message}
    </div>
  );
}

// ── Category Form Modal ──────────────────────────────────────────────────────

function CategoryFormModal({ open, onClose, onSave, editData = null }) {
  const isEdit = !!editData;
  const [form, setForm] = useState({
    name:          '',
    description:   '',
    display_order: 0,
    icon_emoji:    '🍽️',
    is_active:     true
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  useEffect(() => {
    if (editData) {
      setForm({
        name:          editData.name          || '',
        description:   editData.description   || '',
        display_order: editData.display_order || 0,
        icon_emoji:    editData.icon_emoji    || '🍽️',
        is_active:     editData.is_active     !== false
      });
    } else {
      setForm({ name: '', description: '', display_order: 0, icon_emoji: '🍽️', is_active: true });
    }
    setErr('');
  }, [editData, open]);

  const handleSave = async () => {
    if (!form.name.trim()) { setErr('Category name is required.'); return; }
    setSaving(true);
    setErr('');
    try {
      await onSave(form, editData?.category_id);
      onClose();
    } catch (e) {
      setErr(e.message || 'Failed to save category.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
    }}>
      <div style={{
        ...glass,
        width: '100%', maxWidth: '480px', background: 'rgba(10,15,28,0.98)',
        padding: '28px', position: 'relative'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: '700', color: '#f1f5f9' }}>
            {isEdit ? '✏️ Edit Category' : '➕ New Category'}
          </h3>
          <button onClick={onClose} style={{ ...btnSecondary, padding: '5px 10px' }}><X size={14} /></button>
        </div>

        {err && (
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '10px 14px', color: '#f87171', fontSize: '0.83rem', marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <AlertTriangle size={14} /> {err}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: '12px', alignItems: 'end' }}>
            <div>
              <label style={labelStyle}>Icon</label>
              <input
                style={{ ...inputStyle, textAlign: 'center', fontSize: '1.4rem', padding: '6px' }}
                value={form.icon_emoji}
                onChange={e => setForm(f => ({ ...f, icon_emoji: e.target.value }))}
                maxLength={4}
              />
            </div>
            <div>
              <label style={labelStyle}>Category Name *</label>
              <input
                style={inputStyle}
                placeholder="e.g. Starters, Main Course"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                autoFocus
              />
            </div>
          </div>

          <div>
            <label style={labelStyle}>Description</label>
            <textarea
              style={{ ...inputStyle, minHeight: '70px', resize: 'vertical' }}
              placeholder="Optional short description"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={labelStyle}>Display Order</label>
              <input
                style={inputStyle}
                type="number" min="0"
                value={form.display_order}
                onChange={e => setForm(f => ({ ...f, display_order: parseInt(e.target.value) || 0 }))}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <label style={{ ...labelStyle, marginBottom: '10px' }}>Status</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.84rem', color: form.is_active ? '#4ade80' : '#f87171' }}>
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
                  style={{ width: '16px', height: '16px', accentColor: '#38bdf8' }}
                />
                {form.is_active ? '✅ Active' : '❌ Inactive'}
              </label>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '24px', justifyContent: 'flex-end' }}>
          <button style={btnSecondary} onClick={onClose}>Cancel</button>
          <button style={btnPrimary} onClick={handleSave} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving...' : 'Save Category'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Item Form Modal ──────────────────────────────────────────────────────────

function ItemFormModal({ open, onClose, onSave, editData = null, categories = [] }) {
  const isEdit = !!editData;
  const blankForm = {
    name: '', category_id: '', description: '', base_price: '', tax_rate: 5,
    tax_type: 'GST_5', is_veg: true, is_active: true, kot_type: 'KITCHEN',
    preparation_time_mins: 0, image_url: '', tags: ''
  };
  const [form, setForm]   = useState(blankForm);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  useEffect(() => {
    if (editData) {
      setForm({
        name:                 editData.name                 || '',
        category_id:          editData.category_id          || '',
        description:          editData.description          || '',
        base_price:           editData.base_price           ?? '',
        tax_rate:             editData.tax_rate             ?? 5,
        tax_type:             editData.tax_type             || 'GST_5',
        is_veg:               editData.is_veg               !== false,
        is_active:            editData.is_active            !== false,
        kot_type:             editData.kot_type             || 'KITCHEN',
        preparation_time_mins: editData.preparation_time_mins ?? 0,
        image_url:            editData.image_url            || '',
        tags:                 (editData.tags || []).join(', ')
      });
    } else {
      setForm(blankForm);
    }
    setErr('');
  }, [editData, open]);

  // Auto-set tax_rate when tax_type changes
  const handleTaxTypeChange = (tt) => {
    const defaultRates = { GST_5: 5, GST_12: 12, GST_18: 18, EXEMPT: 0, CUSTOM: 5 };
    setForm(f => ({ ...f, tax_type: tt, tax_rate: defaultRates[tt] ?? f.tax_rate }));
  };

  const handleSave = async () => {
    if (!form.name.trim())      { setErr('Item name is required.'); return; }
    if (!form.category_id)      { setErr('Please select a category.'); return; }
    if (form.base_price === '' || isNaN(parseFloat(form.base_price))) {
      setErr('Valid base price is required.'); return;
    }
    setSaving(true); setErr('');
    try {
      const tags = form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      await onSave({
        ...form,
        base_price:           parseFloat(form.base_price),
        tax_rate:             parseFloat(form.tax_rate),
        preparation_time_mins: parseInt(form.preparation_time_mins) || 0,
        tags
      }, editData?.item_id);
      onClose();
    } catch (e) {
      setErr(e.message || 'Failed to save item.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const activeCategories = categories.filter(c => c.is_active !== false);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '20px', overflowY: 'auto'
    }}>
      <div style={{
        ...glass, width: '100%', maxWidth: '560px',
        background: 'rgba(10,15,28,0.98)', padding: '28px',
        margin: 'auto', position: 'relative'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: '700', color: '#f1f5f9' }}>
            {isEdit ? '✏️ Edit Menu Item' : '➕ New Menu Item'}
          </h3>
          <button onClick={onClose} style={{ ...btnSecondary, padding: '5px 10px' }}><X size={14} /></button>
        </div>

        {err && (
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '10px 14px', color: '#f87171', fontSize: '0.83rem', marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <AlertTriangle size={14} /> {err}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Name */}
          <div>
            <label style={labelStyle}>Item Name *</label>
            <input style={inputStyle} placeholder="e.g. Dal Makhani" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
          </div>

          {/* Category */}
          <div>
            <label style={labelStyle}>Category *</label>
            <select style={{ ...inputStyle }} value={form.category_id}
              onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}>
              <option value="">— Select Category —</option>
              {activeCategories.map(c => (
                <option key={c.category_id} value={c.category_id}>{c.icon_emoji} {c.name}</option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Description</label>
            <textarea style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
              placeholder="Short description (optional)"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>

          {/* Price + Tax row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={labelStyle}>Base Price (₹) *</label>
              <input style={inputStyle} type="number" min="0" step="0.01"
                placeholder="0.00" value={form.base_price}
                onChange={e => setForm(f => ({ ...f, base_price: e.target.value }))} />
            </div>
            <div>
              <label style={labelStyle}>Tax Type</label>
              <select style={{ ...inputStyle }} value={form.tax_type}
                onChange={e => handleTaxTypeChange(e.target.value)}>
                {TAX_TYPES.map(t => <option key={t} value={t}>{TAX_LABELS[t] || t}</option>)}
              </select>
            </div>
          </div>

          {/* KOT Type + Prep Time */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={labelStyle}>KOT Type</label>
              <select style={{ ...inputStyle }} value={form.kot_type}
                onChange={e => setForm(f => ({ ...f, kot_type: e.target.value }))}>
                {KOT_TYPES.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Prep Time (mins)</label>
              <input style={inputStyle} type="number" min="0"
                value={form.preparation_time_mins}
                onChange={e => setForm(f => ({ ...f, preparation_time_mins: e.target.value }))} />
            </div>
          </div>

          {/* Tags */}
          <div>
            <label style={labelStyle}>Tags (comma-separated)</label>
            <input style={inputStyle} placeholder="e.g. popular, spicy, gluten-free"
              value={form.tags}
              onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
          </div>

          {/* Veg / Active toggles */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.84rem', color: form.is_veg ? '#4ade80' : '#f87171' }}>
              <input type="checkbox" checked={form.is_veg}
                onChange={e => setForm(f => ({ ...f, is_veg: e.target.checked }))}
                style={{ width: '16px', height: '16px', accentColor: '#4ade80' }} />
              {form.is_veg ? '🟢 Vegetarian' : '🔴 Non-Vegetarian'}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.84rem', color: form.is_active ? '#38bdf8' : '#94a3b8' }}>
              <input type="checkbox" checked={form.is_active}
                onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
                style={{ width: '16px', height: '16px', accentColor: '#38bdf8' }} />
              {form.is_active ? '✅ Active' : '❌ Inactive'}
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '24px', justifyContent: 'flex-end' }}>
          <button style={btnSecondary} onClick={onClose}>Cancel</button>
          <button style={btnPrimary} onClick={handleSave} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving...' : 'Save Item'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tax Config Panel ─────────────────────────────────────────────────────────

function TaxConfigPanel({ token, showToast }) {
  const [config, setConfig]   = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm]       = useState({ gst_5: null, gst_12: null, gst_18: null, notes: '' });
  const [saving, setSaving]   = useState(false);

  const getHeaders = () => getApiHeaders(
    token || localStorage.getItem('adminToken') || localStorage.getItem('staffToken'),
    { 'Content-Type': 'application/json' }
  );

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${FOOD_BASE}/tax-config`, { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setConfig(data.tax_config);
        setForm({
          gst_5:  data.tax_config.gst_5  || { cgst: 2.5, sgst: 2.5 },
          gst_12: data.tax_config.gst_12 || { cgst: 6.0, sgst: 6.0 },
          gst_18: data.tax_config.gst_18 || { cgst: 9.0, sgst: 9.0 },
          notes:  data.tax_config.notes  || ''
        });
      }
    } catch (e) { console.error('[TaxConfig] fetch error:', e); }
  }, [token]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${FOOD_BASE}/tax-config`, {
        method: 'PUT', headers: getHeaders(), body: JSON.stringify(form)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update tax config');
      setConfig(data.tax_config);
      setEditing(false);
      showToast('Tax configuration updated successfully', 'success');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const rateRow = (label, key) => (
    <div key={key} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 1fr', gap: '12px', alignItems: 'center' }}>
      <span style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.7)', fontWeight: '600' }}>{label}</span>
      <div>
        <label style={{ ...labelStyle, marginBottom: '4px' }}>CGST (%)</label>
        <input style={{ ...inputStyle, padding: '7px 10px' }} type="number" min="0" max="50" step="0.01"
          value={form[key]?.cgst ?? ''} disabled={!editing}
          onChange={e => setForm(f => ({ ...f, [key]: { ...f[key], cgst: parseFloat(e.target.value) || 0 } }))} />
      </div>
      <div>
        <label style={{ ...labelStyle, marginBottom: '4px' }}>SGST (%)</label>
        <input style={{ ...inputStyle, padding: '7px 10px' }} type="number" min="0" max="50" step="0.01"
          value={form[key]?.sgst ?? ''} disabled={!editing}
          onChange={e => setForm(f => ({ ...f, [key]: { ...f[key], sgst: parseFloat(e.target.value) || 0 } }))} />
      </div>
    </div>
  );

  return (
    <div style={{ ...glass, padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: '700', color: '#f1f5f9', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Percent size={16} style={{ color: '#38bdf8' }} /> Food Tax Configuration
        </h3>
        {!editing
          ? <button style={btnSecondary} onClick={() => setEditing(true)}><Edit size={13} /> Edit</button>
          : <div style={{ display: 'flex', gap: '8px' }}>
              <button style={btnSecondary} onClick={() => { setEditing(false); fetchConfig(); }}>Cancel</button>
              <button style={btnPrimary} onClick={handleSave} disabled={saving}><Save size={13} /> {saving ? 'Saving...' : 'Save'}</button>
            </div>
        }
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {rateRow('GST 5%',  'gst_5')}
        {rateRow('GST 12%', 'gst_12')}
        {rateRow('GST 18%', 'gst_18')}
      </div>

      {editing && (
        <div>
          <label style={labelStyle}>Notes</label>
          <input style={inputStyle} placeholder="Optional notes about tax revision"
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
        </div>
      )}

      {config?.updated_at && (
        <p style={{ margin: 0, fontSize: '0.7rem', color: 'rgba(255,255,255,0.25)' }}>
          Last updated: {new Date(config.updated_at).toLocaleString('en-IN')}
        </p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function FoodMenuManager({ token, user }) {

  const getHeaders = useCallback((extraHeaders = {}) =>
    getApiHeaders(
      token || localStorage.getItem('adminToken') || localStorage.getItem('staffToken'),
      { 'Content-Type': 'application/json', ...extraHeaders }
    ),
  [token]);

  // ── State ─────────────────────────────────────────────────────────────────
  const [activeView, setActiveView] = useState('items'); // 'items' | 'categories' | 'tax'
  const [categories,   setCategories]   = useState([]);
  const [items,        setItems]        = useState([]);
  const [loading,      setLoading]      = useState({ categories: true, items: true });
  const [toast,        setToast]        = useState({ show: false, message: '', type: 'info' });
  const [searchTerm,   setSearchTerm]   = useState('');
  const [selCategory,  setSelCategory]  = useState(null);
  const [showInactive, setShowInactive] = useState(false);
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editCat,  setEditCat]  = useState(null);
  const [editItem, setEditItem] = useState(null);

  // ── Toast helper ──────────────────────────────────────────────────────────
  const showToast = useCallback((message, type = 'success') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: '', type: 'info' }), 4000);
  }, []);

  // ── Fetch Categories ──────────────────────────────────────────────────────
  const fetchCategories = useCallback(async () => {
    setLoading(l => ({ ...l, categories: true }));
    try {
      const res = await fetch(`${FOOD_BASE}/categories`, { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setCategories(data.categories || []);
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to load categories', 'error');
      }
    } catch (e) {
      showToast('Network error loading categories', 'error');
    } finally {
      setLoading(l => ({ ...l, categories: false }));
    }
  }, [getHeaders, showToast]);

  // ── Fetch Items ────────────────────────────────────────────────────────────
  const fetchItems = useCallback(async () => {
    setLoading(l => ({ ...l, items: true }));
    try {
      const params = new URLSearchParams();
      if (selCategory)   params.set('category_id', selCategory);
      if (!showInactive) params.set('active_only', 'true');
      const res = await fetch(`${FOOD_BASE}/menu-items?${params}`, { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to load menu items', 'error');
      }
    } catch (e) {
      showToast('Network error loading menu items', 'error');
    } finally {
      setLoading(l => ({ ...l, items: false }));
    }
  }, [getHeaders, showToast, selCategory, showInactive]);

  // ── Search Items ───────────────────────────────────────────────────────────
  const fetchSearchResults = useCallback(async (q) => {
    setLoading(l => ({ ...l, items: true }));
    try {
      const res = await fetch(`${FOOD_BASE}/menu-items/search?q=${encodeURIComponent(q)}&active_only=${!showInactive}`, { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
      }
    } catch (e) {
      console.error('[FoodMenuManager] search error:', e);
    } finally {
      setLoading(l => ({ ...l, items: false }));
    }
  }, [getHeaders, showInactive]);

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  // ── Unified item-fetch effect ─────────────────────────────────────────────
  // Single effect handles all three triggers: searchTerm, selCategory, showInactive.
  // Uses debounce only for active search typing; fetches immediately on filter change.
  useEffect(() => {
    const term = searchTerm.trim();

    if (term.length >= 2) {
      // Debounce search queries while user is typing
      const timer = setTimeout(() => fetchSearchResults(term), 350);
      return () => clearTimeout(timer);
    }

    // No search active — (re)fetch items respecting current category + showInactive
    fetchItems();
  }, [searchTerm, selCategory, showInactive, fetchItems, fetchSearchResults]);


  // ── Category CRUD ─────────────────────────────────────────────────────────
  const handleSaveCategory = async (formData, editId) => {
    const url    = editId ? `${FOOD_BASE}/categories/${editId}` : `${FOOD_BASE}/categories`;
    const method = editId ? 'PUT' : 'POST';
    const res    = await fetch(url, { method, headers: getHeaders(), body: JSON.stringify(formData) });
    const data   = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save category');
    showToast(data.message || 'Category saved', 'success');
    fetchCategories();
    if (editId === selCategory) setSelCategory(null);
  };

  const handleDeleteCategory = async (cat) => {
    if (!window.confirm(`Delete category "${cat.name}"? If it has active items, it will be deactivated instead.`)) return;
    const res  = await fetch(`${FOOD_BASE}/categories/${cat.category_id}`, { method: 'DELETE', headers: getHeaders() });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to delete category', 'error'); return; }
    showToast(data.message, data.action === 'DELETED' ? 'success' : 'info');
    fetchCategories();
    fetchItems();
  };

  // ── Item CRUD ─────────────────────────────────────────────────────────────
  const handleSaveItem = async (formData, editId) => {
    const url    = editId ? `${FOOD_BASE}/menu-items/${editId}` : `${FOOD_BASE}/menu-items`;
    const method = editId ? 'PUT' : 'POST';
    const res    = await fetch(url, { method, headers: getHeaders(), body: JSON.stringify(formData) });
    const data   = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save item');
    showToast(data.message || 'Item saved', 'success');
    fetchItems();
  };

  const handleToggleItem = async (item) => {
    const url    = `${FOOD_BASE}/menu-items/${item.item_id}`;
    const newVal = !item.is_active;
    const res    = await fetch(url, { method: 'PUT', headers: getHeaders(), body: JSON.stringify({ is_active: newVal }) });
    const data   = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to update item', 'error'); return; }
    showToast(`"${item.name}" ${newVal ? 'activated' : 'deactivated'}`, 'success');
    fetchItems();
  };

  const handleDeleteItem = async (item) => {
    if (!window.confirm(`Deactivate "${item.name}"? The item will be hidden but not deleted.`)) return;
    const res  = await fetch(`${FOOD_BASE}/menu-items/${item.item_id}`, { method: 'DELETE', headers: getHeaders() });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to deactivate item', 'error'); return; }
    showToast(data.message, 'info');
    fetchItems();
  };

  // ── Filtered Items ─────────────────────────────────────────────────────────
  const displayItems = items;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', fontFamily: 'var(--font-body, Inter, sans-serif)' }}>

      {/* Header Bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: '800', color: '#f1f5f9', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <UtensilsCrossed size={20} style={{ color: '#38bdf8' }} /> Menu Master
          </h2>
          <p style={{ margin: '2px 0 0 0', fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)' }}>
            Manage food categories, items, and tax configuration
          </p>
        </div>

        {/* View Switcher */}
        <div style={{ display: 'flex', gap: '6px', background: 'rgba(0,0,0,0.2)', padding: '4px', borderRadius: '8px' }}>
          {[
            { key: 'items',      label: 'Menu Items' },
            { key: 'categories', label: 'Categories' },
            { key: 'tax',        label: 'Tax Config'  }
          ].map(v => (
            <button key={v.key}
              style={{
                padding:      '6px 14px',
                borderRadius: '6px',
                border:       'none',
                cursor:       'pointer',
                fontSize:     '0.8rem',
                fontWeight:   '600',
                transition:   'all 0.15s ease',
                background:   activeView === v.key ? 'rgba(56,189,248,0.2)' : 'transparent',
                color:        activeView === v.key ? '#38bdf8' : 'rgba(255,255,255,0.5)',
                borderBottom: activeView === v.key ? '2px solid #38bdf8' : '2px solid transparent'
              }}
              onClick={() => setActiveView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── ITEMS VIEW ── */}
      {activeView === 'items' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: 1, minHeight: 0 }}>

          {/* Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {/* Search */}
            <div style={{ position: 'relative', flex: '1', minWidth: '200px' }}>
              <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.35)' }} />
              <input
                style={{ ...inputStyle, paddingLeft: '34px' }}
                placeholder="Search items by name, description, or tag…"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)', cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} style={{ accentColor: '#38bdf8' }} />
              Show Inactive
            </label>
            <button style={btnSecondary} onClick={fetchItems} title="Refresh"><RefreshCw size={14} /></button>
            <button style={btnPrimary} onClick={() => { setEditItem(null); setItemModalOpen(true); }}>
              <Plus size={14} /> Add Item
            </button>
          </div>

          {/* Category Pills */}
          <FoodCategoryBar
            categories={categories}
            selectedId={selCategory}
            onSelect={setSelCategory}
            loading={loading.categories}
          />

          {/* Items Grid */}
          {loading.items ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' }}>
              {[1,2,3,4,5,6].map(i => (
                <div key={i} style={{ ...glass, height: '160px', background: 'rgba(255,255,255,0.02)', animation: 'pulse 1.5s ease infinite' }} />
              ))}
            </div>
          ) : displayItems.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', color: 'rgba(255,255,255,0.25)', gap: '12px' }}>
              <UtensilsCrossed size={40} style={{ opacity: 0.3 }} />
              <p style={{ margin: 0, fontSize: '0.9rem' }}>
                {searchTerm ? 'No items match your search.' : 'No menu items found. Click "Add Item" to get started.'}
              </p>
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '12px',
              overflowY: 'auto',
              paddingBottom: '8px',
              paddingRight: '4px'
            }}>
              {displayItems.map(item => (
                <FoodItemCard
                  key={item.item_id}
                  item={item}
                  mode="manage"
                  onEdit={it => { setEditItem(it); setItemModalOpen(true); }}
                  onToggleActive={handleToggleItem}
                />
              ))}
            </div>
          )}

          {/* Item count */}
          <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.25)', paddingTop: '4px' }}>
            {displayItems.length} item{displayItems.length !== 1 ? 's' : ''} {selCategory ? 'in selected category' : 'total'}
            {searchTerm && ` matching "${searchTerm}"`}
          </div>
        </div>
      )}

      {/* ── CATEGORIES VIEW ── */}
      {activeView === 'categories' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button style={btnSecondary} onClick={fetchCategories}><RefreshCw size={13} /> Refresh</button>
            <button style={btnPrimary} onClick={() => { setEditCat(null); setCatModalOpen(true); }}>
              <Plus size={14} /> Add Category
            </button>
          </div>

          {loading.categories ? (
            <div style={{ color: 'rgba(255,255,255,0.4)', padding: '20px', textAlign: 'center' }}>Loading categories…</div>
          ) : categories.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(255,255,255,0.25)' }}>
              <Layers size={36} style={{ opacity: 0.3, marginBottom: '12px' }} />
              <p>No categories yet. Create one to get started.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {categories.map(cat => (
                <div key={cat.category_id} style={{
                  ...glass,
                  padding: '14px 18px',
                  display: 'flex', alignItems: 'center', gap: '14px',
                  opacity: cat.is_active === false ? 0.55 : 1
                }}>
                  <span style={{ fontSize: '1.6rem', flexShrink: 0 }}>{cat.icon_emoji || '🍴'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: '700', fontSize: '0.9rem', color: '#f1f5f9' }}>{cat.name}</span>
                      {cat.is_active === false && (
                        <span style={{ fontSize: '0.65rem', padding: '1px 6px', borderRadius: '4px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}>INACTIVE</span>
                      )}
                      <span style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)' }}>Order #{cat.display_order}</span>
                    </div>
                    {cat.description && <p style={{ margin: '2px 0 0', fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>{cat.description}</p>}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button style={btnSecondary} onClick={() => { setEditCat(cat); setCatModalOpen(true); }}>
                      <Edit size={12} /> Edit
                    </button>
                    <button style={btnDanger} onClick={() => handleDeleteCategory(cat)}>
                      <X size={12} /> {cat.is_active !== false ? 'Deactivate' : 'Delete'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAX CONFIG VIEW ── */}
      {activeView === 'tax' && (
        <TaxConfigPanel token={token} showToast={showToast} />
      )}

      {/* Modals */}
      <CategoryFormModal
        open={catModalOpen}
        onClose={() => { setCatModalOpen(false); setEditCat(null); }}
        onSave={handleSaveCategory}
        editData={editCat}
      />
      <ItemFormModal
        open={itemModalOpen}
        onClose={() => { setItemModalOpen(false); setEditItem(null); }}
        onSave={handleSaveItem}
        editData={editItem}
        categories={categories}
      />

      {/* Toast */}
      <Toast toast={toast} />

      {/* Pulse animation (only needed here if not in global CSS) */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes slideInRight {
          from { transform: translateX(30px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
