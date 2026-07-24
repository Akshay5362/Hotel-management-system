/**
 * electron/main.js  — DIAGNOSTIC BUILD
 * ─────────────────────────────────────────────────────────────────────────────
 * Logging fires BEFORE all app-specific imports using only Node.js built-ins.
 * App-specific imports (branding.js, backend-launcher.js) are dynamic and
 * wrapped in try/catch so any import failure is captured in the log file.
 *
 * Single-instance lock is DISABLED for this diagnostic build.
 *
 * Log file:
 *   <resources>/logs/startup.log          (packaged)
 *   <userData>/logs/startup.log           (fallback)
 *   ~/Desktop/webline-startup.log         (absolute fallback)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── ONLY built-in / Electron imports at the top level ───────────────────────
// Avoids any app-specific module resolution failures silencing startup.
import { app, BrowserWindow, ipcMain, shell, Menu, dialog, screen } from 'electron';
import path   from 'path';
import fs     from 'fs';
import http   from 'http';
import os     from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Synchronous file logger ──────────────────────────────────────────────────
// Uses appendFileSync — every line is on disk before the next line runs.
// Three candidate paths tried in order; whichever is writable wins.

let LOG_FILE = null;

function initLogger() {
  const dirs = [
    // 1. Primary: next to backend in resources/ (visible after build)
    app.isPackaged ? path.join(process.resourcesPath, 'logs') : null,
    // 2. userData — always writable for the current user
    (() => { try { return path.join(app.getPath('userData'), 'logs'); } catch { return null; } })(),
    // 3. Absolute fallback — Desktop
    path.join(os.homedir(), 'Desktop'),
    // 4. Temp
    os.tmpdir(),
  ].filter(Boolean);

  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const candidate = path.join(dir, dir === os.tmpdir() ? 'webline-startup.log' : 'startup.log');
      fs.writeFileSync(candidate, ''); // truncate / create
      LOG_FILE = candidate;
      break;
    } catch { /* try next */ }
  }
}

function L(step, msg, extra) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const body = `[${ts}] [${step}] ${msg}${extra ? '\n         ' + String(extra).replace(/\n/g, '\n         ') : ''}\n`;
  try { process.stdout.write(body); } catch {}
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, body); } catch {}
  }
}

function LERR(step, msg, err) {
  const stack = err instanceof Error ? err.stack : String(err);
  L(step, `ERROR: ${msg}`, stack);
}

// ─── INIT LOGGER — very first thing ──────────────────────────────────────────
try { initLogger(); } catch {}

L('START', '='.repeat(60));
L('START', 'Webline PMS Plus — Electron Diagnostic Startup');
L('START', '='.repeat(60));
L('START', `Log file         : ${LOG_FILE ?? 'FAILED TO CREATE'}`);
L('START', `Electron ver     : ${process.versions.electron}`);
L('START', `Node.js ver      : ${process.versions.node}`);
L('START', `Chrome ver       : ${process.versions.chrome}`);
L('START', `Process exe      : ${process.execPath}`);
L('START', `argv             : ${process.argv.join(' ')}`);
L('START', `__dirname        : ${__dirname}`);
L('START', `app.isPackaged   : ${app.isPackaged}`);
L('START', `NODE_ENV         : ${process.env.NODE_ENV ?? '(not set)'}`);
L('START', `process.resourcesPath : ${process.resourcesPath}`);
try { L('START', `app.getPath(exe) : ${app.getPath('exe')}`); } catch {}
try { L('START', `userData         : ${app.getPath('userData')}`); } catch {}

// ─── Global error catchers (registered immediately, before any async code) ───

