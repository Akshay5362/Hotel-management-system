/**
 * electron/main.js
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ELECTRON ENTRY POINT — the main process.
 *
 * PRODUCTION STARTUP FLOW (packaged .exe):
 *   1. App ready → Show splash screen immediately
 *   2. Spawn backend/server.js from process.resourcesPath/backend/
 *   3. Poll /api/health until backend is ready (up to 30 s)
 *   4. Build main BrowserWindow → loadFile(dist/index.html from inside asar)
 *   5. ready-to-show → close splash → show main window
 *
 * DEVELOPMENT STARTUP FLOW (npm run electron:dev):
 *   1. App ready → Show splash screen
 *   2. Wait for Vite dev server on :5173
 *   3. Load http://localhost:5173
 *   4. Open DevTools in detached mode
 *
 * KEY FIXES IN THIS VERSION:
 *   ✅ webSecurity: false  — required so file:// renderer can fetch localhost:5000
 *   ✅ PROD_ENTRY uses app.getAppPath() instead of __dirname — works inside asar
 *   ✅ process.resourcesPath used for backend path in packaged mode
 *   ✅ will-navigate uses forward-slash URL comparison (Windows-safe)
 *   ✅ DevTools always enabled (for diagnosis); F12 opens inspector
 *   ✅ console-message relays renderer errors to main process stdout
 *   ✅ ready-to-show safety fallback (15 s) prevents permanent black screen
 *   ✅ Comprehensive step-by-step startup logging
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { app, BrowserWindow, ipcMain, shell, Menu, dialog, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';
import BRANDING_CONFIG from './branding.js';
import { launchBackend, waitForBackend, killBackend } from './backend-launcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Environment ──────────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV !== 'production';

console.log(`[Electron] ── Startup ──────────────────────────────────────────`);
console.log(`[Electron] isDev        : ${isDev}`);
console.log(`[Electron] isPackaged   : ${app.isPackaged}`);
console.log(`[Electron] __dirname    : ${__dirname}`);
console.log(`[Electron] app.getAppPath(): will resolve after app.ready`);

// ─── Path constants ────────────────────────────────────────────────────────────
// IMPORTANT: app.getAppPath() returns the root of the asar archive (or the
// project root in dev). __dirname inside an asar is the virtual asar path, so
// using app.getAppPath() is the canonical way to resolve the app's root.

const DEV_URL = 'http://localhost:5173';

// These are computed after app is ready (app.getAppPath() needs app to be initialized).
// Declared here as `let` and set inside app.whenReady().
let ELECTRON_DIR;
let PRELOAD_PATH;
let SPLASH_PATH;
let PROD_ENTRY;

// ─── Window state persistence ─────────────────────────────────────────────────

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) { /* ignore corrupted state */ }
  return null;
}

function saveWindowState(win) {
  try {
    const bounds      = win.getBounds();
    const isMaximized = win.isMaximized();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...bounds, isMaximized }));
  } catch (e) { /* non-critical */ }
}

function getValidatedBounds(saved) {
  if (!saved) return null;
  const displays = screen.getAllDisplays();
  const isOnScreen = displays.some((d) => {
    const { x, y, width, height } = d.workArea;
    return (
      saved.x >= x &&
      saved.y >= y &&
      saved.x + saved.width  <= x + width &&
      saved.y + saved.height <= y + height
    );
  });
  return isOnScreen ? saved : null;
}

// ─── Window references ────────────────────────────────────────────────────────

let mainWindow   = null;
let splashWindow = null;

// ─── ① Single Instance Lock ───────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[Electron] Another instance is running — quitting this one.');
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ─── createSplashWindow() ─────────────────────────────────────────────────────

function createSplashWindow() {
  console.log(`[Electron] Creating splash window: ${SPLASH_PATH}`);

  splashWindow = new BrowserWindow({
    width          : 480,
    height         : 320,
    frame          : false,
    alwaysOnTop    : true,
    resizable      : false,
    skipTaskbar    : true,
    backgroundColor: '#0d1117',
    webPreferences : {
      nodeIntegration : false,
      contextIsolation: true,
    },
  });

  splashWindow.loadFile(SPLASH_PATH)
    .then(() => console.log('[Electron] ✓ Splash loaded'))
    .catch((e) => console.warn('[Electron] Splash load failed (non-fatal):', e.message));

  splashWindow.on('closed', () => { splashWindow = null; });
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
}

// ─── createWindow() ───────────────────────────────────────────────────────────

