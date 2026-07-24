import React from 'react';

export default function RoomInspectorDrawer({ selectedRoom, onClose, onActionClick }) {
  if (!selectedRoom) return null;

  return (
    <>
      <div 
        className={`slide-over-overlay ${selectedRoom ? 'open' : ''}`}
        onClick={onClose}
      />
      <div className={`slide-over-drawer ${selectedRoom ? 'open' : ''}`}>
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: '1.25rem', margin: 0, fontWeight: '700' }}>Room {selectedRoom.number}</h2>
            <span style={{ 
              display: 'inline-block',
              marginTop: '4px',
              background: `var(--color-${selectedRoom.status})`, 
              color: '#fff', 
              padding: '2px 8px', 
              borderRadius: '12px', 
              fontSize: '0.65rem',
              textTransform: 'uppercase',
              fontWeight: '700'
            }}>
              {selectedRoom.status}
            </span>
          </div>
          <button 
            onClick={onClose}
            style={{ 
              background: 'transparent', 
              border: 'none', 
              color: 'var(--text-muted)', 
              fontSize: '2rem', 
              cursor: 'pointer',
              lineHeight: 1
            }}
          >
            &times;
          </button>
        </div>

        <div className="drawer-content">
          {/* Stay & Guest Information */}
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textTransform: 'uppercase', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px' }}>
              Guest & Stay Details
            </h3>
            {selectedRoom.guestName ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.9rem' }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: 'var(--text-main)' }}>
                  👤 {selectedRoom.guestName}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Phone:</span>
                  <span>{selectedRoom.phone || 'N/A'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Occupants:</span>
                  <span>2 Adults, 0 Children</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Check-in:</span>
                  <span style={{ fontWeight: '500' }}>{selectedRoom.checkInDate || new Date().toLocaleDateString('en-GB')}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Check-out:</span>
                  <span style={{ fontWeight: '500' }}>{new Date(Date.now() + 86400000).toLocaleDateString('en-GB')}</span>
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No active guest assigned to this room.</div>
            )}
          </div>

          {/* Room Billing & Tariff */}
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textTransform: 'uppercase', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px' }}>
              Tariff & Billing
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.9rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Room Type:</span>
                <span style={{ fontWeight: '500' }}>{selectedRoom.type}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Floor:</span>
                <span style={{ fontWeight: '500' }}>{String(selectedRoom.number).charAt(0)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Base Tariff:</span>
                <span style={{ fontWeight: '500' }}>₹{selectedRoom.price}/night</span>
              </div>
              {selectedRoom.guestName && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Balance Due:</span>
                  <span style={{ fontWeight: 'bold', color: '#f87171', fontSize: '1.1rem' }}>₹{selectedRoom.deposit ? (selectedRoom.price - selectedRoom.deposit) : selectedRoom.price}</span>
                </div>
              )}
            </div>
          </div>

          {/* Quick Actions inside Drawer */}
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', marginTop: 'auto' }}>
            <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textTransform: 'uppercase', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px' }}>
              Room Actions
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <button className="btn-action" onClick={() => onActionClick && onActionClick('checkin')} style={{ width: '100%', height: '32px' }}>
                Check In
              </button>
              <button className="btn-action" onClick={() => onActionClick && onActionClick('checkout')} style={{ width: '100%', height: '32px' }}>
                Check Out
              </button>
              <button className="btn-action" onClick={() => onActionClick && onActionClick('shifting')} style={{ width: '100%', height: '32px' }}>
                Add Service
              </button>
              <button className="btn-action" style={{ width: '100%', height: '32px' }}>
                Housekeeping
              </button>
              <button className="btn-action" style={{ width: '100%', height: '32px', gridColumn: 'span 2' }}>
                Maintenance Request
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
