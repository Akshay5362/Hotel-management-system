import React, { useState, useEffect } from 'react';
import { API_URL, getApiHeaders, getAssetUrl } from '../config/apiConfig';

const STATUS_COLORS = {
  Pending:  { bg: 'rgba(234, 179, 8, 0.15)', border: 'rgba(234, 179, 8, 0.4)',  text: '#fde047' },
  Verified: { bg: 'rgba(34, 197, 94, 0.15)', border: 'rgba(34, 197, 94, 0.4)',  text: '#4ade80' },
  Rejected: { bg: 'rgba(239, 68, 68, 0.15)', border: 'rgba(239, 68, 68, 0.4)',  text: '#f87171' },
};

export default function IdentityVerificationModal({ isOpen, onClose, token, rooms = [] }) {
  const [documents, setDocuments] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('All');

  const [selectedDoc, setSelectedDoc] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setSelectedDoc(null);
      fetchDocuments();
    }
  }, [isOpen]);

  const fetchDocuments = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/guest-documents`, {
        headers: getApiHeaders(token)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to fetch documents');
      setDocuments(data.guests || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify = async (status) => {
    if (status === 'Rejected' && !rejectionReason.trim()) {
      alert('Please provide a rejection reason before rejecting a document.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/admin/guest-documents/${selectedDoc.id}/verify`, {
        method: 'POST',
        headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status, rejectionReason })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Verification failed');

      // Update local state optimistically
      setDocuments(prev => prev.map(doc =>
        doc.id === selectedDoc.id
          ? { ...doc, id_verification_status: status, id_rejection_reason: status === 'Rejected' ? rejectionReason : null }
          : doc
      ));
      setSelectedDoc(prev => ({ ...prev, id_verification_status: status, id_rejection_reason: status === 'Rejected' ? rejectionReason : null }));
      setRejectionReason('');
    } catch (err) {
      alert(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteDocument = async () => {
    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/admin/guest-documents/${selectedDoc.id}`, {
        method: 'DELETE',
        headers: getApiHeaders(token)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Deletion failed');
      
      alert('Identity document deleted successfully.');
      setShowDeleteConfirm(false);
      setSelectedDoc(null);
      fetchDocuments();
    } catch (err) {
      alert(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const statusCounts = documents.reduce((acc, d) => {
    acc[d.id_verification_status] = (acc[d.id_verification_status] || 0) + 1;
    return acc;
  }, {});

  const filtered = filter === 'All' ? documents : documents.filter(d => d.id_verification_status === filter);

  const statusChip = (status) => {
    const c = STATUS_COLORS[status] || STATUS_COLORS.Pending;
    return (
      <span style={{
        fontSize: '0.7rem', padding: '3px 9px', borderRadius: '20px', fontWeight: '700',
        background: c.bg, border: `1px solid ${c.border}`, color: c.text, letterSpacing: '0.3px'
      }}>
        {status}
      </span>
    );
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 2000 }}>
      <div className="modal-content glass" style={{
        width: '980px', maxWidth: '96vw', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', borderRadius: '16px', overflow: 'hidden'
      }}>

        {/* Header */}
        <div style={{
          padding: '18px 24px', borderBottom: '1px solid rgba(255,255,255,0.07)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: 'rgba(0,0,0,0.3)', flexShrink: 0
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '1.5rem' }}>🛡️</span>
            <div>
              <h2 style={{ fontSize: '1.1rem', fontWeight: '800', color: '#fff', margin: 0 }}>
                Identity Document Verification
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
                Review guest-uploaded IDs and approve or reject for check-in clearance
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={fetchDocuments}
              style={{ background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.25)', borderRadius: '8px', padding: '6px 12px', color: '#38bdf8', cursor: 'pointer', fontSize: '0.78rem', fontWeight: '600' }}
            >
              ↻ Refresh
            </button>
            <button className="btn-close" onClick={onClose} style={{ fontSize: '1.2rem', lineHeight: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', width: '32px', height: '32px', cursor: 'pointer', color: '#fff' }}>×</button>
          </div>
        </div>

        {/* Stats bar */}
        <div style={{ display: 'flex', gap: '1px', background: 'rgba(255,255,255,0.04)', flexShrink: 0 }}>
          {['All', 'Pending', 'Verified', 'Rejected'].map(s => {
            const count = s === 'All' ? documents.length : (statusCounts[s] || 0);
            const c = s === 'All' ? { bg: 'rgba(99,102,241,0.15)', border: 'rgba(99,102,241,0.3)', text: '#a5b4fc' } : (STATUS_COLORS[s] || STATUS_COLORS.Pending);
            return (
              <button
                key={s}
                onClick={() => setFilter(s)}
                style={{
                  flex: 1, padding: '10px 6px', background: filter === s ? c.bg : 'transparent',
                  border: 'none', borderBottom: filter === s ? `2px solid ${c.text}` : '2px solid transparent',
                  color: filter === s ? c.text : 'var(--text-muted)', cursor: 'pointer',
                  fontSize: '0.78rem', fontWeight: filter === s ? '700' : '500', transition: 'all 0.2s'
                }}
              >
                {s} <span style={{ fontWeight: '800' }}>({count})</span>
              </button>
            );
          })}
        </div>

        {/* Body: Two-column layout */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

          {/* Left Panel: Document List */}
          <div style={{ width: '310px', flexShrink: 0, overflowY: 'auto', borderRight: '1px solid rgba(255,255,255,0.07)', padding: '12px' }}>
            {isLoading ? (
              <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>⏳ Loading documents...</div>
            ) : error ? (
              <div style={{ padding: '20px', color: '#f87171', background: 'rgba(239,68,68,0.08)', borderRadius: '8px', fontSize: '0.85rem' }}>
                ⚠️ {error}
                <button onClick={fetchDocuments} style={{ display: 'block', marginTop: '8px', background: 'transparent', border: '1px solid #f87171', color: '#f87171', padding: '4px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem' }}>Retry</button>
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                {filter === 'All' ? 'No documents uploaded yet.' : `No ${filter} documents.`}
              </div>
            ) : (
              filtered.map(doc => (
                <div
                  key={doc.id}
                  onClick={() => { setSelectedDoc(doc); setRejectionReason(doc.id_rejection_reason || ''); setImgError(false); }}
                  style={{
                    padding: '12px', borderRadius: '10px', marginBottom: '8px', cursor: 'pointer',
                    background: selectedDoc?.id === doc.id ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${selectedDoc?.id === doc.id ? 'rgba(56,189,248,0.4)' : 'rgba(255,255,255,0.06)'}`,
                    transition: 'all 0.18s'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px' }}>
                    <div style={{ fontWeight: '700', color: '#fff', fontSize: '0.88rem', lineHeight: '1.3' }}>{doc.full_name}</div>
                    {statusChip(doc.id_verification_status)}
                  </div>
                  <div style={{ fontSize: '0.77rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                    📄 {doc.id_type}
                  </div>
                  <div style={{ fontSize: '0.77rem', color: 'var(--text-secondary)', marginTop: '2px', fontFamily: 'monospace' }}>
                    {doc.government_id}
                  </div>
                  {doc.room_number && (
                    <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <span style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: '20px', background: doc.booking_status === 'Checked In' ? 'rgba(34,197,94,0.15)' : 'rgba(56,189,248,0.15)', color: doc.booking_status === 'Checked In' ? '#4ade80' : '#38bdf8', border: '1px solid currentColor', fontWeight: '600' }}>
                        Room {doc.room_number} · {doc.booking_status}
                      </span>
                    </div>
                  )}
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Uploaded: {new Date(doc.id_upload_timestamp).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Right Panel: Document Details & Verification */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {selectedDoc ? (
              <>
                {/* Guest Info Row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                  {[
                    { label: 'Guest Name', value: selectedDoc.full_name },
                    { label: 'Document Type', value: selectedDoc.id_type },
                    { label: 'Document Number', value: selectedDoc.government_id },
                    { label: 'Assigned Room', value: selectedDoc.room_number ? `Room ${selectedDoc.room_number}` : 'No Active Booking' },
                    { label: 'Booking Status', value: selectedDoc.booking_status || '—' },
                    { label: 'Verification Status', value: selectedDoc.id_verification_status },
                  ].map(item => (
                    <div key={item.label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '10px 12px' }}>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{item.label}</div>
                      <div style={{ fontSize: '0.88rem', fontWeight: '700', color: '#fff' }}>{item.value}</div>
                    </div>
                  ))}
                </div>

                {/* Document Preview */}
                <div style={{ background: 'rgba(0,0,0,0.35)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden', minHeight: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {selectedDoc.id_document_path && !selectedDoc.id_document_path.endsWith('.pdf') ? (
                    imgError ? (
                      <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                        <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>🖼️</div>
                        <div>Image could not be loaded.</div>
                        <a href={getAssetUrl(`/guest-documents/${selectedDoc.id_document_path}`)} target="_blank" rel="noopener noreferrer" style={{ color: '#38bdf8', fontSize: '0.8rem', marginTop: '6px', display: 'inline-block' }}>
                          Open file directly →
                        </a>
                      </div>
                    ) : (
                      <img
                        src={getAssetUrl(`/guest-documents/${selectedDoc.id_document_path}`)}
                        alt="Guest ID Document"
                        onError={() => setImgError(true)}
                        style={{ maxWidth: '100%', maxHeight: '320px', objectFit: 'contain', borderRadius: '6px' }}
                      />
                    )
                  ) : selectedDoc.id_document_path?.endsWith('.pdf') ? (
                    <object
                      data={getAssetUrl(`/guest-documents/${selectedDoc.id_document_path}`)}
                      type="application/pdf"
                      width="100%"
                      height="320px"
                    >
                      <a href={getAssetUrl(`/guest-documents/${selectedDoc.id_document_path}`)} target="_blank" rel="noopener noreferrer" style={{ color: '#38bdf8' }}>
                        Open PDF →
                      </a>
                    </object>

                  ) : (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No document file attached.</div>
                  )}
                </div>

                {/* OCR Text (if available) */}
                {selectedDoc.id_ocr_text && (
                  <div>
                    <div style={{ fontSize: '0.78rem', fontWeight: '700', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      🔍 OCR Extracted Text
                    </div>
                    <div style={{ background: 'rgba(0,0,0,0.4)', padding: '10px', borderRadius: '8px', fontSize: '0.77rem', color: 'var(--text-muted)', maxHeight: '80px', overflowY: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'monospace', border: '1px solid rgba(255,255,255,0.06)' }}>
                      {selectedDoc.id_ocr_text}
                    </div>
                  </div>
                )}

                {/* Verification Action */}
                <div style={{ marginTop: 'auto', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', padding: '16px', borderRadius: '10px', flexShrink: 0 }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-secondary)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    ✅ Verification Decision
                  </div>

                  {selectedDoc.id_verification_status !== 'Pending' ? (
                    <div>
                      <div style={{ padding: '10px 14px', borderRadius: '8px', background: STATUS_COLORS[selectedDoc.id_verification_status]?.bg, border: `1px solid ${STATUS_COLORS[selectedDoc.id_verification_status]?.border}`, marginBottom: '10px' }}>
                        <p style={{ color: STATUS_COLORS[selectedDoc.id_verification_status]?.text, fontWeight: '700', margin: 0, fontSize: '0.9rem' }}>
                          Document is currently <strong>{selectedDoc.id_verification_status}</strong>
                        </p>
                        {selectedDoc.id_rejection_reason && (
                          <p style={{ fontSize: '0.82rem', color: '#f87171', marginTop: '4px', margin: '4px 0 0 0' }}>
                            Reason: {selectedDoc.id_rejection_reason}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => handleVerify('Pending')}
                        disabled={isSubmitting}
                        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '7px 16px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: '600' }}
                      >
                        ↺ Reset to Pending
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <input
                        type="text"
                        placeholder="Rejection reason (required only when rejecting)"
                        value={rejectionReason}
                        onChange={(e) => setRejectionReason(e.target.value)}
                        style={{ padding: '9px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', color: '#fff', fontSize: '0.85rem', outline: 'none' }}
                      />
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button
                          onClick={() => handleVerify('Verified')}
                          disabled={isSubmitting}
                          style={{ flex: 1, padding: '10px', background: 'rgba(22, 163, 74, 0.2)', border: '1px solid rgba(22,163,74,0.5)', borderRadius: '8px', color: '#4ade80', fontWeight: '700', cursor: 'pointer', fontSize: '0.88rem', transition: 'all 0.2s' }}
                        >
                          ✅ Approve Document
                        </button>
                        <button
                          onClick={() => handleVerify('Rejected')}
                          disabled={isSubmitting}
                          style={{ flex: 1, padding: '10px', background: 'rgba(220, 38, 38, 0.2)', border: '1px solid rgba(220,38,38,0.5)', borderRadius: '8px', color: '#f87171', fontWeight: '700', cursor: 'pointer', fontSize: '0.88rem', transition: 'all 0.2s' }}
                        >
                          ❌ Reject Document
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Delete Document Action */}
                  <div style={{ marginTop: '16px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '16px', display: 'flex', justifyContent: 'center' }}>
                    <button
                      onClick={() => setShowDeleteConfirm(true)}
                      disabled={isSubmitting}
                      style={{ width: '100%', padding: '10px', background: 'transparent', border: '1px solid rgba(239, 68, 68, 0.5)', borderRadius: '8px', color: '#f87171', fontWeight: '700', cursor: 'pointer', fontSize: '0.88rem', transition: 'all 0.2s' }}
                    >
                      🗑️ Delete Document
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px', color: 'var(--text-muted)' }}>
                <span style={{ fontSize: '3rem' }}>🛡️</span>
                <p style={{ fontSize: '0.9rem', textAlign: 'center', maxWidth: '260px', lineHeight: 1.5 }}>
                  Select a guest document from the left panel to review it here.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#1e1e1e', padding: '24px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', maxWidth: '400px', textAlign: 'center', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}>
            <h3 style={{ margin: '0 0 12px 0', color: '#fff', fontSize: '1.2rem' }}>Delete Identity Document</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '24px', lineHeight: '1.5' }}>
              Are you sure you want to permanently delete this identity document? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isSubmitting}
                style={{ flex: 1, padding: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', cursor: 'pointer', fontWeight: '600' }}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteDocument}
                disabled={isSubmitting}
                style={{ flex: 1, padding: '10px', background: '#ef4444', border: 'none', borderRadius: '8px', color: '#fff', fontWeight: '700', cursor: 'pointer' }}
              >
                {isSubmitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
