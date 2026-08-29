/**
 * src/components/food/FoodOrderHistory.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2D-B — Food Order History (Back-Office).
 *
 * READ-ONLY screen. Consumes the existing backend endpoint:
 *   GET /api/food/orders/history
 *
 * This component performs NO writes of any kind — no order creation, no
 * status updates, no payment/ledger changes, no Firestore/MySQL writes.
 * It only issues GET requests against endpoints that already exist.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  ClipboardList, Search, RefreshCw, ChevronLeft, ChevronRight, X,
  AlertCircle, Loader, Filter, ArrowUpDown, ChevronDown
} from 'lucide-react';
import { API_URL, getApiHeaders } from '../../config/apiConfig';

// ── Enums (must mirror backend/controllers/foodReportsController.js) ──────────
const ORDER_STATUSES = [
  'DRAFT', 'PLACED', 'RECEIVED', 'PREPARING', 'READY',
  'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED'
];
const PAYMENT_STATUSES  = ['PENDING', 'PAID', 'ROOM_BILL', 'COMPLIMENTARY', 'VOIDED', 'REFUNDED'];
const DESTINATION_TYPES = ['ROOM', 'TABLE', 'STAFF', 'OWNER'];
const SORT_OPTIONS = [
  { value: 'newest',  label: 'Newest First' },
  { value: 'oldest',  label: 'Oldest First' },
  { value: 'highest', label: 'Highest Total' },
  { value: 'lowest',  label: 'Lowest Total' }
];
const PAGE_SIZES = [25, 50, 100];

const EMPTY_FILTERS = {
  order_number:     '',
  order_status:     '',
  payment_status:   '',
  destination_type: '',
  room_number:      '',
  waiter_uid:       '',
  table_id:         '',
  from_date:        '',
  to_date:          ''
};

// ── Formatting helpers ─────────────────────────────────────────────────────────
const fmtMoney = (n) => `₹${Number(n || 0).toFixed(2)}`;

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function destinationLabel(order) {
  switch (order.destination_type) {
    case 'ROOM':  return `Room ${order.room_number || '—'}`;
    case 'TABLE': return order.table_name || 'Table';
    case 'STAFF': return `Staff: ${order.staff_name || '—'}`;
    case 'OWNER': return `Owner: ${order.owner_name || 'Management'}`;
    default:      return order.destination_type || '—';
  }
}

const ORDER_STATUS_COLORS = {
  DRAFT:             { bg: 'rgba(148,163,184,0.15)', border: 'rgba(148,163,184,0.35)', color: '#cbd5e1' },
  PLACED:            { bg: 'rgba(56,189,248,0.15)',  border: 'rgba(56,189,248,0.35)',  color: '#38bdf8' },
  RECEIVED:          { bg: 'rgba(34,211,238,0.15)',  border: 'rgba(34,211,238,0.35)',  color: '#22d3ee' },
  PREPARING:         { bg: 'rgba(251,191,36,0.15)',  border: 'rgba(251,191,36,0.35)',  color: '#fbbf24' },
  READY:             { bg: 'rgba(52,211,153,0.15)',  border: 'rgba(52,211,153,0.35)',  color: '#34d399' },
  OUT_FOR_DELIVERY:  { bg: 'rgba(167,139,250,0.15)', border: 'rgba(167,139,250,0.35)', color: '#a78bfa' },
  DELIVERED:         { bg: 'rgba(45,212,191,0.15)',  border: 'rgba(45,212,191,0.35)',  color: '#2dd4bf' },
  COMPLETED:         { bg: 'rgba(16,185,129,0.18)',  border: 'rgba(16,185,129,0.4)',   color: '#10b981' },
  CANCELLED:         { bg: 'rgba(248,113,113,0.15)', border: 'rgba(248,113,113,0.35)', color: '#f87171' }
};

const PAYMENT_STATUS_COLORS = {
  PENDING:       { bg: 'rgba(251,191,36,0.15)', border: 'rgba(251,191,36,0.35)', color: '#fbbf24' },
  PAID:          { bg: 'rgba(52,211,153,0.15)', border: 'rgba(52,211,153,0.35)', color: '#34d399' },
  ROOM_BILL:     { bg: 'rgba(167,139,250,0.15)',border: 'rgba(167,139,250,0.35)',color: '#a78bfa' },
  COMPLIMENTARY: { bg: 'rgba(56,189,248,0.15)', border: 'rgba(56,189,248,0.35)', color: '#38bdf8' },
  VOIDED:        { bg: 'rgba(148,163,184,0.15)',border: 'rgba(148,163,184,0.35)',color: '#cbd5e1' },
  REFUNDED:      { bg: 'rgba(248,113,113,0.15)',border: 'rgba(248,113,113,0.35)',color: '#f87171' }
};

function Badge({ label, palette }) {
  const p = palette || { bg: 'rgba(255,255,255,0.08)', border: 'rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.7)' };
  return (
    <span style={{
      display:      'inline-block',
      padding:      '3px 9px',
      borderRadius: '20px',
      fontSize:     '0.68rem',
      fontWeight:   '700',
      letterSpacing: '0.3px',
      background:   p.bg,
      border:       `1px solid ${p.border}`,
      color:        p.color,
      whiteSpace:   'nowrap'
    }}>
      {label}
    </span>
  );
}

const inputStyle = {
  width:        '100%',
  padding:      '8px 10px',
  background:   'rgba(0,0,0,0.3)',
  border:       '1px solid rgba(255,255,255,0.12)',
  borderRadius: '7px',
  color:        '#fff',
  fontSize:     '0.8rem',
  outline:      'none',
  boxSizing:    'border-box'
};

const labelStyle = {
  display:      'block',
  fontSize:     '0.66rem',
  fontWeight:   '700',
  letterSpacing: '0.3px',
  color:        'rgba(255,255,255,0.45)',
  marginBottom: '4px',
  textTransform: 'uppercase'
};

// ═══════════════════════════════════════════════════════════════════════════════
// Order Detail Modal (read-only)
// ═══════════════════════════════════════════════════════════════════════════════
function OrderDetailModal({ order, onClose }) {
  if (!order) return null;
  const items = Array.isArray(order.items) ? order.items : [];
  const history = Array.isArray(order.status_history) ? order.status_history : [];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: '20px'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background:   '#0f172a',
          border:       '1px solid rgba(255,255,255,0.12)',
          borderRadius: '16px',
          width:        '100%',
          maxWidth:     '680px',
          maxHeight:    '88vh',
          overflowY:    'auto',
          color:        '#f1f5f9',
          boxShadow:    '0 24px 48px rgba(0,0,0,0.55)'
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          padding: '20px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)'
        }}>
          <div>
            <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.45)', fontWeight: '700', letterSpacing: '0.4px', marginBottom: '4px' }}>
              ORDER DETAILS
            </div>
            <div style={{ fontSize: '1.25rem', fontWeight: '900', color: '#38bdf8' }}>
              {order.order_number || order.order_id}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <Badge label={order.order_status} palette={ORDER_STATUS_COLORS[order.order_status]} />
              <Badge label={order.payment_status} palette={PAYMENT_STATUS_COLORS[order.payment_status]} />
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', padding: '4px' }}
          >
            <X size={20} />
          </button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          {/* Summary grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: '14px', marginBottom: '20px'
          }}>
            <div>
              <div style={labelStyle}>Destination</div>
              <div style={{ fontSize: '0.88rem', fontWeight: '700' }}>{destinationLabel(order)}</div>
            </div>
            <div>
              <div style={labelStyle}>Business Date</div>
              <div style={{ fontSize: '0.88rem', fontWeight: '700' }}>{order.business_date || '—'}</div>
            </div>
            <div>
              <div style={labelStyle}>Placed / Created</div>
              <div style={{ fontSize: '0.88rem', fontWeight: '700' }}>{fmtDateTime(order.created_at)}</div>
            </div>
            <div>
              <div style={labelStyle}>Waiter</div>
              <div style={{ fontSize: '0.88rem', fontWeight: '700' }}>{order.waiter_name || '—'}</div>
            </div>
            <div>
              <div style={labelStyle}>Created By</div>
              <div style={{ fontSize: '0.88rem', fontWeight: '700' }}>{order.created_by_name || '—'}</div>
            </div>
            {order.guest_name && (
              <div>
                <div style={labelStyle}>Guest</div>
                <div style={{ fontSize: '0.88rem', fontWeight: '700' }}>{order.guest_name}</div>
              </div>
            )}
          </div>

          {/* Items table */}
          <div style={labelStyle}>Items ({items.length})</div>
          <div style={{
            border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px',
            overflow: 'hidden', marginBottom: '18px', marginTop: '6px'
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                  <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>ITEM</th>
                  <th style={{ textAlign: 'center', padding: '8px 8px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>QTY</th>
                  <th style={{ textAlign: 'right', padding: '8px 8px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>UNIT PRICE</th>
                  <th style={{ textAlign: 'right', padding: '8px 8px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>TAX</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>LINE TOTAL</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: '16px', textAlign: 'center', color: 'rgba(255,255,255,0.35)' }}>No item data available</td></tr>
                ) : items.map((it, idx) => (
                  <tr key={idx} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '8px 12px' }}>{it.item_name}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'center' }}>{it.quantity}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right' }}>{fmtMoney(it.unit_price)}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: 'rgba(255,255,255,0.6)' }}>{fmtMoney(it.tax_amount)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: '700' }}>{fmtMoney(it.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: '6px',
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '10px', padding: '14px 16px', marginBottom: '20px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: 'rgba(255,255,255,0.6)' }}>
              <span>Subtotal</span><span>{fmtMoney(order.subtotal)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: 'rgba(255,255,255,0.6)' }}>
              <span>Tax</span><span>{fmtMoney(order.tax_total)}</span>
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between', fontSize: '1.05rem', fontWeight: '900',
              color: '#34d399', paddingTop: '8px', marginTop: '4px', borderTop: '1px solid rgba(255,255,255,0.08)'
            }}>
              <span>Grand Total</span><span>{fmtMoney(order.grand_total)}</span>
            </div>
          </div>

          {/* Billing references */}
          {(order.food_payment_id || order.ledger_item_id || order.complimentary_request_id) && (
            <div style={{ marginBottom: '20px' }}>
              <div style={labelStyle}>Billing Reference</div>
              <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.7)', lineHeight: '1.7' }}>
                {order.food_payment_id && <div>Payment ID: <strong>{order.food_payment_id}</strong></div>}
                {order.ledger_item_id && <div>Ledger Item ID: <strong>{order.ledger_item_id}</strong></div>}
                {order.complimentary_request_id && <div>Complimentary Request ID: <strong>{order.complimentary_request_id}</strong></div>}
                {order.billed_at && <div>Billed At: <strong>{fmtDateTime(order.billed_at)}</strong></div>}
              </div>
            </div>
          )}

          {/* Cancellation info */}
          {order.order_status === 'CANCELLED' && (
            <div style={{
              background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
              borderRadius: '10px', padding: '12px 14px', marginBottom: '20px', fontSize: '0.8rem'
            }}>
              <div style={{ color: '#f87171', fontWeight: '700', marginBottom: '4px' }}>Cancelled</div>
              <div style={{ color: 'rgba(255,255,255,0.7)' }}>Reason: {order.cancellation_reason || '—'}</div>
              <div style={{ color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>At: {fmtDateTime(order.cancelled_at)}</div>
            </div>
          )}

          {/* Status timeline */}
          <div>
            <div style={labelStyle}>Status History</div>
            {history.length === 0 ? (
              <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.35)', marginTop: '6px' }}>No status history recorded.</div>
            ) : (
              <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '0' }}>
                {history.map((h, idx) => (
                  <div key={idx} style={{
                    display: 'flex', gap: '12px', padding: '8px 0',
                    borderTop: idx > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none'
                  }}>
                    <div style={{
                      width: '8px', height: '8px', borderRadius: '50%',
                      background: (ORDER_STATUS_COLORS[h.status]?.color) || '#94a3b8',
                      marginTop: '5px', flexShrink: 0
                    }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '0.82rem', fontWeight: '700' }}>
                        {h.status} {h.by_name ? <span style={{ fontWeight: '400', color: 'rgba(255,255,255,0.5)' }}>— {h.by_name}</span> : null}
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>{fmtDateTime(h.ts)}</div>
                      {h.note && <div style={{ fontSize: '0.76rem', color: 'rgba(255,255,255,0.55)', marginTop: '2px' }}>{h.note}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {order.remarks && (
            <div style={{ marginTop: '18px' }}>
              <div style={labelStyle}>Remarks</div>
              <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.7)' }}>{order.remarks}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════
export default function FoodOrderHistory({ token, user }) {
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const [sort, setSort]         = useState('newest');
  const [pageSize, setPageSize] = useState(25);

  const [orders, setOrders]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [warnings, setWarnings] = useState([]);

  const [hasMore, setHasMore]         = useState(false);
  const [nextCursor, setNextCursor]   = useState(null);
  const [currentCursor, setCurrentCursor] = useState(null);
  const [prevCursors, setPrevCursors] = useState([]);
  const [pageNum, setPageNum]         = useState(1);

  const [selectedOrder, setSelectedOrder] = useState(null);

  const [tables, setTables]       = useState([]);
  const [staffList, setStaffList] = useState([]);

  const requestSeq = useRef(0);

  // ── Load filter dropdown sources (read-only, existing endpoints) ────────────
  useEffect(() => {
    fetch(`${API_URL}/food/tables`, { headers: getApiHeaders(token) })
      .then(r => r.json())
      .then(d => setTables(Array.isArray(d.tables) ? d.tables : []))
      .catch(() => {}); // non-fatal — table filter simply stays empty

    fetch(`${API_URL}/food/context/staff`, { headers: getApiHeaders(token) })
      .then(r => r.json())
      .then(d => setStaffList(Array.isArray(d.staff) ? d.staff : []))
      .catch(() => {}); // non-fatal — waiter filter simply stays empty
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Core fetch — always issues a real request against the backend endpoint ──
  async function runQuery({ f = filters, s = sort, ps = pageSize, cursor = null }) {
    const mySeq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (f.order_number.trim())     params.set('order_number', f.order_number.trim());
      if (f.order_status)            params.set('order_status', f.order_status);
      if (f.payment_status)          params.set('payment_status', f.payment_status);
      if (f.destination_type)        params.set('destination_type', f.destination_type);
      if (f.room_number.trim())      params.set('room_number', f.room_number.trim());
      if (f.waiter_uid)              params.set('waiter_uid', f.waiter_uid);
      if (f.table_id)                params.set('table_id', f.table_id);
      if (f.from_date)               params.set('from_date', f.from_date);
      if (f.to_date)                 params.set('to_date', f.to_date);
      params.set('sort', s);
      params.set('page_size', String(ps));
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(`${API_URL}/food/orders/history?${params.toString()}`, {
        headers: getApiHeaders(token)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to load order history (HTTP ${res.status})`);

      // Ignore out-of-order responses (e.g. rapid filter changes)
      if (mySeq !== requestSeq.current) return;

      setOrders(Array.isArray(data.orders) ? data.orders : []);
      setHasMore(Boolean(data.has_more));
      setNextCursor(data.next_cursor || null);
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setCurrentCursor(cursor);
    } catch (err) {
      if (mySeq !== requestSeq.current) return;
      setError(err.message || 'Failed to load order history');
    } finally {
      if (mySeq === requestSeq.current) setLoading(false);
    }
  }

  function resetAndSearch(f = filters, s = sort, ps = pageSize) {
    setPrevCursors([]);
    setPageNum(1);
    runQuery({ f, s, ps, cursor: null });
  }

  // Initial load
  useEffect(() => {
    resetAndSearch(EMPTY_FILTERS, 'newest', 25);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateFilter = (key, val) => setFilters(f => ({ ...f, [key]: val }));

  const handleSearch = () => resetAndSearch(filters, sort, pageSize);

  const handleClearFilters = () => {
    const empty = { ...EMPTY_FILTERS };
    setFilters(empty);
    resetAndSearch(empty, sort, pageSize);
  };

  const handleSortChange = (val) => {
    setSort(val);
    resetAndSearch(filters, val, pageSize);
  };

  const handlePageSizeChange = (val) => {
    setPageSize(val);
    resetAndSearch(filters, sort, val);
  };

  const handleNext = () => {
    if (!hasMore || !nextCursor) return;
    setPrevCursors(p => [...p, currentCursor]);
    setPageNum(n => n + 1);
    runQuery({ cursor: nextCursor });
  };

  const handlePrev = () => {
    if (prevCursors.length === 0) return;
    const stack = [...prevCursors];
    const prevCur = stack.pop();
    setPrevCursors(stack);
    setPageNum(n => Math.max(1, n - 1));
    runQuery({ cursor: prevCur });
  };

  const handleRetry = () => runQuery({ cursor: currentCursor });

  const handleKeyDownSearch = (e) => {
    if (e.key === 'Enter') handleSearch();
  };

  const hasActiveFilters = Object.values(filters).some(v => v !== '');

  return (
    <div style={{ padding: '4px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: '1.1rem', fontWeight: '800', color: '#f1f5f9' }}>
            Food Order History
          </h2>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(255,255,255,0.45)' }}>
            Browse and search past food &amp; beverage orders — read-only
          </p>
        </div>
        <button
          onClick={handleRetry}
          disabled={loading}
          title="Refresh current page"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '8px 14px', background: 'rgba(56,189,248,0.1)',
            border: '1px solid rgba(56,189,248,0.3)', borderRadius: '8px',
            color: '#38bdf8', fontWeight: '700', fontSize: '0.82rem',
            cursor: loading ? 'not-allowed' : 'pointer'
          }}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Filter Bar */}
      <div style={{
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '12px', padding: '16px', marginBottom: '16px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', color: 'rgba(255,255,255,0.5)', fontSize: '0.72rem', fontWeight: '700', letterSpacing: '0.4px' }}>
          <Filter size={13} /> FILTERS
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: '12px', marginBottom: '12px'
        }}>
          <div>
            <label style={labelStyle}>Order Number</label>
            <input
              type="text" placeholder="e.g. FO-20260829-000123"
              value={filters.order_number}
              onChange={(e) => updateFilter('order_number', e.target.value)}
              onKeyDown={handleKeyDownSearch}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Order Status</label>
            <select value={filters.order_status} onChange={(e) => updateFilter('order_status', e.target.value)} style={inputStyle}>
              <option value="">All Statuses</option>
              {ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Payment Status</label>
            <select value={filters.payment_status} onChange={(e) => updateFilter('payment_status', e.target.value)} style={inputStyle}>
              <option value="">All Payment Statuses</option>
              {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Destination</label>
            <select value={filters.destination_type} onChange={(e) => updateFilter('destination_type', e.target.value)} style={inputStyle}>
              <option value="">All Destinations</option>
              {DESTINATION_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Room Number</label>
            <input
              type="text" placeholder="e.g. 204"
              value={filters.room_number}
              onChange={(e) => updateFilter('room_number', e.target.value)}
              onKeyDown={handleKeyDownSearch}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Table</label>
            <select value={filters.table_id} onChange={(e) => updateFilter('table_id', e.target.value)} style={inputStyle}>
              <option value="">All Tables</option>
              {tables.map(t => <option key={t.table_id} value={t.table_id}>{t.table_name}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Waiter</label>
            <select value={filters.waiter_uid} onChange={(e) => updateFilter('waiter_uid', e.target.value)} style={inputStyle}>
              <option value="">All Waiters</option>
              {staffList.map(s => <option key={s.staff_id} value={s.staff_id}>{s.staff_name}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>From Date</label>
            <input type="date" value={filters.from_date} onChange={(e) => updateFilter('from_date', e.target.value)} style={inputStyle} />
          </div>

          <div>
            <label style={labelStyle}>To Date</label>
            <input type="date" value={filters.to_date} onChange={(e) => updateFilter('to_date', e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={handleSearch}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '9px 18px', background: 'linear-gradient(135deg, #38bdf8, #6366f1)',
              border: 'none', borderRadius: '8px', color: '#fff', fontWeight: '700',
              fontSize: '0.82rem', cursor: 'pointer'
            }}
          >
            <Search size={14} /> Search
          </button>

          <button
            onClick={handleClearFilters}
            disabled={!hasActiveFilters}
            style={{
              padding: '9px 16px', background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px',
              color: hasActiveFilters ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)',
              fontWeight: '600', fontSize: '0.82rem',
              cursor: hasActiveFilters ? 'pointer' : 'not-allowed'
            }}
          >
            Clear Filters
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
            <ArrowUpDown size={13} style={{ color: 'rgba(255,255,255,0.4)' }} />
            <select value={sort} onChange={(e) => handleSortChange(e.target.value)} style={{ ...inputStyle, width: 'auto', padding: '7px 10px' }}>
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            <select value={pageSize} onChange={(e) => handlePageSizeChange(Number(e.target.value))} style={{ ...inputStyle, width: 'auto', padding: '7px 10px' }}>
              {PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div style={{
          background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)',
          color: '#fbbf24', padding: '10px 14px', borderRadius: '8px', marginBottom: '14px',
          fontSize: '0.78rem', display: 'flex', alignItems: 'flex-start', gap: '8px'
        }}>
          <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
          <div>{warnings.join(' ')}</div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
          color: '#f87171', padding: '14px 16px', borderRadius: '10px', marginBottom: '16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', fontSize: '0.85rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={18} /> {error}
          </div>
          <button
            onClick={handleRetry}
            style={{
              padding: '6px 14px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)',
              borderRadius: '6px', color: '#f87171', fontWeight: '700', fontSize: '0.78rem', cursor: 'pointer', flexShrink: 0
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px', color: 'rgba(255,255,255,0.4)' }}>
          <Loader className="animate-spin" size={22} style={{ marginRight: '10px' }} /> Loading order history...
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && orders.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '60px 20px', background: 'rgba(255,255,255,0.02)',
          border: '1px dashed rgba(255,255,255,0.1)', borderRadius: '12px', color: 'rgba(255,255,255,0.4)'
        }}>
          <ClipboardList size={40} style={{ opacity: 0.3, margin: '0 auto 12px' }} />
          <h3 style={{ margin: '0 0 6px', color: 'rgba(255,255,255,0.6)' }}>No Orders Found</h3>
          <p style={{ margin: 0, fontSize: '0.82rem' }}>
            {hasActiveFilters ? 'No orders match the current filters.' : 'No food orders have been recorded yet.'}
          </p>
        </div>
      )}

      {/* Order table */}
      {!loading && !error && orders.length > 0 && (
        <>
          <div style={{
            border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px',
            overflow: 'auto', marginBottom: '14px'
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: '860px' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                  <th style={{ textAlign: 'left', padding: '10px 14px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>ORDER #</th>
                  <th style={{ textAlign: 'left', padding: '10px 10px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>DATE / TIME</th>
                  <th style={{ textAlign: 'left', padding: '10px 10px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>DESTINATION</th>
                  <th style={{ textAlign: 'left', padding: '10px 10px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>WAITER</th>
                  <th style={{ textAlign: 'left', padding: '10px 10px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>STATUS</th>
                  <th style={{ textAlign: 'left', padding: '10px 10px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>PAYMENT</th>
                  <th style={{ textAlign: 'right', padding: '10px 14px', color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem' }}>TOTAL</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(order => (
                  <tr
                    key={order.order_id}
                    onClick={() => setSelectedOrder(order)}
                    style={{ borderTop: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '10px 14px', fontWeight: '700', color: '#38bdf8' }}>{order.order_number || order.order_id}</td>
                    <td style={{ padding: '10px 10px', color: 'rgba(255,255,255,0.75)', whiteSpace: 'nowrap' }}>{fmtDateTime(order.created_at)}</td>
                    <td style={{ padding: '10px 10px', color: 'rgba(255,255,255,0.75)' }}>{destinationLabel(order)}</td>
                    <td style={{ padding: '10px 10px', color: 'rgba(255,255,255,0.6)' }}>{order.waiter_name || '—'}</td>
                    <td style={{ padding: '10px 10px' }}><Badge label={order.order_status} palette={ORDER_STATUS_COLORS[order.order_status]} /></td>
                    <td style={{ padding: '10px 10px' }}><Badge label={order.payment_status} palette={PAYMENT_STATUS_COLORS[order.payment_status]} /></td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: '800', color: '#34d399' }}>{fmtMoney(order.grand_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.45)' }}>
              Page {pageNum} · {orders.length} order{orders.length === 1 ? '' : 's'} shown
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handlePrev}
                disabled={prevCursors.length === 0 || loading}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                  padding: '8px 14px', background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.12)', borderRadius: '7px',
                  color: (prevCursors.length === 0 || loading) ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.8)',
                  fontWeight: '600', fontSize: '0.8rem',
                  cursor: (prevCursors.length === 0 || loading) ? 'not-allowed' : 'pointer'
                }}
              >
                <ChevronLeft size={15} /> Previous
              </button>
              <button
                onClick={handleNext}
                disabled={!hasMore || loading}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                  padding: '8px 14px', background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.12)', borderRadius: '7px',
                  color: (!hasMore || loading) ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.8)',
                  fontWeight: '600', fontSize: '0.8rem',
                  cursor: (!hasMore || loading) ? 'not-allowed' : 'pointer'
                }}
              >
                Next <ChevronRight size={15} />
              </button>
            </div>
          </div>
        </>
      )}

      {selectedOrder && (
        <OrderDetailModal order={selectedOrder} onClose={() => setSelectedOrder(null)} />
      )}
    </div>
  );
}
