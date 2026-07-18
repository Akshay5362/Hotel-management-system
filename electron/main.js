/**
 * electron/main.js
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ELECTRON ENTRY POINT — the main process.
 *
 * PURPOSE:
 *   Creates and manages the application window (BrowserWindow).
 *   Decides whether to load the Vite dev server URL (development) or
 *   the built React files from ./dist (production).
 *   Handles app lifecycle events (ready, window-all-closed, activate).
 *   Handles IPC messages from the renderer (via preload.js).
 *
 * STARTUP FLOW:
 *   electron .
 *     └─ main.js: app.whenReady()
 *         └─ createWindow()
 *             ├─ DEV:  loadURL('http://localhost:5173')   ← Vite dev server
 *             └─ PROD: loadFile('./dist/index.html')      ← vite build output
 *
 * HOW THIS FILE RELATES TO OTHERS:
 *   main.js   ←  imports config.js  (all settings in one place)
 *   main.js   →  loads preload.js   (injected into renderer before page load)
 *   main.js   ↔  renderer (React)   (via ipcMain / ipcRenderer in preload.js)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// NOTE: Electron's main process uses CommonJS (require), not ES Modules.
// config.js uses ES Module syntax, so we use a dynamic import() wrapper below.

import { app, BrowserWindow, ipcMain, shell, Menu, dialog } from 'electron';
import path from 'path';
import BRANDING_CONFIG from './branding.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Resolve paths ────────────────────────────────────────────────────────────

const ELECTRON_DIR  = __dirname;                            // .../hotel/electron/
const PROJECT_ROOT  = path.join(ELECTRON_DIR, '..');        // .../hotel/
const PRELOAD_PATH  = path.join(ELECTRON_DIR, 'preload.js');
const PROD_ENTRY    = path.join(PROJECT_ROOT, 'dist', 'index.html');
const DEV_URL       = 'http://localhost:5173';

// ─── Environment detection ────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV !== 'production';

// ─── Window settings ─────────────────────────────────────────────────────────

const WINDOW_CONFIG = {
  // Initial window dimensions (before maximize is called)
  width          : 1400,
  height         : 880,
  
  // Set minimum window size (1280x720) to prevent UI breaking
  minWidth       : 1280,
  minHeight      : 720,
  
  // Set application title from branding configuration
  title          : BRANDING_CONFIG.windowTitle,
  
  // prevents white flash before React renders by matching dark mode background
  backgroundColor: '#0d1117',  
  
  // hidden until 'ready-to-show' fires to avoid flashing unrendered content
  show           : false,      
  
  // Window Control Behaviors: Allow minimize, maximize and resize
  resizable      : true,
  maximizable    : true,
  minimizable    : true,
  
  // App icon sourced from central branding configuration
  // Ensures the app has a custom logo in the taskbar and title bar when enabled
  icon           : BRANDING_CONFIG.appIcon,

  webPreferences: {
    // ── SECURITY (DO NOT CHANGE) ──────────────────────────────────────────
    // renderer JS runs in isolated context — REQUIRED for security
    contextIsolation : true,   
    // renderer has NO access to Node.js APIs — REQUIRED for security
    nodeIntegration  : false,  
    // allow preload.js to use contextBridge by turning off aggressive sandboxing
    sandbox          : false,  
    // enforce same-origin (dev: Vite, prod: file://) to prevent XSS issues
    webSecurity      : true,   
    // Disable developer tools in production builds at the webPreferences level
    devTools         : isDev,  

    // ── Preload script ────────────────────────────────────────────────────
    // loaded before renderer, provides secure contextBridge access
    preload: PRELOAD_PATH,     
  },
};

// ─── Main window reference ────────────────────────────────────────────────────
// Kept at module scope so IPC handlers and platform-specific code can access it.

let mainWindow = null;
let splashWindow = null; // Holds reference to the splash screen

// ─────────────────────────────────────────────────────────────────────────────
// createSplashWindow()
// Creates a small, borderless loading screen while the React app initializes.
// ─────────────────────────────────────────────────────────────────────────────

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,             // Borderless window
    alwaysOnTop: true,        // Keep splash on top of other windows
    icon: BRANDING_CONFIG.appIcon,
    backgroundColor: '#0d1117', // Match splash.html background to avoid flash
    webPreferences: {
      nodeIntegration: false, // Maintain secure architecture
      contextIsolation: true  // Maintain secure architecture
    }
  });

  splashWindow.loadFile(path.join(ELECTRON_DIR, 'splash.html'));

  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// createWindow()
// Creates the BrowserWindow and loads the correct URL/file.
// ─────────────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow(WINDOW_CONFIG);

  // ── Show window gracefully (no white flash) ──────────────────────────────
  mainWindow.once('ready-to-show', () => {
    // 1. Destroy splash screen once main application is fully loaded
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }

    // 2. Start maximized automatically for a professional desktop app feel
    mainWindow.maximize(); 
    
    // Show window only after rendering is ready
    mainWindow.show();
    
    if (isDev) {
      // Keep developer tools enabled only during development
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // ── Disable DevTools in Production ───────────────────────────────────────
  // Adds an extra layer of security to ensure users cannot open devtools in prod
  if (!isDev) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });
  }

  // ── Handle Renderer Crashes ──────────────────────────────────────────────
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    // Only intercept abnormal exits (like OOM, crashes, kills)
    if (details.reason !== 'clean-exit') {
      console.error('[Electron] Renderer process crashed:', details.reason);
      
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close(); // Prevent splash from hiding the error dialog
      }

      dialog.showMessageBox({
        type: 'error',
        title: 'Application Crash',
        message: 'The application encountered an unexpected error and crashed.',
        detail: `Crash Reason: ${details.reason}\n\nThe application will now attempt to reload.`,
        buttons: ['Reload Application']
      }).then(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      });
    }
  });

  // ── Load the React app with Retry Logic ──────────────────────────────────
  const loadApplication = () => {
    if (isDev) {
      console.log(`[Electron] DEV mode — loading ${DEV_URL}`);
    } else {
      console.log(`[Electron] PROD mode — loading ${PROD_ENTRY}`);
    }

    const loadPromise = isDev 
      ? mainWindow.loadURL(DEV_URL) 
      : mainWindow.loadFile(PROD_ENTRY);

    loadPromise.catch((err) => {
      console.error('[Electron] Failed to load application:', err.message);
      
      // Close splash screen if it's still open to prevent blank/dead screen
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
      }

      if (mainWindow.isDestroyed()) return;

      // Show user-friendly error dialog for connection failures
      dialog.showMessageBox({
        type: 'error',
        title: 'Connection Error',
        message: 'Failed to connect to the Webline PMS interface.',
        detail: `The application encountered an error while loading. Please verify that the required backend services are running.\n\nError details: ${err.message}\n\nWould you like to retry?`,
        buttons: ['Retry', 'Exit Application'],
        defaultId: 0,
        cancelId: 1
      }).then(({ response }) => {
        if (response === 0) {
          // Retry loading the backend when possible
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              loadApplication();
            }
          }, 1000);
        } else {
          app.quit();
        }
      });
    });
  };

  loadApplication();

  // ── Open external links in the system browser, not inside Electron ───────
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost:5000')) {
      // Allow API calls to backend to pass through inside Electron
      return { action: 'allow' };
    }
    // Open all other external URLs (e.g. payment gateway pages, docs) in the user's default browser
    shell.openExternal(url);
    return { action: 'deny' }; // Prevent opening inside the Electron app itself
  });

  // ── Prevent accidental navigation outside the application ────────────────
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    const appUrl = isDev ? DEV_URL : `file://${PROD_ENTRY}`;
    // If navigation doesn't belong to the Vite server/Prod file or the backend API, block it
    if (!navUrl.startsWith(appUrl) && !navUrl.startsWith('http://localhost:5000')) {
      event.preventDefault(); // Stop the navigation completely
    }
  });

  // ── Clean up reference on close ──────────────────────────────────────────
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC Handlers
// These respond to messages sent from the renderer via preload.js
// ─────────────────────────────────────────────────────────────────────────────

// Return app version string (used by renderer: window.electronAPI.getAppVersion())
ipcMain.handle('app:get-version', () => app.getVersion());

// Window control handlers (for a future custom titlebar)
ipcMain.on('app:minimize', () => mainWindow?.minimize());
ipcMain.on('app:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('app:close', () => mainWindow?.close());

// ─────────────────────────────────────────────────────────────────────────────
// Application Menu
// Minimal menu — removes the default Electron menu in production.
// You can extend this later with Print, Export, Settings items.
// ─────────────────────────────────────────────────────────────────────────────

function buildMenu() {
  // Define the base professional menu
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        // Keep development tools and shortcuts enabled only during development
        ...(isDev ? [
          { role: 'reload' },        // Reload shortcut enabled in dev
          { role: 'forceReload' },   // Force Reload shortcut enabled in dev
          { role: 'toggleDevTools' },
          { type: 'separator' }
        ] : []),
        // In production, users can only toggle fullscreen
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: `About ${BRANDING_CONFIG.productName}`,
          click: async () => {
            // Displays a professional native About dialog
            await dialog.showMessageBox(mainWindow, {
              title: `About ${BRANDING_CONFIG.productName}`,
              type: 'info',
              message: BRANDING_CONFIG.productName,
              detail: 'A professional Hotel Property Management System.\nVersion: ' + app.getVersion(),
              icon: BRANDING_CONFIG.appIcon
            });
          }
        }
      ]
    }
  ];

  // If macOS, prepend the required App menu for native feel
  if (process.platform === 'darwin') {
    template.unshift({
      label: BRANDING_CONFIG.productName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  // Set the custom menu, overriding all default unnecessary Electron items
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────────────────────────────────────────────────────────
// App Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Set product name at the OS level
  app.setName(BRANDING_CONFIG.productName);

  buildMenu();
  createSplashWindow(); // Show splash immediately
  createWindow();       // Start loading main window in background

  // macOS: re-create window when dock icon is clicked and no windows are open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplashWindow();
      createWindow();
    }
  });
});

// Windows / Linux: quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ─── Future: Add electron-updater here ───────────────────────────────────────
// import { autoUpdater } from 'electron-updater';
// app.whenReady().then(() => autoUpdater.checkForUpdatesAndNotify());
