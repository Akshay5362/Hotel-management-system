import React, { useState, useEffect, useCallback, useRef } from 'react';
import { exportToExcel } from '../utils/exportUtils';
import { formatDateOnly } from '../utils/dateFormatter';

import { API_URL as API_BASE, getApiHeaders } from '../config/apiConfig';

async function apiCall(method, endpoint, body, token) {
  const opts = {
    method,
    headers: getApiHeaders(token, { 'Content-Type': 'application/json' }),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${endpoint}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || err.message || `HTTP ${res.status}`);
  }
  return res.json();
}


// ── Style tokens (identical to App.jsx/ReceptionPortal palette) ───────────────
const inp = {
  padding: '8px 12px',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '8px',
  color: '#fff',
  fontSize: '0.84rem',
  fontFamily: 'inherit',
  outline: 'none',
};

const TIER_COLOR = {
  Bronze: '#cd7f32',
  Silver: '#94a3b8',
  Gold: '#fbbf24',
  Platinum: '#e2e8f0',
  Blacklisted: '#f43f5e',
};

const TIER_BG = {
  Bronze: 'rgba(205,127,50,0.12)',
  Silver: 'rgba(148,163,184,0.12)',
  Gold: 'rgba(251,191,36,0.12)',
  Platinum: 'rgba(226,232,240,0.12)',
  Blacklisted: 'rgba(244,63,94,0.12)',
};

const STATUS_COLOR = {
  'Checked In':  '#f87171',
  Reserved:      '#a78bfa',
  'Checked Out': '#4ade80',
  Cancelled:     '#94a3b8',
  Refunded:      '#fb923c',
  'No Show':     '#fbbf24',
};

const VERIFY_COLOR = {
  Verified:  '#4ade80',
  Pending:   '#fbbf24',
  Rejected:  '#f87171',
  'Not Uploaded': '#94a3b8',
};

function TierBadge({ tier }) {
  if (!tier) return null;
  return (
    <span style={{
      fontSize: '0.62rem', fontWeight: 700, padding: '2px 7px', borderRadius: '4px',
      background: TIER_BG[tier] || 'rgba(148,163,184,0.12)',
      color: TIER_COLOR[tier] || '#94a3b8',
      border: `1px solid ${TIER_COLOR[tier] || '#94a3b8'}44`,
      textTransform: 'uppercase', letterSpacing: '0.3px',
    }}>
      {tier}
    </span>
  );
}

function StatusBadge({ status }) {
  const c = STATUS_COLOR[status] || '#94a3b8';
  return (
    <span style={{
      fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: '4px',
      background: `${c}18`, color: c, border: `1px solid ${c}44`,
      textTransform: 'uppercase',
    }}>
      {status}
    </span>
  );
}

function VerifyBadge({ status }) {
  const c = VERIFY_COLOR[status] || '#94a3b8';
  return (
    <span style={{
      fontSize: '0.62rem', fontWeight: 700, padding: '2px 7px', borderRadius: '4px',
      background: `${c}18`, color: c, border: `1px solid ${c}44`,
    }}>
      {status || 'Not Uploaded'}
    </span>
  );
}

// ── Mask a government ID (show last 4 chars) ──────────────────────────────────
function maskId(id) {
  if (!id) return '—';
  if (id.length <= 4) return '****';
  return '****' + id.slice(-4);
}

// ── Small UI helpers ──────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', padding: '14px 16px' }}>
      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>{title}</div>
      {children}
    </div>
  );
}

