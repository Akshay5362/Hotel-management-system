/**
 * src/components/food/FoodKOTView.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Kitchen Order Ticket (KOT) preview + print for a single food order.
 *
 * Mirrors the FoodBillView.jsx printing architecture exactly:
 *   - a modal preview rendered from data the caller ALREADY holds
 *   - browser-native window.print()
 *   - an inline @media print rule that hides everything except
 *     #food-kot-print-area, so only the ticket reaches the paper
 *
 * SAFETY CONTRACT:
 *   - Performs NO network requests and NO writes of any kind.
 *   - Never touches order status, payment, ledger, or notifications.
 *   - Reprinting is simply opening this view again on the same order.
 *   - Operational kitchen data ONLY — no prices, totals, tax, payment,
 *     billing, invoice, or guest contact information is rendered.
 *
 * Print target: 80mm thermal receipt (≈72mm printable), black on white.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { X, Printer } from 'lucide-react';

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function destinationLabel(order) {
  switch (order.destination_type) {
    case 'ROOM':  return `ROOM ${order.room_number || '—'}`;
    case 'TABLE': return `TABLE ${order.table_name || '—'}`;
    case 'STAFF': return `STAFF ${order.staff_name || '—'}`;
    case 'OWNER': return `OWNER ${order.owner_name || 'Management'}`;
    default:      return order.destination_type || '—';
  }
}

const mono = { fontFamily: '"Courier New", Courier, monospace' };
const dashed = { borderTop: '1px dashed #000', margin: '6px 0' };
const row = { display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px', lineHeight: 1.35 };

export default function FoodKOTView({ order, onClose }) {
  if (!order) return null;
  const items = Array.isArray(order.items) ? order.items : [];
  const isModified = Array.isArray(order.modification_history) && order.modification_history.length > 0;
  const canPrint = items.length > 0;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 10000, padding: '20px'
      }}
    >
      <style>{`
        @media print {
          @page { size: 80mm auto; margin: 4mm; }
          body * { visibility: hidden; }
          #food-kot-print-area, #food-kot-print-area * { visibility: visible; }
          #food-kot-print-area {
            position: absolute; left: 0; top: 0;
            width: 72mm; max-width: 72mm;
            padding: 0; margin: 0;
            background: #fff; color: #000;
          }
          #food-kot-print-no-print { display: none !important; }
        }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', color: '#000', borderRadius: '12px',
          width: '100%', maxWidth: '360px', maxHeight: '90vh', overflowY: 'auto',
          boxShadow: '0 24px 48px rgba(0,0,0,0.55)'
        }}
      >
        {/* Controls — never printed */}
        <div id="food-kot-print-no-print" style={{
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px',
          padding: '12px 14px 0'
        }}>
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!canPrint}
            title={canPrint ? 'Print Kitchen Order Ticket' : 'No items to print'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '7px 14px', background: canPrint ? '#0f172a' : '#94a3b8', border: 'none',
              borderRadius: '7px', color: '#fff', fontWeight: '700', fontSize: '0.8rem',
              cursor: canPrint ? 'pointer' : 'not-allowed'
            }}
          >
            <Printer size={14} /> Print
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', padding: '6px', display: 'flex' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Ticket — the only thing that prints */}
        <div id="food-kot-print-area" style={{ ...mono, padding: '14px 22px 22px', color: '#000', background: '#fff' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '16px', fontWeight: '900', letterSpacing: '0.5px' }}>HOTEL SKY-5</div>
            <div style={{ fontSize: '12px', fontWeight: '800', letterSpacing: '1px', marginTop: '2px' }}>KITCHEN ORDER TICKET</div>
          </div>

          <div style={dashed} />

          <div style={{ textAlign: 'center', fontSize: '20px', fontWeight: '900', letterSpacing: '0.5px', margin: '4px 0 6px' }}>
            {order.order_number || order.order_id}
          </div>
          <div style={row}><span>Date</span><strong>{fmtDate(order.created_at)}</strong></div>
          <div style={row}><span>Time</span><strong>{fmtTime(order.created_at)}</strong></div>
          <div style={{ ...row, fontSize: '14px', fontWeight: '900', marginTop: '4px' }}>
            <span>{destinationLabel(order)}</span>
          </div>
          {order.destination_type === 'ROOM' && order.guest_name && (
            <div style={row}><span>Guest</span><strong>{order.guest_name}</strong></div>
          )}
          {order.waiter_name && (
            <div style={row}><span>Waiter</span><strong>{order.waiter_name}</strong></div>
          )}
          {isModified && (
            <div style={{ ...row, justifyContent: 'center', marginTop: '4px' }}>
              <span style={{ border: '1px solid #000', padding: '1px 8px', fontWeight: '900', fontSize: '11px', letterSpacing: '1px' }}>MODIFIED</span>
            </div>
          )}

          <div style={dashed} />

          <div style={{ fontSize: '12px', fontWeight: '900', letterSpacing: '1px', marginBottom: '4px' }}>ITEMS</div>
          {items.length === 0 ? (
            <div style={{ fontSize: '12px', fontStyle: 'italic' }}>No items on this order.</div>
          ) : items.map((it, idx) => (
            <div key={idx} style={{ marginBottom: '5px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                <span style={{ fontSize: '16px', fontWeight: '900', minWidth: '2.4em', textAlign: 'right' }}>
                  {it.quantity} ×
                </span>
                <span style={{ fontSize: '14px', fontWeight: '800', flex: 1, wordBreak: 'break-word' }}>
                  {it.item_name}
                </span>
                {it.kot_type && (
                  <span style={{ fontSize: '9px', fontWeight: '700', letterSpacing: '0.5px', border: '1px solid #000', padding: '0 4px', alignSelf: 'center' }}>
                    {String(it.kot_type).toUpperCase()}
                  </span>
                )}
              </div>
              {it.item_remarks && (
                <div style={{ fontSize: '11px', fontStyle: 'italic', paddingLeft: '3.2em', marginTop: '1px' }}>
                  ↳ {it.item_remarks}
                </div>
              )}
            </div>
          ))}

          {order.remarks && (
            <>
              <div style={dashed} />
              <div style={{ fontSize: '12px', fontWeight: '900', letterSpacing: '1px', marginBottom: '2px' }}>SPECIAL INSTRUCTIONS</div>
              <div style={{ fontSize: '12px', fontWeight: '700', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{order.remarks}</div>
            </>
          )}

          <div style={dashed} />

          <div style={{ textAlign: 'center', fontSize: '12px', fontWeight: '900', letterSpacing: '2px', marginTop: '4px' }}>KITCHEN COPY</div>
          <div style={{ textAlign: 'center', fontSize: '9px', marginTop: '3px' }}>
            {items.reduce((n, it) => n + (Number(it.quantity) || 0), 0)} item(s) · printed {fmtTime(new Date().toISOString())}
          </div>
        </div>
      </div>
    </div>
  );
}
