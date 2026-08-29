/**
 * src/components/food/FoodKitchenDisplay.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2C — Hotel Kitchen Display System (KDS).
 *
 * Designed specifically for kitchen chefs and pantry staff:
 *   - Real-time Socket.IO synchronization (`food:order_placed`, `food:status_changed`, `food:order_cancelled`).
 *   - Full reconnect / resync reconciliation from Firestore server authority.
 *   - Three operational columns: NEW / RECEIVED, PREPARING, READY.
 *   - Visual urgency indicators based on elapsed time (>15 min yellow, >25 min red).
 *   - Keyboard shortcuts for rapid touch/hardware workflows (1: Receive, 2: Prepare, 3: Ready).
 *   - Complete separation from guest billing & payments.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import {
  Clock, Flame, CheckCircle, ChefHat, RefreshCw,
  AlertTriangle, Volume2, Wifi, WifiOff, ArrowRight,
  Utensils, Hash, User, Home, Layers, Check
} from 'lucide-react';
import { API_URL, SOCKET_URL, getApiHeaders } from '../../config/apiConfig';

const COLUMNS = [
  { key: 'RECEIVED',  label: 'New & Received', color: '#38bdf8', icon: ChefHat },
  { key: 'PREPARING', label: 'Preparing',     color: '#fbbf24', icon: Flame },
  { key: 'READY',     label: 'Ready / Dispatch', color: '#34d399', icon: CheckCircle }
];

function getElapsedMinutes(isoString) {
  if (!isoString) return 0;
  const diff = Date.now() - new Date(isoString).getTime();
  return Math.max(0, Math.floor(diff / 60000));
}

export default function FoodKitchenDisplay({ token, user }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [updatingId, setUpdatingId] = useState(null);
  const [now, setNow] = useState(Date.now());

  const socketRef = useRef(null);

  // Update live elapsed time every 30 seconds
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  // ── 1. Fetch Authoritative Active Orders from Server ────────────────────────
  const fetchActiveQueue = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`${API_URL}/food/orders/kds`, {
        headers: getApiHeaders(token)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch kitchen queue');

      setOrders(data.orders || []);
    } catch (err) {
      console.error('[KDS] Fetch queue error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Initial load
  useEffect(() => {
    fetchActiveQueue();
  }, [fetchActiveQueue]);

  // ── 2. Socket.IO Real-time Connection & Reconnect Reconciliation ─────────────
  useEffect(() => {
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[KDS] Real-time socket connected');
      setConnected(true);
      // Re-sync with server authority upon reconnect
      fetchActiveQueue();
    });

    socket.on('disconnect', () => {
      console.log('[KDS] Socket disconnected. Waiting to reconnect...');
      setConnected(false);
    });

    // Event 1: New order placed -> Add to queue if not present
    socket.on('food:order_placed', (newOrderSummary) => {
      console.log('[KDS] Received food:order_placed:', newOrderSummary);
      fetchActiveQueue();
    });

    // Event 2: Order status changed -> Reconcile state
    socket.on('food:status_changed', ({ order_id, new_status }) => {
      console.log('[KDS] Received food:status_changed:', order_id, new_status);
      if (['OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED'].includes(new_status)) {
        // Remove from active kitchen queue
        setOrders(prev => prev.filter(o => o.order_id !== order_id));
      } else {
        setOrders(prev => prev.map(o => o.order_id === order_id ? { ...o, order_status: new_status } : o));
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [fetchActiveQueue]);

  // ── 3. State Machine Status Transitions ────────────────────────────────────
  const handleTransition = async (orderId, nextStatus) => {
    setUpdatingId(orderId);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/food/orders/${orderId}/status`, {
        method: 'PUT',
        headers: getApiHeaders(token),
        body: JSON.stringify({ next_status: nextStatus })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to transition to ${nextStatus}`);

      // Optimistic update reconciled by socket
      setOrders(prev => prev.map(o => o.order_id === orderId ? { ...o, order_status: nextStatus } : o));
    } catch (err) {
      alert(`Transition Error: ${err.message}`);
      // Re-sync to ensure no corrupted UI state
      fetchActiveQueue();
    } finally {
      setUpdatingId(null);
    }
  };

  // ── 4. Keyboard Shortcuts Workflow ──────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!selectedOrderId || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      const targetOrder = orders.find(o => o.order_id === selectedOrderId);
      if (!targetOrder) return;

      if (e.key === '1' && targetOrder.order_status === 'PLACED') {
        handleTransition(selectedOrderId, 'RECEIVED');
      } else if (e.key === '2' && ['PLACED', 'RECEIVED'].includes(targetOrder.order_status)) {
        handleTransition(selectedOrderId, 'PREPARING');
      } else if (e.key === '3' && targetOrder.order_status === 'PREPARING') {
        handleTransition(selectedOrderId, 'READY');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedOrderId, orders]);

  // Filter columns
  const receivedOrders = orders.filter(o => ['PLACED', 'RECEIVED'].includes(o.order_status));
  const preparingOrders = orders.filter(o => o.order_status === 'PREPARING');
  const readyOrders     = orders.filter(o => o.order_status === 'READY');

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      color: '#f1f5f9',
      fontFamily: 'var(--font-body, Inter, sans-serif)'
    }}>
      {/* Header Bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0 0 16px 0',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        marginBottom: '16px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, rgba(251,146,60,0.25), rgba(239,68,68,0.25))',
            border: '1px solid rgba(251,146,60,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.3rem'
          }}>
            👨‍🍳
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.2rem', fontWeight: '800', letterSpacing: '0.3px' }}>
              Kitchen Display System (KDS)
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px', fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)' }}>
              <span>Live Restaurant Line & Pantry Queue</span>
              <span>•</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: connected ? '#34d399' : '#f87171', fontWeight: '700' }}>
                {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
                {connected ? 'Real-time Connected' : 'Connecting / Polling'}
              </span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', padding: '6px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
            Keys: <strong style={{ color: '#38bdf8' }}>1: Receive</strong> | <strong style={{ color: '#fbbf24' }}>2: Prepare</strong> | <strong style={{ color: '#34d399' }}>3: Ready</strong>
          </div>

          <button
            onClick={fetchActiveQueue}
            disabled={loading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 14px',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.82rem',
              fontWeight: '600',
              cursor: 'pointer'
            }}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Sync
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.3)',
          color: '#f87171',
          padding: '10px 16px',
          borderRadius: '8px',
          marginBottom: '14px',
          fontSize: '0.85rem',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {/* 3-Column KDS Board */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: '16px',
        flex: 1,
        minHeight: 0
      }}>
        {/* COLUMN 1: NEW & RECEIVED */}
        <KDSColumn
          title="New & Received"
          color="#38bdf8"
          orders={receivedOrders}
          selectedOrderId={selectedOrderId}
          onSelectOrder={setSelectedOrderId}
          onTransition={handleTransition}
          updatingId={updatingId}
          actionType="START_PREPARING"
        />

        {/* COLUMN 2: PREPARING */}
        <KDSColumn
          title="Preparing"
          color="#fbbf24"
          orders={preparingOrders}
          selectedOrderId={selectedOrderId}
          onSelectOrder={setSelectedOrderId}
          onTransition={handleTransition}
          updatingId={updatingId}
          actionType="MARK_READY"
        />

        {/* COLUMN 3: READY */}
        <KDSColumn
          title="Ready / Dispatch"
          color="#34d399"
          orders={readyOrders}
          selectedOrderId={selectedOrderId}
          onSelectOrder={setSelectedOrderId}
          onTransition={handleTransition}
          updatingId={updatingId}
          actionType="DISPATCH"
        />
      </div>
    </div>
  );
}

