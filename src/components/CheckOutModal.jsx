import React, { useState } from 'react';
import { generateInvoicePDF } from '../utils/invoiceUtils';

export default function CheckOutModal({ isOpen, onClose, room, onCheckOut, onAddLedgerItem, onModifyClick, onRefundClick, showAlert, showConfirm }) {
  const [newDesc, setNewDesc] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [showInvoiceMenu, setShowInvoiceMenu] = useState(false);
  const [showSettleMenu, setShowSettleMenu] = useState(false);
  const [isGeneratingInvoice, setIsGeneratingInvoice] = useState(false);

  if (!isOpen || !room) return null;

  // Calculate totals
  const subtotal = room.ledger.reduce((sum, item) => sum + item.amount, 0);
  const deposit = room.deposit || 0;
  const balance = subtotal - deposit;

  const handlePostCharge = (e) => {
    e.preventDefault();
    if (!newDesc.trim() || !newAmount.trim()) {
      showAlert('Please enter both description and amount', 'Validation Error');
      return;
    }
    const amt = parseFloat(newAmount);
    if (isNaN(amt) || amt <= 0) {
      showAlert('Please enter a valid amount', 'Validation Error');
      return;
    }
    onAddLedgerItem(room.number, newDesc, amt);
    setNewDesc('');
    setNewAmount('');
  };

  // Core checkout — returns true on success
  const executeCheckOut = async () => {
    const msg = balance >= 0
      ? `Confirm settlement of ₹ ${balance.toLocaleString('en-IN')} and check out Room ${room.number}?`
      : `Confirm refund of ₹ ${Math.abs(balance).toLocaleString('en-IN')} and check out Room ${room.number}?`;
    const confirmed = await showConfirm(msg, 'Settle & Checkout');
    if (confirmed) {
      onCheckOut(room.number, balance);
      return true;
    }
    return false;
  };

  const handleCheckOut = async () => {
    setShowSettleMenu(false);
    await executeCheckOut();
  };

  // Settle then immediately print invoice
  const handleSettleAndPrint = async () => {
    setShowSettleMenu(false);
    const ok = await executeCheckOut();
    if (ok) {
      setIsGeneratingInvoice(true);
      try {
        await generateInvoicePDF(room, 'print');
      } finally {
        setIsGeneratingInvoice(false);
      }
    }
  };

  const handleInvoiceAction = async (action) => {
    setIsGeneratingInvoice(true);
    try {
      await generateInvoicePDF(room, action);
    } finally {
      setIsGeneratingInvoice(false);
      setShowInvoiceMenu(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '640px' }}>
        <div className="modal-header">
          <h3>
            <span>🧾</span> Guest Folio &amp; Checkout - Room {room.number}
          </h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {/* Guest Summary Info */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '20px', padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
            <div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Guest Name</p>
              <p style={{ fontWeight: '700', fontSize: '1rem', color: '#fff' }}>{room.guestName}</p>
            </div>
            <div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Mobile No</p>
              <p style={{ fontWeight: '600', color: 'var(--text-secondary)' }}>{room.phone || 'N/A'}</p>
            </div>
            <div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Check-in Date</p>
              <p style={{ fontWeight: '600', color: 'var(--text-secondary)' }}>{room.checkInDate}</p>
            </div>
            <div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Room Type / Rate</p>
              <p style={{ fontWeight: '600', color: 'var(--text-secondary)' }}>{room.type} (₹ {room.rate}/Night, Incl. GST)</p>
            </div>
          </div>

          {/* Post Charges */}
          <div style={{ marginBottom: '20px' }}>
            <h4 style={{ fontSize: '0.85rem', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '8px', letterSpacing: '0.5px' }}>Post Charges (Bill Posting)</h4>
            <form onSubmit={handlePostCharge} style={{ display: 'flex', gap: '10px' }}>
              <input
                type="text"
                placeholder="e.g. Laundry, Dinner, Extra Bed"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                style={{ flex: 2 }}
              />
              <input
                type="number"
                placeholder="Amount (₹)"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="submit" className="btn-secondary" style={{ padding: '0 16px', fontSize: '0.85rem' }}>Post</button>
            </form>
          </div>

          {/* Billing Ledger */}
          <div>
            <h4 style={{ fontSize: '0.85rem', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '8px', letterSpacing: '0.5px' }}>Billing Ledger</h4>
            <div className="ledger-table-container">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Item Description</th>
                    <th style={{ width: '80px', textAlign: 'center' }}>Qty</th>
                    <th style={{ width: '120px', textAlign: 'right' }}>Amount (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {room.ledger.map((item, index) => (
                    <tr key={item.id || index}>
                      <td>{item.desc}</td>
                      <td style={{ textAlign: 'center' }}>{item.qty || 1}</td>
                      <td className="col-amount">{item.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                    </tr>
                  ))}
                  {room.ledger.length === 0 && (
                    <tr>
                      <td colSpan="3" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '20px' }}>
                        No charges posted yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div className="ledger-summary">
                <div className="ledger-summary-row">
                  <span>Subtotal <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>(GST Inclusive)</span></span>
                  <span>₹ {subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="ledger-summary-row" style={{ color: 'var(--color-booked)' }}>
                  <span>Advance Deposit Paid</span>
                  <span>- ₹ {deposit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="ledger-summary-row total">
                  <span>{balance >= 0 ? 'Net Balance Due' : 'Refund Amount'}</span>
                  <span>₹ {Math.abs(balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {/* Left actions */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn-secondary"
              style={{ background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)', color: '#fff', border: 'none' }}
              onClick={onModifyClick}
            >
              ✏️ Modify Check-In
            </button>
            <button
              className="btn-secondary"
              style={{ background: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)', color: '#fff', border: 'none' }}
              onClick={onRefundClick}
            >
              💰 Cancel &amp; Refund
            </button>
          </div>

          {/* Right actions */}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>

            {/* Invoice ▼ */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn-secondary"
                onClick={() => { setShowInvoiceMenu(!showInvoiceMenu); setShowSettleMenu(false); }}
                disabled={isGeneratingInvoice}
              >
                {isGeneratingInvoice ? 'Generating…' : '📄 Invoice ▼'}
              </button>
              {showInvoiceMenu && (
                <div style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: '8px', background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', padding: '5px 0', zIndex: 50, minWidth: '160px', boxShadow: '0 -10px 15px -3px rgba(0,0,0,0.5)' }}>
                  <button
                    onClick={() => handleInvoiceAction('print')}
                    style={{ display: 'block', width: '100%', padding: '8px 20px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem' }}
                    onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
                    onMouseLeave={(e) => e.target.style.background = 'transparent'}
                  >
                    🖨️ Print Invoice
                  </button>
                  <button
                    onClick={() => handleInvoiceAction('download')}
                    style={{ display: 'block', width: '100%', padding: '8px 20px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem' }}
                    onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
                    onMouseLeave={(e) => e.target.style.background = 'transparent'}
                  >
                    📥 Download PDF
                  </button>
                </div>
              )}
            </div>

            <button className="btn-secondary" onClick={onClose}>Close</button>

            {/* Settle & Check Out ▼ */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn-danger"
                onClick={() => { setShowSettleMenu(!showSettleMenu); setShowInvoiceMenu(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                Settle &amp; Check Out ▼
              </button>
              {showSettleMenu && (
                <div style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: '8px', background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', padding: '5px 0', zIndex: 50, minWidth: '220px', boxShadow: '0 -10px 15px -3px rgba(0,0,0,0.5)' }}>
                  <button
                    onClick={handleCheckOut}
                    style={{ display: 'block', width: '100%', padding: '10px 20px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem' }}
                    onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
                    onMouseLeave={(e) => e.target.style.background = 'transparent'}
                  >
                    ✅ Settle Only
                  </button>
                  <button
                    onClick={handleSettleAndPrint}
                    disabled={isGeneratingInvoice}
                    style={{ display: 'block', width: '100%', padding: '10px 20px', background: 'transparent', border: 'none', color: '#4ade80', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem', fontWeight: '600' }}
                    onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
                    onMouseLeave={(e) => e.target.style.background = 'transparent'}
                  >
                    🖨️ Settle &amp; Print Invoice
                  </button>
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
