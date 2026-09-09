/**
 * InventoryApprovalSettings.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase D — administrator configuration for purchase-request approvals.
 *
 * This one setting drives BOTH things at once, from a single stored document
 * (settings/inventory_pr_approval):
 *   • who is authorized to approve or reject a purchase request, and
 *   • who receives the "pending approval" notification.
 * There is deliberately no second list to keep in sync.
 *
 * The screen is reachable only from a MANAGE-role tab and the save endpoint is
 * administrator-only, re-checked server-side — hiding this tab grants nothing.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw, Save, AlertTriangle } from 'lucide-react';
import { inventoryFetch } from './inventoryApi';

/** Display labels for the backend's normalized role names. */
const ROLE_LABELS = {
  admin: 'Admin',
  super_admin: 'Super Admin',
  receptionist: 'Receptionist',
  kitchen: 'Kitchen (Chef, Kitchen Helper, Pantry)',
  housekeeper: 'Housekeeper (Cleaner)'
};

export default function InventoryApprovalSettings({ token }) {
  const [config, setConfig] = useState(null);
  const [validRoles, setValidRoles] = useState([]);
  const [enabled, setEnabled] = useState(true);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [canConfigure, setCanConfigure] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await inventoryFetch('/inventory/purchase-requests/approval-config', { token });
      setConfig(data);
      setValidRoles(data.valid_roles || Object.keys(ROLE_LABELS));
      setEnabled(data.enabled !== false);
      setRoles(Array.isArray(data.allowed_roles) ? [...data.allowed_roles] : []);
      setCanConfigure(Boolean(data.caller_can_configure));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const toggleRole = (role) => {
    setNotice('');
    setRoles(prev => (prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]));
  };

  const save = async () => {
    setError(''); setNotice('');
    if (enabled && roles.length === 0) {
      setError('Select at least one approver role, or disable approvals.');
      return;
    }
    setSaving(true);
    try {
      const res = await inventoryFetch('/inventory/purchase-requests/approval-config', {
        token, method: 'PUT', body: { enabled, allowed_roles: roles }
      });
      setNotice('Approval configuration saved. It takes effect immediately.');
      setConfig(c => ({ ...c, ...res.config }));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = config && (
    (config.enabled !== false) !== enabled ||
    JSON.stringify([...(config.allowed_roles || [])].sort()) !== JSON.stringify([...roles].sort())
  );

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading approval settings...</div>;

  return (
    <div style={{ padding: 24, color: '#fff', maxWidth: 780, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldCheck size={20} /> Purchase Request Approval
        </h2>
        <button onClick={load} style={iconBtn}><RefreshCw size={16} /></button>
      </div>
      <p style={{ color: 'var(--text-muted, #94a3b8)', fontSize: '0.85rem', marginTop: 0, marginBottom: 20 }}>
        These roles may approve or reject purchase requests, and they are the roles notified when a
        request is submitted. A requester is never notified about — or allowed to decide — their own request.
      </p>

      {error && <div style={errorBox}><AlertTriangle size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />{error}</div>}
      {notice && <div style={okBox}>{notice}</div>}

      {!canConfigure && (
        <div style={{ ...warnBox, marginBottom: 16 }}>
          Only an administrator can change this configuration. You are viewing it read-only.
        </div>
      )}

      <div className="glass" style={{ padding: 20, borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, cursor: canConfigure ? 'pointer' : 'not-allowed' }}>
          <input type="checkbox" checked={enabled} disabled={!canConfigure}
            onChange={e => { setEnabled(e.target.checked); setNotice(''); }} />
          Approvals enabled
        </label>
        <div style={{ fontSize: '0.78rem', color: '#64748b', margin: '4px 0 20px 26px' }}>
          When disabled, submitted requests stay pending and no approval notification is sent.
        </div>

        <div style={{ fontWeight: 700, marginBottom: 10 }}>Allowed approvers</div>
        <div style={{ display: 'grid', gap: 8 }}>
          {validRoles.map(role => (
            <label key={role} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8,
              background: roles.includes(role) ? 'rgba(56,189,248,0.08)' : 'rgba(15,23,42,0.5)',
              border: roles.includes(role) ? '1px solid rgba(56,189,248,0.35)' : '1px solid rgba(255,255,255,0.08)',
              cursor: canConfigure ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5
            }}>
              <input type="checkbox" checked={roles.includes(role)} disabled={!canConfigure || !enabled}
                onChange={() => toggleRole(role)} />
              <span style={{ fontWeight: 600 }}>{ROLE_LABELS[role] || role}</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b' }}>{role}</span>
            </label>
          ))}
        </div>

        {enabled && roles.length === 0 && (
          <div style={{ ...warnBox, marginTop: 14 }}>
            At least one approver role is required while approvals are enabled — otherwise no one could
            ever decide a request.
          </div>
        )}

        {config?.source && config.source !== 'settings' && (
          <div style={{ ...warnBox, marginTop: 14 }}>
            No saved configuration yet — the fail-safe default (administrators only) is in effect.
          </div>
        )}

        {canConfigure && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
            <button onClick={load} disabled={saving || !dirty} style={secondaryBtn}>Discard changes</button>
            <button onClick={save} disabled={saving || !dirty} style={primaryBtn}>
              <Save size={15} /> {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const iconBtn = { padding: 9, borderRadius: 6, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.12)', color: '#94a3b8', cursor: 'pointer' };
const primaryBtn = { display: 'flex', alignItems: 'center', gap: 8, background: 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' };
const secondaryBtn = { padding: '9px 16px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', fontWeight: 600, cursor: 'pointer' };
const errorBox = { background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', color: '#ef4444', padding: 12, borderRadius: 8, marginBottom: 16 };
const okBox = { background: 'rgba(16,185,129,0.15)', border: '1px solid #10b981', color: '#10b981', padding: 12, borderRadius: 8, marginBottom: 16 };
const warnBox = { background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', color: '#f59e0b', padding: 10, borderRadius: 8, fontSize: '0.82rem' };
