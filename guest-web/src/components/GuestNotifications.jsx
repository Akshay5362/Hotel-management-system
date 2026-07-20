import React from 'react';

export default function GuestNotifications({
  notifications,
  notifLoading,
  loadNotifications,
  handleMarkRead,
  activeBooking,
  setWizardStep,
  setDashTab,
  setReuploadFile,
  setReuploadError,
  setReuploadSuccess,
  setShowIdReupload
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}>🔔 Notification Center</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Messages and updates from Hotel Sky-5.</p>
        </div>
        <button onClick={loadNotifications} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 14px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.82rem' }}>
          🔄 Refresh
        </button>
      </div>

      {notifLoading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading notifications...</div>
      ) : notifications.length === 0 ? (
        <div className="glass" style={{ borderRadius: '12px', padding: '40px', textAlign: 'center', border: '1px solid rgba(255,255,255,0.06)' }}>
          <p style={{ fontSize: '2rem', marginBottom: '10px' }}>🔕</p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No notifications yet. We'll keep you updated here.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {notifications.map(notif => {
            const isIdRejected = notif.type === 'id_rejected';
            const isIdVerified = notif.type === 'id_verified';
            return (
              <div
                key={notif.id}
                onClick={() => !notif.is_read && handleMarkRead(notif.id)}
                style={{
                  background: isIdRejected
                    ? 'rgba(239,68,68,0.07)'
                    : isIdVerified
                    ? 'rgba(34,197,94,0.07)'
                    : notif.is_read ? 'rgba(255,255,255,0.02)' : 'rgba(56,189,248,0.05)',
                  border: isIdRejected
                    ? '1px solid rgba(239,68,68,0.35)'
                    : isIdVerified
                    ? '1px solid rgba(34,197,94,0.35)'
                    : notif.is_read ? '1px solid rgba(255,255,255,0.05)' : '1px solid rgba(56,189,248,0.2)',
                  borderRadius: '10px', padding: '16px',
                  cursor: notif.is_read && !isIdRejected ? 'default' : 'pointer',
                  display: 'flex', gap: '14px', alignItems: 'flex-start', transition: 'all 0.2s'
                }}
              >
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: notif.is_read ? 'transparent' : (isIdRejected ? '#ef4444' : isIdVerified ? '#22c55e' : '#38bdf8'), marginTop: '6px', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <p style={{ fontWeight: '700', color: isIdRejected ? '#f87171' : isIdVerified ? '#4ade80' : (notif.is_read ? 'var(--text-secondary)' : '#fff'), fontSize: '0.92rem', margin: 0, marginBottom: '4px' }}>
                    {notif.title}
                  </p>
                  {/* Multi-line message — split by \n */}
                  {notif.message.split('\n').map((line, i) => (
                    line.trim() ? (
                      <p key={i} style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: '0 0 3px', lineHeight: '1.4' }}>{line}</p>
                    ) : <br key={i} />
                  ))}
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.72rem', margin: '8px 0 0' }}>
                    {new Date(notif.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    {!notif.is_read && <span style={{ color: isIdRejected ? '#f87171' : '#38bdf8', marginLeft: '8px', fontWeight: '600' }}>· Tap to mark read</span>}
                  </p>
                  {/* ID Rejected — Re-upload CTA */}
                  {isIdRejected && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // For booked guests: go to wizard step 3
                        // For occupied guests: open inline re-upload modal
                        if (activeBooking?.status === 'booked') {
                          setWizardStep(3);
                          setDashTab('overview');
                        } else {
                          setReuploadFile(null);
                          setReuploadError(null);
                          setReuploadSuccess(false);
                          setShowIdReupload(true);
                        }
                      }}
                      style={{
                        marginTop: '10px', padding: '8px 18px',
                        background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)',
                        borderRadius: '8px', color: '#f87171', fontWeight: '700',
                        fontSize: '0.82rem', cursor: 'pointer', display: 'inline-flex',
                        alignItems: 'center', gap: '6px'
                      }}
                    >
                      📤 Re-upload Document
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
