/**
 * src/components/KitchenDashboard.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase F3 — Dedicated Kitchen Login + Kitchen Dashboard.
 * Phase K1+K2+K3 — Professional KDS UI, search/filters, and kitchen alerts.
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
 *
 * K1/K2/K3 additions below are entirely frontend/presentational — they filter,
 * search, and annotate the SAME `orders` array already fetched from the SAME
 * endpoint; no new endpoint, no new database field, no backend call.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { io } from 'socket.io-client';
import {
  Clock, Flame, CheckCircle, ChefHat, RefreshCw,
  AlertTriangle, Wifi, WifiOff, Inbox, Search, X,
  Volume2, VolumeX, Bell, RotateCcw
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

// Which board column an order currently belongs to — the single source of
// truth for both the 3-column board (unchanged) and the new filter/aggregate
// logic below, so "delayed"/"new"/"preparing"/"ready" always agree with what
// the board itself is showing.
function stageOf(order) {
  if (['PLACED', 'RECEIVED'].includes(order.order_status)) return 'RECEIVE';
  if (order.order_status === 'PREPARING') return 'PREPARING';
  if (order.order_status === 'READY') return 'READY';
  return null;
}

// Extracted verbatim from the existing per-card urgency calculation — same
// fields, same stage-dependent reference time, unchanged. Reused so the new
// header DELAYED count and DELAYED filter always match what a red card
// border already means today.
function getUrgencyMinutes(order, stage) {
  const isPlaced = order.order_status === 'PLACED';
  const waitingSec = getElapsedSeconds(isPlaced ? order.created_at : order.kitchen_received_at || order.created_at);
  const preparingSec = getElapsedSeconds(order.kitchen_preparing_at);
  return (stage === 'PREPARING' ? preparingSec : waitingSec) / 60;
}

// Existing threshold (>25 min), unchanged — this is exactly the threshold
// that already turns a card border red today.
function isDelayed(order) {
  const stage = stageOf(order);
  if (!stage) return false;
  return getUrgencyMinutes(order, stage) > 25;
}

function matchesSearch(order, rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [
    order.order_number,
    order.order_id,
    order.room_number,
    order.table_name,
    order.guest_name
  ].filter(Boolean).map(v => String(v).toLowerCase());
  return haystacks.some(h => h.includes(q));
}

function matchesFilter(order, filter) {
  switch (filter) {
    case 'NEW':       return stageOf(order) === 'RECEIVE';
    case 'PREPARING': return order.order_status === 'PREPARING';
    case 'READY':      return order.order_status === 'READY';
    case 'DELAYED':    return isDelayed(order);
    case 'ROOM':       return order.destination_type === 'ROOM';
    case 'TABLE':      return order.destination_type === 'TABLE';
    case 'ALL':
    default:
      return true;
  }
}

const FILTERS = ['ALL', 'NEW', 'PREPARING', 'READY', 'DELAYED', 'ROOM', 'TABLE'];

// Tiny generated notification tone — no audio file, no external dependency.
// Wrapped so a failure (unsupported browser, blocked AudioContext, etc.) can
// never crash the KDS; it just silently does nothing.
function playTone(audioCtxRef) {
  try {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  } catch (e) {
    // Never let an audio failure affect the KDS.
    console.warn('[KitchenDashboard] Notification tone failed (non-fatal):', e.message);
  }
}

let toastSeq = 0;

export default function KitchenDashboard() {
  const { adminUser, adminToken, logout } = useContext(AdminAuthContext);

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // 'connected' | 'reconnecting' | 'offline' — real Socket.IO states only,
  // never faked.
  const [connectionState, setConnectionState] = useState('offline');
  const [updatingId, setUpdatingId] = useState(null);
  const [, setNowTick] = useState(Date.now()); // forces elapsed-time re-render
  const [modifiedBanners, setModifiedBanners] = useState({});
  const [selectedOrderId, setSelectedOrderId] = useState(null);

  // ── K2: search + filters (frontend-only; never mutates `orders`) ─────────
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState('ALL');

  // ── K3: alerts ─────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState([]);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const audioCtxRef = useRef(null);
  const notifiedOrderIdsRef = useRef(new Set());
  const prevDelayedIdsRef = useRef(new Set());
  const ordersRef = useRef(orders);

  const socketRef = useRef(null);

  useEffect(() => { ordersRef.current = orders; }, [orders]);

  const addToast = useCallback((toast) => {
    const id = ++toastSeq;
    setToasts(prev => [...prev, { id, ...toast }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 6000);
  }, []);

  const dismissToast = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  // Mirrors soundEnabled so the socket effect can read the latest value
  // without needing soundEnabled in its dependency array — toggling sound
  // must never tear down/recreate the Socket.IO connection.
  const soundEnabledRef = useRef(soundEnabled);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);

  // Live elapsed-time refresh — a UI-only ticking clock computed from the
  // stored server timestamp each render, not business-date logic. Ticking
  // every second is purely a local re-render — it never writes to Firestore.
  // K3.3: the same tick also does an edge-triggered (not-delayed -> delayed)
  // check against the previously-seen delayed set, so a delayed alert fires
  // exactly once per order per transition, not every second.
  useEffect(() => {
    const timer = setInterval(() => {
      setNowTick(Date.now());

      const currentDelayedIds = new Set(
        ordersRef.current.filter(isDelayed).map(o => o.order_id)
      );
      const newlyDelayed = [...currentDelayedIds].filter(id => !prevDelayedIdsRef.current.has(id));
      newlyDelayed.forEach(id => {
        const ord = ordersRef.current.find(o => o.order_id === id);
        if (ord) {
          addToast({ kind: 'delayed', orderId: ord.order_id, orderNumber: ord.order_number || ord.order_id, destination: destinationLabel(ord) });
        }
      });
      prevDelayedIdsRef.current = currentDelayedIds;
    }, 1000);
    return () => clearInterval(timer);
  }, [addToast]);

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
      setConnectionState('connected');
      fetchActiveQueue(); // resync with server authority on (re)connect — server remains authoritative
    });

    socket.on('disconnect', () => {
      setConnectionState('offline');
    });

    socket.on('reconnect_attempt', () => {
      setConnectionState('reconnecting');
    });

    socket.on('food:order_placed', (newOrderSummary) => {
      fetchActiveQueue();

      // K3.1: one toast per genuinely new order, deduped by order_id so a
      // duplicate socket delivery (or a later resync) never double-notifies.
      const orderId = newOrderSummary?.order_id;
      if (orderId && !notifiedOrderIdsRef.current.has(orderId)) {
        notifiedOrderIdsRef.current.add(orderId);
        let destination = newOrderSummary?.destination_type || '';
        if (newOrderSummary?.destination_type === 'ROOM' && newOrderSummary?.room_number) {
          destination = `Room ${newOrderSummary.room_number}`;
        } else if (newOrderSummary?.destination_type === 'TABLE' && newOrderSummary?.table_name) {
          destination = `Table ${newOrderSummary.table_name}`;
        }
        addToast({
          kind: 'new',
          orderId,
          orderNumber: newOrderSummary?.order_number || orderId,
          destination
        });
        if (soundEnabledRef.current) playTone(audioCtxRef);
      }
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
    // soundEnabled is intentionally excluded — read via soundEnabledRef so
    // toggling sound never tears down/recreates the socket connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchActiveQueue, addToast]);

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

  // K3.2 — sound can only ever be armed by a real user gesture (this click),
  // never on mount/autoplay. AudioContext is created lazily, once.
  const toggleSound = () => {
    if (!soundEnabled) {
      try {
        if (!audioCtxRef.current) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (Ctx) audioCtxRef.current = new Ctx();
        }
        audioCtxRef.current?.resume?.().catch(() => {});
      } catch (e) {
        console.warn('[KitchenDashboard] Could not initialize audio (non-fatal):', e.message);
      }
    }
    setSoundEnabled(v => !v);
  };

  // ── K2: allOrders -> filteredOrders -> columns. `orders` itself is never
  // mutated; every derived array below is a fresh filter() result. ─────────
  const filteredOrders = useMemo(
    () => orders.filter(o => matchesFilter(o, activeFilter) && matchesSearch(o, search)),
    [orders, activeFilter, search]
  );

  const newReceivedOrders = filteredOrders.filter(o => stageOf(o) === 'RECEIVE');
  const preparingOrders   = filteredOrders.filter(o => o.order_status === 'PREPARING');
  const readyOrders       = filteredOrders.filter(o => o.order_status === 'READY');

  // Header stats reflect the full queue regardless of active filter — a
  // kitchen overview should always show total load, while the board below
  // narrows to the active filter/search.
  const totalNewCount       = orders.filter(o => stageOf(o) === 'RECEIVE').length;
  const totalPreparingCount = orders.filter(o => o.order_status === 'PREPARING').length;
  const totalReadyCount     = orders.filter(o => o.order_status === 'READY').length;
  const totalDelayedCount   = orders.filter(isDelayed).length;

  const hasActiveFilter = activeFilter !== 'ALL' || search.trim() !== '';
  const clearFilters = () => { setActiveFilter('ALL'); setSearch(''); };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0b0f17',
      color: '#f1f5f9',
      fontFamily: 'var(--font-body, Inter, sans-serif)',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <style>{`
        @keyframes kds-toast-in {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .kds-board {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 20px;
        }
        @media (max-width: 980px) {
          .kds-board { grid-template-columns: 1fr; }
        }
        .kds-header-stats {
          display: flex;
          align-items: stretch;
          gap: 10px;
          flex-wrap: wrap;
        }
      `}</style>

      {/* ── K3.1 / K3.3: toast stack ─────────────────────────────────────── */}
      <div style={{
        position: 'fixed', top: '16px', right: '16px', zIndex: 9999,
        display: 'flex', flexDirection: 'column', gap: '8px', width: '300px'
      }}>
        {toasts.map(t => (
          <div
            key={t.id}
            style={{
              animation: 'kds-toast-in 180ms ease',
              background: t.kind === 'new' ? 'rgba(56,189,248,0.14)' : 'rgba(239,68,68,0.14)',
              border: `1px solid ${t.kind === 'new' ? 'rgba(56,189,248,0.5)' : 'rgba(239,68,68,0.5)'}`,
              borderRadius: '12px', padding: '12px 14px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.72rem', fontWeight: '900', letterSpacing: '0.4px', color: t.kind === 'new' ? '#38bdf8' : '#f87171' }}>
                {t.kind === 'new' ? <Bell size={13} /> : <AlertTriangle size={13} />}
                {t.kind === 'new' ? 'NEW ORDER' : 'ORDER DELAYED'}
              </div>
              <button onClick={() => dismissToast(t.id)} style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 0 }}>
                <X size={14} />
              </button>
            </div>
            <div style={{ fontSize: '0.95rem', fontWeight: '900', color: '#fff', marginTop: '2px' }}>{t.orderNumber}</div>
            {t.destination && <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)' }}>{t.destination}</div>}
            <button
              onClick={() => { setSelectedOrderId(t.orderId); dismissToast(t.id); }}
              style={{
                marginTop: '6px', padding: '5px 12px', background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', color: '#fff',
                fontWeight: '800', fontSize: '0.72rem', cursor: 'pointer'
              }}
            >
              VIEW
            </button>
          </div>
        ))}
      </div>

      {/* ── K1.1: Professional header — LEFT / CENTER / RIGHT ─────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '18px 28px',
        borderBottom: '2px solid rgba(251,146,60,0.25)',
        background: 'linear-gradient(180deg, rgba(251,146,60,0.06), transparent)',
        flexWrap: 'wrap',
        gap: '16px'
      }}>
        {/* LEFT */}
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
              Live Kitchen Display — HOTEL SKY-5
            </div>
          </div>
        </div>

        {/* CENTER — live stats, from the full queue (K1.1 / K1.5) */}
        <div className="kds-header-stats">
          <HeaderStat label="NEW / RECEIVED" count={totalNewCount} color="#38bdf8" />
          <HeaderStat label="PREPARING" count={totalPreparingCount} color="#fbbf24" />
          <HeaderStat label="READY" count={totalReadyCount} color="#34d399" />
          <HeaderStat label="DELAYED" count={totalDelayedCount} color="#f87171" />
        </div>

        {/* RIGHT */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <ConnectionPill state={connectionState} />

          <button
            onClick={toggleSound}
            title={soundEnabled ? 'Sound alerts on — click to mute' : 'Sound alerts off — click to enable'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '8px 12px', background: soundEnabled ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${soundEnabled ? 'rgba(52,211,153,0.4)' : 'rgba(255,255,255,0.1)'}`,
              borderRadius: '10px', color: soundEnabled ? '#34d399' : 'rgba(255,255,255,0.6)',
              fontSize: '0.8rem', fontWeight: '700', cursor: 'pointer'
            }}
          >
            {soundEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
            {soundEnabled ? 'Sound On' : 'Sound Off'}
          </button>

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

      {/* ── K2: Search + Filters ───────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        padding: '16px 28px 0 28px'
      }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: '360px' }}>
          <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.35)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order #, room, table, guest…"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '9px 12px 9px 34px',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '10px', color: '#fff', fontSize: '0.85rem', outline: 'none'
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              style={{
                padding: '8px 14px', borderRadius: '8px', fontSize: '0.78rem', fontWeight: '800',
                letterSpacing: '0.3px', cursor: 'pointer',
                background: activeFilter === f ? 'rgba(56,189,248,0.18)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${activeFilter === f ? '#38bdf8' : 'rgba(255,255,255,0.1)'}`,
                color: activeFilter === f ? '#38bdf8' : 'rgba(255,255,255,0.6)'
              }}
            >
              {f}
            </button>
          ))}
        </div>

        {hasActiveFilter && (
          <button
            onClick={clearFilters}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              padding: '8px 12px', background: 'transparent', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '8px', color: 'rgba(255,255,255,0.55)', fontSize: '0.78rem', fontWeight: '700', cursor: 'pointer'
            }}
          >
            <RotateCcw size={13} /> Clear
          </button>
        )}
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
      <div className="kds-board" style={{ padding: '20px 28px 28px 28px', flex: 1, minHeight: 0 }}>
        <KitchenColumn
          title="New / Received"
          color="#38bdf8"
          orders={newReceivedOrders}
          hasUnfiltered={totalNewCount > 0}
          emptyLabel="No new orders"
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
          hasUnfiltered={totalPreparingCount > 0}
          emptyLabel="No orders currently cooking"
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
          hasUnfiltered={totalReadyCount > 0}
          emptyLabel="No orders waiting for pickup"
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

