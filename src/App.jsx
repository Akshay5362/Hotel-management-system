import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
import AnalyticsModal from './components/AnalyticsModal';
import SettingsModal from './components/SettingsModal';
import { AdminAuthProvider, AdminAuthContext } from './contexts/AdminAuthContext';
import { GuestAuthProvider, GuestAuthContext } from './contexts/GuestAuthContext';
import { AdminProtectedRoute, GuestProtectedRoute, RoleProtectedRoute } from './components/ProtectedRoutes';
import { ReceptionDashboard, PantryDashboard, HousekeepingDashboard } from './components/StaffDashboards';
import KitchenDashboard from './components/KitchenDashboard';
import ReceptionPortal from './components/ReceptionPortal';
import Sidebar from './components/Sidebar';
import RoomInspectorDrawer from './components/RoomInspectorDrawer';
import { auth } from './config/firebaseClient';
import InventoryModule from './components/InventoryModule';
import FoodPOS from './components/food/FoodPOS';           // Food POS Phase 1 — Menu Master
import { io } from 'socket.io-client';
import { API_URL, SOCKET_URL, getApiHeaders } from './config/apiConfig';



// Room inventory: 17 rooms — 3 Premium, 10 Executive, 4 Standard
// Rooms 13, 15, 18 do NOT exist.


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

import AdminHousekeeping from './components/AdminHousekeeping.jsx';
import AdminGuests from './components/AdminGuests.jsx';
import ReservationModule from './components/ReservationModule.jsx';

