const fs = require('fs');

let code = fs.readFileSync('c:/Users/akshu/OneDrive/Desktop/hotel/src/components/AnalyticsModal.jsx', 'utf8');

// 1. Add imports
const imports = `import { exportToPDF, exportToExcel, exportToCSV, formatCurrency } from '../utils/exportUtils';\n`;
if (!code.includes('exportToPDF')) {
  code = code.replace(/import \{ AdminAuthContext \} from '\.\.\/contexts\/AdminAuthContext';/, "import { AdminAuthContext } from '../contexts/AdminAuthContext';\n" + imports);
}

// 2. Add showExportMenu state
if (!code.includes('showExportMenu')) {
  code = code.replace('const [loading, setLoading] = useState(false);', 'const [loading, setLoading] = useState(false);\n  const [showExportMenu, setShowExportMenu] = useState(false);');
}

// 3. Add handleExport function
const handleExportCode = `
  const handleExport = (format) => {
    let title = '';
    let headers = [];
    let rows = [];

    const getFilterText = () => {
      if (dateRange === 'Custom Date Range') return \`\${customStart} to \${customEnd}\`;
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
          ['Occupancy Rate', \`\${dashboardData.occupancyRate}%\`],
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
        rows = roomTypeData.roomTypeStats.map(d => [d.name, d.total, d.occupied, \`\${d.occupancyRate}%\`]);
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

    if (format === 'pdf') exportToPDF(title, headers, rows, filters);
    else if (format === 'excel') exportToExcel(title, headers, rows, filters);
    else if (format === 'csv') exportToCSV(title, headers, rows, filters);
  };
`;
if (!code.includes('const handleExport = (format) =>')) {
  code = code.replace('const getDateParams = () => {', handleExportCode + '\n  const getDateParams = () => {');
}

// 4. Add Export UI Button Group
const exportUI = `
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '10px' }}>
            <div style={{ position: 'relative' }}>
              <button 
                onClick={() => setShowExportMenu(!showExportMenu)}
                style={{ padding: '8px 16px', borderRadius: '6px', background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}
              >
                Export ▼
              </button>
              {showExportMenu && (
                <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: '8px', background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', padding: '5px 0', zIndex: 50, minWidth: '100px', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)' }}>
                  <button onClick={() => { handleExport('pdf'); setShowExportMenu(false); }} style={{ display: 'block', width: '100%', padding: '8px 20px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer' }}>PDF</button>
                  <button onClick={() => { handleExport('excel'); setShowExportMenu(false); }} style={{ display: 'block', width: '100%', padding: '8px 20px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer' }}>Excel</button>
                  <button onClick={() => { handleExport('csv'); setShowExportMenu(false); }} style={{ display: 'block', width: '100%', padding: '8px 20px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer' }}>CSV</button>
                </div>
              )}
            </div>
            <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)', margin: '0 5px' }}></div>
`;
if (!code.includes('Export ▼')) {
  code = code.replace("<div style={{ marginLeft: 'auto', display: 'flex', gap: '10px' }}>", exportUI);
}

fs.writeFileSync('c:/Users/akshu/OneDrive/Desktop/hotel/src/components/AnalyticsModal.jsx', code, 'utf8');
