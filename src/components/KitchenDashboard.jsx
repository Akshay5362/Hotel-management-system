/**
 * src/components/KitchenDashboard.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase F3 — Dedicated Kitchen Login + Kitchen Dashboard.
 *
 * A purpose-built, distraction-free operational screen for kitchen staff
 * (chef / kitchen helper / pantry). This is NOT a second implementation of
 * the kitchen order lifecycle — it calls the exact same endpoints and listens
 * to the exact same Socket.IO events as the Admin/Reception-embedded
 * FoodKitchenDisplay.jsx (which remains monitoring-only and untouched):
 *
 *   GET  /api/food/orders/kds        — active order queue
 *   PUT  /api/food/orders/:id/status — RECEIVE / START PREPARING / MARK READY
 *                                       (already kitchen-role-gated server-side,
 *                                       independent of this screen entirely)
 *   food:order_placed, food:status_changed, food:order_modified — sockets
 *
 * No order creation, no commercial/item editing, no payment/billing surface —
 * only what a kitchen worker needs: what to prepare, where it goes, who
 * ordered it, special instructions, how long it has waited, and the single
 * next action.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useContext, useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import {
  Clock, Flame, CheckCircle, ChefHat, RefreshCw,
  AlertTriangle, Wifi, WifiOff, Inbox
} from 'lucide-react';
import { AdminAuthContext } from '../contexts/AdminAuthContext';
import { API_URL, SOCKET_URL, getApiHeaders } from '../config/apiConfig';

function getElapsedSeconds(isoString) {
  if (!isoString) return 0;
  const diff = Date.now() - new Date(isoString).getTime();
  return Math.max(0, Math.floor(diff / 1000));
}

function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDurationLong(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m} min ${s} sec`;
}

function formatTime(isoString) {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return '—';
  }
}

function destinationLabel(order) {
  switch (order.destination_type) {
    case 'ROOM':  return `Room ${order.room_number || '—'}`;
    case 'TABLE': return `Table ${order.table_name || '—'}`;
    case 'STAFF': return `Staff: ${order.staff_name || '—'}`;
    case 'OWNER': return `VIP: ${order.owner_name || '—'}`;
    default:      return order.destination_type || '—';
  }
}

export default function KitchenDashboard() {
  const { adminUser, adminToken, logout } = useContext(AdminAuthContext);

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);
  const [, setNowTick] = useState(Date.now()); // forces elapsed-time re-render
  const [modifiedBanners, setModifiedBanners] = useState({});
  const [selectedOrderId, setSelectedOrderId] = useState(null);

  const socketRef = useRef(null);

  // Live elapsed-time refresh — a UI-only ticking clock computed from the
  // stored server timestamp each render, not business-date logic. Ticking
  // every second is purely a local re-render — it never writes to Firestore.
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const fetchActiveQueue = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`${API_URL}/food/orders/kds`, {
        headers: getApiHeaders(adminToken)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch kitchen queue');
      setOrders(data.orders || []);
    } catch (err) {
      console.error('[KitchenDashboard] Fetch queue error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [adminToken]);

  useEffect(() => {
    fetchActiveQueue();
  }, [fetchActiveQueue]);

  useEffect(() => {
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      fetchActiveQueue(); // resync with server authority on (re)connect
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    socket.on('food:order_placed', () => {
      fetchActiveQueue();
    });

    socket.on('food:status_changed', ({ order_id, new_status }) => {
      if (['OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED'].includes(new_status)) {
        setOrders(prev => prev.filter(o => o.order_id !== order_id));
      } else {
        setOrders(prev => prev.map(o => o.order_id === order_id ? { ...o, order_status: new_status } : o));
      }
    });

    socket.on('food:order_modified', ({ order_id, changes }) => {
      setModifiedBanners(prev => ({ ...prev, [order_id]: { changes: changes || [], ts: Date.now() } }));
      fetchActiveQueue();
    });

    return () => socket.disconnect();
  }, [fetchActiveQueue]);

  const handleTransition = async (orderId, nextStatus) => {
    setUpdatingId(orderId);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/food/orders/${orderId}/status`, {
        method: 'PUT',
        headers: getApiHeaders(adminToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ next_status: nextStatus })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to transition to ${nextStatus}`);
      // Re-sync from the server rather than patching only order_status locally —
      // the transition also stamps a kitchen_*_at timestamp server-side that the
      // card display needs (Received:/Started:/Ready: times).
      await fetchActiveQueue();
    } catch (err) {
      setError(err.message);
      fetchActiveQueue();
    } finally {
      setUpdatingId(null);
    }
  };

  // Keyboard shortcuts — this entire screen is already kitchen-role-gated at
  // the route level (RoleProtectedRoute on /kitchen/dashboard), so a global
  // listener here can never be reached by Admin/Reception. Each key only
  // fires the transition actually valid for the selected order's current
  // state, mirroring the backend's own VALID_TRANSITIONS — no skipping.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!selectedOrderId || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      const targetOrder = orders.find(o => o.order_id === selectedOrderId);
      if (!targetOrder) return;

      if (e.key === '1' && targetOrder.order_status === 'PLACED') {
        handleTransition(selectedOrderId, 'RECEIVED');
      } else if (e.key === '2' && targetOrder.order_status === 'RECEIVED') {
        handleTransition(selectedOrderId, 'PREPARING');
      } else if (e.key === '3' && targetOrder.order_status === 'PREPARING') {
        handleTransition(selectedOrderId, 'READY');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrderId, orders]);

  const dismissBanner = (orderId) => {
    setModifiedBanners(prev => {
      const next = { ...prev };
      delete next[orderId];
      return next;
    });
  };

  const handleLogout = () => {
    logout();
    window.location.href = '/admin/login';
  };

  const newReceivedOrders = orders.filter(o => ['PLACED', 'RECEIVED'].includes(o.order_status));
  const preparingOrders   = orders.filter(o => o.order_status === 'PREPARING');
  const readyOrders       = orders.filter(o => o.order_status === 'READY');

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0b0f17',
      color: '#f1f5f9',
      fontFamily: 'var(--font-body, Inter, sans-serif)',
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '18px 28px',
        borderBottom: '2px solid rgba(251,146,60,0.25)',
        background: 'linear-gradient(180deg, rgba(251,146,60,0.06), transparent)',
        flexWrap: 'wrap',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{
            width: '52px', height: '52px', borderRadius: '14px',
            background: 'linear-gradient(135deg, rgba(251,146,60,0.3), rgba(239,68,68,0.25))',
            border: '1px solid rgba(251,146,60,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.8rem'
          }}>
            🍳
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: '900', letterSpacing: '0.4px' }}>
              KITCHEN DISPLAY
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
            color: connected ? '#34d399' : '#f87171',
            fontWeight: '800', fontSize: '0.85rem'
          }}>
            {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
            {connected ? '🟢 Kitchen Connected' : '🔴 Connection Lost'}
          </div>

          <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', padding: '6px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
            Select an order, then: <strong style={{ color: '#38bdf8' }}>1</strong> Receive · <strong style={{ color: '#fbbf24' }}>2</strong> Prepare · <strong style={{ color: '#34d399' }}>3</strong> Ready
          </div>

          <button
            onClick={fetchActiveQueue}
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
              {(adminUser?.fullName || adminUser?.full_name || 'KITCHEN STAFF').toUpperCase()}
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
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px',
        padding: '20px 28px 0 28px'
      }}>
        <StatCard label="NEW / RECEIVED" count={newReceivedOrders.length} color="#38bdf8" />
        <StatCard label="PREPARING" count={preparingOrders.length} color="#fbbf24" />
        <StatCard label="READY" count={readyOrders.length} color="#34d399" />
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
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px',
        padding: '20px 28px 28px 28px', flex: 1, minHeight: 0
      }}>
        <KitchenColumn
          title="New / Received"
          color="#38bdf8"
          orders={newReceivedOrders}
          onTransition={handleTransition}
          updatingId={updatingId}
          stage="RECEIVE"
          modifiedBanners={modifiedBanners}
          onDismissBanner={dismissBanner}
          selectedOrderId={selectedOrderId}
          onSelectOrder={setSelectedOrderId}
        />
        <KitchenColumn
          title="Preparing"
          color="#fbbf24"
          orders={preparingOrders}
          onTransition={handleTransition}
          updatingId={updatingId}
          stage="PREPARING"
          modifiedBanners={modifiedBanners}
          onDismissBanner={dismissBanner}
          selectedOrderId={selectedOrderId}
          onSelectOrder={setSelectedOrderId}
        />
        <KitchenColumn
          title="Ready"
          color="#34d399"
          orders={readyOrders}
          onTransition={handleTransition}
          updatingId={updatingId}
          stage="READY"
          modifiedBanners={modifiedBanners}
          onDismissBanner={dismissBanner}
          selectedOrderId={selectedOrderId}
          onSelectOrder={setSelectedOrderId}
        />
      </div>
    </div>
  );
}

function StatCard({ label, count, color }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)', border: `1px solid ${color}33`,
      borderRadius: '14px', padding: '16px 20px', textAlign: 'center'
    }}>
      <div style={{ fontSize: '2.4rem', fontWeight: '900', color }}>{count}</div>
      <div style={{ fontSize: '0.8rem', fontWeight: '800', letterSpacing: '0.5px', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' }}>
        {label}
      </div>
    </div>
  );
}

function KitchenColumn({ title, color, orders, onTransition, updatingId, stage, modifiedBanners, onDismissBanner, selectedOrderId, onSelectOrder }) {
  return (
    <div style={{
      background: 'rgba(15,23,42,0.6)', border: `1px solid ${color}33`,
      borderRadius: '16px', display: 'flex', flexDirection: 'column', minHeight: 0
    }}>
      <div style={{
        padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', alignItems: 'center', gap: '8px'
      }}>
        <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: color }} />
        <span style={{ fontWeight: '800', fontSize: '1rem' }}>{title}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {orders.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 10px', color: 'rgba(255,255,255,0.2)' }}>
            <Inbox size={28} style={{ marginBottom: '8px' }} />
            <div style={{ fontSize: '0.9rem' }}>No orders in this stage</div>
          </div>
        ) : (
          orders.map(order => (
            <KitchenCard
              key={order.order_id}
              order={order}
              onTransition={onTransition}
              isUpdating={updatingId === order.order_id}
              stage={stage}
              modifiedBanner={modifiedBanners?.[order.order_id]}
              onDismissBanner={onDismissBanner}
              isSelected={selectedOrderId === order.order_id}
              onSelect={() => onSelectOrder(order.order_id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

const STATUS_BADGE = {
  PLACED:    { label: '🆕 NEW',    color: '#38bdf8' },
  RECEIVED:  { label: 'RECEIVED',  color: '#22d3ee' },
  PREPARING: { label: 'PREPARING', color: '#fbbf24' },
  READY:     { label: '🟢 READY',  color: '#34d399' }
};

function KitchenCard({ order, onTransition, isUpdating, stage, modifiedBanner, onDismissBanner, isSelected, onSelect }) {
  const isPlaced = order.order_status === 'PLACED';
  const waitingSec = getElapsedSeconds(isPlaced ? order.created_at : order.kitchen_received_at || order.created_at);
  const preparingSec = getElapsedSeconds(order.kitchen_preparing_at);
  const readyDurationSec = (order.kitchen_ready_at && order.kitchen_preparing_at)
    ? Math.max(0, Math.floor((new Date(order.kitchen_ready_at).getTime() - new Date(order.kitchen_preparing_at).getTime()) / 1000))
    : null;
  const badge = STATUS_BADGE[order.order_status] || { label: order.order_status, color: '#94a3b8' };

  let urgencyBorder = isSelected ? '#38bdf8' : 'rgba(255,255,255,0.1)';
  const referenceMin = (stage === 'PREPARING' ? preparingSec : waitingSec) / 60;
  if (!isSelected) {
    if (referenceMin > 25) urgencyBorder = 'rgba(239,68,68,0.5)';
    else if (referenceMin > 15) urgencyBorder = 'rgba(251,191,36,0.4)';
  }

  return (
    <div
      onClick={onSelect}
      style={{
        background: isSelected ? 'rgba(56,189,248,0.06)' : 'rgba(255,255,255,0.03)',
        border: `1.5px solid ${urgencyBorder}`,
        borderRadius: '14px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px',
        cursor: 'pointer', transition: 'border-color 150ms ease, background 150ms ease'
      }}
    >
      {modifiedBanner && (
        <div style={{
          background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.4)',
          borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '5px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: '900', color: '#fbbf24' }}>
            <AlertTriangle size={15} /> KOT MODIFIED
          </div>
          {(modifiedBanner.changes || []).map((c, idx) => (
            <span key={idx} style={{
              fontSize: '0.82rem', fontWeight: '700',
              color: c.type === 'ADDED' ? '#4ade80' : c.type === 'REMOVED' ? '#f87171' : '#fbbf24'
            }}>
              {c.type === 'ADDED' && `+ ${c.item_name} × ${c.new_qty}`}
              {c.type === 'REMOVED' && `− ${c.item_name} × ${c.prev_qty}`}
              {c.type === 'QTY_CHANGED' && `${c.item_name}: ${c.prev_qty} → ${c.new_qty}`}
            </span>
          ))}
          <button
            onClick={(e) => { e.stopPropagation(); onDismissBanner?.(order.order_id); }}
            style={{
              alignSelf: 'flex-start', marginTop: '2px', padding: '4px 12px',
              background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.4)',
              borderRadius: '6px', color: '#fbbf24', fontWeight: '800', fontSize: '0.75rem', cursor: 'pointer'
            }}
          >
            Got it
          </button>
        </div>
      )}

      {/* KOT + status + destination */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div>
          <div style={{ fontSize: '1.3rem', fontWeight: '900', color: '#38bdf8', letterSpacing: '0.3px' }}>
            {order.order_number || order.order_id}
          </div>
          <div style={{ fontSize: '0.72rem', fontWeight: '700', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.4px', marginTop: '2px' }}>
            {order.destination_type || '—'}
          </div>
          <div style={{ fontSize: '1rem', fontWeight: '800', color: '#f1f5f9', marginTop: '1px' }}>
            {destinationLabel(order)}
          </div>
        </div>
        <span style={{
          flexShrink: 0, padding: '4px 10px', borderRadius: '20px', fontSize: '0.72rem', fontWeight: '900',
          letterSpacing: '0.3px', color: badge.color, background: `${badge.color}22`, border: `1px solid ${badge.color}55`
        }}>
          {badge.label}
        </span>
      </div>

      {/* Guest / Waiter */}
      <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {order.guest_name && (
          <span>Guest: <strong style={{ color: '#fff' }}>{order.guest_name}</strong></span>
        )}
        <span>Waiter: <strong style={{ color: '#fff' }}>{order.waiter_name || 'Assigned'}</strong></span>
      </div>

      {/* Items */}
      <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {(order.items || []).map((item, idx) => (
          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '1rem' }}>
            <span style={{
              fontWeight: '900', color: '#fbbf24', background: 'rgba(251,191,36,0.15)',
              padding: '2px 8px', borderRadius: '5px', minWidth: '2.2em', textAlign: 'center'
            }}>
              {item.quantity}×
            </span>
            <span style={{ color: '#f1f5f9', fontWeight: '700' }}>{item.item_name}</span>
          </div>
        ))}
      </div>

      {/* Special Instructions */}
      {order.remarks && (
        <div style={{
          fontSize: '0.85rem', color: '#fbbf24', fontWeight: '600', fontStyle: 'italic',
          background: 'rgba(251,191,36,0.08)', padding: '8px 12px', borderRadius: '8px'
        }}>
          Special Instructions: {order.remarks}
        </div>
      )}

      {/* Timing */}
      <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.5)', display: 'flex', flexDirection: 'column', gap: '3px' }}>
        {stage === 'RECEIVE' && isPlaced && (
          <>
            <span>Ordered At: <strong style={{ color: '#fff' }}>{formatTime(order.created_at)}</strong></span>
            <TimeBadge label="Elapsed" seconds={waitingSec} />
          </>
        )}
        {stage === 'RECEIVE' && !isPlaced && (
          <>
            <span>Received: <strong style={{ color: '#fff' }}>{formatTime(order.kitchen_received_at)}</strong></span>
            <TimeBadge label="Elapsed" seconds={waitingSec} />
          </>
        )}
        {stage === 'PREPARING' && (
          <>
            <span>Started: <strong style={{ color: '#fff' }}>{formatTime(order.kitchen_preparing_at)}</strong></span>
            <TimeBadge label="Preparing" seconds={preparingSec} />
          </>
        )}
        {stage === 'READY' && (
          <>
            <span>Ready at: <strong style={{ color: '#fff' }}>{formatTime(order.kitchen_ready_at)}</strong></span>
            {readyDurationSec !== null && (
              <span>Preparation Time: <strong style={{ color: '#fff' }}>{formatDurationLong(readyDurationSec)}</strong></span>
            )}
            <span style={{ color: '#34d399', fontWeight: '700' }}>✓ Waiting for pickup</span>
          </>
        )}
      </div>

      {/* Next Action */}
      <div style={{ paddingTop: '4px' }}>
        {stage === 'RECEIVE' && isPlaced && (
          <ActionButton
            icon={ChefHat}
            label="Receive Order"
            bg="linear-gradient(135deg, #38bdf8, #0ea5e9)"
            disabled={isUpdating}
            onClick={() => onTransition(order.order_id, 'RECEIVED')}
          />
        )}
        {stage === 'RECEIVE' && !isPlaced && (
          <ActionButton
            icon={Flame}
            label="Start Preparing"
            bg="linear-gradient(135deg, #f59e0b, #d97706)"
            disabled={isUpdating}
            onClick={() => onTransition(order.order_id, 'PREPARING')}
          />
        )}
        {stage === 'PREPARING' && (
          <ActionButton
            icon={CheckCircle}
            label="Mark Ready"
            bg="linear-gradient(135deg, #10b981, #059669)"
            disabled={isUpdating}
            onClick={() => onTransition(order.order_id, 'READY')}
          />
        )}
      </div>
    </div>
  );
}

function TimeBadge({ label, seconds }) {
  const minutes = seconds / 60;
  const color = minutes > 20 ? '#f87171' : minutes > 10 ? '#fbbf24' : '#34d399';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color, fontWeight: '800', fontVariantNumeric: 'tabular-nums' }}>
      <Clock size={13} /> {label}: {formatDuration(seconds)}
    </span>
  );
}

function ActionButton({ icon: Icon, label, bg, disabled, onClick }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      style={{
        width: '100%', padding: '14px', background: bg, border: 'none',
        borderRadius: '10px', color: '#fff', fontWeight: '900', fontSize: '1rem',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        letterSpacing: '0.3px'
      }}
    >
      <Icon size={18} /> {disabled ? 'Updating…' : label.toUpperCase()}
    </button>
  );
}