function AppContent() {
  const [adminTab, setAdminTab] = useState('frontdesk');
  const [rooms, setRooms] = useState([]);
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Modal controllers
  const [activeModal, setActiveModal] = useState(null); // 'checkin' | 'checkout' | 'shifting' | 'cash' | 'reports' | null
  const [selectedRoomNumber, setSelectedRoomNumber] = useState(null);

  // Authoritative live selected room derived continuously from rooms array (Single Source of Truth)
  const liveSelectedRoom = React.useMemo(() => {
    if (!selectedRoomNumber) return null;
    const selStr = String(selectedRoomNumber).trim();
    // IMPORTANT: Never compare r.id (legacy MySQL surrogate PK) against the visible room number.
    // r.id values do NOT correspond to canonical room numbers after migration
    // (e.g. Room 12 has mysql id=17, Room 17 has mysql id=14), causing cross-room collisions.
    // Resolve exclusively by canonical visible number or Firestore document ID.
    const found = rooms.find(
      r => String(r.number) === selStr || String(r.doc_id) === selStr
    );
    return found || null;
  }, [rooms, selectedRoomNumber]);

  const setSelectedRoom = React.useCallback((roomOrNum) => {
    if (!roomOrNum) {
      setSelectedRoomNumber(null);
    } else if (typeof roomOrNum === 'object') {
      // Store canonical room number; fall back to Firestore doc_id.
      // Never fall back to roomOrNum.id (MySQL surrogate PK) — it does not equal the visible room number.
      setSelectedRoomNumber(String(roomOrNum.number || roomOrNum.doc_id || ''));
    } else {
      setSelectedRoomNumber(String(roomOrNum));
    }
  }, []);

  // Business context
  const [systemDate, setSystemDate] = useState('11-Jul-2026');
  const [currentTime, setCurrentTime] = useState('');
  const [todayCheckins, setTodayCheckins] = useState(0);
  const [todayCheckouts, setTodayCheckouts] = useState(0);
  const [continuedRooms, setContinuedRooms] = useState(0);
  
  // Transaction Cash Logs
  const [cashLog, setCashLog] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBackendOnline, setIsBackendOnline] = useState(true);
  const [dataStatus, setDataStatus] = useState('fresh'); // 'fresh' | 'stale' | 'degraded'
  const [staleReason, setStaleReason] = useState(null);
  const [upcomingReservations, setUpcomingReservations] = useState([]);
  const [refundPolicy, setRefundPolicy] = useState({ noStayPct: 100, partialStayPct: 50, fullStayPct: 0, partialHours: 12 });

  // Contexts
  const { guestUser, guestToken, login: guestLogin, logout: guestLogout, updateUser: updateGuestUser } = React.useContext(GuestAuthContext);
  const { adminUser, adminToken, login: adminLogin, logout: adminLogout, updateUser: updateAdminUser } = React.useContext(AdminAuthContext);

  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  // Custom Navigation Router
  const navigate = useCallback((path) => {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
  }, []);

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
      // Route to the correct dashboard based on stored role — do NOT always route to /admin/dashboard
      const roleUpper = (adminUser.role || '').toUpperCase();
      switch (roleUpper) {
        case 'SUPER_ADMIN':
        case 'ADMIN':
          navigate('/admin/dashboard');
          break;
        case 'RECEPTIONIST':
          navigate('/reception/dashboard');
          break;
        case 'CHEF':
        case 'KITCHEN_HELPER':
        case 'PANTRY_BOY':
        case 'KITCHEN':
          navigate('/kitchen/dashboard');
          break;
        case 'CLEANER':
          navigate('/housekeeping/dashboard');
          break;
        default:
          navigate('/admin/dashboard');
      }
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

  // In-flight guard to prevent duplicate concurrent status fetches
  const statusFetchInFlightRef = useRef(false);

  // Load status from backend
  const fetchStatus = useCallback(async () => {
    if (statusFetchInFlightRef.current) {
      return; // Avoid duplicate concurrent in-flight status fetches
    }

    const currentToken = adminToken || guestToken;
    const tokenSource = adminToken ? 'AdminAuthContext (localStorage adminToken)' : (guestToken ? 'GuestAuthContext (localStorage guestToken)' : 'None');
    if (!currentToken) {
      setIsLoading(false);
      return;
    }

    statusFetchInFlightRef.current = true;
    const requestUrl = `${API_URL}/status?_t=${new Date().getTime()}`;
    const authHeader = `Bearer ${currentToken}`;

    try {
      // Add a 5-second timeout so the app never hangs forever
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      console.log(`[API Request] URL: ${requestUrl} | Token Source: ${tokenSource} | Auth Header: ${authHeader.substring(0, 20)}...`);

      let res = await fetch(requestUrl, { 
        signal: controller.signal,
        headers: getApiHeaders(currentToken)
      });
      clearTimeout(timeout);

      console.log(`[API Response Status] ${res.status}`);

      // Any HTTP response from server means backend is reachable and online
      setIsBackendOnline(true);

      // Handle 401 with graceful token refresh and a single immediate retry
      if (res.status === 401) {
        console.warn('[API Auth Warning] Server returned HTTP 401. Attempting token refresh and single retry...');
        let refreshedSuccessfully = false;

        if (auth && auth.currentUser) {
          try {
            const freshToken = await auth.currentUser.getIdToken(true);
            if (freshToken) {
              if (adminToken) {
                localStorage.setItem('adminToken', freshToken);
              } else if (guestToken) {
                localStorage.setItem('guestToken', freshToken);
              }

              // Retry the request once with the fresh token
              const retryController = new AbortController();
              const retryTimeout = setTimeout(() => retryController.abort(), 5000);
              const retryRes = await fetch(requestUrl, {
                signal: retryController.signal,
                headers: getApiHeaders(freshToken)
              });
              clearTimeout(retryTimeout);

              if (retryRes.ok) {
                res = retryRes;
                refreshedSuccessfully = true;
                console.log('[API Auth Recovery] Retry succeeded with refreshed token.');
              } else if (retryRes.status === 401) {
                console.warn('[API Auth Warning] Retry still returned 401 after token refresh.');
              }
            }
          } catch (refreshErr) {
            console.warn('[API Auth Warning] Token refresh attempt threw:', refreshErr.message);
          }
        }

        // If refresh + retry failed and user is genuinely unauthenticated in Firebase
        if (!refreshedSuccessfully) {
          if (!auth || !auth.currentUser) {
            console.warn('[API Auth Warning] User is not authenticated in Firebase. Logging out.');
            const isAdminPath = window.location.pathname.includes('admin');
            if (isAdminPath) {
              adminLogout();
              navigate('/admin/login');
            } else {
              guestLogout();
              navigate('/login');
            }
            return;
          }
          // If auth.currentUser still exists, do not destroy session prematurely on transient error
          console.warn('[API Auth Warning] Skipping hard logout because Firebase session is still active.');
          return;
        }
      }

      // Handle 403: Forbidden (Role / Permission check failed — do NOT logout authenticated users)
      if (res.status === 403) {
        console.warn('[API Auth Warning] Server returned HTTP 403 (Forbidden: user lacks permission). Session preserved.');
        return;
      }

      if (res.ok) {
        const data = await res.json();
        console.log('[API Response Body]', data);

        if (Array.isArray(data.rooms)) {
          setRooms(data.rooms);
        }
        if (data.systemDate) setSystemDate(data.systemDate);
        if (data.todayCheckins !== undefined) setTodayCheckins(data.todayCheckins);
        if (data.todayCheckouts !== undefined) setTodayCheckouts(data.todayCheckouts);
        if (data.continuedRooms !== undefined) setContinuedRooms(data.continuedRooms);
        if (data.cashLog) setCashLog(data.cashLog);
        if (data.upcomingReservations) setUpcomingReservations(data.upcomingReservations || []);

        setDataStatus(data.data_status || 'fresh');
        setStaleReason(data.stale_reason || null);
      } else {
        const errorJson = await res.json().catch(() => null);
        console.warn('[API Server Warning] Non-200 status response from backend:', res.status, errorJson);
        if (res.status === 503 || errorJson?.code === 'FIRESTORE_RESOURCE_EXHAUSTED') {
          setDataStatus('degraded');
          setStaleReason('FIRESTORE_RESOURCE_EXHAUSTED');
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn('[API Warning] Status request timed out (5s). Preserving backend online state.');
        setDataStatus('degraded');
        setStaleReason('REQUEST_TIMEOUT');
      } else {
        console.error('[API Network Error] Backend unreachable / connection error:', err);
        setIsBackendOnline(false);
      }
    } finally {
      statusFetchInFlightRef.current = false;
      setIsLoading(false);
    }
  }, [adminToken, guestToken, navigate]);

  // Fetch guest requests count for badge
  const [requestCount, setRequestCount] = useState(0);
  const fetchRequestCount = useCallback(async () => {
    const currentToken = adminToken;
    if (!currentToken) return;
    try {
      const res = await fetch(`${API_URL}/admin/guest-requests`, {
        headers: getApiHeaders(currentToken)
      });
      if (res.ok) {
        const data = await res.json();
        setRequestCount(data.total || 0);
      }
    } catch (e) { /* silent */ }
  }, [adminToken]);

  // Real-time Guest Requests and Fallback Polling
  useEffect(() => {
    if (!adminUser || adminUser.role !== 'admin' || !adminToken) return;
    fetchRequestCount();

    const socket = io(SOCKET_URL);

    let fallbackInterval = null;

    socket.on('connect', () => {
      console.log('Connected to real-time Guest Requests socket');
      if (fallbackInterval) {
        clearInterval(fallbackInterval);
        fallbackInterval = null;
      }
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from socket. Falling back to 15s polling.');
      if (!fallbackInterval) {
        fallbackInterval = setInterval(fetchRequestCount, 15000);
      }
    });

    socket.on('new_guest_request', () => {
      fetchRequestCount();
      // Dispatch an event so GuestRequestsModal can refresh if it's currently open
      document.dispatchEvent(new CustomEvent('guest-request-refresh'));
    });

    socket.on('food:order_ready', (data) => {
      if (data && data.order_number) {
        const dest = data.destination_type === 'ROOM' ? `Room ${data.room_number}` : (data.table_name || 'Restaurant');
        showAlert(`Food Order ${data.order_number} is READY for dispatch to ${dest} (Server: ${data.waiter_name || 'Staff'})`, 'Kitchen Alert — Order Ready');
      }
    });

    return () => {
      if (fallbackInterval) clearInterval(fallbackInterval);
      socket.disconnect();
    };
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
      // Skip automatic background interval poll if page/tab is currently hidden
      if (typeof document !== 'undefined' && document.hidden) return;

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

    // Visibility change listener: refresh immediately upon returning to tab
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && !activeModal) {
        poll();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken, adminUser?.role, activeModal, fetchStatus]);


  useEffect(() => {
    // For guests (non-admin), trigger initial status load here (admins are polled by the effect above)
    if (guestToken && !adminToken) {
      fetchStatus();
    } else if (!adminToken && !guestToken) {
      setIsLoading(false);
    }

    const handleDateChange = () => {
      fetchStatus();
      if (adminToken) fetchRequestCount();
    };

    // Factory Reset auto-refresh — reloads all rooms, counters and data
    // immediately after a successful factory reset without restarting Electron.
    const handleFactoryReset = () => {
      fetchStatus();
      if (adminToken) fetchRequestCount();
    };

    window.addEventListener('businessDateChanged', handleDateChange);
    window.addEventListener('factoryResetComplete', handleFactoryReset);
    return () => {
      window.removeEventListener('businessDateChanged', handleDateChange);
      window.removeEventListener('factoryResetComplete', handleFactoryReset);
    };
  }, [adminToken, guestToken, fetchStatus, fetchRequestCount]);

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
        const res = await fetch(`${API_URL}/status`, {
          headers: getApiHeaders(currentToken)
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
              const res = await fetch(`${API_URL}/status`, {
                headers: getApiHeaders(currentToken)
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
      case 'analytics':
        setActiveModal('analytics');
        break;
      case 'id_verify':
        setActiveModal('id_verify');
        break;
      case 'requests':
        setActiveModal('requests');
        break;
      case 'settings':
        setActiveModal('settings');
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
          adminLogout();
          navigate('/admin/login');
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

      const res = await fetch(`${API_URL}/rooms/${roomNumber}/checkin`, {
        method: 'POST',
        headers: getApiHeaders(adminToken, { 'Content-Type': 'application/json' }),
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
          await fetch(`${API_URL}/payments/booking/${room.booking_id}/confirm-cash`, {
            method: 'PUT',
            headers: getApiHeaders(adminToken)
          });
          // Non-fatal: booking can still proceed even if confirm-cash has nothing to confirm
        } catch (cashErr) {
          console.warn('Cash confirm attempt failed (non-blocking):', cashErr.message);
        }
      }

      // ─ Step 2: Admin check-in (room status -> occupied) ────────────────────────
      const res = await fetch(`${API_URL}/rooms/${roomNumber}/checkin`, {
        method: 'POST',
        headers: getApiHeaders(adminToken, { 'Content-Type': 'application/json' }),
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
      const res = await fetch(`${API_URL}/rooms/${roomNumber}/checkout`, {
        method: 'POST',
        headers: getApiHeaders(adminToken, { 'Content-Type': 'application/json' }),
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

      const res = await fetch(`${API_URL}/rooms/${roomNumber}/checkin`, {
        method: 'PUT',
        headers: getApiHeaders(adminToken, { 'Content-Type': 'application/json' }),
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
      state: res.state || '',
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
      const res = await fetch(`${API_URL}/rooms/${roomNumber}/clean`, {
        method: 'POST',
        headers: getApiHeaders(adminToken)
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
  const shiftGuest = async (fromRoomNumber, toRoomNumber, adjustmentOptions = {}) => {
    try {
      const res = await fetch(`${API_URL}/rooms/shift`, {
        method: 'POST',
        headers: getApiHeaders(adminToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          fromRoomNumber,
          toRoomNumber,
          adjustmentType: adjustmentOptions.adjustmentType || 'AUTOMATIC',
          manualAdjustmentAmount: adjustmentOptions.manualAdjustmentAmount || 0,
          manualAdjustmentReason: adjustmentOptions.manualAdjustmentReason || '',
          idempotencyKey: `shift_${fromRoomNumber}_${toRoomNumber}_${Date.now()}`
        })
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
  const addLedgerItem = async (roomNumber, desc, amount, category = 'General') => {
    try {
      const res = await fetch(`${API_URL}/rooms/${roomNumber}/ledger`, {
        method: 'POST',
        headers: getApiHeaders(adminToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ desc, amount, category })
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
          const nextId = prev.ledger && prev.ledger.length > 0 ? Math.max(...prev.ledger.map(item => item.id || 0)) + 1 : 1;
          return {
            ...prev,
            ledger: [...(prev.ledger || []), { id: nextId, desc, qty: 1, amount, category }]
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
      const res = await fetch(`${API_URL}/dayend`, {
        method: 'POST',
        headers: getApiHeaders(adminToken, { 'Content-Type': 'application/json' }),
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

  // Handle Room Status change (Mark Active / Inactive, Mark Clean / Dirty)
  const handleRoomStatusChange = async (roomNumber, action) => {
    try {
      const res = await fetch(`${API_URL}/rooms/${roomNumber}/status`, {
        method: 'PUT',
        headers: getApiHeaders(adminToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action })
      });

      if (!res.ok) {
        const errData = await res.json();
        showAlert(errData.error || 'Failed to update room status', 'Room Update Error');
        return;
      }

      const data = await res.json();
      const updatedRoom = data.room;

      if (updatedRoom) {
        // Match ONLY by canonical visible room number — never by r.id (MySQL surrogate PK).
        // r.id does not equal the visible room number after migration (e.g. Room 12 has id=17,
        // Room 17 has id=14), so the old r.id branch caused cross-room number corruption.
        setRooms(prev => prev.map(r => String(r.number) === String(roomNumber) ? { ...r, ...updatedRoom } : r));
      }

      await fetchStatus();

      showAlert(`Room ${roomNumber} updated successfully.`, 'Status Updated');
    } catch (err) {
      console.error('Error in handleRoomStatusChange:', err);
      showAlert('Network error, please try again.', 'Connection Error');
    }
  };

  // Helper date formatter — converts YYYY-MM-DD (or "YYYY-MM-DD HH:mm") → DD-Mon-YYYY
  const formatDateString = (dateStr) => {
    if (!dateStr) return '';
    // Strip any time component (e.g. "2026-08-19 11:00" → "2026-08-19")
    const datePart = String(dateStr).split(' ')[0];
    const parts = datePart.split('-');
    if (parts.length !== 3) return datePart;
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

  const occupancyRate = rooms.length === 0 ? 0 : Math.round((occupiedCount / rooms.length) * 100);

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

  const vacantRoomsList = useMemo(() => {
    return rooms.filter(r => r.status === 'vacant');
  }, [rooms]);

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
    // Determine whether this is a staff/admin user regardless of which auth path delivered it.
    // getMe now returns loginType:'staff'|'admin' and type:'staff'|'admin'.
    // Legacy JWT path returns loginType:'staff'.
    const roleUpper    = (userData.role || '').toUpperCase();
    const loginType    = (userData.loginType || userData.type || '').toLowerCase();
    const isStaffLogin = loginType === 'staff' || loginType === 'admin'
      || roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN'
      || roleUpper === 'RECEPTIONIST' || roleUpper === 'CHEF'
      || roleUpper === 'KITCHEN_HELPER' || roleUpper === 'PANTRY_BOY' || roleUpper === 'CLEANER';

    if (isStaffLogin) {
      adminLogin(userData, userToken);

      // Route to the correct dashboard based on the role returned by the server.
      switch (roleUpper) {
        case 'SUPER_ADMIN':
        case 'ADMIN':
          navigate('/admin/dashboard');
          break;
        case 'RECEPTIONIST':
          navigate('/reception/dashboard');
          break;
        case 'CHEF':
        case 'KITCHEN_HELPER':
        case 'PANTRY_BOY':
        case 'KITCHEN':
          navigate('/kitchen/dashboard');
          break;
        case 'CLEANER':
          navigate('/housekeeping/dashboard');
          break;
        default:
          // Unknown staff role — send back to login, do NOT grant admin access
          navigate('/admin/login');
      }
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
      <RoleProtectedRoute allowedRoles={['ADMIN', 'admin']} navigate={navigate}>
        <div className="app-layout">
          <Sidebar
            activeTab={adminTab}
            activeModal={activeModal}
            onTabChange={(tab) => setAdminTab(tab)}
            onAction={(action) => setActiveModal(action)}
            onNavigate={navigate}
          />
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
                  USER: {(adminUser?.fullName || adminUser?.full_name)?.toUpperCase()}
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
            activeModal={activeModal}
          />

          {/* Main Workspace Scrollable Body */}
          {adminTab === 'housekeeping' && <AdminHousekeeping onBack={() => setAdminTab('frontdesk')} />}
          {adminTab === 'inventory' && (
            <div className="dashboard-body">
              <InventoryModule />
            </div>
          )}
          {/* ── Food / Restaurant POS — Phase 1 Menu Master ───────────────────── */}
          {adminTab === 'food' && (
            <div className="dashboard-body">
              <FoodPOS token={adminToken} user={adminUser} />
            </div>
          )}
          {adminTab === 'guests' && (

            <div className="dashboard-body">
              <AdminGuests token={adminToken} />
            </div>
          )}
          {adminTab === 'reservations' && (
            <div className="dashboard-body">
              <ReservationModule 
                token={adminToken}
                user={adminUser}
                onNavigate={navigate}
                showAlert={showAlert}
                showConfirm={showConfirm}
                fetchStatus={fetchStatus}
              />
            </div>
          )}
          {adminTab === 'frontdesk' && (
            <div className="dashboard-body">
              <div className="room-grid-wrapper">
                <RoomGrid 
                  rooms={rooms}
                  activeFilter={filter}
                  searchQuery={searchQuery}
                  onRoomClick={handleRoomClick}
                  showOperationalBadges={false}
                />
              </div>
            </div>
          )}

          {adminTab === 'rooms' && (
            <div className="dashboard-body">
              <div style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                padding: '12px 16px',
                marginBottom: '16px',
                display: 'flex',
                justify: 'space-between',
                alignItems: 'center'
              }}>
                <div>
                  <h2 style={{ fontSize: '1.1rem', fontWeight: '700', color: 'var(--text-main)', margin: 0 }}>
                    🛏️ Rooms Management & Operational Controls
                  </h2>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Manage room availability (Active/Inactive) and housekeeping (Clean/Dirty)
                  </span>
                </div>
              </div>
              <div className="room-grid-wrapper">
                <RoomGrid 
                  rooms={rooms}
                  activeFilter={filter}
                  searchQuery={searchQuery}
                  onRoomClick={handleRoomClick}
                  showOperationalBadges={true}
                />
              </div>
            </div>
          )}

          {/* Bottom Metrics Information Bar */}
          <MetricsBar 
            stats={globalStats}
            systemStatus={isBackendOnline}
            dataStatus={dataStatus}
            staleReason={staleReason}
          />

          {/* Modals & Dialog Portals */}
          <CheckInModal 
            isOpen={activeModal === 'checkin'}
            onClose={() => { setActiveModal(null); setSelectedRoom(null); }}
            room={liveSelectedRoom}
            onCheckIn={checkInGuest}
            showAlert={showAlert}
          />

          <CheckOutModal 
            isOpen={activeModal === 'checkout'}
            onClose={() => { setActiveModal(null); setSelectedRoom(null); }}
            room={liveSelectedRoom}
            token={adminToken}
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
            room={liveSelectedRoom}
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
            room={liveSelectedRoom}
            vacantRooms={vacantRoomsList}
            onShiftRoom={shiftGuest}
            showAlert={showAlert}
            showConfirm={showConfirm}
          />

          <CashStatusModal 
            isOpen={activeModal === 'cash'} 
            onClose={() => setActiveModal(null)} 
            cashLog={cashLog}
            token={adminToken}
            adminUser={adminUser}
          />

          <AnalyticsModal 
            isOpen={activeModal === 'analytics'} 
            onClose={() => setActiveModal(null)} 
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
            room={liveSelectedRoom}
            token={adminToken}
            onRefundComplete={processRefundCheckout}
            showAlert={showAlert}
            showConfirm={showConfirm}
          />

          <SettingsModal
            isOpen={activeModal === 'settings'}
            onClose={() => { setActiveModal(null); fetchStatus(); }}
          />
        </div>
        <RoomInspectorDrawer 
          selectedRoom={liveSelectedRoom} 
          onClose={() => setSelectedRoom(null)}
          onCheckInClick={(room) => { setSelectedRoom(room); setActiveModal('checkin'); }}
          onCheckOutClick={(room) => { setSelectedRoom(room); setActiveModal('checkout'); }}
          onRoomStatusChange={handleRoomStatusChange}
          token={adminToken}
        />
        </div>
      </RoleProtectedRoute>
    );
  } else if (currentPath === '/reception/dashboard') {
    pageContent = (
      <RoleProtectedRoute allowedRoles={['RECEPTIONIST']} navigate={navigate}>
        <ReceptionPortal />
      </RoleProtectedRoute>
    );
  } else if (currentPath === '/kitchen/dashboard') {
    pageContent = (
      <RoleProtectedRoute allowedRoles={['CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY', 'KITCHEN']} navigate={navigate}>
        <KitchenDashboard />
      </RoleProtectedRoute>
    );
  } else if (currentPath === '/pantry/dashboard') {
    pageContent = (
      <RoleProtectedRoute allowedRoles={['PANTRY_BOY']} navigate={navigate}>
        <PantryDashboard />
      </RoleProtectedRoute>
    );
  } else if (currentPath === '/housekeeping/dashboard') {
    pageContent = (
      <RoleProtectedRoute allowedRoles={['CLEANER']} navigate={navigate}>
        <HousekeepingDashboard />
      </RoleProtectedRoute>
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
