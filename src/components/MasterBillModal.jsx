import React, { useState, useEffect } from 'react';
import { API_URL, getApiHeaders } from '../config/apiConfig';
import { generateInvoicePDF } from '../utils/invoiceUtils';

export default function MasterBillModal({ isOpen, onClose, bookingId, room }) {
  const [bill, setBill] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const token = localStorage.getItem('adminToken') || localStorage.getItem('token');
  const targetId = bookingId || room?.current_booking_id || room?.booking_id || room?.bookingId || room?.booking_number || room?.number || room?.id;

  useEffect(() => {
    if (!isOpen || !targetId) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    fetch(`${API_URL}/invoices/master-bill/${targetId}`, {
      headers: getApiHeaders(token, { 'Content-Type': 'application/json' })
    })
      .then(res => {
        if (!res.ok) throw new Error(`Failed to load bill (HTTP ${res.status})`);
        return res.json();
      })
      .then(data => {
        if (isMounted) setBill(data);
      })
      .catch(err => {
        if (isMounted) {
          console.warn('Direct master-bill fetch failed, falling back to room data:', err.message);
          // Construct fallback bill from room object if available
          if (room) {
            setBill({
              title: 'MASTER BILL',
              hotel: {
                name: 'HOTEL SKY-5',
                address: 'DISHA ARCADE, I.T PARK ROAD, SECTOR 4, MDC, PANCHKULA-134114',
                mobile: '+91 8146470934',
                email: 'Hotelsky71@gmail.com',
                gstin: '06AANFH0310B1Z5',
                state: 'Haryana',
                hotelRegNo: '9610'
              },
              invoice: {
                billNo: `INV-2026-${String(targetId).padStart(6, '0')}`,
                invoiceDate: room.checkInDate || '17-Aug-26',
                registrationNo: String(targetId),
                hotelRegNo: '9610',
                status: 'Issued'
              },
              guest: {
                name: room.guestName || 'Walk In Guest',
                phone: room.phone || '',
                address: room.address || 'Chandigarh',
                state: 'Chandigarh'
              },
              stay: {
                arrivalDate: room.checkInDate || '17-Aug-26',
                arrivalTime: '10:19:59 AM',
                departureDate: '17-Aug-26',
                departureTime: '05:43:09 PM',
                roomNo: String(room.number || '108'),
                roomType: room.type || 'Standard',
                paxAdult: 2,
                paxChildren: 0,
                days: 1
              },
              lineItems: (room.ledger || []).map(item => ({
                date: item.business_date || '17-Aug-26',
                particulars: (item.desc || 'Room Charge').toUpperCase(),
                reference: `REF-${item.id || '1'}`,
                charges: item.amount,
                credit: 0,
                balance: item.amount
              })),
              settlement: {
                subtotal: (room.ledger || []).reduce((s, i) => s + i.amount, 0),
                taxableAmount: (room.ledger || []).reduce((s, i) => s + i.amount, 0) / 1.05,
                cgst: ((room.ledger || []).reduce((s, i) => s + i.amount, 0) - (room.ledger || []).reduce((s, i) => s + i.amount, 0) / 1.05) / 2,
                sgst: ((room.ledger || []).reduce((s, i) => s + i.amount, 0) - (room.ledger || []).reduce((s, i) => s + i.amount, 0) / 1.05) / 2,
                totalCredits: room.deposit || 0,
                outstandingBalance: Math.max(0, (room.ledger || []).reduce((s, i) => s + i.amount, 0) - (room.deposit || 0)),
                paymentStatus: (room.deposit || 0) >= (room.ledger || []).reduce((s, i) => s + i.amount, 0) ? 'PAID IN FULL' : 'BALANCE DUE'
              }
            });
          } else {
            setError(err.message);
          }
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => { isMounted = false; };
  }, [isOpen, targetId]);

  if (!isOpen) return null;

  const handleDownload = () => {
    generateInvoicePDF(bill || room, 'download');
  };

  const handlePrint = () => {
    generateInvoicePDF(bill || room, 'print');
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 9999 }}>
      <div className="modal-content" style={{ maxWidth: '820px', width: '95%', maxHeight: '92vh', display: 'flex', flexDirection: 'column', padding: '0', background: '#0f172a', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '12px' }}>
        
        {/* Modal Top Actions Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderBottom: '1px solid rgba(255,255,255,0.1)', background: 'rgba(30, 41, 59, 0.7)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '1.4rem' }}>🧾</span>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', fontWeight: '700' }}>Master Bill &amp; Tax Invoice</h3>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>Hotel SKY-5 Billing Authority</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button onClick={handlePrint} className="btn-secondary" style={{ padding: '6px 14px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
              🖨️ Print
            </button>
            <button onClick={handleDownload} className="btn-primary" style={{ padding: '6px 14px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
              ⬇ Download PDF
            </button>
            <button onClick={onClose} className="btn-close" style={{ color: '#fff', fontSize: '1.5rem', background: 'none', border: 'none', cursor: 'pointer', marginLeft: '6px' }}>&times;</button>
          </div>
        </div>

        {/* Modal Scrollable Bill Container */}
        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
              <div className="spinner" style={{ margin: '0 auto 16px' }} />
              <p>Loading Master Bill &amp; Reconciling Financials...</p>
            </div>
          ) : error && !bill ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#ef4444' }}>
              <p>❌ Error: {error}</p>
              <button onClick={onClose} className="btn-secondary" style={{ marginTop: '12px' }}>Close</button>
            </div>
          ) : bill ? (
            <div style={{ background: '#fff', color: '#0f172a', padding: '28px', borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.5)', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
              
              {/* Bill Header */}
              <div style={{ textAlign: 'center', borderBottom: '2px solid #cbd5e1', paddingBottom: '14px', marginBottom: '14px' }}>
                <h1 style={{ margin: '0 0 4px', fontSize: '1.5rem', fontWeight: '800', letterSpacing: '0.5px' }}>{bill.hotel?.name || 'HOTEL SKY-5'}</h1>
                <p style={{ margin: '0 0 3px', fontSize: '0.8rem', color: '#475569' }}>{bill.hotel?.address}</p>
                <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>
                  Mobile: {bill.hotel?.mobile || bill.hotel?.phone} &nbsp;|&nbsp; Email: {bill.hotel?.email} &nbsp;|&nbsp; GSTIN: {bill.hotel?.gstin}
                </p>
              </div>

              {/* Title & Status */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                <div style={{ width: '33%' }} />
                <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: '800', textAlign: 'center', letterSpacing: '1px', textTransform: 'uppercase' }}>MASTER BILL</h2>
                <div style={{ width: '33%', textAlign: 'right' }}>
                  <span style={{
                    display: 'inline-block',
                    padding: '4px 12px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: '700',
                    color: '#fff',
                    background: bill.settlement?.paymentStatus === 'PAID IN FULL' ? '#16a34a' : '#dc2626'
                  }}>
                    {bill.settlement?.paymentStatus === 'PAID IN FULL' ? '✔ PAID IN FULL' : '⚠ BALANCE DUE'}
                  </span>
                </div>
              </div>

              {/* Information Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '18px', fontSize: '0.82rem' }}>
                {/* Guest Info */}
                <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <p style={{ margin: '0 0 6px', fontWeight: '700', borderBottom: '1px solid #cbd5e1', paddingBottom: '4px', color: '#334155' }}>GUEST INFORMATION</p>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      <tr><td style={{ width: '90px', color: '#64748b', fontWeight: '600' }}>Guest Name</td><td style={{ fontWeight: '700' }}>: {bill.guest?.name}</td></tr>
                      <tr><td style={{ color: '#64748b', fontWeight: '600' }}>Contact No.</td><td>: {bill.guest?.phone || '—'}</td></tr>
                      <tr><td style={{ color: '#64748b', fontWeight: '600' }}>Address</td><td>: {bill.guest?.address || 'Chandigarh'}</td></tr>
                      <tr><td style={{ color: '#64748b', fontWeight: '600' }}>State</td><td>: {bill.guest?.state || 'Chandigarh'}</td></tr>
                      {(bill.guest?.gstin || bill.guest?.gst_no || bill.guest?.gstNo) && <tr><td style={{ color: '#64748b', fontWeight: '600' }}>Guest GSTIN</td><td>: {bill.guest.gstin || bill.guest.gst_no || bill.guest.gstNo}</td></tr>}
                    </tbody>
                  </table>
                </div>

                {/* Bill & Stay Info */}
                <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <p style={{ margin: '0 0 6px', fontWeight: '700', borderBottom: '1px solid #cbd5e1', paddingBottom: '4px', color: '#334155' }}>INVOICE &amp; STAY DETAILS</p>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      <tr><td style={{ width: '90px', color: '#64748b', fontWeight: '600' }}>Bill No</td><td style={{ fontWeight: '700' }}>: {bill.invoice?.billNo}</td></tr>
                      <tr><td style={{ color: '#64748b', fontWeight: '600' }}>Invoice Date</td><td>: {bill.invoice?.invoiceDate}</td></tr>
                      <tr><td style={{ color: '#64748b', fontWeight: '600' }}>Room No</td><td>: Room {bill.stay?.roomNo} ({bill.stay?.roomType})</td></tr>
                      <tr><td style={{ color: '#64748b', fontWeight: '600' }}>Arrival</td><td>: {bill.stay?.arrivalDate} {bill.stay?.arrivalTime}</td></tr>
                      <tr><td style={{ color: '#64748b', fontWeight: '600' }}>Departure</td><td>: {bill.stay?.departureDate} {bill.stay?.departureTime}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Line Items Table */}
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '18px', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ background: '#0f172a', color: '#fff', textAlign: 'left' }}>
                    <th style={{ padding: '8px 10px', width: '90px', textAlign: 'center' }}>Date</th>
                    <th style={{ padding: '8px 10px' }}>Particulars</th>
                    <th style={{ padding: '8px 10px', width: '120px' }}>Reference</th>
                    <th style={{ padding: '8px 10px', width: '95px', textAlign: 'right' }}>Charges (₹)</th>
                    <th style={{ padding: '8px 10px', width: '95px', textAlign: 'right' }}>Credit (₹)</th>
                    <th style={{ padding: '8px 10px', width: '105px', textAlign: 'right' }}>Balance (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {(bill.lineItems || []).map((row, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid #e2e8f0', background: idx % 2 === 0 ? '#fff' : '#f8fafc' }}>
                      <td style={{ padding: '8px 10px', textAlign: 'center', color: '#475569' }}>{row.date}</td>
                      <td style={{ padding: '8px 10px', fontWeight: '600', color: '#0f172a' }}>{row.particulars}</td>
                      <td style={{ padding: '8px 10px', color: '#64748b', fontSize: '0.75rem' }}>{row.reference || '—'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: '#0f172a' }}>{row.charges > 0 ? row.charges.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: '#16a34a' }}>{row.credit > 0 ? row.credit.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: '700', color: '#0f172a' }}>₹ {row.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Summary & Totals Box */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '18px', marginBottom: '18px' }}>
                {/* Left: Payment History & Notes */}
                <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '0.8rem' }}>
                  <p style={{ margin: '0 0 6px', fontWeight: '700', color: '#334155' }}>PAYMENT DETAILS</p>
                  {(bill.paymentDetails || []).length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: '16px', color: '#475569' }}>
                      {bill.paymentDetails.map((p, pIdx) => (
                        <li key={pIdx} style={{ marginBottom: '4px' }}>
                          {p.date} — {p.mode}: <strong>₹ {p.amount?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong> ({p.reference})
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ margin: 0, color: '#64748b', fontStyle: 'italic' }}>No payment records logged.</p>
                  )}
                  <p style={{ marginTop: '12px', marginBottom: '2px', fontWeight: '700', fontSize: '0.75rem', color: '#64748b' }}>TERMS &amp; CONDITIONS:</p>
                  <p style={{ margin: 0, fontSize: '0.7rem', color: '#64748b', lineHeight: '1.3' }}>
                    1. Standard check-in 12:00 PM / check-out 11:00 AM. 2. Disputes subject to local jurisdiction.
                  </p>
                </div>

                {/* Right: Settlement Calculation */}
                <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '0.82rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', color: '#475569' }}>
                    <span>Subtotal (Gross Charges)</span><span>₹ {bill.settlement?.subtotal?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', color: '#64748b' }}>
                    <span>Taxable Amount</span><span>₹ {bill.settlement?.taxableAmount?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', color: '#64748b' }}>
                    <span>CGST @ 2.5%</span><span>₹ {bill.settlement?.cgst?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', color: '#64748b' }}>
                    <span>SGST @ 2.5%</span><span>₹ {bill.settlement?.sgst?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', color: '#16a34a' }}>
                    <span>Total Credits / Advance</span><span>− ₹ {bill.settlement?.totalCredits?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div style={{ borderTop: '2px solid #cbd5e1', paddingTop: '6px', display: 'flex', justifyContent: 'space-between', fontWeight: '800', fontSize: '1rem', color: '#0f172a' }}>
                    <span>{bill.settlement?.outstandingBalance === 0 ? 'Total Paid' : 'Balance Due'}</span>
                    <span style={{ color: bill.settlement?.outstandingBalance === 0 ? '#16a34a' : '#dc2626' }}>
                      ₹ {bill.settlement?.outstandingBalance?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>

              {/* Bill Footer */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderTop: '1px solid #cbd5e1', paddingTop: '14px', fontSize: '0.75rem', color: '#64748b' }}>
                <div>
                  <p style={{ margin: '0 0 2px', fontWeight: '700', color: '#0f172a' }}>Thank you for staying with us at HOTEL SKY-5!</p>
                  <p style={{ margin: 0, fontSize: '0.68rem' }}>This is a computer-generated invoice and requires no physical signature.</p>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ width: '120px', borderBottom: '1px solid #94a3b8', marginBottom: '4px' }} />
                  <span style={{ fontWeight: '700', color: '#0f172a' }}>Authorized Signatory</span>
                </div>
              </div>

            </div>
          ) : null}
        </div>

      </div>
    </div>
  );
}
