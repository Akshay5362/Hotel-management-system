/**
 * src/components/food/FoodBillView.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only bill / receipt view for a food order. Used for both "Print Bill"
 * and "Reprint Bill" — printing is stateless, so reprinting is simply opening
 * this same view again on the same order and printing again.
 *
 * SAFETY CONTRACT:
 *   - Performs NO network requests and NO writes of any kind.
 *   - Renders only data already fetched by the caller (Order History).
 *   - Printing is a browser-native window.print() call — it can never mark an
 *     order paid, create a payment, or touch any backend state.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { X, Printer } from 'lucide-react';

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

const PAYMENT_DISPLAY = {
  PENDING:       { label: 'PAY LATER / UNPAID', color: '#c2410c' },
  PAID:          { label: 'PAID',               color: '#15803d' },
  ROOM_BILL:     { label: 'CHARGED TO ROOM',     color: '#6d28d9' },
  COMPLIMENTARY: { label: 'COMPLIMENTARY',       color: '#0369a1' },
  VOIDED:        { label: 'VOIDED',              color: '#475569' },
  REFUNDED:      { label: 'REFUNDED',            color: '#b91c1c' }
};

export default function FoodBillView({ order, onClose }) {
  if (!order) return null;
  const items = Array.isArray(order.items) ? order.items : [];
  const payDisplay = PAYMENT_DISPLAY[order.payment_status] || { label: order.payment_status, color: '#334155' };

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
          body * { visibility: hidden; }
          #food-bill-print-area, #food-bill-print-area * { visibility: visible; }
          #food-bill-print-area { position: absolute; left: 0; top: 0; width: 100%; }
          #food-bill-print-no-print { display: none !important; }
        }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', color: '#0f172a', borderRadius: '12px',
          width: '100%', maxWidth: '480px', maxHeight: '90vh', overflowY: 'auto',
          boxShadow: '0 24px 48px rgba(0,0,0,0.55)'
        }}
      >
        <div id="food-bill-print-no-print" style={{
          display: 'flex', justifyContent: 'flex-end', gap: '8px',
          padding: '14px 16px 0'
        }}>
          <button
            onClick={() => window.print()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '7px 14px', background: '#0f172a', border: 'none',
              borderRadius: '7px', color: '#fff', fontWeight: '700', fontSize: '0.8rem', cursor: 'pointer'
            }}
          >
            <Printer size={14} /> Print
          </button>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', padding: '6px' }}
          >
            <X size={20} />
          </button>
        </div>

        <div id="food-bill-print-area" style={{ padding: '20px 28px 28px' }}>
          <div style={{ textAlign: 'center', borderBottom: '2px solid #0f172a', paddingBottom: '12px', marginBottom: '16px' }}>
            <div style={{ fontSize: '1.3rem', fontWeight: '900' }}>HOTEL SKY-5</div>
            <div style={{ fontSize: '0.78rem', color: '#64748b' }}>Food &amp; Beverage Bill</div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '4px' }}>
            <span>Order No:</span>
            <strong>{order.order_number || order.order_id}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '4px' }}>
            <span>Date:</span>
            <strong>{fmtDateTime(order.created_at)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '4px' }}>
            <span>Destination:</span>
            <strong>{destinationLabel(order)}</strong>
          </div>
          {order.guest_name && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '4px' }}>
              <span>Guest:</span>
              <strong>{order.guest_name}</strong>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '12px' }}>
            <span>Waiter:</span>
            <strong>{order.waiter_name || '—'}</strong>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', marginBottom: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <th style={{ textAlign: 'left', padding: '6px 0' }}>Item</th>
                <th style={{ textAlign: 'center', padding: '6px 0' }}>Qty</th>
                <th style={{ textAlign: 'right', padding: '6px 0' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '5px 0' }}>{it.item_name}</td>
                  <td style={{ padding: '5px 0', textAlign: 'center' }}>{it.quantity}</td>
                  <td style={{ padding: '5px 0', textAlign: 'right' }}>{fmtMoney(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ borderTop: '1px dashed #cbd5e1', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem' }}>
              <span>Subtotal</span><span>{fmtMoney(order.subtotal)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem' }}>
              <span>Tax</span><span>{fmtMoney(order.tax_total)}</span>
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between', fontSize: '1.05rem', fontWeight: '900',
              borderTop: '1px solid #0f172a', paddingTop: '6px', marginTop: '4px'
            }}>
              <span>TOTAL</span><span>{fmtMoney(order.grand_total)}</span>
            </div>
          </div>

          {order.remarks && (
            <div style={{ marginTop: '12px', fontSize: '0.78rem', color: '#475569', fontStyle: 'italic' }}>
              Note: {order.remarks}
            </div>
          )}

          <div style={{
            marginTop: '18px', textAlign: 'center', padding: '8px', borderRadius: '8px',
            border: `1px solid ${payDisplay.color}`, color: payDisplay.color, fontWeight: '800', fontSize: '0.85rem'
          }}>
            Payment Status: {payDisplay.label}
          </div>

          {order.payment_status === 'PAID' && order.billed_at && (
            <div style={{ marginTop: '8px', textAlign: 'center', fontSize: '0.72rem', color: '#64748b' }}>
              Paid on {fmtDateTime(order.billed_at)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
