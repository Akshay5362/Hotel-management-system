/**
 * backend/middleware/whatsappWebhookRateLimit.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H5 — a flood guard for the ONE public endpoint.
 *
 * SCOPE, DELIBERATELY NARROW
 * This is not a general rate limiter and must not become one. It is applied
 * only inside the WhatsApp webhook router. Every existing API route keeps its
 * current behaviour exactly, because nothing else mounts this.
 *
 * NO NEW DEPENDENCY
 * The backend image is built with `npm ci --omit=dev` and runs from a bind
 * mount, so adding a package would mean rebuilding the container before the
 * server could even start. A fixed-window counter is a few lines, so it is
 * written here rather than pulled in.
 *
 * WHAT IT IS AND IS NOT
 * A fixed window per key, where the key is the client address. Behind a tunnel
 * or reverse proxy every request may share one address, in which case the
 * per-key limit behaves as a single cap for the endpoint — which is precisely
 * the flood protection wanted here. It is NOT per-tenant fairness, and it is
 * per-process, so a future second backend instance would allow the limit once
 * per instance. Both are acceptable for a guard whose job is to stop a public
 * URL being hammered; neither is a security boundary. The security boundary is
 * the HMAC signature.
 */

/** Defaults chosen to sit far above Meta's real delivery rate for one hotel. */
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_REQUESTS = 60;

/** Hard cap on tracked keys, so a spoofed-address flood cannot grow the map. */
export const MAX_TRACKED_KEYS = 5_000;

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Reads the limiter's configuration from the environment, with safe defaults. */
export function rateLimitSettingsFromEnv(env = process.env) {
  return {
    windowMs: positiveInt(env.WHATSAPP_WEBHOOK_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS),
    max: positiveInt(env.WHATSAPP_WEBHOOK_RATE_LIMIT_MAX, DEFAULT_MAX_REQUESTS)
  };
}

/**
 * Builds an Express middleware enforcing `max` requests per `windowMs` per key.
 *
 * Exported as a factory so a test can construct an isolated limiter with tiny
 * limits instead of mutating shared state.
 */
export function createWebhookRateLimiter({ windowMs = DEFAULT_WINDOW_MS, max = DEFAULT_MAX_REQUESTS } = {}) {
  /** key → { count, resetAt } */
  const hits = new Map();

  const prune = (now) => {
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  };

  const middleware = (req, res, next) => {
    const now = Date.now();
    // Pruning on the way in keeps the map proportional to live traffic rather
    // than to everything ever seen.
    if (hits.size > 0) prune(now);

    const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      // Once the cap is reached, refuse to track anything new rather than grow.
      if (hits.size >= MAX_TRACKED_KEYS) {
        res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ error: 'Too many requests.', code: 'RATE_LIMITED' });
      }
      hits.set(key, entry);
    }

    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many requests.', code: 'RATE_LIMITED' });
    }
    return next();
  };

  // Exposed for tests and diagnostics only; never used to make a decision.
  middleware.reset = () => hits.clear();
  middleware.size = () => hits.size;
  return middleware;
}
