import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Resolve Paths ────────────────────────────────────────────────────────────
// Assuming this file is located in 'electron/branding.js'
const PROJECT_ROOT = path.join(__dirname, '..');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'assets');

/**
 * Reusable branding configuration for Webline PMS.
 * This configuration centralizes all application branding so it can be used
 * across the main process (BrowserWindow), electron-builder (installer), 
 * and future splash screens.
 */
const BRANDING_CONFIG = {
  // ─── Application Naming ─────────────────────────────────────────────────────
  productName: 'Webline PMS Plus',
  appId: 'com.webline.pms',

  // ─── Window Configuration ───────────────────────────────────────────────────
  windowTitle: 'Webline PMS Plus',

  // ─── Asset Paths ────────────────────────────────────────────────────────────
  // Place future app icons here:
  // - assets/icons/icon.ico (for Windows)
  // - assets/icons/icon.icns (for macOS)
  // - assets/icons/icon.png (for Linux/General fallback - preferably 512x512)
  appIcon: path.join(ASSETS_DIR, 'icons', 'icon.png'),

  // Place future splash screen logo here:
  splashLogo: path.join(ASSETS_DIR, 'images', 'splash-logo.png'),
  
  // Place installer sidebar/header images here:
  installerIcon: path.join(ASSETS_DIR, 'icons', 'installer-icon.bmp'),
};

export default BRANDING_CONFIG;
