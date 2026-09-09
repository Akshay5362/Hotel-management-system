/**
 * inventoryApi.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin fetch helper shared by the Inventory Hub tabs (Phase A). Mirrors the
 * auth-header pattern already used by src/components/InventoryModule.jsx and
 * the `API_URL` base from src/config/apiConfig.js — no new dependency.
 */
import { API_URL } from '../../config/apiConfig';

export function authHeader(token) {
  const t = token || localStorage.getItem('adminToken') || localStorage.getItem('token') || localStorage.getItem('staffToken');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/**
 * @param {string} path   e.g. '/inventory/categories'
 * @param {object} [opts] { token, method, body, isForm }
 */
export async function inventoryFetch(path, { token, method = 'GET', body, isForm = false } = {}) {
  const headers = { ...authHeader(token) };
  let payload = body;
  if (body !== undefined && !isForm) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const message = data?.error || `Request failed (HTTP ${res.status})`;
    const err = new Error(Array.isArray(data?.details) ? `${message}: ${data.details.join(' ')}` : message);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

export const STOCK_STATUS_COLORS = {
  NORMAL: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'In Stock' },
  LOW_STOCK: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', label: 'Low Stock' },
  OUT_OF_STOCK: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', label: 'Out of Stock' }
};

/**
 * Quantities are stored with up to 3 decimals (see QUANTITY_DECIMALS in
 * backend/utils/inventoryConstants.js), so display up to 3 and trim trailing
 * zeros — rounding to 2 here silently misreported values like 0.125.
 */
export function formatQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  if (v % 1 === 0) return String(v);
  return String(Math.round(v * 1000) / 1000);
}