function KDSColumn({ title, color, orders, selectedOrderId, onSelectOrder, onTransition, updatingId, actionType }) {
  return (
    <div style={{
      background: 'rgba(15, 23, 42, 0.6)',
      border: `1px solid rgba(${color === '#38bdf8' ? '56,189,248' : color === '#fbbf24' ? '251,191,36' : '52,211,153'}, 0.2)`,
      borderRadius: '14px',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0
    }}>
      {/* Column Header */}
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: color }} />
          <span style={{ fontWeight: '800', fontSize: '0.95rem', color: '#f1f5f9' }}>{title}</span>
        </div>
        <span style={{
          fontSize: '0.75rem',
          fontWeight: '800',
          padding: '2px 8px',
          borderRadius: '10px',
          background: `rgba(255,255,255,0.06)`,
          color: color
        }}>
          {orders.length}
        </span>
      </div>

      {/* Cards List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {orders.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 10px', color: 'rgba(255,255,255,0.2)', fontSize: '0.85rem' }}>
            No orders in this stage
          </div>
        ) : (
          orders.map(order => (
            <KDSCard
              key={order.order_id}
              order={order}
              isSelected={selectedOrderId === order.order_id}
              onSelect={() => onSelectOrder(order.order_id)}
              onTransition={onTransition}
              isUpdating={updatingId === order.order_id}
              actionType={actionType}
            />
          ))
        )}
      </div>
    </div>
  );
}

function KDSCard({ order, isSelected, onSelect, onTransition, isUpdating, actionType }) {
  const elapsedMin = getElapsedMinutes(order.created_at);

  // Urgency colors
  let urgencyBg = 'rgba(255,255,255,0.03)';
  let urgencyBorder = 'rgba(255,255,255,0.08)';
  if (elapsedMin > 25) {
    urgencyBg = 'rgba(239,68,68,0.12)';
    urgencyBorder = 'rgba(239,68,68,0.4)';
  } else if (elapsedMin > 15) {
    urgencyBg = 'rgba(251,191,36,0.1)';
    urgencyBorder = 'rgba(251,191,36,0.3)';
  }

  if (isSelected) {
    urgencyBorder = '#38bdf8';
  }

  return (
    <div
      onClick={onSelect}
      style={{
        background: urgencyBg,
        border: `1px solid ${urgencyBorder}`,
        borderRadius: '12px',
        padding: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        cursor: 'pointer',
        transition: 'all 0.15s ease'
      }}
    >
      {/* Top Card Row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <span style={{ fontSize: '1.05rem', fontWeight: '900', color: '#38bdf8', letterSpacing: '0.4px' }}>
            {order.order_number || order.order_id}
          </span>
          <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.7)', fontWeight: '700', marginTop: '2px' }}>
            {order.destination_type === 'ROOM' && `Room ${order.room_number}`}
            {order.destination_type === 'TABLE' && `Table: ${order.table_name}`}
            {order.destination_type === 'STAFF' && `Staff: ${order.staff_name}`}
            {order.destination_type === 'OWNER' && `VIP: ${order.owner_name}`}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '0.72rem',
            fontWeight: '800',
            color: elapsedMin > 20 ? '#f87171' : elapsedMin > 10 ? '#fbbf24' : '#34d399',
            background: 'rgba(0,0,0,0.3)',
            padding: '2px 8px',
            borderRadius: '6px'
          }}>
            <Clock size={12} /> {elapsedMin}m ago
          </div>
        </div>
      </div>

      {/* Items List */}
      <div style={{
        background: 'rgba(0,0,0,0.25)',
        borderRadius: '8px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px'
      }}>
        {(order.items || []).map((item, idx) => (
          <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.86rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                fontSize: '0.82rem',
                fontWeight: '900',
                color: '#fbbf24',
                background: 'rgba(251,191,36,0.15)',
                padding: '1px 6px',
                borderRadius: '4px'
              }}>
                {item.quantity}×
              </span>
              <span style={{ color: '#f1f5f9', fontWeight: '600' }}>
                {item.item_name}
              </span>
            </div>
            <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>
              {item.kot_type || 'KITCHEN'}
            </span>
          </div>
        ))}
      </div>

      {/* Remarks */}
      {order.remarks && (
        <div style={{ fontSize: '0.78rem', color: '#fbbf24', fontStyle: 'italic', background: 'rgba(251,191,36,0.08)', padding: '6px 10px', borderRadius: '6px' }}>
          Note: {order.remarks}
        </div>
      )}

      {/* Waiter Provenance */}
      <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', display: 'flex', justifyContent: 'space-between' }}>
        <span>Server: <strong style={{ color: '#fff' }}>{order.waiter_name || 'Assigned'}</strong></span>
        <span>Items: {order.items?.length || 0}</span>
      </div>

      {/* Action Buttons */}
      <div style={{ paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        {actionType === 'START_PREPARING' && (
          <div style={{ display: 'flex', gap: '6px' }}>
            {order.order_status === 'PLACED' && (
              <button
                onClick={(e) => { e.stopPropagation(); onTransition(order.order_id, 'RECEIVED'); }}
                disabled={isUpdating}
                style={{
                  flex: 1,
                  padding: '8px',
                  background: 'rgba(56,189,248,0.2)',
                  border: '1px solid #38bdf8',
                  borderRadius: '6px',
                  color: '#38bdf8',
                  fontWeight: '700',
                  fontSize: '0.78rem',
                  cursor: 'pointer'
                }}
              >
                Acknowledge
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onTransition(order.order_id, 'PREPARING'); }}
              disabled={isUpdating}
              style={{
                flex: 1,
                padding: '8px',
                background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                border: 'none',
                borderRadius: '6px',
                color: '#fff',
                fontWeight: '800',
                fontSize: '0.82rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px'
              }}
            >
              <Flame size={14} /> Start Preparing
            </button>
          </div>
        )}

        {actionType === 'MARK_READY' && (
          <button
            onClick={(e) => { e.stopPropagation(); onTransition(order.order_id, 'READY'); }}
            disabled={isUpdating}
            style={{
              width: '100%',
              padding: '10px',
              background: 'linear-gradient(135deg, #10b981, #059669)',
              border: 'none',
              borderRadius: '6px',
              color: '#fff',
              fontWeight: '800',
              fontSize: '0.85rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px'
            }}
          >
            <CheckCircle size={16} /> Mark Order Ready (Notify Front Desk)
          </button>
        )}

        {actionType === 'DISPATCH' && (
          <button
            onClick={(e) => { e.stopPropagation(); onTransition(order.order_id, 'OUT_FOR_DELIVERY'); }}
            disabled={isUpdating}
            style={{
              width: '100%',
              padding: '8px',
              background: 'rgba(52,211,153,0.15)',
              border: '1px solid #34d399',
              borderRadius: '6px',
              color: '#34d399',
              fontWeight: '700',
              fontSize: '0.8rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px'
            }}
          >
            <ArrowRight size={14} /> Handed to Server ({order.waiter_name || 'Staff'})
          </button>
        )}
      </div>
    </div>
  );
}
