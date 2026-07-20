/**
 * PaymentPanel.jsx  — Reusable Digital Payment Component
 *
 * Architecture:
 *   PaymentPanel receives { selectedMethod, onMethodChange, amount }
 *   and renders the correct sub-panel based on method selection.
 *
 * RAZORPAY INTEGRATION GUIDE (Next Phase):
 *   1. Backend: Add createRazorpayOrder + verifyRazorpayPayment to paymentController.js
 *   2. Frontend: Pass onGatewayPay prop to PaymentPanel
 *   3. PaymentPanel calls onGatewayPay({ method, amount }) → opens Razorpay checkout
 *   NO CHANGES to GuestDashboard.jsx booking workflow or database needed.
 */

import React from 'react';

// ─── Payment Method Definitions ───────────────────────────────────────────────

const PAYMENT_METHODS = [
  {
    id: 'Cash',
    label: 'Cash',
    icon: '💵',
    color: '#4ade80',
    badgeText: '✓ Available',
    available: true,
  },
  {
    id: 'UPI',
    label: 'UPI',
    icon: '📱',
    color: '#a78bfa',
    badgeText: 'Pending Setup',
    available: true,
  },
  {
    id: 'Credit Card',
    label: 'Credit Card',
    icon: '💳',
    color: '#38bdf8',
    badgeText: 'Pending Setup',
    available: true,
  },
  {
    id: 'Debit Card',
    label: 'Debit Card',
    icon: '🏧',
    color: '#818cf8',
    badgeText: 'Pending Setup',
    available: true,
  },
  {
    id: 'QR Code',
    label: 'QR Code',
    icon: '⬛',
    color: '#fb923c',
    badgeText: 'Pending Setup',
    available: true,
  },
  {
    id: 'Net Banking',
    label: 'Net Banking',
    icon: '🌐',
    color: '#34d399',
    badgeText: 'Pending Setup',
    available: true,
  },
  {
    id: 'Wallet',
    label: 'Wallet',
    icon: '👛',
    color: '#fbbf24',
    badgeText: 'Pending Setup',
    available: true,
  },
];

// ─── Shared primitive styles ──────────────────────────────────────────────────

const labelSt = {
  fontSize: '0.7rem',
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  marginBottom: '5px',
  display: 'block',
  fontWeight: '600',
};

const inputSt = {
  width: '100%',
  padding: '10px 14px',
  background: 'rgba(0,0,0,0.35)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: '8px',
  color: 'rgba(255,255,255,0.4)',
  fontSize: '0.87rem',
  outline: 'none',
  boxSizing: 'border-box',
  cursor: 'not-allowed',
};

// ─── Gateway Notice (shared by all digital methods) ───────────────────────────

function GatewayNotice({ method }) {
  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(251,191,36,0.07) 0%, rgba(245,158,11,0.03) 100%)',
      border: '1px solid rgba(251,191,36,0.2)',
      borderRadius: '10px',
      padding: '14px 16px',
      display: 'flex',
      gap: '12px',
      alignItems: 'flex-start',
      marginTop: '4px',
    }}>
      <div style={{
        width: '34px', height: '34px', borderRadius: '8px',
        background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '1rem', flexShrink: 0,
      }}>
        ⚙️
      </div>
      <div>
        <p style={{ fontWeight: '700', color: '#fbbf24', margin: '0 0 5px', fontSize: '0.82rem' }}>
          Gateway Integration — Next Phase
        </p>
        <p style={{ color: '#94a3b8', margin: 0, fontSize: '0.74rem', lineHeight: '1.6' }}>
          <strong style={{ color: '#e2e8f0' }}>{method}</strong> payment is architected and ready.
          Your booking will be confirmed with{' '}
          <strong style={{ color: '#fbbf24' }}>Payment Status: Pending</strong>.
          Razorpay gateway will be connected in the next release —
          no changes to your booking or this UI will be needed at that time.
        </p>
      </div>
    </div>
  );
}

// ─── UPI Panel ────────────────────────────────────────────────────────────────