function Grid2({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px' }}>{children}</div>;
}

function Field({ label, val, span }) {
  return (
    <div style={span ? { gridColumn: '1 / -1' } : {}}>
      <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</div>
      <div style={{ fontSize: '0.82rem', color: '#e2e8f0', fontWeight: 500, wordBreak: 'break-word' }}>{val || '—'}</div>
    </div>
  );
}

function EmptyState({ icon, msg, sub }) {
  return (
    <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>{icon}</div>
      <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#64748b' }}>{msg}</div>
      {sub && <div style={{ fontSize: '0.78rem', color: '#475569', marginTop: '6px' }}>{sub}</div>}
    </div>
  );
}

// ── Drawer overlay ────────────────────────────────────────────────────────────
function GuestDrawer({ guest, token, onClose }) {
  const [tab, setTab]         = useState('profile');
  const [detail, setDetail]   = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!guest) return;
    setTab('profile');
    setDetail(null);
    setLoading(true);
    apiCall('GET', `/admin/guest-history/${guest.id}`, null, token)
      .then(d => setDetail(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [guest, token]);

  if (!guest) return null;

  const TABS = [
    { id: 'profile',  label: 'Profile'   },
    { id: 'bookings', label: 'History'   },
    { id: 'payments', label: 'Billing'   },
    { id: 'notes',    label: 'Notes'     },
  ];

  const bookings = detail?.bookings || [];
  const payments = detail?.payments || [];
  const lifetimeSpend = bookings.reduce((s, b) => s + Number(b.total_amount || 0), 0);
  const totalNights = bookings.filter(b => b.check_in_date && (b.check_out_date || b.expected_check_out_date))
    .reduce((s, b) => {
      try {
        const ci = new Date(b.check_in_date);
        const co = new Date(b.check_out_date || b.expected_check_out_date);
        const n  = Math.max(0, Math.round((co - ci) / 86400000));
        return s + n;
      } catch { return s; }
    }, 0);

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }} />

      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 1001,
        width: '560px', maxWidth: '96vw',
        background: 'linear-gradient(160deg, #0d1526 0%, #0a1020 100%)',
        borderLeft: '1px solid rgba(56,189,248,0.18)',
        display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 40px rgba(0,0,0,0.6)',
      }}>
        {/* Drawer header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '46px', height: '46px', borderRadius: '50%', background: 'linear-gradient(135deg,#38bdf8,#818cf8)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.3rem', fontWeight: 800, color: '#fff', flexShrink: 0 }}>
            {guest.full_name?.[0]?.toUpperCase() || '?'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: '1rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{guest.full_name}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              {guest.phone && <span>📞 {guest.phone}</span>}
              {guest.email && <span>✉ {guest.email}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
            <TierBadge tier={guest.loyalty_tier} />
            {guest.current_room && <span style={{ fontSize: '0.68rem', color: '#f87171', fontWeight: 600 }}>Room {guest.current_room}</span>}
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', borderRadius: '6px', width: '30px', height: '30px', cursor: 'pointer', fontSize: '1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>×</button>
        </div>

        {/* KPI strip */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          {[
            { label: 'Bookings', val: bookings.length },
            { label: 'Nights',   val: totalNights },
            { label: 'Spend',    val: `₹${Number(lifetimeSpend).toLocaleString('en-IN')}` },
            { label: 'Points',   val: guest.loyalty_points || 0 },
          ].map(k => (
            <div key={k.label} style={{ flex: 1, padding: '10px 0', textAlign: 'center', borderRight: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: '1rem', fontWeight: 800, color: '#38bdf8' }}>{k.val}</div>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{k.label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)' }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, padding: '10px 4px', background: 'none', border: 'none',
              borderBottom: `2px solid ${tab === t.id ? '#38bdf8' : 'transparent'}`,
              color: tab === t.id ? '#38bdf8' : '#64748b',
              fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
              textTransform: 'uppercase', letterSpacing: '0.4px', transition: 'color 0.15s',
            }}>{t.label}</button>
          ))}
        </div>

        {/* Tab body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
              <div style={{ width: '28px', height: '28px', border: '3px solid rgba(56,189,248,0.1)', borderTopColor: '#38bdf8', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 14px' }} />
              Loading guest profile...
            </div>
          ) : (
            <>
              {/* PROFILE TAB */}
              {tab === 'profile' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <Section title="Personal Information">
                    <Grid2>
                      <Field label="Full Name"     val={guest.full_name} />
                      <Field label="Date of Birth" val={formatDateOnly(guest.date_of_birth)} />
                      <Field label="Gender"        val={guest.gender || '—'} />
                      <Field label="Age"           val={guest.age || '—'} />
                      <Field label="Phone"         val={guest.phone || '—'} />
                      <Field label="Email"         val={guest.email || '—'} />
                      <Field label="Country"       val={guest.country || '—'} />
                      <Field label="Address"       val={guest.address || '—'} span />
                      <Field label="Pincode"       val={guest.pincode || '—'} />
                      <Field label="GST No"        val={guest.gst_no || '—'} />
                      <Field label="Arrival From"  val={guest.arrival_from || '—'} />
                      <Field label="Departure To"  val={guest.departure_to || '—'} />
                    </Grid2>
                  </Section>

                  <Section title="Government Identity">
                    <Grid2>
                      <Field label="ID Type"   val={guest.id_type || '—'} />
                      <Field label="ID Number" val={maskId(guest.government_id)} />
                      <div>
                        <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginBottom: '5px', textTransform: 'uppercase' }}>Verification Status</div>
                        <VerifyBadge status={guest.id_verification_status} />
                      </div>
                    </Grid2>
                  </Section>

                  <Section title="Loyalty Programme">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                      <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: `${TIER_COLOR[guest.loyalty_tier] || '#94a3b8'}22`, border: `2px solid ${TIER_COLOR[guest.loyalty_tier] || '#94a3b8'}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem' }}>
                        {guest.loyalty_tier === 'Platinum' ? '💎' : guest.loyalty_tier === 'Gold' ? '🥇' : guest.loyalty_tier === 'Silver' ? '🥈' : guest.loyalty_tier === 'Blacklisted' ? '🚫' : '🥉'}
                      </div>
                      <div>
                        <div style={{ fontWeight: 800, color: TIER_COLOR[guest.loyalty_tier] || '#94a3b8', fontSize: '1rem' }}>{guest.loyalty_tier || 'Bronze'} Member</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '3px' }}>{guest.loyalty_points || 0} loyalty points</div>
                      </div>
                    </div>
                  </Section>

                  <Section title="Account">
                    <Grid2>
                      <Field label="Guest Since"   val={guest.created_at ? new Date(guest.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'} />
                      <Field label="Last Activity" val={guest.updated_at ? new Date(guest.updated_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'} />
                    </Grid2>
                  </Section>
                </div>
              )}

              {/* BOOKINGS TAB */}
              {tab === 'bookings' && (
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '12px' }}>{bookings.length} booking{bookings.length !== 1 ? 's' : ''} on record</div>
                  {bookings.length === 0 ? <EmptyState icon="📭" msg="No booking history found" /> : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {bookings.map(b => (
                        <div key={b.id} style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', padding: '12px 14px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#818cf8' }}>{b.booking_number || `#${b.id}`}</div>
                              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '3px' }}>
                                Room {b.room_number} ({b.room_type}) · {b.check_in_date} → {b.check_out_date || b.expected_check_out_date || '—'}
                              </div>
                              {b.overall_rating && (
                                <div style={{ fontSize: '0.68rem', color: '#fbbf24', marginTop: '3px' }}>
                                  {'⭐'.repeat(Math.round(b.overall_rating))} {b.feedback_comments ? `· "${b.feedback_comments.slice(0, 60)}..."` : ''}
                                </div>
                              )}
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                              <StatusBadge status={b.booking_status} />
                              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff', marginTop: '5px' }}>₹{Number(b.total_amount || 0).toLocaleString('en-IN')}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* PAYMENTS TAB (BILLING) */}
              {tab === 'payments' && (
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginBottom: '20px' }}>
                    <div style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total Charges</div>
                      <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#e2e8f0' }}>₹{Number(lifetimeSpend).toLocaleString('en-IN')}</div>
                    </div>
                    <div style={{ background: 'rgba(74,222,128,0.05)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(74,222,128,0.2)' }}>
                      <div style={{ fontSize: '0.65rem', color: '#4ade80', textTransform: 'uppercase' }}>Total Paid</div>
                      <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#4ade80' }}>₹{Number(payments.reduce((s, p) => s + Number(p.amount || 0), 0)).toLocaleString('en-IN')}</div>
                    </div>
                    <div style={{ background: 'rgba(248,113,113,0.05)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(248,113,113,0.2)' }}>
                      <div style={{ fontSize: '0.65rem', color: '#f87171', textTransform: 'uppercase' }}>Pending Balance</div>
                      <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#f87171' }}>₹{Number(lifetimeSpend - payments.reduce((s, p) => s + Number(p.amount || 0), 0)).toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '12px' }}>{payments.length} payment record{payments.length !== 1 ? 's' : ''}</div>
                  {payments.length === 0 ? <EmptyState icon="💳" msg="No payment records found" /> : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {payments.map(p => {
                        const sc = STATUS_COLOR[p.payment_status] || '#94a3b8';
                        return (
                          <div key={p.id} style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '10px 13px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                            <div>
                              <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>{p.payment_method || 'Cash'} · {p.payment_type || 'advance'}</div>
                              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '2px' }}>{p.booking_number} · {p.business_date || (p.created_at || '').slice(0, 10)}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontWeight: 700, fontSize: '0.88rem' }}>₹{Number(p.amount || 0).toLocaleString('en-IN')}</div>
                              <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 6px', borderRadius: '3px', background: `${sc}18`, color: sc, border: `1px solid ${sc}44` }}>{p.payment_status}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* NOTES TAB */}
              {tab === 'notes' && (
                <EmptyState icon="📝" msg="Guest notes are not yet available" sub="Future feature: Add internal notes and preferences for this guest." />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────────
export default function AdminGuests({ token }) {
  const [guests, setGuests]             = useState([]);
  const [stats, setStats]               = useState({ total: 0, inhouse: 0, checkedout: 0, vip: 0, blacklisted: 0, new_today: 0 });
  const [pagination, setPagination]     = useState({ total: 0, page: 1, pages: 1 });
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [filter, setFilter]             = useState('all');
  const [selectedGuest, setSelectedGuest] = useState(null);
  const searchTimer                     = useRef(null);

  const FILTERS = [
    { id: 'all',         label: 'All Guests'     },
    { id: 'inhouse',     label: '🏨 In House'    },
    { id: 'reserved',    label: '📅 Reserved'    },
    { id: 'checkedout',  label: '✅ Checked Out'  },
    { id: 'vip',         label: '⭐ VIP (Gold+)' },
    { id: 'blacklisted', label: '🚫 Blacklisted'  },
  ];

  const fetchGuests = useCallback(async (page, q, f) => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '25', filter: f });
      if (q && q.trim().length >= 2) params.set('q', q.trim());
      const data = await apiCall('GET', `/admin/guests?${params}`, null, token);
      setGuests(data.guests || []);
      if (data.stats) setStats(data.stats);
      setPagination(data.pagination || { total: 0, page: 1, pages: 1 });
    } catch (e) {
      console.error('AdminGuests fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchGuests(1, '', 'all'); }, [fetchGuests]);

  const handleSearch = (val) => {
    setSearch(val);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchGuests(1, val, filter), 400);
  };

  const handleFilter = (f) => {
    setFilter(f);
    fetchGuests(1, search, f);
  };

  const handlePage = (p) => fetchGuests(p, search, filter);

  const handleExport = () => {
    const headers = ['Name', 'Phone', 'Email', 'Tier', 'Total Bookings', 'Lifetime Spend (INR)', 'ID Status', 'Current Room'];
    const rows = guests.map(g => [
      g.full_name, g.phone || '', g.email || '', g.loyalty_tier || 'Bronze',
      g.total_bookings, Number(g.lifetime_spend || 0),
      g.id_verification_status || 'Not Uploaded',
      g.current_room || '',
    ]);
    exportToExcel('Guest_List', headers, rows, filter);
  };

  const handleExportCSV = () => {
    const headers = ['Name', 'Phone', 'Email', 'Tier', 'Total Bookings', 'Lifetime Spend (INR)', 'ID Status', 'Current Room'];
    const csvRows = guests.map(g => [
      `"${(g.full_name || '').replace(/"/g, '""')}"`,
      `"${(g.phone || '').replace(/"/g, '""')}"`,
      `"${(g.email || '').replace(/"/g, '""')}"`,
      `"${(g.loyalty_tier || 'Bronze').replace(/"/g, '""')}"`,
      g.total_bookings,
      Number(g.lifetime_spend || 0),
      `"${(g.id_verification_status || 'Not Uploaded').replace(/"/g, '""')}"`,
      `"${(g.current_room || '').replace(/"/g, '""')}"`
    ].join(','));
    
    const csvString = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csvString], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Guests_Export_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  };

  const handlePrint = () => {
    window.print();
  };

  const paginBtn = {
    padding: '4px 10px', borderRadius: '5px', border: '1px solid rgba(255,255,255,0.08)',
    background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
    fontSize: '0.72rem', fontWeight: 600, fontFamily: 'inherit', transition: 'all 0.15s',
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header & KPIs */}
      <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
              👥 Guests Dashboard
            </h2>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '3px 0 0' }}>
              Manage profiles, history, and billing records for all guests
            </p>
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button onClick={handlePrint} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '7px', padding: '7px 14px', fontSize: '0.76rem', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}>
              🖨️ Print
            </button>
            <button onClick={handleExportCSV} style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.25)', color: '#38bdf8', borderRadius: '7px', padding: '7px 14px', fontSize: '0.76rem', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}>
              📄 CSV
            </button>
            <button onClick={handleExport} style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.25)', color: '#4ade80', borderRadius: '7px', padding: '7px 14px', fontSize: '0.76rem', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}>
              📥 Excel
            </button>
          </div>
        </div>

        {/* KPI Strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px', marginTop: '20px' }}>
          {[
            { l: 'Total Guests', v: stats.total, c: '#38bdf8' },
            { l: 'In House', v: stats.inhouse, c: '#f87171' },
            { l: 'Checked Out', v: stats.checkedout, c: '#4ade80' },
            { l: 'VIP Guests', v: stats.vip, c: '#fbbf24' },
            { l: 'Blacklisted', v: stats.blacklisted, c: '#94a3b8' },
            { l: 'New Today', v: stats.new_today, c: '#a78bfa' },
          ].map(k => (
            <div key={k.l} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', padding: '12px', textAlign: 'center' }}>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: k.c }}>{k.v || 0}</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: '4px' }}>{k.l}</div>
            </div>
          ))}
        </div>

        {/* Search + Filters */}
        <div style={{ marginTop: '14px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Search by name, phone, email, ID number..."
            value={search}
            onChange={e => handleSearch(e.target.value)}
            style={{ ...inp, flex: '1', minWidth: '220px' }}
          />
          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
            {FILTERS.map(f => (
              <button key={f.id} onClick={() => handleFilter(f.id)} style={{
                padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, fontFamily: 'inherit', border: '1px solid',
                borderColor: filter === f.id ? '#38bdf8' : 'rgba(255,255,255,0.09)',
                background: filter === f.id ? 'rgba(56,189,248,0.1)' : 'transparent',
                color: filter === f.id ? '#38bdf8' : 'var(--text-muted)', transition: 'all 0.15s',
              }}>{f.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px 20px', color: 'var(--text-muted)' }}>
            <div style={{ width: '32px', height: '32px', border: '3px solid rgba(56,189,248,0.1)', borderTopColor: '#38bdf8', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 14px' }} />
            Loading guests...
          </div>
        ) : guests.length === 0 ? (
          <EmptyState icon="🔍" msg="No guests found" sub="Try a different search term or filter." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: 'rgba(8,15,30,0.97)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {['Guest', 'Contact', 'Tier / Points', 'Bookings', 'Spend', 'ID Status', 'Status', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '9px 14px', color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.4px', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {guests.map(g => (
                <tr key={g.id}
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', transition: 'background 0.12s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(56,189,248,0.04)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  onClick={() => setSelectedGuest(g)}
                >
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0, background: 'linear-gradient(135deg,#38bdf888,#818cf888)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', fontWeight: 800, color: '#fff' }}>
                        {g.full_name?.[0]?.toUpperCase() || '?'}
                      </div>
                      <div>
                        <div style={{ fontWeight: 700, color: '#e2e8f0', whiteSpace: 'nowrap' }}>{g.full_name}</div>
                        {g.current_room && <div style={{ fontSize: '0.66rem', color: '#f87171', marginTop: '1px' }}>🏨 Room {g.current_room}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-muted)' }}>
                    <div>{g.phone || '—'}</div>
                    <div style={{ fontSize: '0.72rem', marginTop: '1px' }}>{g.email || ''}</div>
                    {g.date_of_birth && <div style={{ fontSize: '0.68rem', color: '#a78bfa', marginTop: '1px' }}>🎂 DOB: {formatDateOnly(g.date_of_birth)}</div>}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <TierBadge tier={g.loyalty_tier} />
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '3px' }}>{g.loyalty_points || 0} pts</div>
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'center', fontWeight: 700, color: '#818cf8' }}>{g.total_bookings}</td>
                  <td style={{ padding: '10px 14px', fontWeight: 700, color: '#4ade80' }}>₹{Number(g.lifetime_spend || 0).toLocaleString('en-IN')}</td>
                  <td style={{ padding: '10px 14px' }}><VerifyBadge status={g.id_verification_status} /></td>
                  <td style={{ padding: '10px 14px' }}>
                    {g.current_status
                      ? <StatusBadge status={g.current_status} />
                      : <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>—</span>
                    }
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                    <button onClick={e => { e.stopPropagation(); setSelectedGuest(g); }} style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)', color: '#38bdf8', borderRadius: '5px', padding: '4px 10px', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                      View →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {pagination.pages > 1 && (
        <div style={{ padding: '12px 24px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(0,0,0,0.3)', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          <span>Showing {((pagination.page - 1) * 25) + 1}–{Math.min(pagination.page * 25, pagination.total)} of {pagination.total}</span>
          <div style={{ display: 'flex', gap: '5px' }}>
            <button onClick={() => handlePage(pagination.page - 1)} disabled={pagination.page <= 1} style={{ ...paginBtn, opacity: pagination.page <= 1 ? 0.35 : 1 }}>← Prev</button>
            {Array.from({ length: Math.min(5, pagination.pages) }, (_, i) => {
              const p = pagination.page <= 3 ? i + 1 : Math.max(1, pagination.page - 2) + i;
              if (p > pagination.pages) return null;
              return (
                <button key={p} onClick={() => handlePage(p)} style={{ ...paginBtn, background: p === pagination.page ? 'rgba(56,189,248,0.15)' : 'transparent', color: p === pagination.page ? '#38bdf8' : 'var(--text-muted)', borderColor: p === pagination.page ? 'rgba(56,189,248,0.4)' : 'rgba(255,255,255,0.08)' }}>{p}</button>
              );
            })}
            <button onClick={() => handlePage(pagination.page + 1)} disabled={pagination.page >= pagination.pages} style={{ ...paginBtn, opacity: pagination.page >= pagination.pages ? 0.35 : 1 }}>Next →</button>
          </div>
        </div>
      )}

      {/* Guest Profile Drawer */}
      {selectedGuest && <GuestDrawer guest={selectedGuest} token={token} onClose={() => setSelectedGuest(null)} />}
    </div>
  );
}