process.on('uncaughtException', (err) => {
  LERR('EXCEPTION', 'uncaughtException — process will exit', err);
  try {
    dialog.showErrorBox(
      'Webline PMS — Fatal Error',
      `Uncaught exception:\n\n${err?.message}\n\nSee log:\n${LOG_FILE}`
    );
  } catch {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack : String(reason);
  LERR('REJECTION', 'unhandledRejection', msg);
});

process.on('exit', (code) => {
  L('EXIT', `process.exit called — code: ${code}`);
});

// ─── Environment ──────────────────────────────────────────────────────────────
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
L('ENV', `isDev = ${isDev}  (based on app.isPackaged & NODE_ENV)`);

// ─── Path placeholders ────────────────────────────────────────────────────────
const DEV_URL = 'http://localhost:5173';
let PRELOAD_PATH, SPLASH_PATH, PROD_ENTRY;

// ─── Dynamic import of app-specific modules ───────────────────────────────────
// Done at whenReady so import failures are caught and logged, not silent.
let launchBackend, waitForBackend, killBackend;

async function loadModules(APP_ROOT) {
  L('IMPORT', 'Loading branding.js...');
  try {
    // branding.js is not needed at runtime — it only provides icon paths.
    // We skip it in the diagnostic build to eliminate it as a crash source.
    L('IMPORT', 'branding.js skipped (diagnostic build)');
  } catch (e) {
    LERR('IMPORT', 'branding.js import FAILED', e);
  }

  L('IMPORT', 'Loading backend-launcher.js...');
  try {
    const mod = await import('./backend-launcher.js');
    launchBackend  = mod.launchBackend;
    waitForBackend = mod.waitForBackend;
    killBackend    = mod.killBackend;
    L('IMPORT', 'backend-launcher.js loaded OK');
  } catch (e) {
    LERR('IMPORT', 'backend-launcher.js import FAILED', e);
    // Provide no-op stubs so startup continues and we can see what happens next
    launchBackend  = (root) => L('BACKEND', `launchBackend stub called (root=${root})`);
    waitForBackend = () => Promise.resolve();
    killBackend    = () => {};
  }
}

// ─── Window state ─────────────────────────────────────────────────────────────

const STATE_FILE = (() => {
  try { return path.join(app.getPath('userData'), 'window-state.json'); } catch { return null; }
})();

function loadWindowState() {
  try {
    if (STATE_FILE && fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return null;
}

function saveWindowState(win) {
  try {
    if (!STATE_FILE) return;
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...win.getBounds(), isMaximized: win.isMaximized() }));
  } catch {}
}

function getValidatedBounds(saved) {
  if (!saved) return null;
  try {
    return screen.getAllDisplays().some(d => {
      const { x, y, width, height } = d.workArea;
      return saved.x >= x && saved.y >= y &&
        saved.x + saved.width <= x + width && saved.y + saved.height <= y + height;
    }) ? saved : null;
  } catch { return null; }
}

// ─── Window refs ──────────────────────────────────────────────────────────────

let mainWindow = null, splashWindow = null;

