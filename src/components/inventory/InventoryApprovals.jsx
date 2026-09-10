/**
 * InventoryApprovals.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Purchasing › Approvals — the queue of purchase requests waiting for a
 * decision, with the decision made in place.
 *
 * This screen adds no rule. It calls the same three endpoints the request
 * detail always has (approval-config, approve, reject) and shows the buttons
 * under the same conditions: the request is PENDING_APPROVAL, the server says
 * this caller may approve, and the caller did not raise it. The server
 * re-checks all three on every call.
 *
 * A request is addressed by its id, so a future notification (in the app, or
 * over any channel) can land an approver on exactly this request by passing
 * `openRequestId`. Nothing here knows or cares which channel that will be.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, CheckCircle2, ThumbsDown, RefreshCw, ChevronDown, ChevronUp, ExternalLink, History } from 'lucide-react';
import { inventoryFetch, formatQty } from './inventoryApi';
import { Alert, Button, Card, EmptyState, StatusBadge, humanError, money, fmtDateTime, SubNav, PageHeader } from './ui';
import { PR_STATUS, statusOf } from './statusMaps';

const QUEUE_LIMIT = 25;

export default function InventoryApprovals({ token, currentUserUid, openRequestId, onOpenHandled, onOpenRequest }) {
  const [view, setView] = useState('pending'); // pending | decided
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [approvalCtx, setApprovalCtx] = useState({ enabled: false, caller_can_approve: false });
  const [expanded, setExpanded] = useState(null);
  const [detail, setDetail] = useState({});   // id -> full request
  const [busyId, setBusyId] = useState(null);
  const [rejectingId, setRejectingId] = useState(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    inventoryFetch('/inventory/purchase-requests/approval-config', { token })
      .then(setApprovalCtx)
      .catch(() => setApprovalCtx({ enabled: false, caller_can_approve: false }));
  }, [token]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      if (view === 'pending') {
        const d = await inventoryFetch(`/inventory/purchase-requests?status=PENDING_APPROVAL&limit=${QUEUE_LIMIT}`, { token });
        setRequests(d.requests || []);
      } else {
        const [a, r] = await Promise.all([
          inventoryFetch('/inventory/purchase-requests?status=APPROVED&limit=15', { token }),
          inventoryFetch('/inventory/purchase-requests?status=REJECTED&limit=15', { token })
        ]);
        const merged = [...(a.requests || []), ...(r.requests || [])]
          .sort((x, y) => String(y.updated_at || y.created_at || '').localeCompare(String(x.updated_at || x.created_at || '')));
        setRequests(merged);
      }
    } catch (err) {
      setError(humanError(err, 'Unable to load approvals right now. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, [token, view]);

  useEffect(() => { load(); }, [load]);

  const expand = useCallback(async (id) => {
    setExpanded(cur => (cur === id ? null : id));
    setRejectingId(null); setReason('');
    if (!detail[id]) {
      try {
        const d = await inventoryFetch(`/inventory/purchase-requests/${id}`, { token });
        setDetail(prev => ({ ...prev, [id]: d.request }));
      } catch (err) {
        setError(humanError(err));
      }
    }
  }, [token, detail]);

  // Deep link: land on the request and open it.
  useEffect(() => {
    if (!openRequestId) return;
    setView('pending');
    setExpanded(openRequestId);
    if (!detail[openRequestId]) {
      inventoryFetch(`/inventory/purchase-requests/${openRequestId}`, { token })
        .then(d => setDetail(prev => ({ ...prev, [openRequestId]: d.request })))
        .catch(() => {});
    }
    onOpenHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequestId]);

  const decide = async (id, action, body = {}) => {
    setBusyId(id); setError(''); setNotice('');
    try {
      await inventoryFetch(`/inventory/purchase-requests/${id}/${action}`, { token, method: 'POST', body });
      setNotice(action === 'approve' ? 'Request approved.' : 'Request rejected.');
      setRejectingId(null); setReason('');
      setDetail(prev => { const n = { ...prev }; delete n[id]; return n; });
      await load();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader
        icon={ClipboardCheck}
        title="Approvals"
        subtitle={approvalCtx.enabled === false
          ? 'Approvals are currently disabled in Approval Rules. Submitted requests wait until they are enabled.'
          : approvalCtx.caller_can_approve
            ? 'Requests waiting for your decision. Approving does not buy anything or change stock.'
            : 'You can view the queue. Only authorised approvers can decide.'}
        actions={<Button variant="ghost" icon={RefreshCw} onClick={load} title="Refresh" aria-label="Refresh" />}
      />

      <SubNav
        value={view}
        onChange={(v) => { setView(v); setExpanded(null); }}
        items={[
          { key: 'pending', label: 'Awaiting decision', icon: ClipboardCheck, count: view === 'pending' && !loading ? requests.length : undefined, countTone: 'warn' },
          { key: 'decided', label: 'Recently decided', icon: History }
        ]}
      />

      {error ? <Alert tone="error" onRetry={load} onDismiss={() => setError('')}>{error}</Alert> : null}
      {notice ? <Alert tone="ok" onDismiss={() => setNotice('')}>{notice}</Alert> : null}

      <Card>
        {loading ? (
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[70, 60, 65].map((w, i) => <span key={i} className="inv-skel" style={{ width: `${w}%` }} />)}
          </div>
        ) : requests.length === 0 ? (
          view === 'pending'
            ? <EmptyState icon={CheckCircle2} title="No requests are waiting" text="Every submitted purchase request has been decided." />
            : <EmptyState title="No recent decisions" text="Approved and rejected requests will be listed here." />
        ) : requests.map(r => {
          const st = statusOf(PR_STATUS, r.status);
          const isOpen = expanded === r.id;
          const full = detail[r.id];
          const isOwner = r.requested_by_uid && currentUserUid && String(r.requested_by_uid) === String(currentUserUid);
          const canDecide = r.status === 'PENDING_APPROVAL' && approvalCtx.caller_can_approve && !isOwner;
          const busy = busyId === r.id;
          return (
            <div key={r.id} style={{ borderBottom: '1px solid var(--inv-line)' }}>
              <div className="inv-attn-row" style={{ cursor: 'pointer', borderBottom: 'none' }} onClick={() => expand(r.id)}>
                {isOpen ? <ChevronUp size={14} color="var(--inv-muted)" /> : <ChevronDown size={14} color="var(--inv-muted)" />}
                <div className="inv-attn-main">
                  <div className="inv-attn-title">
                    <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--inv-accent)' }}>{r.request_number || 'DRAFT'}</span>
                    {' · '}{r.requested_by_name || r.requested_by_uid}
                    <span style={{ color: 'var(--inv-muted)', fontWeight: 400 }}> · {r.department || r.location_name_snapshot || ''}</span>
                  </div>
                  <div className="inv-attn-sub">{r.item_count} item{r.item_count === 1 ? '' : 's'} · {money(r.total_estimated_value)} · {r.business_date}{r.priority && r.priority !== 'NORMAL' ? ` · ${r.priority}` : ''}</div>
                </div>
                <StatusBadge label={st.label} tone={st.tone} />
                {canDecide ? (
                  <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                    <Button size="sm" icon={ThumbsDown} disabled={busy} onClick={() => { setExpanded(r.id); setRejectingId(r.id); setReason(''); }}>Reject</Button>
                    <Button size="sm" variant="primary" icon={CheckCircle2} disabled={busy} onClick={() => decide(r.id, 'approve', {})}>{busy ? 'Working…' : 'Approve'}</Button>
                  </div>
                ) : null}
              </div>

              {isOpen ? (
                <div style={{ padding: '4px 14px 14px 40px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {!full ? (
                    <span className="inv-skel" style={{ width: '50%' }} />
                  ) : (
                    <>
                      <div className="inv-kv">
                        <div><span>Requester</span><strong style={{ fontSize: '0.85rem' }}>{full.requested_by_name || full.requested_by_uid}</strong></div>
                        <div><span>Location</span><strong style={{ fontSize: '0.85rem' }}>{full.location_name_snapshot || full.location_id}</strong></div>
                        <div><span>Estimated</span><strong>{money(full.total_estimated_value)}</strong></div>
                        <div><span>Submitted</span><strong style={{ fontSize: '0.85rem' }}>{fmtDateTime((full.status_history || []).find(h => h.status === 'PENDING_APPROVAL')?.at || full.updated_at)}</strong></div>
                      </div>
                      <div className="inv-card">
                        <table className="inv-table">
                          <thead><tr><th>Item</th><th className="num">Qty</th><th>Unit</th><th className="num">Stock now</th><th className="num">Est. total</th></tr></thead>
                          <tbody>
                            {(full.items || []).map(it => (
                              <tr key={it.id}>
                                <td><span className="strong">{it.product_name_snapshot}</span><span className="inv-cell-sub">{it.sku}</span></td>
                                <td className="num strong">{formatQty(it.requested_quantity)}</td>
                                <td className="muted">{it.unit}</td>
                                <td className="num muted">{formatQty(it.current_stock_snapshot)} <span style={{ fontSize: '0.7rem' }}>(min {formatQty(it.minimum_stock_snapshot)})</span></td>
                                <td className="num">{money(it.estimated_total)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {(full.reason || full.remarks) ? (
                        <div style={{ fontSize: '0.82rem', display: 'grid', gap: 4 }}>
                          {full.reason ? <div><span className="inv-hint" style={{ marginRight: 6 }}>Reason</span>{full.reason}</div> : null}
                          {full.remarks ? <div><span className="inv-hint" style={{ marginRight: 6 }}>Remarks</span>{full.remarks}</div> : null}
                        </div>
                      ) : null}
                      {(full.approvals || []).length > 0 ? (
                        <div style={{ fontSize: '0.8rem', color: 'var(--inv-muted)' }}>
                          {full.approvals.map(a => (
                            <div key={a.approval_id}>{a.action === 'APPROVED' ? 'Approved' : 'Rejected'} by {a.approver_name || a.approver_uid} · {fmtDateTime(a.created_at)}{a.comment ? ` · ${a.comment}` : ''}</div>
                          ))}
                        </div>
                      ) : null}
                      {r.status === 'PENDING_APPROVAL' && isOwner ? (
                        <div className="inv-hint">You raised this request, so you cannot decide it yourself.</div>
                      ) : null}
                      {r.status === 'PENDING_APPROVAL' && !isOwner && !approvalCtx.caller_can_approve ? (
                        <div className="inv-hint">Awaiting a decision from an authorised approver.</div>
                      ) : null}
                      {rejectingId === r.id && canDecide ? (
                        <div className="inv-card" style={{ padding: 12, borderColor: 'rgba(248,113,113,0.4)' }}>
                          <label className="inv-hint" style={{ display: 'block', marginBottom: 4 }}>Rejection reason (recorded permanently on the request) *</label>
                          <input className="inv-input" autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Budget not available this month" />
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                            <Button size="sm" onClick={() => { setRejectingId(null); setReason(''); }}>Cancel</Button>
                            <Button size="sm" variant="danger" icon={ThumbsDown} disabled={busy || reason.trim().length < 3} onClick={() => decide(r.id, 'reject', { reason: reason.trim() })}>
                              {busy ? 'Rejecting…' : 'Confirm rejection'}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {onOpenRequest ? (
                        <div><Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => onOpenRequest(r.id)}>Open full request</Button></div>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
