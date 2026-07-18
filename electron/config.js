/**
 * electron/config.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH for all Electron configuration.
 *
 * PURPOSE:
 *   Centralise every configurable value so that main.js and preload.js
 *   never contain hardcoded strings. Changing the dev port, window size,
 *   or app title only requires editing this one file.
 *
 * USAGE:
 *   import config from './config.js';   (in main.js / preload.js)
 *
 * PRODUCTION vs DEVELOPMENT:
 *   Electron sets NODE_ENV = 'production' when packaged by electron-builder.
 *   In dev, you start Electron manually so NODE_ENV = 'development' (default).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve __dirname for ES Module context (Electron main process uses CommonJS,
// but we keep this ready for the hybrid approach used in main.js).
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const isDev = process.env.NODE_ENV !== 'production';

const config = {
  // ── App Identity ─────────────────────────────────────────────────────────
  appName    : 'Webline PMS Plus — Hotel Sky-5',
  appVersion : '1.0.0',

  // ── URLs ─────────────────────────────────────────────────────────────────
  //   DEV:  Vite dev server (npm run dev → http://localhost:5173)
  //   PROD: Built React files served from ./dist/index.html
  devUrl     : 'http://localhost:5173',
  prodEntry  : join(__dirname, '..', 'dist', 'index.html'),

  // ── Window ───────────────────────────────────────────────────────────────
  window: {
    width          : 1400,
    height         : 880,
    minWidth       : 1024,
    minHeight      : 700,
    title          : 'Webline PMS Plus — Hotel Sky-5',
    backgroundColor: '#0d1117',   // matches CSS --bg-primary so no white flash on load
    show           : false,       // show AFTER content is ready (avoids blank-window flash)
  },

  // ── Security ─────────────────────────────────────────────────────────────
  //   These values are spread into BrowserWindow.webPreferences in main.js.
  //   DO NOT set nodeIntegration: true — it exposes the full Node.js API to
  //   the renderer (React app), which is a critical security vulnerability.
  webPreferences: {
    contextIsolation  : true,   // renderer runs in isolated JS context
    nodeIntegration   : false,  // renderer has NO access to Node.js modules
    sandbox           : false,  // keep false so preload.js can use contextBridge
    webSecurity       : true,   // enforce same-origin policy in renderer
  },

  // ── Backend API (the Node.js/Express server) ─────────────────────────────
  //   React already calls this directly via fetch(); Electron does not proxy it.
  //   This is documented here for reference only.
  backendPort: 5000,
  backendUrl : 'http://localhost:5000',

  // ── Dev helper ───────────────────────────────────────────────────────────
  isDev,
  openDevTools: isDev,   // auto-open Chrome DevTools only in dev mode
};

export default config;
