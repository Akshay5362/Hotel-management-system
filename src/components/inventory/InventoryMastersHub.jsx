/**
 * InventoryMastersHub.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Masters — configuration, deliberately set apart from daily operation. The
 * five master-data screens and the approval rules are the existing Phase A/D
 * components; this file only arranges them and says, visibly, that these are
 * settings rather than work.
 */
import React, { useEffect, useState } from 'react';
import { Settings2, Package, Tags, Truck, Ruler, Warehouse, ShieldCheck } from 'lucide-react';
import { SubNav, PageHeader, Alert } from './ui';
import InventoryModule from '../InventoryModule';
import InventoryMasters from './InventoryMasters';
import InventorySuppliers from './InventorySuppliers';
import InventoryApprovalSettings from './InventoryApprovalSettings';

export default function InventoryMastersHub({ token, sub, onNavigate }) {
  const [tab, setTab] = useState(sub || 'items');
  useEffect(() => { if (sub) setTab(sub); }, [sub]);

  const items = [
    { key: 'items', label: 'Items', icon: Package, desc: 'Product master' },
    { key: 'categories', label: 'Categories', icon: Tags },
    { key: 'suppliers', label: 'Suppliers', icon: Truck },
    { key: 'units', label: 'Units', icon: Ruler },
    { key: 'locations', label: 'Locations', icon: Warehouse },
    { key: 'approval-rules', label: 'Approval Rules', icon: ShieldCheck }
  ];

  return (
    <div className="inv-page">
      <PageHeader
        icon={Settings2}
        title="Masters"
        subtitle="Configuration for the inventory module. Changes here shape the daily screens but do not move stock."
      />
      <SubNav items={items} value={tab} onChange={(k) => { setTab(k); onNavigate?.('masters', k); }} />
      {tab === 'items' ? <InventoryModule token={token} embedded /> : null}
      {tab === 'categories' ? <InventoryMasters token={token} section="categories" embedded /> : null}
      {tab === 'suppliers' ? <InventorySuppliers token={token} embedded /> : null}
      {tab === 'units' ? <InventoryMasters token={token} section="units" embedded /> : null}
      {tab === 'locations' ? <InventoryMasters token={token} section="locations" embedded /> : null}
      {tab === 'approval-rules' ? (
        <>
          <Alert tone="info">Who may approve purchase requests, and who is notified when one is submitted. Deciding requests happens under Purchasing › Approvals.</Alert>
          <InventoryApprovalSettings token={token} embedded />
        </>
      ) : null}
    </div>
  );
}
