/**
 * FoodPOS.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Food / Restaurant POS Module Shell.
 *
 * Tab Management:
 *   - Menu Master (Phase 1)
 *   - New Order + Billing (Phase 2A + 2B)
 *   - Kitchen Display System (Phase 2C)
 *   - Table Master (Phase 2B)
 *   - Complimentary Approvals (Phase 2B)
 *   - Order History (Phase 2D placeholder)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState } from 'react';
import { UtensilsCrossed, BookOpen, ShoppingCart, ClipboardEdit, ClipboardList, Layers, Gift, ChefHat, BarChart3, Users } from 'lucide-react';
import FoodMenuManager from './FoodMenuManager';
import FoodNewOrder from './FoodNewOrder';
import FoodKOTModification from './FoodKOTModification';
import FoodKitchenDisplay from './FoodKitchenDisplay';
import FoodTableManager from './FoodTableManager';
import FoodWaiterManager from './FoodWaiterManager';
import FoodComplimentaryApproval from './FoodComplimentaryApproval';
import FoodOrderHistory from './FoodOrderHistory';
import FoodReports from './FoodReports';

// ── Tab configuration ─────────────────────────────────────────────────────────
// `roles` gates which normalized Food role sees this tab. FoodPOS is only ever
// reached via a RoleProtectedRoute that already limits callers to ADMIN or
// RECEPTIONIST (see App.jsx's /admin/dashboard and ReceptionPortal.jsx's Food
// tab) — Chef has its own dedicated KitchenDashboard.jsx and never renders
// this component, so no 'kitchen' entry is needed here.
const TABS = [
  {
    key:   'menu',
    label: 'Menu Master',
    icon:  BookOpen,
    phase: 1,
    ready: true,
    desc:  'Categories, items, and tax configuration',
    roles: ['admin']
  },
  {
    key:   'orders',
    label: 'New Order',
    icon:  ShoppingCart,
    phase: 2,
    ready: true,
    desc:  'Create and bill restaurant orders',
    roles: ['admin', 'receptionist']
  },
  {
    key:   'kot-modification',
    label: 'KOT Modification',
    icon:  ClipboardEdit,
    phase: 2,
    ready: true,
    desc:  'Change items or quantities on an existing KOT',
    roles: ['admin', 'receptionist']
  },
  {
    key:   'kds',
    label: 'Kitchen Display (KDS)',
    icon:  ChefHat,
    phase: 2,
    ready: true,
    desc:  'Live restaurant kitchen order line',
    roles: ['admin', 'receptionist']
  },
  {
    key:   'tables',
    label: 'Table Master',
    icon:  Layers,
    phase: 2,
    ready: true,
    desc:  'Manage dining tables',
    roles: ['admin']
  },
  {
    key:   'waiters',
    label: 'Waiter Master',
    icon:  Users,
    phase: 2,
    ready: true,
    desc:  'Manage waiters for order assignment',
    roles: ['admin']
  },
  {
    key:   'history',
    label: 'Order History',
    icon:  ClipboardList,
    phase: 2,
    ready: true,
    desc:  'Browse past orders and billing records',
    roles: ['admin', 'receptionist']
  },
  {
    key:   'reports',
    label: 'Reports',
    icon:  BarChart3,
    phase: 2,
    ready: true,
    desc:  'Sales, tax, and operational breakdowns',
    roles: ['admin']
  }
];

// FoodPOS is only reachable by ADMIN or RECEPTIONIST (enforced by the
// RoleProtectedRoute wrapping every entry point) — this only decides which
// tabs render for the two, it is not itself an authorization boundary.
function getFoodRole(user) {
  const rawRole = String(user?.role || '').toUpperCase().trim();
  return rawRole === 'RECEPTIONIST' ? 'receptionist' : 'admin';
}

function ComingSoonBadge() {
  return (
    <span style={{
      fontSize:     '0.6rem',
      padding:      '2px 6px',
      borderRadius: '4px',
      background:   'rgba(251,191,36,0.15)',
      border:       '1px solid rgba(251,191,36,0.3)',
      color:        '#fbbf24',
      fontWeight:   '700',
      letterSpacing: '0.3px',
      marginLeft:   '6px'
    }}>
      SOON
    </span>
  );
}

export default function FoodPOS({ token, user }) {
  const foodRole = getFoodRole(user);
  const visibleTabs = TABS.filter(tab => tab.roles.includes(foodRole));
  const [activeTab, setActiveTab] = useState(() => foodRole === 'receptionist' ? 'orders' : 'menu');
  const [hoveredTab, setHoveredTab] = useState(null);

  return (
    <div style={{
      display:       'flex',
      flexDirection: 'column',
      height:        '100%',
      fontFamily:    'var(--font-body, Inter, sans-serif)',
      gap:           '0'
    }}>
      {/* Module Header */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        padding:        '0 0 16px 0',
        borderBottom:   '1px solid rgba(255,255,255,0.06)',
        marginBottom:   '20px',
        flexWrap:       'wrap',
        gap:            '12px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width:          '42px',
            height:         '42px',
            borderRadius:   '10px',
            background:     'linear-gradient(135deg, rgba(251,146,60,0.25), rgba(239,68,68,0.2))',
            border:         '1px solid rgba(251,146,60,0.35)',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            fontSize:       '1.4rem'
          }}>
            🍽️
          </div>
          <div>
            <h1 style={{
              margin:     0,
              fontSize:   '1.2rem',
              fontWeight: '800',
              color:      '#f1f5f9',
              fontFamily: 'var(--font-heading, Inter, sans-serif)',
              letterSpacing: '0.3px'
            }}>
              Food & Beverage POS
            </h1>
            <p style={{ margin: '2px 0 0 0', fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)' }}>
              Restaurant Management System — Hotel Sky-5
            </p>
          </div>
        </div>

        {/* Phase badge */}
        <div style={{
          padding:      '5px 12px',
          borderRadius: '6px',
          background:   'rgba(56,189,248,0.08)',
          border:       '1px solid rgba(56,189,248,0.2)',
          fontSize:     '0.72rem',
          color:        '#38bdf8',
          fontWeight:   '600'
        }}>
          Phase 1 + 2B + 2C + 2D-B + 2D-C — Active
        </div>
      </div>

      {/* Tab Navigation */}
      <div style={{
        display:       'flex',
        alignItems:    'flex-end',
        gap:           '2px',
        marginBottom:  '20px',
        borderBottom:  '1px solid rgba(255,255,255,0.06)',
        paddingBottom: '0',
        overflowX:     'auto',
        scrollBehavior: 'smooth'
      }}>
        {visibleTabs.map(tab => {
          const Icon      = tab.icon;
          const isActive  = activeTab === tab.key;
          const isHovered = hoveredTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => { if (tab.ready) setActiveTab(tab.key); }}
              onMouseEnter={() => setHoveredTab(tab.key)}
              onMouseLeave={() => setHoveredTab(null)}
              title={tab.ready ? tab.desc : `${tab.desc} — available in Phase ${tab.phase}`}
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          '7px',
                padding:      '10px 16px',
                border:       'none',
                borderRadius: '8px 8px 0 0',
                borderBottom: isActive ? '2px solid #38bdf8' : '2px solid transparent',
                background:   isActive
                  ? 'rgba(56,189,248,0.08)'
                  : isHovered
                    ? 'rgba(255,255,255,0.04)'
                    : 'transparent',
                cursor:       tab.ready ? 'pointer' : 'not-allowed',
                color:        isActive
                  ? '#38bdf8'
                  : tab.ready
                    ? (isHovered ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.55)')
                    : 'rgba(255,255,255,0.25)',
                fontSize:      '0.84rem',
                fontWeight:    isActive ? '700' : '500',
                letterSpacing: '0.1px',
                whiteSpace:    'nowrap',
                transition:    'background 180ms ease, color 180ms ease, border-color 180ms ease',
                fontFamily:    'var(--font-body, Inter, sans-serif)',
                flexShrink:    0
              }}
            >
              <Icon size={15} />
              {tab.label}
              {!tab.ready && <ComingSoonBadge />}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {activeTab === 'menu' && (
          <FoodMenuManager token={token} user={user} />
        )}

        {activeTab === 'orders' && (
          <FoodNewOrder token={token} user={user} />
        )}

        {activeTab === 'kot-modification' && (
          <FoodKOTModification token={token} user={user} />
        )}

        {activeTab === 'kds' && (
          <FoodKitchenDisplay token={token} user={user} />
        )}

        {activeTab === 'tables' && (
          <FoodTableManager token={token} user={user} />
        )}

        {activeTab === 'waiters' && (
          <FoodWaiterManager token={token} user={user} />
        )}

        {activeTab === 'complimentary' && (
          <FoodComplimentaryApproval token={token} user={user} />
        )}

        {activeTab === 'history' && (
          <FoodOrderHistory token={token} user={user} />
        )}

        {activeTab === 'reports' && (
          <FoodReports token={token} user={user} />
        )}
      </div>
    </div>
  );
}
