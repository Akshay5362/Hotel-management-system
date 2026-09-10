/**
 * InventoryHub.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Inventory module shell (Batch 5 redesign).
 *
 * The eleven flat tabs are replaced by six areas with a clear hierarchy:
 *
 *   Overview · Stock · Purchasing · Receiving        daily operation
 *   History & Reports · Masters                      secondary / administrative
 *
 * Purchasing, Receiving, History and Masters each carry their own sub
 * navigation. Overview is the landing screen.
 *
 * WHAT DID NOT CHANGE
 * Every screen underneath still calls the same endpoints with the same
 * payloads; the role matrix below is the same one the backend enforces with
 * requireRole (backend/routes/inventoryRoutes.js) and normalizeUserRole
 * (backend/controllers/authController.js). Hiding an area grants nothing —
 * the server is authoritative on every call.
 *
 * DEEP LINKS
 * Notification navigation intents keep their contract exactly:
 *   { module: 'inventory', tab: 'purchase-requests', requestId }
 * lands on Purchasing › Purchase Requests with that request open. Legacy tab
 * keys from the previous flat layout are mapped, so an older intent still
 * arrives somewhere sensible.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNotifications } from '../../contexts/NotificationContext';
import {
  Package, LayoutDashboard, Boxes, ShoppingCart, PackageCheck, History, Settings2
} from 'lucide-react';
import './inventory.css';
import InventoryOverview from './InventoryOverview';
import InventoryStock from './InventoryStock';
import InventoryPurchasing from './InventoryPurchasing';
import InventoryReceiving from './InventoryReceiving';
import InventoryHistory from './InventoryHistory';
import InventoryMastersHub from './InventoryMastersHub';

// Mirrors backend/utils/inventoryConstants.js INVENTORY_ROLES.
const INVENTORY_ROLES = {
  VIEW: ['admin', 'super_admin', 'receptionist', 'kitchen', 'housekeeper'],
  MANAGE: ['admin', 'super_admin'],
  MOVE: ['admin', 'super_admin', 'kitchen', 'housekeeper'],
  REQUEST: ['admin', 'super_admin', 'receptionist', 'kitchen', 'housekeeper'],
  // Receiving (bills, deliveries) — matches the backend RECEIVING_ROLES guard:
  // a bill exposes purchase pricing, so it is not a VIEW screen.
  RECEIVE: ['admin', 'super_admin', 'receptionist'],
  // Phase G — reversing a receipt or closing an order short. Narrower than
  // receiving on purpose: signing for a delivery is not the same as undoing one.
  CORRECT: ['admin', 'super_admin']
};

/** Mirrors backend/controllers/authController.js normalizeUserRole exactly (display-only). */
function normalizeInventoryRole(user) {
  const raw = String(user?.role || '').toUpperCase().trim();
  const isStaff = user?.type === 'staff' || user?.user_type === 'staff';
  if (!isStaff && raw === 'ADMIN') return 'super_admin';
  if (isStaff) {
    if (raw === 'ADMIN') return 'admin';
    if (raw === 'RECEPTIONIST') return 'receptionist';
    if (raw === 'CLEANER') return 'housekeeper';
    if (['CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY'].includes(raw)) return 'kitchen';
    return raw.toLowerCase();
  }
  return raw.toLowerCase() || 'admin';
}

const SECTIONS = [
  { key: 'overview',   label: 'Overview',          icon: LayoutDashboard, roles: INVENTORY_ROLES.VIEW,    primary: true },
  { key: 'stock',      label: 'Stock',             icon: Boxes,           roles: INVENTORY_ROLES.VIEW,    primary: true },
  { key: 'purchasing', label: 'Purchasing',        icon: ShoppingCart,    roles: INVENTORY_ROLES.REQUEST, primary: true },
  { key: 'receiving',  label: 'Receiving',         icon: PackageCheck,    roles: INVENTORY_ROLES.RECEIVE, primary: true },
  { key: 'history',    label: 'History & Reports', icon: History,         roles: INVENTORY_ROLES.VIEW,    primary: false },
  { key: 'masters',    label: 'Masters',           icon: Settings2,       roles: INVENTORY_ROLES.MANAGE,  primary: false }
];

/** Old flat-tab keys → new (section, sub). Keeps existing intents working. */
const LEGACY_TABS = {
  'stock': ['stock'],
  'items': ['masters', 'items'],
  'categories': ['masters', 'categories'],
  'units': ['masters', 'units'],
  'locations': ['masters', 'locations'],
  'suppliers': ['masters', 'suppliers'],
  'movements': ['history', 'movements'],
  'purchase-requests': ['purchasing', 'requests'],
  'purchase-orders': ['purchasing', 'orders'],
  'bill-capture': ['receiving', 'bill'],
  'approval-settings': ['masters', 'approval-rules'],
  'approvals': ['purchasing', 'approvals']
};

