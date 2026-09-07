/**
 * src/components/NotificationBell.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Header bell + unread badge + compact dropdown panel. Renders nothing for
 * users who are not notification recipients. Styled with the existing HPMS
 * header-pill idiom (inline styles, sky accent, glass surfaces).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, CheckCheck } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';

export function formatTimeAgo(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const SEVERITY_COLOR = {
  success: '#4ade80',
  info:    '#38bdf8',
  warning: '#fbbf24',
  error:   '#f87171'
};

export default function NotificationBell() {
  const ctx = useNotifications();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const wrapRef = useRef(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Keep "x minutes ago" fresh while the panel is open.
  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [open]);

  if (!ctx || !ctx.isRecipient) return null;

  const { notifications, unreadCount, markRead, markAllRead, openNotification, connected } = ctx;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title={connected ? 'Notifications' : 'Notifications (reconnecting…)'}
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        style={{
          position:     'relative',
          display:      'flex',
          alignItems:   'center',
          justifyContent: 'center',
          width:        '34px',
          height:       '34px',
          background:   open ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.04)',
          border:       `1px solid ${open ? 'rgba(56,189,248,0.4)' : 'rgba(255,255,255,0.09)'}`,
          borderRadius: '8px',
          color:        open || unreadCount ? '#38bdf8' : '#cdd9e5',
          cursor:       'pointer',
          transition:   'all 0.15s',
          fontFamily:   'inherit'
        }}
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span style={{
            position:     'absolute',
            top:          '-6px',
            right:        '-6px',
            minWidth:     '18px',
            height:       '18px',
            padding:      '0 5px',
            background:   '#ef4444',
            color:        '#fff',
            borderRadius: '9px',
            fontSize:     '0.65rem',
            fontWeight:   '800',
            display:      'flex',
            alignItems:   'center',
            justifyContent: 'center',
            boxShadow:    '0 0 0 2px rgba(13,17,23,0.9)'
          }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{
            position:     'absolute',
            top:          '42px',
            right:        0,
            width:        '340px',
            maxHeight:    '440px',
            display:      'flex',
            flexDirection: 'column',
            background:   'rgba(10,14,20,0.97)',
            border:       '1px solid rgba(255,255,255,0.1)',
            borderRadius: '12px',
            boxShadow:    '0 18px 40px rgba(0,0,0,0.55)',
            backdropFilter: 'blur(12px)',
            zIndex:       3000,
            overflow:     'hidden',
            animation:    'fadeIn 0.15s ease'
          }}
        >
          <div style={{
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'space-between',
            padding:        '12px 14px',
            borderBottom:   '1px solid rgba(255,255,255,0.08)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '0.85rem', color: '#f0f6fc' }}>
              🔔 Notifications
              {unreadCount > 0 && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, color: '#fff', background: '#ef4444', borderRadius: '9px', padding: '1px 7px' }}>
                  {unreadCount}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              style={{
                display:    'flex',
                alignItems: 'center',
                gap:        '4px',
                background: 'transparent',
                border:     'none',
                color:      unreadCount ? '#38bdf8' : '#8b949e',
                cursor:     unreadCount ? 'pointer' : 'default',
                fontSize:   '0.72rem',
                fontWeight: 600,
                fontFamily: 'inherit'
              }}
            >
              <CheckCheck size={13} /> Mark all as read
            </button>
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {notifications.length === 0 ? (
              <div style={{ padding: '28px 14px', textAlign: 'center', color: '#8b949e', fontSize: '0.82rem' }}>
                No new notifications
              </div>
            ) : notifications.map(n => {
              const accent = SEVERITY_COLOR[n.severity] || SEVERITY_COLOR.info;
              return (
                <div
                  key={n.id}
                  onClick={() => { openNotification(n); setOpen(false); }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNotification(n); setOpen(false); } }}
                  style={{
                    display:      'flex',
                    gap:          '10px',
                    padding:      '11px 14px',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    borderLeft:   `3px solid ${n.read ? 'transparent' : accent}`,
                    background:   n.read ? 'transparent' : 'rgba(56,189,248,0.06)',
                    cursor:       n.navigation ? 'pointer' : 'default',
                    transition:   'background 0.15s'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = n.read ? 'transparent' : 'rgba(56,189,248,0.06)'; }}
                >
                  <div style={{ fontSize: '1.1rem', lineHeight: 1, paddingTop: '2px' }}>{n.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: n.read ? 600 : 800, color: '#f0f6fc' }}>{n.title}</div>
                    <div style={{ fontSize: '0.78rem', color: '#cbd5e1', marginTop: '2px' }}>{n.message}</div>
                    {n.lines && n.lines.map((line, i) => (
                      <div key={i} style={{ fontSize: '0.74rem', color: '#94a3b8', marginTop: i === 0 ? '4px' : '1px' }}>{line}</div>
                    ))}
                    <div style={{ fontSize: '0.68rem', color: '#8b949e', marginTop: '5px' }}>{formatTimeAgo(n.timestamp, now)}</div>
                  </div>
                  {!n.read && (
                    <button
                      type="button"
                      title="Mark as read"
                      onClick={(e) => { e.stopPropagation(); markRead(n.id); }}
                      style={{
                        alignSelf:  'flex-start',
                        background: 'transparent',
                        border:     '1px solid rgba(255,255,255,0.12)',
                        borderRadius: '6px',
                        color:      '#38bdf8',
                        cursor:     'pointer',
                        padding:    '3px 5px',
                        display:    'flex',
                        alignItems: 'center',
                        fontFamily: 'inherit'
                      }}
                    >
                      <Check size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
