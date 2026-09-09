/**
 * InventoryHub.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Inventory Module Shell (Phase A — Foundation & Master Data;
 * Phase B — Purchase Requests).
 * Modelled on src/components/food/FoodPOS.jsx's tabbed-shell pattern.
 *
 * Tabs: Stock · Items · Categories · Units · Locations · Suppliers · Movements
 *       · Purchase Requests · Purchase Orders · Approval Settings.
 * "Items" reuses the existing src/components/InventoryModule.jsx (evolved for
 * Phase A) rather than re-implementing product-master CRUD.
 *
 * Role gating here is a UX convenience only — the server enforces the real
 * boundary via requireRole (backend/routes/inventoryRoutes.js). The role
 * matrix mirrors backend/utils/inventoryConstants.js INVENTORY_ROLES and
 * backend/controllers/authController.js normalizeUserRole exactly, so the
 * tabs a user sees here match what their token can actually do.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNotifications } from '../../contexts/NotificationContext';
import { Package, Boxes, Tags, Ruler, Warehouse, Truck, History, ClipboardList, ShieldCheck, FileText } from 'lucide-react';
import InventoryModule from '../InventoryModule';
import InventoryStock from './InventoryStock';
import InventoryMasters from './InventoryMasters';
import InventorySuppliers from './InventorySuppliers';
import StockMovementHistory from './StockMovementHistory';
import InventoryPurchaseRequests from './InventoryPurchaseRequests';
import InventoryApprovalSettings from './InventoryApprovalSettings';
import InventoryPurchaseOrders from './InventoryPurchaseOrders';

// Mirrors backend/utils/inventoryConstants.js INVENTORY_ROLES.
const INVENTORY_ROLES = {
  VIEW: ['admin', 'super_admin', 'receptionist', 'kitchen', 'housekeeper'],
  MANAGE: ['admin', 'super_admin'],
  MOVE: ['admin', 'super_admin', 'kitchen', 'housekeeper'],
  // Phase B — create/view purchase requests (approval is a later phase).
  REQUEST: ['admin', 'super_admin', 'receptionist', 'kitchen', 'housekeeper'],
  // Phase G — reversing a goods receipt or closing an order short. Narrower
  // than receiving on purpose: a receptionist may sign for a delivery but may
  // not undo one. Hiding the control is UX only — the server is authoritative.
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
  return raw.toLowerCase() || 'admin'; // sensible default when no user prop is supplied yet
}

const TABS = [
  { key: 'stock', label: 'Stock', icon: Boxes, roles: INVENTORY_ROLES.VIEW, desc: 'Current quantities, low-stock and out-of-stock status' },
  { key: 'items', label: 'Items', icon: Package, roles: INVENTORY_ROLES.MANAGE, desc: 'Product master: categories, units, pricing, photos, opening stock' },
  { key: 'categories', label: 'Categories', icon: Tags, roles: INVENTORY_ROLES.MANAGE, desc: 'Item categories and departments' },
  { key: 'units', label: 'Units', icon: Ruler, roles: INVENTORY_ROLES.MANAGE, desc: 'Units of measure' },
  { key: 'locations', label: 'Locations', icon: Warehouse, roles: INVENTORY_ROLES.MANAGE, desc: 'Stores / rooms where stock is held' },
  { key: 'suppliers', label: 'Suppliers', icon: Truck, roles: INVENTORY_ROLES.MANAGE, desc: 'Vendor directory' },
  { key: 'movements', label: 'Stock Movements', icon: History, roles: INVENTORY_ROLES.VIEW, desc: 'Ledger history, adjustments and transfers' },
  { key: 'purchase-requests', label: 'Purchase Requests', icon: ClipboardList, roles: INVENTORY_ROLES.REQUEST, desc: 'Request items to be purchased — never changes stock' },
  { key: 'purchase-orders', label: 'Purchase Orders', icon: FileText, roles: INVENTORY_ROLES.MANAGE, desc: 'Orders issued to suppliers, goods receiving, receipt reversal and short close' },
  { key: 'approval-settings', label: 'Approval Settings', icon: ShieldCheck, roles: INVENTORY_ROLES.MANAGE, desc: 'Who may approve purchase requests, and who is notified' }
];

export default function InventoryHub({ token, user }) {
  const role = useMemo(() => normalizeInventoryRole(user), [user]);
  const canMove = INVENTORY_ROLES.MOVE.includes(role);
  const visibleTabs = useMemo(() => TABS.filter(t => t.roles.includes(role)), [role]);
  const [activeTab, setActiveTab] = useState(() => (visibleTabs[0] || TABS[0]).key);

  // Notification click → open the requested sub-tab (and, for a purchase
  // request, that specific request). Only tabs this role can already see are
  // honoured, so no access is granted here. Mirrors FoodPOS's consumer.
  const notificationCtx = useNotifications();
  const navigationIntent = notificationCtx?.navigationIntent || null;
  const clearNavigationIntent = notificationCtx?.clearNavigationIntent;
  const [deepLinkRequestId, setDeepLinkRequestId] = useState(null);
  const [deepLinkOrderId, setDeepLinkOrderId] = useState(null);

  /** Purchase Requests → "View / Create Purchase Order" jumps to that order. */
  const openPurchaseOrder = (orderId) => {
    setDeepLinkOrderId(String(orderId));
    setActiveTab('purchase-orders');
  };
  useEffect(() => {
    if (!navigationIntent || navigationIntent.module !== 'inventory') return;
    const allowed = TABS.some(t => t.key === navigationIntent.tab && t.roles.includes(role));
    if (allowed) setActiveTab(navigationIntent.tab);
    if (navigationIntent.requestId) setDeepLinkRequestId(String(navigationIntent.requestId));
    if (clearNavigationIntent) clearNavigationIntent();
  }, [navigationIntent, clearNavigationIntent, role]);

  const current = visibleTabs.find(t => t.key === activeTab) || visibleTabs[0];

  if (!current) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted, #94a3b8)' }}>
        Your role does not have access to Inventory.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'var(--font-body, Inter, sans-serif)' }}>
      {/* Module header + tab strip */}
      <div style={{ padding: '16px 24px 0 24px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '0 0 4px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Package color="var(--accent-color, #38bdf8)" size={24} /> Inventory
        </h1>
        <p style={{ color: 'var(--text-muted, #94a3b8)', margin: '0 0 14px 0', fontSize: '0.85rem' }}>
          {current.desc}
        </p>
        <div style={{ display: 'flex', gap: 4, overflowX: 'auto' }}>
          {visibleTabs.map(tab => {
            const Icon = tab.icon;
            const isActive = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '10px 14px', border: 'none', background: 'none', cursor: 'pointer',
                  color: isActive ? 'var(--accent-color, #38bdf8)' : 'var(--text-muted, #94a3b8)',
                  borderBottom: isActive ? '2px solid var(--accent-color, #38bdf8)' : '2px solid transparent',
                  fontWeight: isActive ? 700 : 500, fontSize: '0.85rem', whiteSpace: 'nowrap'
                }}
              >
                <Icon size={15} /> {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab body */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {activeTab === 'stock' && <InventoryStock token={token} />}
        {activeTab === 'items' && <InventoryModule token={token} />}
        {activeTab === 'categories' && <InventoryMasters token={token} section="categories" />}
        {activeTab === 'units' && <InventoryMasters token={token} section="units" />}
        {activeTab === 'locations' && <InventoryMasters token={token} section="locations" />}
        {activeTab === 'suppliers' && <InventorySuppliers token={token} />}
        {activeTab === 'movements' && <StockMovementHistory token={token} canMove={canMove} />}
        {activeTab === 'purchase-requests' && (
          <InventoryPurchaseRequests
            token={token}
            currentUserUid={user?.uid}
            openRequestId={deepLinkRequestId}
            onDeepLinkHandled={() => setDeepLinkRequestId(null)}
            canManageOrders={INVENTORY_ROLES.MANAGE.includes(role)}
            onOpenPurchaseOrder={openPurchaseOrder}
          />
        )}
        {activeTab === 'purchase-orders' && (
          <InventoryPurchaseOrders
            token={token}
            openOrderId={deepLinkOrderId}
            onDeepLinkHandled={() => setDeepLinkOrderId(null)}
            canCorrect={INVENTORY_ROLES.CORRECT.includes(role)}
          />
        )}
        {activeTab === 'approval-settings' && <InventoryApprovalSettings token={token} />}
      </div>
    </div>
  );
}
