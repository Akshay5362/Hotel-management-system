import React, { useState, useEffect, useContext, useCallback } from 'react';
import {
  X, CalendarDays, Clock, Save, Info, AlertTriangle,
  Users, Bed, CheckSquare, Sparkles, RotateCcw, RefreshCw,
  ShieldAlert, Calendar, ArrowDown, ArrowUp, Loader2, CheckCircle2,
  FlaskConical, Trash2, DatabaseZap, CheckCircle
} from 'lucide-react';
import { AdminAuthContext } from '../contexts/AdminAuthContext';

// ─── Helper: convert YYYY-MM-DD → display string ─────────────────────────────
function fmtDisplay(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

// ─── Helper: count days between two ISO date strings ─────────────────────────
function daysDiff(a, b) {
  const msA = new Date(a + 'T00:00:00Z').getTime();
  const msB = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((msB - msA) / 86400000);
}

import { API_URL as API_BASE, getApiHeaders } from '../config/apiConfig';


// ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: '4px', padding: '10px 14px',
      background: 'rgba(0,0,0,0.25)', borderRadius: '8px',
      border: `1px solid ${color}22`,
    }}>
      <Icon size={14} color={color} style={{ opacity: 0.85 }} />
      <div style={{ color, fontSize: '1.15rem', fontWeight: 700, lineHeight: 1 }}>{value}</div>
      <div style={{ color: '#8b949e', fontSize: '0.7rem', textAlign: 'center' }}>{label}</div>
    </div>
  );
}

