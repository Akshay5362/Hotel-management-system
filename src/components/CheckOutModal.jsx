import React, { useState, useEffect } from 'react';
import { generateInvoicePDF } from '../utils/invoiceUtils';
import { API_URL, getApiHeaders } from '../config/apiConfig';
import MasterBillModal from './MasterBillModal';

const CHARGE_CATEGORIES = [
  'Laundry',
  'Food / Dining',
  'Room Service',
  'Extra Bed',
  'Minibar',
  'Transportation',
  'Telephone',
  'Room Shifting',
  'Other / Custom'
];

const PAYMENT_METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];

export default function CheckOutModal({
  isOpen,
  onClose,
  room,
  token,
  onCheckOut,
  onAddLedgerItem,
  onRecordPayment,
  onModifyClick,
  onRefundClick,
  showAlert,
  showConfirm
}) {
  // Post Charges state
  const [chargeCategory, setChargeCategory] = useState('Laundry');
  const [customDesc, setCustomDesc]         = useState('');
  const [chargeAmount, setChargeAmount]     = useState('');
  const [isPostingCharge, setIsPostingCharge] = useState(false);

  // Room Rent Adjustment state
  const [rentAdjType, setRentAdjType]       = useState('INCREASE');
  const [rentAdjAmount, setRentAdjAmount]   = useState('');
  const [rentAdjReason, setRentAdjReason]   = useState('');
  const [isApplyingRentAdj, setIsApplyingRentAdj] = useState(false);

  // Record Payment state
  const [paymentAmount, setPaymentAmount]   = useState('');
  const [paymentMethod, setPaymentMethod]   = useState('Cash');
  const [paymentRemarks, setPaymentRemarks] = useState('');
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);

  // Menus and previews
  const [showInvoiceMenu, setShowInvoiceMenu] = useState(false);
  const [showSettleMenu, setShowSettleMenu]   = useState(false);
  const [isGeneratingInvoice, setIsGeneratingInvoice] = useState(false);
  const [showMasterBillPreview, setShowMasterBillPreview] = useState(false);

  // Live Ledger State
  const [ledgerItems, setLedgerItems]       = useState([]);
  const [isLoadingLedger, setIsLoadingLedger] = useState(false);

  // Helper to reliably resolve active auth token
  const getAuthToken = () => {
    return token || localStorage.getItem('adminToken') || localStorage.getItem('token') || '';
  };

  // Fetch live ledger items whenever modal opens or room changes
  const fetchLiveLedger = async () => {
    if (!room || !room.number) return;
    setIsLoadingLedger(true);
    try {
      const activeToken = getAuthToken();
      const res = await fetch(`${API_URL}/rooms/${room.number}/ledger`, {
        headers: getApiHeaders(activeToken)
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.ledger)) {
          setLedgerItems(data.ledger);
        }
      }
    } catch (err) {
      console.warn('Failed to fetch live room ledger:', err.message);
      if (Array.isArray(room.ledger)) {
        setLedgerItems(room.ledger);
      }
    } finally {
      setIsLoadingLedger(false);
    }
  };

  useEffect(() => {
    if (isOpen && room) {
      setChargeCategory('Laundry');
      setCustomDesc('');
      setChargeAmount('');
      setRentAdjType('INCREASE');
      setRentAdjAmount('');
      setRentAdjReason('');
      setPaymentAmount('');
      setPaymentMethod('Cash');
      setPaymentRemarks('');
      setShowInvoiceMenu(false);
      setShowSettleMenu(false);
      fetchLiveLedger();
    }
  }, [isOpen, room]);

  if (!isOpen || !room) return null;

  // Separate Charges, Adjustments, and Payments from ledger
  const chargesList = ledgerItems.filter(
    item => (item.transaction_type === 'CHARGE' || Number(item.amount || item.debit_amount || 0) > 0) &&
            item.transaction_type !== 'CREDIT' &&
            item.transaction_type !== 'PAYMENT' &&
            item.transaction_type !== 'ADJUSTMENT'
  );
  const creditAdjustmentsList = ledgerItems.filter(
    item => (item.transaction_type === 'CREDIT' || item.transaction_type === 'ADJUSTMENT' || item.transaction_type === 'REFUND') &&
            item.transaction_type !== 'PAYMENT'
  );
  const paymentsList = ledgerItems.filter(
    item => item.transaction_type === 'PAYMENT' || (Number(item.credit_amount || 0) > 0 && !item.transaction_type)
  );

  // Authoritative calculations
  const totalGrossCharges = chargesList.reduce((sum, item) => sum + Number(item.amount || item.debit_amount || 0), 0) || (room.ledger ? room.ledger.reduce((s, i) => s + (i.amount || 0), 0) : Number(room.price || 0));
  const totalAdjustments = creditAdjustmentsList.reduce((sum, item) => sum + Number(item.credit_amount || 0), 0);
  const totalNetCharges = Math.max(0, totalGrossCharges - totalAdjustments);
  const totalPayments = paymentsList.reduce((sum, item) => sum + Number(item.credit_amount || 0), 0) || Number(room.deposit || 0);
  const outstandingBalance = Math.max(0, Number((totalNetCharges - totalPayments).toFixed(2)));

  // ── Post Charge Handler ───────────────────────────────────────────────────
  const handlePostCharge = async (e) => {
    e.preventDefault();
    const finalDesc = chargeCategory === 'Other / Custom' ? customDesc.trim() : chargeCategory;
    if (!finalDesc) {
      showAlert('Please enter a description for custom charge', 'Validation Error');
      return;
    }
    const amt = parseFloat(chargeAmount);
    if (isNaN(amt) || amt <= 0) {
      showAlert('Please enter a valid positive charge amount', 'Validation Error');
      return;
    }

    const confirmed = await showConfirm(
      `Post ${finalDesc} of ₹${amt.toLocaleString('en-IN')} to Room ${room.number} folio?`,
      'Confirm Post Charge'
    );
    if (!confirmed) return;

    setIsPostingCharge(true);
    try {
      if (typeof onAddLedgerItem === 'function') {
        await onAddLedgerItem(room.number, finalDesc, amt, chargeCategory);
      } else {
        const activeToken = getAuthToken();
        const res = await fetch(`${API_URL}/rooms/${room.number}/ledger`, {
          method: 'POST',
          headers: getApiHeaders(activeToken, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ desc: finalDesc, amount: amt, category: chargeCategory })
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Failed to post charge');
        }
      }
      setChargeAmount('');
      setCustomDesc('');
      await fetchLiveLedger();
      showAlert(`Successfully posted ${finalDesc} of ₹${amt.toLocaleString('en-IN')}`, 'Charge Posted');
    } catch (err) {
      console.error('Error posting charge:', err);
      showAlert(err.message || 'Failed to post charge', 'Error');
    } finally {
      setIsPostingCharge(false);
    }
  };

  // ── Apply Room Rent Adjustment Handler ────────────────────────────────────
  const handleApplyRentAdjustment = async (e) => {
    e.preventDefault();
    const amt = parseFloat(rentAdjAmount);
    if (isNaN(amt) || amt <= 0) {
      showAlert('Please enter a valid positive adjustment amount greater than 0', 'Validation Error');
      return;
    }
    const reason = rentAdjReason.trim();
    if (!reason) {
      showAlert('Please enter a valid reason for the room rent adjustment', 'Validation Error');
      return;
    }

    const typeLabel = rentAdjType === 'INCREASE' ? 'Increase (+)' : 'Decrease (-)';
    const confirmed = await showConfirm(
      `Apply room rent ${typeLabel} of ₹${amt.toLocaleString('en-IN')} to Room ${room.number}?\nReason: ${reason}`,
      'Confirm Room Rent Adjustment'
    );
    if (!confirmed) return;

    setIsApplyingRentAdj(true);
    try {
      const activeToken = getAuthToken();
      const res = await fetch(`${API_URL}/rooms/${room.number}/adjust-rent`, {
        method: 'POST',
        headers: getApiHeaders(activeToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          amount: amt,
          adjustmentType: rentAdjType,
          reason,
          idempotencyKey: `adj_${room.number}_${Date.now()}`
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to apply room rent adjustment');
      }

      setRentAdjAmount('');
      setRentAdjReason('');
      await fetchLiveLedger();
      showAlert(`Room rent ${typeLabel} of ₹${amt.toLocaleString('en-IN')} applied successfully!`, 'Adjustment Applied');
    } catch (err) {
      console.error('Error applying rent adjustment:', err);
      showAlert(err.message || 'Failed to apply room rent adjustment', 'Adjustment Error');
    } finally {
      setIsApplyingRentAdj(false);
    }
  };

  // ── Record Payment Handler ────────────────────────────────────────────────
  const handleRecordPayment = async (e) => {
    if (e) e.preventDefault();
    const amt = parseFloat(paymentAmount);
    if (isNaN(amt) || amt <= 0) {
      showAlert('Please enter a valid payment amount greater than 0', 'Validation Error');
      return;
    }
    if (amt > outstandingBalance + 0.01) {
      showAlert(`Payment amount (₹${amt.toLocaleString('en-IN')}) cannot exceed outstanding balance (₹${outstandingBalance.toLocaleString('en-IN')}).`, 'Invalid Payment');
      return;
    }

    const confirmed = await showConfirm(
      `Record payment of ₹${amt.toLocaleString('en-IN')} via ${paymentMethod} for Room ${room.number}?`,
      'Confirm Payment'
    );
    if (!confirmed) return;

    setIsRecordingPayment(true);
    try {
      const activeToken = getAuthToken();
      const res = await fetch(`${API_URL}/rooms/${room.number}/payments`, {
        method: 'POST',
        headers: getApiHeaders(activeToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          amount: amt,
          paymentMethod,
          remarks: paymentRemarks.trim(),
          idempotencyKey: `pay_${room.number}_${Date.now()}`
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to record payment');
      }

      setPaymentAmount('');
      setPaymentRemarks('');
      await fetchLiveLedger();
      showAlert(`Payment of ₹${amt.toLocaleString('en-IN')} recorded successfully!`, 'Payment Confirmed');
    } catch (err) {
      console.error('Error recording payment:', err);
      showAlert(err.message || 'Failed to record payment', 'Payment Error');
    } finally {
      setIsRecordingPayment(false);
    }
  };

  // Auto-populate full balance
  const handlePayFullBalance = () => {
    if (outstandingBalance <= 0) {
      showAlert('Folio is already fully settled (₹0 balance).', 'Info');
      return;
    }
    setPaymentAmount(String(outstandingBalance));
  };

  // ── Checkout Execution ────────────────────────────────────────────────────
  const executeCheckOut = async () => {
    if (outstandingBalance > 0.01) {
      showAlert(
        `Checkout cannot be completed. Outstanding balance is ₹${outstandingBalance.toLocaleString('en-IN')}. Please record the guest's payment before checking out.`,
        'Checkout Blocked'
      );
      return false;
    }

    const confirmed = await showConfirm(`Confirm check out for Room ${room.number} (Folio is fully settled)?`, 'Settle & Checkout');
    if (confirmed) {
      onCheckOut(room.number, 0);
      return true;
    }
    return false;
  };

  const handleCheckOut = async () => {
    setShowSettleMenu(false);
    await executeCheckOut();
  };

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

  const inpStyle = {
    background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px', color: '#e2e8f0', padding: '8px 12px', width: '100%',
    fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box'
  };
  const selectStyle = {
    ...inpStyle,
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    cursor: 'pointer'
  };
  const optionStyle = {
    backgroundColor: '#0f172a',
    color: '#f8fafc'
  };
  const labelStyle = { display: 'block', marginBottom: '4px', fontSize: '0.74rem',
    fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' };
  const sectionTitle = {
    color: '#818cf8', fontWeight: 700, fontSize: '0.78rem', textTransform: 'uppercase',
    letterSpacing: '0.08em', marginBottom: '10px', marginTop: '14px',
    borderBottom: '1px solid rgba(129,140,248,0.2)', paddingBottom: '4px'
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '720px', maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="modal-header">
          <h3><span>🧾</span> Guest Folio &amp; Checkout — Room {room.number}</h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {/* 1. GUEST SUMMARY */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)' }}>
            <div>
              <span style={labelStyle}>Guest Name</span>
              <span style={{ fontWeight: '700', fontSize: '0.95rem', color: '#fff' }}>{room.guestName || 'GUEST'}</span>
            </div>
            <div>
              <span style={labelStyle}>Mobile No</span>
              <span style={{ fontWeight: '600', color: '#cbd5e1' }}>{room.phone || 'N/A'}</span>
            </div>
            <div>
              <span style={labelStyle}>Check-In Date</span>
              <span style={{ fontWeight: '600', color: '#cbd5e1' }}>{room.checkInDate || 'Today'}</span>
            </div>
            <div>
              <span style={labelStyle}>Room Type / Rate</span>
              <span style={{ fontWeight: '600', color: '#cbd5e1' }}>{room.type} (₹{room.rate || room.price})</span>
            </div>
          </div>

          {/* 2. POST CHARGES (BILL POSTING) */}
          <p style={sectionTitle}>Post Charges (Bill Posting)</p>
          <form onSubmit={handlePostCharge} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 100px 90px', gap: '10px', alignItems: 'end' }}>
            <div>
              <label style={labelStyle}>Category</label>
              <select style={selectStyle} value={chargeCategory} onChange={e => setChargeCategory(e.target.value)}>
                {CHARGE_CATEGORIES.map(cat => <option key={cat} value={cat} style={optionStyle}>{cat}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>{chargeCategory === 'Other / Custom' ? 'Custom Description *' : 'Description'}</label>
              <input
                style={inpStyle}
                type="text"
                placeholder={chargeCategory === 'Other / Custom' ? 'e.g. Airport Pickup' : chargeCategory}
                value={customDesc}
                onChange={e => setCustomDesc(e.target.value)}
                disabled={chargeCategory !== 'Other / Custom'}
              />
            </div>
            <div>
              <label style={labelStyle}>Amount (₹)</label>
              <input
                style={inpStyle}
                type="number"
                min="1"
                placeholder="₹ 500"
                value={chargeAmount}
                onChange={e => setChargeAmount(e.target.value)}
                required
              />
            </div>
            <div>
              <button
                type="submit"
                className="btn-secondary"
                disabled={isPostingCharge}
                style={{ width: '100%', padding: '8px 0', fontSize: '0.85rem', fontWeight: '600' }}
              >
                {isPostingCharge ? 'Posting…' : '✓ Post'}
              </button>
            </div>
          </form>

          {/* 3. ROOM RENT ADJUSTMENT */}
          <p style={sectionTitle}>Room Rent Adjustment</p>
          <form onSubmit={handleApplyRentAdjustment} style={{ display: 'grid', gridTemplateColumns: '130px 110px 1.5fr 100px', gap: '10px', alignItems: 'end', background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div>
              <label style={labelStyle}>Adjustment Type</label>
              <select style={selectStyle} value={rentAdjType} onChange={e => setRentAdjType(e.target.value)}>
                <option value="INCREASE" style={optionStyle}>Increase (+)</option>
                <option value="DECREASE" style={optionStyle}>Decrease (-)</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Amount (₹) *</label>
              <input
                style={inpStyle}
                type="number"
                min="1"
                placeholder="₹ 200"
                value={rentAdjAmount}
                onChange={e => setRentAdjAmount(e.target.value)}
                required
              />
            </div>
            <div>
              <label style={labelStyle}>Adjustment Reason *</label>
              <input
                style={inpStyle}
                type="text"
                placeholder="e.g. Approved corporate discount / tariff upgrade"
                value={rentAdjReason}
                onChange={e => setRentAdjReason(e.target.value)}
                required
              />
            </div>
            <div>
              <button
                type="submit"
                className="btn-secondary"
                disabled={isApplyingRentAdj || !rentAdjAmount || !rentAdjReason}
                style={{
                  width: '100%',
                  padding: '8px 0',
                  fontSize: '0.85rem',
                  fontWeight: '600',
                  background: rentAdjType === 'INCREASE' ? 'rgba(99,102,241,0.2)' : 'rgba(245,158,11,0.2)',
                  borderColor: rentAdjType === 'INCREASE' ? '#6366f1' : '#f59e0b',
                  color: '#fff'
                }}
              >
                {isApplyingRentAdj ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </form>

          {/* 4. BILLING LEDGER (CHARGES & ADJUSTMENTS) */}
          <p style={sectionTitle}>Billing Ledger (Charges &amp; Adjustments)</p>
          <div className="ledger-table-container">
            <table className="ledger-table" style={{ width: '100%', fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th>Item Description</th>
                  <th style={{ width: '80px', textAlign: 'center' }}>Qty</th>
                  <th style={{ width: '130px', textAlign: 'right' }}>Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {chargesList.map((item, index) => (
                  <tr key={item.id || item.doc_id || `charge_${index}`}>
                    <td>{item.desc || item.description}</td>
                    <td style={{ textAlign: 'center' }}>{item.qty || 1}</td>
                    <td style={{ textAlign: 'right', fontWeight: '600' }}>
                      ₹{Number(item.amount || item.debit_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
                {creditAdjustmentsList.map((item, index) => (
                  <tr key={item.id || item.doc_id || `adj_${index}`} style={{ color: '#fbbf24' }}>
                    <td>{item.desc || item.description}</td>
                    <td style={{ textAlign: 'center' }}>{item.qty || 1}</td>
                    <td style={{ textAlign: 'right', fontWeight: '600' }}>
                      - ₹{Number(item.credit_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
                {chargesList.length === 0 && creditAdjustmentsList.length === 0 && (
                  <tr>
                    <td colSpan="3" style={{ textAlign: 'center', color: '#94a3b8', padding: '16px' }}>
                      {isLoadingLedger ? 'Loading ledger charges…' : 'No charges posted yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* SUMMARY BAR */}
            <div className="ledger-summary" style={{ marginTop: '10px' }}>
              <div className="ledger-summary-row">
                <span>Total Gross Charges <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>(GST Inclusive)</span></span>
                <span style={{ fontWeight: '600' }}>₹ {totalGrossCharges.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              {totalAdjustments > 0 && (
                <div className="ledger-summary-row" style={{ color: '#fbbf24' }}>
                  <span>Total Adjustments / Credits</span>
                  <span style={{ fontWeight: '600' }}>- ₹ {totalAdjustments.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
              )}
              <div className="ledger-summary-row" style={{ color: '#4ade80' }}>
                <span>Total Payments Received</span>
                <span style={{ fontWeight: '600' }}>- ₹ {totalPayments.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="ledger-summary-row total" style={{ borderTop: '2px solid rgba(255,255,255,0.1)', paddingTop: '8px' }}>
                <span>Net Balance Due</span>
                <span style={{ fontWeight: '700', fontSize: '1.05rem', color: outstandingBalance > 0 ? '#f87171' : '#4ade80' }}>
                  ₹ {outstandingBalance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>

          {/* 5. PAYMENT / SETTLEMENT */}
          <p style={sectionTitle}>Payment / Settlement</p>
          <form onSubmit={handleRecordPayment} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.2fr 1.5fr auto auto', gap: '8px', alignItems: 'end' }}>
            <div>
              <label style={labelStyle}>Amount (₹)</label>
              <input
                style={inpStyle}
                type="number"
                min="1"
                max={outstandingBalance || undefined}
                placeholder={`Max: ₹${outstandingBalance}`}
                value={paymentAmount}
                onChange={e => setPaymentAmount(e.target.value)}
                disabled={outstandingBalance <= 0 || isRecordingPayment}
              />
            </div>
            <div>
              <label style={labelStyle}>Payment Method</label>
              <select
                style={selectStyle}
                value={paymentMethod}
                onChange={e => setPaymentMethod(e.target.value)}
                disabled={outstandingBalance <= 0 || isRecordingPayment}
              >
                {PAYMENT_METHODS.map(m => <option key={m} value={m} style={optionStyle}>{m}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Reference / Remarks</label>
              <input
                style={inpStyle}
                type="text"
                placeholder="e.g. UPI Ref / Cashier note"
                value={paymentRemarks}
                onChange={e => setPaymentRemarks(e.target.value)}
                disabled={outstandingBalance <= 0 || isRecordingPayment}
              />
            </div>
            <div>
              <button
                type="button"
                className="btn-secondary"
                onClick={handlePayFullBalance}
                disabled={outstandingBalance <= 0 || isRecordingPayment}
                style={{ padding: '8px 12px', fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                title="Populate full outstanding balance"
              >
                Pay Full
              </button>
            </div>
            <div>
              <button
                type="submit"
                className="btn-primary"
                disabled={outstandingBalance <= 0 || !paymentAmount || isRecordingPayment}
                style={{ padding: '8px 14px', fontSize: '0.8rem', whiteSpace: 'nowrap' }}
              >
                {isRecordingPayment ? 'Recording…' : '💳 Record Payment'}
              </button>
            </div>
          </form>

          {/* 6. PAYMENT HISTORY */}
          <p style={sectionTitle}>Payment History</p>
          <div className="ledger-table-container">
            <table className="ledger-table" style={{ width: '100%', fontSize: '0.82rem' }}>
              <thead>
                <tr>
                  <th>Payment Date / Time</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Recorded By</th>
                  <th style={{ textAlign: 'right' }}>Amount Paid (₹)</th>
                </tr>
              </thead>
              <tbody>
                {paymentsList.map((p, idx) => (
                  <tr key={p.id || p.doc_id || idx}>
                    <td>{p.business_date || (p.created_at ? p.created_at.substring(0, 10) : 'Recorded')} {p.time_of_entry || ''}</td>
                    <td><span style={{ background: 'rgba(59,130,246,0.15)', color: '#60a5fa', padding: '2px 6px', borderRadius: '4px' }}>{p.payment_mode || p.payment_method || 'Cash'}</span></td>
                    <td style={{ color: '#94a3b8' }}>{p.reference || p.desc || '—'}</td>
                    <td style={{ textTransform: 'capitalize' }}>{p.created_by || 'Staff'}</td>
                    <td style={{ textAlign: 'right', fontWeight: '700', color: '#4ade80' }}>
                      ₹{Number(p.credit_amount || p.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
                {paymentsList.length === 0 && (
                  <tr>
                    <td colSpan="5" style={{ textAlign: 'center', color: '#94a3b8', padding: '12px' }}>
                      No payments recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* 7. FOOTER */}
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
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
                <div style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: '8px', background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', padding: '5px 0', zIndex: 50, minWidth: '180px', boxShadow: '0 -10px 15px -3px rgba(0,0,0,0.5)' }}>
                  <button
                    onClick={() => { setShowMasterBillPreview(true); setShowInvoiceMenu(false); }}
                    style={{ display: 'block', width: '100%', padding: '8px 20px', background: 'transparent', border: 'none', color: '#60a5fa', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem', fontWeight: '600' }}
                    onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
                    onMouseLeave={(e) => e.target.style.background = 'transparent'}
                  >
                    🔍 Preview Master Bill
                  </button>
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

      {/* Master Bill Preview Modal */}
      <MasterBillModal
        isOpen={showMasterBillPreview}
        onClose={() => setShowMasterBillPreview(false)}
        room={room}
        bookingId={room.booking_id || room.id}
      />
    </div>
  );
}
