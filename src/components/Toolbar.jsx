import React from 'react';

export default function Toolbar({ 
  onActionClick, 
  activeFilter, 
  setFilter, 
  roomCounts, 
  searchQuery, 
  setSearchQuery,
  requestCount,
  activeModal
}) {
  const filters = [
    { key: 'all', label: 'All Rooms', class: 'chip-all', count: roomCounts.all },
    { key: 'vacant', label: 'Vacant', class: 'chip-vacant', count: roomCounts.vacant },
    { key: 'occupied', label: 'Occupied', class: 'chip-occupied', count: roomCounts.occupied },
    { key: 'dirty', label: 'Dirty', class: 'chip-dirty', count: roomCounts.dirty },
    { key: 'booked', label: 'Booked', class: 'chip-booked', count: roomCounts.booked },
    { key: 'inactive', label: 'Inactive', class: 'chip-inactive', count: roomCounts.inactive }
  ];

  return (
    <div className="toolbar-section">
      {/* Quick Action Toolbar Buttons */}
      <div className="quick-actions">
        <button className="btn-action" onClick={() => onActionClick('checkin')} {...(activeModal ? {} : { 'data-tooltip': "Register a guest check-in (Vacant room)" })}>
          <svg viewBox="0 0 24 24">
            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="8.5" cy="7" r="4" />
            <line x1="20" y1="8" x2="20" y2="14" />
            <line x1="17" y1="11" x2="23" y2="11" />
          </svg>
          Check In
        </button>

        <button className="btn-action" onClick={() => onActionClick('checkout')} {...(activeModal ? {} : { 'data-tooltip': "Settle bills & check out guest (Occupied room)" })}>
          <svg viewBox="0 0 24 24">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          Check Out
        </button>

        <button className="btn-action" onClick={() => onActionClick('shifting')} {...(activeModal ? {} : { 'data-tooltip': "Shift active guest to another room" })}>
          <svg viewBox="0 0 24 24">
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          Shifting
        </button>

        <button className="btn-action" onClick={() => onActionClick('cash')} {...(activeModal ? {} : { 'data-tooltip': "View active business date cash transactions" })}>
          <svg viewBox="0 0 24 24">
            <line x1="12" y1="1" x2="12" y2="23" />
            <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
          Cash Status
        </button>

        <button className="btn-action" onClick={() => onActionClick('reports')} {...(activeModal ? {} : { 'data-tooltip': "Day End closure & Night Audit rollover" })}>
          <svg viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          Day End
        </button>

        <button className="btn-action" onClick={() => onActionClick('analytics')} {...(activeModal ? {} : { 'data-tooltip': "View Reports & Analytics Dashboard" })}>
          <svg viewBox="0 0 24 24">
            <path d="M3 3v18h18" />
            <path d="M18 17V9" />
            <path d="M13 17V5" />
            <path d="M8 17v-3" />
          </svg>
          Analytics
        </button>

        <button className="btn-action" onClick={() => onActionClick('reservations')} {...(activeModal ? {} : { 'data-tooltip': "View upcoming future guest reservations" })}>
          <svg viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
            <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
          </svg>
          Upcoming Res
        </button>

        <button className="btn-action" onClick={() => onActionClick('requests')} {...(activeModal ? {} : { 'data-tooltip': "View guest service, maintenance & checkout requests" })} style={{ position: 'relative' }}>
          <svg viewBox="0 0 24 24">
            <path d="M18 8h1a4 4 0 0 1 0 8h-1"/>
            <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/>
            <line x1="6" y1="1" x2="6" y2="4"/>
            <line x1="10" y1="1" x2="10" y2="4"/>
            <line x1="14" y1="1" x2="14" y2="4"/>
          </svg>
          Requests
          {requestCount > 0 && (
            <span style={{
              position: 'absolute',
              top: '-6px',
              right: '-6px',
              background: '#ef4444',
              color: '#fff',
              borderRadius: '50%',
              minWidth: '18px',
              height: '18px',
              fontSize: '0.65rem',
              fontWeight: '800',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 4px',
              boxShadow: '0 0 8px rgba(239,68,68,0.6)',
              animation: 'pulse 2s infinite',
              lineHeight: 1,
              zIndex: 10
            }}>
              {requestCount > 99 ? '99+' : requestCount}
            </span>
          )}
        </button>

        <button className="btn-action" onClick={() => onActionClick('id_verify')} {...(activeModal ? {} : { 'data-tooltip': "Review and verify uploaded Guest ID documents" })}>
          <svg viewBox="0 0 24 24">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <polyline points="9 12 11 14 15 10" />
          </svg>
          ID Verify
        </button>

        <button className="btn-action" onClick={() => onActionClick('refresh')} {...(activeModal ? {} : { 'data-tooltip': "Re-sync dashboard with database" })}>
          <svg viewBox="0 0 24 24">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
          </svg>
          Refresh
        </button>

        <button className="btn-action exit" onClick={() => onActionClick('exit')} {...(activeModal ? {} : { 'data-tooltip': "Close module and return to PMS shell" })}>
          <svg viewBox="0 0 24 24">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Exit
        </button>
      </div>

      {/* Guest/Room Search bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexGrow: 1, maxWidth: '240px' }}>
        <div className="input-icon-wrapper" style={{ width: '100%', position: 'relative' }}>
          <svg viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input 
            type="text" 
            placeholder="Search by Room / Guest..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ padding: '6px 32px 6px 36px', height: '36px', borderRadius: '8px', border: '1px solid var(--border-color)', width: '100%' }}
          />
          {searchQuery && (
            <button 
              onClick={() => setSearchQuery('')}
              style={{
                position: 'absolute',
                right: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: '1.2rem',
                cursor: 'pointer',
                padding: '0 4px',
                lineHeight: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title="Clear search"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      {/* Status Legend & Filtering Row */}
      <div className="legend-filters">
        {filters.map((f) => (
          <button 
            key={f.key} 
            className={`filter-chip ${f.class} ${activeFilter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
            data-tooltip={`Filter rooms by status: ${f.label}`}
          >
            {f.label}
            <span className="badge-count">{f.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
