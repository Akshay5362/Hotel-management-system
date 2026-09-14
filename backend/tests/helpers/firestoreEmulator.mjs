/**
 * backend/tests/helpers/firestoreEmulator.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * TEST-ONLY. Establishes and proves emulator mode BEFORE Firebase initialises.
 *
 * This file must never be imported by production application code. It lives in
 * backend/tests/, which package.json's extraResources filter excludes from the
 * packaged Electron build, so it cannot ship even by accident.
 *
 * WHY IT EXISTS
 * The Admin SDK honours FIRESTORE_EMULATOR_HOST inside getFirestore(), so a
 * suite pointed at the emulator keeps the same project id and the same
 * four-layer guard it always had — only the transport changes. What the SDK
 * does NOT do is tell you, early and loudly, that you meant to use an emulator
 * and there isn't one. That gap is what this helper closes.
 *
 * FAIL CLOSED, NEVER FALL BACK
 * Every check below runs before firebaseAdmin.js is imported. If any of them
 * fails the process exits, so a suite that was written for the emulator can
 * never quietly reach a cloud project instead. There is no fallback path here
 * by design: an unreachable emulator is an error, not a reason to use the
 * network.
 *
 * STRICTER THAN THE RUNTIME GUARD
 * isProductionProject() deliberately treats an emulator host as safe, because
 * traffic to localhost cannot reach production. This helper does not accept
 * that for tests: the production project id is refused outright, emulator or
 * not, so a suite can never even name it. The runtime guard is untouched and
 * still runs; this is an additional layer on top.
 *
 * THE HOST MUST BE LOOPBACK
 * FIRESTORE_EMULATOR_HOST is an ordinary environment variable, and a value such
 * as an external hostname would send every document this suite writes to a
 * machine that is not yours. Only loopback is accepted.
 */

import net from 'net';

/** The one project id that must never appear in a test, by any route. */
const PRODUCTION_PROJECT_ID = 'hpms-sky5';

/** Hosts that are unambiguously this machine. Nothing else is accepted. */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The emulator port declared in firebase.json. */
export const DEFAULT_EMULATOR_PORT = 8080;
export const DEFAULT_EMULATOR_HOST = `127.0.0.1:${DEFAULT_EMULATOR_PORT}`;

export class EmulatorGuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EmulatorGuardError';
    this.code = code;
  }
}

/**
 * Splits and validates FIRESTORE_EMULATOR_HOST. Pure: takes the value, never
 * reads the environment, so it can be tested against hostile inputs directly.
 *
 * @returns {{ ok: true, host: string, port: number } | { ok: false, code: string, reason: string }}
 */
export function parseEmulatorHost(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, code: 'EMULATOR_HOST_MISSING', reason: 'FIRESTORE_EMULATOR_HOST is not set' };
  if (/^[a-z]+:\/\//i.test(raw)) {
    return { ok: false, code: 'EMULATOR_HOST_MALFORMED', reason: 'a scheme is not allowed; use host:port' };
  }

  // IPv6 in brackets, or plain host:port. Anything else is refused.
  const match = raw.startsWith('[')
    ? raw.match(/^(\[[0-9a-fA-F:]+\]):(\d{1,5})$/)
    : raw.match(/^([A-Za-z0-9._-]+):(\d{1,5})$/);
  if (!match) return { ok: false, code: 'EMULATOR_HOST_MALFORMED', reason: 'expected host:port' };

  const host = match[1];
  const port = Number.parseInt(match[2], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, code: 'EMULATOR_HOST_MALFORMED', reason: 'port is out of range' };
  }
  if (!LOOPBACK_HOSTS.includes(host)) {
    return {
      ok: false,
      code: 'EMULATOR_HOST_NOT_LOOPBACK',
      reason: `'${host}' is not loopback; a remote emulator host would send test data off this machine`
    };
  }
  return { ok: true, host: host === '[::1]' ? '::1' : host, port };
}

/**
 * Pure project-id check. Refuses production outright and requires the exact
 * expected test project, so a half-loaded environment cannot drift onto
 * another database.
 */
