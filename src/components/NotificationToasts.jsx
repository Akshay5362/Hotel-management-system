/**
 * src/components/NotificationToasts.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Non-blocking toast stack for real-time notifications. Modeled on the
 * existing KitchenDashboard toast stack (fixed top-right, auto-dismiss,
 * dismiss + view actions). Rendered once, app-wide, by App.jsx.
 * Renders nothing for non-recipient users or when there are no toasts.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React from 'react';
import { X } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';

const SEVERITY_COLOR = {
  success: '#4ade80',
  info:    '#38bdf8',
  warning: '#fbbf24',
  error:   '#f87171'
};

export default function NotificationToasts() {
  const ctx = useNotifications();
  if (!ctx || !ctx.isRecipient || ctx.toasts.length === 0) return null;

  const { toasts, dismissToast, openNotification } = ctx;

  return (
    <div
      aria-live="polite"
      style={{
        position:      'fixed',
        top:           '16px',
        right:         '16px',
        zIndex:        9999,
        display:       'flex',
        flexDirection: 'column',
        gap:           '10px',
        width:         '320px',
        maxWidth:      'calc(100vw - 32px)',
        pointerEvents: 'none'
      }}
    >
      {toasts.map(t => {
        const accent = SEVERITY_COLOR[t.severity] || SEVERITY_COLOR.info;
        return (
          <div
            key={t.id}
            style={{
              pointerEvents: 'auto',
              background:    'rgba(8,15,30,0.97)',
              border:        `1px solid ${accent}55`,
              borderLeft:    `4px solid ${accent}`,
              borderRadius:  '10px',
              padding:       '12px 14px',
              boxShadow:     '0 12px 30px rgba(0,0,0,0.5)',
              animation:     'slideInRight 0.3s ease',
              color:         '#f0f6fc',
              fontFamily:    'var(--font-body, Inter, sans-serif)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <div style={{ fontSize: '1.2rem', lineHeight: 1 }}>{t.icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.5px', color: accent, textTransform: 'uppercase' }}>
                  {t.title}
                </div>
                <div style={{ fontSize: '0.86rem', fontWeight: 700, marginTop: '3px' }}>{t.message}</div>
                {t.lines && t.lines.map((line, i) => (
                  <div key={i} style={{ fontSize: '0.76rem', color: '#cbd5e1', marginTop: i === 0 ? '4px' : '1px' }}>{line}</div>
                ))}
                {t.navigation && (
                  <button
                    type="button"
                    onClick={() => openNotification(t)}
                    style={{
                      marginTop:    '8px',
                      background:   `${accent}1f`,
                      border:       `1px solid ${accent}66`,
                      color:        accent,
                      borderRadius: '6px',
                      padding:      '4px 10px',
                      fontSize:     '0.72rem',
                      fontWeight:   700,
                      cursor:       'pointer',
                      fontFamily:   'inherit'
                    }}
                  >
                    VIEW
                  </button>
                )}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismissToast(t.id)}
                style={{ background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer', padding: '2px', display: 'flex' }}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
