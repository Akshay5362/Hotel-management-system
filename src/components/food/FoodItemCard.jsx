/**
 * FoodItemCard.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Menu item display card for the Food POS grid.
 * Used in both browse mode (future order creation) and admin management view.
 *
 * Props:
 *   item           — food menu item object from foodMenuRepository
 *   mode           — 'browse' | 'manage' (default: 'browse')
 *   onEdit         — callback(item) — shown in manage mode
 *   onToggleActive — callback(item) — shown in manage mode
 *   onAddToOrder   — callback(item) — shown in browse mode (Phase 2)
 */

import React from 'react';
import { Edit, Power, Tag, Clock, Leaf, Flame } from 'lucide-react';

const TAX_LABEL = {
  GST_5:   '5% GST',
  GST_12:  '12% GST',
  GST_18:  '18% GST',
  EXEMPT:  'Tax Exempt',
  CUSTOM:  'Custom Tax'
};

const KOT_COLOR = {
  KITCHEN: 'rgba(251,146,60,0.15)',
  PANTRY:  'rgba(52,211,153,0.15)',
  BAR:     'rgba(167,139,250,0.15)',
  BAKERY:  'rgba(251,191,36,0.15)'
};

const KOT_BORDER = {
  KITCHEN: 'rgba(251,146,60,0.35)',
  PANTRY:  'rgba(52,211,153,0.35)',
  BAR:     'rgba(167,139,250,0.35)',
  BAKERY:  'rgba(251,191,36,0.35)'
};

