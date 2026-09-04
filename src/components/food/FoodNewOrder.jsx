/**
 * FoodNewOrder.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2A + 2B — New Food Order: Destination → Menu → Basket → Review → Billing
 *
 * Allows a receptionist or admin to:
 *   1. Select order destination (Room / Table / Staff / Owner)
 *   2. Select Waiter (Mandatory for operational delivery)
 *   3. Browse and search active menu items
 *   4. Build a basket with quantity controls
 *   5. Review the full order before placing it
 *   6. Seamlessly continue to atomic billing (Pay Now / Room Bill / Complimentary)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Search, Plus, Minus, Trash2, ShoppingCart,
  ChevronRight, ArrowLeft, CheckCircle,
  Home, Layers, User, Crown, AlertTriangle,
  UtensilsCrossed, RefreshCw, Loader, DollarSign
} from 'lucide-react';
import { API_URL, getApiHeaders } from '../../config/apiConfig';
import FoodCategoryBar from './FoodCategoryBar';
import FoodOrderBilling from './FoodOrderBilling';

const FOOD_BASE = `${API_URL}/food`;

const fmt = (n) => `₹${Number(n).toFixed(2)}`;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const DEST_TYPES = [
  { key: 'ROOM',  label: 'Room',  icon: Home,   color: '#38bdf8' },
  { key: 'TABLE', label: 'Table', icon: Layers,  color: '#a78bfa' },
  { key: 'STAFF', label: 'Staff', icon: User,    color: '#34d399' },
  { key: 'OWNER', label: 'Owner', icon: Crown,   color: '#fbbf24' }
];

const glass = {
  background:   'rgba(255,255,255,0.03)',
  border:       '1px solid rgba(255,255,255,0.08)',
  borderRadius: '12px'
};

const inputStyle = {
  width:        '100%',
  padding:      '10px 14px',
  background:   'rgba(0,0,0,0.3)',
  border:       '1px solid rgba(255,255,255,0.1)',
  borderRadius: '8px',
  color:        '#f1f5f9',
  fontSize:     '0.88rem',
  outline:      'none',
  fontFamily:   'var(--font-body, Inter, sans-serif)',
  boxSizing:    'border-box'
};

const labelStyle = {
  display:       'block',
  fontSize:      '0.72rem',
  fontWeight:    '600',
  color:         'rgba(255,255,255,0.45)',
  marginBottom:  '5px',
  letterSpacing: '0.4px',
  textTransform: 'uppercase'
};

const btnPrimary = {
  display:      'inline-flex',
  alignItems:   'center',
  gap:          '6px',
  padding:      '10px 20px',
  background:   'linear-gradient(135deg, rgba(56,189,248,0.25), rgba(99,102,241,0.25))',
  border:       '1px solid rgba(56,189,248,0.4)',
  borderRadius: '8px',
  color:        '#38bdf8',
  cursor:       'pointer',
  fontSize:     '0.85rem',
  fontWeight:   '700',
  transition:   'all 0.18s ease',
  fontFamily:   'var(--font-body, Inter, sans-serif)'
};

const btnSecondary = {
  ...btnPrimary,
  background: 'rgba(255,255,255,0.05)',
  border:     '1px solid rgba(255,255,255,0.12)',
  color:      'rgba(255,255,255,0.7)'
};

const btnSuccess = {
  ...btnPrimary,
  background: 'linear-gradient(135deg, rgba(74,222,128,0.25), rgba(52,211,153,0.25))',
  border:     '1px solid rgba(74,222,128,0.4)',
  color:      '#4ade80'
};

function hexToRgb(hex) {
  const c = hex.replace('#', '');
  return `${parseInt(c.slice(0,2),16)},${parseInt(c.slice(2,4),16)},${parseInt(c.slice(4,6),16)}`;
}

function SectionLabel({ children }) {
  return (
    <p style={{ margin: '0 0 10px 0', fontSize: '0.72rem', fontWeight: '700',
      color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
      {children}
    </p>
  );
}

function InlineError({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px',
      background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
      borderRadius: '8px', color: '#f87171', fontSize: '0.82rem', marginTop: '8px' }}>
      <AlertTriangle size={14} /> {msg}
    </div>
  );
}

function DestinationPanel({
  destType, setDestType,
  rooms, loadingRooms, roomSearch, setRoomSearch, selectedRoom, setSelectedRoom,
  staffList, loadingStaff, selectedStaff, setSelectedStaff,
  tablesList, loadingTables, selectedTable, setSelectedTable,
  ownerName, setOwnerName,
  waiterList, selectedWaiter, setSelectedWaiter,
  destError
}) {
  const filteredRooms = useMemo(() => {
    if (!roomSearch.trim()) return rooms;
    const q = roomSearch.trim().toLowerCase();
    return rooms.filter(r =>
      String(r.room_number).includes(q) ||
      (r.guest_name || '').toLowerCase().includes(q) ||
      (r.type || '').toLowerCase().includes(q)
    );
  }, [rooms, roomSearch]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <SectionLabel>Order Destination & Server</SectionLabel>

      {/* Type pills */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {DEST_TYPES.map(dt => {
          const Icon = dt.icon;
          const active = destType === dt.key;
          return (
            <button key={dt.key}
              onClick={() => { setDestType(dt.key); setSelectedRoom(null); setSelectedStaff(null); setSelectedTable(null); }}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '8px 16px', borderRadius: '8px', cursor: 'pointer',
                fontWeight: '700', fontSize: '0.83rem', transition: 'all 0.15s ease',
                fontFamily: 'var(--font-body, Inter, sans-serif)',
                background: active ? `rgba(${hexToRgb(dt.color)},0.15)` : 'rgba(255,255,255,0.04)',
                border: active ? `1px solid ${dt.color}` : '1px solid rgba(255,255,255,0.1)',
                color: active ? dt.color : 'rgba(255,255,255,0.5)'
              }}>
              <Icon size={14} />{dt.label}
            </button>
          );
        })}
      </div>

      {/* Room selector */}
      {destType === 'ROOM' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.3)' }} />
            <input style={{ ...inputStyle, paddingLeft: '32px' }}
              placeholder="Search by room number or guest name…"
              value={roomSearch} onChange={e => { setRoomSearch(e.target.value); setSelectedRoom(null); }} />
          </div>
          {loadingRooms ? (
            <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.8rem', padding: '8px' }}>Loading rooms…</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
              {filteredRooms.map(room => {
                const isSelected = selectedRoom?.room_id === room.room_id;
                const isOccupied = room.status === 'occupied';
                return (
                  <button key={room.room_id}
                    onClick={() => setSelectedRoom(isSelected ? null : room)}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                      padding: '10px 14px', borderRadius: '8px', cursor: 'pointer',
                      textAlign: 'left', transition: 'all 0.15s ease',
                      fontFamily: 'var(--font-body, Inter, sans-serif)',
                      background: isSelected ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.03)',
                      border: isSelected ? '1px solid rgba(56,189,248,0.4)' : '1px solid rgba(255,255,255,0.07)',
                      opacity: (!isOccupied && destType === 'ROOM') ? 0.45 : 1
                    }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%' }}>
                      <span style={{ fontWeight: '800', fontSize: '0.95rem', color: isSelected ? '#38bdf8' : '#f1f5f9' }}>
                        Room {room.room_number}
                      </span>
                      <span style={{
                        fontSize: '0.6rem', padding: '1px 6px', borderRadius: '4px', fontWeight: '700',
                        background: isOccupied ? 'rgba(74,222,128,0.12)' : 'rgba(148,163,184,0.1)',
                        border: isOccupied ? '1px solid rgba(74,222,128,0.3)' : '1px solid rgba(148,163,184,0.2)',
                        color: isOccupied ? '#4ade80' : '#94a3b8', marginLeft: 'auto'
                      }}>
                        {isOccupied ? 'IN' : room.status?.toUpperCase() || 'VACANT'}
                      </span>
                    </div>
                    {room.guest_name && (
                      <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>
                        {room.guest_name}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Table selector */}
      {destType === 'TABLE' && (
        <div>
          <label style={labelStyle}>Select Restaurant Table *</label>
          {loadingTables ? (
            <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.8rem' }}>Loading tables…</div>
          ) : (
            <select
              style={inputStyle}
              value={selectedTable?.table_id || ''}
              onChange={e => {
                const found = tablesList.find(t => t.table_id === e.target.value);
                setSelectedTable(found || null);
              }}
            >
              <option value="">— Select Table —</option>
              {tablesList.map(tbl => (
                <option key={tbl.table_id} value={tbl.table_id}>
                  {tbl.table_name} ({tbl.capacity} seats - {tbl.location})
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Staff selector */}
      {destType === 'STAFF' && (
        <div>
          <label style={labelStyle}>Staff Member *</label>
          <select style={inputStyle} value={selectedStaff?.staff_id || ''}
            onChange={e => {
              const found = staffList.find(s => s.staff_id === e.target.value);
              setSelectedStaff(found || null);
            }}>
            <option value="">— Select staff member —</option>
            {staffList.map(s => (
              <option key={s.staff_id} value={s.staff_id}>
                {s.staff_name}{s.role ? ` (${s.role})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Owner selector */}
      {destType === 'OWNER' && (
        <div>
          <label style={labelStyle}>Owner / Manager Name *</label>
          <input style={inputStyle} placeholder="e.g. Management, General Manager"
            value={ownerName} onChange={e => setOwnerName(e.target.value)} />
        </div>
      )}

      {/* Mandatory Server / Waiter Selection */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '12px' }}>
        <label style={labelStyle}>Assigned Waiter / Server *</label>
        <select
          style={inputStyle}
          value={selectedWaiter?.staff_id || ''}
          onChange={e => {
            const found = waiterList.find(w => w.staff_id === e.target.value);
            setSelectedWaiter(found || null);
          }}
        >
          <option value="">— Select Assigned Waiter —</option>
          {waiterList.map(w => (
            <option key={w.staff_id} value={w.staff_id}>
              {w.staff_name}
            </option>
          ))}
        </select>
      </div>

      <InlineError msg={destError} />
    </div>
  );
}

function MenuItemOrderCard({ item, basketQty, onAdd }) {
  const inBasket = basketQty > 0;
  return (
    <div style={{
      ...glass, padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: '8px',
      transition: 'border-color 0.15s ease',
      border: inBasket ? '1px solid rgba(56,189,248,0.3)' : '1px solid rgba(255,255,255,0.07)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.6rem', color: item.is_veg ? '#4ade80' : '#f87171',
              border: `1px solid ${item.is_veg ? '#4ade80' : '#f87171'}`, borderRadius: '3px',
              padding: '0 4px', fontWeight: '700' }}>
              ●
            </span>
            <span style={{ fontWeight: '700', fontSize: '0.88rem', color: '#f1f5f9' }}>{item.name}</span>
            {inBasket && (
              <span style={{ fontSize: '0.6rem', padding: '1px 7px', borderRadius: '10px',
                background: 'rgba(56,189,248,0.15)', border: '1px solid rgba(56,189,248,0.3)',
                color: '#38bdf8', fontWeight: '700' }}>
                ×{basketQty}
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontWeight: '800', fontSize: '0.92rem', color: '#38bdf8' }}>
            {fmt(item.base_price)}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto' }}>
        <button
          onClick={() => onAdd(item)}
          style={{
            ...btnPrimary, padding: '5px 12px', fontSize: '0.75rem',
            background: inBasket ? 'rgba(56,189,248,0.2)' : 'rgba(255,255,255,0.05)',
            border: inBasket ? '1px solid #38bdf8' : '1px solid rgba(255,255,255,0.12)'
          }}>
          <Plus size={12} /> {inBasket ? 'Add More' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function BasketLine({ line, onQtyChange, onRemove }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', gap: '8px'
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: '600', fontSize: '0.82rem', color: '#f1f5f9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {line.item_name}
        </div>
        <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>
          {fmt(line.unit_price)} × {line.quantity} = {fmt(line.line_total)}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <button onClick={() => onQtyChange(line.item_id, -1)} style={{ ...btnSecondary, padding: '3px 7px' }}>
          <Minus size={10} />
        </button>
        <span style={{ fontSize: '0.82rem', fontWeight: '700', minWidth: '18px', textAlign: 'center', color: '#fff' }}>
          {line.quantity}
        </span>
        <button onClick={() => onQtyChange(line.item_id, 1)} style={{ ...btnSecondary, padding: '3px 7px' }}>
          <Plus size={10} />
        </button>
        <button onClick={() => onRemove(line.item_id)} style={{ background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', padding: '4px' }}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function OrderTotals({ subtotal, taxTotal, grandTotal }) {
  return (
    <div style={{ marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>
        <span>Subtotal</span>
        <span>{fmt(subtotal)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>
        <span>Taxes</span>
        <span>{fmt(taxTotal)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.95rem', fontWeight: '800', color: '#34d399', paddingTop: '4px', borderTop: '1px dashed rgba(255,255,255,0.1)' }}>
        <span>Grand Total</span>
        <span>{fmt(grandTotal)}</span>
      </div>
    </div>
  );
}

function buildBasketLine(item, qty) {
  const unitPrice   = Number(item.base_price);
  const taxRate     = Number(item.tax_rate) || 0;
  const subTotal    = round2(unitPrice * qty);
  const taxAmount   = round2(subTotal * taxRate / 100);
  const lineTotal   = round2(subTotal + taxAmount);

  return {
    item_id:       item.item_id,
    item_name:     item.name,
    category_id:   item.category_id   || null,
    category_name: item.category_name || null,
    quantity:      qty,
    unit_price:    unitPrice,
    tax_rate:      taxRate,
    tax_type:      item.tax_type || 'GST',
    tax_amount:    taxAmount,
    line_subtotal: subTotal,
    line_total:    lineTotal,
    kot_type:      item.kot_type || 'KITCHEN',
    is_veg:        item.is_veg === true
  };
}

function computeTotals(basket) {
  let subtotal = 0;
  let taxTotal = 0;
  for (const line of basket) {
    subtotal += line.line_subtotal;
    taxTotal += line.tax_amount;
  }
  return {
    subtotal:   round2(subtotal),
    taxTotal:   round2(taxTotal),
    grandTotal: round2(subtotal + taxTotal)
  };
}

const VIEW = { ORDER: 'order', REVIEW: 'review', BILLING: 'billing', PAY_LATER_DONE: 'pay_later_done' };

export default function FoodNewOrder({ token, user }) {
  const getHeaders = useCallback((extra = {}) =>
    getApiHeaders(
      token || localStorage.getItem('adminToken') || localStorage.getItem('staffToken'),
      { 'Content-Type': 'application/json', ...extra }
    ),
  [token]);

  const [view, setView] = useState(VIEW.ORDER);

  // Destination state
  const [destType,        setDestType]        = useState('ROOM');
  const [rooms,           setRooms]           = useState([]);
  const [loadingRooms,    setLoadingRooms]    = useState(false);
  const [roomSearch,      setRoomSearch]      = useState('');
  const [selectedRoom,    setSelectedRoom]    = useState(null);
  const [staffList,       setStaffList]       = useState([]);
  const [loadingStaff,    setLoadingStaff]    = useState(false);
  const [selectedStaff,   setSelectedStaff]   = useState(null);
  const [tablesList,      setTablesList]      = useState([]);
  const [loadingTables,   setLoadingTables]   = useState(false);
  const [selectedTable,   setSelectedTable]   = useState(null);
  const [ownerName,       setOwnerName]       = useState('');
  const [waiterList,      setWaiterList]      = useState([]);
  const [loadingWaiters,  setLoadingWaiters]  = useState(false);
  const [selectedWaiter,  setSelectedWaiter]  = useState(null);
  const [destError,       setDestError]       = useState('');

  // Menu state
  const [categories,   setCategories]   = useState([]);
  const [menuItems,    setMenuItems]    = useState([]);
  const [loadingMenu,  setLoadingMenu]  = useState(false);
  const [selCategory,  setSelCategory]  = useState(null);
  const [menuSearch,   setMenuSearch]   = useState('');

  // Basket state
  const [basket,      setBasket]      = useState([]);
  const [remarks,     setRemarks]     = useState('');
  const [basketError, setBasketError] = useState('');

  // Active placed order for billing
  const [activeOrder, setActiveOrder] = useState(null);
  const [placing,     setPlacing]     = useState(false);
  const [placeError,  setPlaceError]  = useState('');

  const totals = useMemo(() => computeTotals(basket), [basket]);

  useEffect(() => {
    setLoadingRooms(true);
    fetch(`${FOOD_BASE}/context/rooms`, { headers: getHeaders() })
      .then(r => r.json())
      .then(d => setRooms(d.rooms || []))
      .catch(e => console.error('[FoodNewOrder] rooms context error:', e))
      .finally(() => setLoadingRooms(false));

    setLoadingStaff(true);
    fetch(`${FOOD_BASE}/context/staff`, { headers: getHeaders() })
      .then(r => r.json())
      .then(d => setStaffList(d.staff || []))
      .catch(e => console.error('[FoodNewOrder] staff context error:', e))
      .finally(() => setLoadingStaff(false));

    setLoadingTables(true);
    fetch(`${FOOD_BASE}/tables?active_only=true`, { headers: getHeaders() })
      .then(r => r.json())
      .then(d => setTablesList(d.tables || []))
      .catch(e => console.error('[FoodNewOrder] tables error:', e))
      .finally(() => setLoadingTables(false));

    setLoadingWaiters(true);
    fetch(`${FOOD_BASE}/waiters?active_only=true`, { headers: getHeaders() })
      .then(r => r.json())
      .then(d => {
        const waiters = (d.waiters || []).map(w => ({ staff_id: w.waiter_id, staff_name: w.waiter_name }));
        setWaiterList(waiters);
        if (waiters.length > 0) setSelectedWaiter(waiters[0]);
      })
      .catch(e => console.error('[FoodNewOrder] waiters error:', e))
      .finally(() => setLoadingWaiters(false));
  }, []);

  useEffect(() => {
    fetch(`${FOOD_BASE}/categories?active_only=true`, { headers: getHeaders() })
      .then(r => r.json())
      .then(d => setCategories(d.categories || []))
      .catch(e => console.error('[FoodNewOrder] categories error:', e));
  }, []);

  useEffect(() => {
    const term = menuSearch.trim();
    if (term.length >= 2) {
      const timer = setTimeout(async () => {
        setLoadingMenu(true);
        try {
          const res = await fetch(`${FOOD_BASE}/menu-items/search?q=${encodeURIComponent(term)}&active_only=true`, { headers: getHeaders() });
          const d = await res.json();
          setMenuItems(d.items || []);
        } catch (e) { console.error('[FoodNewOrder] search error:', e); }
        finally { setLoadingMenu(false); }
      }, 300);
      return () => clearTimeout(timer);
    }

    setLoadingMenu(true);
    const catParam = selCategory ? `?category_id=${selCategory}&active_only=true` : '?active_only=true';
    fetch(`${FOOD_BASE}/menu-items${catParam}`, { headers: getHeaders() })
      .then(r => r.json())
      .then(d => setMenuItems(d.items || []))
      .catch(e => console.error('[FoodNewOrder] items error:', e))
      .finally(() => setLoadingMenu(false));
  }, [selCategory, menuSearch]);

  const basketQtyMap = useMemo(() => {
    const map = {};
    for (const l of basket) map[l.item_id] = l.quantity;
    return map;
  }, [basket]);

  const handleAddItem = useCallback((item) => {
    setBasket(prev => {
      const existing = prev.find(l => l.item_id === item.item_id);
      if (existing) {
        return prev.map(l =>
          l.item_id === item.item_id ? buildBasketLine(item, l.quantity + 1) : l
        );
      }
      return [...prev, buildBasketLine(item, 1)];
    });
  }, []);

  const handleQtyChange = useCallback((itemId, delta) => {
    setBasket(prev => {
      const line = prev.find(l => l.item_id === itemId);
      if (!line) return prev;
      const newQty = line.quantity + delta;
      if (newQty < 1) return prev;
      const taxAmt    = round2(line.unit_price * newQty * line.tax_rate / 100);
      const subTotal  = round2(line.unit_price * newQty);
      const lineTotal = round2(subTotal + taxAmt);
      return prev.map(l => l.item_id === itemId
        ? { ...l, quantity: newQty, line_subtotal: subTotal, tax_amount: taxAmt, line_total: lineTotal }
        : l
      );
    });
  }, []);

  const handleRemoveItem = useCallback((itemId) => {
    setBasket(prev => prev.filter(l => l.item_id !== itemId));
  }, []);

  const validateDestination = useCallback(() => {
    if (destType === 'ROOM'  && !selectedRoom)    return 'Please select a room';
    if (destType === 'TABLE' && !selectedTable)   return 'Please select a table from the list';
    if (destType === 'STAFF' && !selectedStaff)   return 'Please select a staff member';
    if (destType === 'OWNER' && !ownerName.trim()) return 'Please enter an owner/manager name';
    if (!selectedWaiter)                          return 'Please select an assigned waiter';
    return '';
  }, [destType, selectedRoom, selectedTable, selectedStaff, ownerName, selectedWaiter]);

  const handleReview = useCallback(() => {
    const destErr = validateDestination();
    if (destErr) { setDestError(destErr); return; }
    setDestError('');
    if (basket.length === 0) { setBasketError('Add at least one item to continue'); return; }
    setBasketError('');
    setView(VIEW.REVIEW);
  }, [validateDestination, basket]);

  const placeOrder = useCallback(async (payLater) => {
    setPlaceError('');
    setPlacing(true);
    let createdOrderId = null;
    try {
      const payload = {
        destination_type: destType,
        room_id:     selectedRoom?.room_id     || null,
        room_number: selectedRoom?.room_number || null,
        guest_id:    selectedRoom?.guest_id    || null,
        guest_name:  selectedRoom?.guest_name  || null,
        booking_id:  selectedRoom?.booking_id  || null,
        table_id:    selectedTable?.table_id   || null,
        table_name:  selectedTable?.table_name || null,
        staff_id:    selectedStaff?.staff_id   || null,
        staff_name:  selectedStaff?.staff_name || null,
        owner_name:  ownerName || null,
        waiter_uid:  selectedWaiter?.staff_id   || null,
        waiter_name: selectedWaiter?.staff_name || null,
        items:       basket,
        subtotal:    totals.subtotal,
        tax_total:   totals.taxTotal,
        grand_total: totals.grandTotal,
        remarks:     remarks.trim() || null
      };

      // 1. Create order
      const res = await fetch(`${FOOD_BASE}/orders`, {
        method: 'POST', headers: getHeaders(), body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to initialize order');
      createdOrderId = data.order_id;

      // 2. Transition DRAFT -> PLACED with sequential order number
      const placeRes = await fetch(`${FOOD_BASE}/orders/${data.order_id}/place`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({
          waiter_uid: selectedWaiter?.staff_id,
          waiter_name: selectedWaiter?.staff_name
        })
      });
      const placeData = await placeRes.json();
      if (!placeRes.ok) throw new Error(placeData.error || 'Failed to place order');

      setActiveOrder(placeData.order || data);
      // Pay Later: the order is already created and sent to Kitchen (steps above) —
      // do NOT call any payment endpoint. payment_status stays at its existing
      // default ('PENDING'), which already means "not yet paid" in this schema.
      // Pay Now: continue into the existing billing screen, unchanged.
      setView(payLater ? VIEW.PAY_LATER_DONE : VIEW.BILLING);
    } catch (e) {
      setPlaceError(e.message || 'Network error. Please try again.');
      // The order was created (DRAFT) but placement failed — clean up the
      // orphan draft so it doesn't sit forever un-placed and un-cancelled.
      // Best-effort only: this doesn't change the error already shown above,
      // and the backend independently refuses to touch the order if it
      // isn't still DRAFT (e.g. placement actually succeeded server-side
      // despite this client seeing a failure) — see cancelDraftOrder.
      if (createdOrderId) {
        try {
          await fetch(`${FOOD_BASE}/orders/${createdOrderId}/cancel-draft`, {
            method: 'POST',
            headers: getHeaders()
          });
        } catch (cleanupErr) {
          console.warn('[FoodNewOrder] Draft cleanup after failed placement also failed (non-fatal):', cleanupErr.message);
        }
      }
    } finally {
      setPlacing(false);
    }
  }, [destType, selectedRoom, selectedTable, selectedStaff, ownerName, selectedWaiter, basket, totals, remarks, getHeaders]);

  const handleReset = useCallback(() => {
    setView(VIEW.ORDER);
    setDestType('ROOM');
    setSelectedRoom(null);
    setSelectedStaff(null);
    setSelectedTable(null);
    setOwnerName('');
    setRoomSearch('');
    setBasket([]);
    setRemarks('');
    setSelCategory(null);
    setMenuSearch('');
    setDestError('');
    setBasketError('');
    setPlaceError('');
    setActiveOrder(null);
  }, []);

  // ── VIEW: BILLING ─────────────────────────────────────────────────────────
  if (view === VIEW.BILLING && activeOrder) {
    return (
      <FoodOrderBilling
        order={activeOrder}
        token={token}
        user={user}
        onBack={() => setView(VIEW.REVIEW)}
        onComplete={() => handleReset()}
      />
    );
  }

  // ── VIEW: REVIEW ──────────────────────────────────────────────────────────
  if (view === VIEW.REVIEW) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '680px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button style={btnSecondary} onClick={() => setView(VIEW.ORDER)}>
            <ArrowLeft size={14} /> Back to Edit
          </button>
          <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: '800', color: '#f1f5f9' }}>
            Order Confirmation & Review
          </h2>
        </div>

        <div style={{ ...glass, padding: '16px 20px' }}>
          <SectionLabel>Destination & Staff</SectionLabel>
          <div style={{ fontSize: '0.9rem', color: '#fff', fontWeight: '600' }}>
            {destType === 'ROOM' && `Room ${selectedRoom?.room_number} (${selectedRoom?.guest_name || 'Guest'})`}
            {destType === 'TABLE' && `Table: ${selectedTable?.table_name}`}
            {destType === 'STAFF' && `Staff: ${selectedStaff?.staff_name}`}
            {destType === 'OWNER' && `Management: ${ownerName}`}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)', marginTop: '4px' }}>
            Assigned Waiter: <strong style={{ color: '#38bdf8' }}>{selectedWaiter?.staff_name}</strong>
          </div>
        </div>

        <div style={{ ...glass, padding: '16px 20px' }}>
          <SectionLabel>Items ({basket.length})</SectionLabel>
          {basket.map(line => (
            <div key={line.item_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: '0.84rem' }}>
              <div>
                <span style={{ fontWeight: '600', color: '#f1f5f9' }}>{line.item_name}</span>
                <span style={{ color: 'rgba(255,255,255,0.4)', marginLeft: '8px' }}>
                  ×{line.quantity} @ {fmt(line.unit_price)}
                </span>
              </div>
              <span style={{ fontWeight: '700', color: '#f1f5f9' }}>{fmt(line.line_total)}</span>
            </div>
          ))}
          <OrderTotals subtotal={totals.subtotal} taxTotal={totals.taxTotal} grandTotal={totals.grandTotal} />
        </div>

        {remarks.trim() && (
          <div style={{ ...glass, padding: '14px 20px' }}>
            <SectionLabel>Special Instructions</SectionLabel>
            <p style={{ margin: 0, fontSize: '0.84rem', color: 'rgba(255,255,255,0.65)' }}>{remarks}</p>
          </div>
        )}

        <InlineError msg={placeError} />

        <div style={{ ...glass, padding: '14px 20px' }}>
          <SectionLabel>Payment</SectionLabel>
          <p style={{ margin: '0 0 12px', fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)' }}>
            Collect payment now, or place the order and collect payment later from Order History.
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button style={btnSecondary} onClick={() => setView(VIEW.ORDER)} disabled={placing}>
              <ArrowLeft size={14} /> Back
            </button>
            <button
              style={{ ...btnSecondary, borderColor: 'rgba(251,191,36,0.4)', color: '#fbbf24' }}
              onClick={() => placeOrder(true)}
              disabled={placing}
            >
              {placing ? <><Loader size={14} className="animate-spin" /> Placing Order…</> : 'Pay Later'}
            </button>
            <button style={btnSuccess} onClick={() => placeOrder(false)} disabled={placing}>
              {placing ? <><Loader size={14} className="animate-spin" /> Placing Order…</> : <><DollarSign size={15} /> Pay Now</>}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── VIEW: PAY LATER CONFIRMATION ──────────────────────────────────────────
  if (view === VIEW.PAY_LATER_DONE && activeOrder) {
    return (
      <div style={{ maxWidth: '520px', margin: '60px auto', textAlign: 'center' }}>
        <div style={{
          ...glass, padding: '28px 24px',
          border: '1px solid rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.06)'
        }}>
          <div style={{ fontSize: '2.4rem', marginBottom: '8px' }}>🟠</div>
          <h2 style={{ margin: '0 0 6px', fontSize: '1.2rem', fontWeight: '900', color: '#fbbf24' }}>
            PAYMENT PENDING
          </h2>
          <div style={{ fontSize: '0.95rem', fontWeight: '700', color: '#f1f5f9', marginBottom: '10px' }}>
            {activeOrder.order_number || activeOrder.order_id}
          </div>
          <p style={{ margin: '0 0 4px', fontSize: '0.85rem', color: 'rgba(255,255,255,0.65)', lineHeight: '1.6' }}>
            Order placed and sent to Kitchen. Bill can be printed now.
          </p>
          <p style={{ margin: '0 0 20px', fontSize: '0.85rem', color: 'rgba(255,255,255,0.65)', lineHeight: '1.6' }}>
            Payment can be collected later from Order History.
          </p>
          <button style={{ ...btnPrimary, padding: '10px 24px' }} onClick={handleReset}>
            Done — New Order
          </button>
        </div>
      </div>
    );
  }

  // ── VIEW: ORDER BUILDER ───────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', gap: '16px', height: 'calc(100vh - 180px)', minHeight: '520px' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' }}>
        <div style={{ ...glass, padding: '16px 20px' }}>
          <DestinationPanel
            destType={destType} setDestType={setDestType}
            rooms={rooms} loadingRooms={loadingRooms} roomSearch={roomSearch} setRoomSearch={setRoomSearch}
            selectedRoom={selectedRoom} setSelectedRoom={setSelectedRoom}
            staffList={staffList} loadingStaff={loadingStaff} selectedStaff={selectedStaff} setSelectedStaff={setSelectedStaff}
            tablesList={tablesList} loadingTables={loadingTables} selectedTable={selectedTable} setSelectedTable={setSelectedTable}
            ownerName={ownerName} setOwnerName={setOwnerName}
            waiterList={waiterList} selectedWaiter={selectedWaiter} setSelectedWaiter={setSelectedWaiter}
            destError={destError}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.3)' }} />
            <input
              style={{ ...inputStyle, paddingLeft: '36px' }}
              placeholder="Search menu items by name, tags, or code…"
              value={menuSearch}
              onChange={e => { setMenuSearch(e.target.value); if (e.target.value) setSelCategory(null); }}
            />
          </div>

          {!menuSearch && (
            <FoodCategoryBar categories={categories} selectedId={selCategory} onSelect={setSelCategory} loading={false} />
          )}

          {loadingMenu ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px' }}>
              {[1,2,3,4].map(i => <div key={i} style={{ ...glass, height: '90px', opacity: 0.4 }} />)}
            </div>
          ) : menuItems.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(255,255,255,0.2)' }}>
              <UtensilsCrossed size={36} style={{ opacity: 0.3, marginBottom: '10px' }} />
              <p style={{ margin: 0, fontSize: '0.85rem' }}>
                {menuSearch ? `No items match "${menuSearch}"` : 'No active menu items found'}
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px' }}>
              {menuItems.map(item => (
                <MenuItemOrderCard
                  key={item.item_id}
                  item={item}
                  basketQty={basketQtyMap[item.item_id] || 0}
                  onAdd={handleAddItem}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ width: '320px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '0', ...glass, padding: '18px 16px', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShoppingCart size={16} style={{ color: '#38bdf8' }} />
            <span style={{ fontWeight: '800', fontSize: '0.9rem', color: '#f1f5f9' }}>Basket</span>
            {basket.length > 0 && (
              <span style={{ fontSize: '0.65rem', padding: '1px 7px', borderRadius: '10px', background: 'rgba(56,189,248,0.15)', color: '#38bdf8', fontWeight: '700' }}>
                {basket.reduce((a, l) => a + l.quantity, 0)} items
              </span>
            )}
          </div>
          {basket.length > 0 && (
            <button onClick={() => setBasket([])} style={{ ...btnSecondary, padding: '4px 10px', fontSize: '0.72rem' }}>
              Clear
            </button>
          )}
        </div>

        {basket.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: 'rgba(255,255,255,0.2)', paddingBottom: '40px' }}>
            <ShoppingCart size={36} style={{ opacity: 0.2 }} />
            <p style={{ margin: 0, fontSize: '0.82rem', textAlign: 'center' }}>
              Tap "+ Add" on menu items to assemble an order
            </p>
          </div>
        ) : (
          <>
            <div style={{ flex: 1 }}>
              {basket.map(line => (
                <BasketLine key={line.item_id} line={line} onQtyChange={handleQtyChange} onRemove={handleRemoveItem} />
              ))}
            </div>
            <OrderTotals subtotal={totals.subtotal} taxTotal={totals.taxTotal} grandTotal={totals.grandTotal} />
          </>
        )}

        <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <label style={labelStyle}>Special Instructions</label>
          <textarea
            style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
            placeholder="No onion, room delivery, less spicy…"
            value={remarks}
            onChange={e => setRemarks(e.target.value)}
          />
        </div>

        <div style={{ marginTop: '14px' }}>
          <InlineError msg={basketError} />
          <button
            onClick={handleReview}
            disabled={basket.length === 0}
            style={{
              ...btnPrimary, width: '100%', justifyContent: 'center', padding: '12px',
              opacity: basket.length === 0 ? 0.4 : 1, cursor: basket.length === 0 ? 'not-allowed' : 'pointer'
            }}>
            Review Order <ChevronRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
