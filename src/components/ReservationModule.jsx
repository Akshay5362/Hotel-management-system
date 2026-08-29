import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { API_URL, getApiHeaders } from '../config/apiConfig';

/**
 * ReservationModule.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Complete Reservation Module for Hotel Sky-5 PMS.
 * Inspired by professional PMS reservation management interfaces.
 */

export default function ReservationModule({ token, user, onNavigate, showAlert, showConfirm, fetchStatus }) {
  const [activeSubTab, setActiveSubTab] = useState('dashboard'); // 'dashboard' | 'new' | 'modify' | 'cancel' | 'report' | 'availability' | 'print'
  
  // Data state
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  // Filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [fromDateFilter, setFromDateFilter] = useState('');
  const [toDateFilter, setToDateFilter] = useState('');

  // Selected reservation for Modify / Cancel / Print
  const [selectedRes, setSelectedRes] = useState(null);

  // Form State for New / Modify Reservation
  const initialFormState = {
    id: null,
    reservationNumber: 'Auto Generated',
    guestName: '',
    phone: '',
    dateOfBirth: '',
    email: '',
    address: '',
    nationality: 'Indian',
    state: '',
    company: '',
    purpose: 'Leisure',
    arrivalDate: new Date().toISOString().slice(0, 10),
    arrivalTime: '12:00 PM',
    departureDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    adults: 1,
    children: 0,
    roomType: 'STANDARD',
    roomNumber: '',
    roomId: null,
    bookingSource: 'Direct',
    bookingMode: 'Offline',
    bookedBy: user?.fullName || user?.username || 'Reception',
    bookedByContact: user?.phone || '',
    advancePayment: 0,
    paymentMode: 'Cash',
    billingInstructions: 'Direct to Guest',
    transportMode: 'Self',
    remarks: '',
    status: 'Reserved'
  };

  const [formData, setFormData] = useState(initialFormState);
  const [availableRooms, setAvailableRooms] = useState([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [cancellationReason, setCancellationReason] = useState('');

  // Fetch reservations from API
  const fetchReservations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let url = `${API_URL}/reservations?`;
      if (statusFilter && statusFilter !== 'ALL') url += `status=${statusFilter}&`;
      if (searchQuery) url += `search=${encodeURIComponent(searchQuery)}&`;
      if (fromDateFilter) url += `fromDate=${fromDateFilter}&`;
      if (toDateFilter) url += `toDate=${toDateFilter}&`;

      const res = await fetch(url, {
        headers: getApiHeaders(token)
      });
      if (!res.ok) throw new Error('Failed to load reservations');
      const data = await res.json();
      setReservations(data.reservations || []);
    } catch (err) {
      console.error('Fetch reservations error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter, searchQuery, fromDateFilter, toDateFilter]);

  useEffect(() => {
    fetchReservations();
    const handleDateChange = () => fetchReservations();
    window.addEventListener('businessDateChanged', handleDateChange);
    return () => window.removeEventListener('businessDateChanged', handleDateChange);
  }, [fetchReservations]);

  // Fetch Available Rooms dynamically based on arrivalDate, departureDate, roomType
  const fetchAvailableRooms = useCallback(async (arrDate, depDate, rType) => {
    if (!arrDate || !depDate || arrDate >= depDate) {
      setAvailableRooms([]);
      return;
    }
    setLoadingRooms(true);
    try {
      const url = `${API_URL}/reservations/available-rooms?arrivalDate=${arrDate}&departureDate=${depDate}&roomType=${rType || 'ALL'}`;
      const res = await fetch(url, {
        headers: getApiHeaders(token)
      });
      if (res.ok) {
        const data = await res.json();
        setAvailableRooms(data.rooms || []);
      }
    } catch (e) {
      console.error('Error fetching available rooms:', e);
    } finally {
      setLoadingRooms(false);
    }
  }, [token]);

  // Trigger room availability lookup when dates or roomType change in form
  useEffect(() => {
    if (activeSubTab === 'new' || activeSubTab === 'modify') {
      fetchAvailableRooms(formData.arrivalDate, formData.departureDate, formData.roomType);
    }
  }, [formData.arrivalDate, formData.departureDate, formData.roomType, activeSubTab, fetchAvailableRooms]);

  // Form input handler
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  // Handle New Reservation Submission
  const handleCreateReservation = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    // Validation
    if (!formData.guestName.trim()) return setError('Guest Name is required');
    if (!formData.phone.trim()) return setError('Contact Phone is required');
    if (!formData.arrivalDate || !formData.departureDate) return setError('Arrival & Departure dates are required');
    if (formData.arrivalDate >= formData.departureDate) return setError('Arrival Date must be strictly before Departure Date');
    if (!formData.roomNumber) return setError('Please select an Available Room');
    if (formData.advancePayment < 0) return setError('Advance Payment cannot be negative');

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/reservations`, {
        method: 'POST',
        headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(formData)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create reservation');

      setSuccessMsg(`Reservation ${data.reservation.reservation_number} created successfully!`);
      if (showAlert) showAlert(`Reservation ${data.reservation.reservation_number} created successfully!`, 'Reservation Created');
      
      fetchReservations();
      if (fetchStatus) fetchStatus();
      
      // Reset form and return to dashboard
      setFormData(initialFormState);
      setTimeout(() => {
        setActiveSubTab('dashboard');
        setSuccessMsg(null);
      }, 1500);
    } catch (err) {
      console.error('Create reservation failed:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Handle Modify Reservation Submission
  const handleUpdateReservation = async (e) => {
    e.preventDefault();
    if (!formData.id) return setError('No reservation selected to modify');
    setError(null);
    setSuccessMsg(null);

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/reservations/${formData.id}`, {
        method: 'PUT',
        headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(formData)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update reservation');

      setSuccessMsg(`Reservation ${formData.reservationNumber} updated successfully!`);
      if (showAlert) showAlert(`Reservation ${formData.reservationNumber} updated successfully!`, 'Reservation Updated');
      
      fetchReservations();
      if (fetchStatus) fetchStatus();
      
      setTimeout(() => {
        setActiveSubTab('dashboard');
        setSuccessMsg(null);
      }, 1500);
    } catch (err) {
      console.error('Update reservation failed:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Handle Cancel Reservation
  const handleCancelReservation = async (e) => {
    e.preventDefault();
    if (!selectedRes) return setError('Please select a reservation to cancel');
    
    if (showConfirm) {
      const confirmed = await showConfirm(`Are you sure you want to cancel Reservation #${selectedRes.reservation_number}?`, 'Cancel Reservation');
      if (!confirmed) return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/reservations/${selectedRes.id}/cancel`, {
        method: 'POST',
        headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ cancellationReason })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel reservation');

      if (showAlert) showAlert(`Reservation #${selectedRes.reservation_number} has been cancelled.`, 'Reservation Cancelled');
      fetchReservations();
      if (fetchStatus) fetchStatus();
      
      setSelectedRes(null);
      setCancellationReason('');
      setActiveSubTab('dashboard');
    } catch (err) {
      console.error('Cancel reservation failed:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Handle Convert Reservation to Check-In
  const handleCheckInReservation = async (reservation) => {
    if (showConfirm) {
      const confirmed = await showConfirm(
        `Check-In guest ${reservation.guest_name} into Room ${reservation.room_number}?\nThis will set room status to Occupied and generate folio charges.`,
        'Check-In Reservation'
      );
      if (!confirmed) return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/reservations/${reservation.id}/checkin`, {
        method: 'POST',
        headers: getApiHeaders(token)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check in reservation');

      if (showAlert) showAlert(data.message, 'Check-In Complete');
      fetchReservations();
      if (fetchStatus) fetchStatus();
    } catch (err) {
      console.error('Check-in reservation failed:', err);
      if (showAlert) showAlert(err.message, 'Check-In Failed');
    } finally {
      setLoading(false);
    }
  };

  // Load selected reservation into form for Modify
  const startModify = (res) => {
    setSelectedRes(res);
    setFormData({
      id: res.id,
      reservationNumber: res.reservation_number,
      guestName: res.guest_name || '',
      phone: res.phone || '',
      dateOfBirth: res.date_of_birth || '',
      email: res.email || '',
      address: res.address || '',
      nationality: res.nationality || 'Indian',
      state: res.state || '',
      company: res.company || '',
      purpose: res.purpose || 'Leisure',
      arrivalDate: res.arrival_date || '',
      arrivalTime: res.arrival_time || '12:00 PM',
      departureDate: res.departure_date || '',
      adults: res.adults || 1,
      children: res.children || 0,
      roomType: res.room_type || 'STANDARD',
      roomNumber: res.room_number || '',
      roomId: res.room_id || null,
      bookingSource: res.booking_source || 'Direct',
      bookingMode: res.booking_mode || 'Offline',
      bookedBy: res.booked_by || '',
      bookedByContact: res.booked_by_contact || '',
      advancePayment: res.advance_payment || 0,
      paymentMode: res.payment_mode || 'Cash',
      billingInstructions: res.billing_instructions || 'Direct to Guest',
      transportMode: res.transport_mode || 'Self',
      remarks: res.remarks || '',
      status: res.status || 'Reserved'
    });
    setActiveSubTab('modify');
  };

  // Metrics computation for dashboard
  const metrics = useMemo(() => {
    const total = reservations.length;
    const reserved = reservations.filter(r => r.status === 'Reserved').length;
    const confirmed = reservations.filter(r => r.status === 'Confirmed').length;
    const checkedIn = reservations.filter(r => r.status === 'Checked-In').length;
    const cancelled = reservations.filter(r => r.status === 'Cancelled').length;
    const totalAdvance = reservations.reduce((acc, r) => acc + (r.advance_payment || 0), 0);
    return { total, reserved, confirmed, checkedIn, cancelled, totalAdvance };
  }, [reservations]);

  return (
    <div className="reservation-module-container" style={{ padding: '24px', minHeight: 'calc(100vh - 80px)', background: '#0b0f19', color: '#f8fafc' }}>
      
      {/* Module Header & Sub-Navigation Menu */}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', gap: '16px', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px', color: '#fff' }}>
            <span>📅</span> Reservation Management System
          </h2>
          <p style={{ color: '#94a3b8', fontSize: '0.85rem', margin: '4px 0 0 0' }}>
            Hotel Sky-5 Advance Bookings, Availability Calendar, Reports & Voucher Operations
          </p>
        </div>

        {/* Sub-menu Navigation Tabs (Requirement 3) */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', background: 'rgba(255,255,255,0.04)', padding: '6px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.08)' }}>
          <button 
            className={`btn-subtab ${activeSubTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveSubTab('dashboard')}
            style={subTabStyle(activeSubTab === 'dashboard')}
          >
            📊 Dashboard
          </button>
          <button 
            className={`btn-subtab ${activeSubTab === 'new' ? 'active' : ''}`}
            onClick={() => { setFormData(initialFormState); setActiveSubTab('new'); }}
            style={subTabStyle(activeSubTab === 'new')}
          >
            ➕ New Reservation
          </button>
          <button 
            className={`btn-subtab ${activeSubTab === 'modify' ? 'active' : ''}`}
            onClick={() => setActiveSubTab('modify')}
            style={subTabStyle(activeSubTab === 'modify')}
          >
            ✏️ Modify Reservation
          </button>
          <button 
            className={`btn-subtab ${activeSubTab === 'cancel' ? 'active' : ''}`}
            onClick={() => setActiveSubTab('cancel')}
            style={subTabStyle(activeSubTab === 'cancel')}
          >
            ❌ Cancel Reservation
          </button>
          <button 
            className={`btn-subtab ${activeSubTab === 'report' ? 'active' : ''}`}
            onClick={() => setActiveSubTab('report')}
            style={subTabStyle(activeSubTab === 'report')}
          >
            📈 Reservation Report
          </button>
          <button 
            className={`btn-subtab ${activeSubTab === 'availability' ? 'active' : ''}`}
            onClick={() => setActiveSubTab('availability')}
            style={subTabStyle(activeSubTab === 'availability')}
          >
            🛏️ Room Availability
          </button>
          <button 
            className={`btn-subtab ${activeSubTab === 'print' ? 'active' : ''}`}
            onClick={() => setActiveSubTab('print')}
            style={subTabStyle(activeSubTab === 'print')}
          >
            🖨️ Print Reservation
          </button>
        </div>
      </div>

      {/* Global Alerts */}
      {error && (
        <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', padding: '12px 16px', borderRadius: '8px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)} style={{ background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: '1.1rem' }}>&times;</button>
        </div>
      )}
      {successMsg && (
        <div style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: '#86efac', padding: '12px 16px', borderRadius: '8px', marginBottom: '20px' }}>
          ✓ {successMsg}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          SUB-VIEW 1: RESERVATION DASHBOARD
         ───────────────────────────────────────────────────────────────────────────── */}
      {activeSubTab === 'dashboard' && (
        <div>
          {/* Summary Metric Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <MetricCard label="Total Reservations" value={metrics.total} icon="📋" color="#38bdf8" />
            <MetricCard label="Reserved" value={metrics.reserved} icon="⏳" color="#fbbf24" />
            <MetricCard label="Confirmed" value={metrics.confirmed} icon="✅" color="#4ade80" />
            <MetricCard label="Checked-In" value={metrics.checkedIn} icon="🔑" color="#a78bfa" />
            <MetricCard label="Cancelled" value={metrics.cancelled} icon="❌" color="#f87171" />
            <MetricCard label="Advance Collected" value={`₹${metrics.totalAdvance.toLocaleString('en-IN')}`} icon="💰" color="#34d399" />
          </div>

          {/* Search & Filter Bar */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', marginBottom: '20px', background: 'rgba(255,255,255,0.03)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ flex: '1 1 240px' }}>
              <input 
                type="text" 
                placeholder="🔍 Search Guest, Phone, Res #, Room #"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
                <option value="ALL">All Statuses</option>
                <option value="Reserved">Reserved</option>
                <option value="Confirmed">Confirmed</option>
                <option value="Checked-In">Checked-In</option>
                <option value="Cancelled">Cancelled</option>
              </select>
            </div>
            <div>
              <input 
                type="date" 
                value={fromDateFilter} 
                onChange={(e) => setFromDateFilter(e.target.value)}
                style={inputStyle}
                placeholder="From Date"
              />
            </div>
            <div>
              <input 
                type="date" 
                value={toDateFilter} 
                onChange={(e) => setToDateFilter(e.target.value)}
                style={inputStyle}
                placeholder="To Date"
              />
            </div>
            <button className="btn-secondary" onClick={fetchReservations} style={{ padding: '9px 16px', fontSize: '0.85rem' }}>
              🔄 Refresh
            </button>
          </div>

          {/* Reservations Table */}
          <div style={{ overflowX: 'auto', background: 'rgba(15, 23, 42, 0.6)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
            <table className="ledger-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.05)', textAlign: 'left' }}>
                  <th style={thStyle}>Res #</th>
                  <th style={thStyle}>Guest Name</th>
                  <th style={thStyle}>Contact</th>
                  <th style={thStyle}>Room</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Arrival</th>
                  <th style={thStyle}>Departure</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Advance</th>
                  <th style={{ ...thStyle, textAlign: 'center' }}>Status</th>
                  <th style={{ ...thStyle, textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan="10" style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                      ⏳ Loading reservations...
                    </td>
                  </tr>
                ) : reservations.length === 0 ? (
                  <tr>
                    <td colSpan="10" style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                      📭 No reservations found matching criteria.
                    </td>
                  </tr>
                ) : (
                  reservations.map((res) => (
                    <tr key={res.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.2s' }}>
                      <td style={{ ...tdStyle, fontFamily: 'monospace', fontWeight: 'bold', color: '#38bdf8' }}>
                        {res.reservation_number}
                      </td>
                      <td style={{ ...tdStyle, fontWeight: '600', color: '#fff' }}>
                        {res.guest_name}
                      </td>
                      <td style={tdStyle}>{res.phone}</td>
                      <td style={{ ...tdStyle, fontWeight: 'bold', color: '#facc15' }}>
                        Room {res.room_number || 'Unassigned'}
                      </td>
                      <td style={tdStyle}>{res.room_type}</td>
                      <td style={{ ...tdStyle, color: '#38bdf8' }}>{res.arrival_date}</td>
                      <td style={{ ...tdStyle, color: '#818cf8' }}>{res.departure_date}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: '700', color: '#34d399' }}>
                        ₹{(res.advance_payment || 0).toLocaleString('en-IN')}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>
                        <StatusBadge status={res.status} />
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'center' }}>
                          <button 
                            title="View / Print Voucher"
                            onClick={() => { setSelectedRes(res); setActiveSubTab('print'); }}
                            style={actionBtnStyle('#38bdf8')}
                          >
                            👁️
                          </button>
                          <button 
                            title="Modify Reservation"
                            onClick={() => startModify(res)}
                            style={actionBtnStyle('#facc15')}
                          >
                            ✏️
                          </button>
                          {res.status !== 'Checked-In' && res.status !== 'Cancelled' && (
                            <>
                              <button 
                                title="Check-In Guest"
                                onClick={() => handleCheckInReservation(res)}
                                style={actionBtnStyle('#4ade80')}
                              >
                                🔑
                              </button>
                              <button 
                                title="Cancel Reservation"
                                onClick={() => { setSelectedRes(res); setActiveSubTab('cancel'); }}
                                style={actionBtnStyle('#f87171')}
                              >
                                ❌
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          SUB-VIEW 2 & 3: NEW / MODIFY RESERVATION FORM (Requirement 4 & 5)
         ───────────────────────────────────────────────────────────────────────────── */}
      {/* ─────────────────────────────────────────────────────────────────────────────
          SUB-VIEW 2b: MODIFY RESERVATION — SELECTION GATE
          Reuses the Cancel Reservation picker pattern. The edit form below must
          never render for 'modify' until a real reservation is bound to formData.id
          (via startModify), regardless of how the 'modify' tab was reached.
         ───────────────────────────────────────────────────────────────────────────── */}
      {activeSubTab === 'modify' && !formData.id && (
        <div style={{ maxWidth: '600px', margin: '0 auto', background: 'rgba(15,23,42,0.8)', padding: '24px', borderRadius: '12px', border: '1px solid rgba(250,204,21,0.2)' }}>
          <h3 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#facc15', marginBottom: '16px' }}>
            ✏️ Modify Reservation
          </h3>

          <div style={formGroupStyle}>
            <label style={labelStyle}>Select Reservation to Modify</label>
            <select
              value=""
              onChange={(e) => {
                const found = reservations.find(r => String(r.id) === String(e.target.value));
                if (found) startModify(found);
              }}
              style={selectStyle}
            >
              <option value="">-- Select Reservation --</option>
              {reservations.filter(r => r.status !== 'Cancelled' && r.status !== 'Checked-In').map(r => (
                <option key={r.id} value={r.id}>
                  #{r.reservation_number} - {r.guest_name} (Room {r.room_number})
                </option>
              ))}
            </select>
            {reservations.length === 0 && (
              <p style={{ color: '#94a3b8', fontSize: '0.75rem', marginTop: '8px' }}>
                No reservations available to modify.
              </p>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
            <button type="button" className="btn-secondary" onClick={() => setActiveSubTab('dashboard')}>
              Back
            </button>
          </div>
        </div>
      )}

      {(activeSubTab === 'new' || (activeSubTab === 'modify' && formData.id)) && (
        <form onSubmit={activeSubTab === 'new' ? handleCreateReservation : handleUpdateReservation}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0, color: '#fff' }}>
              {activeSubTab === 'new' ? '➕ Create New Reservation' : `✏️ Modify Reservation: ${formData.reservationNumber}`}
            </h3>
            <button 
              type="button" 
              className="btn-secondary" 
              onClick={() => setActiveSubTab('dashboard')}
              style={{ fontSize: '0.85rem', padding: '6px 14px' }}
            >
              ← Back to Dashboard
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
            
            {/* CARD 1: Guest Information */}
            <div style={cardStyle}>
              <h4 style={cardTitleStyle}>👤 Guest Details</h4>
              <div style={formGroupStyle}>
                <label style={labelStyle}>Reservation Number</label>
                <input type="text" value={formData.reservationNumber} disabled style={{ ...inputStyle, background: 'rgba(0,0,0,0.4)', color: '#38bdf8', fontWeight: 'bold' }} />
              </div>
              <div style={formGroupStyle}>
                <label style={labelStyle}>Guest Full Name *</label>
                <input type="text" name="guestName" value={formData.guestName} onChange={handleInputChange} required placeholder="Enter guest full name" style={inputStyle} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Contact Phone *</label>
                  <input type="text" name="phone" value={formData.phone} onChange={handleInputChange} required placeholder="+91 9876543210" style={inputStyle} />
                </div>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Date of Birth (Optional)</label>
                  <input type="date" name="dateOfBirth" value={formData.dateOfBirth} onChange={handleInputChange} style={inputStyle} />
                </div>
              </div>
              <div style={formGroupStyle}>
                <label style={labelStyle}>Email Address</label>
                <input type="email" name="email" value={formData.email} onChange={handleInputChange} placeholder="guest@example.com" style={inputStyle} />
              </div>
              <div style={formGroupStyle}>
                <label style={labelStyle}>Residential Address</label>
                <input type="text" name="address" value={formData.address} onChange={handleInputChange} placeholder="Street address, city" style={inputStyle} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Nationality</label>
                  <input type="text" name="nationality" value={formData.nationality} onChange={handleInputChange} style={inputStyle} />
                </div>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>State / Province</label>
                  <input type="text" name="state" value={formData.state} onChange={handleInputChange} placeholder="e.g. Maharashtra" style={inputStyle} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Company / Org</label>
                  <input type="text" name="company" value={formData.company} onChange={handleInputChange} placeholder="Company name" style={inputStyle} />
                </div>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Purpose of Visit</label>
                  <select name="purpose" value={formData.purpose} onChange={handleInputChange} style={selectStyle}>
                    <option value="Leisure">Leisure / Vacation</option>
                    <option value="Business">Business Travel</option>
                    <option value="Event">Event / Wedding</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>
            </div>

            {/* CARD 2: Stay & Room Allocation Details */}
            <div style={cardStyle}>
              <h4 style={cardTitleStyle}>🛏️ Stay & Room Allocation</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Arrival Date *</label>
                  <input type="date" name="arrivalDate" value={formData.arrivalDate} onChange={handleInputChange} required style={inputStyle} />
                </div>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Arrival Time</label>
                  <input type="text" name="arrivalTime" value={formData.arrivalTime} onChange={handleInputChange} placeholder="12:00 PM" style={inputStyle} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Departure Date *</label>
                  <input type="date" name="departureDate" value={formData.departureDate} onChange={handleInputChange} required style={inputStyle} />
                </div>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Adults / Children</label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input type="number" min="1" max="10" name="adults" value={formData.adults} onChange={handleInputChange} style={inputStyle} placeholder="Adults" />
                    <input type="number" min="0" max="10" name="children" value={formData.children} onChange={handleInputChange} style={inputStyle} placeholder="Children" />
                  </div>
                </div>
              </div>
              <div style={formGroupStyle}>
                <label style={labelStyle}>Room Category / Type *</label>
                <select name="roomType" value={formData.roomType} onChange={handleInputChange} style={selectStyle}>
                  <option value="STANDARD">Standard Cozy Room (₹1,500/night)</option>
                  <option value="EXECUTIVE">Executive Work Room (₹2,000/night)</option>
                  <option value="PREMIUM">Premium Suite Room (₹2,500/night)</option>
                </select>
              </div>

              <div style={formGroupStyle}>
                <label style={labelStyle}>
                  Available Room Selection * {loadingRooms && <span style={{ color: '#38bdf8', fontSize: '0.75rem' }}>(Checking availability...)</span>}
                </label>
                <select 
                  name="roomNumber" 
                  value={formData.roomNumber} 
                  onChange={(e) => {
                    const selectedNum = e.target.value;
                    const matchedRoom = availableRooms.find(r => r.number === selectedNum);
                    setFormData(prev => ({
                      ...prev,
                      roomNumber: selectedNum,
                      roomId: matchedRoom ? matchedRoom.id : null
                    }));
                  }} 
                  required 
                  style={{ ...selectStyle, borderColor: formData.roomNumber ? '#4ade80' : 'rgba(255,255,255,0.1)' }}
                >
                  <option value="">-- Select Available Room --</option>
                  {availableRooms.map(r => (
                    <option key={r.id} value={r.number}>
                      Room #{r.number} ({r.title || r.room_type} - ₹{r.base_rate}/night)
                    </option>
                  ))}
                </select>
                {availableRooms.length === 0 && !loadingRooms && (
                  <p style={{ color: '#f87171', fontSize: '0.75rem', marginTop: '4px' }}>
                    ⚠️ No vacant rooms available for specified dates and room category.
                  </p>
                )}
              </div>

              {activeSubTab === 'modify' && (
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Reservation Status</label>
                  <select name="status" value={formData.status} onChange={handleInputChange} style={selectStyle}>
                    <option value="Reserved">Reserved</option>
                    <option value="Confirmed">Confirmed</option>
                    <option value="Checked-In">Checked-In</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>
                </div>
              )}
            </div>

            {/* CARD 3: Booking Source & Billing */}
            <div style={cardStyle}>
              <h4 style={cardTitleStyle}>💳 Booking Source & Payment</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Booking Source</label>
                  <select name="bookingSource" value={formData.bookingSource} onChange={handleInputChange} style={selectStyle}>
                    <option value="Direct">Direct / Front Desk</option>
                    <option value="Website">Hotel Website</option>
                    <option value="OTA">OTA / MakeMyTrip / Booking.com</option>
                    <option value="Corporate">Corporate Client</option>
                    <option value="Agent">Travel Agent</option>
                  </select>
                </div>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Booking Mode</label>
                  <select name="bookingMode" value={formData.bookingMode} onChange={handleInputChange} style={selectStyle}>
                    <option value="Offline">Offline / Desk</option>
                    <option value="Online">Online Portal</option>
                    <option value="Phone">Phone Call</option>
                    <option value="Email">Email Request</option>
                  </select>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Booked By Name</label>
                  <input type="text" name="bookedBy" value={formData.bookedBy} onChange={handleInputChange} style={inputStyle} />
                </div>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Booked By Contact</label>
                  <input type="text" name="bookedByContact" value={formData.bookedByContact} onChange={handleInputChange} style={inputStyle} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Advance Payment (₹)</label>
                  <input type="number" min="0" name="advancePayment" value={formData.advancePayment} onChange={handleInputChange} style={{ ...inputStyle, color: '#34d399', fontWeight: 'bold' }} />
                </div>
                <div style={formGroupStyle}>
                  <label style={labelStyle}>Payment Mode</label>
                  <select name="paymentMode" value={formData.paymentMode} onChange={handleInputChange} style={selectStyle}>
                    <option value="Cash">Cash</option>
                    <option value="Credit Card">Credit Card</option>
                    <option value="Debit Card">Debit Card</option>
                    <option value="UPI">UPI / GPay / PhonePe</option>
                    <option value="Bank Transfer">Bank Transfer</option>
                  </select>
                </div>
              </div>

              <div style={formGroupStyle}>
                <label style={labelStyle}>Billing Instructions</label>
                <select name="billingInstructions" value={formData.billingInstructions} onChange={handleInputChange} style={selectStyle}>
                  <option value="Direct to Guest">Direct to Guest</option>
                  <option value="Bill to Company">Bill to Company</option>
                  <option value="Room Tariff Only">Room Tariff Only</option>
                  <option value="EP Plan">EP Plan (European Plan - Room Only)</option>
                  <option value="CP Plan">CP Plan (Continental Plan - Breakfast)</option>
                  <option value="MAP Plan">MAP Plan (Modified American Plan - Breakfast + Dinner)</option>
                  <option value="AP Plan">AP Plan (American Plan - All Meals)</option>
                </select>
              </div>

              <div style={formGroupStyle}>
                <label style={labelStyle}>Transport Mode</label>
                <select name="transportMode" value={formData.transportMode} onChange={handleInputChange} style={selectStyle}>
                  <option value="Self">Self / Personal Vehicle</option>
                  <option value="Taxi">Taxi / Cab</option>
                  <option value="Flight">Flight</option>
                  <option value="Train">Train</option>
                  <option value="Airport Pickup Required">Airport Pickup Required</option>
                </select>
              </div>

              <div style={formGroupStyle}>
                <label style={labelStyle}>Special Remarks / Notes</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleInputChange} rows="2" placeholder="High floor, extra bed, early check-in notes..." style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
            </div>

          </div>

          <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
            <button type="button" className="btn-secondary" onClick={() => setActiveSubTab('dashboard')}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={loading} style={{ padding: '10px 24px', background: 'var(--accent-grad)', fontWeight: 700 }}>
              {loading ? 'Saving...' : activeSubTab === 'new' ? 'Create Reservation' : 'Update Reservation'}
            </button>
          </div>
        </form>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          SUB-VIEW 4: CANCEL RESERVATION (Requirement 6)
         ───────────────────────────────────────────────────────────────────────────── */}
      {activeSubTab === 'cancel' && (
        <div style={{ maxWidth: '600px', margin: '0 auto', background: 'rgba(15,23,42,0.8)', padding: '24px', borderRadius: '12px', border: '1px solid rgba(239,68,68,0.2)' }}>
          <h3 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#f87171', marginBottom: '16px' }}>
            ❌ Cancel Reservation
          </h3>

          <div style={formGroupStyle}>
            <label style={labelStyle}>Select Reservation to Cancel</label>
            <select
              value={selectedRes ? selectedRes.id : ''}
              onChange={(e) => {
                const found = reservations.find(r => String(r.id) === String(e.target.value));
                setSelectedRes(found || null);
              }}
              style={selectStyle}
            >
              <option value="">-- Select Reservation --</option>
              {reservations.filter(r => r.status !== 'Cancelled' && r.status !== 'Checked-In').map(r => (
                <option key={r.id} value={r.id}>
                  #{r.reservation_number} - {r.guest_name} (Room {r.room_number})
                </option>
              ))}
            </select>
          </div>

          {selectedRes && (
            <div style={{ background: 'rgba(255,255,255,0.03)', padding: '16px', borderRadius: '8px', marginBottom: '20px', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p><strong>Reservation #:</strong> <span style={{ color: '#38bdf8' }}>{selectedRes.reservation_number}</span></p>
              <p><strong>Guest Name:</strong> {selectedRes.guest_name}</p>
              <p><strong>Contact:</strong> {selectedRes.phone}</p>
              <p><strong>Stay Dates:</strong> {selectedRes.arrival_date} to {selectedRes.departure_date}</p>
              <p><strong>Advance Amount Paid:</strong> ₹{(selectedRes.advance_payment || 0).toLocaleString('en-IN')}</p>
            </div>
          )}

          <form onSubmit={handleCancelReservation}>
            <div style={formGroupStyle}>
              <label style={labelStyle}>Reason for Cancellation *</label>
              <textarea 
                value={cancellationReason} 
                onChange={(e) => setCancellationReason(e.target.value)} 
                required 
                rows="3" 
                placeholder="Enter cancellation reason (e.g. Guest travel plan changed)" 
                style={inputStyle} 
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '20px' }}>
              <button type="button" className="btn-secondary" onClick={() => setActiveSubTab('dashboard')}>
                Back
              </button>
              <button type="submit" disabled={loading || !selectedRes} style={{ padding: '10px 20px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 700, cursor: 'pointer' }}>
                {loading ? 'Cancelling...' : 'Confirm Cancellation'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          SUB-VIEW 5: RESERVATION REPORT
         ───────────────────────────────────────────────────────────────────────────── */}
      {activeSubTab === 'report' && (
        <ReservationReportView reservations={reservations} token={token} />
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          SUB-VIEW 6: ROOM AVAILABILITY MATRIX
         ───────────────────────────────────────────────────────────────────────────── */}
      {activeSubTab === 'availability' && (
        <RoomAvailabilityGrid reservations={reservations} token={token} />
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          SUB-VIEW 7: PRINT RESERVATION VOUCHER
         ───────────────────────────────────────────────────────────────────────────── */}
      {activeSubTab === 'print' && (
        <PrintReservationVoucher reservations={reservations} selectedRes={selectedRes} setSelectedRes={setSelectedRes} />
      )}

    </div>
  );
}

// ── Sub-component 1: Status Badge ──────────────────────────────────────────────
function StatusBadge({ status }) {
  let bg = 'rgba(148, 163, 184, 0.15)';
  let color = '#94a3b8';
  let border = '1px solid rgba(148, 163, 184, 0.3)';

  if (status === 'Reserved') {
    bg = 'rgba(251, 191, 36, 0.12)';
    color = '#fbbf24';
    border = '1px solid rgba(251, 191, 36, 0.3)';
  } else if (status === 'Confirmed') {
    bg = 'rgba(56, 189, 248, 0.12)';
    color = '#38bdf8';
    border = '1px solid rgba(56, 189, 248, 0.3)';
  } else if (status === 'Checked-In') {
    bg = 'rgba(74, 222, 128, 0.12)';
    color = '#4ade80';
    border = '1px solid rgba(74, 222, 128, 0.3)';
  } else if (status === 'Cancelled') {
    bg = 'rgba(248, 113, 113, 0.12)';
    color = '#f87171';
    border = '1px solid rgba(248, 113, 113, 0.3)';
  }

  return (
    <span style={{ background: bg, color, border, padding: '3px 10px', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase' }}>
      {status}
    </span>
  );
}

// ── Sub-component 2: Metric Card ─────────────────────────────────────────────
function MetricCard({ label, value, icon, color }) {
  return (
    <div style={{ background: 'rgba(15, 23, 42, 0.6)', padding: '16px', borderRadius: '12px', border: `1px solid ${color}30`, display: 'flex', alignItems: 'center', gap: '14px' }}>
      <div style={{ fontSize: '2rem', background: `${color}15`, padding: '10px', borderRadius: '10px' }}>
        {icon}
      </div>
      <div>
        <div style={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase' }}>{label}</div>
        <div style={{ fontSize: '1.4rem', fontWeight: 800, color: color, marginTop: '2px' }}>{value}</div>
      </div>
    </div>
  );
}

// ── Sub-component 3: Reservation Report View ───────────────────────────────
function ReservationReportView({ reservations }) {
  const [repStatus, setRepStatus] = useState('ALL');
  const [repType, setRepType] = useState('ALL');

  const filtered = useMemo(() => {
    return reservations.filter(r => {
      if (repStatus !== 'ALL' && r.status !== repStatus) return false;
      if (repType !== 'ALL' && r.room_type !== repType) return false;
      return true;
    });
  }, [reservations, repStatus, repType]);

  const totalAdvance = filtered.reduce((acc, r) => acc + (r.advance_payment || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0, color: '#fff' }}>
          📈 Reservation Performance Report
        </h3>
        <button className="btn-primary" onClick={() => window.print()} style={{ padding: '8px 16px', fontSize: '0.85rem' }}>
          🖨️ Print Report
        </button>
      </div>

      {/* Filter controls */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
        <select value={repStatus} onChange={(e) => setRepStatus(e.target.value)} style={selectStyle}>
          <option value="ALL">All Statuses</option>
          <option value="Reserved">Reserved</option>
          <option value="Confirmed">Confirmed</option>
          <option value="Checked-In">Checked-In</option>
          <option value="Cancelled">Cancelled</option>
        </select>
        <select value={repType} onChange={(e) => setRepType(e.target.value)} style={selectStyle}>
          <option value="ALL">All Room Types</option>
          <option value="STANDARD">Standard Cozy Room</option>
          <option value="EXECUTIVE">Executive Work Room</option>
          <option value="PREMIUM">Premium Suite Room</option>
        </select>
      </div>

      <div style={{ background: 'rgba(15,23,42,0.6)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)', marginBottom: '20px', display: 'flex', gap: '30px' }}>
        <div>Total Filtered Records: <strong>{filtered.length}</strong></div>
        <div>Total Advance Collected: <strong style={{ color: '#34d399' }}>₹{totalAdvance.toLocaleString('en-IN')}</strong></div>
      </div>

      <div style={{ overflowX: 'auto', background: 'rgba(15, 23, 42, 0.6)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
        <table className="ledger-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.05)', textAlign: 'left' }}>
              <th style={thStyle}>Res #</th>
              <th style={thStyle}>Guest Name</th>
              <th style={thStyle}>Phone</th>
              <th style={thStyle}>Room #</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Arrival</th>
              <th style={thStyle}>Departure</th>
              <th style={thStyle}>Source</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Advance (₹)</th>
              <th style={{ ...thStyle, textAlign: 'center' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ ...tdStyle, fontFamily: 'monospace', fontWeight: 'bold' }}>{r.reservation_number}</td>
                <td style={{ ...tdStyle, fontWeight: '600' }}>{r.guest_name}</td>
                <td style={tdStyle}>{r.phone}</td>
                <td style={tdStyle}>Room {r.room_number}</td>
                <td style={tdStyle}>{r.room_type}</td>
                <td style={tdStyle}>{r.arrival_date}</td>
                <td style={tdStyle}>{r.departure_date}</td>
                <td style={tdStyle}>{r.booking_source}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 'bold' }}>₹{(r.advance_payment || 0).toLocaleString('en-IN')}</td>
                <td style={{ ...tdStyle, textAlign: 'center' }}><StatusBadge status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Sub-component 4: Room Availability Grid Matrix ───────────────────────────
function RoomAvailabilityGrid({ reservations }) {
  const roomList = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14', '16', '17', '19', '20'];
  
  // Generate next 7 days dates starting today
  const dates = useMemo(() => {
    const arr = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      arr.push(d.toISOString().slice(0, 10));
    }
    return arr;
  }, []);

  return (
    <div>
      <h3 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#fff', marginBottom: '16px' }}>
        🛏️ 7-Day Room Availability Calendar Matrix
      </h3>

      <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', fontSize: '0.8rem', color: '#94a3b8' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span style={{ width: 12, height: 12, background: '#22c55e', borderRadius: 3, display: 'inline-block' }}></span> Vacant / Available</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span style={{ width: 12, height: 12, background: '#a855f7', borderRadius: 3, display: 'inline-block' }}></span> Reserved / Confirmed</div>
      </div>

      <div style={{ overflowX: 'auto', background: 'rgba(15,23,42,0.6)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.05)' }}>
              <th style={{ ...thStyle, width: '100px' }}>Room #</th>
              {dates.map(d => (
                <th key={d} style={{ ...thStyle, textAlign: 'center' }}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roomList.map(rNum => (
              <tr key={rNum} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ ...tdStyle, fontWeight: 'bold', color: '#fff' }}>Room {rNum}</td>
                {dates.map(d => {
                  const isReserved = reservations.some(res => 
                    res.room_number === rNum && 
                    res.status !== 'Cancelled' &&
                    d >= res.arrival_date && d < res.departure_date
                  );
                  return (
                    <td key={d} style={{ ...tdStyle, textAlign: 'center', padding: '12px 6px' }}>
                      <span style={{
                        display: 'inline-block',
                        padding: '4px 10px',
                        borderRadius: '6px',
                        fontSize: '0.75rem',
                        fontWeight: '700',
                        background: isReserved ? 'rgba(168,85,247,0.2)' : 'rgba(34,197,94,0.15)',
                        color: isReserved ? '#c084fc' : '#4ade80',
                        border: `1px solid ${isReserved ? 'rgba(168,85,247,0.4)' : 'rgba(34,197,94,0.3)'}`
                      }}>
                        {isReserved ? 'Reserved' : 'Available'}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Sub-component 5: Print Reservation Voucher ──────────────────────────────
function PrintReservationVoucher({ reservations, selectedRes, setSelectedRes }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#fff', margin: 0 }}>
          🖨️ Reservation Confirmation Voucher
        </h3>
        {selectedRes && (
          <button className="btn-primary" onClick={() => window.print()} style={{ padding: '8px 16px' }}>
            🖨️ Print Voucher
          </button>
        )}
      </div>

      <div style={formGroupStyle}>
        <label style={labelStyle}>Select Reservation to Print</label>
        <select
          value={selectedRes ? selectedRes.id : ''}
          onChange={(e) => {
            const found = reservations.find(r => String(r.id) === String(e.target.value));
            setSelectedRes(found || null);
          }}
          style={{ ...selectStyle, maxWidth: '400px' }}
        >
          <option value="">-- Select Reservation Voucher --</option>
          {reservations.map(r => (
            <option key={r.id} value={r.id}>
              #{r.reservation_number} - {r.guest_name} (Room {r.room_number})
            </option>
          ))}
        </select>
      </div>

      {selectedRes ? (
        <div className="printable-voucher" style={{ background: '#fff', color: '#0f172a', padding: '40px', borderRadius: '12px', maxWidth: '800px', margin: '20px auto', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.5)' }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #0f172a', paddingBottom: '20px', marginBottom: '24px' }}>
            <div>
              <h1 style={{ fontSize: '1.8rem', fontWeight: 900, color: '#0369a1', margin: 0 }}>HOTEL SKY-5</h1>
              <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: '#475569' }}>Luxury Accommodations & Hospitality Services</p>
              <p style={{ margin: '2px 0 0 0', fontSize: '0.8rem', color: '#64748b' }}>Phone: +91 9876543210 | Email: reservations@sky5hotel.com</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 800, color: '#0f172a', margin: 0 }}>RESERVATION VOUCHER</h2>
              <div style={{ fontFamily: 'monospace', fontSize: '1rem', fontWeight: 700, color: '#0284c7', marginTop: '4px' }}>
                {selectedRes.reservation_number}
              </div>
              <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '4px' }}>
                Status: <strong>{selectedRes.status}</strong>
              </div>
            </div>
          </div>

          {/* Details Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
            <div>
              <h4 style={{ fontSize: '0.9rem', color: '#0369a1', textTransform: 'uppercase', marginBottom: '8px', borderBottom: '1px solid #e2e8f0', paddingBottom: '4px' }}>Guest Information</h4>
              <p style={{ margin: '4px 0' }}><strong>Full Name:</strong> {selectedRes.guest_name}</p>
              <p style={{ margin: '4px 0' }}><strong>Phone:</strong> {selectedRes.phone}</p>
              <p style={{ margin: '4px 0' }}><strong>Email:</strong> {selectedRes.email || 'N/A'}</p>
              <p style={{ margin: '4px 0' }}><strong>Address:</strong> {selectedRes.address || 'N/A'}</p>
              <p style={{ margin: '4px 0' }}><strong>Company:</strong> {selectedRes.company || 'N/A'}</p>
            </div>

            <div>
              <h4 style={{ fontSize: '0.9rem', color: '#0369a1', textTransform: 'uppercase', marginBottom: '8px', borderBottom: '1px solid #e2e8f0', paddingBottom: '4px' }}>Booking & Stay Details</h4>
              <p style={{ margin: '4px 0' }}><strong>Room Allocated:</strong> Room #{selectedRes.room_number} ({selectedRes.room_type})</p>
              <p style={{ margin: '4px 0' }}><strong>Check-In Date:</strong> {selectedRes.arrival_date} ({selectedRes.arrival_time || '12:00 PM'})</p>
              <p style={{ margin: '4px 0' }}><strong>Check-Out Date:</strong> {selectedRes.departure_date}</p>
              <p style={{ margin: '4px 0' }}><strong>Guests:</strong> {selectedRes.adults} Adult(s), {selectedRes.children} Child(ren)</p>
              <p style={{ margin: '4px 0' }}><strong>Booking Source:</strong> {selectedRes.booking_source} ({selectedRes.booking_mode})</p>
            </div>
          </div>

          {/* Payment & Billing */}
          <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '24px' }}>
            <h4 style={{ fontSize: '0.9rem', color: '#0369a1', textTransform: 'uppercase', margin: '0 0 10px 0' }}>Payment & Advance Receipt</h4>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.95rem' }}>
              <span>Advance Payment Collected ({selectedRes.payment_mode || 'Cash'}):</span>
              <strong style={{ fontSize: '1.1rem', color: '#16a34a' }}>₹{(selectedRes.advance_payment || 0).toLocaleString('en-IN')}</strong>
            </div>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '6px' }}>
              Billing Instructions: {selectedRes.billing_instructions || 'Direct to Guest'}
            </div>
          </div>

          {/* Policy Notes & Signatures */}
          <div style={{ fontSize: '0.75rem', color: '#64748b', lineHeight: 1.5, borderTop: '1px solid #e2e8f0', paddingTop: '16px' }}>
            <p style={{ margin: '0 0 4px 0' }}><strong>Hotel Policies:</strong> Check-in time is 12:00 PM and check-out time is 11:00 AM. Government-issued photo ID required at check-in.</p>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '50px', paddingTop: '20px', borderTop: '1px dashed #cbd5e1' }}>
            <div style={{ textAlign: 'center', width: '200px' }}>
              <div style={{ borderBottom: '1px solid #0f172a', marginBottom: '4px', height: '30px' }}></div>
              <span style={{ fontSize: '0.75rem', color: '#475569' }}>Guest Signature</span>
            </div>
            <div style={{ textAlign: 'center', width: '200px' }}>
              <div style={{ borderBottom: '1px solid #0f172a', marginBottom: '4px', height: '30px' }}></div>
              <span style={{ fontSize: '0.75rem', color: '#475569' }}>Authorized Desk Signature</span>
            </div>
          </div>
        </div>
      ) : (
        <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>Please select a reservation above to generate printable voucher.</p>
      )}
    </div>
  );
}

// ── Shared Inline Style Tokens ─────────────────────────────────────────────
const subTabStyle = (active) => ({
  background: active ? 'var(--accent-grad, linear-gradient(135deg, #38bdf8 0%, #818cf8 100%))' : 'transparent',
  color: active ? '#fff' : '#94a3b8',
  border: 'none',
  padding: '8px 14px',
  borderRadius: '8px',
  fontSize: '0.82rem',
  fontWeight: active ? '700' : '600',
  cursor: 'pointer',
  transition: 'all 0.2s ease'
});

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '8px',
  color: '#fff',
  fontSize: '0.85rem',
  outline: 'none'
};

const selectStyle = {
  ...inputStyle,
  cursor: 'pointer',
  background: '#0f172a'
};

const labelStyle = {
  display: 'block',
  fontSize: '0.78rem',
  fontWeight: '600',
  color: '#cbd5e1',
  marginBottom: '4px'
};

const formGroupStyle = {
  marginBottom: '12px'
};

const cardStyle = {
  background: 'rgba(15, 23, 42, 0.6)',
  padding: '20px',
  borderRadius: '12px',
  border: '1px solid rgba(255,255,255,0.08)'
};

const cardTitleStyle = {
  fontSize: '1rem',
  fontWeight: '700',
  color: '#38bdf8',
  marginTop: 0,
  marginBottom: '16px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  paddingBottom: '8px'
};

const thStyle = {
  padding: '12px 14px',
  color: '#cbd5e1',
  fontWeight: '700'
};

const tdStyle = {
  padding: '12px 14px',
  color: '#e2e8f0'
};

const actionBtnStyle = (color) => ({
  background: `${color}15`,
  border: `1px solid ${color}30`,
  color: color,
  borderRadius: '6px',
  padding: '5px 8px',
  cursor: 'pointer',
  fontSize: '0.85rem'
});
