import React, { useState, useEffect } from 'react';

const CountUp = ({ end, duration = 1500, prefix = '' }) => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 4); // easeOutQuart
      setCount(Math.floor(ease * end));
      if (progress < 1) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  }, [end, duration]);
  return <span>{prefix}{count.toLocaleString('en-IN')}</span>;
};

const CheckoutCountdown = ({ checkOutDateStr }) => {
  const [timeLeft, setTimeLeft] = useState('');
  useEffect(() => {
    if (!checkOutDateStr) return;
    const update = () => {
      let coDate = new Date(checkOutDateStr);
      if (coDate.getHours() === 0) coDate.setHours(11, 0, 0, 0);
      const diff = coDate.getTime() - Date.now();
      if (diff <= 0) return setTimeLeft('Checkout passed');
      
      const d = Math.floor(diff / (1000 * 60 * 60 * 24));
      const h = Math.floor((diff / (1000 * 60 * 60)) % 24);
      const m = Math.floor((diff / 1000 / 60) % 60);
      const s = Math.floor((diff / 1000) % 60);
      setTimeLeft(`${d > 0 ? d + 'd ' : ''}${h}h ${m}m ${s}s`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [checkOutDateStr]);
  return <span style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{timeLeft}</span>;
};

export default function GuestActiveStayOverview({
  user,
  activeBooking,
  activeReservation,
  setDashTab,
  handleRequestCheckout,
  isRequestingCheckout,
  fetchStatus,
  liveBill,
  notifications,
  guestHistory
}) {
  const guestName = user?.name || guestHistory?.guest?.name || 'Valued Guest';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';

  const checkIn = new Date(activeReservation?.check_in_date || activeReservation?.expected_check_in_date);
  const checkOut = new Date(activeReservation?.expected_check_out_date);
  const totalNights = Math.max(1, Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24)));
  const daysStayed = Math.max(0, Math.floor((Date.now() - checkIn) / (1000 * 60 * 60 * 24)));
  const progressPct = Math.min(100, Math.max(0, (daysStayed / totalNights) * 100));

  // ── BALANCE (single source of truth — same formula as GuestBilling.jsx) ──────
  const ledger       = liveBill?.ledger || [];
  const subtotal     = ledger.reduce((s, i) => s + Number(i.amount), 0);
  const deposit      = Number(liveBill?.booking?.advance_amount ?? activeReservation?.advance_amount ?? 0);
  const balance      = subtotal - deposit;
  // For the progress bar we still need charges vs paid separately
  const totalCharges = ledger.filter(i => Number(i.amount) > 0).reduce((s, i) => s + Number(i.amount), 0);
  const totalPaid    = Math.max(
    deposit,
    ledger.filter(i => Number(i.amount) < 0).reduce((s, i) => s + Math.abs(Number(i.amount)), 0)
  );
  const paidPct  = totalCharges > 0 ? Math.min(100, (totalPaid / totalCharges) * 100) : 0;
  
  const recentActivities = [];
  if (liveBill?.ledger) {
    const sorted = [...liveBill.ledger]
      .filter(i => {
         const d = i.desc.toLowerCase();
         return !d.includes('rollover') && !d.includes('taxes & gst') && !d.includes('gst');
      })
      .sort((a,b) => new Date(b.created_at || b.business_date) - new Date(a.created_at || a.business_date))
      .slice(0, 5);

    sorted.forEach(i => {
      let icon = '💳';
      if (i.desc.includes('Food')) icon = '🍔';
      else if (i.desc.includes('Service') || i.desc.includes('Maintenance')) icon = '🔧';
      else if (i.desc.includes('Tariff')) icon = '🏨';
      else if (Number(i.amount) < 0) icon = '✅';
      recentActivities.push({ id: i.id, icon, desc: i.desc, time: i.created_at || i.business_date, amount: i.amount });
    });
  }
  
  if (recentActivities.length === 0 && activeReservation?.check_in_date) {
     recentActivities.push({ id: 'ci', icon: '🏨', desc: 'Check-in completed', time: activeReservation.check_in_date, amount: 0 });
  }

  // ── LOYALTY (single source of truth — read from guestHistory.guest, same DB row as the header) ──
  // guestHistory.guest is fetched from /api/guest/history which queries the guests table directly.
  // The header (GuestDashboard.jsx) reads user.loyalty_tier set at login time — it may be stale.
  // We prefer guestHistory.guest here so both the card and header sync via onUserUpdate().
  const loyaltyPoints = guestHistory?.guest?.loyalty_points ?? user?.loyalty_points ?? 0;
  const tierName      = guestHistory?.guest?.loyalty_tier  ?? user?.loyalty_tier  ?? 'Bronze';
  // Next-tier thresholds match the backend (roomController.js:950-953)
  const nextTier = tierName === 'Platinum' ? null
                 : tierName === 'Gold'     ? 3000
                 : tierName === 'Silver'   ? 1500
                 :                           500;  // Bronze
  const loyaltyPct = nextTier ? Math.min(100, (loyaltyPoints / nextTier) * 100) : 100;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px', animation: 'fadeIn 0.4s ease-out' }}>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideInRight { from { opacity: 0; transform: translateX(15px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes breatheBG { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        @keyframes pulseDot { 0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5); } 70% { box-shadow: 0 0 0 10px rgba(34, 197, 94, 0); } 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); } }
        @keyframes floatCrown { 0% { transform: translateY(0px); } 50% { transform: translateY(-4px); } 100% { transform: translateY(0px); } }
        
        .dash-container {
          display: grid;
          grid-template-columns: 1fr;
          gap: 28px;
        }
        @media(min-width: 1100px) {
          .dash-container { grid-template-columns: 2.4fr 1fr; }
        }

        .premium-card {
          background: rgba(15, 23, 42, 0.4);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 20px;
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255,255,255,0.04);
          position: relative;
          overflow: hidden;
        }

        .interactive-card {
          transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 0.3s cubic-bezier(0.2, 0.8, 0.2, 1), border-color 0.3s;
        }
        .interactive-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.08);
          border-color: rgba(255, 255, 255, 0.12);
        }

        .hero-bg {
          background: linear-gradient(135deg, rgba(30, 58, 138, 0.25), rgba(15, 23, 42, 0.9)), 
                      radial-gradient(circle at top right, rgba(56, 189, 248, 0.12), transparent 40%),
                      radial-gradient(circle at bottom left, rgba(20, 184, 166, 0.08), transparent 40%);
          background-size: 200% 200%;
          animation: breatheBG 12s ease-in-out infinite;
        }
        .hero-bg::after {
           content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
           background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
        }

        .text-gradient {
          background: linear-gradient(to right, #f8fafc, #94a3b8);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .timeline-item {
          position: relative;
          padding-left: 32px;
          margin-bottom: 24px;
        }
        .timeline-item::before {
          content: ''; position: absolute; left: 2px; top: 8px; width: 10px; height: 10px;
          background: #38bdf8; border-radius: 50%; box-shadow: 0 0 10px rgba(56,189,248,0.4);
        }
        .timeline-item:not(:last-child)::after {
          content: ''; position: absolute; left: 6px; top: 24px; bottom: -16px; width: 2px;
          background: linear-gradient(to bottom, rgba(56,189,248,0.5), rgba(255,255,255,0.05));
        }

        .action-tile {
          display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start;
          padding: 20px; border-radius: 16px; gap: 8px;
          background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);
          cursor: pointer; transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
          position: relative; overflow: hidden;
        }
        .action-tile::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          background: radial-gradient(circle at top right, var(--hover-color) 0%, transparent 70%);
          opacity: 0; transition: opacity 0.3s;
        }
        .action-tile:hover {
          transform: translateY(-4px) scale(1.02);
          background: rgba(255,255,255,0.04);
          border-color: rgba(255,255,255,0.1);
          box-shadow: 0 12px 24px rgba(0,0,0,0.25);
        }
        .action-tile:hover::before { opacity: 0.1; }
        .action-tile:active { transform: translateY(0) scale(0.98); }
        .action-tile > * { position: relative; z-index: 1; }

        .btn-ripple {
          position: relative; overflow: hidden; transition: transform 0.2s, box-shadow 0.2s;
        }
        .btn-ripple:active { transform: scale(0.96); }

        .progress-track { background: rgba(255,255,255,0.05); height: 8px; border-radius: 4px; overflow: hidden; box-shadow: inset 0 1px 3px rgba(0,0,0,0.2); }
        .progress-fill { height: 100%; border-radius: 4px; transition: width 1s cubic-bezier(0.4, 0, 0.2, 1); }
      `}</style>

      <div className="dash-container">
        
        {/* ── MAIN COLUMN (LEFT) ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
          
          {/* HERO WIDGET */}
          <div className="premium-card hero-bg" style={{ padding: '48px 40px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
              <div>
                <h1 className="text-gradient" style={{ fontSize: '3.2rem', fontWeight: '800', margin: '0 0 8px 0', letterSpacing: '-1.5px', lineHeight: 1.1 }}>
                  <span style={{ fontWeight: 300, fontSize: '2.2rem' }}>{greeting},</span><br/>
                  {guestName}
                </h1>
                <p style={{ color: '#94a3b8', fontSize: '1.15rem', margin: '0 0 32px 0', maxWidth: '500px', lineHeight: '1.6' }}>
                  Welcome to your exclusive stay in <strong>Room {activeBooking?.number}</strong> ({activeBooking?.type}).
                </p>
              </div>
              <div style={{ background: 'rgba(15, 23, 42, 0.6)', border: '1px solid rgba(255,255,255,0.1)', padding: '8px 16px', borderRadius: '30px', display: 'flex', alignItems: 'center', gap: '10px', backdropFilter: 'blur(10px)', boxShadow: '0 4px 12px rgba(0,0,0,0.2)' }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', animation: 'pulseDot 2s infinite' }}></div>
                <span style={{ color: '#f8fafc', fontWeight: '700', fontSize: '0.85rem', letterSpacing: '1px', textTransform: 'uppercase' }}>Checked In</span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '24px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '28px' }}>
              <div>
                <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1.5px', margin: '0 0 6px 0', fontWeight: '600' }}>Check-in</p>
                <p style={{ fontSize: '1.2rem', fontWeight: '700', color: '#e2e8f0', margin: 0 }}>
                  {activeReservation?.check_in_date ? new Date(activeReservation.check_in_date).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}) : '—'}
                </p>
              </div>
              <div>
                <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1.5px', margin: '0 0 6px 0', fontWeight: '600' }}>Check-out</p>
                <p style={{ fontSize: '1.2rem', fontWeight: '700', color: '#e2e8f0', margin: 0 }}>
                  {activeReservation?.expected_check_out_date ? new Date(activeReservation.expected_check_out_date).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}) : '—'}
                </p>
              </div>
              <div>
                <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1.5px', margin: '0 0 6px 0', fontWeight: '600' }}>Stay Duration</p>
                <p style={{ fontSize: '1.2rem', fontWeight: '700', color: '#e2e8f0', margin: 0 }}>
                  {totalNights} Night(s)
                </p>
              </div>
            </div>
          </div>

          {/* STAY PROGRESS & COUNTDOWN */}
          <div className="premium-card interactive-card" style={{ padding: '32px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px', alignItems: 'flex-end', flexWrap: 'wrap', gap: '10px' }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: '1.2rem', color: '#f8fafc', fontWeight: '700' }}>Stay Progress</h3>
                <span style={{ color: '#94a3b8', fontSize: '0.9rem', fontWeight: '500' }}>Day {daysStayed} of {totalNights}</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', margin: '0 0 4px', fontWeight: '600' }}>Est. Checkout In</p>
                <p style={{ fontSize: '1.1rem', fontWeight: '700', color: '#38bdf8', margin: 0 }}>
                  <CheckoutCountdown checkOutDateStr={activeReservation?.expected_check_out_date} />
                </p>
              </div>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg, #0ea5e9, #38bdf8)', boxShadow: '0 0 10px rgba(56,189,248,0.5)' }}></div>
            </div>
          </div>

          {/* RECENT ACTIVITY TIMELINE */}
          <div className="premium-card interactive-card" style={{ padding: '36px' }}>
            <h3 style={{ margin: '0 0 28px 0', fontSize: '1.2rem', color: '#f8fafc', fontWeight: '700', letterSpacing: '0.5px' }}>Timeline Activity</h3>
            {recentActivities.length > 0 ? (
              <div style={{ marginLeft: '8px' }}>
                {recentActivities.map((act, i) => (
                  <div key={i} className="timeline-item">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <p style={{ margin: 0, fontSize: '1.05rem', fontWeight: '600', color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span>{act.icon}</span> {act.desc}
                        </p>
                        <p style={{ margin: '4px 0 0', fontSize: '0.85rem', color: '#64748b' }}>
                          {new Date(act.time).toLocaleString('en-GB', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'})}
                        </p>
                      </div>
                      {act.amount !== 0 && (
                        <div style={{ fontWeight: '700', color: Number(act.amount) < 0 ? '#22c55e' : '#f8fafc', fontSize: '1rem', background: 'rgba(255,255,255,0.03)', padding: '6px 14px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                          {Number(act.amount) < 0 ? '-' : ''}₹{Math.abs(Number(act.amount)).toLocaleString('en-IN')}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
               <p style={{ color: '#64748b', fontSize: '0.95rem' }}>Your stay timeline is ready.</p>
            )}
          </div>
          
          {/* ── NEW: YOUR STAY SUMMARY ── */}
          <div className="premium-card interactive-card" style={{ padding: '36px' }}>
            <h3 style={{ margin: '0 0 24px 0', fontSize: '1.2rem', color: '#f8fafc', fontWeight: '700', letterSpacing: '0.5px' }}>Your Stay Summary</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <p style={{ margin: '0 0 4px', fontSize: '0.8rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '600' }}>Guests</p>
                <p style={{ margin: 0, fontSize: '1.1rem', color: '#e2e8f0', fontWeight: '600' }}>
                  {activeReservation?.adults || 1} Adult(s) {activeReservation?.children ? `, ${activeReservation.children} Child(ren)` : ''}
                </p>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <p style={{ margin: '0 0 4px', fontSize: '0.8rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '600' }}>Booking No.</p>
                <p style={{ margin: 0, fontSize: '1.1rem', color: '#e2e8f0', fontWeight: '600' }}>{activeReservation?.booking_number || 'N/A'}</p>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', gridColumn: '1 / -1' }}>
                <p style={{ margin: '0 0 4px', fontSize: '0.8rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '600' }}>Special Requests</p>
                <p style={{ margin: 0, fontSize: '1rem', color: '#e2e8f0', lineHeight: '1.5' }}>
                  {activeReservation?.special_requests || 'No special requests recorded for this stay.'}
                </p>
              </div>
            </div>
          </div>

          {/* ── NEW: HOTEL FACILITIES & GUEST BENEFITS ── */}
          <div className="premium-card interactive-card" style={{ padding: '36px' }}>
            <h3 style={{ margin: '0 0 24px 0', fontSize: '1.2rem', color: '#f8fafc', fontWeight: '700', letterSpacing: '0.5px' }}>Guest Benefits</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
              {[
                { icon: '📶', title: 'High-Speed Wi-Fi', desc: 'Complimentary access' },
                { icon: '🍳', title: 'Gourmet Breakfast', desc: 'Served 7:00 AM - 10:30 AM' },
                { icon: '🏊', title: 'Wellness Spa', desc: 'Pool & Spa access' },
                { icon: '🚗', title: 'Valet Parking', desc: '24/7 complimentary' }
              ].map((fac, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '16px', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.2s' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'} onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}>
                  <div style={{ fontSize: '1.8rem', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.3))' }}>{fac.icon}</div>
                  <div>
                    <p style={{ margin: '0 0 2px', fontWeight: '700', fontSize: '0.95rem', color: '#e2e8f0' }}>{fac.title}</p>
                    <p style={{ margin: 0, fontSize: '0.75rem', color: '#94a3b8' }}>{fac.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* NOTIFICATION PREVIEW */}
          {notifications && notifications.length > 0 && (
            <div className="premium-card interactive-card" style={{ padding: '32px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ margin: 0, fontSize: '1.2rem', color: '#f8fafc', fontWeight: '700' }}>Recent Notifications</h3>
                <button onClick={() => setDashTab('notifications')} style={{ background: 'none', border: 'none', color: '#38bdf8', fontSize: '0.9rem', fontWeight: '600', cursor: 'pointer' }}>View All →</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {notifications.slice(0, 3).map((notif, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: '16px', background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.2s' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'} onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#38bdf8', marginTop: 6, boxShadow: '0 0 8px rgba(56,189,248,0.6)' }}></div>
                    <div>
                      <p style={{ margin: '0 0 6px', fontWeight: '600', fontSize: '0.95rem', color: '#e2e8f0' }}>{notif.title}</p>
                      <p style={{ margin: 0, fontSize: '0.85rem', color: '#94a3b8', lineHeight: '1.4' }}>{notif.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* ── SIDEBAR COLUMN (RIGHT) ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '28px', animation: 'slideInRight 0.5s ease-out 0.1s both' }}>
          
          {/* CURRENT BALANCE */}
          <div className="premium-card interactive-card" style={{ padding: '36px', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '1rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1.5px', fontWeight: '600' }}>Outstanding Balance</h3>
            <div style={{ fontSize: '3.4rem', fontWeight: '800', color: '#f8fafc', letterSpacing: '-2px', lineHeight: '1', marginBottom: '24px' }}>
              <CountUp end={balance} prefix="₹" />
            </div>
            
            {/* Paid vs Remaining Mini Indicator */}
            <div style={{ marginBottom: '24px' }}>
               <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#64748b', marginBottom: '8px', fontWeight: '600' }}>
                 <span>Paid: ₹{totalPaid.toLocaleString('en-IN')}</span>
                 <span>Total: ₹{totalCharges.toLocaleString('en-IN')}</span>
               </div>
               <div className="progress-track" style={{ height: '6px' }}>
                 <div className="progress-fill" style={{ width: `${paidPct}%`, background: '#22c55e' }}></div>
               </div>
            </div>

            <button className="btn-ripple" onClick={() => setDashTab('bill')} style={{ width: '100%', background: 'linear-gradient(90deg, #f8fafc, #e2e8f0)', border: 'none', padding: '16px', borderRadius: '12px', color: '#0f172a', fontWeight: '700', fontSize: '1rem', cursor: 'pointer', boxShadow: '0 4px 12px rgba(255,255,255,0.15)' }}>
              View Detailed Bill
            </button>
          </div>

          {/* QUICK ACTIONS */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            {[
              { id: 'service', icon: '🛎️', label: 'Room Service', desc: 'Towels, etc.', color: 'rgba(129, 140, 248, 0.4)' },
              { id: 'food', icon: '🍽️', label: 'In-Room Dining', desc: 'Order meals', color: 'rgba(251, 146, 60, 0.4)' },
              { id: 'maintenance', icon: '🔧', label: 'Support', desc: 'Report issue', color: 'rgba(250, 204, 21, 0.4)' },
              { id: 'extend', icon: '📅', label: 'Extend Stay', desc: 'Modify dates', color: 'rgba(56, 189, 248, 0.4)' },
            ].map(action => (
              <div key={action.id} className="action-tile" style={{ '--hover-color': action.color }} onClick={() => setDashTab(action.id)}>
                <div style={{ fontSize: '2.2rem', marginBottom: '4px', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.2))' }}>{action.icon}</div>
                <div>
                  <div style={{ fontWeight: '700', fontSize: '0.9rem', color: '#f8fafc', marginBottom: '2px' }}>{action.label}</div>
                  <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{action.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* LOYALTY CARD */}
          <div className="premium-card interactive-card" style={{ padding: '32px', background: 'linear-gradient(135deg, rgba(217,119,6,0.15) 0%, rgba(251,191,36,0.05) 100%)', border: '1px solid rgba(251,191,36,0.25)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
              <div>
                <span style={{ fontSize: '0.75rem', color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '600' }}>Membership Status</span>
                <h3 style={{ margin: '4px 0 0', fontSize: '1.4rem', color: '#fbbf24', fontWeight: '800' }}>{tierName}</h3>
              </div>
              <div style={{ fontSize: '2.5rem', filter: 'drop-shadow(0 0 12px rgba(251,191,36,0.5))', animation: 'floatCrown 4s ease-in-out infinite' }}>👑</div>
            </div>
            <div style={{ fontSize: '2.2rem', fontWeight: '800', color: '#f8fafc', marginBottom: '16px' }}>
              <CountUp end={loyaltyPoints} /> <span style={{ fontSize: '1rem', fontWeight: '600', color: '#94a3b8' }}>PTS</span>
            </div>
            <div className="progress-track" style={{ background: 'rgba(251,191,36,0.15)' }}>
              <div className="progress-fill" style={{ width: `${loyaltyPct}%`, background: 'linear-gradient(90deg, #f59e0b, #fbbf24)', boxShadow: '0 0 8px rgba(251,191,36,0.5)' }}></div>
            </div>
            <p style={{ margin: '12px 0 0', fontSize: '0.8rem', color: '#cbd5e1' }}>
              Earn <CountUp end={nextTier - loyaltyPoints} /> more points for {tierName === 'Silver' ? 'Gold' : 'Platinum'}
            </p>
          </div>

          {/* SUPPORT DIRECTORY */}
          <div className="premium-card interactive-card" style={{ padding: '32px' }}>
            <h3 style={{ margin: '0 0 20px 0', fontSize: '1.1rem', color: '#f8fafc', fontWeight: '700' }}>Hotel Directory</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {[
                { label: 'Front Desk', num: 'Dial 9', icon: '🛎️' },
                { label: 'Housekeeping', num: 'Dial 8', icon: '🧹' },
                { label: 'Emergency', num: 'Dial 0', icon: '🚨' }
              ].map(h => (
                <div key={h.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '14px 16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.2s' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'} onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '1.2rem' }}>{h.icon}</span>
                    <span style={{ fontSize: '0.95rem', fontWeight: '600', color: '#e2e8f0' }}>{h.label}</span>
                  </div>
                  <span style={{ fontSize: '0.85rem', color: '#94a3b8', fontWeight: '600' }}>{h.num}</span>
                </div>
              ))}
            </div>
          </div>

          {/* CHECKOUT WIDGET */}
          <div className="premium-card interactive-card" style={{ padding: '32px', border: '1px solid rgba(239,68,68,0.3)', background: 'linear-gradient(135deg, rgba(239,68,68,0.08) 0%, rgba(15, 23, 42, 0.4) 100%)' }}>
            <h3 style={{ color: '#f8fafc', fontWeight: '700', margin: '0 0 12px 0', fontSize: '1.15rem' }}>
              🚪 Ready for Checkout?
            </h3>
            <p style={{ color: '#94a3b8', fontSize: '0.9rem', marginBottom: '20px', lineHeight: '1.5' }}>
              Notify the front desk instantly and we'll prepare your final bill for a seamless departure.
            </p>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                className="btn-ripple"
                onClick={handleRequestCheckout}
                disabled={isRequestingCheckout}
                style={{ 
                  flex: 1, background: isRequestingCheckout ? 'rgba(255,255,255,0.05)' : 'linear-gradient(90deg, #ef4444, #dc2626)', 
                  border: 'none', borderRadius: '12px', padding: '14px', 
                  color: '#fff', fontWeight: '700', fontSize: '0.95rem', 
                  cursor: isRequestingCheckout ? 'not-allowed' : 'pointer',
                  boxShadow: isRequestingCheckout ? 'none' : '0 6px 20px rgba(239,68,68,0.4)'
                }}
              >
                {isRequestingCheckout ? '⏳ Sending...' : 'Request Checkout'}
              </button>
              <button
                className="btn-ripple"
                onClick={() => fetchStatus()}
                style={{ 
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', 
                  borderRadius: '12px', padding: '14px', 
                  color: '#e2e8f0', cursor: 'pointer'
                }}
                title="Refresh Status"
              >
                🔄
              </button>
            </div>
          </div>

        </div>
      </div>
      
    </div>
  );
}
