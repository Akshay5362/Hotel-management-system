import React, { useState, useEffect } from 'react';

export default function RoomShiftingModal({
  isOpen,
  onClose,
  room,
  vacantRooms = [],
  onShiftRoom,
  showAlert,
  showConfirm
}) {
  const [targetRoomNo, setTargetRoomNo] = useState('');
  const [adjustmentType, setAdjustmentType] = useState('AUTOMATIC');
  const [manualAmount, setManualAmount] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (isOpen && vacantRooms.length > 0) {
      setTargetRoomNo(vacantRooms[0].number);
      setAdjustmentType('AUTOMATIC');
      setManualAmount('');
      setReason('');
    }
  }, [isOpen, vacantRooms]);

  if (!isOpen || !room) return null;

  const targetRoom = vacantRooms.find(r => String(r.number) === String(targetRoomNo)) || vacantRooms[0];

  // Financial Calculations
  const sourceRate = Number(room.rate || room.price || 0);
  const targetRate = Number(targetRoom?.rate || targetRoom?.price || 0);
  const automaticDifference = targetRate - sourceRate;

  // Compute existing payments and charges if available from room object
  const ledgerItems = Array.isArray(room.ledger) ? room.ledger : [];
  const totalCharges = ledgerItems.length > 0
    ? ledgerItems.filter(i => i.transaction_type !== 'CREDIT' && i.transaction_type !== 'PAYMENT').reduce((s, i) => s + (Number(i.amount || i.debit_amount) || 0), 0)
    : sourceRate;
  const totalCredits = ledgerItems.length > 0
    ? ledgerItems.filter(i => i.transaction_type === 'CREDIT' || i.transaction_type === 'ADJUSTMENT').reduce((s, i) => s + (Number(i.credit_amount) || 0), 0)
    : 0;
  const effectiveCurrentCharges = Math.max(0, totalCharges - totalCredits);
  const totalPayments = ledgerItems.length > 0
    ? ledgerItems.filter(i => i.transaction_type === 'PAYMENT').reduce((s, i) => s + (Number(i.credit_amount || i.amount) || 0), 0)
    : Number(room.deposit || 0);
  const currentBalance = Math.max(0, effectiveCurrentCharges - totalPayments);

  // Manual Adjustment calculations
  const parsedManualAmt = parseFloat(manualAmount) || 0;
  let finalAdditionalCharge = 0;

  if (adjustmentType === 'NO_ADJUSTMENT') {
    finalAdditionalCharge = 0;
  } else if (adjustmentType === 'INCREASE') {
    finalAdditionalCharge = automaticDifference + parsedManualAmt;
  } else if (adjustmentType === 'DECREASE') {
    finalAdditionalCharge = automaticDifference - parsedManualAmt;
  } else {
    // AUTOMATIC
    finalAdditionalCharge = automaticDifference;
  }

  const finalNewBalance = Math.max(0, currentBalance + finalAdditionalCharge);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!targetRoomNo) {
      showAlert('No vacant rooms available to shift to!', 'Shifting Check');
      return;
    }

    if ((adjustmentType === 'INCREASE' || adjustmentType === 'DECREASE')) {
      if (parsedManualAmt <= 0) {
        showAlert('Please enter a valid positive adjustment amount greater than 0.', 'Validation Error');
        return;
      }
      if (!reason.trim()) {
        showAlert('A valid reason is required for manual room shift adjustments.', 'Validation Error');
        return;
      }
    }

    const diffLabel = finalAdditionalCharge >= 0
      ? `+₹${finalAdditionalCharge.toLocaleString('en-IN')}`
      : `-₹${Math.abs(finalAdditionalCharge).toLocaleString('en-IN')}`;

    const confirmMsg = `Confirm shift for guest ${room.guestName}?\n` +
      `From: Room ${room.number} (${room.type} - ₹${sourceRate}/night)\n` +
      `To: Room ${targetRoomNo} (${targetRoom?.type || 'Room'} - ₹${targetRate}/night)\n` +
      `Shift Adjustment: ${diffLabel}\n` +
      `New Outstanding Balance: ₹${finalNewBalance.toLocaleString('en-IN')}`;

    const confirmed = await showConfirm(confirmMsg, 'Confirm Room Shift');
    if (confirmed) {
      onShiftRoom(room.number, targetRoomNo, {
        adjustmentType,
        manualAdjustmentAmount: parsedManualAmt,
        manualAdjustmentReason: reason.trim()
      });
    }
  };

  const inpStyle = {
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px',
    color: '#e2e8f0',
    padding: '8px 12px',
    width: '100%',
    fontSize: '0.85rem',
    outline: 'none',
    boxSizing: 'border-box'
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

  const labelStyle = {
    display: 'block',
    marginBottom: '4px',
    fontSize: '0.74rem',
    fontWeight: 600,
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.04em'
  };

  const sectionTitle = {
    color: '#818cf8',
    fontWeight: 700,
    fontSize: '0.78rem',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '8px',
    marginTop: '12px',
    borderBottom: '1px solid rgba(129,140,248,0.2)',
    paddingBottom: '4px'
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '640px', maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="modal-header">
          <h3>
            <span>🔄</span> Room Shifting &amp; Tariff Adjustment
          </h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* 1. ROOM DETAILS COMPARISON */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
              {/* SOURCE ROOM */}
              <div style={{ padding: '10px 12px', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '8px' }}>
                <span style={labelStyle}>Source Room</span>
                <p style={{ fontWeight: '700', color: '#fff', fontSize: '1rem', margin: '2px 0' }}>
                  Room {room.number} — {room.type?.toUpperCase()}
                </p>
                <p style={{ fontSize: '0.85rem', color: '#cbd5e1', margin: '2px 0' }}>
                  Tariff: <strong style={{ color: '#f87171' }}>₹{sourceRate.toLocaleString('en-IN')}</strong> / night
                </p>
                <p style={{ fontSize: '0.78rem', color: '#94a3b8', margin: '2px 0' }}>
                  Guest: {room.guestName || 'GUEST'}
                </p>
              </div>

              {/* DESTINATION ROOM */}
              <div style={{ padding: '10px 12px', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.25)', borderRadius: '8px' }}>
                <span style={labelStyle}>Destination Room</span>
                {vacantRooms.length > 0 ? (
                  <>
                    <select
                      value={targetRoomNo}
                      onChange={(e) => setTargetRoomNo(e.target.value)}
                      style={{ ...selectStyle, padding: '6px 8px', fontSize: '0.9rem', fontWeight: '600', marginBottom: '4px' }}
                    >
                      {vacantRooms.map((vRoom) => (
                        <option key={vRoom.number} value={vRoom.number} style={optionStyle}>
                          Room {vRoom.number} — {vRoom.type} (₹{vRoom.rate}/night)
                        </option>
                      ))}
                    </select>
                    <p style={{ fontSize: '0.85rem', color: '#cbd5e1', margin: '2px 0' }}>
                      Tariff: <strong style={{ color: '#60a5fa' }}>₹{targetRate.toLocaleString('en-IN')}</strong> / night
                    </p>
                  </>
                ) : (
                  <div style={{ color: '#f87171', fontSize: '0.85rem', fontWeight: '600', padding: '6px 0' }}>
                    ⚠️ No vacant rooms currently available.
                  </div>
                )}
              </div>
            </div>

            {/* 2. AUTOMATIC TARIFF CALCULATION BREAKDOWN */}
            <p style={sectionTitle}>Shift Billing Breakdown</p>
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '10px 14px', fontSize: '0.83rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ color: '#94a3b8' }}>Current Room Charge</span>
                <span style={{ fontWeight: '600', color: '#e2e8f0' }}>₹ {sourceRate.toLocaleString('en-IN')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ color: '#94a3b8' }}>Destination Room Tariff</span>
                <span style={{ fontWeight: '600', color: '#e2e8f0' }}>₹ {targetRate.toLocaleString('en-IN')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', color: automaticDifference >= 0 ? '#60a5fa' : '#fbbf24' }}>
                <span>Automatic Difference ({automaticDifference >= 0 ? 'Upgrade' : 'Downgrade'})</span>
                <span style={{ fontWeight: '700' }}>
                  {automaticDifference >= 0 ? `+ ₹ ${automaticDifference.toLocaleString('en-IN')}` : `- ₹ ${Math.abs(automaticDifference).toLocaleString('en-IN')}`}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', color: '#4ade80' }}>
                <span>Payments Already Received</span>
                <span style={{ fontWeight: '600' }}>- ₹ {totalPayments.toLocaleString('en-IN')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '6px', marginBottom: '6px' }}>
                <span style={{ color: '#cbd5e1' }}>Current Balance Before Shift</span>
                <span style={{ fontWeight: '600' }}>₹ {currentBalance.toLocaleString('en-IN')}</span>
              </div>
            </div>

            {/* 3. OPTIONAL MANUAL ADJUSTMENT */}
            <p style={sectionTitle}>Room Shift Billing Adjustment (Optional)</p>
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '10px 12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '10px', marginBottom: '8px' }}>
                <div>
                  <label style={labelStyle}>Adjustment Type</label>
                  <select
                    style={selectStyle}
                    value={adjustmentType}
                    onChange={(e) => setAdjustmentType(e.target.value)}
                  >
                    <option value="AUTOMATIC" style={optionStyle}>1. Automatic Difference ({automaticDifference >= 0 ? `+₹${automaticDifference}` : `-₹${Math.abs(automaticDifference)}`})</option>
                    <option value="INCREASE" style={optionStyle}>2. Increase (+ Manual Charge)</option>
                    <option value="DECREASE" style={optionStyle}>3. Decrease (- Manual Discount)</option>
                    <option value="NO_ADJUSTMENT" style={optionStyle}>4. No Adjustment (₹0 Difference)</option>
                  </select>
                </div>

                <div>
                  <label style={labelStyle}>
                    Manual Amount (₹) {adjustmentType === 'INCREASE' || adjustmentType === 'DECREASE' ? '*' : ''}
                  </label>
                  <input
                    style={inpStyle}
                    type="number"
                    min="1"
                    placeholder="₹ 0"
                    value={manualAmount}
                    onChange={(e) => setManualAmount(e.target.value)}
                    disabled={adjustmentType === 'AUTOMATIC' || adjustmentType === 'NO_ADJUSTMENT'}
                  />
                </div>
              </div>

              {(adjustmentType === 'INCREASE' || adjustmentType === 'DECREASE') && (
                <div style={{ marginTop: '6px' }}>
                  <label style={labelStyle}>Adjustment Reason *</label>
                  <input
                    style={inpStyle}
                    type="text"
                    placeholder="e.g. Guest requested premium amenity upgrade / Manager approved discount"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    required
                  />
                </div>
              )}

              {/* FINAL CALCULATION SUMMARY */}
              <div style={{ marginTop: '10px', padding: '8px 10px', background: 'rgba(99,102,241,0.08)', borderRadius: '6px', border: '1px solid rgba(99,102,241,0.2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '4px' }}>
                  <span style={{ color: '#cbd5e1' }}>Final Additional Shift Charge:</span>
                  <span style={{ fontWeight: '700', color: finalAdditionalCharge >= 0 ? '#60a5fa' : '#fbbf24' }}>
                    {finalAdditionalCharge >= 0 ? `+ ₹ ${finalAdditionalCharge.toLocaleString('en-IN')}` : `- ₹ ${Math.abs(finalAdditionalCharge).toLocaleString('en-IN')}`}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', fontWeight: '700' }}>
                  <span style={{ color: '#fff' }}>Final Outstanding Balance:</span>
                  <span style={{ color: finalNewBalance > 0 ? '#f87171' : '#4ade80' }}>
                    ₹ {finalNewBalance.toLocaleString('en-IN')}
                  </span>
                </div>
              </div>
            </div>

            <div style={{ fontSize: '0.76rem', color: '#94a3b8', marginTop: '10px', lineHeight: '1.4' }}>
              💡 <em>Note: Room shift preserves all historical charges and payment records for this continuous stay. Only the net differential/adjustment is posted.</em>
            </div>
          </div>

          <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button
              type="submit"
              className="btn-primary"
              disabled={vacantRooms.length === 0}
            >
              Confirm Room Shift
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
