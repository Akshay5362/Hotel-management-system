import React, { useState, useEffect, useCallback } from 'react';
import Toolbar from './components/Toolbar';
import RoomGrid from './components/RoomGrid';
import MetricsBar from './components/MetricsBar';
import CheckInModal from './components/CheckInModal';
import CheckOutModal from './components/CheckOutModal';
import RoomShiftingModal from './components/RoomShiftingModal';
import CashStatusModal from './components/CashStatusModal';
import ReportsModal from './components/ReportsModal';
import AuthCard from './components/AuthCard';
import GuestDashboard from './components/GuestDashboard';
import ModifyCheckInModal from './components/ModifyCheckInModal';
import UpcomingReservationsModal from './components/UpcomingReservationsModal';
import GuestRequestsModal from './components/GuestRequestsModal';
import IdentityVerificationModal from './components/IdentityVerificationModal';
import RefundCheckoutModal from './components/RefundCheckoutModal';
import { AdminAuthProvider, AdminAuthContext } from './contexts/AdminAuthContext';
import { GuestAuthProvider, GuestAuthContext } from './contexts/GuestAuthContext';
import { AdminProtectedRoute, GuestProtectedRoute } from './components/ProtectedRoutes';

// Starting initial room configuration directly mimicking the screenshot layout
const INITIAL_ROOMS = [
  { id: '101', number: '101', type: 'PREMIUM', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', user_id: null, ledger: [] },
  { id: '102', number: '102', type: 'EXECUTIVE', status: 'occupied', guestName: 'RAJVEER SINGH', pax: 2, phone: '+91 9876543210', rate: 2000, deposit: 1000, checkInDate: '10-Jul-2026', user_id: null, ledger: [{ id: 1, desc: 'Room Tariff Charge', qty: 1, amount: 2000, business_date: '10-Jul-2026' }, { id: 2, desc: 'Taxes & GST (12%)', qty: 1, amount: 240, business_date: '10-Jul-2026' }] },
  { id: '103', number: '103', type: 'EXECUTIVE', status: 'occupied', guestName: 'KATARI AKHILESH', pax: 1, phone: '+91 9123456789', rate: 2000, deposit: 2000, checkInDate: '09-Jul-2026', user_id: 3, ledger: [{ id: 1, desc: 'Room Tariff Charge (2 Nights)', qty: 2, amount: 4000, business_date: '09-Jul-2026' }, { id: 2, desc: 'Taxes & GST (12%)', qty: 1, amount: 480, business_date: '09-Jul-2026' }, { id: 3, desc: 'Room Service (Mineral Water)', qty: 2, amount: 120, business_date: '10-Jul-2026' }] },
  { id: '104', number: '104', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2000, deposit: 0, checkInDate: '', user_id: null, ledger: [] },
  { id: '105', number: '105', type: 'PREMIUM', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', user_id: null, ledger: [] },
  { id: '106', number: '106', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2000, deposit: 0, checkInDate: '', user_id: null, ledger: [] },
  { id: '107', number: '107', type: 'EXECUTIVE', status: 'occupied', guestName: 'RAJESH', pax: 1, phone: '+91 8888888888', rate: 2000, deposit: 500, checkInDate: '11-Jul-2026', user_id: null, ledger: [{ id: 1, desc: 'Room Tariff Charge', qty: 1, amount: 2000, business_date: '11-Jul-2026' }, { id: 2, desc: 'Taxes & GST (12%)', qty: 1, amount: 240, business_date: '11-Jul-2026' }] },
  { id: '108', number: '108', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2000, deposit: 0, checkInDate: '', user_id: null, ledger: [] },
  { id: '110', number: '110', type: 'EXECUTIVE', status: 'occupied', guestName: 'MR. NAVEEN SONI', pax: 2, phone: '+91 7777777777', rate: 2000, deposit: 1500, checkInDate: '10-Jul-2026', user_id: null, ledger: [{ id: 1, desc: 'Room Tariff Charge', qty: 1, amount: 2000, business_date: '10-Jul-2026' }, { id: 2, desc: 'Taxes & GST (12%)', qty: 1, amount: 240, business_date: '10-Jul-2026' }, { id: 3, desc: 'Restaurant Posting (Dinner)', qty: 1, amount: 480, business_date: '10-Jul-2026' }] },
  { id: '111', number: '111', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2000, deposit: 0, checkInDate: '', user_id: null, ledger: [] },
  { id: '112', number: '112', type: 'EXECUTIVE', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2000, deposit: 0, checkInDate: '', user_id: null, ledger: [] },
  { id: '114', number: '114', type: 'PREMIUM', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 2500, deposit: 0, checkInDate: '', user_id: null, ledger: [] },
  { id: '116', number: '116', type: 'STANDARD', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 1500, deposit: 0, checkInDate: '', user_id: null, ledger: [] },
  { id: '117', number: '117', type: 'STANDARD', status: 'occupied', guestName: 'RAGHUBEER', pax: 1, phone: '+91 9999999999', rate: 1500, deposit: 1000, checkInDate: '11-Jul-2026', user_id: null, ledger: [{ id: 1, desc: 'Room Tariff Charge', qty: 1, amount: 1500, business_date: '11-Jul-2026' }, { id: 2, desc: 'Taxes & GST (12%)', qty: 1, amount: 180, business_date: '11-Jul-2026' }] },
  { id: '119', number: '119', type: 'STANDARD', status: 'vacant', guestName: '', pax: 0, phone: '', rate: 1500, deposit: 0, checkInDate: '', user_id: null, ledger: [] },
  { id: '120', number: '120', type: 'STANDARD', status: 'dirty', guestName: '', pax: 0, phone: '', rate: 1500, deposit: 0, checkInDate: '', user_id: null, ledger: [] }
];

function LandingPage({ onNavigate }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      width: '100vw',
      background: 'radial-gradient(circle at center, #0f172a 0%, #020617 100%)',
      color: '#fff',
      padding: '20px',
      textAlign: 'center'
    }}>
      <div style={{ marginBottom: '40px' }}>
        <div style={{ fontSize: '4.5rem', marginBottom: '15px', animation: 'floatAnimation 3s ease-in-out infinite' }}>🏨</div>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 900, fontSize: '3rem', background: 'linear-gradient(135deg, #38bdf8 0%, #818cf8 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: '1px' }}>
          HOTEL SKY-5
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', marginTop: '10px', maxWidth: '600px', margin: '10px auto' }}>
          Welcome to the Hotel Sky-5 Portal Hub. Please select a portal below to access reservations or property management systems.
        </p>
      </div>

      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '30px',
        justifyContent: 'center',
        maxWidth: '900px',
        width: '100%'
      }}>
        {/* Guest Portal Card */}
        <div 
          onClick={() => onNavigate('/login')}
          className="glass" 
          style={{
            flex: '1 1 350px',
            borderRadius: '16px',
            padding: '40px 30px',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            textAlign: 'left',
            boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '15px'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-5px)';
            e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.4)';
            e.currentTarget.style.boxShadow = '0 15px 40px rgba(56, 189, 248, 0.15)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
            e.currentTarget.style.boxShadow = '0 10px 30px rgba(0,0,0,0.3)';
          }}
        >
          <div style={{ fontSize: '2.5rem' }}>🧳</div>
          <h3 style={{ fontSize: '1.5rem', fontWeight: '800', color: '#fff' }}>Guest Portal</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: '1.5' }}>
            Book rooms, pay securely via credit card, view active reservations, and monitor billing statements in real time.
          </p>
          <button className="btn-primary" style={{ marginTop: 'auto', alignSelf: 'flex-start', background: 'var(--accent-grad)' }}>
            Enter Guest Portal
          </button>
        </div>

        {/* Staff Portal Card */}
        <div 
          onClick={() => onNavigate('/admin/login')}
          className="glass" 
          style={{
            flex: '1 1 350px',
            borderRadius: '16px',
            padding: '40px 30px',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            textAlign: 'left',
            boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '15px'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-5px)';
            e.currentTarget.style.borderColor = 'rgba(129, 140, 248, 0.4)';
            e.currentTarget.style.boxShadow = '0 15px 40px rgba(129, 140, 248, 0.15)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
            e.currentTarget.style.boxShadow = '0 10px 30px rgba(0,0,0,0.3)';
          }}
        >
          <div style={{ fontSize: '2.5rem' }}>🛡️</div>
          <h3 style={{ fontSize: '1.5rem', fontWeight: '800', color: '#fff' }}>Staff & Management</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: '1.5' }}>
            Access property management dashboards, perform check-ins/check-outs, clean rooms, shift guests, and run day-end audits.
          </p>
          <button className="btn-secondary" style={{ marginTop: 'auto', alignSelf: 'flex-start' }}>
            Enter Staff Portal
          </button>
        </div>
      </div>
    </div>
  );
}