function HeaderStat({ label, count, color }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)', border: `1px solid ${color}33`,
      borderRadius: '12px', padding: '8px 16px', textAlign: 'center', minWidth: '88px'
    }}>
      <div style={{ fontSize: '1.6rem', fontWeight: '900', color, lineHeight: 1.1 }}>{count}</div>
      <div style={{ fontSize: '0.65rem', fontWeight: '800', letterSpacing: '0.5px', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' }}>
        {label}
      </div>
    </div>
  );
}

function ConnectionPill({ state }) {
  const config = {
    connected:    { color: '#34d399', icon: Wifi,    label: '🟢 Kitchen Connected' },
    reconnecting: { color: '#fbbf24', icon: RefreshCw, label: '🟡 Reconnecting…' },
    offline:      { color: '#f87171', icon: WifiOff, label: '🔴 Connection Lost' }
  }[state] || { color: '#f87171', icon: WifiOff, label: '🔴 Connection Lost' };
  const Icon = config.icon;
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '8px',
      padding: '8px 16px', borderRadius: '10px',
      background: `${config.color}1F`,
      border: `1px solid ${config.color}66`,
      color: config.color,
      fontWeight: '800', fontSize: '0.85rem'
    }}>
      <Icon size={16} className={state === 'reconnecting' ? 'animate-spin' : ''} />
      {config.label}
    </div>
  );
}

