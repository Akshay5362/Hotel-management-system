import React, { useState } from 'react';
import PaymentPanel from './PaymentPanel';

export default function GuestBookingWizard({
  user,
  token,
  rooms,
  activeBooking,
  activeReservation,
  hasCheckedOut,
  historyLoading,
  wizardStep,
  setWizardStep,
  confirmedBooking,
  setConfirmedBooking,
  fetchStatus,
  loadGuestHistory,
  onUserUpdate,
  showAlert,
  apiFetch,
  liveBill,
  activeSubtotal,
  activeBookingDeposit,
  activeBalance
}) {
  // STEP 1: Room Selection Filters
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [filterCapacity, setFilterCapacity] = useState('1');
  const [filterMaxPrice, setFilterMaxPrice] = useState('3500');
  const [selectedRoomNumber, setSelectedRoomNumber] = useState(null);
  
  // STEP 2: Primary Guest & Extra Guest States
  const [guestName, setGuestName] = useState(user.fullName || '');
  const [guestPhone, setGuestPhone] = useState(user.phone || '');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestGender, setGuestGender] = useState('Male');
  const [guestAge, setGuestAge] = useState('');
  const [checkInDate, setCheckInDate] = useState(() => {
    return new Date().toISOString().split('T')[0];
  });
  const [checkOutDate, setCheckOutDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  });
  
  const [extraGuests, setExtraGuests] = useState([
    { name: '', gender: 'Male', age: '' },
    { name: '', gender: 'Male', age: '' },
    { name: '', gender: 'Male', age: '' }
  ]);

  // STEP 3: Identity Verification States
  const [idType, setIdType] = useState('Aadhaar Card');
  const [governmentId, setGovernmentId] = useState('');
  const [docError, setDocError] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [idDocumentPath, setIdDocumentPath] = useState('');
  const [idOcrText, setIdOcrText] = useState('');

  // STEP 4: Extra Services States
  const [extraServices, setExtraServices] = useState({
    breakfast: false,
    lunch: false,
    dinner: false,
    parking: false
  });

  // STEP 5: Payment States
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [paymentDeposit, setPaymentDeposit] = useState('0');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Derived properties for Room Selection
  const roomTypesInfo = {
    'STANDARD': { price: 1500, maxPax: 2 },
    'EXECUTIVE': { price: 2000, maxPax: 3 },
    'PREMIUM': { price: 2500, maxPax: 4 }
  };

  const vacantRooms = rooms.filter(r => r.status === 'vacant');
  let filteredRooms = vacantRooms;
  if (selectedCategory !== 'ALL') {
    filteredRooms = filteredRooms.filter(r => r.type === selectedCategory);
  }
  const cap = parseInt(filterCapacity, 10);
  filteredRooms = filteredRooms.filter(r => {
    const rInfo = roomTypesInfo[r.type];
    return rInfo && rInfo.maxPax >= cap && rInfo.price <= parseInt(filterMaxPrice, 10);
  });

  // Action Handlers
  const handleSelectRoom = (roomNumber) => {
    setSelectedRoomNumber(roomNumber);
  };

  const handleExtraGuestChange = (index, field, value) => {
    const updated = [...extraGuests];
    updated[index][field] = value;
    setExtraGuests(updated);
  };

  const simulateFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      setFileError('File size exceeds 5MB limit.');
      return;
    }
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (!validTypes.includes(file.type)) {
      setFileError('Invalid format. Use JPG, PNG or PDF.');
      return;
    }

    setFileError(null);
    setIsUploading(true);

    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setFilePreviewUrl(url);
    } else {
      setFilePreviewUrl(null);
    }

    setTimeout(() => {
      setUploadedFile(file);
      setIdDocumentPath('/uploads/simulated_id_scan.jpg');
      setIdOcrText(`EXTRACTED_OCR_TEXT: ${governmentId || 'UNKNOWN_ID'}\nNAME: ${guestName.toUpperCase()}`);
      setIsUploading(false);
    }, 1800);
  };

  const handleRemoveFile = () => {
    setUploadedFile(null);
    setFilePreviewUrl(null);
    setFileError(null);
    setIdDocumentPath('');
    setIdOcrText('');
    const uploader = document.getElementById('id-doc-uploader');
    if (uploader) uploader.value = '';
  };

  const triggerUploadClick = () => {
    document.getElementById('id-doc-uploader').click();
  };

  const toggleService = (service) => {
    setExtraServices(prev => ({
      ...prev,
      [service]: !prev[service]
    }));
  };

  const handleSelectCategoryCard = (cat) => {
    setSelectedCategory(cat);
    setSelectedRoomNumber(null);
    const available = vacantRooms.filter(r => r.type === cat && roomTypesInfo[cat].maxPax >= parseInt(filterCapacity, 10) && roomTypesInfo[cat].price <= parseInt(filterMaxPrice, 10));
    if (available.length > 0) {
      setSelectedRoomNumber(available[0].number);
    }
  };

  const renderCategoryCard = (type, title, price, imagePath, desc, features, maxPax) => {
    const availableCount = vacantRooms.filter(r => r.type === type).length;
    const isSelected = selectedCategory === type;

    return (
      <div 
        onClick={() => { if (availableCount > 0) handleSelectCategoryCard(type); }}
        className="glass"
        style={{
          borderRadius: '16px',
          overflow: 'hidden',
          cursor: availableCount > 0 ? 'pointer' : 'not-allowed',
          border: isSelected ? '2px solid #38bdf8' : '1px solid rgba(255,255,255,0.06)',
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

  const handleTransitionToPayment = () => {
    setPaymentDeposit(totalStayPrice.toString());
    setPaymentMethod('Cash');
    setWizardStep(5);
  };

  const handleBookSubmit = async (transactionId = null) => {
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
          extraServices,
          paymentMethod,
          transactionId
        })
      });

      const data = await res.json();
      if (!res.ok || (data.success === false)) {
        throw new Error(data.message || data.error || (data.errors && Object.values(data.errors)[0]) || 'Booking failed');
      }

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

  if (wizardStep === 6 && confirmedBooking) {
    return (
      <main style={{ flex: 1, padding: '2rem', maxWidth: '900px', width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px', alignItems: 'center' }}>
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

        <div className="glass" style={{ width: '100%', maxWidth: '520px', borderRadius: '16px', border: '1px solid rgba(74, 222, 128, 0.3)', background: 'linear-gradient(180deg, rgba(16,28,24,0.7) 0%, rgba(13,17,23,0.9) 100%)', overflow: 'hidden', boxShadow: '0 15px 35px rgba(0,0,0,0.4), 0 0 20px rgba(74,222,128,0.05)' }}>
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

          <div style={{ padding: '25px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
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
    );
  }

  if (!(!historyLoading && !activeReservation && !hasCheckedOut)) {
    return null;
  }

  return (
    <main style={{ flex: 1, padding: '2rem', maxWidth: '1400px', width: '100%', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr', gap: '2rem' }}>
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {activeBooking && wizardStep !== 6 ? (
          <div style={{ padding: '30px', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px dashed rgba(255,255,255,0.08)', textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
            <div style={{ fontSize: '3rem', marginBottom: '15px' }}>🧳</div>
            <h4 style={{ color: '#fff', fontSize: '1.1rem', fontWeight: '700', marginBottom: '8px' }}>Active Reservation In Progress</h4>
            <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', maxWidth: '400px', lineHeight: '1.4' }}>
              You have a stay booked in Room <strong>{activeBooking.number}</strong>. You cannot book multiple rooms at the same time on this account. Please settle and check out of your active room before requesting a new booking.
            </p>
          </div>
        ) : (
          <>
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

                <div className="glass" style={{ borderRadius: '12px', padding: '16px', border: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', background: 'rgba(255,255,255,0.01)' }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Capacity (Pax)</label>
                    <select value={filterCapacity} onChange={(e) => { setFilterCapacity(e.target.value); setSelectedRoomNumber(null); }}>
                      <option value="1">1 Adult</option>
                      <option value="2">2 Adults</option>
                      <option value="3">3 Adults</option>
                      <option value="4">4 Adults</option>
                    </select>
                  </div>

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
                          val = val.replace(/[^\d]/g, '');
                          if (val.length > 12) val = val.slice(0, 12);
                        } else if (idType === 'Passport') {
                          val = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
                          if (val.length > 8) val = val.slice(0, 8);
                        } else if (idType === 'Voter ID') {
                          val = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
                          if (val.length > 10) val = val.slice(0, 10);
                        } else if (idType === 'Driving Licence') {
                          val = val.toUpperCase().replace(/[^A-Z0-9\-\s]/g, '');
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

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.2rem' }}>
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

            {wizardStep === 5 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '14px' }}>
                  <h4 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.15rem', fontWeight: '700', color: '#fff' }}>
                    📋 Step 5: Booking Summary &amp; Payment
                  </h4>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '2px' }}>
                    Review your complete booking details before confirming payment.
                  </p>
                </div>

                <div className="glass" style={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(10,15,30,0.5)', overflow: 'hidden' }}>
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

                <PaymentPanel
                  selectedMethod={paymentMethod}
                  onMethodChange={setPaymentMethod}
                  amount={parseInt(paymentDeposit || '0', 10)}
                />

                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  <button type="button" className="btn-secondary" onClick={() => setWizardStep(4)}>← Back</button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={isSubmitting}
                    onClick={async () => {
                      if (paymentMethod !== 'Cash') {
                        setIsSubmitting(true);
                        try {
                          // 1. Get Order ID
                          const res = await fetch(`http://localhost:5000/api/payments/razorpay/order`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                            body: JSON.stringify({ amount: parseInt(paymentDeposit, 10) })
                          });
                          const data = await res.json();
                          if (!res.ok) throw new Error(data.error || 'Failed to create order');

                          // 2. Open Razorpay
                          const options = {
                            key: data.key_id,
                            amount: data.amount,
                            currency: data.currency,
                            name: 'Hotel PMS',
                            description: 'Room Reservation Deposit',
                            order_id: data.order_id,
                            handler: async function (response) {
                              try {
                                // 3. Verify Payment
                                const verifyRes = await fetch(`http://localhost:5000/api/payments/razorpay/verify`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                  body: JSON.stringify({
                                    razorpay_order_id: response.razorpay_order_id,
                                    razorpay_payment_id: response.razorpay_payment_id,
                                    razorpay_signature: response.razorpay_signature
                                  })
                                });
                                const verifyData = await verifyRes.json();
                                if (!verifyRes.ok) throw new Error(verifyData.error || 'Verification failed');
                                
                                // 4. Book Room
                                await handleBookSubmit(verifyData.transaction_id);
                              } catch (err) {
                                showAlert(err.message, 'Payment Verification Failed');
                                setIsSubmitting(false);
                              }
                            },
                            prefill: {
                              name: guestName,
                              email: guestEmail,
                              contact: guestPhone
                            },
                            theme: {
                              color: '#38bdf8'
                            },
                            modal: {
                              ondismiss: function() {
                                setIsSubmitting(false);
                              }
                            }
                          };
                          const rzp = new window.Razorpay(options);
                          rzp.open();
                        } catch (err) {
                          showAlert(err.message, 'Payment Initialization Failed');
                          setIsSubmitting(false);
                        }
                      } else {
                        handleBookSubmit();
                      }
                    }}
                    style={{ background: 'var(--accent-grad)', minWidth: '200px' }}
                  >
                    {isSubmitting
                      ? '⏳ Processing Booking...'
                      : `Confirm Booking & Pay ₹ ${parseInt(paymentDeposit || '0', 10).toLocaleString()} →`}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
