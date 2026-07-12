import React, { useState, useEffect } from 'react';

export default function RoomShiftingModal({ isOpen, onClose, room, vacantRooms, onShiftRoom, showAlert, showConfirm }) {
  const [targetRoomNo, setTargetRoomNo] = useState('');

  useEffect(() => {
    if (vacantRooms.length > 0) {
      setTargetRoomNo(vacantRooms[0].number);
    } else {
      setTargetRoomNo('');
    }
  }, [vacantRooms, isOpen]);

  if (!isOpen || !room) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!targetRoomNo) {
      showAlert('No vacant rooms available to shift to!', 'Shifting Check');
      return;
    }
    
    const confirmed = await showConfirm(`Are you sure you want to shift guest ${room.guestName} from Room ${room.number} to Room ${targetRoomNo}?`, 'Room Shift Confirmation');
    if (confirmed) {
      onShiftRoom(room.number, targetRoomNo);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h3>
            <span>🔄</span> Room Shifting
          </h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div style={{ padding: '12px', background: 'rgba(248, 113, 113, 0.05)', border: '1px solid rgba(248, 113, 113, 0.2)', borderRadius: '8px', marginBottom: '20px' }}>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Current Guest Details</p>
              <p style={{ fontWeight: '700', color: '#fff', fontSize: '1.05rem', margin: '4px 0' }}>{room.guestName}</p>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Occupying <strong>Room {room.number}</strong> ({room.type})
              </p>
            </div>

            <div className="form-group">
              <label>Select Target Vacant Room</label>
              {vacantRooms.length > 0 ? (
                <select 
                  value={targetRoomNo}
                  onChange={(e) => setTargetRoomNo(e.target.value)}
                  style={{ fontSize: '1rem', padding: '12px' }}
                >
                  {vacantRooms.map((vRoom) => (
                    <option key={vRoom.number} value={vRoom.number}>
                      Room {vRoom.number} - {vRoom.type} (₹ {vRoom.rate}/night)
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ color: 'var(--color-occupied)', fontSize: '0.9rem', fontWeight: '600', padding: '10px 0' }}>
                  ⚠️ No vacant rooms are currently available in the hotel.
                </div>
              )}
            </div>

            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '10px', lineHeight: '1.4' }}>
              💡 <em>Note: All billing ledger items, advances, and registration information will be moved to the target room. The original room status will change to Vacant.</em>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button 
              type="submit" 
              className="btn-primary" 
              disabled={vacantRooms.length === 0}
            >
              Execute Room Shift
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