function AppContent() {
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
  const [isBackendOnline, setIsBackendOnline] = useState(false);
  const [upcomingReservations, setUpcomingReservations] = useState([]);
  const [refundPolicy, setRefundPolicy] = useState({ noStayPct: 100, partialStayPct: 50, fullStayPct: 0, partialHours: 12 });

  // Contexts
  const { guestUser, guestToken, login: guestLogin, logout: guestLogout, updateUser: updateGuestUser } = React.useContext(GuestAuthContext);
  const { adminUser, adminToken, login: adminLogin, logout: adminLogout, updateUser: updateAdminUser } = React.useContext(AdminAuthContext);

  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  // Custom Navigation Router
  const navigate = (path) => {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
  };

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(window.location.pathname);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Auth-based route protection for login pages
  useEffect(() => {
    const path = currentPath;
    if ((path === '/login' || path === '/signup') && guestUser) {
      navigate('/dashboard');
    } else if (path === '/admin/login' && adminUser) {
      navigate('/admin/dashboard');
    }
  }, [currentPath, guestUser, adminUser]);

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

  const showConfirm = (message, title = 'Confirmation', confirmText = 'Confirm', cancelText = 'Cancel') => {
    return new Promise((resolve) => {
      setPopup({
        type: 'confirm',
        title,
        message,
        confirmText,
        cancelText,
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
    const currentToken = adminToken || guestToken;
    if (!currentToken) {
      setIsLoading(false);
      return;
    }

    try {
      // Add a 5-second timeout so the app never hangs forever
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(`http://localhost:5000/api/status?_t=${new Date().getTime()}`, { 
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${currentToken}`
        }
      });
      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem('user');
        localStorage.removeItem('token');
        setUser(null);
        setToken('');
        navigate(window.location.pathname.includes('admin') ? '/admin/login' : '/login');
        return;
      }

      if (!res.ok) throw new Error('Failed to fetch dashboard data');
      const data = await res.json();
      setRooms(data.rooms);
      setSystemDate(data.systemDate);
      setTodayCheckins(data.todayCheckins);
      setTodayCheckouts(data.todayCheckouts);
      setContinuedRooms(data.continuedRooms);
      setCashLog(data.cashLog);
      setUpcomingReservations(data.upcomingReservations || []);
      setIsBackendOnline(true);
    } catch (err) {
      console.error('Backend unreachable, loading local demo data:', err);
      setIsBackendOnline(false);
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

  // Fetch guest requests count for badge
  const [requestCount, setRequestCount] = useState(0);
  const fetchRequestCount = useCallback(async () => {
    const currentToken = adminToken;
    if (!currentToken) return;
    try {
      const res = await fetch('http://localhost:5000/api/admin/guest-requests', {
        headers: { Authorization: `Bearer ${currentToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setRequestCount(data.total || 0);
      }
    } catch (e) { /* silent */ }
  }, [adminToken]);

  // Auto-refresh request count every 15 seconds for admins (near real-time)
  useEffect(() => {
    if (!adminUser || adminUser.role !== 'admin' || !adminToken) return;
    fetchRequestCount();
    const interval = setInterval(fetchRequestCount, 15000);
    return () => clearInterval(interval);
  }, [adminUser, adminToken, fetchRequestCount]);

  // ── AUTO-POLL: Refresh full room grid every 20 seconds for admin ───────────────────
  // This ensures new guest bookings appear without manual refresh.
  const [lastSynced, setLastSynced] = useState(null);
  const [isSyncing,  setIsSyncing]  = useState(false);

  useEffect(() => {
    if (!adminToken || !adminUser || adminUser.role !== 'admin') return;

    const poll = async () => {
      // Don't poll while a modal is open (to avoid data flickering mid-operation)
      if (activeModal) return;
      setIsSyncing(true);
      try {
        await fetchStatus();
        setLastSynced(new Date());
      } catch (e) {
        // silent — fetchStatus handles its own error state
      } finally {
        setIsSyncing(false);
      }
    };

    // Immediate first poll
    poll();
    const interval = setInterval(poll, 20000); // every 20 seconds
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken, adminUser?.role, activeModal]);


  useEffect(() => {
    if (adminToken || guestToken) {
      fetchStatus();
    } else {
      setIsLoading(false);
    }
  }, [adminToken, guestToken]);

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
    // Force refresh status first to ensure we have the absolute latest ledger details/requests
    let freshRoom = room;
    try {
      const currentToken = adminToken;
      if (currentToken) {
        const res = await fetch('http://localhost:5000/api/status', {
          headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (res.ok) {
          const data = await res.json();
          setRooms(data.rooms);
          setSystemDate(data.systemDate);
          setTodayCheckins(data.todayCheckins);
          setTodayCheckouts(data.todayCheckouts);
          setContinuedRooms(data.continuedRooms);
          setCashLog(data.cashLog);
          setUpcomingReservations(data.upcomingReservations || []);
          setIsBackendOnline(true);
          
          const updated = data.rooms.find(r => r.number === room.number);
          if (updated) {
            freshRoom = updated;
          }
        }
      }
    } catch (e) {
      console.error('Error auto-refreshing room details on card click:', e);
    }

    setSelectedRoom(freshRoom);
    if (freshRoom.status === 'vacant') {
      setActiveModal('checkin');
    } else if (freshRoom.status === 'occupied') {
      setActiveModal('checkout');
    } else if (freshRoom.status === 'booked') {
      // Build a context-aware message about payment method
      const paymentNote = freshRoom.payment_method === 'Cash' || !freshRoom.payment_method
        ? `\n\n💵 This guest selected CASH payment. Confirm you have received \u20b9${freshRoom.deposit} cash at the reception before proceeding.`
        : `\n\nPayment method: ${freshRoom.payment_method}`;

      const confirmed = await showConfirm(
        `Guest ${freshRoom.guestName} has booked Room ${freshRoom.number} with a \u20b9${freshRoom.deposit} deposit.${paymentNote}\n\nCheck in this guest now?`,
        'Guest Arrival — Confirm Check-In',
        'Yes, Check In',
        'Cancel'
      );
      if (confirmed) {
        checkInBookedGuest(freshRoom.number);
      }
    } else if (freshRoom.status === 'dirty') {
      const confirmed = await showConfirm(`Mark Room ${freshRoom.number} as CLEAN and make it vacant?`, 'Clean Room Service');
      if (confirmed) {
        cleanRoom(freshRoom.number);
      }
    } else {
      showAlert(`Room ${freshRoom.number} is inactive and cannot be operated.`, 'Room Status');
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
          let freshRooms = rooms;
          try {
            const currentToken = adminToken;
            if (currentToken) {
              const res = await fetch('http://localhost:5000/api/status', {
                headers: { 'Authorization': `Bearer ${currentToken}` }
              });
              if (res.ok) {
                const data = await res.json();
                setRooms(data.rooms);
                setSystemDate(data.systemDate);
                setTodayCheckins(data.todayCheckins);
                setTodayCheckouts(data.todayCheckouts);
                setContinuedRooms(data.continuedRooms);
                setCashLog(data.cashLog);
                setUpcomingReservations(data.upcomingReservations || []);
                setIsBackendOnline(true);
                freshRooms = data.rooms;
              }
            }
          } catch (e) {
            console.error('Error auto-refreshing rooms for checkout action:', e);
          }

          const roomToOut = freshRooms.find(r => r.number === outNo && r.status === 'occupied');
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
      case 'reservations':
        setActiveModal('reservations');
        break;
      case 'reports':
        setActiveModal('reports');
        break;
      case 'id_verify':
        setActiveModal('id_verify');
        break;
      case 'requests':
        setActiveModal('requests');
        break;
      case 'refresh':
        setFilter('all');
        setSearchQuery('');
        await fetchStatus();
        await fetchRequestCount();
        showAlert('Dashboard re-synced successfully with Front Office logs.', 'Sync Status');
        break;
      case 'exit':
        const confirmExit = await showConfirm(
          'Do you want to exit?',
          'Exit Front Office Module',
          'Yes',
          'No'
        );
        if (confirmExit) {
          setUser(null);
          window.close();
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
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
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

  // Check-In Booked Guest action
  const checkInBookedGuest = async (roomNumber) => {
    const room = rooms.find(r => r.number === roomNumber);
    if (!room) return;

    try {
      // ─ Step 1: If cash payment is pending, confirm it now (admin receiving cash = confirmation) ─
      if (room.booking_id) {
        try {
          await fetch(`http://localhost:5000/api/payments/booking/${room.booking_id}/confirm-cash`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${adminToken}` }
          });
          // Non-fatal: booking can still proceed even if confirm-cash has nothing to confirm
        } catch (cashErr) {
          console.warn('Cash confirm attempt failed (non-blocking):', cashErr.message);
        }
      }

      // ─ Step 2: Admin check-in (room status -> occupied) ────────────────────────
      const res = await fetch(`http://localhost:5000/api/rooms/${roomNumber}/checkin`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          guestName: room.guestName,
          phone: room.phone,
          pax: room.pax,
          deposit: room.deposit,
          checkInDate: room.checkInDate
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        showAlert(errData.error || 'Check-in failed', 'Check-in Error');
        return;
      }

      await fetchStatus();
      setSelectedRoom(null);
      showAlert(`Guest successfully checked in to Room ${roomNumber}!`, 'Check-in Confirmed');
    } catch (err) {
      console.error('Error in checkInBookedGuest:', err);
      showAlert('Network error, please try again.', 'Connection Error');
    }
  };

  // Check-Out core action
  const checkOutGuest = async (roomNumber, balancePaid) => {
    try {
      const res = await fetch(`http://localhost:5000/api/rooms/${roomNumber}/checkout`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
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

  // Process refund cancellation checkout — called when RefundCheckoutModal succeeds
  const processRefundCheckout = async (roomNumber, refundAmount) => {
    await fetchStatus();
    setActiveModal(null);
    setSelectedRoom(null);
    showAlert(
      `Cancellation refund of Rs.${refundAmount.toLocaleString('en-IN')} processed for Room ${roomNumber}. Room is now marked as dirty.`,
      'Refund Checkout Complete'
    );
  };

  // Modify guest check-in details
  const modifyCheckInGuest = async (roomNumber, modifiedData) => {
    try {
      const formattedData = {
        ...modifiedData,
        checkInDate: formatDateString(modifiedData.checkInDate),
        expectedCheckOutDate: formatDateString(modifiedData.expectedCheckOutDate)
      };

      const res = await fetch(`http://localhost:5000/api/rooms/${roomNumber}/checkin`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify(formattedData)
      });

      if (!res.ok) {
        const errData = await res.json();
        showAlert(errData.error || 'Modification failed', 'Modification Error');
        return;
      }

      await fetchStatus();
      setActiveModal(null);
      setSelectedRoom(null);
      showAlert(`Guest check-in details for Room ${roomNumber} updated successfully!`, 'Modification Saved');
    } catch (err) {
      console.error('Error in modifyCheckInGuest:', err);
      showAlert('Network error, please try again.', 'Connection Error');
    }
  };

  // Handle click on an upcoming reservation in the admin panel
  const handleUpcomingReservationClick = (res) => {
    setSelectedRoom({
      number: res.roomNumber,
      type: res.roomType,
      guestName: res.guestName,
      phone: res.phone,
      pax: res.adults,
      deposit: res.deposit,
      checkInDate: res.checkInDate,
      expectedCheckOutDate: res.expectedCheckOutDate,
      address: res.address || '',
      gst_no: res.gst_no || '',
      pincode: res.pincode || '',
      country: res.country || '',
      arrival_from: res.arrival_from || '',
      departure_to: res.departure_to || '',
      status: 'booked'
    });
    setActiveModal('modify_checkin');
  };

  // Clean dirty room
  const cleanRoom = async (roomNumber) => {
    try {
      const res = await fetch(`http://localhost:5000/api/rooms/${roomNumber}/clean`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`
        }
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
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
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
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
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
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
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

  const handleAuthSuccess = (userData, userToken) => {
    if (userData.role === 'admin') {
      adminLogin(userData, userToken);
      navigate('/admin/dashboard');
    } else {
      guestLogin(userData, userToken);
      navigate('/dashboard');
    }
  };

  const handleGuestUpdate = (updatedUserData) => {
    updateGuestUser(updatedUserData);
  };

  const handleGuestLogout = () => {
    guestLogout();
    navigate('/login');
  };

  const handleAdminLogout = () => {
    adminLogout();
    navigate('/admin/login');
  };

  let pageContent = null;

  if (currentPath === '/') {
    pageContent = <LandingPage onNavigate={navigate} />;
  } else if (currentPath === '/login') {
    pageContent = (
      <AuthCard 
        isAdmin={false} 
        initialIsSignUp={false} 
        onAuthSuccess={handleAuthSuccess} 
        showAlert={showAlert} 
        onNavigate={navigate} 
      />
    );
  } else if (currentPath === '/signup') {
    pageContent = (
      <AuthCard 
        isAdmin={false} 
        initialIsSignUp={true} 
        onAuthSuccess={handleAuthSuccess} 
        showAlert={showAlert} 
        onNavigate={navigate} 
      />
    );
  } else if (currentPath === '/admin/login') {
    pageContent = (
      <AuthCard 
        isAdmin={true} 
        onAuthSuccess={handleAuthSuccess} 
        showAlert={showAlert} 
        onNavigate={navigate} 
      />
    );
  } else if (currentPath === '/dashboard') {
    pageContent = (
      <GuestProtectedRoute navigate={navigate}>
        <GuestDashboard 
          user={guestUser} 
          token={guestToken}
          rooms={rooms} 
          systemDate={systemDate} 
          onLogout={handleGuestLogout} 
          showAlert={showAlert} 
          fetchStatus={fetchStatus} 
          onUserUpdate={handleGuestUpdate}
        />
      </GuestProtectedRoute>
    );
  } else if (currentPath === '/admin/dashboard') {
    pageContent = (
      <AdminProtectedRoute navigate={navigate}>
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
              {/* Live sync indicator */}
              <div
                title={lastSynced ? `Last synced: ${lastSynced.toLocaleTimeString()}` : 'Syncing...'}
                style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  fontSize: '0.7rem', color: isSyncing ? '#38bdf8' : (lastSynced ? '#4ade80' : '#fbbf24'),
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${isSyncing ? 'rgba(56,189,248,0.2)' : 'rgba(74,222,128,0.15)'}`,
                  padding: '3px 8px', borderRadius: '4px', cursor: 'default'
                }}
              >
                <span style={{
                  width: '6px', height: '6px', borderRadius: '50%',
                  background: isSyncing ? '#38bdf8' : (lastSynced ? '#4ade80' : '#fbbf24'),
                  boxShadow: isSyncing ? '0 0 6px #38bdf8' : (lastSynced ? '0 0 6px #4ade80' : 'none'),
                  animation: isSyncing ? 'pulse 1s infinite' : 'none',
                  display: 'inline-block'
                }} />
                {isSyncing ? 'Syncing...' : lastSynced
                  ? `Synced ${Math.round((Date.now() - lastSynced) / 1000)}s ago`
                  : 'Connecting...'}
              </div>
              <div className="user-badge" data-tooltip={isBackendOnline ? "System Sync Active (MySQL Connected)" : "Demo Mode (MySQL Disconnected)"}>
                <span className="user-indicator" style={{ background: isBackendOnline ? 'var(--color-booked)' : 'var(--color-occupied)', boxShadow: isBackendOnline ? '0 0 8px var(--color-booked)' : '0 0 8px var(--color-occupied)' }}></span>
                <span style={{ fontSize: '0.8rem', fontWeight: '600' }}>
                  USER: {adminUser?.fullName?.toUpperCase()}
                </span>
                <button onClick={handleAdminLogout} style={{ background: 'transparent', border: 'none', color: '#ff4d4d', marginLeft: '10px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: '700' }}>
                  Logout
                </button>
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
            requestCount={requestCount}
          />

          {/* Main Workspace Scrollable Body */}
          <div className="dashboard-body">
            <RoomGrid 
              rooms={rooms}
              activeFilter={filter}
              searchQuery={searchQuery}
              onRoomClick={handleRoomClick}
            />
          </div>

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
            onModifyClick={() => setActiveModal('modify_checkin')}
            onRefundClick={() => setActiveModal('refund_checkout')}
            showAlert={showAlert}
            showConfirm={showConfirm}
          />

          <ModifyCheckInModal
            isOpen={activeModal === 'modify_checkin'}
            onClose={() => { setActiveModal(null); setSelectedRoom(null); }}
            room={selectedRoom}
            onModify={modifyCheckInGuest}
            showAlert={showAlert}
          />

          <UpcomingReservationsModal
            isOpen={activeModal === 'reservations'}
            onClose={() => setActiveModal(null)}
            reservations={upcomingReservations}
            onSelectReservation={handleUpcomingReservationClick}
          />

          <GuestRequestsModal
            isOpen={activeModal === 'requests'}
            onClose={() => setActiveModal(null)}
            token={adminToken}
            onRequestResolved={fetchRequestCount}
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

          <IdentityVerificationModal
            isOpen={activeModal === 'id_verify'}
            onClose={() => setActiveModal(null)}
            token={adminToken}
            rooms={rooms}
          />

          <RefundCheckoutModal
            isOpen={activeModal === 'refund_checkout'}
            onClose={() => setActiveModal('checkout')}
            room={selectedRoom}
            token={adminToken}
            onRefundComplete={processRefundCheckout}
            showAlert={showAlert}
            showConfirm={showConfirm}
          />
        </div>
      </AdminProtectedRoute>
    );
  } else {
    pageContent = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#080b10', color: '#fff' }}>
        <h3>Page Not Found</h3>
        <p style={{ color: 'var(--text-muted)', margin: '10px 0 20px 0' }}>Redirecting to landing page...</p>
      </div>
    );
    setTimeout(() => navigate('/'), 1200);
  }

  return (
    <div style={{ minHeight: '100vh', width: '100vw' }}>
      {pageContent}

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
                        <button type="button" className="btn-secondary" onClick={() => { if(popup.onCancel) popup.onCancel(); setPopup(null); }}>
                          {popup.cancelText || 'Cancel'}
                        </button>
                        <button type="button" className="btn-primary" onClick={() => { if(popup.onConfirm) popup.onConfirm(); }}>
                          {popup.confirmText || 'Confirm'}
                        </button>
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

export default function App() {
  return (
    <AdminAuthProvider>
      <GuestAuthProvider>
        <AppContent />
      </GuestAuthProvider>
    </AdminAuthProvider>
  );
}
