import React from 'react';

export default function RightDetailsPanel({ selectedRoom, onActionClick }) {
  // Mock global stats for the redesign
  const globalStats = {
    activeGuests: 42,
    occupiedRooms: 28,
    vacantRooms: 15,
    dirtyRooms: 7,
  };

  return (
    <div className="right-details-panel">


      {/* Room Details */}
      <div className="panel-section" style={{ flex: 1 }}>
        <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', textTransform: 'uppercase', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
          Room Details
        </h3>
        <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', flex: 1, minHeight: '150px' }}>
          {selectedRoom ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.9rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>Room {selectedRoom.number}</span>
                <span style={{ 
                  background: `var(--color-${selectedRoom.status})`, 
                  color: '#fff', 
                  padding: '4px 10px', 
                  borderRadius: '12px', 
                  fontSize: '0.75rem',
                  textTransform: 'uppercase',
                  fontWeight: '600'
                }}>
                  {selectedRoom.status}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Type:</span>
                <span style={{ fontWeight: '500' }}>{selectedRoom.type}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Floor:</span>
                <span style={{ fontWeight: '500' }}>{String(selectedRoom.number).charAt(0)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Tariff:</span>
                <span style={{ fontWeight: '500' }}>₹{selectedRoom.price}/night</span>
              </div>
              {selectedRoom.status === 'occupied' && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Check-in:</span>
                    <span style={{ fontWeight: '500' }}>{new Date().toLocaleDateString('en-GB')} 12:00</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Check-out:</span>
                    <span style={{ fontWeight: '500' }}>{new Date(Date.now() + 86400000).toLocaleDateString('en-GB')} 11:00</span>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', textAlign: 'center', fontSize: '0.9rem' }}>
              Select a room from the grid<br/>to view detailed information.
            </div>
          )}
        </div>
      </div>

      {/* Guest Details */}
      <div className="panel-section">
        <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', textTransform: 'uppercase', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
          Guest Details
        </h3>
        <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', minHeight: '130px' }}>
          {selectedRoom && selectedRoom.guestName ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.9rem' }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: 'var(--text-main)', marginBottom: '4px' }}>
                {selectedRoom.guestName}
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
                <span style={{ color: 'var(--text-muted)' }}>Source:</span>
                <span>Direct Booking</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
                <span style={{ color: 'var(--text-muted)' }}>Balance Due:</span>
                <span style={{ fontWeight: 'bold', color: '#f87171' }}>₹{selectedRoom.deposit ? (selectedRoom.price - selectedRoom.deposit) : selectedRoom.price}</span>
              </div>
              {selectedRoom.meal_plan && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Meal Plan:</span>
                  <span style={{ fontWeight: '500', color: '#4ade80' }}>{selectedRoom.meal_plan} Plan</span>
                </div>
              )}
              {selectedRoom.billing_instruction && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Billing:</span>
                  <span style={{ fontWeight: '500', fontSize: '0.82rem' }}>{selectedRoom.billing_instruction}</span>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              No active guest assigned.
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="panel-section">
        <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', textTransform: 'uppercase', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
          Quick Actions
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <button className="btn-action" onClick={() => onActionClick && onActionClick('checkin')} style={{ width: '100%' }}>
            Check In
          </button>
          <button className="btn-action" onClick={() => onActionClick && onActionClick('checkout')} style={{ width: '100%' }}>
            Check Out
          </button>
          <button className="btn-action" onClick={() => onActionClick && onActionClick('shifting')} style={{ width: '100%' }}>
            Add Service
          </button>
          <button className="btn-action" style={{ width: '100%' }}>
            Housekeeping
          </button>
          <button className="btn-action" style={{ width: '100%', gridColumn: 'span 2' }}>
            Maintenance
          </button>
        </div>
      </div>
    </div>
  );
}
