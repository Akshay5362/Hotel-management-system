/**
 * InventoryOverview.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The Inventory landing screen. Answers, at a glance: how much is there, what
 * is short, what is waiting for someone, and what happened recently.
 *
 * DATA HONESTY
 * Every number here comes from an existing list endpoint, requested once on
 * mount and again only when the person presses Refresh. Nothing polls, nothing
 * listens. Where the API cannot answer a question reliably the question is
 * not asked: there is no "stock value" card, because the only way to compute
 * it today would be to fetch every product, and the pending counts are the
 * size of the first page (capped), shown as "5+" when the page is full.
 *
 * Requests are gated by role so a person is never shown a section they cannot
 * open and the screen never generates 403s for them.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Package, AlertTriangle, XCircle, ClipboardCheck, Plus, ScanLine, RefreshCw,
  PackageCheck, FileText, Activity, ArrowRight
} from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';
import { Button, Card, KpiCard, StatusBadge, EmptyState, Alert, humanError, fmtAgo, PageHeader } from './ui';
import { MOVEMENT_TYPE, PR_STATUS, PO_STATUS, BILL_STATUS, statusOf } from './statusMaps';

const PAGE = 5;

export default function InventoryOverview({ token, perms, onNavigate }) {
  const [metrics, setMetrics] = useState(null);
  const [low, setLow] = useState([]);
  const [out, setOut] = useState([]);
  const [pendingPRs, setPendingPRs] = useState([]);
  const [receivablePOs, setReceivablePOs] = useState([]);
  const [openBills, setOpenBills] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    const errs = [];
    const safe = (label, p) => p.catch(err => { errs.push(`${label}: ${humanError(err)}`); return null; });

    // Only what this role may read. The stock endpoint carries the KPIs.
    const jobs = {
      low: safe('Low stock', inventoryFetch(`/inventory/stock?page_size=${PAGE}&stock_status=LOW_STOCK`, { token })),
      out: safe('Out of stock', inventoryFetch(`/inventory/stock?page_size=${PAGE}&stock_status=OUT_OF_STOCK`, { token })),
      prs: perms.request ? safe('Approvals', inventoryFetch(`/inventory/purchase-requests?status=PENDING_APPROVAL&limit=${PAGE}`, { token })) : Promise.resolve(null),
      issued: perms.manage ? safe('Purchase orders', inventoryFetch(`/inventory/purchase-orders?status=ISSUED&limit=${PAGE}`, { token })) : Promise.resolve(null),
      partial: perms.manage ? safe('Purchase orders', inventoryFetch(`/inventory/purchase-orders?status=PARTIALLY_RECEIVED&limit=${PAGE}`, { token })) : Promise.resolve(null),
      bills: perms.receive ? Promise.all(['EXTRACTED', 'IN_REVIEW', 'EXTRACTION_FAILED'].map(s =>
        safe('Bills', inventoryFetch(`/inventory/bills?status=${s}&limit=${PAGE}`, { token })))) : Promise.resolve(null),
      moves: safe('Recent activity', inventoryFetch('/inventory/movements?limit=8', { token }))
    };
    const r = await Promise.all(Object.values(jobs));
    const [lowR, outR, prR, issuedR, partialR, billsR, movesR] = r;

    if (lowR) { setMetrics(lowR.metrics || null); setLow(lowR.items || []); }
    if (outR) { setOut(outR.items || []); if (!lowR && outR.metrics) setMetrics(outR.metrics); }
    setPendingPRs(prR?.requests || []);
    setReceivablePOs([...(issuedR?.orders || []), ...(partialR?.orders || [])]);
    setOpenBills((billsR || []).flatMap(b => b?.bills || []));
    setActivity(movesR?.movements || []);
    setErrors([...new Set(errs)]);
    setLoading(false);
  }, [token, perms.request, perms.manage, perms.receive]);

  useEffect(() => { load(); }, [load]);

  const plus = (arr) => (arr.length >= PAGE ? `${PAGE}+` : String(arr.length));
  const attentionCount = low.length + out.length + pendingPRs.length + receivablePOs.length + openBills.length;

  return (
    <div className="inv-page">
      <PageHeader
        icon={Package}
        title="Inventory"
        subtitle="Manage stock, purchasing and receiving"
        actions={
          <>
            <Button variant="ghost" icon={RefreshCw} onClick={load} title="Refresh" aria-label="Refresh" />
            {perms.receive ? <Button icon={ScanLine} onClick={() => onNavigate('receiving', 'bill')}>Capture Bill</Button> : null}
            {perms.request ? <Button variant="primary" icon={Plus} onClick={() => onNavigate('purchasing', 'requests', { create: true })}>Purchase Request</Button> : null}
          </>
        }
      />

      <div className="inv-kpis">
        <KpiCard label="Total items" value={metrics?.totalProducts ?? '—'} icon={Package} loading={loading && !metrics} onClick={() => onNavigate('stock')} />
        <KpiCard label="Low stock" value={metrics?.lowStockProducts ?? '—'} icon={AlertTriangle} tone="warn" loading={loading && !metrics} onClick={() => onNavigate('stock', null, { status: 'LOW_STOCK' })} />
        <KpiCard label="Out of stock" value={metrics?.outOfStockProducts ?? '—'} icon={XCircle} tone="bad" loading={loading && !metrics} onClick={() => onNavigate('stock', null, { status: 'OUT_OF_STOCK' })} />
        {perms.request ? (
          <KpiCard label="Awaiting approval" value={loading ? '—' : plus(pendingPRs)} icon={ClipboardCheck} tone={pendingPRs.length ? 'warn' : 'ok'} loading={loading} onClick={() => onNavigate('purchasing', 'approvals')} />
        ) : null}
      </div>

      {errors.length ? (
        <Alert tone="warn" title="Some sections could not be loaded" onRetry={load}>
          {errors.join(' · ')}
        </Alert>
      ) : null}

      <div className="inv-two-col">
        <Card title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>Needs attention {!loading && attentionCount > 0 ? <span className="inv-count warn">{attentionCount}{attentionCount >= PAGE * 2 ? '+' : ''}</span> : null}</span>}>
          {loading ? (
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[70, 55, 65, 50].map((w, i) => <span key={i} className="inv-skel" style={{ width: `${w}%` }} />)}
            </div>
          ) : attentionCount === 0 ? (
            <EmptyState icon={PackageCheck} title="Nothing needs attention" text="Stock levels are healthy and no requests, orders or bills are waiting." />
          ) : (
            <>
              {(out.length > 0 || low.length > 0) ? (
                <>
                  <div className="inv-attn-group-head"><AlertTriangle size={12} /> Stock below minimum</div>
                  {[...out, ...low].map(p => (
                    <div className="inv-attn-row" key={p.id}>
                      <div className="inv-attn-main">
                        <div className="inv-attn-title">{p.name}</div>
                        <div className="inv-attn-sub">{formatQty(p.current_stock)} {p.unit_of_measure} on hand · minimum {formatQty(p.minimum_stock_level)}</div>
                      </div>
                      <StatusBadge label={p.stock_status === 'OUT_OF_STOCK' ? 'Out of stock' : 'Low'} tone={p.stock_status === 'OUT_OF_STOCK' ? 'bad' : 'warn'} />
                      {perms.request ? <Button size="sm" onClick={() => onNavigate('purchasing', 'requests', { create: true, productId: p.id })}>Request stock</Button> : null}
                    </div>
                  ))}
                </>
              ) : null}

              {pendingPRs.length > 0 ? (
                <>
                  <div className="inv-attn-group-head"><ClipboardCheck size={12} /> Purchase requests awaiting approval</div>
                  {pendingPRs.map(r => (
                    <div className="inv-attn-row" key={r.id}>
                      <div className="inv-attn-main">
                        <div className="inv-attn-title"><span className="mono" style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--inv-accent)' }}>{r.request_number}</span> · {r.item_count} item{r.item_count === 1 ? '' : 's'}</div>
                        <div className="inv-attn-sub">{r.requested_by_name || r.requested_by_uid} · {r.department || r.location_name_snapshot || ''} · {r.business_date}</div>
                      </div>
                      <Button size="sm" onClick={() => onNavigate('purchasing', 'approvals', { requestId: r.id })}>Review</Button>
                    </div>
                  ))}
                </>
              ) : null}

              {receivablePOs.length > 0 ? (
                <>
                  <div className="inv-attn-group-head"><PackageCheck size={12} /> Purchase orders awaiting delivery</div>
                  {receivablePOs.map(o => {
                    const st = statusOf(PO_STATUS, o.status);
                    return (
                      <div className="inv-attn-row" key={o.id}>
                        <div className="inv-attn-main">
                          <div className="inv-attn-title"><span className="mono" style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--inv-accent)' }}>{o.po_number}</span> · {o.supplier_name_snapshot}</div>
                          <div className="inv-attn-sub">{o.item_count} item{o.item_count === 1 ? '' : 's'} · {o.business_date}</div>
                        </div>
                        <StatusBadge label={st.label} tone={st.tone} />
                        <Button size="sm" onClick={() => onNavigate('receiving', 'po', { orderId: o.id })}>Receive</Button>
                      </div>
                    );
                  })}
                </>
              ) : null}

              {openBills.length > 0 ? (
                <>
                  <div className="inv-attn-group-head"><FileText size={12} /> Bills requiring review</div>
                  {openBills.map(b => {
                    const st = statusOf(BILL_STATUS, b.status);
                    return (
                      <div className="inv-attn-row" key={b.id}>
                        <div className="inv-attn-main">
                          <div className="inv-attn-title">{b.invoice_number || 'No invoice number'} <span className="muted" style={{ color: 'var(--inv-muted)', fontWeight: 400 }}>· {b.supplier_name_raw || 'supplier not identified'}</span></div>
                          <div className="inv-attn-sub">uploaded {fmtAgo(b.created_at)}</div>
                        </div>
                        <StatusBadge label={st.label} tone={st.tone} />
                        <Button size="sm" onClick={() => onNavigate('receiving', 'bill', { billId: b.id })}>Review</Button>
                      </div>
                    );
                  })}
                </>
              ) : null}
            </>
          )}
        </Card>

        <Card title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Activity size={13} /> Recent activity</span>}
          actions={<Button size="sm" variant="ghost" icon={ArrowRight} onClick={() => onNavigate('history', 'movements')}>All movements</Button>}>
          {loading ? (
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[60, 75, 50, 65, 55].map((w, i) => <span key={i} className="inv-skel" style={{ width: `${w}%` }} />)}
            </div>
          ) : activity.length === 0 ? (
            <EmptyState title="No recent stock activity" text="Receipts, adjustments and transfers will appear here as they happen." />
          ) : (
            activity.map(m => {
              const t = statusOf(MOVEMENT_TYPE, m.movement_type);
              const q = Number(m.quantity) || 0;
              return (
                <div className="inv-attn-row" key={m.id}>
                  <div className="inv-attn-main">
                    <div className="inv-attn-title">{m.product_name} <span style={{ color: q < 0 ? 'var(--inv-bad)' : 'var(--inv-ok)', fontVariantNumeric: 'tabular-nums' }}>{q > 0 ? '+' : ''}{formatQty(q)} {m.unit}</span></div>
                    <div className="inv-attn-sub">{t.label}{m.location_name ? ` · ${m.location_name}` : ''}{m.actor_name ? ` · ${m.actor_name}` : ''} · {fmtAgo(m.created_at)}</div>
                  </div>
                  <StatusBadge label={t.label} tone={t.tone} />
                </div>
              );
            })
          )}
        </Card>
      </div>

      {/* Quick paths: the three questions people ask most, one click each. */}
      <div className="inv-kpis">
        <button className="inv-workflow" onClick={() => onNavigate('stock')} style={{ padding: 12 }}>
          <div className="inv-workflow-title"><Package size={15} /> Stock</div>
          <p>Search items, see where stock is held, adjust or transfer.</p>
        </button>
        {perms.request ? (
          <button className="inv-workflow" onClick={() => onNavigate('purchasing')} style={{ padding: 12 }}>
            <div className="inv-workflow-title"><ClipboardCheck size={15} /> Purchasing</div>
            <p>Raise requests, approve them, and issue purchase orders.</p>
          </button>
        ) : null}
        {perms.receive ? (
          <button className="inv-workflow" onClick={() => onNavigate('receiving')} style={{ padding: 12 }}>
            <div className="inv-workflow-title"><PackageCheck size={15} /> Receiving</div>
            <p>Capture a supplier bill, receive against an order, or record a direct receipt.</p>
          </button>
        ) : null}
      </div>
    </div>
  );
}
