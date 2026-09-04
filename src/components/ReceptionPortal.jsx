/**
 * ReceptionPortal.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Front Office Module — Full Implementation
 *
 * Reuses ALL existing booking and room APIs.
 * Does NOT modify Admin Portal, Guest Portal, or any business logic.
 *
 * Features:
 *   Quick Check-In       → POST /api/rooms/:number/checkin
 *   Quick Check-Out      → POST /api/rooms/:number/checkout
 *   Walk-In Guest        → POST /api/rooms/:number/checkin  (same, no booking_id)
 *   Assign Room          → PUT  /api/rooms/:number/checkin
 *   Room Shift           → POST /api/rooms/shift
 *   Extend Stay          → POST /api/rooms/:number/extend-stay  [NEW]
 *   Late Checkout        → POST /api/rooms/:number/late-checkout [NEW]
 *   Early Check-In       → POST /api/rooms/:number/checkin  (same, with note)
 *   Guest Search         → GET  /api/admin/guests/search
 *   Reservation Search   → GET  /api/status (upcomingReservations)
 *   Booking Cancellation → POST /api/rooms/:number/refund-checkout
 *   No Show              → POST /api/rooms/:number/no-show  [NEW]
 *
 * Verified non-breaking:
 *   Admin Check-In:  /admin/dashboard still uses its own CheckInModal + App.jsx
 *   Admin Check-Out: /admin/dashboard still uses its own CheckOutModal + App.jsx
 *   Room Shift:      /admin/dashboard still uses its own RoomShiftingModal
 *   Billing:         CheckOutModal + RefundCheckoutModal in admin unchanged
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AdminAuthContext } from '../contexts/AdminAuthContext';
import ReservationModule from './ReservationModule';
import LedgerPanel from './LedgerPanel';
import FoodPOS from './food/FoodPOS';
import { getDefaultExpectedCheckoutInput, formatDateOnly, formatExpectedCheckout } from '../utils/dateFormatter';

import { API_URL as API, getApiHeaders } from '../config/apiConfig';


// ── Status styling ───────────────────────────────────────────────────────────
const STATUS_STYLE = {
  vacant:   { bg: 'rgba(56,189,248,0.08)',  border: 'rgba(56,189,248,0.25)',  text: '#38bdf8',  label: 'VACANT'   },
  occupied: { bg: 'rgba(248,113,113,0.1)',  border: 'rgba(248,113,113,0.3)',  text: '#f87171',  label: 'OCCUPIED' },
  dirty:    { bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.25)',  text: '#fbbf24',  label: 'DIRTY'    },
  booked:   { bg: 'rgba(139,92,246,0.1)',   border: 'rgba(139,92,246,0.3)',   text: '#a78bfa',  label: 'BOOKED'   },
  inactive: { bg: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.2)',  text: '#94a3b8',  label: 'INACTIVE' },
};

const SIDEBAR_ITEMS = [
  { id: 'frontdesk',    icon: '🛎️', label: 'Front Office'       },
  { id: 'reservations', icon: '📅', label: 'Reservations'       },
  { id: 'guests',       icon: '🔍', label: 'Guest Search'       },
  { id: 'requests',     icon: '📩', label: 'Guest Requests'     },
  { id: 'food',         icon: '🍽️', label: 'Food & Beverage'    },
  { id: 'cash',         icon: '💵', label: 'Cash Handover'      },
];

const QUICK_ACTIONS = [
  { id: 'walkin',        icon: '🚶', label: 'Walk-In',        color: '#34d399' },
  { id: 'checkin',       icon: '🔑', label: 'Check-In',       color: '#38bdf8' },
  { id: 'checkout',      icon: '🧾', label: 'Check-Out',      color: '#f97316' },
  { id: 'assign',        icon: '🛏️', label: 'Assign Room',    color: '#818cf8' },
  { id: 'shift',         icon: '🔄', label: 'Room Shift',     color: '#a78bfa' },
  { id: 'extend',        icon: '📆', label: 'Extend Stay',    color: '#fbbf24' },
  { id: 'late',          icon: '🕐', label: 'Late Checkout',  color: '#fb923c' },
  { id: 'early',         icon: '⏰', label: 'Early Check-In', color: '#4ade80' },
  { id: 'noshow',        icon: '❌', label: 'No Show',        color: '#f43f5e' },
  { id: 'cancel',        icon: '💸', label: 'Cancel Booking', color: '#c084fc' },
];

// ── Time hook ────────────────────────────────────────────────────────────────
function useTime() {
  const [t, setT] = useState('');
  useEffect(() => {
    const tick = () => {
      const n = new Date();
      let h = n.getHours(), m = n.getMinutes(), s = n.getSeconds();
      const a = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      setT(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')} ${a}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}

// ── Shared API helper ─────────────────────────────────────────────────────────
async function apiCall(method, path, body, token) {
  const opts = {
    method,
    headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message || 'Request failed');
  return data;
}


// ── Inline field styles ───────────────────────────────────────────────────────
const inputStyle = {
  width: '100%', padding: '9px 12px',
  background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: '8px', color: '#fff', fontSize: '0.88rem', fontFamily: 'inherit',
};
const selectStyle = {
  ...inputStyle,
  backgroundColor: '#0f172a',
  color: '#f8fafc',
  cursor: 'pointer',
};
const optionStyle = {
  backgroundColor: '#0f172a',
  color: '#f8fafc',
};
const labelStyle = { fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '5px' };

// ── Modal wrapper ─────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, width = '460px' }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: width }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>{title}</h3>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: '20px' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function ModalFooter({ onClose, onSubmit, loading, submitLabel, submitColor = '#38bdf8' }) {
  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: '20px', paddingTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
      <button className="btn-secondary" onClick={onClose} disabled={loading}>Cancel</button>
      <button className="btn-primary" onClick={onSubmit} disabled={loading}
        style={{ background: submitColor, color: '#000', fontWeight: 700 }}>
        {loading ? 'Processing...' : submitLabel}
      </button>
    </div>
  );
}

function ErrorBox({ msg }) {
  if (!msg) return null;
  return <div style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: '8px', padding: '10px 14px', color: '#f87171', marginBottom: '14px', fontSize: '0.82rem' }}>{msg}</div>;
}

function SuccessBox({ msg }) {
  if (!msg) return null;
  return <div style={{ background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: '8px', padding: '10px 14px', color: '#4ade80', marginBottom: '14px', fontSize: '0.82rem' }}>{msg}</div>;
}

function ConfirmModal({ title, message, onConfirm, onClose, confirmLabel = 'Confirm', confirmColor = '#38bdf8' }) {
  const [loading, setLoading] = useState(false);
  const handle = async () => {
    setLoading(true);
    await onConfirm();
    setLoading(false);
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div style={{ marginBottom: '16px', color: '#cbd5e1', fontSize: '0.9rem', whiteSpace: 'pre-line', lineHeight: '1.6' }}>{message}</div>
      <ModalFooter onClose={onClose} onSubmit={handle} loading={loading} submitLabel={confirmLabel} submitColor={confirmColor} />
    </Modal>
  );
}

// ── 1. Quick Check-In / Walk-In Modal ────────────────────────────────────────
function CheckInModal({ room, rooms, token, onClose, onSuccess, isWalkIn = false, userRole = '' }) {
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({
    guestName: '', phone: '', pax: '1', deposit: '0',
    roomNumber: room?.number || '',
    checkInDate: today,
    expectedCheckout: getDefaultExpectedCheckoutInput(today),
    billing_instruction: 'Direct to Guest',
    meal_plan: 'EP',
    // New Phase E fields
    dob: '',
    roomTariff: room ? String(room.rate || '') : '',
    paymentMode: '',
    purposeOfVisit: '',
    companyName: '',
    gstNo: '',
    city: '',
    state: '',
  });
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [showDirty, setShowDirty]     = useState(false);

  // Req 1 (new): Manual override restricted to Admin/Manager roles
  const roleUpper     = (userRole || '').toUpperCase();
  const canOverride   = roleUpper === 'ADMIN' || roleUpper === 'MANAGER';

  // Req 2 (new): Explicitly exclude inactive rooms from all room pools
  const cleanRooms = rooms.filter(r =>
    (r.status === 'vacant' || r.status === 'booked') &&
    r.status !== 'inactive' &&
    r.housekeeping_status !== 'Dirty'
  );
  const dirtyRooms = rooms.filter(r =>
    (r.status === 'vacant' || r.status === 'booked') &&
    r.status !== 'inactive' &&
    r.housekeeping_status === 'Dirty'
  );
  // Show dirty rooms only when override is active and user has permission
  const vacantRooms = (canOverride && showDirty) ? [...cleanRooms, ...dirtyRooms] : cleanRooms;

  const handle = async () => {
    if (!form.guestName.trim()) { setError('Guest name is required'); return; }
    const rn = isWalkIn ? form.roomNumber : (room?.number || form.roomNumber);
    if (!rn) { setError('Room number is required'); return; }
    const selRoom     = rooms.find(r => r.number === rn);
    const isDirtyRoom = selRoom?.housekeeping_status === 'Dirty';
    const parsedTariff = parseFloat(form.roomTariff);
    setLoading(true); setError('');
    try {
      await apiCall('POST', `/rooms/${rn}/checkin`, {
        guestName:            form.guestName.trim().toUpperCase(),
        age:                  parseInt(form.age, 10) || 30,
        phone:                form.phone.trim() || '9876543210',
        pax:                  parseInt(form.pax) || 1,
        deposit:              parseInt(form.deposit) || 0,
        checkInDate:          form.checkInDate,
        expectedCheckoutDate: form.expectedCheckout || undefined,
        billing_instruction:  form.billing_instruction || 'Direct to Guest',
        meal_plan:            form.meal_plan || 'EP',
        // New Phase E fields
        dateOfBirth:     form.dob || null,
        roomTariff:      form.roomTariff !== '' && !isNaN(parsedTariff) ? parsedTariff : (selRoom?.rate || 2000),
        paymentMode:     form.paymentMode || null,
        purposeOfVisit:  form.purposeOfVisit || 'Personal',
        companyName:     form.companyName || '',
        gstNo:           form.gstNo || '',
        city:            form.city || '',
        state:           form.state || 'Chandigarh',
        // manual_override is sent only for admin/manager who explicitly toggled the override
        ...(isDirtyRoom && canOverride && showDirty ? { manual_override: true } : {}),
      }, token);
      onSuccess(`✓ ${form.guestName.toUpperCase()} checked into Room ${rn}`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const selectedRoom  = rooms.find(r => r.number === form.roomNumber);
  const hasDirtyRooms = dirtyRooms.length > 0;

  return (
    <Modal title={isWalkIn ? '🚶 Walk-In Guest Check-In' : `🔑 Check-In — Room ${room?.number}`} onClose={onClose}>
      <ErrorBox msg={error} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
        {isWalkIn && (
          <div>
            <label style={labelStyle}>Select Room *</label>
            <select value={form.roomNumber} onChange={e => setForm(f => ({ ...f, roomNumber: e.target.value }))}
              style={selectStyle}>
              <option value="" style={optionStyle}>-- Choose a room --</option>
              {vacantRooms.map(r => (
                <option key={r.number} value={r.number} style={optionStyle}>
                  Room {r.number} — {r.type} (₹{r.rate}/night) [{r.status}]{r.housekeeping_status === 'Dirty' ? ' ⚠ DIRTY — Override' : ''}
                </option>
              ))}
            </select>

            {/* Dirty room override — visible only to Admin/Manager (Req 1) */}
            {hasDirtyRooms && canOverride && (
              <div style={{ marginTop: '10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.78rem', color: showDirty ? '#fbbf24' : 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    checked={showDirty}
                    onChange={e => { setShowDirty(e.target.checked); setForm(f => ({ ...f, roomNumber: '' })); }}
                    style={{ accentColor: '#fbbf24', width: '14px', height: '14px' }}
                  />
                  Show dirty rooms ({dirtyRooms.length}) — Manager Override
                </label>
              </div>
            )}

            {/* Inform receptionist that override is unavailable (Req 1) */}
            {hasDirtyRooms && !canOverride && (
              <div style={{ marginTop: '8px', padding: '6px 10px', background: 'rgba(148,163,184,0.07)', border: '1px solid rgba(148,163,184,0.2)', borderRadius: '6px', fontSize: '0.75rem', color: '#94a3b8' }}>
                🔒 {dirtyRooms.length} dirty room{dirtyRooms.length > 1 ? 's' : ''} hidden — contact Manager or Admin to override
              </div>
            )}

            {/* Amber warning when dirty override selected */}
            {showDirty && canOverride && selectedRoom?.housekeeping_status === 'Dirty' && (
              <div style={{ marginTop: '8px', padding: '8px 12px', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: '7px', fontSize: '0.78rem', color: '#fbbf24' }}>
                ⚠ Manager Override: Room {selectedRoom.number} has pending housekeeping. Notify housekeeping immediately.
              </div>
            )}

            {selectedRoom && selectedRoom.housekeeping_status !== 'Dirty' && (
              <div style={{ marginTop: '8px', padding: '8px 12px', background: 'rgba(56,189,248,0.07)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: '7px', fontSize: '0.78rem', color: '#38bdf8' }}>
                Rate: ₹{selectedRoom.rate}/night  •  Type: {selectedRoom.type}
                {selectedRoom.status === 'booked' && '  •  Has existing reservation'}
              </div>
            )}
          </div>
        )}
        <div>
          <label style={labelStyle}>Guest Name *</label>
          <input style={inputStyle} type="text" placeholder="Full name" value={form.guestName}
            onChange={e => setForm(f => ({ ...f, guestName: e.target.value }))} autoFocus />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Phone</label>
            <input style={inputStyle} type="tel" placeholder="+91 XXXXX XXXXX" value={form.phone}
              onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>Date of Birth</label>
            <input style={inputStyle} type="date" value={form.dob}
              onChange={e => setForm(f => ({ ...f, dob: e.target.value }))} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Check-In Date *</label>
            <input style={inputStyle} type="date" value={form.checkInDate}
              onChange={e => {
                const d = e.target.value;
                setForm(f => ({ ...f, checkInDate: d, expectedCheckout: getDefaultExpectedCheckoutInput(d) }));
              }} required />
          </div>
          <div>
            <label style={labelStyle}>Expected Checkout <span style={{ color:'#f59e0b', fontSize:'0.72rem' }}>editable</span></label>
            <input style={inputStyle} type="datetime-local" value={form.expectedCheckout}
              onChange={e => setForm(f => ({ ...f, expectedCheckout: e.target.value }))}
              title="Default: next day at 11:00 AM" />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Company Name (optional)</label>
            <input style={inputStyle} type="text" placeholder="For company billing" value={form.companyName}
              onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>GST Number (optional)</label>
            <input style={inputStyle} type="text" placeholder="e.g. 29ABCDE..." value={form.gstNo}
              onChange={e => setForm(f => ({ ...f, gstNo: e.target.value }))} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>City</label>
            <input style={inputStyle} type="text" placeholder="Guest city" value={form.city}
              onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>State</label>
            <input style={inputStyle} type="text" placeholder="Guest state" value={form.state}
              onChange={e => setForm(f => ({ ...f, state: e.target.value }))} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Pax (Guests)</label>
            <input style={inputStyle} type="number" min="1" max="10" value={form.pax}
              onChange={e => setForm(f => ({ ...f, pax: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>Room Tariff / Night (₹) <span style={{ color:'#f59e0b', fontSize:'0.72rem' }}>editable</span></label>
            <input style={inputStyle} type="number" min="0" step="50"
              placeholder={selectedRoom ? `Base: ₹${selectedRoom.rate}` : 'e.g. 1500'}
              value={form.roomTariff}
              onChange={e => setForm(f => ({ ...f, roomTariff: e.target.value }))} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Deposit (₹)</label>
            <input style={inputStyle} type="number" min="0" value={form.deposit}
              onChange={e => setForm(f => ({ ...f, deposit: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>Payment Mode</label>
            <select style={selectStyle} value={form.paymentMode}
              onChange={e => setForm(f => ({ ...f, paymentMode: e.target.value }))}>
              <option value="" style={optionStyle}>-- Not Specified --</option>
              <option value="Cash" style={optionStyle}>Cash</option>
              <option value="UPI" style={optionStyle}>UPI</option>
              <option value="Card" style={optionStyle}>Card</option>
              <option value="Bank Transfer" style={optionStyle}>Bank Transfer</option>
              <option value="Other" style={optionStyle}>Other</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Purpose of Visit</label>
            <select style={selectStyle} value={form.purposeOfVisit}
              onChange={e => setForm(f => ({ ...f, purposeOfVisit: e.target.value }))}>
              <option value="" style={optionStyle}>-- Not Specified --</option>
              <option value="Official" style={optionStyle}>Official</option>
              <option value="Function" style={optionStyle}>Function</option>
              <option value="Tourist" style={optionStyle}>Tourist</option>
              <option value="Personal" style={optionStyle}>Personal</option>
              <option value="Business" style={optionStyle}>Business</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Billing Instructions</label>
            <select style={selectStyle} value={form.billing_instruction}
              onChange={e => setForm(f => ({ ...f, billing_instruction: e.target.value }))}>
              <option value="Direct to Guest" style={optionStyle}>Direct to Guest</option>
              <option value="Bill to Company" style={optionStyle}>Bill to Company</option>
              <option value="Room Tariff Only" style={optionStyle}>Room Tariff Only</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Meal Plan</label>
            <select style={selectStyle} value={form.meal_plan}
              onChange={e => setForm(f => ({ ...f, meal_plan: e.target.value }))}>
              <option value="EP" style={optionStyle}>EP (Room Only)</option>
              <option value="CP" style={optionStyle}>CP (+ Breakfast)</option>
              <option value="MAP" style={optionStyle}>MAP (+ B&amp;D)</option>
              <option value="AP" style={optionStyle}>AP (All Meals)</option>
            </select>
          </div>
        </div>
      </div>
      <ModalFooter onClose={onClose} onSubmit={handle} loading={loading}
        submitLabel="✓ Confirm Check-In" submitColor="#38bdf8" />
    </Modal>
  );
}


// ── 2. Quick Check-Out Modal ─────────────────────────────────────────────────
function CheckOutModal({ room, token, onClose, onSuccess }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const deposit = room?.deposit || 0;

  const handle = async () => {
    setLoading(true); setError('');
    try {
      await apiCall('POST', `/rooms/${room.number}/checkout`, { balancePaid: 0 }, token);
      onSuccess(`\u2713 Room ${room.number} \u2014 ${room.guestName} checked out`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <Modal title={`Check-Out \u2014 Room ${room?.number}`} onClose={onClose} width="560px">
      <ErrorBox msg={error} />
      <div style={{ padding: '12px 16px', background: 'rgba(56,189,248,0.05)', border: '1px solid rgba(56,189,248,0.15)', borderRadius: '8px', marginBottom: '16px' }}>
        <div style={{ fontWeight: 700 }}>{room?.guestName}</div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          Room {room?.number} &bull; Check-In: {room?.checkInDate} &bull; {room?.pax} Pax
          {deposit > 0 && <span style={{ marginLeft: '10px', color: '#4ade80' }}>Deposit: &#8377;{deposit.toLocaleString('en-IN')}</span>}
        </div>
      </div>
      {/* Live folio via LedgerPanel */}
      <LedgerPanel roomNumber={room?.number} token={token} compact={false} />
      <ModalFooter onClose={onClose} onSubmit={handle} loading={loading}
        submitLabel="\u2713 Confirm Check-Out" submitColor="#f97316" />
    </Modal>
  );
}


// ── 3. Assign Room (Modify Check-In for booked reservation) ──────────────────
function AssignRoomModal({ rooms, reservations, token, onClose, onSuccess }) {
  const [bookingId, setBookingId] = useState('');
  const [newRoom, setNewRoom] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const bookedRooms = rooms.filter(r => r.status === 'booked' && r.guestName);

  const handle = async () => {
    if (!bookingId) { setError('Select a reservation'); return; }
    if (!newRoom) { setError('Select a target room'); return; }
    const src = rooms.find(r => r.booking_id === parseInt(bookingId));
    if (!src) { setError('Reservation not found'); return; }
    setLoading(true); setError('');
    try {
      // First shift the booking to new room if rooms differ
      if (src.number !== newRoom) {
        await apiCall('POST', `/rooms/shift`, { fromRoomNumber: src.number, toRoomNumber: newRoom }, token);
      } else {
        await apiCall('PUT', `/rooms/${src.number}/checkin`, {
          guestName: src.guestName, phone: src.phone, pax: src.pax, deposit: src.deposit,
        }, token);
      }
      onSuccess(`✓ Room assigned for ${src.guestName}`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  // Req 2: Explicitly exclude inactive rooms from destination list
  const vacantRooms = [...rooms.filter(r =>
    r.status === 'vacant' && r.status !== 'inactive' && r.housekeeping_status !== 'Dirty'
  )].sort((a, b) => {
    if (a.housekeeping_status === 'Dirty' && b.housekeeping_status !== 'Dirty') return 1;
    if (a.housekeeping_status !== 'Dirty' && b.housekeeping_status === 'Dirty') return -1;
    return 0;
  });

  return (
    <Modal title="🛏️ Assign Room" onClose={onClose}>
      <ErrorBox msg={error} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
        <div>
          <label style={labelStyle}>Select Reservation (Booked Guest)</label>
          <select value={bookingId} onChange={e => setBookingId(e.target.value)} style={inputStyle}>
            <option value="">-- Choose reservation --</option>
            {bookedRooms.map(r => (
              <option key={r.booking_id} value={r.booking_id}>
                {r.guestName} — Room {r.number}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Assign to Vacant Room</label>
          <select value={newRoom} onChange={e => setNewRoom(e.target.value)} style={inputStyle}>
            <option value="">-- Select room --</option>
            {vacantRooms.map(r => (
              <option key={r.number} value={r.number}>
                Room {r.number} — {r.type} (₹{r.rate}/night){r.housekeeping_status === 'Dirty' ? ' (DIRTY)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div style={{ padding: '10px 12px', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '7px', fontSize: '0.78rem', color: '#fbbf24' }}>
          ℹ️ Existing reservation will be shifted to the selected room. All ledger items will be transferred.
        </div>
      </div>
      <ModalFooter onClose={onClose} onSubmit={handle} loading={loading}
        submitLabel="✓ Assign Room" submitColor="#818cf8" />
    </Modal>
  );
}

// ── 4. Room Shift Modal ───────────────────────────────────────────────────────
function RoomShiftModal({ room, rooms, token, onClose, onSuccess }) {
  const [fromRoom, setFromRoom] = useState(room?.number || '');
  const [toRoom, setToRoom] = useState('');
  const [adjustmentType, setAdjustmentType] = useState('AUTOMATIC');
  const [manualAmount, setManualAmount] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const occupiedRooms = rooms.filter(r => r.status === 'occupied');
  // Req 2: Explicitly exclude inactive rooms from shift destination list
  const vacantRooms   = rooms.filter(r => r.status === 'vacant' && r.status !== 'inactive');

  const srcRoomObj = rooms.find(r => String(r.number) === String(fromRoom));
  const tgtRoomObj = rooms.find(r => String(r.number) === String(toRoom));

  const sourceRate = Number(srcRoomObj?.rate || srcRoomObj?.price || 0);
  const targetRate = Number(tgtRoomObj?.rate || tgtRoomObj?.price || 0);
  const automaticDifference = targetRate - sourceRate;

  const parsedManualAmt = parseFloat(manualAmount) || 0;
  let finalAdditionalCharge = 0;
  if (adjustmentType === 'NO_ADJUSTMENT') {
    finalAdditionalCharge = 0;
  } else if (adjustmentType === 'INCREASE') {
    finalAdditionalCharge = automaticDifference + parsedManualAmt;
  } else if (adjustmentType === 'DECREASE') {
    finalAdditionalCharge = automaticDifference - parsedManualAmt;
  } else {
    finalAdditionalCharge = automaticDifference;
  }

  const handle = async () => {
    if (!fromRoom || !toRoom) { setError('Both rooms are required'); return; }
    if (fromRoom === toRoom) { setError('Source and target rooms must be different'); return; }
    if ((adjustmentType === 'INCREASE' || adjustmentType === 'DECREASE')) {
      if (parsedManualAmt <= 0) { setError('Manual adjustment amount must be > 0'); return; }
      if (!reason.trim()) { setError('Reason is required for manual adjustment'); return; }
    }

    setLoading(true); setError('');
    try {
      await apiCall('POST', '/rooms/shift', {
        fromRoomNumber: fromRoom,
        toRoomNumber: toRoom,
        adjustmentType,
        manualAdjustmentAmount: parsedManualAmt,
        manualAdjustmentReason: reason.trim()
      }, token);
      onSuccess(`✓ Guest shifted from Room ${fromRoom} to Room ${toRoom}`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <Modal title="🔄 Room Shift" onClose={onClose}>
      <ErrorBox msg={error} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
        <div>
          <label style={labelStyle}>From Room (Occupied) *</label>
          <select value={fromRoom} onChange={e => setFromRoom(e.target.value)} style={inputStyle}>
            <option value="">-- Select occupied room --</option>
            {occupiedRooms.map(r => (
              <option key={r.number} value={r.number}>
                Room {r.number} — {r.guestName} (₹{r.rate || r.price}/night)
              </option>
            ))}
          </select>
          {fromRoom && srcRoomObj && (
            <div style={{ marginTop: '6px', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
              Guest: {srcRoomObj.guestName} | Tariff: ₹{sourceRate}/night
            </div>
          )}
        </div>
        <div>
          <label style={labelStyle}>To Room (Vacant) *</label>
          <select value={toRoom} onChange={e => setToRoom(e.target.value)} style={inputStyle}>
            <option value="">-- Select vacant room --</option>
            {vacantRooms.map(r => (
              <option key={r.number} value={r.number}>
                Room {r.number} — {r.type} (₹{r.rate || r.price}/night)
              </option>
            ))}
          </select>
        </div>

        {fromRoom && toRoom && (
          <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', fontSize: '0.82rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ color: '#94a3b8' }}>Automatic Tariff Difference:</span>
              <span style={{ fontWeight: '700', color: automaticDifference >= 0 ? '#60a5fa' : '#fbbf24' }}>
                {automaticDifference >= 0 ? `+ ₹${automaticDifference.toLocaleString('en-IN')}` : `- ₹${Math.abs(automaticDifference).toLocaleString('en-IN')}`}
              </span>
            </div>

            <div style={{ marginTop: '8px' }}>
              <label style={labelStyle}>Adjustment Option</label>
              <select value={adjustmentType} onChange={e => setAdjustmentType(e.target.value)} style={{ ...inputStyle, marginBottom: '6px' }}>
                <option value="AUTOMATIC">Automatic Difference ({automaticDifference >= 0 ? `+₹${automaticDifference}` : `-₹${Math.abs(automaticDifference)}`})</option>
                <option value="INCREASE">Increase (+ Charge)</option>
                <option value="DECREASE">Decrease (- Discount)</option>
                <option value="NO_ADJUSTMENT">No Adjustment (₹0)</option>
              </select>
            </div>

            {(adjustmentType === 'INCREASE' || adjustmentType === 'DECREASE') && (
              <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '8px', marginTop: '6px' }}>
                <div>
                  <label style={labelStyle}>Amount (₹) *</label>
                  <input type="number" min="1" placeholder="₹" value={manualAmount} onChange={e => setManualAmount(e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Reason *</label>
                  <input type="text" placeholder="Mandatory reason" value={reason} onChange={e => setReason(e.target.value)} style={inputStyle} />
                </div>
              </div>
            )}

            <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#cbd5e1', fontWeight: '600' }}>Final Additional Shift Charge:</span>
              <span style={{ fontWeight: '700', color: finalAdditionalCharge >= 0 ? '#60a5fa' : '#fbbf24' }}>
                {finalAdditionalCharge >= 0 ? `+ ₹${finalAdditionalCharge.toLocaleString('en-IN')}` : `- ₹${Math.abs(finalAdditionalCharge).toLocaleString('en-IN')}`}
              </span>
            </div>
          </div>
        )}
      </div>
      <ModalFooter onClose={onClose} onSubmit={handle} loading={loading}
        submitLabel="✓ Confirm Shift" submitColor="#a78bfa" />
    </Modal>
  );
}

// ── 5. Extend Stay Modal ─────────────────────────────────────────────────────
function ExtendStayModal({ room, rooms, token, onClose, onSuccess }) {
  const [roomNumber, setRoomNumber] = useState(room?.number || '');
  const [newCheckout, setNewCheckout] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const occupiedRooms = rooms.filter(r => r.status === 'occupied');
  const selRoom = rooms.find(r => r.number === roomNumber);

  const handle = async () => {
    if (!roomNumber) { setError('Select a room'); return; }
    if (!newCheckout) { setError('New checkout date is required'); return; }
    setLoading(true); setError('');
    try {
      await apiCall('POST', `/rooms/${roomNumber}/extend-stay`, { newCheckOutDate: newCheckout }, token);
      onSuccess(`✓ Stay extended to ${newCheckout} for Room ${roomNumber}`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <Modal title="📆 Extend Stay" onClose={onClose}>
      <ErrorBox msg={error} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
        <div>
          <label style={labelStyle}>Occupied Room *</label>
          <select value={roomNumber} onChange={e => setRoomNumber(e.target.value)} style={inputStyle}>
            <option value="">-- Select room --</option>
            {occupiedRooms.map(r => (
              <option key={r.number} value={r.number}>
                Room {r.number} — {r.guestName}
              </option>
            ))}
          </select>
          {selRoom && (
            <div style={{ marginTop: '6px', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
              Current checkout: {selRoom.expectedCheckOutDate || 'Not set'} | Rate: ₹{selRoom.rate}/night
            </div>
          )}
        </div>
        <div>
          <label style={labelStyle}>New Checkout Date *</label>
          <input type="date" style={inputStyle} value={newCheckout}
            onChange={e => setNewCheckout(e.target.value)} min={new Date().toISOString().split('T')[0]} />
        </div>
        {selRoom && newCheckout && (
          <div style={{ padding: '10px 12px', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '7px', fontSize: '0.78rem', color: '#fbbf24' }}>
            ℹ️ An additional night tariff of ₹{selRoom.rate} + GST ₹{Math.round(selRoom.rate * 0.05)} will be posted to the folio.
          </div>
        )}
      </div>
      <ModalFooter onClose={onClose} onSubmit={handle} loading={loading}
        submitLabel="✓ Extend Stay" submitColor="#fbbf24" />
    </Modal>
  );
}

// ── 6. Late Checkout Modal ────────────────────────────────────────────────────
function LateCheckoutModal({ room, rooms, token, onClose, onSuccess }) {
  const [roomNumber, setRoomNumber] = useState(room?.number || '');
  const [lateTime, setLateTime] = useState('14:00');
  const [fee, setFee] = useState('500');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const occupiedRooms = rooms.filter(r => r.status === 'occupied');

  const handle = async () => {
    if (!roomNumber) { setError('Select a room'); return; }
    setLoading(true); setError('');
    try {
      await apiCall('POST', `/rooms/${roomNumber}/late-checkout`, {
        lateCheckoutTime: lateTime, fee: parseInt(fee) || 500,
      }, token);
      onSuccess(`✓ Late checkout approved for Room ${roomNumber} until ${lateTime}`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <Modal title="🕐 Late Checkout" onClose={onClose}>
      <ErrorBox msg={error} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
        <div>
          <label style={labelStyle}>Occupied Room *</label>
          <select value={roomNumber} onChange={e => setRoomNumber(e.target.value)} style={inputStyle}>
            <option value="">-- Select room --</option>
            {occupiedRooms.map(r => (
              <option key={r.number} value={r.number}>
                Room {r.number} — {r.guestName}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Late Checkout Until</label>
            <input type="time" style={inputStyle} value={lateTime}
              onChange={e => setLateTime(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Fee (₹)</label>
            <input type="number" min="0" style={inputStyle} value={fee}
              onChange={e => setFee(e.target.value)} />
          </div>
        </div>
        <div style={{ padding: '10px 12px', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '7px', fontSize: '0.78rem', color: '#fbbf24' }}>
          ℹ️ A Late Checkout Fee of ₹{fee || 500} will be posted to the room folio.
        </div>
      </div>
      <ModalFooter onClose={onClose} onSubmit={handle} loading={loading}
        submitLabel="✓ Approve Late Checkout" submitColor="#fb923c" />
    </Modal>
  );
}

// ── 7. Early Check-In Modal ───────────────────────────────────────────────────
function EarlyCheckInModal({ rooms, token, onClose, onSuccess }) {
  const [form, setForm] = useState({ guestName: '', phone: '', pax: '1', deposit: '0', roomNumber: '' });
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Req 2: Exclude inactive rooms and dirty rooms from early check-in selection
  const vacantRooms = rooms.filter(r => r.status === 'vacant' && r.status !== 'inactive' && r.housekeeping_status !== 'Dirty');

  const handle = async () => {
    if (!form.guestName.trim()) { setError('Guest name is required'); return; }
    if (!form.roomNumber) { setError('Room selection is required'); return; }
    setLoading(true); setError('');
    try {
      const selRoom = rooms.find(r => r.number === form.roomNumber);
      await apiCall('POST', `/rooms/${form.roomNumber}/checkin`, {
        guestName: form.guestName.trim().toUpperCase(),
        age: 30,
        phone: form.phone.trim() || '9876543210',
        state: 'Chandigarh',
        purposeOfVisit: 'Personal',
        pax: parseInt(form.pax, 10) || 1,
        billing_instruction: 'Direct to Guest',
        roomTariff: selRoom?.rate || 2000,
        deposit: parseInt(form.deposit, 10) || 0,
      }, token);
      onSuccess(`✓ Early check-in: ${form.guestName.toUpperCase()} → Room ${form.roomNumber}${note ? ` (${note})` : ''}`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <Modal title="⏰ Early Check-In" onClose={onClose}>
      <ErrorBox msg={error} />
      <div style={{ padding: '8px 12px', background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.2)', borderRadius: '7px', marginBottom: '12px', fontSize: '0.78rem', color: '#4ade80' }}>
        ⏰ Early check-in before standard 12:00 PM — no automatic fee applied
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
        <div>
          <label style={labelStyle}>Room *</label>
          <select value={form.roomNumber} onChange={e => setForm(f => ({ ...f, roomNumber: e.target.value }))} style={inputStyle}>
            <option value="">-- Select vacant room --</option>
            {vacantRooms.map(r => (
              <option key={r.number} value={r.number}>
                Room {r.number} — {r.type} (₹{r.rate}/night)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Guest Name *</label>
          <input style={inputStyle} type="text" placeholder="Full name" value={form.guestName}
            onChange={e => setForm(f => ({ ...f, guestName: e.target.value }))} autoFocus />
        </div>
        <div>
          <label style={labelStyle}>Phone</label>
          <input style={inputStyle} type="tel" placeholder="+91 XXXXX XXXXX" value={form.phone}
            onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Pax</label>
            <input style={inputStyle} type="number" min="1" max="10" value={form.pax}
              onChange={e => setForm(f => ({ ...f, pax: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>Deposit (₹)</label>
            <input style={inputStyle} type="number" min="0" value={form.deposit}
              onChange={e => setForm(f => ({ ...f, deposit: e.target.value }))} />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Note (optional)</label>
          <input style={inputStyle} type="text" placeholder="e.g. Arriving at 9 AM" value={note}
            onChange={e => setNote(e.target.value)} />
        </div>
      </div>
      <ModalFooter onClose={onClose} onSubmit={handle} loading={loading}
        submitLabel="✓ Early Check-In" submitColor="#4ade80" />
    </Modal>
  );
}

// ── 8. No Show Modal ──────────────────────────────────────────────────────────
function NoShowModal({ room, rooms, token, onClose, onSuccess }) {
  const [roomNumber, setRoomNumber] = useState(room?.number || '');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const bookedRooms = rooms.filter(r => r.status === 'booked');
  const selRoom = rooms.find(r => r.number === roomNumber);

  const handle = async () => {
    if (!roomNumber) { setError('Select a room'); return; }
    setLoading(true); setError('');
    try {
      await apiCall('POST', `/rooms/${roomNumber}/no-show`, { reason }, token);
      onSuccess(`✓ Room ${roomNumber} marked as No Show. Room is now vacant.`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <Modal title="❌ No Show" onClose={onClose}>
      <ErrorBox msg={error} />
      <div style={{ padding: '8px 12px', background: 'rgba(244,63,94,0.07)', border: '1px solid rgba(244,63,94,0.25)', borderRadius: '7px', marginBottom: '12px', fontSize: '0.78rem', color: '#f87171' }}>
        ⚠ Marking as No Show will forfeit the deposit and free the room. This cannot be undone.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
        <div>
          <label style={labelStyle}>Booked Room *</label>
          <select value={roomNumber} onChange={e => setRoomNumber(e.target.value)} style={inputStyle}>
            <option value="">-- Select room with reservation --</option>
            {bookedRooms.map(r => (
              <option key={r.number} value={r.number}>
                Room {r.number} — {r.guestName}
              </option>
            ))}
          </select>
          {selRoom && (
            <div style={{ marginTop: '6px', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
              Guest: {selRoom.guestName} | Deposit forfeited: ₹{selRoom.deposit?.toLocaleString('en-IN')}
            </div>
          )}
        </div>
        <div>
          <label style={labelStyle}>Reason (optional)</label>
          <input style={inputStyle} type="text" placeholder="e.g. Guest did not arrive or call" value={reason}
            onChange={e => setReason(e.target.value)} />
        </div>
      </div>
      <ModalFooter onClose={onClose} onSubmit={handle} loading={loading}
        submitLabel="✓ Mark No Show" submitColor="#f43f5e" />
    </Modal>
  );
}

// ── 9. Cancel Booking Modal ────────────────────────────────────────────────────
function CancelBookingModal({ room, rooms, token, onClose, onSuccess }) {
  const [roomNumber, setRoomNumber] = useState(room?.number || '');
  const [refundAmt, setRefundAmt] = useState('0');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const occupiedRooms = rooms.filter(r => r.status === 'occupied');
  const selRoom = rooms.find(r => r.number === roomNumber);

  useEffect(() => {
    if (selRoom) setRefundAmt(String(selRoom.deposit || 0));
  }, [roomNumber]);

  const handle = async () => {
    if (!roomNumber) { setError('Select a room'); return; }
    setLoading(true); setError('');
    try {
      await apiCall('POST', `/rooms/${roomNumber}/refund-checkout`, {
        refundAmount: parseFloat(refundAmt) || 0,
        reason: reason.trim() || 'Guest Cancellation',
      }, token);
      onSuccess(`✓ Cancellation processed for Room ${roomNumber}. Refund: ₹${refundAmt}`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <Modal title="💸 Cancel Booking" onClose={onClose}>
      <ErrorBox msg={error} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
        <div>
          <label style={labelStyle}>Occupied Room *</label>
          <select value={roomNumber} onChange={e => setRoomNumber(e.target.value)} style={inputStyle}>
            <option value="">-- Select room --</option>
            {occupiedRooms.map(r => (
              <option key={r.number} value={r.number}>
                Room {r.number} — {r.guestName}
              </option>
            ))}
          </select>
          {selRoom && (
            <div style={{ marginTop: '6px', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
              Deposit collected: ₹{selRoom.deposit?.toLocaleString('en-IN')}
            </div>
          )}
        </div>
        <div>
          <label style={labelStyle}>Refund Amount (₹)</label>
          <input style={inputStyle} type="number" min="0" value={refundAmt}
            onChange={e => setRefundAmt(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Cancellation Reason</label>
          <input style={inputStyle} type="text" placeholder="e.g. Guest requested cancellation" value={reason}
            onChange={e => setReason(e.target.value)} />
        </div>
        <div style={{ padding: '10px 12px', background: 'rgba(244,63,94,0.07)', border: '1px solid rgba(244,63,94,0.2)', borderRadius: '7px', fontSize: '0.78rem', color: '#f87171' }}>
          ⚠ This will check the guest out and mark the booking as Refunded. Room will be set to dirty.
        </div>
      </div>
      <ModalFooter onClose={onClose} onSubmit={handle} loading={loading}
        submitLabel="✓ Process Cancellation" submitColor="#c084fc" />
    </Modal>
  );
}

// ── 10. Room Card ─────────────────────────────────────────────────────────────
function RoomCard({ room, onAction }) {
  const isDirty = room.status === 'dirty' || room.housekeeping_status === 'Dirty';
  const displayStatus = isDirty ? 'dirty' : room.status;
  const s = STATUS_STYLE[displayStatus] || STATUS_STYLE.vacant;
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const inlineActions = [];
  if (room.status === 'vacant')   inlineActions.push({ id: 'walkin',   icon: '🚶', label: 'Walk-In',  color: '#34d399' });
  if (room.status === 'booked')   inlineActions.push({ id: 'checkin',  icon: '📥', label: 'Check-In', color: '#38bdf8' });
  if (room.status === 'occupied') inlineActions.push(
    { id: 'checkout', icon: '🧾', label: 'Out',    color: '#f97316' },
    { id: 'extend',   icon: '📆', label: 'Extend', color: '#fbbf24' },
    { id: 'shift',    icon: '🔄', label: 'Shift',  color: '#a78bfa' },
    { id: 'late',     icon: '🕐', label: 'Late',   color: '#fb923c' },
  );
  if (room.status === 'booked')   inlineActions.push({ id: 'noshow', icon: '❌', label: 'No Show', color: '#f43f5e' });

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setMenuOpen(false); }}
      style={{
        background: s.bg, border: `1px solid ${hovered ? s.text : s.border}`,
        borderRadius: '12px', padding: '14px', cursor: 'pointer',
        transition: 'all 0.2s', position: 'relative', minHeight: '110px',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        boxShadow: hovered ? `0 6px 20px ${s.border}` : 'none',
        transform: hovered ? 'translateY(-2px)' : 'none',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#fff', lineHeight: 1 }}>{room.number}</div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: '2px' }}>{room.type}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{
            fontSize: '0.6rem', fontWeight: 700, padding: '2px 7px',
            borderRadius: '4px', background: s.bg, border: `1px solid ${s.border}`,
            color: s.text, textTransform: 'uppercase', letterSpacing: '0.5px',
          }}>{s.label}</span>
          <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
            <button 
              onClick={() => setMenuOpen(!menuOpen)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem', padding: '0 4px' }}
            >⋮</button>
            {menuOpen && (
              <div style={{
                position: 'absolute', top: '100%', right: '0', background: '#1e293b', 
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', 
                padding: '4px', zIndex: 10, minWidth: '120px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
              }}>
                {room.housekeeping_status === 'Dirty' && <button onClick={() => { setMenuOpen(false); onAction('mark_clean', room); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' }}>Mark Clean</button>}
                {room.housekeeping_status !== 'Dirty' && <button onClick={() => { setMenuOpen(false); onAction('mark_dirty', room); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' }}>Mark Dirty</button>}
                {room.status !== 'inactive' && <button onClick={() => { setMenuOpen(false); onAction('mark_inactive', room); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' }}>Mark Inactive</button>}
                {room.status === 'inactive' && <button onClick={() => { setMenuOpen(false); onAction('mark_active', room); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' }}>Mark Active</button>}
              </div>
            )}
          </div>
        </div>
      </div>

      <div>
        {room.status === 'occupied' && (
          <>
            <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#fff', marginBottom: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{room.guestName || '—'}</div>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
              {room.pax ? `${room.pax} Pax` : ''}{room.checkInDate ? ` • CI: ${room.checkInDate}` : ''}
            </div>
          </>
        )}
        {room.status === 'dirty'    && <div style={{ fontSize: '0.72rem', color: '#fbbf24' }}>⚠ Needs Cleaning</div>}
        {room.status === 'booked'   && <div style={{ fontSize: '0.72rem', color: '#a78bfa' }}>📅 {room.guestName || 'Advance Booking'}</div>}
        {room.status === 'vacant'   && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>[ Available ]</div>}
        {room.status === 'inactive' && <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>— Inactive —</div>}
      </div>

      {/* Inline action buttons on hover */}
      {hovered && inlineActions.length > 0 && (
        <div style={{
          position: 'absolute', bottom: '8px', left: '8px', right: '8px',
          display: 'flex', gap: '4px', flexWrap: 'wrap',
        }}>
          {inlineActions.map(a => (
            <button key={a.id}
              onClick={e => { e.stopPropagation(); onAction(a.id, room); }}
              style={{
                background: `${a.color}22`, border: `1px solid ${a.color}55`,
                color: a.color, borderRadius: '5px', padding: '3px 8px',
                fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = `${a.color}44`; }}
              onMouseLeave={e => { e.currentTarget.style.background = `${a.color}22`; }}
            >
              {a.icon} {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 11. Guest Search Panel ────────────────────────────────────────────────────
const TIER_STYLE = {
  Bronze:   { color: '#cd7f32', bg: 'rgba(205,127,50,0.12)',  border: 'rgba(205,127,50,0.35)'  },
  Silver:   { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.35)' },
  Gold:     { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.35)'  },
  Platinum: { color: '#e5e7eb', bg: 'rgba(229,231,235,0.12)', border: 'rgba(229,231,235,0.35)' },
};
const BOOKING_STATUS_STYLE = {
  'Checked In':  { color: '#34d399', bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.3)'  },
  'Checked Out': { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.3)' },
  'Reserved':    { color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  border: 'rgba(251,191,36,0.3)'  },
  'No Show':     { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)' },
  'Cancelled':   { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)' },
};
function statusBadge(status) {
  const s = BOOKING_STATUS_STYLE[status] || { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.3)' };
  return { fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', background: s.bg, color: s.color, border: `1px solid ${s.border}` };
}

function GuestSearchPanel({ token }) {
  const [query, setQuery]       = useState('');
  const [results, setResults]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState(null);   // guest summary row
  const [detail, setDetail]     = useState(null);   // { guest, bookings, payments }
  const [detailLoading, setDetailLoading] = useState(false);

  const doSearch = async () => {
    if (query.trim().length < 2) return;
    setLoading(true); setResults([]); setSelected(null); setDetail(null); setSearched(false);
    try {
      const data = await apiCall('GET', `/reception/guests/search?q=${encodeURIComponent(query.trim())}`, null, token);
      setResults(data.guests || []);
    } catch (e) {
      setResults([]);
    } finally {
      setLoading(false); setSearched(true);
    }
  };

  const viewGuest = async (guest) => {
    setSelected(guest); setDetail(null); setDetailLoading(true);
    try {
      const data = await apiCall('GET', `/reception/guests/history/${guest.id}`, null, token);
      setDetail(data);
    } catch (e) { setDetail(null); }
    finally { setDetailLoading(false); }
  };

  const back = () => { setSelected(null); setDetail(null); };

  const cardBase = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '12px', padding: '14px 16px',
  };

  /* ── DETAIL VIEW ── */
  if (selected) {
    const g = detail?.guest || selected;
    const bookings  = detail?.bookings  || [];
    const payments  = detail?.payments  || [];
    const tier = TIER_STYLE[g.loyalty_tier] || TIER_STYLE.Bronze;
    const totalSpend = payments.reduce((s, p) => s + Number(p.amount || 0), 0);

    return (
      <div>
        <button onClick={back}
          style={{ background: 'none', border: '1px solid rgba(255,255,255,0.15)', color: 'var(--text-muted)', borderRadius: '6px', padding: '5px 14px', cursor: 'pointer', fontSize: '0.78rem', marginBottom: '18px' }}>
          ← Back to results
        </button>

        {/* Guest profile card */}
        <div style={{ ...cardBase, marginBottom: '16px', display: 'grid', gridTemplateColumns: '1fr auto', gap: '16px', alignItems: 'start' }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: '1.15rem', marginBottom: '6px' }}>{g.full_name}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {g.phone && <span>📞 {g.phone}</span>}
              {g.email && <span>✉ {g.email}</span>}
            </div>
            {selected.current_room && (
              <div style={{ marginTop: '8px', fontSize: '0.78rem', fontWeight: 700, color: '#34d399' }}>
                🏨 Currently in Room {selected.current_room} · {selected.current_status}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 800, color: tier.color, background: tier.bg, border: `1px solid ${tier.border}`, padding: '3px 10px', borderRadius: '6px' }}>
              {g.loyalty_tier || 'Bronze'} MEMBER
            </span>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{g.loyalty_points || 0} pts</span>
            <span style={{ fontSize: '0.75rem', color: '#4ade80', fontWeight: 700 }}>
              ₹{totalSpend.toLocaleString('en-IN')} total spend
            </span>
          </div>
        </div>

        {/* Booking history */}
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading history...</div>
        ) : bookings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No bookings found.</div>
        ) : (
          <>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '10px', color: '#94a3b8' }}>
              Booking History · {bookings.length} stay{bookings.length !== 1 ? 's' : ''}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '420px', overflowY: 'auto', paddingRight: '4px' }}>
              {bookings.map(b => (
                <div key={b.id} style={{ ...cardBase, padding: '12px 16px', display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px', alignItems: 'center' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.88rem' }}>{b.booking_number}</span>
                      <span style={statusBadge(b.booking_status)}>{b.booking_status}</span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Room {b.room_number} ({b.room_type}) · {b.check_in_date}
                      {(b.check_out_date) ? ` → ${b.check_out_date}` : ''}
                    </div>
                    {b.feedback_comments && (
                      <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '4px', fontStyle: 'italic' }}>
                        ⭐ {b.overall_rating}/5 — "{b.feedback_comments}"
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#4ade80' }}>
                      ₹{Number(b.total_amount || 0).toLocaleString('en-IN')}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      Paid: ₹{Number(b.total_paid || 0).toLocaleString('en-IN')}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: b.payment_status === 'Paid' ? '#4ade80' : '#fbbf24', marginTop: '2px', fontWeight: 600 }}>
                      {b.payment_status}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  /* ── SEARCH VIEW ── */
  return (
    <div>
      {/* Search bar */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '8px' }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          type="text"
          placeholder="Search by name, phone, email or booking number..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doSearch()}
          autoFocus
        />
        <button
          onClick={doSearch}
          disabled={loading || query.trim().length < 2}
          style={{ padding: '9px 22px', background: '#38bdf8', color: '#000', fontWeight: 700, borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '0.88rem', opacity: query.trim().length < 2 ? 0.5 : 1 }}>
          {loading ? '...' : '🔍 Search'}
        </button>
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
        Search all guests — in-house, checked-out, and historical records
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
            {results.length} guest{results.length !== 1 ? 's' : ''} found
          </div>
          {results.map(g => {
            const tier = TIER_STYLE[g.loyalty_tier] || TIER_STYLE.Bronze;
            const inHouse = !!g.current_room;
            return (
              <div key={g.id}
                onClick={() => viewGuest(g)}
                style={{
                  ...cardBase, cursor: 'pointer', display: 'grid',
                  gridTemplateColumns: '1fr auto', gap: '12px', alignItems: 'center',
                  borderColor: inHouse ? 'rgba(52,211,153,0.25)' : 'rgba(255,255,255,0.08)',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#38bdf855'; e.currentTarget.style.background = 'rgba(56,189,248,0.05)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = inHouse ? 'rgba(52,211,153,0.25)' : 'rgba(255,255,255,0.08)'; e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{g.full_name}</span>
                    {inHouse && (
                      <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: '4px', padding: '1px 7px' }}>
                        IN HOUSE · Rm {g.current_room}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {g.phone || '—'}{g.email ? ` · ${g.email}` : ''} · {g.total_bookings} booking{g.total_bookings != 1 ? 's' : ''}
                  </div>
                  {g.last_booking_number && (
                    <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '3px' }}>
                      Last: {g.last_booking_number}
                      {g.last_check_in ? ` · ${g.last_check_in}` : ''}
                      {g.last_booking_status ? ` · ${g.last_booking_status}` : ''}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                  <span style={{ fontSize: '0.68rem', fontWeight: 800, color: tier.color, background: tier.bg, border: `1px solid ${tier.border}`, padding: '2px 8px', borderRadius: '4px' }}>
                    {g.loyalty_tier || 'Bronze'}
                  </span>
                  <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{g.loyalty_points || 0} pts</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {searched && results.length === 0 && (
        <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>🔍</div>
          <p style={{ fontWeight: 600 }}>No guests found for "{query}"</p>
          <p style={{ fontSize: '0.8rem', marginTop: '6px' }}>Try searching by phone number, email, or booking number</p>
        </div>
      )}

      {!searched && !loading && (
        <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>👤</div>
          <p>Type at least 2 characters and press Search or Enter</p>
        </div>
      )}
    </div>
  );
}

// ── 12. Reservations Panel ────────────────────────────────────────────────────
function ReservationsPanel({ reservations, rooms, token, onActionSuccess }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [cancelModal, setCancelModal] = useState(null);
  const [noShowModal, setNoShowModal] = useState(null);

  const filtered = reservations.filter(r =>
    !searchTerm ||
    (r.guestName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (r.roomNumber || '').includes(searchTerm) ||
    (r.booking_number || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
        <input style={{ ...inputStyle, flex: 1 }} type="text" placeholder="Search by guest, room or booking number..."
          value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '3rem', marginBottom: '12px' }}>📭</div>
          <p>{reservations.length === 0 ? 'No upcoming reservations' : 'No reservations match your search'}</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {['Booking #','Room','Guest','Phone','Check-In','Check-Out','Pax','Amount','Status','Actions'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.booking_id || i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '9px 12px', color: '#818cf8', fontWeight: 600 }}>{r.booking_number || r.booking_id}</td>
                  <td style={{ padding: '9px 12px', fontWeight: 700, color: '#a78bfa' }}>{r.roomNumber}</td>
                  <td style={{ padding: '9px 12px', fontWeight: 600 }}>{r.guestName}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--text-muted)' }}>{r.phone || '—'}</td>
                  <td style={{ padding: '9px 12px' }}>{r.checkInDate}</td>
                  <td style={{ padding: '9px 12px' }}>{r.expectedCheckOutDate || '—'}</td>
                  <td style={{ padding: '9px 12px', textAlign: 'center' }}>{r.adults}</td>
                  <td style={{ padding: '9px 12px', fontWeight: 600 }}>₹{Number(r.totalAmount || 0).toLocaleString('en-IN')}</td>
                  <td style={{ padding: '9px 12px' }}>
                    <span style={{
                      fontSize: '0.65rem', fontWeight: 700, padding: '2px 7px', borderRadius: '4px',
                      background: 'rgba(139,92,246,0.12)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.3)',
                      textTransform: 'uppercase',
                    }}>Reserved</span>
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    <div style={{ display: 'flex', gap: '5px' }}>
                      <button
                        onClick={() => setNoShowModal({ number: r.roomNumber })}
                        style={{ fontSize: '0.65rem', padding: '3px 8px', background: 'rgba(244,63,94,0.1)', border: '1px solid rgba(244,63,94,0.3)', color: '#f87171', borderRadius: '4px', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}>
                        No Show
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {noShowModal && (
        <NoShowModal room={noShowModal} rooms={rooms} token={token}
          onClose={() => setNoShowModal(null)}
          onSuccess={msg => { setNoShowModal(null); onActionSuccess(msg); }} />
      )}
    </div>
  );
}

// ── 13. Guest Requests Panel ─────────────────────────────────────────────────
function GuestRequestsPanel({ token }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(null);

  const fetchRequests = useCallback(async () => {
    try {
      const data = await apiCall('GET', '/admin/guest-requests', null, token);
      setRequests(data.requests || []);
    } catch (e) {} finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleResolve = async (req) => {
    setResolving(req.id);
    try {
      const ep = req.type === 'extension'
        ? `/admin/guest-requests/extension/${req.id}/resolve`
        : `/admin/guest-requests/${req.id}/resolve`;
      await apiCall('POST', ep, null, token);
      fetchRequests();
    } catch (e) {} finally { setResolving(null); }
  };

  const REQ_ICON = { checkin: '🔑', checkout: '🧾', extension: '📅', service: '🛎', maintenance: '🔧' };

  if (loading) return <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>Loading...</div>;
  if (requests.length === 0) return (
    <div style={{ textAlign: 'center', padding: '80px 20px', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: '3rem', marginBottom: '14px' }}>✅</div>
      <p style={{ fontWeight: 600 }}>No pending guest requests</p>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {requests.map(req => (
        <div key={req.id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '4px' }}>
              Room {req.room_number} — {req.guest_name}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {REQ_ICON[req.request_type] || '📋'} {req.request_type?.charAt(0).toUpperCase() + req.request_type?.slice(1)} Request
            </div>
            {req.notes && <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '4px', fontStyle: 'italic' }}>"{req.notes}"</div>}
          </div>
          <button className="btn-primary" onClick={() => handleResolve(req)} disabled={resolving === req.id}
            style={{ fontSize: '0.78rem', padding: '7px 14px', background: '#4ade80', color: '#000', fontWeight: 700, whiteSpace: 'nowrap' }}>
            {resolving === req.id ? '...' : '✓ Resolve'}
          </button>
        </div>
      ))}
    </div>
  );
}

// ── 14. Cash Handover Panel ───────────────────────────────────────────────────
const SHIFT_OPTIONS = ['Morning', 'Night'];

function CashHandoverPanel({ token, adminUser }) {
  const [submissions, setSubmissions] = useState([]);
  const [amount, setAmount]           = useState('');
  const [shift, setShift]             = useState('Morning');
  const [name, setName]               = useState('');
  const [receivedBy, setReceivedBy]   = useState('');
  const [notes, setNotes]             = useState('');
  const [loading, setLoading]         = useState(true);
  const [submitting, setSubmitting]   = useState(false);
  const [success, setSuccess]         = useState('');
  const [error, setError]             = useState('');

  const receptionistName = adminUser?.fullName || adminUser?.full_name || adminUser?.username || 'Receptionist';

  const fetchSubmissions = useCallback(async () => {
    try {
      const data = await apiCall('GET', '/cash/submissions', null, token);
      setSubmissions(data.submissions || []);
    } catch (e) {} finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchSubmissions(); }, [fetchSubmissions]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!amount || isNaN(amount) || Number(amount) <= 0) { setError('Enter a valid amount'); return; }
    if (!name.trim()) { setError('Your name is required'); return; }
    setSubmitting(true); setError(''); setSuccess('');
    try {
      const res = await apiCall('POST', '/cash/submit', {
        amount:     Number(amount),
        shift:      shift,
        name:       name.trim(),
        receivedBy: receivedBy.trim(),
        notes:      notes.trim(),
      }, token);
      setSuccess(`✓ ₹${Number(amount).toLocaleString('en-IN')} submitted successfully — ${res.submission?.receipt_id || ''}`);
      setAmount(''); setReceivedBy(''); setNotes('');
      fetchSubmissions();
    } catch (e) { setError(e.message); } finally { setSubmitting(false); }
  };

  const cardStyle = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '12px',
    padding: '20px',
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: '24px', alignItems: 'start' }}>

      {/* ── Submit form ── */}
      <div style={cardStyle}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '6px', color: '#4ade80' }}>💵 Submit Cash Handover</h3>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Receptionist: <strong style={{ color: '#e2e8f0' }}>{receptionistName}</strong>
        </div>
        <SuccessBox msg={success} />
        <ErrorBox msg={error} />
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

          <div>
            <label style={labelStyle}>Your Name *</label>
            <input type="text" style={inputStyle} value={name}
              onChange={e => setName(e.target.value)} placeholder="Enter your name" />
          </div>

          <div>
            <label style={labelStyle}>Amount (₹) *</label>
            <input type="number" min="1" style={inputStyle} value={amount}
              onChange={e => setAmount(e.target.value)} placeholder="Enter amount" />
          </div>

          <div>
            <label style={labelStyle}>Shift *</label>
            <select style={inputStyle} value={shift} onChange={e => setShift(e.target.value)}>
              {SHIFT_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Received By (optional)</label>
            <input type="text" style={inputStyle} value={receivedBy}
              onChange={e => setReceivedBy(e.target.value)} placeholder="Manager / Supervisor name" />
          </div>

          <div>
            <label style={labelStyle}>Notes (optional)</label>
            <textarea style={{ ...inputStyle, resize: 'vertical' }} rows={2} value={notes}
              onChange={e => setNotes(e.target.value)} placeholder="Any remarks for this handover..." />
          </div>

          <button type="submit" disabled={submitting}
            style={{ background: '#4ade80', color: '#000', fontWeight: 700, padding: '11px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '0.9rem' }}>
            {submitting ? 'Submitting...' : '✓ Submit Handover'}
          </button>
        </form>
      </div>

      {/* ── Submission history ── */}
      <div>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '14px' }}>📋 Today's Submissions</h3>
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading...</div>
        ) : submissions.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '30px 0', textAlign: 'center' }}>
            <div style={{ fontSize: '2rem', marginBottom: '8px' }}>💸</div>
            No submissions yet today.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {submissions.slice(0, 15).map((s, i) => {
              const time = s.submitted_at
                ? new Date(s.submitted_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
                : '—';
              const remarks = s.remarks || '';
              const shiftMatch = remarks.match(/Shift:\s*(\w+)/);
              const shiftLabel = shiftMatch ? shiftMatch[1] : '—';
              return (
                <div key={i} style={{ ...cardStyle, padding: '12px 16px', display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px', alignItems: 'center' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 800, color: '#4ade80', fontSize: '1.05rem' }}>
                        ₹{Number(s.amount || 0).toLocaleString('en-IN')}
                      </span>
                      <span style={{ fontSize: '0.7rem', background: 'rgba(74,222,128,0.1)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.25)', borderRadius: '4px', padding: '1px 6px', fontWeight: 700 }}>
                        {shiftLabel} Shift
                      </span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      By: <strong style={{ color: '#e2e8f0' }}>{s.receptionist_name || '—'}</strong>
                      {s.receiver_name && s.receiver_name !== 'N/A' && (
                        <span> → Received by: <strong style={{ color: '#e2e8f0' }}>{s.receiver_name}</strong></span>
                      )}
                    </div>
                    {s.remarks && !s.remarks.startsWith('Shift:') && (
                      <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '3px' }}>{s.remarks.replace(/Shift:\s*\w+\s*\|?\s*/, '')}</div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.75rem', color: '#e2e8f0', fontWeight: 600 }}>{time}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>{s.receipt_id || '—'}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────────
export default function ReceptionPortal() {
  const { adminUser, adminToken, logout } = React.useContext(AdminAuthContext);
  const time = useTime();
  const [activeTab, setActiveTab] = useState('frontdesk');
  const [rooms, setRooms] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [systemDate, setSystemDate] = useState('—');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [toast, setToast] = useState('');

  // Active modal state
  const [modal, setModal] = useState(null);  // modal id string
  const [ctxRoom, setCtxRoom] = useState(null); // room context for modal
  const [confirmStatusModal, setConfirmStatusModal] = useState(null);

  // ── Data fetch ─────────────────────────────────────────────────────────────
  const fetchData = useCallback(async (silent = false) => {
    if (!adminToken) return;
    if (!silent) setLoading(true); else setSyncing(true);
    try {
      const data = await apiCall('GET', `/status?_t=${Date.now()}`, null, adminToken);
      setRooms(data.rooms || []);
      setReservations(data.upcomingReservations || []);
      setSystemDate(data.systemDate || '—');
    } catch (e) {} finally { setLoading(false); setSyncing(false); }
  }, [adminToken]);

  useEffect(() => { 
    fetchData(); 
    const handleDateChange = () => fetchData(true);
    window.addEventListener('businessDateChanged', handleDateChange);
    return () => window.removeEventListener('businessDateChanged', handleDateChange);
  }, [fetchData]);
  
  useEffect(() => {
    const id = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(id);
  }, [fetchData]);

  // ── Toast ──────────────────────────────────────────────────────────────────
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 4500);
  };

  // ── Modal management ───────────────────────────────────────────────────────
  const openModal = (id, room = null) => {
    setCtxRoom(room);
    setModal(id);
  };

  const closeModal = () => {
    setModal(null);
    setCtxRoom(null);
  };

  const handleSuccess = (msg) => {
    closeModal();
    showToast(msg);
    fetchData(true);
  };

  // ── Quick action bar clicks ────────────────────────────────────────────────
  const handleQuickAction = (id) => {
    if (id === 'walkin')  { openModal('walkin'); return; }
    if (id === 'checkin') { openModal('checkin'); return; }
    if (id === 'checkout') {
      const occ = rooms.find(r => r.status === 'occupied');
      if (occ) openModal('checkout', occ);
      else showToast('❌ No occupied rooms found');
      return;
    }
    if (id === 'assign') { openModal('assign'); return; }
    if (id === 'shift')  { openModal('shift'); return; }
    if (id === 'extend') { openModal('extend'); return; }
    if (id === 'late')   { openModal('late'); return; }
    if (id === 'early')  { openModal('early'); return; }
    if (id === 'noshow') { openModal('noshow'); return; }
    if (id === 'cancel') { openModal('cancel'); return; }
  };

  // ── Room card action ────────────────────────────────────────────────────────
  const executeRoomStatusChange = async (room, action, manualOverride = false) => {
    try {
      setLoading(true);
      const body = { action, ...(manualOverride ? { manual_override: true } : {}) };
      const res = await apiCall('PUT', `/rooms/${room.number}/status`, body, adminToken);
      showToast(res.message);
      fetchData(true);
    } catch (e) {
      showToast(e.message || 'Error updating room status');
    } finally {
      setLoading(false);
      setConfirmStatusModal(null);
    }
  };

  const handleRoomAction = (id, room) => {
    if (id.startsWith('mark_')) {
      if (id === 'mark_inactive' && (room.status === 'occupied' || room.status === 'booked')) {
        showToast('Only vacant or dirty rooms can be marked Inactive.');
        return;
      }

      // Req 1 & 2: For occupied rooms, mark_dirty/mark_clean only affects housekeeping — show informational confirm
      if ((id === 'mark_dirty' || id === 'mark_clean') && room.status === 'occupied') {
        const newHk = id === 'mark_dirty' ? 'Dirty' : 'Clean';
        setConfirmStatusModal({
          room,
          action: id,
          title: id === 'mark_dirty' ? '🧹 Mark Room as Dirty' : '✅ Mark Room as Clean',
          message: `Room ${room.number} is currently occupied by ${room.guestName || 'a guest'}.\n\nThis will only update the Housekeeping status to "${newHk}" — the room will remain occupied.`,
        });
        return;
      }

      if (id === 'mark_inactive') {
        setConfirmStatusModal({ room, action: id, title: 'Mark Inactive', message: 'Mark this room as Inactive? It will not be available for new bookings.' });
      } else {
        executeRoomStatusChange(room, id);
      }
      return;
    }
    openModal(id, room);
  };

  // ── Filter ─────────────────────────────────────────────────────────────────
  const filteredRooms = rooms.filter(r => {
    const ms = !searchQuery || r.number.includes(searchQuery) || (r.guestName || '').toLowerCase().includes(searchQuery.toLowerCase());
    const mf = filterStatus === 'all' || r.status === filterStatus || (filterStatus === 'dirty' && r.housekeeping_status === 'Dirty') || (filterStatus === 'inactive' && r.status === 'inactive');
    return ms && mf;
  });

  const stats = {
    total: rooms.length,
    vacant:   rooms.filter(r => r.status === 'vacant').length,
    occupied: rooms.filter(r => r.status === 'occupied').length,
    dirty:    rooms.filter(r => r.status === 'dirty' || r.housekeeping_status === 'Dirty').length,
    booked:   rooms.filter(r => r.status === 'booked').length,
    inactive: rooms.filter(r => r.status === 'inactive').length,
  };

  // ── Loading screen ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#080b10', color: '#fff' }}>
        <div style={{ fontSize: '3rem', marginBottom: '20px' }}>🛎️</div>
        <h2 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700 }}>Front Office</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>Loading...</p>
        <div style={{ width: '36px', height: '36px', border: '3px solid rgba(56,189,248,0.1)', borderTopColor: '#38bdf8', borderRadius: '50%', animation: 'spin 1s linear infinite', marginTop: '20px' }} />
      </div>
    );
  }

  return (
    <div className="app-layout">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <div className="sidebar-container">
        <div className="sidebar-header">Front Office <span>+</span></div>
        <nav className="sidebar-menu">
          {SIDEBAR_ITEMS.map(item => (
            <button key={item.id}
              className={`sidebar-item${activeTab === item.id ? ' active' : ''}`}
              onClick={() => setActiveTab(item.id)} type="button">
              <span className="sidebar-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 'auto' }}>
          <div style={{ fontWeight: 700, color: '#38bdf8', marginBottom: '2px' }}>RECEPTIONIST</div>
          <div>{(adminUser?.fullName || adminUser?.full_name || '').toUpperCase()}</div>
          <button onClick={() => { logout(); window.location.href = '/admin/login'; }}
            style={{ marginTop: '10px', width: '100%', padding: '6px', background: 'rgba(255,77,77,0.08)', border: '1px solid rgba(255,77,77,0.25)', color: '#f87171', borderRadius: '6px', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, fontFamily: 'inherit' }}>
            Logout
          </button>
        </div>
      </div>

      {/* ── Main Area ─────────────────────────────────────────────────────── */}
      <div className="app-container">
        {/* Header */}
        <header className="header" style={{ borderBottom: '2px solid rgba(56,189,248,0.25)' }}>
          <div className="brand-section">
            <span className="logo-icon">🛎️</span>
            <h1 className="brand-name">Front Office <span>HOTEL SKY-5</span></h1>
          </div>
          <div className="status-time-widget">
            <div className="date-box">📅 Business Date: <strong>{systemDate}</strong></div>
            <div className="time-box">{time}</div>
            {syncing && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.7rem', color: '#38bdf8', background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.2)', padding: '3px 8px', borderRadius: '4px' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#38bdf8', boxShadow: '0 0 6px #38bdf8', animation: 'pulse 1s infinite', display: 'inline-block' }} />
                Syncing...
              </div>
            )}
            <div className="user-badge">
              <span className="user-indicator" style={{ background: '#38bdf8', boxShadow: '0 0 8px #38bdf8' }} />
              <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{(adminUser?.fullName || adminUser?.full_name || '').toUpperCase()}</span>
              <span style={{ fontSize: '0.7rem', background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.3)', color: '#38bdf8', padding: '2px 7px', borderRadius: '4px', marginLeft: '8px' }}>RECEPTIONIST</span>
            </div>
          </div>
        </header>

        {/* Quick Action Bar */}
        <div style={{ display: 'flex', gap: '6px', padding: '8px 14px', background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid rgba(255,255,255,0.05)', flexWrap: 'wrap', alignItems: 'center' }}>
          {QUICK_ACTIONS.map(a => (
            <button key={a.id} onClick={() => handleQuickAction(a.id)}
              style={{
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
                color: '#cdd9e5', borderRadius: '6px', padding: '5px 12px', cursor: 'pointer',
                fontSize: '0.76rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '5px',
                transition: 'all 0.15s', fontFamily: 'inherit',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = a.color; e.currentTarget.style.color = a.color; e.currentTarget.style.background = `${a.color}11`; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; e.currentTarget.style.color = '#cdd9e5'; e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
            >
              {a.icon} {a.label}
            </button>
          ))}
          <button onClick={() => fetchData()}
            style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', color: '#cdd9e5', borderRadius: '6px', padding: '5px 12px', cursor: 'pointer', fontSize: '0.76rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '5px', fontFamily: 'inherit', transition: 'all 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#38bdf8'; e.currentTarget.style.color = '#38bdf8'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; e.currentTarget.style.color = '#cdd9e5'; }}>
            🔄 Refresh
          </button>
        </div>

        {/* ── Tab: Front Office ─────────────────────────────────────────── */}
        {activeTab === 'frontdesk' && (
          <div className="dashboard-body">
            {/* Search + Filter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexWrap: 'wrap' }}>
              <input type="text" placeholder="Search by room number or guest name..."
                value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                style={{ flex: '1', minWidth: '200px', padding: '7px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', color: '#fff', fontSize: '0.84rem', fontFamily: 'inherit' }} />
              {['all', 'vacant', 'occupied', 'dirty', 'booked', 'inactive'].map(s => (
                <button key={s} onClick={() => setFilterStatus(s)}
                  style={{
                    padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '0.74rem', fontWeight: 700,
                    fontFamily: 'inherit', border: '1px solid',
                    borderColor: filterStatus === s ? '#38bdf8' : 'rgba(255,255,255,0.1)',
                    background: filterStatus === s ? 'rgba(56,189,248,0.1)' : 'transparent',
                    color: filterStatus === s ? '#38bdf8' : 'var(--text-muted)',
                    textTransform: 'capitalize',
                  }}>
                  {s === 'all' ? `All ${rooms.length}` : `${s.charAt(0).toUpperCase() + s.slice(1)} ${rooms.filter(r => r.status === s).length}`}
                </button>
              ))}
            </div>

            {/* Room Grid */}
            <div style={{ padding: '14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))', gap: '12px' }}>
              {filteredRooms.map(room => (
                <RoomCard key={room.number} room={room} onAction={handleRoomAction} />
              ))}
              {filteredRooms.length === 0 && (
                <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
                  No rooms match your search.
                </div>
              )}
            </div>

            {/* Stats Footer */}
            <div style={{ display: 'flex', borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.3)', marginTop: 'auto' }}>
              {[
                { label: 'TOTAL', val: stats.total, color: '#94a3b8' },
                { label: 'VACANT', val: stats.vacant, color: '#38bdf8' },
                { label: 'OCCUPIED', val: stats.occupied, color: '#f87171' },
                { label: 'DIRTY', val: stats.dirty, color: '#fbbf24' },
                { label: 'BOOKED', val: stats.booked, color: '#a78bfa' },
                { label: 'INACTIVE', val: stats.inactive, color: '#94a3b8' },
              ].map(s => (
                <div key={s.label} style={{ flex: 1, padding: '10px 12px', borderRight: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', letterSpacing: '0.5px', marginBottom: '2px' }}>{s.label}</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: s.color }}>{s.val}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Tab: Reservations ────────────────────────────────────────── */}
        {activeTab === 'reservations' && (
          <div className="dashboard-body">
            <ReservationModule 
              token={adminToken}
              user={adminUser}
              fetchStatus={() => fetchData(true)}
            />
          </div>
        )}

        {/* ── Tab: Guest Search ────────────────────────────────────────── */}
        {activeTab === 'guests' && (
          <div className="dashboard-body">
            <div style={{ padding: '18px 22px' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '16px' }}>🔍 Guest Search</h2>
              <GuestSearchPanel token={adminToken} />
            </div>
          </div>
        )}

        {/* ── Tab: Guest Requests ──────────────────────────────────────── */}
        {activeTab === 'requests' && (
          <div className="dashboard-body">
            <div style={{ padding: '18px 22px' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '16px' }}>📩 Guest Requests</h2>
              <GuestRequestsPanel token={adminToken} />
            </div>
          </div>
        )}

        {/* ── Tab: Food & Beverage ─────────────────────────────────────── */}
        {activeTab === 'food' && (
          <div className="dashboard-body">
            <FoodPOS token={adminToken} user={adminUser} />
          </div>
        )}

        {/* ── Tab: Cash Handover ───────────────────────────────────────── */}
        {activeTab === 'cash' && (
          <div className="dashboard-body">
            <div style={{ padding: '18px 22px' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '20px' }}>💵 Cash Handover</h2>
              <CashHandoverPanel token={adminToken} adminUser={adminUser} />
            </div>
          </div>
        )}
      </div>

      {/* ════════════════════════════════════════════════════
          MODALS — all self-contained, use existing APIs
          ════════════════════════════════════════════════════ */}

      {modal === 'walkin' && (
        <CheckInModal rooms={rooms} token={adminToken} onClose={closeModal} onSuccess={handleSuccess} isWalkIn={true}
          userRole={adminUser?.role} />
      )}

      {modal === 'checkin' && (
        <CheckInModal room={ctxRoom} rooms={rooms} token={adminToken} onClose={closeModal} onSuccess={handleSuccess} isWalkIn={!ctxRoom}
          userRole={adminUser?.role} />
      )}

      {modal === 'checkout' && ctxRoom && (
        <CheckOutModal room={ctxRoom} token={adminToken} onClose={closeModal} onSuccess={handleSuccess} />
      )}

      {modal === 'assign' && (
        <AssignRoomModal rooms={rooms} reservations={reservations} token={adminToken} onClose={closeModal} onSuccess={handleSuccess} />
      )}

      {modal === 'shift' && (
        <RoomShiftModal room={ctxRoom} rooms={rooms} token={adminToken} onClose={closeModal} onSuccess={handleSuccess} />
      )}

      {modal === 'extend' && (
        <ExtendStayModal room={ctxRoom} rooms={rooms} token={adminToken} onClose={closeModal} onSuccess={handleSuccess} />
      )}

      {modal === 'late' && (
        <LateCheckoutModal room={ctxRoom} rooms={rooms} token={adminToken} onClose={closeModal} onSuccess={handleSuccess} />
      )}

      {modal === 'early' && (
        <EarlyCheckInModal rooms={rooms} token={adminToken} onClose={closeModal} onSuccess={handleSuccess} />
      )}

      {modal === 'noshow' && (
        <NoShowModal room={ctxRoom} rooms={rooms} token={adminToken} onClose={closeModal} onSuccess={handleSuccess} />
      )}

      {modal === 'cancel' && (
        <CancelBookingModal room={ctxRoom} rooms={rooms} token={adminToken} onClose={closeModal} onSuccess={handleSuccess} />
      )}

      {confirmStatusModal && (
        <ConfirmModal 
          title={confirmStatusModal.title} 
          message={confirmStatusModal.message}
          onConfirm={() => executeRoomStatusChange(confirmStatusModal.room, confirmStatusModal.action)}
          onClose={() => setConfirmStatusModal(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '24px', right: '24px',
          background: 'rgba(8,15,30,0.97)', border: '1px solid rgba(74,222,128,0.4)',
          borderRadius: '10px', padding: '14px 20px', color: '#4ade80',
          fontWeight: 600, fontSize: '0.88rem', zIndex: 9999,
          boxShadow: '0 8px 30px rgba(0,0,0,0.5)', maxWidth: '380px',
          animation: 'slideInRight 0.3s ease',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}