// ─── Section Header ───────────────────────────────────────────────────────────
function SectionHeader({ icon: Icon, label, color = '#38bdf8' }) {
  return (
    <h3 style={{
      margin: '0 0 14px 0', display: 'flex', alignItems: 'center',
      gap: '8px', color, fontSize: '0.95rem', fontWeight: 600,
      textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      <Icon size={16} /> {label}
    </h3>
  );
}

// ─── Settings Gear Icon ───────────────────────────────────────────────────────
function SettingsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '8px' }}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// ─── Confirmation Dialog ──────────────────────────────────────────────────────
function ConfirmDialog({ isOpen, title, message, onConfirm, onCancel, danger = false }) {
  if (!isOpen) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 20000,
      background: 'rgba(0,0,0,0.75)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: '#0d1117', border: `1px solid ${danger ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.1)'}`,
        borderRadius: '12px', padding: '28px 32px', maxWidth: '480px', width: '90vw',
        boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <ShieldAlert size={22} color={danger ? '#ef4444' : '#f59e0b'} />
          <h3 style={{ margin: 0, color: danger ? '#ef4444' : '#f59e0b', fontSize: '1.05rem', fontWeight: 600 }}>
            {title}
          </h3>
        </div>
        <div style={{ color: '#c9d1d9', fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '24px', whiteSpace: 'pre-line' }}>
          {message}
        </div>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button
            id="bd-confirm-cancel"
            onClick={onCancel}
            style={{
              padding: '8px 20px', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '8px', background: 'transparent', color: '#8b949e',
              cursor: 'pointer', fontSize: '0.9rem', transition: 'all 0.2s',
            }}
            onMouseEnter={e => e.target.style.color = '#f0f6fc'}
            onMouseLeave={e => e.target.style.color = '#8b949e'}
          >
            Cancel
          </button>
          <button
            id="bd-confirm-proceed"
            onClick={onConfirm}
            style={{
              padding: '8px 22px', border: 'none', borderRadius: '8px',
              background: danger ? '#ef4444' : '#f59e0b',
              color: '#fff', cursor: 'pointer', fontSize: '0.9rem',
              fontWeight: 600, transition: 'all 0.2s',
            }}
            onMouseEnter={e => e.target.style.opacity = '0.85'}
            onMouseLeave={e => e.target.style.opacity = '1'}
          >
            Proceed
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── REQUIRED_PHRASE constant (must match backend) ───────────────────────────
const REQUIRED_PHRASE = 'RESET HOTEL DATA';

// ─── Main Component ───────────────────────────────────────────────────────────
export default function SettingsModal({ isOpen, onClose }) {
  const { adminToken, adminUser } = useContext(AdminAuthContext);

  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [data, setData] = useState({
    businessDate: '',
    systemDate:   '',
    lastDayEnd:   null,
    mode:         'production',
    stats: { occupiedRooms: 0, bookedRooms: 0, dirtyRooms: 0, pendingCheckouts: 0 },
  });

  const [targetDate, setTargetDate] = useState('');
  const [reason,     setReason]     = useState('');
  const [forceBack,  setForceBack]  = useState(false);
  const [error,      setError]      = useState('');
  const [success,    setSuccess]    = useState('');

  // Confirmation dialog state
  const [confirm, setConfirm] = useState({ open: false, title: '', message: '', handler: null, danger: false });

  // ── Factory Reset state ────────────────────────────────────────────────────
  const [frPhrase,   setFrPhrase]   = useState('');
  const [frLoading,  setFrLoading]  = useState(false);
  const [frError,    setFrError]    = useState('');
  const [frSummary,  setFrSummary]  = useState(null);

  // ── Permission check: only 'admin' role that is NOT staff can modify ────────
  const isSuperAdmin = adminUser?.role === 'admin' && adminUser?.type !== 'staff';
  const isDev        = data.mode === 'development';

  // ── Computed: direction of target date vs current ─────────────────────────
  const currentIso = data.businessDate;
  const diff       = targetDate && currentIso ? daysDiff(currentIso, targetDate) : null;
  const isForward  = diff !== null && diff > 0;
  const isBackward = diff !== null && diff < 0;
  const isSame     = diff === 0;

  // ── Fetch settings data ───────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!adminToken) return;
    try {
      setLoading(true);
      const res    = await fetch(`${API_BASE}/settings/business-date`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to fetch settings');

      setData({
        businessDate: result.businessDate || '',
        systemDate:   result.systemDate   || '',
        lastDayEnd:   result.lastDayEnd   || null,
        mode:         result.mode         || 'production',
        stats:        result.stats        || { occupiedRooms: 0, bookedRooms: 0, dirtyRooms: 0, pendingCheckouts: 0 },
      });
      setTargetDate(result.businessDate || '');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [adminToken]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      fetchData();
      setError('');
      setSuccess('');
      setReason('');
      setForceBack(false);
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen, fetchData]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (confirm.open) {
          setConfirm(c => ({ ...c, open: false }));
        } else if (onClose) {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, confirm.open, onClose]);

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget && onClose) {
      onClose();
    }
  };

  // ── Core API call ─────────────────────────────────────────────────────────
  const callApi = async (action, extraPayload = {}) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const body = { action, reason: reason.trim(), force: forceBack, ...extraPayload };
      if (action === 'update') body.date = targetDate;

      const res    = await fetch(`${API_BASE}/settings/business-date`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${adminToken}`,
        },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Operation failed');

      setSuccess(`✓ ${result.message}`);
      window.dispatchEvent(new Event('businessDateChanged'));
      setTimeout(() => { fetchData(); setSuccess(''); }, 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Validation before any action ──────────────────────────────────────────
  const validate = (action) => {
    setError('');
    if (!reason.trim()) {
      setError('A reason is required for all Business Date changes.');
      return false;
    }
    if (action === 'update') {
      if (!targetDate) { setError('Please select a target date.'); return false; }
      if (isSame)      { setError('The selected date is the same as the current Business Date.'); return false; }
      if (isBackward && !forceBack) {
        setError('You must enable "Force backward change" to move the Business Date backwards.');
        return false;
      }
    }
    return true;
  };

  // ── Button handlers (with confirmation dialogs) ───────────────────────────

  const handleUpdate = () => {
    if (!validate('update')) return;

    const absDiff = Math.abs(diff);
    let msg = `You are about to change the Business Date:\n\n` +
              `  From:  ${fmtDisplay(currentIso)}\n` +
              `  To:    ${fmtDisplay(targetDate)}\n` +
              `  Move:  ${isForward ? `Forward ${absDiff} day(s)` : `Backward ${absDiff} day(s)  ← CAUTION`}\n` +
              `  Reason: ${reason.trim()}\n\n`;

    const isDanger = isBackward && absDiff > 1;
    if (isDanger) {
      msg += `⚠️  Backward move of ${absDiff} days detected!\n\nPossible impact:\n` +
             `  • Night Audit / Day End records\n` +
             `  • Ledger entries\n  • Reports\n  • Reservations\n\n`;
    }
    msg += `Current hotel occupancy:\n` +
           `  • Occupied Rooms: ${data.stats.occupiedRooms}\n` +
           `  • Pending Checkouts: ${data.stats.pendingCheckouts}\n\n` +
           `This change is permanently recorded in the audit log.`;

    setConfirm({
      open: true,
      title: isBackward ? '⚠️ Backward Date Change' : 'Confirm Date Change',
      message: msg,
      danger: isDanger,
      handler: () => { setConfirm(c => ({ ...c, open: false })); callApi('update'); },
    });
  };

  const handleRollback = () => {
    if (!reason.trim()) { setError('A reason is required for rollback.'); return; }
    const prev = currentIso ? (() => {
      const [y, m, d] = currentIso.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d - 1));
      return dt.toISOString().split('T')[0];
    })() : '—';

    setConfirm({
      open: true,
      title: 'Confirm Rollback',
      message: `Roll back Business Date by one day?\n\n` +
               `  From:  ${fmtDisplay(currentIso)}\n` +
               `  To:    ${fmtDisplay(prev)}\n` +
               `  Reason: ${reason.trim()}\n\n` +
               `This action is recorded in the audit log.`,
      danger: false,
      handler: () => { setConfirm(c => ({ ...c, open: false })); callApi('rollback'); },
    });
  };

  const handleResetToToday = () => {
    if (!reason.trim()) { setError('A reason is required for reset.'); return; }
    setConfirm({
      open: true,
      title: '🧪 DEV: Reset to Today',
      message: `Set Business Date to the current OS date?\n\n` +
               `  Current BD:  ${fmtDisplay(currentIso)}\n` +
               `  OS Date:     ${fmtDisplay(new Date().toISOString().split('T')[0])}\n` +
               `  Reason:      ${reason.trim()}\n\n` +
               `⚠️  This is a DEVELOPMENT-ONLY feature. Never use in production.`,
      danger: true,
      handler: () => { setConfirm(c => ({ ...c, open: false })); callApi('reset_to_today'); },
    });
  };

  // ── Factory Reset handler ──────────────────────────────────────────────────
  const handleFactoryReset = useCallback(() => {
    console.log('[FactoryReset] Factory Reset button clicked');
    console.log('[FactoryReset] frPhrase:', JSON.stringify(frPhrase.trim()), '| REQUIRED:', JSON.stringify(REQUIRED_PHRASE));

    if (frPhrase.trim() !== REQUIRED_PHRASE) {
      console.warn('[FactoryReset] Phrase mismatch — returning early. Button should have been disabled.');
      return;
    }

    console.log('[FactoryReset] Opening confirmation dialog');

    const executeReset = async () => {
      console.log('[FactoryReset] User confirmed factory reset');
      setConfirm(c => ({ ...c, open: false }));
      setFrLoading(true);
      setFrError('');
      setFrSummary(null);
      try {
        console.log('[FactoryReset] Sending POST /api/system/factory-reset');
        const res = await fetch(`${API_BASE}/system/factory-reset`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ confirmationPhrase: frPhrase.trim() }),
        });
        const result = await res.json();
        console.log('[FactoryReset] Response status:', res.status, '| Body:', result);
        if (!res.ok) throw new Error(result.error || 'Factory reset failed');

        setFrSummary(result.summary);
        setFrPhrase('');

        // ── Auto-refresh: dispatch event so App.jsx reloads all data ──────
        window.dispatchEvent(new CustomEvent('factoryResetComplete'));
      } catch (err) {
        console.error('[FactoryReset] Error during reset:', err.message);
        setFrError(err.message);
      } finally {
        setFrLoading(false);
      }
    };

    setConfirm({
      open:    true,
      title:   '⚠️ FACTORY RESET — FINAL CONFIRMATION',
      message:
        `You are about to perform an IRREVERSIBLE factory reset.\n\n` +
        `ALL of the following will be permanently deleted:\n` +
        `  • All guest profiles and guest login accounts\n` +
        `  • All bookings and check-ins\n` +
        `  • All reservations\n` +
        `  • All payments, invoices and cash logs\n` +
        `  • All audit logs and notifications\n` +
        `  • All uploaded identity documents (files on disk)\n` +
        `  • All housekeeping and maintenance records\n\n` +
        `PRESERVED: Admin users, staff, rooms, room types, hotel settings.\n\n` +
        `This cannot be undone. Are you absolutely sure?`,
      danger:  true,
      handler: executeReset,
    });
  }, [frPhrase, adminToken]);

  if (!isOpen) return null;

  return (
    <>
      <div className="modal-overlay" onClick={handleOverlayClick}>
        <div className="modal-content" style={{ maxWidth: '700px', backgroundColor: 'var(--card-bg)' }}>

          {/* Header */}
          <div className="modal-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '15px' }}>
            <h2><SettingsIcon /> System Settings</h2>
            <button className="icon-btn" id="settings-close-btn" onClick={onClose}><X size={24} /></button>
          </div>

          <div className="modal-body" style={{ marginTop: '20px' }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: '50px', color: '#8b949e' }}>
                <Loader2 size={28} style={{ animation: 'spin 1s linear infinite', marginBottom: '10px' }} />
                <div>Loading settings…</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>

                {/* ── Section 1: Current Status ──────────────────────────────── */}
                <div style={{
                  background: 'rgba(56, 189, 248, 0.07)',
                  padding: '18px 20px', borderRadius: '10px',
                  border: '1px solid rgba(56, 189, 248, 0.18)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
                    <SectionHeader icon={CalendarDays} label="Operational Business Date" />

                    {/* Mode badge */}
                    <span style={{
                      padding: '3px 10px', borderRadius: '20px', fontSize: '0.7rem',
                      fontWeight: 700, letterSpacing: '0.08em',
                      background: isDev ? 'rgba(251,146,60,0.2)' : 'rgba(74,222,128,0.15)',
                      color: isDev ? '#fb923c' : '#4ade80',
                      border: `1px solid ${isDev ? '#fb923c44' : '#4ade8044'}`,
                    }}>
                      {isDev ? '🧪 DEV MODE' : '✅ PRODUCTION'}
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                    <div>
                      <div style={{ color: '#8b949e', fontSize: '0.78rem', marginBottom: '4px' }}>Current PMS Business Date</div>
                      <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#38bdf8', letterSpacing: '-0.01em' }}>
                        {fmtDisplay(data.businessDate)}
                      </div>
                      <div style={{ color: '#8b949e', fontSize: '0.72rem', marginTop: '2px', fontFamily: 'monospace' }}>
                        {data.businessDate}
                      </div>
                    </div>
                    <div>
                      <div style={{ color: '#8b949e', fontSize: '0.78rem', marginBottom: '4px' }}>
                        <Clock size={11} style={{ verticalAlign: 'middle', marginRight: '3px' }} />
                        Real-time System Clock
                      </div>
                      <div style={{ fontSize: '1rem', color: '#c9d1d9' }}>
                        {new Date(data.systemDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </div>
                    </div>
                  </div>

                  {/* Last Day End */}
                  <div style={{ fontSize: '0.8rem', color: '#8b949e', borderTop: '1px dashed rgba(255,255,255,0.07)', paddingTop: '10px' }}>
                    Last Night Audit: <span style={{ color: '#c9d1d9' }}>
                      {data.lastDayEnd ? new Date(data.lastDayEnd).toLocaleString('en-IN') : 'Never'}
                    </span>
                  </div>

                  {/* Room stats */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginTop: '14px' }}>
                    <StatCard icon={Users}       label="Occupied"  value={data.stats.occupiedRooms}    color="#f87171" />
                    <StatCard icon={CheckSquare} label="Checkouts" value={data.stats.pendingCheckouts}  color="#fbbf24" />
                    <StatCard icon={Bed}         label="Booked"    value={data.stats.bookedRooms}       color="#4ade80" />
                    <StatCard icon={Sparkles}    label="Dirty"     value={data.stats.dirtyRooms}        color="#818cf8" />
                  </div>
                </div>

                {/* ── Section 2: Read-only message for non-super-admin ──────── */}
                {!isSuperAdmin ? (
                  <div style={{
                    display: 'flex', gap: '12px', alignItems: 'flex-start',
                    padding: '15px', background: 'rgba(255,255,255,0.04)', borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.07)',
                  }}>
                    <Info size={18} color="#94a3b8" style={{ flexShrink: 0, marginTop: '2px' }} />
                    <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.88rem', lineHeight: 1.6 }}>
                      You have <strong>read-only</strong> access to system settings.
                      Only authorized Administrators with the <em>override_business_date</em> permission
                      can manually modify the Business Date. Standard date rollover occurs automatically
                      during the Night Audit / Day End process.
                    </p>
                  </div>
                ) : (
                  /* ── Section 3: Admin override panel ──────────────────────── */
                  <div style={{
                    background: 'rgba(245, 158, 11, 0.07)',
                    padding: '20px', borderRadius: '10px',
                    border: '1px solid rgba(245, 158, 11, 0.2)',
                  }}>
                    <SectionHeader icon={AlertTriangle} label="Business Date Management" color="#f59e0b" />

                    <p style={{ fontSize: '0.82rem', color: '#fbbf24', margin: '0 0 18px 0', lineHeight: 1.6 }}>
                      ⚠️ Manually altering the Business Date affects all revenue reporting, ledger entries, room statuses,
                      and audit trails. Every change is permanently recorded.
                    </p>

                    {/* Shared reason field */}
                    <div style={{ marginBottom: '16px' }}>
                      <label id="bd-reason-label" style={{ display: 'block', fontSize: '0.82rem', color: '#8b949e', marginBottom: '6px' }}>
                        Reason for Change <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input
                        id="bd-reason-input"
                        type="text"
                        className="input-field"
                        style={{ width: '100%' }}
                        placeholder="e.g. Correcting night audit error, testing, dev reset…"
                        value={reason}
                        onChange={e => setReason(e.target.value)}
                        disabled={saving}
                      />
                    </div>

                    {/* ── Update section ─────────────────────────────────────── */}
                    <div style={{
                      background: 'rgba(0,0,0,0.2)', borderRadius: '8px',
                      padding: '14px 16px', marginBottom: '14px',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}>
                      <div style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        Update to Specific Date
                      </div>

                      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <div style={{ flex: '1 1 200px' }}>
                          <label style={{ display: 'block', fontSize: '0.78rem', color: '#8b949e', marginBottom: '5px' }}>
                            New Business Date
                          </label>
                          <input
                            id="bd-date-picker"
                            type="date"
                            className="input-field"
                            style={{ width: '100%' }}
                            value={targetDate}
                            onChange={e => setTargetDate(e.target.value)}
                            disabled={saving}
                          />
                        </div>

                        {/* Direction indicator */}
                        {diff !== null && !isSame && (
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 12px',
                            borderRadius: '6px', fontSize: '0.8rem', fontWeight: 600,
                            background: isForward ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
                            border: `1px solid ${isForward ? '#4ade8044' : '#f8717144'}`,
                            color: isForward ? '#4ade80' : '#f87171',
                            whiteSpace: 'nowrap',
                          }}>
                            {isForward ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                            {Math.abs(diff)} day(s) {isForward ? 'forward' : 'backward'}
                          </div>
                        )}
                      </div>

                      {/* Force backward checkbox — shown when backward is selected */}
                      {isBackward && (
                        <div style={{
                          marginTop: '10px', padding: '10px 12px',
                          background: 'rgba(239,68,68,0.08)', borderRadius: '6px',
                          border: '1px solid rgba(239,68,68,0.2)',
                        }}>
                          <label id="bd-force-label" style={{
                            display: 'flex', alignItems: 'center', gap: '9px',
                            cursor: 'pointer', fontSize: '0.85rem', color: '#fca5a5',
                          }}>
                            <input
                              id="bd-force-checkbox"
                              type="checkbox"
                              checked={forceBack}
                              onChange={e => setForceBack(e.target.checked)}
                              disabled={saving}
                              style={{ width: '15px', height: '15px', accentColor: '#ef4444', cursor: 'pointer' }}
                            />
                            <span>
                              <strong>Force backward change</strong> — I understand this may affect ledger and audit records
                            </span>
                          </label>
                        </div>
                      )}

                      <div style={{ marginTop: '12px' }}>
                        <button
                          id="bd-update-btn"
                          className="btn btn-primary"
                          style={{
                            background: isBackward ? '#ef4444' : '#f59e0b',
                            color: '#fff', border: 'none',
                            display: 'flex', alignItems: 'center', gap: '7px',
                            opacity: saving ? 0.7 : 1, cursor: saving ? 'not-allowed' : 'pointer',
                          }}
                          onClick={handleUpdate}
                          disabled={saving}
                        >
                          {saving ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={15} />}
                          {saving ? 'Processing…' : 'Update Business Date'}
                        </button>
                      </div>
                    </div>

                    {/* ── Rollback section ───────────────────────────────────── */}
                    <div style={{
                      background: 'rgba(0,0,0,0.15)', borderRadius: '8px',
                      padding: '14px 16px', marginBottom: isDev ? '14px' : 0,
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}>
                      <div style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '4px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        Rollback One Day
                      </div>
                      <div style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '10px' }}>
                        Steps back the Business Date by exactly one calendar day
                        ({currentIso ? (() => {
                          const [y,m,d] = currentIso.split('-').map(Number);
                          const dt = new Date(Date.UTC(y,m-1,d-1));
                          return fmtDisplay(dt.toISOString().split('T')[0]);
                        })() : '—'}).
                      </div>
                      <button
                        id="bd-rollback-btn"
                        className="btn"
                        style={{
                          background: 'rgba(129,140,248,0.15)', color: '#818cf8',
                          border: '1px solid rgba(129,140,248,0.3)',
                          display: 'flex', alignItems: 'center', gap: '7px',
                          opacity: saving ? 0.7 : 1, cursor: saving ? 'not-allowed' : 'pointer',
                        }}
                        onClick={handleRollback}
                        disabled={saving}
                      >
                        {saving ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <RotateCcw size={15} />}
                        Rollback One Day
                      </button>
                    </div>

                    {/* ── Dev-only: Reset to today ────────────────────────────── */}
                    {isDev && (
                      <div style={{
                        background: 'rgba(251,146,60,0.07)', borderRadius: '8px',
                        padding: '14px 16px',
                        border: '1px solid rgba(251,146,60,0.2)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', color: '#fb923c', marginBottom: '4px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          <FlaskConical size={12} /> Development Only
                        </div>
                        <div style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '10px' }}>
                          Sets Business Date to the current OS date ({fmtDisplay(new Date().toISOString().split('T')[0])}).
                          This button is hidden in production.
                        </div>
                        <button
                          id="bd-reset-today-btn"
                          className="btn"
                          style={{
                            background: 'rgba(251,146,60,0.15)', color: '#fb923c',
                            border: '1px solid rgba(251,146,60,0.3)',
                            display: 'flex', alignItems: 'center', gap: '7px',
                            opacity: saving ? 0.7 : 1, cursor: saving ? 'not-allowed' : 'pointer',
                          }}
                          onClick={handleResetToToday}
                          disabled={saving}
                        >
                          {saving ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={15} />}
                          Reset to Today's System Date
                        </button>
                      </div>
                    )}

                    {/* Error / success banners */}
                    {error && (
                      <div style={{
                        marginTop: '14px', padding: '10px 14px', borderRadius: '7px',
                        background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)',
                        color: '#fca5a5', fontSize: '0.85rem', display: 'flex', gap: '8px', alignItems: 'flex-start',
                      }}>
                        <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '1px' }} /> {error}
                      </div>
                    )}
                    {success && (
                      <div style={{
                        marginTop: '14px', padding: '10px 14px', borderRadius: '7px',
                        background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.25)',
                        color: '#86efac', fontSize: '0.85rem', display: 'flex', gap: '8px', alignItems: 'center',
                      }}>
                        <CheckCircle2 size={16} /> {success}
                      </div>
                    )}
                  </div>
                )}

              {/* ── Factory Reset Danger Zone ───────────────────────────── */}
              {isSuperAdmin && (
                <div style={{
                  background: 'rgba(239,68,68,0.06)',
                  padding: '20px', borderRadius: '10px',
                  border: '1px solid rgba(239,68,68,0.35)',
                  marginTop: '4px',
                }}>

                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    marginBottom: '8px',
                  }}>
                    <Trash2 size={16} color="#ef4444" />
                    <h3 style={{
                      margin: 0, color: '#ef4444', fontSize: '0.95rem',
                      fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                    }}>Danger Zone — Factory Reset</h3>
                  </div>

                  <p style={{
                    fontSize: '0.82rem', color: '#fca5a5',
                    margin: '0 0 16px 0', lineHeight: 1.65,
                  }}>
                    Permanently deletes <strong>all guest data, bookings, payments, invoices,
                    reservations, cash logs, audit logs, and uploaded identity documents</strong>.
                    Admin accounts, room configuration and hotel settings are preserved.
                    This action <strong>cannot be undone</strong>.
                  </p>

                  {/* Confirmation phrase input */}
                  {!frSummary && (
                    <div style={{ marginBottom: '14px' }}>
                      <label style={{
                        display: 'block', fontSize: '0.8rem',
                        color: '#fca5a5', marginBottom: '6px', fontWeight: 600,
                      }}>
                        Type <code style={{
                          background: 'rgba(239,68,68,0.15)', padding: '1px 6px',
                          borderRadius: '4px', letterSpacing: '0.05em',
                        }}>{REQUIRED_PHRASE}</code> to enable reset:
                      </label>
                      <input
                        id="fr-phrase-input"
                        type="text"
                        className="input-field"
                        style={{
                          width: '100%',
                          borderColor: frPhrase.trim() === REQUIRED_PHRASE
                            ? 'rgba(239,68,68,0.7)' : 'rgba(239,68,68,0.25)',
                          background: 'rgba(239,68,68,0.06)',
                          color: '#fca5a5',
                        }}
                        placeholder="RESET HOTEL DATA"
                        value={frPhrase}
                        onChange={e => { setFrPhrase(e.target.value); setFrError(''); }}
                        disabled={frLoading}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                  )}

                  {/* Execute button */}
                  {!frSummary && (
                    <button
                      id="fr-execute-btn"
                      onClick={handleFactoryReset}
                      disabled={frPhrase.trim() !== REQUIRED_PHRASE || frLoading}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '9px 20px', border: 'none', borderRadius: '8px',
                        background: frPhrase.trim() === REQUIRED_PHRASE
                          ? '#ef4444' : 'rgba(239,68,68,0.2)',
                        color: frPhrase.trim() === REQUIRED_PHRASE ? '#fff' : '#ef444488',
                        cursor: frPhrase.trim() === REQUIRED_PHRASE && !frLoading
                          ? 'pointer' : 'not-allowed',
                        fontWeight: 600, fontSize: '0.9rem',
                        transition: 'all 0.2s',
                        opacity: frLoading ? 0.7 : 1,
                      }}
                    >
                      {frLoading
                        ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Executing Reset…</>
                        : <><DatabaseZap size={15} /> Execute Factory Reset</>
                      }
                    </button>
                  )}

                  {/* Error banner */}
                  {frError && (
                    <div style={{
                      marginTop: '12px', padding: '10px 14px', borderRadius: '7px',
                      background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
                      color: '#fca5a5', fontSize: '0.84rem',
                      display: 'flex', gap: '8px', alignItems: 'flex-start',
                    }}>
                      <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '2px' }} />
                      {frError}
                    </div>
                  )}

                  {/* Success summary */}
                  {frSummary && (
                    <div style={{
                      marginTop: '4px', padding: '16px 18px', borderRadius: '9px',
                      background: 'rgba(74,222,128,0.08)',
                      border: '1px solid rgba(74,222,128,0.3)',
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        color: '#4ade80', fontWeight: 700, fontSize: '0.9rem',
                        marginBottom: '12px',
                      }}>
                        <CheckCircle size={16} /> Factory Reset Complete in {frSummary.executionMs}ms
                      </div>
                      <table style={{
                        width: '100%', borderCollapse: 'collapse',
                        fontSize: '0.82rem', color: '#c9d1d9',
                      }}>
                        <tbody>
                          {[
                            ['Guests Deleted',        frSummary.guestsDeleted],
                            ['Guest Logins Deleted',  frSummary.guestUsersDeleted],
                            ['Reservations Deleted',  frSummary.reservationsDeleted],
                            ['Bookings Deleted',      frSummary.bookingsDeleted],
                            ['Payments Deleted',      frSummary.paymentsDeleted],
                            ['Invoices Deleted',      frSummary.invoicesDeleted],
                            ['Cash Logs Deleted',     frSummary.cashLogsDeleted],
                            ['Notifications Deleted', frSummary.notificationsDeleted],
                            ['Room Service Deleted',  frSummary.roomServiceDeleted],
                            ['Maintenance Deleted',   frSummary.maintenanceDeleted],
                            ['Audit Logs Deleted',    frSummary.auditLogsDeleted],
                            ['Rooms Reset to Vacant', frSummary.roomsReset],
                            ['Business Date Reset',   frSummary.businessDateReset],
                            ['Files Deleted',         frSummary.filesDeletedFromDisk],
                          ].map(([label, val]) => (
                            <tr key={label} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                              <td style={{ padding: '4px 0', color: '#8b949e' }}>{label}</td>
                              <td style={{
                                padding: '4px 0', textAlign: 'right', fontWeight: 600,
                                color: typeof val === 'number' && val > 0 ? '#4ade80' : '#c9d1d9',
                              }}>{val}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p style={{
                        marginTop: '12px', fontSize: '0.78rem',
                        color: '#8b949e', margin: '12px 0 0 0',
                      }}>
                        The dashboard has been refreshed automatically. All rooms are now vacant.
                      </p>
                    </div>
                  )}

                </div>
              )}
            </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirm.open}
        title={confirm.title}
        message={confirm.message}
        danger={confirm.danger}
        onConfirm={confirm.handler}
        onCancel={() => setConfirm(c => ({ ...c, open: false }))}
      />
    </>
  );
}