export function checkProjectId(projectId, expectedProjectId) {
  const id = String(projectId ?? '').trim();
  if (!id) return { ok: false, code: 'PROJECT_ID_MISSING', reason: 'FIREBASE_PROJECT_ID is not set' };
  if (id === PRODUCTION_PROJECT_ID) {
    return { ok: false, code: 'PRODUCTION_PROJECT_REFUSED', reason: `'${id}' is the production project and is never permitted in a test` };
  }
  if (/hpms/i.test(id)) {
    return { ok: false, code: 'PROJECT_ID_LOOKS_PRODUCTION', reason: `'${id}' matches the production naming pattern` };
  }
  if (expectedProjectId && id !== expectedProjectId) {
    return { ok: false, code: 'PROJECT_ID_UNEXPECTED', reason: `expected '${expectedProjectId}', found '${id}'` };
  }
  return { ok: true, projectId: id };
}

/**
 * Opens a TCP connection to prove something is actually listening.
 *
 * This is the check that turns "the emulator is not running" from a long hang
 * deep inside a Firestore call into an immediate, readable failure. It never
 * falls back to anything.
 */
export function probeEmulator({ host, port, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (reachable, reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, reason: reason || null });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'connection timed out'));
    socket.once('error', (err) => done(false, err?.code || 'connection failed'));
    socket.connect(port, host);
  });
}

/**
 * The whole gate, in order, before any Firebase import.
 *
 * Returns the validated settings on success. On failure it throws, and the
 * caller is expected to abort — there is deliberately no permissive mode and
 * no environment variable that relaxes any of this.
 */
export async function assertEmulatorMode({
  expectedProjectId = 'sky5-development',
  emulatorHost = process.env.FIRESTORE_EMULATOR_HOST,
  projectId = process.env.FIREBASE_PROJECT_ID,
  requireReachable = true,
  timeoutMs = 2000
} = {}) {
  const parsed = parseEmulatorHost(emulatorHost);
  if (!parsed.ok) throw new EmulatorGuardError(parsed.reason, parsed.code);

  const project = checkProjectId(projectId, expectedProjectId);
  if (!project.ok) throw new EmulatorGuardError(project.reason, project.code);

  if (requireReachable) {
    const probe = await probeEmulator({ host: parsed.host, port: parsed.port, timeoutMs });
    if (!probe.reachable) {
      throw new EmulatorGuardError(
        `no Firestore emulator is listening on ${parsed.host}:${parsed.port} (${probe.reason}). ` +
        'Start it with: npm run emulator:start. Refusing to continue; this suite will NOT fall back to a cloud project.',
        'EMULATOR_UNREACHABLE'
      );
    }
  }

  return { host: parsed.host, port: parsed.port, projectId: project.projectId };
}

/**
 * Confirms that the live Firestore handle really is pointed at the emulator.
 *
 * Run AFTER firebaseAdmin.js has been imported. The settings object carries the
 * host the client resolved, so this catches the case where the environment said
 * emulator but the client was constructed before the variable was set.
 */
export function assertHandleUsesEmulator(db, { host, port } = {}) {
  const settings = db?._settings || {};
  // The Admin SDK reports an emulator target as servicePath + port with ssl
  // false. Older and other builds have used a combined `host`, so both shapes
  // are read rather than assuming one.
  const resolvedHost = String(settings.servicePath || settings.host || '').replace(/:\d+$/, '');
  const resolvedPort = Number(settings.port ?? (String(settings.host || '').match(/:(\d+)$/) || [])[1]);
  const ssl = settings.ssl;

  // TLS is the decisive signal: a cloud connection is always encrypted and the
  // local emulator never is. This alone rules out having reached a real project.
  if (ssl !== false) {
    throw new EmulatorGuardError(
      `the Firestore handle reports ssl=${String(ssl)}; a cloud connection is always TLS, so this is not the emulator`,
      'HANDLE_NOT_EMULATOR'
    );
  }
  if (!resolvedHost) {
    throw new EmulatorGuardError('the Firestore handle names no host; it was not built for an emulator', 'HANDLE_NOT_EMULATOR');
  }
  if (resolvedHost !== host) {
    throw new EmulatorGuardError(
      `the Firestore handle is pointed at '${resolvedHost}', not the emulator host '${host}'`,
      'HANDLE_WRONG_HOST'
    );
  }
  if (Number.isFinite(resolvedPort) && resolvedPort !== port) {
    throw new EmulatorGuardError(
      `the Firestore handle is pointed at port ${resolvedPort}, not the emulator port ${port}`,
      'HANDLE_WRONG_HOST'
    );
  }
  return { host: resolvedHost, port: resolvedPort, ssl: false };
}

