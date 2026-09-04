/**
 * electron/backend-launcher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Spawns and manages the embedded Express backend server as a child process.
 *
 * PRODUCTION HARDENED:
 * - Directs all logs to app.getPath('userData')/logs/backend.log (100% user-writable).
 * - Safe port 5000 conflict detection (verifies HPMS process ownership before terminating).
 * - Immediate fail-fast with exact error diagnostics if the backend exits prematurely.
 * - Robust path resolution for packaged extraResources.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { app } from 'electron';
import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Logging ──────────────────────────────────────────────────────────────────
let BLOG = null;
const recentLogs = [];
const MAX_LOG_BUFFER = 50;

export function initBackendLog(resourcesPath) {
  try {
    const userDataDir = app && typeof app.getPath === 'function' 
      ? path.join(app.getPath('userData'), 'logs') 
      : path.join(os.homedir(), '.hpms-logs');
    
    fs.mkdirSync(userDataDir, { recursive: true });
    const logPath = path.join(userDataDir, 'backend.log');
    fs.writeFileSync(logPath, ''); // Create / truncate on startup
    BLOG = logPath;
  } catch (err) {
    // Fallback to temp
    try {
      const tempPath = path.join(os.tmpdir(), 'hpms-backend.log');
      fs.writeFileSync(tempPath, '');
      BLOG = tempPath;
    } catch {}
  }
}

export function blog(tag, msg) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `[${ts}] [${tag}] ${msg}`;
  recentLogs.push(line);
  if (recentLogs.length > MAX_LOG_BUFFER) recentLogs.shift();

  try { process.stdout.write(line + '\n'); } catch {}
  if (BLOG) {
    try { fs.appendFileSync(BLOG, line + '\n'); } catch {}
  }
}

export function blogSection(title) {
  const bar = '─'.repeat(60);
  blog('────', bar);
  blog('SECT', title);
  blog('────', bar);
}

export function getLastBackendError() {
  const errorLines = recentLogs.filter(l => l.includes('[STDERR]') || l.includes('[ERROR]') || l.includes('[EXIT]'));
  if (errorLines.length > 0) {
    return errorLines.slice(-10).join('\n');
  }
  return recentLogs.slice(-10).join('\n');
}

// ─── State ────────────────────────────────────────────────────────────────────
let backendProcess = null;
let prematureExitError = null;

// ─── Safe Port 5000 Inspector & Cleanup ───────────────────────────────────────

/**
 * Checks whether port 5000 is in use.
 * If in use:
 * 1. Checks if it is already a healthy HPMS backend (/api/health -> hotel-pms-backend). If so, returns true (reuse).
 * 2. On Windows, inspects the listening PID using netstat/wmic.
 *    - If the PID belongs to an HPMS process (HPMS.exe or contains server.js), terminates it safely.
 *    - If the PID belongs to another unrelated application, DOES NOT kill it and throws a descriptive error.
 */
// A single 1.5s health-check attempt can race a cold Docker start: on boot,
// the hotel_pms_backend container may still be starting when Electron
// launches, so one quick check can wrongly conclude the port is free —
// leading the embedded backend to spawn and immediately lose an EADDRINUSE
// race once Docker finishes binding the port. Retrying the health check a
// few times over a short window (bounded, not an arbitrary long delay) gives
// Docker room to come up before falling through to the port-ownership
// inspection / embedded-backend fallback below.
const PORT_HEALTH_RETRY_ATTEMPTS   = 5;
const PORT_HEALTH_RETRY_DELAY_MS   = 1000;
const PORT_HEALTH_CHECK_TIMEOUT_MS = 1500;

