import React from 'react';

export default function Gallery() {
  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '4rem 2rem' }}>
      <h1 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontSize: '2.5rem', marginBottom: '1.5rem' }}>
        Photo Gallery
      </h1>
      <div className="glass" style={{ padding: '2rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', lineHeight: '1.6' }}>
          Take a visual tour of our hotel and amenities.
        </p>
        <p style={{ marginTop: '2rem', fontSize: '0.9rem', color: '#666' }}>
          [ This is a Phase 6 placeholder page component. ]
        </p>
      </div>
    </div>
  );
}
