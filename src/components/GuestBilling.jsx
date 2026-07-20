import React from 'react';

export default function GuestBilling({ liveBill, billLoading, loadBill }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}>📄 Live Folio Statement</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Real-time billing record for your current stay.</p>
        </div>
        <button onClick={loadBill} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 14px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.82rem' }}>
          🔄 Refresh
        </button>
      </div>

      {billLoading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading bill...</div>
      ) : liveBill ? (
        <div className="glass" style={{ borderRadius: '12px', padding: '24px', border: '1px solid rgba(255,255,255,0.07)' }}>
          {/* Folio header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
            <div>
              <p style={{ fontWeight: '800', color: '#fff', fontSize: '1rem' }}>Room {liveBill.booking?.room_number} — {liveBill.booking?.room_type_title}</p>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>Booking: {liveBill.booking?.booking_number} · Check-in: {liveBill.booking?.check_in_date}</p>
            </div>
            <span style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '20px', padding: '4px 14px', color: '#22c55e', fontWeight: '700', fontSize: '0.78rem' }}>IN-HOUSE</span>
          </div>

          {/* Ledger table */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ textAlign: 'left', padding: '8px 0', color: 'var(--text-muted)', fontWeight: '600' }}>Description</th>
                <th style={{ textAlign: 'center', width: '60px', color: 'var(--text-muted)', fontWeight: '600' }}>Qty</th>
                <th style={{ textAlign: 'right', width: '110px', color: 'var(--text-muted)', fontWeight: '600' }}>Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              {(liveBill.ledger || []).map((item, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '10px 0', color: '#fff' }}>{item.desc}</td>
                  <td style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>{item.qty || 1}</td>
                  <td style={{ textAlign: 'right', fontWeight: '600', color: '#fff' }}>₹ {item.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
              {(liveBill.ledger || []).length === 0 && (
                <tr><td colSpan={3} style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No charges posted yet</td></tr>
              )}
            </tbody>
          </table>

          {/* Bill summary */}
          {(() => {
            const subtotal = (liveBill.ledger || []).reduce((s, i) => s + i.amount, 0);
            const deposit = liveBill.booking?.advance_amount || 0;
            const balance = subtotal - deposit;
            return (
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', color: 'var(--text-secondary)' }}>
                  <span>Subtotal</span><span>₹ {subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', color: '#22c55e' }}>
                  <span>Advance Deposit Paid</span><span>− ₹ {deposit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderTop: '1px solid var(--border-color)', fontWeight: '800', color: '#fff', fontSize: '1.05rem' }}>
                  <span>{balance >= 0 ? 'Balance Due at Checkout' : 'Refund Due'}</span>
                  <span style={{ color: balance >= 0 ? '#ef4444' : '#22c55e' }}>₹ {Math.abs(balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
            );
          })()}
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          <p>Click Refresh to load your bill.</p>
        </div>
      )}
    </div>
  );
}
