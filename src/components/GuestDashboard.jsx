import React, { useState, useEffect, useCallback } from 'react';
import { API_URL, getApiHeaders } from '../config/apiConfig';

import GuestBookingWizard from './GuestBookingWizard';
import GuestActiveStayOverview from './GuestActiveStayOverview';
import GuestBilling from './GuestBilling';
import GuestNotifications from './GuestNotifications';
import GuestRoomService from './GuestRoomService';
import GuestMaintenance from './GuestMaintenance';
import GuestFeedback from './GuestFeedback';
import GuestProfile from './GuestProfile';
import GuestLoyalty from './GuestLoyalty';
import GuestBookingHistory from './GuestBookingHistory';
import { 
  Star, ClipboardList, Send, CheckCircle, AlertTriangle, Calendar, Bell, 
  Utensils, Coffee, Paperclip, Upload, Plus, Minus, Info, Settings, Clock, Check,
  Hotel, Wallet, X, Wrench
} from 'lucide-react';

export default function GuestDashboard({ user, token, rooms, systemDate, onLogout, showAlert, fetchStatus, onUserUpdate }) {
  const [wizardStep, setWizardStep] = useState(1); // 1: Room Selection, 2: Guest Details, 3: ID Verification, 4: Extra Services, 5: Payment, 6: Confirmation
  
  // STEP 6: Confirmation State
  const [confirmedBooking, setConfirmedBooking] = useState(null);

  // ΓöÇΓöÇΓöÇ PHASE 2: Guest Stay Dashboard State ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  const [dashTab, setDashTab] = useState('overview'); // overview|service|maintenance|bill|notifications|extend|food
  const [isCheckingIn, setIsCheckingIn] = useState(false);

  // Payment status for the active booked reservation
  const [paymentStatusInfo, setPaymentStatusInfo] = useState(null);
  // { paymentStatus, paymentMethod, amount, paymentConfirmed, cashPendingConfirmation }

  // Live bill state
  const [liveBill, setLiveBill] = useState(null); // { booking, ledger }
  const [billLoading, setBillLoading] = useState(false);

  // Notifications state
  const [notifications, setNotifications] = useState([]);
  const [notifLoading, setNotifLoading] = useState(false);

  // Room service state
  const [serviceCategory, setServiceCategory] = useState('housekeeping');
  const [isSubmittingService, setIsSubmittingService] = useState(false);

  // Maintenance state
  const [maintenanceIssue, setMaintenanceIssue] = useState('');
  const [isSubmittingMaintenance, setIsSubmittingMaintenance] = useState(false);

  // Extend stay state
  const [extendDate, setExtendDate] = useState('');
  const [isExtending, setIsExtending] = useState(false);

  // Food order state
  const [foodCart, setFoodCart] = useState({});
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);

  // Checkout request state
  const [isRequestingCheckout, setIsRequestingCheckout] = useState(false);

  // ID Re-upload modal state (for occupied guests who get a rejection notification)
  const [showIdReupload, setShowIdReupload] = useState(false);
  const [reuploadFile, setReuploadFile] = useState(null);
  const [reuploadIdType, setReuploadIdType] = useState('Aadhaar Card');
  const [reuploadGovId, setReuploadGovId] = useState('');
  const [reuploadError, setReuploadError] = useState(null);
  const [isReuploading, setIsReuploading] = useState(false);
  const [reuploadSuccess, setReuploadSuccess] = useState(false);

  // ΓöÇΓöÇΓöÇ PHASE 3: Post-Checkout State ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  const [guestHistory, setGuestHistory] = useState(null); // { guest, bookings }
  const [historyLoading, setHistoryLoading] = useState(false);
  // Feedback form state
  const [feedbackBookingId, setFeedbackBookingId] = useState(null);
  const [feedbackOverall, setFeedbackOverall] = useState(0);
  const [feedbackCleanliness, setFeedbackCleanliness] = useState(0);
  const [feedbackService, setFeedbackService] = useState(0);
  const [feedbackValue, setFeedbackValue] = useState(0);
  const [feedbackComments, setFeedbackComments] = useState('');
  const [feedbackRecommend, setFeedbackRecommend] = useState(true);
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [postCheckoutTab, setPostCheckoutTab] = useState('feedback'); // 'feedback' | 'history'

  // Active stay for the current logged-in guest (excludes Checked Out / Cancelled)
  const activeReservation = guestHistory?.bookings?.find(b => b.booking_status === 'Reserved' || b.booking_status === 'Checked In');
  const activeBooking = activeReservation ? rooms.find(r => String(r.number) === String(activeReservation.room_number)) : null;
  const isOccupied = activeBooking?.status === 'occupied';

  // Recently checked-out bookings (no active stay, but has a checkedout booking)
  const hasCheckedOut = !activeBooking && guestHistory?.bookings?.some(b => b.booking_status === 'Checked Out');
  const latestCheckedOutBooking = guestHistory?.bookings?.find(b => b.booking_status === 'Checked Out');


  // ΓöÇΓöÇΓöÇ Phase 2 API Helpers ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  const apiFetch = useCallback(async (path, opts = {}) => {
    const res = await fetch(`${API_URL}${path}`, {
      ...opts,
      headers: getApiHeaders(token, { 'Content-Type': 'application/json', ...(opts.headers || {}) })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }, [token]);

  // Load bill when Bill tab is active
  const loadBill = useCallback(async () => {
    if (!isOccupied) return;
    setBillLoading(true);
    try {
      const data = await apiFetch('/guest/bill');
      setLiveBill(data);
    } catch (e) {
      console.error('Bill load error:', e);
    } finally {
      setBillLoading(false);
    }
  }, [isOccupied, apiFetch]);

  // Load notifications
  const loadNotifications = useCallback(async () => {
    setNotifLoading(true);
    try {
      const data = await apiFetch('/guest/notifications');
      setNotifications(data.notifications || []);
    } catch (e) {
      console.error('Notifications load error:', e);
    } finally {
      setNotifLoading(false);
    }
  }, [apiFetch]);

  // Auto-load on tab switch + always sync room status from server
  useEffect(() => {
    fetchStatus(); // Sync room status from server on every tab switch
    if (isOccupied) loadBill(); // ALWAYS load bill so Overview has latest balance
    if (dashTab === 'notifications') loadNotifications();
  }, [dashTab, isOccupied, fetchStatus, loadBill, loadNotifications]);

  // Auto-load notifications on mount if occupied (for badge count)
  // Also call fetchStatus on initial mount so stale room data is refreshed immediately
  useEffect(() => {
    fetchStatus(); // Ensure we have the latest room state on mount
    if (token) loadGuestHistory(); // Always load guest history to check for active bookings accurately
    if (isOccupied) loadNotifications();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Phase 3: Load guest history when no active booking (post-checkout state)
  const loadGuestHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await apiFetch('/guest/history');
      setGuestHistory(data);
      // Auto-set feedback booking to the latest checked-out booking if no feedback yet
      const latest = data.bookings?.find(b => b.booking_status === 'Checked Out' && !b.feedback_id);
      if (latest) setFeedbackBookingId(latest.id);
      // Sync user context: loyalty_tier and loyalty_points may have changed since login
      // This keeps the header badge in sync with the card without a separate API call.
      if (data.guest && onUserUpdate) {
        onUserUpdate({
          ...user,
          loyalty_tier:   data.guest.loyalty_tier,
          loyalty_points: data.guest.loyalty_points,
        });
      }
    } catch (e) {
      console.error('History load error:', e);
    } finally {
      setHistoryLoading(false);
    }
  }, [apiFetch, onUserUpdate, user]);

  // ΓöÇΓöÇΓöÇ Auto-refresh room status so admin checkout is immediately detected ΓöÇΓöÇΓöÇΓöÇ
  // Polls fetchStatus every 30s while the guest is on the portal
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      fetchStatus();
      if (isOccupied) loadBill(); // Also fetch latest bill automatically
    }, 30000);
    return () => clearInterval(interval);
  }, [token, fetchStatus]);

  // When the guest goes from occupied ΓåÆ not occupied (admin checked them out),
  // immediately load their history so the post-checkout screen appears.
  const prevIsOccupied = React.useRef(isOccupied);
  useEffect(() => {
    if (prevIsOccupied.current === true && !isOccupied) {
      // Just transitioned out of occupied — checkout happened on admin side
      loadGuestHistory();
      setPostCheckoutTab('feedback');
    }
    prevIsOccupied.current = isOccupied;
  }, [isOccupied, loadGuestHistory]);

  // We no longer need this separate useEffect because loadGuestHistory is called on mount with token.


  // Phase 3: Submit feedback
  const handleSubmitFeedback = async () => {
    if (!feedbackBookingId) { showAlert('No booking selected for feedback.', 'Error'); return; }
    if (feedbackOverall === 0) { showAlert('Please select an overall rating (1-5 stars).', 'Rating Required'); return; }
    setIsSubmittingFeedback(true);
    try {
      const data = await apiFetch('/guest/feedback', {
        method: 'POST',
        body: JSON.stringify({
          bookingId: feedbackBookingId,
          overallRating: feedbackOverall,
          roomCleanliness: feedbackCleanliness || null,
          serviceQuality: feedbackService || null,
          valueForMoney: feedbackValue || null,
          comments: feedbackComments.trim() || null,
          wouldRecommend: feedbackRecommend
        })
      });
      setFeedbackSubmitted(true);
      await loadGuestHistory(); // Refresh to reflect submitted status
      showAlert(`${data.message}`, 'Review Submitted!');
    } catch (e) {
      showAlert(e.message, 'Feedback Error');
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  // Fetch payment status whenever activeBooking appears with status === 'booked'
  useEffect(() => {
    if (activeBooking && activeBooking.status === 'booked') {
      fetchPaymentStatus();
      // Poll every 20 seconds so guest sees update without manual refresh
      const interval = setInterval(fetchPaymentStatus, 20000);
      return () => clearInterval(interval);
    } else {
      setPaymentStatusInfo(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBooking?.status]);

  const unreadCount = notifications.filter(n => !n.is_read).length;

  // Phase 2 action: self check-in
  const handleSelfCheckIn = async () => {
    setIsCheckingIn(true);
    try {
      const data = await apiFetch('/guest/checkin-request', { method: 'POST' });
      showAlert(`${data.message}`, 'Check-In Successful');
      await fetchStatus();
    } catch (e) {
      // If backend returns a cash-pending specific error, show a friendlier message
      if (e.message && e.message.includes('Cash payment not yet confirmed')) {
        showAlert(
          'Your cash payment has not been confirmed by the reception yet. Please visit the front desk and pay your advance, then the staff will unlock your check-in.',
          'Cash Payment Required'
        );
      } else {
        showAlert(e.message, 'Check-In Error');
      }
    } finally {
      setIsCheckingIn(false);
    }
  };

  // Fetch payment status for active booked reservation
  const fetchPaymentStatus = async () => {
    try {
      const data = await apiFetch('/payments/guest/payment-status');
      if (data.hasActivePayment) {
        setPaymentStatusInfo(data);
      } else {
        setPaymentStatusInfo(null);
      }
    } catch (e) {
      console.warn('fetchPaymentStatus error:', e.message);
    }
  };

  // Phase 2 action: submit service request
  const handleServiceRequest = async (serviceDesc, amount, qty = 1) => {
    setIsSubmittingService(true);
    try {
      await apiFetch('/guest/service', { method: 'POST', body: JSON.stringify({ serviceDesc, amount, qty }) });
      showAlert(`"${serviceDesc}" request submitted! It will be delivered shortly.`, 'Service Requested');
      if (dashTab === 'bill') await loadBill();
    } catch (e) {
      showAlert(e.message, 'Service Error');
    } finally {
      setIsSubmittingService(false);
    }
  };

  // Phase 2 action: submit maintenance report
  const handleMaintenanceSubmit = async (e) => {
    e.preventDefault();
    if (!maintenanceIssue.trim()) { showAlert('Please describe the issue.', 'Validation'); return; }
    setIsSubmittingMaintenance(true);
    try {
      await apiFetch('/guest/maintenance', { method: 'POST', body: JSON.stringify({ issue: maintenanceIssue }) });
      showAlert(`Maintenance report submitted. Our team will attend shortly.`, 'Report Received');
      setMaintenanceIssue('');
    } catch (e) {
      showAlert(e.message, 'Maintenance Error');
    } finally {
      setIsSubmittingMaintenance(false);
    }
  };

  // Phase 2 action: extend stay
  const handleExtendStay = async (e) => {
    e.preventDefault();
    if (!extendDate) { showAlert('Please select a new checkout date.', 'Validation'); return; }
    setIsExtending(true);
    try {
      const data = await apiFetch('/guest/extend-stay', { method: 'POST', body: JSON.stringify({ newCheckOutDate: extendDate }) });
      showAlert(`${data.message}`, 'Stay Extended!');
      setExtendDate('');
      await fetchStatus();
    } catch (e) {
      showAlert(e.message, 'Extend Stay Error');
    } finally {
      setIsExtending(false);
    }
  };

  // Phase 2 action: place food order
  const handlePlaceFoodOrder = async () => {
    const items = Object.entries(foodCart).filter(([, qty]) => qty > 0);
    if (items.length === 0) { showAlert('Please add at least one item to your order.', 'Empty Cart'); return; }
    setIsPlacingOrder(true);
    try {
      for (const [key, qty] of items) {
        const item = FOOD_MENU.flatMap(c => c.items).find(i => i.key === key);
        if (item) {
          await apiFetch('/guest/service', { method: 'POST', body: JSON.stringify({ serviceDesc: `Food Order: ${item.name}`, amount: item.price, qty }) });
        }
      }
      showAlert(`Your food order has been placed! Estimated delivery: 20-30 minutes.`, 'Order Placed');
      setFoodCart({});
      if (dashTab === 'bill') await loadBill();
    } catch (e) {
      showAlert(e.message, 'Order Error');
    } finally {
      setIsPlacingOrder(false);
    }
  };

  // Phase 2 action: request checkout
  const handleRequestCheckout = async () => {
    setIsRequestingCheckout(true);
    try {
      const data = await apiFetch('/guest/checkout-request', { method: 'POST' });
      showAlert(`${data.message}`, 'Checkout Requested');
    } catch (e) {
      showAlert(e.message, 'Checkout Error');
    } finally {
      setIsRequestingCheckout(false);
    }
  };

  // Mark notification as read
  const handleMarkRead = async (id) => {
    try {
      await apiFetch(`/guest/notifications/${id}/read`, { method: 'PUT' });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: 1 } : n));
    } catch (e) { /* silent */ }
  };

  // Food menu data
  const FOOD_MENU = [
    {
      category: '🥐 Breakfast Combos',
      note: 'Served with Chai / Black Tea / Coffee / Lemon Water',
      items: [
        { key: 'aloo_paratha', name: 'Aloo Paratha', price: 120, photo: '/food/aloo_paratha.png', desc: '1 piece stuffed whole wheat flatbread with fresh curd, pickle & drink of your choice' },
        { key: 'poha_combo', name: 'Poha Combo', price: 159, photo: '/food/poha_combo.png', desc: 'Light & healthy flattened rice savory (with/without onion) with drink of your choice' },
        { key: 'paneer_paratha_combo', name: 'Paneer Paratha Combo', price: 209, photo: '/food/paneer_paratha_combo.png', desc: '1 piece spiced paneer-stuffed flatbread with curd, pickle & drink of your choice' },
      ]
    },
    {
      category: '🍳 Eggs',
      note: 'Served with golden toast & drink of your choice',
      items: [
        { key: 'scrambled_eggs', name: 'Scrambled Eggs', price: 120, photo: '/food/scrambled_eggs.png', desc: 'Classic fried & scrambled eggs, seasoned for a quick and tasty breakfast with toast & drink' },
        { key: 'egg_bhurji', name: 'Egg Bhurji', price: 120, photo: '/food/egg_bhurji.png', desc: '2 eggs in Spiced Indian Style (Bhurji) with one drink of your choice' },
        { key: 'omelette_combo', name: 'Omelette Combo', price: 159, photo: '/food/omelette_combo.png', desc: 'Fluffy 2-egg omelette with golden bread toasted & drink of your choice' },
        { key: 'veg_sandwich_combo', name: 'Veg Sandwich Combo', price: 159, photo: '/food/veg_sandwich_combo.png', desc: '4 pieces double-decker cold sandwich with golden fresh veggies & drink' },
      ]
    },
    {
      category: '🥗 All-Day Snacks',
      items: [
        { key: 'mix_pakora', name: 'Mix Pakora (10 pcs)', price: 199, photo: '/food/mix_pakora.png', desc: 'Assortment of crispy vegetable fritters, lightly seasoned & served with dipping chutney' },
        { key: 'chicken_pakora', name: 'Chicken Pakora (7 pcs)', price: 249, photo: '/food/chicken_pakora.png', desc: 'Tender chicken pieces coated in flavored batter, fried until golden & crispy with mint chutney' },
        { key: 'french_fries', name: 'French Fries', price: 179, photo: '/food/french_fries.png', desc: 'Golden, crispy potato fries seasoned with salt & served with tomato ketchup' },
        { key: 'masala_papad', name: 'Masala Papad', price: 100, photo: '/food/masala_papad.png', desc: 'Crispy papad topped with fresh onions, tomatoes, herbs & aromatic Indian spices' },
        { key: 'masala_peanuts', name: 'Masala Peanuts', price: 149, photo: '/food/masala_peanuts.png', desc: 'Roasted peanuts tossed with onions, tomatoes, fresh herbs & a blend of aromatic spices' },
        { key: 'plain_papad', name: 'Plain Papad', price: 80, photo: '/food/plain_papad.png', desc: '1 piece of crisp roasted or fried papad, lightly seasoned' },
      ]
    },
    {
      category: '🍜 Indo-Chinese',
      items: [
        { key: 'chilli_potato', name: 'Chilli Potato', price: 199, photo: '/food/chilli_potato.png', desc: 'Crispy potato strips tossed in a tangy Indo-Chinese sauce with onions, capsicum & aromatic seasonings' },
        { key: 'honey_chilli_potato', name: 'Honey Chilli Potato', price: 229, photo: '/food/honey_chilli_potato.png', desc: 'Crispy potato strips glazed with sweet & spicy honey chilli sauce, finished with sesame seeds' },
        { key: 'veg_manchurian', name: 'Veg Manchurian', price: 249, photo: '/food/veg_manchurian.png', desc: 'Soft vegetable dumplings simmered in flavourful Indo-Chinese gravy with fresh vegetables & aromatic spices' },
      ]
    },
    {
      category: '🍚 Rice Delights',
      items: [
        { key: 'plain_rice', name: 'Plain Rice', price: 119, photo: '/food/plain_rice.png', desc: 'Steamed premium basmati rice, light, fluffy — the perfect accompaniment to any curry' },
        { key: 'jeera_rice', name: 'Jeera Rice', price: 179, photo: '/food/jeera_rice.png', desc: 'Fragrant basmati rice delicately tempered with cumin seeds & aromatic spices' },
        { key: 'veg_fried_rice', name: 'Veg Fried Rice', price: 219, photo: '/food/veg_fried_rice.png', desc: 'Stir-fried basmati rice with fresh vegetables & aromatic seasonings, cooked to perfection' },
      ]
    },
    {
      category: '🥦 Vegetarian Mains',
      note: '12 PM – 10:30 PM',
      items: [
        { key: 'dal_tadka', name: 'Dal Tadka', price: 199, photo: '/food/dal_tadka.png', desc: 'Yellow lentils cooked to perfection with fragrant tempering of cumin, garlic & traditional Indian spices' },
        { key: 'dal_makhani', name: 'Dal Makhani', price: 229, photo: '/food/dal_makhani.png', desc: 'Slow-cooked black lentils & kidney beans simmered in rich, creamy tomato gravy with butter & Indian spices' },
        { key: 'chana_masala', name: 'Chana Masala', price: 229, photo: '/food/chana_masala.png', desc: 'Tender chickpeas cooked in flavorful onion & tomato gravy, infused with aromatic Indian spices' },
        { key: 'paneer_butter_masala', name: 'Paneer Butter Masala', price: 289, photo: '/food/paneer_butter_masala.png', desc: 'Soft paneer cubes simmered in rich, creamy tomato & butter gravy with aromatic Indian spices' },
      ]
    },
    {
      category: '🍗 Non-Veg Mains',
      note: '12 PM – 10:30 PM',
      items: [
        { key: 'egg_curry', name: 'Egg Curry', price: 179, photo: '/food/egg_curry.png', desc: 'Two hard-boiled eggs simmered in rich onion & tomato gravy, delicately spiced with aromatic Indian spices' },
        { key: 'chicken_curry', name: 'Chicken Curry', price: 399, photo: '/food/chicken_curry.png', desc: 'Tender chicken pieces in rich onion & tomato gravy, delicately seasoned with aromatic Indian spices' },
        { key: 'butter_chicken', name: 'Butter Chicken', price: 599, photo: '/food/butter_chicken.png', desc: 'Tender chicken pieces in rich, creamy tomato & butter gravy — a classic North Indian favourite' },
        { key: 'chili_chicken', name: 'Chili Chicken', price: 289, photo: '/food/chili_chicken.png', desc: 'Tender chicken pieces saut├⌐ed with onions, capsicum & a blend of savory spices' },
      ]
    },
    {
      category: '≡ƒæ¿ΓÇì🍳 Chef\'s Combos',
      items: [
        { key: 'veg_combo', name: 'Veg Combo', price: 299, photo: '/food/veg_combo.png', desc: 'Paneer Butter Masala + Jeera Rice + 2 Butter Rotis + Pickle — a wholesome complete meal' },
        { key: 'non_veg_combo', name: 'Non-Veg Combo', price: 449, photo: '/food/non_veg_combo.png', desc: 'Butter Chicken + Jeera Rice + 2 Tawa Rotis + Pickle — tender chicken in creamy gravy' },
      ]
    },
    {
      category: '🥖 Breads',
      items: [
        { key: 'tawa_roti', name: 'Tawa Roti', price: 25, photo: '/food/tawa_roti.png', desc: 'Freshly prepared whole wheat flatbread, cooked on a traditional tawa until soft & lightly golden' },
        { key: 'tawa_butter_roti', name: 'Tawa Butter Roti', price: 30, photo: '/food/tawa_roti.png', desc: 'Whole wheat flatbread cooked on traditional tawa, finished with a touch of butter' },
        { key: 'missi_roti', name: 'Missi Roti', price: 40, photo: '/food/missi_roti.png', desc: 'Traditional flatbread made with gram flour & whole wheat flour, seasoned with aromatic spices' },
        { key: 'malabar_paratha', name: 'Malabar Paratha', price: 60, photo: '/food/malabar_paratha.png', desc: 'Flaky, layered flatbread with a soft buttery texture, cooked to golden perfection — ideal with curries' },
      ]
    },
    {
      category: '🥗 Salads',
      items: [
        { key: 'fresh_salad', name: 'Fresh Salad', price: 119, photo: '/food/fresh_salad.png', desc: 'Refreshing selection of crisp cucumber, tomatoes, onions & herbs — a light & healthy accompaniment' },
        { key: 'chickpea_salad', name: 'Chickpea Salad', price: 169, photo: '/food/chickpea_salad.png', desc: 'Protein-rich boiled chickpeas seasoned with onions, tomatoes, herbs & tangy Indian spices' },
      ]
    },
    {
      category: '☕ Beverages',
      items: [
        { key: 'chai', name: 'Chai', price: 70, photo: '/food/chai.png', desc: 'Freshly brewed cup of traditional Indian tea, served hot & full of flavour' },
        { key: 'coffee', name: 'Coffee', price: 70, photo: '/food/coffee_cup.png', desc: 'Rich and refreshing cup of freshly brewed coffee, perfect any time of day' },
        { key: 'black_tea', name: 'Black Tea', price: 50, photo: '/food/black_tea.png', desc: 'Bold, aromatic and invigorating cup of carefully selected black tea leaves' },
        { key: 'green_tea', name: 'Green Tea', price: 50, photo: '/food/green_tea.png', desc: 'Soothing cup of premium green tea, brewed to preserve its delicate flavour & natural goodness' },
        { key: 'sweet_lassi', name: 'Sweet Lassi', price: 109, photo: '/food/lassi.png', desc: 'Refreshing blend of smooth and creamy yogurt, blended until frothy for a satisfying treat' },
        { key: 'salted_lassi', name: 'Salted Lassi', price: 109, photo: '/food/salted_lassi.png', desc: 'Refreshing blend of fresh yogurt, lightly seasoned with salt & churned to a smooth, frothy texture' },
        { key: 'milk', name: 'Glass of Milk', price: 70, photo: '/food/glass_of_milk.png', desc: 'Pure, fresh milk served hot or chilled — a wholesome and nourishing beverage' },
        { key: 'mineral_water', name: 'Mineral Water (1 L)', price: 50, photo: '/food/mineral_water.png', desc: '1 litre of pure, refreshing mineral water served chilled or at room temperature' },
        { key: 'soft_drinks', name: 'Soft Drinks', price: 70, photo: '/food/soft_drinks.png', desc: 'A selection of refreshing carbonated beverages — Coca-Cola / Limca / Seven Up' },
        { key: 'refreshers', name: 'Refreshers', price: 70, photo: '/food/lemon_refresher.png', desc: 'Fresh lemon beverages — traditional Indian lemonade or international-style lemon refresher' },
      ]
    },
    {
      category: '🍨 Desserts',
      items: [
        { key: 'gulab_jamun', name: 'Gulab Jamun (2 pcs)', price: 109, photo: '/food/gulab_jamun.png', desc: 'Soft, golden-fried milk dumplings soaked in fragrant cardamom & rose-infused sugar syrup, served warm' },
        { key: 'kulfi_stick', name: 'Kulfi (Stick)', price: 99, photo: '/food/kulfi_icecream.png', desc: 'Traditional Indian frozen dessert infused with saffron & cardamom — rich, creamy & refreshing' },
        { key: 'ice_cream_1scoop', name: 'Vanilla Ice Cream (1 Scoop)', price: 99, photo: '/food/kulfi_icecream.png', desc: 'One generous scoop of creamy vanilla ice cream, served chilled' },
        { key: 'ice_cream_2scoop', name: 'Vanilla Ice Cream (2 Scoops)', price: 169, photo: '/food/kulfi_icecream.png', desc: 'Two generous scoops of creamy ice cream, served chilled for a rich and indulgent dessert' },
      ]
    },
  ];



  const foodCartTotal = Object.entries(foodCart).reduce((sum, [key, qty]) => {
    const item = FOOD_MENU.flatMap(c => c.items).find(i => i.key === key);
    return sum + (item ? item.price * qty : 0);
  }, 0);


  // Get rooms available for this guest's date window
  const activeSubtotal = activeBooking ? (liveBill?.ledger || []).reduce((sum, item) => sum + item.amount, 0) : 0;
  const activeBookingDeposit = activeBooking ? activeReservation?.advance_amount || 0 : 0;
  const activeBalance = activeSubtotal - activeBookingDeposit;

  return (
    <div style={{ minHeight: '100vh', background: '#080b10', color: '#f0f6fc', display: 'flex', flexDirection: 'column' }}>
      
      {/* Header Panel */}
      <header className="header glass" style={{ borderBottom: '1px solid var(--border-color)', height: '70px', padding: '0 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="brand-section" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="logo-icon"><Hotel size={24} /></span>
          <h1 className="brand-name" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: '1.3rem' }}>
            HOTEL SKY-5 <span style={{ color: 'var(--color-vacant)' }}>GUEST PORTAL</span>
          </h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <div>Welcome, <strong style={{ color: '#fff' }}>{user.fullName}</strong></div>
            <div style={{ fontSize: '0.75rem', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span><Star size={18} /></span>
              <span style={{ 
                color: user.loyalty_tier === 'Platinum' ? '#e5e4e2' : 
                       user.loyalty_tier === 'Gold' ? '#ffd700' : 
                       user.loyalty_tier === 'Silver' ? '#c0c0c0' : '#cd7f32',
                fontWeight: '800'
              }}>{(user.loyalty_tier || 'Bronze').toUpperCase()} MEMBER</span>
              <span style={{ color: 'var(--text-muted)' }}>({user.loyalty_points || 0} pts)</span>
            </div>
          </div>
          {isOccupied && (
            <button
              onClick={() => { setDashTab('notifications'); }}
              style={{ position: 'relative', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', cursor: 'pointer', color: '#fff', fontSize: '1.1rem' }}
              title="Notifications"
            >
              <Bell size={18} />
              {unreadCount > 0 && (
                <span style={{ position: 'absolute', top: '-4px', right: '-4px', background: '#ef4444', color: '#fff', borderRadius: '50%', width: '16px', height: '16px', fontSize: '0.65rem', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '800' }}>{unreadCount}</span>
              )}
            </button>
          )}
          <button onClick={onLogout} className="btn-secondary" style={{ padding: '6px 14px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
            Logout
          </button>
        </div>
      </header>

      {/* ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
          INITIALIZATION LOADING STATE
      ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ */}
      {(historyLoading || (activeReservation && !activeBooking)) && (
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '16px' }}>
          <div style={{ fontSize: '3rem', animation: 'pulse 1.5s infinite' }}><Clock size={18} /></div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', fontWeight: '600', letterSpacing: '0.5px' }}>
            Loading your dashboard...
          </p>
        </main>
      )}

      {/* ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
          PHASE 2: GUEST CHECK-IN LANDING (status === 'booked') 
      ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ */}
      {activeBooking && activeBooking.status === 'booked' && wizardStep !== 6 && (
        <main style={{ flex: 1, padding: '2rem', maxWidth: '900px', width: '100%', margin: '0 auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Status Banner */}
            <div style={{ background: 'linear-gradient(135deg, rgba(251,191,36,0.1) 0%, rgba(245,158,11,0.05) 100%)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '12px', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '1.5rem' }}><Clock size={18} /></span>
              <div>
                <p style={{ fontWeight: '700', color: '#fbbf24', margin: 0, fontSize: '0.95rem' }}>Reservation Confirmed — Awaiting Check-In</p>
                <p style={{ color: 'var(--text-muted)', margin: '2px 0 0', fontSize: '0.82rem' }}>You have an upcoming reservation. When you arrive at the hotel, click "Check In Now" below.</p>
              </div>
            </div>

            {/* Booking Details Card */}
            <div className="glass" style={{ borderRadius: '16px', padding: '28px', border: '1px solid rgba(255,255,255,0.07)' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.3rem', fontWeight: '800', color: '#fff', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Info size={18} /> Your Reservation Details
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '28px' }}>
                {[
                  { label: 'BOOKING NO', value: activeReservation?.booking_number || '—' },
                  { label: 'ROOM', value: `Room ${activeBooking.number} (${activeBooking.type})` },
                  { label: 'GUEST NAME', value: guestHistory?.guest?.full_name || user.fullName },
                  { label: 'CHECK-IN DATE', value: activeReservation?.check_in_date?.split('T')[0] || '—' },
                  { label: 'CHECK-OUT DATE', value: activeReservation?.expected_check_out_date?.split('T')[0] || '—' },
                  { label: 'PAX', value: `${activeReservation?.adults || 1} Guest(s)` },
                  { label: 'DEPOSIT PAID', value: `₹ ${(activeReservation?.advance_amount || 0).toLocaleString('en-IN')}` },
                  { label: 'BASE RATE', value: `₹ ${(liveBill?.booking?.base_rate || 0).toLocaleString('en-IN')} / Night` },
                ].map(({ label, value }) => (
                  <div key={label} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '14px', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', letterSpacing: '0.8px', marginBottom: '4px', textTransform: 'uppercase' }}>{label}</p>
                    <p style={{ fontWeight: '700', color: '#fff', fontSize: '0.92rem' }}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Check In Button / Payment Pending Lock */}
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap', flexDirection: 'column', alignItems: 'center' }}>

                {/* Case A: Cash payment still pending admin confirmation */}
                {paymentStatusInfo?.cashPendingConfirmation && (
                  <div style={{ width: '100%', maxWidth: '520px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '12px', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '1.8rem' }}><Wallet size={18} /></span>
                      <div>
                        <p style={{ fontWeight: '800', color: '#ef4444', margin: 0, fontSize: '0.95rem' }}>Cash Payment Pending Confirmation</p>
                        <p style={{ color: 'var(--text-muted)', margin: '4px 0 0', fontSize: '0.8rem', lineHeight: '1.5' }}>
                          Please visit the hotel reception desk and pay your advance deposit of
                          <strong style={{ color: '#fff' }}> ₹{(paymentStatusInfo.amount || 0).toLocaleString('en-IN')}</strong>.
                          Once the staff confirms receipt, your <strong style={{ color: '#fbbf24' }}>Check In Now</strong> button will activate automatically.
                        </p>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '8px', padding: '10px 14px' }}>
                      <span style={{ fontSize: '0.9rem' }}><Info size={18} /></span>
                      <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: 0, lineHeight: '1.4' }}>
                        This page refreshes every 20 seconds. You’ll also receive a notification once the staff confirms your payment.
                      </p>
                    </div>
                    {/* Disabled Check In button to show it exists but is locked */}
                    <button
                      disabled
                      style={{
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px dashed rgba(255,255,255,0.15)',
                        borderRadius: '10px',
                        padding: '14px 36px',
                        color: 'rgba(255,255,255,0.25)',
                        fontSize: '1rem',
                        fontWeight: '700',
                        cursor: 'not-allowed',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        alignSelf: 'center'
                      }}
                    >
                      ≡ƒöÆ Check In Locked — Awaiting Payment
                    </button>
                  </div>
                )}

                {/* Case B: Payment confirmed OR no payment pending ΓåÆ normal Check In Now */}
                {!paymentStatusInfo?.cashPendingConfirmation && (
                  <button
                    onClick={handleSelfCheckIn}
                    disabled={isCheckingIn}
                    style={{
                      background: isCheckingIn ? 'rgba(255,255,255,0.1)' : 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                      border: 'none',
                      borderRadius: '10px',
                      padding: '14px 36px',
                      color: '#fff',
                      fontSize: '1rem',
                      fontWeight: '800',
                      cursor: isCheckingIn ? 'not-allowed' : 'pointer',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      boxShadow: '0 4px 20px rgba(34,197,94,0.3)'
                    }}
                  >
                    {isCheckingIn ? <><Clock size={18} /> Checking In...</> : <><CheckCircle size={18} /> Check In Now</>}
                  </button>
                )}
              </div>
              <p style={{ textAlign: 'center', fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '14px' }}>
                {paymentStatusInfo?.cashPendingConfirmation
                  ? <><Wallet size={18} /> Pay your advance deposit at the reception desk. Check-in will unlock once confirmed.</>
                  : <><Info size={18} /> Clicking "Check In Now" will confirm your arrival and activate your room. Make sure you are physically at the hotel reception.</>}
              </p>
            </div>
          </div>
        </main>
      )}

      {/* ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
          PHASE 2: GUEST STAY DASHBOARD (status === 'occupied') 
      ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ */}
      {isOccupied && (
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Tab Navigation */}
          <div style={{ borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.3)', padding: '0 2rem', display: 'flex', gap: '4px', overflowX: 'auto' }}>
            {[
              { id: 'overview', icon: <Hotel size={18} />, label: 'Overview' },
              { id: 'service', icon: <Bell size={18} />, label: 'Room Service' },
              { id: 'food', icon: <Utensils size={18} />, label: 'Food Order' },
              { id: 'maintenance', icon: <Wrench size={18} />, label: 'Maintenance' },
              { id: 'bill', icon: <ClipboardList size={18} />, label: 'My Bill' },
              { id: 'notifications', icon: <Bell size={18} />, label: `Notifications${unreadCount > 0 ? ` (${unreadCount})` : ''}` },
              { id: 'extend', icon: <Calendar size={18} />, label: 'Extend Stay' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setDashTab(tab.id)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: dashTab === tab.id ? '2px solid #38bdf8' : '2px solid transparent',
                  color: dashTab === tab.id ? '#38bdf8' : 'var(--text-secondary)',
                  padding: '14px 16px',
                  cursor: 'pointer',
                  fontSize: '0.84rem',
                  fontWeight: dashTab === tab.id ? '700' : '500',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.2s',
                  borderRadius: '0',
                }}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div style={{ flex: 1, overflow: 'auto', padding: '2rem', maxWidth: '1200px', width: '100%', margin: '0 auto' }}>

            {/* ΓöÇΓöÇ OVERVIEW TAB ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */}
            {dashTab === 'overview' && (
              <GuestActiveStayOverview
                user={user}
                activeBooking={activeBooking}
                activeReservation={activeReservation}
                setDashTab={setDashTab}
                handleRequestCheckout={handleRequestCheckout}
                isRequestingCheckout={isRequestingCheckout}
                fetchStatus={fetchStatus}
                liveBill={liveBill}
                guestHistory={guestHistory}
                notifications={notifications}
              />
            )}
            {/* ΓöÇΓöÇ ROOM SERVICE TAB ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */}
            {dashTab === 'service' && (
              <GuestRoomService
                serviceCategory={serviceCategory}
                setServiceCategory={setServiceCategory}
                handleServiceRequest={handleServiceRequest}
                isSubmittingService={isSubmittingService}
              />
            )}
            {/* ΓöÇΓöÇ FOOD ORDER TAB ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */}
            {dashTab === 'food' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div>
                  <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}><Utensils size={18} /> In-Room Dining</h2>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Order from our kitchen menu. Delivery in 20–30 minutes to your room. <span style={{ color: '#fbbf24' }}>Dial 9</span> to order by phone.</p>
                </div>

                {FOOD_MENU.map(cat => (
                  <div key={cat.category} className="glass" style={{ borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ marginBottom: '14px' }}>
                      <h3 style={{ color: '#fff', fontWeight: '700', fontSize: '1rem', margin: 0 }}>{cat.category}</h3>
                      {cat.note && (
                        <p style={{ color: '#38bdf8', fontSize: '0.74rem', fontWeight: '600', margin: '3px 0 0', letterSpacing: '0.3px' }}>
                          ΓÅ░ {cat.note}
                        </p>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px' }}>
                      {cat.items.map(item => {
                        const qty = foodCart[item.key] || 0;
                        return (
                          <div key={item.key} style={{
                            background: qty > 0 ? 'rgba(251,146,60,0.06)' : 'rgba(255,255,255,0.03)',
                            borderRadius: '10px', padding: '12px 14px',
                            border: qty > 0 ? '1px solid rgba(251,146,60,0.3)' : '1px solid rgba(255,255,255,0.05)',
                            display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                            gap: '10px', transition: 'all 0.2s', position: 'relative', overflow: 'hidden',
                            minHeight: '110px'
                          }}>
                            {/* Food photo — absolutely positioned in top-right corner */}
                            {item.photo && (
                              <img
                                src={item.photo}
                                alt={item.name}
                                onError={e => { e.target.style.display = 'none'; }}
                                style={{
                                  position: 'absolute', top: '8px', right: '8px',
                                  width: '62px', height: '62px',
                                  borderRadius: '50%',
                                  objectFit: 'cover',
                                  border: qty > 0 ? '2px solid rgba(251,146,60,0.5)' : '2px solid rgba(255,255,255,0.12)',
                                  boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
                                  transition: 'border-color 0.2s',
                                  zIndex: 1
                                }}
                              />
                            )}

                            {/* Text content — padded right to avoid overlap with image */}
                            <div style={{ paddingRight: item.photo ? '74px' : '0' }}>
                              <p style={{ fontWeight: '700', color: '#fff', fontSize: '0.88rem', margin: 0, lineHeight: '1.3' }}>{item.name}</p>
                              {item.desc && (
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.72rem', margin: '3px 0 6px', lineHeight: '1.35', opacity: 0.85 }}>{item.desc}</p>
                              )}
                              <p style={{ color: '#fbbf24', fontWeight: '800', fontSize: '0.85rem', margin: 0 }}>₹ {item.price}</p>
                            </div>

                            {/* +/- buttons pinned to bottom-right */}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', zIndex: 2 }}>
                              <button
                                onClick={() => setFoodCart(prev => ({ ...prev, [item.key]: Math.max(0, (prev[item.key] || 0) - 1) }))}
                                style={{ width: '30px', height: '30px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', cursor: 'pointer', fontWeight: '700', fontSize: '1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' }}
                                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                              >−</button>
                              <span style={{ minWidth: '24px', textAlign: 'center', fontWeight: '800', color: qty > 0 ? '#fb923c' : 'var(--text-muted)', fontSize: '1rem' }}>{qty}</span>
                              <button
                                onClick={() => setFoodCart(prev => ({ ...prev, [item.key]: (prev[item.key] || 0) + 1 }))}
                                style={{ width: '30px', height: '30px', borderRadius: '50%', background: qty > 0 ? 'rgba(251,146,60,0.3)' : 'rgba(251,146,60,0.15)', border: '1px solid rgba(251,146,60,0.5)', color: '#fb923c', cursor: 'pointer', fontWeight: '700', fontSize: '1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' }}
                                onMouseEnter={e => e.currentTarget.style.background = 'rgba(251,146,60,0.4)'}
                                onMouseLeave={e => e.currentTarget.style.background = qty > 0 ? 'rgba(251,146,60,0.3)' : 'rgba(251,146,60,0.15)'}
                              >+</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {/* Order Summary sticky bar */}
                <div style={{ position: 'sticky', bottom: 0, background: 'rgba(8,11,16,0.95)', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                  <div>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>Order Total</p>
                    <p style={{ fontWeight: '800', color: '#fff', fontSize: '1.2rem', margin: 0 }}>₹ {foodCartTotal.toLocaleString('en-IN')}</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', margin: '2px 0 0' }}>{Object.values(foodCart).reduce((a, b) => a + b, 0)} items · Added to room folio</p>
                  </div>
                  <button
                    onClick={handlePlaceFoodOrder}
                    disabled={isPlacingOrder || foodCartTotal === 0}
                    style={{ background: foodCartTotal === 0 ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg, #fb923c 0%, #f97316 100%)', border: 'none', borderRadius: '10px', padding: '12px 28px', color: '#fff', fontWeight: '800', fontSize: '0.95rem', cursor: foodCartTotal === 0 ? 'not-allowed' : 'pointer', transition: 'all 0.2s', boxShadow: foodCartTotal > 0 ? '0 4px 16px rgba(251,146,60,0.3)' : 'none' }}
                  >
                    {isPlacingOrder ? <><Clock size={18} /> Placing Order...</> : <><Utensils size={18} /> Place Order</>}
                  </button>
                </div>
              </div>
            )}


            {/* ΓöÇΓöÇ MAINTENANCE TAB ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */}
            {dashTab === 'maintenance' && (
              <GuestMaintenance
                maintenanceIssue={maintenanceIssue}
                setMaintenanceIssue={setMaintenanceIssue}
                handleMaintenanceSubmit={handleMaintenanceSubmit}
                isSubmittingMaintenance={isSubmittingMaintenance}
              />
            )}
            {/* ΓöÇΓöÇ MY BILL TAB ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */}
            {dashTab === 'bill' && (
              <GuestBilling 
                liveBill={liveBill}
                billLoading={billLoading}
                loadBill={loadBill}
              />
            )}
            {/* ΓöÇΓöÇ NOTIFICATIONS TAB ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */}
            {dashTab === 'notifications' && (
              <GuestNotifications 
                notifications={notifications}
                notifLoading={notifLoading}
                loadNotifications={loadNotifications}
                handleMarkRead={handleMarkRead}
                activeBooking={activeBooking}
                setWizardStep={setWizardStep}
                setDashTab={setDashTab}
                setReuploadFile={setReuploadFile}
                setReuploadError={setReuploadError}
                setReuploadSuccess={setReuploadSuccess}
                setShowIdReupload={setShowIdReupload}
              />
            )}
            {/* ΓöÇΓöÇ EXTEND STAY TAB ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */}
            {dashTab === 'extend' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div>
                  <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}><Calendar size={18} /> Extend Your Stay</h2>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Wish to stay longer? Select a new checkout date and we'll update your reservation.</p>
                </div>
                <div className="glass" style={{ borderRadius: '12px', padding: '28px', border: '1px solid rgba(255,255,255,0.07)', maxWidth: '500px' }}>
                  <div style={{ marginBottom: '20px', padding: '16px', background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: '8px' }}>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>CURRENT CHECKOUT DATE</p>
                    <p style={{ fontWeight: '800', color: '#38bdf8', fontSize: '1.1rem' }}>{activeReservation?.expected_check_out_date?.split('T')[0] || '—'}</p>
                  </div>

                  <form onSubmit={handleExtendStay} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div>
                      <label style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.82rem', marginBottom: '8px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px' }}>New Checkout Date</label>
                      <input
                        type="date"
                        value={extendDate}
                        onChange={e => setExtendDate(e.target.value)}
                        min={activeReservation?.expected_check_out_date?.split('T')[0] || new Date().toISOString().split('T')[0]}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '8px', padding: '12px 14px', color: '#fff', fontSize: '0.95rem', fontFamily: 'inherit', boxSizing: 'border-box' }}
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isExtending || !extendDate}
                      style={{ background: isExtending || !extendDate ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)', border: 'none', borderRadius: '8px', padding: '12px 24px', color: '#fff', fontWeight: '800', fontSize: '0.95rem', cursor: 'pointer', boxShadow: extendDate ? '0 4px 16px rgba(56,189,248,0.25)' : 'none' }}
                    >
                      {isExtending ? <><Clock size={18} /> Extending...</> : <><Calendar size={18} /> Confirm Extension</>}
                    </button>
                  </form>

                  <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '14px', lineHeight: '1.4' }}>
                    <Info size={18} /> Extending your stay is subject to room availability. Additional charges will be applied as per your room tariff.
                  </p>
                </div>
              </div>
            )}

          </div>
        </main>
      )}

      {/* ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
          PHASE 3: POST-CHECKOUT SCREEN (no active stay + has booking history)
      ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ */}
      {!historyLoading && !activeReservation && hasCheckedOut && (
        <main style={{ flex: 1, overflow: 'auto', padding: '0' }}>
          {/* Top Tab Nav */}
          <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.4)', padding: '0 2rem', display: 'flex', gap: '4px' }}>
            {[
              { id: 'feedback', icon: <Star size={16} />, label: 'Leave a Review' },
              { id: 'history', icon: <ClipboardList size={18} />, label: 'My Stays' },
            ].map(tab => (
              <button key={tab.id} onClick={() => setPostCheckoutTab(tab.id)} style={{
                background: 'transparent', border: 'none',
                borderBottom: postCheckoutTab === tab.id ? '2px solid #38bdf8' : '2px solid transparent',
                color: postCheckoutTab === tab.id ? '#38bdf8' : 'var(--text-secondary)',
                padding: '14px 18px', cursor: 'pointer', fontSize: '0.9rem',
                fontWeight: postCheckoutTab === tab.id ? '700' : '500',
                display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap', transition: 'all 0.2s'
              }}>{tab.icon} {tab.label}</button>
            ))}
          </div>

          <div style={{ padding: '2rem', maxWidth: '860px', margin: '0 auto' }}>

            {/* ΓöÇΓöÇ FEEDBACK TAB ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */}
            {postCheckoutTab === 'feedback' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                <div style={{ background: 'rgba(15, 23, 42, 0.6)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderRadius: '16px', border: '1px solid rgba(255, 255, 255, 0.08)', padding: '40px', boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)', textAlign: 'center', animation: 'fadeIn 0.5s ease-out' }}>
                  <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                    <span style={{ fontSize: '32px', color: '#10b981' }}>✓</span>
                  </div>
                  <h2 style={{ fontSize: '1.8rem', fontWeight: '800', color: '#fff', marginBottom: '12px', fontFamily: 'var(--font-heading)' }}>Thank You For Staying With Us</h2>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem', marginBottom: '32px' }}>Your stay has been successfully completed.</p>
                  <div style={{ background: 'rgba(0, 0, 0, 0.3)', borderRadius: '12px', padding: '24px', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '32px', maxWidth: '400px', margin: '0 auto' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: '#fff' }}><span style={{ color: '#10b981', fontSize: '1.2rem' }}>✓</span> Checkout completed</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: '#fff' }}><span style={{ color: '#10b981', fontSize: '1.2rem' }}>✓</span> Final invoice available</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: '#fff' }}><span style={{ color: '#10b981', fontSize: '1.2rem' }}>✓</span> Thank you for choosing Hotel Sky-5</div>
                  </div>
                  <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap', marginTop: '32px' }}>
                    <button onClick={() => setPostCheckoutTab('history')} className="btn-ripple" style={{ padding: '12px 24px', borderRadius: '8px', background: 'var(--primary)', color: '#fff', border: 'none', fontWeight: '600', cursor: 'pointer', transition: 'all 0.2s' }}>Download Invoice</button>
                    <button className="btn-ripple" style={{ padding: '12px 24px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)', fontWeight: '600', cursor: 'pointer', transition: 'all 0.2s' }}>Contact Reception</button>
                    <button onClick={onLogout} className="btn-ripple" style={{ padding: '12px 24px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.2)', fontWeight: '600', cursor: 'pointer', transition: 'all 0.2s' }}>Logout</button>
                  </div>
                </div>
              <GuestFeedback
                latestCheckedOutBooking={latestCheckedOutBooking}
                feedbackSubmitted={feedbackSubmitted}
                feedbackOverall={feedbackOverall} setFeedbackOverall={setFeedbackOverall}
                feedbackCleanliness={feedbackCleanliness} setFeedbackCleanliness={setFeedbackCleanliness}
                feedbackService={feedbackService} setFeedbackService={setFeedbackService}
                feedbackValue={feedbackValue} setFeedbackValue={setFeedbackValue}
                feedbackComments={feedbackComments} setFeedbackComments={setFeedbackComments}
                feedbackRecommend={feedbackRecommend} setFeedbackRecommend={setFeedbackRecommend}
                handleSubmitFeedback={handleSubmitFeedback}
                isSubmittingFeedback={isSubmittingFeedback}
                setPostCheckoutTab={setPostCheckoutTab}
              />
              </div>
            )}

            {/* ΓöÇΓöÇ MY STAYS HISTORY TAB ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */}
            {postCheckoutTab === 'history' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ fontFamily: 'var(--font-heading)', fontWeight: '800', color: '#fff', margin: 0, fontSize: '1.2rem' }}>
                    <ClipboardList size={18} /> Your Stay History
                  </h2>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    {guestHistory?.totalStays || 0} stay{guestHistory?.totalStays !== 1 ? 's' : ''} total
                  </span>
                </div>

                {/* Loyalty Summary Card */}
                {guestHistory?.guest && (
                  <div style={{ background: 'linear-gradient(135deg, rgba(251,191,36,0.1), rgba(245,158,11,0.05))', border: '1px solid rgba(251,191,36,0.25)', borderRadius: '12px', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                    <GuestProfile guest={guestHistory.guest} />
                    <GuestLoyalty guest={guestHistory.guest} totalStays={guestHistory.totalStays} />
                  </div>
                )}

                <GuestBookingHistory
                  historyLoading={historyLoading}
                  guestHistory={guestHistory}
                  setFeedbackBookingId={setFeedbackBookingId}
                  setFeedbackSubmitted={setFeedbackSubmitted}
                  setPostCheckoutTab={setPostCheckoutTab}
                />

                {/* Book Again CTA */}
                <div style={{ textAlign: 'center', padding: '24px', marginTop: '8px' }}>
                  <button onClick={() => { setGuestHistory(null); setWizardStep(1); }} style={{
                    background: 'linear-gradient(135deg, #38bdf8, #6366f1)', border: 'none', borderRadius: '12px',
                    padding: '14px 32px', color: '#fff', fontWeight: '800', fontSize: '1rem', cursor: 'pointer'
                  }}>
                    <Hotel size={24} /> Book Your Next Stay
                  </button>
                  <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>Looking forward to welcoming you again at Hotel Sky-5</p>
                </div>
              </div>
            )}
          </div>
        </main>
      )}

      {/* ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
          ORIGINAL BOOKING WIZARD (show when no active stay AND no prior history)
      ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ */}
      {!historyLoading && !activeReservation && !hasCheckedOut && (
        <GuestBookingWizard
          user={user}
          token={token}
          rooms={rooms}
          activeBooking={activeBooking}
          activeReservation={activeReservation}
          hasCheckedOut={hasCheckedOut}
          historyLoading={historyLoading}
          wizardStep={wizardStep}
          setWizardStep={setWizardStep}
          confirmedBooking={confirmedBooking}
          setConfirmedBooking={setConfirmedBooking}
          fetchStatus={fetchStatus}
          loadGuestHistory={loadGuestHistory}
          onUserUpdate={onUserUpdate}
          showAlert={showAlert}
          apiFetch={apiFetch}
          liveBill={liveBill}
          activeSubtotal={activeSubtotal}
          activeBookingDeposit={activeBookingDeposit}
          activeBalance={activeBalance}
        />
      )}

      {/* ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
          ID RE-UPLOAD MODAL (for occupied guests with rejected documents)
      ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ */}
      {showIdReupload && (
        <div className="modal-overlay" style={{ zIndex: 3000 }}>
          <div className="glass" style={{
            width: '480px', maxWidth: '95vw', borderRadius: '16px',
            padding: '28px', border: '1px solid rgba(239,68,68,0.3)',
            display: 'flex', flexDirection: 'column', gap: '18px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ color: '#f87171', fontWeight: '800', fontSize: '1.1rem', margin: 0 }}><Upload size={18} /> Re-upload Identity Document</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '4px 0 0' }}>
                  Upload a clear, legible photo of your government ID to complete verification.
                </p>
              </div>
              <button onClick={() => setShowIdReupload(false)} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '1.4rem', cursor: 'pointer', lineHeight: 1 }}><X size={24} /></button>
            </div>

            {reuploadSuccess ? (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <p style={{ fontSize: '2rem', marginBottom: '8px' }}><CheckCircle size={18} /></p>
                <p style={{ color: '#4ade80', fontWeight: '700', fontSize: '1rem' }}>Document re-uploaded successfully!</p>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '6px' }}>The front desk will review your document shortly.</p>
                <button onClick={() => setShowIdReupload(false)} style={{ marginTop: '16px', padding: '8px 24px', background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', borderRadius: '8px', color: '#4ade80', fontWeight: '700', cursor: 'pointer', fontSize: '0.85rem' }}>
                  Close
                </button>
              </div>
            ) : (
              <>
                {/* ID Type selector */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Document Type</label>
                  <select
                    value={reuploadIdType}
                    onChange={e => setReuploadIdType(e.target.value)}
                    style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '10px 12px', color: '#fff', fontSize: '0.88rem', fontFamily: 'inherit' }}
                  >
                    {['Aadhaar Card', 'Passport', 'Driving Licence', 'Voter ID'].map(t => (
                      <option key={t} value={t} style={{ background: '#1a1f2e' }}>{t}</option>
                    ))}
                  </select>
                </div>

                {/* Government ID */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Document Number</label>
                  <input
                    type="text"
                    value={reuploadGovId}
                    onChange={e => setReuploadGovId(e.target.value.toUpperCase())}
                    placeholder="Enter your document number"
                    style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '10px 12px', color: '#fff', fontSize: '0.88rem', fontFamily: 'inherit', boxSizing: 'border-box' }}
                  />
                </div>

                {/* File upload */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Document Image / PDF</label>
                  <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '20px', border: '2px dashed rgba(239,68,68,0.35)', borderRadius: '10px', cursor: 'pointer', background: 'rgba(239,68,68,0.04)', transition: 'all 0.2s' }}>
                    <span style={{ fontSize: '2rem' }}><Paperclip size={32} /></span>
                    <span style={{ color: '#f87171', fontSize: '0.84rem', fontWeight: '600' }}>
                      {reuploadFile ? reuploadFile.name : 'Click to choose file'}
                    </span>
                    {reuploadFile && (
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                        {(reuploadFile.size / 1024).toFixed(0)} KB
                      </span>
                    )}
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      style={{ display: 'none' }}
                      onChange={e => {
                        const f = e.target.files[0];
                        if (f) { setReuploadFile(f); setReuploadError(null); }
                      }}
                    />
                  </label>
                </div>

                {reuploadError && (
                  <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', color: '#f87171', fontSize: '0.82rem' }}>
                    <AlertTriangle size={18} /> {reuploadError}
                  </div>
                )}

                <button
                  disabled={isReuploading || !reuploadFile || !reuploadGovId.trim()}
                  onClick={async () => {
                    if (!reuploadFile || !reuploadGovId.trim()) {
                      setReuploadError('Please provide a document number and upload a file.');
                      return;
                    }
                    setIsReuploading(true);
                    setReuploadError(null);
                    try {
                      const fd = new FormData();
                      fd.append('idDocument', reuploadFile);
                      fd.append('governmentId', reuploadGovId.trim());
                      fd.append('idType', reuploadIdType);
                      const res = await fetch(`${API_URL}/guest/upload-id`, {
                        method: 'POST',
                        headers: getApiHeaders(token),
                        body: fd
                      });

                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error || data.message || 'Upload failed');
                      setReuploadSuccess(true);
                    } catch (err) {
                      setReuploadError(err.message);
                    } finally {
                      setIsReuploading(false);
                    }
                  }}
                  style={{
                    padding: '12px', background: isReuploading || !reuploadFile || !reuploadGovId.trim() ? 'rgba(255,255,255,0.05)' : 'rgba(239,68,68,0.2)',
                    border: '1px solid rgba(239,68,68,0.4)', borderRadius: '10px', color: '#f87171',
                    fontWeight: '800', fontSize: '0.95rem', cursor: 'pointer', width: '100%', transition: 'all 0.2s'
                  }}
                >
                  {isReuploading ? <><Clock size={18} /> Uploading...</> : <><Upload size={18} /> Submit Re-upload</>}
                </button>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

