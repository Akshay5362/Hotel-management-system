import React, { useState } from 'react';

export default function ReportsModal({ isOpen, onClose, rooms, cashLog, currentDate, onRunDayEnd }) {
  const [report, setReport] = useState(null);
  const [isAuditing, setIsAuditing] = useState(false);

  if (!isOpen) return null;

  // Active guest calculations
  const occupiedRooms = rooms.filter(r => r.status === 'occupied');
  const vacantRoomsCount = rooms.filter(r => r.status === 'vacant').length;
  const dirtyRoomsCount = rooms.filter(r => r.status === 'dirty').length;
  const occupancyPct = ((occupiedRooms.length / rooms.length) * 100).toFixed(1);

  // Financial calculations
  const totalAdvances = cashLog
    .filter(log => log.type === 'Advance Deposit')
    .reduce((sum, log) => sum + log.amount, 0);

  const totalSettlements = cashLog
    .filter(log => log.type === 'Checkout Settlement')
    .reduce((sum, log) => sum + log.amount, 0);

  const totalRevenue = cashLog.reduce((sum, log) => {
    if (log.type.includes('Refund')) return sum - log.amount;
    return sum + log.amount;
  }, 0);

  const handleNightAudit = () => {
    setIsAuditing(true);
    
    // Simulate a brief delay for night audit calculations
    setTimeout(() => {
      // Calculate night charges to be posted
      let auditRoomCharges = 0;
      occupiedRooms.forEach(room => {
        auditRoomCharges += room.rate;
      });

      const auditReport = {
        auditDate: currentDate,
        roomsOccupied: occupiedRooms.length,
        occupancyPct,
        totalRevenueToday: totalRevenue,
        advancesReceived: totalAdvances,
        settlementsSettled: totalSettlements,
        nightAuditChargesPosted: auditRoomCharges,
        nextDate: advanceDateStr(currentDate)
      };

      setReport(auditReport);
      setIsAuditing(false);
      onRunDayEnd(auditReport);
    }, 1200);
  };

  // Helper to advance date string like "11-Jul-2026"
  const advanceDateStr = (dateStr) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;

    const day = parseInt(parts[0], 10);
    const monthIndex = months.indexOf(parts[1]);
    const year = parseInt(parts[2], 10);

    const date = new Date(year, monthIndex, day);
    date.setDate(date.getDate() + 1);

    const newDay = String(date.getDate()).padStart(2, '0');
    const newMonth = months[date.getMonth()];
    const newYear = date.getFullYear();

    return `${newDay}-${newMonth}-${newYear}`;
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '600px' }}>
        <div className="modal-header">
          <h3>
            <span>📊</span> Night Audit & Day-End Report
          </h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {!report ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '15px', lineHeight: '1.5' }}>
                Running the <strong>Day End Night Audit</strong> will post the daily room charge (₹ rate/night) and taxes to all currently checked-in guests, roll over the software date to the next business day, and clear the local dashboard check-in/out registers.
              </p>
              
              <div style={{ padding: '16px', background: 'rgba(251, 146, 60, 0.05)', border: '1px solid rgba(251, 146, 60, 0.2)', borderRadius: '8px', marginBottom: '20px', textAlign: 'left' }}>
                <h5 style={{ color: 'var(--color-inactive)', textTransform: 'uppercase', marginBottom: '8px', fontSize: '0.8rem' }}>Pre-Audit Checklist</h5>
                <ul style={{ paddingLeft: '18px', fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <li>All expected departures checked out: <strong>{dirtyRoomsCount} Rooms currently dirty</strong></li>
                  <li>All arrivals for today checked in or marked as no-show</li>
                  <li>Active occupied rooms ready: <strong>{occupiedRooms.length} Active Guests</strong></li>
                </ul>
              </div>

              <button 
                className="btn-primary" 
                onClick={handleNightAudit}
                disabled={isAuditing}
                style={{ fontSize: '1rem', padding: '12px 24px', background: 'linear-gradient(135deg, #c2410c 0%, #a2380c 100%)', borderColor: '#fb923c' }}
              >
                {isAuditing ? 'Processing Audit, Posting Charges...' : 'Run Day End & Roll Over Date'}
              </button>
            </div>
          ) : (
            <div id="printable-area" style={{ padding: '10px' }}>
              <div style={{ textAlign: 'center', borderBottom: '2px solid var(--border-color)', paddingBottom: '12px', marginBottom: '15px' }}>
                <h3 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontSize: '1.4rem' }}>HOTEL SKY-5</h3>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Night Audit Closure Report</p>
                <p style={{ fontSize: '0.9rem', color: 'var(--color-vacant)', fontWeight: '600', marginTop: '4px' }}>Business Date: {report.auditDate}</p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px', fontSize: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Occupied Rooms (Occupancy Rate)</span>
                  <span style={{ fontWeight: '600', color: '#fff' }}>{report.roomsOccupied} Rooms ({report.occupancyPct}%)</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Vacant Rooms Available</span>
                  <span style={{ fontWeight: '600', color: '#fff' }}>{vacantRoomsCount} Rooms</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Advance Cash Collected</span>
                  <span style={{ fontWeight: '600', color: 'var(--color-vacant)', fontFamily: 'monospace' }}>₹ {report.advancesReceived.toLocaleString('en-IN')}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Checkout Settlement Income</span>
                  <span style={{ fontWeight: '600', color: 'var(--color-booked)', fontFamily: 'monospace' }}>₹ {report.settlementsSettled.toLocaleString('en-IN')}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Total Cash Drawer Balance</span>
                  <span style={{ fontWeight: '700', color: 'var(--color-filters)', fontFamily: 'monospace' }}>₹ {report.totalRevenueToday.toLocaleString('en-IN')}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed var(--border-color)', paddingBottom: '8px', paddingTop: '4px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Night Room Tariff Charges Posted</span>
                  <span style={{ fontWeight: '700', color: 'var(--color-occupied)', fontFamily: 'monospace' }}>₹ {report.nightAuditChargesPosted.toLocaleString('en-IN')}</span>
                </div>
              </div>

              <div style={{ padding: '10px', background: 'rgba(74, 222, 128, 0.05)', border: '1px solid rgba(74, 222, 128, 0.2)', borderRadius: '8px', fontSize: '0.8rem', color: 'var(--color-booked)', textAlign: 'center' }}>
                ✅ Audit Successful! business calendar rolled forward to <strong>{report.nextDate}</strong>.
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {report ? (
            <>
              <button className="btn-secondary" onClick={handlePrint}>Print Summary</button>
              <button className="btn-primary" onClick={() => { setReport(null); onClose(); }}>Close Audit</button>
            </>
          ) : (
            <button className="btn-secondary" onClick={onClose}>Cancel Audit</button>
          )}
        </div>
      </div>
    </div>
  );
}
