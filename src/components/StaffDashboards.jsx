import React, { useContext } from 'react';
import { AdminAuthContext } from '../contexts/AdminAuthContext';
import Sidebar from './Sidebar';

function BaseDashboard({ title, icon, color }) {
  const { adminUser, logout } = useContext(AdminAuthContext);
  
  return (
    <div className="app-layout">
      <Sidebar />
      <div className="app-container" style={{ background: '#0f172a' }}>
      <header className="header" style={{ borderBottom: `2px solid ${color}` }}>
        <div className="brand-section">
          <span className="logo-icon">{icon}</span>
          <h1 className="brand-name">
            Webline PMS Plus <span>HOTEL SKY-5</span>
          </h1>
        </div>
        
        <div className="status-time-widget">
          <div className="user-badge">
            <span className="user-indicator" style={{ background: color, boxShadow: `0 0 8px ${color}` }}></span>
            <span style={{ fontSize: '0.8rem', fontWeight: '600' }}>
              USER: {adminUser?.fullName?.toUpperCase() || adminUser?.full_name?.toUpperCase()}
            </span>
            <span style={{ 
              fontSize: '0.7rem', 
              background: 'rgba(255,255,255,0.1)', 
              padding: '2px 6px', 
              borderRadius: '4px', 
              marginLeft: '8px',
              border: `1px solid ${color}`
            }}>
              {adminUser?.role}
            </span>
            <button 
              onClick={() => { logout(); window.location.href = '/admin/login'; }} 
              style={{ background: 'transparent', border: 'none', color: '#ff4d4d', marginLeft: '10px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: '700' }}
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <div style={{ padding: '40px', color: '#fff', textAlign: 'center', height: 'calc(100vh - 70px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: '4rem', marginBottom: '20px' }}>{icon}</div>
        <h2 style={{ fontSize: '2.5rem', marginBottom: '10px', color }}>{title}</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '1.2rem', maxWidth: '600px' }}>
          Welcome to the {title}. This module is currently under development. Here you will find tools and reports specific to your department.
        </p>
      </div>
    </div>
    </div>
  );
}

export function ReceptionDashboard() {
  return <BaseDashboard title="Front Office & Reception" icon="🛎️" color="#38bdf8" />;
}

export function KitchenDashboard() {
  return <BaseDashboard title="Kitchen Management" icon="🍳" color="#fbbf24" />;
}

export function PantryDashboard() {
  return <BaseDashboard title="Pantry Operations" icon="☕" color="#f472b6" />;
}

export function HousekeepingDashboard() {
  return <BaseDashboard title="Housekeeping & Cleaning" icon="🧹" color="#4ade80" />;
}