function UpiPanel({ amount, color }) {
  const apps = [
    { name: 'PhonePe', emoji: '🟣' },
    { name: 'Google Pay', emoji: '🔵' },
    { name: 'Paytm', emoji: '🔷' },
    { name: 'BHIM', emoji: '🟠' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <p style={labelSt}>Pay via UPI App</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
          {apps.map(app => (
            <div key={app.name} title="Will activate after Razorpay integration" style={{
              padding: '10px 6px', borderRadius: '8px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
              textAlign: 'center', cursor: 'not-allowed', opacity: 0.65,
            }}>
              <div style={{ fontSize: '1.5rem', marginBottom: '4px' }}>{app.emoji}</div>
              <p style={{ fontSize: '0.6rem', color: '#94a3b8', margin: 0 }}>{app.name}</p>
            </div>
          ))}
        </div>
      </div>
      <div>
        <p style={labelSt}>Or enter UPI ID</p>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input type="text" placeholder="yourname@upi" style={{ ...inputSt, flex: 1 }} disabled />
          <button disabled style={{
            padding: '10px 16px',
            background: `${color}15`,
            border: `1px solid ${color}35`,
            borderRadius: '8px',
            color: color,
            fontSize: '0.8rem',
            cursor: 'not-allowed',
            fontWeight: '700',
          }}>Verify</button>
        </div>
        <p style={{ fontSize: '0.65rem', color: '#475569', marginTop: '5px' }}>
          e.g. 9876543210@paytm, name@okaxis, name@ybl
        </p>
      </div>
      <GatewayNotice method="UPI" />
    </div>
  );
}

// ─── Card Panel (Credit / Debit) ──────────────────────────────────────────────

function CardPanel({ method, amount, color }) {
  const networks = ['VISA', 'Mastercard', 'RuPay', 'AMEX'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '0.7rem', color: '#475569' }}>Accepted networks:</span>
        {networks.map(n => (
          <span key={n} style={{
            fontSize: '0.6rem', fontWeight: '800',
            color: '#94a3b8', letterSpacing: '0.5px',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            padding: '2px 7px', borderRadius: '4px',
          }}>{n}</span>
        ))}
      </div>
      <div>
        <label style={labelSt}>Card Number</label>
        <input type="text" placeholder="•••• •••• •••• ••••" maxLength={19} style={inputSt} disabled />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div>
          <label style={labelSt}>Expiry (MM / YY)</label>
          <input type="text" placeholder="MM / YY" style={inputSt} disabled />
        </div>
        <div>
          <label style={labelSt}>CVV</label>
          <input type="password" placeholder="•••" maxLength={4} style={inputSt} disabled />
        </div>
      </div>
      <div>
        <label style={labelSt}>Cardholder Name</label>
        <input type="text" placeholder="Name as on card" style={inputSt} disabled />
      </div>
      <GatewayNotice method={method} />
    </div>
  );
}

// ─── QR Code Panel ────────────────────────────────────────────────────────────

function QrCodePanel({ amount, color }) {
  // Deterministic fake QR pattern (seeded by amount so it looks different each time)
  const seed = amount || 1000;
  const cells = Array.from({ length: 100 }).map((_, i) =>
    ((seed * (i + 7) * 13) % 97) < 48
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '8px 0' }}>
      <div style={{
        width: '168px', height: '168px', background: '#fff',
        borderRadius: '12px', padding: '10px', position: 'relative', overflow: 'hidden',
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
      }}>
        {/* Fake QR grid */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)',
          gap: '2px', width: '100%', height: '100%',
        }}>
          {cells.map((dark, i) => (
            <div key={i} style={{ background: dark ? '#000' : '#fff', borderRadius: '1px' }} />
          ))}
        </div>
        {/* Overlay */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'rgba(0,0,0,0.75)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: '6px', borderRadius: '12px',
        }}>
          <span style={{ fontSize: '1.8rem' }}>🔒</span>
          <p style={{ fontSize: '0.6rem', color: '#fff', textAlign: 'center', margin: 0, lineHeight: '1.4' }}>
            QR generated<br />after gateway setup
          </p>
        </div>
      </div>
      <p style={{ fontSize: '0.74rem', color: '#64748b', textAlign: 'center', lineHeight: '1.6', margin: 0 }}>
        Scan with any UPI app (PhonePe, GPay, Paytm, BHIM)<br />
        Dynamic QR expires in 10 minutes after generation.
      </p>
      <GatewayNotice method="QR Code" />
    </div>
  );
}

