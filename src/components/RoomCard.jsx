import React from 'react';

export default function RoomCard({ room, onClick, isDimmed }) {
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
    >
      <div className="room-header">
        <span className="room-number">{room.number}</span>
        <span className="room-tag">{room.type}</span>
      </div>
      
      <div className="room-details">
        {room.status === 'occupied' ? (
          <>
            <span className="guest-name" title={room.guestName}>
              👤 {room.guestName}
            </span>
            <span className="room-status-label" style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.8)' }}>
              Check-in: {room.checkInDate}
            </span>
          </>
        ) : room.status === 'dirty' ? (
          <>
            <span className="guest-name" style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem' }}>
              ⚠️ Needs Cleaning
            </span>
            <span className="room-status-label">{getStatusLabel(room.status)}</span>
          </>
        ) : (
          <>
            <span className="guest-name" style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.8rem', fontWeight: '400' }}>
              [ Empty ]
            </span>
            <span className="room-status-label">{getStatusLabel(room.status)}</span>
          </>
        )}
      </div>
    </div>
  );
}
