/**
 * backend/utils/whatsappSignature.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H5 — proving an inbound webhook really came from Meta.
 *
 * Deliberately pure: no Firebase, no Express, no I/O and NO LOGGING. This file
 * handles an application secret, and one stray console.log of the wrong
 * variable would defeat the whole control, so it has no logging at all rather
 * than logging carefully.
 *
 * WHAT IS SIGNED
 * Meta signs the RAW REQUEST BYTES, not a parsed object. Re-serialising a
 * parsed body is not byte-identical to what was sent — key order, whitespace
 * and unicode escaping all differ — so a check built on a parsed body is not a
 * verification at all. Every function here therefore refuses anything that is
 * not a Buffer. That refusal is what forces the webhook route to be mounted
 * ahead of the global express.json().
 *
 * WHY NOT THE EXISTING RAZORPAY PATTERN
 * razorpayController compares digests with `!==`, which returns as soon as two
 * bytes differ and therefore leaks, through timing, how much of a forged
 * signature was correct. This file uses crypto.timingSafeEqual. The Razorpay
 * code is pre-existing and out of scope here, but it must not be copied.
 *
 * FAIL CLOSED
 * Every function returns false on anything unexpected — missing secret, missing
 * header, wrong prefix, wrong length, non-Buffer body. Nothing throws, because
 * a thrown error carrying a secret into a stack trace is exactly what this file
 * exists to prevent.
 */

import crypto from 'crypto';

/** The header Meta sends. Lower-case: Node normalises incoming header names. */
export const SIGNATURE_HEADER = 'x-hub-signature-256';

/** Meta's algorithm prefix. Only this one is accepted. */
export const SIGNATURE_PREFIX = 'sha256=';

/** Hex length of a SHA-256 digest, used to reject malformed headers cheaply. */
export const SIGNATURE_HEX_LENGTH = 64;

/**
 * Constant-time string comparison.
 *
 * Both sides are hashed first so the buffers handed to timingSafeEqual are
 * always the same length. That avoids the throw-on-length-mismatch that a naive
 * use hits, and it stops the comparison leaking the length of the expected
 * value through an early return.
 */
export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * The header value Meta should have sent for these exact bytes.
 * Returns null rather than throwing when it cannot be computed.
 */
export function computeSignatureHeader(rawBody, appSecret) {
  if (!Buffer.isBuffer(rawBody)) return null;
  if (typeof appSecret !== 'string' || appSecret.length === 0) return null;
  const digest = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
}

/**
 * True only when `headerValue` is a well-formed signature of `rawBody` under
 * `appSecret`.
 *
 * @param {Buffer} rawBody    the untouched request bytes
 * @param {string} headerValue  the x-hub-signature-256 header, verbatim
 * @param {string} appSecret  the Meta app secret, from the environment
 * @returns {boolean}         false for every failure, including misconfiguration
 */
export function verifyWebhookSignature(rawBody, headerValue, appSecret) {
  if (typeof headerValue !== 'string') return false;
  if (!headerValue.startsWith(SIGNATURE_PREFIX)) return false;
  // Cheap shape check before any HMAC work, so junk costs nothing.
  if (headerValue.length !== SIGNATURE_PREFIX.length + SIGNATURE_HEX_LENGTH) return false;
  if (!/^[0-9a-f]+$/.test(headerValue.slice(SIGNATURE_PREFIX.length))) return false;

  const expected = computeSignatureHeader(rawBody, appSecret);
  if (!expected) return false;
  return timingSafeCompare(expected, headerValue);
}