// ─── Net Banking Panel ────────────────────────────────────────────────────────

function NetBankingPanel({ color }) {
  const banks = [
    'State Bank of India', 'HDFC Bank',
    'ICICI Bank', 'Axis Bank',
    'Kotak Mahindra', 'Punjab National Bank',
    'Bank of Baroda', 'Canara Bank',
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <p style={labelSt}>Select Your Bank</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        {banks.map(bank => (
          <div key={bank} style={{
            padding: '9px 12px', borderRadius: '7px',
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid rgba(255,255,255,0.06)',
            display: 'flex', alignItems: 'center', gap: '8px',
            cursor: 'not-allowed', opacity: 0.75,
          }}>
            <span style={{
              width: '7px', height: '7px', borderRadius: '50%',
              background: color, flexShrink: 0,
            }} />
            <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{bank}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: '0.65rem', color: '#475569', margin: 0 }}>
        + 50 more banks available after gateway integration
      </p>
      <GatewayNotice method="Net Banking" />
    </div>
  );
}

// ─── Wallet Panel ─────────────────────────────────────────────────────────────

function WalletPanel({ color }) {
  const wallets = [
    { name: 'Paytm', emoji: '💙' },
    { name: 'Amazon Pay', emoji: '🟡' },
    { name: 'Mobikwik', emoji: '🔴' },
    { name: 'Freecharge', emoji: '🟢' },
    { name: 'JioMoney', emoji: '🔵' },
    { name: 'Airtel Money', emoji: '🔺' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <p style={labelSt}>Select Wallet</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
        {wallets.map(w => (
          <div key={w.name} style={{
            padding: '12px 8px', borderRadius: '8px',
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid rgba(255,255,255,0.06)',
            textAlign: 'center', cursor: 'not-allowed', opacity: 0.7,
          }}>
            <div style={{ fontSize: '1.4rem', marginBottom: '5px' }}>{w.emoji}</div>
            <p style={{ fontSize: '0.64rem', color: '#94a3b8', margin: 0 }}>{w.name}</p>
          </div>
        ))}
      </div>
      <GatewayNotice method="Wallet" />
    </div>
  );
}

// ─── Cash Panel ───────────────────────────────────────────────────────────────

function CashPanel({ amount }) {
  const steps = [
    'Your booking is confirmed after clicking "Confirm Booking".',
    'Visit the hotel reception desk on your check-in date.',
    `Pay ₹${Number(amount || 0).toLocaleString('en-IN')} advance in cash to the front-desk staff.`,
    'Staff confirms receipt → your Check In button activates instantly.',
  ];
  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(74,222,128,0.06) 0%, rgba(0,0,0,0.15) 100%)',
      border: '1px solid rgba(74,222,128,0.18)',
      borderRadius: '12px', padding: '20px',
      display: 'flex', flexDirection: 'column', gap: '14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{
          width: '46px', height: '46px', borderRadius: '12px',
          background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem',
        }}>💵</div>
        <div>
          <p style={{ fontWeight: '800', color: '#fff', fontSize: '0.97rem', margin: 0 }}>
            Pay at Reception Desk
          </p>
          <p style={{ color: '#4ade80', fontSize: '0.78rem', margin: '2px 0 0' }}>
            Amount due: ₹{Number(amount || 0).toLocaleString('en-IN')}
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {steps.map((text, i) => (
          <div key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <div style={{
              width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0,
              background: 'rgba(74,222,128,0.15)', border: '1px solid rgba(74,222,128,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.6rem', color: '#4ade80', fontWeight: '800', marginTop: '1px',
            }}>{i + 1}</div>
            <p style={{ fontSize: '0.79rem', color: '#94a3b8', margin: 0, lineHeight: '1.55' }}>{text}</p>
          </div>
        ))}
      </div>
      <div style={{
        background: 'rgba(74,222,128,0.04)', border: '1px solid rgba(74,222,128,0.12)',
        borderRadius: '8px', padding: '10px 12px',
        display: 'flex', gap: '8px', alignItems: 'flex-start',
      }}>
        <span style={{ fontSize: '0.85rem', flexShrink: 0 }}>💡</span>
        <p style={{ fontSize: '0.73rem', color: '#64748b', margin: 0, lineHeight: '1.5' }}>
          Cash is the only method requiring in-person staff confirmation before check-in activates.
          All digital methods will auto-confirm once Razorpay gateway is live.
        </p>
      </div>
    </div>
  );
}