function createWindow() {
  const savedState  = loadWindowState();
  const validBounds = getValidatedBounds(savedState);

  console.log(`[Electron] Creating BrowserWindow`);
  console.log(`[Electron]   PRELOAD_PATH : ${PRELOAD_PATH}`);
  console.log(`[Electron]   preload exists: ${fs.existsSync(PRELOAD_PATH)}`);
  console.log(`[Electron]   PROD_ENTRY   : ${PROD_ENTRY}`);
  console.log(`[Electron]   prod exists  : ${!isDev ? fs.existsSync(PROD_ENTRY) : 'n/a (dev)'}`);

  const winConfig = {
    width          : validBounds?.width  || 1440,
    height         : validBounds?.height || 900,
    x              : validBounds?.x,
    y              : validBounds?.y,
    minWidth       : 1280,
    minHeight      : 720,
    title          : 'Webline PMS Plus',
    backgroundColor: '#0d1117',
    show           : false,   // shown only on ready-to-show (or fallback)
    resizable      : true,
    maximizable    : true,
    minimizable    : true,
    webPreferences : {
      contextIsolation: true,
      nodeIntegration : false,
      sandbox         : false,
      // ─────────────────────────────────────────────────────────────────────
      // webSecurity: false  ← THIS IS THE CRITICAL FIX FOR THE BLACK SCREEN.
      //
      // When Electron loads dist/index.html via the file:// protocol the
      // renderer's origin is "null".  Every fetch() call to http://localhost:5000
      // is treated as a cross-origin request (null → http) and Chromium silently
      // drops it when webSecurity is true.  React receives no data, mounts
      // nothing into #root, and the window background (#0d1117 = near-black)
      // is all that's visible — the "black screen".
      //
      // Setting webSecurity: false allows file:// pages to call localhost APIs.
      // contextIsolation: true still applies, so Node.js APIs are NOT exposed
      // to renderer code — security is maintained at the boundary that matters.
      // ─────────────────────────────────────────────────────────────────────
      webSecurity     : false,
      devTools        : true,   // keep open for diagnosis; disable after confirming
      preload         : PRELOAD_PATH,
    },
  };

  mainWindow = new BrowserWindow(winConfig);
  console.log('[Electron] ✓ BrowserWindow created');

  // ── Restore maximized state ────────────────────────────────────────────────
  if (savedState?.isMaximized) {
    mainWindow.maximize();
  }

  // ── Persist window state ───────────────────────────────────────────────────
  const persistState = () => saveWindowState(mainWindow);
  mainWindow.on('resize', persistState);
  mainWindow.on('move',   persistState);
  mainWindow.on('close',  persistState);

  // ── Show window only when fully rendered ───────────────────────────────────
  let windowShown = false;
  const showWindow = (reason) => {
    if (windowShown) return;
    windowShown = true;
    clearTimeout(showFallbackTimer);
    console.log(`[Electron] ✓ Showing window (reason: ${reason})`);
    closeSplash();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      if (isDev) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }
  };

  mainWindow.once('ready-to-show', () => {
    console.log('[Electron] ✓ ready-to-show fired');
    showWindow('ready-to-show');
  });

  // Safety fallback: if ready-to-show never fires in 15 s, show anyway.
  // This prevents a permanent black/hidden window if the renderer stalls.
  const showFallbackTimer = setTimeout(() => {
    if (!windowShown) {
      console.warn('[Electron] ⚠ ready-to-show did not fire within 15 s — safety show');
      showWindow('15s-fallback');
    }
  }, 15000);

  // ── Renderer lifecycle events ──────────────────────────────────────────────
  mainWindow.webContents.on('dom-ready', () => {
    console.log('[Electron] ✓ dom-ready');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Electron] ✓ did-finish-load — renderer loaded successfully');
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Electron] ✗ did-fail-load`);
    console.error(`            code : ${errorCode}`);
    console.error(`            desc : ${errorDescription}`);
    console.error(`            url  : ${validatedURL}`);
    // Show the window so user sees error page rather than black screen
    showWindow('did-fail-load');
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    if (details.reason !== 'clean-exit') {
      console.error(`[Electron] ✗ Renderer process gone — reason: ${details.reason}`);
      closeSplash();
      dialog.showMessageBox({
        type   : 'error',
        title  : 'Application Crash',
        message: 'Webline PMS encountered an unexpected error.',
        detail : `Crash reason: ${details.reason}\n\nThe application will reload.`,
        buttons: ['Reload'],
      }).then(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      });
    }
  });

  // ── Relay renderer console output to main process stdout ──────────────────
  // Allows seeing React errors in the main process log / Windows Event Viewer.
  mainWindow.webContents.on('console-message', (event) => {
    const level    = typeof event.level    === 'number' ? event.level    : 1;
    const message  = typeof event.message  === 'string' ? event.message  : String(event);
    const lineNum  = typeof event.lineNumber === 'number' ? event.lineNumber : 0;
    const sourceId = typeof event.sourceId === 'string'  ? event.sourceId  : '';
    const LEVELS = ['verbose', 'info', 'warning', 'error'];
    const tag = LEVELS[level] || 'log';
    const src = sourceId ? ` (${path.basename(sourceId)}:${lineNum})` : '';
    if (level >= 3) {
      console.error(`[Renderer:${tag}]${src} ${message}`);
    } else if (level >= 2) {
      console.warn(`[Renderer:${tag}]${src} ${message}`);
    } else if (isDev) {
      console.log(`[Renderer:${tag}]${src} ${message}`);
    }
  });

  // ── Block F5 / Ctrl+R in production ───────────────────────────────────────
  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const isRefresh = (
        input.key === 'F5' ||
        (input.control && input.key === 'r') ||
        (input.control && input.key === 'R') ||
        (input.meta    && input.key === 'r') ||
        (input.meta    && input.key === 'R')
      );
      if (isRefresh) event.preventDefault();
    });
  }

  const targetApiBase = (process.env.VITE_API_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
  const isAllowedOrigin = (testUrl) => {
    if (!testUrl) return false;
    if (testUrl.startsWith('http://localhost:5000') || testUrl.startsWith('http://localhost:5173') || testUrl.startsWith(targetApiBase)) return true;
    try {
      const hostname = new URL(testUrl).hostname;
      if (hostname.endsWith('.ngrok-free.dev') || hostname.endsWith('.ngrok.io')) return true;
    } catch {}
    return false;
  };

  // ── External links open in system browser ─────────────────────────────────
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // ── Prevent navigation outside the app ────────────────────────────────────
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    let allowed = false;
    if (isDev) {
      allowed = navUrl.startsWith(DEV_URL) || isAllowedOrigin(navUrl);
    } else {
      const prodDir = path.dirname(PROD_ENTRY).replace(/\\/g, '/');
      allowed =
        navUrl.startsWith(`file:///${prodDir}`) ||
        navUrl.startsWith(`file://${prodDir}`)  ||
        isAllowedOrigin(navUrl);
    }
    if (!allowed) {
      console.log(`[Electron] Navigation blocked: ${navUrl}`);
      event.preventDefault();
    }
  });


  mainWindow.on('closed', () => { mainWindow = null; });

  // ── Load the application ───────────────────────────────────────────────────
  loadApplication();
}

