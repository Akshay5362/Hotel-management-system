import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

import { API_URL, SOCKET_URL, getApiHeaders } from '../config/apiConfig';
let socket;


export default function AdminHousekeeping({ onBack }) {
  const [rooms, setRooms] = useState([]);
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // Stats
  const stats = {
    total: rooms.length,
    dirty: rooms.filter(r => r.housekeeping_status === 'Dirty').length,
    clean: rooms.filter(r => r.housekeeping_status === 'Clean' || r.housekeeping_status === 'Vacant Ready').length,
    inProgress: rooms.filter(r => r.housekeeping_status === 'Cleaning In Progress').length,
    highPriority: rooms.filter(r => r.housekeeping_priority === 'High Priority').length,
  };

  const fetchRooms = async () => {
    try {
      const res = await fetch(`${API_URL}/housekeeping/rooms`);
      if (res.ok) {
        const data = await res.json();
        setRooms(data);
      }
    } catch (err) {
      console.error('Failed to fetch rooms', err);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchRooms();
    socket = io(SOCKET_URL);
    socket.on('housekeeping_update', (data) => {
      fetchRooms();
    });
    return () => socket.disconnect();
  }, []);

  const handleStatusChange = async (roomId, newStatus) => {
    try {
      await fetch(`${API_URL}/housekeeping/update-status`, {
        method: 'POST',
        headers: getApiHeaders(localStorage.getItem('adminToken'), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ roomId, status: newStatus })
      });
      fetchRooms();
    } catch (err) {
      console.error(err);
    }
  };

  const handlePriorityChange = async (roomId, newPriority) => {
    try {
      await fetch(`${API_URL}/housekeeping/assign`, {
        method: 'POST',
        headers: getApiHeaders(localStorage.getItem('adminToken'), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ roomId, priority: newPriority })
      });
      fetchRooms();

    } catch (err) {
      console.error(err);
    }
  };

  const filteredRooms = rooms.filter(r => {
    if (filter === 'Dirty' && r.housekeeping_status !== 'Dirty') return false;
    if (filter === 'Clean' && r.housekeeping_status !== 'Clean' && r.housekeeping_status !== 'Vacant Ready') return false;
    if (filter === 'In Progress' && r.housekeeping_status !== 'Cleaning In Progress') return false;
    if (filter === 'High Priority' && r.housekeeping_priority !== 'High Priority') return false;
    
    if (search) {
      const term = search.toLowerCase();
      if (!r.number.toString().toLowerCase().includes(term) && !r.guest_name?.toLowerCase().includes(term)) return false;
    }
    return true;
  });

  const getStatusColor = (status) => {
    switch(status) {
      case 'Clean': case 'Vacant Ready': return '#10b981';
      case 'Dirty': return '#ef4444';
      case 'Cleaning In Progress': return '#3b82f6';
      case 'Inspected': return '#8b5cf6';
      case 'Out Of Order': return '#f59e0b';
      default: return '#64748b';
    }
  };

  return (
    <div style={{ padding: '20px', color: '#fff', height: '100%', overflowY: 'auto', background: 'var(--bg-main)' }}>
      
      {/* Top Metrics Strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '20px', marginBottom: '25px' }}>
        {[
          { label: 'Total Rooms', value: stats.total, color: '#38bdf8' },
          { label: 'Dirty', value: stats.dirty, color: '#ef4444' },
          { label: 'Clean', value: stats.clean, color: '#10b981' },
          { label: 'In Progress', value: stats.inProgress, color: '#3b82f6' },
          { label: 'High Priority', value: stats.highPriority, color: '#f59e0b' }
        ].map(stat => (
          <div key={stat.label} style={{ background: 'var(--glass-bg)', border: `1px solid var(--border-color)`, borderRadius: '16px', padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)', boxShadow: 'var(--glass-shadow)' }}>
            <span style={{ fontSize: '2.5rem', fontWeight: '800', color: stat.color }}>{stat.value}</span>
            <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '5px', fontWeight: '600', textTransform: 'uppercase' }}>{stat.label}</span>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', background: 'var(--glass-bg)', padding: '15px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', gap: '10px' }}>
          {['All', 'Dirty', 'Clean', 'In Progress', 'High Priority'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                background: filter === f ? '#38bdf8' : 'rgba(255,255,255,0.05)',
                color: filter === f ? '#fff' : 'var(--text-muted)',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: '600',
                transition: 'all 0.2s'
              }}
            >
              {f}
            </button>
          ))}
        </div>
        <input 
          type="text" 
          placeholder="Search Room / Guest..." 
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '10px 15px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.3)', color: '#fff', width: '250px' }}
        />
      </div>

      {/* Data Table */}
      <div style={{ background: 'var(--glass-bg)', borderRadius: '16px', border: '1px solid var(--border-color)', overflow: 'hidden', boxShadow: 'var(--glass-shadow)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid var(--border-color)' }}>
              <th style={{ padding: '15px 20px', color: 'var(--text-muted)', fontWeight: '600' }}>Room</th>
              <th style={{ padding: '15px 20px', color: 'var(--text-muted)', fontWeight: '600' }}>Occupancy</th>
              <th style={{ padding: '15px 20px', color: 'var(--text-muted)', fontWeight: '600' }}>Guest</th>
              <th style={{ padding: '15px 20px', color: 'var(--text-muted)', fontWeight: '600' }}>Priority</th>
              <th style={{ padding: '15px 20px', color: 'var(--text-muted)', fontWeight: '600' }}>HK Status</th>
              <th style={{ padding: '15px 20px', color: 'var(--text-muted)', fontWeight: '600' }}>Last Cleaned</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: '30px' }}>Loading...</td></tr>
            ) : filteredRooms.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s', cursor: 'default' }} onMouseOver={e => e.currentTarget.style.background='rgba(255,255,255,0.03)'} onMouseOut={e => e.currentTarget.style.background='transparent'}>
                <td style={{ padding: '15px 20px' }}>
                  <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{r.number}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{r.type}</div>
                </td>
                <td style={{ padding: '15px 20px', textTransform: 'capitalize' }}>
                  <span style={{ color: r.occupancy_status === 'occupied' ? '#38bdf8' : 'var(--text-muted)' }}>{r.occupancy_status}</span>
                </td>
                <td style={{ padding: '15px 20px' }}>{r.guest_name || '-'}</td>
                <td style={{ padding: '15px 20px' }}>
                  <select 
                    value={r.housekeeping_priority || 'Normal'}
                    onChange={(e) => handlePriorityChange(r.id, e.target.value)}
                    style={{ 
                      background: r.housekeeping_priority === 'High Priority' ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.1)',
                      color: r.housekeeping_priority === 'High Priority' ? '#fca5a5' : '#cbd5e1',
                      border: 'none',
                      padding: '6px 12px',
                      borderRadius: '8px',
                      fontWeight: 'bold',
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    <option value="Normal">Normal</option>
                    <option value="High Priority">High Priority</option>
                  </select>
                </td>
                <td style={{ padding: '15px 20px' }}>
                  <select 
                    value={r.housekeeping_status}
                    onChange={(e) => handleStatusChange(r.id, e.target.value)}
                    style={{ 
                      background: 'rgba(0,0,0,0.4)',
                      color: getStatusColor(r.housekeeping_status),
                      border: `1px solid ${getStatusColor(r.housekeeping_status)}`,
                      padding: '6px 12px',
                      borderRadius: '8px',
                      fontWeight: 'bold',
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    <option value="Clean" style={{color: '#10b981'}}>Clean</option>
                    <option value="Dirty" style={{color: '#ef4444'}}>Dirty</option>
                    <option value="Cleaning In Progress" style={{color: '#3b82f6'}}>Cleaning In Progress</option>
                    <option value="Inspected" style={{color: '#8b5cf6'}}>Inspected</option>
                    <option value="Out Of Order" style={{color: '#f59e0b'}}>Out Of Order</option>
                    <option value="Do Not Disturb" style={{color: '#64748b'}}>Do Not Disturb</option>
                    <option value="Vacant Ready" style={{color: '#10b981'}}>Vacant Ready</option>
                  </select>
                </td>
                <td style={{ padding: '15px 20px', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                  {r.last_cleaned_at ? new Date(r.last_cleaned_at).toLocaleString() : 'Never'}
                </td>
              </tr>
            ))}
            {filteredRooms.length === 0 && !loading && (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>No rooms match the selected filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
