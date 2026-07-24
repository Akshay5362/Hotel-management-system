/**
 * electron/backend-launcher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Spawns and manages the Express backend server as a child process.
 *
 * DIAGNOSTIC MODE: All backend stdout/stderr, exit events, and errors are
 * written synchronously to resources/logs/backend.log so the exact failure
 * point is visible even when the process exits immediately.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn } from 'child_process';
import path   from 'path';
import { fileURLToPath } from 'url';
import http   from 'http';
import fs     from 'fs';
import os     from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Backend log ──────────────────────────────────────────────────────────────
// Written with appendFileSync so every line is on disk before the next runs.

let BLOG = null;  // backend log file path

function initBackendLog(resourcesPath) {
  const dirs = [
    resourcesPath ? path.join(resourcesPath, 'logs') : null,
    (() => { try { return path.join(
      (typeof app !== 'undefined' ? app.getPath('userData') : null) ?? os.homedir(),
      'webline-logs'
    ); } catch { return path.join(os.homedir(), 'webline-logs'); } })(),
    path.join(os.homedir(), 'Desktop'),
    os.tmpdir(),
  ].filter(Boolean);

  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'backend.log');
      fs.writeFileSync(f, '');  // truncate/create
      BLOG = f;
      break;
    } catch { /* try next */ }
  }
}

function blog(tag, msg) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `[${ts}] [${tag}] ${msg}\n`;
  try { process.stdout.write(line); } catch {}
  if (BLOG) { try { fs.appendFileSync(BLOG, line); } catch {} }
}

function blogSection(title) {
  const bar = '─'.repeat(60);
  blog('────', bar);
  blog('SECT', title);
  blog('────', bar);
}

// ─── State ────────────────────────────────────────────────────────────────────

let backendProcess = null;

// ─── waitForBackend ───────────────────────────────────────────────────────────

export function waitForBackend(port = 5000, maxWaitMs = 30000, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    let elapsed = 0;
    let resolved = false;

    const check = () => {
      if (resolved) return;
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        if (resolved) return;
        if (res.statusCode === 200) {
          resolved = true;
          blog('HEALTH', `✓ Backend health check PASSED on port ${port} (HTTP ${res.statusCode})`);
          resolve();
        } else {
          blog('HEALTH', `Health check returned HTTP ${res.statusCode} — retrying...`);
          retry();
        }
      });
      req.on('error', (e) => {
        if (resolved) return;
        // Don't log every retry — only log first and every 5s
        if (elapsed === 0 || elapsed % 5000 === 0) {
          blog('HEALTH', `Waiting for backend... elapsed=${elapsed}ms  error=${e.code}`);
        }
        retry();
      });
      req.setTimeout(400, () => { req.destroy(); });
    };

    const retry = () => {
      if (resolved) return;
      elapsed += intervalMs;
      if (elapsed >= maxWaitMs) {
        blog('HEALTH', `✗ Backend did NOT become healthy within ${maxWaitMs / 1000}s`);
        blog('HEALTH', `  Last known backend process state: ${backendProcess ? `pid=${backendProcess.pid} killed=${backendProcess.killed}` : 'null (process exited)'}`);
        reject(new Error(`Backend did not start within ${maxWaitMs / 1000}s`));
        return;
      }
      setTimeout(check, intervalMs);
    };

    check();
  });
}

// ─── resolveNodeBin ───────────────────────────────────────────────────────────

function resolveNodeBin() {
  const envNode = process.env.NODE_EXE_PATH;
  if (envNode) { blog('NODE', `Using NODE_EXE_PATH override: ${envNode}`); return envNode; }

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const isWin    = process.platform === 'win32';
  const ext      = isWin ? 'node.exe' : 'node';
  const found    = pathDirs.map(d => path.join(d, ext)).find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (found) { blog('NODE', `Resolved node from PATH: ${found}`); return found; }

  if (isWin) {
    const winLocations = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
    ];
    for (const loc of winLocations) {
      try { if (fs.existsSync(loc)) { blog('NODE', `Found node at known location: ${loc}`); return loc; } } catch {}
    }
  }

  blog('NODE', 'WARNING: Could not locate node executable; falling back to bare "node"');
  return isWin ? 'node.exe' : 'node';
}

// ─── checkHealthOnce ────────────────────────────────────────────────────────────

function checkHealthOnce(port = 5000, timeout = 1000) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeout, () => { req.destroy(); resolve(false); });
  });
}

// ─── launchBackend ────────────────────────────────────────────────────────────

