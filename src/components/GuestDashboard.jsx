import React, { useState, useEffect, useCallback } from 'react';
import PaymentPanel from './PaymentPanel';

export default function GuestDashboard({ user, token, rooms, systemDate, onLogout, showAlert, fetchStatus, onUserUpdate }) {
  const [wizardStep, setWizardStep] = useState(1); // 1: Room Selection, 2: Guest Details, 3: ID Verification, 4: Extra Services, 5: Payment, 6: Confirmation
  
  // STEP 1: Room Selection Filters
  const [selectedCategory, setSelectedCategory] = useState('ALL'); // 'ALL' | 'STANDARD' | 'EXECUTIVE' | 'PREMIUM'
  const [filterCapacity, setFilterCapacity] = useState('1'); // '1' | '2' | '3' | '4'
  const [filterMaxPrice, setFilterMaxPrice] = useState('3500');
  const [selectedRoomNumber, setSelectedRoomNumber] = useState(null); // The specific room number chosen
  
  // STEP 2: Primary Guest & Extra Guest States
  const [guestName, setGuestName] = useState(user.fullName || '');
  const [guestPhone, setGuestPhone] = useState(user.phone || '');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestGender, setGuestGender] = useState('Male'); // 'Male' | 'Female' | 'Other'
  const [guestAge, setGuestAge] = useState('');
  const [checkInDate, setCheckInDate] = useState(() => {
    return new Date().toISOString().split('T')[0];
  });
  const [checkOutDate, setCheckOutDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  });
  
  // Additional guest slots
  const [extraGuests, setExtraGuests] = useState([
    { name: '', gender: 'Male', age: '' },
    { name: '', gender: 'Male', age: '' },
    { name: '', gender: 'Male', age: '' }
  ]);

  // STEP 3: Identity Verification States
  const [idType, setIdType] = useState('Aadhaar Card'); // 'Aadhaar Card' | 'Passport' | 'Driving Licence' | 'Voter ID'
  const [governmentId, setGovernmentId] = useState('');
  const [docError, setDocError] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null); // uploaded file details
  const [fileError, setFileError] = useState(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [idDocumentPath, setIdDocumentPath] = useState(''); // Real backend path
  const [idOcrText, setIdOcrText] = useState(''); // Extracted OCR Text


  // STEP 4: Extra Services States
  const [extraServices, setExtraServices] = useState({
    breakfast: false,
    lunch: false,
    dinner: false,
    parking: false
  });

  // STEP 5: Payment States
  const [paymentMethod, setPaymentMethod] = useState('Cash'); // 'Cash' | 'UPI' | 'Debit Card' | 'Credit Card' | 'QR Code' | 'Net Banking' | 'Wallet'
  const [paymentDeposit, setPaymentDeposit] = useState('0'); // dynamically calculated default
  const [isSubmitting, setIsSubmitting] = useState(false);

  // STEP 6: Confirmation State
  const [confirmedBooking, setConfirmedBooking] = useState(null);

  // ─── PHASE 2: Guest Stay Dashboard State ───────────────────────────────────
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

  // ─── PHASE 3: Post-Checkout State ──────────────────────────────────────────
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


  // ─── Phase 2 API Helpers ────────────────────────────────────────────────────
  const apiFetch = useCallback(async (path, opts = {}) => {
    const res = await fetch(`http://localhost:5000/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(opts.headers || {}) }
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
    if (dashTab === 'bill') loadBill();
    if (dashTab === 'notifications') loadNotifications();
  }, [dashTab]);

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
    } catch (e) {
      console.error('History load error:', e);
    } finally {
      setHistoryLoading(false);
    }
  }, [apiFetch]);

  // ─── Auto-refresh room status so admin checkout is immediately detected ────
  // Polls fetchStatus every 30s while the guest is on the portal
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      fetchStatus();
    }, 30000);
    return () => clearInterval(interval);
  }, [token, fetchStatus]);

  // When the guest goes from occupied → not occupied (admin checked them out),
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
      showAlert(`⭐ ${data.message}`, 'Review Submitted!');
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
      showAlert(`✅ ${data.message}`, 'Check-In Successful');
      await fetchStatus();
    } catch (e) {
      // If backend returns a cash-pending specific error, show a friendlier message
      if (e.message && e.message.includes('Cash payment not yet confirmed')) {
        showAlert(
          'Your cash payment has not been confirmed by the reception yet. Please visit the front desk and pay your advance, then the staff will unlock your check-in.',
          '💵 Cash Payment Required'
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
      showAlert(`✅ "${serviceDesc}" request submitted! It will be delivered shortly.`, 'Service Requested');
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
      showAlert('🔧 Maintenance report submitted. Our team will attend shortly.', 'Report Received');
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
      showAlert(`📅 ${data.message}`, 'Stay Extended!');
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
      showAlert('🍽️ Your food order has been placed! Estimated delivery: 20-30 minutes.', 'Order Placed');
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
      showAlert(`📋 ${data.message}`, 'Checkout Requested');
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
      category: '🥞 Breakfast Combos',
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
      category: '🥢 Indo-Chinese',
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
      category: '🫕 Vegetarian Mains',
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
        { key: 'chili_chicken', name: 'Chili Chicken', price: 289, photo: '/food/chili_chicken.png', desc: 'Tender chicken pieces sautéed with onions, capsicum & a blend of savory spices' },
      ]
    },
    {
      category: '👨‍🍳 Chef\'s Combos',
      items: [
        { key: 'veg_combo', name: 'Veg Combo', price: 299, photo: '/food/veg_combo.png', desc: 'Paneer Butter Masala + Jeera Rice + 2 Butter Rotis + Pickle — a wholesome complete meal' },
        { key: 'non_veg_combo', name: 'Non-Veg Combo', price: 449, photo: '/food/non_veg_combo.png', desc: 'Butter Chicken + Jeera Rice + 2 Tawa Rotis + Pickle — tender chicken in creamy gravy' },
      ]
    },
    {
      category: '🫓 Breads',
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
      category: '🍮 Desserts',
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
  // Include 'vacant' rooms, and also 'booked' rooms whose existing reservation ends before our desired check-in date
  const vacantRooms = rooms.filter(r => {
    if (r.status === 'vacant') return true;
    // For 'booked' rooms, we allow booking if we know its expected check-out date
    // The backend will do the definitive conflict check, but show these rooms as selectable here
    if (r.status === 'booked' && checkInDate && r.expectedCheckOutDate) {
      const newCIN = new Date(checkInDate);
      const existingCOUT = new Date(r.expectedCheckOutDate);
      // If existing reservation ends on or before our desired check-in, it won't conflict
      return newCIN >= existingCOUT;
    }
    return false;
  });

  // Room categories descriptions
  const roomTypesInfo = {
    'STANDARD': {
      title: 'Standard Room',
      desc: 'A comfortable and clean room designed for individuals or couples seeking a budget-friendly stay.',
      rate: 1500,
      image: '🛏️',
      maxPax: 2
    },
    'EXECUTIVE': {
      title: 'Executive Room',
      desc: 'Spacious room equipped with a modern work desk, premium seating area, and complimentary high-speed connectivity.',
      rate: 2000,
      image: '💼',
      maxPax: 3
    },
    'PREMIUM': {
      title: 'Premium Suite',
      desc: 'Our signature luxury suite featuring a private lounge, panoramic skyline views, and premium personalized services.',
      rate: 2500,
      image: '👑',
      maxPax: 4
    }
  };


  // Filter vacant rooms dynamically based on criteria
  const filteredRooms = vacantRooms.filter(room => {
    // Type Category Filter
    if (selectedCategory !== 'ALL' && room.type !== selectedCategory) return false;
    
    // Price Filter
    if (room.rate > parseInt(filterMaxPrice, 10)) return false;
    
    // Capacity Filter: Standard (2), Executive (3), Premium (4)
    const capacityLimit = roomTypesInfo[room.type]?.maxPax || 2;
    if (capacityLimit < parseInt(filterCapacity, 10)) return false;
    
    return true;
  });

  const handleSelectRoom = (roomNumber) => {
    setSelectedRoomNumber(roomNumber);
  };

  const handleExtraGuestChange = (index, field, value) => {
    setExtraGuests(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  // Real-time document number validation
  useEffect(() => {
    if (!governmentId) {
      setDocError(null);
      return;
    }
    const val = governmentId.trim();
    if (idType === 'Aadhaar Card') {
      if (!/^\d+$/.test(val)) {
        setDocError('Aadhaar number must contain only numeric digits.');
      } else if (val.length !== 12) {
        setDocError(`Aadhaar must be exactly 12 digits (currently ${val.length} digits).`);
      } else {
        setDocError(null);
      }
    } else if (idType === 'Passport') {
      if (!/^[A-Z]/.test(val)) {
        setDocError('Passport must start with an uppercase letter.');
      } else if (!/^[A-Z]\d{7}$/.test(val)) {
        setDocError('Passport must be one uppercase letter followed by exactly 7 digits (e.g., A1234567).');
      } else {
        setDocError(null);
      }
    } else if (idType === 'Voter ID') {
      if (!/^[A-Z]{3}/.test(val)) {
        setDocError('Voter ID must start with 3 uppercase letters.');
      } else if (!/^[A-Z]{3}\d{7}$/.test(val)) {
        setDocError('Voter ID must be 3 uppercase letters followed by exactly 7 digits (e.g., ABC1234567).');
      } else {
        setDocError(null);
      }
    } else if (idType === 'Driving Licence') {
      const cleanDL = val.replace(/[- ]/g, '');
      if (!/^[A-Z]{2}/.test(cleanDL)) {
        setDocError('Driving Licence must start with a 2-letter state code (e.g., DL, MH).');
      } else if (!/^[A-Z]{2}\d{2}/.test(cleanDL)) {
        setDocError('Driving Licence state code must be followed by a 2-digit RTO code.');
      } else if (!/^[A-Z]{2}\d{2}(19|20)\d{2}/.test(cleanDL)) {
        setDocError('Driving Licence RTO code must be followed by a 4-digit year of issue (e.g., 2015).');
      } else if (!/^[A-Z]{2}\d{2}(19|20)\d{2}\d{7}$/.test(cleanDL)) {
        setDocError('Driving Licence must have state code, RTO code, year, and 7-digit serial number (e.g., DL0420101234567).');
      } else {
        setDocError(null);
      }
    } else {
      setDocError(null);
    }
  }, [governmentId, idType]);

  const simulateFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileError(null);

    // 1. Check supported format
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    const fileExtension = file.name.split('.').pop().toLowerCase();
    const isAllowedExt = ['jpg', 'jpeg', 'png', 'pdf'].includes(fileExtension);
    if (!allowedTypes.includes(file.type) && !isAllowedExt) {
      setFileError('Invalid file format. Only JPG, JPEG, PNG, and PDF files are allowed.');
      setUploadedFile(null);
      setFilePreviewUrl(null);
      return;
    }

    // 2. Check file size (0 byte check or empty/corrupted)
    if (file.size === 0) {
      setFileError('File is empty or corrupted. Please upload a valid document.');
      setUploadedFile(null);
      setFilePreviewUrl(null);
      return;
    }

    // 3. Check 5MB limit
    const maxSize = 5 * 1024 * 1024; // 5 MB
    if (file.size > maxSize) {
      setFileError(`File size exceeds 5MB limit (currently ${(file.size / 1024 / 1024).toFixed(2)}MB).`);
      setUploadedFile(null);
      setFilePreviewUrl(null);
      return;
    }

    setIsUploading(true);

    const completeUpload = async (previewUrl = null) => {
      try {
        const formData = new FormData();
        formData.append('document', file);
        formData.append('idType', idType); // Append ID type for OCR verification
        formData.append('documentNumber', governmentId); // Append ID number for bulletproof OCR verification

        const response = await fetch('http://localhost:5000/api/guest/upload-id', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.message || (data.errors && data.errors.document) || 'Upload failed');
        }

        setUploadedFile({
          name: file.name,
          size: (file.size / 1024 / 1024).toFixed(2) + ' MB',
          type: file.type || (fileExtension === 'pdf' ? 'application/pdf' : 'image/jpeg')
        });
        setFilePreviewUrl(previewUrl);
        setIdDocumentPath(data.data.filePath);
        setIdOcrText(data.data.ocrText);
      } catch (err) {
        setFileError(err.message);
        setUploadedFile(null);
        setFilePreviewUrl(null);
        setIdDocumentPath('');
        setIdOcrText('');
      } finally {
        setIsUploading(false);
      }
    };

    // 4. Image Quality Check (Resolution) for image files
    if (file.type.startsWith('image/') || ['jpg', 'jpeg', 'png'].includes(fileExtension)) {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      img.onload = () => {
        if (img.width < 400 || img.height < 400) {
          setFileError(`The uploaded image is too small or low-resolution (${img.width}x${img.height}px). Please upload a clearer document scan of at least 400x400px.`);
          setUploadedFile(null);
          setFilePreviewUrl(null);
          setIsUploading(false);
        } else {
          completeUpload(img.src);
        }
      };
      img.onerror = () => {
        setFileError('Failed to read image. The file may be corrupted.');
        setUploadedFile(null);
        setFilePreviewUrl(null);
        setIsUploading(false);
      };
    } else {
      // PDF file - skip resolution checks
      completeUpload(null);
    }
  };

  const handleRemoveFile = () => {
    setUploadedFile(null);
    setFilePreviewUrl(null);
    setFileError(null);
    setIdDocumentPath('');
    setIdOcrText('');
    const fileInput = document.getElementById('id-doc-uploader');
    if (fileInput) fileInput.value = '';
  };

  const triggerUploadClick = () => {
    const fileInput = document.getElementById('id-doc-uploader');
    fileInput?.click();
  };


  const toggleService = (serviceKey) => {
    setExtraServices(prev => ({
      ...prev,
      [serviceKey]: !prev[serviceKey]
    }));
  };

  const handleSelectCategoryCard = (categoryType) => {
    const matchingRoom = vacantRooms.find(r => 
      r.type === categoryType && 
      r.rate <= parseInt(filterMaxPrice, 10) &&
      (roomTypesInfo[categoryType]?.maxPax || 2) >= parseInt(filterCapacity, 10)
    );
    if (matchingRoom) {
      setSelectedRoomNumber(matchingRoom.number);
    } else {
      setSelectedRoomNumber(null);
    }
  };

  const renderCategoryCard = (categoryType, title, price, imagePath, desc, amenities, maxPax) => {
    const isSelected = selectedRoomNumber && vacantRooms.find(r => r.number === selectedRoomNumber)?.type === categoryType;
    
    const availableCount = vacantRooms.filter(r => 
      r.type === categoryType && 
      r.rate <= parseInt(filterMaxPrice, 10) &&
      (roomTypesInfo[categoryType]?.maxPax || 2) >= parseInt(filterCapacity, 10)
    ).length;
    
    return (
      <div 
        key={categoryType}
        onClick={() => {
          if (availableCount > 0) {
            handleSelectCategoryCard(categoryType);
          } else {
            showAlert(`Sorry, ${title} is currently unavailable for your selected filters (Capacity/Price) or is fully booked.`, 'Unavailable');
          }
        }}
        style={{
          borderRadius: '16px',
          overflow: 'hidden',
          border: isSelected ? '2.5px solid var(--color-vacant)' : '1px solid rgba(255,255,255,0.06)',
          cursor: availableCount > 0 ? 'pointer' : 'not-allowed',
          transition: 'all 0.25s ease',
          display: 'flex',
          flexDirection: 'column',
          background: isSelected ? 'rgba(56, 189, 248, 0.04)' : 'rgba(10, 15, 30, 0.45)',
          boxShadow: isSelected ? '0 10px 30px rgba(56, 189, 248, 0.15), 0 0 15px rgba(56, 189, 248, 0.1)' : 'none',
          opacity: availableCount > 0 ? 1 : 0.55,
          position: 'relative'
        }}
      >
        <div style={{ width: '100%', height: '170px', overflow: 'hidden', position: 'relative' }}>
          <img 
            src={imagePath} 
            alt={title} 
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <div style={{ position: 'absolute', top: '12px', right: '12px', zIndex: 2 }}>
            <span style={{ 
              fontSize: '0.68rem', 
              fontWeight: '700', 
              padding: '4px 10px', 
              borderRadius: '20px', 
              background: availableCount > 0 ? 'rgba(74, 222, 128, 0.2)' : 'rgba(239, 68, 68, 0.2)', 
              color: availableCount > 0 ? '#4ade80' : '#f87171',
              border: availableCount > 0 ? '1px solid rgba(74, 222, 128, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)'
            }}>
              {availableCount > 0 ? `${availableCount} Available` : 'Sold Out'}
            </span>
          </div>
        </div>

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', flex: 1, gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <h4 style={{ margin: 0, fontSize: '1.15rem', fontWeight: '800', color: '#fff', fontFamily: 'var(--font-heading)' }}>
              {title}
            </h4>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '1.2rem', fontWeight: '900', color: 'var(--color-vacant)' }}>₹ {price}</span>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block' }}>/ night</span>
            </div>
          </div>

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: '1.4', margin: 0 }}>
            {desc}
          </p>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              👥 Capacity: <strong>Max {maxPax} Pax</strong>
            </span>
            {isSelected && (
              <span style={{ fontSize: '0.72rem', color: 'var(--color-vacant)', fontWeight: 'bold' }}>
                ✓ Selected Room {selectedRoomNumber}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };

  const selectMealPlan = (planCode) => {
    if (planCode === 'EP') {
      setExtraServices({ breakfast: false, lunch: false, dinner: false, parking: false });
    } else if (planCode === 'CP') {
      setExtraServices({ breakfast: true, lunch: false, dinner: false, parking: false });
    } else if (planCode === 'MAP') {
      setExtraServices({ breakfast: true, lunch: false, dinner: true, parking: false });
    } else if (planCode === 'AP') {
      setExtraServices({ breakfast: true, lunch: true, dinner: true, parking: false });
    }
  };

  // Calculate pricing breakdown
  const selectedRoom = vacantRooms.find(r => r.number === selectedRoomNumber);
  const baseRate = selectedRoom ? selectedRoom.rate : 0;
  const numGuests = parseInt(filterCapacity, 10);

  // Loyalty calculations
  let discountPercent = 0;
  if (user.loyalty_tier === 'Silver') discountPercent = 0.05;
  else if (user.loyalty_tier === 'Gold') discountPercent = 0.10;
  else if (user.loyalty_tier === 'Platinum') discountPercent = 0.15;

  const loyaltyDiscount = Math.round(baseRate * discountPercent);

  // Calculate pricing based on chosen Meal Plan
  let servicesTotal = 0;
  const servicesList = [];
  
  let activeMealPlan = 'EP';
  if (extraServices.breakfast && extraServices.lunch && extraServices.dinner) {
    activeMealPlan = 'AP';
  } else if (extraServices.breakfast && !extraServices.lunch && extraServices.dinner) {
    activeMealPlan = 'MAP';
  } else if (extraServices.breakfast && !extraServices.lunch && !extraServices.dinner) {
    activeMealPlan = 'CP';
  }

  const isBreakfastFree = (user.loyalty_tier === 'Gold' || user.loyalty_tier === 'Platinum');

  if (activeMealPlan === 'CP') {
    const amt = isBreakfastFree ? 0 : 250 * numGuests;
    servicesTotal += amt;
    servicesList.push({
      name: 'Continental Plan (CP)' + (isBreakfastFree ? ' (Breakfast Complimentary Perk)' : ''),
      rate: isBreakfastFree ? '₹ 0' : '₹ 250',
      total: amt
    });
  } else if (activeMealPlan === 'MAP') {
    const breakfastAmt = isBreakfastFree ? 0 : 250 * numGuests;
    const dinnerAmt = 500 * numGuests;
    const amt = breakfastAmt + dinnerAmt;
    servicesTotal += amt;
    servicesList.push({
      name: 'Modified American Plan (MAP)' + (isBreakfastFree ? ' (Breakfast Complimentary Perk)' : ''),
      rate: isBreakfastFree ? '₹ 500' : '₹ 750',
      total: amt
    });
  } else if (activeMealPlan === 'AP') {
    const breakfastAmt = isBreakfastFree ? 0 : 250 * numGuests;
    const lunchAmt = 400 * numGuests;
    const dinnerAmt = 500 * numGuests;
    const amt = breakfastAmt + lunchAmt + dinnerAmt;
    servicesTotal += amt;
    servicesList.push({
      name: 'American Plan (AP)' + (isBreakfastFree ? ' (Breakfast Complimentary Perk)' : ''),
      rate: isBreakfastFree ? '₹ 900' : '₹ 1150',
      total: amt
    });
  }

  const taxesAmount = Math.round((baseRate - loyaltyDiscount + servicesTotal) * 0.12);
  const totalStayPrice = (baseRate - loyaltyDiscount) + servicesTotal + taxesAmount;

  // Initialize deposit value and default payment method on step transition to payment
  const handleTransitionToPayment = () => {
    setPaymentDeposit(totalStayPrice.toString());
    setPaymentMethod('Cash'); // Default to Cash (only functional method in Phase 2)
    setWizardStep(5);
  };

  const handleBookSubmit = async () => {
    if (!selectedRoomNumber) {
      showAlert('Please select a room first.', 'Validation Error');
      return;
    }

    const parsedDeposit = parseInt(paymentDeposit, 10);
    if (isNaN(parsedDeposit) || parsedDeposit < 1000) {
      showAlert('Minimum required deposit amount is ₹ 1,000 to reserve a room', 'Validation Error');
      return;
    }
    if (parsedDeposit > totalStayPrice) {
      showAlert('Deposit amount cannot exceed the total stays amount', 'Validation Error');
      return;
    }

    setIsSubmitting(true);
    try {
      const activeExtraGuests = extraGuests.slice(0, numGuests - 1);

      // ── Step A: Create booking (existing, unchanged) ────────────────────
      const res = await fetch(`http://localhost:5000/api/rooms/${selectedRoomNumber}/book`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          guestName: guestName.trim(),
          phone: guestPhone.trim(),
          email: guestEmail.trim(),
          gender: guestGender,
          age: guestAge,
          idType,
          governmentId: governmentId.trim(),
          idDocumentPath,
          idOcrText,
          pax: numGuests,
          deposit: parsedDeposit,
          checkInDate: checkInDate,
          checkOutDate: checkOutDate,
          extraGuests: activeExtraGuests,
          extraServices
        })
      });

      const data = await res.json();
      if (!res.ok || (data.success === false)) {
        throw new Error(data.message || data.error || (data.errors && Object.values(data.errors)[0]) || 'Booking failed');
      }

      // ── Step B: Finalize payment with chosen method (Phase 2 API) ────────
      // Non-blocking — if this fails the booking is still valid.
      if (data.bookingId) {
        try {
          await apiFetch('/payments/finalize', {
            method: 'POST',
            body: JSON.stringify({
              bookingId: data.bookingId,
              paymentMethod
            })
          });
        } catch (finalizeErr) {
          console.warn('Payment finalize call failed (booking still confirmed):', finalizeErr.message);
        }
      }

      // ── Step C: Set confirmation state ────────────────────────────────────
      setConfirmedBooking({
        bookingNumber: data.bookingNumber || ('BKG-' + Math.floor(100000 + Math.random() * 900000)),
        roomNumber: selectedRoomNumber,
        guestName: guestName.trim().toUpperCase(),
        checkInDate,
        checkOutDate,
        pax: numGuests,
        deposit: parsedDeposit,
        total: totalStayPrice,
        extraServices,
        idType,
        governmentId: governmentId.trim(),
        paymentMethod,
        loyaltyDiscount,
        discountPercent,
        loyaltyTier: user.loyalty_tier || 'Bronze',
        pointsEarned: data.loyalty?.pointsEarned || 0,
        totalPoints: data.loyalty?.totalPoints || 0,
        tier: data.loyalty?.tier || user.loyalty_tier || 'Bronze'
      });

      showAlert(
        `Room ${selectedRoomNumber} booked successfully! Payment recorded. Confirmation receipt generated.`,
        'Booking Confirmed'
      );

      setWizardStep(6);
      await fetchStatus();

      if (data.loyalty && onUserUpdate) {
        onUserUpdate({
          ...user,
          loyalty_tier: data.loyalty.tier,
          loyalty_points: data.loyalty.totalPoints
        });
      }
    } catch (err) {
      console.error(err);
      showAlert(err.message || 'Something went wrong', 'Booking Error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFinishConfirmation = async () => {
    try { 
      await Promise.all([fetchStatus(), loadGuestHistory()]); 
    } catch (e) { 
      console.error('fetch error on finish:', e); 
    }
    setSelectedRoomNumber(null);
    setSelectedCategory('ALL');
    setFilterCapacity('1');
    setGuestEmail('');
    setGuestGender('Male');
    setGuestAge('');
    setExtraGuests([
      { name: '', gender: 'Male', age: '' },
      { name: '', gender: 'Male', age: '' },
      { name: '', gender: 'Male', age: '' }
    ]);
    setGovernmentId('');
    setUploadedFile(null);
    setExtraServices({ breakfast: false, lunch: false, dinner: false, parking: false });
    setPaymentMethod('Cash');
    setConfirmedBooking(null);
    setWizardStep(1);
  };

  // Calculations for billing statement display
  const activeSubtotal = activeBooking ? liveBill?.ledger || [].reduce((sum, item) => sum + item.amount, 0) : 0;
  const activeBookingDeposit = activeBooking ? activeReservation?.advance_amount || 0 : 0;
  const activeBalance = activeSubtotal - activeBookingDeposit;

  return (
    <div style={{ minHeight: '100vh', background: '#080b10', color: '#f0f6fc', display: 'flex', flexDirection: 'column' }}>
      
      {/* Header Panel */}
      <header className="header glass" style={{ borderBottom: '1px solid var(--border-color)', height: '70px', padding: '0 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="brand-section" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="logo-icon">🏨</span>
          <h1 className="brand-name" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: '1.3rem' }}>
            HOTEL SKY-5 <span style={{ color: 'var(--color-vacant)' }}>GUEST PORTAL</span>
          </h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <div>Welcome, <strong style={{ color: '#fff' }}>{user.fullName}</strong></div>
            <div style={{ fontSize: '0.75rem', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span>🎖️</span>
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
              🔔
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

      {/* ═══════════════════════════════════════════════════════════════════════
          INITIALIZATION LOADING STATE
      ═══════════════════════════════════════════════════════════════════════ */}
      {(historyLoading || (activeReservation && !activeBooking)) && (
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '16px' }}>
          <div style={{ fontSize: '3rem', animation: 'pulse 1.5s infinite' }}>⏳</div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', fontWeight: '600', letterSpacing: '0.5px' }}>
            Loading your dashboard...
          </p>
        </main>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          PHASE 2: GUEST CHECK-IN LANDING (status === 'booked') 
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeBooking && activeBooking.status === 'booked' && wizardStep !== 6 && (
        <main style={{ flex: 1, padding: '2rem', maxWidth: '900px', width: '100%', margin: '0 auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Status Banner */}
            <div style={{ background: 'linear-gradient(135deg, rgba(251,191,36,0.1) 0%, rgba(245,158,11,0.05) 100%)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '12px', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '1.5rem' }}>⏳</span>
              <div>
                <p style={{ fontWeight: '700', color: '#fbbf24', margin: 0, fontSize: '0.95rem' }}>Reservation Confirmed — Awaiting Check-In</p>
                <p style={{ color: 'var(--text-muted)', margin: '2px 0 0', fontSize: '0.82rem' }}>You have an upcoming reservation. When you arrive at the hotel, click "Check In Now" below.</p>
              </div>
            </div>

            {/* Booking Details Card */}
            <div className="glass" style={{ borderRadius: '16px', padding: '28px', border: '1px solid rgba(255,255,255,0.07)' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.3rem', fontWeight: '800', color: '#fff', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                🔑 Your Reservation Details
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
                      <span style={{ fontSize: '1.8rem' }}>💵</span>
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
                      <span style={{ fontSize: '0.9rem' }}>ℹ️</span>
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
                      🔒 Check In Locked — Awaiting Payment
                    </button>
                  </div>
                )}

                {/* Case B: Payment confirmed OR no payment pending → normal Check In Now */}
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
                    {isCheckingIn ? '⏳ Checking In...' : '✅ Check In Now'}
                  </button>
                )}
              </div>
              <p style={{ textAlign: 'center', fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '14px' }}>
                {paymentStatusInfo?.cashPendingConfirmation
                  ? '💵 Pay your advance deposit at the reception desk. Check-in will unlock once confirmed.'
                  : 'ℹ️ Clicking "Check In Now" will confirm your arrival and activate your room. Make sure you are physically at the hotel reception.'}
              </p>
            </div>
          </div>
        </main>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          PHASE 2: GUEST STAY DASHBOARD (status === 'occupied') 
      ═══════════════════════════════════════════════════════════════════════ */}
      {isOccupied && (
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Tab Navigation */}
          <div style={{ borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.3)', padding: '0 2rem', display: 'flex', gap: '4px', overflowX: 'auto' }}>
            {[
              { id: 'overview', icon: '🏠', label: 'Overview' },
              { id: 'service', icon: '🛎️', label: 'Room Service' },
              { id: 'food', icon: '🍽️', label: 'Food Order' },
              { id: 'maintenance', icon: '🔧', label: 'Maintenance' },
              { id: 'bill', icon: '📄', label: 'My Bill' },
              { id: 'notifications', icon: '🔔', label: `Notifications${unreadCount > 0 ? ` (${unreadCount})` : ''}` },
              { id: 'extend', icon: '📅', label: 'Extend Stay' },
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

            {/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}
            {dashTab === 'overview' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* Live stay pulse banner */}
                <div style={{ background: 'linear-gradient(135deg, rgba(34,197,94,0.12) 0%, rgba(16,185,129,0.06) 100%)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '12px', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'pulse 2s infinite', boxShadow: '0 0 8px #22c55e' }}/>
                    <span style={{ fontWeight: '700', color: '#22c55e', fontSize: '0.95rem' }}>You are currently checked in to Hotel Sky-5</span>
                  </span>
                </div>

                {/* Stats grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
                  {[
                    { icon: '🏨', label: 'ROOM', value: `Room ${activeBooking.number}`, sub: activeBooking.type },
                    { icon: '📋', label: 'BOOKING NO', value: activeReservation?.booking_number || '—', sub: '' },
                    { icon: '📅', label: 'CHECK-IN', value: activeReservation?.check_in_date?.split('T')[0] || '—', sub: '' },
                    { icon: '🚪', label: 'CHECKOUT', value: activeReservation?.expected_check_out_date?.split('T')[0] || '—', sub: '' },
                    { icon: '👥', label: 'GUESTS', value: `${activeReservation?.adults || 1} Person(s)`, sub: '' },
                    { icon: '💰', label: 'DEPOSIT PAID', value: `₹ ${(activeReservation?.advance_amount || 0).toLocaleString('en-IN')}`, sub: '' },
                  ].map(({ icon, label, value, sub }) => (
                    <div key={label} className="glass" style={{ borderRadius: '12px', padding: '18px', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <span style={{ fontSize: '1.4rem' }}>{icon}</span>
                      <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', margin: 0 }}>{label}</p>
                      <p style={{ fontWeight: '800', color: '#fff', fontSize: '1rem', margin: 0 }}>{value}</p>
                      {sub && <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>{sub}</p>}
                    </div>
                  ))}
                </div>

                {/* Quick actions */}
                <div className="glass" style={{ borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <h3 style={{ color: '#fff', fontWeight: '700', marginBottom: '16px', fontSize: '1rem' }}>⚡ Quick Actions</h3>
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    {[
                      { label: '🛎️ Request Service', tab: 'service', color: '#818cf8' },
                      { label: '🍽️ Order Food', tab: 'food', color: '#fb923c' },
                      { label: '🔧 Report Issue', tab: 'maintenance', color: '#facc15' },
                      { label: '📄 View My Bill', tab: 'bill', color: '#22c55e' },
                      { label: '📅 Extend Stay', tab: 'extend', color: '#38bdf8' },
                    ].map(({ label, tab, color }) => (
                      <button key={tab} onClick={() => setDashTab(tab)} style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${color}30`, borderRadius: '8px', padding: '10px 16px', color, fontWeight: '600', fontSize: '0.85rem', cursor: 'pointer', transition: 'all 0.2s' }}
                        onMouseEnter={e => { e.currentTarget.style.background = `${color}20`; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Checkout Request */}
                <div className="glass" style={{ borderRadius: '12px', padding: '20px', border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.03)' }}>
                  <h3 style={{ color: '#fff', fontWeight: '700', marginBottom: '8px', fontSize: '1rem' }}>🚪 Ready to Check Out?</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.84rem', marginBottom: '14px' }}>If you wish to check out, click below to notify the reception. Proceed to the front desk to settle your final bill.</p>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      onClick={handleRequestCheckout}
                      disabled={isRequestingCheckout}
                      style={{ background: isRequestingCheckout ? 'rgba(255,255,255,0.05)' : 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '8px', padding: '10px 20px', color: '#ef4444', fontWeight: '700', fontSize: '0.88rem', cursor: isRequestingCheckout ? 'not-allowed' : 'pointer' }}
                    >
                      {isRequestingCheckout ? '⏳ Sending...' : '📋 Request Checkout'}
                    </button>
                    <button
                      onClick={() => fetchStatus()}
                      title="Sync latest room status from server"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '10px 14px', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.82rem', cursor: 'pointer' }}
                    >
                      🔄 Refresh Status
                    </button>
                  </div>
                  <p style={{ margin: '10px 0 0', fontSize: '0.74rem', color: 'var(--text-muted)', opacity: 0.7 }}>
                    ℹ️ If reception has already processed your checkout, this screen will update automatically within 30 seconds, or click Refresh Status above.
                  </p>
                </div>

              </div>
            )}

            {/* ── ROOM SERVICE TAB ──────────────────────────────────────────── */}
            {dashTab === 'service' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div>
                  <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}>🛎️ Room Service</h2>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Select a service category and choose what you need. Requests are delivered directly to your room.</p>
                </div>

                {/* Category selector */}
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  {[
                    { id: 'housekeeping', label: '🧹 Housekeeping' },
                    { id: 'laundry', label: '👔 Laundry' },
                    { id: 'extras', label: '🛏️ Bedroom Extras' },
                    { id: 'toiletries', label: '🧴 Toiletries' },
                  ].map(cat => (
                    <button key={cat.id} onClick={() => setServiceCategory(cat.id)} style={{
                      background: serviceCategory === cat.id ? 'rgba(129,140,248,0.2)' : 'rgba(255,255,255,0.04)',
                      border: serviceCategory === cat.id ? '1px solid #818cf8' : '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '8px', padding: '10px 16px', color: serviceCategory === cat.id ? '#818cf8' : 'var(--text-secondary)', fontWeight: '600', fontSize: '0.85rem', cursor: 'pointer', transition: 'all 0.2s'
                    }}>{cat.label}</button>
                  ))}
                </div>

                {/* Service items grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' }}>
                  {({
                    housekeeping: [
                      { name: 'Room Cleaning', price: 0, desc: 'Full room cleaning service', icon: '🧹' },
                      { name: 'Bed Turndown Service', price: 0, desc: 'Evening turndown with mints', icon: '🌙' },
                      { name: 'Vacuum Cleaning', price: 0, desc: 'Deep carpet vacuuming', icon: '🌀' },
                      { name: 'Fresh Towels', price: 50, desc: 'Set of fresh bath towels', icon: '🛁' },
                    ],
                    laundry: [
                      { name: 'Shirt Laundry', price: 80, desc: 'Washed & pressed shirt', icon: '👕' },
                      { name: 'Trouser Press', price: 100, desc: 'Steam pressed trousers', icon: '👖' },
                      { name: 'Saree/Kurta', price: 150, desc: 'Ethnic wear dry clean', icon: '👗' },
                      { name: 'Express Laundry', price: 250, desc: '3-hour express service', icon: '⚡' },
                    ],
                    extras: [
                      { name: 'Extra Pillow', price: 0, desc: 'Soft memory foam pillow', icon: '😴' },
                      { name: 'Extra Blanket', price: 150, desc: 'Warm fleece blanket', icon: '🛏️' },
                      { name: 'Extra Bed', price: 500, desc: 'Rollaway bed with mattress', icon: '🛌' },
                      { name: 'Baby Cot', price: 200, desc: 'Safe crib for infants', icon: '👶' },
                      { name: 'Ironing Board', price: 0, desc: 'Portable ironing board', icon: '👔' },
                    ],

                    toiletries: [
                      { name: 'Shampoo & Conditioner', price: 0, desc: 'Luxury hair care set', icon: '🧴' },
                      { name: 'Dental Kit', price: 0, desc: 'Toothbrush & toothpaste', icon: '🦷' },
                      { name: 'Razor & Shaving Kit', price: 0, desc: 'Complete shaving set', icon: '🪒' },
                      { name: 'Sanitary Kit', price: 0, desc: 'Feminine hygiene items', icon: '🌸' },
                    ],
                  })[serviceCategory]?.map(item => (
                    <div key={item.name} className="glass" style={{ borderRadius: '12px', padding: '18px', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div style={{ fontSize: '2rem' }}>{item.icon}</div>
                      <p style={{ fontWeight: '700', color: '#fff', fontSize: '0.92rem', margin: 0 }}>{item.name}</p>
                      <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0, flex: 1 }}>{item.desc}</p>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                        <span style={{ fontWeight: '700', color: item.price === 0 ? '#22c55e' : '#fbbf24', fontSize: '0.88rem' }}>{item.price === 0 ? 'Complimentary' : `₹ ${item.price}`}</span>
                        <button
                          onClick={() => handleServiceRequest(item.name, item.price || 1, 1)}
                          disabled={isSubmittingService}
                          style={{ background: 'rgba(56,189,248,0.15)', border: '1px solid rgba(56,189,248,0.4)', borderRadius: '6px', padding: '6px 14px', color: '#38bdf8', fontWeight: '700', fontSize: '0.8rem', cursor: 'pointer' }}
                        >
                          {isSubmittingService ? '...' : 'Request'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── FOOD ORDER TAB ────────────────────────────────────────────── */}
            {dashTab === 'food' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div>
                  <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}>🍽️ In-Room Dining</h2>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Order from our kitchen menu. Delivery in 20–30 minutes to your room. <span style={{ color: '#fbbf24' }}>Dial 9</span> to order by phone.</p>
                </div>

                {FOOD_MENU.map(cat => (
                  <div key={cat.category} className="glass" style={{ borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ marginBottom: '14px' }}>
                      <h3 style={{ color: '#fff', fontWeight: '700', fontSize: '1rem', margin: 0 }}>{cat.category}</h3>
                      {cat.note && (
                        <p style={{ color: '#38bdf8', fontSize: '0.74rem', fontWeight: '600', margin: '3px 0 0', letterSpacing: '0.3px' }}>
                          ⏰ {cat.note}
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
                    {isPlacingOrder ? '⏳ Placing Order...' : '🍽️ Place Order'}
                  </button>
                </div>
              </div>
            )}


            {/* ── MAINTENANCE TAB ───────────────────────────────────────────── */}
            {dashTab === 'maintenance' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div>
                  <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}>🔧 Report a Maintenance Issue</h2>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Experiencing a problem in your room? Let us know and our team will resolve it quickly.</p>
                </div>

                {/* Common issues quick select */}
                <div className="glass" style={{ borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p style={{ color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.85rem', marginBottom: '12px' }}>Quick Select (tap to add to description):</p>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
                    {['AC not cooling', 'No hot water', 'Light not working', 'WiFi not connecting', 'TV issue', 'Door lock issue', 'Plumbing problem', 'Noise complaint', 'Broken furniture'].map(issue => (
                      <button key={issue} onClick={() => setMaintenanceIssue(prev => prev ? `${prev}, ${issue}` : issue)}
                        style={{ background: 'rgba(250,204,21,0.1)', border: '1px solid rgba(250,204,21,0.2)', borderRadius: '20px', padding: '6px 12px', color: '#facc15', fontSize: '0.8rem', cursor: 'pointer', fontWeight: '600' }}>
                        {issue}
                      </button>
                    ))}
                  </div>

                  <form onSubmit={handleMaintenanceSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <textarea
                      value={maintenanceIssue}
                      onChange={e => setMaintenanceIssue(e.target.value)}
                      placeholder="Describe the issue in detail (e.g. AC is not cooling the room, making loud noise)..."
                      rows={5}
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '14px', color: '#fff', fontSize: '0.9rem', resize: 'vertical', fontFamily: 'inherit' }}
                    />
                    <button
                      type="submit"
                      disabled={isSubmittingMaintenance || !maintenanceIssue.trim()}
                      style={{ background: isSubmittingMaintenance ? 'rgba(255,255,255,0.05)' : 'rgba(250,204,21,0.15)', border: '1px solid rgba(250,204,21,0.4)', borderRadius: '8px', padding: '12px 24px', color: '#facc15', fontWeight: '800', fontSize: '0.92rem', cursor: 'pointer', alignSelf: 'flex-start', transition: 'all 0.2s' }}
                    >
                      {isSubmittingMaintenance ? '⏳ Submitting...' : '🔧 Submit Report'}
                    </button>
                  </form>
                </div>
              </div>
            )}

            {/* ── MY BILL TAB ───────────────────────────────────────────────── */}
            {dashTab === 'bill' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}>📄 Live Folio Statement</h2>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Real-time billing record for your current stay.</p>
                  </div>
                  <button onClick={loadBill} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 14px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.82rem' }}>
                    🔄 Refresh
                  </button>
                </div>

                {billLoading ? (
                  <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading bill...</div>
                ) : liveBill ? (
                  <div className="glass" style={{ borderRadius: '12px', padding: '24px', border: '1px solid rgba(255,255,255,0.07)' }}>
                    {/* Folio header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
                      <div>
                        <p style={{ fontWeight: '800', color: '#fff', fontSize: '1rem' }}>Room {liveBill.booking?.room_number} — {liveBill.booking?.room_type_title}</p>
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>Booking: {liveBill.booking?.booking_number} · Check-in: {liveBill.booking?.check_in_date}</p>
                      </div>
                      <span style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '20px', padding: '4px 14px', color: '#22c55e', fontWeight: '700', fontSize: '0.78rem' }}>IN-HOUSE</span>
                    </div>

                    {/* Ledger table */}
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                          <th style={{ textAlign: 'left', padding: '8px 0', color: 'var(--text-muted)', fontWeight: '600' }}>Description</th>
                          <th style={{ textAlign: 'center', width: '60px', color: 'var(--text-muted)', fontWeight: '600' }}>Qty</th>
                          <th style={{ textAlign: 'right', width: '110px', color: 'var(--text-muted)', fontWeight: '600' }}>Amount (₹)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(liveBill.ledger || []).map((item, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                            <td style={{ padding: '10px 0', color: '#fff' }}>{item.desc}</td>
                            <td style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>{item.qty || 1}</td>
                            <td style={{ textAlign: 'right', fontWeight: '600', color: '#fff' }}>₹ {item.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                          </tr>
                        ))}
                        {(liveBill.ledger || []).length === 0 && (
                          <tr><td colSpan={3} style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No charges posted yet</td></tr>
                        )}
                      </tbody>
                    </table>

                    {/* Bill summary */}
                    {(() => {
                      const subtotal = (liveBill.ledger || []).reduce((s, i) => s + i.amount, 0);
                      const deposit = liveBill.booking?.advance_amount || 0;
                      const balance = subtotal - deposit;
                      return (
                        <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', color: 'var(--text-secondary)' }}>
                            <span>Subtotal</span><span>₹ {subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', color: '#22c55e' }}>
                            <span>Advance Deposit Paid</span><span>− ₹ {deposit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderTop: '1px solid var(--border-color)', fontWeight: '800', color: '#fff', fontSize: '1.05rem' }}>
                            <span>{balance >= 0 ? 'Balance Due at Checkout' : 'Refund Due'}</span>
                            <span style={{ color: balance >= 0 ? '#ef4444' : '#22c55e' }}>₹ {Math.abs(balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                    <p>Click Refresh to load your bill.</p>
                  </div>
                )}
              </div>
            )}

            {/* ── NOTIFICATIONS TAB ─────────────────────────────────────────── */}
            {dashTab === 'notifications' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}>🔔 Notification Center</h2>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Messages and updates from Hotel Sky-5.</p>
                  </div>
                  <button onClick={loadNotifications} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 14px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.82rem' }}>
                    🔄 Refresh
                  </button>
                </div>

                {notifLoading ? (
                  <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading notifications...</div>
                ) : notifications.length === 0 ? (
                  <div className="glass" style={{ borderRadius: '12px', padding: '40px', textAlign: 'center', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <p style={{ fontSize: '2rem', marginBottom: '10px' }}>🔕</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No notifications yet. We'll keep you updated here.</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {notifications.map(notif => {
                      const isIdRejected = notif.type === 'id_rejected';
                      const isIdVerified = notif.type === 'id_verified';
                      return (
                        <div
                          key={notif.id}
                          onClick={() => !notif.is_read && handleMarkRead(notif.id)}
                          style={{
                            background: isIdRejected
                              ? 'rgba(239,68,68,0.07)'
                              : isIdVerified
                              ? 'rgba(34,197,94,0.07)'
                              : notif.is_read ? 'rgba(255,255,255,0.02)' : 'rgba(56,189,248,0.05)',
                            border: isIdRejected
                              ? '1px solid rgba(239,68,68,0.35)'
                              : isIdVerified
                              ? '1px solid rgba(34,197,94,0.35)'
                              : notif.is_read ? '1px solid rgba(255,255,255,0.05)' : '1px solid rgba(56,189,248,0.2)',
                            borderRadius: '10px', padding: '16px',
                            cursor: notif.is_read && !isIdRejected ? 'default' : 'pointer',
                            display: 'flex', gap: '14px', alignItems: 'flex-start', transition: 'all 0.2s'
                          }}
                        >
                          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: notif.is_read ? 'transparent' : (isIdRejected ? '#ef4444' : isIdVerified ? '#22c55e' : '#38bdf8'), marginTop: '6px', flexShrink: 0 }} />
                          <div style={{ flex: 1 }}>
                            <p style={{ fontWeight: '700', color: isIdRejected ? '#f87171' : isIdVerified ? '#4ade80' : (notif.is_read ? 'var(--text-secondary)' : '#fff'), fontSize: '0.92rem', margin: 0, marginBottom: '4px' }}>
                              {notif.title}
                            </p>
                            {/* Multi-line message — split by \n */}
                            {notif.message.split('\n').map((line, i) => (
                              line.trim() ? (
                                <p key={i} style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: '0 0 3px', lineHeight: '1.4' }}>{line}</p>
                              ) : <br key={i} />
                            ))}
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.72rem', margin: '8px 0 0' }}>
                              {new Date(notif.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                              {!notif.is_read && <span style={{ color: isIdRejected ? '#f87171' : '#38bdf8', marginLeft: '8px', fontWeight: '600' }}>· Tap to mark read</span>}
                            </p>
                            {/* ID Rejected — Re-upload CTA */}
                            {isIdRejected && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  // For booked guests: go to wizard step 3
                                  // For occupied guests: open inline re-upload modal
                                  if (activeBooking?.status === 'booked') {
                                    setWizardStep(3);
                                    setDashTab('overview');
                                  } else {
                                    setReuploadFile(null);
                                    setReuploadError(null);
                                    setReuploadSuccess(false);
                                    setShowIdReupload(true);
                                  }
                                }}
                                style={{
                                  marginTop: '10px', padding: '8px 18px',
                                  background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)',
                                  borderRadius: '8px', color: '#f87171', fontWeight: '700',
                                  fontSize: '0.82rem', cursor: 'pointer', display: 'inline-flex',
                                  alignItems: 'center', gap: '6px'
                                }}
                              >
                                📤 Re-upload Document
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── EXTEND STAY TAB ───────────────────────────────────────────── */}
            {dashTab === 'extend' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div>
                  <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}>📅 Extend Your Stay</h2>
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
                      {isExtending ? '⏳ Extending...' : '📅 Confirm Extension'}
                    </button>
                  </form>

                  <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '14px', lineHeight: '1.4' }}>
                    ℹ️ Extending your stay is subject to room availability. Additional charges will be applied as per your room tariff.
                  </p>
                </div>
              </div>
            )}

          </div>
        </main>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          PHASE 3: POST-CHECKOUT SCREEN (no active stay + has booking history)
      ═══════════════════════════════════════════════════════════════════════ */}
      {!historyLoading && !activeReservation && hasCheckedOut && (
        <main style={{ flex: 1, overflow: 'auto', padding: '0' }}>
          {/* Top Tab Nav */}
          <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.4)', padding: '0 2rem', display: 'flex', gap: '4px' }}>
            {[
              { id: 'feedback', icon: '⭐', label: 'Leave a Review' },
              { id: 'history', icon: '📋', label: 'My Stays' },
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

            {/* ── FEEDBACK TAB ─────────────────────────────────────────────── */}
            {postCheckoutTab === 'feedback' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                
                {/* Thank You Banner */}
                <div style={{ background: 'linear-gradient(135deg, rgba(56,189,248,0.12), rgba(99,102,241,0.08))', border: '1px solid rgba(56,189,248,0.25)', borderRadius: '16px', padding: '28px 32px', display: 'flex', alignItems: 'center', gap: '20px' }}>
                  <span style={{ fontSize: '3rem' }}>🏨</span>
                  <div>
                    <h2 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontWeight: '800', color: '#fff', fontSize: '1.5rem' }}>
                      Thank You for Staying With Us!
                    </h2>
                    <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                      Your checkout from <strong style={{ color: '#38bdf8' }}>Room {latestCheckedOutBooking?.room_number}</strong> is complete. 
                      We hope you had an exceptional stay. Your feedback helps us improve!
                    </p>
                    {latestCheckedOutBooking?.feedback_id || feedbackSubmitted ? (
                      <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', color: '#22c55e', fontWeight: '700', fontSize: '0.85rem' }}>
                        <span>✅</span> Review already submitted for this stay. Thank you!
                      </div>
                    ) : (
                      <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '8px', padding: '6px 12px', width: 'fit-content' }}>
                        <span style={{ fontSize: '0.85rem', color: '#fbbf24', fontWeight: '600' }}>🎁 Leave a review and earn 50 loyalty points!</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Stay Summary */}
                {latestCheckedOutBooking && (
                  <div className="glass" style={{ borderRadius: '16px', padding: '20px 24px', border: '1px solid rgba(255,255,255,0.06)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px' }}>
                    {[
                      { label: 'Booking', value: latestCheckedOutBooking.booking_number, icon: '🔖' },
                      { label: 'Room', value: `${latestCheckedOutBooking.room_number} (${latestCheckedOutBooking.room_type})`, icon: '🏠' },
                      { label: 'Check-In', value: latestCheckedOutBooking.check_in_date, icon: '📅' },
                      { label: 'Check-Out', value: latestCheckedOutBooking.check_out_date, icon: '🚪' },
                      { label: 'Total Paid', value: `₹${(latestCheckedOutBooking.total_paid || 0).toLocaleString('en-IN')}`, icon: '💰', highlight: true },
                      { label: 'Payment', value: latestCheckedOutBooking.payment_status, icon: latestCheckedOutBooking.payment_status === 'Paid' ? '✅' : '⚠️' },
                    ].map(stat => (
                      <div key={stat.label} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{stat.icon} {stat.label}</span>
                        <span style={{ fontSize: '0.95rem', fontWeight: '700', color: stat.highlight ? '#38bdf8' : '#fff' }}>{stat.value}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Feedback Form */}
                {!latestCheckedOutBooking?.feedback_id && !feedbackSubmitted ? (
                  <div className="glass" style={{ borderRadius: '16px', padding: '28px', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: '28px' }}>
                    <h3 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontWeight: '800', color: '#fff', fontSize: '1.1rem' }}>
                      📝 Share Your Experience
                    </h3>

                    {/* Star Rating Helper */}
                    {(() => {
                      const StarRow = ({ label, value, setValue }) => (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', minWidth: '140px' }}>{label}</span>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            {[1,2,3,4,5].map(star => (
                              <button key={star} onClick={() => setValue(star)} style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                fontSize: '1.6rem', filter: star <= value ? 'none' : 'grayscale(1) opacity(0.3)',
                                transform: star <= value ? 'scale(1.1)' : 'scale(1)', transition: 'all 0.15s',
                              }}>⭐</button>
                            ))}
                          </div>
                          {value > 0 && <span style={{ fontSize: '0.78rem', color: ['','😞','😕','😐','😊','😍'][value], fontWeight: '600', minWidth: '24px' }}>
                            {['','Poor','Fair','Good','Great','Excellent!'][value]}
                          </span>}
                        </div>
                      );
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                          <StarRow label="⭐ Overall Experience *" value={feedbackOverall} setValue={setFeedbackOverall} />
                          <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />
                          <StarRow label="🛏️ Room Cleanliness" value={feedbackCleanliness} setValue={setFeedbackCleanliness} />
                          <StarRow label="🛎️ Service Quality" value={feedbackService} setValue={setFeedbackService} />
                          <StarRow label="💰 Value for Money" value={feedbackValue} setValue={setFeedbackValue} />
                        </div>
                      );
                    })()}

                    {/* Comments */}
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                        💬 Tell us more (optional)
                      </label>
                      <textarea
                        value={feedbackComments}
                        onChange={e => setFeedbackComments(e.target.value)}
                        placeholder="What did you love? What could we improve? Any special moments to share?"
                        rows={4}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', color: '#fff', padding: '12px 14px', fontSize: '0.9rem', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }}
                      />
                    </div>

                    {/* Would Recommend Toggle */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>🤝 Would you recommend Hotel Sky-5 to a friend?</span>
                      <button onClick={() => setFeedbackRecommend(!feedbackRecommend)} style={{
                        background: feedbackRecommend ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.1)',
                        border: `1px solid ${feedbackRecommend ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.3)'}`,
                        borderRadius: '20px', padding: '6px 18px', cursor: 'pointer',
                        color: feedbackRecommend ? '#22c55e' : '#ef4444',
                        fontWeight: '700', fontSize: '0.85rem', transition: 'all 0.2s'
                      }}>
                        {feedbackRecommend ? '✅ Yes, definitely!' : '❌ Not this time'}
                      </button>
                    </div>

                    {/* Submit Button */}
                    <button
                      onClick={handleSubmitFeedback}
                      disabled={isSubmittingFeedback || feedbackOverall === 0}
                      style={{
                        background: feedbackOverall > 0 ? 'linear-gradient(135deg, #38bdf8, #6366f1)' : 'rgba(255,255,255,0.05)',
                        border: 'none', borderRadius: '12px', padding: '14px 28px',
                        color: '#fff', fontWeight: '800', fontSize: '1rem', cursor: feedbackOverall > 0 ? 'pointer' : 'not-allowed',
                        opacity: isSubmittingFeedback ? 0.7 : 1, transition: 'all 0.2s',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                      }}
                    >
                      {isSubmittingFeedback ? '⏳ Submitting...' : '⭐ Submit Review & Earn 50 Points'}
                    </button>
                  </div>
                ) : (
                  <div style={{ background: 'linear-gradient(135deg, rgba(34,197,94,0.1), rgba(16,185,129,0.05))', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '16px', padding: '40px', textAlign: 'center' }}>
                    <div style={{ fontSize: '3rem', marginBottom: '12px' }}>🎉</div>
                    <h3 style={{ color: '#22c55e', fontWeight: '800', margin: '0 0 8px', fontSize: '1.3rem' }}>Review Submitted!</h3>
                    <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Thank you for your feedback. You earned <strong style={{ color: '#fbbf24' }}>50 loyalty points</strong>. We look forward to welcoming you back!</p>
                    <button onClick={() => { setFeedbackOverall(0); setFeedbackCleanliness(0); setFeedbackService(0); setFeedbackValue(0); setFeedbackComments(''); setPostCheckoutTab('history'); }} style={{ marginTop: '16px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '8px 20px', color: '#fff', cursor: 'pointer', fontSize: '0.85rem' }}>
                      📋 View My Stay History
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── MY STAYS HISTORY TAB ─────────────────────────────────────── */}
            {postCheckoutTab === 'history' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ fontFamily: 'var(--font-heading)', fontWeight: '800', color: '#fff', margin: 0, fontSize: '1.2rem' }}>
                    📋 Your Stay History
                  </h2>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    {guestHistory?.totalStays || 0} stay{guestHistory?.totalStays !== 1 ? 's' : ''} total
                  </span>
                </div>

                {/* Loyalty Summary Card */}
                {guestHistory?.guest && (
                  <div style={{ background: 'linear-gradient(135deg, rgba(251,191,36,0.1), rgba(245,158,11,0.05))', border: '1px solid rgba(251,191,36,0.25)', borderRadius: '12px', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span style={{ fontSize: '2rem' }}>🎖️</span>
                      <div>
                        <div style={{ fontWeight: '800', color: '#fff', fontSize: '1rem' }}>{guestHistory.guest.full_name}</div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{guestHistory.guest.phone}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '24px' }}>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.4rem', fontWeight: '900', color: '#fbbf24' }}>{guestHistory.guest.loyalty_points || 0}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Points</div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.4rem', fontWeight: '900', color: guestHistory.guest.loyalty_tier === 'Gold' ? '#ffd700' : guestHistory.guest.loyalty_tier === 'Platinum' ? '#e5e4e2' : guestHistory.guest.loyalty_tier === 'Silver' ? '#c0c0c0' : '#cd7f32' }}>
                          {(guestHistory.guest.loyalty_tier || 'Bronze').toUpperCase()}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Tier</div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.4rem', fontWeight: '900', color: '#38bdf8' }}>{guestHistory.totalStays || 0}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Stays</div>
                      </div>
                    </div>
                  </div>
                )}

                {historyLoading ? (
                  <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>⏳ Loading your stay history...</div>
                ) : guestHistory?.bookings?.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>📋</div>
                    No stay history found yet.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {guestHistory?.bookings?.map(booking => (
                      <div key={booking.id} className="glass" style={{ borderRadius: '14px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {/* Booking Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ fontSize: '1.2rem' }}>{booking.room_type === 'PREMIUM' ? '👑' : booking.room_type === 'EXECUTIVE' ? '💼' : '🛏️'}</span>
                            <div>
                              <div style={{ fontWeight: '700', color: '#fff', fontSize: '0.95rem' }}>Room {booking.room_number} — {booking.room_title}</div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{booking.booking_number}</div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '0.7rem', fontWeight: '700',
                              background: booking.booking_status === 'Checked Out' ? 'rgba(148,163,184,0.15)' : booking.booking_status === 'Checked In' ? 'rgba(34,197,94,0.15)' : 'rgba(251,191,36,0.15)',
                              color: booking.booking_status === 'Checked Out' ? '#94a3b8' : booking.booking_status === 'Checked In' ? '#22c55e' : '#fbbf24',
                              textTransform: 'uppercase' }}>
                              {booking.booking_status}
                            </span>
                            <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '0.7rem', fontWeight: '700',
                              background: booking.payment_status === 'Paid' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.1)',
                              color: booking.payment_status === 'Paid' ? '#22c55e' : '#ef4444',
                              textTransform: 'uppercase' }}>
                              {booking.payment_status}
                            </span>
                          </div>
                        </div>

                        {/* Booking Details Grid */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                          {[
                            { label: 'Check-In', value: booking.check_in_date },
                            { label: 'Check-Out', value: booking.check_out_date || '—' },
                            { label: 'Total Billed', value: `₹${(booking.total_amount || 0).toLocaleString('en-IN')}` },
                            { label: 'Total Paid', value: `₹${(booking.total_paid || 0).toLocaleString('en-IN')}`, highlight: true },
                          ].map(s => (
                            <div key={s.label}>
                              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '2px' }}>{s.label}</div>
                              <div style={{ fontWeight: '700', color: s.highlight ? '#38bdf8' : '#fff', fontSize: '0.9rem' }}>{s.value}</div>
                            </div>
                          ))}
                        </div>

                        {/* Feedback Status */}
                        {booking.booking_status === 'Checked Out' && (
                          <div style={{ paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            {booking.feedback_id ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ fontSize: '0.8rem', color: '#22c55e' }}>✅ Review submitted</span>
                                <span style={{ display: 'flex', gap: '2px' }}>
                                  {[1,2,3,4,5].map(s => (
                                    <span key={s} style={{ fontSize: '0.75rem', filter: s <= booking.overall_rating ? 'none' : 'grayscale(1) opacity(0.3)' }}>⭐</span>
                                  ))}
                                </span>
                              </div>
                            ) : (
                              <button onClick={() => { setFeedbackBookingId(booking.id); setFeedbackSubmitted(false); setPostCheckoutTab('feedback'); }} style={{
                                background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.25)', borderRadius: '8px',
                                padding: '6px 14px', color: '#38bdf8', cursor: 'pointer', fontSize: '0.8rem', fontWeight: '600'
                              }}>
                                ⭐ Leave a Review
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Book Again CTA */}
                <div style={{ textAlign: 'center', padding: '24px', marginTop: '8px' }}>
                  <button onClick={() => { setGuestHistory(null); setWizardStep(1); }} style={{
                    background: 'linear-gradient(135deg, #38bdf8, #6366f1)', border: 'none', borderRadius: '12px',
                    padding: '14px 32px', color: '#fff', fontWeight: '800', fontSize: '1rem', cursor: 'pointer'
                  }}>
                    🏨 Book Your Next Stay
                  </button>
                  <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>Looking forward to welcoming you again at Hotel Sky-5</p>
                </div>
              </div>
            )}

          </div>
        </main>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          ORIGINAL BOOKING WIZARD (show when no active stay AND no prior history)
      ═══════════════════════════════════════════════════════════════════════ */}
      {!historyLoading && !activeReservation && !hasCheckedOut && (
        <main style={{ flex: 1, padding: '2rem', maxWidth: '1400px', width: '100%', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr', gap: '2rem' }}>

        
        {/* Left Side: Active Booking Folio (If Active Booking exists and we are not in confirmation screen) */}
        {activeBooking && wizardStep !== 6 && (
          <div className="glass" style={{ borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)', alignSelf: 'start' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', fontWeight: '700', color: '#fff' }}>
                🔑 Your Active Reservation
              </h3>
              <span className={`filter-chip ${activeBooking.status === 'booked' ? 'chip-booked active' : 'chip-occupied active'}`} style={{ fontSize: '0.72rem', padding: '4px 10px', textTransform: 'uppercase' }}>
                {activeBooking.status === 'booked' ? 'Booked (Awaiting Check-In)' : 'In-House'}
              </span>
            </div>

            {/* Quick stats */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', padding: '15px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)', marginBottom: '20px' }}>
              <div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>ROOM NO & TYPE</p>
                <p style={{ fontWeight: '700', color: '#fff' }}>Room {activeBooking.number} ({activeBooking.type})</p>
              </div>
              <div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>CHECK-IN DATE</p>
                <p style={{ fontWeight: '700', color: '#fff' }}>{activeReservation?.check_in_date?.split('T')[0]}</p>
              </div>
              <div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>GUESTS COUNT (PAX)</p>
                <p style={{ fontWeight: '700', color: '#fff' }}>{activeReservation?.adults} Person(s)</p>
              </div>
              <div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>BASE RATE</p>
                <p style={{ fontWeight: '700', color: '#fff' }}>₹ {liveBill?.booking?.base_rate} / Night</p>
              </div>
            </div>

            {/* Billing Ledger */}
            <div>
              <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                Billing Folio Statement
              </h4>
              <div className="ledger-table-container">
                <table className="ledger-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                      <th style={{ padding: '8px 0' }}>Description</th>
                      <th style={{ width: '80px', textAlign: 'center' }}>Qty</th>
                      <th style={{ width: '120px', textAlign: 'right' }}>Amount (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveBill?.ledger || [].map((item, index) => (
                      <tr key={item.id || index} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                        <td style={{ padding: '8px 0' }}>{item.desc}</td>
                        <td style={{ textAlign: 'center' }}>{item.qty || 1}</td>
                        <td style={{ textAlign: 'right', fontWeight: '600' }}>₹ {item.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                
                <div className="ledger-summary" style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '0.9rem' }}>
                    <span>Subtotal</span>
                    <span>₹ {activeSubtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', color: 'var(--color-booked)', fontSize: '0.9rem' }}>
                    <span>Advance Deposit Paid</span>
                    <span>- ₹ {activeBookingDeposit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border-color)', fontWeight: 'bold', color: '#fff', fontSize: '1.05rem' }}>
                    <span>{activeBalance >= 0 ? 'Net Balance Due' : 'Refund Due'}</span>
                    <span style={{ color: activeBalance >= 0 ? 'var(--color-occupied)' : 'var(--color-booked)' }}>
                      ₹ {Math.abs(activeBalance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '15px', lineHeight: '1.4' }}>
              💡 <em>Note: Any additional dining, restaurant orders, or extra services ordered during your stay will be posted to this statement. Final settlement or refund occurs at check-out.</em>
            </p>
          </div>
        )}

        {/* Right Side: Wizard booking or Confirmation Screen */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {activeBooking && wizardStep !== 6 ? (
            /* Message when stay already exists */
            <div style={{ padding: '30px', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px dashed rgba(255,255,255,0.08)', textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
              <div style={{ fontSize: '3rem', marginBottom: '15px' }}>🧳</div>
              <h4 style={{ color: '#fff', fontSize: '1.1rem', fontWeight: '700', marginBottom: '8px' }}>Active Reservation In Progress</h4>
              <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', maxWidth: '400px', lineHeight: '1.4' }}>
                You have a stay booked in Room <strong>{activeBooking.number}</strong>. You cannot book multiple rooms at the same time on this account. Please settle and check out of your active room before requesting a new booking.
              </p>
            </div>
          ) : (
            <>
              {/* Wizard Nav Go Back */}
              {wizardStep > 1 && wizardStep < 6 && (
                <button 
                  onClick={() => setWizardStep(prev => prev - 1)} 
                  style={{
                    alignSelf: 'flex-start',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--color-vacant)',
                    cursor: 'pointer',
                    fontSize: '0.88rem',
                    fontWeight: '700',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '0',
                    width: 'fit-content',
                    transition: 'all 0.2s',
                    textDecoration: 'none',
                    marginBottom: '10px'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = '#fff'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'var(--color-vacant)'}
                >
                  <span style={{ fontSize: '1.1rem' }}>←</span> Go Back
                </button>
              )}

              {/* Step indicator header (Only for steps 1-5) */}
              {wizardStep < 6 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px 20px', flexWrap: 'wrap', gap: '10px' }}>
                  {[
                    { step: 1, label: 'Room' },
                    { step: 2, label: 'Profile' },
                    { step: 3, label: 'Identity' },
                    { step: 4, label: 'Services' },
                    { step: 5, label: 'Payment' }
                  ].map((s, idx, arr) => (
                    <React.Fragment key={s.step}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: wizardStep === s.step ? 1 : 0.4 }}>
                        <span style={{ 
                          background: wizardStep >= s.step ? 'var(--color-vacant)' : 'rgba(255,255,255,0.1)', 
                          color: wizardStep >= s.step ? '#000' : '#fff', 
                          borderRadius: '50%', 
                          width: '22px', 
                          height: '22px', 
                          display: 'flex', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          fontSize: '0.78rem', 
                          fontWeight: 'bold' 
                        }}>
                          {s.step}
                        </span>
                        <span style={{ fontSize: '0.82rem', fontWeight: '600', color: '#fff' }}>{s.label}</span>
                      </div>
                      {idx < arr.length - 1 && (
                        <div style={{ borderTop: '1px dashed rgba(255,255,255,0.1)', flex: 1, minWidth: '15px' }} />
                      )}
                    </React.Fragment>
                  ))}
                </div>
              )}

              {/* STEP 1: Specific Room Selection */}
              {wizardStep === 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div>
                    <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.25rem', fontWeight: '700', color: '#fff' }}>
                      🔎 Pre-Checkin: Choose Your Room
                    </h3>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
                      Register your checking-in details by searching rooms based on type, price range, capacity, and real-time availability.
                    </p>
                  </div>

                  {/* Loyalty Program Info Banner */}
                  <div className="glass" style={{
                    borderRadius: '12px',
                    padding: '16px 20px',
                    border: '1px solid rgba(56, 189, 248, 0.25)',
                    background: 'linear-gradient(90deg, rgba(56, 189, 248, 0.08) 0%, rgba(129, 140, 248, 0.08) 100%)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '1.4rem' }}>🎖️</span>
                        <h4 style={{ margin: 0, fontWeight: '800', color: '#fff', fontSize: '0.98rem' }}>
                          Sky-5 Loyalty Status: <span style={{
                            color: user.loyalty_tier === 'Platinum' ? '#e5e4e2' : 
                                   user.loyalty_tier === 'Gold' ? '#ffd700' : 
                                   user.loyalty_tier === 'Silver' ? '#c0c0c0' : '#cd7f32',
                            textShadow: '0 0 10px rgba(255,255,255,0.1)'
                          }}>{user.loyalty_tier || 'Bronze'}</span>
                        </h4>
                      </div>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', background: 'rgba(0,0,0,0.3)', padding: '4px 10px', borderRadius: '20px' }}>
                        Balance: <strong>{user.loyalty_points || 0} pts</strong>
                      </span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
                      <p style={{ margin: 0, fontSize: '0.78rem', color: '#cbd5e1', lineHeight: '1.4', flex: '1 1 400px' }}>
                        {user.loyalty_tier === 'Platinum' && "🏆 Premium Tier Active! You save 15% on room tariff and enjoy complimentary breakfast and parking."}
                        {user.loyalty_tier === 'Gold' && "✨ Gold Tier Active! You save 10% on room tariff and enjoy complimentary buffet breakfast."}
                        {user.loyalty_tier === 'Silver' && "⭐ Silver Tier Active! You save 5% on room tariff. Upgrade to Gold at 1,500 pts for free breakfasts."}
                        {(user.loyalty_tier === 'Bronze' || !user.loyalty_tier) && "🎖️ Bronze Tier Active. Earn 500 pts to upgrade to Silver (5% discount) and 1,500 pts for Gold (10% discount + Free breakfast)."}
                      </p>
                      
                      {user.loyalty_tier !== 'Platinum' && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.03)', padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                          Next Tier Upgrade: <strong>{
                            user.loyalty_tier === 'Gold' ? '3,000 pts (Platinum)' : 
                            user.loyalty_tier === 'Silver' ? '1,500 pts (Gold)' : '500 pts (Silver)'
                          }</strong> (Need {
                            user.loyalty_tier === 'Gold' ? (3000 - (user.loyalty_points || 0)) : 
                            user.loyalty_tier === 'Silver' ? (1500 - (user.loyalty_points || 0)) : (500 - (user.loyalty_points || 0))
                          } more)
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Filter Toolbar Card */}
                  <div className="glass" style={{ borderRadius: '12px', padding: '16px', border: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', background: 'rgba(255,255,255,0.01)' }}>
                    {/* Guest Count */}

                    {/* Capacity */}
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Capacity (Pax)</label>
                      <select value={filterCapacity} onChange={(e) => { setFilterCapacity(e.target.value); setSelectedRoomNumber(null); }}>
                        <option value="1">1 Adult</option>
                        <option value="2">2 Adults</option>
                        <option value="3">3 Adults</option>
                        <option value="4">4 Adults</option>
                      </select>
                    </div>

                    {/* Max Price */}
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Max Tariff: ₹ {filterMaxPrice}</label>
                      <input 
                        type="range" 
                        min="1500" 
                        max="3500" 
                        step="500" 
                        value={filterMaxPrice} 
                        onChange={(e) => { setFilterMaxPrice(e.target.value); setSelectedRoomNumber(null); }} 
                        style={{ width: '100%', marginTop: '10px' }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                        <span>₹1500</span>
                        <span>₹3500</span>
                      </div>
                    </div>
                  </div>

                  {/* Category Selection Cards */}
                  <div>
                    <h4 style={{ color: '#fff', fontSize: '0.92rem', fontWeight: '700', marginBottom: '16px', display: 'flex', justifyContent: 'space-between' }}>
                      <span>Select Room Category</span>
                      {selectedRoomNumber && (
                        <span style={{ color: 'var(--color-vacant)' }}>
                          Selected Category: {vacantRooms.find(r => r.number === selectedRoomNumber)?.type} (Room {selectedRoomNumber})
                        </span>
                      )}
                    </h4>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
                      {renderCategoryCard(
                        'STANDARD',
                        'Standard Room',
                        1500,
                        '/standard_room.png',
                        'A comfortable and clean room designed for individuals or couples seeking a budget-friendly stay.',
                        [],
                        2
                      )}
                      
                      {renderCategoryCard(
                        'EXECUTIVE',
                        'Executive Room',
                        2000,
                        '/executive_room.png',
                        'Spacious room equipped with a modern work desk, premium seating area, and complimentary high-speed connectivity.',
                        [],
                        3
                      )}
                      
                      {renderCategoryCard(
                        'PREMIUM',
                        'Premium Suite',
                        2500,
                        '/premium_room.png',
                        'Our signature luxury suite featuring a private lounge, panoramic skyline views, and premium personalized services.',
                        [],
                        4
                      )}
                    </div>

                  </div>

                  {selectedRoomNumber && (
                    <button 
                      onClick={() => setWizardStep(2)} 
                      className="btn-primary" 
                      style={{ background: 'var(--accent-grad)', width: 'fit-content', alignSelf: 'flex-end', padding: '10px 24px' }}
                    >
                      Next: Guest Profile Info →
                    </button>
                  )}
                </div>
              )}

              {/* STEP 2: Guest Details */}
              {wizardStep === 2 && (
                <div className="glass" style={{ borderRadius: '12px', padding: '25px', border: '1px solid var(--border-color)', background: 'rgba(10, 15, 30, 0.4)' }}>
                  <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', marginBottom: '20px' }}>
                    <h4 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.15rem', fontWeight: '700', color: '#fff' }}>
                      📋 Step 2: Primary Guest Profile Info
                    </h4>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '2px' }}>
                      Provide contact, gender, and age profiles for checking in to Room {selectedRoomNumber}.
                    </p>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '25px' }}>
                    <div className="form-group">
                      <label>Guest Full Name</label>
                      <input 
                        type="text" 
                        value={guestName} 
                        onChange={(e) => setGuestName(e.target.value)} 
                        required 
                      />
                    </div>
                    <div className="form-group">
                      <label>Contact Mobile</label>
                      <input 
                        type="tel" 
                        placeholder="e.g. +91 9999999999"
                        value={guestPhone} 
                        onChange={(e) => setGuestPhone(e.target.value)} 
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Email Address</label>
                      <input 
                        type="email" 
                        placeholder="e.g. guest@example.com"
                        value={guestEmail} 
                        onChange={(e) => setGuestEmail(e.target.value)} 
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Gender</label>
                      <select value={guestGender} onChange={(e) => setGuestGender(e.target.value)}>
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Age</label>
                      <input 
                        type="number" 
                        min="18" 
                        max="120"
                        placeholder="e.g. 28"
                        value={guestAge} 
                        onChange={(e) => setGuestAge(e.target.value)} 
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Expected Check-in Date</label>
                      <input 
                        type="date" 
                        value={checkInDate} 
                        onChange={(e) => {
                          setCheckInDate(e.target.value);
                          // Auto-adjust checkout if it's not at least 1 day after new check-in
                          if (checkOutDate <= e.target.value) {
                            const nextDay = new Date(e.target.value);
                            nextDay.setDate(nextDay.getDate() + 1);
                            setCheckOutDate(nextDay.toISOString().split('T')[0]);
                          }
                        }}
                        required 
                      />
                    </div>
                    <div className="form-group">
                      <label>Expected Check-out Date</label>
                      <input 
                        type="date" 
                        value={checkOutDate}
                        min={(() => { const d = new Date(checkInDate); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; })()}
                        onChange={(e) => setCheckOutDate(e.target.value)}
                        required 
                      />
                    </div>
                  </div>

                  {/* Extra guest information fields */}
                  {parseInt(filterCapacity, 10) > 1 && (
                    <div style={{ marginTop: '20px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '20px', marginBottom: '20px' }}>
                      <h5 style={{ color: '#fff', fontSize: '0.9rem', fontWeight: '700', marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        👥 Additional Guests Profile ({parseInt(filterCapacity, 10) - 1})
                      </h5>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                        {Array.from({ length: parseInt(filterCapacity, 10) - 1 }).map((_, idx) => (
                          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 1fr', gap: '15px', padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)' }}>
                            <div className="form-group" style={{ marginBottom: '0' }}>
                              <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Guest {idx + 2} Full Name</label>
                              <input 
                                type="text" 
                                placeholder={`Name`}
                                value={extraGuests[idx]?.name || ''} 
                                onChange={(e) => handleExtraGuestChange(idx, 'name', e.target.value)} 
                                required 
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: '0' }}>
                              <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Gender</label>
                              <select 
                                value={extraGuests[idx]?.gender || 'Male'}
                                onChange={(e) => handleExtraGuestChange(idx, 'gender', e.target.value)}
                              >
                                <option value="Male">Male</option>
                                <option value="Female">Female</option>
                                <option value="Other">Other</option>
                              </select>
                            </div>
                            <div className="form-group" style={{ marginBottom: '0' }}>
                              <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Age</label>
                              <input 
                                type="number" 
                                min="1"
                                max="120"
                                placeholder="Age"
                                value={extraGuests[idx]?.age || ''} 
                                onChange={(e) => handleExtraGuestChange(idx, 'age', e.target.value)} 
                                required 
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '20px' }}>
                    <button type="button" className="btn-secondary" onClick={() => setWizardStep(1)}>
                      ← Back
                    </button>
                    <button 
                      type="button" 
                      className="btn-primary" 
                      onClick={() => {
                        if (!guestName.trim() || !guestPhone.trim() || !guestEmail.trim() || !guestAge || !checkInDate) {
                          showAlert('Please fill in all primary guest profile fields.', 'Validation Error');
                          return;
                        }
                        if (parseInt(guestAge, 10) < 18) {
                          showAlert('Primary checking-in guest must be at least 18 years old.', 'Validation Error');
                          return;
                        }
                        const activeExtraGuests = extraGuests.slice(0, parseInt(filterCapacity, 10) - 1);
                        for (let i = 0; i < activeExtraGuests.length; i++) {
                          if (!activeExtraGuests[i].name.trim() || !activeExtraGuests[i].age.trim()) {
                            showAlert(`Please provide Name and Age for Guest ${i + 2}`, 'Validation Error');
                            return;
                          }
                        }
                        setWizardStep(3);
                      }}
                      style={{ background: 'var(--accent-grad)' }}
                    >
                      Next: ID Verification →
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 3: Identity Verification */}
              {wizardStep === 3 && (
                <div className="glass" style={{ borderRadius: '12px', padding: '25px', border: '1px solid var(--border-color)', background: 'rgba(10, 15, 30, 0.4)' }}>
                  <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', marginBottom: '20px' }}>
                    <h4 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.15rem', fontWeight: '700', color: '#fff' }}>
                      🛡️ Step 3: Identity Verification
                    </h4>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '2px' }}>
                      Government-approved identification is required for hotel registration check-in.
                    </p>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', marginBottom: '20px' }}>
                    <div className="form-group">
                      <label style={{ color: 'var(--text-secondary)', fontWeight: '500' }}>
                        Verification ID Type <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <select value={idType} onChange={(e) => {
                        setIdType(e.target.value);
                        setGovernmentId('');
                        handleRemoveFile();
                      }} style={{ width: '100%' }}>
                        <option value="Aadhaar Card">Aadhaar Card</option>
                        <option value="Driving Licence">Driving Licence</option>
                        <option value="Passport">Passport</option>
                        <option value="Voter ID">Voter ID</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label style={{ color: 'var(--text-secondary)', fontWeight: '500' }}>
                        ID Document Number <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input 
                        type="text" 
                        placeholder={`Enter your ${idType} identification number`}
                        value={governmentId} 
                        onChange={(e) => {
                          let val = e.target.value;
                          if (idType === 'Aadhaar Card') {
                            val = val.replace(/[^\d]/g, ''); // Reject alphabets and special characters
                            if (val.length > 12) val = val.slice(0, 12);
                          } else if (idType === 'Passport') {
                            val = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
                            if (val.length > 8) val = val.slice(0, 8);
                          } else if (idType === 'Voter ID') {
                            val = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
                            if (val.length > 10) val = val.slice(0, 10);
                          } else if (idType === 'Driving Licence') {
                            val = val.toUpperCase().replace(/[^A-Z0-9\-\s]/g, ''); // Allow hyphens and spaces
                          } else {
                            val = val.toUpperCase();
                          }
                          setGovernmentId(val);
                        }} 
                        maxLength={idType === 'Aadhaar Card' ? 12 : idType === 'Passport' ? 8 : idType === 'Voter ID' ? 10 : 20}
                        style={{
                          width: '100%',
                          borderColor: docError ? '#ef4444' : 'var(--border-color)',
                          boxShadow: docError ? '0 0 0 1px #ef4444' : 'none'
                        }}
                        required
                      />
                      {docError && (
                        <p style={{ color: '#f87171', fontSize: '0.72rem', marginTop: '5px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          ⚠️ {docError}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Dropzone File Upload Simulator */}
                  <div style={{ marginBottom: '25px' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: '500' }}>
                      Upload ID Document Image / PDF
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: '8px', fontWeight: '400' }}>(Optional — can show offline at reception)</span>
                    </label>
                    <input 
                      type="file" 
                      id="id-doc-uploader" 
                      onChange={simulateFileUpload} 
                      style={{ display: 'none' }} 
                      accept="image/jpeg,image/jpg,image/png,application/pdf"
                    />
                    
                    <div 
                      onClick={!uploadedFile && !isUploading ? triggerUploadClick : undefined}
                      style={{
                        border: fileError ? '2px dashed #ef4444' : '2px dashed rgba(255,255,255,0.1)',
                        borderRadius: '12px',
                        padding: uploadedFile ? '20px' : '40px 20px',
                        textAlign: 'center',
                        cursor: uploadedFile ? 'default' : 'pointer',
                        background: uploadedFile ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.01)',
                        transition: 'all 0.2s',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '12px'
                      }}
                      onMouseEnter={(e) => {
                        if (!uploadedFile) {
                          e.currentTarget.style.borderColor = fileError ? '#ef4444' : 'var(--accent-color)';
                          e.currentTarget.style.background = 'rgba(56, 189, 248, 0.02)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!uploadedFile) {
                          e.currentTarget.style.borderColor = fileError ? '#ef4444' : 'rgba(255,255,255,0.1)';
                          e.currentTarget.style.background = 'rgba(255,255,255,0.01)';
                        }
                      }}
                    >
                      {isUploading ? (
                        <>
                          <div style={{ width: '30px', height: '30px', border: '3px solid rgba(56, 189, 248, 0.1)', borderTopColor: 'var(--color-vacant)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Uploading & performing verification scan...</span>
                        </>
                      ) : uploadedFile ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', width: '100%' }}>
                          {filePreviewUrl ? (
                            <img 
                              src={filePreviewUrl} 
                              alt="ID Preview" 
                              style={{ width: '100%', maxWidth: '320px', maxHeight: '180px', objectFit: 'contain', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)' }} 
                            />
                          ) : (
                            <span style={{ fontSize: '2.5rem' }}>📄</span>
                          )}
                          <div style={{ textAlign: 'center' }}>
                            <p style={{ fontSize: '0.9rem', color: 'var(--color-booked)', fontWeight: 'bold' }}>✓ ID Scan Uploaded successfully</p>
                            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '3px' }}>
                              {uploadedFile.name} ({uploadedFile.size})
                            </p>
                          </div>
                          <button 
                            type="button" 
                            className="btn-secondary" 
                            onClick={handleRemoveFile} 
                            style={{ padding: '5px 15px', fontSize: '0.78rem', background: 'rgba(239, 68, 68, 0.15)', borderColor: 'rgba(239, 68, 68, 0.4)', color: '#ef4444', fontWeight: 'bold', cursor: 'pointer' }}
                          >
                            Remove / Re-upload File
                          </button>
                        </div>
                      ) : (
                        <>
                          <span style={{ fontSize: '2.5rem' }}>📤</span>
                          <div>
                            <p style={{ fontSize: '0.88rem', color: '#fff', fontWeight: '600' }}>Select PDF or Scanned Identification Image</p>
                            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                              Supported formats: PDF, JPG, JPEG, PNG (Max 5MB). Simulated OCR scanner verifies document.
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                    {fileError && (
                      <p style={{ color: '#f87171', fontSize: '0.72rem', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        ⚠️ {fileError}
                      </p>
                    )}
                  </div>

                  {/* Skip notice when no document uploaded */}
                  {!uploadedFile && !isUploading && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', background: 'rgba(251, 191, 36, 0.06)', border: '1px solid rgba(251, 191, 36, 0.2)', borderRadius: '8px', marginBottom: '18px' }}>
                      <span style={{ fontSize: '1rem' }}>📋</span>
                      <p style={{ fontSize: '0.75rem', color: '#fbbf24', margin: 0, lineHeight: '1.4' }}>
                        <strong>No document uploaded.</strong> You can proceed and present your ID document physically at the reception desk during check-in.
                      </p>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                    <button type="button" className="btn-secondary" onClick={() => setWizardStep(2)}>
                      ← Back
                    </button>
                    <button 
                      type="button" 
                      className="btn-primary" 
                      disabled={!!docError || (!!fileError && !!uploadedFile) || !governmentId.trim()}
                      onClick={() => {
                        if (docError || !governmentId.trim()) return;
                        // If there's a file error but no file actually uploaded, clear the error and allow skip
                        if (fileError && !uploadedFile) setFileError(null);
                        if (fileError && uploadedFile) return;
                        setWizardStep(4);
                      }}
                      style={{ 
                        background: (docError || (fileError && uploadedFile) || !governmentId.trim()) ? '#1e293b' : 'var(--accent-grad)',
                        color: (docError || (fileError && uploadedFile) || !governmentId.trim()) ? 'var(--text-muted)' : '#fff',
                        cursor: (docError || (fileError && uploadedFile) || !governmentId.trim()) ? 'not-allowed' : 'pointer'
                      }}
                    >
                      {uploadedFile ? 'Next: Extra Services →' : 'Skip Upload & Continue →'}
                    </button>
                  </div>
                </div>
              )}


              {/* STEP 4: Extra Services */}
              {wizardStep === 4 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div>
                    <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.25rem', fontWeight: '700', color: '#fff' }}>
                      🍳 Step 4: Choose Extra Services
                    </h3>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
                      Personalize your hotel experience. Toggled services are billed per night directly to your check-out folio.
                    </p>
                  </div>

                  {/* Services toggle grids */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.2rem' }}>
                    
                    {/* EP */}
                    <div 
                      onClick={() => selectMealPlan('EP')}
                      className="glass"
                      style={{
                        padding: '20px',
                        borderRadius: '12px',
                        cursor: 'pointer',
                        border: activeMealPlan === 'EP' ? '1px solid var(--color-booked)' : '1px solid rgba(255,255,255,0.06)',
                        display: 'flex',
                        gap: '15px',
                        background: activeMealPlan === 'EP' ? 'rgba(74, 222, 128, 0.05)' : 'var(--bg-card)',
                        transition: 'all 0.2s'
                      }}
                    >
                      <div style={{ fontSize: '2rem' }}>🏨</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <h5 style={{ color: '#fff', fontSize: '0.95rem', fontWeight: '700' }}>EP (European Plan)</h5>
                          <span style={{ fontSize: '0.72rem', color: 'var(--color-booked)', fontWeight: 'bold' }}>
                            ₹ 0 / night
                          </span>
                        </div>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', lineHeight: '1.3' }}>
                          Room stay only. No meals are included. Ideal for budget travelers or guests who prefer exploring local dining options.
                        </p>
                      </div>
                    </div>

                    {/* CP */}
                    <div 
                      onClick={() => selectMealPlan('CP')}
                      className="glass"
                      style={{
                        padding: '20px',
                        borderRadius: '12px',
                        cursor: 'pointer',
                        border: activeMealPlan === 'CP' ? '1px solid var(--color-booked)' : '1px solid rgba(255,255,255,0.06)',
                        display: 'flex',
                        gap: '15px',
                        background: activeMealPlan === 'CP' ? 'rgba(74, 222, 128, 0.05)' : 'var(--bg-card)',
                        transition: 'all 0.2s'
                      }}
                    >
                      <div style={{ fontSize: '2rem' }}>🍳</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <h5 style={{ color: '#fff', fontSize: '0.95rem', fontWeight: '700' }}>CP (Continental Plan)</h5>
                          <span style={{ fontSize: '0.72rem', color: 'var(--color-booked)', fontWeight: 'bold' }}>
                            {isBreakfastFree ? '₹ 0' : '₹ 250'} / guest / night
                          </span>
                        </div>
                        {isBreakfastFree && (
                          <div style={{ fontSize: '0.65rem', color: '#ffd700', fontWeight: 'bold', marginTop: '2px' }}>
                            🎖️ Complimentary Gold/Platinum Perk
                          </div>
                        )}
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', lineHeight: '1.3' }}>
                          Room stay + Buffet Breakfast included. Mornings start with a fresh continental spread in the dining hall.
                        </p>
                      </div>
                    </div>

                    {/* MAP */}
                    <div 
                      onClick={() => selectMealPlan('MAP')}
                      className="glass"
                      style={{
                        padding: '20px',
                        borderRadius: '12px',
                        cursor: 'pointer',
                        border: activeMealPlan === 'MAP' ? '1px solid var(--color-booked)' : '1px solid rgba(255,255,255,0.06)',
                        display: 'flex',
                        gap: '15px',
                        background: activeMealPlan === 'MAP' ? 'rgba(74, 222, 128, 0.05)' : 'var(--bg-card)',
                        transition: 'all 0.2s'
                      }}
                    >
                      <div style={{ fontSize: '2rem' }}>🍱</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <h5 style={{ color: '#fff', fontSize: '0.95rem', fontWeight: '700' }}>MAP (Modified American Plan)</h5>
                          <span style={{ fontSize: '0.72rem', color: 'var(--color-booked)', fontWeight: 'bold' }}>
                            {isBreakfastFree ? '₹ 500' : '₹ 750'} / guest / night
                          </span>
                        </div>
                        {isBreakfastFree && (
                          <div style={{ fontSize: '0.65rem', color: '#ffd700', fontWeight: 'bold', marginTop: '2px' }}>
                            🎖️ Breakfast Discount Applied (-₹250)
                          </div>
                        )}
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', lineHeight: '1.3' }}>
                          Room stay + two daily meals (Buffet Breakfast + Gourmet Dinner) included. Ideal option for travelers exploring all day.
                        </p>
                      </div>
                    </div>

                    {/* AP */}
                    <div 
                      onClick={() => selectMealPlan('AP')}
                      className="glass"
                      style={{
                        padding: '20px',
                        borderRadius: '12px',
                        cursor: 'pointer',
                        border: activeMealPlan === 'AP' ? '1px solid var(--color-booked)' : '1px solid rgba(255,255,255,0.06)',
                        display: 'flex',
                        gap: '15px',
                        background: activeMealPlan === 'AP' ? 'rgba(74, 222, 128, 0.05)' : 'var(--bg-card)',
                        transition: 'all 0.2s'
                      }}
                    >
                      <div style={{ fontSize: '2rem' }}>🍽️</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <h5 style={{ color: '#fff', fontSize: '0.95rem', fontWeight: '700' }}>AP (American Plan)</h5>
                          <span style={{ fontSize: '0.72rem', color: 'var(--color-booked)', fontWeight: 'bold' }}>
                            {isBreakfastFree ? '₹ 900' : '₹ 1,150'} / guest / night
                          </span>
                        </div>
                        {isBreakfastFree && (
                          <div style={{ fontSize: '0.65rem', color: '#ffd700', fontWeight: 'bold', marginTop: '2px' }}>
                            🎖️ Breakfast Discount Applied (-₹250)
                          </div>
                        )}
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', lineHeight: '1.3' }}>
                          Fully inclusive room stay + three daily meals (Buffet Breakfast, Executive Lunch, and Gourmet Dinner) included.
                        </p>
                      </div>
                    </div>

                  </div>

                  {/* Realtime Pricing Calculations Panel */}
                  <div className="glass" style={{ borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.01)' }}>
                    <h5 style={{ color: '#fff', fontSize: '0.88rem', fontWeight: '700', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Pricing Breakdown Summary
                    </h5>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>Room {selectedRoomNumber} Base Tariff ({selectedRoom?.type} Category)</span>
                        <span>₹ {baseRate}</span>
                      </div>

                      {loyaltyDiscount > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-booked)' }}>
                          <span>Loyalty {user.loyalty_tier} Discount (-{discountPercent * 100}%)</span>
                          <span>- ₹ {loyaltyDiscount}</span>
                        </div>
                      )}
                      
                      {servicesList.map((srv, idx) => (
                        <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-booked)' }}>
                          <span>{srv.name} ({srv.rate} * {numGuests} guest(s))</span>
                          <span>+ ₹ {srv.total}</span>
                        </div>
                      ))}

                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>Taxes & GST (12% of Tariff + Services)</span>
                        <span>₹ {taxesAmount}</span>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '10px', fontSize: '1.05rem', fontWeight: 'bold', color: '#fff' }}>
                        <span>Total Stay Rate Estimate</span>
                        <span style={{ color: 'var(--color-vacant)' }}>₹ {totalStayPrice}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                    <button type="button" className="btn-secondary" onClick={() => setWizardStep(3)}>
                      ← Back
                    </button>
                    <button 
                      type="button" 
                      className="btn-primary" 
                      onClick={handleTransitionToPayment}
                      style={{ background: 'var(--accent-grad)' }}
                    >
                      Next: Complete Payment →
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 5: Booking Summary + Payment */}
              {wizardStep === 5 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

                  {/* ── Section Header ── */}
                  <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '14px' }}>
                    <h4 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.15rem', fontWeight: '700', color: '#fff' }}>
                      📋 Step 5: Booking Summary &amp; Payment
                    </h4>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '2px' }}>
                      Review your complete booking details before confirming payment.
                    </p>
                  </div>

                  {/* ── Booking Summary Card ── */}
                  <div className="glass" style={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(10,15,30,0.5)', overflow: 'hidden' }}>

                    {/* Card header */}
                    <div style={{ padding: '14px 20px', background: 'rgba(56,189,248,0.06)', borderBottom: '1px solid rgba(56,189,248,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Room</p>
                        <p style={{ fontSize: '1.1rem', fontWeight: '800', color: '#38bdf8' }}>Room {selectedRoomNumber} &mdash; {selectedRoom?.type}</p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Guest</p>
                        <p style={{ fontSize: '0.92rem', fontWeight: '700', color: '#fff' }}>{guestName.trim().toUpperCase()}</p>
                      </div>
                    </div>

                    {/* Stay dates row */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      {[
                        { label: 'Check-in', value: checkInDate, color: '#38bdf8' },
                        { label: 'Check-out', value: checkOutDate || '—', color: '#818cf8' },
                        { label: 'Guests', value: `${numGuests} Adult${numGuests > 1 ? 's' : ''}`, color: '#fff' },
                      ].map((item, i) => (
                        <div key={i} style={{ padding: '14px 18px', borderRight: i < 2 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                          <p style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{item.label}</p>
                          <p style={{ fontSize: '0.9rem', fontWeight: '700', color: item.color, marginTop: '3px' }}>{item.value}</p>
                        </div>
                      ))}
                    </div>

                    {/* ID & Document */}
                    <div style={{ padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: '12px', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.85rem' }}>🛡️</span>
                      <div>
                        <p style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Identity</p>
                        <p style={{ fontSize: '0.82rem', color: '#fff', marginTop: '2px' }}>
                          {idType} &mdash; <span style={{ fontFamily: 'monospace' }}>{governmentId || '—'}</span>
                          {!idDocumentPath && <span style={{ marginLeft: '8px', fontSize: '0.65rem', color: '#fbbf24', background: 'rgba(251,191,36,0.1)', padding: '2px 6px', borderRadius: '3px' }}>Offline</span>}
                          {idDocumentPath && <span style={{ marginLeft: '8px', fontSize: '0.65rem', color: '#4ade80', background: 'rgba(74,222,128,0.1)', padding: '2px 6px', borderRadius: '3px' }}>Uploaded</span>}
                        </p>
                      </div>
                    </div>

                    {/* Services */}
                    {servicesList.length > 0 && (
                      <div style={{ padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <p style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>Services</p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {servicesList.map((srv, i) => (
                            <span key={i} style={{ fontSize: '0.72rem', color: '#4ade80', background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.2)', padding: '3px 8px', borderRadius: '4px' }}>
                              {srv.name} &mdash; ₹{srv.total}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Pricing Breakdown */}
                    <div style={{ padding: '14px 18px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '7px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>Room {selectedRoomNumber} Base Tariff</span>
                          <span>₹ {baseRate.toLocaleString()}</span>
                        </div>
                        {loyaltyDiscount > 0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#4ade80' }}>
                            <span>🎖️ {user.loyalty_tier} Loyalty Discount (-{discountPercent * 100}%)</span>
                            <span>- ₹ {loyaltyDiscount.toLocaleString()}</span>
                          </div>
                        )}
                        {servicesList.map((srv, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>{srv.name}</span>
                            <span>₹ {srv.total.toLocaleString()}</span>
                          </div>
                        ))}
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>GST &amp; Taxes (12%)</span>
                          <span>₹ {taxesAmount.toLocaleString()}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '8px', marginTop: '2px', fontSize: '1rem', fontWeight: 'bold', color: '#fff' }}>
                          <span>Total Payable</span>
                          <span style={{ color: '#38bdf8' }}>₹ {totalStayPrice.toLocaleString()}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#a3e635' }}>
                          <span>🏅 Est. Loyalty Points Earned</span>
                          <span>+{Math.round(totalStayPrice / 10)} pts</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* ── Deposit Selector ── */}
                  <div className="form-group" style={{ marginBottom: '0' }}>
                    <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: '500' }}>
                      Advance Deposit Amount (₹) &mdash; <em style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Min ₹ 1,000 required</em>
                    </label>
                    <input
                      type="number"
                      min="1000"
                      max={totalStayPrice}
                      value={paymentDeposit}
                      onChange={(e) => setPaymentDeposit(e.target.value)}
                      style={{ marginTop: '6px' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      <span>Advance Deposit: ₹ {parseInt(paymentDeposit || '0', 10).toLocaleString()}</span>
                      <span>Balance at Check-out: ₹ {Math.max(0, totalStayPrice - parseInt(paymentDeposit || '0', 10)).toLocaleString()}</span>
                    </div>
                  </div>


                  {/* ── Payment Method Selector — Reusable PaymentPanel component ── */}
                  {/* RAZORPAY HOOK: In next phase, pass onGatewayPay prop here */}
                  <PaymentPanel
                    selectedMethod={paymentMethod}
                    onMethodChange={setPaymentMethod}
                    amount={parseInt(paymentDeposit || '0', 10)}
                  />


                  {/* ── Action Buttons ── */}
                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <button type="button" className="btn-secondary" onClick={() => setWizardStep(4)}>← Back</button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={isSubmitting}
                      onClick={handleBookSubmit}
                      style={{ background: 'var(--accent-grad)', minWidth: '200px' }}
                    >
                      {isSubmitting
                        ? '⏳ Processing Booking...'
                        : `Confirm Booking & Pay ₹ ${parseInt(paymentDeposit || '0', 10).toLocaleString()} →`}
                    </button>
                  </div>

                </div>
              )}

              {/* End of Wizard Forms */}
            </>
          )}

        </div>

      </main>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          PHASE 1: BOOKING CONFIRMATION RECEIPT (wizardStep === 6)
      ═══════════════════════════════════════════════════════════════════════ */}
      {wizardStep === 6 && confirmedBooking && (
        <main style={{ flex: 1, padding: '2rem', maxWidth: '900px', width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px', alignItems: 'center' }}>
          
          {/* Success Indicator icon */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center', marginBottom: '10px' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(74, 222, 128, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2.5rem', color: 'var(--color-booked)', animation: 'pulse 2s infinite' }}>
              ✓
            </div>
            <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.6rem', fontWeight: '800', color: '#fff' }}>
              Booking Pre-Checkin Confirmed!
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Your reservation is secured. Show this receipt at checking-in desk for card retrieval.
            </p>
          </div>

          {/* Confirmation Ticket Details */}
          <div className="glass" style={{ width: '100%', maxWidth: '520px', borderRadius: '16px', border: '1px solid rgba(74, 222, 128, 0.3)', background: 'linear-gradient(180deg, rgba(16,28,24,0.7) 0%, rgba(13,17,23,0.9) 100%)', overflow: 'hidden', boxShadow: '0 15px 35px rgba(0,0,0,0.4), 0 0 20px rgba(74,222,128,0.05)' }}>
            
            {/* Header Ticket Banner */}
            <div style={{ padding: '20px', background: 'rgba(74,222,128,0.06)', borderBottom: '1px dashed rgba(74,222,128,0.2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Booking reference code</p>
                <p style={{ fontSize: '1.2rem', fontFamily: 'monospace', fontWeight: 'bold', color: '#fff' }}>{confirmedBooking.bookingNumber}</p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Assigned Room</p>
                <p style={{ fontSize: '1.25rem', fontWeight: '800', color: 'var(--color-booked)' }}>ROOM {confirmedBooking.roomNumber}</p>
              </div>
            </div>

            {/* Ticket Body Content */}
            <div style={{ padding: '25px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              
              {/* Grid: stay details */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', fontSize: '0.82rem', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '16px' }}>
                <div>
                  <p style={{ color: 'var(--text-muted)' }}>PRIMARY GUEST</p>
                  <p style={{ fontWeight: 'bold', color: '#fff', marginTop: '2px' }}>{confirmedBooking.guestName}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-muted)' }}>CHECK-IN DATE</p>
                  <p style={{ fontWeight: 'bold', color: '#38bdf8', marginTop: '2px' }}>{confirmedBooking.checkInDate}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-muted)' }}>CHECK-OUT DATE</p>
                  <p style={{ fontWeight: 'bold', color: '#818cf8', marginTop: '2px' }}>{confirmedBooking.checkOutDate || '—'}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-muted)' }}>GUEST(S) COUNT</p>
                  <p style={{ fontWeight: 'bold', color: '#fff', marginTop: '2px' }}>{confirmedBooking.pax} Person(s)</p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-muted)' }}>IDENTIFICATION TYPE</p>
                  <p style={{ fontWeight: 'bold', color: '#fff', marginTop: '2px' }}>{confirmedBooking.idType}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-muted)' }}>BOOKING STATUS</p>
                  <p style={{ fontWeight: 'bold', color: 'var(--color-booked)', marginTop: '2px' }}>✓ Reserved</p>
                </div>
              </div>

              {/* Extra services details */}
              <div style={{ fontSize: '0.82rem', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '16px' }}>
                <p style={{ color: 'var(--text-muted)', marginBottom: '6px' }}>SERVICES ENROLLED</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  <span style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '3px 8px', fontSize: '0.72rem', color: '#fff' }}>
                    🏨 Room Stay Folio
                  </span>
                  <span style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.2)', borderRadius: '4px', padding: '3px 8px', fontSize: '0.72rem', color: 'var(--color-booked)' }}>
                    {confirmedBooking.extraServices.breakfast && confirmedBooking.extraServices.lunch && confirmedBooking.extraServices.dinner ? '🍽️ American Plan (AP)' :
                     confirmedBooking.extraServices.breakfast && !confirmedBooking.extraServices.lunch && confirmedBooking.extraServices.dinner ? '🍱 Modified American Plan (MAP)' :
                     confirmedBooking.extraServices.breakfast && !confirmedBooking.extraServices.lunch && !confirmedBooking.extraServices.dinner ? '🍳 Continental Plan (CP)' :
                     '🏨 European Plan (EP)'}
                  </span>
                </div>
              </div>

              {/* Payment summaries */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.82rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Invoice Total:</span>
                  <span style={{ color: '#fff', fontWeight: '600' }}>₹ {confirmedBooking.total}</span>
                </div>
                {confirmedBooking.loyaltyDiscount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-booked)' }}>
                    <span>Loyalty {confirmedBooking.loyaltyTier} Discount (-{confirmedBooking.discountPercent * 100}%):</span>
                    <span>- ₹ {confirmedBooking.loyaltyDiscount}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#fbbf24' }}>
                  <span>
                    {confirmedBooking.paymentMethod === 'Cash'
                      ? 'Cash Advance (Pay at Reception):'
                      : `${confirmedBooking.paymentMethod} (Gateway Payment):`}
                  </span>
                  <strong>
                    ₹ {confirmedBooking.deposit} ({confirmedBooking.paymentMethod.toUpperCase()})
                    {confirmedBooking.paymentMethod === 'Cash'
                      ? <span style={{ fontSize: '0.62rem', marginLeft: '6px', background: 'rgba(239,68,68,0.15)', color: '#ef4444', padding: '1px 5px', borderRadius: '3px', fontWeight: '700' }}>PENDING</span>
                      : <span style={{ fontSize: '0.62rem', marginLeft: '6px', background: 'rgba(251,191,36,0.12)', color: '#fbbf24', padding: '1px 5px', borderRadius: '3px', fontWeight: '700' }}>AWAITING GATEWAY</span>
                    }
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '8px', marginTop: '4px', fontSize: '0.92rem', fontWeight: 'bold' }}>
                  <span style={{ color: '#fff' }}>Folio Balance Due:</span>
                  <span style={{ color: 'var(--color-occupied)' }}>₹ {Math.max(0, confirmedBooking.total - confirmedBooking.deposit)}</span>
                </div>

                {/* Loyalty updates */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', background: 'rgba(56, 189, 248, 0.05)', border: '1px solid rgba(56, 189, 248, 0.1)', padding: '10px', borderRadius: '8px', marginTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Loyalty Points Earned:</span>
                    <span style={{ color: 'var(--color-vacant)', fontWeight: 'bold' }}>+{confirmedBooking.pointsEarned} pts</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>New Status:</span>
                    <span style={{ color: '#ffd700', fontWeight: 'bold' }}>{confirmedBooking.tier.toUpperCase()} MEMBER ({confirmedBooking.totalPoints} pts)</span>
                  </div>
                </div>
              </div>

            </div>
          </div>

          <button 
            onClick={handleFinishConfirmation}
            className="btn-primary"
            style={{ background: 'var(--accent-grad)', padding: '10px 30px', fontSize: '0.88rem', fontWeight: 'bold', marginTop: '10px' }}
          >
            Go to active stay Folio →
          </button>

        </main>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          ID RE-UPLOAD MODAL (for occupied guests with rejected documents)
      ═══════════════════════════════════════════════════════════════════════ */}
      {showIdReupload && (
        <div className="modal-overlay" style={{ zIndex: 3000 }}>
          <div className="glass" style={{
            width: '480px', maxWidth: '95vw', borderRadius: '16px',
            padding: '28px', border: '1px solid rgba(239,68,68,0.3)',
            display: 'flex', flexDirection: 'column', gap: '18px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ color: '#f87171', fontWeight: '800', fontSize: '1.1rem', margin: 0 }}>📤 Re-upload Identity Document</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '4px 0 0' }}>
                  Upload a clear, legible photo of your government ID to complete verification.
                </p>
              </div>
              <button onClick={() => setShowIdReupload(false)} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '1.4rem', cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>

            {reuploadSuccess ? (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <p style={{ fontSize: '2rem', marginBottom: '8px' }}>✅</p>
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
                    <span style={{ fontSize: '2rem' }}>📎</span>
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
                    ⚠️ {reuploadError}
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
                      const res = await fetch('http://localhost:5000/api/guest/upload-id', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` },
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
                  {isReuploading ? '⏳ Uploading...' : '📤 Submit Re-upload'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