// ─── loadApplication() ────────────────────────────────────────────────────────

function loadApplication(retryCount = 0) {
  const MAX_RETRIES = 5;

  if (isDev) {
    console.log(`[Electron] loadApplication → DEV URL: ${DEV_URL} (attempt ${retryCount + 1})`);
  } else {
    const exists = fs.existsSync(PROD_ENTRY);
    console.log(`[Electron] loadApplication → PROD FILE (attempt ${retryCount + 1})`);
    console.log(`[Electron]   path   : ${PROD_ENTRY}`);
    console.log(`[Electron]   exists : ${exists}`);
    if (!exists) {
      console.error('[Electron] ✗ dist/index.html NOT FOUND inside asar — rebuild required!');
    }
  }

  const loadPromise = isDev
    ? mainWindow.loadURL(DEV_URL)
    : mainWindow.loadFile(PROD_ENTRY);

  loadPromise
    .then(() => {
      console.log(`[Electron] ✓ loadURL/loadFile resolved (attempt ${retryCount + 1})`);
    })
    .catch((err) => {
      console.error(`[Electron] ✗ Load failed (attempt ${retryCount + 1}): ${err.message}`);
      closeSplash();

      if (retryCount < MAX_RETRIES) {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            loadApplication(retryCount + 1);
          }
        }, 2000);
        return;
      }

      dialog.showMessageBox({
        type     : 'error',
        title    : 'Connection Error',
        message  : 'Failed to load Webline PMS.',
        detail   : `Could not load the application after ${MAX_RETRIES} attempts.\n\nError: ${err.message}`,
        buttons  : ['Retry', 'Exit'],
        defaultId: 0,
        cancelId : 1,
      }).then(({ response }) => {
        if (response === 0) loadApplication(0);
        else app.quit();
      });
    });
}

