/**
 * InventoryPurchasing.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The Purchasing workspace: Requests, Orders and Approvals under one header
 * with one primary action. The three screens inside are the existing Phase
 * B/C/E components, unchanged in what they call — this file only decides
 * which one is showing and carries deep links between them.
 */
import React, { useEffect, useState } from 'react';
import { ClipboardList, FileText, ClipboardCheck, Plus, ShoppingCart } from 'lucide-react';
import { Button, SubNav, PageHeader } from './ui';
import InventoryPurchaseRequests from './InventoryPurchaseRequests';
import InventoryPurchaseOrders from './InventoryPurchaseOrders';
import InventoryApprovals from './InventoryApprovals';

export default function InventoryPurchasing({ token, user, perms, sub, ctx, onNavigate, onCtxHandled }) {
  const [tab, setTab] = useState(sub || 'requests');
  const [createNonce, setCreateNonce] = useState(0);
  const [openRequestId, setOpenRequestId] = useState(null);
  const [openOrderId, setOpenOrderId] = useState(null);
  const [approvalRequestId, setApprovalRequestId] = useState(null);

  useEffect(() => { if (sub) setTab(sub); }, [sub]);

  // Context from Overview or a notification: which request/order to open, or
  // whether to start a new request straight away.
  useEffect(() => {
    if (!ctx) return;
    if (ctx.create) { setTab('requests'); setCreateNonce(n => n + 1); }
    if (ctx.requestId && tab === 'approvals') setApprovalRequestId(String(ctx.requestId));
    else if (ctx.requestId) { setTab('requests'); setOpenRequestId(String(ctx.requestId)); }
    if (ctx.orderId) { setTab('orders'); setOpenOrderId(String(ctx.orderId)); }
    onCtxHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  const items = [
    { key: 'requests', label: 'Purchase Requests', icon: ClipboardList, desc: 'Ask for stock to be bought' },
    ...(perms.manage ? [{ key: 'orders', label: 'Purchase Orders', icon: FileText, desc: 'Orders issued to suppliers' }] : []),
    { key: 'approvals', label: 'Approvals', icon: ClipboardCheck, desc: 'Decide submitted requests' }
  ];

  return (
    <div className="inv-page">
      <PageHeader
        icon={ShoppingCart}
        title="Purchasing"
        subtitle="Request stock, approve requests, and issue purchase orders. Nothing here changes stock."
        actions={perms.request ? (
          <Button variant="primary" icon={Plus} onClick={() => { setTab('requests'); setCreateNonce(n => n + 1); }}>New Purchase Request</Button>
        ) : null}
      />
      <SubNav items={items} value={tab} onChange={(k) => { setTab(k); onNavigate?.('purchasing', k); }} />

      {tab === 'requests' ? (
        <InventoryPurchaseRequests
          token={token}
          currentUserUid={user?.uid}
          openRequestId={openRequestId}
          onDeepLinkHandled={() => setOpenRequestId(null)}
          openCreateNonce={createNonce}
          canManageOrders={perms.manage}
          onOpenPurchaseOrder={(id) => { setTab('orders'); setOpenOrderId(String(id)); }}
          embedded
        />
      ) : null}

      {tab === 'orders' && perms.manage ? (
        <InventoryPurchaseOrders
          token={token}
          openOrderId={openOrderId}
          onDeepLinkHandled={() => setOpenOrderId(null)}
          canCorrect={perms.correct}
          embedded
        />
      ) : null}

      {tab === 'approvals' ? (
        <InventoryApprovals
          token={token}
          currentUserUid={user?.uid}
          openRequestId={approvalRequestId}
          onOpenHandled={() => setApprovalRequestId(null)}
          onOpenRequest={(id) => { setTab('requests'); setOpenRequestId(String(id)); }}
        />
      ) : null}
    </div>
  );
}
