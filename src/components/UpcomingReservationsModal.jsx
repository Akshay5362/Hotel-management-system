import React from 'react';

export default function UpcomingReservationsModal({ isOpen, onClose, reservations, onSelectReservation }) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '800px' }}>
        <div className="modal-header">
          <h3>
            <span>📅</span> Upcoming Advance Reservations
          </h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body" style={{ padding: '20px' }}>
          <div style={{
            display: 'flex',
            gap: '10px',
            padding: '10px 14px',
            marginBottom: '18px',
            borderRadius: '6px',
            background: 'rgba(139, 92, 246, 0.05)',
            border: '1px solid rgba(139, 92, 246, 0.15)',
            fontSize: '0.82rem',
            color: '#c4b5fd'
          }}>
            <span>ℹ️</span>
            <span>List of advance bookings made via the Guest Portal. Click on any reservation row to modify guest details, stay dates, or tax parameters.</span>
          </div>

          <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
            <table className="ledger-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '10px' }}>Room #</th>
                  <th style={{ textAlign: 'left', padding: '10px' }}>Guest Details</th>
                  <th style={{ textAlign: 'center', padding: '10px' }}>Check-In</th>
                  <th style={{ textAlign: 'center', padding: '10px' }}>Check-Out</th>
                  <th style={{ textAlign: 'center', padding: '10px' }}>Pax</th>
                  <th style={{ textAlign: 'right', padding: '10px' }}>Amount (₹)</th>
                  <th style={{ textAlign: 'center', padding: '10px' }}>Ref Code</th>
                </tr>
              </thead>
              <tbody>
                {reservations.map((res) => (
                  <tr 
                    key={res.booking_id} 
                    className="upcoming-row"
                    onClick={() => {
                      onSelectReservation(res);
                      onClose();
                    }}
                    style={{ cursor: 'pointer', transition: 'all 0.2s' }}
                  >
                    <td style={{ padding: '12px 10px', fontWeight: 'bold' }}>
                      <span style={{
                        background: res.roomType === 'PREMIUM' ? 'rgba(250,204,21,0.1)' : res.roomType === 'EXECUTIVE' ? 'rgba(59,130,246,0.1)' : 'rgba(74,222,128,0.08)',
                        border: `1px solid ${res.roomType === 'PREMIUM' ? 'rgba(250,204,21,0.3)' : res.roomType === 'EXECUTIVE' ? 'rgba(59,130,246,0.3)' : 'rgba(74,222,128,0.2)'}`,
                        borderRadius: '4px',
                        padding: '2px 6px',
                        color: '#fff',
                        fontSize: '0.85rem'
                      }}>
                        #{res.roomNumber}
                      </span>
                    </td>
                    <td style={{ padding: '12px 10px' }}>
                      <div style={{ fontWeight: '700', color: '#fff' }}>{res.guestName}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{res.phone}</div>
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center', color: '#38bdf8', fontWeight: '600' }}>
                      {res.checkInDate}
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center', color: '#818cf8', fontWeight: '600' }}>
                      {res.expectedCheckOutDate || '—'}
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center', color: '#fff' }}>
                      {res.adults}
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'right', fontWeight: '700', color: 'var(--color-booked)' }}>
                      {res.totalAmount?.toLocaleString()}
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                      <span style={{
                        background: 'rgba(139,92,246,0.12)',
                        border: '1px solid rgba(139,92,246,0.2)',
                        borderRadius: '4px',
                        padding: '2px 6px',
                        fontSize: '0.7rem',
                        color: '#c4b5fd',
                        fontFamily: 'monospace',
                        fontWeight: '700'
                      }}>
                        {res.booking_number}
                      </span>
                    </td>
                  </tr>
                ))}
                {reservations.length === 0 && (
                  <tr>
                    <td colSpan="7" style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                      <div style={{ fontSize: '2rem', marginBottom: '10px' }}>📭</div>
                      No upcoming advance reservations found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
