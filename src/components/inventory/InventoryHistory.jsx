/**
 * InventoryHistory.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * History & Reports — the secondary area for looking back, kept out of the
 * daily screens. Three read-only views over existing list endpoints:
 *
 *   Stock Movements    the append-only ledger (the Phase A screen)
 *   Purchase History   decided requests and issued/closed orders
 *   Receiving History  orders with deliveries, and bills confirmed into receipts
 *
 * Each view loads only when opened, one page at a time. There is no
 * cross-order receipts endpoint, so Receiving History is built from the two
 * lists that do exist and says so.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { History, ClipboardList, PackageCheck, RefreshCw, ArrowRight } from 'lucide-react';
import { inventoryFetch } from './inventoryApi';
import { Alert, Button, Card, EmptyState, LoadingRows, StatusBadge, Table, Toolbar, humanError, money, fmtAgo, SubNav, PageHeader } from './ui';
import { PR_STATUS, PO_STATUS, BILL_STATUS, statusOf } from './statusMaps';
import StockMovementHistory from './StockMovementHistory';

export default function InventoryHistory({ token, perms, sub, onNavigate }) {
  const [tab, setTab] = useState(sub || 'movements');
  useEffect(() => { if (sub) setTab(sub); }, [sub]);

  const items = [
    { key: 'movements', label: 'Stock Movements', icon: History },
    ...(perms.request ? [{ key: 'purchases', label: 'Purchase History', icon: ClipboardList }] : []),
    ...(perms.receive ? [{ key: 'receiving', label: 'Receiving History', icon: PackageCheck }] : [])
  ];

  return (
    <div className="inv-page">
      <PageHeader icon={History} title="History & Reports" subtitle="Past activity across stock, purchasing and receiving. Read-only." />
      <SubNav items={items} value={tab} onChange={(k) => { setTab(k); onNavigate?.('history', k); }} />
      {tab === 'movements' ? <StockMovementHistory token={token} canMove={perms.move} embedded /> : null}
      {tab === 'purchases' && perms.request ? <PurchaseHistory token={token} perms={perms} onNavigate={onNavigate} /> : null}
      {tab === 'receiving' && perms.receive ? <ReceivingHistory token={token} perms={perms} onNavigate={onNavigate} /> : null}
    </div>
  );
}

const PR_COLS = [
  { key: 'no', label: 'Request' }, { key: 'date', label: 'Date' }, { key: 'by', label: 'Requested by' },
  { key: 'items', label: 'Items', className: 'num' }, { key: 'val', label: 'Estimated', className: 'num' }, { key: 'st', label: 'Status' }, { key: 'a', label: '', className: 'action' }
];
const PO_COLS = [
  { key: 'no', label: 'Order' }, { key: 'date', label: 'Date' }, { key: 'sup', label: 'Supplier' },
  { key: 'items', label: 'Items', className: 'num' }, { key: 'val', label: 'Estimated', className: 'num' }, { key: 'st', label: 'Status' }, { key: 'a', label: '', className: 'action' }
];

function PurchaseHistory({ token, perms, onNavigate }) {
  const [prStatus, setPrStatus] = useState('APPROVED');
  const [poStatus, setPoStatus] = useState('RECEIVED');
  const [prs, setPrs] = useState([]);
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [a, b] = await Promise.all([
        inventoryFetch(`/inventory/purchase-requests?status=${prStatus}&limit=25`, { token }),
        perms.manage ? inventoryFetch(`/inventory/purchase-orders?status=${poStatus}&limit=25`, { token }) : Promise.resolve({ orders: [] })
      ]);
      setPrs(a.requests || []);
      setPos(b.orders || []);
    } catch (err) {
      setError(humanError(err, 'Unable to load purchase history right now.'));
    } finally {
      setLoading(false);
    }
  }, [token, prStatus, poStatus, perms.manage]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      {error ? <Alert tone="error" onRetry={load}>{error}</Alert> : null}
      <Card title="Purchase requests" actions={
        <>
          <select className="inv-select" style={{ height: 28, fontSize: '0.76rem' }} value={prStatus} onChange={e => setPrStatus(e.target.value)}>
            <option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="CANCELLED">Cancelled</option><option value="PENDING_APPROVAL">Pending approval</option>
          </select>
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={load} aria-label="Refresh" />
        </>
      }>
        <Table columns={PR_COLS}>
          {loading ? <LoadingRows columns={PR_COLS.length} rows={4} /> : null}
          {!loading && prs.length === 0 ? <tr><td colSpan={PR_COLS.length}><EmptyState title="No purchase requests" text={`There are no ${statusOf(PR_STATUS, prStatus).label.toLowerCase()} requests.`} /></td></tr> : null}
          {!loading && prs.map(r => { const st = statusOf(PR_STATUS, r.status); return (
            <tr key={r.id} className="row-link" onClick={() => onNavigate?.('purchasing', 'requests', { requestId: r.id })}>
              <td className="mono">{r.request_number || '—'}</td>
              <td className="muted nowrap">{r.business_date}</td>
              <td>{r.requested_by_name || r.requested_by_uid || '—'}<span className="inv-cell-sub">{r.department || r.location_name_snapshot || ''}</span></td>
              <td className="num">{r.item_count}</td>
              <td className="num">{money(r.total_estimated_value)}</td>
              <td><StatusBadge label={st.label} tone={st.tone} /></td>
              <td className="action"><Button size="sm" variant="ghost" icon={ArrowRight}>Open</Button></td>
            </tr>); })}
        </Table>
      </Card>

      {perms.manage ? (
        <Card title="Purchase orders" actions={
          <select className="inv-select" style={{ height: 28, fontSize: '0.76rem' }} value={poStatus} onChange={e => setPoStatus(e.target.value)}>
            <option value="RECEIVED">Received</option><option value="PARTIALLY_RECEIVED">Partially received</option><option value="CLOSED_SHORT">Closed short</option><option value="ISSUED">Issued</option><option value="DRAFT">Draft</option>
          </select>
        }>
          <Table columns={PO_COLS}>
            {loading ? <LoadingRows columns={PO_COLS.length} rows={4} /> : null}
            {!loading && pos.length === 0 ? <tr><td colSpan={PO_COLS.length}><EmptyState title="No purchase orders" text={`There are no ${statusOf(PO_STATUS, poStatus).label.toLowerCase()} orders.`} /></td></tr> : null}
            {!loading && pos.map(o => { const st = statusOf(PO_STATUS, o.status); return (
              <tr key={o.id} className="row-link" onClick={() => onNavigate?.('purchasing', 'orders', { orderId: o.id })}>
                <td className="mono">{o.po_number}</td>
                <td className="muted nowrap">{o.business_date}</td>
                <td>{o.supplier_name_snapshot}<span className="inv-cell-sub">{o.source_request_number || ''}</span></td>
                <td className="num">{o.item_count}</td>
                <td className="num">{money(o.total_estimated_value)}</td>
                <td><StatusBadge label={st.label} tone={st.tone} /></td>
                <td className="action"><Button size="sm" variant="ghost" icon={ArrowRight}>Open</Button></td>
              </tr>); })}
          </Table>
        </Card>
      ) : null}
    </>
  );
}

const RECV_COLS = [
  { key: 'ref', label: 'Reference' }, { key: 'sup', label: 'Supplier' }, { key: 'when', label: 'When' }, { key: 'kind', label: 'Type' }, { key: 'st', label: 'Status' }, { key: 'a', label: '', className: 'action' }
];

function ReceivingHistory({ token, perms, onNavigate }) {
  const [orders, setOrders] = useState([]);
  const [bills, setBills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [rec, part, closed, confirmed] = await Promise.all([
        perms.manage ? inventoryFetch('/inventory/purchase-orders?status=RECEIVED&limit=15', { token }) : Promise.resolve({ orders: [] }),
        perms.manage ? inventoryFetch('/inventory/purchase-orders?status=PARTIALLY_RECEIVED&limit=10', { token }) : Promise.resolve({ orders: [] }),
        perms.manage ? inventoryFetch('/inventory/purchase-orders?status=CLOSED_SHORT&limit=10', { token }) : Promise.resolve({ orders: [] }),
        inventoryFetch('/inventory/bills?status=CONFIRMED&limit=25', { token })
      ]);
      setOrders([...(rec.orders || []), ...(part.orders || []), ...(closed.orders || [])]);
      setBills(confirmed.bills || []);
    } catch (err) {
      setError(humanError(err, 'Unable to load receiving history right now.'));
    } finally {
      setLoading(false);
    }
  }, [token, perms.manage]);

  useEffect(() => { load(); }, [load]);

  const rows = [
    ...orders.map(o => ({ key: `po_${o.id}`, ref: o.po_number, sub: o.source_request_number || '', supplier: o.supplier_name_snapshot, when: o.updated_at || o.business_date, kind: 'Against purchase order', st: statusOf(PO_STATUS, o.status), go: () => onNavigate?.('purchasing', 'orders', { orderId: o.id }) })),
    ...bills.map(b => ({ key: `bill_${b.id}`, ref: b.invoice_number || 'No invoice number', sub: b.receipt_id || '', supplier: b.supplier_name_raw || b.supplier_id || '—', when: b.confirmed_at || b.updated_at, kind: b.mode === 'DIRECT' ? 'Direct receipt (bill)' : 'Bill against order', st: statusOf(BILL_STATUS, b.status), go: () => onNavigate?.('receiving', 'bill', { billId: b.id }) }))
  ].sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));

  return (
    <>
      {error ? <Alert tone="error" onRetry={load}>{error}</Alert> : null}
      <Card title="Receipts" actions={<Button size="sm" variant="ghost" icon={RefreshCw} onClick={load} aria-label="Refresh" />}>
        <Table columns={RECV_COLS}>
          {loading ? <LoadingRows columns={RECV_COLS.length} rows={5} /> : null}
          {!loading && rows.length === 0 ? <tr><td colSpan={RECV_COLS.length}><EmptyState title="Nothing has been received yet" text="Confirmed deliveries and bills will be listed here." /></td></tr> : null}
          {!loading && rows.map(r => (
            <tr key={r.key} className="row-link" onClick={r.go}>
              <td className="mono">{r.ref}{r.sub ? <span className="inv-cell-sub" style={{ fontFamily: 'inherit', color: 'var(--inv-muted)' }}>{r.sub}</span> : null}</td>
              <td>{r.supplier}</td>
              <td className="muted nowrap">{fmtAgo(r.when)}</td>
              <td className="muted">{r.kind}</td>
              <td><StatusBadge label={r.st.label} tone={r.st.tone} /></td>
              <td className="action"><Button size="sm" variant="ghost" icon={ArrowRight}>Open</Button></td>
            </tr>
          ))}
        </Table>
      </Card>
      <div className="inv-hint">Individual delivery records are shown inside each purchase order. Reversals appear there against the delivery they undo.</div>
    </>
  );
}
