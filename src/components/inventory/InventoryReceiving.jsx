/**
 * InventoryReceiving.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The Receiving workspace. Three ways goods enter stock, each a visible card:
 *
 *   1. Capture Supplier Bill   upload → read → review → match → confirm
 *   2. Receive Against PO      pick the order → check ordered vs received → confirm
 *   3. Direct Receipt          no order: supplier, bill, items, location → confirm
 *
 * All three post through the existing Phase F/H5/H6 endpoints. A direct
 * receipt is bill-based in this system (POST /bills/:id/confirm-direct), so
 * the Direct Receipt path is the bill screen opened in DIRECT mode — the
 * server has no bill-less direct receipt, and none is invented here.
 *
 * "Pending receipts" is assembled from two existing lists: purchase orders
 * still awaiting delivery, and bills still in review. There is no cross-order
 * receipts endpoint, so nothing more is claimed.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { PackageCheck, ScanLine, FileText, Truck, RefreshCw, ArrowLeft, Inbox } from 'lucide-react';
import { inventoryFetch } from './inventoryApi';
import { Alert, Button, Card, EmptyState, StatusBadge, humanError, fmtAgo, PageHeader } from './ui';
import { PO_STATUS, BILL_STATUS, BILL_OPEN_STATUSES, statusOf } from './statusMaps';
import InventoryBillCapture from './InventoryBillCapture';
import InventoryPurchaseOrders from './InventoryPurchaseOrders';

export default function InventoryReceiving({ token, perms, sub, ctx, onNavigate, onCtxHandled }) {
  const [view, setView] = useState(sub || 'home'); // home | bill | po | direct
  const [billCtx, setBillCtx] = useState(null);     // { billId?, autoUpload?, mode? }
  const [orderId, setOrderId] = useState(null);

  useEffect(() => { if (sub) setView(sub); }, [sub]);
  useEffect(() => {
    if (!ctx) return;
    if (ctx.billId) { setView('bill'); setBillCtx({ billId: String(ctx.billId) }); }
    if (ctx.orderId) { setView('po'); setOrderId(String(ctx.orderId)); }
    onCtxHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  const go = (v, c = null) => { setView(v); setBillCtx(c); onNavigate?.('receiving', v); };

  if (view === 'bill' || view === 'direct') {
    return (
      <div className="inv-page">
        <InventoryBillCapture
          token={token}
          initialMode={view === 'direct' ? 'DIRECT' : 'PO'}
          openBillId={billCtx?.billId || null}
          autoUpload={Boolean(billCtx?.autoUpload)}
          onOpenHandled={() => setBillCtx(null)}
          onBack={() => go('home')}
          canManage={perms.manage}
        />
      </div>
    );
  }

  if (view === 'po') {
    return (
      <div className="inv-page">
        <div>
          <Button variant="ghost" icon={ArrowLeft} onClick={() => go('home')}>Receiving</Button>
        </div>
        {perms.manage ? (
          <InventoryPurchaseOrders
            token={token}
            openOrderId={orderId}
            onDeepLinkHandled={() => setOrderId(null)}
            canCorrect={perms.correct}
            receivingOnly
            embedded
          />
        ) : (
          <Alert tone="info" title="Purchase orders are managed by administrators">
            You can record a delivery when an administrator opens the order for you, or capture the supplier bill instead.
          </Alert>
        )}
      </div>
    );
  }

  return <ReceivingHome token={token} perms={perms} onGo={go} />;
}

function ReceivingHome({ token, perms, onGo }) {
  const [orders, setOrders] = useState([]);
  const [bills, setBills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const errs = [];
    const safe = (p) => p.catch(e => { errs.push(humanError(e)); return null; });
    const [issued, partial, ...billPages] = await Promise.all([
      perms.manage ? safe(inventoryFetch('/inventory/purchase-orders?status=ISSUED&limit=10', { token })) : Promise.resolve(null),
      perms.manage ? safe(inventoryFetch('/inventory/purchase-orders?status=PARTIALLY_RECEIVED&limit=10', { token })) : Promise.resolve(null),
      ...BILL_OPEN_STATUSES.map(s => safe(inventoryFetch(`/inventory/bills?status=${s}&limit=10`, { token })))
    ]);
    setOrders([...(issued?.orders || []), ...(partial?.orders || [])]);
    setBills(billPages.flatMap(b => b?.bills || []));
    if (errs.length) setError([...new Set(errs)].join(' · '));
    setLoading(false);
  }, [token, perms.manage]);

  useEffect(() => { load(); }, [load]);

  const pending = orders.length + bills.length;

  return (
    <div className="inv-page">
      <PageHeader
        icon={PackageCheck}
        title="Receiving"
        subtitle="Record goods arriving at the hotel. Stock increases only when a receipt is confirmed."
        actions={<Button variant="ghost" icon={RefreshCw} onClick={load} title="Refresh" aria-label="Refresh" />}
      />

      <div className="inv-workflows">
        <button className="inv-workflow" onClick={() => onGo('bill', { autoUpload: true })}>
          <div className="inv-workflow-title"><ScanLine size={17} color="var(--inv-accent)" /> Capture Supplier Bill</div>
          <p>Photograph or upload the bill. The text is read for you, then you check every line before anything is received.</p>
          <div className="inv-workflow-steps"><span>Upload</span><span>Read</span><span>Review</span><span>Match</span><span>Confirm</span></div>
        </button>
        <button className="inv-workflow" onClick={() => onGo('po')} disabled={!perms.manage} style={!perms.manage ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
          title={!perms.manage ? 'Purchase orders are managed by administrators' : undefined}>
          <div className="inv-workflow-title"><FileText size={17} color="var(--inv-accent)" /> Receive Against PO</div>
          <p>Pick the purchase order, compare what was ordered with what arrived, and confirm the delivery.</p>
          <div className="inv-workflow-steps"><span>Select PO</span><span>Ordered vs received</span><span>Confirm</span></div>
        </button>
        <button className="inv-workflow" onClick={() => onGo('direct', { autoUpload: true })}>
          <div className="inv-workflow-title"><Truck size={17} color="var(--inv-warn)" /> Direct Receipt <span className="inv-badge warn" style={{ marginLeft: 4 }}>No purchase order</span></div>
          <p>For a purchase made without an order. Supplier, bill, items and location are recorded, then stock is increased on confirmation.</p>
          <div className="inv-workflow-steps"><span>Supplier</span><span>Bill</span><span>Items</span><span>Location</span><span>Confirm</span></div>
        </button>
      </div>

      {error ? <Alert tone="warn" onRetry={load}>{error}</Alert> : null}

      <Card title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>Pending receipts {!loading && pending > 0 ? <span className="inv-count warn">{pending}</span> : null}</span>}>
        {loading ? (
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[65, 55, 70].map((w, i) => <span key={i} className="inv-skel" style={{ width: `${w}%` }} />)}
          </div>
        ) : pending === 0 ? (
          <EmptyState icon={Inbox} title="No incoming receipts require attention" text="Issued purchase orders and bills under review will appear here." />
        ) : (
          <>
            {orders.length > 0 ? (
              <>
                <div className="inv-attn-group-head"><FileText size={12} /> Purchase orders awaiting delivery</div>
                {orders.map(o => {
                  const st = statusOf(PO_STATUS, o.status);
                  return (
                    <div className="inv-attn-row" key={o.id}>
                      <div className="inv-attn-main">
                        <div className="inv-attn-title"><span style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--inv-accent)' }}>{o.po_number}</span> · {o.supplier_name_snapshot}</div>
                        <div className="inv-attn-sub">{o.item_count} item{o.item_count === 1 ? '' : 's'} · {o.location_name_snapshot || ''} · {o.business_date}</div>
                      </div>
                      <StatusBadge label={st.label} tone={st.tone} />
                      <Button size="sm" variant="primary" onClick={() => { onGo('po'); }} data-order={o.id}>Receive</Button>
                    </div>
                  );
                })}
              </>
            ) : null}
            {bills.length > 0 ? (
              <>
                <div className="inv-attn-group-head"><ScanLine size={12} /> Bills under review</div>
                {bills.map(b => {
                  const st = statusOf(BILL_STATUS, b.status);
                  return (
                    <div className="inv-attn-row" key={b.id}>
                      <div className="inv-attn-main">
                        <div className="inv-attn-title">{b.invoice_number || 'No invoice number'} <span style={{ color: 'var(--inv-muted)', fontWeight: 400 }}>· {b.supplier_name_raw || 'supplier not identified'}</span></div>
                        <div className="inv-attn-sub">uploaded {fmtAgo(b.created_at)}{typeof b.ocr_confidence === 'number' ? ` · read at ${Math.round(b.ocr_confidence)}% confidence` : ''}</div>
                      </div>
                      <StatusBadge label={st.label} tone={st.tone} />
                      <Button size="sm" onClick={() => onGo('bill', { billId: b.id })}>Review</Button>
                    </div>
                  );
                })}
              </>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
