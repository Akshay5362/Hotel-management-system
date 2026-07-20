import React from 'react';

export default function GuestActiveStayOverview({
  activeBooking,
  activeReservation,
  setDashTab,
  handleRequestCheckout,
  isRequestingCheckout,
  fetchStatus
}) {
  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Live stay pulse banner */}
      <div style={{ background: 'linear-gradient(135deg, rgba(34,197,94,0.12) 0%, rgba(16,185,129,0.06) 100%)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '12px', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'pulse 2s infinite', boxShadow: '0 0 8px #22c55e' }}/>
          <span style={{ fontWeight: '700', color: '#22c55e', fontSize: '0.95rem' }}>You are currently checked in to Hotel Sky-5</span>
        </span>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
        {[
          { icon: '🏨', label: 'ROOM', value: `Room ${activeBooking.number}`, sub: activeBooking.type },
          { icon: '📋', label: 'BOOKING NO', value: activeReservation?.booking_number || '—', sub: '' },
          { icon: '📅', label: 'CHECK-IN', value: activeReservation?.check_in_date?.split('T')[0] || '—', sub: '' },
          { icon: '🚪', label: 'CHECKOUT', value: activeReservation?.expected_check_out_date?.split('T')[0] || '—', sub: '' },
          { icon: '👥', label: 'GUESTS', value: `${activeReservation?.adults || 1} Person(s)`, sub: '' },
          { icon: '💰', label: 'DEPOSIT PAID', value: `₹ ${(activeReservation?.advance_amount || 0).toLocaleString('en-IN')}`, sub: '' },
        ].map(({ icon, label, value, sub }) => (
          <div key={label} className="glass" style={{ borderRadius: '12px', padding: '18px', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '1.4rem' }}>{icon}</span>
            <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', margin: 0 }}>{label}</p>
            <p style={{ fontWeight: '800', color: '#fff', fontSize: '1rem', margin: 0 }}>{value}</p>
            {sub && <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>{sub}</p>}
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div className="glass" style={{ borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)' }}>
        <h3 style={{ color: '#fff', fontWeight: '700', marginBottom: '16px', fontSize: '1rem' }}>⚡ Quick Actions</h3>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {[
            { label: '🛎️ Request Service', tab: 'service', color: '#818cf8' },
            { label: '🍽️ Order Food', tab: 'food', color: '#fb923c' },
            { label: '🔧 Report Issue', tab: 'maintenance', color: '#facc15' },
            { label: '📄 View My Bill', tab: 'bill', color: '#22c55e' },
            { label: '📅 Extend Stay', tab: 'extend', color: '#38bdf8' },
          ].map(({ label, tab, color }) => (
            <button key={tab} onClick={() => setDashTab(tab)} style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${color}30`, borderRadius: '8px', padding: '10px 16px', color, fontWeight: '600', fontSize: '0.85rem', cursor: 'pointer', transition: 'all 0.2s' }}
              onMouseEnter={e => { e.currentTarget.style.background = `${color}20`; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Checkout Request */}
      <div className="glass" style={{ borderRadius: '12px', padding: '20px', border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.03)' }}>
        <h3 style={{ color: '#fff', fontWeight: '700', marginBottom: '8px', fontSize: '1rem' }}>🚪 Ready to Check Out?</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.84rem', marginBottom: '14px' }}>If you wish to check out, click below to notify the reception. Proceed to the front desk to settle your final bill.</p>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={handleRequestCheckout}
            disabled={isRequestingCheckout}
            style={{ background: isRequestingCheckout ? 'rgba(255,255,255,0.05)' : 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '8px', padding: '10px 20px', color: '#ef4444', fontWeight: '700', fontSize: '0.88rem', cursor: isRequestingCheckout ? 'not-allowed' : 'pointer' }}
          >
            {isRequestingCheckout ? '⏳ Sending...' : '📋 Request Checkout'}
          </button>
          <button
            onClick={() => fetchStatus()}
            title="Sync latest room status from server"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '10px 14px', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.82rem', cursor: 'pointer' }}
          >
            🔄 Refresh Status
          </button>
        </div>
        <p style={{ margin: '10px 0 0', fontSize: '0.74rem', color: 'var(--text-muted)', opacity: 0.7 }}>
          ℹ️ If reception has already processed your checkout, this screen will update automatically within 30 seconds, or click Refresh Status above.
        </p>
      </div>

    </div>
  );
}
