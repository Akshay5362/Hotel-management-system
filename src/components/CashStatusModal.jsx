import React from 'react';

export default function CashStatusModal({ isOpen, onClose, cashLog }) {
  if (!isOpen) return null;

  // Calculate summaries
  const advances = cashLog
    .filter(log => log.type === 'Advance Deposit')
    .reduce((sum, log) => sum + log.amount, 0);

  const settlements = cashLog
    .filter(log => log.type === 'Checkout Settlement')
    .reduce((sum, log) => sum + log.amount, 0);

  const totalRevenue = cashLog.reduce((sum, log) => {
    if (log.type.includes('Refund')) {
      return sum - log.amount;
    }
    return sum + log.amount;
  }, 0);

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '600px' }}>
        <div className="modal-header">
          <h3>
            <span>💰</span> Front Office Cash Status
          </h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {/* Revenue Breakdown */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '20px' }}>
            <div style={{ padding: '12px', background: 'rgba(56, 189, 248, 0.05)', borderRadius: '8px', border: '1px solid rgba(56, 189, 248, 0.15)' }}>
              <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Advance Deposits</p>
              <p style={{ fontSize: '1.2rem', fontWeight: '800', color: 'var(--color-vacant)', fontFamily: 'monospace', marginTop: '4px' }}>
                ₹ {advances.toLocaleString('en-IN')}
              </p>
            </div>
            <div style={{ padding: '12px', background: 'rgba(74, 222, 128, 0.05)', borderRadius: '8px', border: '1px solid rgba(74, 222, 128, 0.15)' }}>
              <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Settlements</p>
              <p style={{ fontSize: '1.2rem', fontWeight: '800', color: 'var(--color-booked)', fontFamily: 'monospace', marginTop: '4px' }}>
                ₹ {settlements.toLocaleString('en-IN')}
              </p>
            </div>
            <div style={{ padding: '12px', background: 'rgba(192, 132, 252, 0.05)', borderRadius: '8px', border: '1px solid rgba(192, 132, 252, 0.15)' }}>
              <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total Cash Flow</p>
              <p style={{ fontSize: '1.2rem', fontWeight: '800', color: 'var(--color-filters)', fontFamily: 'monospace', marginTop: '4px' }}>
                ₹ {totalRevenue.toLocaleString('en-IN')}
              </p>
            </div>
          </div>

          {/* Transaction Ledger */}
          <div>
            <h4 style={{ fontSize: '0.85rem', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '8px', letterSpacing: '0.5px' }}>Transaction Log</h4>
            <div className="ledger-table-container" style={{ maxHeight: '250px', overflowY: 'auto' }}>
              <table className="ledger-table" style={{ fontSize: '0.8rem' }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-modal)' }}>
                  <tr>
                    <th>Time</th>
                    <th>Room</th>
                    <th>Guest / Details</th>
                    <th>Type</th>
                    <th style={{ textAlign: 'right' }}>Amount (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {cashLog.map((log) => (
                    <tr key={log.id}>
                      <td style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>{log.time}</td>
                      <td style={{ fontWeight: '600' }}>Room {log.room}</td>
                      <td>{log.guest}</td>
                      <td style={{ 
                        color: log.type.includes('Deposit') ? 'var(--color-vacant)' : 
                               log.type.includes('Refund') ? 'var(--color-occupied)' : 'var(--color-booked)',
                        fontWeight: '500'
                      }}>
                        {log.type}
                      </td>
                      <td className="col-amount" style={{ 
                        fontFamily: 'monospace',
                        color: log.type.includes('Refund') ? 'var(--color-occupied)' : '#fff'
                      }}>
                        {log.type.includes('Refund') ? '-' : ''}₹ {log.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                  {cashLog.length === 0 && (
                    <tr>
                      <td colSpan="5" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '25px' }}>
                        No transactions recorded for the day.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>Close Dashboard</button>
        </div>
      </div>
    </div>
  );
}