export default function FoodItemCard({ item, mode = 'browse', onEdit, onToggleActive, onAddToOrder }) {
  if (!item) return null;

  const isInactive = item.is_active === false;

  const cardStyle = {
    position:        'relative',
    background:      isInactive
      ? 'rgba(255,255,255,0.02)'
      : 'rgba(255,255,255,0.04)',
    border:          isInactive
      ? '1px solid rgba(255,255,255,0.06)'
      : `1px solid ${KOT_BORDER[item.kot_type] || 'rgba(255,255,255,0.08)'}`,
    borderRadius:    '12px',
    padding:         '14px',
    transition:      'all 0.2s ease',
    opacity:         isInactive ? 0.55 : 1,
    cursor:          mode === 'browse' && !isInactive ? 'pointer' : 'default',
    display:         'flex',
    flexDirection:   'column',
    gap:             '8px',
    userSelect:      'none'
  };

  const hoverStyle = mode === 'browse' && !isInactive ? {
    transform:  'translateY(-2px)',
    boxShadow:  `0 6px 20px ${KOT_COLOR[item.kot_type] || 'rgba(56,189,248,0.08)'}`
  } : {};

  const [hovered, setHovered] = React.useState(false);

  // Price formatting (Indian locale)
  const formatPrice = (p) =>
    `₹${parseFloat(p || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  // Badge: VEG / NON-VEG
  const vegBadge = item.is_veg
    ? { label: 'VEG',     color: '#4ade80', border: 'rgba(74,222,128,0.3)' }
    : { label: 'NON-VEG', color: '#f87171', border: 'rgba(248,113,113,0.3)' };

  return (
    <div
      style={{ ...cardStyle, ...(hovered ? hoverStyle : {}) }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => mode === 'browse' && !isInactive && onAddToOrder && onAddToOrder(item)}
    >
      {/* KOT type indicator strip */}
      <div style={{
        position:     'absolute',
        top:          0,
        left:         0,
        right:        0,
        height:       '3px',
        borderRadius: '12px 12px 0 0',
        background:   KOT_BORDER[item.kot_type] || 'rgba(255,255,255,0.1)'
      }} />

      {/* Header row: name + badges */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <h3 style={{
          margin:     0,
          fontSize:   '0.9rem',
          fontWeight: '600',
          color:      isInactive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.92)',
          lineHeight: '1.3',
          fontFamily: 'var(--font-heading, Inter, sans-serif)',
          flex:       1,
          minWidth:   0
        }}>
          {item.name}
        </h3>

        {/* Veg/Non-veg indicator */}
        <div style={{
          width:        '14px',
          height:       '14px',
          borderRadius: '3px',
          border:       `2px solid ${vegBadge.border}`,
          background:   'transparent',
          flexShrink:   0,
          display:      'flex',
          alignItems:   'center',
          justifyContent: 'center',
          marginTop:    '2px'
        }}>
          <div style={{
            width:        '7px',
            height:       '7px',
            borderRadius: '50%',
            background:   vegBadge.color
          }} />
        </div>
      </div>

      {/* Description */}
      {item.description && (
        <p style={{
          margin:    0,
          fontSize:  '0.72rem',
          color:     'rgba(255,255,255,0.4)',
          lineHeight: '1.4',
          overflow:  'hidden',
          display:   '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical'
        }}>
          {item.description}
        </p>
      )}

      {/* Meta row */}
      <div style={{
        display:    'flex',
        alignItems: 'center',
        gap:        '10px',
        flexWrap:   'wrap',
        marginTop:  'auto'
      }}>
        {/* KOT type chip */}
        <span style={{
          fontSize:     '0.65rem',
          padding:      '2px 7px',
          borderRadius: '4px',
          background:   KOT_COLOR[item.kot_type] || 'rgba(255,255,255,0.06)',
          color:        KOT_BORDER[item.kot_type] || 'rgba(255,255,255,0.5)',
          border:       `1px solid ${KOT_BORDER[item.kot_type] || 'rgba(255,255,255,0.1)'}`,
          fontWeight:   '600',
          letterSpacing: '0.5px'
        }}>
          {item.kot_type || 'KITCHEN'}
        </span>

        {/* Prep time */}
        {item.preparation_time_mins > 0 && (
          <span style={{
            display:    'flex',
            alignItems: 'center',
            gap:        '3px',
            fontSize:   '0.68rem',
            color:      'rgba(255,255,255,0.35)'
          }}>
            <Clock size={10} />
            {item.preparation_time_mins}m
          </span>
        )}

        {/* Tax label */}
        <span style={{
          fontSize:   '0.68rem',
          color:      'rgba(255,255,255,0.3)',
          marginLeft: 'auto'
        }}>
          {TAX_LABEL[item.tax_type] || item.tax_type}
        </span>
      </div>

      {/* Price row */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        borderTop:      '1px solid rgba(255,255,255,0.05)',
        paddingTop:     '8px',
        marginTop:      '4px'
      }}>
        <span style={{
          fontSize:   '1rem',
          fontWeight: '700',
          color:      isInactive ? 'rgba(255,255,255,0.3)' : '#38bdf8',
          fontFamily: 'var(--font-mono, monospace)'
        }}>
          {formatPrice(item.base_price)}
        </span>

        {/* Manage mode actions */}
        {mode === 'manage' && (
          <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
            <button
              title="Edit item"
              onClick={() => onEdit && onEdit(item)}
              style={{
                background:   'rgba(56,189,248,0.1)',
                border:       '1px solid rgba(56,189,248,0.25)',
                borderRadius: '6px',
                color:        '#38bdf8',
                cursor:       'pointer',
                padding:      '4px 8px',
                display:      'flex',
                alignItems:   'center',
                gap:          '3px',
                fontSize:     '0.72rem',
                transition:   'all 0.15s ease'
              }}
            >
              <Edit size={11} /> Edit
            </button>
            <button
              title={isInactive ? 'Activate item' : 'Deactivate item'}
              onClick={() => onToggleActive && onToggleActive(item)}
              style={{
                background:   isInactive ? 'rgba(74,222,128,0.1)' : 'rgba(239,68,68,0.1)',
                border:       `1px solid ${isInactive ? 'rgba(74,222,128,0.25)' : 'rgba(239,68,68,0.25)'}`,
                borderRadius: '6px',
                color:        isInactive ? '#4ade80' : '#f87171',
                cursor:       'pointer',
                padding:      '4px 8px',
                display:      'flex',
                alignItems:   'center',
                gap:          '3px',
                fontSize:     '0.72rem',
                transition:   'all 0.15s ease'
              }}
            >
              <Power size={11} />
              {isInactive ? 'Activate' : 'Deactivate'}
            </button>
          </div>
        )}

        {/* Browse mode: Add button (Phase 2 stub) */}
        {mode === 'browse' && !isInactive && (
          <button
            onClick={e => { e.stopPropagation(); onAddToOrder && onAddToOrder(item); }}
            style={{
              background:   'linear-gradient(135deg, rgba(56,189,248,0.2), rgba(99,102,241,0.2))',
              border:       '1px solid rgba(56,189,248,0.35)',
              borderRadius: '6px',
              color:        '#38bdf8',
              cursor:       'pointer',
              padding:      '5px 12px',
              fontSize:     '0.78rem',
              fontWeight:   '600',
              transition:   'all 0.15s ease'
            }}
          >
            + Add
          </button>
        )}
      </div>

      {/* Inactive overlay label */}
      {isInactive && mode === 'manage' && (
        <div style={{
          position:       'absolute',
          top:            '8px',
          right:          '8px',
          background:     'rgba(239,68,68,0.15)',
          border:         '1px solid rgba(239,68,68,0.3)',
          borderRadius:   '4px',
          padding:        '2px 6px',
          fontSize:       '0.62rem',
          color:          '#f87171',
          fontWeight:     '700',
          letterSpacing:  '0.5px'
        }}>
          INACTIVE
        </div>
      )}
    </div>
  );
}
