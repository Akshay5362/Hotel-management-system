import React, { useState, useEffect } from 'react';
import Toolbar from './components/Toolbar';
import RoomGrid from './components/RoomGrid';
import MetricsBar from './components/MetricsBar';
import CheckInModal from './components/CheckInModal';
import CheckOutModal from './components/CheckOutModal';
import RoomShiftingModal from './components/RoomShiftingModal';
import CashStatusModal from './components/CashStatusModal';
import ReportsModal from './components/ReportsModal';

// Starting initial room configuration directly mimicking the screenshot layout
const INITIAL_ROOMS = [
  { id: '101', number: '101', type: 'PREMIUM', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 3000, deposit: 0, checkInDate: '', ledger: [] },
  { id: '102', number: '102', type: 'EXECUTIVE', status: 'occupied', guestName: 'RAJVEER SINGH', pax: 2, phone: '+91 9876543210', rate: 2500, deposit: 1000, checkInDate: '10-Jul-2026', ledger: [{ id: 1, desc: 'Room Tariff Charge', qty: 1, amount: 2500 }, { id: 2, desc: 'Taxes & GST (12%)', qty: 1, amount: 300 }] },
  { id: '103', number: '103', type: 'EXECUTIVE', status: 'occupied', guestName: 'KATARI AKHILESH', pax: 1, phone: '+91 9123456789', rate: 2500, deposit: 2000, checkInDate: '09-Jul-2026', ledger: [{ id: 1, desc: 'Room Tariff Charge (2 Nights)', qty: 2, amount: 5000 }, { id: 2, desc: 'Taxes & GST (12%)', qty: 1, amount: 600 }, { id: 3, desc: 'Room Service (Mineral Water)', qty: 2, amount: 120 }] },
  { id: '104', number: '104', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', ledger: [] },
  { id: '105', number: '105', type: 'PREMIUM', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 3000, deposit: 0, checkInDate: '', ledger: [] },
  { id: '106', number: '106', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', ledger: [] },
  { id: '107', number: '107', type: 'EXECUTIVE', status: 'occupied', guestName: 'RAJESH', pax: 1, phone: '+91 8888888888', rate: 2500, deposit: 500, checkInDate: '11-Jul-2026', ledger: [{ id: 1, desc: 'Room Tariff Charge', qty: 1, amount: 2500 }, { id: 2, desc: 'Taxes & GST (12%)', qty: 1, amount: 300 }] },
  { id: '108', number: '108', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', ledger: [] },
  { id: '110', number: '110', type: 'EXECUTIVE', status: 'occupied', guestName: 'MR. NAVEEN SONI', pax: 2, phone: '+91 7777777777', rate: 2500, deposit: 1500, checkInDate: '10-Jul-2026', ledger: [{ id: 1, desc: 'Room Tariff Charge', qty: 1, amount: 2500 }, { id: 2, desc: 'Taxes & GST (12%)', qty: 1, amount: 300 }, { id: 3, desc: 'Restaurant Posting (Dinner)', qty: 1, amount: 480 }] },
  { id: '111', number: '111', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', ledger: [] },
  { id: '112', number: '112', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', ledger: [] },
  { id: '114', number: '114', type: 'SUPER DELUXE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 3500, deposit: 0, checkInDate: '', ledger: [] },
  { id: '116', number: '116', type: 'STANDARD', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 1500, deposit: 0, checkInDate: '', ledger: [] },
  { id: '117', number: '117', type: 'STANDARD', status: 'occupied', guestName: 'RAGHUBEER', pax: 1, phone: '+91 9999999999', rate: 1500, deposit: 1000, checkInDate: '11-Jul-2026', ledger: [{ id: 1, desc: 'Room Tariff Charge', qty: 1, amount: 1500 }, { id: 2, desc: 'Taxes & GST (12%)', qty: 1, amount: 180 }] },
  { id: '119', number: '119', type: 'STANDARD', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 1500, deposit: 0, checkInDate: '', ledger: [] },
  { id: '120', number: '120', type: 'STANDARD', status: 'dirty', guestName: '', pax: 0, phone: '', rate: 1500, deposit: 0, checkInDate: '', ledger: [] }
];

export default function App() {
  const [rooms, setRooms] = useState([]);
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Modal controllers
  const [activeModal, setActiveModal] = useState(null); // 'checkin' | 'checkout' | 'shifting' | 'cash' | 'reports' | null
  const [selectedRoom, setSelectedRoom] = useState(null);

  // Business context
  const [systemDate, setSystemDate] = useState('11-Jul-2026');
  const [currentTime, setCurrentTime] = useState('');
  const [todayCheckins, setTodayCheckins] = useState(0);
  const [todayCheckouts, setTodayCheckouts] = useState(0);
  const [continuedRooms, setContinuedRooms] = useState(0);
  
  // Transaction Cash Logs
  const [cashLog, setCashLog] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Custom Popup Notification/Confirmation/Prompt System state
  const [popup, setPopup] = useState(null);
  const [inputValue, setInputValue] = useState('');

  // Custom Popup Helpers
  const showAlert = (message, title = 'Notification') => {
    return new Promise((resolve) => {
      setPopup({
        type: 'alert',
        title,
        message,
        onConfirm: () => {
          setPopup(null);
          resolve();
        }
      });
    });
  };

  const showConfirm = (message, title = 'Confirmation') => {
    return new Promise((resolve) => {
      setPopup({
        type: 'confirm',
        title,
        message,
        onConfirm: () => {
          setPopup(null);
          resolve(true);
        },
        onCancel: () => {
          setPopup(null);
          resolve(false);
        }
      });
    });
  };

  const showPrompt = (message, placeholder = '', title = 'Input Required') => {
    return new Promise((resolve) => {
      setInputValue('');
      setPopup({
        type: 'prompt',
        title,
        message,
        placeholder,
        onConfirm: (val) => {
          setPopup(null);
          resolve(val);
        },
        onCancel: () => {
          setPopup(null);
          resolve(null);
        }
      });
    });
  };

  // Load status from backend
  const fetchStatus = async () => {
    try {
      // Add a 5-second timeout so the app never hangs forever
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch('http://localhost:5000/api/status', { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) throw new Error('Failed to fetch dashboard data');
      const data = await res.json();
      setRooms(data.rooms);
      setSystemDate(data.systemDate);
      setTodayCheckins(data.todayCheckins);
      setTodayCheckouts(data.todayCheckouts);
      setContinuedRooms(data.continuedRooms);
      setCashLog(data.cashLog);
    } catch (err) {
      console.error('Backend unreachable, loading local demo data:', err);
      // Fallback: load from local initial data so app never stays stuck
      setRooms(INITIAL_ROOMS);
      setTodayCheckins(2);
      setTodayCheckouts(4);
      setContinuedRooms(3);
    } finally {
      // Always stop loading — no matter what happens
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  // Clock runner
  useEffect(() => {
    const updateTime = () => {
      const date = new Date();
      let hours = date.getHours();
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12; // 0 should be 12
      setCurrentTime(`${hours}:${minutes}:${seconds} ${ampm}`);
    };
    
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Room card click logic
  const handleRoomClick = async (room) => {
    setSelectedRoom(room);
    if (room.status === 'vacant') {
      setActiveModal('checkin');
    } else if (room.status === 'occupied') {
      setActiveModal('checkout');
    } else if (room.status === 'dirty') {
      const confirmed = await showConfirm(`Mark Room ${room.number} as CLEAN and make it vacant?`, 'Clean Room Service');
      if (confirmed) {
        cleanRoom(room.number);
      }
    } else {
      showAlert(`Room ${room.number} is inactive and cannot be operated.`, 'Room Status');
    }
  };

  // Action Bar clicks
  const handleActionClick = async (action) => {
    switch (action) {
      case 'checkin':
        // Find first vacant room
        const firstVacant = rooms.find(r => r.status === 'vacant');
        if (firstVacant) {
          setSelectedRoom(firstVacant);
          setActiveModal('checkin');
        } else {
          showAlert('No vacant rooms available.', 'Availability Check');
        }
        break;
      case 'checkout':
        // Prompt for room number
        const outNo = await showPrompt('Enter Occupied Room Number for checkout folio:', 'e.g. 102', 'Folio Checkout Lookup');
        if (outNo) {
          const roomToOut = rooms.find(r => r.number === outNo && r.status === 'occupied');
          if (roomToOut) {
            setSelectedRoom(roomToOut);
            setActiveModal('checkout');
          } else {
            showAlert('Room not found or is not currently occupied.', 'Folio Error');
          }
        }
        break;
      case 'shifting':
        const shiftFromNo = await showPrompt('Enter current occupied room number to shift guest FROM:', 'e.g. 103', 'Guest Shifting Setup');
        if (shiftFromNo) {
          const roomToShift = rooms.find(r => r.number === shiftFromNo && r.status === 'occupied');
          if (roomToShift) {
            setSelectedRoom(roomToShift);
            setActiveModal('shifting');
          } else {
            showAlert('Room not found or is not currently occupied.', 'Shifting Lookup Error');
          }
        }
        break;
      case 'cash':
        setActiveModal('cash');
        break;
      case 'reports':
        setActiveModal('reports');
        break;
      case 'refresh':
        setFilter('all');
        setSearchQuery('');
        await fetchStatus();
        showAlert('Dashboard re-synced successfully with Front Office logs.', 'Sync Status');
        break;
      case 'exit':
        const confirmExit = await showConfirm('Are you sure you want to exit the Front Office Module?', 'Exit Front Office Module');
        if (confirmExit) {
          showAlert('Module closed. Returning to PMS shell.', 'System Closed');
        }
        break;
      default:
        break;
    }
  };

  // Check-In core action
  const checkInGuest = async (roomNumber, guestData) => {
    try {
      const formattedData = {
        ...guestData,
        checkInDate: formatDateString(guestData.checkInDate)
      };

      const res = await fetch(`http://localhost:5000/api/rooms/${roomNumber}/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formattedData)
      });

      if (!res.ok) {
        const errData = await res.json();
        showAlert(errData.error || 'Check-in failed', 'Check-in Error');
        return;
      }

      await fetchStatus();
      setActiveModal(null);
      setSelectedRoom(null);
      showAlert(`Guest ${guestData.guestName} successfully checked in to Room ${roomNumber}!`, 'Check-in Confirmed');
    } catch (err) {
      console.error('Error in checkInGuest:', err);
      showAlert('Network error, please try again.', 'Connection Error');
    }
  };

  // Check-Out core action
  const checkOutGuest = async (roomNumber, balancePaid) => {
    try {
      const res = await fetch(`http://localhost:5000/api/rooms/${roomNumber}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ balancePaid })
      });

      if (!res.ok) {
        const errData = await res.json();
        showAlert(errData.error || 'Checkout failed', 'Checkout Error');
        return;
      }

      await fetchStatus();
      setActiveModal(null);
      setSelectedRoom(null);
      showAlert(`Room ${roomNumber} successfully checked out. Folio settled.`, 'Checkout Complete');
    } catch (err) {
      console.error('Error in checkOutGuest:', err);
      showAlert('Network error, please try again.', 'Connection Error');
    }
  };

  // Clean dirty room
  const cleanRoom = async (roomNumber) => {
    try {
      const res = await fetch(`http://localhost:5000/api/rooms/${roomNumber}/clean`, {
        method: 'POST'
      });

      if (!res.ok) {
        const errData = await res.json();
        showAlert(errData.error || 'Cleaning room failed', 'Cleaning Error');
        return;
      }

      await fetchStatus();
      showAlert(`Room ${roomNumber} marked as clean and ready for booking.`, 'Room Cleaned');
    } catch (err) {
      console.error('Error in cleanRoom:', err);
      showAlert('Network error, please try again.', 'Connection Error');
    }
  };

  // Shift guest room
  const shiftGuest = async (fromRoomNumber, toRoomNumber) => {
    try {
      const res = await fetch('http://localhost:5000/api/rooms/shift', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromRoomNumber, toRoomNumber })
      });

      if (!res.ok) {
        const errData = await res.json();
        showAlert(errData.error || 'Room shifting failed', 'Shifting Error');
        return;
      }

      await fetchStatus();
      setActiveModal(null);
      setSelectedRoom(null);
      showAlert(`Guest shifted successfully to Room ${toRoomNumber}!`, 'Room Shift Confirmed');
    } catch (err) {
      console.error('Error in shiftGuest:', err);
      showAlert('Network error, please try again.', 'Connection Error');
    }
  };

  // Add bill posting ledger item
  const addLedgerItem = async (roomNumber, desc, amount) => {
    try {
      const res = await fetch(`http://localhost:5000/api/rooms/${roomNumber}/ledger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desc, amount })
      });

      if (!res.ok) {
        const errData = await res.json();
        showAlert(errData.error || 'Ledger item posting failed', 'Ledger Error');
        return;
      }

      // Re-fetch status to update standard ledger list
      await fetchStatus();

      // Update selectedRoom state locally for CheckoutModal reactive sync
      setSelectedRoom(prev => {
        if (prev && prev.number === roomNumber) {
          const nextId = prev.ledger.length > 0 ? Math.max(...prev.ledger.map(item => item.id)) + 1 : 1;
          return {
            ...prev,
            ledger: [...prev.ledger, { id: nextId, desc, qty: 1, amount }]
          };
        }
        return prev;
      });
    } catch (err) {
      console.error('Error in addLedgerItem:', err);
      showAlert('Network error, please try again.', 'Connection Error');
    }
  };

  // Run Day End audit
  const runDayEnd = async (auditReport) => {
    try {
      const res = await fetch('http://localhost:5000/api/dayend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nextDate: auditReport.nextDate })
      });

      if (!res.ok) {
        const errData = await res.json();
        showAlert(errData.error || 'Day end run failed', 'Day End Closure Error');
        return;
      }

      await fetchStatus();
    } catch (err) {
      console.error('Error in runDayEnd:', err);
      showAlert('Network error, please try again.', 'Connection Error');
    }
  };

  // Helper date formatter
  const formatDateString = (dateStr) => {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const year = parts[0];
    const month = months[parseInt(parts[1], 10) - 1];
    const day = parts[2];
    return `${day}-${month}-${year}`;
  };

  // Calculations for Metrics
  const vacantCount = rooms.filter(r => r.status === 'vacant').length;
  const occupiedCount = rooms.filter(r => r.status === 'occupied').length;
  const dirtyCount = rooms.filter(r => r.status === 'dirty').length;
  const bookedCount = rooms.filter(r => r.status === 'booked').length;
  const inactiveCount = rooms.filter(r => r.status === 'inactive').length;
  
  const roomCounts = {
    all: rooms.length,
    vacant: vacantCount,
    occupied: occupiedCount,
    dirty: dirtyCount,
    booked: bookedCount,
    inactive: inactiveCount
  };

  const occupancyRate = Math.round((occupiedCount / rooms.length) * 100);

  const globalStats = {
    total: rooms.length,
    occupancy: occupancyRate,
    vacant: vacantCount,
    occupied: occupiedCount,
    dirty: dirtyCount,
    todayCheckins,
    todayCheckouts,
    continuedRooms
  };

  const vacantRoomsList = rooms.filter(r => r.status === 'vacant');

  const handlePromptSubmit = (e) => {
    e.preventDefault();
    if (popup && popup.type === 'prompt' && popup.onConfirm) {
      popup.onConfirm(inputValue);
      setInputValue('');
    }
  };

  if (isLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundColor: '#080b10', color: '#fff' }}>
        <div className="logo-icon" style={{ fontSize: '3rem', marginBottom: '20px' }}>🏢</div>
        <h2 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, letterSpacing: '1px', marginBottom: '10px' }}>Webline PMS Plus</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Loading property details from database...</p>
        <div style={{ width: '40px', height: '40px', border: '3px solid rgba(56, 189, 248, 0.1)', borderTopColor: 'var(--color-vacant)', borderRadius: '50%', animation: 'spin 1s linear infinite', marginTop: '20px' }} />
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Header Panel */}
      <header className="header">
        <div className="brand-section">
          <span className="logo-icon">🏢</span>
          <h1 className="brand-name">
            Webline PMS Plus <span>HOTEL SKY-5</span>
          </h1>
        </div>

        <div className="status-time-widget">
          <div className="date-box">
            📅 Business Date: <strong>{systemDate}</strong>
          </div>
          <div className="time-box">
            {currentTime}
          </div>
          <div className="user-badge">
            <span className="user-indicator"></span>
            <span style={{ fontSize: '0.8rem', fontWeight: '600' }}>USER: KEVAL</span>
          </div>
        </div>
      </header>

      {/* Action and Filter Toolbar */}
      <Toolbar 
        onActionClick={handleActionClick}
        activeFilter={filter}
        setFilter={setFilter}
        roomCounts={roomCounts}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
      />

      {/* Main Workspace Rooms Grid */}
      <RoomGrid 
        rooms={rooms}
        activeFilter={filter}
        searchQuery={searchQuery}
        onRoomClick={handleRoomClick}
      />

      {/* Bottom Metrics Information Bar */}
      <MetricsBar 
        stats={globalStats}
      />

      {/* Modals & Dialog Portals */}
      <CheckInModal 
        isOpen={activeModal === 'checkin'}
        onClose={() => { setActiveModal(null); setSelectedRoom(null); }}
        room={selectedRoom}
        onCheckIn={checkInGuest}
        showAlert={showAlert}
      />

      <CheckOutModal 
        isOpen={activeModal === 'checkout'}
        onClose={() => { setActiveModal(null); setSelectedRoom(null); }}
        room={selectedRoom}
        onCheckOut={checkOutGuest}
        onAddLedgerItem={addLedgerItem}
        showAlert={showAlert}
        showConfirm={showConfirm}
      />

      <RoomShiftingModal 
        isOpen={activeModal === 'shifting'}
        onClose={() => { setActiveModal(null); setSelectedRoom(null); }}
        room={selectedRoom}
        vacantRooms={vacantRoomsList}
        onShiftRoom={shiftGuest}
        showAlert={showAlert}
        showConfirm={showConfirm}
      />

      <CashStatusModal 
        isOpen={activeModal === 'cash'}
        onClose={() => setActiveModal(null)}
        cashLog={cashLog}
      />

      <ReportsModal 
        isOpen={activeModal === 'reports'}
        onClose={() => setActiveModal(null)}
        rooms={rooms}
        cashLog={cashLog}
        currentDate={systemDate}
        onRunDayEnd={runDayEnd}
      />

      {/* Custom Popup Dialog System Overlay */}
      {popup && (
        <div className="modal-overlay popup-overlay">
          <div className="modal-content popup-content glass">
            <div className="modal-header" style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <h3>
                {popup.type === 'confirm' ? '❓ Confirmation' : popup.type === 'prompt' ? '✏️ Input Required' : '🔔 Notification'}
              </h3>
              <button className="btn-close" onClick={() => setPopup(null)}>&times;</button>
            </div>
            <div className="modal-body" style={{ padding: '1.5rem 1.25rem' }}>
              {popup.type === 'prompt' ? (
                <form onSubmit={handlePromptSubmit}>
                  <p style={{ fontSize: '0.95rem', color: '#cbd5e1', marginBottom: '15px', lineHeight: '1.4' }}>{popup.message}</p>
                  <input 
                    type="text" 
                    autoFocus
                    placeholder={popup.placeholder} 
                    value={inputValue} 
                    onChange={(e) => setInputValue(e.target.value)}
                    required
                    style={{ padding: '12px', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', fontSize: '1rem', width: '100%', marginBottom: '10px' }}
                  />
                  <div className="modal-footer" style={{ borderTop: 'none', padding: '10px 0 0 0', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                    <button type="button" className="btn-secondary" onClick={() => { if(popup.onCancel) popup.onCancel(); setPopup(null); }}>Cancel</button>
                    <button type="submit" className="btn-primary">Submit</button>
                  </div>
                </form>
              ) : (
                <div>
                  <p style={{ fontSize: '0.95rem', color: '#cbd5e1', margin: '10px 0 20px 0', lineHeight: '1.4' }}>{popup.message}</p>
                  <div className="modal-footer" style={{ borderTop: 'none', padding: '10px 0 0 0', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                    {popup.type === 'confirm' ? (
                      <>
                        <button type="button" className="btn-secondary" onClick={() => { if(popup.onCancel) popup.onCancel(); setPopup(null); }}>Cancel</button>
                        <button type="button" className="btn-primary" onClick={() => { if(popup.onConfirm) popup.onConfirm(); }}>Confirm</button>
                      </>
                    ) : (
                      <button type="button" className="btn-primary" onClick={() => { if(popup.onConfirm) popup.onConfirm(); }}>OK</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
