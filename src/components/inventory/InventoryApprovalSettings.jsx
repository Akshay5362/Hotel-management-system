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
 * The screen is reachable only from a MANAGE-role area and the save endpoint is
 * administrator-only, re-checked server-side — hiding this screen grants nothing.
 *
 * Batch 5: presentation only. Same endpoint, same payload, same rules.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw, Save } from 'lucide-react';
import { inventoryFetch } from './inventoryApi';
import { Alert, Button, Card, humanError, PageHeader } from './ui';

/** Display labels for the backend's normalized role names. */
const ROLE_LABELS = {
  admin: 'Admin',
  super_admin: 'Super Admin',
  receptionist: 'Receptionist',
  kitchen: 'Kitchen (Chef, Kitchen Helper, Pantry)',
  housekeeper: 'Housekeeper (Cleaner)'
};

export default function InventoryApprovalSettings({ token, embedded = false }) {
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
      setError(humanError(err, 'Unable to load approval rules right now. Please try again.'));
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
      setNotice('Approval rules saved. They take effect immediately.');
      setConfig(c => ({ ...c, ...res.config }));
    } catch (err) {
      setError(humanError(err));
    } finally {
      setSaving(false);
    }
  };

  const dirty = config && (
    (config.enabled !== false) !== enabled ||
    JSON.stringify([...(config.allowed_roles || [])].sort()) !== JSON.stringify([...roles].sort())
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 780 }}>
      <PageHeader
        icon={ShieldCheck}
        title="Approval Rules"
        subtitle="These roles may approve or reject purchase requests, and they are the roles notified when a request is submitted. A requester is never notified about, or allowed to decide, their own request."
        actions={<Button variant="ghost" icon={RefreshCw} onClick={load} title="Refresh" aria-label="Refresh" />}
      />

      {error ? <Alert tone="error" onDismiss={() => setError('')} onRetry={config ? undefined : load}>{error}</Alert> : null}
      {notice ? <Alert tone="ok" onDismiss={() => setNotice('')}>{notice}</Alert> : null}
      {!loading && !canConfigure ? <Alert tone="info">Only an administrator can change these rules. You are viewing them read-only.</Alert> : null}

      <Card padded>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[50, 70, 60].map((w, i) => <span key={i} className="inv-skel" style={{ width: `${w}%` }} />)}
          </div>
        ) : (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, cursor: canConfigure ? 'pointer' : 'not-allowed' }}>
              <input type="checkbox" checked={enabled} disabled={!canConfigure} onChange={e => { setEnabled(e.target.checked); setNotice(''); }} />
              Approvals enabled
            </label>
            <div className="inv-hint" style={{ margin: '4px 0 18px 26px' }}>When disabled, submitted requests stay pending and no approval notification is sent.</div>

            <div className="inv-section-title">Allowed approvers</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {validRoles.map(role => {
                const on = roles.includes(role);
                return (
                  <label key={role} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 6,
                    background: on ? 'rgba(56,189,248,0.08)' : 'rgba(15,23,42,0.4)',
                    border: on ? '1px solid rgba(56,189,248,0.35)' : '1px solid var(--inv-line)',
                    cursor: canConfigure ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5, fontSize: '0.86rem'
                  }}>
                    <input type="checkbox" checked={on} disabled={!canConfigure || !enabled} onChange={() => toggleRole(role)} />
                    <span style={{ fontWeight: 600 }}>{ROLE_LABELS[role] || role}</span>
                    <span className="mono" style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.72rem', color: 'var(--inv-muted)' }}>{role}</span>
                  </label>
                );
              })}
            </div>

            {enabled && roles.length === 0 ? (
              <Alert tone="warn">At least one approver role is required while approvals are enabled, otherwise no one could ever decide a request.</Alert>
            ) : null}
            {config?.source && config.source !== 'settings' ? (
              <div className="inv-hint" style={{ marginTop: 10 }}>No saved configuration yet. The fail-safe default (administrators only) is in effect.</div>
            ) : null}

            {canConfigure ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <Button onClick={load} disabled={saving || !dirty}>Discard changes</Button>
                <Button variant="primary" icon={Save} onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save rules'}</Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
