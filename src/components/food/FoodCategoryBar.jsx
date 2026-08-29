/**
 * FoodCategoryBar.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Horizontal category filter bar for the Food POS menu grid.
 * Renders a scrollable pill-row of category buttons.
 *
 * Props:
 *   categories      — array of category objects from foodMenuRepository
 *   selectedId      — currently active category_id (or null for "All")
 *   onSelect        — callback(category_id | null)
 *   loading         — boolean; shows skeleton state
 */

import React from 'react';

export default function FoodCategoryBar({ categories = [], selectedId, onSelect, loading = false }) {

  const barStyle = {
    display:    'flex',
    alignItems: 'center',
    gap:        '8px',
    overflowX:  'auto',
    padding:    '4px 0 12px 0',
    scrollbarWidth: 'thin',
    scrollbarColor: 'rgba(255,255,255,0.1) transparent',
    flexShrink: 0
  };

  const pillBase = {
    display:       'inline-flex',
    alignItems:    'center',
    gap:           '6px',
    padding:       '7px 16px',
    borderRadius:  '999px',
    border:        '1px solid rgba(255,255,255,0.1)',
    cursor:        'pointer',
    fontSize:      '0.82rem',
    fontWeight:    '500',
    whiteSpace:    'nowrap',
    transition:    'all 0.18s ease',
    userSelect:    'none',
    flexShrink:    0,
    fontFamily:    'var(--font-body, Inter, sans-serif)'
  };

  const pillActive = {
    ...pillBase,
    background:  'linear-gradient(135deg, rgba(56,189,248,0.25) 0%, rgba(99,102,241,0.25) 100%)',
    border:      '1px solid rgba(56,189,248,0.5)',
    color:       '#38bdf8',
    boxShadow:   '0 0 12px rgba(56,189,248,0.2)'
  };

  const pillInactive = {
    ...pillBase,
    background:  'rgba(255,255,255,0.04)',
    color:       'rgba(255,255,255,0.65)'
  };

  if (loading) {
    return (
      <div style={barStyle}>
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} style={{
            ...pillInactive,
            width: `${60 + i * 15}px`,
            height: '34px',
            background: 'rgba(255,255,255,0.06)',
            animation: 'pulse 1.5s ease-in-out infinite'
          }} />
        ))}
      </div>
    );
  }

  return (
    <div style={barStyle}>
      {/* "All" pill */}
      <button
        style={selectedId === null ? pillActive : pillInactive}
        onClick={() => onSelect(null)}
        title="Show all menu items"
      >
        <span>🍽️</span>
        <span>All Items</span>
      </button>

      {categories.map(cat => (
        <button
          key={cat.category_id}
          style={selectedId === cat.category_id ? pillActive : pillInactive}
          onClick={() => onSelect(cat.category_id)}
          title={cat.description || cat.name}
        >
          <span>{cat.icon_emoji || '🍴'}</span>
          <span>{cat.name}</span>
          {!cat.is_active && (
            <span style={{
              fontSize: '0.65rem',
              padding: '1px 5px',
              borderRadius: '4px',
              background: 'rgba(239,68,68,0.2)',
              color: '#ef4444',
              border: '1px solid rgba(239,68,68,0.3)'
            }}>OFF</span>
          )}
        </button>
      ))}
    </div>
  );
}
