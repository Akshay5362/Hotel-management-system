/**
 * backend/utils/whatsappVerificationCode.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H6 — the one-time code that proves a person controls a WhatsApp number.
 *
 * Deliberately pure: no Firebase, no Express, no I/O and NO LOGGING. Like
 * whatsappSignature.js it handles secret material, so it has no logging at all
 * rather than careful logging.
 *
 * WHERE THE CODE TRAVELS
 * Out of the server exactly once, to the administrator who requested it, who
 * hands it to the intended person out of band. It then comes BACK over WhatsApp
 * from that person's own number. The code is never sent TO the number under
 * verification: that would only prove that whoever holds the typed number can
 * read, which is precisely the wrong-number failure this design defeats.
 *
 * WHY A KEYED HMAC AND NOT A PLAIN HASH
 * An 8-digit code has 10^8 values. A plain SHA-256 of it is brute-forced
 * offline in seconds by anyone who can read the stored digest. An HMAC keyed by
 * a server-only secret cannot be reversed without that secret, so a leaked
 * binding document yields nothing usable. The binding key is mixed in as
 * context, so a digest never verifies against a different number.
 *
 * FAIL CLOSED
 * Every predicate returns false or null on anything unexpected. The only
 * function that throws is the one that cannot proceed without the secret, and
 * its error carries no secret material.
 */

import crypto from 'crypto';
import {
  WHATSAPP_VERIFICATION_CODE_LENGTH,
  WHATSAPP_VERIFICATION_MAX_ATTEMPTS
} from './inventoryConstants.js';

/** E.164: a leading +, a non-zero country code, then 7–14 more digits. Mirrors H1. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Meta reports a sender as digits with no '+', e.g. "919876543210". A person
 * types "+91 98765-43210". Both must land on one canonical E.164 string, and
 * anything else must land on null rather than on a guess.
 */
export function normalizeSenderToE164(sender) {
  if (sender === undefined || sender === null) return null;
  const compact = String(sender).trim().replace(/[\s\-().]/g, '');
  if (!compact) return null;
  const candidate = compact.startsWith('+') ? compact : `+${compact}`;
  return E164_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The binding document id for a number: deterministic, so two registrations of
 * one number collide on the same document and Firestore's create() refuses the
 * second. Digits only, so the id is safe as a Firestore path segment.
 */
export function bindingKeyForNumber(e164) {
  const n = normalizeSenderToE164(e164);
  if (!n) return null;
  return `wa_${n.slice(1)}`;
}

/** Digits from the CSPRNG, one at a time, so every code is uniformly likely. */
export function generateVerificationCode(length = WHATSAPP_VERIFICATION_CODE_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i++) out += String(crypto.randomInt(0, 10));
  return out;
}

/** True when the string is exactly a code: the right number of digits, nothing else. */
export function isWellFormedVerificationCode(code, length = WHATSAPP_VERIFICATION_CODE_LENGTH) {
  return typeof code === 'string' && code.length === length && /^[0-9]+$/.test(code);
}

/**
 * The stored form of a code. Keyed by the server secret and bound to a
 * context (the binding key), so it is neither reversible nor transferable.
 * Throws — without the secret in the message — when there is no secret,
 * because issuing a challenge that can never be redeemed would be worse than
 * refusing to issue one.
 */
export function verificationCodeHmac(code, secret, context) {
  if (typeof secret !== 'string' || secret.length < 16) {
    const err = new Error('WhatsApp verification is not configured.');
    err.code = 'WHATSAPP_VERIFICATION_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }
  if (!isWellFormedVerificationCode(code)) {
    const err = new Error('Malformed verification code.');
    err.code = 'MALFORMED_VERIFICATION_CODE';
    err.status = 400;
    throw err;
  }
  return crypto.createHmac('sha256', secret).update(`${String(context || '')}\n${code}`).digest('hex');
}

/**
 * Constant-time comparison of a presented code against a stored digest. Both
 * sides are hashed to a fixed length first, exactly as whatsappSignature.js
 * does, so timingSafeEqual never throws on length and leaks nothing.
 */
export function verificationCodeMatches(code, expectedHmac, secret, context) {
  if (typeof expectedHmac !== 'string' || expectedHmac.length !== 64) return false;
  if (!isWellFormedVerificationCode(code)) return false;
  let presented;
  try { presented = verificationCodeHmac(code, secret, context); } catch { return false; }
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expectedHmac, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Pulls a code out of a WhatsApp message. Strict on purpose: exactly one run
 * of exactly the right number of digits, and no other digits anywhere. A
 * message that mentions two numbers is ambiguous and is treated as not a code
 * rather than guessed at.
 */
export function extractVerificationCode(text, length = WHATSAPP_VERIFICATION_CODE_LENGTH) {
  if (typeof text !== 'string') return null;
  const compact = text.replace(/[\s\-.]/g, '');
  const runs = compact.match(/[0-9]+/g);
  if (!runs || runs.length !== 1 || runs[0].length !== length) return null;
  return runs[0];
}

/** Why a challenge can or cannot be redeemed right now. */
export const CHALLENGE_STATE = Object.freeze({
  NONE: 'NONE',
  ACTIVE: 'ACTIVE',
  CONSUMED: 'CONSUMED',
  EXPIRED: 'EXPIRED',
  EXHAUSTED: 'EXHAUSTED'
});

/**
 * Pure verdict over a binding document. Consumed is checked FIRST: a successful
 * redemption clears the digest, and a replay of that code must still be
 * reported as a replay rather than as "no challenge". Exhaustion also clears
 * the digest but never sets consumed, so it correctly reads as NONE.
 */
export function challengeState(binding, nowMs = Date.now(), maxAttempts = WHATSAPP_VERIFICATION_MAX_ATTEMPTS) {
  if (!binding) return CHALLENGE_STATE.NONE;
  if (binding.challenge_consumed_at) return CHALLENGE_STATE.CONSUMED;
  if (!binding.challenge_code_hmac) return CHALLENGE_STATE.NONE;
  if (Number(binding.challenge_attempts || 0) >= maxAttempts) return CHALLENGE_STATE.EXHAUSTED;
  const exp = Date.parse(binding.challenge_expires_at || '');
  if (!Number.isFinite(exp) || exp <= nowMs) return CHALLENGE_STATE.EXPIRED;
  return CHALLENGE_STATE.ACTIVE;
}

/** The keyed-HMAC secret. Null, never a default, when it is absent. */
export function verificationSecretFromEnv(env = process.env) {
  const s = env.WHATSAPP_VERIFICATION_SECRET;
  return typeof s === 'string' && s.length >= 16 ? s : null;
}
