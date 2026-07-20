import React from 'react';

export default function GuestFeedback({
  latestCheckedOutBooking,
  feedbackSubmitted,
  feedbackOverall, setFeedbackOverall,
  feedbackCleanliness, setFeedbackCleanliness,
  feedbackService, setFeedbackService,
  feedbackValue, setFeedbackValue,
  feedbackComments, setFeedbackComments,
  feedbackRecommend, setFeedbackRecommend,
  handleSubmitFeedback,
  isSubmittingFeedback,
  setPostCheckoutTab
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Thank You Banner */}
      <div style={{ background: 'linear-gradient(135deg, rgba(56,189,248,0.12), rgba(99,102,241,0.08))', border: '1px solid rgba(56,189,248,0.25)', borderRadius: '16px', padding: '28px 32px', display: 'flex', alignItems: 'center', gap: '20px' }}>
        <span style={{ fontSize: '3rem' }}>🏨</span>
        <div>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontWeight: '800', color: '#fff', fontSize: '1.5rem' }}>
            Thank You for Staying With Us!
          </h2>
          <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Your checkout from <strong style={{ color: '#38bdf8' }}>Room {latestCheckedOutBooking?.room_number}</strong> is complete. 
            We hope you had an exceptional stay. Your feedback helps us improve!
          </p>
          {latestCheckedOutBooking?.feedback_id || feedbackSubmitted ? (
            <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', color: '#22c55e', fontWeight: '700', fontSize: '0.85rem' }}>
              <span>✅</span> Review already submitted for this stay. Thank you!
            </div>
          ) : (
            <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '8px', padding: '6px 12px', width: 'fit-content' }}>
              <span style={{ fontSize: '0.85rem', color: '#fbbf24', fontWeight: '600' }}>🎁 Leave a review and earn 50 loyalty points!</span>
            </div>
          )}
        </div>
      </div>

      {/* Stay Summary */}
      {latestCheckedOutBooking && (
        <div className="glass" style={{ borderRadius: '16px', padding: '20px 24px', border: '1px solid rgba(255,255,255,0.06)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px' }}>
          {[
            { label: 'Booking', value: latestCheckedOutBooking.booking_number, icon: '🔖' },
            { label: 'Room', value: `${latestCheckedOutBooking.room_number} (${latestCheckedOutBooking.room_type})`, icon: '🏠' },
            { label: 'Check-In', value: latestCheckedOutBooking.check_in_date, icon: '📅' },
            { label: 'Check-Out', value: latestCheckedOutBooking.check_out_date, icon: '🚪' },
            { label: 'Total Paid', value: `₹${(latestCheckedOutBooking.total_paid || 0).toLocaleString('en-IN')}`, icon: '💰', highlight: true },
            { label: 'Payment', value: latestCheckedOutBooking.payment_status, icon: latestCheckedOutBooking.payment_status === 'Paid' ? '✅' : '⚠️' },
          ].map(stat => (
            <div key={stat.label} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{stat.icon} {stat.label}</span>
              <span style={{ fontSize: '0.95rem', fontWeight: '700', color: stat.highlight ? '#38bdf8' : '#fff' }}>{stat.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Feedback Form */}
      {!latestCheckedOutBooking?.feedback_id && !feedbackSubmitted ? (
        <div className="glass" style={{ borderRadius: '16px', padding: '28px', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: '28px' }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontWeight: '800', color: '#fff', fontSize: '1.1rem' }}>
            📝 Share Your Experience
          </h3>

          {/* Star Rating Helper */}
          {(() => {
            const StarRow = ({ label, value, setValue }) => (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', minWidth: '140px' }}>{label}</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {[1,2,3,4,5].map(star => (
                    <button key={star} onClick={() => setValue(star)} style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      fontSize: '1.6rem', filter: star <= value ? 'none' : 'grayscale(1) opacity(0.3)',
                      transform: star <= value ? 'scale(1.1)' : 'scale(1)', transition: 'all 0.15s',
                    }}>⭐</button>
                  ))}
                </div>
                {value > 0 && <span style={{ fontSize: '0.78rem', color: ['','😞','😕','😐','😊','😍'][value], fontWeight: '600', minWidth: '24px' }}>
                  {['','Poor','Fair','Good','Great','Excellent!'][value]}
                </span>}
              </div>
            );
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                <StarRow label="⭐ Overall Experience *" value={feedbackOverall} setValue={setFeedbackOverall} />
                <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />
                <StarRow label="🛏️ Room Cleanliness" value={feedbackCleanliness} setValue={setFeedbackCleanliness} />
                <StarRow label="🛎️ Service Quality" value={feedbackService} setValue={setFeedbackService} />
                <StarRow label="💰 Value for Money" value={feedbackValue} setValue={setFeedbackValue} />
              </div>
            );
          })()}

          {/* Comments */}
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              💬 Tell us more (optional)
            </label>
            <textarea
              value={feedbackComments}
              onChange={e => setFeedbackComments(e.target.value)}
              placeholder="What did you love? What could we improve? Any special moments to share?"
              rows={4}
              style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', color: '#fff', padding: '12px 14px', fontSize: '0.9rem', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }}
            />
          </div>

          {/* Would Recommend Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>🤝 Would you recommend Hotel Sky-5 to a friend?</span>
            <button onClick={() => setFeedbackRecommend(!feedbackRecommend)} style={{
              background: feedbackRecommend ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.1)',
              border: `1px solid ${feedbackRecommend ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.3)'}`,
              borderRadius: '20px', padding: '6px 18px', cursor: 'pointer',
              color: feedbackRecommend ? '#22c55e' : '#ef4444',
              fontWeight: '700', fontSize: '0.85rem', transition: 'all 0.2s'
            }}>
              {feedbackRecommend ? '✅ Yes, definitely!' : '❌ Not this time'}
            </button>
          </div>

          {/* Submit Button */}
          <button
            onClick={handleSubmitFeedback}
            disabled={isSubmittingFeedback || feedbackOverall === 0}
            style={{
              background: feedbackOverall > 0 ? 'linear-gradient(135deg, #38bdf8, #6366f1)' : 'rgba(255,255,255,0.05)',
              border: 'none', borderRadius: '12px', padding: '14px 28px',
              color: '#fff', fontWeight: '800', fontSize: '1rem', cursor: feedbackOverall > 0 ? 'pointer' : 'not-allowed',
              opacity: isSubmittingFeedback ? 0.7 : 1, transition: 'all 0.2s',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
            }}
          >
            {isSubmittingFeedback ? '⏳ Submitting...' : '⭐ Submit Review & Earn 50 Points'}
          </button>
        </div>
      ) : (
        <div style={{ background: 'linear-gradient(135deg, rgba(34,197,94,0.1), rgba(16,185,129,0.05))', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '16px', padding: '40px', textAlign: 'center' }}>
          <div style={{ fontSize: '3rem', marginBottom: '12px' }}>🎉</div>
          <h3 style={{ color: '#22c55e', fontWeight: '800', margin: '0 0 8px', fontSize: '1.3rem' }}>Review Submitted!</h3>
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Thank you for your feedback. You earned <strong style={{ color: '#fbbf24' }}>50 loyalty points</strong>. We look forward to welcoming you back!</p>
          <button onClick={() => { setFeedbackOverall(0); setFeedbackCleanliness(0); setFeedbackService(0); setFeedbackValue(0); setFeedbackComments(''); setPostCheckoutTab('history'); }} style={{ marginTop: '16px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '8px 20px', color: '#fff', cursor: 'pointer', fontSize: '0.85rem' }}>
            📋 View My Stay History
          </button>
        </div>
      )}
    </div>
  );
}