export default function InventoryHub({ token, user }) {
  const role = useMemo(() => normalizeInventoryRole(user), [user]);
  const perms = useMemo(() => ({
    view: INVENTORY_ROLES.VIEW.includes(role),
    manage: INVENTORY_ROLES.MANAGE.includes(role),
    move: INVENTORY_ROLES.MOVE.includes(role),
    request: INVENTORY_ROLES.REQUEST.includes(role),
    receive: INVENTORY_ROLES.RECEIVE.includes(role),
    correct: INVENTORY_ROLES.CORRECT.includes(role)
  }), [role]);

  const visible = useMemo(() => SECTIONS.filter(s => s.roles.includes(role)), [role]);
  const [nav, setNav] = useState(() => ({ section: (visible[0] || SECTIONS[0]).key, sub: null, ctx: null }));

  /** Single navigation entry point used by every child and by notifications. */
  const navigate = useCallback((section, sub = null, ctx = null) => {
    if (!SECTIONS.some(s => s.key === section && s.roles.includes(role))) return;
    setNav({ section, sub, ctx: ctx ? { ...ctx, nonce: Date.now() } : null });
  }, [role]);

  const clearCtx = useCallback(() => setNav(n => (n.ctx ? { ...n, ctx: null } : n)), []);

  // Notification click → open the requested area. Only areas this role can
  // already see are honoured, so no access is granted here.
  const notificationCtx = useNotifications();
  const navigationIntent = notificationCtx?.navigationIntent || null;
  const clearNavigationIntent = notificationCtx?.clearNavigationIntent;
  useEffect(() => {
    if (!navigationIntent || navigationIntent.module !== 'inventory') return;
    const mapped = LEGACY_TABS[navigationIntent.tab] || [navigationIntent.tab];
    const [section, sub] = mapped;
    if (SECTIONS.some(s => s.key === section && s.roles.includes(role))) {
      navigate(section, sub || null, navigationIntent.requestId ? { requestId: String(navigationIntent.requestId) } : null);
    }
    if (clearNavigationIntent) clearNavigationIntent();
  }, [navigationIntent, clearNavigationIntent, role, navigate]);

  const current = visible.find(s => s.key === nav.section) || visible[0];

  if (!current) {
    return (
      <div className="inv-root">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted, #94a3b8)' }}>
          Your role does not have access to Inventory.
        </div>
      </div>
    );
  }

  const primary = visible.filter(s => s.primary);
  const secondary = visible.filter(s => !s.primary);

  return (
    <div className="inv-root">
      <div className="inv-topbar">
        <div className="inv-topbar-row">
          <div>
            <h1 className="inv-title"><Package color="var(--inv-accent)" size={20} /> Inventory</h1>
            <p className="inv-subtitle">Manage stock, purchasing and receiving</p>
          </div>
        </div>
        <nav className="inv-nav" aria-label="Inventory sections">
          {primary.map(s => {
            const Icon = s.icon;
            return (
              <button key={s.key} className={`inv-nav-item${s.key === current.key ? ' active' : ''}`} onClick={() => navigate(s.key)} title={s.label}>
                <Icon size={15} /> {s.label}
              </button>
            );
          })}
          {secondary.length ? <span className="inv-nav-divider" aria-hidden="true" /> : null}
          {secondary.map(s => {
            const Icon = s.icon;
            return (
              <button key={s.key} className={`inv-nav-item secondary${s.key === current.key ? ' active' : ''}`} onClick={() => navigate(s.key)} title={s.label}>
                <Icon size={14} /> {s.label}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="inv-body">
        {current.key === 'overview' ? <InventoryOverview token={token} perms={perms} onNavigate={navigate} /> : null}
        {current.key === 'stock' ? (
          <InventoryStock
            token={token}
            canMove={perms.move}
            initialStatus={nav.ctx?.status || ''}
            onRequestStock={perms.request ? (p) => navigate('purchasing', 'requests', { create: true, productId: p.id }) : null}
          />
        ) : null}
        {current.key === 'purchasing' ? (
          <InventoryPurchasing token={token} user={user} perms={perms} sub={nav.sub} ctx={nav.ctx} onNavigate={navigate} onCtxHandled={clearCtx} />
        ) : null}
        {current.key === 'receiving' ? (
          <InventoryReceiving token={token} perms={perms} sub={nav.sub} ctx={nav.ctx} onNavigate={navigate} onCtxHandled={clearCtx} />
        ) : null}
        {current.key === 'history' ? (
          <InventoryHistory token={token} perms={perms} sub={nav.sub} onNavigate={navigate} />
        ) : null}
        {current.key === 'masters' && perms.manage ? (
          <InventoryMastersHub token={token} sub={nav.sub} onNavigate={navigate} />
        ) : null}
      </div>
    </div>
  );
}
