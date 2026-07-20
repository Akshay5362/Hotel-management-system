import React from 'react';

export default function GuestProfile({ guest }) {
  if (!guest) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <span style={{ fontSize: '2rem' }}>🎖️</span>
      <div>
        <div style={{ fontWeight: '800', color: '#fff', fontSize: '1rem' }}>{guest.full_name}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{guest.phone}</div>
      </div>
    </div>
  );
}
