import React, { useState, useEffect, useContext, useRef, useMemo, useCallback } from 'react';
import { API_URL, getApiHeaders } from '../config/apiConfig';

import { 
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, 
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer 
} from 'recharts';
import { AdminAuthContext } from '../contexts/AdminAuthContext';
import { exportToPDF, exportToExcel, exportToCSV, formatCurrency } from '../utils/exportUtils';
import { formatDateOnly, parseDateString, calculatePresetDateRange } from '../utils/reportDateUtils';

export { formatDateOnly, parseDateString, calculatePresetDateRange };

const COLORS = ['#38bdf8', '#818cf8', '#34d399', '#fbbf24', '#f87171', '#c084fc'];

const SkeletonChart = () => (
  <div style={{ height: '300px', width: '100%', background: 'rgba(255,255,255,0.05)', borderRadius: '12px', animation: 'pulse 1.5s infinite', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <style>{'@keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 0.3; } 100% { opacity: 0.6; } }'}</style>
    <div style={{ color: '#64748b' }}>Loading data...</div>
  </div>
);

export default function AnalyticsModal({ isOpen, onClose }) {
  const { adminToken } = useContext(AdminAuthContext);
  
  const [activeTab, setActiveTab] = useState('dashboard');
  const [dateRange, setDateRange] = useState('This Month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  
  // Hotel Business Date state
  const [hotelBusinessDate, setHotelBusinessDate] = useState(null);
  const [businessDateLoading, setBusinessDateLoading] = useState(false);
  const [businessDateError, setBusinessDateError] = useState(null);

  const [loading, setLoading] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const hasAnimated = useRef({});

  const tabsRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  useEffect(() => {
    if (tabsRef.current) {
      const activeTabEl = tabsRef.current.querySelector('[data-active="true"]');
      if (activeTabEl) {
        activeTabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
  }, [activeTab]);

  const handleMouseDown = (e) => {
    if (!tabsRef.current) return;
    setIsDragging(true);
    setStartX(e.pageX - tabsRef.current.offsetLeft);
    setScrollLeft(tabsRef.current.scrollLeft);
  };
  const handleMouseLeave = () => setIsDragging(false);
  const handleMouseUp = () => setIsDragging(false);
  const handleMouseMove = (e) => {
    if (!isDragging || !tabsRef.current) return;
    e.preventDefault();
    const x = e.pageX - tabsRef.current.offsetLeft;
    const walk = (x - startX) * 2;
    tabsRef.current.scrollLeft = scrollLeft - walk;
  };

  const dataCache = useRef({});
  const lastParams = useRef('');
  
  // Data States
  const [dashboardData, setDashboardData] = useState(null);
  const [revenueData, setRevenueData] = useState(null);
  const [occupancyData, setOccupancyData] = useState(null);
  const [guestData, setGuestData] = useState(null);
  const [bookingData, setBookingData] = useState(null);
  const [cancellationData, setCancellationData] = useState(null);
  const [profitData, setProfitData] = useState(null);
  const [adrData, setAdrData] = useState(null);
  const [revparData, setRevparData] = useState(null);
  const [roomTypeData, setRoomTypeData] = useState(null);
  const [paymentsData, setPaymentsData] = useState(null);

  // Fetch Business Date from Settings API when modal opens
  const fetchBusinessDate = useCallback(() => {
    if (!adminToken) return;
    setBusinessDateLoading(true);
    setBusinessDateError(null);

    fetch(`${API_URL}/settings/business-date`, {
      headers: getApiHeaders(adminToken)
    })
      .then(res => {
        if (!res.ok) throw new Error(`Failed to load hotel business date (HTTP ${res.status})`);
        return res.json();
      })
      .then(data => {
        if (data && data.businessDate) {
          setHotelBusinessDate(data.businessDate);
        } else {
          throw new Error('Invalid business date payload');
        }
      })
      .catch(err => {
        console.error('Error fetching hotel business date:', err);
        setBusinessDateError(err.message || 'Failed to fetch business date');
      })
      .finally(() => {
        setBusinessDateLoading(false);
      });
  }, [adminToken]);

  useEffect(() => {
    if (isOpen) {
      fetchBusinessDate();
    }
  }, [isOpen, fetchBusinessDate]);
  
  // Clear cache when date selection changes
  useEffect(() => {
    hasAnimated.current = {};
    dataCache.current = {};
  }, [dateRange, customStart, customEnd, hotelBusinessDate]);

  const getDateParams = useCallback(() => {
    if (dateRange === 'Custom Date Range') {
      if (!customStart || !customEnd) return '';
      return `startDate=${formatDateOnly(customStart)}&endDate=${formatDateOnly(customEnd)}`;
    }

    if (!hotelBusinessDate) {
      return '';
    }

    const range = calculatePresetDateRange(dateRange, hotelBusinessDate, customStart, customEnd);
    if (!range || !range.startStr || !range.endStr) return '';
    return `startDate=${range.startStr}&endDate=${range.endStr}`;
  }, [dateRange, hotelBusinessDate, customStart, customEnd]);

  const fetchData = useCallback(async () => {
    if (!adminToken) return;
    if (!hotelBusinessDate && dateRange !== 'Custom Date Range') return;

    const params = getDateParams();
    if (!params) return;
    
    if (lastParams.current !== params) {
      dataCache.current = {};
      lastParams.current = params;
    }

    const cacheKey = activeTab + params;
    if (dataCache.current[cacheKey]) {
      return; 
    }

    setLoading(true);
    try {
      let endpoint = '';
      if (activeTab === 'dashboard') endpoint = 'dashboard';
      else if (activeTab === 'revenue') endpoint = 'revenue';
      else if (activeTab === 'occupancy') endpoint = 'occupancy';
      else if (activeTab === 'guests') endpoint = 'guests';
      else if (activeTab === 'bookings') endpoint = 'bookings';
      else if (activeTab === 'cancellations') endpoint = 'cancellations';
      else if (activeTab === 'profit') endpoint = 'profit';
      else if (activeTab === 'adr') endpoint = 'adr';
      else if (activeTab === 'revpar') endpoint = 'revpar';
      else if (activeTab === 'room_types') endpoint = 'room-types';
      else if (activeTab === 'payments') endpoint = 'payments';

      if (endpoint) {
        const res = await fetch(`${API_URL}/reports/${endpoint}?${params}`, {
          headers: getApiHeaders(adminToken)
        });
        const data = await res.json();

        dataCache.current[cacheKey] = data;

        if (activeTab === 'dashboard') setDashboardData(data);
        else if (activeTab === 'revenue') setRevenueData(data);
        else if (activeTab === 'occupancy') setOccupancyData(data);
        else if (activeTab === 'guests') setGuestData(data);
        else if (activeTab === 'bookings') setBookingData(data);
        else if (activeTab === 'cancellations') setCancellationData(data);
        else if (activeTab === 'profit') setProfitData(data);
        else if (activeTab === 'adr') setAdrData(data);
        else if (activeTab === 'revpar') setRevparData(data);
        else if (activeTab === 'room_types') setRoomTypeData(data);
        else if (activeTab === 'payments') setPaymentsData(data);
        
        setTimeout(() => { hasAnimated.current[activeTab] = true; }, 500);
      }
    } catch (e) {
      console.error("Error fetching reports", e);
    } finally {
      setLoading(false);
    }
  }, [adminToken, hotelBusinessDate, dateRange, getDateParams, activeTab]);

  useEffect(() => { 
    if (isOpen && (hotelBusinessDate || dateRange === 'Custom Date Range')) {
      fetchData(); 
    }
  }, [isOpen, activeTab, dateRange, customStart, customEnd, hotelBusinessDate, fetchData]);

  const handleExport = async (format) => {
    let title = '';
    let headers = [];
    let rows = [];

    const getFilterText = () => {
      if (dateRange === 'Custom Date Range') return `${customStart} to ${customEnd}`;
      return `${dateRange} (Business Date: ${hotelBusinessDate || 'N/A'})`;
    };
    const filters = getFilterText();

    switch (activeTab) {
      case 'dashboard':
        if (!dashboardData) return;
        title = 'Dashboard Overview';
        headers = ['Metric', 'Value'];
        rows = [
          ['Total Revenue', formatCurrency(dashboardData.totalRevenue)],
          ['Total Bookings', dashboardData.totalBookings],
          ['Occupancy Rate', `${dashboardData.occupancyRate}%`],
          ['ADR', formatCurrency(dashboardData.adr)],
          ['RevPAR', formatCurrency(dashboardData.revPAR)]
        ];
        break;
      case 'revenue':
        if (!revenueData) return;
        title = 'Revenue Report';
        headers = ['Date', 'Revenue'];
        rows = revenueData.chartData.map(d => [d.date, formatCurrency(d.revenue)]);
        rows.push(['', '']);
        rows.push(['Payment Type', 'Total']);
        Object.keys(revenueData.breakdown).forEach(key => {
          rows.push([key, formatCurrency(revenueData.breakdown[key])]);
        });
        break;
      case 'occupancy':
        if (!occupancyData) return;
        title = 'Occupancy Report';
        headers = ['Status', 'Count'];
        rows = Object.keys(occupancyData.bookingStatus).map(k => [k, occupancyData.bookingStatus[k]]);
        break;
      case 'guests':
        if (!guestData) return;
        title = 'Guest Analytics';
        headers = ['Loyalty Tier', 'Count'];
        rows = guestData.loyaltyStats.map(d => [d.name, d.value]);
        rows.push(['', '']);
        rows.push(['Gender', 'Count']);
        guestData.genderStats.forEach(d => rows.push([d.name, d.value]));
        break;
      case 'bookings':
        if (!bookingData) return;
        title = 'Booking Analytics';
        headers = ['Date', 'Bookings'];
        rows = bookingData.chartData.map(d => [d.date, d.bookings]);
        break;
      case 'cancellations':
        if (!cancellationData) return;
        title = 'Cancellation Report';
        headers = ['Booking Number', 'Guest ID', 'Amount', 'Date'];
        rows = cancellationData.cancellations.map(c => [c.booking_number || c.id, c.guest_id || 'N/A', formatCurrency(c.total_amount), c.created_at ? c.created_at.split('T')[0] : 'N/A']);
        break;
      case 'profit':
        if (!profitData) return;
        title = 'Profit Report';
        headers = ['Metric', 'Amount'];
        rows = [
          ['Total Revenue', formatCurrency(profitData.totalRevenue)],
          ['Estimated Operating Costs (30%)', formatCurrency(profitData.estimatedCosts)],
          ['Estimated Net Profit', formatCurrency(profitData.estimatedProfit)]
        ];
        break;
      case 'adr':
        if (!adrData) return;
        title = 'ADR Report';
        headers = ['Date', 'ADR'];
        rows = adrData.chartData.map(d => [d.date, formatCurrency(d.adr)]);
        break;
      case 'revpar':
        if (!revparData) return;
        title = 'RevPAR Report';
        headers = ['Date', 'RevPAR'];
        rows = revparData.chartData.map(d => [d.date, formatCurrency(d.revPAR)]);
        break;
      case 'room_types':
        if (!roomTypeData) return;
        title = 'Room Type Performance';
        headers = ['Room Type', 'Total Rooms', 'Occupied Nights', 'Occupancy Rate'];
        rows = roomTypeData.roomTypeStats.map(s => [s.name, s.total, s.occupied, `${s.occupancyRate}%`]);
        break;
      case 'payments':
        if (!paymentsData) return;
        title = 'Payments Report';
        headers = ['Payment Method', 'Amount'];
        rows = paymentsData.breakdown.map(b => [b.name, formatCurrency(b.value)]);
        break;
      default:
        return;
    }

    if (format === 'pdf') await exportToPDF(title, headers, rows, filters);
    else if (format === 'excel') exportToExcel(title, headers, rows, filters);
    else if (format === 'csv') exportToCSV(title, headers, rows, filters);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" style={{ zIndex: 1000 }}>
      <div className="modal-content" style={{ maxWidth: '1100px', width: '95%', height: '90vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-dark)' }}>
        
        {/* Header */}
        <div className="modal-header" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
            <h3 style={{ fontSize: '1.5rem', color: '#fff', margin: 0 }}>📈 Reports & Analytics</h3>
            {hotelBusinessDate && (
              <span style={{ fontSize: '0.75rem', padding: '3px 8px', borderRadius: '12px', background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.3)' }}>
                Business Date: {hotelBusinessDate}
              </span>
            )}
          </div>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>

        {/* Filters and Export Row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '15px 20px', background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid rgba(255,255,255,0.05)', alignItems: 'center', flexWrap: 'wrap', gap: '15px' }}>
          
          {/* Left Side: Date Filters */}
          <div style={{ display: 'flex', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
            <select 
              value={dateRange} 
              onChange={(e) => setDateRange(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: '6px', background: '#1e293b', color: '#fff', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <option>Today</option>
              <option>Yesterday</option>
              <option>This Week</option>
              <option>This Month</option>
              <option>This Year</option>
              <option>Custom Date Range</option>
            </select>

            {dateRange === 'Custom Date Range' && (
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={{ padding: '6px', borderRadius: '4px', background: '#1e293b', color: '#fff', border: '1px solid #334155' }} />
                <span style={{ color: '#94a3b8' }}>to</span>
                <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} style={{ padding: '6px', borderRadius: '4px', background: '#1e293b', color: '#fff', border: '1px solid #334155' }} />
              </div>
            )}
          </div>

          {/* Right Side: Export Button */}
          <div style={{ position: 'relative' }}>
            <button 
              onClick={() => setShowExportMenu(!showExportMenu)}
              style={{ padding: '8px 16px', borderRadius: '6px', background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}
            >
              Export ▼
            </button>
            {showExportMenu && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: '8px', background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', padding: '5px 0', zIndex: 50, minWidth: '100px', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)' }}>
                <button onClick={() => { handleExport('pdf'); setShowExportMenu(false); }} style={{ display: 'block', width: '100%', padding: '8px 20px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer' }}>PDF</button>
                <button onClick={() => { handleExport('excel'); setShowExportMenu(false); }} style={{ display: 'block', width: '100%', padding: '8px 20px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer' }}>Excel</button>
                <button onClick={() => { handleExport('csv'); setShowExportMenu(false); }} style={{ display: 'block', width: '100%', padding: '8px 20px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer' }}>CSV</button>
              </div>
            )}
          </div>
        </div>

        {/* Tabs Row */}
        <div style={{ padding: '10px 20px', background: 'rgba(0,0,0,0.1)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div 
            ref={tabsRef}
            onMouseDown={handleMouseDown}
            onMouseLeave={handleMouseLeave}
            onMouseUp={handleMouseUp}
            onMouseMove={handleMouseMove}
            style={{
              display: 'flex',
              gap: '10px',
              overflowX: 'auto',
              paddingBottom: '4px',
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(255,255,255,0.2) transparent',
              cursor: isDragging ? 'grabbing' : 'grab'
            }}
            className="hide-scrollbar"
          >
            <style>{'.hide-scrollbar::-webkit-scrollbar { height: 4px; } .hide-scrollbar::-webkit-scrollbar-track { background: transparent; } .hide-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; } .hide-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.4); }'}</style>
            {['dashboard', 'revenue', 'occupancy', 'adr', 'revpar', 'room_types', 'payments', 'guests', 'bookings', 'cancellations', 'profit'].map(tab => (
              <button 
                key={tab}
                onClick={() => setActiveTab(tab)}
                data-active={activeTab === tab}
                style={{ 
                  padding: '8px 16px', 
                  borderRadius: '20px', 
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: '600',
                  textTransform: 'capitalize',
                  whiteSpace: 'nowrap',
                  background: activeTab === tab ? 'linear-gradient(135deg, #38bdf8 0%, #818cf8 100%)' : 'rgba(255,255,255,0.05)',
                  color: activeTab === tab ? '#fff' : '#94a3b8',
                  transition: 'all 0.2s'
                }}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {businessDateError ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#f87171', background: 'rgba(248, 113, 113, 0.05)', borderRadius: '12px', border: '1px solid rgba(248, 113, 113, 0.2)' }}>
              <div style={{ fontSize: '2rem', marginBottom: '10px' }}>⚠️</div>
              <h4 style={{ margin: '0 0 8px 0', color: '#fca5a5' }}>Hotel Business Date Synchronization Failed</h4>
              <p style={{ color: '#94a3b8', fontSize: '0.9rem', maxWidth: '400px', margin: '0 auto 15px auto' }}>
                {businessDateError}
              </p>
              <button
                onClick={fetchBusinessDate}
                style={{ padding: '8px 16px', borderRadius: '6px', background: '#38bdf8', color: '#0f172a', border: 'none', fontWeight: 'bold', cursor: 'pointer' }}
              >
                Retry Connection
              </button>
            </div>
          ) : (businessDateLoading && !hotelBusinessDate && dateRange !== 'Custom Date Range') || loading ? (
            <SkeletonChart />
          ) : (
            <>
              {/* DASHBOARD TAB */}
              {activeTab === 'dashboard' && dashboardData && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
                  <KpiCard title="Total Revenue" value={`₹ ${dashboardData.totalRevenue.toLocaleString('en-IN')}`} icon="💰" />
                  <KpiCard title="Total Bookings" value={dashboardData.totalBookings} icon="📅" />
                  <KpiCard title="Occupancy Rate" value={`${dashboardData.occupancyRate}%`} icon="🏨" />
                  <KpiCard title="ADR" value={`₹ ${dashboardData.adr.toLocaleString('en-IN')}`} subtitle="Avg Daily Rate" icon="📊" />
                  <KpiCard title="RevPAR" value={`₹ ${dashboardData.revPAR.toLocaleString('en-IN')}`} subtitle="Rev per Avail Room" icon="📈" />
                </div>
              )}

              {/* REVENUE TAB */}
              {activeTab === 'revenue' && revenueData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Revenue Trend</h4>
                  <div style={{ height: '350px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={revenueData.chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis dataKey="date" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                        <Bar animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} dataKey="revenue" fill="#38bdf8" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                      <h4 style={{ color: '#fff', marginTop: 0 }}>Revenue by Payment Type</h4>
                      <div style={{ height: '250px' }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} 
                              data={Object.keys(revenueData.breakdown).map(k => ({ name: k, value: revenueData.breakdown[k] }))} 
                              cx="50%" cy="50%" innerRadius={60} outerRadius={80} fill="#8884d8" paddingAngle={5} dataKey="value"
                            >
                              {Object.keys(revenueData.breakdown).map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                              ))}
                            </Pie>
                            <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                            <Legend />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* OCCUPANCY TAB */}
              {activeTab === 'occupancy' && occupancyData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Occupancy by Room Type</h4>
                  <div style={{ height: '350px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={occupancyData.roomTypeStats}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis dataKey="name" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                        <Bar animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} dataKey="total" fill="#818cf8" name="Total Rooms" />
                        <Bar animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} dataKey="occupied" fill="#34d399" name="Occupied Nights" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* ADR TAB */}
              {activeTab === 'adr' && adrData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Average Daily Rate (ADR) Trend</h4>
                  <div style={{ height: '350px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={adrData.chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis dataKey="date" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                        <Line animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} type="monotone" dataKey="adr" stroke="#fbbf24" strokeWidth={3} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* RevPAR TAB */}
              {activeTab === 'revpar' && revparData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Revenue Per Available Room (RevPAR) Trend</h4>
                  <div style={{ height: '350px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={revparData.chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis dataKey="date" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                        <Line animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} type="monotone" dataKey="revPAR" stroke="#f87171" strokeWidth={3} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* ROOM TYPES TAB */}
              {activeTab === 'room_types' && roomTypeData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Room Types Performance</h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', color: '#fff', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8' }}>
                          <th style={{ padding: '12px' }}>Room Type</th>
                          <th style={{ padding: '12px' }}>Total Rooms</th>
                          <th style={{ padding: '12px' }}>Occupied Nights</th>
                          <th style={{ padding: '12px' }}>Occupancy Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roomTypeData.roomTypeStats.map((stat, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                            <td style={{ padding: '12px', fontWeight: 'bold' }}>{stat.name}</td>
                            <td style={{ padding: '12px' }}>{stat.total}</td>
                            <td style={{ padding: '12px' }}>{stat.occupied}</td>
                            <td style={{ padding: '12px' }}>
                              <span style={{ padding: '4px 8px', borderRadius: '4px', background: stat.occupancyRate > 70 ? 'rgba(52, 211, 153, 0.2)' : 'rgba(251, 191, 36, 0.2)', color: stat.occupancyRate > 70 ? '#34d399' : '#fbbf24' }}>
                                {stat.occupancyRate}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* PAYMENTS TAB */}
              {activeTab === 'payments' && paymentsData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Payments Breakdown</h4>
                  <div style={{ height: '350px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={paymentsData.breakdown}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis dataKey="name" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                        <Bar animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} dataKey="value" fill="#c084fc" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* GUESTS TAB */}
              {activeTab === 'guests' && guestData && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <h4 style={{ color: '#fff', marginTop: 0 }}>Loyalty Tier Distribution</h4>
                    <div style={{ height: '250px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} data={guestData.loyaltyStats} cx="50%" cy="50%" outerRadius={80} fill="#8884d8" dataKey="value" label>
                            {guestData.loyaltyStats.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                            ))}
                          </Pie>
                          <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <h4 style={{ color: '#fff', marginTop: 0 }}>Gender Distribution</h4>
                    <div style={{ height: '250px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} data={guestData.genderStats} cx="50%" cy="50%" innerRadius={40} outerRadius={80} fill="#82ca9d" dataKey="value" label>
                            {guestData.genderStats.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={COLORS[(index + 2) % COLORS.length]} />
                            ))}
                          </Pie>
                          <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              )}

              {/* BOOKINGS TAB */}
              {activeTab === 'bookings' && bookingData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Bookings Creation Trend</h4>
                  <div style={{ height: '350px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={bookingData.chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis dataKey="date" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                        <Line animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} type="monotone" dataKey="bookings" stroke="#38bdf8" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* CANCELLATIONS TAB */}
              {activeTab === 'cancellations' && cancellationData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                    <KpiCard title="Total Cancelled" value={cancellationData.totalCancelled} icon="❌" />
                    <KpiCard title="Lost Revenue" value={`₹ ${cancellationData.lostRevenue.toLocaleString('en-IN')}`} icon="💸" />
                  </div>
                  <h4 style={{ color: '#fff', margin: 0 }}>Recent Cancellations</h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', color: '#fff', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8' }}>
                          <th style={{ padding: '12px' }}>Booking #</th>
                          <th style={{ padding: '12px' }}>Guest ID</th>
                          <th style={{ padding: '12px' }}>Total Amount</th>
                          <th style={{ padding: '12px' }}>Cancellation Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cancellationData.cancellations.map((c, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                            <td style={{ padding: '12px' }}>{c.booking_number || c.id}</td>
                            <td style={{ padding: '12px' }}>{c.guest_id || 'N/A'}</td>
                            <td style={{ padding: '12px' }}>₹{Number(c.total_amount || 0).toLocaleString('en-IN')}</td>
                            <td style={{ padding: '12px' }}>{c.created_at ? c.created_at.split('T')[0] : 'N/A'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* PROFIT TAB */}
              {activeTab === 'profit' && profitData && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
                  <KpiCard title="Total Revenue" value={`₹ ${profitData.totalRevenue.toLocaleString('en-IN')}`} icon="💰" />
                  <KpiCard title="Est. Operating Costs (30%)" value={`₹ ${profitData.estimatedCosts.toLocaleString('en-IN')}`} icon="📉" />
                  <KpiCard title="Estimated Net Profit" value={`₹ ${profitData.estimatedProfit.toLocaleString('en-IN')}`} icon="💵" />
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}

const KpiCard = ({ title, value, subtitle, icon }) => (
  <div style={{ 
    background: 'rgba(255,255,255,0.03)', 
    border: '1px solid rgba(255,255,255,0.05)', 
    borderRadius: '12px', 
    padding: '20px', 
    display: 'flex', 
    alignItems: 'center', 
    gap: '15px' 
  }}>
    <div style={{ fontSize: '2rem', background: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '10px' }}>
      {icon}
    </div>
    <div>
      <div style={{ color: '#94a3b8', fontSize: '0.875rem' }}>{title}</div>
      <div style={{ color: '#fff', fontSize: '1.5rem', fontWeight: 'bold', margin: '4px 0' }}>{value}</div>
      {subtitle && <div style={{ color: '#64748b', fontSize: '0.75rem' }}>{subtitle}</div>}
    </div>
  </div>
);
