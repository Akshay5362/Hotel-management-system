import React, { useState } from 'react';

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
  const [idType, setIdType] = useState('Aadhaar Card'); // 'Aadhaar Card' | 'Passport' | 'Driver License' | 'Voter ID'
  const [governmentId, setGovernmentId] = useState('');
  const [uploadedFile, setUploadedFile] = useState(null); // simulated upload
  const [isUploading, setIsUploading] = useState(false);

  // STEP 4: Extra Services States
  const [extraServices, setExtraServices] = useState({
    breakfast: false,
    lunch: false,
    dinner: false,
    parking: false
  });

  // STEP 5: Payment States
  const [paymentMethod, setPaymentMethod] = useState('card'); // 'card' | 'upi'
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [upiId, setUpiId] = useState('');
  const [paymentDeposit, setPaymentDeposit] = useState('0'); // dynamically calculated default
  const [isSubmitting, setIsSubmitting] = useState(false);

  // STEP 6: Confirmation State
  const [confirmedBooking, setConfirmedBooking] = useState(null);

  // Active stay for the current logged-in guest (excludes Checked Out / Cancelled)
  const activeBooking = rooms.find(r => r.user_id === user.id && (r.status === 'booked' || r.status === 'occupied'));

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
      title: 'Standard Cozy Room',
      desc: 'Experience coziness in our signature Standard Room. Designed with sleek modern decor, premium bedding, and a peaceful environment, it is the perfect sanctuary for solo travelers or couples.',
      rate: 1500,
      image: '🛏️',
      maxPax: 2
    },
    'EXECUTIVE': {
      title: 'Executive Work Room',
      desc: 'Tailored for business leaders and discerning guests, the Executive Room offers a spacious layout, an integrated professional workstation, high-speed fiber connectivity, and sophisticated comfort.',
      rate: 2000,
      image: '💼',
      maxPax: 3
    },
    'PREMIUM': {
      title: 'Premium Suite Room',
      desc: 'Indulge in ultimate refinement. Our Premium Suite is an expansive heaven featuring a private living lounge, scenic architecture, a deep soaking tub, and bespoke luxury amenities.',
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

  const simulateFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    setTimeout(() => {
      setUploadedFile({
        name: file.name,
        size: (file.size / 1024 / 1024).toFixed(2) + ' MB'
      });
      setIsUploading(false);
    }, 1200);
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

  // Initialize deposit value on step transition to payment
  const handleTransitionToPayment = () => {
    setPaymentDeposit(totalStayPrice.toString());
    setWizardStep(5);
  };

  const handleBookSubmit = async (e) => {
    e.preventDefault();
    if (!selectedRoomNumber) {
      showAlert('Please select a room first.', 'Validation Error');
      return;
    }

    if (paymentMethod === 'card') {
      if (!cardNumber.trim() || !cardExpiry.trim() || !cardCvv.trim()) {
        showAlert('Please enter credit card details to complete payment', 'Secure Payment');
        return;
      }
    } else {
      if (!upiId.trim() || !upiId.includes('@')) {
        showAlert('Please enter a valid UPI address (e.g. username@upi)', 'Secure Payment');
        return;
      }
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
          pax: numGuests,
          deposit: parsedDeposit,
          checkInDate: checkInDate,
          checkOutDate: checkOutDate,
          extraGuests: activeExtraGuests,
          extraServices
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Booking failed');

      // Set confirmation info
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
        `Room ${selectedRoomNumber} booked successfully! Verification complete and invoice receipt generated.`,
        'Booking Confirmed'
      );

      // Reset forms and navigate to step 6 (Confirmation)
      setWizardStep(6);
      
      // Refresh room database
      await fetchStatus();

      // Trigger user state update
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

  const handleFinishConfirmation = () => {
    // Reset all states back to defaults
    setWizardStep(1);
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
    setExtraServices({
      breakfast: false,
      lunch: false,
      dinner: false,
      parking: false
    });
    setCardNumber('');
    setCardExpiry('');
    setCardCvv('');
    setUpiId('');
    setConfirmedBooking(null);
  };

  // Calculations for billing statement display
  const activeSubtotal = activeBooking ? activeBooking.ledger.reduce((sum, item) => sum + item.amount, 0) : 0;
  const activeBookingDeposit = activeBooking ? activeBooking.deposit || 0 : 0;
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
          <button onClick={onLogout} className="btn-secondary" style={{ padding: '6px 14px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
            Logout
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <main style={{ flex: 1, padding: '2rem', maxWidth: '1400px', width: '100%', margin: '0 auto', display: 'grid', gridTemplateColumns: (activeBooking && wizardStep !== 6) ? '1.1fr 0.9fr' : '1fr', gap: '2rem' }}>
        
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
                <p style={{ fontWeight: '700', color: '#fff' }}>{activeBooking.checkInDate}</p>
              </div>
              <div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>GUESTS COUNT (PAX)</p>
                <p style={{ fontWeight: '700', color: '#fff' }}>{activeBooking.pax} Person(s)</p>
              </div>
              <div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>BASE RATE</p>
                <p style={{ fontWeight: '700', color: '#fff' }}>₹ {activeBooking.rate} / Night</p>
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
                    {activeBooking.ledger.map((item, index) => (
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
                        'Standard Cozy Room',
                        1500,
                        '/standard_room.png',
                        'Experience coziness in our signature Standard Room. Designed with sleek modern decor, premium bedding, and a peaceful sanctuary for solo travelers or couples.',
                        ['🛏️ Double Bed', '📶 Free Wi-Fi', '📺 Smart TV', '❄️ Air Conditioner'],
                        2
                      )}
                      
                      {renderCategoryCard(
                        'EXECUTIVE',
                        'Executive Business Room',
                        2000,
                        '/executive_room.png',
                        'Tailored for business leaders and discerning guests, the Executive Room offers a spacious layout, an integrated professional workstation, high-speed fiber connectivity, and sophisticated comfort.',
                        ['💼 King Bed', '📶 High Speed Wi-Fi', '🖥️ Workspace', '🥤 Mini Bar'],
                        3
                      )}
                      
                      {renderCategoryCard(
                        'PREMIUM',
                        'Premium Luxury Suite',
                        2500,
                        '/premium_room.png',
                        'Indulge in ultimate refinement. Our Premium Suite is an expansive heaven featuring a private living lounge, scenic architecture, a deep soaking tub, and bespoke luxury amenities.',
                        ['👑 Luxury Lounge', '🌆 Skyline View', '🏊 Pool Access', '🛁 Bathtub'],
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

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '25px' }}>
                    <div className="form-group">
                      <label>Verification ID Type</label>
                      <select value={idType} onChange={(e) => {
                        setIdType(e.target.value);
                        setGovernmentId('');
                        setUploadedFile(null);
                      }}>
                        <option value="Aadhaar Card">Aadhaar Card (India)</option>
                        <option value="Passport">Passport</option>
                        <option value="Driver License">Driver License</option>
                        <option value="Voter ID">Voter ID</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>ID Document Number</label>
                      <input 
                        type="text" 
                        placeholder={`Enter your ${idType} identification number`}
                        value={governmentId} 
                        onChange={(e) => setGovernmentId(e.target.value)} 
                        required
                      />
                    </div>
                  </div>

                  {/* Dropzone File Upload Simulator */}
                  <div style={{ marginBottom: '25px' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: '500' }}>
                      Upload ID Document Image (Mock Simulator)
                    </label>
                    <input 
                      type="file" 
                      id="id-doc-uploader" 
                      onChange={simulateFileUpload} 
                      style={{ display: 'none' }} 
                      accept="image/*,application/pdf"
                    />
                    
                    <div 
                      onClick={triggerUploadClick}
                      style={{
                        border: '2px dashed rgba(255,255,255,0.1)',
                        borderRadius: '12px',
                        padding: '40px 20px',
                        textAlign: 'center',
                        cursor: 'pointer',
                        background: 'rgba(255,255,255,0.01)',
                        transition: 'all 0.2s',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '12px'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = 'var(--accent-color)';
                        e.currentTarget.style.background = 'rgba(56, 189, 248, 0.02)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                        e.currentTarget.style.background = 'rgba(255,255,255,0.01)';
                      }}
                    >
                      {isUploading ? (
                        <>
                          <div style={{ width: '30px', height: '30px', border: '3px solid rgba(56, 189, 248, 0.1)', borderTopColor: 'var(--color-vacant)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Uploading & performing verification scan...</span>
                        </>
                      ) : uploadedFile ? (
                        <>
                          <span style={{ fontSize: '2.5rem' }}>📄</span>
                          <div>
                            <p style={{ fontSize: '0.9rem', color: 'var(--color-booked)', fontWeight: 'bold' }}>✓ ID Scan Uploaded successfully</p>
                            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '3px' }}>
                              {uploadedFile.name} ({uploadedFile.size})
                            </p>
                          </div>
                        </>
                      ) : (
                        <>
                          <span style={{ fontSize: '2.5rem' }}>📤</span>
                          <div>
                            <p style={{ fontSize: '0.88rem', color: '#fff', fontWeight: '600' }}>Select PDF or Scanned Identification Image</p>
                            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                              Supported formats: PDF, JPG, PNG (Max 5MB). Simulated OCR scanner verifies document.
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                    <button type="button" className="btn-secondary" onClick={() => setWizardStep(2)}>
                      ← Back
                    </button>
                    <button 
                      type="button" 
                      className="btn-primary" 
                      onClick={() => {
                        if (!governmentId.trim()) {
                          showAlert('Please provide your Government identification number', 'Validation Error');
                          return;
                        }
                        if (!uploadedFile) {
                          showAlert('Please upload a scanned document image for ID validation.', 'Verification Required');
                          return;
                        }
                        setWizardStep(4);
                      }}
                      style={{ background: 'var(--accent-grad)' }}
                    >
                      Next: Extra Services →
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

              {/* STEP 5: Payment Page */}
              {wizardStep === 5 && (
                <div className="glass" style={{ borderRadius: '12px', padding: '25px', border: '1px solid rgba(56, 189, 248, 0.2)', background: 'rgba(10, 15, 30, 0.6)' }}>
                  <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h4 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.15rem', fontWeight: '700', color: '#fff' }}>
                        💳 Secure Payment Gateway
                      </h4>
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '2px' }}>
                        Review details and complete booking check-in payment.
                      </p>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', background: 'rgba(56, 189, 248, 0.08)', padding: '4px 10px', borderRadius: '4px', border: '1px solid rgba(56, 189, 248, 0.2)' }}>
                      Room {selectedRoomNumber} ({selectedRoom?.type})
                    </div>
                  </div>

                  <form onSubmit={handleBookSubmit}>
                    
                    {/* Itemized final invoices panel */}
                    <div style={{ padding: '15px', background: 'rgba(0,0,0,0.25)', borderRadius: '8px', border: '1px solid var(--border-color)', marginBottom: '20px' }}>
                      <h5 style={{ color: '#fff', fontSize: '0.8rem', textTransform: 'uppercase', marginBottom: '8px' }}>Stay Summary</h5>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>Base Room Rate:</span>
                          <span>₹ {baseRate}</span>
                        </div>
                        {loyaltyDiscount > 0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-booked)' }}>
                            <span>Loyalty Discount ({user.loyalty_tier} - {discountPercent * 100}%):</span>
                            <span>- ₹ {loyaltyDiscount}</span>
                          </div>
                        )}
                        {servicesList.map((srv, idx) => (
                          <div key={idx} style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>{srv.name}:</span>
                            <span>₹ {srv.total}</span>
                          </div>
                        ))}
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>GST (12%):</span>
                          <span>₹ {taxesAmount}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#fff', fontWeight: 'bold', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '6px', marginTop: '4px' }}>
                          <span>Net Stays Total:</span>
                          <span>₹ {totalStayPrice}</span>
                        </div>
                        
                        {/* Loyalty earnings details */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-vacant)', fontSize: '0.75rem', borderTop: '1px dashed rgba(255,255,255,0.05)', paddingTop: '6px', marginTop: '4px' }}>
                          <span>Estimated Loyalty Points Earned:</span>
                          <span><strong>+{Math.round(totalStayPrice / 10)} pts</strong></span>
                        </div>
                      </div>
                    </div>

                    {/* Deposit selector */}
                    <div className="form-group" style={{ marginBottom: '20px' }}>
                      <label style={{ fontSize: '0.85rem' }}>Advance Deposit Amount (₹) - <em>Min ₹ 1,000 required</em></label>
                      <input 
                        type="number" 
                        min="1000"
                        max={totalStayPrice}
                        value={paymentDeposit} 
                        onChange={(e) => setPaymentDeposit(e.target.value)}
                        required 
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                        <span>Paid Deposit: ₹ {paymentDeposit}</span>
                        <span>Post-Checkin Balance: ₹ {Math.max(0, totalStayPrice - parseInt(paymentDeposit || '0', 10))}</span>
                      </div>
                    </div>

                    {/* Payment Mode Selector Tabs */}
                    <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '4px', borderRadius: '8px', marginBottom: '20px', border: '1px solid var(--border-color)' }}>
                      <button 
                        type="button"
                        onClick={() => setPaymentMethod('card')}
                        style={{
                          flex: 1,
                          padding: '8px 0',
                          border: 'none',
                          background: paymentMethod === 'card' ? 'var(--accent-grad)' : 'transparent',
                          color: paymentMethod === 'card' ? '#fff' : 'var(--text-secondary)',
                          borderRadius: '6px',
                          fontWeight: '600',
                          fontSize: '0.85rem',
                          cursor: 'pointer',
                          transition: 'all 0.2s'
                        }}
                      >
                        💳 Debit / Credit Card
                      </button>
                      <button 
                        type="button"
                        onClick={() => setPaymentMethod('upi')}
                        style={{
                          flex: 1,
                          padding: '8px 0',
                          border: 'none',
                          background: paymentMethod === 'upi' ? 'var(--accent-grad)' : 'transparent',
                          color: paymentMethod === 'upi' ? '#fff' : 'var(--text-secondary)',
                          borderRadius: '6px',
                          fontWeight: '600',
                          fontSize: '0.85rem',
                          cursor: 'pointer',
                          transition: 'all 0.2s'
                        }}
                      >
                        📱 UPI Mobile Payments
                      </button>
                    </div>

                    {/* Conditional Payment Methods */}
                    {paymentMethod === 'card' ? (
                      <div style={{ padding: '15px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', border: '1px solid var(--border-color)', marginBottom: '20px' }}>
                        <div className="form-group" style={{ marginBottom: '10px' }}>
                          <label style={{ fontSize: '0.7rem' }}>Card Number</label>
                          <input 
                            type="text" 
                            name="cardnumber"
                            autoComplete="cc-number"
                            placeholder="1234 5678 1234 5678"
                            value={cardNumber}
                            onChange={(e) => setCardNumber(e.target.value)}
                            maxLength="19"
                            required
                          />
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                          <div className="form-group" style={{ marginBottom: '0' }}>
                            <label style={{ fontSize: '0.7rem' }}>Expiry Date</label>
                            <input 
                              type="text" 
                              name="cc-exp"
                              autoComplete="cc-exp"
                              placeholder="MM/YY"
                              value={cardExpiry}
                              onChange={(e) => setCardExpiry(e.target.value)}
                              maxLength="5"
                              required
                            />
                          </div>
                          <div className="form-group" style={{ marginBottom: '0' }}>
                            <label style={{ fontSize: '0.7rem' }}>CVV</label>
                            <input 
                              type="password" 
                              name="cvv"
                              autoComplete="cc-csc"
                              placeholder="***"
                              value={cardCvv}
                              onChange={(e) => setCardCvv(e.target.value)}
                              maxLength="3"
                              required
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ padding: '15px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', border: '1px solid var(--border-color)', marginBottom: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '15px' }}>
                        
                        <div className="form-group" style={{ width: '100%', marginBottom: '0' }}>
                          <label style={{ fontSize: '0.7rem' }}>UPI ID Address</label>
                          <input 
                            type="text" 
                            placeholder="e.g. guestname@upi / guest@paytm"
                            value={upiId}
                            onChange={(e) => setUpiId(e.target.value)}
                            required
                          />
                        </div>

                        {/* Styled QR Code mockup */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', background: '#fff', padding: '12px', borderRadius: '8px', width: '130px', height: '130px', justifyContent: 'center', border: '2px solid var(--color-booked)' }}>
                          <div style={{ width: '100px', height: '100px', background: 'repeating-conic-gradient(from 45deg, #000 0% 25%, transparent 0% 50%) 0 0/ 15px 15px, repeating-conic-gradient(from 45deg, #000 0% 25%, transparent 0% 50%) 7.5px 7.5px/ 15px 15px', opacity: 0.85 }} />
                        </div>
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Scan QR with your mobile app or enter UPI address above.</span>
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                      <button type="button" className="btn-secondary" onClick={() => setWizardStep(4)}>
                        ← Back
                      </button>
                      <button type="submit" className="btn-primary" disabled={isSubmitting} style={{ background: 'var(--accent-grad)', borderColor: 'var(--accent-color)' }}>
                        {isSubmitting ? 'Processing Payment...' : `Authorize ₹ ${paymentDeposit} & Confirm Booking`}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* STEP 6: Booking Confirmation Receipt Ticket */}
              {wizardStep === 6 && confirmedBooking && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', alignItems: 'center' }}>
                  
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
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-booked)' }}>
                          <span>Advance Deposit Paid:</span>
                          <strong>₹ {confirmedBooking.deposit} ({confirmedBooking.paymentMethod.toUpperCase()})</strong>
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

                </div>
              )}
            </>
          )}

        </div>

      </main>
    </div>
  );
}
