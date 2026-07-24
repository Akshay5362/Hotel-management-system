const fs = require('fs');

let code = fs.readFileSync('c:/Users/akshu/OneDrive/Desktop/hotel/src/components/AnalyticsModal.jsx', 'utf8');

// 1. Add states and refs
const statesCode = `
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
`;
if (!code.includes('tabsRef = useRef(null)')) {
  code = code.replace('const hasAnimated = useRef({});', 'const hasAnimated = useRef({});\n' + statesCode);
}

// 2. Adjust layout container
code = code.replace(
  /<div style=\{\{ display: 'flex', gap: '15px', padding: '15px 20px', background: 'rgba\(0,0,0,0.2\)', borderBottom: '1px solid rgba\(255,255,255,0.05\)', flexWrap: 'wrap', alignItems: 'center' \}\}>/g,
  `<div style={{ display: 'flex', gap: '15px', padding: '15px 20px', background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid rgba(255,255,255,0.05)', flexWrap: 'nowrap', alignItems: 'center', overflow: 'hidden' }}>`
);

// 3. Replace the old flex container with the new structure
const searchStr = `<div style={{ marginLeft: 'auto', display: 'flex', gap: '10px' }}>`;
const replaceStr = `<div style={{ marginLeft: 'auto', display: 'flex', gap: '10px', alignItems: 'center', flex: 1, minWidth: 0 }}>`;
code = code.replace(searchStr, replaceStr);

// 4. Wrap the tabs mapping
const searchTabs = `{['dashboard', 'revenue', 'occupancy', 'adr', 'revpar', 'room_types', 'payments', 'guests', 'bookings', 'cancellations', 'profit'].map(tab => (`;
const replaceTabs = `
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
                scrollbarWidth: 'none', // Firefox
                msOverflowStyle: 'none', // IE
                flex: 1,
                cursor: isDragging ? 'grabbing' : 'grab'
              }}
              className="hide-scrollbar"
            >
              <style>{'.hide-scrollbar::-webkit-scrollbar { display: none; }'}</style>
            ${searchTabs}`;

code = code.replace(searchTabs, replaceTabs);

// 5. Add data-active and whiteSpace nowrap to button
code = code.replace(
  `onClick={() => setActiveTab(tab)}`,
  `onClick={() => setActiveTab(tab)}\n                data-active={activeTab === tab}`
);

code = code.replace(
  `textTransform: 'capitalize',`,
  `textTransform: 'capitalize',\n                  whiteSpace: 'nowrap',`
);

// 6. Close the wrapper div
code = code.replace(
  `{tab}\n              </button>\n            ))}\n          </div>`,
  `{tab}\n              </button>\n            ))}\n            </div>\n          </div>`
);

fs.writeFileSync('c:/Users/akshu/OneDrive/Desktop/hotel/src/components/AnalyticsModal.jsx', code, 'utf8');
