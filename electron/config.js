/**
 * electron/config.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH for all Electron startup configuration.
 *
 * Every startup path reads ONLY from here — no duplicated URLs in main.js.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STARTUP MODES  (set by npm scripts via cross-env ELECTRON_MODE=...)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  local        npm run electron:local
 *               Requires: npm run dev  +  npm run backend:dev
 *               Loads:    http://localhost:5173  (Vite dev server)
 *               Backend:  EXTERNAL — Electron NEVER spawns it
 *
 *  docker-dev   npm run electron:docker-dev
 *               Requires: docker compose up -d  +  npm run dev
 *               Loads:    http://localhost:5173  (Vite dev server)
 *               Backend:  DOCKER — Electron NEVER spawns it
 *
 *  docker       npm run electron:docker
 *               Requires: docker compose up -d  +  npm run build
 *               Loads:    dist/index.html  (production build)
 *               Backend:  DOCKER — Electron NEVER spawns it
 *
 *  production   electron-builder installer  (app.isPackaged = true)
 *               Loads:    dist/index.html  (bundled in asar)
 *               Backend:  SPAWNED by Electron from extraResources/backend/
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Mode detection ───────────────────────────────────────────────────────────
// Value is injected by npm scripts via cross-env. Never hardcoded at runtime.
const ELECTRON_MODE = process.env.ELECTRON_MODE || 'local';

export const MODES = Object.freeze({
  LOCAL:      'local',
  DOCKER_DEV: 'docker-dev',
  DOCKER:     'docker',
  PRODUCTION: 'production',
});

// ─── Derived flags ────────────────────────────────────────────────────────────

/**
 * true  → Electron loads http://localhost:5173 (Vite dev server must be running)
 * false → Electron loads dist/index.html       (production build must exist)
 */
export const USES_VITE = ELECTRON_MODE === MODES.LOCAL || ELECTRON_MODE === MODES.DOCKER_DEV;

/**
 * true  → Electron spawns backend/server.js from extraResources (packaged installer only)
 * false → Backend is external (local process or Docker) — Electron NEVER spawns it
 *
 * Development modes MUST NEVER set this to true.
 */
export const SPAWNS_BACKEND = ELECTRON_MODE === MODES.PRODUCTION;

// ─── URL constants ────────────────────────────────────────────────────────────

/** Vite dev server — fixed to :5173 with strictPort, never drifts */
export const VITE_URL = 'http://localhost:5173';

/** Express backend API base URL — reads VITE_API_BASE_URL or defaults to localhost:5000 */
export const API_BASE_URL = (process.env.VITE_API_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');


/** Backend health check endpoint polled before window opens */
export const HEALTH_URL = `${API_BASE_URL}/api/health`;

// ─── Default export ───────────────────────────────────────────────────────────

const config = {
  ELECTRON_MODE,
  MODES,
  USES_VITE,
  SPAWNS_BACKEND,
  VITE_URL,
  API_BASE_URL,
  HEALTH_URL,
};

export default config;
