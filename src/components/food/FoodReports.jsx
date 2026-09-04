/**
 * src/components/food/FoodReports.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2D-C — Food Order Reports (Back-Office).
 *
 * READ-ONLY screen. Consumes the existing backend endpoint:
 *   GET /api/food/reports/summary
 *
 * One request returns every breakdown; switching "Report Type" below only
 * changes which already-fetched table is displayed -- it never triggers a
 * second network call. This component performs NO writes of any kind.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  BarChart3, Filter, RefreshCw, AlertCircle, Loader, Download,
  Calendar, TrendingUp, Receipt, XCircle
} from 'lucide-react';
import { API_URL, getApiHeaders } from '../../config/apiConfig';
import { calculatePresetDateRange, formatDateOnly } from '../../utils/reportDateUtils';
import { exportToCSV, exportToExcel, exportToPDF } from '../../utils/exportUtils';

const ORDER_STATUSES = [
  'DRAFT', 'PLACED', 'RECEIVED', 'PREPARING', 'READY',
  'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED'
];
const PAYMENT_STATUSES  = ['PENDING', 'PAID', 'ROOM_BILL', 'COMPLIMENTARY', 'VOIDED', 'REFUNDED'];
const DESTINATION_TYPES = ['ROOM', 'TABLE', 'STAFF', 'OWNER'];
const DATE_PRESETS = ['Today', 'Yesterday', 'This Week', 'This Month', 'This Year', 'Custom Date Range'];

const REPORT_TYPES = [
  { value: 'byDate',          label: 'Sales by Date',            columns: ['Date', 'Orders', 'Sales', 'Avg Order Value'] },
  { value: 'byOrderStatus',   label: 'Sales by Order Status',     columns: ['Status', 'Orders', 'Sales'] },
  { value: 'byPaymentStatus', label: 'Sales by Payment Status',   columns: ['Payment Status', 'Orders', 'Sales'] },
  { value: 'byDestination',   label: 'Sales by Destination',      columns: ['Destination', 'Orders', 'Sales'] },
  { value: 'byWaiter',        label: 'Sales by Waiter',           columns: ['Waiter', 'Orders', 'Sales', 'Avg Order Value'] },
  { value: 'byItem',          label: 'Sales by Menu Item',        columns: ['Item', 'Qty Sold', 'Sales', 'Orders'] },
  { value: 'byCategory',      label: 'Sales by Category',         columns: ['Category', 'Qty Sold', 'Sales'] },
  { value: 'byRoom',          label: 'Room Food Sales',           columns: ['Room', 'Orders', 'Sales'] },
  { value: 'tax',             label: 'Tax Summary',               columns: ['Tax Type', 'Tax Rate %', 'Taxable Amount', 'Tax Amount'] },
];

const EMPTY_FILTERS = {
  order_status: '', payment_status: '', destination_type: '',
  waiter_uid: '', room_number: '', table_id: '', category_id: ''
};

const fmtMoney = (n) => `₹${Number(n || 0).toFixed(2)}`;

const inputStyle = {
  width: '100%', padding: '8px 10px', background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.12)', borderRadius: '7px',
  color: '#fff', fontSize: '0.8rem', outline: 'none', boxSizing: 'border-box'
};

const labelStyle = {
  display: 'block', fontSize: '0.66rem', fontWeight: '700', letterSpacing: '0.3px',
  color: 'rgba(255,255,255,0.45)', marginBottom: '4px', textTransform: 'uppercase'
};

function StatCard({ label, value, color = '#f1f5f9', sub }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '10px', padding: '14px 16px', minWidth: '140px', flex: '1 1 140px'
    }}>
      <div style={{ fontSize: '0.68rem', fontWeight: '700', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</div>
      <div style={{ fontSize: '1.3rem', fontWeight: '900', color, marginTop: '4px' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>{sub}</div>}
    </div>
  );
}

function rowsForReportType(type, data) {
  if (!data) return [];
  switch (type) {
    case 'byDate':
      return (data.byDate || []).map(r => [r.date, r.orders, fmtMoney(r.sales), fmtMoney(r.avgOrderValue)]);
    case 'byOrderStatus':
      return (data.byOrderStatus || []).map(r => [r.status, r.count, fmtMoney(r.sales)]);
    case 'byPaymentStatus':
      // PENDING is the existing canonical "not yet paid" value — labeled for
      // staff clarity without changing the stored value.
      return (data.byPaymentStatus || []).map(r => [r.status === 'PENDING' ? 'PENDING (Pay Later)' : r.status, r.count, fmtMoney(r.sales)]);
    case 'byDestination':
      return (data.byDestination || []).map(r => [r.destination, r.count, fmtMoney(r.sales)]);
    case 'byWaiter':
      return (data.byWaiter || []).map(r => [r.waiter_name, r.orders, fmtMoney(r.sales), fmtMoney(r.avgOrderValue)]);
    case 'byItem':
      return (data.byItem || []).map(r => [r.item_name, r.qty, fmtMoney(r.sales), r.orders]);
    case 'byCategory':
      return (data.byCategory || []).map(r => [r.category_name, r.qty, fmtMoney(r.sales)]);
    case 'byRoom':
      return (data.byRoom || []).map(r => [r.room_number, r.orders, fmtMoney(r.sales)]);
    case 'tax':
      return (data.tax?.byTaxType || []).map(r => [r.tax_type, r.tax_rate, fmtMoney(r.taxableAmount), fmtMoney(r.taxAmount)]);
    default:
      return [];
  }
}

export default function FoodReports({ token, user }) {
  const [businessDate, setBusinessDate] = useState('');
  const [preset, setPreset] = useState('Today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const [reportType, setReportType] = useState('byDate');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [tables, setTables] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [categories, setCategories] = useState([]);

  const requestSeq = useRef(0);
  const lastRangeRef = useRef({ from: '', to: '' });

  // ── Load business date + filter dropdown sources (read-only) ────────────────
  useEffect(() => {
    fetch(`${API_URL}/status`, { headers: getApiHeaders(token) })
      .then(r => r.json())
      .then(d => { if (d.systemDate) setBusinessDate(formatDateOnly(d.systemDate)); })
      .catch(() => {});

    fetch(`${API_URL}/food/tables`, { headers: getApiHeaders(token) })
      .then(r => r.json())
      .then(d => setTables(Array.isArray(d.tables) ? d.tables : []))
      .catch(() => {});

    fetch(`${API_URL}/food/context/staff`, { headers: getApiHeaders(token) })
      .then(r => r.json())
      .then(d => setStaffList(Array.isArray(d.staff) ? d.staff : []))
      .catch(() => {});

    fetch(`${API_URL}/food/categories`, { headers: getApiHeaders(token) })
      .then(r => r.json())
      .then(d => setCategories(Array.isArray(d.categories) ? d.categories : []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Core fetch ────────────────────────────────────────────────────────────
  async function runQuery(range, f) {
    const mySeq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (range.from) params.set('from_date', range.from);
      if (range.to)   params.set('to_date', range.to);
      if (f.order_status)     params.set('order_status', f.order_status);
      if (f.payment_status)   params.set('payment_status', f.payment_status);
      if (f.destination_type) params.set('destination_type', f.destination_type);
      if (f.waiter_uid)       params.set('waiter_uid', f.waiter_uid);
      if (f.room_number.trim()) params.set('room_number', f.room_number.trim());
      if (f.table_id)         params.set('table_id', f.table_id);
      if (f.category_id)      params.set('category_id', f.category_id);

      const res = await fetch(`${API_URL}/food/reports/summary?${params.toString()}`, {
        headers: getApiHeaders(token)
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed to load reports (HTTP ${res.status})`);

      if (mySeq !== requestSeq.current) return;
      setData(json);
    } catch (err) {
      if (mySeq !== requestSeq.current) return;
      setError(err.message || 'Failed to load reports');
    } finally {
      if (mySeq === requestSeq.current) setLoading(false);
    }
  }

  function resolveRange(presetVal = preset, from = customFrom, to = customTo) {
    if (!businessDate && presetVal !== 'Custom Date Range') return null;
    const r = calculatePresetDateRange(presetVal, businessDate, from, to);
    return r ? { from: r.startStr, to: r.endStr } : null;
  }

  // Fetch once the business date first becomes available (initial "Today" load)
  useEffect(() => {
    if (!businessDate) return;
    const range = resolveRange('Today', '', '');
    if (!range) return;
    lastRangeRef.current = range;
    runQuery(range, EMPTY_FILTERS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessDate]);

  const handlePresetChange = (val) => {
    setPreset(val);
    if (val === 'Custom Date Range') return; // wait for both custom dates
    const range = resolveRange(val, customFrom, customTo);
    if (!range) return;
    lastRangeRef.current = range;
    runQuery(range, filters);
  };

  const handleCustomDateApply = () => {
    if (!customFrom && !customTo) return;
    const range = resolveRange('Custom Date Range', customFrom, customTo);
    if (!range) return;
    lastRangeRef.current = range;
    runQuery(range, filters);
  };

  const updateFilter = (key, val) => setFilters(f => ({ ...f, [key]: val }));

  const handleApplyFilters = () => {
    runQuery(lastRangeRef.current, filters);
  };

  const handleClearFilters = () => {
    const empty = { ...EMPTY_FILTERS };
    setFilters(empty);
    runQuery(lastRangeRef.current, empty);
  };

  const handleRetry = () => runQuery(lastRangeRef.current, filters);

  const activeReportMeta = REPORT_TYPES.find(r => r.value === reportType);
  const activeRows = rowsForReportType(reportType, data);
  const filtersLabel = data ? `${data.range.from_date} to ${data.range.to_date}` : '';

  const handleExport = (fmt) => {
    if (!activeReportMeta || activeRows.length === 0) return;
    const title = `Food_${activeReportMeta.label.replace(/\s+/g, '_')}`;
    if (fmt === 'csv')   exportToCSV(title, activeReportMeta.columns, activeRows, filtersLabel);
    if (fmt === 'excel') exportToExcel(title, activeReportMeta.columns, activeRows, filtersLabel);
    if (fmt === 'pdf')   exportToPDF(title, activeReportMeta.columns, activeRows, filtersLabel);
  };

  const hasActiveFilters = Object.values(filters).some(v => v !== '');
  const noData = data && data.summary.totalOrders === 0;

  return (
    <div style={{ padding: '4px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: '1.1rem', fontWeight: '800', color: '#f1f5f9' }}>
            Food Reports
          </h2>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(255,255,255,0.45)' }}>
            Sales, tax, and operational breakdowns — read-only
          </p>
        </div>
        <button
          onClick={handleRetry}
          disabled={loading}
          title="Refresh current report"
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

      {/* Date range presets */}
      <div style={{
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '12px', padding: '16px', marginBottom: '14px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', color: 'rgba(255,255,255,0.5)', fontSize: '0.72rem', fontWeight: '700', letterSpacing: '0.4px' }}>
          <Calendar size={13} /> DATE RANGE
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {DATE_PRESETS.map(p => (
            <button
              key={p}
              onClick={() => handlePresetChange(p)}
              style={{
                padding: '8px 14px', borderRadius: '8px',
                border: preset === p ? '1px solid #38bdf8' : '1px solid rgba(255,255,255,0.1)',
                background: preset === p ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.03)',
                color: preset === p ? '#38bdf8' : 'rgba(255,255,255,0.7)',
                fontWeight: '600', fontSize: '0.78rem', cursor: 'pointer'
              }}
            >
              {p}
            </button>
          ))}
          {preset === 'Custom Date Range' && (
            <>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} style={{ ...inputStyle, width: 'auto' }} />
              <span style={{ color: 'rgba(255,255,255,0.4)' }}>to</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} style={{ ...inputStyle, width: 'auto' }} />
              <button
                onClick={handleCustomDateApply}
                style={{ padding: '8px 14px', background: 'linear-gradient(135deg, #38bdf8, #6366f1)', border: 'none', borderRadius: '8px', color: '#fff', fontWeight: '700', fontSize: '0.78rem', cursor: 'pointer' }}
              >
                Apply
              </button>
            </>
          )}
          {data && (
            <span style={{ marginLeft: 'auto', fontSize: '0.76rem', color: 'rgba(255,255,255,0.45)' }}>
              Showing: <strong style={{ color: '#f1f5f9' }}>{data.range.from_date}</strong> to <strong style={{ color: '#f1f5f9' }}>{data.range.to_date}</strong>
            </span>
          )}
        </div>
      </div>

      {/* Secondary filters */}
      <div style={{
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '12px', padding: '16px', marginBottom: '16px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', color: 'rgba(255,255,255,0.5)', fontSize: '0.72rem', fontWeight: '700', letterSpacing: '0.4px' }}>
          <Filter size={13} /> FILTERS
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '12px', marginBottom: '12px' }}>
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
            <label style={labelStyle}>Waiter</label>
            <select value={filters.waiter_uid} onChange={(e) => updateFilter('waiter_uid', e.target.value)} style={inputStyle}>
              <option value="">All Waiters</option>
              {staffList.map(s => <option key={s.staff_id} value={s.staff_id}>{s.staff_name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Room Number</label>
            <input type="text" placeholder="e.g. 204" value={filters.room_number} onChange={(e) => updateFilter('room_number', e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Table</label>
            <select value={filters.table_id} onChange={(e) => updateFilter('table_id', e.target.value)} style={inputStyle}>
              <option value="">All Tables</option>
              {tables.map(t => <option key={t.table_id} value={t.table_id}>{t.table_name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Category</label>
            <select value={filters.category_id} onChange={(e) => updateFilter('category_id', e.target.value)} style={inputStyle}>
              <option value="">All Categories</option>
              {categories.map(c => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={handleApplyFilters}
            style={{ padding: '9px 18px', background: 'linear-gradient(135deg, #38bdf8, #6366f1)', border: 'none', borderRadius: '8px', color: '#fff', fontWeight: '700', fontSize: '0.82rem', cursor: 'pointer' }}
          >
            Apply Filters
          </button>
          <button
            onClick={handleClearFilters}
            disabled={!hasActiveFilters}
            style={{
              padding: '9px 16px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '8px', color: hasActiveFilters ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)',
              fontWeight: '600', fontSize: '0.82rem', cursor: hasActiveFilters ? 'pointer' : 'not-allowed'
            }}
          >
            Clear Filters
          </button>
        </div>
      </div>

      {/* Truncation warning */}
      {data?.truncated && (
        <div style={{
          background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)',
          color: '#fbbf24', padding: '10px 14px', borderRadius: '8px', marginBottom: '14px',
          fontSize: '0.78rem', display: 'flex', alignItems: 'flex-start', gap: '8px'
        }}>
          <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
          <div>{(data.warnings || []).join(' ')}</div>
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
            style={{ padding: '6px 14px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '6px', color: '#f87171', fontWeight: '700', fontSize: '0.78rem', cursor: 'pointer', flexShrink: 0 }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px', color: 'rgba(255,255,255,0.4)' }}>
          <Loader className="animate-spin" size={22} style={{ marginRight: '10px' }} /> Loading reports...
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && noData && (
        <div style={{
          textAlign: 'center', padding: '60px 20px', background: 'rgba(255,255,255,0.02)',
          border: '1px dashed rgba(255,255,255,0.1)', borderRadius: '12px', color: 'rgba(255,255,255,0.4)'
        }}>
          <BarChart3 size={40} style={{ opacity: 0.3, margin: '0 auto 12px' }} />
          <h3 style={{ margin: '0 0 6px', color: 'rgba(255,255,255,0.6)' }}>No Orders For This Period</h3>
          <p style={{ margin: 0, fontSize: '0.82rem' }}>
            No food orders were placed in the selected date range{hasActiveFilters ? ' matching the current filters' : ''}.
          </p>
        </div>
      )}

      {/* Report content */}
      {!loading && !error && data && !noData && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '18px' }}>
            <StatCard label="Total Orders" value={data.summary.totalOrders} />
            <StatCard label="Gross Sales" value={fmtMoney(data.summary.grossSales)} color="#38bdf8" />
            <StatCard label="Tax" value={fmtMoney(data.summary.taxTotal)} color="#a78bfa" />
            <StatCard label="Grand Total" value={fmtMoney(data.summary.grandTotal)} color="#34d399" />
            <StatCard label="Paid" value={data.summary.paidOrders} color="#34d399" />
            <StatCard label="Unpaid" value={data.summary.unpaidOrders} color="#fbbf24" />
            <StatCard label="Room Bill" value={data.summary.roomBillOrders} color="#a78bfa" />
            <StatCard label="Complimentary" value={data.summary.complimentaryOrders} color="#38bdf8" />
            <StatCard label="Cancelled" value={data.summary.cancelledOrders} color="#f87171"
              sub={data.cancellation.count > 0 ? `${fmtMoney(data.cancellation.grandTotalOfCancelledOrders)} order total` : null} />
          </div>

          {/* Report type selector + export */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <TrendingUp size={15} style={{ color: 'rgba(255,255,255,0.5)' }} />
              <select value={reportType} onChange={(e) => setReportType(e.target.value)} style={{ ...inputStyle, width: 'auto', minWidth: '220px' }}>
                {REPORT_TYPES.map(rt => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => handleExport('csv')} disabled={activeRows.length === 0} style={exportBtnStyle(activeRows.length > 0)}>
                <Download size={14} /> CSV
              </button>
              <button onClick={() => handleExport('excel')} disabled={activeRows.length === 0} style={exportBtnStyle(activeRows.length > 0)}>
                <Download size={14} /> Excel
              </button>
              <button onClick={() => handleExport('pdf')} disabled={activeRows.length === 0} style={exportBtnStyle(activeRows.length > 0)}>
                <Download size={14} /> PDF
              </button>
            </div>
          </div>

          {/* Breakdown table */}
          {activeRows.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: '40px 20px', background: 'rgba(255,255,255,0.02)',
              border: '1px dashed rgba(255,255,255,0.1)', borderRadius: '12px', color: 'rgba(255,255,255,0.35)'
            }}>
              <XCircle size={28} style={{ opacity: 0.3, marginBottom: '8px' }} />
              <div style={{ fontSize: '0.85rem' }}>No data for "{activeReportMeta.label}" in this period.</div>
            </div>
          ) : (
            <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: '600px' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                    {activeReportMeta.columns.map((c, i) => (
                      <th key={c} style={{
                        textAlign: i === 0 ? 'left' : 'right', padding: '10px 14px',
                        color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: '0.68rem'
                      }}>{c.toUpperCase()}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeRows.map((row, idx) => (
                    <tr key={idx} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      {row.map((cell, ci) => (
                        <td key={ci} style={{
                          padding: '9px 14px', textAlign: ci === 0 ? 'left' : 'right',
                          color: ci === 0 ? '#f1f5f9' : 'rgba(255,255,255,0.8)',
                          fontWeight: ci === 0 ? '600' : '400'
                        }}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function exportBtnStyle(enabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: '5px',
    padding: '7px 12px', background: enabled ? 'rgba(52,211,153,0.1)' : 'rgba(255,255,255,0.03)',
    border: enabled ? '1px solid rgba(52,211,153,0.3)' : '1px solid rgba(255,255,255,0.08)',
    borderRadius: '7px', color: enabled ? '#34d399' : 'rgba(255,255,255,0.25)',
    fontWeight: '700', fontSize: '0.76rem', cursor: enabled ? 'pointer' : 'not-allowed'
  };
}
