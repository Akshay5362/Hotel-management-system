/**
 * src/components/food/FoodWaiterManager.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Restaurant Waiter Master Manager.
 *
 * Allows Admin to:
 *   1. View configured waiters.
 *   2. Add new waiters.
 *   3. Toggle active status.
 *   4. Delete waiters.
 *
 * Waiters here are lightweight named records for order assignment only —
 * they are NOT application users and have no login credentials or RBAC role.
 * Mirrors the FoodTableManager.jsx pattern.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect } from 'react';
import { Users, Plus, Edit2, Trash2, CheckCircle, XCircle, Loader, AlertCircle } from 'lucide-react';
import { API_URL, getApiHeaders } from '../../config/apiConfig';

export default function FoodWaiterManager({ token, user }) {
  const [waiters, setWaiters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Form modal
  const [showModal, setShowModal] = useState(false);
  const [editingWaiter, setEditingWaiter] = useState(null);
  const [waiterName, setWaiterName] = useState('');
  const [displayOrder, setDisplayOrder] = useState(0);
  const [saving, setSaving] = useState(false);

  const fetchWaiters = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/food/waiters`, {
        headers: getApiHeaders(token)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load waiters');
      setWaiters(data.waiters || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWaiters();
  }, []);

  const handleOpenCreate = () => {
    setEditingWaiter(null);
    setWaiterName('');
    setDisplayOrder(waiters.length + 1);
    setShowModal(true);
  };

  const handleOpenEdit = (w) => {
    setEditingWaiter(w);
    setWaiterName(w.waiter_name);
    setDisplayOrder(w.display_order || 0);
    setShowModal(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!waiterName.trim()) return;

    setSaving(true);
    setError(null);
    try {
      const payload = {
        waiter_name:   waiterName.trim(),
        display_order: Number(displayOrder)
      };

      const url = editingWaiter
        ? `${API_URL}/food/waiters/${editingWaiter.waiter_id}`
        : `${API_URL}/food/waiters`;
      const method = editingWaiter ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save waiter');

      setShowModal(false);
      fetchWaiters();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (w) => {
    try {
      const res = await fetch(`${API_URL}/food/waiters/${w.waiter_id}`, {
        method: 'PUT',
        headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ is_active: !w.is_active })
      });
      if (res.ok) fetchWaiters();
    } catch (e) {
      console.error('Toggle waiter error:', e);
    }
  };

  const handleDelete = async (waiterId) => {
    if (!window.confirm('Are you sure you want to delete this waiter?')) return;
    try {
      const res = await fetch(`${API_URL}/food/waiters/${waiterId}`, {
        method: 'DELETE',
        headers: getApiHeaders(token)
      });
      if (res.ok) fetchWaiters();
    } catch (e) {
      console.error('Delete waiter error:', e);
    }
  };

  return (
    <div style={{ padding: '4px' }}>
      {/* Top action bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: '1.1rem', fontWeight: '800', color: '#f1f5f9' }}>
            Waiter Master
          </h2>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(255,255,255,0.45)' }}>
            Configure waiters/servers for food order assignment
          </p>
        </div>

        <button
          onClick={handleOpenCreate}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 16px',
            background: 'linear-gradient(135deg, rgba(167,139,250,0.25), rgba(99,102,241,0.25))',
            border: '1px solid rgba(167,139,250,0.4)',
            borderRadius: '8px',
            color: '#a78bfa',
            fontWeight: '700',
            fontSize: '0.85rem',
            cursor: 'pointer'
          }}
        >
          <Plus size={16} /> Add Waiter
        </button>
      </div>

      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.3)',
          color: '#f87171',
          padding: '10px 14px',
          borderRadius: '8px',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '0.85rem'
        }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px', color: 'rgba(255,255,255,0.4)' }}>
          <Loader className="animate-spin" size={24} style={{ marginRight: '10px' }} /> Loading waiters...
        </div>
      ) : waiters.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '60px 20px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px dashed rgba(255,255,255,0.1)',
          borderRadius: '12px',
          color: 'rgba(255,255,255,0.4)'
        }}>
          <Users size={40} style={{ opacity: 0.3, margin: '0 auto 12px' }} />
          <h3 style={{ margin: '0 0 6px', color: 'rgba(255,255,255,0.6)' }}>No Waiters Configured</h3>
          <p style={{ margin: '0 0 16px', fontSize: '0.82rem' }}>Add waiters to assign them to food orders.</p>
          <button onClick={handleOpenCreate} style={{ padding: '8px 16px', background: 'rgba(167,139,250,0.2)', border: '1px solid #a78bfa', color: '#a78bfa', borderRadius: '6px', fontWeight: '700', cursor: 'pointer' }}>
            + Create First Waiter
          </button>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: '12px'
        }}>
          {waiters.map(w => (
            <div
              key={w.waiter_id}
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '10px',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                opacity: w.is_active ? 1 : 0.5
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '1.05rem', fontWeight: '800', color: '#f1f5f9' }}>
                  {w.waiter_name}
                </span>
                <button
                  onClick={() => handleToggleActive(w)}
                  title={w.is_active ? 'Active (Click to disable)' : 'Inactive (Click to enable)'}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: w.is_active ? '#34d399' : '#94a3b8'
                  }}
                >
                  {w.is_active ? <CheckCircle size={18} /> : <XCircle size={18} />}
                </button>
              </div>

              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <button
                  onClick={() => handleOpenEdit(w)}
                  style={{ background: 'transparent', border: 'none', color: '#38bdf8', cursor: 'pointer', padding: '4px' }}
                >
                  <Edit2 size={15} />
                </button>
                <button
                  onClick={() => handleDelete(w.waiter_id)}
                  style={{ background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', padding: '4px' }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit Modal */}
      {showModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '20px'
        }}>
          <div style={{
            background: '#0f172a', border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '14px', width: '100%', maxWidth: '420px', padding: '24px', color: '#fff'
          }}>
            <h3 style={{ margin: '0 0 16px', fontSize: '1.1rem', fontWeight: '800' }}>
              {editingWaiter ? 'Edit Waiter' : 'Add New Waiter'}
            </h3>

            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: '700', color: 'rgba(255,255,255,0.6)', marginBottom: '4px' }}>
                  WAITER NAME *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Varun"
                  value={waiterName}
                  onChange={(e) => setWaiterName(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: '#fff', boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  disabled={saving}
                  style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: '#fff', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  style={{ padding: '8px 20px', background: '#8b5cf6', border: 'none', borderRadius: '6px', color: '#fff', fontWeight: '700', cursor: 'pointer' }}
                >
                  {saving ? 'Saving...' : 'Save Waiter'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
