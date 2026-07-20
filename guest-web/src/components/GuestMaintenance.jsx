import React from 'react';

export default function GuestMaintenance({
  maintenanceIssue,
  setMaintenanceIssue,
  handleMaintenanceSubmit,
  isSubmittingMaintenance
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}>🔧 Report a Maintenance Issue</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Experiencing a problem in your room? Let us know and our team will resolve it quickly.</p>
      </div>

      {/* Common issues quick select */}
      <div className="glass" style={{ borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)' }}>
        <p style={{ color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.85rem', marginBottom: '12px' }}>Quick Select (tap to add to description):</p>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
          {['AC not cooling', 'No hot water', 'Light not working', 'WiFi not connecting', 'TV issue', 'Door lock issue', 'Plumbing problem', 'Noise complaint', 'Broken furniture'].map(issue => (
            <button key={issue} onClick={() => setMaintenanceIssue(prev => prev ? `${prev}, ${issue}` : issue)}
              style={{ background: 'rgba(250,204,21,0.1)', border: '1px solid rgba(250,204,21,0.2)', borderRadius: '20px', padding: '6px 12px', color: '#facc15', fontSize: '0.8rem', cursor: 'pointer', fontWeight: '600' }}>
              {issue}
            </button>
          ))}
        </div>

        <form onSubmit={handleMaintenanceSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <textarea
            value={maintenanceIssue}
            onChange={e => setMaintenanceIssue(e.target.value)}
            placeholder="Describe the issue in detail (e.g. AC is not cooling the room, making loud noise)..."
            rows={5}
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '14px', color: '#fff', fontSize: '0.9rem', resize: 'vertical', fontFamily: 'inherit' }}
          />
          <button
            type="submit"
            disabled={isSubmittingMaintenance || !maintenanceIssue.trim()}
            style={{ background: isSubmittingMaintenance ? 'rgba(255,255,255,0.05)' : 'rgba(250,204,21,0.15)', border: '1px solid rgba(250,204,21,0.4)', borderRadius: '8px', padding: '12px 24px', color: '#facc15', fontWeight: '800', fontSize: '0.92rem', cursor: 'pointer', alignSelf: 'flex-start', transition: 'all 0.2s' }}
          >
            {isSubmittingMaintenance ? '⏳ Submitting...' : '🔧 Submit Report'}
          </button>
        </form>
      </div>
    </div>
  );
}
