import React from 'react';

export default function GuestBookingHistory({
  historyLoading,
  guestHistory,
  setFeedbackBookingId,
  setFeedbackSubmitted,
  setPostCheckoutTab
}) {
  return (
    <>
      {historyLoading ? (
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>⏳ Loading your stay history...</div>
      ) : guestHistory?.bookings?.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>📋</div>
          No stay history found yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {guestHistory?.bookings?.map(booking => (
            <div key={booking.id} className="glass" style={{ borderRadius: '14px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Booking Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.2rem' }}>{booking.room_type === 'PREMIUM' ? '👑' : booking.room_type === 'EXECUTIVE' ? '💼' : '🛏️'}</span>
                  <div>
                    <div style={{ fontWeight: '700', color: '#fff', fontSize: '0.95rem' }}>Room {booking.room_number} — {booking.room_title}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{booking.booking_number}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '0.7rem', fontWeight: '700',
                    background: booking.booking_status === 'Checked Out' ? 'rgba(148,163,184,0.15)' : booking.booking_status === 'Checked In' ? 'rgba(34,197,94,0.15)' : 'rgba(251,191,36,0.15)',
                    color: booking.booking_status === 'Checked Out' ? '#94a3b8' : booking.booking_status === 'Checked In' ? '#22c55e' : '#fbbf24',
                    textTransform: 'uppercase' }}>
                    {booking.booking_status}
                  </span>
                  <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '0.7rem', fontWeight: '700',
                    background: booking.payment_status === 'Paid' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.1)',
                    color: booking.payment_status === 'Paid' ? '#22c55e' : '#ef4444',
                    textTransform: 'uppercase' }}>
                    {booking.payment_status}
                  </span>
                </div>
              </div>

              {/* Booking Details Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                {[
                  { label: 'Check-In', value: booking.check_in_date },
                  { label: 'Check-Out', value: booking.check_out_date || '—' },
                  { label: 'Total Billed', value: `₹${(booking.total_amount || 0).toLocaleString('en-IN')}` },
                  { label: 'Total Paid', value: `₹${(booking.total_paid || 0).toLocaleString('en-IN')}`, highlight: true },
                ].map(s => (
                  <div key={s.label}>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '2px' }}>{s.label}</div>
                    <div style={{ fontWeight: '700', color: s.highlight ? '#38bdf8' : '#fff', fontSize: '0.9rem' }}>{s.value}</div>
                  </div>
                ))}
              </div>

              {/* Feedback Status */}
              {booking.booking_status === 'Checked Out' && (
                <div style={{ paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  {booking.feedback_id ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '0.8rem', color: '#22c55e' }}>✅ Review submitted</span>
                      <span style={{ display: 'flex', gap: '2px' }}>
                        {[1,2,3,4,5].map(s => (
                          <span key={s} style={{ fontSize: '0.75rem', filter: s <= booking.overall_rating ? 'none' : 'grayscale(1) opacity(0.3)' }}>⭐</span>
                        ))}
                      </span>
                    </div>
                  ) : (
                    <button onClick={() => { setFeedbackBookingId(booking.id); setFeedbackSubmitted(false); setPostCheckoutTab('feedback'); }} style={{
                      background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.25)', borderRadius: '8px',
                      padding: '6px 14px', color: '#38bdf8', cursor: 'pointer', fontSize: '0.8rem', fontWeight: '600'
                    }}>
                      ⭐ Leave a Review
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
