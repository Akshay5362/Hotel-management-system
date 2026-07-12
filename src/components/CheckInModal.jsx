import React, { useState, useEffect } from 'react';

export default function CheckInModal({ isOpen, onClose, room, onCheckIn, showAlert }) {
  const [guestName, setGuestName] = useState('');
  const [phone, setPhone] = useState('');
  const [pax, setPax] = useState('1');
  const [deposit, setDeposit] = useState('0');
  const [checkInDate, setCheckInDate] = useState('');

  // Reset or initialize state when room changes or modal opens
  useEffect(() => {
    if (room) {
      setGuestName('');
      setPhone('');
      setPax('1');
      setDeposit('0');
      // Set to today's date formatted as YYYY-MM-DD
      const today = new Date().toISOString().split('T')[0];
      setCheckInDate(today);
    }
  }, [room, isOpen]);

  if (!isOpen || !room) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!guestName.trim()) {
      showAlert('Please enter guest name', 'Missing Field');
      return;
    }
    onCheckIn(room.number, {
      guestName: guestName.toUpperCase(),
      phone,
      pax: parseInt(pax, 10),
      deposit: parseFloat(deposit) || 0,
      checkInDate
    });
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h3>
            <span>🏨</span> Room Check-In - Room {room.number}
          </h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-row">
              <div className="form-group">
                <label>Room Number</label>
                <input type="text" value={room.number} disabled />
              </div>
              <div className="form-group">
                <label>Room Type</label>
                <input type="text" value={room.type} disabled />
              </div>
            </div>

            <div className="form-group">
              <label>Guest Name</label>
              <div className="input-icon-wrapper">
                <svg viewBox="0 0 24 24">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                  <circle cx="12" cy="7" r="4"></circle>
                </svg>
                <input 
                  type="text" 
                  placeholder="Enter guest's full name"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  required 
                />
              </div>
            </div>

            <div className="form-group">
              <label>Mobile Number</label>
              <div className="input-icon-wrapper">
                <svg viewBox="0 0 24 24">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                </svg>
                <input 
                  type="tel" 
                  placeholder="e.g. +91 9999999999"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Pax (Guests Count)</label>
                <select value={pax} onChange={(e) => setPax(e.target.value)}>
                  <option value="1">1 Person</option>
                  <option value="2">2 Persons</option>
                  <option value="3">3 Persons</option>
                  <option value="4">4 Persons</option>
                </select>
              </div>
              <div className="form-group">
                <label>Room Rate per Night</label>
                <input type="text" value={`₹ ${room.rate}`} disabled />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Advance Deposit (₹)</label>
                <input 
                  type="number" 
                  min="0" 
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Check-in Date</label>
                <input 
                  type="date" 
                  value={checkInDate}
                  onChange={(e) => setCheckInDate(e.target.value)}
                  required
                />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary">Confirm Check-In</button>
          </div>
        </form>
      </div>
    </div>
  );
}