// ─── PaymentPanel (main export) ───────────────────────────────────────────────

/**
 * Props:
 *   selectedMethod  {string}   - Active payment method id ('Cash', 'UPI', etc.)
 *   onMethodChange  {function} - Called with method id when user picks a method
 *   amount          {number}   - Deposit amount in INR
 *
 * RAZORPAY HOOK — Next Phase:
 *   Add `onGatewayPay` prop. PaymentPanel will call:
 *     onGatewayPay({ method, amount })
 *   in place of showing the GatewayNotice placeholder.
 */
export default function PaymentPanel({ selectedMethod, onMethodChange, amount }) {
  const current = PAYMENT_METHODS.find(m => m.id === selectedMethod) || PAYMENT_METHODS[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* ── Method Selector ── */}
      <div>
        <p style={{ fontSize: '0.82rem', color: '#94a3b8', fontWeight: '600', marginBottom: '10px' }}>
          Choose Payment Method
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(98px, 1fr))', gap: '8px' }}>
          {PAYMENT_METHODS.map(m => {
            const sel = selectedMethod === m.id;
            return (
              <div
                key={m.id}
                onClick={() => onMethodChange(m.id)}
                style={{
                  padding: '12px 8px',
                  borderRadius: '10px',
                  border: sel ? `2px solid ${m.color}` : '1px solid rgba(255,255,255,0.07)',
                  background: sel ? `${m.color}12` : 'rgba(255,255,255,0.015)',
                  cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px',
                  transition: 'all 0.18s',
                  position: 'relative',
                  userSelect: 'none',
                }}
              >
                <span style={{ fontSize: '1.4rem' }}>{m.icon}</span>
                <p style={{
                  fontSize: '0.7rem', fontWeight: '700', textAlign: 'center',
                  color: sel ? m.color : '#cbd5e1', margin: 0,
                }}>{m.label}</p>
                <span style={{
                  fontSize: '0.54rem', fontWeight: '700',
                  color: m.id === 'Cash' ? '#4ade80' : '#94a3b8',
                  background: m.id === 'Cash' ? 'rgba(74,222,128,0.10)' : 'rgba(255,255,255,0.04)',
                  padding: '1px 5px', borderRadius: '3px', textAlign: 'center',
                }}>{m.badgeText}</span>
                {sel && (
                  <div style={{
                    position: 'absolute', top: '5px', right: '5px',
                    width: '13px', height: '13px', borderRadius: '50%',
                    background: m.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.48rem', color: '#000', fontWeight: '900',
                  }}>✓</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Method Detail Panel ── */}
      <div>
        {current.id === 'Cash' && <CashPanel amount={amount} />}
        {current.id === 'UPI' && <UpiPanel amount={amount} color={current.color} />}
        {(current.id === 'Credit Card' || current.id === 'Debit Card') &&
          <CardPanel method={current.label} amount={amount} color={current.color} />}
        {current.id === 'QR Code' && <QrCodePanel amount={amount} color={current.color} />}
        {current.id === 'Net Banking' && <NetBankingPanel color={current.color} />}
        {current.id === 'Wallet' && <WalletPanel color={current.color} />}
      </div>

    </div>
  );
}