export async function launchBackend(appRoot) {
  // Determine resources path for log init
  const resourcesPath = process.resourcesPath || appRoot;
  initBackendLog(resourcesPath);

  blogSection('BACKEND LAUNCHER STARTED');
  blog('INIT', `appRoot          : ${appRoot}`);
  blog('INIT', `resourcesPath    : ${process.resourcesPath || '(not available)'}`);
  blog('INIT', `isPackaged       : ${typeof app !== 'undefined' ? 'check main process' : process.env.ELECTRON_IS_DEV !== '1'}`);
  blog('INIT', `backend.log path : ${BLOG}`);
  blog('INIT', `Platform         : ${process.platform}`);
  blog('INIT', `Electron exe     : ${process.execPath}`);

  if (backendProcess) {
    blog('INIT', 'Backend already running — skipping relaunch');
    return;
  }

  // ── Check if another backend is already running ───────────────────────────
  const isHealthy = await checkHealthOnce(5000, 1000);
  if (isHealthy) {
    blog('INIT', 'Existing backend detected on port 5000.');
    return;
  }

  // ── Locate server.js ────────────────────────────────────────────────────────
  const backendDir  = path.join(appRoot, 'backend');
  const backendPath = path.join(backendDir, 'server.js');

  blog('FILES', `backendDir       : ${backendDir}`);
  blog('FILES', `server.js        : ${backendPath}`);
  blog('FILES', `server.js exists : ${fs.existsSync(backendPath)}`);
  blog('FILES', `package.json     : ${path.join(backendDir, 'package.json')} exists=${fs.existsSync(path.join(backendDir, 'package.json'))}`);
  blog('FILES', `.env             : ${path.join(backendDir, '.env')} exists=${fs.existsSync(path.join(backendDir, '.env'))}`);
  blog('FILES', `node_modules     : ${path.join(backendDir, 'node_modules')} exists=${fs.existsSync(path.join(backendDir, 'node_modules'))}`);

  // Log .env contents (redact passwords)
  try {
    const envPath = path.join(backendDir, '.env');
    if (fs.existsSync(envPath)) {
      const envLines = fs.readFileSync(envPath, 'utf8').split('\n')
        .map(l => l.replace(/(PASSWORD|PASS|SECRET|KEY)\s*=.*/i, '$1=[REDACTED]'))
        .join('\n');
      blog('ENV', `.env contents:\n${envLines}`);
    }
  } catch (e) { blog('ENV', `Could not read .env: ${e.message}`); }

  // Log backend package.json type field
  try {
    const pkgPath = path.join(backendDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      blog('PKG', `backend package.json: name=${pkg.name} type=${pkg.type} main=${pkg.main}`);
    }
  } catch (e) { blog('PKG', `Could not read backend package.json: ${e.message}`); }

  if (!fs.existsSync(backendPath)) {
    blog('ERROR', `✗ server.js NOT FOUND at: ${backendPath}`);
    blog('ERROR', 'extraResources may not have been copied. Cannot launch backend.');
    return;
  }

  // ── Resolve node ─────────────────────────────────────────────────────────────
  const nodeExe = resolveNodeBin();

  // Verify node executable works
  blog('NODE', `node exe         : ${nodeExe}`);
  blog('NODE', `node exe exists  : ${fs.existsSync(nodeExe)}`);

  // ── Spawn environment ────────────────────────────────────────────────────────
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT:     '5000',
  };

  blog('SPAWN', `Command: "${nodeExe}" "${backendPath}"`);
  blog('SPAWN', `CWD    : ${backendDir}`);
  blog('SPAWN', `PORT   : ${env.PORT}`);
  blog('SPAWN', 'Spawning backend process...');

  try {
    backendProcess = spawn(nodeExe, [backendPath], {
      cwd:         backendDir,
      env,
      stdio:       ['ignore', 'pipe', 'pipe'],
      detached:    false,
      windowsHide: true,
    });
  } catch (spawnErr) {
    blog('ERROR', `✗ spawn() threw synchronously: ${spawnErr.message}`);
    blog('ERROR', spawnErr.stack || String(spawnErr));
    backendProcess = null;
    return;
  }

  if (!backendProcess || !backendProcess.pid) {
    blog('ERROR', '✗ spawn() returned no PID — process failed to start');
    backendProcess = null;
    return;
  }

  blog('SPAWN', `✓ Backend process spawned. PID: ${backendProcess.pid}`);

  // ── Pipe all stdout to log ───────────────────────────────────────────────────
  backendProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      text.split('\n').forEach(line => blog('STDOUT', line));
    }
  });

  // ── Pipe all stderr to log ───────────────────────────────────────────────────
  backendProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      text.split('\n').forEach(line => blog('STDERR', line));
    }
  });

  // ── Exit event ───────────────────────────────────────────────────────────────
  backendProcess.on('exit', async (code, signal) => {
    blog('EXIT', `Backend process exited — code: ${code}  signal: ${signal}`);
    
    const healthyNow = await checkHealthOnce(5000, 1000);
    if (healthyNow) {
      blog('EXIT', 'Backend exited, but port 5000 is healthy. Assuming another backend is running. Continuing normally.');
      backendProcess = null;
      return;
    }

    if (code !== 0 && code !== null) {
      blog('EXIT', `✗ Backend exited with non-zero code ${code} — this is why health check fails`);
    }
    backendProcess = null;
  });

  // ── Error event (spawn failure) ───────────────────────────────────────────────
  backendProcess.on('error', (err) => {
    blog('ERROR', `✗ Backend spawn error: ${err.message}`);
    blog('ERROR', `  code: ${err.code}  path: ${err.path}`);
    blog('ERROR', err.stack || String(err));
    backendProcess = null;
  });

  blogSection('Backend process started — waiting for health check');
}

// ─── killBackend ──────────────────────────────────────────────────────────────

export function killBackend() {
  if (backendProcess && !backendProcess.killed) {
    blog('KILL', 'Killing backend process...');
    backendProcess.kill('SIGTERM');
    backendProcess = null;
  }
}
