import React from 'react';

export default function RoomInspectorDrawer({ selectedRoom, onClose, onCheckInClick, onCheckOutClick, onRoomStatusChange }) {
  if (!selectedRoom) return null;

  const isActive = selectedRoom.is_active !== false && selectedRoom.is_active !== 0 && selectedRoom.is_active !== '0';
  const isDirty = selectedRoom.housekeeping_status === 'Dirty' || selectedRoom.status === 'dirty';
  const isOccupied = selectedRoom.status === 'occupied';
  const isVacant = selectedRoom.status === 'vacant';
  const isBooked = selectedRoom.status === 'booked';

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
            <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
              <span style={{ 
                display: 'inline-block',
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
              <span style={{ 
                display: 'inline-block',
                background: isActive ? 'rgba(74, 222, 128, 0.2)' : 'rgba(239, 68, 68, 0.2)', 
                color: isActive ? '#4ade80' : '#f87171', 
                border: `1px solid ${isActive ? '#4ade8055' : '#f8717155'}`,
                padding: '2px 8px', 
                borderRadius: '12px', 
                fontSize: '0.65rem',
                textTransform: 'uppercase',
                fontWeight: '700'
              }}>
                {isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}
              </span>
              <span style={{ 
                display: 'inline-block',
                background: isDirty ? 'rgba(251, 191, 36, 0.2)' : 'rgba(56, 189, 248, 0.2)', 
                color: isDirty ? '#fbbf24' : '#38bdf8', 
                border: `1px solid ${isDirty ? '#fbbf2455' : '#38bdf855'}`,
                padding: '2px 8px', 
                borderRadius: '12px', 
                fontSize: '0.65rem',
                textTransform: 'uppercase',
                fontWeight: '700'
              }}>
                {isDirty ? '⚠️ DIRTY' : '🧹 CLEAN'}
              </span>
            </div>
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

        <div className="drawer-content" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Occupancy & Guest Details */}
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textTransform: 'uppercase', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px' }}>
              Occupancy & Guest Details
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
                {selectedRoom.date_of_birth && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Date of Birth:</span>
                    <span style={{ color: '#a78bfa' }}>🎂 {selectedRoom.date_of_birth}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Occupants:</span>
                  <span>{selectedRoom.pax || 1} Person(s)</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Check-in Date:</span>
                  <span style={{ fontWeight: '500' }}>{selectedRoom.checkInDate || 'N/A'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Expected Check-out:</span>
                  <span style={{ fontWeight: '500' }}>{selectedRoom.expectedCheckOutDate || 'N/A'}</span>
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontStyle: 'italic' }}>
                No active guest currently assigned. Status: <strong style={{ textTransform: 'uppercase', color: '#4ade80' }}>{selectedRoom.status}</strong>
              </div>
            )}
          </div>

          {/* Tariff & Operational Status */}
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textTransform: 'uppercase', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px' }}>
              Tariff & Operational Mode
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.9rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Room Type:</span>
                <span style={{ fontWeight: '500' }}>{selectedRoom.type}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Base Tariff:</span>
                <span style={{ fontWeight: '500' }}>₹{selectedRoom.rate || selectedRoom.price || 0}/night</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Operational Mode:</span>
                <span style={{ fontWeight: '700', color: isActive ? '#4ade80' : '#f87171' }}>
                  {isActive ? '🟢 Active' : '🔴 Inactive'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Housekeeping Status:</span>
                <span style={{ fontWeight: '700', color: isDirty ? '#fbbf24' : '#38bdf8' }}>
                  {isDirty ? '⚠️ Dirty' : '🧹 Clean'}
                </span>
              </div>
            </div>
          </div>

          {/* Operational Controls & Actions */}
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', marginTop: 'auto' }}>
            <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textTransform: 'uppercase', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px' }}>
              Room Controls & Actions
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {/* Active / Inactive & Clean / Dirty Controls */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <button 
                  className="btn-action" 
                  onClick={() => onRoomStatusChange && onRoomStatusChange(selectedRoom.number, isActive ? 'mark_inactive' : 'mark_active')}
                  style={{
                    width: '100%',
                    height: '36px',
                    background: isActive ? 'rgba(239, 68, 68, 0.15)' : 'rgba(74, 222, 128, 0.15)',
                    color: isActive ? '#f87171' : '#4ade80',
                    border: `1px solid ${isActive ? 'rgba(239, 68, 68, 0.3)' : 'rgba(74, 222, 128, 0.3)'}`,
                    fontWeight: 'bold',
                    fontSize: '0.75rem'
                  }}
                >
                  {isActive ? '🚫 Mark Inactive' : '✅ Mark Active'}
                </button>

                <button 
                  className="btn-action" 
                  onClick={() => onRoomStatusChange && onRoomStatusChange(selectedRoom.number, isDirty ? 'mark_clean' : 'mark_dirty')}
                  style={{
                    width: '100%',
                    height: '36px',
                    background: isDirty ? 'rgba(74, 222, 128, 0.15)' : 'rgba(251, 191, 36, 0.15)',
                    color: isDirty ? '#4ade80' : '#fbbf24',
                    border: `1px solid ${isDirty ? 'rgba(74, 222, 128, 0.3)' : 'rgba(251, 191, 36, 0.3)'}`,
                    fontWeight: 'bold',
                    fontSize: '0.75rem'
                  }}
                >
                  {isDirty ? '🧹 Mark Clean' : '⚠️ Mark Dirty'}
                </button>
              </div>

              {/* Check In / Check Out Action Buttons according to room operational state */}
              {isActive ? (
                isOccupied ? (
                  <button 
                    className="btn-action" 
                    onClick={() => onCheckOutClick && onCheckOutClick(selectedRoom)} 
                    style={{ width: '100%', height: '38px', background: 'var(--color-occupied)', color: '#fff', fontWeight: 'bold' }}
                  >
                    Check Out Guest
                  </button>
                ) : (isVacant || isBooked) ? (
                  <button 
                    className="btn-action" 
                    onClick={() => onCheckInClick && onCheckInClick(selectedRoom)} 
                    style={{ width: '100%', height: '38px', background: 'var(--color-vacant)', color: '#101827', fontWeight: 'bold' }}
                  >
                    Check In Guest
                  </button>
                ) : null
              ) : (
                <div style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.25)',
                  color: '#f87171',
                  fontSize: '0.8rem',
                  fontWeight: '600',
                  textAlign: 'center'
                }}>
                  🔒 Room is inactive and cannot be checked in.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
