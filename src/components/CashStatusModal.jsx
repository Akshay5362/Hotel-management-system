import React, { useState, useEffect, useCallback } from 'react';
import { API_URL, getApiHeaders } from '../config/apiConfig';


const RECEIVERS = ['Owner', 'Manager', 'Area Manager', 'Other'];

// ── Inline confirmation dialog ────────────────────────────────────────────────
function ConfirmSubmitDialog({ amount, receiver, remarks, onConfirm, onCancel, isSubmitting }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{
        background: 'linear-gradient(145deg, #0f172a, #1e293b)',
        border: '1px solid rgba(251,191,36,0.3)',
        borderRadius: '16px', padding: '32px', maxWidth: '420px', width: '90%',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)'
      }}>
        <div style={{ fontSize: '2.5rem', textAlign: 'center', marginBottom: '16px' }}>💰</div>
        <h3 style={{ color: '#fbbf24', fontWeight: '800', fontSize: '1.1rem', textAlign: 'center', margin: '0 0 20px' }}>
          Confirm Cash Submission
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
          {[
            { label: 'Amount', value: `₹ ${Number(amount).toLocaleString('en-IN')}`, color: '#22c55e', big: true },
            { label: 'Receiver', value: receiver },
            { label: 'Remarks', value: remarks || '—' },
          ].map(row => (
            <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.07)' }}>
              <span style={{ color: '#94a3b8', fontSize: '0.82rem' }}>{row.label}</span>
              <span style={{ color: row.color || '#f8fafc', fontWeight: row.big ? '800' : '600', fontSize: row.big ? '1rem' : '0.88rem', fontFamily: row.big ? 'monospace' : 'inherit' }}>{row.value}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={onCancel} disabled={isSubmitting} style={{
            flex: 1, padding: '12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.04)', color: '#94a3b8', fontWeight: '600', cursor: 'pointer', fontSize: '0.9rem'
          }}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={isSubmitting} style={{
            flex: 2, padding: '12px', borderRadius: '10px', border: 'none',
            background: isSubmitting ? 'rgba(34,197,94,0.4)' : 'linear-gradient(90deg, #16a34a, #22c55e)',
            color: '#fff', fontWeight: '800', cursor: isSubmitting ? 'not-allowed' : 'pointer', fontSize: '0.9rem',
            boxShadow: '0 4px 12px rgba(34,197,94,0.3)'
          }}>
            {isSubmitting ? '⏳ Submitting...' : '✓ Confirm & Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function CashStatusModal({ isOpen, onClose, cashLog, token, adminUser }) {
  const [submissions, setSubmissions] = useState([]);
  const [subsLoading, setSubsLoading] = useState(false);

  // Submission form state
  const [submitAmount, setSubmitAmount] = useState('');
  const [receiver, setReceiver] = useState(RECEIVERS[0]);
  const [remarks, setRemarks] = useState('');
  const [formError, setFormError] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  // ── Load today's submissions ────────────────────────────────────────────────

  const loadSubmissions = useCallback(async () => {
    if (!token) return;
    setSubsLoading(true);
    try {
      const res = await fetch(`${API_URL}/cash/submissions`, {
        headers: getApiHeaders(token)
      });
      const data = await res.json();
      setSubmissions(data.submissions || []);
    } catch (e) {
      console.error('loadSubmissions error:', e);
    } finally {
      setSubsLoading(false);
    }
  }, [token]);


  useEffect(() => {
    if (isOpen) {
      loadSubmissions();
      setSubmitAmount('');
      setRemarks('');
      setFormError('');
      setSuccessMsg('');
    }
  }, [isOpen, loadSubmissions]);

  if (!isOpen) return null;

  // ── Cash calculations ───────────────────────────────────────────────────────
  const advances = cashLog
    .filter(log => log.type === 'Advance Deposit' || log.type === 'Partial Payment' || log.type === 'Full Settlement')
    .reduce((sum, log) => sum + Number(log.amount), 0);

  const settlements = cashLog
    .filter(log => log.type === 'Checkout Settlement' || log.type === 'Settlement')
    .reduce((sum, log) => sum + Number(log.amount), 0);

  const refunds = cashLog
    .filter(log => log.type.toLowerCase().includes('refund'))
    .reduce((sum, log) => sum + Number(log.amount), 0);

  const totalRevenue = advances + settlements - refunds;

  const totalSubmitted = submissions.reduce((sum, s) => sum + Number(s.amount), 0);

  const cashInHand = totalRevenue - totalSubmitted;

  // ── Handle submission ───────────────────────────────────────────────────────
  const handleSubmitClick = () => {
    setFormError('');
    setSuccessMsg('');
    const amt = Number(submitAmount);
    if (!submitAmount || isNaN(amt) || amt <= 0) {
      setFormError('Please enter a valid amount greater than ₹0.');
      return;
    }
    if (amt > cashInHand) {
      setFormError(`Amount exceeds cash in hand (₹${cashInHand.toLocaleString('en-IN')}).`);
      return;
    }
    setShowConfirm(true);
  };

  const handleConfirmSubmit = async () => {
    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/cash/submit`, {
        method: 'POST',
        headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ amount: Number(submitAmount), receiverName: receiver, remarks })
      });

      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || 'Submission failed.');
        setShowConfirm(false);
        return;
      }
      // Success: append new submission optimistically
      setSubmissions(prev => [...prev, data.submission]);
      setSuccessMsg(`✓ ₹${Number(submitAmount).toLocaleString('en-IN')} submitted to ${receiver}. Receipt: ${data.submission.receipt_id}`);
      setSubmitAmount('');
      setRemarks('');
      setShowConfirm(false);
      setFormError('');
    } catch (e) {
      setFormError('Network error. Please try again.');
      setShowConfirm(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Summary card helper ─────────────────────────────────────────────────────
  const SummaryCard = ({ label, value, color, bg, border, prefix = '₹ ' }) => (
    <div style={{ padding: '14px 16px', background: bg, borderRadius: '10px', border }}>
      <p style={{ fontSize: '0.65rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '6px' }}>{label}</p>
      <p style={{ fontSize: '1.25rem', fontWeight: '900', color, fontFamily: 'monospace', margin: 0 }}>
        {prefix}{Number(value).toLocaleString('en-IN')}
      </p>
    </div>
  );

  // ── Merged transaction log (cash_logs + submissions) ───────────────────────
  const mergedLog = [
    ...cashLog.map(l => ({
      key: `cl-${l.id}`,
      time: l.time,
      ref: `Room ${l.room}`,
      by: l.guest,
      type: l.type,
      amount: Number(l.amount),
      receiver: '—',
      receipt: '—',
      direction: l.type.toLowerCase().includes('refund') ? 'out' : 'in',
    })),
    ...submissions.map(s => ({
      key: `cs-${s.id}`,
      time: s.time || new Date(s.submitted_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }),
      ref: s.receipt_id,
      by: s.receptionist_name,
      type: 'Cash Submission',
      amount: Number(s.amount),
      receiver: s.receiver_name,
      receipt: s.receipt_id,
      direction: 'out',
    }))
  ];

  const typeColor = (type) => {
    if (type === 'Advance Deposit') return '#38bdf8';
    if (type === 'Checkout Settlement') return '#4ade80';
    if (type.toLowerCase().includes('refund')) return '#f87171';
    if (type === 'Cash Submission') return '#fb923c';
    return '#a78bfa';
  };

  return (
    <>
      {showConfirm && (
        <ConfirmSubmitDialog
          amount={submitAmount}
          receiver={receiver}
          remarks={remarks}
          onConfirm={handleConfirmSubmit}
          onCancel={() => setShowConfirm(false)}
          isSubmitting={isSubmitting}
        />
      )}

      <div className="modal-overlay">
        <div className="modal-content" style={{ maxWidth: '740px', maxHeight: '90vh', overflowY: 'auto' }}>
          <div className="modal-header">
            <h3><span>💰</span> Front Office Cash Status</h3>
            <button className="btn-close" onClick={onClose}>&times;</button>
          </div>

          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

            {/* ── Row 1: Original 3 cards ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <SummaryCard label="Advance Deposits" value={advances}
                color="#38bdf8" bg="rgba(56,189,248,0.05)" border="1px solid rgba(56,189,248,0.15)" />
              <SummaryCard label="Settlements" value={settlements}
                color="#4ade80" bg="rgba(74,222,128,0.05)" border="1px solid rgba(74,222,128,0.15)" />
              <SummaryCard label="Total Cash Flow" value={totalRevenue}
                color="#c084fc" bg="rgba(192,132,252,0.05)" border="1px solid rgba(192,132,252,0.15)" />
            </div>

            {/* ── Row 2: New 2 cards ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <SummaryCard label="Cash Submitted Today" value={totalSubmitted}
                color="#fb923c" bg="rgba(251,146,60,0.06)" border="1px solid rgba(251,146,60,0.2)" />
              <SummaryCard label="Cash In Hand" value={cashInHand}
                color="#fbbf24" bg="rgba(251,191,36,0.06)" border="1px solid rgba(251,191,36,0.25)" />
            </div>

            {/* ── Cash Submission Panel ── */}
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '20px' }}>
              <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: '#94a3b8', letterSpacing: '0.8px', margin: '0 0 16px' }}>
                💸 Cash Submission
              </h4>

              {successMsg && (
                <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '8px', padding: '10px 14px', marginBottom: '14px', color: '#4ade80', fontSize: '0.85rem', fontWeight: '600' }}>
                  {successMsg}
                </div>
              )}
              {formError && (
                <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '10px 14px', marginBottom: '14px', color: '#f87171', fontSize: '0.85rem' }}>
                  {formError}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                {/* Cash Available (read-only) */}
                <div>
                  <label style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '6px' }}>Cash Available</label>
                  <div style={{ padding: '10px 14px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '8px', color: '#fbbf24', fontWeight: '800', fontFamily: 'monospace', fontSize: '1rem' }}>
                    ₹ {cashInHand.toLocaleString('en-IN')}
                  </div>
                </div>

                {/* Amount to Submit */}
                <div>
                  <label style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '6px' }}>Amount to Submit *</label>
                  <input
                    type="number"
                    min="1"
                    max={cashInHand}
                    value={submitAmount}
                    onChange={e => { setSubmitAmount(e.target.value); setFormError(''); setSuccessMsg(''); }}
                    placeholder={`Max ₹${cashInHand.toLocaleString('en-IN')}`}
                    style={{ width: '100%', padding: '10px 14px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                {/* Receiver */}
                <div>
                  <label style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '6px' }}>Receiver *</label>
                  <select
                    value={receiver}
                    onChange={e => setReceiver(e.target.value)}
                    style={{ width: '100%', padding: '10px 14px', background: '#1e293b', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box' }}
                  >
                    {RECEIVERS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>

                {/* Remarks */}
                <div>
                  <label style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '6px' }}>Remarks</label>
                  <input
                    type="text"
                    value={remarks}
                    onChange={e => setRemarks(e.target.value)}
                    placeholder="Optional note..."
                    style={{ width: '100%', padding: '10px 14px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              <button
                onClick={handleSubmitClick}
                disabled={cashInHand <= 0}
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px', border: 'none',
                  background: cashInHand <= 0 ? 'rgba(255,255,255,0.05)' : 'linear-gradient(90deg, #d97706, #fbbf24)',
                  color: cashInHand <= 0 ? '#64748b' : '#0f172a',
                  fontWeight: '800', fontSize: '0.9rem', cursor: cashInHand <= 0 ? 'not-allowed' : 'pointer',
                  boxShadow: cashInHand > 0 ? '0 4px 12px rgba(251,191,36,0.25)' : 'none',
                  transition: 'all 0.2s'
                }}
              >
                {cashInHand <= 0 ? 'No Cash Available to Submit' : '💸 Submit Cash'}
              </button>
            </div>

            {/* ── Transaction Log ── */}
            <div>
              <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: '#94a3b8', marginBottom: '10px', letterSpacing: '0.6px' }}>
                Transaction Log {subsLoading && <span style={{ color: '#64748b', fontSize: '0.7rem' }}>· Refreshing...</span>}
              </h4>
              <div style={{ maxHeight: '260px', overflowY: 'auto', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.77rem' }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: '#0f172a' }}>
                    <tr>
                      {['Time', 'Room / Ref', 'By / Guest', 'Type', 'Amount (₹)', 'Receiver', 'Receipt'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Amount (₹)' ? 'right' : 'left', color: '#64748b', fontWeight: '600', borderBottom: '1px solid rgba(255,255,255,0.07)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mergedLog.map((row) => (
                      <tr key={row.key} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <td style={{ padding: '8px 10px', color: '#64748b', fontFamily: 'monospace' }}>{row.time}</td>
                        <td style={{ padding: '8px 10px', color: '#cbd5e1', fontWeight: '600' }}>{row.ref}</td>
                        <td style={{ padding: '8px 10px', color: '#94a3b8' }}>{row.by}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ color: typeColor(row.type), fontWeight: '600' }}>{row.type}</span>
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace', color: row.direction === 'out' ? '#f87171' : '#4ade80', fontWeight: '700' }}>
                          {row.direction === 'out' ? '−' : '+'} {row.amount.toLocaleString('en-IN')}
                        </td>
                        <td style={{ padding: '8px 10px', color: '#94a3b8' }}>{row.receiver}</td>
                        <td style={{ padding: '8px 10px', color: '#64748b', fontFamily: 'monospace', fontSize: '0.7rem' }}>{row.receipt}</td>
                      </tr>
                    ))}
                    {mergedLog.length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', color: '#475569', padding: '28px', fontStyle: 'italic' }}>
                          No transactions recorded today.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

          </div>

          <div className="modal-footer">
            <button className="btn-primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </>
  );
}