async function inspectAndHandlePortConflict(port = 5000) {
  blog('PORT', `Inspecting port ${port} status...`);

  for (let attempt = 1; attempt <= PORT_HEALTH_RETRY_ATTEMPTS; attempt++) {
    const isHealthy = await checkHealthOnce(port, PORT_HEALTH_CHECK_TIMEOUT_MS);
    if (isHealthy) {
      blog('PORT', `✓ Existing healthy HPMS backend detected on port ${port} (attempt ${attempt}/${PORT_HEALTH_RETRY_ATTEMPTS}). Reusing instance.`);
      return { canReuse: true };
    }
    if (attempt < PORT_HEALTH_RETRY_ATTEMPTS) {
      blog('PORT', `Port ${port} not healthy yet (attempt ${attempt}/${PORT_HEALTH_RETRY_ATTEMPTS}) — retrying in ${PORT_HEALTH_RETRY_DELAY_MS}ms (allowing for a cold Docker start)...`);
      await new Promise((resolve) => setTimeout(resolve, PORT_HEALTH_RETRY_DELAY_MS));
    }
  }
  blog('PORT', `Port ${port} did not become healthy after ${PORT_HEALTH_RETRY_ATTEMPTS} attempts — proceeding to port-ownership inspection.`);

  if (process.platform !== 'win32') {
    return { canReuse: false };
  }

  try {
    const netstatOut = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = netstatOut.split('\n').map(l => l.trim()).filter(Boolean);
    const listeningLines = lines.filter(l => l.toUpperCase().includes('LISTENING'));

    if (listeningLines.length === 0) {
      blog('PORT', `Port ${port} is free.`);
      return { canReuse: false };
    }

    // Extract listening PIDs
    const pids = [...new Set(listeningLines.map(l => {
      const parts = l.split(/\s+/);
      return parts[parts.length - 1];
    }).filter(p => /^\d+$/.test(p)))];

    blog('PORT', `Found listening PID(s) on port ${port}: ${pids.join(', ')}`);

    for (const pid of pids) {
      // Inspect process command line / executable
      let processInfo = '';
      try {
        processInfo = execSync(`wmic process where "ProcessId=${pid}" get CommandLine,ExecutablePath /format:list`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch {
        try {
          processInfo = execSync(`tasklist /fi "PID eq ${pid}" /fo list`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          });
        } catch {}
      }

      const isHpmsProcess = (
        processInfo.toLowerCase().includes('hpms') ||
        processInfo.toLowerCase().includes('server.js') ||
        processInfo.toLowerCase().includes('hotel-pms-backend')
      );

      if (isHpmsProcess) {
        blog('PORT', `PID ${pid} is identified as a stale HPMS process. Terminating safely...`);
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          blog('PORT', `✓ Stale HPMS PID ${pid} terminated.`);
        } catch (killErr) {
          blog('PORT', `Warning: Failed to terminate stale HPMS PID ${pid}: ${killErr.message}`);
        }
      } else {
        blog('PORT', `✗ PID ${pid} does NOT belong to HPMS. Process info:\n${processInfo}`);
        throw new Error(`Port ${port} is already in use by another application (PID ${pid}). Please close conflicting software before starting HPMS.`);
      }
    }

    // Short pause after cleanup
    await new Promise(r => setTimeout(r, 500));
  } catch (err) {
    if (err.message && err.message.includes('already in use by another application')) {
      throw err;
    }
    // Netstat returned 1 when nothing matched -> port is free
  }

  return { canReuse: false };
}

// ─── Health Check Probe ───────────────────────────────────────────────────────

export function checkHealthOnce(port = 5000, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(res.statusCode === 200 && parsed.status === 'ok');
        } catch {
          resolve(res.statusCode === 200);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeout, () => { req.destroy(); resolve(false); });
  });
}

// ─── waitForBackend ───────────────────────────────────────────────────────────

export function waitForBackend(port = 5000, maxWaitMs = 30000, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    let elapsed = 0;
    let resolved = false;

    const check = () => {
      if (resolved) return;

      // Fail fast if the child process has already crashed/exited
      if (prematureExitError) {
        resolved = true;
        blog('HEALTH', `✗ Backend child process failed: ${prematureExitError}`);
        reject(new Error(prematureExitError));
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        if (resolved) return;
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolved = true;
            blog('HEALTH', `✓ Backend health check PASSED on port ${port} (HTTP ${res.statusCode})`);
            resolve();
          } else {
            blog('HEALTH', `Health check returned HTTP ${res.statusCode} — retrying...`);
            retry();
          }
        });
      });

      req.on('error', (e) => {
        if (resolved) return;
        if (elapsed === 0 || elapsed % 5000 === 0) {
          blog('HEALTH', `Waiting for backend... elapsed=${elapsed}ms  error=${e.code}`);
        }
        retry();
      });

      req.setTimeout(800, () => { req.destroy(); });
    };

    const retry = () => {
      if (resolved) return;
      elapsed += intervalMs;
      if (elapsed >= maxWaitMs) {
        blog('HEALTH', `✗ Backend did NOT become healthy within ${maxWaitMs / 1000}s`);
        const diag = getLastBackendError();
        reject(new Error(`Backend did not start within ${maxWaitMs / 1000}s.\n\nRecent backend logs:\n${diag}`));
        return;
      }
      setTimeout(check, intervalMs);
    };

    check();
  });
}

