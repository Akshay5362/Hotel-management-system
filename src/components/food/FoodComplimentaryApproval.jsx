/**
 * src/components/food/FoodComplimentaryApproval.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2B — Admin / Manager Approval Queue for Complimentary Food Orders.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect } from 'react';
import { Gift, CheckCircle, XCircle, Clock, Loader, AlertCircle, RefreshCw } from 'lucide-react';
import { API_URL, getApiHeaders } from '../../config/apiConfig';

const fmt = (n) => `₹${Number(n || 0).toFixed(2)}`;

export default function FoodComplimentaryApproval({ token, user }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [processingId, setProcessingId] = useState(null);

  const fetchPending = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/food/complimentary/pending`, {
        headers: getApiHeaders(token)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch pending requests');
      setRequests(data.requests || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPending();
  }, []);

  const handleApprove = async (reqId) => {
    setProcessingId(reqId);
    try {
      const res = await fetch(`${API_URL}/food/complimentary/${reqId}/approve`, {
        method: 'POST',
        headers: getApiHeaders(token)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Approval failed');
      fetchPending();
    } catch (err) {
      alert(`Approval error: ${err.message}`);
    } finally {
      setProcessingId(null);
    }
  };

  const handleReject = async (reqId) => {
    const reason = window.prompt('Enter rejection reason:');
    if (reason === null) return;

    setProcessingId(reqId);
    try {
      const res = await fetch(`${API_URL}/food/complimentary/${reqId}/reject`, {
        method: 'POST',
        headers: getApiHeaders(token),
        body: JSON.stringify({ rejection_reason: reason })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rejection failed');
      fetchPending();
    } catch (err) {
      alert(`Rejection error: ${err.message}`);
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <div style={{ padding: '4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: '1.1rem', fontWeight: '800', color: '#f1f5f9' }}>
            Complimentary Authorizations Queue
          </h2>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(255,255,255,0.45)' }}>
            Review and approve staff-submitted complimentary food order waivers
          </p>
        </div>

        <button
          onClick={fetchPending}
          disabled={loading}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '8px',
            color: '#fff',
            fontSize: '0.82rem',
            cursor: 'pointer'
          }}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.3)',
          color: '#f87171',
          padding: '10px 14px',
          borderRadius: '8px',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '0.85rem'
        }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px', color: 'rgba(255,255,255,0.4)' }}>
          <Loader className="animate-spin" size={24} style={{ marginRight: '10px' }} /> Checking pending authorizations...
        </div>
      ) : requests.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '60px 20px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '12px',
          color: 'rgba(255,255,255,0.4)'
        }}>
          <Gift size={40} style={{ opacity: 0.3, margin: '0 auto 12px' }} />
          <h3 style={{ margin: '0 0 6px', color: 'rgba(255,255,255,0.6)' }}>No Pending Authorizations</h3>
          <p style={{ margin: 0, fontSize: '0.82rem' }}>All complimentary requests have been processed.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {requests.map(req => (
            <div
              key={req.request_id}
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(251,191,36,0.2)',
                borderRadius: '12px',
                padding: '18px 20px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '16px'
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <span style={{ fontWeight: '800', fontSize: '1rem', color: '#fbbf24' }}>
                    {req.food_order_number || req.food_order_id}
                  </span>
                  <span style={{
                    fontSize: '0.65rem',
                    padding: '2px 8px',
                    borderRadius: '10px',
                    background: 'rgba(251,191,36,0.15)',
                    color: '#fbbf24',
                    fontWeight: '700'
                  }}>
                    PENDING APPROVAL
                  </span>
                </div>

                <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', marginBottom: '4px' }}>
                  Recipient: <strong style={{ color: '#fff' }}>{req.recipient}</strong> ({req.recipient_type}) {req.room_number ? `— Room ${req.room_number}` : ''}
                </div>

                <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.5)', fontStyle: 'italic', marginBottom: '6px' }}>
                  "{req.reason}"
                </div>

                <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)' }}>
                  Requested by: {req.requested_by_name} • {new Date(req.requested_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>WAIVER AMOUNT</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: '800', color: '#34d399' }}>{fmt(req.amount)}</div>
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => handleReject(req.request_id)}
                    disabled={processingId === req.request_id}
                    style={{
                      padding: '8px 14px',
                      background: 'rgba(239,68,68,0.15)',
                      border: '1px solid rgba(239,68,68,0.3)',
                      borderRadius: '8px',
                      color: '#f87171',
                      fontWeight: '700',
                      cursor: 'pointer',
                      fontSize: '0.82rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                  >
                    <XCircle size={15} /> Reject
                  </button>

                  <button
                    onClick={() => handleApprove(req.request_id)}
                    disabled={processingId === req.request_id}
                    style={{
                      padding: '8px 16px',
                      background: 'linear-gradient(135deg, #10b981, #059669)',
                      border: 'none',
                      borderRadius: '8px',
                      color: '#fff',
                      fontWeight: '700',
                      cursor: 'pointer',
                      fontSize: '0.82rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                  >
                    <CheckCircle size={15} /> Approve
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
