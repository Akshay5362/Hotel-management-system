import React, { useState, useEffect, useCallback } from 'react';
import { API_URL } from '../config/apiConfig.js';

/**
 * LedgerPanel — displays the live ledger for an occupied room.
 * Props:
 *   roomNumber  {string}  — e.g. "101"
 *   token       {string}  — auth JWT token
 *   compact     {bool}    — if true, render a condensed version (for side panels)
 */
export default function LedgerPanel({ roomNumber, token, compact = false }) {
  const [ledgerData, setLedgerData]   = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');

  const fetchLedger = useCallback(async () => {
    if (!roomNumber || !token) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/rooms/${roomNumber}/ledger`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      setLedgerData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [roomNumber, token]);

  useEffect(() => { fetchLedger(); }, [fetchLedger]);

  // ── Colour helpers ─────────────────────────────────────────────────────────
  const typeColor = (type) => {
    if (!type) return '#94a3b8';
    switch (String(type).toUpperCase()) {
      case 'PAYMENT':    return '#22c55e';
      case 'CHARGE':     return '#f97316';
      case 'ROLLOVER':   return '#818cf8';
      case 'ADJUSTMENT': return '#facc15';
      case 'REFUND':     return '#34d399';
      default:           return '#94a3b8';
    }
  };

  const typeBg = (type) => {
    if (!type) return 'rgba(148,163,184,0.1)';
    switch (String(type).toUpperCase()) {
      case 'PAYMENT':    return 'rgba(34,197,94,0.1)';
      case 'CHARGE':     return 'rgba(249,115,22,0.1)';
      case 'ROLLOVER':   return 'rgba(129,140,248,0.1)';
      case 'ADJUSTMENT': return 'rgba(250,204,21,0.1)';
      case 'REFUND':     return 'rgba(52,211,153,0.1)';
      default:           return 'rgba(148,163,184,0.1)';
    }
  };

  // ── Styles ──────────────────────────────────────────────────────────────────
  const s = {
    panel: {
      background: compact ? 'transparent' : 'rgba(15,23,42,0.95)',
      border: compact ? 'none' : '1px solid rgba(129,140,248,0.25)',
      borderRadius: compact ? 0 : '12px',
      padding: compact ? '0' : '18px',
      fontFamily: "'Inter', 'Segoe UI', sans-serif"
    },
    heading: {
      color: '#818cf8', fontWeight: 700, fontSize: compact ? '0.82rem' : '0.92rem',
      textTransform: 'uppercase', letterSpacing: '0.06em',
      display: 'flex', alignItems: 'center', gap: '6px',
      marginBottom: '12px'
    },
    summaryRow: {
      display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
      gap: '10px', marginBottom: '14px'
    },
    summaryCard: {
      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: '8px', padding: '10px 14px', textAlign: 'center'
    },
    summaryLabel: { color: '#64748b', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
    summaryValue: { color: '#e2e8f0', fontSize: '1.05rem', fontWeight: 700, marginTop: '2px' },
    outstanding: { color: '#f97316' },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: compact ? '0.77rem' : '0.82rem' },
    th: {
      color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.7rem',
      fontWeight: 700, padding: '6px 10px', textAlign: 'left',
      borderBottom: '1px solid rgba(255,255,255,0.08)'
    },
    thRight: {
      color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.7rem',
      fontWeight: 700, padding: '6px 10px', textAlign: 'right',
      borderBottom: '1px solid rgba(255,255,255,0.08)'
    },
    td: { padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.04)', color: '#cbd5e1', verticalAlign: 'middle' },
    tdRight: { padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.04)', color: '#cbd5e1', textAlign: 'right' },
    typeBadge: (type) => ({
      display: 'inline-block', padding: '2px 7px', borderRadius: '4px', fontSize: '0.68rem',
      fontWeight: 700, letterSpacing: '0.03em',
      color: typeColor(type), background: typeBg(type), border: `1px solid ${typeColor(type)}33`
    }),
    refreshBtn: {
      marginLeft: 'auto', background: 'rgba(129,140,248,0.15)', border: '1px solid rgba(129,140,248,0.3)',
      color: '#818cf8', borderRadius: '6px', padding: '4px 12px', cursor: 'pointer', fontSize: '0.75rem'
    },
    emptyMsg: { color: '#475569', textAlign: 'center', padding: '22px 0', fontSize: '0.85rem' },
    errMsg: { color: '#f87171', fontSize: '0.82rem', padding: '10px 0' }
  };

  if (loading) return (
    <div style={s.panel}>
      <div style={{ ...s.emptyMsg, color: '#818cf8' }}>⌛ Loading ledger…</div>
    </div>
  );

  if (error) return (
    <div style={s.panel}>
      <div style={s.errMsg}>⚠️ {error}</div>
      <button style={s.refreshBtn} onClick={fetchLedger}>Retry</button>
    </div>
  );

  if (!ledgerData) return null;

  const { booking, ledger, summary } = ledgerData;

  return (
    <div style={s.panel}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
        <div style={s.heading}>
          📒 Folio — {booking.booking_number}
        </div>
        <button style={s.refreshBtn} onClick={fetchLedger} title="Refresh ledger">↻ Refresh</button>
      </div>

      {/* Booking meta (compact) */}
      {!compact && (
        <div style={{ color: '#64748b', fontSize: '0.76rem', marginBottom: '10px', lineHeight: 1.6 }}>
          <strong style={{ color: '#94a3b8' }}>{booking.guest_name}</strong>
          {booking.company_name && ` · ${booking.company_name}`}
          {booking.purpose_of_visit && <span style={{ marginLeft: '8px', color: '#818cf8' }}>[{booking.purpose_of_visit}]</span>}
          <br />
          Tariff: <strong style={{ color: '#e2e8f0' }}>₹{booking.room_tariff ?? '—'}/night</strong>
          {booking.payment_mode && ` · Mode: ${booking.payment_mode}`}
        </div>
      )}

      {/* Summary cards */}
      <div style={s.summaryRow}>
        <div style={s.summaryCard}>
          <div style={s.summaryLabel}>Total Charges</div>
          <div style={s.summaryValue}>₹{(summary.totalCharges || 0).toLocaleString('en-IN')}</div>
        </div>
        <div style={s.summaryCard}>
          <div style={s.summaryLabel}>Total Payments</div>
          <div style={{ ...s.summaryValue, color: '#22c55e' }}>₹{(summary.totalPayments || 0).toLocaleString('en-IN')}</div>
        </div>
        <div style={s.summaryCard}>
          <div style={s.summaryLabel}>Outstanding</div>
          <div style={{ ...s.summaryValue, ...s.outstanding }}>₹{(summary.outstanding || 0).toLocaleString('en-IN')}</div>
        </div>
      </div>

      {/* Ledger table */}
      {ledger && ledger.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Date</th>
                <th style={s.th}>Time</th>
                <th style={s.th}>Type</th>
                <th style={s.th}>Description</th>
                <th style={s.thRight}>Charge (₹)</th>
                <th style={s.thRight}>Payment (₹)</th>
                <th style={s.thRight}>Balance (₹)</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((item, i) => (
                <tr key={item.id || i} style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                  <td style={s.td}>{item.business_date || '—'}</td>
                  <td style={s.td}>{item.time_of_entry || '—'}</td>
                  <td style={s.td}>
                    <span style={s.typeBadge(item.transaction_type)}>
                      {item.transaction_type || 'CHARGE'}
                    </span>
                  </td>
                  <td style={s.td}>
                    {item.description}
                    {item.payment_mode && (
                      <span style={{ marginLeft: '6px', color: '#64748b', fontSize: '0.72rem' }}>
                        [{item.payment_mode}]
                      </span>
                    )}
                  </td>
                  <td style={{ ...s.tdRight, color: item.amount > 0 ? '#fca5a5' : '#475569' }}>
                    {item.amount > 0 ? `₹${Number(item.amount).toLocaleString('en-IN')}` : '—'}
                  </td>
                  <td style={{ ...s.tdRight, color: item.credit_amount > 0 ? '#86efac' : '#475569' }}>
                    {item.credit_amount > 0 ? `₹${Number(item.credit_amount).toLocaleString('en-IN')}` : '—'}
                  </td>
                  <td style={{ ...s.tdRight, color: item.balance > 0 ? '#fb923c' : '#34d399', fontWeight: 700 }}>
                    ₹{Number(item.balance || 0).toLocaleString('en-IN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={s.emptyMsg}>No ledger entries yet for this booking.</div>
      )}
    </div>
  );
}
