const fs = require('fs');
let code = fs.readFileSync('c:/Users/akshu/OneDrive/Desktop/hotel/src/components/AnalyticsModal.jsx', 'utf8');

if (!code.includes('useRef')) {
  code = code.replace(/import React, \{([^}]+)\} from 'react';/, 'import React, { $1, useRef, useMemo, useCallback } from \'react\';');
}

const skeletonCode = `
const SkeletonChart = () => (
  <div style={{ height: '300px', width: '100%', background: 'rgba(255,255,255,0.05)', borderRadius: '12px', animation: 'pulse 1.5s infinite', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <style>{'@keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 0.3; } 100% { opacity: 0.6; } }'}</style>
    <div style={{ color: '#64748b' }}>Loading data...</div>
  </div>
);
`;
if (!code.includes('SkeletonChart')) {
  code = code.replace('export default function AnalyticsModal', skeletonCode + '\nexport default function AnalyticsModal');
}

const refsCode = `
  const hasAnimated = useRef({});
  const dataCache = useRef({});
  const lastParams = useRef('');
`;
if (!code.includes('const hasAnimated = useRef({});')) {
  code = code.replace('const [loading, setLoading] = useState(false);', 'const [loading, setLoading] = useState(false);\n' + refsCode);
}

const clearCacheCode = `
  // Clear cache when date changes
  useEffect(() => {
    hasAnimated.current = {};
    dataCache.current = {};
  }, [dateRange, customStart, customEnd]);
`;
if (!code.includes('hasAnimated.current = {};')) {
  code = code.replace(/useEffect\(\(\) => \{\n\s*if \(isOpen\) \{\n\s*fetchData\(\);\n\s*\}\n\s*\}, \[isOpen, activeTab, dateRange, customStart, customEnd\]\);/, clearCacheCode + '\n  useEffect(() => { if (isOpen) fetchData(); }, [isOpen, activeTab, dateRange, customStart, customEnd]);');
}

const oldFetchDataRegex = /const fetchData = async \(\) => \{[\s\S]*?\}\s*\} catch \(e\) \{\s*console\.error\(\"Error fetching reports\", e\);\s*\} finally \{\s*setLoading\(false\);\s*\}\s*\};/;
const newFetchData = `const fetchData = async () => {
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
        const res = await fetch(\`http://localhost:5000/api/reports/\${endpoint}?\${params}\`, {
          headers: { 'Authorization': \`Bearer \${adminToken}\` }
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
  };`;
code = code.replace(oldFetchDataRegex, newFetchData);

code = code.replace(/<div style=\{\{ display: 'flex', justifyContent: 'center'.*?Loading Analytics\.\.\.<\/div>/, '<SkeletonChart />');

code = code.replace(/<Line /g, '<Line animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} ');
code = code.replace(/<Bar /g, '<Bar animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]} ');
code = code.replace(/<Pie(\s|\n)/g, '<Pie animationDuration={400} isAnimationActive={!hasAnimated.current[activeTab]}$1');

fs.writeFileSync('c:/Users/akshu/OneDrive/Desktop/hotel/src/components/AnalyticsModal.jsx', code, 'utf8');
