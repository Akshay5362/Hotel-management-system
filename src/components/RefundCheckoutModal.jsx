import { API_BASE_URL } from '../config/apiConfig';
﻿import React, { useState, useEffect, useCallback } from 'react';

/**
 * Parses a PMS date string like "17-Jul-2026" or "2026-07-17" into a JS Date (midnight UTC).
 */
function parsePmsDate(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr + 'T00:00:00Z');
  }
  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;
  return new Date(Date.UTC(parseInt(parts[2]), months[parts[1]], parseInt(parts[0])));
}

function getStayTier(checkInDateStr, partialHours) {
  const checkIn = parsePmsDate(checkInDateStr);
  if (!checkIn) return 'no_stay';
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayMidnightUTC = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()));
  const checkInMidnight = new Date(Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate()));
  const daysDiff = Math.floor((todayMidnightUTC - checkInMidnight) / (1000 * 60 * 60 * 24));
  if (daysDiff <= 0) {
    const hoursSinceMidnight = nowIST.getUTCHours() + nowIST.getUTCMinutes() / 60;
    if (hoursSinceMidnight < (parseFloat(partialHours) || 12)) return 'no_stay';
    return 'partial';
  }
  if (daysDiff === 1) return 'partial';
  return 'full';
}

function getTierLabel(tier) {
  if (tier === 'no_stay') return 'No Stay (Same Day)';
  if (tier === 'partial') return 'Partial Stay (< 1 Night)';
  return 'Full Stay (1+ Nights)';
}
function getTierColor(tier) {
  if (tier === 'no_stay') return '#22c55e';
  if (tier === 'partial') return '#f59e0b';
  return '#ef4444';
}
function getTierIcon(tier) {
  if (tier === 'no_stay') return '🟢';
  if (tier === 'partial') return '🟡';
  return '🔴';
}