// ─── Node Binary Resolver ─────────────────────────────────────────────────────

function resolveNodeBin(isPackaged = false) {
  const envNode = process.env.NODE_EXE_PATH;
  if (envNode && fs.existsSync(envNode)) {
    blog('NODE', `Using NODE_EXE_PATH override: ${envNode}`);
    return { bin: envNode, useRunAsNode: false };
  }

  // In packaged mode (or when running standalone), use Electron's embedded binary with ELECTRON_RUN_AS_NODE=1
  if (isPackaged && process.execPath && fs.existsSync(process.execPath)) {
    blog('NODE', `Packaged mode: using embedded Electron binary (${process.execPath}) with ELECTRON_RUN_AS_NODE=1`);
    return { bin: process.execPath, useRunAsNode: true };
  }

  // Development PATH resolution
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const isWin    = process.platform === 'win32';
  const ext      = isWin ? 'node.exe' : 'node';
  const found    = pathDirs.map(d => path.join(d, ext)).find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (found) {
    blog('NODE', `Resolved node from PATH: ${found}`);
    return { bin: found, useRunAsNode: false };
  }

  // Fallback to Electron execPath with ELECTRON_RUN_AS_NODE
  if (process.execPath && fs.existsSync(process.execPath)) {
    blog('NODE', `Fallback: using Electron binary (${process.execPath}) with ELECTRON_RUN_AS_NODE=1`);
    return { bin: process.execPath, useRunAsNode: true };
  }

  return { bin: isWin ? 'node.exe' : 'node', useRunAsNode: false };
}

// ─── launchBackend ────────────────────────────────────────────────────────────

