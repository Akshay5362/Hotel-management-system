import React from 'react';

export default function GuestLoyalty({ guest, totalStays }) {
  if (!guest) return null;
  return (
    <div style={{ display: 'flex', gap: '24px' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '1.4rem', fontWeight: '900', color: '#fbbf24' }}>{guest.loyalty_points || 0}</div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Points</div>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '1.4rem', fontWeight: '900', color: guest.loyalty_tier === 'Gold' ? '#ffd700' : guest.loyalty_tier === 'Platinum' ? '#e5e4e2' : guest.loyalty_tier === 'Silver' ? '#c0c0c0' : '#cd7f32' }}>
          {(guest.loyalty_tier || 'Bronze').toUpperCase()}
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Tier</div>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '1.4rem', fontWeight: '900', color: '#38bdf8' }}>{totalStays || 0}</div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Stays</div>
      </div>
    </div>
  );
}
