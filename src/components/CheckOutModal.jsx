import React, { useState } from 'react';

export default function CheckOutModal({ isOpen, onClose, room, onCheckOut, onAddLedgerItem, showAlert, showConfirm }) {
  const [newDesc, setNewDesc] = useState('');
  const [newAmount, setNewAmount] = useState('');

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

  const handleCheckOut = async () => {
    const msg = balance >= 0 
      ? `Confirm settlement of ₹ ${balance.toLocaleString('en-IN')} and check out Room ${room.number}?`
      : `Confirm refund of ₹ ${Math.abs(balance).toLocaleString('en-IN')} and check out Room ${room.number}?`;
    
    const confirmed = await showConfirm(msg, 'Settle & Checkout');
    if (confirmed) {
      onCheckOut(room.number, balance);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '640px' }}>
        <div className="modal-header">
          <h3>
            <span>🧾</span> Guest Folio & Checkout - Room {room.number}
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
              <p style={{ fontWeight: '600', color: 'var(--text-secondary)' }}>{room.type} (₹ {room.rate}/Night)</p>
            </div>
          </div>

          {/* Add Billing Item (Bill Posting) */}
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

          {/* Ledger Table */}
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
                  <span>Subtotal</span>
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

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-danger" onClick={handleCheckOut}>Settle & Check Out</button>
        </div>
      </div>
    </div>
  );
}