// ─── SINGLE INSTANCE LOCK — DISABLED FOR DIAGNOSTIC ──────────────────────────
// Set ENABLE_LOCK = true to re-enable after debugging is complete.
const ENABLE_LOCK = false;
if (ENABLE_LOCK) {
  const gotLock = app.requestSingleInstanceLock();
  L('LOCK', `requestSingleInstanceLock() = ${gotLock}`);
  if (!gotLock) {
    L('LOCK', 'Lock not acquired — another instance running. Exiting.');
    app.quit();
    process.exit(0);
  }
  app.on('second-instance', () => {
    L('LOCK', 'Second instance detected — focusing window');
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
} else {
  L('LOCK', 'Single-instance lock DISABLED (diagnostic mode)');
}

// ─── App lifecycle logging ────────────────────────────────────────────────────

app.on('before-quit', () => {
  L('QUIT', 'before-quit fired');
  if (killBackend) {
    try { if (!isDev) killBackend(); } catch (e) { LERR('QUIT', 'killBackend failed', e); }
  }
});

app.on('window-all-closed', () => {
  L('QUIT', 'window-all-closed fired');
  if (process.platform !== 'darwin') {
    L('QUIT', 'Calling app.quit() from window-all-closed');
    app.quit();
  }
});

// ─── Splash ───────────────────────────────────────────────────────────────────

function createSplashWindow() {
  L('SPLASH', `Loading splash from: ${SPLASH_PATH}`);
  L('SPLASH', `  exists: ${fs.existsSync(SPLASH_PATH)}`);
  try {
    splashWindow = new BrowserWindow({
      width: 480, height: 320,
      frame: false, alwaysOnTop: true, resizable: false, skipTaskbar: true,
      backgroundColor: '#0d1117',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    splashWindow.loadFile(SPLASH_PATH)
      .then(() => L('SPLASH', 'Splash loaded OK'))
      .catch(e => LERR('SPLASH', 'Splash loadFile failed (non-fatal)', e));
    splashWindow.on('closed', () => { splashWindow = null; });
    L('SPLASH', 'Splash BrowserWindow created OK');
  } catch (e) {
    LERR('SPLASH', 'Splash BrowserWindow creation FAILED', e);
  }
}

function closeSplash() {
  try { if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close(); } catch {}
}

// ─── Main window ──────────────────────────────────────────────────────────────

function createWindow() {
  L('WINDOW', 'createWindow() entered');

  const savedState  = loadWindowState();
  const validBounds = getValidatedBounds(savedState);

  // Verify critical files
  const preloadExists = fs.existsSync(PRELOAD_PATH);
  const indexExists   = !isDev && fs.existsSync(PROD_ENTRY);
  L('WINDOW', `PRELOAD_PATH : ${PRELOAD_PATH}`);
  L('WINDOW', `  preload exists  : ${preloadExists}`);
  L('WINDOW', `PROD_ENTRY   : ${PROD_ENTRY}`);
  L('WINDOW', `  index.html exists: ${isDev ? 'n/a (dev)' : indexExists}`);

  if (!preloadExists) {
    L('WINDOW', 'WARNING: preload.js NOT FOUND — contextBridge will be unavailable');
  }
  if (!isDev && !indexExists) {
    L('WINDOW', 'CRITICAL: dist/index.html NOT FOUND — renderer cannot load!');
  }

  const winConfig = {
    width: validBounds?.width || 1440,
    height: validBounds?.height || 900,
    x: validBounds?.x,
    y: validBounds?.y,
    minWidth: 1280, minHeight: 720,
    title: 'Webline PMS Plus',
    backgroundColor: '#0d1117',
    show: false,
    resizable: true, maximizable: true, minimizable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,    // Required: file:// → localhost:5000 fetch
      devTools: true,
      preload: PRELOAD_PATH,
    },
  };

  L('WINDOW', 'Calling new BrowserWindow(...)');
  try {
    mainWindow = new BrowserWindow(winConfig);
    L('WINDOW', `BrowserWindow created OK — id: ${mainWindow.id}`);
  } catch (err) {
    LERR('WINDOW', 'BrowserWindow constructor THREW — cannot continue', err);
    return;
  }

  if (savedState?.isMaximized) { try { mainWindow.maximize(); } catch {} }

  const persistState = () => saveWindowState(mainWindow);
  mainWindow.on('resize', persistState);
  mainWindow.on('move', persistState);
  mainWindow.on('close', persistState);

  // Show window logic
  let windowShown = false;
  const showWindow = (reason) => {
    if (windowShown) return;
    windowShown = true;
    clearTimeout(showFallbackTimer);
    L('SHOW', `mainWindow.show() called — reason: ${reason}`);
    closeSplash();
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        L('SHOW', 'mainWindow.show() completed');
        if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    } catch (e) { LERR('SHOW', 'mainWindow.show() threw', e); }
  };

  mainWindow.once('ready-to-show', () => {
    L('RENDERER', 'ready-to-show fired');
    showWindow('ready-to-show');
  });

  const showFallbackTimer = setTimeout(() => {
    if (!windowShown) {
      L('RENDERER', 'WARNING: ready-to-show did NOT fire in 15 s — forcing show');
      showWindow('15s-fallback');
    }
  }, 15000);

  // Renderer lifecycle
  mainWindow.webContents.on('did-start-loading',  () => L('RENDERER', 'did-start-loading'));
  mainWindow.webContents.on('dom-ready',           () => L('RENDERER', 'dom-ready'));
  mainWindow.webContents.on('did-finish-load',     () => L('RENDERER', 'did-finish-load ✓'));
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    L('RENDERER', `did-fail-load ✗  code=${code}  desc="${desc}"  url=${url}`);
    showWindow('did-fail-load');
  });
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    L('RENDERER', `render-process-gone  reason=${details.reason}`, JSON.stringify(details));
    if (details.reason !== 'clean-exit') {
      closeSplash();
      dialog.showMessageBox({
        type: 'error', title: 'Crash', buttons: ['Reload'],
        message: 'Renderer crashed.',
        detail: `Reason: ${details.reason}\n\nLog: ${LOG_FILE}`,
      }).then(() => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); } catch {} });
    }
  });

  // Relay renderer console to log file
  mainWindow.webContents.on('console-message', (event) => {
    const lvl = typeof event.level === 'number' ? event.level : 1;
    const msg = typeof event.message === 'string' ? event.message : String(event);
    if (lvl >= 2) L('RENDERER-CONSOLE', `[${['verbose','info','warning','error'][lvl]??'log'}] ${msg}`);
  });

  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F5' ||
          (input.control && (input.key === 'r' || input.key === 'R')) ||
          (input.meta    && (input.key === 'r' || input.key === 'R')))
        event.preventDefault();
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost:5000') || url.startsWith('http://localhost:5173'))
      return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    let allowed = isDev
      ? (navUrl.startsWith(DEV_URL) || navUrl.startsWith('http://localhost:5000'))
      : (() => {
          const prodDir = path.dirname(PROD_ENTRY).replace(/\\/g, '/');
          return navUrl.startsWith(`file:///${prodDir}`) ||
                 navUrl.startsWith(`file://${prodDir}`)  ||
                 navUrl.startsWith('http://localhost:5000');
        })();
    if (!allowed) { L('NAV', `Blocked navigation to: ${navUrl}`); event.preventDefault(); }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Load the application
  loadApp();
}

