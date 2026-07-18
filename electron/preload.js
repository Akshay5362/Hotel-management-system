/**
 * electron/preload.js
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SECURE BRIDGE between Electron's Node.js world and the React app.
 *
 * PURPOSE:
 *   Electron runs with two separate JS contexts:
 *     1. MAIN PROCESS  — has full Node.js access (filesystem, OS, native APIs)
 *     2. RENDERER      — the React app (a Chromium tab, no Node.js by default)
 *
 *   With contextIsolation: true (our secure setting), these two contexts
 *   CANNOT share variables. The preload script runs BEFORE the renderer but
 *   has access to BOTH worlds. It uses contextBridge.exposeInMainWorld() to
 *   selectively expose only approved APIs to the React app.
 *
 * SECURITY PRINCIPLE:
 *   Never expose ipcRenderer directly. Always wrap calls in named functions
 *   so the renderer can only call what you explicitly allow — nothing more.
 *
 * WHAT REACT CAN USE AFTER THIS:
 *   window.electronAPI.getAppVersion()        → returns app version string
 *   window.electronAPI.platform               → 'win32' | 'darwin' | 'linux'
 *   window.electronAPI.isDev                  → boolean
 *   window.electronAPI.onMenuAction(callback) → listens for native menu events
 *   window.electronAPI.removeMenuListener()   → cleans up the listener
 *
 *   (Add more under the "Future IPC channels" section below as needed)
 *
 * HOW TO CHECK IN REACT:
 *   if (window.electronAPI) {
 *     // running inside Electron desktop app
 *   } else {
 *     // running in browser (dev or web deployment)
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { contextBridge, ipcRenderer } from 'electron';

// ─── Allowed IPC channels (whitelist) ────────────────────────────────────────
// Only channels listed here can be used. The renderer cannot invent new channels.

const ALLOWED_SEND_CHANNELS = [
  'app:minimize',
  'app:maximize',
  'app:close',
  'app:get-version',
];

const ALLOWED_RECEIVE_CHANNELS = [
  'menu:action',          // native menu → renderer (e.g. Print, Export, Settings)
  'app:update-available', // future: electron-updater notification
];

// ─── Expose safe API to the React renderer ───────────────────────────────────

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Platform info (read-only, no IPC needed) ─────────────────────────────
  platform : process.platform,           // 'win32' | 'darwin' | 'linux'
  isDev    : process.env.NODE_ENV !== 'production',

  // ── App version ──────────────────────────────────────────────────────────
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),

  // ── Window controls (for custom titlebar, if added later) ────────────────
  minimizeWindow : () => ipcRenderer.send('app:minimize'),
  maximizeWindow : () => ipcRenderer.send('app:maximize'),
  closeWindow    : () => ipcRenderer.send('app:close'),

  // ── Listen for native menu actions from the main process ─────────────────
  //   Usage in React:
  //     useEffect(() => {
  //       window.electronAPI?.onMenuAction((action) => {
  //         if (action === 'print-folio') handlePrint();
  //       });
  //       return () => window.electronAPI?.removeMenuListener();
  //     }, []);
  onMenuAction: (callback) => {
    if (!ALLOWED_RECEIVE_CHANNELS.includes('menu:action')) return;
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('menu:action', handler);
    // Store handler reference so removeMenuListener can clean it up
    ipcRenderer._menuHandler = handler;
  },

  removeMenuListener: () => {
    if (ipcRenderer._menuHandler) {
      ipcRenderer.removeListener('menu:action', ipcRenderer._menuHandler);
      ipcRenderer._menuHandler = null;
    }
  },

  // ── Future IPC channels ──────────────────────────────────────────────────
  // Add new channels here following the same pattern:
  //   sendSomething : (data) => ipcRenderer.invoke('channel:name', data),
  //
  // RAZORPAY DESKTOP:
  //   openPaymentWindow: (orderData) => ipcRenderer.invoke('payment:open', orderData),
  //
  // PRINT INVOICE:
  //   printFolio: (html) => ipcRenderer.invoke('print:folio', html),
  //
  // FILE OPERATIONS:
  //   saveReport: (data) => ipcRenderer.invoke('file:save-report', data),

});

// ─── Dev console confirmation ─────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  console.log('[Preload] Context bridge ready. window.electronAPI is available in renderer.');
}
