import React, { useState, useEffect, useContext } from 'react';
import { X, CalendarDays, Clock, Save, Info, AlertTriangle, Users, Bed, CheckSquare, Sparkles } from 'lucide-react';
import { AdminAuthContext } from '../contexts/AdminAuthContext';

export default function SettingsModal({ isOpen, onClose }) {
  const { adminToken, adminUser } = useContext(AdminAuthContext);
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState({
    businessDate: '',
    systemDate: '',
    lastDayEnd: null,
    stats: {
      occupiedRooms: 0,
      bookedRooms: 0,
      dirtyRooms: 0,
      pendingCheckouts: 0
    }
  });
  
  const [newDate, setNewDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const isAdmin = adminUser?.role === 'ADMIN' || adminUser?.role === 'admin';

  useEffect(() => {
    if (isOpen) {
      fetchData();
      setError('');
      setSuccess('');
      setReason('');
    }
  }, [isOpen]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await fetch('http://localhost:5000/api/settings/business-date', {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to fetch settings');
      
      setData({
        businessDate: result.businessDate,
        systemDate: result.systemDate,
        lastDayEnd: result.lastDayEnd,
        stats: result.stats || { occupiedRooms: 0, bookedRooms: 0, dirtyRooms: 0, pendingCheckouts: 0 }
      });
      setNewDate(result.businessDate);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!isAdmin) return;
    
    if (!newDate) {
      setError('Please select a new business date.');
      return;
    }
    if (!reason.trim()) {
      setError('Please provide a reason for the manual change.');
      return;
    }

    // Convert YYYY-MM-DD from date input to DD-Mon-YYYY
    const d = new Date(newDate);
    const formattedDate = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    if (formattedDate === data.businessDate) {
      setError('New business date cannot be the same as the current business date.');
      return;
    }

    const confirmMsg = `WARNING: You are about to override the active Business Date from ${data.businessDate} to ${formattedDate}.\n\nThere are currently:\n- ${data.stats.occupiedRooms} Occupied Rooms\n- ${data.stats.pendingCheckouts} Pending Checkouts\n\nThis action will affect revenue reporting and room availability. Are you absolutely sure you want to proceed?`;
    
    if (!window.confirm(confirmMsg)) {
      return;
    }

    try {
      setSaving(true);
      setError('');
      setSuccess('');
      
      const res = await fetch('http://localhost:5000/api/settings/business-date', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          newDate: formattedDate,
          reason: reason
        })
      });
      
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to update business date');
      
      setSuccess('Business Date successfully updated! Refreshing dashboards...');
      setData(prev => ({ ...prev, businessDate: formattedDate }));
      setReason('');
      
      // Dispatch a custom event to tell all dashboards to refetch silently
      window.dispatchEvent(new Event('businessDateChanged'));
      
      // Re-fetch our own settings to ensure we are completely in sync
      setTimeout(() => {
        fetchData();
        setSuccess('');
      }, 3000);
      
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '650px', backgroundColor: 'var(--card-bg)' }}>
        <div className="modal-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '15px' }}>
          <h2><SettingsIcon /> System Settings</h2>
          <button className="icon-btn" onClick={onClose}><X size={24} /></button>
        </div>

        <div className="modal-body" style={{ marginTop: '20px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px' }}>Loading settings...</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '25px' }}>
              
              <div style={{
                background: 'rgba(56, 189, 248, 0.1)',
                padding: '20px',
                borderRadius: '8px',
                border: '1px solid rgba(56, 189, 248, 0.2)'
              }}>
                <h3 style={{ margin: '0 0 15px 0', display: 'flex', alignItems: 'center', gap: '8px', color: '#38bdf8' }}>
                  <CalendarDays size={20} /> Operational Business Date
                </h3>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                  <div>
                    <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '5px' }}>
                      Current PMS Date
                    </label>
                    <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{data.businessDate}</div>
                  </div>
                  
                  <div>
                    <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '5px' }}>
                      Real-time System Clock
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Clock size={16} /> 
                      {new Date(data.systemDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px dashed rgba(255,255,255,0.1)' }}>
                  <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '5px' }}>
                    Last Night Audit / Day End
                  </label>
                  <div>
                    {data.lastDayEnd ? new Date(data.lastDayEnd).toLocaleString('en-IN') : 'Never'}
                  </div>
                </div>
              </div>

              {!isAdmin ? (
                <div style={{
                  display: 'flex', gap: '12px', alignItems: 'flex-start',
                  padding: '15px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px'
                }}>
                  <Info size={20} color="#94a3b8" style={{ flexShrink: 0, marginTop: '2px' }} />
                  <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.9rem', lineHeight: '1.5' }}>
                    You have read-only access to system settings. Only Administrators can manually modify the operational business date. Standard date rollover occurs automatically during the Night Audit.
                  </p>
                </div>
              ) : (
                <div style={{
                  background: 'rgba(245, 158, 11, 0.1)',
                  padding: '20px',
                  borderRadius: '8px',
                  border: '1px solid rgba(245, 158, 11, 0.2)'
                }}>
                  <h3 style={{ margin: '0 0 15px 0', display: 'flex', alignItems: 'center', gap: '8px', color: '#f59e0b' }}>
                    <AlertTriangle size={20} /> Manual Date Override
                  </h3>
                  
                  <p style={{ fontSize: '0.85rem', color: '#fbbf24', margin: '0 0 15px 0' }}>
                    Warning: Manually altering the business date will affect all revenue reporting and room statuses. This action is permanently logged.
                  </p>

                  <div style={{ 
                    display: 'grid', 
                    gridTemplateColumns: 'repeat(4, 1fr)', 
                    gap: '10px', 
                    marginBottom: '20px',
                    background: 'rgba(0,0,0,0.2)',
                    padding: '12px',
                    borderRadius: '6px'
                  }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}><Users size={12}/> Occupied</div>
                      <div style={{ fontWeight: 'bold', color: '#f8fafc' }}>{data.stats.occupiedRooms}</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}><CheckSquare size={12}/> Checkouts</div>
                      <div style={{ fontWeight: 'bold', color: '#f8fafc' }}>{data.stats.pendingCheckouts}</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}><Bed size={12}/> Booked</div>
                      <div style={{ fontWeight: 'bold', color: '#f8fafc' }}>{data.stats.bookedRooms}</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}><Sparkles size={12}/> Dirty</div>
                      <div style={{ fontWeight: 'bold', color: '#f8fafc' }}>{data.stats.dirtyRooms}</div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                    <div>
                      <label style={{ display: 'block', marginBottom: '8px' }}>New Business Date</label>
                      <input 
                        type="date" 
                        className="input-field"
                        style={{ width: '100%', maxWidth: '250px' }}
                        // Convert DD-Mon-YYYY to YYYY-MM-DD for the input value
                        value={newDate && !newDate.includes('-20') ? newDate : (() => {
                          try {
                            const d = new Date(data.businessDate);
                            return !isNaN(d) ? d.toISOString().split('T')[0] : '';
                          } catch(e) { return ''; }
                        })()}
                        onChange={(e) => setNewDate(e.target.value)}
                      />
                    </div>
                    
                    <div>
                      <label style={{ display: 'block', marginBottom: '8px' }}>Reason for Override (Required)</label>
                      <input 
                        type="text" 
                        className="input-field"
                        style={{ width: '100%' }}
                        placeholder="e.g., Fixing incorrect night audit date"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </div>

                    {error && <div style={{ color: '#ef4444', fontSize: '0.9rem' }}>{error}</div>}
                    {success && <div style={{ color: '#10b981', fontSize: '0.9rem' }}>{success}</div>}

                    <div style={{ marginTop: '10px' }}>
                      <button 
                        className="btn btn-primary" 
                        style={{ background: '#ef4444', color: '#fff', border: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}
                        onClick={handleUpdate}
                        disabled={saving}
                      >
                        <Save size={18} />
                        {saving ? 'Processing...' : 'Override Business Date'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '8px' }}>
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
  );
}
