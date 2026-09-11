import React, { useEffect, useRef, useState, useCallback } from 'react';
import { API_URL, getApiHeaders, authenticatedFetch, AuthenticationError } from '../config/apiConfig';

/** Matches the badge poller in App.jsx, so the two never fight each other. */
const MODAL_POLL_MS = 15000;
const MODAL_BACKOFF_MS = [30000, 60000];

const TYPE_CONFIG = {
  service: { label: 'Room Service', color: '#818cf8', bg: 'rgba(129,140,248,0.12)', border: 'rgba(129,140,248,0.3)', icon: '🛎️' },
  maintenance: { label: 'Maintenance', color: '#facc15', bg: 'rgba(250,204,21,0.1)', border: 'rgba(250,204,21,0.3)', icon: '🔧' },
  checkout_request: { label: 'Checkout Request', color: '#ef4444', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)', icon: '🚪' },
  extension_request: { label: 'Stay Extension', color: '#22c55e', bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.3)', icon: '⏳' },
};

export default function GuestRequestsModal({ isOpen, onClose, token, onRequestResolved }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [resolvingId, setResolvingId] = useState(null);

  // The same three protections the App badge poller has. Without them this was
  // a second, independent polling system: raw fetch that could not refresh a
  // token, no in-flight guard, and no backoff — so while the modal sat open
  // during an outage it called the endpoint every 15s regardless.
  const inFlightRef = useRef(false);
  const backoffRef = useRef({ failures: 0, nextAllowedAt: 0 });
  const [degraded, setDegraded] = useState(false);

  const fetchRequests = useCallback(async (silent = false, { fromPoll = false } = {}) => {
    if (!token) return;
    if (inFlightRef.current) return;                                   // one at a time
    if (fromPoll && Date.now() < backoffRef.current.nextAllowedAt) return;

    inFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      // authenticatedFetch refreshes the token once on a 401 and retries once.
      const res = await authenticatedFetch(`${API_URL}/admin/guest-requests`, {}, token);
      if (res.ok) {
        const data = await res.json();
        setRequests(data.requests || []);
        setLastUpdated(new Date());
        setDegraded(false);
        backoffRef.current = { failures: 0, nextAllowedAt: 0 };
        return;
      }
      // 503 means the server cannot tell us. The list already on screen is the
      // last thing we actually knew, so it stays; it is not replaced by empty.
      if (res.status === 503 || res.status === 429 || res.status >= 500) {
        setDegraded(true);
        const failures = backoffRef.current.failures + 1;
        const wait = MODAL_BACKOFF_MS[Math.min(failures - 1, MODAL_BACKOFF_MS.length - 1)];
        backoffRef.current = { failures, nextAllowedAt: Date.now() + wait };
      }
    } catch (e) {
      if (e instanceof AuthenticationError) {
        console.warn('[GuestRequests] Session expired; the list was not refreshed.');
      } else {
        console.error('fetchRequests error:', e);
      }
      setDegraded(true);
      const failures = backoffRef.current.failures + 1;
      const wait = MODAL_BACKOFF_MS[Math.min(failures - 1, MODAL_BACKOFF_MS.length - 1)];
      backoffRef.current = { failures, nextAllowedAt: Date.now() + wait };
    } finally {
      inFlightRef.current = false;
      if (!silent) setLoading(false);
    }
  }, [token]);

  // Handle request resolution (acknowledge/complete)
  const handleResolve = async (id, action = null) => {
    if (!token || resolvingId) return;
    setResolvingId(id);
    try {
      let url = `${API_URL}/admin/guest-requests/${id}/resolve`;
      let body = {};
      
      if (id.startsWith('ext_')) {
        url = `${API_URL}/admin/guest-requests/extension/${id}/resolve`;
        body = { action }; // 'approve' or 'reject'
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
        body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined
      });
      if (res.ok) {
        const data = await res.json();
        if (data.message) alert(data.message);
        
        // Instantly reload local modal requests list silently
        await fetchRequests(true);
        // Instantly refresh the parent toolbar requests badge count
        if (onRequestResolved) onRequestResolved();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to resolve request');
      }
    } catch (e) {
      console.error('Resolve request error:', e);
      alert('Network error while resolving request');
    } finally {
      setResolvingId(null);
    }
  };

  // Fetch on open, then poll while open. The interval keeps a steady beat and
  // the fetcher decides whether to act, so there is one timer and no recursion.
  useEffect(() => {
    if (!isOpen) return undefined;
    backoffRef.current = { failures: 0, nextAllowedAt: 0 };   // a fresh open starts clean
    fetchRequests(false);

    const handleRefresh = () => fetchRequests(true);
    document.addEventListener('guest-request-refresh', handleRefresh);

    const interval = setInterval(() => fetchRequests(true, { fromPoll: true }), MODAL_POLL_MS);
    return () => {
      document.removeEventListener('guest-request-refresh', handleRefresh);
      clearInterval(interval);
    };
  }, [isOpen, fetchRequests]);

  if (!isOpen) return null;



  const filtered = filter === 'all' ? requests : requests.filter(r => r.request_type === filter);
  const svcCount = requests.filter(r => r.request_type === 'service').length;
  const mntCount = requests.filter(r => r.request_type === 'maintenance').length;
  const coCount = requests.filter(r => r.request_type === 'checkout_request').length;

  const formatTime = (ts) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '20px'
    }} onClick={onClose}>
      <div style={{
        background: '#0f1623',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '16px',
        padding: '0',
        width: '100%',
        maxWidth: '780px',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
        overflow: 'hidden'
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '1.4rem' }}>📬</span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontWeight: '800', color: '#fff', fontSize: '1.2rem' }}>
                  Guest Requests
                </h2>
                {/* Feed state. Green LIVE only while refreshes are actually
                    succeeding; amber STALE once the server stops answering, so
                    the list is never presented as current when it is not. */}
                {degraded ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(250,204,21,0.12)', border: '1px solid rgba(250,204,21,0.35)', borderRadius: '20px', padding: '2px 8px', fontSize: '0.65rem', fontWeight: '700', color: '#facc15', letterSpacing: '0.5px' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#facc15', display: 'inline-block' }} />
                    STALE
                  </span>
                ) : (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '20px', padding: '2px 8px', fontSize: '0.65rem', fontWeight: '700', color: '#22c55e', letterSpacing: '0.5px' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'pulse 2s infinite' }} />
                    LIVE
                  </span>
                )}
              </div>
              <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                {requests.length} active request{requests.length !== 1 ? 's' : ''} ·{' '}
                {degraded ? 'Server unreachable — showing the last known list' : 'Auto-refreshes every 15s'}
                {lastUpdated && <span style={{ marginLeft: '6px', opacity: 0.6 }}>· Updated {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button onClick={() => fetchRequests(false)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '6px 12px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem' }}>
              🔄 Refresh
            </button>
            <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '6px 14px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1rem', fontWeight: '700' }}>
              ✕
            </button>
          </div>
        </div>


        {/* Filter Tabs */}
        <div style={{ padding: '12px 24px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: '8px', flexShrink: 0, flexWrap: 'wrap' }}>
          {[
            { key: 'all', label: `All (${requests.length})`, color: '#fff' },
            { key: 'service', label: `🛎️ Services (${svcCount})`, color: '#818cf8' },
            { key: 'maintenance', label: `🔧 Maintenance (${mntCount})`, color: '#facc15' },
            { key: 'checkout_request', label: `🚪 Checkout (${coCount})`, color: '#ef4444' },
            { key: 'extension_request', label: `⏳ Extension (${requests.filter(r => r.request_type === 'extension_request').length})`, color: '#22c55e' },
          ].map(tab => (
            <button key={tab.key} onClick={() => setFilter(tab.key)} style={{
              background: filter === tab.key ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: filter === tab.key ? `1px solid ${tab.color}40` : '1px solid rgba(255,255,255,0.06)',
              borderRadius: '20px',
              padding: '5px 14px',
              color: filter === tab.key ? tab.color : 'var(--text-muted)',
              fontWeight: filter === tab.key ? '700' : '500',
              fontSize: '0.8rem',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}>{tab.label}</button>
          ))}
        </div>

        {/* Request List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 24px 20px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>⏳</div>
              Loading requests...
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '3rem', marginBottom: '12px' }}>✅</div>
              <p style={{ fontWeight: '600', color: 'var(--text-secondary)', fontSize: '0.95rem' }}>All Clear!</p>
              <p style={{ fontSize: '0.82rem', marginTop: '4px' }}>No pending guest requests at this time.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {filtered.map(req => {
                const cfg = TYPE_CONFIG[req.request_type] || TYPE_CONFIG.service;
                return (
                  <div key={req.id} style={{
                    background: cfg.bg,
                    border: `1px solid ${cfg.border}`,
                    borderRadius: '10px',
                    padding: '14px 16px',
                    display: 'flex',
                    gap: '14px',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}>
                    <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start', flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: '1.4rem', flexShrink: 0, marginTop: '2px' }}>{cfg.icon}</span>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
                          <span style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: '20px', padding: '2px 10px', color: cfg.color, fontWeight: '700', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            {cfg.label}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', flexShrink: 0 }}>
                            🕐 {formatTime(req.created_at)}
                          </span>
                        </div>

                        <p style={{ fontWeight: '600', color: '#fff', fontSize: '0.9rem', margin: '0 0 8px', lineHeight: '1.4' }}>
                          {req.desc}
                        </p>

                        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
                          {req.room_number && (
                            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem' }}>
                              <span style={{ color: 'var(--text-muted)' }}>🏨 Room</span>
                              <strong style={{ color: '#38bdf8' }}>{req.room_number}</strong>
                              {req.room_type && <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>({req.room_type})</span>}
                            </span>
                          )}
                          {req.guest_name && (
                            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem' }}>
                              <span style={{ color: 'var(--text-muted)' }}>👤</span>
                              <strong style={{ color: '#e2e8f0' }}>{req.guest_name}</strong>
                            </span>
                          )}
                          {req.guest_phone && (
                            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>📞 {req.guest_phone}</span>
                          )}
                          {req.qty && req.qty > 1 && (
                            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Qty: {req.qty}</span>
                          )}
                          {req.amount > 0 && (
                            <span style={{ fontSize: '0.78rem', color: '#fbbf24', fontWeight: '700' }}>₹ {req.amount.toLocaleString('en-IN')}</span>
                          )}
                          {req.request_type === 'maintenance' && req.status && (
                            <span style={{
                              fontSize: '0.72rem', fontWeight: '700', padding: '2px 8px', borderRadius: '10px',
                              background: req.status === 'Pending' ? 'rgba(239,68,68,0.15)' : 'rgba(251,191,36,0.15)',
                              color: req.status === 'Pending' ? '#ef4444' : '#fbbf24',
                              border: req.status === 'Pending' ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(251,191,36,0.3)'
                            }}>{req.status}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    {req.request_type === 'extension_request' ? (
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={() => handleResolve(req.id, 'approve')}
                          disabled={resolvingId === req.id}
                          className="btn-success"
                          style={{
                            padding: '6px 12px', fontSize: '0.85rem', flexShrink: 0,
                            background: '#22c55e', color: '#fff', border: 'none', borderRadius: '6px',
                            opacity: resolvingId === req.id ? 0.6 : 1, cursor: 'pointer'
                          }}
                        >
                          {resolvingId === req.id ? '...' : '✅ Approve'}
                        </button>
                        <button
                          onClick={() => handleResolve(req.id, 'reject')}
                          disabled={resolvingId === req.id}
                          className="btn-danger"
                          style={{
                            padding: '6px 12px', fontSize: '0.85rem', flexShrink: 0,
                            background: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px',
                            opacity: resolvingId === req.id ? 0.6 : 1, cursor: 'pointer'
                          }}
                        >
                          {resolvingId === req.id ? '...' : '❌ Reject'}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleResolve(req.id)}
                        disabled={resolvingId === req.id}
                        style={{
                          background: 'rgba(255,255,255,0.06)',
                          border: '1px solid rgba(255,255,255,0.12)',
                          borderRadius: '6px',
                          padding: '6px 14px',
                          color: cfg.color,
                          fontWeight: '700',
                          fontSize: '0.78rem',
                          cursor: resolvingId === req.id ? 'not-allowed' : 'pointer',
                          transition: 'all 0.2s',
                          marginLeft: '12px',
                          flexShrink: 0
                        }}
                        onMouseEnter={e => {
                          e.currentTarget.style.background = cfg.bg;
                          e.currentTarget.style.borderColor = cfg.color + '40';
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
                        }}
                      >
                        {resolvingId === req.id ? '⏳ ...' : '✓ Acknowledge'}
                      </button>
                    )}
                  </div>

                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