// ─── Application Menu ─────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label  : 'File',
      submenu: [{ role: 'quit', label: 'Exit Webline PMS' }],
    },
    {
      label  : 'View',
      submenu: [
        ...(isDev
          ? [
              { role: 'reload'         },
              { role: 'forceReload'    },
              { role: 'toggleDevTools' },
              { type: 'separator'      },
            ]
          : [
              { role: 'toggleDevTools' }, // keep available for diagnosis
              { type: 'separator'      },
            ]),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label  : 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom'     },
        { role: 'close'    },
      ],
    },
    {
      role   : 'help',
      submenu: [
        {
          label: 'About Webline PMS Plus',
          click: async () => {
            await dialog.showMessageBox(mainWindow, {
              type   : 'info',
              title  : 'Webline PMS Plus',
              message: 'Webline PMS Plus',
              detail : `Professional Hotel Property Management System\nVersion: ${app.getVersion()}\n\nHotel Sky-5`,
            });
          },
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label  : 'Webline PMS Plus',
      submenu: [
        { role: 'about'     },
        { type: 'separator' },
        { role: 'services'  },
        { type: 'separator' },
        { role: 'hide'      },
        { role: 'hideOthers'},
        { role: 'unhide'    },
        { type: 'separator' },
        { role: 'quit'      },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.on('app:minimize', () => mainWindow?.minimize());
ipcMain.on('app:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('app:close', () => mainWindow?.close());

// ─── Dev helper: wait for Vite ────────────────────────────────────────────────

function waitForPort(port, maxWaitMs = 60000, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    let elapsed = 0;
    let resolved = false;
    const check = () => {
      if (resolved) return;
      const req = http.get(`http://localhost:${port}`, (res) => {
        if (resolved) return;
        resolved = true;
        console.log(`[Electron] Port ${port} ready (HTTP ${res.statusCode})`);
        resolve();
      });
      req.on('error', () => {
        if (resolved) return;
        elapsed += intervalMs;
        if (elapsed >= maxWaitMs) {
          reject(new Error(`Port ${port} not ready within ${maxWaitMs / 1000}s`));
        } else {
          setTimeout(check, intervalMs);
        }
      });
      req.setTimeout(400, () => { req.destroy(); });
    };
    console.log(`[Electron] Waiting for port ${port}...`);
    check();
  });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  app.setName('Webline PMS Plus');

  // ── Resolve paths now that app is ready ─────────────────────────────────
  // app.getAppPath() returns:
  //   - In packaged app : <install>/resources/app.asar
  //   - In dev          : <project root>
  const APP_ROOT = app.getAppPath();
  ELECTRON_DIR   = path.join(APP_ROOT, 'electron');
  PRELOAD_PATH   = path.join(ELECTRON_DIR, 'preload.js');
  SPLASH_PATH    = path.join(ELECTRON_DIR, 'splash.html');
  PROD_ENTRY     = path.join(APP_ROOT, 'dist', 'index.html');

  console.log(`[Electron] ── Paths resolved ──────────────────────────────────`);
  console.log(`[Electron] APP_ROOT     : ${APP_ROOT}`);
  console.log(`[Electron] PRELOAD_PATH : ${PRELOAD_PATH}`);
  console.log(`[Electron] SPLASH_PATH  : ${SPLASH_PATH}`);
  console.log(`[Electron] PROD_ENTRY   : ${PROD_ENTRY}`);
  console.log(`[Electron] preload file exists: ${fs.existsSync(PRELOAD_PATH)}`);

  buildMenu();
  createSplashWindow();

  if (!isDev) {
    // ── PRODUCTION: Launch backend, wait for health ──────────────────────
    try {
      // In a packaged app, extraResources land in process.resourcesPath.
      // In an unpackaged prod run (npm run electron:prod), use project root.
      const backendRoot = app.isPackaged
        ? process.resourcesPath          // <install>/resources/
        : path.join(APP_ROOT, '..');     // project root

      console.log(`[Electron] backendRoot  : ${backendRoot}`);
      console.log(`[Electron] isPackaged   : ${app.isPackaged}`);

      launchBackend(backendRoot);

      console.log('[Electron] Waiting for backend...');
      await waitForBackend(5000, 30000);
      console.log('[Electron] ✓ Backend ready. Creating window...');
    } catch (err) {
      console.error('[Electron] ✗ Backend startup failed:', err.message);
      closeSplash();
      const { response } = await dialog.showMessageBox({
        type   : 'error',
        title  : 'Backend Startup Failed',
        message: 'The Webline PMS server failed to start.',
        detail : `Error: ${err.message}\n\nVerify Node.js is installed and backend/.env is correct.`,
        buttons: ['Retry', 'Exit'],
      });
      if (response === 0) app.relaunch();
      app.quit();
      return;
    }
  } else {
    // ── DEVELOPMENT: Wait for Vite before creating window ─────────────────
    try {
      await waitForPort(5173, 60000);
      console.log('[Electron] ✓ Vite dev server ready.');
    } catch (err) {
      console.warn('[Electron] Vite not ready:', err.message);
      // Continue anyway — loadApplication has retry logic
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplashWindow();
      createWindow();
    }
  });
});

// ─── Quit handling ────────────────────────────────────────────────────────────

app.on('before-quit', () => {
  if (!isDev) killBackend();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
