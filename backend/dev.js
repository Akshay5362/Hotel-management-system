/**
 * backend/dev.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cross-platform bootstrap for `npm run dev` (nodemon), used so this script is
 * safe to run directly (`cd backend && npm run dev`) without depending on the
 * root package.json's `cross-env` wrapper.
 *
 * Explicitly sets HPMS_ENV=development before spawning nodemon, so a bare
 * `npm run dev` inside backend/ can never silently resolve to the production
 * Firebase project (see backend/config/firebaseAdmin.js) — matching the same
 * safety guarantee the root `npm run backend:dev` script already provides.
 *
 * Spawns nodemon's own JS entry point directly via process.execPath (the real
 * node binary) rather than shelling out to `npx`/`npx.cmd`. On Windows, Node
 * refuses to spawn a `.cmd`/`.bat` file with shell:false (EINVAL) — resolving
 * straight to nodemon/bin/nodemon.js and running it with `node <script>` sidesteps
 * that entirely, with no .cmd/.bat involved and no shell:true needed. Pure
 * Node.js — no new dependency, identical on Windows/macOS/Linux.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const nodemonBin = require.resolve('nodemon/bin/nodemon.js');

const env = { ...process.env, HPMS_ENV: 'development' };

const child = spawn(process.execPath, [nodemonBin, 'server.js'], {
  stdio: 'inherit',
  env,
  shell: false,
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('[backend/dev.js] Failed to start nodemon:', err.message);
  process.exit(1);
});
