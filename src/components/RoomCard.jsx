import React from 'react';

export default function RoomCard({ room, onClick, isDimmed, showOperationalBadges = false }) {
  const isActive = room.is_active !== false && room.is_active !== 0 && room.is_active !== '0';
  const isDirty = room.housekeeping_status === 'Dirty' || room.status === 'dirty';

  const getStatusLabel = (status) => {
    switch (status) {
      case 'vacant': return 'Vacant';
      case 'occupied': return 'Occupied';
      case 'dirty': return 'Dirty';
      case 'booked': return 'Booked';
      case 'inactive': return 'Inactive';
      default: return status;
    }
  };

  return (
    <div 
      className={`room-card status-${room.status} ${isDimmed ? 'dimmed' : ''}`}
      onClick={() => onClick(room)}
      style={{ cursor: 'pointer', position: 'relative' }}
    >
      <div className="room-header">
        <span className="room-number">{room.number}</span>
        <span className="room-tag">{room.type}</span>
      </div>
      
      <div className="room-details">
        {room.status === 'occupied' ? (
          <>
            <span className="guest-name text-truncate" title={room.guestName}>
              👤 {room.guestName}
            </span>
            <span className="room-status-label" style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.8)' }}>
              Check-in: {room.checkInDate}
            </span>
          </>
        ) : room.status === 'booked' ? (
          <>
            <span className="guest-name text-truncate" title={room.guestName} style={{ color: '#38bdf8' }}>
              📅 {room.guestName}
            </span>
            <span className="room-status-label">{getStatusLabel(room.status)}</span>
          </>
        ) : room.status === 'dirty' ? (
          <>
            <span className="guest-name text-truncate" style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem' }}>
              ⚠️ Needs Cleaning
            </span>
            <span className="room-status-label">{getStatusLabel(room.status)}</span>
          </>
        ) : (
          <>
            <span className="guest-name text-truncate" style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.8rem', fontWeight: '400' }}>
              [ Empty ]
            </span>
            <span className="room-status-label">{getStatusLabel(room.status)}</span>
          </>
        )}
      </div>

      {/* Operational & Housekeeping Badges — EXCLUSIVELY rendered in Rooms Management Section */}
      {showOperationalBadges && (
        <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
          <span style={{
            fontSize: '0.6rem',
            fontWeight: '700',
            padding: '1px 5px',
            borderRadius: '4px',
            background: isActive ? 'rgba(74, 222, 128, 0.15)' : 'rgba(239, 68, 68, 0.2)',
            color: isActive ? '#4ade80' : '#f87171',
            border: `1px solid ${isActive ? 'rgba(74, 222, 128, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
          }}>
            {isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}
          </span>
          <span style={{
            fontSize: '0.6rem',
            fontWeight: '700',
            padding: '1px 5px',
            borderRadius: '4px',
            background: isDirty ? 'rgba(251, 191, 36, 0.2)' : 'rgba(56, 189, 248, 0.15)',
            color: isDirty ? '#fbbf24' : '#38bdf8',
            border: `1px solid ${isDirty ? 'rgba(251, 191, 36, 0.3)' : 'rgba(56, 189, 248, 0.3)'}`
          }}>
            {isDirty ? '⚠️ DIRTY' : '🧹 CLEAN'}
          </span>
        </div>
      )}
    </div>
  );
}
