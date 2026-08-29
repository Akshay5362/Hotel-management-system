import React, { useState, useEffect } from 'react';
import { getDefaultExpectedCheckoutInput } from '../utils/dateFormatter';
import StateSelect from './StateSelect';

export default function CheckInModal({ isOpen, onClose, room, onCheckIn, showAlert }) {
  // Guest Information (Mandatory)
  const [guestName, setGuestName]           = useState('');
  const [age, setAge]                       = useState('');
  const [dob, setDob]                       = useState('');
  const [gender, setGender]                 = useState('');
  const [phone, setPhone]                   = useState('');
  const [email, setEmail]                   = useState('');
  const [country, setCountry]               = useState('India');
  const [state, setState]                   = useState('');
  const [address, setAddress]               = useState('');
  const [pincode, setPincode]               = useState('');
  const [purposeOfVisit, setPurposeOfVisit] = useState('Personal');

  // Stay Information (Mandatory)
  const [checkInDate, setCheckInDate]       = useState('');
  const [expectedCheckout, setExpectedCheckout] = useState('');
  const [pax, setPax]                       = useState('1');
  const [children, setChildren]             = useState('0');

  // Billing Information (Mandatory)
  const [roomTariff, setRoomTariff]         = useState('');
  const [billingInstruction, setBillingInstruction] = useState('Direct to Guest');

  // Additional optional operational fields
  const [deposit, setDeposit]               = useState('0');
  const [paymentMode, setPaymentMode]       = useState('Cash');
  const [mealPlan, setMealPlan]             = useState('EP');
  const [companyName, setCompanyName]       = useState('');
  const [gstNo, setGstNo]                   = useState('');

  // Field validation errors
  const [errors, setErrors]                 = useState({});

  // Reset or initialize state when room changes or modal opens
  useEffect(() => {
    if (room && isOpen) {
      setGuestName('');
      setAge('');
      setDob('');
      setGender('');
      setPhone('');
      setEmail('');
      setCountry('India');
      setState('');
      setAddress('');
      setPincode('');
      setPurposeOfVisit('Personal');
      setPax('1');
      setChildren('0');
      setDeposit('0');
      setBillingInstruction('Direct to Guest');
      setPaymentMode('Cash');
      setMealPlan('EP');
      setRoomTariff(String(room.rate || room.price || ''));
      setCompanyName('');
      setGstNo('');
      setErrors({});

      const today = new Date().toISOString().split('T')[0];
      setCheckInDate(today);
      setExpectedCheckout(getDefaultExpectedCheckoutInput(today));
    }
  }, [room, isOpen]);

  // When checkInDate changes, update expected checkout default if untouched
  const handleCheckInDateChange = (newDate) => {
    setCheckInDate(newDate);
    setExpectedCheckout(getDefaultExpectedCheckoutInput(newDate));
  };

  if (!isOpen || !room) return null;

  const validateForm = () => {
    const errs = {};
    // Mandatory 1: Full Name
    if (!guestName.trim() || guestName.trim().length < 2) {
      errs.guestName = 'Full name is required (min 2 chars)';
    }
    // Mandatory 2: Age
    const parsedAge = parseInt(age, 10);
    if (!age || isNaN(parsedAge) || parsedAge <= 0 || parsedAge > 125) {
      errs.age = 'Age is required (valid number 1-125)';
    }
    // Optional: Date of Birth (Format check only when non-empty)
    if (dob) {
      const dobTime = new Date(dob).getTime();
      if (isNaN(dobTime)) {
        errs.dob = 'Please enter a valid Date of Birth';
      } else if (dobTime > Date.now()) {
        errs.dob = 'Date of Birth cannot be in the future';
      }
    }
    // Mandatory 3: Contact Number
    if (!phone.trim() || phone.trim().length < 7) {
      errs.phone = 'Valid contact number is required (min 7 digits)';
    }
    // Optional: Email Address (Format check only when non-empty)
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email = 'Please enter a valid email address';
    }
    // Mandatory 4: State
    if (!state.trim()) {
      errs.state = 'State is required';
    }
    // Mandatory 5: Purpose of Visit
    if (!purposeOfVisit.trim()) {
      errs.purposeOfVisit = 'Purpose of visit is required';
    }
    // Mandatory 6: Number of Pax
    const parsedPax = parseInt(pax, 10);
    if (!pax || isNaN(parsedPax) || parsedPax < 1) {
      errs.pax = 'Pax must be at least 1';
    }
    // Optional: Children (Format check only when provided)
    if (children !== '' && children !== undefined && children !== null) {
      const parsedChildren = parseInt(children, 10);
      if (isNaN(parsedChildren) || parsedChildren < 0) {
        errs.children = 'Children must be 0 or more';
      }
    }
    // Optional: Arrival Date
    if (checkInDate && isNaN(new Date(checkInDate).getTime())) {
      errs.checkInDate = 'Please enter a valid arrival date';
    }
    // Optional: Departure Date
    if (expectedCheckout && isNaN(new Date(expectedCheckout).getTime())) {
      errs.expectedCheckout = 'Please enter a valid departure date';
    } else if (checkInDate && expectedCheckout && new Date(expectedCheckout).getTime() <= new Date(checkInDate).getTime()) {
      errs.expectedCheckout = 'Departure date must be after arrival date';
    }
    // Mandatory 7: Billing Instructions
    if (!billingInstruction.trim()) {
      errs.billingInstruction = 'Billing instructions are required';
    }
    // Mandatory 8: Room Rent / Night
    const parsedTariff = parseFloat(roomTariff);
    if (!roomTariff || isNaN(parsedTariff) || parsedTariff <= 0) {
      errs.roomTariff = 'Room rent is required and must be > 0';
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validateForm()) {
      showAlert('Please fill in all mandatory check-in fields marked with *', 'Validation Error');
      return;
    }

    const parsedTariff = parseFloat(roomTariff);
    const parsedDeposit = parseFloat(deposit) || 0;
    const parsedChildren = (children !== '' && children !== undefined && children !== null) ? parseInt(children, 10) : 0;

    onCheckIn(room.number, {
      guestName:            guestName.trim().toUpperCase(),
      fullName:             guestName.trim().toUpperCase(),
      age:                  parseInt(age, 10),
      dob:                  dob || null,
      dateOfBirth:          dob || null,
      gender:               gender || null,
      phone:                phone.trim(),
      contactNumber:        phone.trim(),
      email:                email.trim(),
      country:              country.trim(),
      state:                state.trim(),
      address:              address.trim(),
      pincode:              pincode.trim(),
      purposeOfVisit:       purposeOfVisit.trim(),
      purpose_of_visit:     purposeOfVisit.trim(),
      pax:                  parseInt(pax, 10),
      children:             parsedChildren,
      arrivalDate:          checkInDate,
      checkInDate,
      departureDate:        expectedCheckout,
      expectedCheckoutDate: expectedCheckout,
      roomRent:             parsedTariff,
      roomTariff:           parsedTariff,
      billingInstruction,
      billing_instruction:  billingInstruction,
      deposit:              parsedDeposit,
      paymentMode,
      mealPlan,
      meal_plan:            mealPlan,
      companyName:          companyName.trim(),
      gstNo:                gstNo.trim(),
      gst_no:               gstNo.trim()
    });
  };

  const inpStyle = {
    background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px', color: '#e2e8f0', padding: '9px 12px', width: '100%',
    fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box'
  };
  const errInpStyle = {
    ...inpStyle,
    borderColor: '#ef4444',
    background: 'rgba(239,68,68,0.08)'
  };
  const selectStyle = {
    ...inpStyle,
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    cursor: 'pointer'
  };
  const optionStyle = {
    backgroundColor: '#0f172a',
    color: '#f8fafc'
  };
  const disabledStyle = { ...inpStyle, opacity: 0.55, cursor: 'not-allowed' };
  const labelStyle = { display: 'block', marginBottom: '5px', fontSize: '0.78rem',
    fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' };
  const reqStar = { color: '#ef4444', marginLeft: '3px' };
  const errText = { color: '#ef4444', fontSize: '0.72rem', marginTop: '4px', display: 'block' };
  const rowStyle = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' };
  const fullRowStyle = { marginBottom: '12px' };
  const sectionTitle = {
    color: '#818cf8', fontWeight: 700, fontSize: '0.78rem', textTransform: 'uppercase',
    letterSpacing: '0.08em', marginBottom: '10px', marginTop: '14px',
    borderBottom: '1px solid rgba(129,140,248,0.2)', paddingBottom: '4px'
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '680px', maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="modal-header">
          <h3><span>🏨</span> Room Check-In — Room {room.number}</h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">

            {/* ROOM HEADER INFO */}
            <div style={rowStyle}>
              <div><label style={labelStyle}>Room Number</label><input style={disabledStyle} value={room.number} disabled /></div>
              <div><label style={labelStyle}>Room Type</label><input style={disabledStyle} value={room.type} disabled /></div>
            </div>

            {/* 1. GUEST INFORMATION */}
            <p style={sectionTitle}>1. Guest Information</p>
            <div style={rowStyle}>
              <div>
                <label style={labelStyle}>Full Name <span style={reqStar}>*</span></label>
                <input
                  style={errors.guestName ? errInpStyle : inpStyle}
                  type="text" placeholder="e.g. John Doe"
                  value={guestName} onChange={e => setGuestName(e.target.value)}
                />
                {errors.guestName && <span style={errText}>{errors.guestName}</span>}
              </div>
              <div>
                <label style={labelStyle}>Age <span style={reqStar}>*</span></label>
                <input
                  style={errors.age ? errInpStyle : inpStyle}
                  type="number" min="1" max="125" placeholder="e.g. 32"
                  value={age} onChange={e => setAge(e.target.value)}
                />
                {errors.age && <span style={errText}>{errors.age}</span>}
              </div>
            </div>

            <div style={rowStyle}>
              <div>
                <label style={labelStyle}>Date of Birth (DOB)</label>
                <input
                  style={errors.dob ? errInpStyle : inpStyle}
                  type="date"
                  value={dob} onChange={e => setDob(e.target.value)}
                />
                {errors.dob && <span style={errText}>{errors.dob}</span>}
              </div>
              <div>
                <label style={labelStyle}>Gender</label>
                <select
                  style={selectStyle}
                  value={gender}
                  onChange={e => setGender(e.target.value)}
                >
                  <option value="" style={optionStyle}>Select Gender (optional)</option>
                  <option value="Male" style={optionStyle}>Male</option>
                  <option value="Female" style={optionStyle}>Female</option>
                  <option value="Other" style={optionStyle}>Other</option>
                  <option value="Prefer not to say" style={optionStyle}>Prefer not to say</option>
                </select>
              </div>
            </div>

            <div style={rowStyle}>
              <div>
                <label style={labelStyle}>Contact Number <span style={reqStar}>*</span></label>
                <input
                  style={errors.phone ? errInpStyle : inpStyle}
                  type="tel" placeholder="+91 9876543210"
                  value={phone} onChange={e => setPhone(e.target.value)}
                />
                {errors.phone && <span style={errText}>{errors.phone}</span>}
              </div>
              <div>
                <label style={labelStyle}>Email Address</label>
                <input
                  style={errors.email ? errInpStyle : inpStyle}
                  type="email" placeholder="name@example.com (optional)"
                  value={email} onChange={e => setEmail(e.target.value)}
                />
                {errors.email && <span style={errText}>{errors.email}</span>}
              </div>
            </div>

            <div style={rowStyle}>
              <div>
                <label style={labelStyle}>Country</label>
                <input
                  style={inpStyle}
                  type="text" placeholder="e.g. India (optional)"
                  value={country} onChange={e => setCountry(e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>State <span style={reqStar}>*</span></label>
                <StateSelect
                  value={state}
                  onChange={(val) => {
                    setState(val);
                    if (errors.state) {
                      setErrors(prev => {
                        const copy = { ...prev };
                        delete copy.state;
                        return copy;
                      });
                    }
                  }}
                  hasError={Boolean(errors.state)}
                  placeholder="Select State / UT"
                  required
                />
                {errors.state && <span style={errText}>{errors.state}</span>}
              </div>
            </div>

            <div style={rowStyle}>
              <div>
                <label style={labelStyle}>Address</label>
                <input
                  style={inpStyle}
                  type="text" placeholder="Complete street address (optional)"
                  value={address} onChange={e => setAddress(e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Pincode</label>
                <input
                  style={inpStyle}
                  type="text" placeholder="e.g. 176001 (optional)"
                  value={pincode} onChange={e => setPincode(e.target.value)}
                />
              </div>
            </div>

            <div style={fullRowStyle}>
              <label style={labelStyle}>Purpose of Visit <span style={reqStar}>*</span></label>
              <select
                style={selectStyle}
                value={purposeOfVisit}
                onChange={e => setPurposeOfVisit(e.target.value)}
              >
                <option value="Personal" style={optionStyle}>Personal</option>
                <option value="Business" style={optionStyle}>Business</option>
                <option value="Official" style={optionStyle}>Official</option>
                <option value="Tourist" style={optionStyle}>Tourist</option>
                <option value="Function" style={optionStyle}>Function / Event</option>
              </select>
            </div>

            {/* 2. STAY INFORMATION */}
            <p style={sectionTitle}>2. Stay Information</p>
            <div style={rowStyle}>
              <div>
                <label style={labelStyle}>Arrival Date</label>
                <input
                  style={errors.checkInDate ? errInpStyle : inpStyle}
                  type="date" value={checkInDate}
                  onChange={e => handleCheckInDateChange(e.target.value)}
                />
                {errors.checkInDate && <span style={errText}>{errors.checkInDate}</span>}
              </div>
              <div>
                <label style={labelStyle}>Departure Date</label>
                <input
                  style={errors.expectedCheckout ? errInpStyle : inpStyle}
                  type="datetime-local" value={expectedCheckout}
                  onChange={e => setExpectedCheckout(e.target.value)}
                />
                {errors.expectedCheckout && <span style={errText}>{errors.expectedCheckout}</span>}
              </div>
            </div>

            <div style={rowStyle}>
              <div>
                <label style={labelStyle}>Number of Pax (Adults) <span style={reqStar}>*</span></label>
                <select
                  style={selectStyle}
                  value={pax}
                  onChange={e => setPax(e.target.value)}
                >
                  {[1,2,3,4,5,6].map(n => <option key={n} value={String(n)} style={optionStyle}>{n} Person{n > 1 ? 's' : ''}</option>)}
                </select>
                {errors.pax && <span style={errText}>{errors.pax}</span>}
              </div>
              <div>
                <label style={labelStyle}>Number of Children</label>
                <select
                  style={selectStyle}
                  value={children}
                  onChange={e => setChildren(e.target.value)}
                >
                  {[0,1,2,3,4].map(n => <option key={n} value={String(n)} style={optionStyle}>{n} Child{n !== 1 ? 'ren' : ''}</option>)}
                </select>
                {errors.children && <span style={errText}>{errors.children}</span>}
              </div>
            </div>

            {/* 3. BILLING INFORMATION */}
            <p style={sectionTitle}>3. Billing Information</p>
            <div style={rowStyle}>
              <div>
                <label style={labelStyle}>Room Rent / Night (₹) <span style={reqStar}>*</span></label>
                <input
                  style={errors.roomTariff ? errInpStyle : inpStyle}
                  type="number" min="0" step="any"
                  placeholder={`Base rate: ₹${room.rate || room.price || 2000}`}
                  value={roomTariff}
                  onChange={e => setRoomTariff(e.target.value)}
                />
                {errors.roomTariff && <span style={errText}>{errors.roomTariff}</span>}
              </div>
              <div>
                <label style={labelStyle}>Billing Instructions <span style={reqStar}>*</span></label>
                <select
                  style={selectStyle}
                  value={billingInstruction}
                  onChange={e => setBillingInstruction(e.target.value)}
                >
                  <option value="Direct to Guest" style={optionStyle}>Direct to Guest</option>
                  <option value="Bill to Company" style={optionStyle}>Bill to Company</option>
                  <option value="Room Tariff Only" style={optionStyle}>Room Tariff Only</option>
                </select>
              </div>
            </div>

            <div style={rowStyle}>
              <div>
                <label style={labelStyle}>Advance Deposit (₹)</label>
                <input
                  style={inpStyle}
                  type="number" min="0" value={deposit}
                  onChange={e => setDeposit(e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Payment Mode</label>
                <select style={selectStyle} value={paymentMode} onChange={e => setPaymentMode(e.target.value)}>
                  <option value="Cash" style={optionStyle}>Cash</option>
                  <option value="UPI" style={optionStyle}>UPI</option>
                  <option value="Card" style={optionStyle}>Card</option>
                  <option value="Bank Transfer" style={optionStyle}>Bank Transfer</option>
                  <option value="Other" style={optionStyle}>Other</option>
                </select>
              </div>
            </div>

            {/* OPTIONAL DETAILS & CORPORATE BILLING */}
            <div style={rowStyle}>
              <div>
                <label style={labelStyle}>Meal Plan</label>
                <select style={selectStyle} value={mealPlan} onChange={e => setMealPlan(e.target.value)}>
                  <option value="EP" style={optionStyle}>EP Plan (Room Only)</option>
                  <option value="CP" style={optionStyle}>CP Plan (+ Breakfast)</option>
                  <option value="MAP" style={optionStyle}>MAP Plan (+ Breakfast &amp; Dinner)</option>
                  <option value="AP" style={optionStyle}>AP Plan (All Meals)</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Company Name (Optional)</label>
                <input
                  style={inpStyle}
                  type="text" placeholder="For corporate stays"
                  value={companyName} onChange={e => setCompanyName(e.target.value)}
                />
              </div>
            </div>

            <div style={fullRowStyle}>
              <label style={labelStyle}>Company GST Number (Optional)</label>
              <input
                style={inpStyle}
                type="text" placeholder="e.g. 06AAAAA0000A1Z5"
                value={gstNo} onChange={e => setGstNo(e.target.value)}
              />
            </div>

          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary">✓ Confirm Check-In</button>
          </div>
        </form>
      </div>
    </div>
  );
}