export default function RefundCheckoutModal({ isOpen, onClose, room, token, onRefundComplete, showAlert, showConfirm }) {
  const [loadingPolicy, setLoadingPolicy] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);

  const [editNoStay, setEditNoStay] = useState('100');
  const [editPartial, setEditPartial] = useState('50');
  const [editFull, setEditFull] = useState('0');
  const [editHours, setEditHours] = useState('12');

  const [reason, setReason] = useState('Guest Cancellation');
  const [overrideAmount, setOverrideAmount] = useState('');
  const [isOverriding, setIsOverriding] = useState(false);
  const [processing, setProcessing] = useState(false);

  const deposit = room?.deposit || 0;
  const checkInDate = room?.checkInDate || '';

  const tier = getStayTier(checkInDate, editHours);
  const applicablePct = (() => {
    if (tier === 'no_stay') return parseFloat(editNoStay) || 0;
    if (tier === 'partial') return parseFloat(editPartial) || 0;
    return parseFloat(editFull) || 0;
  })();
  const calculatedRefund = Math.round(deposit * applicablePct / 100);
  const finalRefund = isOverriding ? (parseFloat(overrideAmount) || 0) : calculatedRefund;
  const tierColor = getTierColor(tier);

  const loadPolicy = useCallback(async () => {
    if (!token) return;
    try {
      setLoadingPolicy(true);
      const res = await fetch(`${API_BASE_URL}/api/refund-policy`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setEditNoStay(String(data.noStayPct));
        setEditPartial(String(data.partialStayPct));
        setEditFull(String(data.fullStayPct));
        setEditHours(String(data.partialHours));
        setPolicyDirty(false);
      }
    } catch (e) { console.error('Error loading refund policy:', e); }
    finally { setLoadingPolicy(false); }
  }, [token]);

  useEffect(() => {
    if (isOpen) {
      loadPolicy();
      setOverrideAmount('');
      setIsOverriding(false);
      setReason('Guest Cancellation');
    }
  }, [isOpen, loadPolicy]);

  const handlePolicyChange = (setter) => (e) => { setter(e.target.value); setPolicyDirty(true); };

  const handleSavePolicy = async () => {
    const vals = [parseFloat(editNoStay), parseFloat(editPartial), parseFloat(editFull), parseFloat(editHours)];
    if (vals.some(isNaN)) { showAlert('All policy values must be valid numbers.', 'Validation Error'); return; }
    if (vals.slice(0,3).some(v => v < 0 || v > 100)) { showAlert('Percentages must be between 0–100.', 'Validation Error'); return; }
    try {
      setSavingPolicy(true);
      const res = await fetch(`${API_BASE_URL}/api/refund-policy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ noStayPct: vals[0], partialStayPct: vals[1], fullStayPct: vals[2], partialHours: vals[3] })
      });
      if (res.ok) { setPolicyDirty(false); showAlert('Refund policy saved successfully.', 'Policy Updated'); }
      else { const err = await res.json(); showAlert(err.error || 'Failed to save policy', 'Save Error'); }
    } catch (e) { showAlert('Network error saving policy.', 'Error'); }
    finally { setSavingPolicy(false); }
  };

  const handleProcessRefund = async () => {
    if (finalRefund < 0) { showAlert('Refund amount cannot be negative.', 'Validation Error'); return; }
    const msg = finalRefund > 0
      ? `Process cancellation refund of Rs.${finalRefund.toLocaleString('en-IN')} for ${room.guestName} in Room ${room.number}?\n\nReason: ${reason}\n\nThis will check out the guest and mark the room as dirty.`
      : `Confirm zero-refund cancellation checkout for ${room.guestName} in Room ${room.number}?\n\nReason: ${reason}`;
    const confirmed = await showConfirm(msg, 'Confirm Cancellation Refund', 'Yes, Process', 'Cancel');
    if (!confirmed) return;
    try {
      setProcessing(true);
      const res = await fetch(`${API_BASE_URL}/api/rooms/${room.number}/refund-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ refundAmount: finalRefund, reason })
      });
      if (res.ok) { onRefundComplete(room.number, finalRefund); }
      else { const err = await res.json(); showAlert(err.error || 'Refund checkout failed.', 'Refund Error'); }
    } catch (e) { showAlert('Network error during refund checkout.', 'Error'); }
    finally { setProcessing(false); }
  };

  if (!isOpen || !room) return null;

  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }}>
      <div className="modal-content glass" style={{ maxWidth: '620px', border: '1px solid rgba(245,158,11,0.25)', boxShadow: '0 20px 60px rgba(245,158,11,0.15)' }}>

        {/* Header */}
        <div className="modal-header" style={{ background: 'linear-gradient(135deg,rgba(245,158,11,0.12),rgba(239,68,68,0.08))', borderBottom: '1px solid rgba(245,158,11,0.2)' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '1.3rem' }}>💰</span> Cancel &amp; Refund — Room {room.number}
          </h3>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body" style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }}>

          {/* Guest Summary */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', padding: '14px', marginBottom: '16px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div>
              <p style={{ fontSize: '0.71rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Guest</p>
              <p style={{ fontWeight: 700, fontSize: '1rem', color: '#fff' }}>{room.guestName}</p>
            </div>
            <div>
              <p style={{ fontSize: '0.71rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Room / Type</p>
              <p style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>#{room.number} · {room.type}</p>
            </div>
            <div>
              <p style={{ fontSize: '0.71rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Check-In Date</p>
              <p style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{checkInDate || '—'}</p>
            </div>
            <div>
              <p style={{ fontSize: '0.71rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Advance Deposit</p>
              <p style={{ fontWeight: 700, color: '#22c55e', fontSize: '1.05rem' }}>Rs. {deposit.toLocaleString('en-IN')}</p>
            </div>
          </div>

          {/* Stay Tier Badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px', marginBottom: '16px', background: `rgba(${tier==='no_stay'?'34,197,94':tier==='partial'?'245,158,11':'239,68,68'},0.08)`, borderRadius: '10px', border: `1px solid ${tierColor}35` }}>
            <span style={{ fontSize: '2rem' }}>{getTierIcon(tier)}</span>
            <div style={{ flex: 1 }}>
              <p style={{ fontWeight: 700, color: tierColor, fontSize: '0.95rem', marginBottom: '3px' }}>{getTierLabel(tier)}</p>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                {tier === 'no_stay' && 'Guest checked in today and has not stayed overnight.'}
                {tier === 'partial' && 'Guest stayed but has not completed a full night.'}
                {tier === 'full' && 'Guest has stayed for one or more full nights.'}
              </p>
            </div>
            <div style={{ textAlign: 'right', minWidth: '80px' }}>
              <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Applicable</p>
              <p style={{ fontWeight: 800, fontSize: '1.5rem', color: tierColor, lineHeight: 1 }}>{applicablePct}%</p>
            </div>
          </div>

          {/* Refund Policy Settings */}
          <div style={{ marginBottom: '16px', padding: '14px 16px', background: 'rgba(255,255,255,0.02)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h4 style={{ fontSize: '0.79rem', textTransform: 'uppercase', color: '#fbbf24', letterSpacing: '0.6px', margin: 0 }}>⚙️ Admin Refund Policy</h4>
              {policyDirty && (
                <button onClick={handleSavePolicy} disabled={savingPolicy}
                  style={{ padding: '4px 12px', fontSize: '0.74rem', background: 'linear-gradient(135deg,#f59e0b,#d97706)', border: 'none', borderRadius: '6px', color: '#000', fontWeight: 700, cursor: savingPolicy ? 'not-allowed' : 'pointer', opacity: savingPolicy ? 0.6 : 1 }}>
                  {savingPolicy ? 'Saving…' : '💾 Save Policy'}
                </button>
              )}
            </div>
            {loadingPolicy ? (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading policy…</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                {[
                  { label: '🟢 No Stay Refund (%)', val: editNoStay, set: setEditNoStay, color: '#22c55e', bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.25)' },
                  { label: '🟡 Partial Stay Refund (%)', val: editPartial, set: setEditPartial, color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)' },
                  { label: '🔴 Full Stay Refund (%)', val: editFull, set: setEditFull, color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)' },
                  { label: '⏱️ Partial Threshold (hrs)', val: editHours, set: setEditHours, color: '#818cf8', bg: 'rgba(129,140,248,0.08)', border: 'rgba(129,140,248,0.25)' }
                ].map(({ label, val, set, color, bg, border }) => (
                  <div key={label}>
                    <label style={{ fontSize: '0.74rem', color: 'var(--text-muted)', display: 'block', marginBottom: '5px' }}>{label}</label>
                    <input type="number" min="0" max="100" step="1" value={val} onChange={handlePolicyChange(set)}
                      style={{ width: '100%', padding: '8px 10px', background: bg, border: `1px solid ${border}`, borderRadius: '7px', color, fontWeight: 700, fontSize: '0.9rem', boxSizing: 'border-box' }} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Refund Calculation */}
          <div style={{ marginBottom: '16px', padding: '16px', background: 'rgba(245,158,11,0.05)', borderRadius: '10px', border: '1px solid rgba(245,158,11,0.18)' }}>
            <h4 style={{ fontSize: '0.79rem', textTransform: 'uppercase', color: '#fbbf24', letterSpacing: '0.6px', marginBottom: '14px' }}>💸 Refund Calculation</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.87rem' }}>
                <span style={{ color: 'var(--text-muted)' }}>Advance Deposit</span>
                <span style={{ color: '#fff', fontWeight: 600 }}>Rs. {deposit.toLocaleString('en-IN')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.87rem' }}>
                <span style={{ color: 'var(--text-muted)' }}>Policy ({applicablePct}% of deposit)</span>
                <span style={{ color: tierColor, fontWeight: 600 }}>Rs. {calculatedRefund.toLocaleString('en-IN')}</span>
              </div>
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: '#fff', fontSize: '0.95rem' }}>{isOverriding ? 'Override Refund' : 'Final Refund'}</span>
                <span style={{ fontWeight: 800, fontSize: '1.35rem', color: finalRefund > 0 ? '#22c55e' : '#64748b' }}>Rs. {finalRefund.toLocaleString('en-IN')}</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button onClick={() => { setIsOverriding(!isOverriding); if (!isOverriding) setOverrideAmount(String(calculatedRefund)); }}
                style={{ fontSize: '0.74rem', padding: '5px 12px', background: isOverriding ? 'rgba(129,140,248,0.15)' : 'rgba(255,255,255,0.06)', border: `1px solid ${isOverriding ? 'rgba(129,140,248,0.4)' : 'rgba(255,255,255,0.1)'}`, borderRadius: '6px', color: isOverriding ? '#818cf8' : 'var(--text-muted)', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
                ✏️ {isOverriding ? 'Use Policy Amount' : 'Override Amount'}
              </button>
              {isOverriding && (
                <input type="number" min="0" placeholder="Custom refund (Rs.)" value={overrideAmount} onChange={(e) => setOverrideAmount(e.target.value)} autoFocus
                  style={{ flex: 1, padding: '7px 10px', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.35)', borderRadius: '7px', color: '#818cf8', fontWeight: 700, fontSize: '0.9rem' }} />
              )}
            </div>
          </div>

          {/* Cancellation Reason */}
          <div style={{ marginBottom: '4px' }}>
            <label style={{ fontSize: '0.76rem', textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: '7px', letterSpacing: '0.5px' }}>📋 Cancellation Reason</label>
            <select value={reason} onChange={(e) => setReason(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem' }}>
              <option value="Guest Cancellation">Guest Cancellation</option>
              <option value="Room Not Satisfactory">Room Not Satisfactory</option>
              <option value="Emergency / Medical">Emergency / Medical</option>
              <option value="Double Booking">Double Booking</option>
              <option value="Hotel Fault">Hotel Fault</option>
              <option value="Force Majeure">Force Majeure</option>
              <option value="Other">Other</option>
            </select>
          </div>

        </div>

        {/* Footer */}
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(245,158,11,0.15)' }}>
          <div style={{ fontSize: '0.77rem', color: 'var(--text-muted)' }}>
            Refund will be paid in <strong style={{ color: '#fff' }}>Cash</strong>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn-secondary" onClick={onClose} disabled={processing}>Cancel</button>
            <button onClick={handleProcessRefund} disabled={processing}
              style={{ padding: '10px 20px', background: processing ? 'rgba(239,68,68,0.4)' : 'linear-gradient(135deg,#ef4444 0%,#dc2626 100%)', border: 'none', borderRadius: '8px', color: '#fff', fontWeight: 700, fontSize: '0.88rem', cursor: processing ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
              {processing
                ? <><span style={{ width: '14px', height: '14px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} /> Processing…</>
                : <>💰 Confirm Refund {finalRefund > 0 ? `Rs.${finalRefund.toLocaleString('en-IN')}` : '(Zero Refund)'}</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
