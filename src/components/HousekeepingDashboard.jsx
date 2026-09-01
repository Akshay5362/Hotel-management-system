/**
 * src/components/HousekeepingDashboard.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated Cleaner Login + Housekeeping Dashboard.
 *
 * A purpose-built operational screen for housekeeping staff (cleaner1/cleaner2),
 * following the exact same pattern already established by KitchenDashboard.jsx:
 * a dedicated route outside the main hotel dashboard shell, reusing the
 * existing housekeeping API + Socket.IO event rather than inventing a second
 * room-status system.
 *
 *   GET  /api/housekeeping/rooms         — all rooms with housekeeping fields
 *   POST /api/housekeeping/update-status — Start Cleaning / Mark Clean
 *                                           (cleaner-accessible; the sibling
 *                                           /assign endpoint is admin-only)
 *   housekeeping_update                  — Socket.IO real-time event
 *
 * Shows only the rooms currently assigned to the logged-in cleaner. No
 * Check-In/Check-Out, payments, cash, reservations, guest editing, Food POS,
 * or admin controls are reachable from this screen.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useContext, useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import {
  Sparkles, CheckCircle, RefreshCw, AlertTriangle, Wifi, WifiOff, Inbox, Clock
} from 'lucide-react';
import { AdminAuthContext } from '../contexts/AdminAuthContext';
import { API_URL, SOCKET_URL, getApiHeaders } from '../config/apiConfig';

function formatTime(isoString) {
  if (!isoString) return 'Never';
  try {
    return new Date(isoString).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
    });
  } catch {
    return '—';
  }
}

const STATUS_BADGE = {
  'Dirty':                { label: '🟠 DIRTY',    color: '#f87171' },
  'Cleaning In Progress':  { label: '🔵 CLEANING', color: '#38bdf8' },
  'Clean':                 { label: '🟢 CLEAN',    color: '#34d399' },
  'Vacant Ready':          { label: '🟢 READY',    color: '#34d399' },
  'Inspected':             { label: '🟣 INSPECTED', color: '#a78bfa' },
  'Out Of Order':          { label: '⚠ OUT OF ORDER', color: '#fbbf24' },
  'Do Not Disturb':        { label: '⛔ DO NOT DISTURB', color: '#94a3b8' }
};

export default function HousekeepingDashboard() {
  const { adminUser, adminToken, logout } = useContext(AdminAuthContext);

  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);

  const socketRef = useRef(null);
  const myUid = adminUser?.uid;

  const fetchRooms = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`${API_URL}/housekeeping/rooms`, {
        headers: getApiHeaders(adminToken)
      });
      if (!res.ok) throw new Error('Failed to load housekeeping rooms');
      const data = await res.json();
      setRooms(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[HousekeepingDashboard] fetch error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [adminToken]);

  useEffect(() => {
    fetchRooms();
  }, [fetchRooms]);

  useEffect(() => {
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      fetchRooms(); // resync with server authority on (re)connect
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('housekeeping_update', () => fetchRooms());

    return () => socket.disconnect();
  }, [fetchRooms]);

  const handleStatusChange = async (roomId, newStatus) => {
    setUpdatingId(roomId);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/housekeeping/update-status`, {
        method: 'POST',
        headers: getApiHeaders(adminToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ roomId, status: newStatus })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update status');
      }
      await fetchRooms();
    } catch (err) {
      setError(err.message);
      fetchRooms();
    } finally {
      setUpdatingId(null);
    }
  };

  const handleLogout = () => {
    logout();
    window.location.href = '/admin/login';
  };

  const myRooms = rooms.filter(r => myUid && String(r.housekeeping_assigned_to) === String(myUid));
  const pendingRooms  = myRooms.filter(r => r.housekeeping_status === 'Dirty');
  const inProgress    = myRooms.filter(r => r.housekeeping_status === 'Cleaning In Progress');
  const doneRooms     = myRooms.filter(r => ['Clean', 'Vacant Ready', 'Inspected'].includes(r.housekeeping_status));

  return (
    <div style={{
      minHeight: '100vh', background: '#0b0f17', color: '#f1f5f9',
      fontFamily: 'var(--font-body, Inter, sans-serif)', display: 'flex', flexDirection: 'column'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '18px 28px', borderBottom: '2px solid rgba(74,222,128,0.25)',
        background: 'linear-gradient(180deg, rgba(74,222,128,0.06), transparent)',
        flexWrap: 'wrap', gap: '12px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{
            width: '52px', height: '52px', borderRadius: '14px',
            background: 'linear-gradient(135deg, rgba(74,222,128,0.3), rgba(16,185,129,0.25))',
            border: '1px solid rgba(74,222,128,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.8rem'
          }}>
            🧹
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: '900', letterSpacing: '0.4px' }}>
              HOUSEKEEPING
            </h1>
            <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.45)', fontWeight: '600' }}>
              HOTEL SKY-5
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            padding: '8px 16px', borderRadius: '10px',
            background: connected ? 'rgba(52,211,153,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${connected ? 'rgba(52,211,153,0.4)' : 'rgba(239,68,68,0.4)'}`,
            color: connected ? '#34d399' : '#f87171', fontWeight: '800', fontSize: '0.85rem'
          }}>
            {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
            {connected ? '🟢 Connected' : '🔴 Connection Lost'}
          </div>

          <button
            onClick={fetchRooms}
            disabled={loading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '8px 14px', background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px',
              color: '#fff', fontSize: '0.85rem', fontWeight: '700', cursor: 'pointer'
            }}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Sync
          </button>

          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: '700' }}>
              {(adminUser?.fullName || adminUser?.full_name || 'HOUSEKEEPING STAFF').toUpperCase()}
            </div>
            <button
              onClick={handleLogout}
              style={{ background: 'transparent', border: 'none', color: '#f87171', fontSize: '0.78rem', fontWeight: '700', cursor: 'pointer', padding: 0 }}
            >
              Logout
            </button>
          </div>
        </div>
      </div>

      {/* Stat Counts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', padding: '20px 28px 0 28px' }}>
        <StatCard label="TO CLEAN" count={pendingRooms.length} color="#f87171" />
        <StatCard label="IN PROGRESS" count={inProgress.length} color="#38bdf8" />
        <StatCard label="DONE" count={doneRooms.length} color="#34d399" />
      </div>

      {error && (
        <div style={{
          margin: '16px 28px 0 28px', background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.3)', color: '#f87171',
          padding: '12px 16px', borderRadius: '10px', fontSize: '0.9rem',
          display: 'flex', alignItems: 'center', gap: '8px'
        }}>
          <AlertTriangle size={18} /> {error}
        </div>
      )}

      {/* Board */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', padding: '20px 28px 28px 28px', flex: 1, minHeight: 0 }}>
        <RoomColumn title="To Clean" color="#f87171" rooms={pendingRooms} onStatusChange={handleStatusChange} updatingId={updatingId} />
        <RoomColumn title="In Progress" color="#38bdf8" rooms={inProgress} onStatusChange={handleStatusChange} updatingId={updatingId} />
        <RoomColumn title="Done" color="#34d399" rooms={doneRooms} onStatusChange={handleStatusChange} updatingId={updatingId} />
      </div>
    </div>
  );
}

