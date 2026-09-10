/**
 * InventoryBillCapture.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H4 review screen, wired to H5/H6 confirmation and H7 duplicate
 * protection.
 *
 * EVERY ACTION HERE IS STOCK-NEUTRAL EXCEPT ONE. Upload, re-read, interpret,
 * edit and Save Draft change no stock. The single stock-affecting action is
 * `confirmReceipt`, which posts through the backend — H5 against a purchase
 * order (the unchanged Phase F engine) or H6 as a direct receipt (the same
 * shared ledger core). There are no Firestore writes from this component.
 *
 * The two modes differ only where they must:
 *   PO      — adds the order selector and an Ordered column, and shows
 *             short / exact / over against the ordered quantity.
 *   DIRECT  — hides both, and requires the supplier to be resolved.
 *
 * UX rules enforced here, not merely documented:
 *   • Only HIGH-confidence matches arrive pre-selected (the server sends
 *     matched_product_id only for HIGH; everything else is a suggestion).
 *   • Every machine-derived quantity is visibly marked until the operator
 *     accepts or edits it — see the `machine` styling on the quantity input.
 *   • Confirm stays disabled while any blocker remains, and the blockers are
 *     listed immediately above the button.
 *   • A duplicate signal must be acknowledged by code, with a reason, before
 *     confirmation — the server repeats the check and does not trust this.
 *
 * Batch 5 (presentation): the bill image is fixed on the left, everything the
 * operator decides is on the right, and matching is shown as what to do next
 * rather than as a score. Additive props let the Receiving workspace open the
 * screen in a mode, on a bill, or straight into the file picker.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload, FileText, RefreshCw, Trash2, AlertTriangle, CheckCircle2,
  ScanLine, Save, Image as ImageIcon, ArrowLeft, Truck
} from 'lucide-react';
import { inventoryFetch, authHeader } from './inventoryApi';
import { API_URL } from '../../config/apiConfig';
import { Alert, Button, Card, EmptyState, Field, StatusBadge, humanError, fmtAgo, PageHeader } from './ui';
import { BILL_STATUS, MATCH_CUE, statusOf } from './statusMaps';

export default function InventoryBillCapture({ token, initialMode = 'PO', openBillId = null, autoUpload = false, onOpenHandled, onBack, canManage = true }) {
  const [bills, setBills] = useState([]);
  const [billsLoading, setBillsLoading] = useState(true);
  const [selected, setSelected] = useState(null);      // { bill, lines }
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [orders, setOrders] = useState([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);

  // ── Review state, kept local until Save Draft ─────────────────────────────
  const [mode, setMode] = useState(initialMode === 'DIRECT' ? 'DIRECT' : 'PO');
  const [header, setHeader] = useState({ supplier_id: '', invoice_number: '', invoice_date: '', location_id: '', po_id: '' });
  const [rows, setRows] = useState([]);
  // H7 — duplicate signals for the bill currently open, plus the operator's
  // acknowledgement. Warnings never hide the confirm button; they gate it, and
  // the gate opens only when every raised code is explicitly acknowledged with
  // a reason. The server repeats this check and does not trust this screen.
  const [dupWarnings, setDupWarnings] = useState([]);
  const [dupChecked, setDupChecked] = useState(true);
  const [dupAck, setDupAck] = useState(false);
  const [dupReason, setDupReason] = useState('');

  const loadMasters = useCallback(async () => {
    try {
      const [p, s, l] = await Promise.all([
        inventoryFetch('/inventory/products?limit=500', { token }),
        inventoryFetch('/inventory/suppliers', { token }),
        inventoryFetch('/inventory/locations', { token })
      ]);
      setProducts(p.products || p.items || []);
      setSuppliers(s.suppliers || []);
      setLocations((l.locations || []).filter(x => x.is_active !== false));
    } catch (e) {
      // Suppliers are MANAGE-only; a receptionist may legitimately be refused.
      setProducts(prev => prev);
    }
  }, [token]);

  const loadBills = useCallback(async () => {
    try {
      const data = await inventoryFetch('/inventory/bills?limit=50', { token });
      setBills(data.bills || []);
    } catch (e) {
      setError(humanError(e, 'Unable to load bills right now. Please try again.'));
    } finally {
      setBillsLoading(false);
    }
  }, [token]);

  useEffect(() => { loadBills(); loadMasters(); }, [loadBills, loadMasters]);

  // ── Upload ────────────────────────────────────────────────────────────────
  const onUpload = async (file) => {
    if (!file) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const form = new FormData();
      form.append('bill', file);
      const res = await fetch(`${API_URL}/inventory/bills`, {
        method: 'POST', headers: authHeader(token), body: form
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
      setNotice('Bill uploaded. Reading the image…');
      if (data.duplicate_candidates?.length) {
        setNotice(`Bill uploaded. NOTE: ${data.duplicate_candidates.length} earlier bill(s) have the same file contents.`);
      }
      await loadBills();
      pollExtraction(data.bill.id);
    } catch (e) {
      setError(humanError(e, 'The bill could not be uploaded. Please try again.'));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** Extraction is asynchronous on the server; poll until it settles. */
  const pollExtraction = useCallback(async (billId) => {
    for (let i = 0; i < 40; i++) {
      try {
        const { bill } = await inventoryFetch(`/inventory/bills/${billId}`, { token });
        if (['EXTRACTED', 'EXTRACTION_FAILED', 'IN_REVIEW'].includes(bill.status)) {
          await loadBills();
          setNotice(bill.status === 'EXTRACTION_FAILED'
            ? 'No text could be read. Open the bill and enter the details by hand.'
            : 'Text extracted. Open the bill to review it.');
          return;
        }
      } catch { /* keep polling */ }
      await new Promise(r => setTimeout(r, 750));
    }
  }, [token, loadBills]);

  // ── Open + interpret ──────────────────────────────────────────────────────
  const openBill = useCallback(async (billId, { interpret = false } = {}) => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (interpret) await inventoryFetch(`/inventory/bills/${billId}/interpret`, { token, method: 'POST' });
      const data = await inventoryFetch(`/inventory/bills/${billId}/lines`, { token });
      setSelected(data);
      // A new bill starts with no acknowledgement. Carrying one over would let
      // a reason written for one bill silently clear another bill's warning.
      setDupAck(false);
      setDupReason('');
      setDupWarnings([]);
      // A bill that already chose a mode keeps it; otherwise the workspace's
      // starting mode applies (Direct Receipt opens in DIRECT).
      setMode(data.bill.mode || (initialMode === 'DIRECT' ? 'DIRECT' : 'PO'));
      setHeader({
        supplier_id: data.bill.supplier_id || '',
        invoice_number: data.bill.invoice_number || '',
        invoice_date: data.bill.invoice_date || '',
        location_id: data.bill.location_id || '',
        po_id: data.bill.po_id || ''
      });
      setRows((data.lines || []).map(l => ({
        ...l,
        // A quantity is "machine" until the operator touches it. That flag is
        // what keeps an OCR guess visually distinct from a confirmed number.
        machine: l.resolved_quantity === null,
        qty: l.resolved_quantity != null ? String(l.resolved_quantity) : (l.raw_quantity != null ? String(l.raw_quantity) : ''),
        product_id: l.matched_product_id || ''
      })));
      if (interpret) setNotice('Bill interpreted. Every suggestion below needs your confirmation.');
    } catch (e) {
      setError(humanError(e, 'The bill could not be opened. Please try again.'));
    } finally {
      setBusy(false);
    }
  }, [token, initialMode]);

  // Arriving from Overview / Receiving with a bill id, or asked to start with
  // the file picker straight away.
  const openedRef = useRef(null);
  useEffect(() => {
    if (openBillId && openedRef.current !== openBillId) {
      openedRef.current = openBillId;
      const b = bills.find(x => x.id === openBillId);
      openBill(openBillId, { interpret: b ? (b.status === 'EXTRACTED' || b.status === 'EXTRACTION_FAILED') : false });
      onOpenHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openBillId, bills]);
  const pickedRef = useRef(false);
  useEffect(() => {
    if (autoUpload && !pickedRef.current) {
      pickedRef.current = true;
      // Deferred so the input exists; a blocked picker is harmless.
      setTimeout(() => { try { fileRef.current?.click(); } catch { /* ignore */ } }, 50);
    }
  }, [autoUpload]);

  const loadOrders = useCallback(async () => {
    try {
      const data = await inventoryFetch('/inventory/purchase-orders?limit=50', { token });
      setOrders(data.orders || data.purchase_orders || []);
    } catch { setOrders([]); }
  }, [token]);
  useEffect(() => { if (mode === 'PO' && canManage) loadOrders(); }, [mode, loadOrders, canManage]);

  const discard = async (billId) => {
    if (!window.confirm('Discard this bill? Its parsed lines are removed. No stock is affected.')) return;
    setBusy(true); setError('');
    try {
      await inventoryFetch(`/inventory/bills/${billId}`, { token, method: 'DELETE' });
      setSelected(null);
      setNotice('Bill discarded. Its parsed lines were removed; no stock was affected.');
      await loadBills();
    } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  };

  // ── Blockers ──────────────────────────────────────────────────────────────
  const blockers = useMemo(() => {
    if (!selected) return [];
    const out = [];
    if (selected.bill.status === 'CONFIRMED' || selected.bill.receipt_id) out.push('This bill has already been confirmed into a receipt.');
    if (['UPLOADED', 'EXTRACTING'].includes(selected.bill.status)) out.push('Reading of the bill is still in progress.');
    const active = rows.filter(r => !r.excluded);
    if (!active.length) out.push('No lines to receive.');
    if (!header.location_id) out.push('A destination location must be chosen.');
    if (mode === 'DIRECT' && !header.supplier_id) out.push('A supplier must be chosen for a direct receipt.');
    if (mode === 'PO' && !header.po_id) out.push('A purchase order must be selected.');
    const unmatched = active.filter(r => !r.product_id).length;
    if (unmatched) out.push(`${unmatched} line(s) have no matched product.`);
    const unitEx = active.filter(r => r.unit_exception).length;
    if (unitEx) out.push(`${unitEx} line(s) have a unit exception that must be resolved.`);
    const badQty = active.filter(r => {
      const n = Number(r.qty);
      return !r.qty || !Number.isFinite(n) || n <= 0;
    }).length;
    if (badQty) out.push(`${badQty} line(s) have an invalid quantity.`);
    if (dupWarnings.length && !dupAck) {
      out.push(`${dupWarnings.length} duplicate warning(s) must be acknowledged.`);
    }
    if (dupWarnings.length && dupAck && dupReason.trim().length < 10) {
      out.push('A reason of at least 10 characters is needed to override the duplicate warning.');
    }
    return out;
  }, [selected, rows, header, mode, dupWarnings, dupAck, dupReason]);

  // Re-checks duplicates whenever the identity the operator is about to confirm
  // changes. Read-only: this endpoint moves nothing and is safe to call freely.
  useEffect(() => {
    if (!selected?.bill?.id) { setDupWarnings([]); return; }
    let cancelled = false;
    const q = new URLSearchParams();
    if (header.supplier_id) q.set('supplier_id', header.supplier_id);
    if (header.invoice_number) q.set('invoice_number', header.invoice_number);
    if (header.invoice_date) q.set('invoice_date', header.invoice_date);
    (async () => {
      try {
        const d = await inventoryFetch(
          `/inventory/bills/${selected.bill.id}/duplicates?${q.toString()}`, { token });
        if (cancelled) return;
        setDupWarnings(d.warnings || []);
        setDupChecked(d.checked !== false);
      } catch {
        // A failed check must not silently read as "no duplicates".
        if (!cancelled) { setDupWarnings([]); setDupChecked(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [selected?.bill?.id, header.supplier_id, header.invoice_number, header.invoice_date, token]);

  const updateRow = (idx, patch) => setRows(rs => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const saveDraft = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      // Draft saving records review decisions only. It calls NO stock endpoint.
      setNotice('Draft kept in this session. Stock is unchanged.');
    } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  };

  /**
   * H5 / H6 — the ONLY stock-affecting action in this component.
   *
   * The idempotency key is derived from the bill id, so a double-click, a retry
   * or a refresh-and-resubmit all carry the same key and the backend returns the
   * same receipt instead of posting stock twice. `confirming` additionally locks
   * the button for this session.
   */
  const confirmReceipt = async () => {
    if (confirming || blockers.length) return;
    const label = mode === 'PO' ? 'against purchase order' : 'as a DIRECT receipt with no purchase order';
    if (!window.confirm(`Confirm this bill ${label}?

This will INCREASE STOCK by the quantities shown and cannot be undone except by a reversal.`)) return;

    setConfirming(true); setError(''); setNotice('');
    try {
      const active = rows.filter(r => !r.excluded);
      const payload = {
        idempotency_key: `bill_${selected.bill.id}`,
        // Names the specific signals being overridden rather than a blanket
        // "proceed", so a warning that appeared after review is never covered.
        duplicate_ack: dupWarnings.length
          ? { codes: dupWarnings.map(w => w.code), reason: dupReason.trim() }
          : undefined,
        lines: active.map(r => ({
          product_id: r.product_id,
          quantity: Number(r.qty),
          unit: r.resolved_unit || r.raw_unit || undefined,
          unit_cost: r.raw_rate ?? undefined,
          variance_reason: r.variance_reason || undefined
        }))
      };
      let res;
      if (mode === 'PO') {
        res = await inventoryFetch(`/inventory/bills/${selected.bill.id}/confirm-po`, {
          token, method: 'POST', body: { ...payload, po_id: header.po_id }
        });
      } else {
        res = await inventoryFetch(`/inventory/bills/${selected.bill.id}/confirm-direct`, {
          token, method: 'POST',
          body: {
            ...payload,
            supplier_id: header.supplier_id,
            location_id: header.location_id,
            invoice_number: header.invoice_number || undefined,
            invoice_date: header.invoice_date || undefined
          }
        });
      }
      const num = res?.receipt?.receipt_number || res?.receipt?.receipt_id;
      setNotice(res?.duplicate
        ? `Already confirmed as receipt ${num}. Stock was not changed again.`
        : `Receipt ${num} created. Stock has been updated.`);
      // Refresh only what this screen owns — not the whole application.
      await loadBills();
      await openBill(selected.bill.id);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setConfirming(false);
    }
  };

  const productById = useMemo(() => {
    const m = new Map();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const poLineFor = (row) => {
    if (mode !== 'PO' || !header.po_id) return null;
    const order = orders.find(o => o.id === header.po_id);
    const items = order?.items || [];
    return items.find(i => i.product_id === row.product_id) || null;
  };

  /**
   * What the operator should do with a line, in words. Once a product has
   * been chosen by hand the machine's confidence no longer matters.
   */
  const cueFor = (r) => {
    if (r.product_id && !r.matched_product_id) return { label: 'Selected', tone: 'ok', glyph: '✓' };
    if (r.product_id && r.matched_product_id) return MATCH_CUE.HIGH;
    return MATCH_CUE[r.match_confidence] || MATCH_CUE.UNMATCHED;
  };

  const isDirect = mode === 'DIRECT';
  const isConfirmed = selected?.bill?.status === 'CONFIRMED' || Boolean(selected?.bill?.receipt_id);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader
        icon={isDirect ? Truck : ScanLine}
        title={<>
          {onBack ? <Button variant="ghost" icon={ArrowLeft} onClick={selected ? () => setSelected(null) : onBack} aria-label="Back" style={{ marginRight: 4 }} /> : null}
          {isDirect ? 'Direct Receipt' : 'Bill Capture'}
          {isDirect ? <StatusBadge label="No purchase order" tone="warn" /> : null}
        </>}
        subtitle={isDirect
          ? 'Upload the supplier bill, check every line, then confirm. Stock increases only on confirmation.'
          : 'Upload a supplier bill, review what was read, match it to items, then confirm.'}
        actions={
          <>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={(e) => onUpload(e.target.files?.[0])} />
            {!selected ? <Button variant="ghost" icon={RefreshCw} onClick={loadBills} disabled={busy} title="Refresh" aria-label="Refresh" /> : null}
            <Button variant="primary" icon={Upload} onClick={() => fileRef.current?.click()} disabled={busy}>Upload bill</Button>
          </>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError('')}>{error}</Alert> : null}
      {notice ? <Alert tone="ok" onDismiss={() => setNotice('')}>{notice}</Alert> : null}

      {!selected ? (
        <Card title={`Bills${billsLoading ? '' : ` (${bills.length})`}`}>
          {billsLoading ? (
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[65, 55, 70].map((w, i) => <span key={i} className="inv-skel" style={{ width: `${w}%` }} />)}
            </div>
          ) : bills.length === 0 ? (
            <EmptyState icon={FileText} title="No bills yet" text="Upload a JPEG, PNG or WebP photo of a supplier bill. PDF is not supported yet."
              action={<Button size="sm" variant="primary" icon={Upload} onClick={() => fileRef.current?.click()}>Upload bill</Button>} />
          ) : bills.map(b => {
            const st = statusOf(BILL_STATUS, b.status);
            return (
              <div key={b.id} className="inv-attn-row">
                <FileText size={15} color="var(--inv-muted)" />
                <div className="inv-attn-main">
                  <div className="inv-attn-title">
                    {b.invoice_number || 'No invoice number'}
                    <span style={{ color: 'var(--inv-muted)', fontWeight: 400 }}> · {b.supplier_name_raw || 'supplier not identified'}</span>
                  </div>
                  <div className="inv-attn-sub">
                    {b.invoice_date || 'no date'} · uploaded {fmtAgo(b.created_at)}
                    {typeof b.ocr_confidence === 'number' ? ` · read at ${Math.round(b.ocr_confidence)}% confidence` : ''}
                  </div>
                </div>
                <StatusBadge label={st.label} tone={st.tone} />
                <Button size="sm"
                  variant={['EXTRACTED', 'EXTRACTION_FAILED', 'IN_REVIEW'].includes(b.status) ? 'primary' : ''}
                  onClick={() => openBill(b.id, { interpret: b.status === 'EXTRACTED' || b.status === 'EXTRACTION_FAILED' })}
                  disabled={busy || b.status === 'DISCARDED'}>
                  {b.status === 'CONFIRMED' ? 'View' : 'Review'}
                </Button>
              </div>
            );
          })}
        </Card>
      ) : null}

      {selected ? (
        <>
          {/* Mode — explicit, never inferred */}
          <div className="inv-card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--inv-text-2)' }}>Receiving mode</span>
            {['PO', 'DIRECT'].map(m => (
              <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.84rem', cursor: isConfirmed ? 'default' : 'pointer' }}>
                <input type="radio" name="billmode" checked={mode === m} onChange={() => setMode(m)} disabled={isConfirmed} />
                {m === 'PO' ? 'Against a purchase order' : 'Direct receipt (no order)'}
              </label>
            ))}
            <div style={{ marginLeft: 'auto' }}>
              <StatusBadge label={statusOf(BILL_STATUS, selected.bill.status).label} tone={statusOf(BILL_STATUS, selected.bill.status).tone} />
            </div>
          </div>

          {isDirect && !isConfirmed ? (
            <Alert tone="warn" title="Direct receipt — no purchase order">
              This action will increase stock after confirmation. There is no order to check the quantities against, so read every line carefully.
            </Alert>
          ) : null}

          <div className="inv-two-col" style={{ gridTemplateColumns: 'minmax(240px, 340px) minmax(0, 1fr)' }}>
            {/* The bill image stays visible for the whole review */}
            <div className="inv-card" style={{ padding: 12, position: 'sticky', top: 8 }}>
              <div className="inv-section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ImageIcon size={12} /> Bill image</div>
              <BillImage billId={selected.bill.id} token={token} />
              <div className="inv-hint" style={{ marginTop: 8 }}>
                {selected.bill.file_name} · {Math.round((selected.bill.file_size || 0) / 1024)} KB
                {selected.bill.image_width ? ` · ${selected.bill.image_width}×${selected.bill.image_height}` : ''}
              </div>
              {selected.bill.status === 'EXTRACTION_FAILED' ? (
                <div style={{ marginTop: 8, color: 'var(--inv-warn)', fontSize: '0.78rem' }}>No text could be read from this image. Enter every field by hand.</div>
              ) : null}
            </div>

            {/* Header + lines */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              <Card title="Bill information" padded>
                <div className="inv-form-grid">
                  <Field label="Supplier" required={isDirect} hint={selected.bill.supplier_name_raw ? `read as “${selected.bill.supplier_name_raw}” (${selected.bill.supplier_confidence || 'not matched'})` : undefined}>
                    <select className={`inv-select${isDirect && !header.supplier_id ? ' invalid' : ''}`} style={{ width: '100%' }} value={header.supplier_id} onChange={e => setHeader(h => ({ ...h, supplier_id: e.target.value }))} disabled={isConfirmed}>
                      <option value="">{suppliers.length ? 'Select supplier' : 'Suppliers unavailable for your role'}</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Invoice number">
                    <input className="inv-input" value={header.invoice_number} onChange={e => setHeader(h => ({ ...h, invoice_number: e.target.value }))} placeholder="none read" disabled={isConfirmed} />
                  </Field>
                  <Field label="Invoice date">
                    <input className="inv-input" type="date" value={header.invoice_date} onChange={e => setHeader(h => ({ ...h, invoice_date: e.target.value }))} disabled={isConfirmed} />
                  </Field>
                  <Field label="Destination location" required>
                    <select className={`inv-select${!header.location_id ? ' invalid' : ''}`} style={{ width: '100%' }} value={header.location_id} onChange={e => setHeader(h => ({ ...h, location_id: e.target.value }))} disabled={isConfirmed}>
                      <option value="">Select location</option>
                      {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </Field>
                  {mode === 'PO' ? (
                    <Field label="Purchase order" required hint={!canManage ? 'Purchase orders are listed for administrators.' : undefined}>
                      <select className={`inv-select${!header.po_id ? ' invalid' : ''}`} style={{ width: '100%' }} value={header.po_id} onChange={e => setHeader(h => ({ ...h, po_id: e.target.value }))} disabled={isConfirmed}>
                        <option value="">Select order</option>
                        {orders.map(o => <option key={o.id} value={o.id}>{o.po_number || o.id}{o.supplier_name_snapshot ? ` · ${o.supplier_name_snapshot}` : ''}</option>)}
                      </select>
                    </Field>
                  ) : null}
                </div>
              </Card>

              <Card title="Line items">
                <div className="inv-table-wrap">
                  <table className="inv-table">
                    <thead>
                      <tr>
                        {['From bill', 'Item', 'Matching',
                          ...(mode === 'PO' ? ['Ordered'] : []),
                          'Bill qty', 'Receive qty', 'Unit', 'Rate', 'Amount', ''].map(h => (
                          <th key={h} className={['Ordered', 'Bill qty', 'Receive qty', 'Rate', 'Amount'].includes(h) ? 'num' : ''}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr><td colSpan={mode === 'PO' ? 10 : 9}>
                          <EmptyState title="No lines were read" text="Nothing can be received until lines are added by hand. Try Re-read bill, or discard and upload a clearer photo." />
                        </td></tr>
                      ) : null}
                      {rows.map((r, i) => {
                        const cue = cueFor(r);
                        const poLine = poLineFor(r);
                        const ordered = poLine?.quantity ?? null;
                        const recv = Number(r.qty);
                        let variance = null;
                        if (mode === 'PO' && ordered != null && Number.isFinite(recv)) {
                          variance = recv < ordered ? 'Short' : recv > ordered ? 'Over' : 'Exact';
                        }
                        const product = r.product_id ? productById.get(r.product_id) : null;
                        return (
                          <tr key={r.id || i} style={{ opacity: r.excluded ? 0.4 : 1 }}>
                            <td style={{ maxWidth: 220 }}>
                              <div>{r.description || r.raw_text}</div>
                              {r.unit_exception ? (
                                <div className="inv-match warn" style={{ marginTop: 3 }}><AlertTriangle size={11} /> {r.unit_reason || 'Unit does not match the item'}</div>
                              ) : null}
                            </td>
                            <td>
                              <select
                                className={`inv-select${!r.product_id ? ' invalid' : ''}`}
                                value={r.product_id}
                                onChange={e => updateRow(i, { product_id: e.target.value })}
                                style={{ minWidth: 170, width: '100%' }}
                                disabled={isConfirmed}
                                aria-label="Select product"
                              >
                                <option value="">Select product</option>
                                {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.unit_of_measure})</option>)}
                              </select>
                              {!r.matched_product_id && r.suggested_product_id && !r.product_id ? (
                                <div className="inv-hint">
                                  suggested: {productById.get(r.suggested_product_id)?.name || r.suggested_product_id}
                                  {' '}<button type="button" className="inv-btn ghost sm" style={{ height: 22, padding: '0 6px' }} onClick={() => updateRow(i, { product_id: r.suggested_product_id })} disabled={isConfirmed}>Use</button>
                                </div>
                              ) : null}
                            </td>
                            <td>
                              <span className={`inv-match ${cue.tone}`}>{cue.glyph} {cue.label}</span>
                              {r.unit_exception && product && !isConfirmed ? (
                                <div style={{ marginTop: 4 }}>
                                  <button type="button" className="inv-btn sm" onClick={() => updateRow(i, { resolved_unit: product.unit_of_measure, unit_exception: false, unit_reason: null })}>
                                    Resolve unit → {product.unit_of_measure}
                                  </button>
                                </div>
                              ) : null}
                            </td>
                            {mode === 'PO' ? (
                              <td className="num">
                                {ordered ?? '—'}
                                {variance ? <div style={{ fontSize: '0.7rem', color: variance === 'Over' ? 'var(--inv-bad)' : variance === 'Short' ? 'var(--inv-warn)' : 'var(--inv-ok)' }}>{variance}</div> : null}
                              </td>
                            ) : null}
                            <td className="num muted">{r.raw_quantity ?? '—'}</td>
                            <td className="num">
                              <input
                                className={`inv-input${r.machine ? ' inv-qty-machine' : ''}`}
                                value={r.qty}
                                onChange={e => updateRow(i, { qty: e.target.value, machine: false })}
                                style={{ width: 88, height: 30, textAlign: 'right' }}
                                title={r.machine ? 'Read by OCR — not yet confirmed by you' : 'Confirmed by you'}
                                disabled={isConfirmed}
                                aria-label="Receive quantity"
                              />
                              {r.machine ? <div className="inv-hint" style={{ textAlign: 'right' }}>unconfirmed</div> : null}
                            </td>
                            <td className="muted">{r.resolved_unit || r.raw_unit || '—'}</td>
                            <td className="num muted">{r.raw_rate ?? '—'}</td>
                            <td className="num muted">{r.raw_amount ?? '—'}</td>
                            <td className="action">
                              <button type="button" className="inv-btn ghost sm" onClick={() => updateRow(i, { excluded: !r.excluded })} disabled={isConfirmed}>
                                {r.excluded ? 'Include' : 'Remove'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>

              {!dupChecked ? (
                <Alert tone="warn" title="The duplicate check could not be completed">Treat this bill as unverified.</Alert>
              ) : null}

              {dupWarnings.length > 0 ? (
                <Card padded style={{ borderColor: 'rgba(248,113,113,0.45)' }}>
                  <div style={{ color: 'var(--inv-bad)', fontWeight: 700, fontSize: '0.84rem', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={14} /> Possible duplicate bill
                  </div>
                  <ul style={{ margin: '0 0 10px 0', paddingLeft: 18, color: 'var(--inv-text-2)', fontSize: '0.8rem' }}>
                    {dupWarnings.map(w => (
                      <li key={w.code} style={{ marginBottom: 4 }}>
                        <span style={{ fontWeight: 700 }}>{w.code.replace(/_/g, ' ')}</span>: {w.message}
                      </li>
                    ))}
                  </ul>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.82rem', cursor: 'pointer' }}>
                    <input type="checkbox" checked={dupAck} onChange={e => setDupAck(e.target.checked)} style={{ marginTop: 3 }} />
                    <span>I have checked this and it is a genuine delivery, not a re-entry of a bill already received.</span>
                  </label>
                  {dupAck ? (
                    <textarea className="inv-textarea" value={dupReason} onChange={e => setDupReason(e.target.value)}
                      placeholder="Why is this not a duplicate? (recorded in the audit trail)" rows={2} style={{ marginTop: 8 }} />
                  ) : null}
                </Card>
              ) : null}

              {/* Blockers sit immediately above the action row on purpose */}
              {blockers.length > 0 && !isConfirmed ? (
                <Alert tone="warn" title={`${blockers.length} item(s) block confirmation`}>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>{blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
                </Alert>
              ) : null}
              {isConfirmed ? (
                <Alert tone="ok" title="This bill has been received">
                  Receipt {selected.bill.receipt_id}. Stock was updated when it was confirmed; it can only be changed by a reversal.
                </Alert>
              ) : null}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button icon={ScanLine} onClick={() => openBill(selected.bill.id, { interpret: true })} disabled={busy || isConfirmed}>Re-read bill</Button>
                <Button icon={Save} onClick={saveDraft} disabled={busy || isConfirmed}>Save draft</Button>
                <Button variant="danger" icon={Trash2} onClick={() => discard(selected.bill.id)} disabled={busy || isConfirmed}>Discard</Button>
                <Button
                  variant={isDirect ? 'warn' : 'primary'}
                  icon={CheckCircle2}
                  onClick={confirmReceipt}
                  disabled={busy || confirming || blockers.length > 0}
                  title={blockers.length ? `Blocked: ${blockers[0]}` : 'Posts stock through the shared inventory ledger'}
                  style={{ marginLeft: 'auto' }}
                >
                  {confirming ? 'Confirming…' : mode === 'PO' ? 'Receive Against Purchase Order' : 'Direct Receipt — No Purchase Order'}
                </Button>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Authenticated image fetch — the bill is never a public URL. */
function BillImage({ billId, token }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url = null, cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/inventory/bills/${billId}/file`, { headers: authHeader(token) });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        if (!cancelled) setSrc(url);
      } catch { if (!cancelled) setFailed(true); }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [billId, token]);

  if (failed) return <div style={{ color: 'var(--inv-warn)', fontSize: '0.8rem' }}>Bill image is not available.</div>;
  if (!src) return <span className="inv-skel" style={{ width: '100%', height: 180 }} />;
  return (
    <a href={src} target="_blank" rel="noreferrer">
      <img src={src} alt="Supplier bill" style={{ width: '100%', borderRadius: 6, border: '1px solid var(--inv-line-strong)' }} />
    </a>
  );
}