/**
 * Wipes the emulator's database in one call, using the emulator's own REST
 * endpoint rather than deleting documents one at a time.
 *
 * This function is physically incapable of touching a cloud project: the
 * endpoint it calls exists only on the emulator, and the guard above has
 * already proved the host is loopback. It refuses to run at all if the
 * environment is not in emulator mode.
 */
export async function clearEmulatorData({
  emulatorHost = process.env.FIRESTORE_EMULATOR_HOST,
  projectId = process.env.FIREBASE_PROJECT_ID
} = {}) {
  const parsed = parseEmulatorHost(emulatorHost);
  if (!parsed.ok) throw new EmulatorGuardError(parsed.reason, parsed.code);
  const project = checkProjectId(projectId, null);
  if (!project.ok) throw new EmulatorGuardError(project.reason, project.code);

  const url = `http://${parsed.host}:${parsed.port}/emulator/v1/projects/${project.projectId}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new EmulatorGuardError(`the emulator refused the reset: HTTP ${res.status}`, 'EMULATOR_RESET_FAILED');
  }
  return { cleared: true, projectId: project.projectId };
}

/** For a suite that wants one line at the top of its Part B. */
export function describeEmulator({ host, port, projectId }) {
  return `[EMULATOR] ${projectId} via ${host}:${port} (local only, zero cloud quota)`;
}

/**
 * The one call a Firestore-backed suite makes, immediately before it imports
 * firebaseAdmin.js.
 *
 * Two lines at one call site rather than a copy of the rules in every suite:
 *
 *   const { requireEmulatorOrExit } = await import('./helpers/firestoreEmulator.mjs');
 *   await requireEmulatorOrExit();
 *
 * It ADDS to the four-layer guard each suite already runs; it replaces nothing.
 * The suite still checks isProductionProject(), still pins the project id, still
 * refuses a production-shaped name, and still asserts the live handle. This just
 * makes "and the transport is a local emulator" one of those preconditions.
 *
 * On failure it exits the process. That is deliberate: a Firestore-backed suite
 * with no emulator has nowhere safe to run, and returning a value would leave
 * the decision to a caller who might ignore it. The exit happens BEFORE
 * firebaseAdmin.js is imported, so no credential is used and no connection of
 * any kind is attempted.
 *
 * The default two-second probe is what keeps a missing emulator from becoming a
 * hang: without it the SDK retries a dead host indefinitely and the suite never
 * finishes.
 */
export async function requireEmulatorOrExit({
  expectedProjectId = 'sky5-development',
  timeoutMs = 2000,
  quiet = false
} = {}) {
  try {
    const settings = await assertEmulatorMode({ expectedProjectId, timeoutMs });
    if (!quiet) console.log(`  ${describeEmulator(settings)}`);
    return settings;
  } catch (err) {
    console.error(`\n[EMULATOR_ABORT] ${err.code}: ${err.message}`);
    console.error('  Firestore-backed suites run against the local emulator only.');
    console.error('  They will not use a cloud project, so there is nothing to fall back to.');
    console.error('');
    console.error('    Terminal 1:  npm run emulator:start');
    console.error('    Terminal 2:  npm run test:firestore:emulator -- <suite path>');
    process.exit(1);
  }
}