function StatCard({ label, count, color }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${color}33`, borderRadius: '14px', padding: '16px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: '2.4rem', fontWeight: '900', color }}>{count}</div>
      <div style={{ fontSize: '0.8rem', fontWeight: '800', letterSpacing: '0.5px', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}

function RoomColumn({ title, color, rooms, onStatusChange, updatingId }) {
  return (
    <div style={{ background: 'rgba(15,23,42,0.6)', border: `1px solid ${color}33`, borderRadius: '16px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: color }} />
        <span style={{ fontWeight: '800', fontSize: '1rem' }}>{title}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {rooms.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 10px', color: 'rgba(255,255,255,0.2)' }}>
            <Inbox size={28} style={{ marginBottom: '8px' }} />
            <div style={{ fontSize: '0.9rem' }}>No rooms in this stage</div>
          </div>
        ) : (
          rooms.map(room => (
            <RoomCard key={room.id} room={room} onStatusChange={onStatusChange} isUpdating={updatingId === room.id} />
          ))
        )}
      </div>
    </div>
  );
}

function RoomCard({ room, onStatusChange, isUpdating }) {
  const badge = STATUS_BADGE[room.housekeeping_status] || { label: room.housekeeping_status, color: '#94a3b8' };
  const canStart = room.housekeeping_status === 'Dirty';
  const canComplete = room.housekeeping_status === 'Cleaning In Progress';

  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)', border: '1.5px solid rgba(255,255,255,0.1)',
      borderRadius: '14px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px'
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div>
          <div style={{ fontSize: '1.5rem', fontWeight: '900', color: '#4ade80', letterSpacing: '0.3px' }}>
            Room {room.number}
          </div>
          <div style={{ fontSize: '0.85rem', fontWeight: '700', color: 'rgba(255,255,255,0.6)', marginTop: '2px', textTransform: 'capitalize' }}>
            {room.occupancy_status}
            {room.guest_name ? ` — ${room.guest_name}` : ''}
          </div>
        </div>
        <span style={{
          flexShrink: 0, padding: '4px 10px', borderRadius: '20px', fontSize: '0.7rem', fontWeight: '900',
          letterSpacing: '0.3px', color: badge.color, background: `${badge.color}22`, border: `1px solid ${badge.color}55`
        }}>
          {badge.label}
        </span>
      </div>

      {room.housekeeping_priority === 'High Priority' && (
        <div style={{ fontSize: '0.78rem', fontWeight: '800', color: '#fbbf24', background: 'rgba(251,191,36,0.1)', padding: '5px 10px', borderRadius: '6px', alignSelf: 'flex-start' }}>
          ⚠ High Priority
        </div>
      )}

      <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.45)', display: 'flex', alignItems: 'center', gap: '5px' }}>
        <Clock size={13} /> Last cleaned: {formatTime(room.last_cleaned_at)}
      </div>

      {(canStart || canComplete) && (
        <div style={{ paddingTop: '4px' }}>
          {canStart && (
            <ActionButton
              icon={Sparkles}
              label="Start Cleaning"
              bg="linear-gradient(135deg, #38bdf8, #0ea5e9)"
              disabled={isUpdating}
              onClick={() => onStatusChange(room.id, 'Cleaning In Progress')}
            />
          )}
          {canComplete && (
            <ActionButton
              icon={CheckCircle}
              label="Mark Clean"
              bg="linear-gradient(135deg, #10b981, #059669)"
              disabled={isUpdating}
              onClick={() => onStatusChange(room.id, 'Clean')}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ActionButton({ icon: Icon, label, bg, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', padding: '14px', background: bg, border: 'none',
        borderRadius: '10px', color: '#fff', fontWeight: '900', fontSize: '1rem',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', letterSpacing: '0.3px'
      }}
    >
      <Icon size={18} /> {disabled ? 'Updating…' : label.toUpperCase()}
    </button>
  );
}