export async function launchBackend(appRoot) {
  const isPackaged = app && typeof app.isPackaged === 'boolean' ? app.isPackaged : (process.env.ELECTRON_IS_DEV !== '1' && !process.defaultApp);
  const resourcesPath = process.resourcesPath || appRoot;

  initBackendLog(resourcesPath);
  prematureExitError = null;

  blogSection('HPMS EMBEDDED BACKEND LAUNCHER');
  blog('INIT', `appRoot          : ${appRoot}`);
  blog('INIT', `resourcesPath    : ${process.resourcesPath || '(not available)'}`);
  blog('INIT', `isPackaged       : ${isPackaged}`);
  blog('INIT', `backend.log path : ${BLOG}`);
  blog('INIT', `Platform         : ${process.platform}`);
  blog('INIT', `Electron exe     : ${process.execPath}`);

  if (backendProcess && backendProcess.pid && !backendProcess.killed) {
    blog('INIT', `Backend process PID ${backendProcess.pid} is already active.`);
    return;
  }

  // 1. Check Port 5000 & Handle Conflicts
  const conflictResult = await inspectAndHandlePortConflict(5000);
  if (conflictResult.canReuse) {
    return;
  }

  // 2. Locate backend/server.js
  let backendDir = path.join(appRoot, 'backend');
  let backendPath = path.join(backendDir, 'server.js');

  if (!fs.existsSync(backendPath) && process.resourcesPath) {
    const resBackendDir = path.join(process.resourcesPath, 'backend');
    const resBackendPath = path.join(resBackendDir, 'server.js');
    if (fs.existsSync(resBackendPath)) {
      backendDir = resBackendDir;
      backendPath = resBackendPath;
    } else {
      const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked', 'backend');
      const unpackedPath = path.join(unpackedDir, 'server.js');
      if (fs.existsSync(unpackedPath)) {
        backendDir = unpackedDir;
        backendPath = unpackedPath;
      }
    }
  }

  blog('FILES', `backendDir       : ${backendDir}`);
  blog('FILES', `server.js        : ${backendPath}`);
  blog('FILES', `server.js exists : ${fs.existsSync(backendPath)}`);
  blog('FILES', `package.json     : ${fs.existsSync(path.join(backendDir, 'package.json'))}`);
  blog('FILES', `.env exists      : ${fs.existsSync(path.join(backendDir, '.env'))}`);
  blog('FILES', `node_modules     : ${fs.existsSync(path.join(backendDir, 'node_modules'))}`);
  blog('FILES', `OCR traineddata  : ${fs.existsSync(path.join(backendDir, 'eng.traineddata'))}`);

  if (!fs.existsSync(backendPath)) {
    const errText = `Fatal: server.js not found at ${backendPath}`;
    blog('ERROR', errText);
    prematureExitError = errText;
    throw new Error(errText);
  }

  // 3. Resolve Node Runtime Binary
  const nodeConfig = resolveNodeBin(isPackaged);
  const nodeExe = nodeConfig.bin;

  blog('NODE', `node executable  : ${nodeExe}`);
  blog('NODE', `useRunAsNode     : ${nodeConfig.useRunAsNode}`);

  // 4. Build Clean Production Environment
  // HPMS_ENV is set explicitly here (not merely inherited via ...process.env)
  // because launchBackend() is only ever invoked for the packaged/production
  // Electron path (SPAWNS_BACKEND is true only for ELECTRON_MODE 'production',
  // or an explicit SPAWNS_BACKEND=true override) — this guarantees the spawned
  // backend always resolves to the production Firebase project (hpms-sky5)
  // regardless of whatever HPMS_ENV happened to be in the parent process.
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HPMS_ENV: 'production',
    PORT: '5000',
  };

  if (nodeConfig.useRunAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  blog('SPAWN', `Executing: "${nodeExe}" "${backendPath}"`);
  blog('SPAWN', `CWD: ${backendDir}`);
  blog('SPAWN', `PORT: ${env.PORT}`);

  try {
    backendProcess = spawn(nodeExe, [backendPath], {
      cwd: backendDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });
  } catch (spawnErr) {
    const msg = `Failed to spawn backend process: ${spawnErr.message}`;
    blog('ERROR', msg);
    prematureExitError = msg;
    backendProcess = null;
    throw spawnErr;
  }

  if (!backendProcess || !backendProcess.pid) {
    const msg = 'spawn() did not return a valid PID.';
    blog('ERROR', msg);
    prematureExitError = msg;
    backendProcess = null;
    throw new Error(msg);
  }

  blog('SPAWN', `✓ Backend process spawned successfully (PID: ${backendProcess.pid})`);

  // Pipe stdout and stderr
  backendProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      text.split('\n').forEach(l => blog('STDOUT', l));
    }
  });

  backendProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      text.split('\n').forEach(l => blog('STDERR', l));
    }
  });

  backendProcess.on('exit', async (code, signal) => {
    blog('EXIT', `Backend process exited (code: ${code}, signal: ${signal})`);
    if (code !== 0 && code !== null) {
      prematureExitError = `Backend exited prematurely with code ${code}.\n\nDiagnostics:\n${getLastBackendError()}`;
    }
    backendProcess = null;
  });

  backendProcess.on('error', (err) => {
    blog('ERROR', `Backend process error: ${err.message}`);
    prematureExitError = `Backend process error: ${err.message}`;
    backendProcess = null;
  });
}

// ─── killBackend ──────────────────────────────────────────────────────────────

export function killBackend() {
  if (backendProcess && !backendProcess.killed) {
    const pid = backendProcess.pid;
    blog('KILL', `Terminating backend process PID: ${pid}...`);
    try {
      if (process.platform === 'win32' && pid) {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        backendProcess.kill('SIGTERM');
      }
      blog('KILL', `✓ Backend process PID ${pid} terminated.`);
    } catch (err) {
      blog('KILL', `Note on terminate PID ${pid}: ${err.message}`);
    }
    backendProcess = null;
  }
}
