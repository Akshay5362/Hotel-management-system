import React, { useState, useEffect } from 'react';

function parseDisplayDate(dateStr) {
  if (!dateStr) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  
  const day = parts[0].padStart(2, '0');
  const monthStr = parts[1];
  const year = parts[2];
  
  const months = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
  };
  const month = months[monthStr] || '01';
  return `${year}-${month}-${day}`;
}

export default function ModifyCheckInModal({ isOpen, onClose, room, onModify, showAlert }) {
  const [guestName, setGuestName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState('');
  const [phone, setPhone] = useState('');
  const [pax, setPax] = useState('1');
  const [deposit, setDeposit] = useState('0');
  const [checkInDate, setCheckInDate] = useState('');
  const [expectedCheckOutDate, setExpectedCheckOutDate] = useState('');
  const [address, setAddress] = useState('');
  const [gstNo, setGstNo] = useState('');
  const [pincode, setPincode] = useState('');
  const [country, setCountry] = useState('');
  const [arrivalFrom, setArrivalFrom] = useState('');
  const [departureTo, setDepartureTo] = useState('');
  const [billingInstruction, setBillingInstruction] = useState('Direct to Guest');
  const [mealPlan, setMealPlan] = useState('EP');

  // Reset or initialize state when room changes or modal opens
  useEffect(() => {
    if (room && isOpen) {
      setGuestName(room.guestName || '');
      setDob(room.dob || room.dateOfBirth || room.date_of_birth || '');
      setGender(room.gender || '');
      setPhone(room.phone || '');
      setPax(String(room.pax || '1'));
      setDeposit(String(room.deposit || '0'));
      setCheckInDate(parseDisplayDate(room.checkInDate || ''));
      setExpectedCheckOutDate(parseDisplayDate(room.expectedCheckOutDate || ''));
      setAddress(room.address || '');
      setGstNo(room.gst_no || room.gstNo || '');
      setPincode(room.pincode || '');
      setCountry(room.country || '');
      setArrivalFrom(room.arrival_from || '');
      setDepartureTo(room.departure_to || '');
      setBillingInstruction(room.billing_instruction || 'Direct to Guest');
      setMealPlan(room.meal_plan || 'EP');
    }
  }, [room, isOpen]);

  if (!isOpen || !room) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!guestName.trim()) {
      showAlert('Please enter guest name', 'Missing Field');
      return;
    }

    // Validate checkout date is after checkin date
    if (checkInDate && expectedCheckOutDate) {
      const cin = new Date(checkInDate);
      const cout = new Date(expectedCheckOutDate);
      if (cout <= cin) {
        showAlert('Expected Check-out Date must be after Check-in Date', 'Invalid Dates');
        return;
      }
    }

    onModify(room.number, {
      guestName: guestName.toUpperCase(),
      dob: dob || null,
      dateOfBirth: dob || null,
      date_of_birth: dob || null,
      gender: gender || null,
      phone,
      pax: parseInt(pax, 10),
      deposit: parseFloat(deposit) || 0,
      checkInDate,
      expectedCheckOutDate,
      address,
      gst_no: gstNo,
      gstNo: gstNo,
      pincode,
      country,
      arrival_from: arrivalFrom,
      departure_to: departureTo,
      billing_instruction: billingInstruction,
      meal_plan: mealPlan
    });
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '680px' }}>
        <div className="modal-header">
          <h3>
            <span>✏️</span> Modify Check-In Details - Room {room.number}
          </h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
            <div style={{
              display: 'flex',
              gap: '10px',
              padding: '10px 14px',
              marginBottom: '18px',
              borderRadius: '6px',
              background: 'rgba(56, 189, 248, 0.05)',
              border: '1px solid rgba(56, 189, 248, 0.15)',
              fontSize: '0.82rem',
              color: '#38bdf8'
            }}>
              <span>ℹ️</span>
              <span>Update checked-in guest profile, tax details, and log parameters below.</span>
            </div>

            {/* Room Info & Dates Section */}
            <h4 style={{ fontSize: '0.85rem', color: '#ffd700', textTransform: 'uppercase', marginBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>Stay Details</h4>
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

            <div className="form-row">
              <div className="form-group">
                <label>Arrival Check-in Date</label>
                <input 
                  type="date" 
                  value={checkInDate}
                  onChange={(e) => setCheckInDate(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Departure Check-out Date</label>
                <input 
                  type="date" 
                  value={expectedCheckOutDate}
                  onChange={(e) => setExpectedCheckOutDate(e.target.value)}
                />
              </div>
            </div>

            {/* Guest Primary Details Section */}
            <h4 style={{ fontSize: '0.85rem', color: '#ffd700', textTransform: 'uppercase', marginBottom: '12px', marginTop: '20px', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>Guest Details</h4>
            <div className="form-row">
              <div className="form-group">
                <label>Guest Name</label>
                <input 
                  type="text" 
                  placeholder="Enter guest's name"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  required 
                />
              </div>
              <div className="form-group">
                <label>Date of Birth (DOB)</label>
                <input 
                  type="date" 
                  value={dob}
                  onChange={(e) => setDob(e.target.value)}
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Gender (Optional)</label>
                <select value={gender} onChange={(e) => setGender(e.target.value)}>
                  <option value="">Select Gender (optional)</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                  <option value="Prefer not to say">Prefer not to say</option>
                </select>
              </div>
              <div className="form-group">
                <label>Mobile Number</label>
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
            </div>

            {/* Tax & Demographics Section */}
            <h4 style={{ fontSize: '0.85rem', color: '#ffd700', textTransform: 'uppercase', marginBottom: '12px', marginTop: '20px', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>Address & Tax Information</h4>
            <div className="form-group">
              <label>Address</label>
              <input 
                type="text" 
                placeholder="Enter guest street address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Pincode</label>
                <input 
                  type="text" 
                  placeholder="e.g. 110001"
                  value={pincode}
                  onChange={(e) => setPincode(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Country</label>
                <input 
                  type="text" 
                  placeholder="e.g. India"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                />
              </div>
            </div>

            <div className="form-group">
              <label>Company GST Number (Optional)</label>
              <input 
                type="text" 
                placeholder="e.g. 07AAAAA1111A1Z1"
                value={gstNo}
                onChange={(e) => setGstNo(e.target.value)}
              />
            </div>

            {/* Billing & Meal Plan Section */}
            <h4 style={{ fontSize: '0.85rem', color: '#ffd700', textTransform: 'uppercase', marginBottom: '12px', marginTop: '20px', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>Billing &amp; Meal Plan</h4>
            <div className="form-row">
              <div className="form-group">
                <label>Billing Instructions</label>
                <select
                  value={billingInstruction}
                  onChange={(e) => setBillingInstruction(e.target.value)}
                >
                  <option value="Direct to Guest">Direct to Guest</option>
                  <option value="Bill to Company">Bill to Company</option>
                  <option value="Room Tariff Only">Room Tariff Only</option>
                </select>
              </div>
              <div className="form-group">
                <label>Meal Plan</label>
                <select
                  value={mealPlan}
                  onChange={(e) => setMealPlan(e.target.value)}
                >
                  <option value="EP">EP Plan (Room Only)</option>
                  <option value="CP">CP Plan (+ Breakfast)</option>
                  <option value="MAP">MAP Plan (+ Breakfast &amp; Dinner)</option>
                  <option value="AP">AP Plan (All Meals)</option>
                </select>
              </div>
            </div>

            {/* Logistics Info Section */}
            <h4 style={{ fontSize: '0.85rem', color: '#ffd700', textTransform: 'uppercase', marginBottom: '12px', marginTop: '20px', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>Travel Information</h4>
            <div className="form-row">
              <div className="form-group">
                <label>Arrival From</label>
                <input 
                  type="text" 
                  placeholder="Starting location"
                  value={arrivalFrom}
                  onChange={(e) => setArrivalFrom(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Departure To</label>
                <input 
                  type="text" 
                  placeholder="Destination location"
                  value={departureTo}
                  onChange={(e) => setDepartureTo(e.target.value)}
                />
              </div>
            </div>

          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" style={{ background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)' }}>Save Changes</button>
          </div>
        </form>
      </div>
    </div>
  );
}