// ─── loadApp ──────────────────────────────────────────────────────────────────

function loadApp(retryCount = 0) {
  const MAX_RETRIES = 3;

  if (isDev) {
    L('LOAD', `loadURL → ${DEV_URL}  (attempt ${retryCount + 1})`);
  } else {
    const exists = fs.existsSync(PROD_ENTRY);
    L('LOAD', `loadFile → ${PROD_ENTRY}  (attempt ${retryCount + 1})`);
    L('LOAD', `  file exists: ${exists}`);
    if (!exists) L('LOAD', 'CRITICAL: index.html missing — loadFile will fail!');
  }

  const p = isDev ? mainWindow.loadURL(DEV_URL) : mainWindow.loadFile(PROD_ENTRY);
  p.then(() => L('LOAD', `loadFile/loadURL resolved OK (attempt ${retryCount + 1})`))
   .catch((err) => {
     LERR('LOAD', `Load failed (attempt ${retryCount + 1})`, err);
     closeSplash();
     if (retryCount < MAX_RETRIES) {
       L('LOAD', `Retrying in 2 s...`);
       setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) loadApp(retryCount + 1); }, 2000);
       return;
     }
     dialog.showMessageBox({
       type: 'error', title: 'Load Error',
       message: 'Failed to load Webline PMS.',
       detail: `Error: ${err.message}\n\nLog: ${LOG_FILE}`,
       buttons: ['Retry', 'Exit'], defaultId: 0, cancelId: 1,
     }).then(({ response }) => { response === 0 ? loadApp(0) : app.quit(); });
   });
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    { label: 'File', submenu: [{ role: 'quit', label: 'Exit Webline PMS' }] },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
    {
      role: 'help',
      submenu: [{
        label: 'Diagnostic Log',
        click: () => {
          dialog.showMessageBox({ type: 'info', title: 'Log Location', message: `Log file:\n${LOG_FILE}`, buttons: ['OK'] });
        },
      }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.on('app:minimize', () => mainWindow?.minimize());
ipcMain.on('app:maximize', () => { if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize(); });
ipcMain.on('app:close', () => mainWindow?.close());

// ─── Dev: wait for Vite ───────────────────────────────────────────────────────

function waitForPort(port, maxMs = 60000, interval = 500) {
  return new Promise((resolve, reject) => {
    let elapsed = 0, resolved = false;
    const check = () => {
      if (resolved) return;
      const req = http.get(`http://localhost:${port}`, (res) => {
        if (resolved) return; resolved = true;
        L('VITE', `Port ${port} ready (HTTP ${res.statusCode})`);
        resolve();
      });
      req.on('error', () => {
        if (resolved) return;
        elapsed += interval;
        if (elapsed >= maxMs) reject(new Error(`Port ${port} not ready in ${maxMs / 1000}s`));
        else setTimeout(check, interval);
      });
      req.setTimeout(400, () => req.destroy());
    };
    L('VITE', `Waiting for port ${port}...`);
    check();
  });
}

// ─── app.whenReady ────────────────────────────────────────────────────────────

L('READY', 'Registering app.whenReady() handler');

app.whenReady().then(async () => {
  L('READY', 'app.whenReady() fired ✓');

  app.setName('Webline PMS Plus');

  // Resolve all paths
  let APP_ROOT;
  try {
    const rawPath = app.getAppPath();
    APP_ROOT     = rawPath.endsWith('electron') ? path.dirname(rawPath) : rawPath;
    PRELOAD_PATH = path.join(APP_ROOT, 'electron', 'preload.js');
    SPLASH_PATH  = path.join(APP_ROOT, 'electron', 'splash.html');
    PROD_ENTRY   = path.join(APP_ROOT, 'dist', 'index.html');

    L('PATHS', `APP_ROOT     : ${APP_ROOT}`);
    L('PATHS', `PRELOAD_PATH : ${PRELOAD_PATH}  exists=${fs.existsSync(PRELOAD_PATH)}`);
    L('PATHS', `SPLASH_PATH  : ${SPLASH_PATH}   exists=${fs.existsSync(SPLASH_PATH)}`);
    L('PATHS', `PROD_ENTRY   : ${PROD_ENTRY}    exists=${!isDev ? fs.existsSync(PROD_ENTRY) : 'dev'}`);
    L('PATHS', `resourcesPath: ${process.resourcesPath}`);
  } catch (err) {
    LERR('PATHS', 'Path resolution FAILED', err);
    return;
  }

  // Load app-specific modules (dynamic, so failures are caught)
  await loadModules(APP_ROOT);

  try { buildMenu(); } catch (e) { LERR('MENU', 'buildMenu threw', e); }

  try { createSplashWindow(); } catch (e) { LERR('SPLASH', 'createSplashWindow threw', e); }

  if (!isDev) {
    // ── PRODUCTION ────────────────────────────────────────────────────────────
    L('BACKEND', 'Production mode — launching backend');
    try {
      const backendRoot = app.isPackaged ? process.resourcesPath : path.join(APP_ROOT, '..');
      const serverPath  = path.join(backendRoot, 'backend', 'server.js');
      L('BACKEND', `backendRoot  : ${backendRoot}`);
      L('BACKEND', `server.js    : ${serverPath}`);
      L('BACKEND', `server exists: ${fs.existsSync(serverPath)}`);

      if (launchBackend) {
        launchBackend(backendRoot);
        L('BACKEND', 'launchBackend() called — waiting for health check...');
      } else {
        L('BACKEND', 'launchBackend not available (import failed) — assuming backend already running');
      }

      if (waitForBackend) {
        await waitForBackend(5000, 30000);
        L('BACKEND', 'Backend health check PASSED ✓');
      } else {
        L('BACKEND', 'waitForBackend not available — skipping health check');
      }
    } catch (err) {
      LERR('BACKEND', 'Backend startup failed', err);
      closeSplash();
      try {
        const { response } = await dialog.showMessageBox({
          type: 'error', title: 'Backend Failed',
          message: 'The Webline PMS server failed to start.',
          detail: `Error: ${err.message}\n\nLog: ${LOG_FILE}`,
          buttons: ['Continue anyway', 'Exit'],
        });
        if (response === 1) { app.quit(); return; }
        L('BACKEND', 'User chose "Continue anyway" despite backend failure');
      } catch (de) { LERR('BACKEND', 'dialog.showMessageBox threw', de); }
    }
  } else {
    // ── DEVELOPMENT ───────────────────────────────────────────────────────────
    L('VITE', 'Dev mode — waiting for Vite on port 5173');
    try { await waitForPort(5173, 60000); }
    catch (err) { L('VITE', `Vite not ready: ${err.message} — continuing anyway`); }
  }

  L('WINDOW', 'Calling createWindow()');
  try {
    createWindow();
  } catch (err) {
    LERR('WINDOW', 'createWindow() threw — this is fatal', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try { createSplashWindow(); createWindow(); } catch {}
    }
  });

}).catch((err) => {
  LERR('READY', 'app.whenReady() promise REJECTED — this is fatal', err);
  process.exit(1);
});

L('READY', 'Module evaluation complete — waiting for app.ready event');