function KitchenColumn({ title, color, orders, hasUnfiltered, emptyLabel, onTransition, updatingId, stage, modifiedBanners, onDismissBanner, selectedOrderId, onSelectOrder }) {
  return (
    <div style={{
      background: 'rgba(15,23,42,0.6)', border: `1px solid ${color}33`,
      borderRadius: '16px', display: 'flex', flexDirection: 'column', minHeight: 0
    }}>
      <div style={{
        padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: color }} />
          <span style={{ fontWeight: '800', fontSize: '1rem' }}>{title}</span>
        </div>
        <span style={{
          fontSize: '0.75rem', fontWeight: '800', padding: '2px 9px', borderRadius: '10px',
          background: 'rgba(255,255,255,0.06)', color
        }}>
          {orders.length}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {orders.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 10px', color: 'rgba(255,255,255,0.2)' }}>
            <Inbox size={28} style={{ marginBottom: '8px' }} />
            <div style={{ fontSize: '0.9rem' }}>
              {hasUnfiltered ? 'No matching orders' : emptyLabel}
            </div>
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
  PLACED:    { label: '🆕 NEW ORDER', color: '#38bdf8' },
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
  const itemCount = (order.items || []).reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);

  let urgencyBorder = isSelected ? '#38bdf8' : 'rgba(255,255,255,0.1)';
  const referenceMin = getUrgencyMinutes(order, stage);
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

      {/* Order number — strongest visual element on the card */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ fontSize: '1.5rem', fontWeight: '900', color: '#38bdf8', letterSpacing: '0.3px', lineHeight: 1.1 }}>
          {order.order_number || order.order_id}
        </div>
        <span style={{
          flexShrink: 0, padding: '4px 10px', borderRadius: '20px', fontSize: '0.7rem', fontWeight: '900',
          letterSpacing: '0.3px', color: badge.color, background: `${badge.color}22`, border: `1px solid ${badge.color}55`
        }}>
          {badge.label}
        </span>
      </div>

      {/* Destination + guest */}
      <div>
        <div style={{ fontSize: '1.05rem', fontWeight: '800', color: '#f1f5f9' }}>
          {destinationLabel(order)}
        </div>
        {order.guest_name && (
          <div style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.65)', fontWeight: '600' }}>{order.guest_name}</div>
        )}
        <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.45)', marginTop: '2px' }}>
          Waiter: <strong style={{ color: 'rgba(255,255,255,0.7)' }}>{order.waiter_name || 'Assigned'}</strong>
        </div>
      </div>

      {/* Status + elapsed, inline */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
        <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.55)' }}>
          {stage === 'RECEIVE' && isPlaced && <>Ordered: <strong style={{ color: '#fff' }}>{formatTime(order.created_at)}</strong></>}
          {stage === 'RECEIVE' && !isPlaced && <>Received: <strong style={{ color: '#fff' }}>{formatTime(order.kitchen_received_at)}</strong></>}
          {stage === 'PREPARING' && <>Started: <strong style={{ color: '#fff' }}>{formatTime(order.kitchen_preparing_at)}</strong></>}
          {stage === 'READY' && <>Ready at: <strong style={{ color: '#fff' }}>{formatTime(order.kitchen_ready_at)}</strong></>}
        </div>
        {stage === 'RECEIVE' && <TimeBadge label="Elapsed" seconds={waitingSec} />}
        {stage === 'PREPARING' && <TimeBadge label="Preparing" seconds={preparingSec} />}
        {stage === 'READY' && readyDurationSec !== null && (
          <span style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.5)' }}>
            Prep time: <strong style={{ color: '#fff' }}>{formatDurationLong(readyDurationSec)}</strong>
          </span>
        )}
      </div>

      {/* Items */}
      <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '0.4px', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' }}>
          Items{itemCount > 0 ? ` (${itemCount})` : ''}
        </div>
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
          fontSize: '0.85rem', color: '#fbbf24', fontWeight: '600',
          background: 'rgba(251,191,36,0.08)', padding: '8px 12px', borderRadius: '8px'
        }}>
          <div style={{ fontSize: '0.64rem', fontWeight: '900', letterSpacing: '0.4px', textTransform: 'uppercase', marginBottom: '2px', opacity: 0.85 }}>
            Special Instructions
          </div>
          {order.remarks}
        </div>
      )}

      {stage === 'READY' && (
        <div style={{ fontSize: '0.85rem', color: '#34d399', fontWeight: '700' }}>✓ Waiting for pickup</div>
      )}

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
