import React from 'react';

export default function MetricsBar({ stats, systemStatus }) {
  return (
    <div className="metrics-section">
      {/* Primary Metrics Row */}
      <div className="metrics-row">
        <div className="metric-card total">
          <span className="metric-title">Total Rooms</span>
          <span className="metric-value">{stats.total}</span>
        </div>

        <div className="metric-card occupancy" style={{ background: 'rgba(192, 132, 252, 0.04)' }}>
          <span className="metric-title">Occupancy</span>
          <span className="metric-value">{stats.occupancy}%</span>
        </div>

        <div className="metric-card occupied" style={{ background: 'rgba(248, 113, 113, 0.04)' }}>
          <span className="metric-title">Occupied Rooms</span>
          <span className="metric-value">{stats.occupied}</span>
        </div>

        <div className="metric-card vacant">
          <span className="metric-title">Vacant</span>
          <span className="metric-value">{stats.vacant}</span>
        </div>

        <div className="metric-card clean" style={{ borderLeftColor: '#818cf8', background: 'rgba(129, 140, 248, 0.04)' }}>
          <span className="metric-title">Dirty Rooms</span>
          <span className="metric-value">{stats.dirty}</span>
        </div>

        <div className="metric-card checkout" style={{ borderLeftColor: '#fb923c', background: 'rgba(251, 146, 60, 0.04)' }}>
          <span className="metric-title">Today's Check-in</span>
          <span className="metric-value">{stats.todayCheckins}</span>
        </div>

        <div className="metric-card checkout" style={{ borderLeftColor: '#fb923c', background: 'rgba(251, 146, 60, 0.04)' }}>
          <span className="metric-title">Today's Checkout</span>
          <span className="metric-value">{stats.todayCheckouts}</span>
        </div>

        <div className="metric-card clean">
          <span className="metric-title">Continued Rooms</span>
          <span className="metric-value">{stats.continuedRooms}</span>
        </div>
      </div>

      {/* Sync Status Banner */}
      <div className="sync-status">
        <span className="sync-dot" style={{ backgroundColor: systemStatus ? '#4ade80' : '#f87171' }}></span>
        <span>Online Sync Permission: <strong>{systemStatus ? 'Enabled' : 'Disabled'}</strong></span>
        <span style={{ margin: '0 8px', color: 'var(--border-color)' }}>|</span>
        <span>System: <strong>{systemStatus ? 'Online (Real API)' : 'Offline Mode (Backend Unreachable)'}</strong></span>
      </div>
    </div>
  );
}
