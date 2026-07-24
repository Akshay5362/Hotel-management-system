import { API_BASE_URL } from '../config/apiConfig';
import React, {  useState, useEffect, useContext , useRef, useMemo, useCallback } from 'react';
import { 
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, 
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer 
} from 'recharts';
import { AdminAuthContext } from '../contexts/AdminAuthContext';
import { exportToPDF, exportToExcel, exportToCSV, formatCurrency } from '../utils/exportUtils';


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

  
  // Clear cache when date changes
  useEffect(() => {
    hasAnimated.current = {};
    dataCache.current = {};
  }, [dateRange, customStart, customEnd]);

  useEffect(() => { if (isOpen) fetchData(); }, [isOpen, activeTab, dateRange, customStart, customEnd]);

  
  const handleExport = async (format) => {
    let title = '';
    let headers = [];
    let rows = [];

    const getFilterText = () => {
      if (dateRange === 'Custom Date Range') return `${customStart} to ${customEnd}`;
      return dateRange;
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
        headers = ['Metric', 'Value'];
        rows = [
          ['Total Cancelled', cancellationData.totalCancelled],
          ['Lost Revenue', formatCurrency(cancellationData.lostRevenue)]
        ];
        break;
      case 'profit':
        if (!profitData) return;
        title = 'Profit Report';
        headers = ['Metric', 'Amount'];
        rows = [
          ['Total Revenue', formatCurrency(profitData.totalRevenue)],
          ['Estimated Costs', formatCurrency(profitData.estimatedCosts)],
          ['Estimated Profit', formatCurrency(profitData.estimatedProfit)]
        ];
        break;
      case 'adr':
        if (!adrData) return;
        title = 'Average Daily Rate (ADR)';
        headers = ['Date', 'ADR'];
        rows = adrData.chartData.map(d => [d.date, formatCurrency(d.adr)]);
        break;
      case 'revpar':
        if (!revparData) return;
        title = 'Revenue Per Available Room';
        headers = ['Date', 'RevPAR'];
        rows = revparData.chartData.map(d => [d.date, formatCurrency(d.revPAR)]);
        break;
      case 'room_types':
        if (!roomTypeData) return;
        title = 'Room Type Performance';
        headers = ['Room Type', 'Total Rooms', 'Occupied', 'Occupancy Rate'];
        rows = roomTypeData.roomTypeStats.map(d => [d.name, d.total, d.occupied, `${d.occupancyRate}%`]);
        break;
      case 'payments':
        if (!paymentsData) return;
        title = 'Payment Methods';
        headers = ['Payment Method', 'Amount'];
        rows = paymentsData.breakdown.map(d => [d.name, formatCurrency(d.value)]);
        break;
      default:
        return;
    }

    if (format === 'pdf') await exportToPDF(title, headers, rows, filters);
    else if (format === 'excel') exportToExcel(title, headers, rows, filters);
    else if (format === 'csv') exportToCSV(title, headers, rows, filters);
  };

  const getDateParams = () => {
    let start = new Date();
    let end = new Date();
    
    switch (dateRange) {
      case 'Today':
        start.setHours(0,0,0,0);
        break;
      case 'Yesterday':
        start.setDate(start.getDate() - 1);
        start.setHours(0,0,0,0);
        end = new Date(start);
        end.setHours(23,59,59,999);
        break;
      case 'This Week':
        const day = start.getDay();
        const diff = start.getDate() - day + (day === 0 ? -6 : 1);
        start = new Date(start.setDate(diff));
        start.setHours(0,0,0,0);
        break;
      case 'This Month':
        start = new Date(start.getFullYear(), start.getMonth(), 1);
        break;
      case 'This Year':
        start = new Date(start.getFullYear(), 0, 1);
        break;
      case 'Custom Date Range':
        if (customStart) start = new Date(customStart);
        if (customEnd) end = new Date(customEnd);
        end.setHours(23,59,59,999);
        break;
      default:
        break;
    }
    
    return `startDate=${start.toISOString()}&endDate=${end.toISOString()}`;
  };

  const fetchData = async () => {
    if (!adminToken) return;
    const params = getDateParams();
    
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
        const res = await fetch(`${API_BASE_URL}/api/reports/${endpoint}?${params}`, {
          headers: { 'Authorization': `Bearer ${adminToken}` }
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
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" style={{ zIndex: 1000 }}>
      <div className="modal-content" style={{ maxWidth: '1100px', width: '95%', height: '90vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-dark)' }}>
        
        {/* Header */}
        <div className="modal-header" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <h3 style={{ fontSize: '1.5rem', color: '#fff' }}>📈 Reports & Analytics</h3>
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
          {loading ? (
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <h4 style={{ color: '#fff', marginTop: 0 }}>Room Type Performance</h4>
                    <div style={{ height: '300px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={occupancyData.roomTypeStats} layout="vertical">
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                          <XAxis type="number" stroke="#94a3b8" />
                          <YAxis dataKey="name" type="category" stroke="#94a3b8" width={120} />
                          <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                          <Legend />
                          <Bar animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} dataKey="occupancyRate" name="Occupancy %" fill="#34d399" radius={[0, 4, 4, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <h4 style={{ color: '#fff', marginTop: 0 }}>Booking Status Distribution</h4>
                    <div style={{ height: '300px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} 
                            data={Object.keys(occupancyData.bookingStatus).map(k => ({ name: k, value: occupancyData.bookingStatus[k] }))} 
                            cx="50%" cy="50%" outerRadius={100} fill="#8884d8" dataKey="value" label
                          >
                            {Object.keys(occupancyData.bookingStatus).map((entry, index) => (
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
              )}

              {/* GUESTS TAB */}
              {activeTab === 'guests' && guestData && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <h4 style={{ color: '#fff', marginTop: 0 }}>Guest Loyalty Tiers</h4>
                    <div style={{ height: '300px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} data={guestData.loyaltyStats} cx="50%" cy="50%" innerRadius={70} outerRadius={100} paddingAngle={5} dataKey="value">
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
                    <h4 style={{ color: '#fff', marginTop: 0 }}>Guest Gender Split</h4>
                    <div style={{ height: '300px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} data={guestData.genderStats} cx="50%" cy="50%" outerRadius={100} dataKey="value" label>
                            {guestData.genderStats.map((entry, index) => (
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
              )}

              {/* BOOKINGS TAB */}
              {activeTab === 'bookings' && bookingData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>New Bookings Trend</h4>
                  <div style={{ height: '350px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={bookingData.chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis dataKey="date" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                        <Line animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} type="monotone" dataKey="bookings" stroke="#38bdf8" strokeWidth={3} dot={{ r: 5, fill: '#38bdf8' }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* PROFIT TAB */}
              {activeTab === 'profit' && profitData && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
                  <KpiCard title="Total Revenue" value={`₹ ${profitData.totalRevenue.toLocaleString('en-IN')}`} icon="💰" />
                  <KpiCard title="Estimated Costs (30%)" value={`₹ ${profitData.estimatedCosts.toLocaleString('en-IN')}`} icon="📉" />
                  <KpiCard title="Estimated Profit" value={`₹ ${profitData.estimatedProfit.toLocaleString('en-IN')}`} icon="🤑" />
                </div>
              )}

              {/* CANCELLATIONS TAB */}
              {activeTab === 'cancellations' && cancellationData && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
                  <KpiCard title="Total Cancelled Bookings" value={cancellationData.totalCancelled} icon="❌" />
                  <KpiCard title="Est. Lost Revenue" value={`₹ ${cancellationData.lostRevenue.toLocaleString('en-IN')}`} icon="📉" />
                </div>
              )}

              {/* ADR TAB */}
              {activeTab === 'adr' && adrData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Average Daily Rate (ADR) Trend</h4>
                  <div style={{ height: '300px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={adrData.chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis dataKey="date" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                        <Line animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} type="monotone" dataKey="adr" stroke="#fbbf24" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* REVPAR TAB */}
              {activeTab === 'revpar' && revparData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Revenue Per Available Room (RevPAR) Trend</h4>
                  <div style={{ height: '300px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={revparData.chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis dataKey="date" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                        <Line animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} type="monotone" dataKey="revPAR" stroke="#34d399" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* ROOM TYPES TAB */}
              {activeTab === 'room_types' && roomTypeData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Room Type Performance</h4>
                  <div style={{ height: '300px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={roomTypeData.roomTypeStats}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis dataKey="name" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                        <Legend />
                        <Bar animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} dataKey="occupancyRate" name="Occupancy Rate (%)" fill="#818cf8" radius={[4,4,0,0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* PAYMENTS TAB */}
              {activeTab === 'payments' && paymentsData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <h4 style={{ color: '#fff', margin: 0 }}>Payment Methods Breakdown</h4>
                  <div style={{ height: '300px', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]}
                          data={paymentsData.breakdown}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={100}
                          paddingAngle={5}
                          dataKey="value"
                          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                        >
                          {paymentsData.breakdown.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <RechartsTooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Reusable KPI Card
function KpiCard({ title, value, subtitle, icon }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '12px',
      padding: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      position: 'relative',
      overflow: 'hidden'
    }}>
      <div style={{ position: 'absolute', right: '-10px', top: '-10px', fontSize: '5rem', opacity: 0.05 }}>
        {icon}
      </div>
      <span style={{ color: '#94a3b8', fontSize: '0.9rem', fontWeight: '500' }}>{title}</span>
      <span style={{ color: '#fff', fontSize: '2rem', fontWeight: '800' }}>{value}</span>
      {subtitle && <span style={{ color: '#64748b', fontSize: '0.8rem' }}>{subtitle}</span>}
    </div>
  );
}
