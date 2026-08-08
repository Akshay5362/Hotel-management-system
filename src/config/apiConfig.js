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
