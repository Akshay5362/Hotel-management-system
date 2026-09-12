/**
 * backend/routes/whatsappRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H5 — the only public write surface in the application.
 *
 * MOUNTED BEFORE express.json() IN server.js, ON PURPOSE. Meta signs the raw
 * request bytes, and a body the global parser has already consumed cannot be
 * reproduced byte-for-byte, so the signature could never be checked. This
 * router therefore brings its own parser and must stay ahead of the global one.
 *
 * NO `authenticate` HERE, ALSO ON PURPOSE. Meta cannot present a Firebase ID
 * token. The HMAC signature is the authentication for this route, and it is
 * enforced inside the controller before the body is parsed. This is the one
 * route in the system where that substitution is correct, which is why the
 * public surface is exactly these two paths and nothing else.
 *
 * Middleware order below is load-bearing:
 *   rate limit → raw body → handler
 * The limiter runs FIRST so a flood is refused before a megabyte is buffered
 * for each request.
 */

import express from 'express';
import {
  createWebhookRateLimiter,
  rateLimitSettingsFromEnv
} from '../middleware/whatsappWebhookRateLimit.js';
import {
  verifyWebhookSubscription,
  receiveWebhook
} from '../controllers/whatsappWebhookController.js';

const router = express.Router();

// One limiter instance shared by both verbs, built from the environment at
// startup. Scoped to this router only — no other route is affected.
const webhookRateLimit = createWebhookRateLimiter(rateLimitSettingsFromEnv());

// The matcher returns true for every content-type, so the body arrives as a
// Buffer whatever header Meta sets. The cap is small on purpose: a webhook
// delivery is a few kilobytes, and this endpoint is public.
const rawBody = express.raw({ type: () => true, limit: '512kb' });

/** GET — Meta's one-time subscription handshake. */
router.get('/webhook', webhookRateLimit, verifyWebhookSubscription);

/** POST — an inbound delivery. Raw bytes, signature-checked in the controller. */
router.post('/webhook', webhookRateLimit, rawBody, receiveWebhook);

export default router;
