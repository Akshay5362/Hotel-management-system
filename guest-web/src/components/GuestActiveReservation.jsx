import React from 'react';

export default function GuestActiveReservation({
  activeBooking,
  activeReservation,
  wizardStep,
  guestHistory,
  user,
  liveBill,
  paymentStatusInfo,
  isCheckingIn,
  handleSelfCheckIn
}) {
  if (!(activeBooking && activeBooking.status === 'booked' && wizardStep !== 6)) {
    return null;
  }

  return (
    <main style={{ flex: 1, padding: '2rem', maxWidth: '900px', width: '100%', margin: '0 auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {/* Status Banner */}
        <div style={{ background: 'linear-gradient(135deg, rgba(251,191,36,0.1) 0%, rgba(245,158,11,0.05) 100%)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '12px', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '1.5rem' }}>⏳</span>
          <div>
            <p style={{ fontWeight: '700', color: '#fbbf24', margin: 0, fontSize: '0.95rem' }}>Reservation Confirmed — Awaiting Check-In</p>
            <p style={{ color: 'var(--text-muted)', margin: '2px 0 0', fontSize: '0.82rem' }}>You have an upcoming reservation. When you arrive at the hotel, click "Check In Now" below.</p>
          </div>
        </div>

        {/* Booking Details Card */}
        <div className="glass" style={{ borderRadius: '16px', padding: '28px', border: '1px solid rgba(255,255,255,0.07)' }}>
          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.3rem', fontWeight: '800', color: '#fff', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            🔑 Your Reservation Details
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '28px' }}>
            {[
              { label: 'BOOKING NO', value: activeReservation?.booking_number || '—' },
              { label: 'ROOM', value: `Room ${activeBooking.number} (${activeBooking.type})` },
              { label: 'GUEST NAME', value: guestHistory?.guest?.full_name || user.fullName },
              { label: 'CHECK-IN DATE', value: activeReservation?.check_in_date?.split('T')[0] || '—' },
              { label: 'CHECK-OUT DATE', value: activeReservation?.expected_check_out_date?.split('T')[0] || '—' },
              { label: 'PAX', value: `${activeReservation?.adults || 1} Guest(s)` },
              { label: 'DEPOSIT PAID', value: `₹ ${(activeReservation?.advance_amount || 0).toLocaleString('en-IN')}` },
              { label: 'BASE RATE', value: `₹ ${(liveBill?.booking?.base_rate || 0).toLocaleString('en-IN')} / Night` },
            ].map(({ label, value }) => (
              <div key={label} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '14px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', letterSpacing: '0.8px', marginBottom: '4px', textTransform: 'uppercase' }}>{label}</p>
                <p style={{ fontWeight: '700', color: '#fff', fontSize: '0.92rem' }}>{value}</p>
              </div>
            ))}
          </div>

          {/* Check In Button / Payment Pending Lock */}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap', flexDirection: 'column', alignItems: 'center' }}>

            {/* Case A: Cash payment still pending admin confirmation */}
            {paymentStatusInfo?.cashPendingConfirmation && (
              <div style={{ width: '100%', maxWidth: '520px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '12px', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.8rem' }}>💵</span>
                  <div>
                    <p style={{ fontWeight: '800', color: '#ef4444', margin: 0, fontSize: '0.95rem' }}>Cash Payment Pending Confirmation</p>
                    <p style={{ color: 'var(--text-muted)', margin: '4px 0 0', fontSize: '0.8rem', lineHeight: '1.5' }}>
                      Please visit the hotel reception desk and pay your advance deposit of
                      <strong style={{ color: '#fff' }}> ₹{(paymentStatusInfo.amount || 0).toLocaleString('en-IN')}</strong>.
                      Once the staff confirms receipt, your <strong style={{ color: '#fbbf24' }}>Check In Now</strong> button will activate automatically.
                    </p>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '8px', padding: '10px 14px' }}>
                  <span style={{ fontSize: '0.9rem' }}>ℹ️</span>
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: 0, lineHeight: '1.4' }}>
                    This page refreshes every 20 seconds. You’ll also receive a notification once the staff confirms your payment.
                  </p>
                </div>
                <button
                  disabled
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px dashed rgba(255,255,255,0.15)',
                    borderRadius: '10px',
                    padding: '14px 36px',
                    color: 'rgba(255,255,255,0.25)',
                    fontSize: '1rem',
                    fontWeight: '700',
                    cursor: 'not-allowed',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    alignSelf: 'center'
                  }}
                >
                  🔒 Check In Locked — Awaiting Payment
                </button>
              </div>
            )}

            {/* Case B: Payment confirmed OR no payment pending → normal Check In Now */}
            {!paymentStatusInfo?.cashPendingConfirmation && (
              <button
                onClick={handleSelfCheckIn}
                disabled={isCheckingIn}
                style={{
                  background: isCheckingIn ? 'rgba(255,255,255,0.1)' : 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '14px 36px',
                  color: '#fff',
                  fontSize: '1rem',
                  fontWeight: '800',
                  cursor: isCheckingIn ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  boxShadow: '0 4px 20px rgba(34,197,94,0.3)'
                }}
              >
                {isCheckingIn ? '⏳ Checking In...' : '✅ Check In Now'}
              </button>
            )}
          </div>
          <p style={{ textAlign: 'center', fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '14px' }}>
            {paymentStatusInfo?.cashPendingConfirmation
              ? '💵 Pay your advance deposit at the reception desk. Check-in will unlock once confirmed.'
              : 'ℹ️ Clicking "Check In Now" will confirm your arrival and activate your room. Make sure you are physically at the hotel reception.'}
          </p>
        </div>
      </div>
    </main>
  );
}
