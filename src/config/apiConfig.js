/**
 * src/config/apiConfig.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized API & Backend Configuration for Webline PMS Plus / Hotel Sky-5.
 *
 * Supports both Local development (http://localhost:5000) and Remote testing
 * (e.g. ngrok: https://quarters-frugality-revolving.ngrok-free.dev) cleanly.
 */

// Primary Backend Origin (No trailing slash)
const envApiUrl = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL) 
  || (typeof process !== 'undefined' && process.env && process.env.VITE_API_BASE_URL);

export const API_BASE_URL = (envApiUrl || 'http://localhost:5000').replace(/\/+$/, '');


// Express API Router Base URL
export const API_URL = `${API_BASE_URL}/api`;

// Socket.IO Connection Origin
export const SOCKET_URL = API_BASE_URL;

/**
 * Resolves static backend asset paths (e.g., /inventory-photos/xxx.jpg, /guest-documents/yyy.pdf)
 * to absolute URLs pointing to the configured backend origin.
 */
export function getAssetUrl(relativePath) {
  if (!relativePath) return '';
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://') || relativePath.startsWith('blob:')) {
    return relativePath;
  }
  const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return `${API_BASE_URL}${cleanPath}`;
}

/**
 * Constructs standard API request headers, automatically including Authorization bearer token
 * and ngrok bypass header when needed.
 */
export function getApiHeaders(token = null, customHeaders = {}) {
  const headers = {
    'ngrok-skip-browser-warning': 'true',
    ...customHeaders,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}

/**
 * Thrown by authenticatedFetch() when a request cannot be authenticated at
 * all — either Firebase has no signed-in user to refresh a token from, or
 * the request is still rejected after one legitimate refresh-and-retry.
 * Callers can catch this specifically to show a clean "please sign in
 * again" state, distinct from ordinary network/server errors.
 */
export class AuthenticationError extends Error {
  constructor(message = 'Your session has expired. Please sign in again.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * fetch() wrapper for authenticated API calls, with the same resilience
 * App.jsx's Dashboard polling already has inline: on a 401, force-refresh
 * the Firebase ID token and retry exactly once before giving up cleanly.
 * This is what closes the gap where a module's `token` prop is momentarily
 * stale/empty (e.g. right after AdminAuthContext clears it) but a valid
 * Firebase session still exists to recover from.
 *
 * @param {string} url - full request URL
 * @param {RequestInit} [options] - fetch options (method, body, signal, ...).
 *   `options.headers`, if present, are merged in on top of the
 *   Authorization/extraHeaders below (so a caller can still override).
 * @param {string} [token] - token to use for the first attempt; a stale or
 *   empty value is fine, a 401 triggers the same refresh-and-retry path
 * @param {Record<string,string>} [extraHeaders] - e.g. { 'Content-Type': 'application/json' }
 * @returns {Promise<Response>} the final response for any non-auth outcome —
 *   callers keep checking res.ok / res.status exactly as before
 * @throws {AuthenticationError} when there's no signed-in Firebase user to
 *   refresh from, or the retried request is still rejected after refresh
 */
export async function authenticatedFetch(url, options = {}, token, extraHeaders = {}) {
  // Lazy import avoids a hard circular dependency: firebaseClient.js doesn't
  // import from here, but keeping this import local to the function (rather
  // than a static top-level import) means apiConfig.js stays safe to import
  // from anywhere, including before Firebase has finished initializing.
  const { auth } = await import('./firebaseClient');

  const { headers: optionHeaders, ...restOptions } = options;
  const attempt = (t) => fetch(url, {
    ...restOptions,
    headers: getApiHeaders(t, { ...extraHeaders, ...optionHeaders }),
  });

  let res = await attempt(token);
  if (res.status !== 401) return res;

  if (!auth || !auth.currentUser) {
    throw new AuthenticationError();
  }

  let freshToken;
  try {
    freshToken = await auth.currentUser.getIdToken(true);
  } catch {
    throw new AuthenticationError();
  }
  if (!freshToken) {
    throw new AuthenticationError();
  }

  res = await attempt(freshToken);
  if (res.status === 401) {
    throw new AuthenticationError();
  }
  return res;
}
