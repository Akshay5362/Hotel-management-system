/**
 * ui.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Small presentational primitives shared by every Inventory screen. Nothing in
 * this file fetches, stores or decides anything — it only renders. Keeping the
 * table, badge, toolbar and state components here is what lets ten screens
 * share one density and one vocabulary without a design system dependency.
 *
 * Styles live in inventory.css (all `inv-` prefixed). The drawer and modal
 * reuse the application's own slide-over and modal classes from index.css so
 * they open and animate exactly like the rest of HPMS.
 */
import React, { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Inbox, RefreshCw, X, Info } from 'lucide-react';

/* ── Buttons ─────────────────────────────────────────────────────────────── */
export function Button({ variant = '', size = '', icon: Icon, children, className = '', ...rest }) {
  const cls = ['inv-btn', variant, size, className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {Icon ? <Icon size={size === 'sm' ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

/* ── Header + sub navigation ─────────────────────────────────────────────── */
export function PageHeader({ icon: Icon, title, subtitle, actions }) {
  return (
    <div className="inv-page-header">
      <div>
        <h2>{Icon ? <Icon size={18} /> : null}{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="inv-page-actions">{actions}</div> : null}
    </div>
  );
}

export function SubNav({ items, value, onChange }) {
  return (
    <div className="inv-subnav" role="tablist">
      {items.map(it => (
        <button
          key={it.key}
          role="tab"
          aria-selected={value === it.key}
          className={value === it.key ? 'active' : ''}
          onClick={() => onChange(it.key)}
          title={it.desc || it.label}
        >
          {it.icon ? <it.icon size={13} /> : null}
          {it.label}
          {typeof it.count === 'number' && it.count > 0 ? (
            <span className={`inv-count${it.countTone ? ' ' + it.countTone : ''}`}>{it.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/* ── KPI ─────────────────────────────────────────────────────────────────── */
export function KpiCard({ label, value, icon: Icon, tone, onClick, loading }) {
  const color = tone === 'warn' ? 'var(--inv-warn)' : tone === 'bad' ? 'var(--inv-bad)' : tone === 'ok' ? 'var(--inv-ok)' : 'var(--inv-accent)';
  return (
    <div className={`inv-kpi${onClick ? ' clickable' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}>
      <div>
        <div className="inv-kpi-label">{label}</div>
        {loading ? <span className="inv-skel" style={{ width: 48, height: 22, marginTop: 6 }} /> : <div className="inv-kpi-value" style={{ color }}>{value}</div>}
      </div>
      {Icon ? <Icon className="inv-kpi-icon" size={20} color={color} /> : null}
    </div>
  );
}

/* ── Status badge: text always carries the meaning ───────────────────────── */
export function StatusBadge({ label, tone = 'neutral', icon: Icon }) {
  return <span className={`inv-badge ${tone}`}>{Icon ? <Icon size={11} /> : null}{label}</span>;
}

/* ── Card ────────────────────────────────────────────────────────────────── */
export function Card({ title, actions, children, padded = false, style }) {
  return (
    <div className="inv-card" style={style}>
      {(title || actions) ? (
        <div className="inv-card-head">
          <span>{title}</span>
          {actions ? <div style={{ display: 'flex', gap: 6 }}>{actions}</div> : null}
        </div>
      ) : null}
      {padded ? <div className="inv-card-body">{children}</div> : children}
    </div>
  );
}

/* ── Toolbar + fields ────────────────────────────────────────────────────── */
export function Toolbar({ children }) {
  return <div className="inv-toolbar">{children}</div>;
}

export function Field({ label, required, hint, children, invalid }) {
  return (
    <div className="inv-field">
      {label ? <label>{label}{required ? <span className="req"> *</span> : null}</label> : null}
      {children}
      {hint ? <div className="inv-hint" style={invalid ? { color: 'var(--inv-bad)' } : undefined}>{hint}</div> : null}
    </div>
  );
}

/* ── Table ───────────────────────────────────────────────────────────────── */
export function Table({ columns, children }) {
  return (
    <div className="inv-table-wrap">
      <table className="inv-table">
        <thead>
          <tr>{columns.map(c => <th key={c.key || c.label} className={c.className || ''} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/* ── States ──────────────────────────────────────────────────────────────── */
export function EmptyState({ icon: Icon = Inbox, title, text, action }) {
  return (
    <div className="inv-empty">
      <Icon size={22} style={{ opacity: 0.5 }} />
      {title ? <strong>{title}</strong> : null}
      {text ? <p>{text}</p> : null}
      {action || null}
    </div>
  );
}

/** Skeleton rows for a table that is still loading, so the layout stays put. */
export function LoadingRows({ columns = 5, rows = 5 }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: columns }).map((__, c) => (
            <td key={c}><span className="inv-skel" style={{ width: `${45 + ((r * 7 + c * 13) % 40)}%` }} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function Alert({ tone = 'info', title, children, onRetry, onDismiss }) {
  const Icon = tone === 'error' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`inv-alert ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <div className="inv-alert-body">
        {title ? <div className="inv-alert-title">{title}</div> : null}
        <div>{children}</div>
      </div>
      {onRetry ? <Button size="sm" icon={RefreshCw} onClick={onRetry}>Retry</Button> : null}
      {onDismiss ? <Button size="sm" variant="ghost" icon={X} onClick={onDismiss} aria-label="Dismiss" /> : null}
    </div>
  );
}

/**
 * A raw error is a debugging artefact. Staff should read what happened in
 * their own terms, and the technical code stays available in the title
 * attribute for anyone who needs it. Validation messages from the API are
 * already written for people, so those pass through unchanged.
 */
export function humanError(err, fallback = 'Something went wrong. Please try again.') {
  const raw = String(err?.message || err || '');
  const status = err?.status;
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have permission to do this.';
  if (status === 404) return 'That record could not be found. It may have been removed.';
  if (status === 409) return raw || 'This was already done, or something changed in the meantime. Refresh and check.';
  if (status === 400 || status === 422) return raw || 'Some of the details entered are not valid.';
  if (/failed to fetch|networkerror|load failed|ECONNREFUSED/i.test(raw)) return 'The server could not be reached. Check the connection and try again.';
  if (/firestore|firebase|axios|stack|at .*\.js|ECONN|ENOTFOUND|HTTP 5\d\d|Request failed/i.test(raw) || status >= 500) return fallback;
  return raw || fallback;
}

/* ── Drawer + Modal (reuse the application's classes) ────────────────────── */
export function Drawer({ open, title, subtitle, onClose, children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      <div className={`slide-over-overlay${open ? ' open' : ''}`} onClick={onClose} />
      <div className={`slide-over-drawer inv-drawer${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="drawer-header">
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '1.05rem', margin: 0, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</h2>
            {subtitle ? <div style={{ color: 'var(--inv-muted)', fontSize: '0.78rem', marginTop: 2 }}>{subtitle}</div> : null}
          </div>
          <Button variant="ghost" icon={X} onClick={onClose} aria-label="Close" />
        </div>
        <div className="drawer-content">{open ? children : null}</div>
        {footer ? <div className="modal-footer" style={{ padding: '12px 20px', display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--inv-line)' }}>{footer}</div> : null}
      </div>
    </>
  );
}

export function Modal({ open, title, onClose, children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content inv-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--inv-line)' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>{title}</h3>
          <Button variant="ghost" icon={X} onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ── Formatting ──────────────────────────────────────────────────────────── */
export const money = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "5 min ago" for activity feeds; falls back to the date past a day. */
export function fmtAgo(v) {
  if (!v) return '—';
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return String(v);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return fmtDate(v);
}

export function Pager({ canPrev, canNext, onPrev, onNext, label }) {
  return (
    <div className="inv-pager">
      <Button size="sm" disabled={!canPrev} onClick={onPrev}>Previous</Button>
      {label ? <span>{label}</span> : null}
      <Button size="sm" disabled={!canNext} onClick={onNext}>Next</Button>
    </div>
  );
}
