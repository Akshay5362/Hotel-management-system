/**
 * src/components/food/FoodOrderBilling.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2B — Food Order Billing Modal / Panel.
 *
 * Supports:
 *   1. PAY NOW (Cash, Card, UPI) -> Atomic payment creation & PAID status.
 *   2. ROOM BILL -> Posts verified charge to guest folio in ledger_items.
 *   3. COMPLIMENTARY -> Creates approval request for Admin/Manager.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState } from 'react';
import {
  CreditCard, DollarSign, Smartphone, BedDouble, Gift,
  CheckCircle, AlertCircle, Loader, Printer, ArrowLeft, RefreshCw
} from 'lucide-react';
import { API_URL, getApiHeaders } from '../../config/apiConfig';

const fmt = (n) => `₹${Number(n || 0).toFixed(2)}`;

export default function FoodOrderBilling({ order, token, user, onBack, onComplete }) {
  const [activeTab, setActiveTab] = useState('PAY_NOW'); // 'PAY_NOW' | 'ROOM_BILL' | 'COMPLIMENTARY'
  const [payMethod, setPayMethod] = useState('Cash');
  const [compRecipient, setCompRecipient] = useState(order?.guest_name || '');
  const [compRecipientType, setCompRecipientType] = useState(order?.destination_type || 'GUEST');
  const [compReason, setCompReason] = useState('');
  const [notes, setNotes] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const canRoomBill = order?.destination_type === 'ROOM' && Boolean(order?.booking_id);

  // ── Handle Pay Now ──────────────────────────────────────────────────────────
  const handlePayNow = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/food/orders/${order.order_id}/pay-now`, {
        method: 'POST',
        headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ payment_method: payMethod, notes })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Payment failed');

      setResult({
        type: 'PAY_NOW',
        message: 'Payment received successfully',
        payment: data.payment,
        order: data.order
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Handle Room Bill ────────────────────────────────────────────────────────
  const handleRoomBill = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/food/orders/${order.order_id}/room-bill`, {
        method: 'POST',
        headers: getApiHeaders(token)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to post charge to room');

      setResult({
        type: 'ROOM_BILL',
        message: `Charge posted to Room ${order.room_number} Folio`,
        ledger_item: data.ledger_item
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Handle Complimentary Request ───────────────────────────────────────────
  const handleComplimentary = async () => {
    if (!compRecipient.trim() || !compReason.trim()) {
      setError('Recipient name and reason are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/food/orders/${order.order_id}/complimentary/request`, {
        method: 'POST',
        headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          recipient: compRecipient,
          recipient_type: compRecipientType,
          reason: compReason
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to request complimentary');

      setResult({
        type: 'COMPLIMENTARY',
        message: data.auto_approved
          ? 'Complimentary billing approved & finalized (Admin authority)'
          : 'Complimentary request sent to Admin/Manager for approval',
        complimentary: data.complimentary_request
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      maxWidth: '650px',
      margin: '0 auto',
      background: 'rgba(15, 23, 42, 0.95)',
      border: '1px solid rgba(255, 255, 255, 0.1)',
      borderRadius: '16px',
      padding: '24px',
      color: '#f1f5f9',
      boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <button
          onClick={onBack}
          disabled={loading || Boolean(result)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(255,255,255,0.6)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          <ArrowLeft size={18} /> Back
        </button>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>ORDER BILLING</div>
          <div style={{ fontSize: '1.1rem', fontWeight: '800', color: '#38bdf8' }}>{order?.order_number || order?.order_id}</div>
        </div>
      </div>

      {/* Summary Box */}
      <div style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '12px',
        padding: '16px',
        marginBottom: '20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div>
          <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.6)' }}>
            Destination: <strong style={{ color: '#fff' }}>{order?.destination_type} {order?.room_number ? `#${order?.room_number}` : ''} {order?.table_name || ''}</strong>
          </div>
          <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.6)', marginTop: '4px' }}>
            Items: <strong style={{ color: '#fff' }}>{(order?.items || []).length} items</strong> | Waiter: <strong style={{ color: '#fff' }}>{order?.waiter_name || 'Assigned'}</strong>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>GRAND TOTAL</div>
          <div style={{ fontSize: '1.6rem', fontWeight: '900', color: '#34d399' }}>{fmt(order?.grand_total)}</div>
        </div>
      </div>

      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.3)',
          color: '#f87171',
          padding: '12px 16px',
          borderRadius: '8px',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '0.85rem'
        }}>
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {result ? (
        /* Result State */
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <CheckCircle size={56} style={{ color: '#34d399', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '1.3rem', fontWeight: '800', margin: '0 0 8px' }}>{result.message}</h2>
          <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.88rem', margin: '0 0 24px' }}>
            {result.type === 'PAY_NOW' && `Method: ${result.payment?.payment_method} | Billed by: ${result.payment?.cashier_name}`}
            {result.type === 'ROOM_BILL' && `Folio charge ID: ${result.ledger_item?.item_id}`}
            {result.type === 'COMPLIMENTARY' && `Recipient: ${result.complimentary?.recipient} (${result.complimentary?.recipient_type})`}
          </p>

          <button
            onClick={() => onComplete && onComplete(result)}
            style={{
              padding: '12px 28px',
              background: 'linear-gradient(135deg, #38bdf8, #6366f1)',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              fontWeight: '700',
              cursor: 'pointer',
              fontSize: '0.92rem'
            }}
          >
            Done & Return to Orders
          </button>
        </div>
      ) : (
        /* Billing Form */
        <div>
          {/* Tabs */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '20px' }}>
            <button
              onClick={() => setActiveTab('PAY_NOW')}
              style={{
                padding: '10px',
                borderRadius: '8px',
                border: activeTab === 'PAY_NOW' ? '1px solid #38bdf8' : '1px solid rgba(255,255,255,0.1)',
                background: activeTab === 'PAY_NOW' ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.03)',
                color: activeTab === 'PAY_NOW' ? '#38bdf8' : 'rgba(255,255,255,0.7)',
                fontWeight: '700',
                fontSize: '0.85rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px'
              }}
            >
              <DollarSign size={16} /> Pay Now
            </button>

            <button
              onClick={() => canRoomBill && setActiveTab('ROOM_BILL')}
              disabled={!canRoomBill}
              title={canRoomBill ? 'Post to room ledger' : 'Only available for occupied Room destinations'}
              style={{
                padding: '10px',
                borderRadius: '8px',
                border: activeTab === 'ROOM_BILL' ? '1px solid #a78bfa' : '1px solid rgba(255,255,255,0.1)',
                background: activeTab === 'ROOM_BILL' ? 'rgba(167,139,250,0.15)' : 'rgba(255,255,255,0.03)',
                color: activeTab === 'ROOM_BILL' ? '#a78bfa' : canRoomBill ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.25)',
                fontWeight: '700',
                fontSize: '0.85rem',
                cursor: canRoomBill ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px'
              }}
            >
              <BedDouble size={16} /> Room Bill
            </button>

            <button
              onClick={() => setActiveTab('COMPLIMENTARY')}
              style={{
                padding: '10px',
                borderRadius: '8px',
                border: activeTab === 'COMPLIMENTARY' ? '1px solid #fbbf24' : '1px solid rgba(255,255,255,0.1)',
                background: activeTab === 'COMPLIMENTARY' ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.03)',
                color: activeTab === 'COMPLIMENTARY' ? '#fbbf24' : 'rgba(255,255,255,0.7)',
                fontWeight: '700',
                fontSize: '0.85rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px'
              }}
            >
              <Gift size={16} /> Complimentary
            </button>
          </div>

          {/* TAB 1: PAY NOW */}
          {activeTab === 'PAY_NOW' && (
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: '700', color: 'rgba(255,255,255,0.6)', marginBottom: '8px' }}>
                SELECT PAYMENT METHOD
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '16px' }}>
                {['Cash', 'Card', 'UPI'].map(method => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setPayMethod(method)}
                    style={{
                      padding: '12px',
                      borderRadius: '8px',
                      border: payMethod === method ? '2px solid #34d399' : '1px solid rgba(255,255,255,0.1)',
                      background: payMethod === method ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.02)',
                      color: payMethod === method ? '#34d399' : 'rgba(255,255,255,0.8)',
                      fontWeight: '700',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px'
                    }}
                  >
                    {method === 'Cash' && <DollarSign size={18} />}
                    {method === 'Card' && <CreditCard size={18} />}
                    {method === 'UPI' && <Smartphone size={18} />}
                    {method}
                  </button>
                ))}
              </div>

              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: '700', color: 'rgba(255,255,255,0.6)', marginBottom: '6px' }}>
                  NOTES / REFERENCE (OPTIONAL)
                </label>
                <input
                  type="text"
                  placeholder="e.g. UPI Ref / Card Last 4 Digits"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '8px',
                    color: '#fff',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              <button
                onClick={handlePayNow}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '14px',
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                  border: 'none',
                  borderRadius: '10px',
                  color: '#fff',
                  fontWeight: '800',
                  fontSize: '1rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px'
                }}
              >
                {loading ? <Loader className="animate-spin" size={20} /> : <CheckCircle size={20} />}
                Confirm Payment & Mark Paid ({fmt(order?.grand_total)})
              </button>
            </div>
          )}

          {/* TAB 2: ROOM BILL */}
          {activeTab === 'ROOM_BILL' && (
            <div>
              <div style={{
                background: 'rgba(167,139,250,0.08)',
                border: '1px solid rgba(167,139,250,0.2)',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '20px',
                fontSize: '0.88rem',
                lineHeight: '1.6'
              }}>
                <div>Post charge directly to <strong>Room {order?.room_number}</strong> guest folio.</div>
                <div style={{ marginTop: '6px', color: 'rgba(255,255,255,0.7)' }}>
                  Guest: <strong>{order?.guest_name || 'Checked-in Guest'}</strong> | Booking: <strong>{order?.booking_id}</strong>
                </div>
              </div>

              <button
                onClick={handleRoomBill}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '14px',
                  background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
                  border: 'none',
                  borderRadius: '10px',
                  color: '#fff',
                  fontWeight: '800',
                  fontSize: '1rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px'
                }}
              >
                {loading ? <Loader className="animate-spin" size={20} /> : <BedDouble size={20} />}
                Post {fmt(order?.grand_total)} to Room Folio
              </button>
            </div>
          )}

          {/* TAB 3: COMPLIMENTARY */}
          {activeTab === 'COMPLIMENTARY' && (
            <div>
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: '700', color: 'rgba(255,255,255,0.6)', marginBottom: '6px' }}>
                  RECIPIENT NAME *
                </label>
                <input
                  type="text"
                  placeholder="e.g. VIP Guest / Manager"
                  value={compRecipient}
                  onChange={(e) => setCompRecipient(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '8px',
                    color: '#fff',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: '700', color: 'rgba(255,255,255,0.6)', marginBottom: '6px' }}>
                  RECIPIENT TYPE
                </label>
                <select
                  value={compRecipientType}
                  onChange={(e) => setCompRecipientType(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    background: '#0f172a',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '8px',
                    color: '#fff',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                >
                  <option value="GUEST">Hotel Guest</option>
                  <option value="STAFF">Staff Duty Meal</option>
                  <option value="OWNER">Management / Owner</option>
                  <option value="PROMOTIONAL">VIP / Promotional</option>
                </select>
              </div>

              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: '700', color: 'rgba(255,255,255,0.6)', marginBottom: '6px' }}>
                  JUSTIFICATION REASON *
                </label>
                <textarea
                  rows={2}
                  placeholder="State clear reason for complimentary approval..."
                  value={compReason}
                  onChange={(e) => setCompReason(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '8px',
                    color: '#fff',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              <button
                onClick={handleComplimentary}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '14px',
                  background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                  border: 'none',
                  borderRadius: '10px',
                  color: '#fff',
                  fontWeight: '800',
                  fontSize: '1rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px'
                }}
              >
                {loading ? <Loader className="animate-spin" size={20} /> : <Gift size={20} />}
                Submit Complimentary Authorization
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
